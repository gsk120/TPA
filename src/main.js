import {setTimeout as sleep} from 'node:timers/promises';
import {config,root} from './config.js';
import {createRuntime,paths,writeRuntimeLog} from './runtime.js';
import {Store} from './storage.js';
import {Families,verifyBot,verifyMember} from './families.js';
import {routeUpdate} from './router.js';
import {Telegram,splitMessage} from './telegram.js';
import {messageReferences,quickCommand} from './context.js';
import {Codex} from './assistant/codex.js';
import {processJob,schedule} from './processor.js';
let stopping=false;const shutdown=new AbortController();
let runtime;
function stop(){stopping=true;shutdown.abort();}
for(const name of ['SIGINT','SIGTERM'])process.on(name,()=>runtime?runtime.stop():stop());
const pause=ms=>sleep(ms,undefined,{signal:shutdown.signal}).catch(()=>{});
function safeError(e){return /^(버튼|되돌릴|선택한|AI 응답|AI 작업|Codex 실행|자료가 커서|목록이 변경|다른 작업|과업 형식|필드 형식|제목·종류|날짜를|시각을|시각에는|종료 날짜|이미 지난|한 번에|지원하지|신규 과업|작업 실행|알림 시각|설정|시간대|요일|권한 확인)/.test(e.message)?e.message.slice(0,300):'연결 또는 처리 오류입니다. 잠시 후 다시 요청해주세요.';}
const startupCodes = new Set([
 'ENOTFOUND','EAI_AGAIN','ECONNREFUSED','ECONNRESET','ETIMEDOUT','EPIPE','ENETUNREACH','EHOSTUNREACH',
 'UND_ERR_CONNECT_TIMEOUT','UND_ERR_SOCKET','ENOENT','EACCES','EPERM','EADDRINUSE',
 'CERT_HAS_EXPIRED','UNABLE_TO_VERIFY_LEAF_SIGNATURE','SELF_SIGNED_CERT_IN_CHAIN','ERR_TLS_CERT_ALTNAME_INVALID',
 'ERR_INVALID_URL','BOT_ALREADY_RUNNING','WEBHOOK_CONFIGURED'
]);
function startupError(error) {
 for (const item of [error, error?.cause]) {
  if (startupCodes.has(item?.code) || /^(?:08|22|23|28|42|53|55|57)[0-9A-Z]{3}$/.test(item?.code || '')) return item.code;
  if (Number.isInteger(item?.httpStatus) && item.httpStatus >= 400 && item.httpStatus <= 599) return 'HTTP ' + item.httpStatus;
  if (item?.name === 'TimeoutError') return 'TIMEOUT';
  if (item?.name === 'AbortError') return 'ABORTED';
 }
 if (error?.message === 'timeout exceeded when trying to connect') return 'DB_CONNECT_TIMEOUT';
 if (error?.message === 'DB 실행 계정은 assistant_app 전용 역할을 사용하세요.') return 'DB_ROLE_INVALID';
 return '원인 코드 없음';
}
async function main(stage){
 stage('환경설정 확인');
 const cfg=config(),tg=new Telegram(cfg.token,fetch,shutdown.signal),ai=new Codex(cfg);
 stage('텔레그램 봇 인증 (getMe)');
 const bot=await tg.call('getMe');
 stage('텔레그램 웹훅 확인');
 if((await tg.call('getWebhookInfo')).url)throw Object.assign(new Error('기존 웹훅'), {code:'WEBHOOK_CONFIGURED'});
 stage('Supabase 연결 설정 및 TLS 인증서 확인');
 const pool=await Store.openPool(cfg),families=new Families(pool,bot.id);
 const busy=new Set();
 try{
  stage('Supabase 접속 및 봇 상태 초기화');
  await families.init();
  stage('Supabase 중복 실행 잠금 및 발송 상태 복구');
  await families.lock();
  stage('Supabase 텔레그램 수신 위치 조회');
  let offset=await families.cursor();
  stage('운영 루프 실행');
  runtime.ready();
  console.log('토비 시작. 가족 그룹 관리자가 /setup으로 연결하세요. 종료 Ctrl+C.');
  async function authorize(f,actor){const latest=await families.family(f.chat_id);if(!latest?.active||latest.id!==f.id)throw new Error('권한 확인: 가족방이 비활성화됐어요.');await verifyBot(tg,bot,f.chat_id);await verifyMember(tg,f.chat_id,actor);await families.member(f,actor,true);}
  const poll=async()=>{while(!stopping){try{
   const updates=await tg.call('getUpdates',{offset,timeout:25,allowed_updates:['message','chat_member','my_chat_member','callback_query']});
   for(const u of updates){if(stopping)break;await routeUpdate(u,families,tg,bot);await families.ack(u.update_id);offset=u.update_id+1;}
  }catch{console.error('수신·권한 확인·DB 저장 실패. 수신 위치를 유지하고 재시도합니다.');await pause(10000);}}};
  const worker=async()=>{while(!stopping){let worked=false;try{
   for(const f of await families.list()){
    if(stopping)break;if(!f.active||busy.has(f.id))continue;busy.add(f.id);
    const store=families.store(f);let job,timer;
    try{
     job=await store.claim();if(!job)continue;worked=true;
     const controller=new AbortController();const signal=AbortSignal.any([controller.signal,shutdown.signal]);let beating=false;
     timer=setInterval(async()=>{if(beating)return;beating=true;try{await store.heartbeat(job);}catch{controller.abort();}finally{beating=false;}},20000);
     await authorize(f,job.payload.actor);
     const state=await families.settings(f);
     // Queue acknowledgement is durable and independent of a slow CLI answer.
     if(!job.payload.button&&!job.payload.text.startsWith('/')&&!quickCommand(job.payload.text))await store.schedule('accepted:'+job.id,'요청을 접수했어요. 순서대로 처리한 뒤 결과를 알려드릴게요.');
     await processJob(job,store,ai,new Date(),signal,{settings:state.settings,settingsVersion:state.settings_version,authorize:()=>authorize(f,job.payload.actor)});
     if (job.payload.button?.messageId) {
       void tg.call('editMessageReplyMarkup', {
         chat_id:f.chat_id, message_id:job.payload.button.messageId, reply_markup:{inline_keyboard:[]}
       }, 3000).catch(() => {});
     }
    }catch(e){
     if(job)await store.fail(job,safeError(e), {
       silent: !!job.payload.button && e.message === '버튼이 이미 처리됐거나 만료됐어요.'
     }).catch(()=>{});
    }
    finally{clearInterval(timer);busy.delete(f.id);}
   }
  }catch{console.error('작업·DB 확인 실패. 재시도합니다.');await pause(10000);}if(!worked)await pause(1000);}};
  const scheduler=async()=>{while(!stopping){try{if(cfg.scheduler)for(const f of await families.list()){
   if(!f.active)continue;try{await verifyBot(tg,bot,f.chat_id);const state=await families.settings(f);await schedule(families.store(f),new Date(),state.settings,state.settings_version);}catch{console.error('가족별 예약 확인 보류. 권한·DB를 확인하세요.');}
  }}catch{console.error('예약·DB 확인 실패.');}await pause(30000);}};
  const deliver=async()=>{while(!stopping){let sent=false;try{for(const f of await families.list()){
   if(stopping)break;if(!f.active)continue;const store=families.store(f);
   try{await verifyBot(tg,bot,f.chat_id);}catch{continue;}
   const d=await store.claimDelivery();if(!d)continue;sent=true;
   try{const memory=await store.referencesForDelivery(d);const linked=memory?.refs??(/^(daily:|weekly:|reminder:|missed:)/.test(d.id)?await store.tasks():[]);const parts=splitMessage(d.text);const ids=await tg.send(f.chat_id,d.text,memory?.replyMarkup);await store.deliveryResult(d,'sent',{messageIds:ids,chatId:f.chat_id,messageRefs:messageReferences(parts,linked),replyOwner:memory?.ownerActor,replyPending:memory?.pending,requestId:memory?.requestId});}
   catch(e){const status=e.retryAfter&&d.attempts<3?'pending':e.uncertain||!e.message?.startsWith('텔레그램')?'uncertain':'failed';await store.deliveryResult(d,status,{reason:safeError(e)},Math.min(e.retryAfter||0,3600));}
   await pause(3100);
  }}catch{console.error('발송·DB 확인 실패.');await pause(10000);}if(!sent)await pause(1500);}};
  await Promise.all([poll(),worker(),worker(),scheduler(),deliver()]);
 }finally{await families.close();}
}
async function boot(){
 let phase = '로컬 제어 채널 초기화';
 const stage = label => {phase = label;console.log('토비 기동 · ' + label);};
 try{
  runtime=await createRuntime(root,stop);
  stage(phase);
  await main(stage);
 }catch(error){
  const message = '토비 시작 또는 실행 실패 · ' + phase + ' · ' + startupError(error);
  if (!runtime) writeRuntimeLog(paths(root).log,'error',message);
  console.error(message);
  process.exitCode=1;
 }
 finally{await runtime?.close();}
}
boot();
