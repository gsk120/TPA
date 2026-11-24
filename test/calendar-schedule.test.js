import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { Store } from '../src/storage.js';
import { planTaskCreation, planChanges } from '../src/tasks.js';
import { processJob, schedule } from '../src/processor.js';
import { expandSeries, occurrenceDay, occurrenceId, validateSeries } from '../src/recurrence.js';
import { buildPrompt } from '../src/assistant/codex.js';
import { dateTimePolicy } from '../src/assistant/date-time-policy.js';
import { recordLink } from '../src/calendar-sync/store.js';
import { localEvent } from '../src/calendar-sync/mapping.js';
import { syncCalendarOnce } from '../src/calendar-sync/worker.js';
import { createScheduleSeries } from '../src/schedule-store.js';

const family = '129eec5c-61c8-418a-b670-7db608bb08a1';
const otherFamily = '129eec5c-61c8-418a-b670-7db608bb08a2';
const now = new Date('2026-11-16T12:00:00Z');
const timeZone = 'Asia/Seoul';
const daySeries = {
  kind:'appointment', title:'정기 모임', timezone:timeZone, all_day:true,
  start_date:'2026-11-16', end_date_exclusive:'2026-11-17', recurrence_raw:['RRULE:FREQ=DAILY;COUNT=2']
};
const legacyInput = {
  title:'독립 일정',kind:'event',status:'open',dueDate:'2026-11-16',time:'10:00',endDate:null,
  timeNote:null,person:null,assignee:null,notes:'원래 메모',followUpDate:null,actualDeadline:null,remindAt:[]
};
const schema = await readFile(new URL('../sql/schema.sql',import.meta.url),'utf8');
const migration = await readFile(new URL('../sql/calendar-sync.sql',import.meta.url),'utf8');

async function isolated(t,{migrate = true, seed = true} = {}) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec('create role anon; create role authenticated');
  await db.exec(schema);
  if (migrate) await db.exec(migration);
  if (seed) await db.query("insert into assistant.families(id,chat_id,user_ids,active) values($1,'-1',array['1'],true),($2,'-2',array['2'],true)",[family,otherFamily]);
  await db.exec('set role assistant_app');
  const query = async (sql, params = []) => {
    const result = await db.query(sql,params);
    return {...result,rowCount:result.rows.length || result.affectedRows || 0};
  };
  const pool = {query,connect:async () => ({query,release(){}})};
  return {db,query,store:new Store(pool,family),other:new Store(pool,otherFamily)};
}

function expand(data, from, to) {
  validateSeries(data);
  return [...expandSeries(data,from,to)];
}

test('RRULE bounds, weekdays, month end, missing 31st and leap day', () => {
  const dates = (start, end, rule, to) => expand({...daySeries,start_date:start,end_date_exclusive:end,recurrence_raw:[rule]},start,to).map(r => r.anchor);
  assert.deepEqual(dates('2024-01-31','2024-02-01','RRULE:FREQ=MONTHLY;COUNT=3','2024-07-31'),['2024-01-31','2024-03-31','2024-05-31']);
  assert.deepEqual(dates('2024-01-31','2024-02-01','RRULE:FREQ=MONTHLY;BYMONTHDAY=-1;UNTIL=20240430','2024-05-31'),['2024-01-31','2024-02-29','2024-03-31','2024-04-30']);
  assert.deepEqual(dates('2024-02-29','2024-03-01','RRULE:FREQ=MONTHLY;INTERVAL=12;COUNT=2','2028-03-01'),['2024-02-29','2028-02-29']);
  assert.deepEqual(dates('2026-11-16','2026-11-17','RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=4','2026-12-05'),['2026-11-16','2026-11-18','2026-11-30','2026-12-02']);
  assert.throws(() => dates('2024-01-01','2024-01-02','RRULE:FREQ=MONTHLY;BYSETPOS=-1','2024-02-01'), /반복 규칙/);
});

test('DST gaps do not consume COUNT and repeated clocks retain a stable original fold', () => {
  const timed = {...daySeries, all_day:false, timezone:'America/New_York',
    start_at:'2026-03-07T02:30:00-05:00',end_at:'2026-03-07T03:30:00-05:00'};
  const spring = expand(timed,'2026-03-07','2026-03-10');
  assert.deepEqual(spring.map(item => item.start),['2026-03-07T07:30:00.000Z','2026-03-09T06:30:00.000Z']);
  const fall = {...timed,start_at:'2026-11-01T01:30:00-05:00',end_at:'2026-11-01T02:30:00-05:00'};
  const [first] = expand(fall,'2026-11-01','2026-11-01');
  assert.equal(first.anchor,'2026-11-01T01:30:00#1');
  assert.equal(first.start,'2026-11-01T06:30:00.000Z');
  const uuid = occurrenceId(family,otherFamily,first.anchor);
  assert.equal(occurrenceDay(uuid),'2026-11-01');
  assert.notEqual(uuid,occurrenceId(otherFamily,otherFamily,first.anchor));
  const inclusive = {...timed,recurrence_raw:['RRULE:FREQ=DAILY;UNTIL=20260309T063000Z']};
  assert.deepEqual(expand(inclusive,'2026-03-07','2026-03-11').map(r=>r.start),spring.map(r=>r.start));
  const range = {...timed,time_type:'range',start_at:'2026-03-07T01:30:00-05:00',end_at:'2026-03-07T03:30:00-05:00'};
  const [,springRange] = expand(range,'2026-03-07','2026-03-08');
  assert.equal(springRange.start,'2026-03-08T06:30:00.000Z');
  assert.equal(springRange.end,'2026-03-08T07:30:00.000Z');
});

let nextJob = 400;
async function request(store,text,ai,extra = {}) {
  const id = ++nextJob;
  await store.ingest(id,{actor:'1',chatId:'-1',text,...extra});
  return processJob(await store.claim(extra.button ? 'button:' + extra.button.token : 'tg:' + id),store,ai,now);
}

const seriesDraft = fields => ({
  title:null,frequency:null,weekday:null,monthDay:null,start:null,end:null,time:null,timeType:null,
  endTime:null,endDayOffset:null,timeNote:null,timeZone:null,...fields
});
const creationAnswer = (series,extra = {}) => ({
  series,reply:'',actions:[],settings:null,retrieval:null,clarification:null,...extra
});
const createWith = (fields, extra) => ({
  classify:async () => ({intent:'create',targets:[],answer:creationAnswer(seriesDraft(fields),extra)})
});

