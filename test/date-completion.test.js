import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {Store} from '../src/storage.js';
import {planChanges} from '../src/tasks.js';
import {validateIntent, intentSchema} from '../src/assistant/schema.js';
import {Codex} from '../src/assistant/codex.js';
import {createJobDispatcher} from '../src/core/router.js';
import {createCalendarSkill} from '../src/skills/calendar.js';

const now = new Date('2026-11-18T14:50:00Z');
const timeZone = 'Asia/Seoul';
let db, pool, nextJob = 0;
before(async () => {
  db = new PGlite();
  await db.exec('create role anon; create role authenticated');
  await db.exec(await readFile(new URL('../sql/schema.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../sql/calendar-sync.sql',import.meta.url),'utf8'));
  await db.exec('set role assistant_app');
  const query = async (sql, params = []) => {
    const result = await db.query(sql,params);
    return {...result,rowCount:result.rows.length || result.affectedRows || 0};
  };
  pool = {query,connect:async () => ({query,release(){}})};
});
after(async () => db.close());
async function fixture() {
  const family = randomUUID();
  await pool.query('insert into assistant.families(id,chat_id,user_ids) values($1,$2,$3)',[family,'-'+ ++nextJob,['1','2']]);
  return new Store(pool,family);
}
const task = (title, fields = {}) => ({
  id:randomUUID(),version:1,title,kind:'task',status:'open',dueDate:'2026-11-17',time:null,
  endDate:null,timeNote:null,person:null,assignee:null,notes:'보존할 메모',
  followUpDate:null,actualDeadline:null,remindAt:[],...fields
});
async function seed(store, rows) {
  for (const row of rows) await pool.query('insert into assistant.tasks(family_id,id,version,data) values($1,$2,$3,$4)',[store.familyId,row.id,row.version,row]);
}
const completion = (date = '2026-11-17') => ({intent:'complete',targets:[],answer:null,cancellation:null,
  completion:{scope:date ? 'date_all' : null,date,question:date ? null : '어느 하루의 일정을 완료할까요?'}});
const classify = (date, inspect) => ({
  classify:async input => { inspect?.(input); return completion(date); },
  answer:async () => assert.fail('date completion must not request model-generated DB actions')
});
const noAi = {classify:async () => assert.fail('unexpected classification'),answer:async () => assert.fail('unexpected answer')};
const dispatch = createJobDispatcher([createCalendarSkill()],'calendar');
async function run(store,text,ai = noAi,extra = {}) {
  const {at = now, authorize = async () => {}, ...payload} = extra;
  const id = ++nextJob;
  await store.ingest(id,{actor:'1',chatId:'-1',text,...payload});
  const job = await store.claim('tg:'+id);
  return dispatch({job,store,ai,now:at,options:{authorize}});
}
async function edit(store, original, fields) {
  const id = ++nextJob;
  await store.ingest(id,{actor:'1',chatId:'-1',text:'test edit'});
  await store.finish(await store.claim('tg:'+id),planChanges([{
    operation:'update',id:original.id,expectedVersion:original.version,task:{...original,...fields}
  }],[original],now),'edit');
}

test('date completion confirms every target and changes only frozen active IDs through Core and Store',async () => {
  const store = await fixture();
  const rows = [task('어린이집 준비'),task('병원 예약',{status:'waiting'}),task('장보기',{status:'in_progress'}),
    task('완료',{status:'done'}),task('취소',{status:'cancelled'}),task('다른 날짜',{dueDate:'2026-11-18'}),task('미정',{dueDate:null})];
  await seed(store,rows);
  const reply = await run(store,'11월 17일 일정 완료해줘',classify('2026-11-17'));
  assert.match(reply,/미완료 일정 3건/);
  for (const row of rows.slice(0,3)) assert.ok(reply.includes(row.title));
  assert.deepEqual(await store.tasks(),[...rows].sort((a,b)=>a.id.localeCompare(b.id)));
  assert.equal((await store.history()).length,0);
  const state = await store.conversation('1');
  assert.ok(state.pending && state.workflow.snapshot);
  assert.deepEqual(state.request.dateCompletion.targets.map(t=>t.id).sort(),rows.slice(0,3).map(t=>t.id).sort());
  const late = task('승인 전 추가');
  await seed(store,[late]);
  let authorized = 0;
  await run(store,'네',noAi,{authorize:async () => {authorized++;}});
  assert.equal(authorized,1);
  const saved = new Map((await store.tasks()).map(t=>[t.id,t]));
  for (const row of rows.slice(0,3)) {
    assert.equal(saved.get(row.id).status,'done');
    assert.equal(saved.get(row.id).version,2);
    assert.equal(saved.get(row.id).notes,row.notes);
  }
  for (const row of [...rows.slice(3),late]) assert.deepEqual(saved.get(row.id),row);
  assert.equal((await store.history()).length,3);
  assert.equal((await store.conversation('1')).pending,false);
});

