// Runs the same script the action runs, against a local bare repository.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = join(import.meta.dirname, '..');
const temp = mkdtempSync(join(tmpdir(), 'benchboard-'));
const remote = join(temp, 'remote.git');
execFileSync('git', ['init', '--quiet', '--bare', remote]);

let step = 0;
function publish(results, { commit, envKey = 'rustc 1.98.1; valgrind-3.22.0' }) {
  step += 1;
  const files = Object.entries(results).map(([name, content], index) => {
    const file = join(temp, `results-${step}-${index}-${name}.json`);
    writeFileSync(file, JSON.stringify(content));
    return file;
  });
  const output = join(temp, `output-${step}`);
  const report = join(temp, `report-${step}.md`);
  writeFileSync(output, '');
  execFileSync('bash', [join(root, 'publish.sh')], {
    cwd: temp,
    env: {
      PATH: process.env.PATH,
      HOME: temp,
      BENCHBOARD_REMOTE: remote,
      BENCHBOARD_RESULTS: files.join('\n'),
      BENCHBOARD_COMMIT: commit,
      BENCHBOARD_TIME: `2026-10-0${step}T05:00:00Z`,
      BENCHBOARD_ENV_KEY: envKey,
      BENCHBOARD_GATE_METRICS: 'Ir',
      BENCHBOARD_THRESHOLD: '2',
      BENCHBOARD_VIEWER_URL: 'https://example.test/benchboard/',
      BENCHBOARD_REPORT: report,
      GITHUB_REPOSITORY: 'owner/project',
      GITHUB_OUTPUT: output,
    },
  });
  const outputs = Object.fromEntries(readFileSync(output, 'utf8').trim().split('\n').map(line => {
    const at = line.indexOf('=');
    return [line.slice(0, at), line.slice(at + 1)];
  }));
  return { outputs, report: readFileSync(report, 'utf8') };
}
const stored = path => JSON.parse(execFileSync('git', ['--git-dir', remote, 'show', `perf-data:${path}`], { encoding: 'utf8' }));
const summary = (cases, extra = {}) => ({
  ...extra,
  results: Object.fromEntries(Object.entries(cases).map(([id, metrics]) => [
    id, Object.fromEntries(Object.entries(metrics).map(([metric, value]) => [metric, { value }])),
  ])),
});
const counts = { metrics: [{ key: 'Ir', label: 'Instructions', unit: 'count' }] };

const programs = { 'fcc/dhrystone/compile/dhry_1': { Ir: 2_394_000_000, Dr: 600_000_000 }, 'fcc/dhrystone/run': { Ir: 43_700_000_000 } };
const micro = { 'pbqp/dense_search/16': { Ir: 1_000_000 } };

test('the data branch accumulates runs and reports regressions against the previous one', () => {
  const first = publish({ programs: summary(programs, counts), micro: summary(micro) }, { commit: 'a'.repeat(40) });
  assert.equal(first.outputs.regressed, 'false');
  assert.match(first.report, /First recorded run/);

  const unchanged = publish({ programs: summary(programs, counts), micro: summary(micro) }, { commit: 'b'.repeat(40) });
  assert.equal(unchanged.outputs.regressed, 'false');
  assert.match(unchanged.report, /No gated metric moved more than 2%/);

  const slower = structuredClone(programs);
  slower['fcc/dhrystone/compile/dhry_1'].Ir *= 2;
  slower['fcc/dhrystone/compile/dhry_1'].Dr *= 3;
  slower['fcc/dhrystone/run'].Ir *= 1.05;
  const regressed = publish({ programs: summary(slower, counts), micro: summary(micro) }, { commit: 'c'.repeat(40) });
  assert.equal(regressed.outputs.regressed, 'true');
  assert.equal(regressed.outputs.title, 'perf: fcc/dhrystone/compile/dhry_1 instructions +100.00% at cccccccc and 1 more');
  const rows = regressed.report.split('\n').filter(line => line.startsWith('| `'));
  assert.equal(rows[0], '| `fcc/dhrystone/compile/dhry_1` | Instructions | 2.394G | 4.788G | +100.00% |');
  assert.match(rows[1], /fcc\/dhrystone\/run.*\+5\.00%/);
  assert.equal(rows.length, 2, 'the ungated Dr increase is not in the report');
  assert.ok(regressed.report.includes(`https://github.com/owner/project/compare/${'b'.repeat(40)}...${'c'.repeat(40)}`));
  assert.ok(regressed.report.includes(`https://example.test/benchboard/?repo=owner%2Fproject&branch=perf-data&view=compare&base=${'b'.repeat(40)}&head=${'c'.repeat(40)}`));

  // A toolchain update shifts every count. It is recorded and not reported as a regression.
  const shifted = structuredClone(slower);
  shifted['fcc/dhrystone/run'].Ir *= 1.5;
  const environment = publish({ programs: summary(shifted, counts), micro: summary(micro) }, { commit: 'd'.repeat(40), envKey: 'rustc 1.99.0; valgrind-3.22.0' });
  assert.equal(environment.outputs.regressed, 'false');
  assert.match(environment.report, /environment changed from `rustc 1\.98\.1; valgrind-3\.22\.0` to `rustc 1\.99\.0; valgrind-3\.22\.0`/);

  // A benchmark nobody told benchboard about is recorded and listed as new. A
  // second file adds another metric for a benchmark the first one counted.
  const tag = { benchmark: 'dhrystone', group: 'Run', variant: 'fcc', subject: true };
  const timed = summary({ 'fcc/dhrystone/run': { latency: 9e8 } }, {
    metrics: [{ key: 'latency', label: 'Wall time', unit: 'ns' }],
    variants: { 'fcc/dhrystone/run': tag },
  });
  const added = publish(
    { programs: summary(shifted, counts), micro: summary({ ...micro, 'tmdl/parser/large': { Ir: 5, wall_ns: 7 } }), timed },
    { commit: 'e'.repeat(40), envKey: 'rustc 1.99.0; valgrind-3.22.0' },
  );
  assert.equal(added.outputs.regressed, 'false');
  assert.match(added.report, /New benchmarks: `tmdl\/parser\/large`\n/);

  const index = stored('index.json');
  assert.deepEqual(index.runs.map(entry => entry.commit[0]), ['a', 'b', 'c', 'd', 'e']);
  const last = stored(index.runs.at(-1).file);
  assert.equal(last.results['tmdl/parser/large'].wall_ns.value, 7);
  assert.deepEqual(last.results['fcc/dhrystone/run'], { Ir: { value: shifted['fcc/dhrystone/run'].Ir }, latency: { value: 9e8 } });
  assert.deepEqual(last.metrics.map(metric => metric.key), ['Ir', 'latency']);
  assert.deepEqual(last.variants, { 'fcc/dhrystone/run': tag });
  assert.deepEqual(last.gate_metrics, ['Ir']);
});

test('a metric that two results files report for one benchmark is rejected', () => {
  assert.throws(() => publish({ one: summary(micro), two: summary(micro) }, { commit: 'f'.repeat(40) }));
});
