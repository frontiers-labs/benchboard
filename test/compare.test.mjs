import assert from 'node:assert/strict';
import test from 'node:test';
import { compare, formatDelta, formatValue } from '../lib/compare.mjs';

const run = (results, env_key = 'rustc 1; valgrind 3') => ({
  env_key,
  results: Object.fromEntries(Object.entries(results).map(([id, metrics]) => [
    id, Object.fromEntries(Object.entries(metrics).map(([metric, value]) => [metric, { value }])),
  ])),
});
const options = { gateMetrics: ['Ir'], threshold: 0.02 };
const row = (outcome, id, metric) => outcome.rows.find(r => r.id === id && r.metric === metric);

test('a gated metric above the threshold regresses the run and sorts first', () => {
  const outcome = compare(
    run({ a: { Ir: 100, Dr: 50 }, b: { Ir: 1000 } }),
    run({ a: { Ir: 200, Dr: 50 }, b: { Ir: 1010 } }),
    options,
  );
  assert.equal(outcome.regressed, true);
  assert.deepEqual(outcome.rows[0], { id: 'a', metric: 'Ir', base: 100, head: 200, delta: 1, status: 'regressed', gated: true });
  assert.equal(row(outcome, 'b', 'Ir').status, 'unchanged');
});

test('an ungated metric is flagged in its row without regressing the run', () => {
  const outcome = compare(run({ a: { Ir: 100, Dr: 50 } }), run({ a: { Ir: 100, Dr: 500 } }), options);
  assert.equal(outcome.regressed, false);
  assert.equal(row(outcome, 'a', 'Dr').status, 'regressed');
  assert.equal(row(outcome, 'a', 'Dr').gated, false);
});

test('the threshold applies in both directions', () => {
  const outcome = compare(
    run({ a: { Ir: 1000 }, b: { Ir: 1000 }, c: { Ir: 1000 }, d: { Ir: 1000 } }),
    run({ a: { Ir: 1019 }, b: { Ir: 1021 }, c: { Ir: 979 }, d: { Ir: 981 } }),
    options,
  );
  assert.equal(row(outcome, 'a', 'Ir').status, 'unchanged');
  assert.equal(row(outcome, 'b', 'Ir').status, 'regressed');
  assert.equal(row(outcome, 'c', 'Ir').status, 'improved');
  assert.equal(row(outcome, 'd', 'Ir').status, 'unchanged');
});

test('new and missing benchmarks are reported and never regress the run', () => {
  const outcome = compare(run({ gone: { Ir: 100 } }), run({ added: { Ir: 1e9, wall: 3 } }), options);
  assert.equal(outcome.regressed, false);
  assert.deepEqual(row(outcome, 'gone', 'Ir'), { id: 'gone', metric: 'Ir', base: 100, head: null, delta: null, status: 'missing', gated: true });
  assert.equal(row(outcome, 'added', 'Ir').status, 'new');
  assert.equal(row(outcome, 'added', 'wall').status, 'new');
});

test('a changed environment key disables the gate but keeps the rows', () => {
  const outcome = compare(run({ a: { Ir: 100 } }, 'rustc 1'), run({ a: { Ir: 300 } }, 'rustc 2'), options);
  assert.equal(outcome.envChanged, true);
  assert.equal(outcome.regressed, false);
  assert.equal(row(outcome, 'a', 'Ir').status, 'regressed');
});

test('a zero baseline regresses only when the value becomes nonzero', () => {
  const outcome = compare(run({ a: { Ir: 0 }, b: { Ir: 0 } }), run({ a: { Ir: 0 }, b: { Ir: 5 } }), options);
  assert.equal(row(outcome, 'a', 'Ir').status, 'unchanged');
  assert.equal(row(outcome, 'b', 'Ir').status, 'regressed');
  assert.equal(formatDelta(row(outcome, 'b', 'Ir').delta), 'was 0');
});

test('values and deltas format for a table', () => {
  assert.equal(formatValue(9038000000), '9.038 bn');
  assert.equal(formatValue(436435), '436.4 k');
  assert.equal(formatValue(123), '123');
  assert.equal(formatValue(0.5), '0.5000');
  assert.equal(formatValue(null), 'n/a');
  assert.equal(formatValue(1_234_500_000, 'ns'), '1.234 s');
  assert.equal(formatValue(87_650, 'ns'), '87.65 µs');
  assert.equal(formatValue(52_428_800, 'bytes'), '50.00 MiB');
  assert.equal(formatDelta(1.0416), '+104.16%');
  assert.equal(formatDelta(-0.7351), '-73.51%');
  assert.equal(formatDelta(null), 'n/a');
});
