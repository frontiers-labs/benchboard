import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { importCriterion, importTir } from '../cli/adapters.ts';
import { validateRun } from '../src/shared/validation.ts';

const root = path.resolve('examples/fixtures');
const args = {
  id: 'candidate-001', project: 'tir', commit: '0123456789abcdef', branch: 'feature/benchboard',
  kind: 'candidate' as const, machine: 'linux-x86-runner', config: 'x86_64-bench-v1', timestamp: '2026-09-24T10:00:00Z',
};

test('imports TIR schema 3, normalizes compiler IDs, and retains samples/provenance/gate', async () => {
  const { run } = await importTir([path.join(root, 'tir-results.json'), path.join(root, 'tir-functions-results.json')], args);
  assert.doesNotThrow(() => validateRun({ ...run, metadata: { sources: [{ source: 'tir' }] } }));
  assert.match(run.config, /source-contract=/);
  assert.equal(run.measurements.length, 9);
  const compile = run.measurements.find((item) => item.suite === 'compile' && item.metric === 'latency')!;
  assert.equal(compile.compiler, 'fcc');
  assert.equal(compile.benchmark, 'dhrystone/source/O2/dhry_1');
  assert.deepEqual(compile.samples, [1000000, 980000]);
  assert.equal(compile.metadata?.source, 'tir');
  assert.deepEqual((compile.metadata?.workload as any).workload.reference_compiler_version, 'gcc 14.2');
  assert.equal(compile.gate, true);
  const diagnostic = run.measurements.find((item) => item.metric === 'user_cpu_ns')!;
  assert.equal(diagnostic.gate, false);
  assert.deepEqual((diagnostic.metadata?.diagnostics as any).summary, { latency_mad_ns: 10000 });
  const functionCase = run.measurements.find((item) => item.suite === 'criterion')!;
  assert.equal(functionCase.compiler, 'fcc');
  assert.equal(functionCase.benchmark, 'codegen/codegen/ast_to_ir');
  assert.equal(functionCase.gate, false);
  assert.equal((run.metadata?.sources as any[]).length, 2);
});

test('rejects incomplete, empty, or structurally invalid TIR reports', async () => {
  const fixture = path.join(root, 'tir-results.json');
  const original = JSON.parse(await readFile(fixture, 'utf8'));
  const temp = await mkdtemp(path.join(os.tmpdir(), 'benchboard-tir-'));
  const file = path.join(temp, 'results.json');
  try {
    for (const report of [
      { ...original, status: 'incomplete' },
      { ...original, cases: [] },
      { ...original, cases: [{ ...original.cases[0], gate: undefined }] },
      { ...original, cases: [{ ...original.cases[0], samples: [{ user_cpu_ns: 900 }], summary: { user_cpu_ns: 900 }, gate: true }] },
    ]) {
      await writeFile(file, JSON.stringify(report));
      await assert.rejects(importTir([file], args));
    }
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('configuration fingerprints workload and environment contracts but ignores TIR revision provenance', async () => {
  const source = path.join(root, 'tir-results.json');
  const original = JSON.parse(await readFile(source, 'utf8'));
  const temp = await mkdtemp(path.join(os.tmpdir(), 'benchboard-contract-'));
  const changed = path.join(temp, 'results.json');
  try {
    const baseline = await importTir([source], args);
    const provenanceOnly = structuredClone(original);
    provenanceOnly.provenance.revision = 'fedcba9876543210';
    provenanceOnly.cases[0].metadata.workload.provenance.compiler_hash = 'changed-binary-hash';
    await writeFile(changed, JSON.stringify(provenanceOnly));
    const candidate = await importTir([changed], args);
    assert.equal(candidate.run.config, baseline.run.config);
    assert.equal((candidate.run.measurements[0]!.metadata!.workload as any).workload.provenance.compiler_hash, 'changed-binary-hash');

    const changedWorkload = structuredClone(original);
    changedWorkload.cases[0].metadata.workload.flags = ['-O3'];
    await writeFile(changed, JSON.stringify(changedWorkload));
    const incompatible = await importTir([changed], args);
    assert.notEqual(incompatible.run.config, baseline.run.config);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('imports Criterion new estimates recursively with nanosecond CI and per-iteration samples', async () => {
  const { run } = await importCriterion([path.join(root, 'criterion')], args, 'tir');
  assert.doesNotThrow(() => validateRun({ ...run, metadata: { sources: [{ source: 'criterion' }] } }));
  assert.equal(run.measurements.length, 1);
  const item = run.measurements[0]!;
  assert.equal(item.suite, 'criterion');
  assert.equal(item.compiler, 'tir');
  assert.equal(item.benchmark, 'sort/quick/10');
  assert.equal(item.metric, 'latency');
  assert.equal(item.unit, 'ns');
  assert.equal(item.value, 2000);
  assert.equal(item.lower, 1800);
  assert.equal(item.upper, 2200);
  assert.deepEqual(item.samples, [2100, 2000, 2050]);
});
