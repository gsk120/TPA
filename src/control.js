import {spawn} from 'node:child_process';
import {mkdir,readFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {root} from './config.js';
import {paths,request,readState,withControl,writeRuntimeLog} from './runtime.js';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function hasState(base){try{await stat(paths(base).state);return true;}catch{return false;}}
export async function start(base=root,{entry=path.join(base,'src','main.js'),timeout=30000}={}){
 const current=await request(base);if(current){console.log('토비가 이미 실행 중이에요: '+current.phase);return current;}
 const runtimePaths=paths(base);
 await mkdir(runtimePaths.dir,{recursive:true});
 writeRuntimeLog(runtimePaths.log,'log','토비 기동 · 백그라운드 프로세스 시작 요청');
 const child=spawn(process.execPath,['--env-file-if-exists='+path.join(base,'.env'),entry],{cwd:base,detached:true,windowsHide:true,stdio:'ignore',env:{...process.env}});
 let failed=false, exited=false;
 child.on('error',error=>{
  failed=true;
  const code=['ENOENT','EACCES','EPERM','EINVAL','EAGAIN'].includes(error.code)?error.code:'원인 코드 없음';
  writeRuntimeLog(runtimePaths.log,'error','토비 프로세스 생성 실패 · '+code);
 });
 child.once('exit',(code,signal)=>{
  exited=true;
  writeRuntimeLog(runtimePaths.log,'error','토비 기동 프로세스 종료 · '+(signal||'종료 코드 '+code));
 });
 child.unref();
 const until=Date.now()+timeout;let seen=false;
 while(Date.now()<until){if(failed)throw new Error('토비 프로세스를 시작하지 못했어요.');const s=await request(base);if(s){seen=true;if(s.phase==='running'){console.log('토비 백그라운드 실행 완료. 터미널을 닫아도 유지됩니다.');return s;}if(s.phase==='stopping')throw new Error('토비가 종료 중입니다.');}else if(seen||exited)throw new Error('토비가 시작 중 종료됐어요. bot:logs로 확인하세요.');await sleep(300);}
 const state=await request(base);if(state){console.log('토비가 시작 중이에요. bot:status와 bot:logs로 확인하세요.');return state;}
 throw new Error('시작 상태를 확인하지 못했어요. bot:logs로 확인하세요.');
}
export async function stop(base=root,{timeout=65000}={}){
 const current=await request(base);if(!current){const stale=await hasState(base);console.log(stale?'토비 응답이 없어요. 비정상 종료 또는 남은 상태 파일일 수 있습니다. PID만으로 강제 종료하지 않습니다.':'토비는 실행 중이 아닙니다.');return;}
 const result=await request(base,'stop');if(!result)throw new Error('종료 요청 결과를 확인하지 못했어요. 다시 상태를 확인하세요.');
 const until=Date.now()+timeout;
 while(Date.now()<until){const s=await request(base);if(!s){
   // Require repeated endpoint absence; never kill by a stale/reused PID.
   await sleep(500);if(!await request(base)){console.log('토비 제어 연결 종료 확인. 프로그램 정리·프로세스 종료를 확인합니다.');
     const alive=(()=>{try{process.kill(current.pid,0);return true;}catch{return false;}})();
     if(!alive){console.log('토비 종료 완료.');return;}
     await sleep(500);try{process.kill(current.pid,0);}catch{console.log('토비 종료 완료.');return;}
   }
  }else if(s.instance!==current.instance)throw new Error('실행 인스턴스가 바뀌었어요. 새 프로세스를 종료하지 않았습니다.');await sleep(300);}
 throw new Error('종료를 확인하지 못했어요. 다른 프로그램을 보호하기 위해 PID 강제 종료는 하지 않았습니다.');
}
export async function status(base=root){const s=await request(base);console.log(s?`토비 ${ {starting:'시작 중',running:'실행 중',stopping:'종료 중'}[s.phase]||'상태 미확인'} (PID ${s.pid})\n프로그램 상태이며 외부 연결 상태는 npm run doctor로 확인하세요.`:await hasState(base)?'토비 응답 없음. 남은 상태 파일 또는 비정상 상태. PID는 종료 근거로 사용하지 않습니다.':'토비 중지 상태');return s;}
export async function logs(base=root,lines=60){
 if(!Number.isInteger(lines)||lines<1||lines>500)throw new Error('로그 줄 수는 1~500입니다.');
 try{const p=paths(base).log;const size=(await stat(p)).size;if(size>3*1024*1024)throw new Error('로그 파일이 예상 한도를 초과했어요.');const text=await readFile(p,'utf8');console.log(text.trimEnd().split('\n').slice(-lines).join('\n'));}catch(e){if(e.code==='ENOENT')console.log('아직 기록된 로그가 없어요.');else throw e;}
}
async function cli(){const cmd=process.argv[2];if(cmd==='logs')return logs(root,process.argv[3]?Number(process.argv[3]):60);if(cmd==='status')return status();if(!['start','stop','restart'].includes(cmd))throw new Error('start / stop / restart / status / logs [줄수]를 사용하세요.');await withControl(root,async()=>{if(cmd==='start')await start();else if(cmd==='stop')await stop();else{await stop();await start();}});}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))cli().catch(e=>{console.error(e.message?.startsWith('토비')||e.message?.startsWith('다른')||e.message?.startsWith('종료')||e.message?.startsWith('시작')?e.message:'운영 명령 실패. 실행 경로·로그·권한을 확인하세요.');process.exitCode=1;});
