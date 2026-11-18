// Regression tests for the cancelled-series registration analysis.
// No network, production credentials, or external services are used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { Store } from '../src/storage.js';
import { processJob } from '../src/processor.js';
import { createJobDispatcher } from '../src/core/router.js';
import { createCalendarSkill } from '../src/skills/calendar.js';
import { planChanges } from '../src/tasks.js';
import { occurrenceId } from '../src/recurrence.js';
import { planSeriesRegistration, readSeriesDraft } from '../src/weekly.js';

const family = '129eec5c-61c8-418a-b670-7db608bb08a1';
const timeZone = 'Asia/Seoul';
const now = new Date('2026-11-18T03:00:00Z');
const draft = {title:'기석 월급',frequency:'MONTHLY',monthDay:21,timeType:'all_day'};
const creationAi = fields => ({classify:async () => ({intent:'create',targets:[],answer:{
  series:fields,reply:'',actions:[],settings:null,retrieval:null,clarification:null
}})});
const cancellationAi = {classify:async () => ({intent:'cancel',targets:['기석 월급'],
  answer:null,cancellation:{scope:'series',date:null,question:null}})};
const retrievalAi = {classify:async () => ({intent:'retrieve',targets:[],answer:{
  reply:'',actions:[],settings:null,clarification:null,
  retrieval:{kind:'task_list',from:'2026-11-01',to:'2026-11-30',status:'active',search:null,person:null}
}})};

async function isolated(t, viaCore = false) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec('create role anon; create role authenticated');
  for (const file of ['schema.sql','calendar-sync.sql']) {
    await db.exec(await readFile(new URL('../sql/' + file,import.meta.url),'utf8'));
  }
  await db.query("insert into assistant.families(id,chat_id,user_ids,active) values($1,'-1',array['1','2'],true)",[family]);
  await db.exec('set role assistant_app');
  const query = async (sql,params=[]) => {
    const result = await db.query(sql,params);
    return {...result,rowCount:result.rows.length || result.affectedRows || 0};
  };
  const store = new Store({query,connect:async () => ({query,release(){}})},family);
  const dispatch = createJobDispatcher([createCalendarSkill()],'calendar');
  let update = 8000;
  const queue = async (text = '매월 21일 기석 월급 추가', actor = '1') => {
    const id = ++update;
    assert.equal(await store.ingest(id,{actor,chatId:'-1',text,sentAt:Math.floor(+now/1000)+id}),true);
    return store.claim('tg:' + id);
  };
  const process = (job, ai = creationAi(draft)) => viaCore
    ? dispatch({job,store,ai,now}) : processJob(job,store,ai,now);
  const run = async (text,ai,actor) => process(await queue(text,actor),ai);
  const keys = async () => (await query("select key,value from assistant.runtime where family_id=$1 and key like 'weekly-request:%'",[family])).rows;
  const month = () => store.calendarTasks({now,timeZone,from:'2026-11-01',to:'2026-11-30',listOnly:true});
  const edit = async (task, fields) => {
    const changes = planChanges([{operation:'update',id:task.id,expectedVersion:task.version,
      task:{...task,...fields},reason:'regression fixture'}],[task],now);
    await store.finish(await queue('fixture edit'),changes,'fixture');
  };
  return {db,query,store,queue,process,run,keys,month,edit};
}

