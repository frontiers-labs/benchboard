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

/** One point per run that reported the metric. `index` is the position in `runs`. */
export function series(runs, id, metric) {
  const points = [];
  runs.forEach((run, index) => {
    const value = run.results[id]?.[metric]?.value;
    if (Number.isFinite(value)) points.push({ index, value });
  });
  return points;
}
