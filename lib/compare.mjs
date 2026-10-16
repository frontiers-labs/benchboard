// Shared by the CI recorder and the viewer, so both agree on what regressed.

/**
 * Compare two runs. `threshold` is a fraction (0.02 for 2%). Every metric gets a
 * status, but only metrics named in `gateMetrics` can mark the run regressed.
 * New and missing rows are reported and never fail the run.
 *
 * When both measures carry raw `samples`, a change also needs a significant
 * rank-sum test. A benchmark measured on another machine than before gets the
 * status `environment`, since the machine alone can move it.
 */
export function compare(base, head, { gateMetrics = [], threshold = 0.02 } = {}) {
  const gates = new Set(gateMetrics);
  const rows = [];
  for (const id of new Set([...Object.keys(base.results), ...Object.keys(head.results)])) {
    const before = base.results[id] ?? {};
    const after = head.results[id] ?? {};
    const moved = (base.environments?.[id] ?? '') !== (head.environments?.[id] ?? '');
    for (const metric of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const b = before[metric]?.value ?? null;
      const h = after[metric]?.value ?? null;
      let delta = null;
      let p = null;
      let status = h === null ? 'missing' : 'new';
      if (b !== null && h !== null) {
        delta = b === 0 ? (h === 0 ? 0 : Infinity) : h / b - 1;
        p = rankSumP(before[metric].samples, after[metric].samples);
        const significant = p === null || p < SIGNIFICANCE;
        status = !significant ? 'unchanged' : delta > threshold ? 'regressed' : delta < -threshold ? 'improved' : 'unchanged';
        if (moved && status !== 'unchanged') status = 'environment';
      }
      rows.push({ id, metric, base: b, head: h, delta, p, status, gated: gates.has(metric) });
    }
  }
  rows.sort((x, y) => Math.abs(y.delta ?? 0) - Math.abs(x.delta ?? 0) || x.id.localeCompare(y.id) || x.metric.localeCompare(y.metric));
  // A new compiler or Valgrind shifts counts without any change in the project.
  const envChanged = (base.env_key ?? '') !== (head.env_key ?? '');
  const regressed = !envChanged && rows.some(row => row.gated && row.status === 'regressed');
  return { rows, envChanged, regressed };
}

/** Two-sided p-value below which a change counts as real. */
export const SIGNIFICANCE = 0.01;
// The normal approximation of the rank-sum statistic needs this many samples a side.
const MIN_SAMPLES = 8;

/**
 * Two-sided p-value of the Mann-Whitney U test with the normal approximation,
 * corrected for ties and continuity. Null when either side has too few samples.
 */
export function rankSumP(x, y) {
  if (!Array.isArray(x) || !Array.isArray(y) || x.length < MIN_SAMPLES || y.length < MIN_SAMPLES) return null;
  const pooled = [...x.map(value => [value, 0]), ...y.map(value => [value, 1])].sort((a, b) => a[0] - b[0]);
  const n = pooled.length;
  let rankSum = 0, ties = 0;
  for (let start = 0; start < n;) {
    let end = start;
    while (end < n && pooled[end][0] === pooled[start][0]) end += 1;
    const size = end - start;
    const rank = (start + end + 1) / 2;
    for (let i = start; i < end; i += 1) if (pooled[i][1] === 0) rankSum += rank;
    ties += size ** 3 - size;
    start = end;
  }
  const n1 = x.length, n2 = y.length;
  const u = rankSum - n1 * (n1 + 1) / 2;
  const sigma = Math.sqrt(n1 * n2 / 12 * (n + 1 - ties / (n * (n - 1))));
  if (sigma === 0) return 1;
  const z = Math.max(0, Math.abs(u - n1 * n2 / 2) - 0.5) / sigma;
  return Math.min(1, 2 * (1 - normalCdf(z)));
}

// Abramowitz and Stegun 7.1.26, accurate to 1.5e-7.
function normalCdf(z) {
  const t = 1 / (1 + 0.3275911 * z / Math.SQRT2);
  const erf = 1 - t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) * Math.exp(-z * z / 2);
  return (1 + erf) / 2;
}

const SCALES = {
  ns: [[1e9, ' s'], [1e6, ' ms'], [1e3, ' µs'], [1, ' ns']],
  bytes: [[2 ** 30, ' GiB'], [2 ** 20, ' MiB'], [2 ** 10, ' KiB'], [1, ' B']],
  // Spelled so a count cannot be read as bytes: 2.380 bn, not 2.380G.
  count: [[1e12, ' tn'], [1e9, ' bn'], [1e6, ' M'], [1e3, ' k']],
};

/** Four significant digits in the largest fitting step of `unit`: `ns`, `bytes`, or a plain count. */
export function formatValue(value, unit) {
  if (value === null || value === undefined) return 'n/a';
  if (!Number.isFinite(value)) return String(value);
  const abs = Math.abs(value);
  for (const [limit, suffix] of SCALES[unit] ?? SCALES.count) {
    if (abs >= limit) return `${(value / limit).toPrecision(4)}${suffix}`;
  }
  return Number.isInteger(value) ? String(value) : value.toPrecision(4);
}

export function formatDelta(delta) {
  if (delta === null) return 'n/a';
  if (!Number.isFinite(delta)) return 'was 0';
  return `${delta > 0 ? '+' : ''}${(delta * 100).toFixed(2)}%`;
}
