import { compare, formatDelta, formatValue } from './lib/compare.mjs';
import { groupIds, resolveRun, series } from './lib/history.mjs';

// The only project-specific value. Any public repository works through ?repo=owner/name.
const DEFAULT_REPO = 'frontiers-labs/tir';

const params = new URLSearchParams(location.search);
const repo = params.get('repo') || DEFAULT_REPO;
const branch = params.get('branch') || 'perf-data';
// ?data= points at a local directory with the same layout as the data branch.
const dataUrl = params.get('data') || `https://raw.githubusercontent.com/${repo}/${branch}/`;

const $ = id => document.getElementById(id);
const content = $('content');
const tooltip = $('tooltip');
const state = {
  view: params.get('view') === 'history' ? 'history' : 'compare',
  metric: params.get('metric') || '',
  query: params.get('q') || '',
  range: params.get('range') || '30',
  unchanged: params.get('unchanged') === '1',
  base: -1,
  head: -1,
};
let index = [];
const cache = new Map();

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (value !== false && value !== null && value !== undefined) node.setAttribute(key, value);
  }
  node.append(...children.filter(child => child !== null && child !== false && child !== ''));
  return node;
}
function svg(tag, attributes = {}) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  return node;
}

async function fetchJson(path) {
  const response = await fetch(new URL(path, new URL(dataUrl, location.href)));
  if (!response.ok) throw new Error(`${path}: ${response.status} ${response.statusText}`);
  return response.json();
}
function loadRun(position) {
  const file = index[position].file;
  if (!cache.has(file)) cache.set(file, fetchJson(file));
  return cache.get(file);
}

const shortSha = commit => commit.slice(0, 8);
const dateLabel = time => new Date(time).toISOString().slice(0, 16).replace('T', ' ');
const runLabel = run => `${dateLabel(run.time)} · ${shortSha(run.commit)}${run.subject ? ` · ${run.subject}` : ''}`;
const commitLink = run => el('a', { href: `https://github.com/${repo}/commit/${run.commit}`, class: 'mono', rel: 'noopener' }, shortSha(run.commit));

function persist() {
  const next = new URLSearchParams();
  if (params.get('repo')) next.set('repo', repo);
  if (params.get('branch')) next.set('branch', branch);
  if (params.get('data')) next.set('data', params.get('data'));
  next.set('view', state.view);
  if (state.metric) next.set('metric', state.metric);
  if (state.query) next.set('q', state.query);
  if (state.view === 'compare') {
    if (index[state.base]) next.set('base', index[state.base].commit);
    if (index[state.head]) next.set('head', index[state.head].commit);
    if (state.unchanged) next.set('unchanged', '1');
  } else {
    next.set('range', state.range);
  }
  history.replaceState(null, '', `${location.pathname}?${next}`);
}

function setMetrics(runs) {
  const metrics = new Set();
  for (const run of runs) for (const measures of Object.values(run.results)) for (const metric of Object.keys(measures)) metrics.add(metric);
  const gates = runs.at(-1)?.gate_metrics ?? [];
  if (!metrics.has(state.metric)) state.metric = gates.find(metric => metrics.has(metric)) ?? [...metrics].sort()[0] ?? '';
  // Gated metrics lead the list because they are the ones that open issues.
  const ordered = [...gates.filter(metric => metrics.has(metric)), ...[...metrics].filter(metric => !gates.includes(metric)).sort()];
  $('metric').replaceChildren(...ordered.map(metric => el('option', { value: metric, selected: metric === state.metric ? '' : null }, metric)));
}

const matches = id => id.toLowerCase().includes(state.query.trim().toLowerCase());

async function renderCompare() {
  if (index.length < 2) {
    content.replaceChildren(el('p', { class: 'message' }, 'Two runs are needed for a comparison. Only one is recorded so far.'));
    if (index.length) setMetrics([await loadRun(0)]);
    return;
  }
  const [base, head] = await Promise.all([loadRun(state.base), loadRun(state.head)]);
  setMetrics([base, head]);
  const outcome = compare(base, head, { gateMetrics: head.gate_metrics ?? [], threshold: (head.threshold ?? 2) / 100 });
  const rows = outcome.rows.filter(row => row.metric === state.metric && matches(row.id));
  const count = status => rows.filter(row => row.status === status).length;
  const shown = rows.filter(row => state.unchanged || row.status !== 'unchanged');

  const summary = el('p', { class: 'summary' },
    el('strong', {}, `${count('regressed')} regressed, ${count('improved')} improved, ${count('unchanged')} unchanged`),
    count('new') || count('missing') ? `, ${count('new')} new, ${count('missing')} missing` : '',
    ` in ${state.metric} at a ${head.threshold ?? 2}% threshold. `,
    el('span', { class: 'commits' }, commitLink(base), ' to ', commitLink(head), head.subject ? ` · ${head.subject}` : ''),
  );
  const nodes = [summary];
  if (outcome.envChanged) {
    nodes.push(el('p', { class: 'notice' }, `The measurement environment changed between these runs, from "${base.env_key}" to "${head.env_key}". Differences may come from the toolchain.`));
  }
  if (!shown.length) {
    nodes.push(el('p', { class: 'message' }, rows.length ? 'Nothing moved above the threshold. Enable "Show unchanged" to list every benchmark.' : 'No benchmark matches the filter.'));
  } else {
    const body = el('tbody');
    for (const row of shown) {
      const open = () => { state.view = 'history'; state.query = row.id; $('query').value = row.id; render(); };
      body.append(el('tr', { tabindex: '0', onclick: open, onkeydown: event => { if (event.key === 'Enter') open(); } },
        el('td', { class: 'mono' }, row.id),
        el('td', { class: 'number' }, formatValue(row.base)),
        el('td', { class: 'number' }, formatValue(row.head)),
        el('td', { class: 'number' }, formatDelta(row.delta)),
        el('td', {}, el('span', { class: `status ${row.status}` }, row.status)),
      ));
    }
    nodes.push(el('div', { class: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {},
        el('th', {}, 'Benchmark'), el('th', { class: 'number' }, 'Before'), el('th', { class: 'number' }, 'After'),
        el('th', { class: 'number' }, 'Change'), el('th', {}, 'Status'))),
      body)));
  }
  content.replaceChildren(...nodes);
}

