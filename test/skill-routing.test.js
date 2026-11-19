import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Codex } from '../src/assistant/codex.js';
import { skillRoutingPrompt, skillRoutingSchema, validateSkillRouting } from '../src/assistant/skill-routing.js';
import { createSkillRouter } from '../src/core/router.js';

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
    skills: [{ id: 'calendar', handle: input => input.job.payload.text }],
    classifySkill: () => assert.fail('unexpected routing call')
  });
  const options = { authorize: async () => {} };
  for (const [payload, entry] of [
    [{ text: '/week@tobi' }], [{ text: '오늘 일정 알려줘' }], [{ text: '선택', button: { token: 'internal' } }],
    [{ text: '오후 세 시' }, { kind: 'verified-followup' }],
    [{ text: '병원 완료' }, { kind: 'direct-completion' }]
  ]) {
    assert.equal(await route({ job: { payload }, options }, entry), payload.text);
  }
  await assert.rejects(route({ job: { payload: { text: '네', calendarEntry: { kind: 'verified-followup' } } }, options }),
    /Trusted Calendar entry/);
  assert.throws(() => createSkillRouter({ skills: [{ id: 'calendar', handle() {} }, { id: 'calendar', handle() {} }] }), /registration/);
  assert.throws(() => createSkillRouter({ skills: [{ id: 'invented', handle() {} }] }), /registration/);
});
