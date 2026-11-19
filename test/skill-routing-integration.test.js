import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { createSkillRouter } from '../src/core/router.js';
import { createCalendarSkill, inspectCalendarEntry } from '../src/skills/calendar.js';
import { Store } from '../src/storage.js';

const taskFields = {
  time:null, endDate:null, timeNote:null, person:null, assignee:null, notes:'',
  followUpDate:null, actualDeadline:null, remindAt:[]
};

async function harness(t) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec('create role anon; create role authenticated');
  await db.exec(await readFile(new URL('../sql/schema.sql', import.meta.url), 'utf8'));
  const familyId = randomUUID();
  await db.query('insert into assistant.families(id,chat_id,user_ids) values($1,$2,$3)', [familyId, '-10', ['1']]);
  await db.exec('set role assistant_app');
  const query = async (sql, params) => {
    const result = await db.query(sql, params);
    return { ...result, rowCount: result.rows.length || result.affectedRows || 0 };
  };
  const pool = { query, connect: async () => ({ query, release() {} }) };
  const store = new Store(pool, familyId);
  const actor = '1';
  const now = new Date();
  const input = (job, ai = null, currentStore = store, options = { authorize: async () => {} }) =>
    ({ job, store: currentStore, ai, now, options });
  const enqueue = async (id, text, extra = {}) => {
    assert.equal(await store.ingest(id, { actor, chatId: '-10', text, ...extra }), true);
    return store.claim(extra.button ? 'button:' + extra.button.token : 'tg:' + id);
  };
  return { db, pool, familyId, store, actor, now, input, enqueue };
}

test('notice-only routing preserves a persisted Calendar checkpoint and trusted follow-up resumes it', async t => {
  const { db, pool, familyId, store, actor, now, input, enqueue } = await harness(t);
  const dueDate = new Date(+now + 2 * 86400000).toISOString().slice(0, 10);
  const calendar = createCalendarSkill();
  const question = await enqueue(1, '차량 점검 일정 추가');
  await calendar.handle(input(question, { classify: async () => ({
    intent: 'create', targets: [], answer: {
      reply: '', actions: [], clarification: {
        operation: 'create', candidateIds: [], question: '몇 시에 점검하나요?', unresolved: '시각',
        proposedChanges: [{ field: 'dueDate', value: dueDate }]
      }
    }
  }) }));
  const original = await store.conversation(actor);
  assert.ok(original.pending && original.workflow?.snapshot);
  const pending = { kind: 'pending', contextKey: original.requestId + ':' + original.workflow.token };
  const restoredStore = new Store(pool, familyId);
  const cases = [
    ['생일사진 찾아줘', { kind: 'single', skills: ['photo'] }, /아직 지원하지/],
    ['어린이집 안내 메일에서 행사 일정을 등록해줘', { kind: 'multiple', skills: ['mail', 'calendar'] }, /여러 기능/],
    ['카드 건 찾아줘', { kind: 'ambiguous', skills: [] }, /진행 중인 일정 확인/],
    ['날씨', { kind: 'unknown', skills: [] }, /진행 중인 일정 확인/],
    ['메일', { kind: 'single', skills: ['other'] }, /기능을 확인하지 못했어요/],
    ['식비 얼마나 썼어?', new Error('timeout'), /기능을 확인하지 못했어요/],
    ['새 일정 추가', { kind: 'single', skills: ['calendar'] }, /진행 중인 일정 확인/]
  ];
  const previousContext = await store.context();
  for (const [index, [text, decision, message]] of cases.entries()) {
    const route = createSkillRouter({
      skills: [{ id: 'calendar', handle: () => assert.fail('unexpected Calendar dispatch') }],
      classifySkill: async () => {
        if (decision instanceof Error) throw decision;
        return decision;
      }
    });
    assert.match(await route(input(await enqueue(index + 2, text), null, restoredStore), pending), message);
    assert.deepEqual(await restoredStore.conversation(actor), original);
  }
  assert.deepEqual(await restoredStore.context(), previousContext);
  assert.deepEqual(await restoredStore.tasks(), []);
  assert.equal((await db.query("select id from assistant.deliveries where id like 'error:%'")).rows.length, 2);

  const route = createSkillRouter({ skills: [calendar], classifySkill: () => assert.fail('Router called for verified reply') });
  const reply = await enqueue(50, '16:40');
  await route(input(reply, {
    classify: () => assert.fail('Calendar should restore the saved intent'),
    answer: async ({ pendingRequest }) => {
      assert.equal(pendingRequest.originalText, question.payload.text);
      return { reply: '', actions: [{ operation: 'create', id: null, expectedVersion: null, reason: '요청', task: {
        title: '차량 점검', kind: 'appointment', status: 'open', dueDate, time: '16:40', notes: '',
        endDate: null, timeNote: null, person: null, assignee: null, followUpDate: null, actualDeadline: null, remindAt: []
      } }] };
    }
  }, restoredStore), { kind: 'verified-followup' });
  assert.equal((await restoredStore.tasks()).length, 1);
  assert.equal((await restoredStore.conversation(actor)).pending, false);
});

