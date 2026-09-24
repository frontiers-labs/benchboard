import assert from 'node:assert/strict';
import test from 'node:test';
import type { Run } from '../src/shared/types';
import { compareRuns } from '../src/shared/compare';
import { normalizedTimestamp, parseThreshold, validateRun, ValidationError } from '../src/shared/validation';
import worker from '../src/worker/index';

const baseline: Run = {
  id: 'nightly-1', project: 'tir', commit: 'abc123', branch: 'master', kind: 'nightly',
  timestamp: '2026-09-24T00:00:00Z', machine: 'host-a', config: 'release-rv64',
  metadata: { source: 'CI' },
  measurements: [
    { suite: 'runtime', benchmark: 'coremark', compiler: 'tir', metric: 'time', unit: 'ms', value: 100, metadata: { sourceFile: 'result.json' } },
    { suite: 'runtime', benchmark: 'coremark', compiler: 'clang', metric: 'time', unit: 'ms', value: 80, gate: false },
  ],
};
const candidate = (changes: Partial<Run> = {}): Run => ({ ...structuredClone(baseline), id: 'candidate-1', kind: 'candidate', ...changes });

test('validates dates, keys, values, metadata and display-only flags', () => {
  assert.deepEqual(validateRun(baseline), baseline);
  assert.throws(() => validateRun({ ...baseline, timestamp: '2026-02-30T00:00:00Z' }), ValidationError);
  assert.throws(() => validateRun({ ...baseline, measurements: [...baseline.measurements, baseline.measurements[0]] }), /duplicate measurement key/);
  assert.throws(() => validateRun({ ...baseline, measurements: [{ ...baseline.measurements[0], value: Infinity }] }), /finite nonnegative/);
  assert.throws(() => validateRun({ ...baseline, measurements: [{ ...baseline.measurements[0], gate: 'false' }] }), /gate must be boolean/);
  assert.deepEqual(validateRun({ ...baseline, measurements: [{ ...baseline.measurements[0], value: 0, samples: [0], lower: 0, upper: 0 }] }).measurements[0].samples, [0]);
  assert.throws(() => validateRun({ ...baseline, measurements: [{ ...baseline.measurements[0], value: -1 }] }), /finite nonnegative/);
  let nested: unknown = 'leaf';
  for (let i = 0; i < 18; i++) nested = { next: nested };
  assert.throws(() => validateRun({ ...baseline, metadata: { nested } }), /metadata bounds/);
});

test('normalizes timestamps for chronological SQL ordering', () => {
  assert.equal(normalizedTimestamp('2026-09-24T00:00:00Z'), '2026-09-24T00:00:00.000Z');
  assert.equal(normalizedTimestamp('2026-09-24T00:00:00.12Z'), '2026-09-24T00:00:00.120Z');
  assert.ok(normalizedTimestamp('2026-09-24T00:00:00Z') < normalizedTimestamp('2026-09-24T00:00:00.001Z'));
});

test('threshold accepts bounded arithmetic percentages', () => {
  assert.equal(parseThreshold(null), 5);
  assert.equal(parseThreshold('0'), 0);
  assert.equal(parseThreshold('100'), 100);
  for (const bad of ['-1', '101', 'NaN', 'Infinity', '5%']) assert.throws(() => parseThreshold(bad), ValidationError);
});

test('comparison fails closed for missing gated coverage and regression', () => {
  const missing = candidate({ measurements: [baseline.measurements[1]] });
  assert.equal(compareRuns(baseline, missing).status, 'fail');
  assert.equal(compareRuns(baseline, missing).rows[0].status, 'missing');
  const regressed = candidate();
  regressed.measurements[0].value = 105.01;
  regressed.measurements[0].gate = false;
  assert.equal(compareRuns(baseline, regressed, 5).status, 'fail');
  regressed.measurements[0].value = 105;
  assert.equal(compareRuns(baseline, regressed, 5).status, 'pass');
});

test('display-only rows remain visible without failing the gate', () => {
  const run = candidate();
  run.measurements[1].value = 999;
  assert.equal(compareRuns(baseline, run).status, 'pass');
  assert.equal(compareRuns(baseline, run).rows[1].status, 'regressed');
  run.measurements.push({ suite: 'criterion', benchmark: 'new', compiler: 'tir', metric: 'time', unit: 'ns', value: 20 });
  assert.equal(compareRuns(baseline, run).rows[2].status, 'new');
  const withoutReference = candidate({ measurements: [baseline.measurements[0]] });
  assert.equal(compareRuns(baseline, withoutReference).status, 'pass');
  assert.equal(compareRuns(baseline, withoutReference).rows[1].status, 'missing');
  const zeroReference = structuredClone(baseline);
  zeroReference.measurements[1].value = 0;
  assert.equal(compareRuns(zeroReference, run).status, 'pass');
  assert.equal(compareRuns(zeroReference, run).rows[1].changePercent, null);
});

test('comparison rejects incompatible provenance and empty gating', () => {
  assert.equal(compareRuns(null, candidate()).status, 'incomparable');
  assert.equal(compareRuns(baseline, candidate({ config: 'different' })).status, 'incomparable');
  assert.equal(compareRuns({ ...baseline, measurements: [baseline.measurements[1]] }, candidate()).status, 'incomparable');
  assert.equal(compareRuns(baseline, candidate(), 101).status, 'incomparable');
  const zeroGate = structuredClone(baseline);
  zeroGate.measurements[0].value = 0;
  assert.equal(compareRuns(zeroGate, candidate()).status, 'incomparable');
});

test('submission rejects unauthenticated requests before reading their body', async () => {
  const response = await worker.fetch(new Request('http://localhost/api/runs', { method: 'POST', body: '{bad json' }), { DB: null as never, SUBMIT_TOKEN: 'secret' });
  assert.equal(response.status, 401);
});

test('run list returns a keyset cursor only when another row exists', async () => {
  let sql = '';
  let bindings: unknown[] = [];
  const db = {
    prepare(statement: string) {
      sql = statement;
      return { bind(...args: unknown[]) { bindings = args; return { async all() {
        return { results: [baseline, candidate({ id: 'candidate-2' })].map(run => ({ id: run.id, timestamp: normalizedTimestamp(run.timestamp), body: JSON.stringify(run) })) };
      } }; } };
    },
  } as unknown as D1Database;
  const response = await worker.fetch(new Request('http://localhost/api/runs?project=tir&limit=1&before=2026-09-25T00%3A00%3A00Z&beforeId=next'), { DB: db });
  assert.equal(response.status, 200);
  const body = await response.json() as { runs: Run[]; nextCursor: { before: string; beforeId: string } | null };
  assert.equal(body.runs.length, 1);
  assert.deepEqual(body.nextCursor, { before: '2026-09-24T00:00:00.000Z', beforeId: 'nightly-1' });
  assert.match(sql, /timestamp < \? OR \(timestamp = \? AND id < \?\)/);
  assert.deepEqual(bindings, ['tir', '2026-09-25T00:00:00.000Z', '2026-09-25T00:00:00.000Z', 'next', 2]);
});
