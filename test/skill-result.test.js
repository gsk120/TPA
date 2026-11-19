import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { deliverSkillContent } from '../src/core/delivery.js';
import { createJobDispatcher, createSkillRouter } from '../src/core/router.js';
import { textResult } from '../src/core/skill.js';
import { routeUpdate } from '../src/router.js';
import { createCalendarSkill } from '../src/skills/calendar.js';
import { recoverDeliveries, Store } from '../src/storage.js';

async function fixture(t) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec('create role anon; create role authenticated');
  await db.exec(await readFile(new URL('../sql/schema.sql', import.meta.url), 'utf8'));
  const familyId = randomUUID();
  const chatId = '-10';
  await db.query('insert into assistant.families(id,chat_id,user_ids) values($1,$2,$3)', [familyId, chatId, ['1']]);
  await db.exec('set role assistant_app');
  const query = async (sql, params) => {
    const result = await db.query(sql, params);
    return { ...result, rowCount:result.affectedRows || result.rows.length };
  };
  const pool = { query, connect:async () => ({ query, release() {} }) };
  const store = new Store(pool, familyId);
  const input = job => ({ job, store, now:new Date(), options:{ authorize:async () => {} } });
  const enqueue = async (updateId, text = '사진 찾아줘') => {
    await store.ingest(updateId, { actor:'1', chatId, text });
    return store.claim('tg:' + updateId);
  };
  const outcome = async id => (await query(
    "select status,payload->>'_skillOutcome' as outcome from assistant.jobs where id=$1", [id]
  )).rows[0];
  return { pool, store, chatId, input, enqueue, outcome };
}

test('Core validates results before commit and Calendar planning leaves completion to Core', async t => {
  const { store, input, enqueue, outcome } = await fixture(t);
  const job = await enqueue(1, '/help');
  const calendar = createCalendarSkill();
  const planned = await calendar.handle(input(job));
  assert.equal(planned.status, 'success');
  assert.match(planned.content[0].text, /토비 사용법/);
  assert.deepEqual(await outcome(job.id), { status:'running', outcome:null });
  assert.equal(await store.claimDelivery(), null);

  const dispatch = createJobDispatcher([{ id:'calendar', handle:async () => planned }], 'calendar');
  assert.equal(await dispatch(input(job)), planned.content[0].text);
  assert.deepEqual(await outcome(job.id), { status:'done', outcome:'success' });
  await assert.rejects(dispatch(input(job)), /만료/);
  assert.equal((await store.claimDelivery()).text, planned.content[0].text);
  assert.equal(await store.claimDelivery(), null);

  const badJob = await enqueue(2);
  const invalid = createJobDispatcher([{ id:'mail', handle:async () => ({
    status:'success', content:[{ type:'document', fileId:'https://example.com/private' }]
  }) }], 'mail');
  await assert.rejects(invalid(input(badJob)), /결과 형식/);
  const failed = createJobDispatcher([{ id:'mail', handle:async () => textResult('처리 실패', 'failed') }], 'mail');
  const stopped = AbortSignal.abort(new Error('중단'));
  await assert.rejects(failed({ ...input(badJob), signal:stopped }), /중단/);
  assert.deepEqual(await outcome(badJob.id), { status:'running', outcome:null });
  await failed(input(badJob));
  assert.deepEqual(await outcome(badJob.id), { status:'failed', outcome:'failed' });
  assert.equal((await store.claimDelivery()).id, 'error:' + badJob.id);
});

