import { compare, formatDelta, formatValue } from './lib/compare.mjs';
import { groupIds, resolveRun, series } from './lib/history.mjs';
import { meanRatio, metricIndex, ratio, versusGroups } from './lib/versus.mjs';

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
const VIEWS = ['versus', 'compare', 'history'];
const state = {
  // Without ?view=, start() opens the versus view when the latest run has variants.
  view: VIEWS.includes(params.get('view')) ? params.get('view') : '',
  metric: params.get('metric') || '',
  query: params.get('q') || '',
  range: params.get('range') || '30',
  unchanged: params.get('unchanged') === '1',
  base: -1,
  head: -1,
};
let index = [];
const cache = new Map();
// Metric definitions of the runs on screen. Older runs may carry none.
let metrics = new Map();
const metricLabel = metric => metrics.get(metric)?.label ?? metric;
const format = (value, metric) => formatValue(value, metrics.get(metric)?.unit);
const formatRatio = value => `${value.toFixed(2)}×`;

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
    if (state.unchanged) next.set('unchanged', '1');
  } else {
    next.set('range', state.range);
  }
  if (state.view !== 'history' && index[state.head]) next.set('head', index[state.head].commit);
  history.replaceState(null, '', `${location.pathname}?${next}`);
}

function setMetrics(runs) {
  metrics = metricIndex(runs);
  const gates = (runs.at(-1)?.gate_metrics ?? []).filter(metric => metrics.has(metric));
  if (!metrics.has(state.metric)) state.metric = gates[0] ?? metrics.keys().next().value ?? '';
  // Gated metrics lead the list because they are the ones that open issues.
  const ordered = [...gates, ...[...metrics.keys()].filter(metric => !gates.includes(metric))];
  $('metric').replaceChildren(...ordered.map(metric => el('option', { value: metric, selected: metric === state.metric ? '' : null }, metricLabel(metric))));
}
const description = metric => {
  const text = metrics.get(metric)?.description;
  return text ? el('p', { class: 'about' }, el('strong', {}, metricLabel(metric)), ` · ${text}`) : '';
};

const matches = (...names) => names.some(name => name.toLowerCase().includes(state.query.trim().toLowerCase()));
const showHistory = (query, metric = state.metric) => { state.view = 'history'; state.metric = metric; state.query = query; $('query').value = query; render(); };
const onActivate = action => ({ tabindex: '0', onclick: action, onkeydown: event => { if (event.key === 'Enter') action(); } });
const swatch = slot => el('i', { class: 'swatch', style: `background: var(--series-${slot + 1})` });

/** One fixed color slot per variant: subjects first, then references by name. */
function variantSlots(groups) {
  const names = [...new Set([...groups.map(group => group.subject), ...groups.flatMap(group => group.variants).sort()])];
  return name => Math.min(names.indexOf(name), 7);
}