async function renderHistory() {
  const size = Number(state.range) || index.length;
  const first = Math.max(0, index.length - size);
  const runs = await Promise.all(index.slice(first).map((_, offset) => loadRun(first + offset)));
  setMetrics(runs);
  const ids = new Set();
  for (const run of runs) for (const [id, measures] of Object.entries(run.results)) if (state.metric in measures && matches(id)) ids.add(id);
  if (!ids.size) {
    content.replaceChildren(el('p', { class: 'message' }, 'No benchmark matches the filter.'));
    return;
  }
  const nodes = [];
  for (const [group, members] of groupIds(ids)) {
    nodes.push(el('h2', {}, group));
    nodes.push(el('div', { class: 'charts' }, ...members.map(id => chart(id, group, runs, first))));
  }
  content.replaceChildren(...nodes);
}

const WIDTH = 300, HEIGHT = 96, PAD = { top: 6, right: 6, bottom: 6, left: 44 };

function chart(id, group, runs, first) {
  const points = series(runs, id, state.metric);
  const values = points.map(point => point.value);
  let low = Math.min(...values), high = Math.max(...values);
  // Keep run-to-run noise flat: the axis always spans at least 10% of the largest value.
  const slack = (Math.abs(high) * 0.1 || 1) - (high - low);
  if (slack > 0) { low -= slack / 2; high += slack / 2; }
  const x = position => PAD.left + (runs.length === 1 ? 0.5 : position / (runs.length - 1)) * (WIDTH - PAD.left - PAD.right);
  const y = value => PAD.top + (1 - (value - low) / (high - low)) * (HEIGHT - PAD.top - PAD.bottom);

  const root = svg('svg', { viewBox: `0 0 ${WIDTH} ${HEIGHT}`, role: 'img', tabindex: '0', 'aria-label': `${id} ${state.metric} over ${points.length} runs` });
  for (const value of [high, low]) {
    root.append(svg('line', { class: 'grid', x1: PAD.left, x2: WIDTH - PAD.right, y1: y(value), y2: y(value) }));
    const label = svg('text', { x: PAD.left - 6, y: y(value) + 3, 'text-anchor': 'end' });
    label.textContent = formatValue(value);
    root.append(label);
  }
  // A short tick marks a run measured in a new environment, where a step is expected.
  runs.forEach((run, position) => {
    if (position > 0 && run.env_key !== runs[position - 1].env_key) {
      root.append(svg('line', { class: 'env', x1: x(position), x2: x(position), y1: HEIGHT - PAD.bottom, y2: HEIGHT - PAD.bottom + 5 }));
    }
  });
  root.append(svg('path', { class: 'line', d: points.map((point, order) => `${order ? 'L' : 'M'}${x(point.index).toFixed(1)},${y(point.value).toFixed(1)}`).join('') }));
  if (points.length === 1) root.append(svg('circle', { class: 'dot', cx: x(points[0].index), cy: y(points[0].value), r: 4 }));
  const cross = svg('line', { class: 'cross', y1: PAD.top, y2: HEIGHT - PAD.bottom, visibility: 'hidden' });
  const dot = svg('circle', { class: 'dot', r: 4, visibility: 'hidden' });
  root.append(cross, dot);

  let active = -1;
  const show = (order, clientX, clientY) => {
    active = order;
    const point = points[order], run = runs[point.index], previous = points[order - 1];
    cross.setAttribute('x1', x(point.index)); cross.setAttribute('x2', x(point.index)); cross.setAttribute('visibility', 'visible');
    dot.setAttribute('cx', x(point.index)); dot.setAttribute('cy', y(point.value)); dot.setAttribute('visibility', 'visible');
    const environment = point.index > 0 && run.env_key !== runs[point.index - 1].env_key;
    tooltip.replaceChildren(...[
      el('strong', {}, `${formatValue(point.value)}${previous ? `  ${formatDelta(previous.value === 0 ? null : point.value / previous.value - 1)}` : ''}`),
      el('span', {}, `${state.metric} · ${dateLabel(run.time)} · ${shortSha(run.commit)}`),
      run.subject && el('span', {}, run.subject),
      environment && el('span', {}, `New environment: ${run.env_key}`),
    ].filter(Boolean));
    tooltip.hidden = false;
    const box = tooltip.getBoundingClientRect();
    tooltip.style.left = `${Math.min(clientX + 14, innerWidth - box.width - 8)}px`;
    tooltip.style.top = `${Math.max(8, clientY - box.height - 12)}px`;
  };
  const hide = () => { active = -1; cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); tooltip.hidden = true; };
  const nearest = event => {
    const box = root.getBoundingClientRect();
    const target = (event.clientX - box.left) / box.width * WIDTH;
    let best = 0;
    points.forEach((point, order) => { if (Math.abs(x(point.index) - target) < Math.abs(x(points[best].index) - target)) best = order; });
    return best;
  };
  const open = order => {
    if (order < 0) return;
    const position = first + points[order].index;
    if (position === 0) return;
    state.view = 'compare'; state.head = position; state.base = position - 1;
    hide(); render();
  };
  const anchor = order => {
    const box = root.getBoundingClientRect();
    return [box.left + x(points[order].index) / WIDTH * box.width, box.top];
  };
  root.addEventListener('pointermove', event => show(nearest(event), event.clientX, event.clientY));
  root.addEventListener('pointerleave', hide);
  root.addEventListener('click', event => open(nearest(event)));
  root.addEventListener('blur', hide);
  root.addEventListener('keydown', event => {
    if (event.key === 'Enter') return open(active);
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const order = Math.min(points.length - 1, Math.max(0, active < 0 ? points.length - 1 : active + (event.key === 'ArrowRight' ? 1 : -1)));
    show(order, ...anchor(order));
  });

  const last = points.at(-1), start = points[0];
  return el('article', { class: 'chart' },
    el('h3', {}, id === group ? id : id.slice(group.length + 1)),
    el('p', { class: 'latest' },
      el('span', { class: 'mono' }, formatValue(last.value)),
      points.length > 1 && start.value !== 0 ? `${formatDelta(last.value / start.value - 1)} over ${points.length} runs` : ''),
    root);
}

