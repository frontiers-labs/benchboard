// Shared by the CI recorder and the viewer, so both agree on what regressed.

/**
 * Compare two runs. `threshold` is a fraction (0.02 for 2%). Every metric gets a
 * status, but only metrics named in `gateMetrics` can mark the run regressed.
 * New and missing rows are reported and never fail the run.
 */
export function compare(base, head, { gateMetrics = [], threshold = 0.02 } = {}) {
  const gates = new Set(gateMetrics);
  const rows = [];
  for (const id of new Set([...Object.keys(base.results), ...Object.keys(head.results)])) {
    const before = base.results[id] ?? {};
    const after = head.results[id] ?? {};
    for (const metric of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const b = before[metric]?.value ?? null;
      const h = after[metric]?.value ?? null;
      let delta = null;
      let status = h === null ? 'missing' : 'new';
      if (b !== null && h !== null) {
        delta = b === 0 ? (h === 0 ? 0 : Infinity) : h / b - 1;
        status = delta > threshold ? 'regressed' : delta < -threshold ? 'improved' : 'unchanged';
      }
      rows.push({ id, metric, base: b, head: h, delta, status, gated: gates.has(metric) });
    }
  }
  rows.sort((x, y) => Math.abs(y.delta ?? 0) - Math.abs(x.delta ?? 0) || x.id.localeCompare(y.id) || x.metric.localeCompare(y.metric));
  // A new compiler or Valgrind shifts counts without any change in the project.
  const envChanged = (base.env_key ?? '') !== (head.env_key ?? '');
  const regressed = !envChanged && rows.some(row => row.gated && row.status === 'regressed');
  return { rows, envChanged, regressed };
}

export function formatValue(value) {
  if (value === null || value === undefined) return 'n/a';
  if (!Number.isFinite(value)) return String(value);
  const abs = Math.abs(value);
  for (const [limit, suffix] of [[1e12, 'T'], [1e9, 'G'], [1e6, 'M'], [1e3, 'k']]) {
    if (abs >= limit) return `${(value / limit).toPrecision(4)}${suffix}`;
  }
  return Number.isInteger(value) ? String(value) : value.toPrecision(4);
}

export function formatDelta(delta) {
  if (delta === null) return 'n/a';
  if (!Number.isFinite(delta)) return 'was 0';
  return `${delta > 0 ? '+' : ''}${(delta * 100).toFixed(2)}%`;
}
