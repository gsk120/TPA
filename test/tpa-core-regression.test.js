import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { Families } from '../src/families.js';
import { routeUpdate } from '../src/router.js';
import { processJob } from '../src/processor.js';
import { messageReferences } from '../src/context.js';
import { splitMessage } from '../src/telegram.js';
import { createSkillRouter } from '../src/core/router.js';
import { createCalendarSkill, inspectCalendarEntry } from '../src/skills/calendar.js';

const bot = { id: 99, username: 'fixture_tpa_bot', is_bot: true };
const chatId = -10;
const userId = 1;
const timeZone = 'Asia/Seoul';
// Use a future Seoul midnight inside the DB reply reference's real 30-day TTL.
const openedAt = new Date();
openedAt.setUTCDate(openedAt.getUTCDate() + 1);
openedAt.setUTCHours(14, 50, 0, 0);
const answeredAt = new Date(+openedAt + 20 * 60 * 1000);
const originalDay = openedAt.toISOString().slice(0, 10);
const originalTomorrow = new Date(+openedAt + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const schema = await readFile(new URL('../sql/schema.sql', import.meta.url), 'utf8');
const calendarSchema = await readFile(new URL('../sql/calendar-sync.sql', import.meta.url), 'utf8');

const appointment = (title, fields = {}) => ({
  title, kind: 'appointment', status: 'open', dueDate: originalTomorrow, time: '10:00',
  endDate: null, timeNote: null, person: null, assignee: null, notes: '접수처 방문',
  followUpDate: null, actualDeadline: null, remindAt: [], ...fields
});
const answer = fields => ({ reply: '', actions: [], ...fields });
const classifier = (intent, output, targets = []) => ({
  classify: async () => ({ intent, answer: output, targets })
});
const create = task => ({ operation: 'create', id: null, expectedVersion: null, task });
const update = (task, fields) => ({
  operation: 'update', id: task.id, expectedVersion: task.version, task: { ...task, ...fields }
});
const noAi = {
  classify: async () => assert.fail('unexpected classification'),
  answer: async () => assert.fail('unexpected AI answer')
};

async function fixture(t, routed = false) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec('create role anon; create role authenticated');
  await db.exec(schema);
  await db.exec(calendarSchema);
  await db.exec('set role assistant_app');
  const query = async (sql, params) => {
    const result = await db.query(sql, params);
    return { ...result, rowCount: result.rows.length || result.affectedRows || 0 };
  };
  const pool = { query, connect: async () => ({ query, release() {} }) };
  const families = new Families(pool, bot.id);
  const route = createSkillRouter({
    skills:[createCalendarSkill()], inspectCalendar:inspectCalendarEntry,
    classifySkill:async () => ({ kind:'single', skills:['calendar'] })
  });
  await families.init();
  const family = await families.setup(chatId, userId);

  const telegram = {
    async call(method, params) {
      if (method === 'getChat') return { type: 'supergroup' };
      assert.equal(method, 'getChatMember');
      return { status: params.user_id === bot.id ? 'administrator' : 'member' };
    }
  };
  let nextUpdateId = 1;

  async function enqueue(text, { actor = userId, chat = chatId, sentAt = openedAt, reply } = {}) {
    const id = nextUpdateId++;
    const incoming = {
      update_id: id,
      message: {
        message_id: 100 + id, chat: { id: chat, type: 'supergroup' }, from: { id: actor },
        text, date: +sentAt / 1000, reply_to_message: reply
      }
    };
    await replay(incoming);
    return incoming;
  }

  async function replay(incoming) {
    await routeUpdate(incoming, families, telegram, bot);
    await families.ack(incoming.update_id);
  }

  async function run(text, ai = noAi, { now = openedAt, ...message } = {}) {
    const incoming = await enqueue(text, { sentAt: now, ...message });
    const store = families.store(await families.family(message.chat ?? chatId));
    const job = await store.claim('tg:' + incoming.update_id);
    assert.ok(job, 'Telegram update must have a queued job');
    return routed ? route({job, store, ai, now, options:{authorize:async () => {}}})
      : processJob(job, store, ai, now);
  }

  async function recordBotReply(store, messageId, chat = chatId) {
    const delivery = await store.claimDelivery();
    const memory = await store.referencesForDelivery(delivery);
    const parts = splitMessage(delivery.text);
    assert.equal(parts.length, 1);
    await store.deliveryResult(delivery, 'sent', {
      messageIds: [messageId], messageRefs: messageReferences(parts, memory.refs), chatId: chat,
      replyOwner: memory.ownerActor, replyPending: memory.pending,
      workflowToken: memory.workflowToken, requestId: memory.requestId
    });
    return { message_id: messageId, from: bot, text: delivery.text };
  }

  return { families, run, enqueue, replay, recordBotReply, newStore: () => families.store(family) };
}