test('migration is additive, respects app grants, and has no effect without a series', async t => {
  const {db,query,store} = await isolated(t,{migrate:false});
  const legacy = planTaskCreation(legacyInput,'fixture',now).after;
  await query('insert into assistant.tasks(family_id,id,version,data) values($1,$2,$3,$4)',[family,legacy.id,legacy.version,legacy]);
  const baseline = await request(store,'/list');
  await db.exec('reset role');
  await db.exec(migration);
  await db.exec(migration);
  await db.exec('set role assistant_app');
  assert.equal(await request(store,'/list'),baseline);
  assert.deepEqual(await store.tasks(),[legacy]);
  const tables = await query("select table_name from information_schema.tables where table_schema='assistant' and (table_name like 'schedule_%' or table_name like 'calendar_%')");
  assert.equal(tables.rows.length,9);
  await db.exec('set role anon');
  await assert.rejects(db.query('select * from assistant.schedule_series'),/permission denied/);
});

test('today, week, list, natural ranges and both briefings resolve virtual rows without writes', async t => {
  const {query,store,other} = await isolated(t);
  await store.createScheduleSeries(daySeries,'1');
  await store.createScheduleSeries({...daySeries,title:'먼 일정', start_date:'2027-02-01',end_date_exclusive:'2027-02-02'},'1');
  for (const command of ['/today','/week','/list','오늘 일정 알려줘']) {
    assert.match(await request(store,command),/정기 모임/);
  }
  const ai = {classify:async () => ({intent:'retrieve',targets:[],answer:{
    reply:'',actions:[],settings:null,clarification:null,retrieval:{kind:'task_list',from:'2027-02-01',to:'2027-02-01',status:'active',search:null,person:null}
  }})};
  assert.match(await request(store,'2027년 2월 1일 일정 조회해줘',ai),/먼 일정/);
  await schedule(store,now,{timeZone,dailyTime:'08:00',weeklyTime:'20:00',weeklyDay:1,dailyEnabled:true,weeklyEnabled:true},1);
  const briefs = (await query("select text,result from assistant.deliveries where id like 'daily:%' or id like 'weekly:%'")).rows;
  assert.equal(briefs.length,2);
  assert.ok(briefs.every(row => row.text.includes('정기 모임') && row.result.context.refs.some(ref => ref.title === '정기 모임')));
  const snapshot = await store.backup();
  assert.deepEqual(snapshot.tasks,[]);
  assert.deepEqual(snapshot.history,[]);
  assert.deepEqual(snapshot.calendar.schedule_occurrences,[]);
  assert.deepEqual(snapshot.calendar.calendar_sync_outbox,[]);
  assert.deepEqual(await other.calendarTasks({now,timeZone}),[]);
});

async function edit(store,id,fields,at = now) {
  const task = (await store.calendarTasks({now:at,timeZone,includeIds:[id]})).find(item => item.id === id);
  assert.ok(task,'the original occurrence is available');
  const changes = planChanges([{operation:'update',id,expectedVersion:task.version,task:{...task,...fields},reason:'회차 변경'}],[task],at);
  const jobId = ++nextJob;
  await store.ingest(jobId,{actor:'1',chatId:'-1',text:'회차 편집'});
  await store.finish(await store.claim('tg:' + jobId),changes,'저장');
  return changes[0].after;
}

test('first materialization, movement, completion, cancellation and Telegram undo retain identity', async t => {
  const {query,store} = await isolated(t);
  const series = await store.createScheduleSeries(daySeries,'1');
  const [virtual] = await store.calendarTasks({now,timeZone});
  assert.equal(virtual.id,(await store.calendarTasks({now,timeZone:'America/Los_Angeles'})).find(item=>item.recurrence.anchor===virtual.recurrence.anchor).id);
  assert.equal(virtual.recurrence.virtual,true);
  const moved = await edit(store,virtual.id,{dueDate:'2027-01-04',notes:'개별 메모'});
  assert.equal(moved.id,virtual.id);
  assert.equal((await store.calendarTasks({now,timeZone})).filter(item => item.id === virtual.id).length,1);
  const ai = {
    classify:async () => ({intent:'cancel',targets:['정기 모임'],answer:null}),
    answer:async ({tasks}) => ({reply:'',settings:null,clarification:null,retrieval:null,actions:[{
      operation:'update',id:virtual.id,expectedVersion:tasks[0].version,task:{...tasks[0],status:'cancelled'},reason:'취소'
    }]})
  };
  assert.match(await request(store,'2027-01-04 정기 모임 취소해줘',ai),/취소/);
  assert.equal((await store.tasks()).find(item=>item.id===virtual.id).status,'cancelled');
  const token = (await query("select substring(key from 8) as token from assistant.runtime where key like 'button:%' and value->>'kind'='undo'")).rows[0].token;
  await query("update assistant.runtime set value=jsonb_set(value,'{expiresAt}',to_jsonb('2099-01-01T00:00:00Z'::text)) where key=$1",['button:' + token]);
  assert.match(await request(store,'',null,{button:{token,index:0,messageId:1}}),/되돌렸어요/);
  const restored = (await store.calendarTasks({now,timeZone})).find(item=>item.id===virtual.id);
  const siblingId = occurrenceId(family,series.id,'2026-11-17');
  const sibling = (await store.calendarTasks({now,timeZone})).find(item=>item.id===siblingId);
  const beforeCompletion = await store.backup();
  assert.equal(restored.dueDate,'2027-01-04');
  assert.equal(restored.notes,'개별 메모');
  assert.equal(restored.status,'open');
  await edit(store,virtual.id,{status:'done'});
  const snapshot = await store.backup();
  assert.equal(snapshot.tasks[0].data.status,'done');
  assert.equal(snapshot.history.length,4);
  assert.equal(snapshot.calendar.schedule_occurrences[0].series_id,series.id);
  assert.equal(snapshot.calendar.schedule_exceptions[0].overrides.timing.start,'2027-01-04');
  assert.deepEqual(snapshot.calendar.schedule_exceptions,beforeCompletion.calendar.schedule_exceptions);
  assert.deepEqual(snapshot.calendar.schedule_series,beforeCompletion.calendar.schedule_series);
  assert.deepEqual((await store.calendarTasks({now,timeZone})).find(item=>item.id===siblingId),sibling);
  assert.deepEqual(snapshot.calendar.calendar_sync_outbox,[]);
});

