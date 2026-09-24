import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import type { Run } from '../src/shared/types';

const folder = await mkdtemp(join(tmpdir(), 'benchboard-integration-'));
const bundled = await build({ entryPoints: ['src/worker/index.ts'], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022' });
const options = convertV4MiniflareOptions({ workers: [{ name: 'api', modules: true, script: bundled.outputFiles[0].text, compatibilityDate: '2026-09-01', d1Databases: ['DB'], bindings: { SUBMIT_TOKEN: 'integration-nightly-token', CANDIDATE_TOKEN: 'integration-candidate-token' } }], resourcePersistencePath: folder, port: 0 });
let mf = new Miniflare(options);
try {
  const db = await mf.getD1Database('DB');
  for (const sql of (await readFile('migrations/0001_runs.sql', 'utf8')).split(';').filter(x => x.trim())) await db.prepare(sql).run();
  const origin = (await mf.ready).origin;
  async function request(path: string, body?: unknown, token?: string) {
    return fetch(`${origin}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  }
  const nightly: Run = { id: 'nightly-1', project: 'tir', commit: 'a'.repeat(40), branch: 'master', kind: 'nightly', timestamp: '2026-09-22T00:00:00Z', machine: 'runner-1', config: 'native-v1', measurements: [
    { suite: 'compile', benchmark: 'coremark', compiler: 'fcc', metric: 'latency', unit: 'ns', value: 100, samples: [99,100,101] },
    { suite: 'runtime', benchmark: 'coremark', compiler: 'fcc', metric: 'latency', unit: 'ns', value: 200 },
    { suite: 'criterion', benchmark: 'dense_search/16', compiler: 'tir', metric: 'latency', unit: 'ns', value: 300 },
    { suite: 'runtime', benchmark: 'coremark', compiler: 'gcc', metric: 'latency', unit: 'ns', value: 150, gate: false },
  ] };
  assert.equal((await request('/api/runs', nightly)).status, 401);
  assert.equal((await request('/api/runs', nightly, 'integration-candidate-token')).status, 401);
  assert.equal((await request('/api/runs', nightly, 'integration-nightly-token')).status, 201);
  assert.equal((await (await request('/api/runs', nightly, 'integration-nightly-token')).json() as any).duplicate, true);
  assert.equal((await request('/api/runs', {...nightly, commit: 'b'.repeat(40)}, 'integration-nightly-token')).status, 409);
  const newer = {...nightly, id:'nightly-2', timestamp:'2026-09-23T00:00:00Z'};
  assert.equal((await request('/api/runs',newer,'integration-nightly-token')).status,201);
  const alien = {...nightly,id:'other-machine',machine:'runner-2',timestamp:'2026-09-24T00:00:00Z'};
  assert.equal((await request('/api/runs',alien,'integration-nightly-token')).status,201);
  const candidate: Run = {...structuredClone(nightly),id:'candidate-1',kind:'candidate',timestamp:'2026-09-24T01:00:00Z'};
  let comparison = await (await request('/api/check', candidate)).json() as any;
  assert.equal(comparison.status,'pass'); assert.equal(comparison.baselineId,'nightly-2');
  assert.equal((await request('/api/runs/candidate-1')).status,404,'public check must not write');
  candidate.measurements[0].value=110;
  comparison=await (await request('/api/check',candidate)).json() as any;
  assert.equal(comparison.status,'fail');
  assert.equal((await (await request('/api/check',{...candidate,config:'different'})).json() as any).status,'incomparable');
  assert.equal((await (await request('/api/check',{...candidate,measurements:candidate.measurements.slice(1)})).json() as any).status,'fail');
  assert.equal((await request('/api/check?threshold=-1',candidate)).status,400);
  assert.equal((await request('/api/runs',{...nightly,id:'empty',measurements:[]},'integration-nightly-token')).status,400);
  assert.equal((await request('/api/runs',candidate,'integration-candidate-token')).status,201);
  assert.equal((await request('/api/compare?baseline=nightly-2&candidate=candidate-1')).status,200);
  assert.equal((await (await request('/api/runs?project=tir&limit=1')).json() as any).runs.length,1);
  const file = join(folder,'candidate.json');
  function cli(args: string[]) {
    // Run asynchronously so the parent can serve Miniflare's HTTP requests.
    return new Promise<number | null>((resolve, reject) => {
      const child=spawn(process.execPath,['--import','tsx','cli/main.ts',...args],{env:{...process.env,BENCHBOARD_URL:origin,BENCHBOARD_TOKEN:'integration-nightly-token'},stdio:['ignore','pipe','pipe']});
      let errors=''; child.stderr.on('data',x=>errors+=x); child.stdout.resume();
      child.on('error',reject);
      child.on('exit',code=>{if(errors) console.error(errors);resolve(code);});
    });
  }
  await writeFile(file,JSON.stringify(candidate)); assert.equal(await cli(['check','--run',file,'--branch','master']),1);
  candidate.measurements[0].value=100;
  await writeFile(file,JSON.stringify(candidate)); assert.equal(await cli(['check','--run',file,'--branch','master']),0);
  candidate.config='missing'; await writeFile(file,JSON.stringify(candidate)); assert.equal(await cli(['check','--run',file,'--branch','master']),2);
  const importFile = join(folder,'imported.json');
  const flags=['--id','imported-nightly','--project','tir','--commit','c'.repeat(40),'--branch','master','--kind','nightly','--machine','fixture-runner','--config','fixtures','--timestamp','2026-09-24T02:00:00Z','--output',importFile];
  assert.equal(await cli(['import-tir','--input','examples/fixtures/tir-results.json',...flags]),0);
  assert.equal(await cli(['submit','--run',importFile]),0);
  assert.equal(await cli(['check','--run',importFile]),0);
  assert.equal(await cli(['import-criterion','--compiler','tir','--input','examples/fixtures/criterion',...flags.map(x=>x==='imported-nightly'?'criterion-nightly':x)]),0);
  assert.equal(await cli(['submit','--run',importFile]),0);
  assert.equal(await cli(['check','--run',importFile]),0);
  const page = await (await request('/api/runs?limit=1')).json() as any;
  assert.ok(page.nextCursor);
  const older = await (await request(`/api/runs?limit=1&${new URLSearchParams(page.nextCursor)}`)).json() as any;
  assert.notEqual(page.runs[0].id,older.runs[0].id);
  await mf.dispose();
  mf = new Miniflare(options);
  const reopened = await mf.dispatchFetch('http://localhost/api/runs/nightly-1');
  assert.equal(reopened.status,200);
  assert.equal((await reopened.json() as Run).measurements.length,4);
  console.log('PASS: real Worker/D1 authentication, atomic immutable submissions, nightly selection, public checks, coverage, comparisons, import-to-submit CLI pipelines and restart persistence');
} finally { await mf.dispose(); await rm(folder,{recursive:true,force:true}); }