async function renderVersus() {
  const size = Number(state.range) || index.length;
  const first = Math.max(0, state.head + 1 - size);
  const runs = await Promise.all(index.slice(first, state.head + 1).map((_, offset) => loadRun(first + offset)));
  const head = runs.at(-1);
  setMetrics(runs);
  const groups = versusGroups(head.variants ?? {});
  const slot = variantSlots(groups);
  const margin = (head.threshold ?? 2) / 100;
  const tiles = [], sections = [], described = new Set();
  for (const group of groups) {
    const benchmarks = group.benchmarks.filter(benchmark => matches(benchmark.name, ...Object.values(benchmark.ids)));
    const shown = { ...group, benchmarks };
    for (const metric of metrics.keys()) {
      const references = group.variants.slice(1).filter(reference => meanRatio(head, shown, reference, metric));
      if (!references.length) continue;
      const title = `${group.name} · ${metricLabel(metric)}`;
      const count = Math.max(...references.map(reference => meanRatio(head, shown, reference, metric).count));
      tiles.push(chart({
        title, runs, first, format: formatRatio, parity: true, tile: true,
        caption: `${group.subject} ÷ reference, geometric mean of ${count} benchmark${count === 1 ? '' : 's'}`,
        series: references.map(reference => ({
          name: reference, slot: slot(reference),
          points: runs.flatMap((run, position) => { const mean = meanRatio(run, shown, reference, metric); return mean ? [{ index: position, value: mean.value }] : []; }),
        })),
      }));
      const ratioCell = value => el('td', { class: 'number' }, value === null ? 'n/a'
        : el('span', { class: `status ${value > 1 + margin ? 'behind' : value < 1 - margin ? 'ahead' : 'level'}` }, formatRatio(value)));
      const body = el('tbody');
      for (const benchmark of benchmarks) {
        const measures = group.variants.map(variant => head.results[benchmark.ids[variant]]?.[metric]);
        if (!measures[0]) continue;
        body.append(el('tr', onActivate(() => showHistory(benchmark.ids[group.subject], metric)),
          el('td', { class: 'mono' }, benchmark.name),
          ...measures.map(measure => el('td', { class: 'number' }, format(measure?.value, metric), spread(measure))),
          ...references.map(reference => ratioCell(ratio(head, benchmark, group.subject, reference, metric)))));
      }
      body.append(el('tr', { class: 'mean' },
        el('td', {}, 'Geometric mean'), ...group.variants.map(() => el('td')),
        ...references.map(reference => ratioCell(meanRatio(head, shown, reference, metric).value))));
      sections.push(el('h2', {}, title), described.has(metric) ? '' : description(metric), el('div', { class: 'table-wrap' }, el('table', {},
        el('thead', {}, el('tr', {},
          el('th', {}, 'Benchmark'),
          ...group.variants.map(variant => el('th', { class: 'number' }, variant)),
          ...references.map(reference => el('th', { class: 'number' }, `${group.subject} ÷ ${reference}`)))),
        body)));
      described.add(metric);
    }
  }
  if (!tiles.length) {
    content.replaceChildren(el('p', { class: 'message' }, groups.length ? 'No benchmark matches the filter.' : 'This run has no benchmark measured for several variants.'));
    return;
  }
  content.replaceChildren(
    el('p', { class: 'summary' },
      el('strong', {}, new Intl.ListFormat('en').format(new Set(groups.map(group => group.subject)))), ' against ',
      new Intl.ListFormat('en').format(new Set(groups.flatMap(group => group.variants.slice(1)))), ' at ',
      el('span', { class: 'commits' }, commitLink(head), head.subject ? ` · ${head.subject}` : ''),
      '. Lower is better for every metric, so a ratio above 1× means the reference is ahead.'),
    el('div', { class: 'charts' }, ...tiles),
    ...sections.filter(Boolean));
}