for (const routed of [false, true]) test(`ordinary appointments can be created, listed, edited, completed and cancelled through the job queue (${routed ? '3-B' : 'legacy'})`, async t => {
  const { run, newStore } = await fixture(t, routed);
  const store = newStore();
  const checkup = appointment('치과 검진');
  const visit = appointment('도서관 방문', { time: '13:00' });
  for (const task of [checkup, visit]) {
    await run(`!내일 ${task.title} 추가`, classifier('create', answer({ actions: [create(task)] })));
  }
  const initial = await store.tasks();
  assert.equal(initial.length, 2);
  const list = await run('/list');
  assert.match(list, /오전 10시 · 치과 검진/);
  assert.match(list, /오후 1시 · 도서관 방문/);

  async function change(intent, request, title, fields) {
    await run(request, {
      ...classifier(intent, null, [title]),
      answer: async ({ tasks }) => {
        assert.deepEqual(tasks.map(task => task.title), [title]);
        return answer({ actions: [update(tasks[0], fields)] });
      }
    });
  }
  await change('update', '!치과 검진 11시로 바꿔줘', checkup.title, { time: '11:00' });
  assert.match(await run('/list'), /오전 11시 · 치과 검진/);
  await run('!치과 검진 완료');
  await change('cancel', '!도서관 방문 취소해줘', visit.title, { status: 'cancelled' });

  const rows = await store.tasks();
  assert.equal(rows.length, 2);
  const completed = rows.find(task => task.title === checkup.title);
  const cancelled = rows.find(task => task.title === visit.title);
  assert.deepEqual([completed.id, completed.version, completed.status, completed.completedAt, completed.notes],
    [initial.find(task => task.title === checkup.title).id, 3, 'done', openedAt.toISOString(), checkup.notes]);
  assert.deepEqual([cancelled.version, cancelled.status, cancelled.completedAt], [2, 'cancelled', null]);
  assert.doesNotMatch(await run('/list'), /치과 검진|도서관 방문/);
  const done = { kind: 'task_list', status: 'done', from: null, to: null, person: null, search: null };
  const completedList = await run('!완료한 일정 보여줘', classifier('retrieve', answer({ retrieval: done })));
  assert.match(completedList, /치과 검진/);
  assert.doesNotMatch(completedList, /도서관 방문/);
  assert.equal((await store.history()).length, 5);
});