test('relative date structures reuse the supplied family clock and date policy',async () => {
  // These mock structured outputs test the program contract, not live model accuracy.
  for (const [text,date] of [['오늘 할 일 다 끝냈어','2026-11-18'],['어제 작업들 모두 완료해줘','2026-11-17'],
    ['지난주 월요일 일정 전부 완료해줘','2026-11-09']]) {
    const store = await fixture();
    await seed(store,[task(text,{dueDate:date}),task('다른 날',{dueDate:'2026-11-01'})]);
    await run(store,text,classify(date,input => {
      assert.equal(+input.now,+now);
      assert.equal(input.settings.timeZone,timeZone);
      assert.equal(input.message.text,text);
    }));
    await run(store,'응');
    assert.equal((await store.tasks()).find(t=>t.title===text).status,'done');
    assert.equal((await store.tasks()).find(t=>t.title==='다른 날').status,'open');
  }
});

test('ambiguous date pauses and date clarification requires a second explicit approval',async () => {
  const store = await fixture();
  await seed(store,[task('과거 작업')]);
  await run(store,'지난주 일정 완료해줘',classify(null));
  const pending = await store.conversation('1');
  assert.equal(pending.request.dateCompletion.targets,null);
  await run(store,'11월 17일',classify('2026-11-17',input => {
    assert.equal(input.pendingRequest.originalText,'지난주 일정 완료해줘');
    assert.equal(+input.now,+now);
  }));
  assert.equal((await store.tasks())[0].status,'open');
  assert.equal((await store.conversation('1')).requestId,pending.requestId);
  await run(store,'네');
  assert.equal((await store.tasks())[0].status,'done');
});

test('rejection and uncertain answers do not modify tasks and preserve candidate order',async () => {
  const store = await fixture();
  await seed(store,[task('보류할 작업')]);
  await run(store,'어제 일정 완료해줘',classify('2026-11-17'));
  const pending = await store.conversation('1');
  // An actual linked reply exercises an uncertain response inside the paused graph.
  await pool.query('insert into assistant.runtime(family_id,key,value) values($1,$2,$3)',[store.familyId,'message:101',{
    messageId:101,chatId:'-1',ownerActor:'1',pending:true,requestId:pending.requestId,
    workflowToken:pending.workflow.token,taskIds:pending.taskIds,expiresAt:pending.expiresAt
  }]);
  await run(store,'아마도',noAi,{replyTo:JSON.stringify({id:101})});
  assert.deepEqual((await store.conversation('1')).request.candidateOrder,pending.request.candidateOrder);
  assert.equal((await store.tasks())[0].status,'open');
  await run(store,'아니요');
  assert.equal((await store.tasks())[0].status,'open');
  assert.equal((await store.history()).length,0);
  assert.equal((await store.conversation('1')).pending,false);
});

test('DB context and LangGraph restore across a new Store and midnight without recalculating yesterday',async () => {
  const store = await fixture();
  await seed(store,[task('어제 작업'),task('오늘 작업',{dueDate:'2026-11-18'})]);
  await run(store,'어제 작업들 모두 완료해줘',classify('2026-11-17'));
  const pending = await store.conversation('1');
  const reopened = new Store(pool,store.familyId);
  assert.deepEqual(await reopened.conversation('1'),pending);
  await run(reopened,'네',noAi,{at:new Date(+now+20*60*1000)});
  assert.equal((await reopened.tasks()).find(t=>t.title==='어제 작업').status,'done');
  assert.equal((await reopened.tasks()).find(t=>t.title==='오늘 작업').status,'open');
});

test('different actor, chat, family, expired request and duplicate linked approvals cannot execute',async () => {
  const store = await fixture();
  const other = await fixture();
  await seed(store,[task('내 작업')]);
  await seed(other,[task('다른 가족 작업')]);
  await run(store,'어제 일정 완료해줘',classify('2026-11-17'));
  const pending = await store.conversation('1');
  const ref = {messageId:201,chatId:'-1',ownerActor:'1',pending:true,requestId:pending.requestId,
    workflowToken:pending.workflow.token,taskIds:pending.taskIds,expiresAt:pending.expiresAt};
  await pool.query('insert into assistant.runtime(family_id,key,value) values($1,$2,$3)',[store.familyId,'message:201',ref]);
  const replyTo = JSON.stringify({id:201});
  for (const payload of [{actor:'2'},{chatId:'-2'},{at:new Date(+now+3*3600000)}]) {
    await run(store,'네',noAi,{...payload,replyTo});
    assert.equal((await store.tasks())[0].status,'open');
    assert.deepEqual(await store.conversation('1'),pending);
  }
  const readOnly = {classify:async()=>({intent:'unknown',targets:[],answer:{reply:'확인할 요청이 없어요.',actions:[]}})};
  await run(other,'네',readOnly,{replyTo});
  assert.equal((await other.tasks())[0].status,'open');
  await run(store,'네',noAi,{replyTo});
  await run(store,'네',noAi,{replyTo});
  assert.equal((await store.history()).length,1);
});

