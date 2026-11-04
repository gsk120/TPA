import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { randomUUID, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { root, config } from './config.js';
import { Telegram } from './telegram.js';
import { Store } from './storage.js';
import { childEnvironment } from './assistant/codex.js';
import { planChanges } from './tasks.js';
import {Families,verifyBot} from './families.js';

const mode = process.argv[2] || 'setup';
async function setup() {
  const envPath = path.join(root, '.env');
  try { await access(envPath); console.log('기존 .env는 유지합니다.'); }
  catch {
    const password = randomBytes(32).toString('base64url');
    const template = (await readFile(path.join(root, '.env.example'), 'utf8')).replace('FAMILY_ID=','FAMILY_ID=' + randomUUID());
    await writeFile(envPath, template, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await mkdir(path.join(root, 'data'), { recursive: true });
    await writeFile(path.join(root, 'data', 'bootstrap.sql'), `-- 비밀 파일: 외부 공유·Git 등록 금지\nalter role assistant_app password '${password}';\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    console.log('.env와 data/bootstrap.sql 생성 완료. 비밀번호는 화면에 출력하지 않습니다.');
  }
  console.log(`설정 순서
1. Supabase 신규 개인비서 프로젝트 생성 → SQL Editor에서 sql/schema.sql 실행.
2. 같은 곳에서 로컬 data/bootstrap.sql 실행 (비밀번호 비밀 유지).
3. Connect → Session pooler 연결문자열을 .env DATABASE_URL에 입력.
   사용자 postgres.PROJECT_REF를 assistant_app.PROJECT_REF로 변경하고 bootstrap.sql의 비밀번호 사용.
   가능한 경우 Supabase CA 인증서를 받아 DATABASE_CA_FILE 지정. TLS 검증은 끄지 않습니다.
4. 텔레그램 BotFather에서 봇 생성 → TELEGRAM_BOT_TOKEN 입력.
5. 비공개 가족 그룹에 토비를 추가하고 관리자로 지정.
6. 기존 설치는 sql/multi-family.sql을 SQL Editor에서 postgres로 실행.
7. 실행 장비에서 codex login → npm run doctor → npm start → 그룹 관리자가 /setup 전송.
TELEGRAM_CHAT_ID, TELEGRAM_USER_IDS, FAMILY_ID는 기존 자료 도구용 선택 설정입니다. 가족 등록은 DB로 관리합니다.
메신저·DB 정보는 채팅에 붙여넣지 말고 로컬 .env에 입력하세요.
PRD.md와 기존 가계부는 자동 수정하지 않습니다.`);
}
async function discover() {
  const cfg = config(process.env, 'discover'), tg = new Telegram(cfg.token);
  if ((await tg.call('getWebhookInfo')).url) throw new Error('기존 웹훅을 사용 중입니다.');
  console.log('본 프로그램을 중지한 상태에서만 실행하세요. 가족 그룹에서 등록할 사용자가 각각 /identify 를 보내면 ID만 로컬에 표시합니다. 종료 Ctrl+C.');
  let offset = 0;
  while (true) {
    const updates = await tg.call('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] });
    for (const u of updates) {
      offset = u.update_id + 1;
      const m = u.message;
      if (m?.text?.match(/^\/identify(?:@\w+)?$/) && ['group','supergroup'].includes(m.chat?.type) && !m.from?.is_bot) console.log(JSON.stringify({ groupId: String(m.chat.id), userId: String(m.from.id) }));
    }
  }
}
async function cliCheck(cfg) {
  const command = cfg.codexJs ? process.execPath : cfg.codexExecutable;
  const args = [...(cfg.codexJs ? [cfg.codexJs] : []), 'login','status'];
  return new Promise(resolve => {
    const child = spawn(command,args,{windowsHide:true,shell:false,env:childEnvironment(),stdio:'ignore'});
    const timer = setTimeout(() => child.kill(),10000);
    child.on('error',()=>{clearTimeout(timer);resolve(false);}); child.on('close',code=>{clearTimeout(timer);resolve(code===0);});
  });
}
async function connected() {
  const cfg = config(); let store;
  try {
    if(mode==='doctor'){
      const pool=await Store.openPool(cfg);
      try{
        const schema=await pool.query("select to_regclass('assistant.members') as members,to_regclass('assistant.settings_history') as settings_history,to_regclass('assistant.bot_runtime') as bot_runtime");
        if(Object.values(schema.rows[0]).some(v=>!v))throw new Error('DB 실행: sql/multi-family.sql을 TPA SQL Editor에서 실행해주세요.');
        const tg=new Telegram(cfg.token),bot=await tg.call('getMe'),families=new Families(pool,bot.id);
        const list=await families.list();
        console.log('DB 마이그레이션·접속 확인 완료. 가족 그룹 '+list.length+'개.');
        for(const f of list){try{await verifyBot(tg,bot,f.chat_id);console.log('그룹 봇 권한 정상. /setup 연결 상태: '+(f.active?'활성':'미설정·보류'));}catch{console.log('그룹에서 토비 관리자 지정 및 /setup이 필요합니다.');}}
        console.log(await cliCheck(cfg)?'CLI 로그인 확인 완료.':'CLI 로그인 또는 실행 경로 확인 필요.');
        console.log('실제 메시지·AI 요청은 보내지 않았습니다.');
      }finally{await pool.end();}
      return;
    }
    store = await Store.connect(cfg);
    if (mode === 'doctor') {
      console.log('DB 접속·가족 등록 확인 완료.');
      const tg = new Telegram(cfg.token), bot = await tg.call('getMe');
      const chat = await tg.call('getChat', { chat_id: cfg.chatId });
      for (const id of cfg.userIds) {
        const member = await tg.call('getChatMember', { chat_id: cfg.chatId, user_id: Number(id) });
        if (['left','kicked'].includes(member.status)) throw new Error('등록한 사용자 중 그룹에 없는 사용자가 있습니다.');
      }
      console.log(`텔레그램 봇 @${bot.username}, 가족 그룹 종류 ${chat.type} 확인. 실제 메시지는 보내지 않았습니다.`);
      console.log(await cliCheck(cfg) ? 'CLI 로그인 상태 확인 완료. 실제 AI 호출은 하지 않았습니다.' : 'CLI 실행·로그인 확인 필요. CODEX_EXECUTABLE 또는 CODEX_JS를 확인하세요.');
    } else if (mode === 'backup') {
      await mkdir(path.join(root,'data','backups'),{recursive:true});
      const file = path.join(root,'data','backups',new Date().toISOString().replaceAll(':','-')+'.json');
      await writeFile(file,JSON.stringify(await store.backup(),null,2),{encoding:'utf8',mode:0o600}); console.log('로컬 백업 저장 완료: '+file);
    } else if (mode === 'import') {
      const file = process.argv[3]; if (!file) throw new Error('사용법: npm run import -- 로컬JSON파일');
      // Input is deliberately not bundled with real family data.
      const input = JSON.parse(await readFile(file,'utf8'));
      if (!input.key || !Array.isArray(input.tasks)) throw new Error('key와 tasks 배열을 포함한 JSON이 필요합니다.');
      await store.lockRuntime();
      const jobId = 'import:'+String(input.key).slice(0,100);
      await store.pool.query('insert into assistant.jobs(family_id,id,payload) values($1,$2,$3) on conflict do nothing',[cfg.familyId,jobId,{actor:'import',text:'승인된 초기 자료 이관'}]);
      const job = await store.claim(jobId);
      if (!job) {console.log('이미 이관되었거나 처리할 작업이 없습니다.');return;}
      if (job.id !== jobId) throw new Error('다른 대기 작업이 있어 이관을 중지합니다. 먼저 기존 작업을 처리하세요.');
      const actions=input.tasks.map(task=>({operation:'create',id:null,expectedVersion:null,task,reason:'사용자 제공 초기 이관'}));
      await store.finish(job,planChanges(actions,await store.tasks()),'초기 자료 '+actions.length+'건 저장 완료.');
      console.log('이관 완료. 확인 메시지는 다음 정상 실행에서 전송됩니다.');
    } else throw new Error('지원하지 않는 명령입니다.');
  } finally { await store?.close(); }
}
try {
  if (mode === 'setup') await setup(); else if (mode === 'discover') await discover(); else await connected();
} catch(error) {
  // Never echo connection strings or upstream error payloads.
  console.error('설정·연결 확인 실패. 입력 항목, SQL 실행, 인증서·전용 DB 역할 및 CLI 로그인 상태를 확인하세요.');
  if (/^(설정이 비어|사용법:|key와|가족 그룹|기존 DB|DB 실행|기존 웹훅|다른 대기|지원하지)/.test(error.message)) console.error(error.message);
  process.exitCode=1;
}
