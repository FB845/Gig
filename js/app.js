// app.js — UI wiring for the Gig Tracker.
import * as store from './store.js';
import * as charts from './charts.js';
import { csvToShifts, extractFromText } from './parse.js';
import { recognize, ocrAvailable } from './ocr.js';
import { DriveTracker } from './geo.js';

const { PLATFORMS, EXPENSE_CATEGORIES } = store;
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  period: 'month',
  logMode: 'shift',
  editShiftId: null,
  editExpenseId: null,
  editIncomeId: null,
};

// ---------- money / format helpers ----------
const fmtMoney = (n, dp = 2) => (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
const fmtMoney0 = (n) => fmtMoney(n, 0);
const fmt1 = (n) => (Math.round(n * 10) / 10).toLocaleString();
const platColor = (p) => (PLATFORMS[p] || PLATFORMS.other).color;
const platLabel = (p) => (PLATFORMS[p] || PLATFORMS.other).label;

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), 2400);
}

function friendlyDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}
function dayOfWeek(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).getDay();
}

// =====================================================================
// Navigation
// =====================================================================
function showView(name) {
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  $$('.tab, .snav').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
  window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
  if (name === 'dashboard') renderDashboard();
  if (name === 'trends') renderTrends();
  if (name === 'log') renderLogList();
  if (name === 'campaign') renderCampaign();
}

$$('.tab, .snav').forEach((t) => t.addEventListener('click', () => showView(t.dataset.view)));

$$('#period-pills .pill').forEach((p) => p.addEventListener('click', () => {
  state.period = p.dataset.period;
  $$('#period-pills .pill').forEach((x) => x.classList.toggle('active', x === p));
  renderDashboard();
}));

// =====================================================================
// Dashboard
// =====================================================================
function currentRange() { return store.rangeFor(state.period); }

function renderDashboard() {
  const { from, to } = currentRange();
  const shifts = store.inRange(store.getShifts(), from, to);
  const expenses = store.inRange(store.getExpenses(), from, to);
  const s = store.summarize(shifts, expenses);

  // KPIs (with LED count-up + sparklines on desktop)
  const spark = dailyMetricSeries(14);
  const kpis = [
    { label: 'Net income', jp: '純利益', target: s.net, fmt: 'money0', sub: `${fmtMoney0(s.income)} in · ${fmtMoney0(s.expenseTotal)} out`, cls: s.net >= 0 ? 'accent' : 'neg', series: spark.net, color: '#34d399' },
    { label: '$ / hour', jp: '時給', target: s.perHour, fmt: 'money2', empty: !s.hours, sub: `${fmt1(s.hours)} hrs worked`, series: spark.perHour, color: '#60a5fa' },
    { label: '$ / mile', jp: '距離単価', target: s.perMile, fmt: 'money2', empty: !s.miles, sub: `${fmt1(s.miles)} mi driven`, series: spark.perMile, color: '#a78bfa' },
    { label: 'Per delivery', jp: '配達単価', target: s.perJob, fmt: 'money2', empty: !s.jobs, sub: `${s.jobs} deliveries`, series: spark.perJob, color: '#f5a524' },
  ];
  $('#kpi-grid').innerHTML = kpis.map((k) => `
    <div class="kpi ${k.cls || ''}">
      <div class="k-label">${k.label}<span class="jp">${k.jp}</span></div>
      <div class="k-value"${k.empty ? '' : ` data-count="${k.target}" data-fmt="${k.fmt}"`}>${k.empty ? '—' : fmtByType(k.fmt, k.target)}</div>
      <div class="k-sub">${k.sub}</div>
      <div class="k-spark">${sparkline(k.series, k.color)}</div>
    </div>`).join('');
  animateCounts($('#kpi-grid'));

  // Tax set-aside card
  const rate = Math.round(store.getSettings().taxRate * 100);
  $('#tax-card').innerHTML = `
    <div class="tax-main">
      <div class="tax-label">Set aside for taxes (${rate}%)</div>
      <div class="tax-val">${fmtMoney0(s.taxSetAside)}</div>
      <div class="tax-sub">on ${fmtMoney0(s.taxableEstimate)} taxable · after ${fmtMoney0(Math.max(s.expenseTotal, s.mileageDeduction))} deduction</div>
    </div>
    <div class="tax-take">
      <div class="tt-val">${fmtMoney0(s.takeHomeAfterTax)}</div>
      <div class="tt-label">est. take-home</div>
    </div>`;

  // Flex block efficiency: actual vs scheduled time
  const feCard = $('#flex-eff-card');
  if (s.schedPlanned > 0) {
    const pct = s.actualVsScheduledPct;
    const over = pct > 100.5;
    const trend = pct > 100.5 ? 'ran over' : pct < 99.5 ? 'finished early' : 'right on time';
    feCard.classList.remove('hidden');
    feCard.innerHTML = `
      <div class="fe-head">
        <span class="fe-title">Flex block time used</span>
        <span class="fe-pct ${over ? 'over' : ''}">${Math.round(pct)}%</span>
      </div>
      <div class="fe-bar"><span class="${over ? 'over' : ''}" style="width:${Math.min(100, pct)}%"></span></div>
      <div class="fe-sub">${fmt1(s.schedActual)} h actual of ${fmt1(s.schedPlanned)} h scheduled · ${s.schedShiftCount} block${s.schedShiftCount !== 1 ? 's' : ''} · ${trend} on average</div>`;
  } else {
    feCard.classList.add('hidden');
  }

  renderTicker(s);
  renderRouteStrip();

  renderEarningsChart(shifts);
  renderPlatformDonut(shifts);
  renderExpensesDonut(expenses);
  renderRecentShifts(store.getShifts().slice(0, 6));
}

// ---- desktop train-infotainment graphics ----
const isDesktop = () => window.matchMedia('(min-width: 960px)').matches;
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function fmtByType(fmt, v) { return fmt === 'money0' ? fmtMoney0(v) : fmtMoney(v); }

// Count each value up from 0 to its target on desktop (LED-board feel).
function animateCounts(root) {
  const els = $$('.k-value[data-count]', root);
  if (!isDesktop() || reducedMotion()) return; // mobile keeps the final value, no motion
  for (const el of els) {
    const target = parseFloat(el.dataset.count) || 0;
    const fmt = el.dataset.fmt;
    const dur = 650, t0 = performance.now();
    const tick = (now) => {
      const p = Math.min(1, (now - t0) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      el.textContent = fmtByType(fmt, target * eased);
      if (p < 1) requestAnimationFrame(tick);
      else el.textContent = fmtByType(fmt, target);
    };
    requestAnimationFrame(tick);
  }
}

// Daily series for the last N days, per KPI metric (for sparklines).
function dailyMetricSeries(days) {
  const map = new Map();
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    map.set(store.isoDate(d), { income: 0, expense: 0, hours: 0, miles: 0, jobs: 0 });
  }
  store.getShifts().forEach((sh) => {
    const o = map.get(sh.date); if (!o) return;
    o.income += store.shiftIncome(sh); o.hours += sh.hours; o.miles += sh.miles; o.jobs += sh.jobs;
  });
  store.getExpenses().forEach((e) => { const o = map.get(e.date); if (o) o.expense += e.amount; });
  const rows = [...map.values()];
  return {
    net: rows.map((r) => r.income - r.expense),
    perHour: rows.map((r) => (r.hours ? r.income / r.hours : 0)),
    perMile: rows.map((r) => (r.miles ? r.income / r.miles : 0)),
    perJob: rows.map((r) => (r.jobs ? r.income / r.jobs : 0)),
  };
}

function sparkline(vals, color) {
  if (!vals || vals.length < 2 || vals.every((v) => !v)) return '';
  const w = 120, h = 30, max = Math.max(...vals), min = Math.min(...vals), rng = (max - min) || 1;
  const x = (i) => (i / (vals.length - 1)) * w;
  const y = (v) => h - 3 - ((v - min) / rng) * (h - 6);
  const pts = vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = `0,${h} ${pts} ${w},${h}`;
  return `<svg viewBox="0 0 ${w} ${h}" class="spark" preserveAspectRatio="none">
    <polygon points="${area}" fill="${color}" fill-opacity="0.10"/>
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${x(vals.length - 1).toFixed(1)}" cy="${y(vals[vals.length - 1]).toFixed(1)}" r="2.6" fill="${color}"/>
  </svg>`;
}

