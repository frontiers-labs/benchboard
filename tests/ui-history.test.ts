import assert from 'node:assert/strict';
import test from 'node:test';
import type { Measurement, Run } from '../src/shared/types';
import { compatibleBaseline, priorNightly, priorValue, trendHistory } from '../src/ui/history';

const measurement: Measurement = { suite: 'runtime', benchmark: 'CoreMark', compiler: 'fcc', metric: 'time', unit: 'ms', value: 100 };
const run = (id: string, timestamp: string, value: number, changes: Partial<Run> = {}): Run => ({
  id, timestamp, project: 'tir', branch: 'master', machine: 'rv64', config: 'O3', commit: id, kind: 'nightly',
  measurements: [{ ...measurement, value }], ...changes,
});

test('historical nightly uses only an older matching nightly', () => {
  const selected = run('selected', '2026-09-22T00:00:00.000Z', 100);
  const older = run('older', '2026-09-21T00:00:00.000Z', 80);
  const runs = [run('newer', '2026-09-23T00:00:00.000Z', 70), selected,
    run('same-time', selected.timestamp, 90), run('other-branch', '2026-09-21T10:00:00.000Z', 60, { branch: 'dev' }),
    run('other-machine', '2026-09-21T09:00:00.000Z', 60, { machine: 'x86' }),
    run('older-candidate', '2026-09-21T08:00:00.000Z', 60, { kind: 'candidate' }), older];
  assert.equal(priorNightly(runs, selected)?.id, 'older');
  assert.equal(priorValue(runs, selected, measurement), 80);
  assert.deepEqual(trendHistory(runs, selected, measurement).map(item => item.run.id), ['older', 'selected']);
});

test('feature candidate compares with master nightly history', () => {
  const selected = run('feature', '2026-09-22T00:00:00.000Z', 100, { branch: 'feature/x', kind: 'candidate' });
  const master = run('master', '2026-09-21T00:00:00.000Z', 80);
  const featureNightly = run('feature-nightly', '2026-09-21T10:00:00.000Z', 60, { branch: 'feature/x' });
  const runs = [selected, featureNightly, master];
  assert.equal(compatibleBaseline(selected, master), true);
  assert.equal(compatibleBaseline(selected, featureNightly), false);
  assert.equal(priorNightly(runs, selected)?.id, 'master');
  assert.equal(priorValue(runs, selected, measurement), 80);
  assert.deepEqual(trendHistory(runs, selected, measurement).map(item => item.run.id), ['master', 'feature']);
});

test('trend matches the complete measurement identity', () => {
  const selected = run('selected', '2026-09-22T00:00:00.000Z', 100);
  const wrongMetric = run('wrong', '2026-09-21T00:00:00.000Z', 70, { measurements: [{ ...measurement, metric: 'instructions', value: 70 }] });
  assert.deepEqual(trendHistory([selected, wrongMetric], selected, measurement).map(item => item.run.id), ['selected']);
  assert.equal(priorValue([selected, wrongMetric], selected, measurement), null);
});