for (const viaCore of [false,true]) {
  test(`cancelled monthly registration creates fresh series and references: ${viaCore ? 'Core' : 'legacy'}`, async t => {
    const {store,run,keys,month,edit} = await isolated(t,viaCore);
    assert.match(await run(undefined,creationAi(draft)),/시리즈 등록/);
    const [original] = await store.activeScheduleSeries();
    assert.match(await run(undefined,creationAi(draft)),/이미 처리된 요청/);
    const occurrences = await store.calendarTasks({now,timeZone,from:'2026-11-01',to:'2027-01-31'});
    await edit(occurrences[0],{status:'done',notes:'완료 이력 보존'});
    await edit(occurrences[1],{status:'cancelled',notes:'취소 이력 보존'});
    await edit(occurrences[2],{notes:'미완료 메모 보존'});
    assert.match(await run('기석 월급 반복일정 전체 취소해줘',cancellationAi),/전체 취소 완료/);
    const old = await store.backup();
    assert.equal(old.calendar.schedule_series[0].status,'cancelled');
    assert.ok(old.calendar.schedule_occurrences.every(row => row.projection_state === 'excluded'));
    assert.deepEqual(old.tasks.map(row => row.data.status).sort(),['cancelled','done','open']);

    for (let cycle = 0; cycle < 3; cycle++) {
      const previousRefs = (await keys())[0].value.refs;
      const reply = await run(undefined,creationAi(draft));
      assert.match(reply,/시리즈 등록/);
      assert.doesNotMatch(reply,/이미 처리된/);
      const [active] = await store.activeScheduleSeries();
      assert.notEqual(active.id,original.id);
      const saved = (await keys())[0].value;
      assert.equal(saved.seriesId,active.id);
      assert.equal(saved.reply,reply);
      assert.notDeepEqual(saved.refs,previousRefs);
      const state = await store.conversation('1');
      assert.deepEqual(state.taskIds,saved.refs.map(ref => ref.id));
      assert.deepEqual(state.request.candidateOrder,state.taskIds);
      assert.equal((await month()).find(row => row.status === 'open').recurrence.seriesId,active.id);
      assert.match(await run('11월 일정 알려줘',retrievalAi),/기석 월급/);
      const delivery = await store.pool.query("select result from assistant.deliveries where family_id=$1 order by created_at desc,id desc limit 1",[family]);
      assert.ok(delivery.rows[0].result.context.refs.every(ref => !previousRefs.some(old => old.id === ref.id)));
      // Follow-up selection must use the newly registered occurrence context.
      assert.match(await run('그거 메모 알려줘',{answer:async ({tasks}) => {
        assert.deepEqual(tasks.map(task => task.id),saved.refs.map(ref => ref.id));
        assert.ok(tasks.every(task => task.recurrence.seriesId === active.id));
        return {reply:'기석 월급 메모 확인',actions:[],settings:null,retrieval:null,clarification:null};
      }}),/기석 월급/);
      assert.deepEqual((await store.conversation('1')).taskIds,saved.refs.map(ref => ref.id));
      assert.match(await run(undefined,creationAi(draft)),/이미 처리된 요청/);
      if (cycle < 2) await run('기석 월급 반복일정 전체 취소해줘',cancellationAi);
    }
    const after = await store.backup();
    assert.deepEqual(after.tasks,old.tasks);
    assert.deepEqual(after.history,old.history);
    assert.deepEqual(after.calendar.schedule_series.find(row => row.id === original.id),old.calendar.schedule_series[0]);
    assert.deepEqual(after.calendar.schedule_occurrences,old.calendar.schedule_occurrences);
    assert.deepEqual(after.calendar.schedule_exceptions,old.calendar.schedule_exceptions);
    assert.deepEqual(after.calendar.schedule_series_history.filter(row => row.series_id === original.id),old.calendar.schedule_series_history);
    assert.equal(after.calendar.schedule_series.length,4);
    const last = (await store.pool.query('select id,payload from assistant.jobs where family_id=$1 order by created_at desc,id desc limit 1',[family])).rows[0];
    assert.equal(await store.ingest(Number(last.id.slice(3)),last.payload),false);
    assert.equal(await store.claim(last.id),null);
    assert.match(await run('매월 22일 기석 월급 추가',creationAi({...draft,monthDay:22})),/시리즈 등록/);
    assert.match(await run(undefined,creationAi(draft),'2'),/시리즈 등록/);
    assert.equal((await store.activeScheduleSeries()).length,3);
  });
}

for (const fields of [draft,{...draft,timeType:'timed',time:'12:30'}]) {
  test(`legacy key without seriesId resolves virtual ${fields.timeType} refs`, async t => {
    const {query,store,run,keys} = await isolated(t);
    await run(undefined,creationAi(fields));
    const [key] = await keys();
    await query("update assistant.runtime set value=value-'seriesId' where family_id=$1 and key=$2",[family,key.key]);
    assert.equal((await store.backup()).calendar.schedule_occurrences.length,0);
    assert.match(await run(undefined,creationAi(fields)),/이미 처리된 요청/);
    await run('기석 월급 반복일정 전체 취소해줘',cancellationAi);
    assert.match(await run(undefined,creationAi(fields)),/시리즈 등록/);
    assert.notEqual((await keys())[0].value.seriesId,key.value.seriesId);
  });
}