function renderTicker(s) {
  const track = $('#ticker-track');
  if (!track) return;
  const chip = (jp, val) => `<span class="tk">${jp} <b>${val}</b></span>`;
  const items = [
    chip('純利益', fmtMoney0(s.net)),
    chip('時給', s.perHour ? fmtMoney(s.perHour) : '—'),
    chip('距離単価', s.perMile ? fmtMoney(s.perMile) : '—'),
    chip('走行距離', fmt1(s.miles) + ' mi'),
    chip('配達数', String(s.jobs)),
    chip('税金積立', fmtMoney0(s.taxSetAside)),
    chip('手取り', fmtMoney0(s.takeHomeAfterTax)),
    chip('運行数', String(s.shiftCount)),
  ];
  const line = `<span class="live">● 運行中</span>` + items.join('<span class="sep">・</span>') + '<span class="sep">・</span>';
  track.innerHTML = line + line; // doubled for seamless marquee loop
}

// Flex block tags styled as JR train types (種別). `ink` is the text color used
// when the type color fills a solid badge.
const TRAIN_TYPES = {
  'Local': { label: '普通', romaji: 'LOCAL', color: '#c9ced8', ink: '#14130f' },
  'Rapid': { label: '快速', romaji: 'RAPID', color: 'var(--jr-blue)', ink: '#fff' },
  'Express': { label: '急行', romaji: 'EXP', color: 'var(--jr-orange)', ink: '#fff' },
  'Rapid Express': { label: '特急', romaji: 'LTD.EXP', color: 'var(--jr-red)', ink: '#fff' },
};
function trainType(shift) {
  return (shift.tag && TRAIN_TYPES[shift.tag]) || { label: '普通', romaji: 'LOCAL', color: '#c9ced8', ink: '#14130f' };
}
// A solid 種別-style badge for a Flex tag, reused wherever a tag is displayed.
function typeBadge(tag) {
  const ty = TRAIN_TYPES[tag];
  if (!ty) return '';
  return `<span class="type-badge" style="--tc:${ty.color};--ink:${ty.ink}">${ty.label}<em>${ty.romaji}</em></span>`;
}
// The rollsign panel shows the selected date range (not a train type).
const PERIOD_TYPE = {
  week: { label: '週間', romaji: 'WEEKLY' },
  month: { label: '月間', romaji: 'MONTHLY' },
  year: { label: '年間', romaji: 'YEARLY' },
  all: { label: '全期間', romaji: 'ALL' },
};

// The signature graphic: earnings rendered as a JR-style line map, with a
// 方向幕 (rollsign) header and numbered stations.
function renderRouteStrip() {
  const host = $('#route-strip');
  if (!host) return;
  const ty = PERIOD_TYPE[state.period] || PERIOD_TYPE.all;
  const rollsign = `
    <div class="rollsign">
      <span class="rs-type" style="--tc:var(--accent)">${ty.label}<em>${ty.romaji}</em></span>
      <span class="rs-dest"><b>ギグライン</b><small>GIG&nbsp;LINE</small></span>
      <span class="rs-total" id="rs-total"></span>
    </div>`;

  // Fewer stations on a narrow (phone) layout so labels stay legible.
  const cap = isDesktop() ? 12 : 7;
  const stops = routeStops(cap);
  // Total mirrors the KPI income for the selected range (rollsign == dashboard).
  const { from, to } = currentRange();
  const total = store.inRange(store.getShifts(), from, to).reduce((a, s) => a + store.shiftIncome(s), 0);
  if (!stops.length || total <= 0) {
    host.innerHTML = rollsign + '<div class="chart-empty">運行実績なし — シフトを記録してください</div>';
    return;
  }
  // Size the viewBox to the actual pixel width so SVG text renders ~1:1 (i.e.
  // stays readable) on both phone and desktop rather than scaling tiny.
  const W = Math.max(300, (host.clientWidth || 1000) - 32);
  const H = 150, y = 84, padX = Math.min(48, W * 0.08);
  const max = Math.max(1, ...stops.map((s) => s.value));
  const step = stops.length > 1 ? (W - padX * 2) / (stops.length - 1) : 0;
  const cx = (i) => padX + i * step;
  const rFor = (v) => 6 + (v / max) * 12;
  const lastIdx = stops.length - 1;
  const line = 'var(--jr-green)';

  let svg = `<svg class="route-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">`;
  svg += `<line class="rline" x1="${cx(0)}" y1="${y}" x2="${cx(lastIdx)}" y2="${y}" style="stroke:${line}"/>`;
  stops.forEach((st, i) => {
    const r = st.value > 0 ? rFor(st.value) : 6;
    // JR line-map station: colored dot with a dark centre; ring marks "now"
    if (st.now) svg += `<circle class="now-ring" cx="${cx(i)}" cy="${y}" r="${r + 4}" style="stroke:${line}"/>`;
    svg += `<circle cx="${cx(i)}" cy="${y}" r="${r}" style="fill:${line}"/>`;
    svg += `<circle cx="${cx(i)}" cy="${y}" r="${Math.max(2, r - 4)}" style="fill:#000"/>`;
    svg += `<text class="amt" x="${cx(i)}" y="${y - r - 11}" text-anchor="middle">${st.value ? fmtMoney0(st.value) : '—'}</text>`;
    svg += `<text class="stn" x="${cx(i)}" y="${y + 24}" text-anchor="middle">${String(i + 1).padStart(2, '0')}</text>`;
    svg += `<text class="day" x="${cx(i)}" y="${y + 40}" text-anchor="middle">${st.label}</text>`;
  });
  svg += '</svg>';

  host.innerHTML = rollsign + svg;
  $('#rs-total').textContent = `${fmtMoney0(total)}`;
}

// Build route-map stations for the SELECTED range so they line up with the
// KPIs (the stations sum to the range's income). Each stop: { label, value, now }.
function routeStops(cap = 12) {
  if (state.period === 'week') return weekDayStops();
  if (state.period === 'month') return monthWeekStops();
  if (state.period === 'year') return yearMonthStops(cap);
  return allMonthStops(cap); // all-time
}

// Days of the current week (from week-start); value = that day's income.
function weekDayStops() {
  const now = new Date();
  const start = store.startOfWeek(now);
  const todayISO = store.isoDate(now);
  const shifts = store.getShifts();
  const stops = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(start); d.setDate(d.getDate() + i);
    const iso = store.isoDate(d);
    const value = shifts.filter((s) => s.date === iso).reduce((a, s) => a + store.shiftIncome(s), 0);
    stops.push({
      label: d.toLocaleDateString(undefined, { weekday: 'narrow' }) + ' ' + (d.getMonth() + 1) + '/' + d.getDate(),
      value, now: iso === todayISO,
    });
  }
  return stops;
}

// Weeks of the current month up to the current week; each value counts only the
// days that fall inside the month, so the stations sum to the month's income.
function monthWeekStops() {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  const nowWs = store.startOfWeek(now);
  const nowWsISO = store.isoDate(nowWs);
  const shifts = store.getShifts();
  const stops = [];
  let ws = store.startOfWeek(first);
  while (ws <= nowWs) {
    const wStart = new Date(ws);
    const wEnd = new Date(ws); wEnd.setDate(wEnd.getDate() + 6);
    const labelDate = wStart < first ? first : wStart;
    const value = shifts.filter((s) => {
      const [yy, mm, dd] = s.date.split('-').map(Number);
      const sd = new Date(yy, mm - 1, dd);
      return sd >= wStart && sd <= wEnd && mm - 1 === now.getMonth() && yy === now.getFullYear();
    }).reduce((a, s) => a + store.shiftIncome(s), 0);
    stops.push({ label: `${labelDate.getMonth() + 1}/${labelDate.getDate()}`, value, now: store.isoDate(ws) === nowWsISO });
    ws = new Date(ws); ws.setDate(ws.getDate() + 7);
  }
  return stops;
}