test('changed, completed, cancelled, moved or missing frozen targets block the whole batch',async () => {
  for (const fields of [{notes:'수정'}, {status:'done'}, {status:'cancelled'}, {dueDate:'2026-11-18'}, null]) {
    const store = await fixture();
    const rows = [task('변경될 작업'),task('그대로 둘 작업')];
    await seed(store,rows);
    await run(store,'어제 일정 완료해줘',classify('2026-11-17'));
    if (fields) await edit(store,rows[0],fields);
    else {
      await db.exec('reset role');
      try { await pool.query('delete from assistant.tasks where family_id=$1 and id=$2',[store.familyId,rows[0].id]); }
      finally { await db.exec('set role assistant_app'); }
    }
    const before = await store.history();
    assert.match(await run(store,'네'),/바뀌었어요/);
    assert.equal((await store.tasks()).find(t=>t.id===rows[1].id).status,'open');
    assert.deepEqual(await store.history(),before);
  }
});

test('past virtual and materialized recurring occurrences complete only the selected date',async () => {
  const store = await fixture();
  const series = await store.createScheduleSeries({kind:'appointment',title:'반복 작업',timezone:timeZone,all_day:true,
    start_date:'2026-09-01',end_date_exclusive:'2026-09-02',recurrence_raw:['RRULE:FREQ=DAILY;COUNT=3']},'1');
  const range = {now,timeZone,from:'2026-09-01',to:'2026-09-03'};
  const original = await store.calendarTasks(range);
  const originalSeries = (await store.activeScheduleSeries()).find(t=>t.id===series.id);
  await edit(store,original.find(t=>t.dueDate==='2026-09-02'),{notes:'연결된 회차'});
  for (const date of ['2026-09-01','2026-09-02']) {
    await run(store,date+' 일정 완료해줘',classify(date));
    await run(store,'네');
  }
  const saved = await store.calendarTasks(range);
  assert.deepEqual(saved.map(t=>[t.dueDate,t.status]).sort(),[
    ['2026-09-01','done'],['2026-09-02','done'],['2026-09-03','open']]);
  assert.deepEqual((await store.activeScheduleSeries()).find(t=>t.id===series.id),originalSeries);
  assert.equal((await pool.query('select * from assistant.calendar_sync_outbox where family_id=$1',[store.familyId])).rows.length,0);
  assert.equal(saved.filter(t=>t.dueDate==='2026-09-01').length,1);
});

test('zero targets and 21 targets do not pause or mutate; 20 targets complete together',async () => {
  for (const count of [0,20,21]) {
    const store = await fixture();
    await seed(store,Array.from({length:count},(_,i)=>task('작업 '+i)));
    const reply = await run(store,'어제 일정 완료해줘',classify('2026-11-17'));
    assert.equal((await store.history()).length,0);
    assert.equal((await store.conversation('1')).pending,count===20);
    if (count===20) {
      assert.match(reply,/20건 모두 완료/);
      await run(store,'네');
      assert.equal((await store.tasks()).filter(t=>t.status==='done').length,20);
    } else assert.match(reply,count ? /20건/ : /없어요/);
  }
});

test('two approvals planned against the same checkpoint consume the token once',async () => {
  const store = await fixture();
  await seed(store,[task('한 번만 완료')]);
  await run(store,'어제 일정 완료해줘',classify('2026-11-17'));
  const planned = [];
  const deferred = Object.create(store);
  deferred.finish = async (...args) => {planned.push(args);};
  await run(deferred,'네');
  await run(deferred,'응');
  assert.equal(planned.length,2);
  assert.equal(planned[0][4].resumeToken,planned[1][4].resumeToken);
  await store.finish(...planned[0]);
  await assert.rejects(store.finish(...planned[1]),/확인 요청이 이미 처리/);
  assert.equal((await store.history()).length,1);
  assert.equal((await store.tasks())[0].version,2);
});

test('new tasks cannot displace frozen targets through the list-size limit',async () => {
  const store = await fixture();
  const original = task('처음 승인할 작업');
  await seed(store,[original]);
  await run(store,'어제 일정 완료해줘',classify('2026-11-17'));
  const added = Array.from({length:105},(_,i)=>task('뒤늦게 추가 '+i));
  await seed(store,added);
  await run(store,'네');
  assert.equal((await store.tasks()).find(t=>t.id===original.id).status,'done');
  assert.equal((await store.tasks()).filter(t=>t.status==='open').length,105);
});

