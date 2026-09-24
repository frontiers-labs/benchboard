import type { Run } from '../shared/types';
import { compareRuns } from '../shared/compare';
import { MAX_BODY_BYTES, normalizedTimestamp, parseThreshold, validateRun, ValidationError } from '../shared/validation';

interface Env { DB: D1Database; SUBMIT_TOKEN?: string; CANDIDATE_TOKEN?: string }
interface StoredRun { body: string }
interface ListedRun extends StoredRun { id: string; timestamp: string }

const jsonHeaders = { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'GET, POST, OPTIONS' };
function response(data: unknown, status = 200): Response { return new Response(JSON.stringify(data), { status, headers: jsonHeaders }); }
function error(message: string, status: number): Response { return response({ error: message }, status); }

async function readRun(request: Request): Promise<Run> {
  const length = request.headers.get('content-length');
  if (length && Number(length) > MAX_BODY_BYTES) throw new ValidationError('body exceeds size limit');
  const reader = request.body?.getReader();
  if (!reader) throw new ValidationError('JSON body required');
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) { await reader.cancel(); throw new ValidationError('body exceeds size limit'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new ValidationError('body must be valid UTF-8 JSON'); }
  return validateRun(parsed);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}

function tokenEquals(received: string, expected: string | undefined): boolean {
  if (!expected) return false;
  const a = new TextEncoder().encode(received);
  const b = new TextEncoder().encode(expected);
  let difference = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) difference |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return difference === 0;
}

function queryText(url: URL, key: string, fallback?: string): string | undefined {
  const value = url.searchParams.get(key) ?? fallback;
  if (value === undefined) return undefined;
  if (!value || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) throw new ValidationError(`invalid ${key}`);
  return value;
}

async function getRun(db: D1Database, id: string): Promise<Run | null> {
  const row = await db.prepare('SELECT body FROM runs WHERE id = ?').bind(id).first<StoredRun>();
  return row ? JSON.parse(row.body) as Run : null;
}

async function latestBaseline(db: D1Database, project: string, branch: string, machine: string, config: string): Promise<Run | null> {
  const row = await db.prepare("SELECT body FROM runs WHERE project = ? AND branch = ? AND machine = ? AND config = ? AND kind = 'nightly' ORDER BY timestamp DESC, id DESC LIMIT 1")
    .bind(project, branch, machine, config).first<StoredRun>();
  return row ? JSON.parse(row.body) as Run : null;
}

async function handle(request: Request, env: Env): Promise<Response> {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: jsonHeaders });
  const url = new URL(request.url);
  if (url.pathname === '/api/runs' && request.method === 'GET') {
    const project = queryText(url, 'project', 'tir')!;
    const rawLimit = url.searchParams.get('limit') ?? '100';
    if (!/^[1-9]\d*$/.test(rawLimit) || Number(rawLimit) > 100) throw new ValidationError('limit must be from 1 to 100');
    const before = url.searchParams.get('before');
    const beforeId = url.searchParams.get('beforeId');
    if ((before === null) !== (beforeId === null)) throw new ValidationError('before and beforeId must be provided together');
    const conditions = ['project = ?'];
    const values: string[] = [project];
    for (const key of ['branch', 'kind', 'machine', 'config', 'commit'] as const) {
      const value = queryText(url, key);
      if (value !== undefined) { conditions.push(`${key === 'commit' ? 'commit_hash' : key} = ?`); values.push(value); }
    }
    if (before !== null && beforeId !== null) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(beforeId)) throw new ValidationError('invalid beforeId');
      conditions.push('(timestamp < ? OR (timestamp = ? AND id < ?))');
      const cursorTime = normalizedTimestamp(before);
      values.push(cursorTime, cursorTime, beforeId);
    }
    const limit = Number(rawLimit);
    const rows = await env.DB.prepare(`SELECT id, timestamp, body FROM runs WHERE ${conditions.join(' AND ')} ORDER BY timestamp DESC, id DESC LIMIT ?`)
      .bind(...values, limit + 1).all<ListedRun>();
    const page = rows.results.slice(0, limit);
    const last = page.at(-1);
    return response({ runs: page.map(row => JSON.parse(row.body) as Run), nextCursor: rows.results.length > limit && last ? { before: last.timestamp, beforeId: last.id } : null });
  }
  if (url.pathname.startsWith('/api/runs/') && request.method === 'GET') {
    let id: string;
    try { id = decodeURIComponent(url.pathname.slice('/api/runs/'.length)); }
    catch { throw new ValidationError('invalid id'); }
    if (!id || id.includes('/')) throw new ValidationError('invalid id');
    const run = await getRun(env.DB, id);
    return run ? response(run) : error('run not found', 404);
  }
  if (url.pathname === '/api/baseline' && request.method === 'GET') {
    const project = queryText(url, 'project', 'tir')!;
    const branch = queryText(url, 'branch', 'master')!;
    const machine = queryText(url, 'machine');
    const config = queryText(url, 'config');
    if (!machine || !config) throw new ValidationError('machine and config are required');
    const baseline = await latestBaseline(env.DB, project, branch, machine, config);
    return baseline ? response(baseline) : error('baseline not found', 404);
  }
  if (url.pathname === '/api/compare' && request.method === 'GET') {
    const baselineId = queryText(url, 'baseline');
    const candidateId = queryText(url, 'candidate');
    if (!baselineId || !candidateId) throw new ValidationError('baseline and candidate are required');
    const threshold = parseThreshold(url.searchParams.get('threshold'));
    const [baseline, candidate] = await Promise.all([getRun(env.DB, baselineId), getRun(env.DB, candidateId)]);
    if (!baseline || !candidate) return error('run not found', 404);
    return response(compareRuns(baseline, candidate, threshold));
  }
  if (url.pathname === '/api/check' && request.method === 'POST') {
    const threshold = parseThreshold(url.searchParams.get('threshold'));
    const branch = queryText(url, 'branch', 'master')!;
    const candidate = await readRun(request);
    const baseline = await latestBaseline(env.DB, candidate.project, branch, candidate.machine, candidate.config);
    return response(compareRuns(baseline, candidate, threshold));
  }
  if (url.pathname === '/api/runs' && request.method === 'POST') {
    const bearer = /^Bearer (\S+)$/.exec(request.headers.get('authorization') ?? '')?.[1] ?? '';
    const nightlyToken = tokenEquals(bearer, env.SUBMIT_TOKEN);
    const candidateToken = tokenEquals(bearer, env.CANDIDATE_TOKEN ?? env.SUBMIT_TOKEN);
    if (!nightlyToken && !candidateToken) return error('unauthorized', 401);
    const run = await readRun(request);
    if (!(run.kind === 'nightly' ? nightlyToken : candidateToken)) return error('unauthorized', 401);
    const body = canonical(run);
    const inserted = await env.DB.prepare('INSERT INTO runs (id, project, branch, kind, timestamp, machine, config, commit_hash, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING')
      .bind(run.id, run.project, run.branch, run.kind, normalizedTimestamp(run.timestamp), run.machine, run.config, run.commit, body).run();
    if (inserted.meta.changes === 1) return response({ id: run.id, duplicate: false }, 201);
    const existing = await env.DB.prepare('SELECT body FROM runs WHERE id = ?').bind(run.id).first<StoredRun>();
    if (existing?.body === body) return response({ id: run.id, duplicate: true });
    return error('run id conflicts with existing content', 409);
  }
  return error('not found', 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try { return await handle(request, env); }
    catch (cause) {
      if (cause instanceof ValidationError) return error(cause.message, 400);
      console.error('benchboard API error', cause);
      return error('internal server error', 500);
    }
  },
};
