// Run selection and series shaping for the viewer.

/** Latest run whose commit starts with `ref`, or whose file equals it. */
export function resolveRun(runs, ref) {
  if (!ref) return -1;
  return runs.findLastIndex(run => run.file === ref || run.commit.startsWith(ref));
}

/** Benchmark ids grouped by their first two path segments, in sorted order. */
export function groupIds(ids) {
  const groups = new Map();
  for (const id of [...ids].sort()) {
    const parts = id.split('/');
    const group = parts.length > 2 ? parts.slice(0, 2).join('/') : parts[0];
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(id);
  }
  return groups;
}

/**
 * One series per machine the benchmark ran on, with one point per run that
 * reported the metric. `index` is the position in `runs`. Results from files
 * without an environment form the series with the empty name.
 */
export function series(runs, id, metric) {
  const lines = new Map();
  runs.forEach((run, index) => {
    const measure = run.results[id]?.[metric];
    if (!Number.isFinite(measure?.value)) return;
    const environment = run.environments?.[id] ?? '';
    if (!lines.has(environment)) lines.set(environment, []);
    lines.get(environment).push({ index, value: measure.value, modality: measure.modality });
  });
  return [...lines].map(([environment, points]) => ({ environment, points }));
}