test('the 3-B entry separates new work from a linked question and preserves the pending snapshot', async t => {
  const { db, store, actor, now, input, enqueue } = await harness(t);
  const routeCalls = [];
  const route = createSkillRouter({
    skills:[createCalendarSkill()], inspectCalendar:inspectCalendarEntry,
    classifySkill:async text => {
      routeCalls.push(text);
      if (text === '오전 9시에 온 카드 결제 메일 찾아줘') return {kind:'single',skills:['mail']};
      if (text === '월요일 가계부에서 식비가 얼마인지 알려줘') return {kind:'single',skills:['finance']};
      return {kind:'single',skills:['calendar']};
    }
  });
  const dueDate = new Date(+now + 2 * 86400000).toISOString().slice(0, 10);
  const newTask = (title, time = '10:00') => ({
    ...taskFields, title, time, dueDate, kind:'appointment', status:'open'
  });
  const proposal = (actions = [], clarification = null) => ({
    classify:async ({message}) => {
      assert.equal(message.replyTo ?? null, null);
      return {intent:'create', targets:[], answer:{reply:'', actions, clarification}};
    }
  });
  const create = task => ({operation:'create',id:null,expectedVersion:null,task});
  const ask = proposal([], {operation:'create',candidateIds:[],proposedChanges:[],question:'몇 시에 할까요?',unresolved:'시각'});
  await route(input(await enqueue(1,'차량 점검 등록'), ask));
  const pending = await store.conversation(actor);
  assert.ok(pending.pending && pending.workflow.snapshot);
  const delivery = await store.claimDelivery();
  await store.deliveryResult(delivery,'sent',{
    messageIds:[77],messageRefs:[[]],chatId:'-10',replyOwner:actor,replyPending:true,
    requestId:pending.requestId,workflowToken:pending.workflow.token
  });
  const replyTo = JSON.stringify({id:77});
  const noAi = {classify:async () => assert.fail('Calendar classification called'),answer:async () => assert.fail('Calendar answer called')};
  assert.match(await route(input(await enqueue(2,'오전 9시에 온 카드 결제 메일 찾아줘',{replyTo}),noAi)),
    /진행 중인 일정 확인[\s\S]*메일 기능은 아직/);
  assert.match(await route(input(await enqueue(3,'월요일 가계부에서 식비가 얼마인지 알려줘'),noAi)), /가계부 기능은 아직/);
  assert.match(await route(input(await enqueue(4,'네, 어제 온 메일도 찾아줘',{replyTo}),noAi)), /진행 중인 일정 확인/);
  await route(input(await enqueue(5,'오늘 개인비서 테스트 추가',{replyTo}),proposal([create(newTask('개인비서 테스트'))])));
  assert.match(await route(input(await enqueue(6,'전체 일정 보여줘'),noAi)), /개인비서 테스트/);
  assert.match(await route(input(await enqueue(7,'개인비서 테스트 완료해줘'),noAi)), /완료/);
  assert.match(await route(input(await enqueue(8,'점심 일정 등록'),ask)), /진행 중인 일정 확인/);
  assert.deepEqual(await store.conversation(actor),pending);
  const raw = (await db.query("select reply_to from assistant.context where text='오늘 개인비서 테스트 추가'")).rows[0];
  assert.equal(raw.reply_to,replyTo);
  const other = await enqueue(9,'16:40',{actor:'2',replyTo});
  assert.match(await route(input(other,noAi)),/이미 처리/);
  const wrongChat = await enqueue(10,'16:40',{chatId:'-20',replyTo});
  assert.match(await route(input(wrongChat,noAi)),/이미 처리/);
  await route(input(await enqueue(11,'오전 3시',{replyTo}),{
    ...noAi, answer:async ({pendingRequest}) => {
      assert.equal(pendingRequest.originalText,'차량 점검 등록');
      return {actions:[create(newTask('차량 점검','03:00'))],reply:''};
    }
  }));
  assert.equal((await store.conversation(actor)).pending,false);
  assert.deepEqual(routeCalls,['차량 점검 등록','오전 9시에 온 카드 결제 메일 찾아줘','월요일 가계부에서 식비가 얼마인지 알려줘','오늘 개인비서 테스트 추가','점심 일정 등록']);
  assert.equal((await store.tasks()).find(task => task.title === '차량 점검').time,'03:00');
});