// Months of the current year up to the current month.
function yearMonthStops(cap) {
  const now = new Date();
  const shifts = store.getShifts();
  const stops = [];
  for (let m = 0; m <= now.getMonth(); m++) {
    const key = `${now.getFullYear()}-${String(m + 1).padStart(2, '0')}`;
    const value = shifts.filter((s) => s.date.slice(0, 7) === key).reduce((a, s) => a + store.shiftIncome(s), 0);
    stops.push({ label: new Date(now.getFullYear(), m, 1).toLocaleDateString(undefined, { month: 'short' }), value, now: m === now.getMonth() });
  }
  return stops.slice(-cap);
}

// All-time by month (most recent `cap`); the last bucket is the current one.
function allMonthStops(cap) {
  const map = new Map();
  store.getShifts().forEach((s) => {
    const k = s.date.slice(0, 7);
    map.set(k, (map.get(k) || 0) + store.shiftIncome(s));
  });
  const entries = [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(-cap);
  return entries.map(([k, v], i) => ({ label: monthLabel(k), value: v, now: i === entries.length - 1 }));
}

function bucketByPeriod(shifts) {
  // choose bucket granularity based on selected period
  const gran = state.period === 'week' || state.period === 'month' ? 'day'
    : state.period === 'year' ? 'month' : 'month';
  const buckets = new Map(); // key -> {flex,doordash,other}
  for (const sh of shifts) {
    let key, label;
    if (gran === 'day') { key = sh.date; label = friendlyDate(sh.date).replace(/^[A-Za-z]+, /, ''); }
    else { key = sh.date.slice(0, 7); label = monthLabel(key); }
    if (!buckets.has(key)) buckets.set(key, { label, values: { flex: 0, doordash: 0, other: 0 } });
    buckets.get(key).values[sh.platform in PLATFORMS ? sh.platform : 'other'] += store.shiftIncome(sh);
  }
  return [...buckets.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map((e) => e[1]);
}

function monthLabel(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'short' });
}

function renderEarningsChart(shifts) {
  const data = bucketByPeriod(shifts);
  const series = [
    { key: 'flex', label: 'Amazon Flex', color: PLATFORMS.flex.color },
    { key: 'doordash', label: 'DoorDash', color: PLATFORMS.doordash.color },
    { key: 'other', label: 'Other', color: PLATFORMS.other.color },
  ];
  charts.barChart($('#chart-earnings'), data, series, { empty: 'Log a shift to see earnings here' });
  charts.legend($('#earn-legend'), series);
}

function renderPlatformDonut(shifts) {
  const totals = { flex: 0, doordash: 0, other: 0 };
  shifts.forEach((s) => { totals[s.platform in PLATFORMS ? s.platform : 'other'] += store.shiftIncome(s); });
  const slices = Object.keys(totals).map((k) => ({ label: PLATFORMS[k].label, value: totals[k], color: PLATFORMS[k].color }));
  charts.donutChart($('#chart-platform'), slices, { empty: 'No earnings yet' });
  charts.legend($('#platform-legend'), slices.filter((s) => s.value > 0));
}

const EXP_COLORS = ['#ef4444', '#f59e0b', '#34d399', '#60a5fa', '#a78bfa', '#f472b6', '#22d3ee', '#facc15', '#fb923c', '#94a3b8'];
const TAG_COLORS = { 'Local': '#9aa3b2', 'Rapid': '#009bbf', 'Express': '#f39800', 'Rapid Express': '#e60012' };
const TAG_SHORT = { 'Local': 'Local', 'Rapid': 'Rapid', 'Express': 'Express', 'Rapid Express': 'R.Exp' };
function renderExpensesDonut(expenses) {
  const byCat = new Map();
  expenses.forEach((e) => byCat.set(e.category, (byCat.get(e.category) || 0) + e.amount));
  const slices = [...byCat.entries()].map(([label, value], i) => ({ label, value, color: EXP_COLORS[i % EXP_COLORS.length] }));
  charts.donutChart($('#chart-expenses'), slices, { empty: 'No expenses logged' });
  charts.legend($('#expenses-legend'), slices);
}

function renderRecentShifts(shifts) {
  const list = $('#recent-shifts');
  if (!shifts.length) { list.innerHTML = '<li class="empty-list">No shifts yet — tap “Log” to add one.</li>'; return; }
  list.innerHTML = shifts.map((s) => recordRow(s, 'shift', false)).join('');
  renderDepartureBoard(shifts);
}

// Recent shifts as a JR LED departure board (発車標) on desktop.
function renderDepartureBoard(shifts) {
  const host = $('#departure-board');
  if (!host) return;
  if (!shifts.length) { host.innerHTML = '<div class="chart-empty">運行実績なし</div>'; return; }
  const depDate = (iso) => { const [, m, d] = iso.split('-').map(Number); return `${m}/${String(d).padStart(2, '0')}`; };
  const rows = shifts.map((s) => {
    const ty = trainType(s);
    const p = PLATFORMS[s.platform] || PLATFORMS.other;
    return `<div class="dep-row">
      <span class="dep-type" style="--tc:${ty.color}">${ty.label}<em>${ty.romaji}</em></span>
      <span class="dep-date">${depDate(s.date)}</span>
      <span class="dep-dest"><b>${p.jp}</b><small>${p.label}</small></span>
      <span class="dep-dist">${fmt1(s.miles)}<i>mi</i></span>
      <span class="dep-amt">${fmtMoney0(store.shiftIncome(s))}</span>
    </div>`;
  }).join('');
  host.innerHTML = `<div class="dep-headrow"><span>種別</span><span>日付</span><span>行先</span><span>距離</span><span>収入</span></div>${rows}`;
}

// =====================================================================
// Log view (forms + lists)
// =====================================================================
function initForms() {
  // segmented control
  $$('#log-segmented .seg').forEach((b) => b.addEventListener('click', () => {
    state.logMode = b.dataset.log;
    $$('#log-segmented .seg').forEach((x) => x.classList.toggle('active', x === b));
    $('#shift-form').classList.toggle('hidden', state.logMode !== 'shift');
    $('#expense-form').classList.toggle('hidden', state.logMode !== 'expense');
    $('#income-form').classList.toggle('hidden', state.logMode !== 'income');
    renderLogList();
  }));

  // platform chip groups (generic)
  bindChips('#shift-platform');
  bindChips('#expense-platform');
  bindChips('#ocr-platform');
  bindChips('#csv-platform');

  // Flex-specific: block-type tags + block-length presets, shown only for Flex
  bindChips('#shift-tag');
  $('#shift-platform').addEventListener('click', (e) => { if (e.target.closest('.chip')) updateFlexUI(); });
  bindBlockPresets();
  updateFlexUI();

  // expense categories
  $('#expense-category').innerHTML = EXPENSE_CATEGORIES.map((c) => `<option value="${c}">${c}</option>`).join('');

  // default dates
  $('#shift-form [name=date]').value = store.todayISO();
  $('#expense-form [name=date]').value = store.todayISO();
  $('#income-form [name=date]').value = store.todayISO();

  // live metrics on shift form
  ['gross', 'tips', 'hours', 'miles', 'jobs'].forEach((n) => {
    $(`#shift-form [name=${n}]`).addEventListener('input', updateShiftLive);
  });
  updateShiftLive();

  $('#shift-form').addEventListener('submit', onSaveShift);
  $('#expense-form').addEventListener('submit', onSaveExpense);
  $('#income-form').addEventListener('submit', onSaveIncome);
  $('#shift-reset').addEventListener('click', () => resetShiftForm());
  $('#expense-reset').addEventListener('click', () => resetExpenseForm());
  $('#income-reset').addEventListener('click', () => resetIncomeForm());
  $('#camp-add-income').addEventListener('click', () => { openIncomeForm(); });
}