test('a truncated target list never opens an approval or changes any rows',async () => {
  const store = await fixture();
  await seed(store,Array.from({length:6},(_,i)=>task('긴 자료 '+i,{notes:'긴'.repeat(4000)})));
  assert.match(await run(store,'어제 일정 완료해줘',classify('2026-11-17')),/조회 한도/);
  assert.equal((await store.conversation('1')).pending,false);
  assert.equal((await store.history()).length,0);
});

test('a conflict after planning rolls back the entire completion transaction',async () => {
  const store = await fixture();
  await seed(store,[task('작업 A'),task('작업 B')]);
  await run(store,'어제 일정 완료해줘',classify('2026-11-17'));
  const pending = await store.conversation('1');
  const lastId = pending.request.dateCompletion.targets.at(-1).id;
  const last = (await store.tasks()).find(t=>t.id===lastId);
  await assert.rejects(run(store,'네',noAi,{authorize:async () => {
    await edit(store,last,{notes:'완료 저장 직전 변경'});
  }}),/다른 작업에서 목록이 변경/);
  assert.ok((await store.tasks()).every(t=>t.status==='open'));
  assert.equal((await store.history()).length,1);
  assert.deepEqual(await store.conversation('1'),pending);
});

test('moved recurring occurrence is selected by its actual day; series changes block approval',async () => {
  const store = await fixture();
  const series = await store.createScheduleSeries({kind:'appointment',title:'이동할 반복 작업',timezone:timeZone,all_day:true,
    start_date:'2026-11-16',end_date_exclusive:'2026-11-17',recurrence_raw:['RRULE:FREQ=DAILY;COUNT=2']},'1');
  const range = {now,timeZone,from:'2026-11-16',to:'2026-11-18'};
  const original = (await store.calendarTasks(range)).find(t=>t.dueDate==='2026-11-16');
  await edit(store,original,{dueDate:'2026-11-18',endDate:null});
  await run(store,'11월 16일 일정 완료해줘',classify('2026-11-16'));
  assert.equal((await store.conversation('1')).pending,false);
  await run(store,'오늘 일정 완료해줘',classify('2026-11-18'));
  assert.deepEqual((await store.conversation('1')).taskIds,[original.id]);
  await run(store,'네');
  const saved = await store.calendarTasks(range);
  assert.equal(saved.find(t=>t.id===original.id).status,'done');
  assert.equal(saved.find(t=>t.dueDate==='2026-11-17').status,'open');
  await run(store,'어제 일정 완료해줘',classify('2026-11-17'));
  await store.updateScheduleSeries(series.id,series.version,{title:'바뀐 시리즈'},'1');
  assert.match(await run(store,'네'),/바뀌었어요/);
  assert.equal((await store.calendarTasks(range)).find(t=>t.dueDate==='2026-11-17').status,'open');
});

test('single exact-title and explicitly named multiple completion retain their existing behavior',async () => {
  const store = await fixture();
  const rows = [task('서아 피부과'),task('기석 치과'),task('장보기')];
  await seed(store,rows);
  await run(store,'장보기 완료');
  await run(store,'11월 17일 서아 피부과랑 기석 치과 완료해줘',{
    classify:async()=>({...completion(),targets:['서아 피부과','기석 치과'],completion:{scope:'named',date:'2026-11-17',question:null}}),
    answer:async({tasks})=>({reply:'',actions:tasks.map(t=>({operation:'update',id:t.id,expectedVersion:t.version,task:{...t,status:'done'}}))})
  });
  assert.equal((await store.tasks()).filter(t=>t.status==='done').length,3);
  assert.equal((await store.conversation('1')).pending,false);
});

test('structured selection rejects invalid dates, title expansion and mismatched intents',async () => {
  assert.equal(validateIntent(completion()).completion.scope,'date_all');
  assert.equal(validateIntent(completion(null)).completion.scope,null);
  for (const value of [
    {...completion(),completion:{scope:'date_all',date:'2026-02-30',question:null}},
    {...completion(),targets:['치과']}, {...completion(),intent:'cancel'},
    {...completion(),completion:{scope:null,date:null,question:''}}
  ]) assert.throws(()=>validateIntent(value),/완료할 날짜/);
});

test('Codex classification supplies date scope schema and existing date policy in one call',async () => {
  const ai = new Codex({});
  ai.run = async (prompt,schema,_signal,stage) => {
    assert.equal(stage,'classify');
    assert.equal(schema,intentSchema);
    assert.ok(schema.required.includes('completion'));
    assert.ok(prompt.includes('11월 17일 일정 완료해줘'));
    assert.ok(prompt.includes('지난주 월요일'));
    assert.ok(prompt.includes('일정 날짜·시간 해석 정책'));
    return JSON.stringify(completion());
  };
  await ai.classify({message:{text:'어제 일정 완료해줘'},now,settings:{timeZone}});
});