/** Half the reported range as a share of the value, when the result carries one. */
function spread(measure) {
  if (!Number.isFinite(measure?.lower_value) || !Number.isFinite(measure?.upper_value) || !measure.value) return '';
  return el('span', { class: 'spread' }, ` ±${((measure.upper_value - measure.lower_value) / 2 / measure.value * 100).toFixed(1)}%`);
}

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
    ` in ${metricLabel(state.metric).toLowerCase()} at a ${head.threshold ?? 2}% threshold. `,
    el('span', { class: 'commits' }, commitLink(base), ' to ', commitLink(head), head.subject ? ` · ${head.subject}` : ''),
  );
  const nodes = [summary, description(state.metric)];
  if (outcome.envChanged) {
    nodes.push(el('p', { class: 'notice' }, `The measurement environment changed between these runs, from "${base.env_key}" to "${head.env_key}". Differences may come from the toolchain.`));
  }
  if (!shown.length) {
    nodes.push(el('p', { class: 'message' }, rows.length ? 'Nothing moved above the threshold. Enable "Show unchanged" to list every benchmark.' : 'No benchmark matches the filter.'));
  } else {
    const body = el('tbody');
    for (const row of shown) {
      body.append(el('tr', onActivate(() => showHistory(row.id)),
        el('td', { class: 'mono' }, row.id),
        el('td', { class: 'number' }, format(row.base, state.metric)),
        el('td', { class: 'number' }, format(row.head, state.metric)),
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
  const reported = new Set();
  for (const run of runs) for (const [id, measures] of Object.entries(run.results)) if (state.metric in measures) reported.add(id);
  const line = (id, name = '', slot = 0) => ({ name, slot, points: series(runs, id, state.metric) });
  const options = { runs, first, format: value => format(value, state.metric) };
  const nodes = [description(state.metric)];
  // A benchmark measured for several variants gets one chart with a line per variant.
  const tags = Object.assign({}, ...runs.map(run => run.variants));
  const groups = versusGroups(tags);
  const slot = variantSlots(groups);
  for (const group of groups) {
    const charts = group.benchmarks
      .filter(benchmark => Object.values(benchmark.ids).some(id => reported.has(id)) && matches(benchmark.name, ...Object.values(benchmark.ids)))
      .map(benchmark => chart({ ...options, title: benchmark.name, series: group.variants.filter(variant => reported.has(benchmark.ids[variant])).map(variant => line(benchmark.ids[variant], variant, slot(variant))) }));
    if (charts.length) nodes.push(el('h2', {}, group.name), el('div', { class: 'charts' }, ...charts));
  }
  const ids = [...reported].filter(id => !(id in tags) && matches(id));
  for (const [group, members] of groupIds(ids)) {
    nodes.push(el('h2', {}, group));
    nodes.push(el('div', { class: 'charts' }, ...members.map(id => chart({ ...options, title: id === group ? id : id.slice(group.length + 1), series: [line(id)] }))));
  }
  if (nodes.length === 1) nodes.push(el('p', { class: 'message' }, 'No benchmark matches the filter.'));
  content.replaceChildren(...nodes);
}

const WIDTH = 300, HEIGHT = 96, PAD = { top: 6, right: 6, bottom: 6, left: 58 };

/**
 * A line per series over `runs`. A series is `{ name, slot, points }`; a lone
 * series has no name and needs no legend. `parity` keeps 1 on the axis.
 */
function chart({ title, series, runs, first, format, parity = false, caption = '', tile = false }) {
  const values = series.flatMap(line => line.points.map(point => point.value));
  if (parity) values.push(1);
  let low = Math.min(...values), high = Math.max(...values);
  // Keep run-to-run noise flat: the axis always spans at least 10% of the largest value.
  const slack = (Math.abs(high) * 0.1 || 1) - (high - low);
  if (slack > 0) { low -= slack / 2; high += slack / 2; }
  const x = position => PAD.left + (runs.length === 1 ? 0.5 : position / (runs.length - 1)) * (WIDTH - PAD.left - PAD.right);
  const y = value => PAD.top + (1 - (value - low) / (high - low)) * (HEIGHT - PAD.top - PAD.bottom);
  const positions = [...new Set(series.flatMap(line => line.points.map(point => point.index)))].sort((a, b) => a - b);

  const root = svg('svg', { viewBox: `0 0 ${WIDTH} ${HEIGHT}`, role: 'img', tabindex: '0', 'aria-label': `${title} over ${positions.length} runs` });
  const levels = [high, low];
  // The parity line gets its own label only where it cannot collide with the ends.
  if (parity && Math.min(y(1) - y(high), y(low) - y(1)) > 12) levels.push(1);
  for (const value of levels) {
    root.append(svg('line', { class: value === 1 && parity ? 'grid parity' : 'grid', x1: PAD.left, x2: WIDTH - PAD.right, y1: y(value), y2: y(value) }));
    const label = svg('text', { x: PAD.left - 6, y: y(value) + 3, 'text-anchor': 'end' });
    label.textContent = format(value);
    root.append(label);
  }
  // A short tick marks a run measured in a new environment, where a step is expected.
  runs.forEach((run, position) => {
    if (position > 0 && run.env_key !== runs[position - 1].env_key) {
      root.append(svg('line', { class: 'env', x1: x(position), x2: x(position), y1: HEIGHT - PAD.bottom, y2: HEIGHT - PAD.bottom + 5 }));
    }
  });
  const color = line => `var(--series-${line.slot + 1})`;
  const dots = series.map(line => {
    root.append(svg('path', { class: 'line', style: `stroke: ${color(line)}`, d: line.points.map((point, order) => `${order ? 'L' : 'M'}${x(point.index).toFixed(1)},${y(point.value).toFixed(1)}`).join('') }));
    const lone = line.points.length === 1;
    return svg('circle', { class: 'dot', style: `fill: ${color(line)}`, r: 4, cx: x(line.points[0].index), cy: y(line.points[0].value), visibility: lone ? 'visible' : 'hidden' });
  });
  const cross = svg('line', { class: 'cross', y1: PAD.top, y2: HEIGHT - PAD.bottom, visibility: 'hidden' });
  root.append(cross, ...dots);

  let active = -1;
  const show = (order, clientX, clientY) => {
    active = order;
    const position = positions[order], run = runs[position];
    cross.setAttribute('x1', x(position)); cross.setAttribute('x2', x(position)); cross.setAttribute('visibility', 'visible');
    const entries = series.map((line, number) => {
      const at = line.points.findIndex(point => point.index === position);
      dots[number].setAttribute('visibility', at < 0 ? 'hidden' : 'visible');
      if (at < 0) return null;
      const point = line.points[at], previous = line.points[at - 1];
      dots[number].setAttribute('cx', x(position)); dots[number].setAttribute('cy', y(point.value));
      return el('span', { class: 'entry' }, line.name && swatch(line.slot), line.name && `${line.name} `,
        el('b', {}, format(point.value)), previous && previous.value !== 0 ? `  ${formatDelta(point.value / previous.value - 1)}` : '');
    });
    const environment = position > 0 && run.env_key !== runs[position - 1].env_key;
    tooltip.replaceChildren(...[
      el('strong', {}, `${dateLabel(run.time)} · ${shortSha(run.commit)}`),
      ...entries,
      run.subject && el('span', {}, run.subject),
      environment && el('span', {}, `New environment: ${run.env_key}`),
    ].filter(Boolean));
    tooltip.hidden = false;
    const box = tooltip.getBoundingClientRect();
    tooltip.style.left = `${Math.min(clientX + 14, innerWidth - box.width - 8)}px`;
    tooltip.style.top = `${Math.max(8, clientY - box.height - 12)}px`;
  };
  const hide = () => {
    active = -1; cross.setAttribute('visibility', 'hidden'); tooltip.hidden = true;
    dots.forEach((dot, number) => { if (series[number].points.length > 1) dot.setAttribute('visibility', 'hidden'); });
  };
  const nearest = event => {
    const box = root.getBoundingClientRect();
    const target = (event.clientX - box.left) / box.width * WIDTH;
    let best = 0;
    positions.forEach((position, order) => { if (Math.abs(x(position) - target) < Math.abs(x(positions[best]) - target)) best = order; });
    return best;
  };
  const open = order => {
    if (order < 0) return;
    const position = first + positions[order];
    if (position === 0) return;
    state.view = 'compare'; state.head = position; state.base = position - 1;
    hide(); render();
  };
  const anchor = order => {
    const box = root.getBoundingClientRect();
    return [box.left + x(positions[order]) / WIDTH * box.width, box.top];
  };
  root.addEventListener('pointermove', event => show(nearest(event), event.clientX, event.clientY));
  root.addEventListener('pointerleave', hide);
  root.addEventListener('click', event => open(nearest(event)));
  root.addEventListener('blur', hide);
  root.addEventListener('keydown', event => {
    if (event.key === 'Enter') return open(active);
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const order = Math.min(positions.length - 1, Math.max(0, active < 0 ? positions.length - 1 : active + (event.key === 'ArrowRight' ? 1 : -1)));
    show(order, ...anchor(order));
  });

  const latest = series.flatMap(line => {
    const last = line.points.at(-1), start = line.points[0];
    const value = el('span', { class: 'mono' }, format(last.value));
    const drift = series.length === 1 && line.points.length > 1 && start.value !== 0 ? `${formatDelta(last.value / start.value - 1)} over ${line.points.length} runs` : '';
    return [line.name ? el('span', {}, swatch(line.slot), value, ` ${line.name}`) : value, drift];
  });
  return el('article', { class: tile ? 'chart tile' : 'chart' },
    el('h3', {}, title), el('p', { class: 'latest' }, ...latest), caption && el('p', { class: 'caption' }, caption), root);
}

async function render() {
  for (const button of document.querySelectorAll('nav button')) {
    if (button.dataset.view === state.view) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  }
  for (const label of document.querySelectorAll('#filters [data-for]')) label.hidden = !label.dataset.for.split(' ').includes(state.view);
  // A chart click moves the compared runs without touching the controls.
  $('base').value = state.base;
  $('head').value = state.head;
  persist();
  content.style.opacity = '0.5';
  try {
    await { versus: renderVersus, compare: renderCompare, history: renderHistory }[state.view]();
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
  if (!state.view) {
    const variants = await loadRun(state.head).then(run => run.variants, () => null);
    state.view = variants && Object.keys(variants).length ? 'versus' : 'compare';
  }

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