function bindChips(sel) {
  const group = $(sel);
  if (!group) return;
  $$('.chip', group).forEach((c) => c.addEventListener('click', () => {
    $$('.chip', group).forEach((x) => x.classList.toggle('active', x === c));
  }));
}
function chipValue(sel) {
  const active = $(`${sel} .chip.active`);
  return active ? active.dataset.val : '';
}
function setChip(sel, val) {
  $$(`${sel} .chip`).forEach((c) => c.classList.toggle('active', c.dataset.val === val));
}

// Show/hide the Flex-only fields and adapt the hours label to the platform.
function updateFlexUI() {
  const isFlex = chipValue('#shift-platform') === 'flex';
  $$('#shift-form .flex-only').forEach((el) => el.classList.toggle('hidden', !isFlex));
  $('#hours-label').textContent = isFlex ? 'Actual time worked' : 'Hours worked';
  updateShiftLive();
}

function bindBlockPresets() {
  const group = $('#shift-blockpreset');
  const custom = $('#shift-scheduled-custom');
  $$('.chip', group).forEach((c) => c.addEventListener('click', () => {
    $$('.chip', group).forEach((x) => x.classList.toggle('active', x === c));
    const isCustom = c.dataset.val === 'custom';
    custom.classList.toggle('hidden', !isCustom);
    if (isCustom) { custom.focus(); }
    else {
      const f = $('#shift-form');
      if (!f.hours.value) f.hours.value = c.dataset.val; // prefill actual = scheduled
    }
    updateShiftLive();
  }));
  custom.addEventListener('input', updateShiftLive);
}

// Currently selected scheduled block length (hours), 0 if none.
function getScheduledHours() {
  const active = $('#shift-blockpreset .chip.active');
  if (!active) return 0;
  if (active.dataset.val === 'custom') return parseFloat($('#shift-scheduled-custom').value) || 0;
  return parseFloat(active.dataset.val) || 0;
}

// Reflect a stored scheduledHours value back onto the preset chips (used on edit).
function setBlockPreset(scheduledHours) {
  const custom = $('#shift-scheduled-custom');
  $$('#shift-blockpreset .chip').forEach((c) => c.classList.remove('active'));
  custom.classList.add('hidden'); custom.value = '';
  if (!scheduledHours) return;
  const match = $$('#shift-blockpreset .chip').find((c) => c.dataset.val !== 'custom' && parseFloat(c.dataset.val) === scheduledHours);
  if (match) { match.classList.add('active'); }
  else {
    $('#shift-blockpreset .chip[data-val="custom"]').classList.add('active');
    custom.classList.remove('hidden'); custom.value = scheduledHours;
  }
}

function updateShiftLive() {
  const f = $('#shift-form');
  const gross = +f.gross.value || 0, tips = +f.tips.value || 0, hours = +f.hours.value || 0;
  const miles = +f.miles.value || 0, jobs = +f.jobs.value || 0;
  const income = gross + tips;
  const rate = store.getSettings().mileageRate;
  const parts = [];
  parts.push(`<span class="lm">Income <b>${fmtMoney(income)}</b></span>`);
  if (hours) parts.push(`<span class="lm">$/hr <b>${fmtMoney(income / hours)}</b></span>`);
  if (miles) parts.push(`<span class="lm">$/mi <b>${fmtMoney(income / miles)}</b></span>`);
  if (jobs) parts.push(`<span class="lm">$/job <b>${fmtMoney(income / jobs)}</b></span>`);
  if (miles) parts.push(`<span class="lm">Tax mi-deduction <b>${fmtMoney(miles * rate)}</b></span>`);
  const sched = chipValue('#shift-platform') === 'flex' ? getScheduledHours() : 0;
  if (sched && hours) parts.push(`<span class="lm">Block time <b>${Math.round((hours / sched) * 100)}%</b></span>`);
  $('#shift-live').innerHTML = parts.join('');
}

function onSaveShift(e) {
  e.preventDefault();
  const f = e.target;
  const isFlex = chipValue('#shift-platform') === 'flex';
  const data = {
    platform: chipValue('#shift-platform') || 'other',
    date: f.date.value,
    hours: f.hours.value, gross: f.gross.value, tips: f.tips.value,
    jobs: f.jobs.value, miles: f.miles.value, fuel: f.fuel.value, notes: f.notes.value,
    scheduledHours: isFlex ? getScheduledHours() : 0,
    tag: isFlex ? chipValue('#shift-tag') : '',
  };
  if (!data.date) { toast('Pick a date'); return; }
  if (state.editShiftId) {
    store.updateShift(state.editShiftId, data);
    // fuel edit not linked-updated to keep it simple; inform user
    toast('Shift updated');
  } else {
    store.addShift(data);
    toast('Shift saved ✓');
  }
  resetShiftForm();
  renderLogList();
}

function onSaveExpense(e) {
  e.preventDefault();
  const f = e.target;
  const data = {
    date: f.date.value, amount: f.amount.value, category: f.category.value,
    platform: chipValue('#expense-platform'), note: f.note.value,
  };
  if (!data.date || !(+data.amount > 0)) { toast('Enter a date and amount'); return; }
  if (state.editExpenseId) { store.updateExpense(state.editExpenseId, data); toast('Expense updated'); }
  else { store.addExpense(data); toast('Expense saved ✓'); }
  resetExpenseForm();
  renderLogList();
}

function resetShiftForm() {
  const f = $('#shift-form');
  f.reset();
  f.date.value = store.todayISO();
  setChip('#shift-platform', 'flex');
  setChip('#shift-tag', '');
  setBlockPreset(0);
  state.editShiftId = null;
  $('#shift-form-title').textContent = 'Log a shift';
  $('#shift-submit').textContent = 'Save shift';
  updateFlexUI();
}
function resetExpenseForm() {
  const f = $('#expense-form');
  f.reset();
  f.date.value = store.todayISO();
  setChip('#expense-platform', '');
  state.editExpenseId = null;
  $('#expense-form-title').textContent = 'Log an expense';
  $('#expense-submit').textContent = 'Save expense';
}