test('unresolvable legacy keys and missing explicit series IDs keep deduplication', async t => {
  const {query,store,run,keys} = await isolated(t);
  await run(undefined,creationAi(draft));
  await run('기석 월급 반복일정 전체 취소해줘',cancellationAi);
  const [key] = await keys();
  const other = await store.createScheduleSeries(planSeriesRegistration(readSeriesDraft({...draft,monthDay:22}),now,timeZone,'1').seriesRegistration.series,'1');
  for (const saved of [
    {},
    {reply:'old',refs:[null]},
    {reply:'old',refs:[]},
    {reply:'old',refs:[{id:'unknown',title:draft.title}]},
    {reply:'old',refs:[...key.value.refs,{id:occurrenceId(family,other.id,'2026-11-22'),title:draft.title}]},
    {...key.value,seriesId:'00000000-0000-0000-0000-000000000000'},
    {...key.value,seriesId:'invalid'}
  ]) {
    await query('update assistant.runtime set value=$3 where family_id=$1 and key=$2',[family,key.key,saved]);
    assert.match(await run(undefined,creationAi(draft)),/이미 처리된 요청/);
    assert.equal((await store.backup()).calendar.schedule_series.length,2);
  }
});

test('legacy refs are rechecked after acquiring the series lock', async t => {
  const {store,run,keys,query} = await isolated(t);
  await run(undefined,creationAi(draft));
  await run('기석 월급 반복일정 전체 취소해줘',cancellationAi);
  const [key] = await keys();
  await query("update assistant.runtime set value=value-'seriesId' where family_id=$1 and key=$2",[family,key.key]);
  const originalQuery = store.pool.query;
  const originalConnect = store.pool.connect;
  store.pool.connect = async () => {
    const client = await originalConnect();
    return {...client,query:async (sql,params) => {
      const result = await originalQuery(sql,params);
      // Simulate another transaction changing the candidate before the lock read.
      if (sql.includes('from assistant.schedule_series') && sql.endsWith('for update')) {
        result.rows = result.rows.map(row => ({...row,start_date:'2026-11-22',end_date_exclusive:'2026-11-23'}));
      }
      return result;
    }};
  };
  assert.match(await run(undefined,creationAi(draft)),/이미 처리된 요청/);
  assert.equal((await store.backup()).calendar.schedule_series.length,1);
});

test('failed replacement rolls back series, key, conversation and reply; lease retry commits once', async t => {
  const {store,run,queue,process,keys,query} = await isolated(t);
  await run(undefined,creationAi(draft));
  await run('기석 월급 반복일정 전체 취소해줘',cancellationAi);
  const old = await store.backup();
  const key = await keys();
  const state = await store.conversation('1');
  const job = await queue();
  const enqueue = store.enqueue;
  store.enqueue = async () => { throw new Error('fixture delivery failure after series and key writes'); };
  await assert.rejects(process(job),/반복 일정 저장 오류/);
  store.enqueue = enqueue;
  assert.deepEqual((await store.backup()).calendar,old.calendar);
  assert.deepEqual(await keys(),key);
  assert.deepEqual(await store.conversation('1'),state);
  assert.equal((await query('select * from assistant.deliveries where family_id=$1 and id=$2',[family,'reply:'+job.id])).rows.length,0);
  // Reclaim an expired lease: stale worker must not commit, new owner succeeds.
  await query("update assistant.jobs set lease_until=now()-interval '1 second' where family_id=$1 and id=$2",[family,job.id]);
  const retry = await store.claim(job.id);
  await assert.rejects(process(job),/반복 일정 저장 오류/);
  assert.match(await process(retry),/시리즈 등록/);
  await assert.rejects(process(retry),/반복 일정 저장 오류/);
  assert.equal((await store.backup()).calendar.schedule_series.length,2);
});

test('semantic request key does not contain requestedAt or the effective first occurrence', () => {
  const key = at => planSeriesRegistration(readSeriesDraft(draft),new Date(at),timeZone,'1').seriesRegistration;
  const november = key('2026-11-18T03:00:00Z');
  const december = key('2026-12-18T03:00:00Z');
  assert.equal(november.weeklyKey,december.weeklyKey);
  assert.notEqual(november.series.start_date,december.series.start_date);
});

