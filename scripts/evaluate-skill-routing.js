import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { Codex, skillRoutingTimeoutMs } from '../src/assistant/codex.js';

const { values } = parseArgs({ options: {
  'codex-js': { type: 'string' },
  executable: { type: 'string', default: 'codex' },
  model: { type: 'string' },
  'timeout-ms': { type: 'string' },
  limit: { type: 'string' }
} });
const fixture = JSON.parse(await readFile(new URL('../test/fixtures/skill-routing-eval.json', import.meta.url), 'utf8'));
const timeoutMs = Number(values['timeout-ms'] ?? skillRoutingTimeoutMs);
const limit = Number(values.limit ?? fixture.length);
if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || !Number.isInteger(limit) || limit < 1 || limit > fixture.length) {
  throw new Error('Invalid timeout or fixture limit');
}
const ai = new Codex({
  codexExecutable: values.executable,
  codexJs: values['codex-js'],
  model: values.model,
  skillRoutingTimeout: timeoutMs
});

const results = [];
for (const { id, text, expected } of fixture.slice(0, limit)) {
  const started = performance.now();
  let result;
  try {
    const actual = await ai.classifySkill(text);
    const correct = actual.kind === expected.kind
      && (!expected.skills || [...actual.skills].sort().join(',') === [...expected.skills].sort().join(','));
    result = { id, expected, actual, correct };
  } catch (error) {
    result = { id, error: error.codexFailure?.category ?? error.code ?? 'local-error' };
  }
  results.push({ ...result, ms: Math.round(performance.now() - started) });
  console.log(JSON.stringify(results.at(-1)));
}

const successes = results.filter(result => result.actual);
const correct = successes.filter(result => result.correct).length;
const timeouts = results.filter(result => result.error === 'timeout').length;
const durations = successes.map(result => result.ms).sort((a, b) => a - b);
const percentile = p => durations.length ? durations[Math.ceil(durations.length * p) - 1] : null;
console.log(JSON.stringify({
  summary: {
    modelOverride: values.model ?? null, timeoutMs, attempts: results.length, classified: successes.length,
    correct, accuracy: successes.length ? correct / successes.length : null, timeouts,
    timeoutRate: timeouts / results.length, p50Ms: percentile(0.50), p95Ms: percentile(0.95)
  }
}));
if (correct !== results.length) process.exitCode = 1;
