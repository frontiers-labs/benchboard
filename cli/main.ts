#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { importCriterion, importTir, type Args } from './adapters.ts';
import type { Run } from '../src/shared/types.ts';
import { validateRun } from '../src/shared/validation.ts';

type Options = Record<string, string[]>;
function parse(argv: string[]): { command: string; options: Options } {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h') return { command: 'help', options: {} };
  const options: Options = {};
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (token === '--help' || token === '-h') return { command: 'help', options: {} };
    if (!token.startsWith('--')) throw new Error(`unexpected argument: ${token}`);
    const key = token.slice(2);
    const value = rest[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`--${key} requires a value`);
    (options[key] ??= []).push(value);
    i++;
  }
  return { command, options };
}

function one(options: Options, key: string, fallback?: string): string {
  const values = options[key];
  if (values && values.length !== 1) throw new Error(`--${key} may be supplied once`);
  const value = values?.[0] ?? fallback;
  if (value === undefined) throw new Error(`--${key} is required`);
  return value;
}
function many(options: Options, key: string): string[] { return options[key] ?? []; }

function metadata(options: Options): Args {
  return {
    id: one(options, 'id'), project: one(options, 'project'), commit: one(options, 'commit'),
    branch: one(options, 'branch'), kind: one(options, 'kind') as Run['kind'],
    machine: one(options, 'machine'), config: one(options, 'config'), timestamp: one(options, 'timestamp'),
  };
}

function help(): void {
  process.stdout.write(`benchboard CLI

  tsx cli/main.ts import-tir --input BUNDLE_OR_RESULTS_JSON [--input ...] ${'\\'}
    --id ID --project PROJECT --commit SHA --branch BRANCH --kind nightly|candidate ${'\\'}
    --machine NAME --config LABEL --timestamp ISO [--output FILE]
  tsx cli/main.ts import-criterion --input CRITERION_DIR [--input ...] --compiler NAME (same metadata flags)
  tsx cli/main.ts submit --run RUN.json
  tsx cli/main.ts check --run RUN.json [--branch master] [--threshold 5]

Import commands write one canonical Run JSON document to stdout unless --output is set.
submit reads BENCHBOARD_TOKEN and sends POST /api/runs. check posts to /api/check.
BENCHBOARD_URL must use HTTPS, except loopback development. For a trusted private
network such as Tailscale, BENCHBOARD_ALLOW_HTTP=1 explicitly permits HTTP.
`);
}

async function outputJson(value: unknown, file?: string): Promise<void> {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  if (file) await writeFile(file, content, 'utf8');
  else process.stdout.write(content);
}

async function loadRun(file: string): Promise<Run> {
  const run = JSON.parse(await readFile(file, 'utf8')) as Run;
  if (!run || typeof run !== 'object' || !Array.isArray(run.measurements) || !run.measurements.length) throw new Error('run file has no measurements');
  return validateRun(run);
}

function baseUrl(): string {
  const value = process.env.BENCHBOARD_URL ?? 'http://localhost:8787';
  const url = new URL(value);
  const localHttpHosts = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
  const allowedHttp = url.protocol === 'http:' && (localHttpHosts.has(url.hostname) || process.env.BENCHBOARD_ALLOW_HTTP === '1');
  if (url.protocol !== 'https:' && !allowedHttp) {
    throw new Error('BENCHBOARD_URL must use HTTPS; plain HTTP requires loopback or BENCHBOARD_ALLOW_HTTP=1');
  }
  return url.toString().replace(/\/$/, '');
}

async function submit(options: Options): Promise<void> {
  const token = process.env.BENCHBOARD_TOKEN;
  if (!token) throw new Error('BENCHBOARD_TOKEN is required for submit');
  const run = await loadRun(one(options, 'run'));
  const response = await fetch(`${baseUrl()}/api/runs`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(run), signal: AbortSignal.timeout(30_000) });
  const body = await response.text();
  if (!response.ok) throw new Error(`submit failed (${response.status}): ${body}`);
  process.stdout.write(`${body}\n`);
}

async function check(options: Options): Promise<void> {
  const run = await loadRun(one(options, 'run'));
  const branch = one(options, 'branch', 'master');
  const threshold = Number(one(options, 'threshold', '5'));
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) throw new Error('--threshold must be between 0 and 100');
  const query = new URLSearchParams({ branch, threshold: String(threshold) });
  const response = await fetch(`${baseUrl()}/api/check?${query}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(run), signal: AbortSignal.timeout(30_000) });
  const body = await response.text();
  if (!response.ok) throw new Error(`check failed (${response.status}): ${body}`);
  let result: any;
  try { result = JSON.parse(body); } catch { throw new Error(`check returned invalid JSON: ${body}`); }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status === 'fail') process.exitCode = 1;
  else if (result.status !== 'pass') process.exitCode = 2;
}

async function main(): Promise<void> {
  const { command, options } = parse(process.argv.slice(2));
  if (command === 'help') return help();
  if (command === 'submit') return submit(options);
  if (command === 'check') return check(options);
  if (command === 'import-tir') {
    const imported = await importTir(many(options, 'input'), metadata(options));
    return outputJson({ ...imported.run, metadata: { sources: imported.sourceMetadata } }, options.output ? one(options, 'output') : undefined);
  }
  if (command === 'import-criterion') {
    const imported = await importCriterion(many(options, 'input'), metadata(options), one(options, 'compiler'));
    return outputJson({ ...imported.run, metadata: { sources: imported.sourceMetadata } }, options.output ? one(options, 'output') : undefined);
  }
  throw new Error(`unknown command: ${command}`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
});