for (const routed of [false, true]) test(`repeat registration and occurrence changes preserve the series and sibling (${routed ? '3-B' : 'legacy'})`, async t => {
  const { run, newStore } = await fixture(t, routed);
  const store = newStore();
  const title = '서버 점검';
  const series = {
    title, frequency: 'DAILY', start: null, end: originalTomorrow, time: '23:55', timeType: 'timed'
  };
  const text = `!${originalTomorrow}까지 매일 서버 점검 23:55에 등록해줘`;
  const ai = classifier('create', answer({ series }));
  // The Telegram message preceded midnight, while the queue worker picked it up afterward.
  const options = { now: answeredAt, sentAt: openedAt };
  assert.match(await run(text, ai, options), /시리즈 등록[\s\S]*회차 2건/);
  assert.match(await run(text, ai, options), /이미 처리된 요청/);
  const range = { now: openedAt, timeZone, from: originalDay, to: originalTomorrow, listOnly: true };
  const [first, sibling] = await store.calendarTasks(range);
  assert.deepEqual([first.dueDate, sibling.dueDate], [originalDay, originalTomorrow]);
  assert.deepEqual(await store.tasks(), []);
  assert.match(await run('/list'), /서버 점검/);
  assert.match(await run('!그거 메모 알려줘', {
    answer: async ({ tasks }) => {
      assert.ok(tasks.length && tasks.every(task => task.recurrence?.seriesId === first.recurrence.seriesId));
      return answer({reply:'서버 점검 메모 확인'});
    }
  }), /서버 점검 메모/);
  const before = (await store.backup()).calendar.schedule_series;
  assert.equal(before.length, 1);
  await run(`!${originalTomorrow} 서버 점검 일정만 18시로 바꿔줘`, {
    ...classifier('update', null, [title]),
    answer: async ({ tasks }) => {
      assert.deepEqual(tasks.map(task => task.id), [sibling.id]);
      return answer({ actions: [update(tasks[0], { time: '18:00' })] });
    }
  });
  const after = await store.calendarTasks(range);
  assert.deepEqual(after.find(task => task.id === first.id), first);
  assert.equal(after.find(task => task.id === sibling.id).time, '18:00');
  const snapshot = await store.backup();
  assert.deepEqual(snapshot.calendar.schedule_series, before);
  assert.equal(snapshot.calendar.schedule_exceptions.length, 1);
  assert.equal(snapshot.calendar.schedule_exceptions[0].anchor_key, sibling.recurrence.anchor);
  const cancel = (scope, question = null) => ({classify:async () => ({
    intent:'cancel',targets:[title],answer:null,cancellation:{scope,date:null,question}
  })});
  assert.match(await run('!서버 점검 반복 일정 취소 범위를 확인해줘',cancel(null,'전체 시리즈인가요, 한 회차인가요?')),
    /전체 시리즈인가요/);
  assert.match(await run('!전체',cancel('series')),/전체 취소 완료/);
  assert.match(await run(text,ai,options),/시리즈 등록/);
  const [active] = await store.activeScheduleSeries();
  assert.notEqual(active.id,first.recurrence.seriesId);
});

async function askForTime(run, options) {
  const original = '내일 차량 점검 일정 추가';
  const ai = {
    classify: async ({ message, now, settings }) => {
      assert.equal(message.text, original);
      assert.equal(now.toISOString(), (options?.now ?? openedAt).toISOString());
      assert.equal(settings.timeZone, timeZone);
      const tomorrowInSeoul = new Date(+now + (9 + 24) * 60 * 60 * 1000).toISOString().slice(0, 10);
      return {
        intent: 'create', targets: [], answer: answer({ clarification: {
          operation: 'create', candidateIds: [], proposedChanges: [{ field: 'dueDate', value: tomorrowInSeoul }],
          question: '몇 시에 점검하나요?', unresolved: '시각'
        } })
      };
    }
  };
  assert.match(await run('!' + original, ai, options), /몇 시에 점검하나요/);
  return original;
}

for (const routed of [false, true]) test(`a Telegram confirmation restores the saved checkpoint across midnight (${routed ? '3-B' : 'legacy'})`, async t => {
  const { run, newStore, recordBotReply } = await fixture(t, routed);
  const original = await askForTime(run);
  const store = newStore();
  const pending = await store.conversation(userId);
  assert.ok(pending.pending && pending.workflow.snapshot);
  assert.deepEqual(await store.tasks(), []);
  const reply = await recordBotReply(store, 871);

  const reopenedStore = newStore();
  assert.notEqual(reopenedStore, store);
  assert.deepEqual(await reopenedStore.conversation(userId), pending);
  const reference = await reopenedStore.replyReference(reply.message_id);
  assert.deepEqual([reference.requestId, reference.workflowToken, reference.ownerActor, reference.chatId],
    [pending.requestId, pending.workflow.token, String(userId), String(chatId)]);

  const ai = {
    ...noAi,
    answer: async ({ pendingRequest, now }) => {
      assert.equal(now.toISOString(), answeredAt.toISOString());
      assert.equal(pendingRequest.originalText, original);
      assert.equal(pendingRequest.startedAt, openedAt.toISOString());
      assert.equal(pendingRequest.timeZone, timeZone);
      const [proposed] = pendingRequest.proposedChanges;
      assert.deepEqual(proposed, { field: 'dueDate', value: originalTomorrow });
      return answer({ actions: [create(appointment('차량 점검', { dueDate: proposed.value, time: '16:30' }))] });
    }
  };
  assert.match(await run('16:30', ai, { now: answeredAt, reply }), /차량 점검/);
  assert.deepEqual((await reopenedStore.tasks()).map(task => [task.dueDate, task.time]), [[originalTomorrow, '16:30']]);
  assert.equal((await reopenedStore.conversation(userId)).pending, false);
  assert.match(await run('16:30', noAi, { now: answeredAt, reply }), /이미 처리/);
  assert.equal((await reopenedStore.tasks()).length, 1);
});