test('Telegram undo reconciles pending, completed and uncertain Google cancellations without duplicates', async t => {
  const {query,store}=await isolated(t);
  const settings={familyId:family,calendarId:'undo.calendar',key:Buffer.alloc(32),allowDelete:true};
  const connection={family_id:family,id:otherFamily,key:settings.key};
  const env={CALENDAR_SYNC_ENABLED:'true',CALENDAR_SYNC_FAMILY_ID:family,GOOGLE_CALENDAR_ID:settings.calendarId,CALENDAR_SYNC_ALLOW_DELETE:'true'};
  const previous=Object.fromEntries(Object.keys(env).map(key=>[key,process.env[key]]));
  Object.assign(process.env,env);
  t.after(()=>{for(const [key,value] of Object.entries(previous)) {
    if (value===undefined) delete process.env[key]; else process.env[key]=value;
  }});
  await query(`insert into assistant.calendar_sync_state(family_id,id,calendar_id,mode,sync_token)
    values($1,$2,$3,'bidirectional','initial')`,[family,connection.id,settings.calendarId]);
  const remote=new Map(), incoming=[];
  let creates=0, uncertain=false, lostCreateResponse=false;
  const error=status=>Object.assign(new Error('Simulated Google failure'),{status});
  const api={
    list:async()=>({items:incoming.splice(0),nextSyncToken:'current'}),
    get:async id=>{if (!remote.has(id)) throw error(404); return remote.get(id);},
    create:async event=>{
      assert.ok(!remote.has(event.id));
      const created={...event,etag:'created'};
      remote.set(event.id,created);
      incoming.push(created);
      creates++;
      if (lostCreateResponse) { lostCreateResponse=false; throw error(503); }
      return created;
    },
    remove:async id=>{
      remote.delete(id);
      incoming.push({id,status:'cancelled',etag:'deleted'});
      if (uncertain) throw error(503);
    },
    instances:async parentId=>({items:[...remote.values()].filter(event=>event.recurringEventId===parentId)}),
    patch:async (id,fields,etag)=>{
      assert.equal(remote.get(id).etag,etag);
      const updated={...remote.get(id),...fields,etag:etag+'-updated'};
      remote.set(id,updated);
      incoming.push(updated);
      return updated;
    }
  };
  const tick=async()=>{
    assert.equal(await syncCalendarOnce(store.pool,settings,api,new AbortController().signal,{force:true}),true);
  };
  async function cancelAndGetUndo(title,id,date) {
    await request(store,(date ? date+' ' : '')+title+' 취소해줘',{
      classify:async()=>({intent:'cancel',targets:[title],answer:null}),
      answer:async({tasks})=>{
        const task=tasks.find(item=>item.id===id);
        assert.ok(task);
        return {actions:[{operation:'update',id,expectedVersion:task.version,task:{...task,status:'cancelled'}}]};
      }
    });
    const {rows}=await query(`select substring(key from 8) as token from assistant.runtime
      where key like 'button:%' and value->>'kind'='undo' and value->'changes'->0->'after'->>'id'=$1`,[id]);
    assert.equal(rows.length,1);
    await query("update assistant.runtime set value=jsonb_set(value,'{expiresAt}',to_jsonb('2099-01-01T00:00:00Z'::text)) where key=$1",
      ['button:'+rows[0].token]);
    return rows[0].token;
  }
  for (const stage of ['pending','done','uncertain']) {
    const task=planTaskCreation({...legacyInput,title:'Undo '+stage},'test',now).after;
    await query('insert into assistant.tasks(family_id,id,version,data) values($1,$2,$3,$4)',[family,task.id,task.version,task]);
    const event={id:stage,etag:'active',...localEvent('task',task,timeZone)};
    remote.set(event.id,event);
    await store.tx(c=>recordLink(c,connection,'task',task,event,{source:'import'}));
    const token=await cancelAndGetUndo(task.title,task.id);
    uncertain=stage==='uncertain';
    if (stage!=='pending') await tick();
    assert.equal(remote.has(event.id),stage==='pending');
    assert.match(await request(store,'',null,{button:{token,index:0,messageId:1}}),/되돌렸어요/);
    if (stage==='done') lostCreateResponse=true;
    await tick();
    if (stage==='done') {
      await query("update assistant.calendar_sync_outbox set next_attempt_at=now() where state='uncertain'");
      await tick();
    }
    const [restored]=[...remote.values()].filter(item=>item.summary===task.title);
    assert.ok(restored);
    assert.equal([...remote.values()].filter(item=>item.summary===task.title).length,1);
    assert.equal(restored.id===event.id,stage==='pending');
    const links=(await query('select * from assistant.calendar_event_links where task_id=$1',[task.id])).rows;
    assert.equal(links.find(link=>link.status==='active').google_event_id,restored.id);
    assert.equal(links.find(link=>link.status==='active').agreed_fields.source,'import');
    assert.equal((await store.tasks()).find(item=>item.id===task.id).status,'open');
    assert.equal((await store.tasks()).filter(item=>item.title===task.title).length,1);
  }
  assert.equal(creates,2);
  const series=await store.tx(c=>createScheduleSeries(c,family,daySeries,'1',{origin:'google'}));
  const parent={id:'series',etag:'parent',...localEvent('series',series,timeZone)};
  remote.set(parent.id,parent);
  await store.tx(c=>recordLink(c,connection,'series',series,parent));
  const [task,sibling]= (await store.calendarTasks({now,timeZone})).filter(item=>item.recurrence?.seriesId===series.id);
  const instance={id:'instance',etag:'child',recurringEventId:parent.id,originalStartTime:{date:task.dueDate},
    ...localEvent('occurrence',task,timeZone)};
  remote.set(instance.id,instance);
  const token=await cancelAndGetUndo(task.title,task.id,task.dueDate);
  await tick();
  assert.equal(remote.get(instance.id).status,'cancelled');
  assert.match(await request(store,'',null,{button:{token,index:0,messageId:1}}),/되돌렸어요/);
  await tick();
  await tick();
  assert.equal(remote.get(instance.id).status,'confirmed');
  assert.equal((await store.calendarTasks({now,timeZone})).find(item=>item.id===sibling.id).status,'open');
  assert.equal(creates,2);
  assert.deepEqual((await query('select reason from assistant.calendar_sync_conflicts')).rows,[]);
});

