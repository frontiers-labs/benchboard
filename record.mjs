#!/usr/bin/env node
// Append one run to a checkout of the data branch and report how it compares
// with the previous run. Git operations stay in action.yml.
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { compare, formatDelta, formatValue } from './lib/compare.mjs';

const REPORT_ROWS = 30;

const { values: args } = parseArgs({
  options: {
    data: { type: 'string' },
    results: { type: 'string', multiple: true },
    commit: { type: 'string' },
    subject: { type: 'string', default: '' },
    time: { type: 'string', default: new Date().toISOString() },
    'run-url': { type: 'string', default: '' },
    'env-key': { type: 'string', default: '' },
    'gate-metrics': { type: 'string', default: '' },
    threshold: { type: 'string', default: '2' },
    repo: { type: 'string', default: '' },
    'viewer-url': { type: 'string', default: '' },
    'data-branch': { type: 'string', default: 'perf-data' },
    report: { type: 'string' },
  },
});
for (const name of ['data', 'results', 'commit']) {
  if (!args[name]?.length) fail(`--${name} is required`);
}
const time = new Date(args.time);
if (Number.isNaN(time.getTime())) fail(`--time is not a date: ${args.time}`);
const threshold = Number(args.threshold);
if (!(threshold >= 0)) fail(`--threshold must be a nonnegative percentage: ${args.threshold}`);
const gateMetrics = args['gate-metrics'].split(',').map(metric => metric.trim()).filter(Boolean);

const results = {};
for (const file of args.results) {
  for (const [id, metrics] of Object.entries(JSON.parse(readFileSync(file, 'utf8')))) {
    if (id in results) fail(`${file}: benchmark ${id} already came from another results file`);
    for (const [metric, measure] of Object.entries(metrics)) {
      if (!Number.isFinite(measure?.value)) fail(`${file}: ${id} ${metric} has no numeric value`);
    }
    results[id] = metrics;
  }
}
if (!Object.keys(results).length) fail('results contain no benchmarks');

const run = {
  commit: args.commit,
  subject: args.subject,
  time: time.toISOString(),
  run_url: args['run-url'],
  env_key: args['env-key'],
  gate_metrics: gateMetrics,
  threshold,
  results,
};

const indexPath = join(args.data, 'index.json');
const index = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, 'utf8')) : { runs: [] };
const file = `runs/${run.time.replace(/[:.]/g, '-')}-${run.commit.slice(0, 12)}.json`;
// A retried step records the same run again; keep one entry for it.
index.runs = index.runs.filter(entry => entry.file !== file);
const previous = index.runs.at(-1);
const base = previous ? JSON.parse(readFileSync(join(args.data, previous.file), 'utf8')) : null;

mkdirSync(join(args.data, 'runs'), { recursive: true });
writeFileSync(join(args.data, file), JSON.stringify(run, null, 1) + '\n');
index.runs.push({ file, commit: run.commit, subject: run.subject, time: run.time, env_key: run.env_key });
writeFileSync(indexPath, JSON.stringify(index, null, 1) + '\n');

const outcome = base ? compare(base, run, { gateMetrics, threshold: threshold / 100 }) : null;
const report = render(base, run, outcome);
if (args.report) writeFileSync(args.report, report.body);
else process.stdout.write(report.body);
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `regressed=${outcome?.regressed ?? false}\ntitle=${report.title}\n`);
}

function render(base, run, outcome) {
  const short = sha => sha.slice(0, 8);
  const commitLink = sha => (args.repo ? `[\`${short(sha)}\`](https://github.com/${args.repo}/commit/${sha})` : `\`${short(sha)}\``);
  if (!outcome) {
    return { title: '', body: `First recorded run at ${commitLink(run.commit)}. Nothing to compare with yet.\n` };
  }
  const gated = outcome.rows.filter(row => row.gated);
  const regressed = gated.filter(row => row.status === 'regressed');
  const improved = gated.filter(row => row.status === 'improved');
  const lines = [`Compared ${commitLink(run.commit)} with the previous run at ${commitLink(base.commit)}.`];
  if (run.subject) lines.push(`Commit: ${run.subject}`);
  lines.push('');
  if (outcome.envChanged) {
    lines.push(`The measurement environment changed from \`${base.env_key}\` to \`${run.env_key}\`, so this run was recorded without gating.`, '');
  }
  const links = [];
  if (args.repo && base.commit !== run.commit) links.push(`[commits in range](https://github.com/${args.repo}/compare/${base.commit}...${run.commit})`);
  if (args['viewer-url']) {
    const query = new URLSearchParams({ repo: args.repo, branch: args['data-branch'], base: base.commit, head: run.commit });
    links.push(`[compare page](${args['viewer-url']}?${query})`);
  }
  if (run.run_url) links.push(`[workflow run](${run.run_url})`);
  if (links.length) lines.push(links.join(' · '), '');
  const table = (heading, rows) => {
    if (!rows.length) return;
    lines.push(`### ${heading}`, '', '| Benchmark | Metric | Before | After | Change |', '| --- | --- | ---: | ---: | ---: |');
    for (const row of rows.slice(0, REPORT_ROWS)) {
      lines.push(`| \`${row.id}\` | ${row.metric} | ${formatValue(row.base)} | ${formatValue(row.head)} | ${formatDelta(row.delta)} |`);
    }
    if (rows.length > REPORT_ROWS) lines.push('', `${rows.length - REPORT_ROWS} more rows are on the compare page.`);
    lines.push('');
  };
  table(`Regressed above ${run.threshold}%`, regressed);
  table(`Improved above ${run.threshold}%`, improved);
  const names = status => [...new Set(outcome.rows.filter(row => row.status === status).map(row => row.id))];
  for (const [status, label] of [['new', 'New benchmarks'], ['missing', 'Benchmarks no longer reported']]) {
    const ids = names(status);
    if (ids.length) lines.push(`${label}: ${ids.slice(0, REPORT_ROWS).map(id => `\`${id}\``).join(', ')}${ids.length > REPORT_ROWS ? `, and ${ids.length - REPORT_ROWS} more` : ''}`, '');
  }
  if (!regressed.length && !improved.length) lines.push(`No gated metric moved more than ${run.threshold}%.`, '');
  let title = '';
  if (outcome.regressed) {
    const worst = regressed[0];
    const others = new Set(regressed.map(row => row.id)).size - 1;
    title = `perf: ${worst.id} ${worst.metric} ${formatDelta(worst.delta)} at ${short(run.commit)}${others > 0 ? ` and ${others} more` : ''}`;
  }
  return { title, body: lines.join('\n') };
}

function fail(message) {
  console.error(`record: ${message}`);
  process.exit(2);
}
