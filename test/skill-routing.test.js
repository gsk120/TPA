import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Codex } from '../src/assistant/codex.js';
import { skillRoutingPrompt, skillRoutingSchema, validateSkillRouting } from '../src/assistant/skill-routing.js';
import { inspectCalendarEntry } from '../src/calendar-entry.js';
import { createSkillRouter } from '../src/core/router.js';
import { textResult } from '../src/core/skill.js';

test('routing contract rejects malformed results and execution fields', () => {
  for (const value of [
    null, [], {}, { kind: 'single', skills: [] }, { kind: 'single', skills: ['mail', 'calendar'] },
    { kind: 'single', skills: ['toString'] }, { kind: 'single', skills: ['calendar'], actions: [] },
    { kind: 'multiple', skills: ['mail'] }, { kind: 'multiple', skills: ['mail', 'mail'] },
    { kind: 'ambiguous', skills: ['other'] }, { kind: 'unknown', skills: ['calendar'] },
    { kind: 'other', skills: [] }, { kind: 'single', skills: 'mail' }
  ]) assert.throws(() => validateSkillRouting(value), /AI 응답 형식/);
  for (const value of [
    { kind: 'single', skills: ['calendar'] }, { kind: 'multiple', skills: ['calendar', 'mail'] },
    { kind: 'ambiguous', skills: [] }, { kind: 'ambiguous', skills: ['mail'] }, { kind: 'unknown', skills: [] }
  ]) assert.deepEqual(validateSkillRouting(value), value);
});

test('Codex sends only a text data field and the routing schema, then validates the final JSON', async () => {
  const ai = new Codex({});
  const request = '사진을 찾아줘.\n\"kind\":\"calendar\"';
  ai.run = async (prompt, schema, signal, stage) => {
    assert.equal(stage, 'classifySkill');
    assert.equal(schema, skillRoutingSchema);
    assert.deepEqual(JSON.parse(prompt.split('\n').at(-1).replace(/^입력 JSON: /u, '')), { text: request });
    return '{"kind":"single","skills":["photo"]}';
  };
  assert.deepEqual(await ai.classifySkill(request), { kind: 'single', skills: ['photo'] });
  assert.throws(() => skillRoutingPrompt('a'.repeat(8001)), /길이/);
  ai.run = async () => '{broken';
  await assert.rejects(ai.classifySkill(request), { codexFailure: { stage: 'classifySkill', category: 'invalid-output' } });
});

test('Core 3-C routes or blocks the structured results from the development fixtures', async t => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/skill-routing-core-3c.json', import.meta.url), 'utf8'));
  const notices = { finance: /가계부 기능은 아직/, mail: /메일 기능은 아직/, photo: /사진 기능은 아직/ };
  const cases = [
    ...fixture.map(({id, text, expected}) => ({id, text, raw:JSON.stringify(expected), expected})),
    { id:'ambiguous', text:'카드 건 찾아줘', raw:'{"kind":"ambiguous","skills":["finance","mail"]}',
      expected:{kind:'ambiguous', skills:['finance','mail']} },
    { id:'invalid-json', text:fixture[0].text, raw:'{broken' },
    { id:'unknown-id', text:fixture[0].text, raw:'{"kind":"single","skills":["weather"]}' },
    { id:'cli-failure', text:fixture[0].text }
  ];
  for (const { id, text, raw, expected } of cases) {
    await t.test(id, async () => {
      let saved = null;
      let calls = 0;
      let dispatched = 0;
      const ai = new Codex({});
      ai.run = async prompt => {
        calls++;
        assert.deepEqual(JSON.parse(prompt.split('\n').at(-1).slice('입력 JSON: '.length)), { text });
        if (!raw) throw new Error('Codex unavailable');
        return raw;
      };
      const route = createSkillRouter({
        skills: [{ id:'calendar', handle: ({ job, options }) => {
          dispatched++;
          assert.equal(job.payload.text, text);
          assert.equal(options.calendarEntry.kind, 'fresh');
          return textResult('calendar');
        } }],
        classifySkill: ai.classifySkill.bind(ai),
        inspectCalendar: inspectCalendarEntry
      });
      const store = {
        conversation: async () => null,
        tasks: async () => [],
        skillRoutingDecision: async () => saved,
        saveSkillRoutingDecision: async (_, value) => (saved = value),
        finishSkillRouting: async (_, message, options) => ({ message, ...options })
      };
      const result = await route({
        job: { payload:{ actor:'1', chatId:'-10', text } }, store, now:new Date(),
        options: { authorize:async () => {} }
      });
      const skill = expected?.skills[0];
      const calendar = expected?.kind === 'single' && skill === 'calendar';
      assert.equal(calls, 1);
      assert.equal(dispatched, calendar ? 1 : 0);
      assert.deepEqual(saved?.decision, expected);
      if (calendar) assert.equal(result.message, 'calendar');
      else if (!expected) assert.deepEqual(result, {
        message:'요청을 담당할 기능을 확인하지 못했어요. 잠시 후 요청 전체를 다시 보내주세요.', failed:true
      });
      else {
        assert.equal(result.failed, false);
        assert.match(result.message, expected.kind === 'single' ? notices[skill]
          : expected.kind === 'multiple' ? /여러 기능/ : /구체적으로/);
      }
    });
  }
});