test('approved link retains existing UUID, state, custom fields and history and forbids cross-family links', async t => {
  const {query,store,other} = await isolated(t);
  const legacy = {...planTaskCreation(legacyInput,'fixture',now).after, extra:{kept:true}};
  await query('insert into assistant.tasks(family_id,id,version,data) values($1,$2,$3,$4)',[family,legacy.id,legacy.version,legacy]);
  await query("insert into assistant.history(family_id,actor,task_id,after_data,reason) values($1,'1',$2,$3,'기존')",[family,legacy.id,legacy]);
  const series = await store.createScheduleSeries({...daySeries,all_day:false,start_at:'2026-11-16T10:00:00+09:00',end_at:'2026-11-16T11:00:00+09:00'},'1');
  const input = {seriesId:series.id,anchor:'2026-11-16T10:00:00#0',taskId:legacy.id,expectedVersion:1,expectedSeriesVersion:1,timeZone,actor:'1'};
  await assert.rejects(other.linkScheduleOccurrence({...input,seriesId:(await other.createScheduleSeries({...daySeries,all_day:false,start_at:series.start_at,end_at:series.end_at},'2')).id}),/변경/);
  await store.linkScheduleOccurrence(input);
  await store.linkScheduleOccurrence(input);
  assert.deepEqual(await store.tasks(),[legacy]);
  assert.equal((await store.history()).length,1);
  assert.equal((await store.calendarTasks({now,timeZone})).filter(item => item.dueDate === '2026-11-16').length,1);
  assert.equal((await store.backup()).calendar.schedule_occurrences[0].task_id,legacy.id);
});

test('repeat requests create finite and open-ended series while legacy tasks and history stay independent', async t => {
  const {store,query} = await isolated(t);
  const legacy = planTaskCreation({...legacyInput,title:'레거시 수업'},'매주 반복 일정 일괄 등록',now).after;
  await query('insert into assistant.tasks(family_id,id,version,data) values($1,$2,$3,$4)',[family,legacy.id,legacy.version,legacy]);
  await query("insert into assistant.history(family_id,actor,task_id,after_data,reason) values($1,'1',$2,$3,'매주 반복 일정 일괄 등록')",[family,legacy.id,legacy]);
  await query("insert into assistant.calendar_sync_state(family_id,id,calendar_id) values($1,$2,'fixture.calendar')",[family,otherFamily]);
  await query("insert into assistant.calendar_event_links(family_id,connection_id,google_event_id,task_id) values($1,$2,'legacy-event',$3)",[family,otherFamily,legacy.id]);
  const before = await store.backup();

  const finite = '2026년 11월 30일까지 매주 월요일 정기 수업 12시 20분 추가해줘';
  const sentAt = Date.parse('2026-11-12T02:00:00Z') / 1000;
  const finiteAi = createWith({title:'정기 수업',frequency:'WEEKLY',weekday:1,end:'2026-11-30',time:'12:20',timeType:'timed'});
  const receipt = await request(store,finite,finiteAi,{sentAt});
  assert.match(receipt,/시리즈 등록[\s\S]*회차 3건/);
  assert.match(await request(store,finite,finiteAi,{sentAt}),/이미 처리된 요청/);
  assert.match(await request(store,'화요일마다 운동은 오후 세 시로 잡아 줘',
    createWith({title:'운동',frequency:'WEEKLY',weekday:2,time:'15:00',timeType:'timed'})),/종료일 없이 반복/);
  assert.match(await request(store,'매일 아침산책 08:00 등록해줘',
    createWith({title:'아침산책',frequency:'DAILY',time:'08:00',timeType:'timed'})),/종료일 없이 반복/);
  assert.match(await request(store,'매월 말일 종일 정산 일정 추가해줘',
    createWith({title:'정산',frequency:'MONTHLY',monthDay:-1,timeType:'all_day'})),/종료일 없이 반복/);

  const snapshot = await store.backup();
  assert.deepEqual(snapshot.tasks,before.tasks);
  assert.deepEqual(snapshot.history,before.history);
  assert.equal(snapshot.calendar.schedule_series.length,4);
  assert.equal(snapshot.calendar.schedule_occurrences.length,0);
  assert.equal(snapshot.calendar.schedule_series_history.length,4);
  assert.deepEqual(snapshot.calendar.calendar_event_links,before.calendar.calendar_event_links);
  const entries = await store.calendarTasks({now,timeZone});
  assert.deepEqual(entries.filter(task=>task.title==='정기 수업').map(task=>task.dueDate),[
    '2026-11-16','2026-11-23','2026-11-30'
  ]);
  assert.ok(entries.filter(task=>task.title==='정기 수업').every(task=>task.time==='12:20' && task.recurrence.timing.end===null));
  assert.ok(entries.some(task=>task.title==='정산' && task.dueDate==='2026-11-30' && task.time===null));
  assert.deepEqual(entries.filter(task=>!task.recurrence),[legacy]);
  const first = entries.find(task=>task.title==='정기 수업');
  await assert.rejects(store.linkScheduleOccurrence({
    seriesId:first.recurrence.seriesId,anchor:first.recurrence.anchor,taskId:legacy.id,
    expectedVersion:1,expectedSeriesVersion:1,timeZone,actor:'1'
  }),/독립 일정/);
});

test('a monthly repeat asks for missing timing, resumes in LangGraph and can retry a failed save', async t => {
  const {store,db} = await isolated(t);
  const fields = {title:'독서 모임',frequency:'MONTHLY',monthDay:24};
  const ai = {
    ...createWith(fields),
    answer:async ({pendingRequest}) => {
      assert.deepEqual(pendingRequest.seriesDraft,seriesDraft(fields));
      return creationAnswer(seriesDraft({...fields,timeType:'all_day'}));
    }
  };
  assert.match(await request(store,'매월 24일 독서 모임 반복해줘 종료일은 없어',ai),/시각 또는 종일 여부/);
  assert.ok((await store.conversation('1')).workflow);
  assert.equal((await store.backup()).calendar.schedule_series.length,0);
  assert.match(await request(store,'종일',ai),/종료일 없이 반복/);
  assert.match(await request(store,'/list'),/독서 모임/);
  assert.match(await request(store,'2026년 11월 15일까지 매주 월요일 예전 수업 12:20 등록',
    createWith({title:'예전 수업',frequency:'WEEKLY',weekday:1,end:'2026-11-15',time:'12:20',timeType:'timed'})),/등록 0건/);
  const retry = '매주 수요일 예정된 수업 12:20 등록';
  const retryAi = createWith({title:'예정된 수업',frequency:'WEEKLY',weekday:3,time:'12:20',timeType:'timed'});
  await db.exec("reset role; alter table assistant.schedule_series add constraint fixture_save_failure check (title <> '예정된 수업'); set role assistant_app");
  await assert.rejects(request(store,retry,retryAi),/반복 일정 저장 오류/);
  await db.exec('reset role; alter table assistant.schedule_series drop constraint fixture_save_failure; set role assistant_app');
  assert.match(await request(store,retry,retryAi),/시리즈 등록/);
  assert.equal((await store.backup()).calendar.schedule_series.length,2);
  assert.deepEqual(await store.tasks(),[]);
});