async function render() {
  for (const button of document.querySelectorAll('nav button')) {
    if (button.dataset.view === state.view) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  }
  for (const label of document.querySelectorAll('#filters [data-for]')) label.hidden = label.dataset.for !== state.view;
  // A chart click moves the compared runs without touching the controls.
  $('base').value = state.base;
  $('head').value = state.head;
  persist();
  content.style.opacity = '0.5';
  try {
    await (state.view === 'compare' ? renderCompare() : renderHistory());
  } catch (error) {
    content.replaceChildren(el('p', { class: 'message' }, `Could not load run data. ${error.message}`));
  }
  content.style.opacity = '';
}

async function start() {
  $('repo').textContent = repo;
  $('repo').href = `https://github.com/${repo}`;
  document.title = `benchboard · ${repo}`;
  try {
    index = (await fetchJson('index.json')).runs;
  } catch (error) {
    content.replaceChildren(el('p', { class: 'message' }, `No run history found at ${dataUrl}. ${error.message}`));
    return;
  }
  if (!index.length) {
    content.replaceChildren(el('p', { class: 'message' }, 'No runs are recorded yet.'));
    return;
  }
  state.head = resolveRun(index, params.get('head'));
  if (state.head < 0) state.head = index.length - 1;
  state.base = resolveRun(index, params.get('base'));
  if (state.base < 0) state.base = Math.max(0, state.head - 1);

  const options = selected => index.map((run, position) => el('option', { value: position, selected: position === selected ? '' : null }, runLabel(run))).reverse();
  $('base').replaceChildren(...options(state.base));
  $('head').replaceChildren(...options(state.head));
  $('query').value = state.query;
  $('range').value = state.range;
  $('unchanged').checked = state.unchanged;

  $('metric').addEventListener('change', event => { state.metric = event.target.value; render(); });
  $('query').addEventListener('input', event => { state.query = event.target.value; render(); });
  $('base').addEventListener('change', event => { state.base = Number(event.target.value); render(); });
  $('head').addEventListener('change', event => { state.head = Number(event.target.value); render(); });
  $('range').addEventListener('change', event => { state.range = event.target.value; render(); });
  $('unchanged').addEventListener('change', event => { state.unchanged = event.target.checked; render(); });
  $('filters').addEventListener('submit', event => event.preventDefault());
  for (const button of document.querySelectorAll('nav button')) {
    button.addEventListener('click', () => { state.view = button.dataset.view; render(); });
  }
  await render();
}

start();
