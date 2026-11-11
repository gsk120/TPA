import test from 'node:test';
import assert from 'node:assert/strict';
import {formatList,groupTasks,formatReceipt,formatDetail,headingEntities,displayTask} from '../src/format.js';
import {listTasks,briefing} from '../src/briefing.js';
import {Telegram,splitMessage} from '../src/telegram.js';
import {processJob} from '../src/processor.js';
const now=new Date('2026-11-02T00:00:00Z');
const task=(extra={})=>({id:'11111111-1111-4111-8111-111111111111',title:'서아 등록',kind:'task',status:'open',dueDate:'2026-11-02',time:null,remindAt:[],...extra});
test('today hides IDs and repetitive status while preserving deadline and count',()=>{
 const t=task();const text=formatList([t],'today',now);assert.ok(text.includes('오늘까지 마감인 과업 1개'));assert.ok(text.includes('☐ 서아 등록'));assert.ok(!text.includes(t.id));assert.ok(!text.includes('미완료'));assert.ok(text.includes('11월 2일(월)'));
});
test('grouped dates sort actual appointments before unspecified times and preserve waiting, ranges and overdue',()=>{
 const tasks=[task({title:'미정',kind:'appointment'}),task({title:'점심',kind:'appointment',time:'12:00'}),task({title:'진료',kind:'appointment',time:'09:30'}),task({title:'지난약속',kind:'appointment',dueDate:'2026-11-01'}),task({title:'점등식',kind:'event',status:'waiting',dueDate:null}),task({title:'전시회',kind:'event',dueDate:'2026-11-19',endDate:'2026-11-22'}),task({title:'접수',kind:'registration',dueDate:'2026-11-10',time:'09:00'})];
 const text=groupTasks(tasks,{now});assert.ok(text.indexOf('진료')<text.indexOf('점심'));assert.ok(text.indexOf('점심')<text.indexOf('미정\n'));assert.ok(text.includes('결과 미확인'));assert.ok(text.includes('날짜 미정 · 안내 대기'));assert.ok(text.includes('2026-11-19~2026-11-22'));assert.ok(text.includes('접수 시작'));assert.ok(text.includes('오전 9시 30분'));
 assert.ok(displayTask(task({timeNote:'14시 이후'})).includes('14시 이후'));
});
test('empty list, timezone and completed exclusion',()=>{
 assert.ok(formatList([],'today',now).includes('없어요'));assert.equal(listTasks([task({status:'done'})],'all',now).length,0);assert.ok(formatList([],'today',now,'America/New_York').includes('11월 1일(일)'));
 assert.ok(briefing([task()], 'daily',now).includes('☐ 서아 등록'));assert.ok(!briefing([task()], 'daily',now).includes(task().id));
});
test('event summaries distinguish a scheduled visit, a time condition and an event period',()=>{
 const event=task({title:'코엑스 유교전',kind:'event'});
 assert.equal(displayTask({...event,time:'09:00',timeNote:'입구에서 만나기'}),'• 오전 9시 · 코엑스 유교전 · 입구에서 만나기');
 assert.equal(displayTask({...event,endDate:event.dueDate}),'• 코엑스 유교전 · 방문 시간 미정');
 assert.equal(displayTask({...event,timeNote:'14시 이후'}),'• 코엑스 유교전 · 14시 이후');
 assert.equal(displayTask({...event,endDate:'2026-11-05'}),'• 코엑스 유교전 · 2026-11-02~2026-11-05 · 방문일 미정');
 assert.equal(displayTask({...event,dueDate:null}),'• 코엑스 유교전');
});
test('natural and slash schedule queries display a saved event time in each scope',async()=>{
 const event=task({title:'코엑스 유교전',kind:'event',time:'09:00'});
 const future=task({title:'다음 달 행사',kind:'event',dueDate:'2026-12-02'});
 const store={tasks:async()=>[event,future],finish:async(_job,changes)=>assert.deepEqual(changes,[])};
 const ai={answer:()=>assert.fail('a clear list request should skip AI')};
 for(const [command,phrases] of [
  ['/today',['오늘일정알려줘','오늘 일정 뭐지?']],
  ['/list',['전체일정알려줘','전체 목록 보여줘']],
  ['/week',['이번주일정알려줘','이번 주 남은 일정 보여줘']]
 ]){
  const reply=await processJob({payload:{text:command}},store,ai,now);
  assert.match(reply,/오전 9시 · 코엑스 유교전/);
  assert.doesNotMatch(reply,/방문일 미정/);
  assert.equal(reply.includes(future.title),command==='/list');
  for(const text of phrases)assert.equal(await processJob({payload:{text}},store,ai,now),reply);
 }
});
test('an interpreted schedule request uses the same event summary',async()=>{
 const event=task({title:'코엑스 유교전',kind:'event',time:'09:00'});
 const store={tasks:async()=>[event],finish:async(_job,changes)=>assert.deepEqual(changes,[])};
 const ai={answer:async()=>({
  actions:[],reply:'',
  retrieval:{kind:'task_list',status:'active',from:'2026-11-02',to:'2026-11-02',person:null,search:null}
 })};
 const reply=await processJob({payload:{text:'오늘 잡혀 있는 일정이 뭐였더라?'}},store,ai,now);
 assert.match(reply,/오전 9시 · 코엑스 유교전/);
 assert.doesNotMatch(reply,/방문일 미정/);
});
test('detail hides technical IDs unless explicitly requested',()=>{
 const t=task({notes:'참고 <>&_*',time:'09:00'});assert.ok(!formatDetail(t).includes(t.id));assert.ok(formatDetail(t,{showId:true}).includes(t.id));assert.ok(formatDetail(t).includes('참고 <>&_*'));const text=formatReceipt([{before:null,after:t}]);assert.ok(text.startsWith('✅ 저장 완료'));assert.ok(!text.includes(t.id));
});
test('special characters remain literal; entities use UTF16 offsets and have a safe bound',async()=>{
 const text='📅 오늘 일정\n\n2026년 11월 2일(월)\n☐ <b>가짜</b> & _제목_ 😀';let body;
 const tg=new Telegram('dummy',async(_url,options)=>{body=JSON.parse(options.body);return {json:async()=>({ok:true,result:{message_id:1}})};});await tg.send('-1',text);
 assert.equal(body.text,text);assert.equal(body.parse_mode,undefined);assert.equal(body.entities[1].offset,text.indexOf('2026년'));assert.equal(body.entities[0].length,'📅 오늘 일정'.length);
 assert.ok(headingEntities('2026년 11월 2일(월)\n'.repeat(200)).length<=90);
});
test('long split preserves text and surrogate pairs; every part has valid entity bounds',()=>{
 const text=('📅 오늘 일정\n\n2026년 11월 2일(월)\n☐ <>& 😀 가족 일정\n').repeat(150);const parts=splitMessage(text,120);assert.equal(parts.join(''),text);assert.ok(parts.every(p=>p.length<=120&&!/[\uD800-\uDBFF]$/.test(p)));for(const p of parts)for(const e of headingEntities(p))assert.ok(e.offset+e.length<=p.length);
});
test('basic list and detail commands render without AI, and IDs remain usable',async()=>{
 const t=task();let reply;const store={tasks:async()=>[t],finish:async(_job,_changes,text)=>{reply=text;}};const ai={answer:()=>{throw Error('should not call AI');}};
 for(const text of ['/today','/list','/week']){await processJob({payload:{text}},store,ai,now);assert.ok(!reply.includes(t.id));}
 await processJob({payload:{text:'서아 자세히 알려줘'}},store,ai,now);assert.ok(reply.includes(t.title));assert.ok(!reply.includes(t.id));
});