test('series plus per-occurrence creates is rejected before writes while an ordinary create still succeeds', async t => {
  const {store} = await isolated(t);
  const action = {operation:'create',id:null,expectedVersion:null,task:legacyInput,reason:'일정 등록'};
  const text = '이번 달부터 2027년 1월까지 매월 24일 도서관 휴관일을 종일 일정으로 반복해줘';
  const fields = {title:'도서관 휴관일',frequency:'MONTHLY',monthDay:24,start:'2026-11-01',end:'2027-01-31',timeType:'all_day'};
  await assert.rejects(request(store,text,createWith(fields,{actions:[action]})),/저장을 보류/);
  const snapshot = await store.backup();
  assert.deepEqual(snapshot.tasks,[]);
  assert.deepEqual(snapshot.history,[]);
  assert.deepEqual(snapshot.calendar.schedule_series,[]);
  assert.match(await request(store,text,createWith(fields)),/시리즈 등록[\s\S]*회차 3건/);
  assert.deepEqual(await store.tasks(),[]);
  const occurrences = await store.calendarTasks({now,timeZone,from:'2026-11-01',to:'2027-02-28',listOnly:true});
  assert.deepEqual(occurrences.map(item => item.dueDate),['2026-11-24','2026-12-24','2027-01-24']);
  const ordinary = {classify:async () => ({
    intent:'create',targets:[],answer:creationAnswer(null,{actions:[action]})
  })};
  assert.match(await request(store,'독립 일정 추가해줘',ordinary),/저장 완료/);
  assert.equal((await store.tasks()).length,1);
});

test('both ordinary and repeat AI prompts include the full date and time policy', () => {
  for (const text of ['12월 1일 생일 추가해줘','매월 24일 도서관 휴관일 반복해줘']) {
    const prompt = buildPrompt({tasks:[],history:[],context:[],message:{text},now});
    assert.ok(prompt.includes(dateTimePolicy));
  }
});

test('ordinary timing types distinguish all-day, unknown, deadline, condition and range', async t => {
  const {store} = await isolated(t);
  const drafts = [
    {title:'생일',timeType:'all_day',time:null},
    {title:'병원 진료',timeType:'unknown',time:null},
    {title:'서류 제출',kind:'task',timeType:'date_only',time:null},
    {title:'기사 방문',timeType:'condition',time:null,timeNote:'14시 이후'},
    {title:'팀 회의',timeType:'range',time:'14:00',endTime:'15:30',sourceTimeZone:'Asia/Tokyo'}
  ];
  const ordinary = {classify:async () => ({intent:'create',targets:[],
    answer:creationAnswer(null,{actions:drafts.map(task => ({
      operation:'create',id:null,expectedVersion:null,task:{...legacyInput,...task},reason:'일정 등록'
    }))})})};
  const reply = await request(store,'생일, 시간 미정 병원, 서류 마감, 기사 방문 조건과 회의 범위를 등록해줘',ordinary);
  assert.match(reply,/종일/);
  assert.match(reply,/시간 미정/);
  assert.match(reply,/팀 회의[^\n]*\n[^\n]*오후 2시/);
  assert.doesNotMatch(reply,/오후 3시 30분/);
  const tasks = await store.tasks();
  for (const draft of drafts) {
    const task = tasks.find(row => row.title === draft.title);
    for (const [key,value] of Object.entries(draft)) assert.equal(task[key],value);
  }
  assert.match(await request(store,'/list'),/14시 이후 · 기사 방문/);
  const invalid = {classify:async () => ({intent:'create',targets:[],answer:creationAnswer(null,{actions:[{
    operation:'create',id:null,expectedVersion:null,
    task:{...legacyInput,timeType:'unknown',time:'15:30'},reason:'일정 등록'
  }]})})};
  await assert.rejects(request(store,'시간 미정 일정 추가해줘',invalid),/시간 유형과 시각/);
  assert.deepEqual(await store.tasks(),tasks);
});

