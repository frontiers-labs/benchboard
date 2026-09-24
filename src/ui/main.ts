import type { Comparison, ComparisonRow, Measurement, Run, Suite } from '../shared/types';
import { measurementKey } from '../shared/validation';
import { compatibleBaseline, priorNightly, priorValue, trendHistory } from './history';
import './style.css';

type View = 'changes' | 'trends' | 'results';
type Cursor = { before: string; beforeId: string };
const API = (import.meta.env.VITE_API_URL || 'http://localhost:8787').replace(/\/$/, '');
const root = document.querySelector<HTMLDivElement>('#app')!;
const initial = new URLSearchParams(location.search);
const viewFrom = (value: string | null): View => value === 'observatory' ? 'trends' : value === 'compare' ? 'changes' : value === 'ledger' ? 'results' : value === 'trends' || value === 'results' ? value : 'changes';
const state = {
  view: viewFrom(initial.get('view') || localStorage.getItem('benchboard-view')),
  runs: [] as Run[], current: initial.get('run') || '', baseline: initial.get('baseline') || '',
  suite: 'runtime' as Suite, metric: '', search: '', benchmark: '', compiler: '', references: false, threshold: 5,
  expanded: '', comparison: null as Comparison | null, loading: true, loadingOlder: false, comparing: false,
  error: '', olderError: '', comparisonError: '', nextCursor: null as Cursor | null, loadSeq: 0, compareSeq: 0,
};
const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const nfmt = (value: number, digits = 2) => new Intl.NumberFormat('en-US', { maximumFractionDigits: digits }).format(value);
const compactDate = (value: string) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
const pct = (value: number | null) => value === null ? '—' : `${value > 0 ? '+' : ''}${value.toFixed(1)}%`;
const selectedRun = () => state.runs.find(run => run.id === state.current) || state.runs[0];
const baselineRun = () => state.runs.find(run => run.id === state.baseline);
const short = (value: string, length = 8) => value.slice(0, length);
const unitValue = (value: number | null, unit: string) => {
  if (value === null) return '—';
  if (unit === 'ns') return value >= 1e9 ? `${nfmt(value / 1e9)} s` : value >= 1e6 ? `${nfmt(value / 1e6)} ms` : value >= 1e3 ? `${nfmt(value / 1e3)} µs` : `${nfmt(value)} ns`;
  if (unit === 'µs' || unit === 'us') return value >= 1e6 ? `${nfmt(value / 1e6)} s` : value >= 1e3 ? `${nfmt(value / 1e3)} ms` : `${nfmt(value)} µs`;
  if (unit === 'ms') return value >= 1e3 ? `${nfmt(value / 1e3)} s` : `${nfmt(value)} ms`;
  return `${nfmt(value)} ${esc(unit)}`;
};
const isPrimary = (compiler: string) => /(^|[^a-z])(tir|fcc)([^a-z]|$)/i.test(compiler);
const source = (row: Measurement) => row.metadata?.source === 'tir' && row.suite === 'criterion' ? 'TIR microbenchmark' : row.metadata?.source === 'criterion' ? 'Criterion' : typeof row.metadata?.source === 'string' ? row.metadata.source : row.suite;
const sameMeasure = (a: Measurement, b: Pick<Measurement, 'suite' | 'benchmark' | 'metric' | 'unit'>) => a.suite === b.suite && a.benchmark === b.benchmark && a.metric === b.metric && a.unit === b.unit;
function ratio(run: Run, row: Pick<Measurement, 'suite' | 'benchmark' | 'metric' | 'unit'> & { candidate: number | null }, peer: 'clang' | 'gcc') {
  if (row.candidate === null) return '—';
  const match = run.measurements.find(item => sameMeasure(item, row) && item.compiler.toLowerCase().includes(peer));
  return match?.value ? `${(row.candidate / match.value).toFixed(2)}×` : '—';
}
function persist() {
  localStorage.setItem('benchboard-view', state.view);
  const p = new URLSearchParams(location.search);
  p.set('view', state.view);
  p.delete('demo'); p.delete('mode');
  if (state.current) p.set('run', state.current); else p.delete('run');
  if (state.baseline) p.set('baseline', state.baseline); else p.delete('baseline');
  history.replaceState(null, '', `${location.pathname}?${p}${location.hash}`);
}
async function getJSON<T>(path: string): Promise<T> {
  const response = await fetch(`${API}${path}`, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText || 'Request failed'}`);
  return response.json() as Promise<T>;
}
type Page = { runs: Run[]; nextCursor: Cursor | null };
function reconcile() {
  if (!state.runs.some(run => run.id === state.current)) state.current = state.runs[0]?.id || '';
  const current = selectedRun(), baseline = baselineRun();
  if (!current || !baseline || !compatibleBaseline(current, baseline)) state.baseline = current ? priorNightly(state.runs, current)?.id || '' : '';
  const metrics = new Set(current?.measurements.filter(row => row.suite === state.suite).map(row => row.metric) || []);
  if (!metrics.has(state.metric)) state.metric = metrics.has('latency') ? 'latency' : [...metrics].sort()[0] || '';
  persist();
}
async function loadRuns() {
  const sequence = ++state.loadSeq;
  state.compareSeq++; state.comparing = false; state.loading = true; state.loadingOlder = false;
  state.error = ''; state.olderError = ''; state.comparisonError = ''; state.comparison = null;
  state.runs = []; state.nextCursor = null; render();
  try {
    const page = await getJSON<Page>('/api/runs?project=tir&limit=100');
    if (sequence !== state.loadSeq) return;
    if (!Array.isArray(page.runs)) throw new Error('Unexpected runs response');
    state.runs = page.runs; state.nextCursor = page.nextCursor || null; reconcile();
  } catch (error) { if (sequence !== state.loadSeq) return; state.error = error instanceof Error ? error.message : String(error); }
  state.loading = false; render(); await compare();
}
async function loadOlder() {
  const cursor = state.nextCursor;
  if (!cursor || state.loadingOlder || state.loading) return;
  const sequence = state.loadSeq;
  state.loadingOlder = true; state.olderError = ''; render();
  try {
    const page = await getJSON<Page>(`/api/runs?project=tir&limit=100&before=${encodeURIComponent(cursor.before)}&beforeId=${encodeURIComponent(cursor.beforeId)}`);
    if (sequence !== state.loadSeq) return;
    if (!Array.isArray(page.runs)) throw new Error('Unexpected runs response');
    const known = new Set(state.runs.map(run => run.id));
    state.runs.push(...page.runs.filter(run => !known.has(run.id)));
    state.nextCursor = page.nextCursor || null;
    const previous = state.baseline; reconcile();
    if (previous !== state.baseline) void compare();
  } catch (error) { if (sequence === state.loadSeq) state.olderError = error instanceof Error ? error.message : String(error); }
  if (sequence !== state.loadSeq) return;
  state.loadingOlder = false; render();
}
async function compare() {
  const sequence = ++state.compareSeq, current = selectedRun(), baseline = baselineRun();
  state.comparison = null; state.comparisonError = ''; state.comparing = false;
  if (!current || !baseline || current.id === baseline.id) { render(); return; }
  state.comparing = true; render();
  try {
    const result = await getJSON<Comparison>(`/api/compare?baseline=${encodeURIComponent(baseline.id)}&candidate=${encodeURIComponent(current.id)}&threshold=${state.threshold}`);
    if (sequence === state.compareSeq) state.comparison = result;
  } catch (error) { if (sequence === state.compareSeq) state.comparisonError = error instanceof Error ? error.message : String(error); }
  if (sequence !== state.compareSeq) return;
  state.comparing = false; render();
}
function runOption(run: Run, selected: string) { return `<option value="${esc(run.id)}" ${run.id === selected ? 'selected' : ''}>${esc(compactDate(run.timestamp))} · ${esc(short(run.commit))} · ${esc(run.kind)}</option>`; }
function scope(row: Pick<Measurement, 'suite' | 'metric' | 'benchmark' | 'compiler'>, gate: boolean) {
  return row.suite === state.suite && row.metric === state.metric && (state.references || gate || isPrimary(row.compiler)) && (!state.search || `${row.benchmark} ${row.compiler}`.toLowerCase().includes(state.search.toLowerCase()));
}
function option(value: string, current: string) { return `<option value="${esc(value)}" ${value === current ? 'selected' : ''}>${esc(value)}</option>`; }
function header() {
  const run = selectedRun();
  const metrics = [...new Set(run?.measurements.filter(row => row.suite === state.suite).map(row => row.metric) || [])].sort();
  const baselines = state.runs.filter(item => run && compatibleBaseline(run, item));
  return `<header class="appbar"><div class="identity"><strong>benchboard</strong><span>/ TIR</span></div></header>
  <nav class="view-nav" aria-label="Views">${(['changes', 'trends', 'results'] as View[]).map(view => `<button data-view="${view}" class="${view === state.view ? 'active' : ''}" aria-current="${view === state.view ? 'page' : 'false'}">${view[0].toUpperCase() + view.slice(1)}</button>`).join('')}</nav>
  <main><div class="suite-nav" role="group" aria-label="Suite">${([['compile', 'Compile time'], ['runtime', 'Runtime'], ['criterion', 'Microbenchmarks']] as [Suite, string][]).map(([suite, label]) => `<button data-suite="${suite}" class="${suite === state.suite ? 'active' : ''}" aria-pressed="${suite === state.suite}">${label}</button>`).join('')}</div>
  <div class="controls"><label>Metric<select id="metric">${metrics.map(metric => option(metric, state.metric)).join('')}</select></label><label class="search">Benchmark<input id="search" type="search" placeholder="Search benchmark or compiler" value="${esc(state.search)}"></label><label>Baseline<select id="baseline"><option value="">None</option>${baselines.map(item => runOption(item, state.baseline)).join('')}</select></label><label>Current<select id="current">${state.runs.map(item => runOption(item, run?.id || '')).join('')}</select></label><label class="threshold">Threshold<input id="threshold" type="number" min="0" max="100" step="0.1" value="${state.threshold}" aria-label="Regression threshold percent"><span>%</span></label></div>`;
}
function alerts() {
  return `${state.error ? `<div class="notice error" role="alert">API error: ${esc(state.error)} at ${esc(API)}. <button data-action="retry">Retry</button></div>` : ''}${state.comparisonError ? `<div class="notice error" role="alert">Comparison error: ${esc(state.comparisonError)}. <button data-action="compare">Retry</button></div>` : ''}${state.olderError ? `<div class="notice error" role="alert">Older runs: ${esc(state.olderError)}</div>` : ''}`;
}
function referenceFor(row: ComparisonRow) {
  return baselineRun()?.measurements.find(item => measurementKey(item) === row.key) || selectedRun()?.measurements.find(item => measurementKey(item) === row.key);
}
function detail(run: Run, row: Measurement) {
  const points = trendHistory(state.runs, run, row);
  const values = points.map(point => point.measurement.value);
  const low = Math.min(...values), high = Math.max(...values), span = high - low || Math.abs(high) * .05 || 1;
  const width = 540, height = 160, pad = 20;
  const dots = points.map((point, i) => ({ x: pad + i * (width - 2 * pad) / Math.max(points.length - 1, 1), y: height - pad - (point.measurement.value - low + span * .1) / (span * 1.2) * (height - 2 * pad), point }));
  const poly = dots.map(dot => `${dot.x.toFixed(1)},${dot.y.toFixed(1)}`).join(' ');
  return `<div class="detail"><div class="detail-title">${esc(row.benchmark)} · ${esc(row.compiler)} · ${esc(row.metric)}</div><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="History of ${esc(row.benchmark)} from ${points.length} compatible runs, low ${esc(unitValue(low, row.unit))}, high ${esc(unitValue(high, row.unit))}"><text x="${width - 5}" y="13" text-anchor="end">${unitValue(high, row.unit)}</text><text x="${width - 5}" y="${height - 5}" text-anchor="end">${unitValue(low, row.unit)}</text><polyline points="${poly}" fill="none" stroke="currentColor" stroke-width="2" vector-effect="non-scaling-stroke"/>${dots.map(dot => `<circle cx="${dot.x}" cy="${dot.y}" r="3" fill="currentColor"><title>${esc(compactDate(dot.point.run.timestamp))}: ${esc(unitValue(dot.point.measurement.value, row.unit))}</title></circle>`).join('')}</svg><div class="detail-ends"><span>${points.length ? esc(compactDate(points[0].run.timestamp)) : ''}</span><span>${points.length ? esc(compactDate(points.at(-1)!.run.timestamp)) : ''}</span></div><details><summary>Samples and provenance</summary><div class="metadata"><span>Run ${esc(run.id)}</span><span>Commit ${esc(run.commit)}</span><span>Branch ${esc(run.branch)}</span><span>Machine ${esc(run.machine)}</span><span>Config ${esc(run.config)}</span><span>Source ${esc(source(row))}</span><span>Gate ${row.gate === false ? 'reference only' : 'included'}</span><span>Samples ${row.samples?.length ? esc(row.samples.map(value => unitValue(value, row.unit)).join(', ')) : 'none supplied'}</span></div></details></div>`;
}
function changes() {
  const current = selectedRun();
  if (!current) return '<p class="empty">No runs found.</p>';
  const comparison = state.comparison;
  const available = comparison?.status === 'pass' || comparison?.status === 'fail' ? comparison.rows : current.measurements.map(row => ({ key: measurementKey(row), suite: row.suite, benchmark: row.benchmark, compiler: row.compiler, metric: row.metric, unit: row.unit, baseline: null, candidate: row.value, changePercent: null, status: 'new' as const }));
  const rows = available.filter(row => scope(row, referenceFor(row)?.gate !== false));
  const gated = comparison?.rows.filter(row => referenceFor(row)?.gate !== false) || [];
  const comparable = gated.filter(row => row.baseline !== null && row.candidate !== null && row.changePercent !== null);
  const regressions = comparable.filter(row => row.status === 'regressed').length, missing = gated.filter(row => row.status === 'missing').length;
  const shownRegressions = rows.filter(row => row.status === 'regressed' && referenceFor(row)?.gate !== false).length;
  const countText = state.comparing ? 'Comparing runs…' : !baselineRun() ? 'Choose a baseline to compare.' : comparison?.status === 'incomparable' ? esc(comparison.reason || 'Runs cannot be compared.') : comparison ? `${regressions} regressions${missing ? `, ${missing} missing` : ''} out of ${comparable.length} comparable across all suites · threshold ${nfmt(state.threshold, 1)}%${rows.length !== comparison.rows.length ? ` · ${shownRegressions} regressions shown` : ''}` : '';
  return `<div class="result-line"><span class="${regressions || missing ? 'bad' : ''}">${countText}</span><label class="inline-check"><input id="references" type="checkbox" ${state.references ? 'checked' : ''}> Show reference compilers</label></div>
  ${!state.comparing ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Benchmark</th><th>Compiler</th><th class="number">Baseline</th><th class="number">Current</th><th class="number">Change</th><th class="number" title="&gt;1 means the current compiler uses more time, count, or memory">Current / Clang</th><th class="number" title="&gt;1 means the current compiler uses more time, count, or memory">Current / GCC</th></tr></thead><tbody>${rows.map(row => { const measurement = current.measurements.find(item => measurementKey(item) === row.key) || baselineRun()?.measurements.find(item => measurementKey(item) === row.key); const primary = isPrimary(row.compiler); return `<tr class="data-row ${state.expanded === row.key ? 'selected' : ''}" data-row="${esc(row.key)}" tabindex="0" aria-expanded="${state.expanded === row.key}"><td><span class="expand-mark">${state.expanded === row.key ? '▾' : '▸'}</span>${esc(row.benchmark)}</td><td>${esc(row.compiler)}${measurement?.gate === false ? ' <span class="muted">· reference</span>' : ''}</td><td class="number">${unitValue(row.baseline, row.unit)}</td><td class="number">${unitValue(row.candidate, row.unit)}</td><td class="number ${row.status === 'regressed' && measurement?.gate !== false ? 'bad' : row.status === 'improved' ? 'good' : ''}">${pct(row.changePercent)}${row.status === 'missing' ? ' missing' : ''}</td><td class="number">${primary ? ratio(current, row, 'clang') : '—'}</td><td class="number">${primary ? ratio(current, row, 'gcc') : '—'}</td></tr>${state.expanded === row.key && measurement ? `<tr class="detail-row"><td colspan="7">${detail(current, measurement)}</td></tr>` : ''}`; }).join('')}</tbody></table>${rows.length ? '' : '<p class="empty">No measurements match these filters.</p>'}</div>` : ''}`;
}
function trends() {
  const run = selectedRun(); if (!run) return '<p class="empty">No runs found.</p>';
  const rows = run.measurements.filter(row => scope(row, row.gate !== false));
  const benchmarks = [...new Set(rows.map(row => row.benchmark))].sort();
  const benchmark = benchmarks.includes(state.benchmark) ? state.benchmark : benchmarks[0];
  const matches = rows.filter(row => row.benchmark === benchmark);
  const chosen = matches.find(row => row.compiler === state.compiler) || matches.find(row => isPrimary(row.compiler)) || matches[0];
  return `<div class="subcontrols"><label>Benchmark<select id="benchmark">${benchmarks.map(value => option(value, benchmark)).join('')}</select></label><label>Compiler<select id="compiler">${matches.map(row => option(row.compiler, chosen?.compiler || '')).join('')}</select></label><label class="inline-check"><input id="references" type="checkbox" ${state.references ? 'checked' : ''}> Show reference compilers</label></div>
  ${chosen ? `<div class="trend-head"><strong>${esc(benchmark)}</strong><span>${esc(chosen.compiler)} · ${esc(chosen.metric)} · ${esc(source(chosen))}</span></div>${detail(run, chosen)}<div class="table-wrap"><table class="data-table"><thead><tr><th>Run</th><th>Commit</th><th>Kind</th><th class="number">Value</th><th class="number">Change vs previous nightly</th></tr></thead><tbody>${trendHistory(state.runs, run, chosen).reverse().map(({ run: item, measurement }) => { const previous = priorValue(state.runs, item, measurement); return `<tr><td>${esc(compactDate(item.timestamp))}</td><td>${esc(short(item.commit))}</td><td>${esc(item.kind)}</td><td class="number">${unitValue(measurement.value, measurement.unit)}</td><td class="number">${previous ? pct((measurement.value - previous) / previous * 100) : '—'}</td></tr>`; }).join('')}</tbody></table></div>` : '<p class="empty">No measurements match these filters.</p>'}`;
}
function results() {
  const run = selectedRun(); if (!run) return '<p class="empty">No runs found.</p>';
  const rows = run.measurements.filter(row => scope(row, row.gate !== false));
  return `<div class="subcontrols"><span>${state.runs.length} runs loaded · ${rows.length} measurements shown</span><label class="inline-check"><input id="references" type="checkbox" ${state.references ? 'checked' : ''}> Show reference compilers</label></div><div class="results-layout"><div class="run-list" aria-label="Run history">${state.runs.map(item => `<button data-run="${esc(item.id)}" class="${item.id === run.id ? 'active' : ''}"><span>${esc(compactDate(item.timestamp))}</span><span>${esc(short(item.commit))}</span></button>`).join('')}</div><div class="table-wrap"><div class="run-info">${esc(run.id)} · ${esc(run.branch)} · ${esc(run.machine)} · ${esc(run.config)}</div><table class="data-table"><thead><tr><th>Benchmark</th><th>Compiler</th><th>Source</th><th class="number">Value</th><th class="number">vs previous nightly</th></tr></thead><tbody>${rows.map(row => { const previous = priorValue(state.runs, run, row); const change = previous ? (row.value - previous) / previous * 100 : null; const identity = measurementKey(row); return `<tr class="data-row ${state.expanded === identity ? 'selected' : ''}" data-row="${esc(identity)}" tabindex="0" aria-expanded="${state.expanded === identity}"><td><span class="expand-mark">${state.expanded === identity ? '▾' : '▸'}</span>${esc(row.benchmark)}</td><td>${esc(row.compiler)}${row.gate === false ? ' <span class="muted">· reference</span>' : ''}</td><td>${esc(source(row))}</td><td class="number">${unitValue(row.value, row.unit)}</td><td class="number ${change !== null && change > state.threshold && row.gate !== false ? 'bad' : ''}">${pct(change)}</td></tr>${state.expanded === identity ? `<tr class="detail-row"><td colspan="5">${detail(run, row)}</td></tr>` : ''}`; }).join('')}</tbody></table>${rows.length ? '' : '<p class="empty">No measurements match these filters.</p>'}</div></div>`;
}
function render() {
  root.innerHTML = `${header()}${alerts()}${state.loading ? '<p class="empty" role="status">Loading runs…</p>' : state.view === 'changes' ? changes() : state.view === 'trends' ? trends() : results()}${state.nextCursor && !state.loading ? `<div class="load-more"><button data-action="older" ${state.loadingOlder ? 'disabled' : ''}>${state.loadingOlder ? 'Loading…' : 'Load older runs'}</button></div>` : ''}</main>`;
  bind();
}
function bind() {
  root.querySelectorAll<HTMLButtonElement>('[data-view]').forEach(button => button.addEventListener('click', () => { state.view = button.dataset.view as View; state.expanded = ''; persist(); render(); }));
  root.querySelectorAll<HTMLButtonElement>('[data-suite]').forEach(button => button.addEventListener('click', () => { state.suite = button.dataset.suite as Suite; state.metric = ''; state.benchmark = ''; state.expanded = ''; reconcile(); render(); }));
  root.querySelector('#metric')?.addEventListener('change', event => { state.metric = (event.target as HTMLSelectElement).value; state.benchmark = ''; state.expanded = ''; render(); });
  root.querySelector<HTMLInputElement>('#search')?.addEventListener('input', event => { const input = event.target as HTMLInputElement, position = input.selectionStart; state.search = input.value; render(); const next = root.querySelector<HTMLInputElement>('#search'); next?.focus(); next?.setSelectionRange(position, position); });
  root.querySelector('#current')?.addEventListener('change', event => { state.current = (event.target as HTMLSelectElement).value; state.expanded = ''; state.benchmark = ''; reconcile(); render(); void compare(); });
  root.querySelector('#baseline')?.addEventListener('change', event => { state.baseline = (event.target as HTMLSelectElement).value; persist(); void compare(); });
  root.querySelector<HTMLInputElement>('#threshold')?.addEventListener('change', event => { const value = Number((event.target as HTMLInputElement).value); if (!Number.isFinite(value) || value < 0 || value > 100) { render(); return; } state.threshold = value; void compare(); });
  root.querySelector<HTMLInputElement>('#references')?.addEventListener('change', event => { state.references = (event.target as HTMLInputElement).checked; render(); });
  root.querySelector('#benchmark')?.addEventListener('change', event => { state.benchmark = (event.target as HTMLSelectElement).value; state.compiler = ''; render(); });
  root.querySelector('#compiler')?.addEventListener('change', event => { state.compiler = (event.target as HTMLSelectElement).value; render(); });
  root.querySelectorAll<HTMLButtonElement>('[data-run]').forEach(button => button.addEventListener('click', () => { state.current = button.dataset.run || ''; state.expanded = ''; reconcile(); render(); void compare(); }));
  root.querySelectorAll<HTMLElement>('[data-row]').forEach(row => { const toggle = () => { state.expanded = state.expanded === row.dataset.row ? '' : row.dataset.row || ''; render(); }; row.addEventListener('click', toggle); row.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(); } }); });
  root.querySelector<HTMLButtonElement>('[data-action="retry"]')?.addEventListener('click', () => void loadRuns());
  root.querySelector<HTMLButtonElement>('[data-action="compare"]')?.addEventListener('click', () => void compare());
  root.querySelector<HTMLButtonElement>('[data-action="older"]')?.addEventListener('click', () => void loadOlder());
}
void loadRuns();