test('structured delivery resumes after a definite rejection and routes a choice only to its owner Skill', async t => {
  const { pool, store, chatId, input, enqueue, outcome } = await fixture(t);
  const content = [
    { type:'text', text:'자료를 골라주세요.' }, { type:'image', fileId:'photo_id' },
    { type:'video', fileId:'video_id' }, { type:'voice', fileId:'voice_id' },
    { type:'document', fileId:'document_id' }, { type:'location', latitude:37.5, longitude:127 }
  ];
  let calls = 0;
  const route = createSkillRouter({
    skills:[{ id:'photo', handle:async ({ selection }) => {
      if (selection) {
        assert.equal(selection.value, 'original');
        calls++;
        return textResult('선택을 받았어요.');
      }
      return { status:'waiting', content, buttons:[{ label:'도움말', url:'https://example.com/' }, { label:'원본', value:'original' }] };
    } }],
    classifySkill:async () => ({ kind:'single', skills:['photo'] }),
    authorizeSkill:async id => id === 'photo'
  });
  const first = await enqueue(10);
  assert.equal(await route(input(first), { kind:'fresh' }), '자료를 골라주세요.');
  assert.deepEqual(await outcome(first.id), { status:'done', outcome:'waiting' });
  const delivery = await store.claimDelivery();
  const methods = [];
  let nextId = 10;
  let rejectVideo = true;
  const tg = { call:async (method, body) => {
    methods.push([method, body]);
    if (method === 'sendVideo' && rejectVideo) {
      rejectVideo = false;
      throw Object.assign(new Error('텔레그램 요청 거부 (429)'), { retryAfter:1 });
    }
    return { message_id:nextId++ };
  } };
  await assert.rejects(deliverSkillContent(tg, store, delivery, chatId, async () => {}), /429/);
  assert.deepEqual(delivery.result.progress, { messageIds:[10, 11], inFlight:false });
  await store.deliveryResult(delivery, 'pending', { reason:'rate-limit' });
  assert.deepEqual((await store.claimDelivery()).result.progress, { messageIds:[10, 11], inFlight:false });
  await recoverDeliveries(pool);
  const retry = await store.claimDelivery();
  const ids = await deliverSkillContent(tg, store, retry, chatId, async () => {});
  assert.deepEqual(ids, [10, 11, 12, 13, 14, 15]);
  assert.deepEqual(methods.map(([name]) => name), [
    'sendMessage', 'sendPhoto', 'sendVideo', 'sendVideo', 'sendVoice', 'sendDocument', 'sendLocation'
  ]);
  assert.equal(methods[1][1].photo, 'photo_id');
  assert.equal(methods[3][1].video, 'video_id');
  assert.equal(methods[4][1].voice, 'voice_id');
  assert.equal(methods[5][1].document, 'document_id');
  assert.equal(methods.at(-1)[1].longitude, 127);
  const markup = methods.at(-1)[1].reply_markup;
  assert.equal(markup.inline_keyboard[0][0].url, 'https://example.com/');
  const data = markup.inline_keyboard[1][0].callback_data;
  await store.deliveryResult(retry, 'sent', { messageIds:ids });
  assert.equal(await store.claimDelivery(), null);

  const bot = { id:99 };
  const family = { active:true };
  const families = { family:async () => family, store:() => store };
  const callback = (id, actor) => ({
    update_id:id, callback_query:{ id:String(id), data, from:{ id:actor },
      message:{ message_id:15, chat:{ id:Number(chatId), type:'group' }, from:bot } }
  });
  await routeUpdate(callback(11, 2), families, tg, bot);
  assert.equal(await store.claim(), null);
  await routeUpdate(callback(12, 1), families, tg, bot);
  const selected = await store.claim();
  assert.equal(await route(input(selected)), '선택을 받았어요.');
  await routeUpdate(callback(13, 1), families, tg, bot);
  assert.equal(await store.claim(), null);
  assert.equal(calls, 1);
  assert.deepEqual(await outcome(selected.id), { status:'done', outcome:'success' });
});

test('restart holds an in-flight structured delivery with an unknown Telegram result', async t => {
  const { pool, store, chatId, input, enqueue } = await fixture(t);
  const dispatch = createJobDispatcher([{ id:'photo', handle:async () => ({
    status:'success', content:[{ type:'image', fileId:'photo_id' }]
  }) }], 'photo');
  await dispatch(input(await enqueue(1)));
  const d = await store.claimDelivery();
  const tg = { call:async () => { throw Object.assign(new Error('텔레그램 연결 결과 불확실'), { uncertain:true }); } };
  await assert.rejects(deliverSkillContent(tg, store, d, chatId), { uncertain:true });
  await recoverDeliveries(pool);
  assert.equal(await store.claimDelivery(), null);
  assert.equal((await store.issues())[0].status, 'uncertain');
});