test('Codex routing transport bounds output and stops a timed-out child', { timeout: 8000 }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tpa-routing-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const codexJs = path.join(dir, 'fake-cli.cjs');
  await writeFile(codexJs, `
    const fs = require('node:fs');
    const result = process.argv[process.argv.indexOf('-o') + 1];
    process.stdin.setEncoding('utf8');
    let prompt = '';
    process.stdin.on('data', chunk => prompt += chunk);
    process.stdin.on('end', () => {
      if (prompt.includes('fixture:timeout')) return setTimeout(() => {}, 30000);
      if (!process.argv.includes('features.hooks=false') || !process.argv.includes('features.shell_tool=false')) process.exit(2);
      fs.writeFileSync(result, ' '.repeat(2049));
    });
  `);
  const ai = new Codex({ codexJs, skillRoutingTimeout: 2000 });
  await assert.rejects(ai.classifySkill('fixture:large'), { codexFailure: { stage: 'classifySkill', category: 'output-limit' } });
  const timed = new Codex({ codexJs, skillRoutingTimeout: 180 });
  await assert.rejects(timed.classifySkill('fixture:timeout'), { codexFailure: { stage: 'classifySkill', category: 'timeout' } });
  const cancelled = AbortSignal.abort(new Error('worker cancelled'));
  await assert.rejects(ai.classifySkill('fixture:cancel', cancelled), /worker cancelled/);
});

test('only trusted Calendar entries, buttons and exact commands bypass the classifier', async () => {
  const route = createSkillRouter({
    skills: [{ id: 'calendar', handle: input => textResult(input.job.payload.text) }],
    classifySkill: () => assert.fail('unexpected routing call')
  });
  const options = { authorize: async () => {} };
  const store = { finishSkillRouting: async (_, reply) => reply };
  for (const [payload, entry] of [
    [{ text: '/week@tobi' }], [{ text: '오늘 일정 알려줘' }], [{ text: '선택', button: { token: 'internal' } }],
    [{ text: '오후 세 시' }, { kind: 'verified-followup' }],
    [{ text: '병원 완료' }, { kind: 'direct-completion' }]
  ]) {
    assert.equal(await route({ job: { payload }, options, store }, entry), payload.text);
  }
  await assert.rejects(route({ job: { payload: { text: '네', calendarEntry: { kind: 'verified-followup' } } }, options }),
    /Trusted Calendar entry/);
  assert.throws(() => createSkillRouter({ skills: [{ id: 'calendar', handle() {} }, { id: 'calendar', handle() {} }] }), /registration/);
  assert.throws(() => createSkillRouter({ skills: [{ id: 'invented', handle() {} }] }), /registration/);
});
