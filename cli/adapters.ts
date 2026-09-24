import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Measurement, Run, Suite } from '../src/shared/types.ts';
import { validateRun } from '../src/shared/validation.ts';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Args = Pick<Run, 'id' | 'project' | 'commit' | 'branch' | 'kind' | 'machine' | 'config' | 'timestamp'>;
type ImportResult = { run: Run; sourceMetadata: Record<string, unknown>[] };

const readJson = async (file: string): Promise<any> => JSON.parse(await readFile(file, 'utf8'));
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const jsonClone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function validateArgs(args: Args): void {
  for (const key of ['id', 'project', 'commit', 'branch', 'machine', 'config', 'timestamp'] as const) {
    if (!args[key]?.trim()) throw new Error(`--${key} is required`);
  }
  if (!['nightly', 'candidate'].includes(args.kind)) throw new Error('--kind must be nightly or candidate');
  if (Number.isNaN(Date.parse(args.timestamp))) throw new Error('--timestamp must be an ISO date/time');
  if (args.config.length > 220) throw new Error('--config must be at most 220 characters');
}

function suiteForTir(id: string, metadata: Record<string, any>): Suite {
  if (metadata.scope === 'function' || metadata.workload?.scope === 'function' || metadata.scope === 'function-region' || metadata.workload?.scope === 'function-region') return 'criterion';
  const parts = id.split('/');
  if (parts.includes('compile')) return 'compile';
  if (parts.includes('run')) return 'runtime';
  throw new Error(`cannot infer suite from TIR case ${id}`);
}

function identityForTir(id: string, suite: Suite, namespace: string, isFunction: boolean): { compiler: string; benchmark: string } {
  const parts = id.split('/');
  if (parts.length < 2 || parts.some((part) => !part)) throw new Error(`invalid TIR benchmark id ${id}`);
  if (isFunction) {
    const prefix = `${namespace}/`;
    if (!id.startsWith(prefix)) throw new Error(`function case ${id} is outside namespace ${namespace}`);
    const namespaceParts = namespace.split('/');
    const packageName = namespaceParts[0]!;
    const compiler = packageName === 'fcc' ? 'fcc' : 'tir';
    return { compiler, benchmark: [...namespaceParts.slice(1), id.slice(prefix.length)].filter(Boolean).join('/') };
  }
  // The leading namespace identifies the measured compiler. Keep the remaining
  // workload path stable so compiler variants line up for ratios.
  const compiler = parts.shift()!;
  if (suite === 'compile' || suite === 'runtime') {
    const phase = parts.indexOf(suite === 'compile' ? 'compile' : 'run');
    if (phase >= 0) parts.splice(phase, 1);
  }
  return { compiler, benchmark: parts.join('/') };
}

function metricUnit(key: string): string | undefined {
  if (key === 'latency' || key === 'user_cpu_ns' || key === 'system_cpu_ns') return 'ns';
  if (key === 'peak_process_rss_bytes') return 'bytes';
  if (['Ir', 'Dr', 'Dw', 'I1mr', 'D1mr', 'D1mw', 'ILmr', 'DLmr', 'DLmw', 'Bc', 'Bcm'].includes(key)) return 'count';
  return undefined;
}

function assertUniqueMeasurements(measurements: Measurement[]): void {
  const keys = new Set<string>();
  for (const row of measurements) {
    const key = JSON.stringify([row.suite, row.benchmark, row.compiler, row.metric, row.unit]);
    if (keys.has(key)) throw new Error(`input reports contain duplicate measurement ${key}`);
    keys.add(key);
  }
}

