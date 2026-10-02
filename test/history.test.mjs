import assert from 'node:assert/strict';
import test from 'node:test';
import { groupIds, resolveRun, series } from '../lib/history.mjs';

test('a commit prefix resolves to the latest run of that commit', () => {
  const runs = [
    { file: 'runs/1-abc.json', commit: 'abc123' },
    { file: 'runs/2-abc.json', commit: 'abc123' },
    { file: 'runs/3-def.json', commit: 'def456' },
  ];
  assert.equal(resolveRun(runs, 'abc'), 1);
  assert.equal(resolveRun(runs, 'runs/1-abc.json'), 0);
  assert.equal(resolveRun(runs, 'def456'), 2);
  assert.equal(resolveRun(runs, '999'), -1);
  assert.equal(resolveRun(runs, ''), -1);
});

test('benchmarks group by their first two path segments', () => {
  const groups = groupIds(['fcc/coremark/source/O2/run', 'pbqp/dense_search/32', 'fcc/coremark/source/O2/compile/core_main', 'large_asm/lex', 'pbqp/dense_search/16']);
  assert.deepEqual([...groups], [
    ['fcc/coremark', ['fcc/coremark/source/O2/compile/core_main', 'fcc/coremark/source/O2/run']],
    ['large_asm', ['large_asm/lex']],
    ['pbqp/dense_search', ['pbqp/dense_search/16', 'pbqp/dense_search/32']],
  ]);
});

test('a series skips runs that did not report the benchmark', () => {
  const runs = [
    { results: { a: { Ir: { value: 10 } } } },
    { results: {} },
    { results: { a: { Ir: { value: 12 }, Dr: { value: 1 } } } },
  ];
  assert.deepEqual(series(runs, 'a', 'Ir'), [{ index: 0, value: 10 }, { index: 2, value: 12 }]);
  assert.deepEqual(series(runs, 'a', 'missing'), []);
});
