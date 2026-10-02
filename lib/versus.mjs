// Metric definitions and variant comparisons that a run file carries about itself.

/** Definitions by metric key, in declared order. A later run's definition wins; an undeclared metric is labelled by its key. */
export function metricIndex(runs) {
  const index = new Map();
  for (const run of runs) for (const metric of run.metrics ?? []) index.set(metric.key, metric);
  for (const run of runs) {
    for (const measures of Object.values(run.results)) {
      for (const key of Object.keys(measures)) if (!index.has(key)) index.set(key, { key, label: key });
    }
  }
  return index;
}

/**
 * Benchmarks that several variants measured, by group. `tags` maps a result id
 * to `{ benchmark, group, variant, subject }`. The subject is the variant the
 * others are references for; it leads `variants`, and the rest follow by name.
 */
export function versusGroups(tags) {
  const groups = new Map();
  for (const [id, tag] of Object.entries(tags)) {
    if (!groups.has(tag.group)) groups.set(tag.group, { name: tag.group, subject: null, variants: new Set(), benchmarks: new Map() });
    const group = groups.get(tag.group);
    if (tag.subject) group.subject = tag.variant;
    group.variants.add(tag.variant);
    if (!group.benchmarks.has(tag.benchmark)) group.benchmarks.set(tag.benchmark, {});
    group.benchmarks.get(tag.benchmark)[tag.variant] = id;
  }
  return [...groups.values()].map(group => {
    const names = [...group.variants].sort();
    const subject = group.subject ?? names[0];
    return {
      name: group.name,
      subject,
      variants: [subject, ...names.filter(name => name !== subject)],
      benchmarks: [...group.benchmarks].sort(([x], [y]) => x.localeCompare(y)).map(([name, ids]) => ({ name, ids })),
    };
  });
}

/** Subject value divided by reference value, or null when either is missing or the reference is 0. */
export function ratio(run, benchmark, subject, reference, metric) {
  const s = run.results[benchmark.ids[subject]]?.[metric]?.value;
  const r = run.results[benchmark.ids[reference]]?.[metric]?.value;
  return Number.isFinite(s) && Number.isFinite(r) && r !== 0 ? s / r : null;
}

/** Geometric mean of the subject-to-reference ratio over the group's benchmarks that report both. */
export function meanRatio(run, group, reference, metric) {
  const logs = group.benchmarks.map(benchmark => ratio(run, benchmark, group.subject, reference, metric)).filter(value => value > 0).map(Math.log);
  return logs.length ? { value: Math.exp(logs.reduce((sum, log) => sum + log, 0) / logs.length), count: logs.length } : null;
}