test('saved Calendar approvals survive re-lease and still reject a replacement question at commit', async t => {
  const { db, store, actor, now, input, enqueue } = await harness(t);
  const route = createSkillRouter({
    skills:[createCalendarSkill()], inspectCalendar:inspectCalendarEntry,
    classifySkill: async text => {
      assert.equal(text,'날짜별 일정 완료해줘');
      return {kind:'single',skills:['calendar']};
    }
  });
  const day = new Date(+now - 86400000).toISOString().slice(0,10);
  const task = {...taskFields,id:randomUUID(), version:1, title:'검토', kind:'task', status:'open', dueDate:day};
  await db.query('insert into assistant.tasks(family_id,id,version,data) values($1,$2,$3,$4)',[store.familyId,task.id,1,task]);
  const completion = date => ({intent:'complete',targets:[],answer:null,completion:{
    scope:date?'date_all':null,date,question:date?null:'어느 하루의 날짜를 알려주세요?'
  }});
  await route(input(await enqueue(1,'날짜별 일정 완료해줘'),{classify:async () => completion(null)}));
  await route(input(await enqueue(2,'어제'),{classify:async () => completion(day)}));
  const pending = await store.conversation(actor);
  assert.equal(pending.request.dateCompletion.targets[0].id,task.id);
  const replace = async state => db.query("update assistant.runtime set value=$2 where family_id=$1 and key='conversation:1'",[store.familyId,state]);
  const replacement = {...pending,requestId:randomUUID(),workflow:{...pending.workflow,token:randomUUID()}};
  const crash = createSkillRouter({
    skills:[{id:'calendar',handle:() => {throw new Error('simulated crash');}}], inspectCalendar:inspectCalendarEntry,
    classifySkill:() => assert.fail('approval must bypass the classifier')
  });
  const firstApproval = await enqueue(3,'네');
  await assert.rejects(crash(input(firstApproval)),/simulated crash/);
  await replace(replacement);
  await db.query("update assistant.jobs set lease_until=now()-interval '1 second' where id='tg:3'");
  await assert.rejects(store.heartbeat(firstApproval),/만료/);
  await store.fail(firstApproval,'stale lease');
  assert.match(await route(input(await store.claim('tg:3'))),/처리 상태가 바뀌었어요/);
  assert.deepEqual(await store.conversation(actor),replacement);
  assert.equal((await store.tasks())[0].status,'open');

  let authorized = 0;
  const approval = await enqueue(4,'네');
  await assert.rejects(route(input(approval,null,store,{authorize:async () => {
    if (++authorized === 3) await replace(pending);
  }})),/다른 요청으로 바뀌었어요/);
  assert.deepEqual(await store.conversation(actor),pending);
  assert.equal((await store.tasks())[0].status,'open');
  assert.deepEqual(await store.history(),[]);
  const earlier = await enqueue(5,'네',{sentAt:Math.floor(+now / 1000) - 60});
  assert.match(await route(input(earlier)),/확인 질문을 찾지 못했어요/);
  const valid = await enqueue(6,'네');
  await assert.rejects(crash(input(valid)), /simulated crash/);
  const saved = await store.skillRoutingDecision(valid);
  assert.equal(saved.version, 2);
  assert.equal(saved.bypass, true);
  await db.query("update assistant.jobs set lease_until=now()-interval '1 second' where id='tg:6'");
  assert.match(await route(input(await store.claim('tg:6'))),/완료/);
  assert.equal(await store.ingest(6,valid.payload),false);
  assert.equal((await store.tasks())[0].status,'done');
  assert.equal((await store.history()).length,1);
});