test('repeat timing types survive projections and a single unknown occurrence can receive a time', async t => {
  const {store,query} = await isolated(t);
  const cases = [
    ['매월 24일 도서관 휴관일 반복해줘',{title:'도서관 휴관일',frequency:'MONTHLY',monthDay:24,timeType:'all_day'},/종일/],
    ['매주 수요일 진료, 시간은 미정으로 반복해줘',{title:'진료',frequency:'WEEKLY',weekday:3,timeType:'unknown'},/시간 미정/],
    ['매주 수요일 14시 이후 기사 방문 잡아줘',{title:'기사 방문',frequency:'WEEKLY',weekday:3,timeType:'condition',timeNote:'14시 이후'},/14시 이후/],
    ['매주 수요일 도쿄 시간 14시부터 15시 30분까지 회의 잡아줘',
      {title:'회의',frequency:'WEEKLY',weekday:3,timeType:'range',time:'14:00',endTime:'15:30',timeZone:'Asia/Tokyo'},/\) 14:00\n/],
    ['수요일마다 서류 제출 마감 잡아줘',{title:'서류 제출',frequency:'WEEKLY',weekday:3,timeType:'date_only'},/마감/]
  ];
  for (const [text,fields,expected] of cases) {
    assert.match(await request(store,text,createWith(fields)),expected);
  }
  const rows = (await query(
    'select title,time_type,all_day,start_at,end_at,timezone from assistant.schedule_series where family_id=$1',[family]
  )).rows;
  const unknown = rows.find(row=>row.time_type==='unknown');
  assert.equal(unknown.all_day,false);
  assert.equal(unknown.start_at,null);
  assert.equal(unknown.end_at,null);
  assert.equal(rows.find(row=>row.time_type==='range').timezone,'Asia/Tokyo');
  assert.equal(rows.find(row=>row.time_type==='all_day').all_day,true);
  const projected = await store.calendarTasks({now,timeZone});
  const [first,sibling] = projected.filter(task=>task.title==='진료');
  assert.equal(first.timeType,'unknown');
  assert.equal(first.recurrence.allDay,false);
  assert.equal(first.time,null);
  assert.equal(projected.find(task=>task.title==='회의').endTime,'15:30');
  assert.equal(projected.find(task=>task.title==='서류 제출').kind,'task');
  await edit(store,first.id,{timeType:'timed',time:'11:00'});
  await edit(store,first.id,{status:'done'});
  const after = await store.calendarTasks({now,timeZone});
  assert.equal(after.find(task=>task.id===first.id).time,'11:00');
  assert.equal(after.find(task=>task.id===first.id).status,'done');
  assert.deepEqual(after.find(task=>task.id===sibling.id),sibling);
  await store.updateScheduleSeries(first.recurrence.seriesId,1,{all_day:true,time_type:'all_day'},'1');
  const updated = await store.calendarTasks({now,timeZone});
  assert.equal(updated.find(task=>task.id===first.id).time,'11:00');
  assert.equal(updated.find(task=>task.id===sibling.id).timeType,'all_day');
  assert.deepEqual((await store.backup()).calendar.calendar_sync_outbox,[]);
});
test('explicit completion and change find a virtual recurrence beyond the default window', async t => {
  const {store}=await isolated(t);
  const title='연동테스트3';
  const series=await store.createScheduleSeries({
    title,kind:'appointment',timezone:timeZone,all_day:false,time_type:'timed',
    start_at:'2026-11-24T09:00:00Z',recurrence_raw:['RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=7']
  },'1');
  const on=day=>store.calendarTasks({now,timeZone,from:day,to:day,listOnly:true});
  const [original]=await on('2026-12-29');
  assert.ok(original.recurrence.virtual);
  assert.ok(!(await store.calendarTasks({now,timeZone})).some(task=>task.id===original.id));

  const answer=(intent,patch,id)=>({
    classify:async()=>({intent,targets:[title],answer:null}),
    answer:async input=>{
      assert.deepEqual(input.tasks.map(task=>task.id),[id]);
      assert.equal(input.selectedTaskId,id);
      const [task]=input.tasks;
      return {actions:[{operation:'update',id,expectedVersion:task.version,task:{...task,...patch}}]};
    }
  });
  const [january]=await on('2027-01-05');
  assert.match(await request(store,'2027년 1월 5일 연동테스트3 완료해줘',
    answer('complete',{status:'done'},january.id)),/저장 완료/);
  assert.equal((await on('2027-01-05'))[0].status,'done');
  assert.match(await request(store,'12월 29일 연동테스트3을 12월 30일 오후 7시로 옮겨줘',
    answer('update',{dueDate:'2026-12-30',time:'19:00'},original.id)),/저장 완료/);
  assert.deepEqual(await on('2026-12-29'),[]);
  const [moved]=await on('2026-12-30');
  assert.equal(moved.id,original.id);
  assert.equal(moved.recurrence.seriesId,series.id);
  assert.equal(moved.time,'19:00');
  assert.match(await request(store,'12월 30일 연동테스트3 완료해줘',
    answer('complete',{status:'done'},original.id)),/저장 완료/);
  assert.equal((await on('2026-12-30'))[0].status,'done');

  assert.match(await request(store,'연동테스트3을 12월 30일 오후 7시로 옮겨줘',{
    classify:async()=>({intent:'update',targets:[title],answer:null}),
    answer:async()=>assert.fail('multiple default candidates must be narrowed before an update')
  }),/후보가 \d+건/);
  assert.equal((await on('2026-12-22'))[0].status,'open');
});

test('all-list window covers finite, open-ended, virtual and materialized occurrences without altering records', async t => {
  const {store,query} = await isolated(t);
  const seriesOn = (title,date,recurrence_raw = ['RRULE:FREQ=DAILY;COUNT=1']) => store.createScheduleSeries({
    ...daySeries,title,start_date:date,end_date_exclusive:new Date(Date.parse(date) + 86400000).toISOString().slice(0,10),recurrence_raw
  },'1');
  await seriesOn('오늘 반복','2026-11-16');
  await seriesOn('내일 반복','2026-11-17');
  await seriesOn('30일차 유한 회차','2026-12-15');
  await seriesOn('31일차 유한 회차','2026-12-16');
  const far = await seriesOn('31일차 무기한 회차','2026-12-16',['RRULE:FREQ=MONTHLY']);
  const past = await seriesOn('과거 유한 회차','2026-11-15');
  const farId = occurrenceId(family,far.id,'2026-12-16');
  await edit(store,farId,{notes:'연결된 회차'});
  await edit(store,occurrenceId(family,past.id,'2026-11-15'),{status:'done'});
  const legacy = planTaskCreation({...legacyInput,title:'먼 독립 일정',dueDate:'2027-02-01'},'fixture',now).after;
  await query('insert into assistant.tasks(family_id,id,version,data) values($1,$2,$3,$4)',[family,legacy.id,legacy.version,legacy]);
  const before = await store.backup();
  const assertAllList = reply => {
    assert.match(reply,/오늘 반복/);
    assert.match(reply,/30일차 유한 회차/);
    assert.match(reply,/먼 독립 일정/);
    assert.doesNotMatch(reply,/31일차|과거 유한 회차/);
    assert.match(reply,/오늘부터 30일/);
  };
  assertAllList(await request(store,'/list'));
  assertAllList(await request(store,'전체 일정 보여줘'));
  assert.doesNotMatch(await request(store,'/today'),/내일 반복/);
  assert.match(await request(store,'/week'),/내일 반복/);
  const ranged = (from,to,status='active') => ({classify:async()=>({intent:'retrieve',targets:[],answer:{
    reply:'',actions:[],settings:null,clarification:null,retrieval:{kind:'task_list',from,to,status,search:null,person:null}
  }})});
  assert.match(await request(store,'12월 16일 일정 조회해줘',ranged('2026-12-16','2026-12-16')),/31일차 무기한 회차/);
  assert.match(await request(store,'완료된 과거 일정 조회해줘',ranged('2026-11-15','2026-11-15','done')),/과거 유한 회차/);
  const after = await store.backup();
  assert.deepEqual(after.tasks,before.tasks);
  assert.deepEqual(after.history,before.history);
  assert.deepEqual(after.calendar,before.calendar);
});

