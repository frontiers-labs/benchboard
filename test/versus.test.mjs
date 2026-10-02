import assert from 'node:assert/strict';
import test from 'node:test';
import { meanRatio, metricIndex, ratio, versusGroups } from '../lib/versus.mjs';

const tag = (group, benchmark, variant) => ({ group, benchmark, variant, subject: variant === 'fcc' });
const tags = {
  'gcc/a': tag('Compile', 'a', 'gcc'),
  'fcc/a': tag('Compile', 'a', 'fcc'),
  'clang/a': tag('Compile', 'a', 'clang'),
  'gcc/b': tag('Compile', 'b', 'gcc'),
  'fcc/b': tag('Compile', 'b', 'fcc'),
  'fcc/run': tag('Run', 'program', 'fcc'),
};
const values = entries => ({ results: Object.fromEntries(Object.entries(entries).map(([id, time]) => [id, { time: { value: time } }])) });

test('variants of one benchmark line up behind the subject', () => {
  const [compile, run] = versusGroups(tags);
  assert.equal(compile.name, 'Compile');
  assert.deepEqual(compile.variants, ['fcc', 'clang', 'gcc']);
  assert.deepEqual(compile.benchmarks, [
    { name: 'a', ids: { gcc: 'gcc/a', fcc: 'fcc/a', clang: 'clang/a' } },
    { name: 'b', ids: { gcc: 'gcc/b', fcc: 'fcc/b' } },
  ]);
  assert.deepEqual(run.variants, ['fcc']);
});

test('the mean ratio is geometric and skips benchmarks a reference did not measure', () => {
  const [compile] = versusGroups(tags);
  const run = values({ 'fcc/a': 400, 'gcc/a': 100, 'clang/a': 200, 'fcc/b': 100, 'gcc/b': 100 });
  assert.equal(ratio(run, compile.benchmarks[0], 'fcc', 'gcc', 'time'), 4);
  // 4x and 1x average to 2x, where an arithmetic mean would say 2.5x.
  assert.deepEqual(meanRatio(run, compile, 'gcc', 'time'), { value: 2, count: 2 });
  assert.deepEqual(meanRatio(run, compile, 'clang', 'time'), { value: 2, count: 1 });
  assert.equal(meanRatio(run, compile, 'gcc', 'memory'), null);
  assert.equal(meanRatio(values({ 'gcc/a': 100 }), compile, 'gcc', 'time'), null);
});

test('metric definitions keep their declared order and fall back to the key', () => {
  const older = { metrics: [{ key: 'Ir', label: 'Instr' }], results: { a: { Ir: { value: 1 }, extra: { value: 2 } } } };
  const newer = { metrics: [{ key: 'time', label: 'Wall time', unit: 'ns' }, { key: 'Ir', label: 'Instructions', unit: 'count' }], results: {} };
  const legacy = { results: { a: { Ir: { value: 1 } } } };
  const index = metricIndex([legacy, older, newer]);
  assert.deepEqual([...index.keys()], ['Ir', 'time', 'extra']);
  assert.equal(index.get('Ir').label, 'Instructions');
  assert.deepEqual(index.get('extra'), { key: 'extra', label: 'extra' });
});
