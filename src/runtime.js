import net from 'node:net';
import {createHash,randomBytes} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,unlink} from 'node:fs/promises';
import {appendFileSync,statSync,renameSync,existsSync,unlinkSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
export function paths(root){
 const id=createHash('sha256').update(path.resolve(root).toLowerCase()+'|'+os.userInfo().username).digest('hex').slice(0,28);
 const dir=path.join(root,'data','runtime');
 return {id,dir,state:path.join(dir,'instance.json'),log:path.join(dir,'tobi.log'),pipe:process.platform==='win32'?[String.fromCharCode(92).repeat(2)+'.','pipe',`tobi-${id}`].join(String.fromCharCode(92)):path.join(os.tmpdir(),`tobi-${id}.sock`)};
}
export async function readState(root){try{const s=JSON.parse(await readFile(paths(root).state,'utf8'));if(s.id!==paths(root).id||!Number.isInteger(s.pid)||typeof s.token!=='string'||!/^[a-f0-9]{64}$/.test(s.token))return null;return s;}catch{return null;}}
export async function request(root,command='status',timeout=2500){
 const s=await readState(root);if(!s)return null;
 return new Promise(resolve=>{
  let done=false,buffer='';const socket=net.createConnection(paths(root).pipe);
  const finish=value=>{if(done)return;done=true;socket.destroy();resolve(value);};
  socket.setTimeout(timeout,()=>finish(null));socket.on('error',()=>finish(null));socket.on('connect',()=>socket.write(JSON.stringify({token:s.token,command})+'\n'));
  socket.on('data',chunk=>{buffer+=chunk;if(buffer.length>8192)return finish(null);if(!buffer.includes('\n'))return;try{const r=JSON.parse(buffer.split('\n')[0]);finish(r.id===s.id&&r.pid===s.pid&&r.instance===s.instance?r:null);}catch{finish(null);}});
  socket.on('end',()=>finish(null));
 });
}
export async function withControl(root,fn){
 const endpoint=paths(root).pipe+'-control';const server=net.createServer(s=>s.destroy());
 for(let i=0;;i++){
  try{await new Promise((ok,no)=>{server.once('error',no);server.listen(endpoint,()=>{server.removeListener('error',no);ok();});});break;}
  catch(e){if(e.code!=='EADDRINUSE'||i>=40)throw new Error('다른 운영 명령이 실행 중이에요. 잠시 후 다시 시도하세요.');await new Promise(r=>setTimeout(r,250));}
 }
 try{return await fn();}finally{await new Promise(r=>server.close(r));}
}
// Callers supply fixed diagnostic strings or already-redacted console messages.
export function writeRuntimeLog(file,level,text){
  try{
   if(existsSync(file)&&statSync(file).size>2*1024*1024){if(existsSync(file+'.3'))unlinkSync(file+'.3');for(let i=2;i>=1;i--)if(existsSync(file+'.'+i))renameSync(file+'.'+i,file+'.'+(i+1));renameSync(file,file+'.1');}
   appendFileSync(file,new Date().toISOString()+' '+level+' '+text.slice(0,2000)+'\n',{mode:0o600});
  }catch{ /* Logging failure must not expose raw secrets. */ }
}
export async function createRuntime(root,onStop,{logging=true,graceMs=60000}={}){
 const p=paths(root);await mkdir(p.dir,{recursive:true});
 let phase='starting',closed=false,stopTimer;
 const state={id:p.id,pid:process.pid,instance:randomBytes(16).toString('hex'),token:randomBytes(32).toString('hex'),startedAt:new Date().toISOString()};
 const server=net.createServer(socket=>{
  let buffer='';socket.setTimeout(3000,()=>socket.destroy());socket.on('error',()=>{});
  socket.on('data',chunk=>{buffer+=chunk;if(buffer.length>2048)return socket.destroy();if(!buffer.includes('\n'))return;
   let input;try{input=JSON.parse(buffer.split('\n')[0]);}catch{return socket.destroy();}
   if(input.token!==state.token)return socket.destroy();
   if(!['status','stop'].includes(input.command))return socket.destroy();
   if(input.command==='stop')stop();
   socket.end(JSON.stringify({id:p.id,pid:state.pid,instance:state.instance,phase,startedAt:state.startedAt})+'\n');
  });
 });
 await new Promise((ok,no)=>{server.once('error',no);server.listen(p.pipe,()=>{server.removeListener('error',no);ok();});});
 try{const tmp=p.state+'.'+state.instance;await writeFile(tmp,JSON.stringify(state),{mode:0o600});await rename(tmp,p.state);}catch(e){server.close();throw e;}
 const originals={log:console.log,error:console.error,warn:console.warn};
 function log(level,args){
  // Runtime messages only: never serialize exception objects, URLs, or arbitrary data.
  let text=args.filter(x=>typeof x==='string').join(' ').replace(/postgres(?:ql)?:\/\/[^\s]+/gi,'[DB 비밀값 숨김]').replace(/\b\d{5,}:[A-Za-z0-9_-]{15,}\b/g,'[봇 토큰 숨김]').replace(/\b(?:sk-|sb_secret_)[A-Za-z0-9_-]+/g,'[비밀키 숨김]');
  for(const key of ['TELEGRAM_BOT_TOKEN','DATABASE_URL','OPENAI_API_KEY','CODEX_API_KEY'])if(process.env[key])text=text.split(process.env[key]).join('[비밀값 숨김]');
  try{const password=decodeURIComponent(new URL(process.env.DATABASE_URL).password);if(password)text=text.split(password).join('[DB 비밀번호 숨김]');}catch{}
  writeRuntimeLog(p.log,level,text);
  originals[level](text);
 }
 if(logging)for(const level of Object.keys(originals))console[level]=(...args)=>log(level,args);
 function stop(){if(phase==='stopping')return;phase='stopping';onStop();stopTimer=setTimeout(()=>{console.error('정상 종료 제한 시간 초과. 현재 토비 인스턴스를 종료합니다.');process.exit(1);},graceMs);stopTimer.unref();}
 return {ready(){if(phase!=='stopping')phase='running';},stop,async close(){if(closed)return;closed=true;clearTimeout(stopTimer);await new Promise(r=>server.close(r));const current=await readState(root);if(current?.instance===state.instance)await unlink(p.state).catch(()=>{});if(logging)Object.assign(console,originals);}};
}