function tirMeasurements(report: any, file: string): { measurements: Measurement[]; sourceMetadata: Record<string, unknown>; contract: Record<string, unknown> } {
  if (!object(report) || report.schema !== 3) throw new Error(`${file}: expected TIR results schema 3`);
  if (report.status !== 'complete') throw new Error(`${file}: TIR run status is ${String(report.status)}, expected complete`);
  if (typeof report.namespace !== 'string' || !report.namespace || !['native', 'cachegrind'].includes(report.engine) || !object(report.environment) || !object(report.provenance)) {
    throw new Error(`${file}: missing TIR namespace, engine, environment, or provenance`);
  }
  const environmentKeys = ['os', 'architecture', 'kernel', 'cpu_model', 'hostname', 'allowed_cpus', 'applied_cpus', 'subprocess_environment', 'build'];
  if (environmentKeys.some((key) => !(key in report.environment)) || !object(report.environment.build) || !Array.isArray(report.environment.allowed_cpus) || !Array.isArray(report.environment.applied_cpus) || !object(report.environment.subprocess_environment)) {
    throw new Error(`${file}: incomplete TIR environment metadata`);
  }
  if (!Array.isArray(report.cases) || report.cases.length === 0) throw new Error(`${file}: TIR report has no cases`);
  const measurements: Measurement[] = [];
  for (const record of report.cases) {
    if (!object(record) || typeof record.id !== 'string' || !record.id || typeof record.gate !== 'boolean' || !object(record.metadata) || !object(record.summary) || !Array.isArray(record.samples) || !record.samples.length) {
      throw new Error(`${file}: invalid or gate-invalid TIR case`);
    }
    const isFunction = record.metadata.scope === 'function' || record.metadata.scope === 'function-region' || record.metadata.workload?.scope === 'function' || record.metadata.workload?.scope === 'function-region';
    const suite = suiteForTir(record.id, record.metadata);
    const identity = identityForTir(record.id, suite, report.namespace, isFunction);
    const diagnosticSummary = Object.fromEntries(Object.entries(record.summary).filter(([metric]) => !metricUnit(metric)));
    const diagnosticSamples = record.samples.map((sample: Record<string, unknown>) => Object.fromEntries(Object.entries(sample).filter(([metric]) => !metricUnit(metric))));
    const metadata = { source: 'tir', namespace: report.namespace, engine: report.engine, workload: jsonClone(record.metadata), diagnostics: { summary: diagnosticSummary, samples: diagnosticSamples } };
    let count = 0;
    let gatedCount = 0;
    for (const [metric, summary] of Object.entries(record.summary)) {
      if (!finite(summary)) throw new Error(`${file}: invalid summary metric ${metric} in ${record.id}`);
      if (report.engine === 'cachegrind' && ['latency', 'user_cpu_ns', 'system_cpu_ns', 'peak_process_rss_bytes'].includes(metric)) throw new Error(`${file}: native metric ${metric} appears in Cachegrind case ${record.id}`);
      if (report.engine === 'native' && ['Ir', 'Dr', 'Dw', 'I1mr', 'D1mr', 'D1mw', 'ILmr', 'DLmr', 'DLmw', 'Bc', 'Bcm'].includes(metric)) throw new Error(`${file}: Cachegrind metric ${metric} appears in native case ${record.id}`);
      const unit = metricUnit(metric);
      if (!unit) continue; // higher-is-better throughput and harness diagnostics stay in provenance.
      const samples = record.samples.map((sample: any) => {
        if (!object(sample) || !finite(sample[metric])) throw new Error(`${file}: invalid sample ${metric} in ${record.id}`);
        return sample[metric] as number;
      });
      const gate = record.gate && ['latency', 'Ir', 'peak_process_rss_bytes'].includes(metric);
      measurements.push({ suite, ...identity, metric, unit, value: summary, samples, metadata: jsonClone(metadata), gate });
      count++;
      if (gate) gatedCount++;
    }
    if (count === 0) throw new Error(`${file}: case ${record.id} has no supported measurement metric`);
    if (record.gate && gatedCount === 0) throw new Error(`${file}: gated case ${record.id} has no supported gate metric`);
  }
  return {
    measurements,
    sourceMetadata: { source: 'tir', file, namespace: report.namespace, engine: report.engine, environment: report.environment, provenance: report.provenance },
    contract: {
      source: 'tir', namespace: report.namespace, engine: report.engine, build: report.environment.build,
      environment: environmentContract(report.environment, report.engine),
      workloads: report.cases.map((record: any) => ({ id: record.id, gate: record.gate, workload: workloadContract(record.metadata) })),
    },
  };
}

