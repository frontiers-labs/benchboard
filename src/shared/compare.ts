import type { Comparison, ComparisonRow, Measurement, Run } from './types';
import { measurementKey } from './validation';

export function compareRuns(baseline: Run | null, candidate: Run, thresholdPercent = 5): Comparison {
  const result: Comparison = { status: 'incomparable', baselineId: baseline?.id ?? null, candidateId: candidate.id, thresholdPercent, rows: [] };
  if (!Number.isFinite(thresholdPercent) || thresholdPercent < 0 || thresholdPercent > 100) {
    return { ...result, reason: 'Invalid threshold' };
  }
  if (!baseline) return { ...result, reason: 'No matching nightly baseline' };
  if (baseline.project !== candidate.project || baseline.machine !== candidate.machine || baseline.config !== candidate.config) {
    return { ...result, reason: 'Project, machine, or config differs' };
  }

  const previous = new Map(baseline.measurements.map(row => [measurementKey(row), row]));
  const current = new Map(candidate.measurements.map(row => [measurementKey(row), row]));
  let gated = 0;
  let failed = false;
  let incomparable = false;
  const rows: ComparisonRow[] = [];
  for (const row of baseline.measurements) {
    const key = measurementKey(row);
    const next = current.get(key);
    if (row.gate !== false) gated++;
    let status: ComparisonRow['status'] = 'missing';
    let changePercent: number | null = null;
    if (row.gate !== false && (!Number.isFinite(row.value) || row.value <= 0 || next && (!Number.isFinite(next.value) || next.value < 0))) incomparable = true;
    if (next && row.value > 0 && Number.isFinite(row.value) && Number.isFinite(next.value) && next.value >= 0) {
      changePercent = (next.value / row.value - 1) * 100;
      status = next.value > row.value * (1 + thresholdPercent / 100) ? 'regressed' : next.value < row.value ? 'improved' : 'unchanged';
    } else if (next && row.value === 0) {
      status = 'unchanged';
    }
    if (row.gate !== false && (status === 'missing' || status === 'regressed')) failed = true;
    rows.push(toRow(row, key, row.value, next?.value ?? null, changePercent, status));
  }
  for (const row of candidate.measurements) {
    const key = measurementKey(row);
    if (previous.has(key)) continue;
    rows.push(toRow(row, key, null, row.value, null, 'new'));
  }
  if (incomparable) return { ...result, rows, reason: 'Invalid or zero gated baseline value' };
  if (gated === 0) return { ...result, rows, reason: 'Baseline has no gated measurements' };
  return { ...result, rows, status: failed ? 'fail' : 'pass' };
}

function toRow(row: Measurement, key: string, baseline: number | null, candidate: number | null, changePercent: number | null, status: ComparisonRow['status']): ComparisonRow {
  return { key, suite: row.suite, benchmark: row.benchmark, compiler: row.compiler, metric: row.metric, unit: row.unit, baseline, candidate, changePercent, status };
}