test('series shortening preserves saved tasks and rejects edits that would strand an exception', async t => {
  const {store,query} = await isolated(t);
  const series = await store.createScheduleSeries(daySeries,'1');
  const [,task] = await store.calendarTasks({now,timeZone});
  await edit(store,task.id,{notes:'회차 메모',remindAt:['2026-11-16T12:15:00.000Z']});
  await schedule(store,new Date('2026-11-16T12:20:00Z'),{timeZone,dailyEnabled:false,weeklyEnabled:false});
  await store.updateScheduleSeries(series.id,1,{recurrence_raw:['RRULE:FREQ=DAILY;COUNT=1']},'1');
  const saved = (await store.tasks())[0];
  assert.equal(saved.id,task.id);
  assert.equal(saved.notes,'회차 메모');
  assert.equal(saved.status,'open');
  assert.equal((await store.calendarTasks({now,timeZone})).some(row=>row.id===task.id),false);
  assert.equal((await query("select status from assistant.deliveries where id like 'series-reminder:%'")).rows[0].status,'cancelled');
  await store.updateScheduleSeries(series.id,2,{recurrence_raw:['RRULE:FREQ=DAILY;COUNT=2']},'1');
  await edit(store,task.id,{dueDate:'2026-11-20'});
  await assert.rejects(store.updateScheduleSeries(series.id,3,{recurrence_raw:['RRULE:FREQ=DAILY;COUNT=1']},'1'),/예외/);
  assert.equal((await store.calendarTasks({now,timeZone})).find(row=>row.id===task.id).dueDate,'2026-11-20');
  assert.equal((await store.backup()).calendar.schedule_series[0].version,3);
});

const cancelRepeat = (scope, date = null, question = null) => ({
  intent:'cancel', targets:[daySeries.title], answer:null, cancellation:{scope,date,question}
});

test('natural whole-series cancellation reaches finite and unlimited series outside the list window', async t => {
  const {store,other,query} = await isolated(t);
  const finite = await store.createScheduleSeries(daySeries,'1');
  const unlimited = await store.createScheduleSeries({...daySeries,start_date:'2027-01-01',
    end_date_exclusive:'2027-01-02',recurrence_raw:['RRULE:FREQ=DAILY']},'1');
  const foreign = await other.createScheduleSeries(daySeries,'2');
  const legacy = planTaskCreation({...legacyInput,title:daySeries.title},'fixture',now).after;
  await query('insert into assistant.tasks(family_id,id,version,data) values($1,$2,$3,$4)',[family,legacy.id,legacy.version,legacy]);
  const [, linked] = (await store.calendarTasks({now,timeZone})).filter(task => task.recurrence);
  await edit(store,linked.id,{remindAt:['2026-11-16T12:15:00.000Z']});
  await schedule(store,new Date('2026-11-16T12:20:00Z'),{timeZone,dailyEnabled:false,weeklyEnabled:false});
  assert.equal((await query("select status from assistant.deliveries where id like 'series-reminder:%'")).rows[0].status,'pending');
  assert.ok(!(await store.calendarTasks({now,timeZone})).some(task => task.recurrence?.seriesId === unlimited.id));
  const enqueue = store.enqueue.bind(store);
  store.enqueue = async () => { throw new Error('fixture reply failure'); };
  const cancelJanuary = {classify:async () => cancelRepeat('series','2027-01')};
  await assert.rejects(request(store,'2027년 1월에 시작하는 정기 모임 반복일정 전체 취소해줘',cancelJanuary),/fixture reply failure/);
  store.enqueue = enqueue;
  assert.equal((await store.activeScheduleSeries()).find(item => item.id === unlimited.id).version,1);
  for (const [text, date] of [
    ['2027년 1월에 시작하는 정기 모임 반복일정 전체 취소해줘','2027-01'],
    ['정기 모임 반복일정 삭제해줘',null]
  ]) {
    assert.match(await request(store,text,{classify:async () => cancelRepeat('series',date)}),/전체 취소 완료/);
  }
  const snapshot = await store.backup();
  assert.deepEqual(snapshot.calendar.schedule_series.map(item => [item.status,item.version]),[['cancelled',2],['cancelled',2]]);
  assert.deepEqual(snapshot.calendar.schedule_exceptions,[]);
  assert.equal(snapshot.calendar.schedule_series_history.filter(item => item.after_data.status === 'cancelled').length,2);
  assert.equal(snapshot.calendar.schedule_occurrences.find(item => item.series_id === finite.id).projection_state,'excluded');
  assert.equal((await query("select status from assistant.deliveries where id like 'series-reminder:%'")).rows[0].status,'cancelled');
  assert.deepEqual(await store.calendarTasks({now,timeZone,from:'2027-02-01',to:'2027-02-03'}),[legacy]);
  assert.equal((await other.activeScheduleSeries())[0].id,foreign.id);
});

test('explicit natural occurrence cancellation records one exception without changing the series', async t => {
  const {store} = await isolated(t);
  const series = await store.createScheduleSeries({...daySeries,start_date:'2027-01-01',end_date_exclusive:'2027-01-02'},'1');
  const ai = {
    classify:async () => cancelRepeat('occurrence','2027-01-02'),
    answer:async ({tasks, selectedTaskId}) => {
      assert.equal(tasks.length,1);
      const [task] = tasks;
      assert.equal(task.id,selectedTaskId);
      assert.equal(task.recurrence.anchor,'2027-01-02');
      return creationAnswer(null,{actions:[{operation:'update',id:task.id,expectedVersion:task.version,
        task:{...task,status:'cancelled'},reason:'회차 취소'}]});
    }
  };
  assert.match(await request(store,'2027년 1월 2일 정기 모임 회차만 삭제해줘',ai),/취소/);
  const snapshot = await store.backup();
  assert.equal(snapshot.calendar.schedule_series[0].status,'active');
  assert.equal(snapshot.calendar.schedule_series[0].version,1);
  assert.deepEqual(snapshot.calendar.schedule_exceptions.map(e => [e.series_id,e.anchor_key,e.status]),[
    [series.id,'2027-01-02','cancelled']
  ]);
  const remaining = await store.calendarTasks({now,timeZone,from:'2027-01-01',to:'2027-01-02'});
  assert.ok(remaining.some(task => task.recurrence?.anchor === '2027-01-01' && task.status === 'open'));
});