for (const legacy of [false,true]) {
  test(`concurrent re-registration serializes request-key replacement (${legacy ? 'legacy' : 'seriesId'})`, {timeout:10000}, async () => {
    // PGlite has one backend. Use two independent mock transaction clients here
    // to force an overlap while modeling the requested PostgreSQL row lock.
    const plan = planSeriesRegistration(readSeriesDraft(draft),now,timeZone,'1').seriesRegistration;
    const oldId = '129eec5c-61c8-418a-b670-7db608bb08a9';
    const old = {...plan.series,id:oldId,version:2,status:'cancelled',edit_mode:'supported'};
    const series = new Map([[oldId,old]]);
    let saved = {reply:'old reply',refs:[{id:occurrenceId(family,oldId,'2026-11-21'),title:draft.title}],
      ...(!legacy && {seriesId:oldId})};
    let owner = null, attempts = 0, creates = 0;
    const waiters = [];
    const bothAttempted = Promise.withResolvers();
    const jobs = new Map(['tg:1','tg:2'].map(id => [id,{id,lease:id,status:'running',payload:{actor:'1',text:'매월 21일 기석 월급 추가'}}]));
    const result = rows => ({rows,rowCount:rows.length});
    const pool = {connect:async () => {
      const client = {};
      const unlock = () => {
        if (owner !== client) return;
        owner = null;
        waiters.shift()?.();
      };
      client.release = () => assert.notEqual(owner,client);
      client.query = async (sql,params=[]) => {
        if (sql === 'begin') return result([]);
        if (sql === 'commit' || sql === 'rollback') { unlock(); return result([]); }
        if (sql.startsWith('select id from assistant.jobs')) {
          const job = jobs.get(params[1]);
          return result(job.status === 'running' && job.lease === params[2] ? [{id:job.id}] : []);
        }
        if (sql.startsWith('insert into assistant.runtime')) return result([]);
        if (sql.startsWith('select value from assistant.runtime')) {
          assert.equal(params[0],family);
          assert.equal(params[1],plan.weeklyKey);
          assert.match(sql,/for update$/);
          if (++attempts === 2) bothAttempted.resolve();
          if (owner) await new Promise(resolve => waiters.push(resolve));
          owner = client;
          return result([{value:structuredClone(saved)}]);
        }
        if (sql.includes('to_regclass')) return result([{name:'assistant.schedule_series'}]);
        if (sql.startsWith('select ') && sql.includes('from assistant.schedule_series')) {
          assert.equal(params[0],family);
          if (params.length === 1) return result([...series.values()]);
          assert.match(sql,/for update$/);
          return result(series.has(params[1]) ? [series.get(params[1])] : []);
        }
        if (sql.startsWith('insert into assistant.schedule_series(')) {
          assert.equal(owner,client);
          // Force the other job to reach the lock before committing this insert.
          await bothAttempted.promise;
          creates++;
          const row = {...plan.series,id:params[1],version:1,status:'active',edit_mode:'supported'};
          series.set(row.id,row);
          return result([row]);
        }
        if (sql.startsWith('update assistant.runtime set value=$3')) {
          assert.equal(owner,client);
          saved = structuredClone(params[2]);
        }
        if (sql.startsWith("update assistant.jobs set status='done'")) jobs.get(params[1]).status = 'done';
        return {rows:[],rowCount:1};
      };
      return client;
    }};
    const store = new Store(pool,family);
    const memory = () => ({...structuredClone(plan),conversation:{taskIds:[],request:{},turns:[{text:''}]}});
    const a = memory(), b = memory();
    const replies = await Promise.all([...jobs.values()].map((job,index) => store.finish(job,[],'new reply',null,index ? b : a)));
    assert.equal(creates,1);
    assert.equal(series.size,2);
    assert.equal(series.get(oldId).status,'cancelled');
    assert.equal([...series.values()].filter(row => row.status === 'active').length,1);
    assert.equal(replies.filter(reply => reply === 'new reply').length,1);
    assert.equal(replies.filter(reply => reply.includes('이미 처리된 요청')).length,1);
    assert.notEqual(saved.seriesId,oldId);
    assert.deepEqual(a.refs,b.refs);
    assert.deepEqual(a.conversation.taskIds,b.conversation.taskIds);
    assert.deepEqual(a.conversation.taskIds,saved.refs.map(ref => ref.id));
    await assert.rejects(store.finish(jobs.get('tg:1'),[],'retry',null,memory()),/작업 실행 권한/);
    assert.equal(creates,1);
  });
}
