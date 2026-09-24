import type { Measurement, Run } from '../shared/types';
import { measurementKey } from '../shared/validation';

export function compatibleBaseline(selected: Run, baseline: Run): boolean {
  return baseline.kind === 'nightly' && baseline.timestamp < selected.timestamp
    && baseline.project === selected.project && baseline.machine === selected.machine && baseline.config === selected.config
    && baseline.branch === (selected.kind === 'candidate' ? 'master' : selected.branch);
}

export function priorNightly(runs: Run[], selected: Run): Run | undefined {
  return runs.filter(run => compatibleBaseline(selected, run))
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp) || b.id.localeCompare(a.id))[0];
}

export function trendHistory(runs: Run[], selected: Run, measurement: Measurement): { run: Run; measurement: Measurement }[] {
  return runs.filter(run => run.id === selected.id || compatibleBaseline(selected, run))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id))
    .flatMap(run => {
      const match = run.measurements.find(row => measurementKey(row) === measurementKey(measurement));
      return match ? [{ run, measurement: match }] : [];
    });
}

export function priorValue(runs: Run[], selected: Run, measurement: Measurement): number | null {
  const prior = priorNightly(runs, selected);
  return prior?.measurements.find(row => measurementKey(row) === measurementKey(measurement))?.value ?? null;
}
