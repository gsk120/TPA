import {createHash,randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {readFile,rename,rm,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseEnv} from 'node:util';
import {calendarClient,refreshTokenReader} from './google.js';
import {Store} from '../storage.js';

const envPath = resolve('.env');
const scope = 'https://www.googleapis.com/auth/calendar.events';
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const literal = value => typeof value === 'string' && value.trim() && !/[<>]/.test(value);
const failure = code => Object.assign(new Error(code),{setupCode:code});
const readEnv = async () => parseEnv(await readFile(envPath,'utf8'));

export function replaceSetting(source,name,value) {
  if (!/^[A-Z_]+$/.test(name) || !/^[A-Za-z0-9._/+*=~-]+$/.test(value)) throw failure('INVALID_ENV_VALUE');
  if (source.startsWith('\uFEFF')) return '\uFEFF'+replaceSetting(source.slice(1),name,value);
  const line = new RegExp('^[ \\t]*(?:export[ \\t]+)?'+name+'[ \\t]*=.*$','gm');
  const lines = [...source.matchAll(line)];
  if (lines.length > 1) throw failure('DUPLICATE_ENV_SETTING');
  if (lines.length) return source.replace(line,()=>name+'='+value);
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  return source+(source && !source.endsWith('\n') ? newline : '')+name+'='+value+newline;
}

async function saveSetting(name,value,original) {
  const source = await readFile(envPath,'utf8');
  if (parseEnv(source)[name] !== original) throw failure('ENV_CHANGED_RETRY');
  const next = replaceSetting(source,name,value);
  if (source === next) return;
  const tmp = envPath+'.'+randomBytes(12).toString('hex')+'.tmp';
  try {
    await writeFile(tmp,next,{encoding:'utf8',mode:0o600,flag:'wx'});
    if (await readFile(envPath,'utf8') !== source) throw failure('ENV_CHANGED_RETRY');
    await rename(tmp,envPath);
  } finally { await rm(tmp,{force:true}); }
}

function credentials(env) {
  const clientId=env.GOOGLE_CALENDAR_CLIENT_ID, clientSecret=env.GOOGLE_CALENDAR_CLIENT_SECRET;
  const calendarId=env.GOOGLE_CALENDAR_ID;
  if (![clientId,clientSecret,calendarId].every(literal) || calendarId==='primary') throw failure('GOOGLE_SETTINGS_MISSING');
  return {clientId,clientSecret,calendarId};
}

function launchBrowser(url) {
  const command = process.platform==='win32' ? 'rundll32.exe' : process.platform==='darwin' ? 'open' : 'xdg-open';
  const args = process.platform==='win32' ? ['url.dll,FileProtocolHandler',url] : [url];
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{stdio:'ignore',windowsHide:true});
    child.once('error',()=>reject(failure('BROWSER_OPEN_FAILED')));
    child.once('exit',code=>code===0?resolve():reject(failure('BROWSER_OPEN_FAILED')));
  });
}

async function authorize(settings) {
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(64).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const timeout = AbortSignal.timeout(180000);
  let accept, reject;
  const authorization = new Promise((res,rej)=>{accept=res;reject=rej;});
  authorization.catch(()=>{});
  const server = createServer((req,res)=>{
    let url;
    try { url=new URL(req.url,'http://127.0.0.1'); }
    catch { res.writeHead(400).end(); return; }
    const params=url.searchParams;
    if (req.method!=='GET' || url.pathname!=='/oauth/callback' || params.get('state')!==state) {
      res.writeHead(404).end();
      return;
    }
    const code=params.get('code');
    res.writeHead(code ? 200 : 400,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store',
      'Referrer-Policy':'no-referrer'});
    res.end(code?'Authorization received. Return to the terminal.':'Authorization was not granted. Return to the terminal.');
    if (code) accept(code);
    else reject(failure('GOOGLE_CONSENT_NOT_GRANTED'));
  });
  timeout.addEventListener('abort',()=>reject(failure('GOOGLE_CONSENT_TIMEOUT')),{once:true});
  try {
    await new Promise((resolve,reject)=>{
      server.once('error',reject);
      server.listen(0,'127.0.0.1',resolve);
    });
    const redirectUri='http://127.0.0.1:'+server.address().port+'/oauth/callback';
    const url=new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search=new URLSearchParams({client_id:settings.clientId,redirect_uri:redirectUri,
      response_type:'code',scope,access_type:'offline',prompt:'consent',state,
      code_challenge:challenge,code_challenge_method:'S256'});
    console.log('Opening Google consent. Sign in and approve access in your browser.');
    const opened=launchBrowser(url.href);
    await Promise.race([authorization,opened.then(()=>authorization)]);
    const code=await authorization;
    const response=await fetch('https://oauth2.googleapis.com/token',{
      method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),
      body:new URLSearchParams({client_id:settings.clientId,client_secret:settings.clientSecret,
        code,code_verifier:verifier,grant_type:'authorization_code',redirect_uri:redirectUri})
    });
    if (!response.ok) throw failure('GOOGLE_TOKEN_EXCHANGE_HTTP_'+response.status);
    const payload=await response.json();
    if (!payload.refresh_token || !payload.scope?.split(/\s+/).includes(scope)) throw failure('GOOGLE_REFRESH_TOKEN_OR_SCOPE_MISSING');
    return payload.refresh_token;
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