function editShift(id) {
  const s = store.getShifts().find((x) => x.id === id);
  if (!s) return;
  state.logMode = 'shift';
  $$('#log-segmented .seg').forEach((x) => x.classList.toggle('active', x.dataset.log === 'shift'));
  $('#shift-form').classList.remove('hidden');
  $('#expense-form').classList.add('hidden');
  const f = $('#shift-form');
  setChip('#shift-platform', s.platform);
  setChip('#shift-tag', s.tag || '');
  setBlockPreset(s.scheduledHours || 0);
  f.date.value = s.date; f.hours.value = s.hours || ''; f.gross.value = s.gross || '';
  f.tips.value = s.tips || ''; f.jobs.value = s.jobs || ''; f.miles.value = s.miles || '';
  f.fuel.value = ''; f.notes.value = s.notes || '';
  state.editShiftId = id;
  $('#shift-form-title').textContent = 'Edit shift';
  $('#shift-submit').textContent = 'Update shift';
  updateFlexUI();
  showView('log');
  f.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function onSaveIncome(e) {
  e.preventDefault();
  const f = e.target;
  const data = { date: f.date.value, amount: f.amount.value, source: f.source.value, note: f.note.value };
  if (!data.date || !(+data.amount > 0)) { toast('Enter a date and amount'); return; }
  if (!data.source.trim()) { toast('Enter a source'); return; }
  if (state.editIncomeId) { store.updateIncome(state.editIncomeId, data); toast('Income updated'); }
  else { store.addIncome(data); toast('Income saved ✓'); }
  resetIncomeForm();
  renderLogList();
}

function resetIncomeForm() {
  const f = $('#income-form');
  f.reset();
  f.date.value = store.todayISO();
  state.editIncomeId = null;
  $('#income-form-title').textContent = 'Log income';
  $('#income-submit').textContent = 'Save income';
}

// Jump to the Log view's Income segment (used by the Campaign "+ Income" button).
function openIncomeForm() {
  state.logMode = 'income';
  $$('#log-segmented .seg').forEach((x) => x.classList.toggle('active', x.dataset.log === 'income'));
  $('#shift-form').classList.add('hidden');
  $('#expense-form').classList.add('hidden');
  $('#income-form').classList.remove('hidden');
  renderLogList();
  showView('log');
  $('#income-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function editIncome(id) {
  const inc = store.getIncomes().find((x) => x.id === id);
  if (!inc) return;
  openIncomeForm();
  const f = $('#income-form');
  f.date.value = inc.date; f.amount.value = inc.amount; f.source.value = inc.source; f.note.value = inc.note || '';
  state.editIncomeId = id;
  $('#income-form-title').textContent = 'Edit income';
  $('#income-submit').textContent = 'Update income';
}

function editExpense(id) {
  const ex = store.getExpenses().find((x) => x.id === id);
  if (!ex) return;
  state.logMode = 'expense';
  $$('#log-segmented .seg').forEach((x) => x.classList.toggle('active', x.dataset.log === 'expense'));
  $('#expense-form').classList.remove('hidden');
  $('#shift-form').classList.add('hidden');
  const f = $('#expense-form');
  f.date.value = ex.date; f.amount.value = ex.amount; f.category.value = ex.category;
  f.note.value = ex.note || ''; setChip('#expense-platform', ex.platform || '');
  state.editExpenseId = id;
  $('#expense-form-title').textContent = 'Edit expense';
  $('#expense-submit').textContent = 'Update expense';
  showView('log');
  f.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function recordRow(item, type, deletable = true) {
  if (type === 'shift') {
    const income = store.shiftIncome(item);
    const bits = [platLabel(item.platform)];
    if (item.scheduledHours) {
      const pct = item.hours ? Math.round((item.hours / item.scheduledHours) * 100) : null;
      bits.push(`${fmt1(item.hours)}/${fmt1(item.scheduledHours)}h${pct != null ? ` (${pct}%)` : ''}`);
    } else if (item.hours) {
      bits.push(`${fmt1(item.hours)}h`);
    }
    if (item.jobs) bits.push(`${item.jobs} jobs`);
    if (item.miles) bits.push(`${fmt1(item.miles)} mi`);
    return `<li class="record" data-id="${item.id}" data-type="shift">
      <span class="rec-badge" style="background:${platColor(item.platform)}"></span>
      <div class="rec-main">
        <div class="rec-title">${friendlyDate(item.date)}${item.tag ? ' ' + typeBadge(item.tag) : ''}</div>
        <div class="rec-sub">${bits.join(' · ')}${item.notes ? ' · ' + escapeHtml(item.notes) : ''}</div>
      </div>
      <div class="rec-amount">${fmtMoney(income)}</div>
      ${deletable ? `<button class="rec-del" data-del="shift" data-id="${item.id}" aria-label="Delete">✕</button>` : ''}
    </li>`;
  }
  if (type === 'trip') {
    const dep = item.miles * store.getSettings().mileageRate;
    const dur = item.durationMs ? `${Math.round(item.durationMs / 60000)} min` : '';
    return `<li class="record" data-id="${item.id}" data-type="trip">
      <span class="rec-badge" style="background:#22d3ee"></span>
      <div class="rec-main">
        <div class="rec-title">${fmt1(item.miles)} mi drive</div>
        <div class="rec-sub">${friendlyDate(item.date)}${dur ? ' · ' + dur : ''} · ${fmtMoney(dep)} tax deduction</div>
      </div>
      <div class="rec-amount">${fmt1(item.miles)} mi</div>
      ${deletable ? `<button class="rec-del" data-del="trip" data-id="${item.id}" aria-label="Delete">✕</button>` : ''}
    </li>`;
  }
  if (type === 'income') {
    return `<li class="record" data-id="${item.id}" data-type="income">
      <span class="rec-badge" style="background:#f5a524"></span>
      <div class="rec-main">
        <div class="rec-title">${escapeHtml(item.source)}</div>
        <div class="rec-sub">${friendlyDate(item.date)} · manual${item.note ? ' · ' + escapeHtml(item.note) : ''}</div>
      </div>
      <div class="rec-amount">${fmtMoney(item.amount)}</div>
      ${deletable ? `<button class="rec-del" data-del="income" data-id="${item.id}" aria-label="Delete">✕</button>` : ''}
    </li>`;
  }
  return `<li class="record" data-id="${item.id}" data-type="expense">
    <span class="rec-badge" style="background:${item.platform ? platColor(item.platform) : '#64748b'}"></span>
    <div class="rec-main">
      <div class="rec-title">${item.category}</div>
      <div class="rec-sub">${friendlyDate(item.date)}${item.note ? ' · ' + escapeHtml(item.note) : ''}${item.platform ? ' · ' + PLATFORMS[item.platform].short : ''}</div>
    </div>
    <div class="rec-amount neg">-${fmtMoney(item.amount)}</div>
    ${deletable ? `<button class="rec-del" data-del="expense" data-id="${item.id}" aria-label="Delete">✕</button>` : ''}
  </li>`;
}

function renderLogList() {
  const list = $('#log-list');
  if (state.logMode === 'shift') {
    $('#log-list-title').textContent = 'All shifts';
    const shifts = store.getShifts();
    list.innerHTML = shifts.length ? shifts.map((s) => recordRow(s, 'shift')).join('')
      : '<li class="empty-list">No shifts logged yet.</li>';
  } else if (state.logMode === 'expense') {
    $('#log-list-title').textContent = 'All expenses';
    const exp = store.getExpenses();
    list.innerHTML = exp.length ? exp.map((e) => recordRow(e, 'expense')).join('')
      : '<li class="empty-list">No expenses logged yet.</li>';
  } else if (state.logMode === 'income') {
    $('#log-list-title').textContent = 'Manual income';
    const inc = store.getIncomes();
    list.innerHTML = inc.length ? inc.map((i) => recordRow(i, 'income')).join('')
      : '<li class="empty-list">No manual income yet — for TraceHaus invoices etc.</li>';
  } else {
    $('#log-list-title').textContent = 'GPS mileage log';
    const trips = store.getTrips();
    list.innerHTML = trips.length ? trips.map((t) => recordRow(t, 'trip')).join('')
      : '<li class="empty-list">No tracked drives yet — tap “Start drive” on Home.</li>';
  }
}

// event delegation for lists (edit on row, delete on ✕)
document.addEventListener('click', (e) => {
  const del = e.target.closest('[data-del]');
  if (del) {
    e.stopPropagation();
    const { del: type, id } = del.dataset;
    if (!confirm('Delete this entry?')) return;
    if (type === 'shift') store.deleteShift(id);
    else if (type === 'expense') store.deleteExpense(id);
    else if (type === 'income') store.deleteIncome(id);
    else store.deleteTrip(id);
    toast('Deleted');
    renderLogList(); renderDashboard(); renderCampaign();
    return;
  }
  const row = e.target.closest('.record[data-type]');
  if (row && row.closest('#log-list')) {
    if (row.dataset.type === 'shift') editShift(row.dataset.id);
    else if (row.dataset.type === 'expense') editExpense(row.dataset.id);
    else if (row.dataset.type === 'income') editIncome(row.dataset.id);
    // trips are read-only records; no edit
  }
});

// =====================================================================
// Campaign 350
// =====================================================================
function renderCampaign() {
  if (!$('#view-campaign')) return;
  const c = store.campaignStats();

  // Hero — today's hit/miss (the "did I hit the block" call)
  const st = c.todayHit ? 'is-hit' : (c.todayTotal > 0 ? 'is-part' : 'is-none');
  const label = c.todayHit ? 'HIT' : (c.todayTotal > 0 ? 'IN PROGRESS' : 'NO EARNINGS YET');
  const jp = c.todayHit ? '達成' : (c.todayTotal > 0 ? '進行中' : '未達');
  const pct = Math.min(100, (c.todayTotal / c.daily) * 100);
  const hero = $('#camp-hero');
  hero.className = `card camp-hero ${st}`;
  hero.innerHTML = `
    <div class="ch-top">
      <span class="ch-title">CAMPAIGN 350<span class="jp">目標</span></span>
      <span class="ch-days">${c.daysRemaining}<em>days left · 残り</em></span>
    </div>
    <div class="ch-status">${label}<span class="ch-status-jp">${jp}</span></div>
    <div class="ch-amount">${fmtMoney0(c.todayTotal)} <span class="ch-goal">/ ${fmtMoney0(c.daily)} today</span></div>
    <div class="ch-bar"><span style="width:${pct}%"></span></div>`;

  // Stat tiles
  const aheadPos = c.ahead >= 0;
  const tiles = [
    { label: 'Earned to date', jp: '累計', value: fmtMoney0(c.earnedToDate), sub: `of ${fmtMoney0(c.totalGoal)} goal`, cls: 'accent' },
    { label: 'Goal to date', jp: '目標累計', value: fmtMoney0(c.goalToDate), sub: `day ${c.daysElapsed} of ${c.totalDays}` },
    { label: aheadPos ? 'Ahead of pace' : 'Behind pace', jp: aheadPos ? '貯金' : '不足', value: (aheadPos ? '+' : '−') + fmtMoney0(Math.abs(c.ahead)), sub: 'vs $350/day line', cls: aheadPos ? 'accent' : 'neg' },
    { label: 'Remaining goal', jp: '残り目標', value: fmtMoney0(c.remainingGoal), sub: `${c.daysRemaining} days left` },
    { label: 'Required / day', jp: '必要日額', value: fmtMoney0(c.requiredPace), sub: c.behindPace ? `above $${c.daily} — behind` : `≤ $${c.daily} — on track`, cls: c.behindPace ? 'neg' : 'accent' },
    { label: 'Streak', jp: '連続達成', value: `${c.streak}`, sub: `day${c.streak === 1 ? '' : 's'} at $350+` },
  ];
  $('#camp-kpis').innerHTML = tiles.map((k) => `
    <div class="kpi ${k.cls || ''}">
      <div class="k-label">${k.label}<span class="jp">${k.jp}</span></div>
      <div class="k-value">${k.value}</div>
      <div class="k-sub">${k.sub}</div>
    </div>`).join('');

  // 14-day chart with a dashed $350 reference line
  const to = store.todayISO();
  const fromD = new Date(); fromD.setDate(fromD.getDate() - 13);
  const days = store.dailyTotals(store.isoDate(fromD), to);
  const data = days.map((d) => {
    const dd = new Date(d.date + 'T00:00:00');
    const color = d.total >= c.daily ? '#34d399' : (d.total > 0 ? '#f5a524' : '#3a3f4b');
    return { label: `${dd.getMonth() + 1}/${dd.getDate()}`, values: { t: d.total }, color };
  });
  charts.barChart($('#camp-chart'), data, [{ key: 't', label: 'Total', color: '#34d399' }], {
    refLine: { value: c.daily, label: `$${c.daily}`, color: '#f5a524' }, empty: 'No data yet',
  });

  // Ledger — last ~60 days, gig shifts + manual income, newest first
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 59);
  const cutISO = store.isoDate(cutoff);
  const rows = [
    ...store.getShifts().filter((s) => s.date >= cutISO).map((item) => ({ kind: 'shift', item })),
    ...store.getIncomes().filter((i) => i.date >= cutISO).map((item) => ({ kind: 'income', item })),
  ].sort((a, b) => (a.item.date < b.item.date ? 1 : a.item.date > b.item.date ? -1 : 0));
  $('#camp-ledger').innerHTML = rows.length
    ? rows.map((r) => (r.kind === 'shift' ? recordRow(r.item, 'shift', false) : recordRow(r.item, 'income', true))).join('')
    : '<li class="empty-list">No income logged in the last 60 days.</li>';
}

// =====================================================================
// Trends
// =====================================================================
function renderTrends() {
  const shifts = store.getShifts();
  const expenses = store.getExpenses();

  // Flex pay by block type — which tag actually pays best per hour
  const byTag = store.flexByTag(shifts);
  const ftCard = $('#flex-tag-card');
  if (byTag.length) {
    ftCard.classList.remove('hidden');
    const best = byTag.reduce((a, b) => (b.perHour > a.perHour ? b : a), byTag[0]);
    charts.barChart($('#chart-flex-tag'),
      byTag.map((t) => ({ label: TAG_SHORT[t.tag] || t.tag, values: { rate: t.perHour }, color: TAG_COLORS[t.tag] })),
      [{ key: 'rate', label: '$/hr', color: 'var(--accent)' }],
      { empty: 'Tag your Flex blocks to compare' });
    $('#flex-tag-list').innerHTML = byTag.map((t) => `
      <li class="tag-stat">
        ${typeBadge(t.tag)}
        <div class="ts-main">
          <div class="ts-name">${t.tag}${t.tag === best.tag && byTag.length > 1 ? ' <span class="hint">· best/hr</span>' : ''}</div>
          <div class="ts-sub">${t.count} block${t.count !== 1 ? 's' : ''} · ${fmtMoney0(t.income)} total${t.effPct ? ` · ${Math.round(t.effPct)}% block time` : ''}</div>
        </div>
        <div class="ts-rate">${t.perHour ? fmtMoney(t.perHour) + '/hr' : '—'}</div>
      </li>`).join('');
  } else {
    ftCard.classList.add('hidden');
  }

  // Weekly net (last 10 weeks)
  const weeks = groupByWeek(shifts, expenses, 10);
  charts.barChart($('#chart-weekly-net'),
    weeks.map((w) => ({ label: w.label, values: { net: Math.max(0, w.net) } })),
    [{ key: 'net', label: 'Net', color: PLATFORMS.flex.color }],
    { empty: 'Not enough data yet' });
  charts.legend($('#trend-net-legend'), [{ label: 'Net income', color: PLATFORMS.flex.color }]);

  // Hourly rate trend
  charts.lineChart($('#chart-hourly'),
    weeks.map((w) => ({ label: w.label, values: { rate: w.hours ? w.income / w.hours : 0 } })),
    [{ key: 'rate', label: '$/hr', color: PLATFORMS.doordash.color }],
    { area: true, empty: 'Log hours to see this' });

  // Income vs expenses monthly (last 8 months)
  const months = groupByMonth(shifts, expenses, 8);
  charts.barChart($('#chart-income-expense'),
    months.map((m) => ({ label: m.label, values: { income: m.income, exp: m.expense } })),
    [{ key: 'income', label: 'Income', color: PLATFORMS.flex.color }, { key: 'exp', label: 'Expenses', color: PLATFORMS.doordash.color }],
    { empty: 'Not enough data yet' });
  charts.legend($('#ie-legend'), [{ label: 'Income', color: PLATFORMS.flex.color }, { label: 'Expenses', color: PLATFORMS.doordash.color }]);

  // Best day of week (avg income per shift)
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const sums = Array(7).fill(0), counts = Array(7).fill(0);
  shifts.forEach((s) => { const d = dayOfWeek(s.date); sums[d] += store.shiftIncome(s); counts[d]++; });
  const dowData = dow.map((label, i) => ({ label, values: { avg: counts[i] ? sums[i] / counts[i] : 0 } }));
  charts.barChart($('#chart-dow'), dowData, [{ key: 'avg', label: 'Avg / shift', color: PLATFORMS.other.color }],
    { empty: 'Log shifts across the week' });
}

function groupByWeek(shifts, expenses, n) {
  const map = new Map();
  const keyOf = (iso) => {
    const [y, m, d] = iso.split('-').map(Number);
    const ws = store.startOfWeek(new Date(y, m - 1, d));
    return store.isoDate(ws);
  };
  shifts.forEach((s) => { const k = keyOf(s.date); const o = get(map, k); o.income += store.shiftIncome(s); o.hours += s.hours; });
  expenses.forEach((e) => { const k = keyOf(e.date); get(map, k).expense += e.amount; });
  return finalize(map, n, (k) => {
    const [y, m, d] = k.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' });
  });
}

function groupByMonth(shifts, expenses, n) {
  const map = new Map();
  shifts.forEach((s) => { const k = s.date.slice(0, 7); const o = get(map, k); o.income += store.shiftIncome(s); o.hours += s.hours; });
  expenses.forEach((e) => { const k = e.date.slice(0, 7); get(map, k).expense += e.amount; });
  return finalize(map, n, monthLabel);
}

function get(map, k) {
  if (!map.has(k)) map.set(k, { income: 0, expense: 0, hours: 0 });
  return map.get(k);
}
function finalize(map, n, labelFn) {
  return [...map.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .slice(-n)
    .map(([k, v]) => ({ label: labelFn(k), income: v.income, expense: v.expense, hours: v.hours, net: v.income - v.expense }));
}

// =====================================================================
// Import — OCR + CSV
// =====================================================================
function initImport() {
  const ocrFile = $('#ocr-file');
  ocrFile.addEventListener('change', onOcrFile);

  $('#csv-file').addEventListener('change', onCsvFile);
}

async function onOcrFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  const statusEl = $('#ocr-status');
  const preview = $('#ocr-preview');
  preview.classList.add('hidden'); preview.innerHTML = '';
  statusEl.classList.remove('hidden');

  if (!ocrAvailable()) {
    statusEl.innerHTML = '⚠️ Reading a screenshot needs the internet the first time (to download the text engine). Connect and try again, or enter the numbers manually.';
    return;
  }
  statusEl.innerHTML = 'Reading screenshot… <div class="progress"><span id="ocr-bar"></span></div>';
  try {
    const text = await recognize(file, (p) => {
      const bar = $('#ocr-bar'); if (bar) bar.style.width = Math.round(p * 100) + '%';
    });
    const hint = chipValue('#ocr-platform');
    const guess = extractFromText(text, hint);
    if (!guess.date) guess.date = store.todayISO();
    statusEl.innerHTML = guess._confidence >= 1
      ? '✓ Read it — check the values below, then save.'
      : '⚠️ Couldn’t read much confidently. Please review/correct below.';
    showOcrReview(guess, text);
  } catch (err) {
    statusEl.innerHTML = '⚠️ ' + escapeHtml(err.message || 'OCR failed');
  } finally {
    e.target.value = '';
  }
}

function showOcrReview(g, rawText) {
  const preview = $('#ocr-preview');
  preview.classList.remove('hidden');
  preview.innerHTML = `
    <div class="form" style="margin-top:14px">
      <div class="field"><label>Platform</label>
        <div class="choice" id="ocr-r-platform">
          <button type="button" class="chip ${g.platform === 'flex' ? 'active' : ''}" data-val="flex">Amazon Flex</button>
          <button type="button" class="chip ${g.platform === 'doordash' ? 'active' : ''}" data-val="doordash">DoorDash</button>
          <button type="button" class="chip ${g.platform === 'other' ? 'active' : ''}" data-val="other">Other</button>
        </div>
      </div>
      <div class="row">
        <div class="field"><label>Date</label><input type="date" id="ocr-r-date" value="${g.date}"></div>
        <div class="field"><label>Hours</label><input type="number" step="0.25" id="ocr-r-hours" value="${g.hours || ''}"></div>
      </div>
      <div class="row">
        <div class="field"><label>Base pay ($)</label><input type="number" step="0.01" id="ocr-r-gross" value="${g.gross || ''}"></div>
        <div class="field"><label>Tips ($)</label><input type="number" step="0.01" id="ocr-r-tips" value="${g.tips || ''}"></div>
      </div>
      <div class="row">
        <div class="field"><label>Deliveries</label><input type="number" step="1" id="ocr-r-jobs" value="${g.jobs || ''}"></div>
        <div class="field"><label>Miles</label><input type="number" step="0.1" id="ocr-r-miles" value="${g.miles || ''}"></div>
      </div>
      <div class="form-actions">
        <button type="button" class="btn ghost" id="ocr-raw-toggle">View raw text</button>
        <button type="button" class="btn primary" id="ocr-save">Save shift</button>
      </div>
      <pre id="ocr-raw" class="hidden muted" style="white-space:pre-wrap;font-size:11px;margin-top:8px;max-height:160px;overflow:auto">${escapeHtml(rawText)}</pre>
    </div>`;
  bindChips('#ocr-r-platform');
  $('#ocr-raw-toggle').addEventListener('click', () => $('#ocr-raw').classList.toggle('hidden'));
  $('#ocr-save').addEventListener('click', () => {
    store.addShift({
      platform: chipValue('#ocr-r-platform') || 'other',
      date: $('#ocr-r-date').value || store.todayISO(),
      hours: $('#ocr-r-hours').value, gross: $('#ocr-r-gross').value, tips: $('#ocr-r-tips').value,
      jobs: $('#ocr-r-jobs').value, miles: $('#ocr-r-miles').value, notes: 'Screenshot import',
    });
    toast('Saved from screenshot ✓');
    preview.classList.add('hidden'); $('#ocr-status').classList.add('hidden');
    renderDashboard();
  });
}

function onCsvFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const platform = chipValue('#csv-platform');
    const { shifts, warnings } = csvToShifts(String(reader.result), platform);
    showCsvReview(shifts, warnings);
  };
  reader.readAsText(file);
  e.target.value = '';
}