for (const routed of [false, true]) test(`a persisted confirmation rejects a different actor, chat or expired conversation (${routed ? '3-B' : 'legacy'})`, async t => {
  const { families, run, newStore, recordBotReply } = await fixture(t, routed);
  await askForTime(run);
  const store = newStore();
  const pending = await store.conversation(userId);
  const reply = await recordBotReply(store, 872);
  assert.match(await run('16:30', noAi, { actor: 2, now: answeredAt, reply }), /이미 처리/);
  assert.equal(await store.conversation(2), null);

  // Telegram migrations keep the same family ID, so this exercises chat matching rather than family isolation.
  const movedChat = -20;
  await families.move(chatId, movedChat);
  assert.match(await run('16:30', noAi, { chat: movedChat, now: answeredAt, reply }), /이미 처리/);
  await families.move(movedChat, chatId);

  const expiry = new Date(pending.expiresAt);
  assert.equal(+expiry - +openedAt, 2 * 60 * 60 * 1000);
  assert.match(await run('16:30', noAi, { now: expiry, reply }), /이미 처리/);
  assert.deepEqual(await store.conversation(userId), pending);
  assert.deepEqual(await store.tasks(), []);
  assert.deepEqual(await store.history(), []);
});

test('redelivery of the same Telegram update creates one ordinary appointment; distinct updates may create identical rows', async t => {
  const { families, enqueue, replay, run, newStore } = await fixture(t);
  const store = newStore();
  const text = '!내일 예방 접종 추가';
  const task = appointment('예방 접종');
  const ai = classifier('create', answer({ actions: [create(task)] }));
  const incoming = await enqueue(text);
  await replay(incoming);
  const job = await store.claim();
  assert.equal(job.id, 'tg:' + incoming.update_id);
  assert.equal(await store.claim(), null);
  await processJob(job, store, ai, openedAt);
  await replay(incoming);
  assert.equal(await store.claim(), null);
  assert.equal(await families.cursor(), incoming.update_id + 1);
  assert.equal((await store.tasks()).length, 1);
  assert.equal((await store.history()).length, 1);

  // Characterization of the current contract for a new Telegram update ID.
  await run(text, ai);
  const saved = await store.tasks();
  assert.equal(saved.length, 2);
  assert.notEqual(saved[0].id, saved[1].id);
  assert.deepEqual(saved.map(row => [row.title, row.dueDate, row.time]),
    [[task.title, task.dueDate, task.time], [task.title, task.dueDate, task.time]]);
});

test('ordinary classification and pending start use worker time when the first Telegram message queued before midnight', async t => {
  const { run, newStore } = await fixture(t);
  await askForTime(run, { now: answeredAt, sentAt: openedAt });
  const pending = await newStore().conversation(userId);
  assert.equal(pending.request.startedAt, answeredAt.toISOString());
  const dayAfterOriginalTomorrow = new Date(+openedAt + 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  assert.deepEqual(pending.request.proposedChanges, [{ field: 'dueDate', value: dayAfterOriginalTomorrow }]);
});

test('a bare detail selection currently survives a Telegram chat move within the same family', async t => {
  const { families, run, newStore } = await fixture(t);
  const title = '정기 검진';
  for (const time of ['10:00', '11:00']) {
    const ai = classifier('create', answer({ actions: [create(appointment(title, { time }))] }));
    await run(`!${title} ${time} 일정 추가`, ai);
  }
  const store = newStore();
  const before = await store.tasks();
  assert.match(await run(`!${title} 자세히 알려줘`), /어떤 일정인가요/);
  const pending = await store.conversation(userId);
  assert.equal(pending.request.operation, 'detail');
  assert.equal(pending.workflow, undefined);
  const movedChat = -20;
  await families.move(chatId, movedChat);
  // The legacy read-only path scopes bare selections by family and actor, even after the chat ID changes.
  assert.match(await run('!첫 번째', noAi, { chat: movedChat }), /접수처 방문/);
  assert.deepEqual(await store.tasks(), before);
  assert.equal((await store.history()).length, 2);
});