async function testCalendar(settings,token) {
  if (!literal(token)) throw failure('GOOGLE_REFRESH_TOKEN_MISSING');
  const signal=AbortSignal.timeout(35000);
  const api=calendarClient({...settings,refreshToken:async()=>token},signal);
  const page=await api.list();
  if (!Array.isArray(page.items) && typeof page.nextSyncToken!=='string' && !page.nextPageToken) {
    throw failure('GOOGLE_CALENDAR_RESPONSE_INVALID');
  }
  console.log('PASS: token refresh and Calendar events.list.');
}

export function resolveBotFamily(rows) {
  const matches=rows.filter(row=>row.bot_family);
  if (matches.length!==1) throw failure('BOT_FAMILY_MISSING_OR_AMBIGUOUS');
  if (!matches[0].active || !uuid.test(matches[0].id)) throw failure('BOT_FAMILY_NOT_ACTIVE');
  return matches[0].id.toLowerCase();
}

async function inspectFamily(env,requestedId,{useBotFamily=false}={}) {
  const db=await Store.openPool({databaseUrl:env.DATABASE_URL,caFile:env.DATABASE_CA_FILE});
  try {
    const schema=(await db.query(`select to_regclass('assistant.schedule_series') is not null as series,
      to_regclass('assistant.calendar_sync_state') is not null as sync`)).rows[0];
    const series=schema.series ? 'exists(select 1 from assistant.schedule_series s where s.family_id=f.id)' : 'false';
    const connection=schema.sync ? `exists(select 1 from assistant.calendar_sync_state c where c.family_id=f.id)` : 'false';
    const rows=(await db.query(`select f.id,f.active,
        (f.id::text=$1 or f.chat_id=$2) as bot_family,
        exists(select 1 from assistant.tasks t where t.family_id=f.id) or ${series} as has_schedule,
        ${connection} as has_connection
      from assistant.families f`,[env.FAMILY_ID?.trim().toLowerCase()??'',env.TELEGRAM_CHAT_ID?.trim()??''])).rows;
    if (useBotFamily) {
      if (!schema.sync) throw failure('SYNC_SCHEMA_MISSING');
      const familyId=resolveBotFamily(rows);
      await saveSetting('CALENDAR_SYNC_FAMILY_ID',familyId,env.CALENDAR_SYNC_FAMILY_ID);
      console.log('PASS: existing bot family verified and local setting saved.');
      return;
    }
    const candidates=rows.filter(row=>row.active && !row.bot_family && !row.has_schedule && !row.has_connection);
    console.log(JSON.stringify({families:rows.length,existingBotFamily:rows.some(row=>row.bot_family),
      isolatedCandidateCount:candidates.length,syncSchema:schema.sync,
      configuredFamilyIsCandidate:candidates.some(row=>row.id===env.CALENDAR_SYNC_FAMILY_ID)}));
    if (!requestedId) return;
    if (!uuid.test(requestedId) || !candidates.some(row=>row.id.toLowerCase()===requestedId.toLowerCase())) {
      throw failure('FAMILY_NOT_AN_EMPTY_ACTIVE_TEST_RECORD');
    }
    if (!schema.sync) throw failure('SYNC_SCHEMA_MISSING_IN_TEST_DB');
    await saveSetting('CALENDAR_SYNC_FAMILY_ID',requestedId.toLowerCase(),env.CALENDAR_SYNC_FAMILY_ID);
    console.log('PASS: existing test family verified and local setting saved.');
  } finally { await db.end(); }
}

async function main() {
  const [command,id]=process.argv.slice(2);
  const env=await readEnv();
  if (command==='inspect-family') return inspectFamily(env);
  if (command==='set-test-family' && id) return inspectFamily(env,id);
  if (command==='set-bot-family' && !id) return inspectFamily(env,undefined,{useBotFamily:true});
  if (!['authorize','verify-api'].includes(command)) throw failure('USE_AUTHORIZE_VERIFY_API_INSPECT_FAMILY_SET_TEST_FAMILY_OR_SET_BOT_FAMILY');
  const settings=credentials(env);
  if (command==='verify-api') {
    if (process.platform==='darwin' && !uuid.test(env.CALENDAR_SYNC_FAMILY_ID??'')) {
      throw failure('MAC_KEYCHAIN_FAMILY_ID_REQUIRED');
    }
    return testCalendar(settings,await refreshTokenReader(env)(AbortSignal.timeout(10000)));
  }
  if (process.platform==='darwin') {
    console.error('Import the Windows refresh token into macOS Keychain as TPA Google Calendar, using the sync family UUID as the account.');
    throw failure('MAC_KEYCHAIN_TOKEN_REQUIRED');
  }
  const probe=await fetch('https://oauth2.googleapis.com/token',{method:'HEAD',redirect:'error',
    signal:AbortSignal.timeout(5000)});
  await probe.body?.cancel();
  const token=await authorize(settings);
  await testCalendar(settings,token);
  await saveSetting('GOOGLE_CALENDAR_REFRESH_TOKEN',token,env.GOOGLE_CALENDAR_REFRESH_TOKEN);
  console.log('PASS: refresh token saved to local .env.');
}

if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  try { await main(); }
  catch(error) {
    const status=Number.isInteger(error.status)?'HTTP_'+error.status:null;
    const code=error.setupCode??status??error.cause?.code??error.code;
    console.error('Calendar setup failed: '+(/^[A-Z0-9_]+$/.test(code??'')?code:'LOCAL_CONFIGURATION_OR_CONNECTION'));
    process.exitCode=1;
  }
}
