import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { createJobDispatcher } from '../src/core/router.js';
import { createCalendarSkill } from '../src/skills/calendar.js';
import { processJob } from '../src/processor.js';
import { defaults } from '../src/settings.js';
import { Store } from '../src/storage.js';

const dispatchCalendar = (skill = createCalendarSkill()) => createJobDispatcher([skill], 'calendar');

test('Calendar forwards every original argument once and returns the same pending promise', async () => {
  const args = [];
  const { promise, resolve } = Promise.withResolvers();
  const calendar = createCalendarSkill((...received) => {
    args.push(received);
    return promise;
  });
  const context = {
    job: { id: 'tg:1', family_id: 'family', lease: 'lease', payload: {
      actor: '1', chatId: '-10', text: '16:40', sentAt: 1794900000, replyTo: '{"id":210}'
    } },
    store: {},
    ai: {},
    now: new Date('2026-11-17T10:01:00Z'),
    signal: new AbortController().signal,
    options: { settings: defaults, settingsVersion: 7, authorize: async () => {} }
  };

  const result = dispatchCalendar(calendar)(context);
  assert.strictEqual(result, promise);
  assert.equal(args.length, 1);
  const expected = [context.job, context.store, context.ai, context.now, context.signal, context.options];
  assert.equal(args[0].length, expected.length);
  expected.forEach((value, index) => assert.strictEqual(args[0][index], value));
  resolve('일정 처리 결과');
  assert.equal(await result, '일정 처리 결과');
});

test('Calendar rejects with the original processor error after asynchronous work', async () => {
  const error = new Error('처리 실패');
  const { promise, reject } = Promise.withResolvers();
  const job = { payload: { actor: '1', text: '/list' } };
  const store = { conversation: () => promise };
  const result = dispatchCalendar()({ job, store, ai: null, now: new Date() });
  const rejected = assert.rejects(result, actual => actual === error);
  reject(error);
  await rejected;
});

test('Calendar resumes a checkpoint saved before Core and handles the same reply only once', async t => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec('create role anon; create role authenticated');
  await db.exec(await readFile(new URL('../sql/schema.sql', import.meta.url), 'utf8'));
  await db.exec(await readFile(new URL('../sql/calendar-sync.sql', import.meta.url), 'utf8'));
  const familyId = randomUUID();
  await db.query('insert into assistant.families(id, chat_id, user_ids) values ($1, $2, $3)',
    [familyId, '-10', ['1']]);
  await db.exec('set role assistant_app');
  const query = async (sql, params) => {
    const result = await db.query(sql, params);
    return { ...result, rowCount: result.rows.length || result.affectedRows || 0 };
  };
  const pool = { query, connect: async () => ({ query, release() {} }) };
  const legacyStore = new Store(pool, familyId);
  const openedAt = new Date();
  const dueDate = new Date(+openedAt + 2 * 86400000).toISOString().slice(0, 10);
  const payload = { actor: '1', chatId: '-10', text: '차량 점검 일정 추가' };
  const questionAi = { classify: async () => ({ intent: 'create', targets: [], answer: {
    reply: '', actions: [], clarification: {
      operation: 'create', candidateIds: [], proposedChanges: [{ field: 'dueDate', value: dueDate }],
      question: '몇 시에 점검하나요?', unresolved: '시각'
    }
  } }) };
  await legacyStore.ingest(1, payload);
  assert.match(await processJob(await legacyStore.claim(), legacyStore, questionAi, openedAt), /몇 시에 점검하나요/);
  const pending = await legacyStore.conversation(payload.actor);
  assert.ok(pending.pending && pending.workflow.snapshot);
  const delivery = await legacyStore.claimDelivery();
  await legacyStore.deliveryResult(delivery, 'sent', {
    messageIds: [210], messageRefs: [[]], chatId: payload.chatId, replyOwner: payload.actor,
    replyPending: true, requestId: pending.requestId, workflowToken: pending.workflow.token
  });

  const store = new Store(pool, familyId);
  assert.deepEqual(await store.conversation(payload.actor), pending);
  const task = {
    title: '차량 점검', kind: 'appointment', status: 'open', dueDate, time: '16:40',
    endDate: null, timeNote: null, person: null, assignee: null, notes: null,
    followUpDate: null, actualDeadline: null, remindAt: []
  };
  const ai = {
    classify: async () => assert.fail('expected the saved intent'),
    answer: async ({ message, pendingRequest }) => {
      assert.equal(message.text, task.time);
      assert.equal(pendingRequest.originalText, payload.text);
      assert.equal(pendingRequest.startedAt, openedAt.toISOString());
      assert.deepEqual(pendingRequest.proposedChanges, [{ field: 'dueDate', value: dueDate }]);
      return { reply: '', actions: [{ operation: 'create', id: null, expectedVersion: null, task }] };
    }
  };
  const dispatchJob = dispatchCalendar();
  const now = new Date(+openedAt + 60000);
  const options = { settings: defaults, settingsVersion: 1, authorize: async () => {} };
  const reply = { ...payload, text: task.time, replyTo: '{"id":210}' };
  await store.ingest(2, reply);
  assert.match(await dispatchJob({ job: await store.claim(), store, ai, now, options }), /차량 점검/);
  await store.ingest(3, reply);
  const duplicateAi = { ...ai, answer: async () => assert.fail('the checkpoint was already consumed') };
  assert.match(await dispatchJob({ job: await store.claim(), store, ai: duplicateAi, now, options }), /이미 처리/);
  assert.deepEqual((await store.tasks()).map(row => [row.title, row.dueDate, row.time]), [[task.title, dueDate, task.time]]);
  assert.equal((await store.conversation(payload.actor)).pending, false);
});