test('the 3-B entry keeps recent follow-ups scoped and restores a saved selection button', async t => {
  const { db, store, actor, now, input, enqueue } = await harness(t);
  const route = createSkillRouter({
    skills:[createCalendarSkill()], inspectCalendar:inspectCalendarEntry,
    classifySkill:async text => {
      assert.equal(text,'사진 촬영 완료해줘');
      return {kind:'single',skills:['calendar']};
    }
  });
  const tasks = ['2026-11-30','2026-12-01'].map(dueDate => ({
    ...taskFields,id:randomUUID(),version:1,title:'사진 촬영',kind:'appointment',status:'open',dueDate,time:'10:00'
  }));
  for (const task of tasks) {
    await db.query('insert into assistant.tasks(family_id,id,version,data) values($1,$2,$3,$4)',[store.familyId,task.id,1,task]);
  }
  assert.match(await route(input(await enqueue(10,'그거 취소해줘'))), /확인 질문을 찾지 못했어요/);
  const classify = async () => ({intent:'complete',targets:['사진 촬영'],answer:null});
  await route(input(await enqueue(1,'사진 촬영 완료해줘'),{classify}));
  const pending = await store.conversation(actor);
  assert.ok(pending.pending && pending.workflow);
  const {rows:[{key}]} = await db.query("select key from assistant.runtime where key like 'button:%'");
  const button = {token:key.slice(7),index:0,messageId:88};
  await route(input(await enqueue(2,'일정 대상 선택',{button}),{answer:async ({tasks:[task],selectedTaskId}) => {
    assert.equal(selectedTaskId,task.id);
    return {reply:'',actions:[{operation:'update',id:task.id,expectedVersion:task.version,task:{...task,status:'done'}}]};
  }}));
  const state = await store.conversation(actor);
  assert.equal(state.pending,false);
  const target = (await store.tasks()).find(task => task.id === state.taskIds[0]);
  assert.equal(target.status,'done');
  const recentJob = await enqueue(3,'그거 내일로 바꿔줘');
  const other = (await store.tasks()).find(task => task.id !== target.id);
  await assert.rejects(route(input(recentJob,{answer:async ({tasks:scoped}) => {
    assert.deepEqual(scoped.map(task => task.id),[target.id]);
    return {reply:'',actions:[{operation:'update',id:other.id,expectedVersion:other.version,task:other}]};
  }})),/후보 범위 밖/);
  assert.equal((await store.history()).length,1);
  const tomorrow = new Date(+now + 86400000).toISOString().slice(0,10);
  for (const [id,text,fields] of [
    [4,'그거 내일로 바꿔줘',{dueDate:tomorrow}],
    [5,'그거 취소해줘',{status:'cancelled'}]
  ]) {
    await route(input(await enqueue(id,text),{answer:async ({tasks:[task]}) => {
      assert.equal(task.id,target.id);
      return {reply:'',actions:[{operation:'update',id:task.id,expectedVersion:task.version,task:{...task,...fields}}]};
    }}));
    const updated = (await store.tasks()).find(task => task.id === target.id);
    for (const [field,value] of Object.entries(fields)) assert.equal(updated[field],value);
  }
  assert.equal((await store.tasks()).find(task => task.id === other.id).status,'open');
});

test('a reclaimed Telegram job reuses its decision, can only finish once, and keeps metadata out of the Skill', async t => {
  const { db, pool, familyId, store, input, enqueue } = await harness(t);
  const job = await enqueue(1, '사진 촬영 일정을 등록해줘');
  let classifications = 0;
  const fresh = { kind: 'fresh' };
  const crashed = createSkillRouter({
    skills: [{ id: 'calendar', handle: () => { throw new Error('worker interrupted before finish'); } }],
    classifySkill: async text => {
      assert.equal(text, job.payload.text);
      classifications++;
      return { kind: 'single', skills: ['calendar'] };
    }
  });
  await assert.rejects(crashed(input(job), fresh), /worker interrupted/);
  assert.equal(await store.ingest(1, job.payload), false);
  await db.query("update assistant.jobs set lease_until=now()-interval '1 second'");
  const restoredStore = new Store(pool, familyId);
  const retry = await restoredStore.claim();
  assert.notEqual(retry.lease, job.lease);
  await assert.rejects(store.finishSkillRouting(job, 'stale'), /만료/);
  const recovered = createSkillRouter({
    skills: [{ id: 'calendar', handle: ({ job, store }) => {
      assert.equal(Object.hasOwn(job.payload, '_skillRouting'), false);
      return store.finish(job, [], '일정 요청 처리');
    } }],
    classifySkill: () => assert.fail('existing valid decision should be reused')
  });
  assert.equal(await recovered(input(retry, null, restoredStore), fresh), '일정 요청 처리');
  assert.equal(classifications, 1);
  assert.equal(await restoredStore.claim(), null);
  assert.equal((await db.query("select id from assistant.deliveries where id='reply:tg:1'")).rows.length, 1);
});

test('changed Calendar context and denied Skill authorization prevent dispatch', async t => {
  const { db, store, input, enqueue } = await harness(t);
  const fresh = { kind: 'fresh' };
  const job = await enqueue(1, '메일 찾아줘');
  const route = createSkillRouter({
    skills: [{ id: 'mail', handle: () => assert.fail('unauthorized Skill executed') }],
    classifySkill: async () => ({ kind: 'single', skills: ['mail'] }),
    authorizeSkill: async () => false
  });
  assert.match(await route(input(job), fresh), /권한/);

  const retry = await enqueue(2, '메일 찾아줘');
  const interrupt = createSkillRouter({
    skills: [{ id: 'mail', handle: () => { throw new Error('interrupted'); } }],
    classifySkill: async () => ({ kind: 'single', skills: ['mail'] }),
    authorizeSkill: async () => true
  });
  await assert.rejects(interrupt(input(retry), fresh), /interrupted/);
  await db.query("update assistant.jobs set lease_until=now()-interval '1 second' where id='tg:2'");
  const reclaimed = await store.claim();
  assert.match(await route(input(reclaimed), { kind: 'pending', contextKey: 'new-question' }), /상태가 바뀌었어요/);
});