function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical);
  if (!object(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}
function stable(value: unknown): string { return JSON.stringify(canonical(value)); }
function configFor(base: string, inputs: Record<string, any>[]): string {
  const contracts = inputs.map((entry) => ({
    source: entry.source,
    namespace: entry.namespace,
    engine: entry.engine,
    build: entry.build,
    environment: entry.environment,
    workloads: entry.workloads,
  })).sort((a, b) => stable(a).localeCompare(stable(b)));
  const hash = createHash('sha256').update(JSON.stringify(contracts)).digest('hex').slice(0, 16);
  return `${base};source-contract=${hash}`;
}

function workloadContract(metadata: Record<string, any>): Record<string, any> {
  const contract = jsonClone(metadata);
  delete contract.provenance;
  if (object(contract.workload)) delete contract.workload.provenance;
  return contract;
}

function environmentContract(environment: Record<string, any>, engine: string): Record<string, any> {
  const contract = jsonClone(environment);
  if (engine === 'cachegrind') for (const key of ['hostname', 'cpu', 'allowed_cpus', 'applied_cpus']) delete contract[key];
  return contract;
}

export async function importTir(files: string[], args: Args): Promise<ImportResult> {
  validateArgs(args);
  if (!files.length) throw new Error('import-tir requires at least one --input');
  const measurements: Measurement[] = [];
  const sourceMetadata: Record<string, unknown>[] = [];
  const contracts: any[] = [];
  for (const input of files) {
    const file = (await stat(input)).isDirectory() ? path.join(input, 'results.json') : input;
    const report = await readJson(file);
    const imported = tirMeasurements(report, file);
    measurements.push(...imported.measurements);
    sourceMetadata.push(imported.sourceMetadata);
    contracts.push(imported.contract);
  }
  if (!measurements.length) throw new Error('TIR inputs contain no importable measurements');
  assertUniqueMeasurements(measurements);
  const run: Run = { ...args, timestamp: new Date(args.timestamp).toISOString(), config: configFor(args.config, contracts), measurements, metadata: { sources: sourceMetadata } };
  validateRun(run);
  return { run, sourceMetadata };
}

function criterionEstimate(estimate: any, file: string): { value: number; lower: number; upper: number } {
  if (!object(estimate) || !finite(estimate.point_estimate) || !object(estimate.confidence_interval) || !finite(estimate.confidence_interval.lower_bound) || !finite(estimate.confidence_interval.upper_bound)) {
    throw new Error(`${file}: malformed Criterion estimate`);
  }
  // Criterion's default WallTime measurement converts Duration to nanoseconds
  // before writing estimates.json.
  const bounds = { value: estimate.point_estimate, lower: estimate.confidence_interval.lower_bound, upper: estimate.confidence_interval.upper_bound };
  if (bounds.lower > bounds.value || bounds.value > bounds.upper) throw new Error(`${file}: Criterion confidence interval does not enclose its point estimate`);
  return bounds;
}

async function walk(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await walk(file));
    else if (entry.name === 'estimates.json' && path.basename(path.dirname(file)) === 'new') found.push(file);
  }
  return found;
}

function criterionIdentity(root: string, estimatesFile: string, benchmark: any): { benchmark: string; metadata: Record<string, unknown> } {
  const id = object(benchmark) ? benchmark : {};
  const serialized = [id.group_id, id.function_id, id.value_str].filter((part) => typeof part === 'string' && part.length).join('/');
  const relative = path.relative(root, path.dirname(path.dirname(estimatesFile)));
  const benchmarkId = serialized || relative.split(path.sep).slice(0, -1).join('/');
  if (!benchmarkId) throw new Error(`${estimatesFile}: benchmark.json does not identify a benchmark`);
  return { benchmark: benchmarkId, metadata: { source: 'criterion', benchmark: id, reportPath: relative } };
}

export async function importCriterion(roots: string[], args: Args, compiler = 'criterion'): Promise<ImportResult> {
  validateArgs(args);
  if (!roots.length) throw new Error('import-criterion requires at least one --input');
  const measurements: Measurement[] = [];
  const sourceMetadata: Record<string, unknown>[] = [];
  for (const root of roots) {
    const files = await walk(root);
    if (!files.length) throw new Error(`${root}: no Criterion new/estimates.json reports found`);
    for (const estimatesFile of files) {
      const directory = path.dirname(estimatesFile);
      const [estimates, benchmark] = await Promise.all([readJson(estimatesFile), readJson(path.join(directory, 'benchmark.json'))]);
      const identity = criterionIdentity(root, estimatesFile, benchmark);
      const estimate = criterionEstimate(estimates.mean, estimatesFile);
      let samples: number[] | undefined;
      try {
        const raw = await readJson(path.join(directory, 'sample.json'));
        if (Array.isArray(raw.iters) && Array.isArray(raw.times) && raw.iters.length === raw.times.length) {
          samples = raw.times.map((time: unknown, index: number) => {
            if (!finite(time) || !finite(raw.iters[index]) || raw.iters[index] === 0) throw new Error(`${estimatesFile}: malformed Criterion sample`);
            return time / raw.iters[index];
          });
        }
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
      measurements.push({ suite: 'criterion', benchmark: identity.benchmark, compiler, metric: 'latency', unit: 'ns', ...estimate, ...(samples ? { samples } : {}), metadata: { ...jsonClone(identity.metadata), diagnostics: { estimates: jsonClone(estimates) } }, gate: true });
      sourceMetadata.push({ source: 'criterion', estimatesFile, benchmark: jsonClone(benchmark ?? null) });
    }
  }
  const contracts = roots.map((root) => ({
    source: 'criterion', namespace: 'criterion', engine: 'criterion-wall-time-ns', build: null, environment: null,
    workloads: sourceMetadata.filter((item) => {
      const relative = path.relative(root, String(item.estimatesFile));
      return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    }).map((item) => item.benchmark),
  }));
  assertUniqueMeasurements(measurements);
  const run: Run = { ...args, timestamp: new Date(args.timestamp).toISOString(), config: configFor(args.config, contracts), measurements, metadata: { sources: sourceMetadata } };
  validateRun(run);
  return { run, sourceMetadata };
}

export type { Args, ImportResult };