test('ambiguous date scope pauses in LangGraph and a changed series must be confirmed again', async t => {
  const {store} = await isolated(t);
  const november = await store.createScheduleSeries({...daySeries,recurrence_raw:['RRULE:FREQ=DAILY']},'1');
  const december = await store.createScheduleSeries({...daySeries,start_date:'2026-12-01',end_date_exclusive:'2026-12-02'},'1');
  const originalText = '12월부터 반복하는 정기 모임 전체 취소해줘';
  const unresolved = {classify:async () => cancelRepeat(null,null,'12월 시작 시리즈 전체인가요, 기존 시리즈의 12월 이후 회차만인가요?')};
  const clarified = {classify:async ({pendingRequest}) => {
    assert.equal(pendingRequest.originalText,originalText);
    return cancelRepeat('series','2026-12');
  }};
  const before = await store.backup();
  assert.match(await request(store,originalText,unresolved),/12월 이후 회차만인가요/);
  assert.ok((await store.conversation('1')).workflow?.snapshot);
  const partial = {classify:async () => cancelRepeat(null,null,'한 회차만 취소하려면 날짜를 알려주세요.')};
  assert.match(await request(store,'12월 이후 회차만요',partial),/날짜를 알려주세요/);
  assert.deepEqual((await store.backup()).calendar,before.calendar);
  await store.updateScheduleSeries(december.id,1,{recurrence_raw:['RRULE:FREQ=DAILY;COUNT=3']},'1');
  await assert.rejects(request(store,'12월에 시작한 시리즈 전체요',clarified),/확인하는 동안 반복 일정이 바뀌었어요/);
  assert.equal((await store.activeScheduleSeries()).length,2);
  assert.match(await request(store,originalText,unresolved),/12월 이후 회차만인가요/);
  assert.match(await request(store,'12월에 시작한 시리즈 전체요',clarified),/전체 취소 완료/);
  assert.deepEqual((await store.activeScheduleSeries()).map(series => series.id),[november.id]);
});

test('stale virtual edit rolls back a batch without creating a duplicate or committing other task writes', async t => {
  const {store} = await isolated(t);
  await store.createScheduleSeries(daySeries,'1');
  const [virtual] = await store.calendarTasks({now,timeZone});
  const editFromOldVersion = planChanges([{
    operation:'update',id:virtual.id,expectedVersion:virtual.version,
    task:{...virtual,notes:'중복'},reason:'stale'
  }],[virtual],now)[0];
  await edit(store,virtual.id,{notes:'먼저 저장'});
  const jobId = ++nextJob;
  await store.ingest(jobId,{actor:'1',chatId:'-1',text:'두 건 편집'});
  const job = await store.claim('tg:' + jobId);
  await assert.rejects(store.finish(job,[planTaskCreation(legacyInput,'fixture',now),editFromOldVersion],'저장'),/변경/);
  const snapshot = await store.backup();
  assert.equal(snapshot.tasks.length,1);
  assert.equal(snapshot.tasks[0].data.notes,'먼저 저장');
  assert.equal(snapshot.history.length,1);
  assert.equal(snapshot.calendar.schedule_occurrences.length,1);
});

test('title changes do not resend a delivered occurrence reminder', async t => {
  const {query,store} = await isolated(t);
  await store.createScheduleSeries(daySeries,'1');
  const [task] = await store.calendarTasks({now,timeZone});
  await edit(store,task.id,{remindAt:['2026-11-16T12:15:00.000Z']});
  const at = new Date('2026-11-16T12:20:00Z');
  const settings = {timeZone,dailyEnabled:false,weeklyEnabled:false};
  await schedule(store,at,settings);
  const delivery = (await query("select id from assistant.deliveries where id like 'series-reminder:%'")).rows[0];
  assert.ok(delivery);
  await query("update assistant.deliveries set status='sent' where id=$1",[delivery.id]);
  await edit(store,task.id,{title:'제목만 변경'},at);
  await schedule(store,at,settings);
  const rem = (await query("select id,status from assistant.deliveries where id like 'series-reminder:%'")).rows;
  assert.deepEqual(rem,[{id:delivery.id,status:'sent'}]);
});

test('linking an existing occurrence does not re-send its legacy reminder', async t => {
  const {query,store} = await isolated(t);
  const instant = '2026-11-16T12:15:00.000Z';
  const legacy = planTaskCreation({...legacyInput,remindAt:[instant]},'fixture',now).after;
  await query('insert into assistant.tasks(family_id,id,version,data) values($1,$2,$3,$4)',[family,legacy.id,legacy.version,legacy]);
  const settings = {timeZone,dailyEnabled:false,weeklyEnabled:false};
  const at = new Date('2026-11-16T12:20:00Z');
  await schedule(store,at,settings);
  await query("update assistant.deliveries set status='sent' where id like 'reminder:%'");
  const series = await store.createScheduleSeries({...daySeries,all_day:false,start_at:'2026-11-16T10:00:00+09:00',end_at:'2026-11-16T11:00:00+09:00'},'1');
  await store.linkScheduleOccurrence({seriesId:series.id,anchor:'2026-11-16T10:00:00#0',taskId:legacy.id,expectedVersion:1,expectedSeriesVersion:1,timeZone,actor:'1'});
  await schedule(store,at,settings);
  await schedule(store,new Date('2026-11-16T14:00:00Z'),settings);
  assert.deepEqual((await query('select id,status from assistant.deliveries')).rows,[{id:'reminder:' + legacy.id + ':1:' + instant,status:'sent'}]);
});

test('new and legacy snapshots restore task IDs and histories; remote work stays paused', async t => {
  const {query,store} = await isolated(t);
  const series = await store.createScheduleSeries(daySeries,'1');
  const [virtual] = await store.calendarTasks({now,timeZone});
  await edit(store,virtual.id,{status:'done'});
  await query("insert into assistant.calendar_sync_state(family_id,id,calendar_id,mode,sync_token) values($1,$2,'fixture.calendar','bidirectional','fixture-cursor')",[family,series.id]);
  await query("insert into assistant.calendar_event_links(family_id,connection_id,google_event_id,series_id,protected_payload) values($1,$2,'fixture-event',$2,$3)",[family,series.id,Buffer.from([16,64])]);
  const snapshot = JSON.parse(JSON.stringify(await store.backup()));
  const target = await isolated(t,{seed:false});
  await target.store.restoreBackup(snapshot);
  const restored = JSON.parse(JSON.stringify(await target.store.backup()));
  assert.deepEqual(restored.tasks,snapshot.tasks);
  assert.deepEqual(restored.history,snapshot.history);
  assert.deepEqual(restored.calendar.schedule_occurrences,snapshot.calendar.schedule_occurrences);
  assert.equal(restored.calendar.calendar_sync_state[0].mode,'paused');
  assert.equal(restored.calendar.calendar_sync_state[0].sync_token,null);
  assert.equal(restored.calendar.calendar_event_links[0].protected_payload,'\\x1040');
  assert.equal(restored.families[0].active,false);
  await assert.rejects(target.store.restoreBackup(snapshot),/기존 데이터/);
  delete snapshot.calendar;
  const legacyTarget = await isolated(t,{migrate:false,seed:false});
  await legacyTarget.store.restoreBackup(snapshot);
  assert.deepEqual((await legacyTarget.store.backup()).tasks,snapshot.tasks);
});
