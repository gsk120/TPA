import test from 'node:test';
import assert from 'node:assert/strict';
import { validDay, dueBriefs, today, addDays } from '../src/time.js';
import { planChanges, validateTask } from '../src/tasks.js';
import { briefing } from '../src/briefing.js';
import { allowed, addressed, splitMessage, Telegram } from '../src/telegram.js';
import { processJob, schedule } from '../src/processor.js';
import { childEnvironment, buildPrompt } from '../src/assistant/codex.js';
import { config } from '../src/config.js';

const now = new Date('2026-10-28T00:00:00Z');
const task = (extra={}) => ({ title:'가상 과업',kind:'task',status:'open',dueDate:'2026-10-28',time:null,endDate:null,timeNote:null,person:null,assignee:null,notes:'',followUpDate:null,actualDeadline:null,remindAt:[], ...extra });
const saved = extra => ({ ...task(),id:'11111111-1111-4111-8111-111111111111',version:1,createdAt:now.toISOString(),updatedAt:now.toISOString(),completedAt:null,...extra });

test('KST 자정·월말·일요일 예약과 날짜 유효성',()=>{
  assert.equal(today(new Date('2026-10-27T15:00:00Z')),'2026-10-28');
  assert.equal(addDays('2026-12-31',1),'2027-01-01');
  assert.equal(validDay('2026-02-29'),false); assert.equal(validDay('2028-02-29'),true);
  assert.deepEqual(dueBriefs(new Date('2026-10-27T22:59:00Z')),[]);
  assert.equal(dueBriefs(new Date('2026-10-27T23:00:00Z'))[0].key,'daily:2026-10-28');
  assert.deepEqual(dueBriefs(new Date('2026-11-01T11:00:00Z')).map(x=>x.type),['daily','weekly']);
});
test('완료는 과거 마감 보존·새 버전·알림 제거',()=>{
  const original=saved({dueDate:'2026-10-27'});
  const [change]=planChanges([{operation:'update',id:original.id,expectedVersion:1,task:task({dueDate:original.dueDate,status:'done',remindAt:['2026-10-29T08:00:00+09:00']}),reason:'완료 보고'}],[original],now);
  assert.equal(change.after.version,2); assert.equal(change.after.dueDate,'2026-10-27');
  assert.deepEqual(change.after.remindAt,[]); assert.equal(change.after.completedAt,now.toISOString());
  assert.equal(original.status,'open');
});
test('오래된 버전·없는 대상·중복 대상 변경은 모두 차단',()=>{
  const t=saved(), action={operation:'update',id:t.id,expectedVersion:0,task:task()};
  assert.throws(()=>planChanges([action],[t],now));
  assert.throws(()=>planChanges([{...action,expectedVersion:1}],[],now));
  assert.throws(()=>planChanges([{...action,expectedVersion:1},{...action,expectedVersion:1}],[t],now));
});
test('잘못된 날짜·시각·과거 알림 및 잘못된 상태 차단',()=>{
  for(const patch of [{dueDate:'2026-02-30'},{time:'24:01'},{remindAt:['2026-10-27T08:00:00+09:00']},{status:'unknown'},{dueDate:null,time:'10:00'}])assert.throws(()=>validateTask(task(patch),now));
  assert.equal(validateTask(task({timeNote:'14시 이후'}),now).time,null);
});
test('처리 목표와 실제 만기는 별도 보존',()=>{
  const t=validateTask(task({actualDeadline:'2026-12-06'}),now); assert.equal(t.dueDate,'2026-10-28');assert.equal(t.actualDeadline,'2026-12-06');
});
test('날짜 변경 시 이전 사전 알림 제거·지난 알림을 둔 메모 수정 가능',()=>{
  const old=saved({remindAt:['2026-10-28T08:00:00+09:00']});
  const action={operation:'update',id:old.id,expectedVersion:1,task:{...old,notes:'메모 수정'}};
  assert.deepEqual(planChanges([action],[old],now)[0].after.remindAt,[]);
  const future=saved({remindAt:['2026-10-29T08:00:00+09:00']});
  assert.deepEqual(planChanges([{...action,task:{...future,dueDate:'2026-10-30'}}],[future],now)[0].after.remindAt,[]);
});
test('브리핑은 완료 제외·지난 약속을 이월하지 않음·진행 중 행사 포함',()=>{
  const tasks=[saved({title:'완료건',status:'done'}),saved({title:'지난약속',kind:'appointment',dueDate:'2026-10-27'}),saved({title:'진행행사',kind:'event',dueDate:'2026-10-27',endDate:'2026-10-30'})];
  const text=briefing(tasks,'daily',now); assert.ok(!text.includes('완료건'));assert.ok(text.includes('결과 미확인'));assert.ok(text.includes('2026-10-27'));assert.ok(text.includes('진행행사'));
});
test('사용자·그룹·봇 권한 및 멘션 범위',()=>{
  const cfg={chatId:'-123',userIds:['1','2']},bot={id:99,username:'family_bot'};
  const m={chat:{id:-123,type:'group'},from:{id:1},text:'일반 대화'};
  assert.equal(allowed(m,cfg),true); assert.equal(allowed({...m,from:{id:3}},cfg),false);
  assert.equal(allowed({...m,from:{id:1,is_bot:true}},cfg),false);
  assert.equal(addressed(m,bot,'addressed'),false);assert.equal(addressed({...m,text:'/list@other_bot'},bot,'addressed'),false);
  assert.equal(addressed({...m,reply_to_message:{from:{id:99}}},bot,'addressed'),true);
});
test('이모지 긴 메시지는 안전한 길이로 분할',()=>{
  const parts=splitMessage('😀'.repeat(4000));assert.ok(parts.every(x=>x.length<=3500));assert.equal(parts.join(''),'😀'.repeat(4000));
});
test('텔레그램 네트워크 단절은 전송 결과 불확실·토큰 비노출',async()=>{
  const tg=new Telegram('secret',async()=>{throw new Error('https://api.telegram.org/botsecret');});
  await assert.rejects(tg.send('-1','hello'),e=>e.uncertain && !e.message.includes('secret'));
});
test('CLI 자식 환경에 DB·텔레그램·모델 API 비밀값 미전달',()=>{
  const env=childEnvironment({PATH:'x',DATABASE_URL:'dbsecret',TELEGRAM_BOT_TOKEN:'token',OPENAI_API_KEY:'api',CODEX_API_KEY:'api2'});
  assert.deepEqual(env,{PATH:'x'});
});
test('AI 입력은 최신 목록·작성자·답장과 절대 한국 시각 포함',()=>{
  const text=buildPrompt({tasks:[saved()],history:[],context:[],message:{actor:'2',text:'그거 미뤄',replyTo:'123'},now});
  assert.ok(text.includes('2026-10-28T09:00:00+09:00'));assert.ok(text.includes('그거 미뤄'));assert.ok(text.includes('123'));
});
test('중복 사용자 설정과 빈 필수 설정은 명확히 거부',()=>{
  assert.throws(()=>config({}),/설정이 비어/);
  assert.throws(()=>config({DATABASE_URL:'x',TELEGRAM_BOT_TOKEN:'x',TELEGRAM_CHAT_ID:'-1',TELEGRAM_USER_IDS:'1,1',FAMILY_ID:'11111111-1111-4111-8111-111111111111'}),/서로 다른/);
});
test('AI 변경 완료는 DB 저장 후 영수증 생성, 거짓 성공 문구 사용 안 함',async()=>{
  const t=saved();let received;
  const store={tasks:async()=>[t],history:async()=>[],context:async()=>[],finish:async(_j,c,r)=>{received={c,r};}};
  const ai={answer:async()=>({reply:'보험 가입도 실제로 완료했어요',actions:[{operation:'update',id:t.id,expectedVersion:1,task:task({status:'done'}),reason:'완료 보고'}]})};
  const reply=await processJob({payload:{text:'가상 과업 끝',actor:'1'}},store,ai,now);
  assert.equal(received.c[0].after.status,'done');assert.ok(reply.startsWith('✅ 저장 완료'));assert.ok(!reply.includes('보험 가입'));
});
test('DB 저장 실패는 사용자 성공 응답 없이 전파',async()=>{
  const store={tasks:async()=>[],finish:async()=>{throw new Error('db down');}};
  await assert.rejects(processJob({payload:{text:'/list'}},store,{},now),/db down/);
});
test('AI 장애에도 기본 목록·일일점검은 실행',async()=>{
  const queued=[];const store={tasks:async()=>[saved()],history:async()=>[],finish:async()=>{},schedule:async(id,text)=>queued.push({id,text}),missed:async()=>{}};
  await processJob({payload:{text:'/list'}},store,{answer:()=>{throw new Error('호출되면 안됨');}},now);
  await schedule(store,now);assert.equal(queued[0].id,'daily:2026-10-28');
});

test('registered users accept one or many, reject empty and duplicate IDs',()=>{
 const base={DATABASE_URL:'x',TELEGRAM_BOT_TOKEN:'x',TELEGRAM_CHAT_ID:'-1',FAMILY_ID:'11111111-1111-4111-8111-111111111111'};
 for(const ids of ['1','1,2,3,4'])assert.equal(config({...base,TELEGRAM_USER_IDS:ids}).userIds.length,ids.split(',').length);
 assert.equal(config({...base,TELEGRAM_USER_IDS:' , '}).userIds.length,0);
 assert.throws(()=>config({...base,TELEGRAM_USER_IDS:'1,1'}));
 const cfg={chatId:'-123',userIds:['1']};
 assert.equal(allowed({chat:{id:-123,type:'group'},from:{id:1}},cfg),true);
 assert.equal(allowed({chat:{id:-123,type:'group'},from:{id:2}},cfg),false);
});