function showCsvReview(shifts, warnings) {
  const preview = $('#csv-preview');
  preview.classList.remove('hidden');
  if (!shifts.length) {
    preview.innerHTML = `<p class="muted" style="margin-top:12px">Couldn’t find any importable rows. ${warnings.map(escapeHtml).join(' ')}</p>`;
    return;
  }
  const total = shifts.reduce((a, s) => a + s.gross + s.tips, 0);
  const rows = shifts.slice(0, 8).map((s) => `<li class="record"><span class="rec-badge" style="background:${platColor(s.platform)}"></span>
    <div class="rec-main"><div class="rec-title">${s.date}</div><div class="rec-sub">${platLabel(s.platform)}${s.miles ? ' · ' + fmt1(s.miles) + ' mi' : ''}${s.jobs ? ' · ' + s.jobs + ' jobs' : ''}</div></div>
    <div class="rec-amount">${fmtMoney(s.gross + s.tips)}</div></li>`).join('');
  preview.innerHTML = `
    <div style="margin-top:14px">
      ${warnings.length ? `<p class="muted">⚠️ ${warnings.map(escapeHtml).join(' ')}</p>` : ''}
      <p class="muted">Found <b>${shifts.length}</b> shifts · ${fmtMoney(total)} total. Preview:</p>
      <ul class="record-list">${rows}${shifts.length > 8 ? `<li class="empty-list">…and ${shifts.length - 8} more</li>` : ''}</ul>
      <div class="form-actions">
        <button type="button" class="btn ghost" id="csv-cancel">Cancel</button>
        <button type="button" class="btn primary" id="csv-confirm">Import ${shifts.length} shifts</button>
      </div>
    </div>`;
  $('#csv-cancel').addEventListener('click', () => { preview.classList.add('hidden'); preview.innerHTML = ''; });
  $('#csv-confirm').addEventListener('click', () => {
    const n = store.importShifts(shifts);
    toast(`Imported ${n} shifts ✓`);
    preview.classList.add('hidden'); preview.innerHTML = '';
    renderDashboard();
  });
}

