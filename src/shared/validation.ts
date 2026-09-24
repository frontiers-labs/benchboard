import type { Measurement, Run } from './types';

export const MAX_BODY_BYTES = 1_000_000;
export const MAX_MEASUREMENTS = 10_000;
const MAX_SAMPLES = 1_000;
const MAX_TEXT = 256;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export class ValidationError extends Error {
  constructor(message: string) { super(message); this.name = 'ValidationError'; }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string, max = MAX_TEXT): string {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0 || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ValidationError(`${label} must be a nonempty string of at most ${max} characters`);
  }
  return value;
}

function nonnegative(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new ValidationError(`${label} must be a finite nonnegative number`);
  return value;
}

export function measurementKey(measurement: Pick<Measurement, 'suite' | 'benchmark' | 'compiler' | 'metric' | 'unit'>): string {
  return JSON.stringify([measurement.suite, measurement.benchmark, measurement.compiler, measurement.metric, measurement.unit]);
}

export function normalizedTimestamp(value: unknown): string {
  const timestamp = string(value, 'timestamp', 40);
  const parsed = Date.parse(timestamp);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(timestamp) || Number.isNaN(parsed) || !timestamp.startsWith(new Date(parsed).toISOString().slice(0, 19))) throw new ValidationError('timestamp must be a valid UTC ISO date');
  return new Date(parsed).toISOString();
}

export function validateRun(input: unknown): Run {
  const run = record(input, 'run');
  const id = string(run.id, 'id', 128);
  if (!idPattern.test(id)) throw new ValidationError('id has invalid characters');
  for (const field of ['project', 'commit', 'branch', 'machine', 'config'] as const) string(run[field], field);
  if (run.kind !== 'nightly' && run.kind !== 'candidate') throw new ValidationError('kind must be nightly or candidate');
  normalizedTimestamp(run.timestamp);
  validateMetadata(run.metadata, 'metadata');
  if (!Array.isArray(run.measurements) || run.measurements.length === 0 || run.measurements.length > MAX_MEASUREMENTS) {
    throw new ValidationError(`measurements must contain 1 to ${MAX_MEASUREMENTS} rows`);
  }
  const keys = new Set<string>();
  for (const [index, raw] of run.measurements.entries()) {
    const row = record(raw, `measurements[${index}]`);
    if (row.suite !== 'compile' && row.suite !== 'runtime' && row.suite !== 'criterion') throw new ValidationError(`measurements[${index}].suite is invalid`);
    for (const field of ['benchmark', 'compiler', 'metric', 'unit'] as const) string(row[field], `measurements[${index}].${field}`);
    nonnegative(row.value, `measurements[${index}].value`);
    validateMetadata(row.metadata, `measurements[${index}].metadata`);
    if (row.gate !== undefined && typeof row.gate !== 'boolean') throw new ValidationError(`measurements[${index}].gate must be boolean`);
    if (row.samples !== undefined) {
      if (!Array.isArray(row.samples) || row.samples.length === 0 || row.samples.length > MAX_SAMPLES) throw new ValidationError(`measurements[${index}].samples is invalid`);
      row.samples.forEach((sample, sampleIndex) => nonnegative(sample, `measurements[${index}].samples[${sampleIndex}]`));
    }
    if (row.lower !== undefined) nonnegative(row.lower, `measurements[${index}].lower`);
    if (row.upper !== undefined) nonnegative(row.upper, `measurements[${index}].upper`);
    if (typeof row.lower === 'number' && typeof row.upper === 'number' && row.lower > row.upper) throw new ValidationError(`measurements[${index}] bounds are reversed`);
    if (typeof row.lower === 'number' && (row.value as number) < row.lower || typeof row.upper === 'number' && (row.value as number) > row.upper) throw new ValidationError(`measurements[${index}].value is outside bounds`);
    const key = measurementKey(row as unknown as Measurement);
    if (keys.has(key)) throw new ValidationError(`duplicate measurement key at row ${index}`);
    keys.add(key);
  }
  return run as unknown as Run;
}

function validateMetadata(value: unknown, label: string): void {
  if (value === undefined) return;
  record(value, label);
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const seen = new Set<object>();
  let nodes = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (++nodes > 20_000 || item.depth > 16) throw new ValidationError(`${label} exceeds metadata bounds`);
    if (item.value === null || typeof item.value === 'string' || typeof item.value === 'boolean') continue;
    if (typeof item.value === 'number' && Number.isFinite(item.value)) continue;
    if (typeof item.value !== 'object') throw new ValidationError(`${label} must contain JSON values`);
    if (seen.has(item.value)) throw new ValidationError(`${label} must not contain cycles or shared objects`);
    seen.add(item.value);
    if (Array.isArray(item.value)) {
      for (const child of item.value) pending.push({ value: child, depth: item.depth + 1 });
    } else {
      const prototype = Object.getPrototypeOf(item.value);
      if (prototype !== Object.prototype && prototype !== null) throw new ValidationError(`${label} must contain JSON objects`);
      for (const [key, child] of Object.entries(item.value)) {
        if (key.length > MAX_TEXT) throw new ValidationError(`${label} key exceeds ${MAX_TEXT} characters`);
        pending.push({ value: child, depth: item.depth + 1 });
      }
    }
  }
}

export function parseThreshold(raw: string | null): number {
  if (raw === null) return 5;
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(raw)) throw new ValidationError('threshold must be a number from 0 to 100');
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 100) throw new ValidationError('threshold must be a number from 0 to 100');
  return value;
}