// =====================================================================
// Drive — GPS auto-mileage tracking
// =====================================================================
let tracker = null;
let driveTimer = null;
let wakeLock = null;

function initDrive() {
  $('#drive-cta').addEventListener('click', startDrive);
  $('#drive-stop').addEventListener('click', () => endDrive(true));
  $('#drive-cancel').addEventListener('click', () => endDrive(false));
  // A wake lock is dropped when the tab is hidden; re-acquire it when we come
  // back and a drive is still running, so tracking survives a screen blank.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && tracker) acquireWakeLock();
  });
}

async function acquireWakeLock() {
  try {
    if ('wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch { /* denied / unsupported — screen may sleep; that's fine */ }
}

function releaseWakeLock() {
  try { if (wakeLock) wakeLock.release(); } catch { /* ignore */ }
  wakeLock = null;
}

async function startDrive() {
  const overlay = $('#drive-overlay');
  overlay.classList.remove('hidden');
  $('#drive-miles').textContent = '0.00';
  $('#drive-time').textContent = '00:00';
  $('#drive-accuracy').textContent = '';
  const stateEl = $('#drive-state');
  stateEl.textContent = 'Getting GPS…'; stateEl.className = 'drive-status';

  tracker = new DriveTracker();
  acquireWakeLock();
  driveTimer = setInterval(() => {
    if (tracker) $('#drive-time').textContent = fmtDuration(tracker.elapsedMs);
  }, 1000);

  try {
    await tracker.start((u) => {
      stateEl.textContent = '● Tracking'; stateEl.className = 'drive-status tracking';
      $('#drive-miles').textContent = u.miles.toFixed(2);
      if (u.accuracy != null) {
        const good = u.accuracy <= 25;
        $('#drive-accuracy').textContent = `GPS accuracy ±${Math.round(u.accuracy)} m${good ? '' : ' · move to open sky for better tracking'}`;
      }
    });
  } catch (err) {
    stateEl.textContent = '⚠️ ' + (err.message || 'GPS unavailable');
    stateEl.className = 'drive-status warn';
  }
}

function endDrive(save) {
  clearInterval(driveTimer); driveTimer = null;
  releaseWakeLock();
  const result = tracker ? tracker.stop() : { miles: 0 };
  tracker = null;
  $('#drive-overlay').classList.add('hidden');
  if (!save) { toast('Drive discarded'); return; }
  if (!(result.miles > 0)) { toast('No distance tracked'); return; }

  const trip = store.addTrip(result);
  // pre-fill the shift form so the tracked miles roll into a shift record
  state.logMode = 'shift';
  $$('#log-segmented .seg').forEach((x) => x.classList.toggle('active', x.dataset.log === 'shift'));
  $('#shift-form').classList.remove('hidden');
  $('#expense-form').classList.add('hidden');
  const f = $('#shift-form');
  f.date.value = trip.date;
  f.miles.value = (parseFloat(f.miles.value || '0') + trip.miles).toFixed(1);
  updateShiftLive();
  showView('log');
  toast(`Logged ${trip.miles.toFixed(1)} mi ✓ — add pay to save the shift`);
  f.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Live station-board clock in the sidebar (desktop).
function startClock() {
  const el = $('#side-clock');
  if (!el) return;
  const pad = (n) => String(n).padStart(2, '0');
  const tick = () => {
    const d = new Date();
    el.textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };
  tick();
  setInterval(tick, 1000);
}

function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

// =====================================================================
// Settings + backup
// =====================================================================
function initSettings() {
  const s = store.getSettings();
  $('#set-mileage').value = s.mileageRate;
  $('#set-taxrate').value = Math.round(s.taxRate * 100);
  $('#set-weekstart').value = String(s.weekStart);
  $('#set-mileage').addEventListener('change', (e) => { store.updateSettings({ mileageRate: parseFloat(e.target.value) || 0 }); toast('Saved'); updateShiftLive(); });
  $('#set-taxrate').addEventListener('change', (e) => { store.updateSettings({ taxRate: (parseFloat(e.target.value) || 0) / 100 }); toast('Saved'); renderDashboard(); });
  $('#set-weekstart').addEventListener('change', (e) => { store.updateSettings({ weekStart: parseInt(e.target.value, 10) }); toast('Saved'); renderTrends(); });

  $('#export-json').addEventListener('click', () => download('gig-tracker-backup.json', store.exportJSON(), 'application/json'));
  $('#export-csv').addEventListener('click', exportShiftsCSV);
  $('#import-json-file').addEventListener('change', onImportJSON);
  $('#clear-all').addEventListener('click', () => {
    if (!confirm('Erase ALL shifts and expenses? Export a backup first if unsure. This cannot be undone.')) return;
    store.clearAll(); toast('All data erased'); renderDashboard(); renderLogList();
  });
}

function exportShiftsCSV() {
  const rows = [['date', 'platform', 'hours', 'gross', 'tips', 'income', 'jobs', 'miles', 'notes']];
  store.getShifts().forEach((s) => rows.push([s.date, s.platform, s.hours, s.gross, s.tips, store.shiftIncome(s), s.jobs, s.miles, (s.notes || '').replace(/"/g, '""')]));
  const csv = rows.map((r) => r.map((c) => (/[,"\n]/.test(String(c)) ? `"${c}"` : c)).join(',')).join('\n');
  download('gig-shifts.csv', csv, 'text/csv');
}

function onImportJSON(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const merge = confirm('OK = MERGE into current data.\nCancel = REPLACE all current data with the backup.');
      store.importJSON(String(reader.result), { merge });
      toast('Backup restored ✓');
      const s = store.getSettings();
      $('#set-mileage').value = s.mileageRate; $('#set-weekstart').value = String(s.weekStart);
      $('#set-taxrate').value = Math.round(s.taxRate * 100);
      renderDashboard(); renderLogList();
    } catch (err) { toast('Invalid backup file'); }
  };
  reader.readAsText(file);
  e.target.value = '';
}

function download(name, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('Downloaded');
}

// ---- PWA install ----
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); deferredPrompt = e;
  $('#install-btn').classList.remove('hidden');
});
function initInstall() {
  $('#install-btn').addEventListener('click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    $('#install-btn').classList.add('hidden');
  });
}

// ---- utils ----
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// =====================================================================
// Boot
// =====================================================================
function boot() {
  // Always open at the top (a refreshed/reopened PWA shouldn't restore a
  // mid-page scroll that hides the KPI row behind the sticky header).
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  window.scrollTo(0, 0);
  initForms();
  initImport();
  initSettings();
  initInstall();
  initDrive();
  setChip('#shift-platform', 'flex');
  renderDashboard();
  renderLogList();
  startClock();

  // Re-render when crossing the desktop breakpoint so the route strip / ticker
  // and count-up numbers appear/disappear correctly.
  window.matchMedia('(min-width: 960px)').addEventListener('change', () => renderDashboard());

  // re-render dashboard when data changes elsewhere
  store.onChange(() => {
    if ($('#view-dashboard').classList.contains('active')) renderDashboard();
    if ($('#view-campaign').classList.contains('active')) renderCampaign();
  });

  registerSW();
}
boot();

// ---- service worker + in-app update banner ----
function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  let updateAccepted = false;
  let reloading = false;

  // When the freshly-activated SW takes control (only after the user taps
  // Refresh), reload once to run the new code.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!updateAccepted || reloading) return;
    reloading = true;
    window.location.reload();
  });

  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('sw.js');
      // A new version may already be waiting from a previous visit.
      if (reg.waiting && navigator.serviceWorker.controller) showUpdateBanner(reg);
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener('statechange', () => {
          // "installed" + an existing controller == this is an update, not first install.
          if (nw.state === 'installed' && navigator.serviceWorker.controller) showUpdateBanner(reg);
        });
      });
      // Proactively check for a new deploy each time the app is reopened/refocused.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update().catch(() => {});
      });
    } catch { /* offline / unsupported — app still works from cache */ }

    function showUpdateBanner(reg) {
      const banner = $('#update-banner');
      if (!banner || banner.dataset.shown === '1') return;
      banner.dataset.shown = '1';
      banner.classList.remove('hidden');
      $('#update-apply').onclick = () => {
        updateAccepted = true;
        banner.classList.add('hidden');
        if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
        else window.location.reload();
      };
      $('#update-dismiss').onclick = () => { banner.classList.add('hidden'); };
    }
  });
}
