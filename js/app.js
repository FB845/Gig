// app.js — UI wiring for the Gig Tracker.
import * as store from './store.js';
import * as charts from './charts.js';
import { csvToShifts, extractFromText } from './parse.js';
import { recognize, ocrAvailable } from './ocr.js';
import { parseICS, parseScheduleText } from './calendar.js';
import { DriveTracker } from './geo.js';
import * as sync from './sync.js';
import { initDesk, renderDesk, focusSlot } from './desk.js';
import { initBestHours, renderBestHours } from './besthours.js';

const { PLATFORMS, EXPENSE_CATEGORIES } = store;
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  period: 'month',
  logMode: 'shift',
  editShiftId: null,
  editExpenseId: null,
  editIncomeId: null,
  editPlanId: null,
  fromPlanId: null, // the plan a shift/income is being logged from ("Log it")
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
// Header title per screen (JP ⇄ EN), as on the station-board mockups.
const SCREEN_TITLES = {
  dashboard: ['ギグ線 · ホーム', 'GIG LINE · HOME'],
  campaign: ['目標 · キャンペーン350', 'CAMPAIGN 350'],
  log: ['記録 · きろく', 'LOG'],
  trends: ['分析 · ぶんせき', 'TRENDS'],
  import: ['取込 · とりこみ', 'IMPORT'],
  settings: ['設定 · せってい', 'SETTINGS'],
  desk: ['計画 · プランニング', 'PLANNING DESK'],
};
function setScreenTitle(jp, en) {
  const h = $('#screen-title');
  if (!h) return;
  h.innerHTML = swapHTML(jp, en);
  h.setAttribute('aria-label', en);
}

function showView(name) {
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  setScreenTitle(...(name === 'log' ? LOG_TITLES[state.logMode] || LOG_TITLES.shift : SCREEN_TITLES[name] || SCREEN_TITLES.dashboard));
  $$('.tab, .snav').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
  window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
  if (name === 'dashboard') renderDashboard();
  if (name === 'trends') renderTrends();
  if (name === 'log') renderLogList();
  if (name === 'campaign') renderCampaign();
  if (name === 'desk') renderDesk();
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
  const incomes = store.inRange(store.getIncomes(), from, to);
  const s = store.summarize(shifts, expenses, undefined, incomes);

  // Net income now combines gig + manual income; show the split in the sub when
  // there's manual income so it's clear where the total comes from.
  const inSub = s.manualIncome > 0
    ? `${fmtMoney0(s.totalIncome)} in (${fmtMoney0(s.gigIncome)} gig + ${fmtMoney0(s.manualIncome)} other) · ${fmtMoney0(s.expenseTotal)} out`
    : `${fmtMoney0(s.totalIncome)} in · ${fmtMoney0(s.expenseTotal)} out`;

  // KPIs (with LED count-up + sparklines on desktop)
  const spark = dailyMetricSeries(14);
  const kpis = [
    { label: 'Net income', jp: '純利益', target: s.net, fmt: 'money0', sub: inSub, cls: s.net >= 0 ? 'accent' : 'neg', series: spark.net, color: '#3dff7a' },
    { label: '$ / hour', jp: '時給', target: s.perHour, fmt: 'money2', empty: !s.hours, sub: `${fmt1(s.hours)} hrs worked · gig`, series: spark.perHour, color: '#e8f1ff' },
    { label: '$ / mile', jp: '距離単価', target: s.perMile, fmt: 'money2', empty: !s.miles, sub: `${fmt1(s.miles)} mi driven · gig`, series: spark.perMile, color: '#6aa8ff' },
    { label: 'Per delivery', jp: '配達単価', target: s.perJob, fmt: 'money2', empty: !s.jobs, sub: `${s.jobs} deliveries · gig`, series: spark.perJob, color: '#ffcf7a' },
  ];
  $('#kpi-grid').innerHTML = kpis.map((k) => `
    <div class="kpi ${k.cls || ''}">
      <div class="k-label"><span class="jp">${k.jp}</span> ${k.label.toUpperCase()}</div>
      <div class="k-value"${k.empty ? '' : ` data-count="${k.target}" data-fmt="${k.fmt}"`}>${k.empty ? '—' : fmtByType(k.fmt, k.target)}</div>
      <div class="k-sub">${k.sub}</div>
      <div class="k-spark">${sparkline(k.series, k.color)}</div>
    </div>`).join('');
  animateCounts($('#kpi-grid'));

  // Tax set-aside card
  const rate = Math.round(store.getSettings().taxRate * 100);
  $('#tax-card').innerHTML = `
    <div class="tax-main">
      <div class="tax-label">税金積立 SET ASIDE FOR TAXES (${rate}%)</div>
      <div class="tax-val">${fmtMoney0(s.taxSetAside)}</div>
      <div class="tax-sub">on ${fmtMoney0(s.taxableEstimate)} taxable · after ${fmtMoney0(Math.max(s.expenseTotal, s.mileageDeduction))} deduction</div>
    </div>
    <div class="tax-take">
      <div class="tt-val">${fmtMoney0(s.takeHomeAfterTax)}</div>
      <div class="tt-label">手取り take-home</div>
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
        <span class="fe-title">${swapHTML('フレックス ブロック消化', 'FLEX BLOCK TIME')}</span>
        <span class="fe-pct ${over ? 'over' : ''}">${Math.round(pct)}%</span>
      </div>
      <div class="fe-cells" aria-hidden="true">${Array.from({ length: 20 }, (_, i) => `<span class="${i < Math.round(Math.min(100, pct) / 5) ? 'lit' : ''}"></span>`).join('')}</div>
      <div class="fe-sub">${fmt1(s.schedActual)} h actual of ${fmt1(s.schedPlanned)} h scheduled · ${s.schedShiftCount} block${s.schedShiftCount !== 1 ? 's' : ''} · ${trend} on average</div>`;
  } else {
    feCard.classList.add('hidden');
  }

  renderTicker(s);
  renderRouteStrip();

  renderEarningsChart(shifts, incomes);
  renderPlatformDonut(shifts, incomes);
  renderExpensesDonut(expenses);
  renderRecentShifts(store.getShifts().slice(0, 6));
  updateOfferAvg();
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
    map.set(store.isoDate(d), { income: 0, manual: 0, expense: 0, hours: 0, miles: 0, jobs: 0 });
  }
  store.getShifts().forEach((sh) => {
    const o = map.get(sh.date); if (!o) return;
    o.income += store.shiftIncome(sh); o.hours += sh.hours; o.miles += sh.miles; o.jobs += sh.jobs;
  });
  store.getExpenses().forEach((e) => { const o = map.get(e.date); if (o) o.expense += e.amount; });
  store.getIncomes().forEach((inc) => { const o = map.get(inc.date); if (o) o.manual += store.num(inc.amount); });
  const rows = [...map.values()];
  return {
    // Net folds in manual income; the rate sparklines stay gig-only.
    net: rows.map((r) => r.income + r.manual - r.expense),
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
  const line = `<span class="live">運行中</span>` + items.join('<span class="sep">・</span>') + '<span class="sep">・</span>';
  track.innerHTML = line + line; // doubled for seamless marquee loop
}

// Flex block tags styled as JR train types (種別). `ink` is the text color used
// when the type color fills a solid badge.
const TRAIN_TYPES = {
  'Local': { label: '普通', romaji: 'LOCAL', color: '#11a85a', ink: '#fff' },
  'Rapid': { label: '快速', romaji: 'RAPID', color: '#2a6fd6', ink: '#fff' },
  'Express': { label: '急行', romaji: 'EXP', color: '#f39a12', ink: '#111' },
  'Rapid Express': { label: '特急', romaji: 'LTD.EXP', color: '#e0211b', ink: '#fff' },
};
function trainType(shift) {
  return (shift.tag && TRAIN_TYPES[shift.tag]) || TRAIN_TYPES.Local;
}
// A JP ⇄ EN pair that flips with every other on the page (see startLangSwap).
function swapHTML(jp, en) {
  return `<span class="swap"><span>${jp}</span><span>${en}</span></span>`;
}
// Form / list headings: English text (what the code and tests key on) paired
// with its station-board Japanese, flipping like every other JP⇄EN label.
const TITLE_JP = {
  'Log a shift': 'シフト記録', 'Edit shift': 'シフト編集', 'Log income': '収入記録', 'Edit income': '収入編集',
  'Log planned block': '予定を記録', 'Log planned income': '予定収入を記録',
  'Plan a block': '予定を立てる', 'Edit plan': '予定編集', 'Log an expense': '経費を記録', 'Edit expense': '経費編集',
  'Shifts & income': 'シフト・収入', 'All expenses': '経費一覧', 'GPS mileage log': '走行記録 · GPS', 'Planner': '予定表',
};
function setTitle(el, en) {
  if (!el) return;
  el.innerHTML = TITLE_JP[en] ? swapHTML(TITLE_JP[en], en.toUpperCase()) : en;
  el.setAttribute('aria-label', en);
  el.dataset.en = en;
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
      <span class="rs-type">${ty.label}</span>
      <span class="rs-dest"><b>${swapHTML('ギグライン', 'GIG LINE')}</b><small>${ty.romaji}</small></span>
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
  const line = '#e8f1ff'; // white LED line

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

function bucketByPeriod(shifts, incomes = []) {
  // choose bucket granularity based on selected period
  const gran = state.period === 'week' || state.period === 'month' ? 'day'
    : state.period === 'year' ? 'month' : 'month';
  const buckets = new Map(); // key -> {flex,doordash,other,manual}
  const keyLabel = (iso) => gran === 'day'
    ? { key: iso, label: friendlyDate(iso).replace(/^[A-Za-z]+, /, '') }
    : { key: iso.slice(0, 7), label: monthLabel(iso.slice(0, 7)) };
  const bucket = (iso) => {
    const { key, label } = keyLabel(iso);
    if (!buckets.has(key)) buckets.set(key, { label, values: { flex: 0, doordash: 0, other: 0, manual: 0 } });
    return buckets.get(key);
  };
  for (const sh of shifts) bucket(sh.date).values[sh.platform in PLATFORMS ? sh.platform : 'other'] += store.shiftIncome(sh);
  for (const inc of incomes) bucket(inc.date).values.manual += store.num(inc.amount);
  return [...buckets.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map((e) => e[1]);
}

function monthLabel(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'short' });
}

function renderEarningsChart(shifts, incomes = []) {
  const data = bucketByPeriod(shifts, incomes);
  const series = [
    { key: 'flex', label: 'Amazon Flex', color: PLATFORMS.flex.color },
    { key: 'doordash', label: 'DoorDash', color: PLATFORMS.doordash.color },
    { key: 'other', label: 'Other', color: PLATFORMS.other.color },
  ];
  // Only surface the manual-income segment when there is any (keeps the legend
  // clean for pure-gig users).
  if (incomes.some((i) => store.num(i.amount) > 0)) {
    series.push({ key: 'manual', label: 'Other income', color: '#e8f1ff' });
  }
  charts.barChart($('#chart-earnings'), data, series, { empty: 'Log a shift to see earnings here' });
  const SHORT = { flex: 'Flex', doordash: 'Dash', other: 'Other', manual: 'Income' };
  charts.legend($('#earn-legend'), series.map((x) => ({ ...x, label: SHORT[x.key] || x.label })));
}

// By platform: one LED split bar (Flex / DoorDash / Other gig / other income).
function renderPlatformDonut(shifts, incomes = []) {
  const totals = { flex: 0, doordash: 0, other: 0 };
  shifts.forEach((s) => { totals[s.platform in PLATFORMS ? s.platform : 'other'] += store.shiftIncome(s); });
  const parts = Object.keys(totals).map((k) => ({ label: PLATFORMS[k].label, value: totals[k], color: PLATFORMS[k].color }));
  const manual = incomes.reduce((a, i) => a + store.num(i.amount), 0);
  if (manual > 0) parts.push({ label: 'Other income', value: manual, color: '#e8f1ff' });
  const shown = parts.filter((p) => p.value > 0);
  const host = $('#chart-platform');
  if (!shown.length) { host.innerHTML = '<div class="chart-empty">No earnings yet</div>'; $('#platform-legend').innerHTML = ''; return; }
  host.innerHTML = shown.map((p) => `<span class="led" style="flex:${p.value};background:${p.color}" title="${escapeHtml(p.label)}: ${fmtMoney0(p.value)}"></span>`).join('');
  $('#platform-legend').innerHTML = shown.map((p) => `<span><i style="background:${p.color}"></i>${escapeHtml(p.label)} ${fmtMoney0(p.value)}</span>`).join('');
}

const EXP_COLORS = ['#ff6b5f', '#ffcf7a', '#e8f1ff', '#6aa8ff', '#a78bfa', '#f472b6', '#2dd4bf', '#3dff7a', '#fb923c', '#8a95a5'];
const TAG_COLORS = { 'Local': '#11a85a', 'Rapid': '#2a6fd6', 'Express': '#f39a12', 'Rapid Express': '#e0211b' };
const TAG_SHORT = { 'Local': 'Local', 'Rapid': 'Rapid', 'Express': 'Express', 'Rapid Express': 'R.Exp' };
// Expenses: one row per category — grey flap, red LED bar, amount.
function renderExpensesDonut(expenses) {
  const byCat = new Map();
  expenses.forEach((e) => byCat.set(e.category, (byCat.get(e.category) || 0) + e.amount));
  const rows = [...byCat.entries()].sort((a, b) => b[1] - a[1]);
  const total = rows.reduce((a, [, v]) => a + v, 0);
  $('#expenses-total').textContent = total ? `−${fmtMoney0(total)}` : '';
  const host = $('#chart-expenses');
  if (!rows.length) { host.innerHTML = '<div class="chart-empty">No expenses logged</div>'; return; }
  const max = rows[0][1];
  host.innerHTML = rows.map(([cat, v]) => `<div class="exp-row">
      <span class="flap gry">${CATEGORY_JP[cat] || cat}</span>
      <span class="exp-track"><span class="led" style="width:${Math.max(2, (v / max) * 100)}%"></span></span>
      <span class="led exp-amt">${fmtMoney0(v)}</span>
    </div>`).join('');
}
// Expense categories as 種別-style kanji for the grey flaps.
const CATEGORY_JP = {
  'Fuel': '燃料', 'Tolls': '通行料', 'Maintenance': '整備', 'Car Payment': '車両', 'Insurance': '保険',
  'Phone': '電話', 'Supplies': '備品', 'Parking': '駐車', 'Hot Bags': '保温', 'Other': 'その他',
};

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
  const rows = shifts.map((s) => {
    const ty = trainType(s);
    const p = PLATFORMS[s.platform] || PLATFORMS.other;
    return `<div class="dep-row">
      <span class="dep-type" style="--tc:${ty.color};--ink:${ty.ink}">${ty.label}</span>
      <span class="dep-date">${depDate(s.date)}</span>
      <span class="dep-dest">${swapHTML(p.jp, p.label.toUpperCase())}</span>
      <span class="dep-amt">${fmtMoney0(store.shiftIncome(s))}</span>
    </div>`;
  }).join('');
  host.innerHTML = `<div class="dep-headrow"><span>${swapHTML('種別', 'TYPE')}</span><span>${swapHTML('日付', 'DATE')}</span><span>${swapHTML('行先', 'DEST')}</span><span>${swapHTML('収入', 'PAY')}</span></div>${rows}`;
}

// =====================================================================
// Log view (forms + lists)
// =====================================================================
function initForms() {
  // segmented control
  $$('#log-segmented .seg').forEach((b) => b.addEventListener('click', () => {
    state.logMode = b.dataset.log;
    $$('#log-segmented .seg').forEach((x) => x.classList.toggle('active', x === b));
    showLogForm(state.logMode);
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

  // live metrics on shift form
  ['gross', 'tips', 'hoursH', 'hoursM', 'startTime', 'endTime', 'miles', 'jobs', 'mpg', 'amount', 'rate'].forEach((n) => {
    $(`#shift-form [name=${n}]`).addEventListener('input', updateShiftLive);
  });
  $$('#time-mode button').forEach((b) => b.addEventListener('click', () => setTimeMode(b.dataset.mode, true)));
  setTimeMode(loadTimeMode());
  // Income pay type: Flat rate | Paid by hour
  $$('#pay-type button').forEach((b) => b.addEventListener('click', () => setPayType(b.dataset.pay, true)));
  setPayType(loadPayType());
  updateShiftLive();

  $('#shift-form').addEventListener('submit', onSaveShift);
  $('#expense-form').addEventListener('submit', onSaveExpense);
  $('#shift-reset').addEventListener('click', () => resetShiftForm());
  $('#expense-reset').addEventListener('click', () => resetExpenseForm());
  $('#camp-add-income').addEventListener('click', () => { openIncomeForm(); });
  initPlanner();
}

// Switch the Log view to a segment: show its form (trips have none) + list.
const LOG_TITLES = { shift: ['記録 · きろく', 'LOG'], plan: ['記録 · 予定', 'LOG · PLAN'], expense: ['記録 · 経費', 'LOG · EXPENSES'], trip: ['記録 · 走行', 'LOG · TRIPS'] };
function showLogForm(mode) {
  state.logMode = mode;
  if ($('#view-log').classList.contains('active')) setScreenTitle(...LOG_TITLES[mode]);
  $$('#log-segmented .seg').forEach((x) => x.classList.toggle('active', x.dataset.log === mode));
  $('#shift-form').classList.toggle('hidden', mode !== 'shift');
  $('#plan-form').classList.toggle('hidden', mode !== 'plan');
  $('#expense-form').classList.toggle('hidden', mode !== 'expense');
  renderLogList();
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

// Time worked is entered either as a duration (hours + minutes) or as start –
// finish clock times, and stored as decimal hours either way — so finishing at,
// say, 2h20m records 2.333 h (not rounded to :15/:30).
const TIME_MODE_KEY = 'gigtracker.timeMode';
function loadTimeMode() {
  try { return localStorage.getItem(TIME_MODE_KEY) === 'range' ? 'range' : 'duration'; } catch { return 'duration'; }
}
function timeMode() {
  return $('#time-mode button.active')?.dataset.mode === 'range' ? 'range' : 'duration';
}
// Switch the time input mode. `remember` saves it as this device's preference.
// Values carry across: range → duration copies the computed length over.
function setTimeMode(mode, remember = false) {
  const f = $('#shift-form');
  if (mode === 'duration' && timeMode() === 'range') {
    const h = store.hoursBetween(f.startTime.value, f.endTime.value);
    if (h) setFormHours(f, h);
  }
  $$('#time-mode button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  $('#time-duration').classList.toggle('hidden', mode !== 'duration');
  $('#time-range').classList.toggle('hidden', mode !== 'range');
  if (remember) { try { localStorage.setItem(TIME_MODE_KEY, mode); } catch { /* private mode */ } }
  updateShiftLive();
}
function getFormHours(f) {
  if (timeMode() === 'range') return store.hoursBetween(f.startTime.value, f.endTime.value);
  return (parseFloat(f.hoursH.value) || 0) + (parseFloat(f.hoursM.value) || 0) / 60;
}
function fmtHM(decimal) {
  const total = Math.round((Number(decimal) || 0) * 60);
  return `${Math.floor(total / 60)}h ${String(total % 60).padStart(2, '0')}m`;
}
// "HH:MM" plus decimal hours → "HH:MM" (wraps past midnight).
function addHoursToTime(t, hours) {
  const [h, m] = t.split(':').map(Number);
  const total = ((h * 60 + m + Math.round(hours * 60)) % 1440 + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}
function setFormHours(f, decimal) {
  const d = Number(decimal) || 0;
  if (!d) { f.hoursH.value = ''; f.hoursM.value = ''; return; }
  let h = Math.floor(d + 1e-9);
  let m = Math.round((d - h) * 60);
  if (m === 60) { h += 1; m = 0; }
  f.hoursH.value = String(h);
  f.hoursM.value = String(m);
}

// Show/hide the Flex-only fields and adapt the hours label to the platform.
// Adapt the shared shift/income form to the selected platform: Flex-only
// block fields, gig-only pay/miles fields, income-only source + pay type, and
// the time input (hidden for flat-rate income — no hours needed).
function updateFlexUI() {
  const plat = chipValue('#shift-platform');
  const isFlex = plat === 'flex';
  const isIncome = plat === 'income';
  $$('#shift-form .flex-only').forEach((el) => el.classList.toggle('hidden', !isFlex));
  $$('#shift-form .gig-only').forEach((el) => el.classList.toggle('hidden', isIncome));
  $$('#shift-form .income-only').forEach((el) => el.classList.toggle('hidden', !isIncome));
  $('#time-field').classList.toggle('hidden', isIncome && payType() !== 'hourly');
  $('#hours-label').textContent = isFlex ? 'Actual time worked 実働' : 'Hours worked 実働';
  $('#shift-form [name=notes]').placeholder = isIncome ? 'Invoice #123' : 'Morning block, downtown';
  const editing = state.editShiftId || state.editIncomeId;
  setTitle($('#shift-form-title'), state.fromPlanId
    ? `Log planned ${isIncome ? 'income' : 'block'}`
    : `${editing ? 'Edit' : 'Log'} ${isIncome ? 'income' : editing ? 'shift' : 'a shift'}`);
  $('#shift-submit').textContent = `${editing ? 'Update' : 'Save'} ${isIncome ? 'income' : 'shift'} 保存`;
  updateShiftLive();
}

const PAY_TYPE_KEY = 'gigtracker.payType';
function loadPayType() {
  try { return localStorage.getItem(PAY_TYPE_KEY) === 'hourly' ? 'hourly' : 'flat'; } catch { return 'flat'; }
}
function payType() {
  return $('#pay-type button.active')?.dataset.pay === 'hourly' ? 'hourly' : 'flat';
}
// Switch income between a flat amount and an hourly rate × time worked.
function setPayType(type, remember = false) {
  $$('#pay-type button').forEach((b) => b.classList.toggle('active', b.dataset.pay === type));
  const f = $('#shift-form');
  f.amount.classList.toggle('hidden', type !== 'flat');
  f.rate.classList.toggle('hidden', type !== 'hourly');
  $('#pay-label').textContent = type === 'hourly' ? 'Hourly rate ($/hr)' : 'Amount ($)';
  if (remember) { try { localStorage.setItem(PAY_TYPE_KEY, type); } catch { /* private mode */ } }
  updateFlexUI();
}
// The income amount the form currently describes (flat, or rate × hours).
function incomeFormAmount(f) {
  if (payType() === 'hourly') return Math.round((parseFloat(f.rate.value) || 0) * getFormHours(f) * 100) / 100;
  return parseFloat(f.amount.value) || 0;
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
      // Prefill actual = scheduled: the duration, or (start–finish mode) the
      // finish time from the start time.
      if (timeMode() === 'range') {
        if (f.startTime.value && !f.endTime.value) f.endTime.value = addHoursToTime(f.startTime.value, parseFloat(c.dataset.val));
      } else if (!f.hoursH.value && !f.hoursM.value) setFormHours(f, parseFloat(c.dataset.val));
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
  const gross = +f.gross.value || 0, tips = +f.tips.value || 0, hours = getFormHours(f);
  const miles = +f.miles.value || 0, jobs = +f.jobs.value || 0;
  const income = gross + tips;
  const settings = store.getSettings();
  const rate = settings.mileageRate;
  const parts = [];
  if (chipValue('#shift-platform') === 'income') {
    // Manual income: the amount (flat, or rate × time), and a reminder that it
    // feeds the totals but not the gig-efficiency rates.
    parts.push(`<span class="lm">Income <b>${fmtMoney(incomeFormAmount(f))}</b></span>`);
    if (payType() === 'hourly' && hours) parts.push(`<span class="lm">${fmtHM(hours)} × <b>${fmtMoney(+f.rate.value || 0)}/hr</b></span>`);
    parts.push('<span class="lm">Counts toward Campaign 350 + totals, not gig $/hr</span>');
  } else {
    parts.push(`<span class="lm">Income <b>${fmtMoney(income)}</b></span>`);
    if (hours) parts.push(`<span class="lm">$/hr <b>${fmtMoney(income / hours)}</b></span>`);
    if (miles) parts.push(`<span class="lm">$/mi <b>${fmtMoney(income / miles)}</b></span>`);
    if (jobs) parts.push(`<span class="lm">$/job <b>${fmtMoney(income / jobs)}</b></span>`);
    if (miles) parts.push(`<span class="lm">Tax mi-deduction <b>${fmtMoney(miles * rate)}</b></span>`);
    const fuel = store.fuelCostFor({ miles, mpg: +f.mpg.value || 0 }, settings);
    if (fuel > 0) parts.push(`<span class="lm">Fuel est. <b>${fmtMoney(fuel)}</b></span>`);
    const sched = chipValue('#shift-platform') === 'flex' ? getScheduledHours() : 0;
    if (sched && hours) parts.push(`<span class="lm">Block time <b>${Math.round((hours / sched) * 100)}%</b></span>`);
  }
  $('#shift-live').innerHTML = parts.join('');

  // Start–finish mode: show the computed length (and flag overnight shifts).
  const dur = $('#time-range-dur');
  const showDur = timeMode() === 'range' && hours > 0;
  dur.classList.toggle('hidden', !showDur);
  if (showDur) {
    const overnight = f.endTime.value < f.startTime.value;
    dur.innerHTML = `= <b>${fmtHM(hours)}</b> worked${overnight ? ' · <span class="tr-night">overnight</span>' : ''}`;
  }
}

function onSaveShift(e) {
  e.preventDefault();
  const f = e.target;
  const isFlex = chipValue('#shift-platform') === 'flex';
  const range = timeMode() === 'range';
  if (chipValue('#shift-platform') === 'income') { saveIncomeFromForm(f, range); return; }
  const data = {
    platform: chipValue('#shift-platform') || 'other',
    date: f.date.value,
    hours: getFormHours(f), gross: f.gross.value, tips: f.tips.value,
    jobs: f.jobs.value, miles: f.miles.value, mpg: f.mpg.value, notes: f.notes.value,
    // Clock times are kept only when logged as start–finish (cleared otherwise).
    startTime: range ? f.startTime.value : '',
    endTime: range ? f.endTime.value : '',
    scheduledHours: isFlex ? getScheduledHours() : 0,
    tag: isFlex ? chipValue('#shift-tag') : '',
  };
  if (!data.date) { toast('Pick a date'); return; }
  if (range && !f.startTime.value !== !f.endTime.value) { toast('Enter both start and finish times'); return; }
  if (range && f.startTime.value && f.startTime.value === f.endTime.value) { toast('Finish time must differ from start'); return; }
  if (state.editShiftId) {
    store.updateShift(state.editShiftId, data);
    toast('Shift updated');
  } else {
    // Editing an income entry but switched the platform to a gig → convert it.
    if (state.editIncomeId) store.deleteIncome(state.editIncomeId);
    const shift = store.addShift(data);
    if (state.fromPlanId) store.markPlanLogged(state.fromPlanId, 'shift', shift.id);
    toast(state.editIncomeId ? 'Converted to a shift ✓' : state.fromPlanId ? 'Planned block logged ✓' : 'Shift saved ✓');
  }
  resetShiftForm();
  renderLogList();
}

// Income chosen under Platform: save to the manual-income store (kept apart
// from gig shifts so gig $/hr, $/mi and $/delivery stay pure).
function saveIncomeFromForm(f, range) {
  const hourly = payType() === 'hourly';
  const data = {
    date: f.date.value,
    source: f.source.value,
    payType: hourly ? 'hourly' : 'flat',
    amount: hourly ? 0 : f.amount.value,
    rate: hourly ? f.rate.value : 0,
    hours: hourly ? getFormHours(f) : 0,
    startTime: hourly && range ? f.startTime.value : '',
    endTime: hourly && range ? f.endTime.value : '',
    note: f.notes.value,
  };
  if (!data.date) { toast('Pick a date'); return; }
  if (!data.source.trim()) { toast('Enter a source'); return; }
  if (hourly) {
    if (range && !f.startTime.value !== !f.endTime.value) { toast('Enter both start and finish times'); return; }
    if (range && f.startTime.value && f.startTime.value === f.endTime.value) { toast('Finish time must differ from start'); return; }
    if (!(+data.rate > 0) || !(data.hours > 0)) { toast('Enter an hourly rate and time worked'); return; }
  } else if (!(+data.amount > 0)) { toast('Enter an amount'); return; }

  if (state.editIncomeId) {
    store.updateIncome(state.editIncomeId, data);
    toast('Income updated');
  } else {
    // Editing a gig shift but switched the platform to Income → convert it.
    if (state.editShiftId) store.deleteShift(state.editShiftId);
    const inc = store.addIncome(data);
    if (state.fromPlanId) store.markPlanLogged(state.fromPlanId, 'income', inc.id);
    toast(state.editShiftId ? 'Converted to income ✓' : state.fromPlanId ? 'Planned income logged ✓' : 'Income saved ✓');
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
  setTimeMode(loadTimeMode()); // back to this device's preferred time input
  setChip('#shift-platform', 'flex');
  setChip('#shift-tag', '');
  setBlockPreset(0);
  state.editShiftId = null;
  state.editIncomeId = null;
  state.fromPlanId = null;
  setPayType(loadPayType()); // also refreshes the platform UI + title
}
function resetExpenseForm() {
  const f = $('#expense-form');
  f.reset();
  f.date.value = store.todayISO();
  setChip('#expense-platform', '');
  state.editExpenseId = null;
  setTitle($('#expense-form-title'), 'Log an expense');
  $('#expense-submit').textContent = 'Save expense 保存';
}

// Show the Log view's shared shift/income form (Shifts segment).
function showShiftForm() {
  showLogForm('shift');
  showView('log');
}

// Put a stored entry's clock times / duration back into the time input.
function fillFormTime(f, rec) {
  if (rec.startTime && rec.endTime) {
    f.startTime.value = rec.startTime; f.endTime.value = rec.endTime;
    setTimeMode('range');
  } else {
    setTimeMode('duration');
    f.startTime.value = ''; f.endTime.value = '';
  }
  setFormHours(f, rec.hours || 0);
}

function editShift(id) {
  const s = store.getShifts().find((x) => x.id === id);
  if (!s) return;
  resetShiftForm();
  showShiftForm();
  const f = $('#shift-form');
  setChip('#shift-platform', s.platform);
  setChip('#shift-tag', s.tag || '');
  setBlockPreset(s.scheduledHours || 0);
  fillFormTime(f, s); // reopen in the time mode the shift was logged with
  f.date.value = s.date; f.gross.value = s.gross || '';
  f.tips.value = s.tips || ''; f.jobs.value = s.jobs || ''; f.miles.value = s.miles || '';
  f.mpg.value = s.mpg || ''; f.notes.value = s.notes || '';
  state.editShiftId = id;
  updateFlexUI();
  f.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Open the shared form with Income selected (Campaign "+ Income" button).
function openIncomeForm() {
  resetShiftForm();
  showShiftForm();
  setChip('#shift-platform', 'income');
  updateFlexUI();
  $('#shift-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function editIncome(id) {
  const inc = store.getIncomes().find((x) => x.id === id);
  if (!inc) return;
  openIncomeForm();
  const f = $('#shift-form');
  state.editIncomeId = id;
  f.date.value = inc.date; f.source.value = inc.source; f.notes.value = inc.note || '';
  if (inc.payType === 'hourly') {
    setPayType('hourly');
    f.rate.value = inc.rate || '';
    fillFormTime(f, inc);
  } else {
    setPayType('flat');
    f.amount.value = inc.amount;
  }
  updateFlexUI();
}

function editExpense(id) {
  const ex = store.getExpenses().find((x) => x.id === id);
  if (!ex) return;
  showLogForm('expense');
  const f = $('#expense-form');
  f.date.value = ex.date; f.amount.value = ex.amount; f.category.value = ex.category;
  f.note.value = ex.note || ''; setChip('#expense-platform', ex.platform || '');
  state.editExpenseId = id;
  setTitle($('#expense-form-title'), 'Edit expense');
  $('#expense-submit').textContent = 'Update expense 保存';
  showView('log');
  f.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Every record list is a 発車標 row: 種別 flap · M/DD · 行先 (JP⇄EN) + meta ·
// amount · ✕. Keeps li.record[data-id][data-type] for the edit/delete handlers.
const depDate = (iso) => { const [, m, d] = iso.split('-').map(Number); return `${m}/${String(d).padStart(2, '0')}`; };
const dowDate = (iso) => `${dowShort(iso)} ${depDate(iso)}`;
function depRow({ id, type, flap, date, dest, meta, amount, amtCls = '', deletable, extra = '' }) {
  return `<li class="record dep-rec" data-id="${id}" data-type="${type}">
      ${flap}
      ${date ? `<span class="dep-date">${date}</span>` : ''}
      <div class="rec-main"><div class="rec-title dep-dest">${dest}</div>${meta ? `<div class="rec-sub">${meta}</div>` : ''}</div>
      <div class="rec-amount ${amtCls}">${amount}</div>
      ${extra}${deletable ? `<button class="rec-del" data-del="${type}" data-id="${id}" aria-label="Delete">✕</button>` : '<span class="rec-del-gap"></span>'}
    </li>`;
}
const flapHTML = (label, color, ink = '#fff', cls = '') => `<span class="dep-type ${cls}" style="--tc:${color};--ink:${ink}">${label}</span>`;

function recordRow(item, type, deletable = true) {
  if (type === 'shift') {
    const bits = [];
    if (item.startTime && item.endTime) bits.push(`${item.startTime}–${item.endTime}`);
    if (item.scheduledHours) {
      const pct = item.hours ? Math.round((item.hours / item.scheduledHours) * 100) : null;
      bits.push(`${fmt1(item.hours)}/${fmt1(item.scheduledHours)}h${pct != null ? ` (${pct}%)` : ''}`);
    } else if (item.hours) {
      bits.push(`${fmt1(item.hours)}h`);
    }
    if (item.jobs) bits.push(`${item.jobs} jobs`);
    if (item.miles) bits.push(`${fmt1(item.miles)} mi`);
    if (item.notes) bits.push(escapeHtml(item.notes));
    const ty = trainType(item);
    const p = PLATFORMS[item.platform] || PLATFORMS.other;
    return depRow({
      id: item.id, type, deletable, date: depDate(item.date),
      flap: flapHTML(ty.label, ty.color, ty.ink),
      dest: swapHTML(p.jp, p.label.toUpperCase()), meta: bits.join(' · '),
      amount: fmtMoney0(store.shiftIncome(item)),
    });
  }
  if (type === 'trip') {
    const dep = item.miles * store.getSettings().mileageRate;
    const dur = item.durationMs ? fmtHM(item.durationMs / 3600000) : '';
    return depRow({
      id: item.id, type, deletable,
      flap: flapHTML('GPS', '#14b8a6', '#04221f'),
      dest: `<span class="led">${fmt1(item.miles)} mi</span>`,
      meta: [dowDate(item.date), dur, 'tax deduction'].filter(Boolean).join(' · '),
      amount: fmtMoney(dep), amtCls: 'pos',
    });
  }
  if (type === 'income') {
    const how = item.payType === 'hourly'
      ? `${fmtHM(item.hours)} × ${fmtMoney(item.rate)}/hr${item.startTime ? ` (${item.startTime}–${item.endTime})` : ''}`
      : 'flat';
    const src = escapeHtml(item.source || 'Income');
    return depRow({
      id: item.id, type, deletable, date: depDate(item.date),
      flap: flapHTML('収入', '#e9eef6', '#111'),
      dest: swapHTML(src, src.toUpperCase()),
      meta: `${how}${item.note ? ' · ' + escapeHtml(item.note) : ''}`,
      amount: fmtMoney0(item.amount),
    });
  }
  const jp = CATEGORY_JP[item.category] || item.category;
  const plat = item.platform && PLATFORMS[item.platform];
  const auto = item.linkedShiftId && item.category === 'Fuel';
  return depRow({
    id: item.id, type: 'expense', deletable,
    flap: flapHTML(jp, '#3a4150'),
    dest: swapHTML(`${jp}${plat ? ' · ' + plat.jp : ''}`, `${escapeHtml(item.category)}${plat ? ' · ' + plat.short : ''}`.toUpperCase()),
    meta: `${dowDate(item.date)}${item.note ? ' · ' + escapeHtml(item.note) : ''}${auto ? ' <span class="auto-pill">auto</span>' : ''}`,
    amount: '−' + fmtMoney(item.amount), amtCls: 'neg',
  });
}
// Column headings for a 発車標 list.
const DEP_HEAD = `<li class="dep-headrow dep-rec-head" aria-hidden="true"><span>${swapHTML('種別', 'TYPE')}</span><span>${swapHTML('日付', 'DATE')}</span><span>${swapHTML('行先', 'DEST')}</span><span>${swapHTML('収入', 'PAY')}</span><span></span></li>`;

function renderLogList() {
  const list = $('#log-list');
  if (state.logMode === 'shift') {
    // Gig shifts and manual income together, newest first.
    setTitle($('#log-list-title'), 'Shifts & income');
    const rows = [
      ...store.getShifts().map((item) => ({ item, type: 'shift' })),
      ...store.getIncomes().map((item) => ({ item, type: 'income' })),
    ].sort((a, b) => (a.item.date < b.item.date ? 1 : a.item.date > b.item.date ? -1
      : (b.item.createdAt || '').localeCompare(a.item.createdAt || '')));
    list.innerHTML = rows.length ? DEP_HEAD + rows.map((r) => recordRow(r.item, r.type)).join('')
      : '<li class="empty-list">Nothing logged yet — pick a platform above (or Income).</li>';
  } else if (state.logMode === 'plan') {
    renderPlanList(list);
  } else if (state.logMode === 'expense') {
    setTitle($('#log-list-title'), 'All expenses');
    const exp = store.getExpenses();
    list.innerHTML = exp.length ? exp.map((e) => recordRow(e, 'expense')).join('')
      : '<li class="empty-list">No expenses logged yet.</li>';
  } else {
    setTitle($('#log-list-title'), 'GPS mileage log');
    const trips = store.getTrips();
    list.innerHTML = trips.length ? trips.map((t) => recordRow(t, 'trip')).join('')
      : '<li class="empty-list">No tracked drives yet — tap “Start drive” on Home.</li>';
  }
}

// =====================================================================
// Planner (Log → Plan): pre-plan blocks/shifts with estimated earnings.
// Plans never count as income; they feed the Campaign "income trajectory"
// until you tap "Log it", which opens the real form prefilled and links them.
// =====================================================================
const dowShort = (iso) => new Date(iso + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short' });

function initPlanner() {
  const f = $('#plan-form');
  bindChips('#plan-platform');
  bindChips('#plan-tag');
  $('#plan-platform').addEventListener('click', (e) => { if (e.target.closest('.chip')) updatePlanUI(); });
  // Block length: pick a length and the finish follows the start.
  $$('#plan-blockpreset .chip').forEach((c) => c.addEventListener('click', () => {
    const on = !c.classList.contains('active');
    $$('#plan-blockpreset .chip').forEach((x) => x.classList.toggle('active', on && x === c));
    applyPlanPreset();
  }));
  f.startTime.addEventListener('input', () => { applyPlanPreset(); updatePlanLive(); });
  f.endTime.addEventListener('input', () => {
    // A hand-typed finish that no longer matches the chosen length clears it.
    const len = planPresetHours();
    if (len && f.startTime.value && store.hoursBetween(f.startTime.value, f.endTime.value) !== len) {
      $$('#plan-blockpreset .chip').forEach((x) => x.classList.remove('active'));
    }
    updatePlanLive();
  });
  ['date', 'estimate'].forEach((n) => f[n].addEventListener('input', updatePlanLive));
  f.addEventListener('submit', onSavePlan);
  $('#plan-reset').addEventListener('click', () => resetPlanForm());
  $('#camp-add-plan').addEventListener('click', () => { resetPlanForm(); showLogForm('plan'); showView('log'); });
  f.date.value = store.todayISO();
  updatePlanUI();
}

function planPresetHours() {
  const c = $('#plan-blockpreset .chip.active');
  return c && chipValue('#plan-platform') === 'flex' ? parseFloat(c.dataset.val) : 0;
}
function applyPlanPreset() {
  const f = $('#plan-form');
  const len = planPresetHours();
  if (len && f.startTime.value) f.endTime.value = addHoursToTime(f.startTime.value, len);
  updatePlanLive();
}

function updatePlanUI() {
  const plat = chipValue('#plan-platform');
  $$('#plan-form .plan-flex').forEach((el) => el.classList.toggle('hidden', plat !== 'flex'));
  $$('#plan-form .plan-income').forEach((el) => el.classList.toggle('hidden', plat !== 'income'));
  $('#plan-time-hint').textContent = plat === 'income' ? 'optional' : '';
  updatePlanLive();
}

// Suggested estimate for the plan on screen: what you've made in that weekday
// + time slot on that platform (best-hours history), else your recent $/hr.
function planSuggestion(f) {
  const plat = chipValue('#plan-platform');
  const hours = store.hoursBetween(f.startTime.value, f.endTime.value);
  if (plat === 'income' || !hours) return { value: 0, rate: 0 };
  const e = store.estimateFor({ date: f.date.value || store.todayISO(), startTime: f.startTime.value, endTime: f.endTime.value, platform: plat });
  return { value: e.estimate, rate: e.rate, fromSlot: e.fromSlot };
}

function updatePlanLive() {
  const f = $('#plan-form');
  const hours = store.hoursBetween(f.startTime.value, f.endTime.value);
  const dur = $('#plan-dur');
  dur.classList.toggle('hidden', !hours);
  if (hours) dur.innerHTML = `= <b>${fmtHM(hours)}</b> planned${f.endTime.value < f.startTime.value ? ' · <span class="tr-night">overnight</span>' : ''}`;

  // Estimate: blank uses your average $/hr on this platform.
  const sug = planSuggestion(f);
  f.estimate.placeholder = sug.value ? String(sug.value) : '84.00';
  $('#plan-est-hint').textContent = sug.value ? `blank = ${fmtMoney0(sug.value)} at your ${fmtMoney(sug.rate)}/hr ${sug.fromSlot ? 'for this slot' : 'avg'}` : '';

  // Checks: clashes with other plans + what this does to the week's goal.
  const est = parseFloat(f.estimate.value) || sug.value;
  const draft = { id: state.editPlanId, date: f.date.value, startTime: f.startTime.value, endTime: f.endTime.value };
  const notes = [];
  const clash = f.date.value ? store.planOverlaps(draft) : [];
  if (clash.length) {
    notes.push(`<div class="pc-warn">⚠ Overlaps ${clash.map((p) => `${p.startTime}–${p.endTime} ${planName(p)}`).join(', ')}</div>`);
  }
  const today = store.todayISO();
  const w = store.weeklyGoalStats();
  if (est > 0 && f.date.value >= today && f.date.value >= w.start && f.date.value <= w.end) {
    let proj = w.projected + est;
    const old = state.editPlanId && store.getPlans().find((p) => p.id === state.editPlanId);
    if (old && old.date >= today && old.date <= w.end && !store.planLogged(old)) proj -= old.estimate;
    notes.push(proj >= w.goal
      ? `<div class="pc-ok">✓ With this, this week's plan reaches the ${fmtMoney0(w.goal)} goal (${fmtMoney0(proj)})</div>`
      : `<div>This week with this plan: <b>${fmtMoney0(proj)}</b> / ${fmtMoney0(w.goal)} — ${fmtMoney0(w.goal - proj)} short</div>`);
  }
  $('#plan-check').innerHTML = notes.join('');
}

const planName = (p) => (p.platform === 'income' ? (p.source || 'Income') : (PLATFORMS[p.platform] || PLATFORMS.other).short);

function onSavePlan(e) {
  e.preventDefault();
  const f = e.target;
  const platform = chipValue('#plan-platform') || 'flex';
  const hasStart = !!f.startTime.value, hasEnd = !!f.endTime.value;
  if (!f.date.value) { toast('Pick a date'); return; }
  if (hasStart !== hasEnd) { toast('Enter both start and finish times'); return; }
  if (platform !== 'income' && !hasStart) { toast('Enter the start and finish times'); return; }
  if (hasStart && f.startTime.value === f.endTime.value) { toast('Finish time must differ from start'); return; }
  const estimate = parseFloat(f.estimate.value) || planSuggestion(f).value;
  if (!(estimate > 0)) { toast('Enter estimated earnings'); return; }
  const data = {
    date: f.date.value, platform,
    startTime: f.startTime.value, endTime: f.endTime.value,
    tag: platform === 'flex' ? chipValue('#plan-tag') : '',
    estimate, source: platform === 'income' ? f.source.value : '', note: f.note.value,
  };
  const clash = store.planOverlaps({ ...data, id: state.editPlanId });
  if (state.editPlanId) store.updatePlan(state.editPlanId, data);
  else store.addPlan(data);
  toast(clash.length ? `Plan saved — overlaps ${clash[0].startTime}–${clash[0].endTime} ${planName(clash[0])}` : (state.editPlanId ? 'Plan updated' : 'Plan saved ✓'));
  const keepDate = data.date; // planning a run of blocks on one day is common
  resetPlanForm();
  f.date.value = keepDate;
  updatePlanLive();
  renderLogList();
}

function resetPlanForm() {
  const f = $('#plan-form');
  f.reset();
  f.date.value = store.todayISO();
  setChip('#plan-platform', 'flex');
  setChip('#plan-tag', '');
  $$('#plan-blockpreset .chip').forEach((x) => x.classList.remove('active'));
  state.editPlanId = null;
  setTitle($('#plan-form-title'), 'Plan a block');
  $('#plan-submit').textContent = 'Save plan 保存';
  updatePlanUI();
}

function editPlan(id) {
  const p = store.getPlans().find((x) => x.id === id);
  if (!p) return;
  resetPlanForm();
  showLogForm('plan');
  const f = $('#plan-form');
  state.editPlanId = id;
  setChip('#plan-platform', p.platform);
  setChip('#plan-tag', p.tag || '');
  const preset = $$('#plan-blockpreset .chip').find((c) => parseFloat(c.dataset.val) === p.hours);
  if (p.platform === 'flex' && preset) preset.classList.add('active');
  f.date.value = p.date; f.startTime.value = p.startTime; f.endTime.value = p.endTime;
  f.estimate.value = p.estimate || ''; f.source.value = p.source || ''; f.note.value = p.note || '';
  setTitle($('#plan-form-title'), 'Edit plan');
  $('#plan-submit').textContent = 'Update plan 保存';
  updatePlanUI();
  f.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// "Plan this slot" from the best-hours heat map: the planning desk on a wide
// screen; on a phone, the Log → Plan form prefilled with a 3-hour block there.
function planSlot(date, hour) {
  if (window.matchMedia('(min-width: 960px)').matches) { focusSlot(date, hour); return; }
  resetPlanForm();
  showLogForm('plan');
  showView('log');
  const f = $('#plan-form');
  const hh = (h) => `${String(h % 24).padStart(2, '0')}:00`;
  const end = Math.min(hour + 3, 24);
  const best = ['flex', 'doordash', 'other'].map((p) => ({ p, e: store.estimateFor({ date, startTime: hh(hour), endTime: hh(end), platform: p }) }))
    .filter((x) => x.e.fromSlot).sort((a, b) => b.e.rate - a.e.rate)[0];
  if (best) setChip('#plan-platform', best.p);
  f.date.value = date; f.startTime.value = hh(hour); f.endTime.value = hh(end);
  updatePlanUI();
  f.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// "Log it": open the real shift/income form prefilled from the plan. The
// estimate goes in as the pay — adjust it to what you actually made.
function logPlan(id) {
  const p = store.getPlans().find((x) => x.id === id);
  if (!p) return;
  resetShiftForm();
  showLogForm('shift');
  showView('log');
  state.fromPlanId = id;
  const f = $('#shift-form');
  setChip('#shift-platform', p.platform);
  if (p.platform === 'income') {
    f.source.value = p.source || '';
    setPayType('flat');
    f.amount.value = p.estimate || '';
  } else {
    f.gross.value = p.estimate || '';
    if (p.platform === 'flex') { setChip('#shift-tag', p.tag || ''); setBlockPreset(p.hours || 0); }
    if (p.startTime && p.endTime) fillFormTime(f, p);
  }
  f.date.value = p.date;
  f.notes.value = p.note || '';
  updateFlexUI();
  toast('Plan loaded — set your actual pay & times, then save');
  f.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function planRow(p, today) {
  const st = store.planStatus(p, today);
  const plat = PLATFORMS[p.platform];
  const color = p.platform === 'income' ? '#e9eef6' : (plat ? plat.color : PLATFORMS.other.color);
  const when = p.startTime ? `${p.startTime}–${p.endTime}` : 'Anytime';
  const pill = { logged: 'Logged ✓', missed: 'Missed', today: 'Today', upcoming: '' }[st];
  let amount = `<span class="led">${fmtMoney0(p.estimate)}</span><small>est</small>`;
  if (st === 'logged') {
    const rec = p.loggedType === 'income' ? store.getIncomes().find((x) => x.id === p.loggedId) : store.getShifts().find((x) => x.id === p.loggedId);
    const actual = rec ? (p.loggedType === 'income' ? rec.amount : store.shiftIncome(rec)) : 0;
    amount = `<span class="led">${fmtMoney0(actual)}</span><small>vs ${fmtMoney0(p.estimate)} est</small>`;
  }
  const ty = p.tag && TRAIN_TYPES[p.tag];
  const name = p.platform === 'income' ? planName(p) : (plat || PLATFORMS.other).label;
  const nameJP = p.platform === 'income' ? escapeHtml(p.source || '収入') : (plat ? plat.jp : name);
  const extra = [p.hours ? fmtHM(p.hours) : '', p.note ? escapeHtml(p.note) : ''].filter(Boolean).join(' · ');
  const canLog = st === 'today' || st === 'missed';
  return `<li class="record plan-row st-${st}" data-id="${p.id}" data-type="plan">
    <span class="plan-bar" style="--c:${color}"></span>
    <div class="rec-main">
      <div class="rec-title"><span class="led plan-when">${when}</span>${ty ? flapHTML(ty.label, ty.color, ty.ink, 'sm') : ''}${pill ? ` <span class="plan-pill">${pill}</span>` : ''}</div>
      <div class="rec-sub">${swapHTML(nameJP, escapeHtml(name).toUpperCase())}${extra ? ` · ${extra}` : ''}</div>
    </div>
    <div class="rec-amount plan-amt">${amount}</div>
    <span class="plan-acts">${canLog ? `<button type="button" class="btn plan-log" data-log-plan="${p.id}">Log it</button>` : ''}<button class="rec-del" data-del="plan" data-id="${p.id}" aria-label="Delete">✕</button></span>
  </li>`;
}

// Agenda: last 7 days (to catch missed/logged) through everything ahead,
// grouped by day with each day's planned total.
function renderPlanList(list) {
  const today = store.todayISO();
  const from = store.isoDate(new Date(Date.now() - 7 * 86400000));
  const plans = store.getPlans().filter((p) => p.date >= from);
  setTitle($('#log-list-title'), 'Planner');
  if (!plans.length) {
    list.innerHTML = '<li class="empty-list">No plans yet — plan your next blocks above to see your income trajectory.</li>';
    return;
  }
  const byDay = new Map();
  plans.forEach((p) => { if (!byDay.has(p.date)) byDay.set(p.date, []); byDay.get(p.date).push(p); });
  let html = '';
  for (const [date, ps] of byDay) {
    const open = ps.filter((p) => !store.planLogged(p) && p.date >= today).reduce((a, p) => a + p.estimate, 0);
    const rel = date === today ? ' · 今日 Today' : date === store.isoDate(new Date(Date.now() - 86400000)) ? ' · 昨日' : '';
    html += `<li class="plan-day${date === today ? ' is-today' : ''}"><span>${dowDate(date).toUpperCase()}${rel}</span>${open ? `<b class="led">${fmtMoney0(open)} planned</b>` : ''}</li>`;
    html += ps.map((p) => planRow(p, today)).join('');
  }
  list.innerHTML = html;
}

// event delegation for lists (edit on row, delete on ✕)
document.addEventListener('click', (e) => {
  const logBtn = e.target.closest('[data-log-plan]');
  if (logBtn) { e.stopPropagation(); logPlan(logBtn.dataset.logPlan); return; }
  const del = e.target.closest('[data-del]');
  if (del) {
    e.stopPropagation();
    const { del: type, id } = del.dataset;
    if (!confirm('Delete this entry?')) return;
    if (type === 'shift') store.deleteShift(id);
    else if (type === 'expense') store.deleteExpense(id);
    else if (type === 'income') store.deleteIncome(id);
    else if (type === 'plan') store.deletePlan(id);
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
    else if (row.dataset.type === 'plan') editPlan(row.dataset.id);
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
  const flapCls = c.todayHit ? 'grn' : (c.todayTotal > 0 ? 'org flip' : 'gry');
  // 14 LED cells: earned = lit, still planned today = teal stripes, rest unlit.
  const N = 14;
  const lit = Math.min(N, Math.round((c.todayTotal / c.daily) * N));
  const planCells = c.todayHit ? 0 : Math.min(N - lit, Math.round((todayPlanned() / c.daily) * N));
  const cells = Array.from({ length: N }, (_, i) => `<span class="${i < lit ? 'lit' : i < lit + planCells ? 'plan' : ''}"></span>`).join('');
  const hero = $('#camp-hero');
  hero.className = `card camp-hero ${st}`;
  hero.innerHTML = `
    <div class="ch-top">
      <span class="ch-label">本日 TODAY · 残り${c.daysRemaining}日 ${c.daysRemaining} DAYS LEFT</span>
      <span class="flap ${flapCls}" title="${label}">${jp}</span>
    </div>
    <div class="ch-amount">${fmtMoney0(c.todayTotal)} <span class="ch-goal">/ ${fmtMoney0(c.daily)}</span></div>
    <div class="ch-cells" aria-hidden="true">${cells}</div>
    <div class="ch-sub">${label} · CAMPAIGN 350</div>
    ${todayPlanLine(c)}`;
  renderCampaignMarquee(c);

  // Weekly + monthly goals — hit early and the rest of the period is days off;
  // income logged on a day off rolls over and lowers the next period's goal.
  renderGoalCard($('#week-goal'), store.weeklyGoalStats(), { unit: 'week', title: 'WEEKLY GOAL', jp: '週間目標' });
  renderGoalCard($('#month-goal'), store.monthlyGoalStats(), { unit: 'month', title: 'MONTHLY GOAL', jp: '月間目標' });
  renderTrajectory(c);

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
      <div class="k-label"><span class="jp">${k.jp}</span> ${k.label.toUpperCase()}</div>
      <div class="k-value">${k.value}</div>
      <div class="k-sub">${k.sub}</div>
    </div>`).join('');

  // 14-day chart with a dashed $350 reference line
  const to = store.todayISO();
  const fromD = new Date(); fromD.setDate(fromD.getDate() - 13);
  const days = store.dailyTotals(store.isoDate(fromD), to);
  const data = days.map((d) => {
    const dd = new Date(d.date + 'T00:00:00');
    const color = d.total >= c.daily ? '#3dff7a' : (d.total > 0 ? '#ffcf7a' : '#1a2030');
    return { label: d.date === to ? '今日' : String(dd.getDate()), values: { t: d.total }, color };
  });
  charts.barChart($('#camp-chart'), data, [{ key: 't', label: 'Total', color: '#3dff7a' }], {
    refLine: { value: c.daily, label: `$${c.daily}`, color: '#ffcf7a' }, empty: 'No data yet',
  });

  // Ledger — last ~60 days, gig shifts + manual income, newest first
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 59);
  const cutISO = store.isoDate(cutoff);
  const rows = [
    ...store.getShifts().filter((s) => s.date >= cutISO).map((item) => ({ kind: 'shift', item })),
    ...store.getIncomes().filter((i) => i.date >= cutISO).map((item) => ({ kind: 'income', item })),
  ].sort((a, b) => (a.item.date < b.item.date ? 1 : a.item.date > b.item.date ? -1 : 0));
  $('#camp-ledger').innerHTML = rows.length
    ? DEP_HEAD + rows.map((r) => (r.kind === 'shift' ? recordRow(r.item, 'shift', false) : recordRow(r.item, 'income', true))).join('')
    : '<li class="empty-list">No income logged in the last 60 days.</li>';
}

// Today's still-to-come plans, shown on the Campaign hero.
function todayPlanned() {
  const t = store.todayISO();
  return store.trajectory(t, t)[0].planned;
}
// The まもなく board under the Campaign hero: $ to go today, the next planned
// block, and the week — each line in Japanese then English.
function renderCampaignMarquee(c) {
  const host = $('#camp-marquee');
  if (!host) return;
  const today = store.todayISO();
  const items = [];
  if (c.todayHit) items.push('本日 350 達成', 'TODAY $350 HIT');
  else if (c.todayTotal > 0) items.push('まもなく 350 達成', `あと ${fmtMoney0(c.daily - c.todayTotal)}`, `${fmtMoney0(c.daily - c.todayTotal)} TO GO`);
  const next = store.getPlans().find((p) => p.date >= today && !store.planLogged(p));
  if (next) {
    const when = `${next.date === today ? '' : dowShort(next.date) + ' '}${next.startTime || ''}`.trim();
    const jpName = next.platform === 'income' ? (next.source || '収入') : (PLATFORMS[next.platform] || PLATFORMS.other).jp;
    const enName = next.platform === 'income' ? (next.source || 'INCOME').toUpperCase() : (PLATFORMS[next.platform] || PLATFORMS.other).label.toUpperCase();
    items.push(`次は ${when} ${jpName} +${fmtMoney0(next.estimate)}`, `NEXT ${when} ${enName}`);
  }
  const w = store.weeklyGoalStats();
  items.push(`今週 ${fmtMoney0(w.earned)} / ${fmtMoney0(w.goal)}`);
  host.classList.toggle('hidden', !items.length);
  const line = items.map((t) => `<span>${escapeHtml(t)}</span><span>◆</span>`).join('');
  $('#camp-marq-track').innerHTML = line + line; // doubled for a seamless loop
}
function todayPlanLine(c) {
  const planned = todayPlanned();
  if (!planned) return '';
  const proj = c.todayTotal + planned;
  return `<div class="ch-plan">予定 +${fmtMoney0(planned)} planned today → ${fmtMoney0(proj)}${proj >= c.daily ? ' · on track for $350 ✓' : ` · ${fmtMoney0(c.daily - proj)} short of $350`}</div>`;
}

// Income trajectory: this week + next week (Mon–Sun ×2), real income as solid
// bars and planned (not yet logged) income as dashed bars, vs the $350 line.
function renderTrajectory(c) {
  const host = $('#traj-chart');
  if (!host) return;
  const today = store.todayISO();
  const start = store.isoDate(store.startOfWeek(new Date()));
  const endD = new Date(start + 'T00:00:00'); endD.setDate(endD.getDate() + 13);
  const days = store.trajectory(start, store.isoDate(endD), today);
  const data = days.map((d) => {
    const dd = new Date(d.date + 'T00:00:00');
    const total = d.actual + d.planned;
    const actualColor = d.actual >= c.daily ? '#3dff7a' : '#e8f1ff';
    return {
      // Day numbers keep 14 labels legible on a phone; today reads 今日.
      label: d.date === today ? '今日' : String(dd.getDate()),
      values: { actual: d.actual, planned: d.planned },
      colors: { actual: actualColor, planned: total >= c.daily ? '#3dff7a' : '#2dd4bf' },
    };
  });
  const series = [
    { key: 'actual', label: 'Earned', color: '#e8f1ff' },
    { key: 'planned', label: 'Planned', color: '#2dd4bf', planned: true },
  ];
  charts.barChart(host, data, series, {
    refLine: { value: c.daily, label: `$${c.daily}`, color: '#ffcf7a' }, empty: 'No data yet',
  });
  charts.legend($('#traj-legend'), series);

  // Summary: what's planned ahead, and the days (today onward) that are still
  // under $350 even with the plan — where to stack more.
  const ahead = days.filter((d) => d.date >= today);
  const plannedAhead = ahead.reduce((a, d) => a + d.planned, 0);
  const blocks = store.getPlans().filter((p) => p.date >= today && p.date <= store.isoDate(endD) && !store.planLogged(p)).length;
  const gaps = ahead.filter((d) => d.actual + d.planned < c.daily);
  const gapTxt = gaps.length
    ? `Under $${c.daily} even with the plan: ${gaps.slice(0, 5).map((d) => `${dowShort(d.date)} ${d.date.slice(5).replace('-', '/')}`).join(', ')}${gaps.length > 5 ? ` +${gaps.length - 5} more` : ''} — fine if they're days off, otherwise stack more there.`
    : `Every day through ${dowShort(store.isoDate(endD))} reaches $${c.daily} with your plan ✓`;
  $('#traj-sum').innerHTML = `
    <div><b>${fmtMoney0(plannedAhead)}</b> planned across ${blocks} block${blocks === 1 ? '' : 's'} (next two weeks)</div>
    <div class="traj-gaps">${gapTxt}</div>`;
}

// One goal card (weekly or monthly) from store.periodGoalStats-shaped data.
function renderGoalCard(el, g, { unit, title, jp }) {
  if (!el) return;
  const dayN = (n) => `${n} day${n === 1 ? '' : 's'}`;
  el.className = `card week-goal ${g.met ? 'is-met' : (g.earned > 0 ? 'is-part' : 'is-none')}`;
  let msg;
  if (g.met) {
    msg = g.daysOff > 0
      ? `<b>${dayN(g.daysOff)} off earned</b> — ${unit}ly goal met with days to spare`
      : `<b>${unit === 'week' ? 'Weekly' : 'Monthly'} goal met</b> — nice finish to the ${unit}`;
  } else if (g.daysLeft === 0) {
    msg = `${fmtMoney0(g.remaining)} short — last day of the ${unit}`;
  } else {
    msg = `${fmtMoney0(g.remaining)} to go · ${fmtMoney0(g.perDayNeeded)}/day over ${dayN(g.daysLeft + 1)}`;
  }
  const notes = [];
  if (g.carryIn > 0) {
    notes.push(`↻ ${fmtMoney0(g.carryIn)} rolled over from last ${unit} — goal lowered from ${fmtMoney0(g.baseGoal)}`);
  }
  if (g.todayOff) notes.push(`Today is an earned day off — anything you log rolls into next ${unit}`);
  if (g.banked > 0) notes.push(`+${fmtMoney0(g.banked)} logged on days off → next ${unit}'s goal drops by that much`);

  // Income trajectory: what the planner says the rest of the period brings.
  let planNote = '';
  if (g.met) {
    if (g.planned > 0) planNote = `予定 ${fmtMoney0(g.planned)} planned on days off → rolls into next ${unit}`;
  } else if (g.planned > 0 && g.projMet) {
    planNote = `予定 Your plan reaches the goal ${g.projMetOn === store.todayISO() ? 'today' : `on ${dowShort(g.projMetOn)}`}`
      + (g.projDaysOff > 0 ? ` → <b>${dayN(g.projDaysOff)} off</b>` : '');
  } else if (g.planned > 0) {
    planNote = `予定 ${fmtMoney0(g.planned)} planned → ${fmtMoney0(g.projected)} · <b>plan ${fmtMoney0(g.shortfall)} more</b> by ${dowShort(g.end)}`;
  } else {
    planNote = `予定 Nothing planned yet — plan ${fmtMoney0(g.remaining)} by ${dowShort(g.end)}`;
  }
  // Planned share of the bar, after what's already earned.
  const planPct = g.goal > 0 && !g.met ? Math.min(100 - g.pct, (g.planned / g.goal) * 100) : 0;
  el.innerHTML = `
    <div class="wg-top">
      <span class="wg-title">${title}<span class="jp">${jp}</span></span>
      <span class="wg-days">${g.met ? dayN(g.daysOff) : dayN(g.daysLeft)}<em>${g.met ? 'off · 休み' : 'left · 残り'}</em></span>
    </div>
    <div class="wg-amount">${fmtMoney0(g.earned)} <span class="wg-goal">/ ${fmtMoney0(g.goal)} this ${unit}</span></div>
    <div class="ch-bar"><span style="width:${g.pct}%"></span>${planPct > 0 ? `<i class="plan-seg" style="width:${planPct}%"></i>` : ''}</div>
    <div class="wg-msg">${msg}</div>
    ${planNote ? `<div class="wg-plan${g.projMet && !g.met ? ' ok' : ''}">${planNote}</div>` : ''}
    ${notes.map((n) => `<div class="wg-note">${n}</div>`).join('')}`;
}

// =====================================================================
// Trends
// =====================================================================
function renderTrends() {
  const shifts = store.getShifts();
  const expenses = store.getExpenses();
  renderTaxSummary();
  renderBestHours();

  // Flex pay by block type — LED bar per 種別, best rate lit green.
  const byTag = store.flexByTag(shifts);
  const ftCard = $('#flex-tag-card');
  if (byTag.length) {
    ftCard.classList.remove('hidden');
    const ranked = [...byTag].sort((a, b) => b.perHour - a.perHour);
    const best = ranked[0];
    const top = best.perHour || 1;
    $('#flex-tag-best').textContent = byTag.length > 1 ? `best: ${TRAIN_TYPES[best.tag]?.label || best.tag}` : '';
    $('#flex-tag-list').innerHTML = ranked.map((t) => {
      const ty = TRAIN_TYPES[t.tag] || TRAIN_TYPES.Local;
      const isBest = t === best && byTag.length > 1;
      const meta = [t.tag, `${t.count} block${t.count !== 1 ? 's' : ''}`, `${fmtMoney0(t.count ? t.income / t.count : 0)}/block`, t.effPct ? `${Math.round(t.effPct)}% block time` : ''].filter(Boolean).join(' · ');
      return `<li class="tag-row${isBest ? ' best' : ''}">
        ${flapHTML(ty.label, ty.color, ty.ink)}
        <span class="tag-mid"><span class="exp-track"><span class="led" style="width:${Math.max(2, (t.perHour / top) * 100)}%"></span></span><span class="tag-meta">${meta}</span></span>
        <span class="led ts-rate${isBest ? ' best' : ''}">${t.perHour ? fmtMoney(t.perHour) : '—'}</span>
      </li>`;
    }).join('');
  } else {
    ftCard.classList.add('hidden');
  }

  // Weekly net (last 8 weeks): weeks that hit the weekly goal light green,
  // the current week gold (still running).
  const weeks = groupByWeek(shifts, expenses, 8);
  const weekGoal = store.CAMPAIGN.daily * 7;
  const thisWeek = store.isoDate(store.startOfWeek(new Date()));
  charts.barChart($('#chart-weekly-net'),
    weeks.map((w) => ({ label: w.label, values: { net: Math.max(0, w.net) }, color: w.key === thisWeek ? '#ffcf7a' : w.net >= weekGoal ? '#3dff7a' : '#e8f1ff' })),
    [{ key: 'net', label: 'Net', color: '#e8f1ff' }],
    { empty: 'Not enough data yet' });
  $('#trend-net-note').textContent = `goal ${fmtMoney0(weekGoal)}`;

  // Hourly rate trend — latest week's rate in the header
  const rates = weeks.map((w) => (w.hours ? w.income / w.hours : 0));
  const lastRate = [...rates].reverse().find((r) => r > 0);
  $('#hourly-latest').textContent = lastRate ? fmtMoney(lastRate) : '';
  charts.lineChart($('#chart-hourly'),
    weeks.map((w, i) => ({ label: w.label, values: { rate: rates[i] } })),
    [{ key: 'rate', label: '$/hr', color: '#e8f1ff' }],
    { empty: 'Log hours to see this' });

  // Income vs expenses monthly (last 6 months), side by side
  const months = groupByMonth(shifts, expenses, 6);
  charts.barChart($('#chart-income-expense'),
    months.map((m) => ({ label: m.label, values: { income: m.income, exp: m.expense } })),
    [{ key: 'income', label: 'Income', color: '#e8f1ff' }, { key: 'exp', label: 'Expenses', color: '#ff6b5f' }],
    { empty: 'Not enough data yet', grouped: true });

  // Best day of week (avg income per shift), Monday first like the board
  const order = [1, 2, 3, 4, 5, 6, 0];
  const DOW_JP = ['日', '月', '火', '水', '木', '金', '土'];
  const DOW_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const sums = Array(7).fill(0), counts = Array(7).fill(0);
  shifts.forEach((s) => { const d = dayOfWeek(s.date); sums[d] += store.shiftIncome(s); counts[d]++; });
  const avg = (i) => (counts[i] ? sums[i] / counts[i] : 0);
  const bestDay = order.reduce((a, i) => (avg(i) > avg(a) ? i : a), order[0]);
  $('#dow-best').textContent = avg(bestDay) ? `best: ${DOW_JP[bestDay]} ${DOW_EN[bestDay]} ${fmtMoney0(avg(bestDay))} avg` : '';
  charts.barChart($('#chart-dow'),
    order.map((i) => ({ label: DOW_JP[i], values: { avg: avg(i) }, color: i === bestDay && avg(i) ? '#3dff7a' : '#e8f1ff' })),
    [{ key: 'avg', label: 'Avg / shift', color: '#e8f1ff' }],
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
    .map(([k, v]) => ({ key: k, label: labelFn(k), income: v.income, expense: v.expense, hours: v.hours, net: v.income - v.expense }));
}

// =====================================================================
// Import — OCR + CSV
// =====================================================================
function initImport() {
  const ocrFile = $('#ocr-file');
  ocrFile.addEventListener('change', onOcrFile);

  $('#csv-file').addEventListener('change', onCsvFile);

  bindChips('#cal-platform');
  $('#cal-ics-file').addEventListener('change', onCalIcsFile);
  $('#cal-img-file').addEventListener('change', onCalImageFile);
  $('#plan-import').addEventListener('click', () => {
    showView('import');
    $('#cal-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

// ---- Calendar → planner (.ics file or schedule screenshot) ----
// Both sources produce rows for one review list; nothing is saved until you
// tap "Add to planner".
const CAL_WINDOW_DAYS = 60; // import today → +60 days (keeps big calendars sane)
let calRows = [];

async function onCalIcsFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  const status = $('#cal-status');
  status.classList.remove('hidden');
  try {
    const today = store.todayISO();
    const to = store.isoDate(new Date(Date.now() + CAL_WINDOW_DAYS * 86400000));
    const r = parseICS(await file.text(), { fromISO: today, toISO: to });
    const skipped = [
      r.skippedPast ? `${r.skippedPast} past` : '',
      r.skippedLater ? `${r.skippedLater} after ${friendlyDate(to)}` : '',
      r.cancelled ? `${r.cancelled} cancelled` : '',
    ].filter(Boolean).join(', ');
    status.innerHTML = r.events.length
      ? `✓ Found ${r.events.length} upcoming event${r.events.length === 1 ? '' : 's'}${skipped ? ` (skipped ${skipped})` : ''}. Work-looking ones are ticked — review, then add.`
      : `No upcoming events in the next ${CAL_WINDOW_DAYS} days${skipped ? ` (skipped ${skipped})` : ''}.`;
    showCalPreview(r.events);
  } catch (err) {
    status.innerHTML = '⚠️ Couldn’t read that calendar file: ' + escapeHtml(err.message || String(err));
  } finally {
    e.target.value = '';
  }
}

async function onCalImageFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  const status = $('#cal-status');
  status.classList.remove('hidden');
  $('#cal-preview').classList.add('hidden');
  if (!ocrAvailable()) {
    status.innerHTML = '⚠️ Reading a screenshot needs the internet the first time (to download the text engine). Connect and try again, or use an .ics file.';
    e.target.value = '';
    return;
  }
  status.innerHTML = 'Reading schedule… <div class="progress"><span id="cal-bar"></span></div>';
  try {
    const text = await recognize(file, (p) => { const bar = $('#cal-bar'); if (bar) bar.style.width = Math.round(p * 100) + '%'; });
    const today = store.todayISO();
    const events = parseScheduleText(text, today).events.filter((ev) => ev.date >= today);
    status.innerHTML = events.length
      ? `✓ Read ${events.length} block${events.length === 1 ? '' : 's'} — check dates, times and pay (screenshots can misread), then add.`
      : '⚠️ Couldn’t find any time ranges like “9:00 AM – 12:30 PM”. Try a sharper screenshot of the schedule list, or an .ics file.';
    showCalPreview(events);
  } catch (err) {
    status.innerHTML = '⚠️ ' + escapeHtml(err.message || 'Could not read the screenshot');
  } finally {
    e.target.value = '';
  }
}

// Same date + start + finish as a plan you already have → probably a re-import.
function calIsDuplicate(row) {
  return store.getPlans().some((p) => p.date === row.date && p.startTime === row.startTime && p.endTime === row.endTime);
}

function showCalPreview(events) {
  const host = $('#cal-preview');
  const fallback = chipValue('#cal-platform') || 'flex';
  calRows = events.map((ev) => {
    const dupe = calIsDuplicate(ev);
    return { ...ev, platform: ev.platform || fallback, checked: ev.recognized && !dupe, dupe };
  });
  if (!calRows.length) { host.classList.add('hidden'); host.innerHTML = ''; return; }
  const opts = (sel) => ['flex', 'doordash', 'other', 'income']
    .map((v) => `<option value="${v}"${v === sel ? ' selected' : ''}>${v === 'income' ? 'Income' : PLATFORMS[v].label}</option>`).join('');
  host.classList.remove('hidden');
  host.innerHTML = `
    <ul class="cal-list">${calRows.map((r, i) => `
      <li class="cal-row${r.dupe ? ' is-dupe' : ''}" data-i="${i}">
        <label class="cal-pick"><input type="checkbox" data-k="checked"${r.checked ? ' checked' : ''} />
          <span class="cal-title">${escapeHtml(r.summary)}${r.dupe ? ' <span class="plan-pill">already planned</span>' : ''}</span>
        </label>
        ${r.detail ? `<div class="cal-detail">${escapeHtml(r.detail)}</div>` : ''}
        <div class="cal-fields">
          <input type="date" data-k="date" value="${r.date}" aria-label="date" />
          <input type="time" data-k="startTime" value="${r.startTime}" aria-label="start" />
          <input type="time" data-k="endTime" value="${r.endTime}" aria-label="finish" />
          <select data-k="platform" aria-label="platform">${opts(r.platform)}</select>
          <input type="number" data-k="estimate" step="0.01" min="0" inputmode="decimal" value="${r.estimate || ''}" placeholder="${calSuggest(r) || 'est. $'}" aria-label="estimated earnings" />
        </div>
      </li>`).join('')}
    </ul>
    <div class="form-actions">
      <button type="button" class="btn ghost" id="cal-cancel">Cancel</button>
      <button type="button" class="btn primary" id="cal-add"></button>
    </div>`;
  const refreshCount = () => {
    const n = calRows.filter((r) => r.checked).length;
    $('#cal-add').textContent = `Add ${n} to planner`;
    $('#cal-add').disabled = n === 0;
  };
  host.querySelectorAll('.cal-row').forEach((li) => {
    const r = calRows[+li.dataset.i];
    li.querySelectorAll('[data-k]').forEach((inp) => {
      const onEdit = () => {
        r[inp.dataset.k] = inp.type === 'checkbox' ? inp.checked : inp.value;
        if (inp.dataset.k !== 'checked' && inp.dataset.k !== 'estimate') {
          li.querySelector('[data-k=estimate]').placeholder = calSuggest(r) || 'est. $';
        }
        refreshCount();
      };
      inp.addEventListener(inp.type === 'checkbox' || inp.tagName === 'SELECT' ? 'change' : 'input', onEdit);
    });
  });
  $('#cal-cancel').addEventListener('click', () => { host.classList.add('hidden'); $('#cal-status').classList.add('hidden'); calRows = []; });
  $('#cal-add').addEventListener('click', addCalRows);
  refreshCount();
}

// Suggested estimate for an imported row: your $/hr on that platform × hours.
function calSuggest(r) {
  const hours = store.hoursBetween(r.startTime, r.endTime);
  if (r.platform === 'income' || !hours) return 0;
  return store.estimateFor({ date: r.date || store.todayISO(), startTime: r.startTime, endTime: r.endTime, platform: r.platform }).estimate;
}

function addCalRows() {
  const picked = calRows.filter((r) => r.checked && r.date);
  let added = 0, noEstimate = 0;
  for (const r of picked) {
    if (!!r.startTime !== !!r.endTime) continue; // half a time range — skip
    const estimate = parseFloat(r.estimate) || calSuggest(r);
    if (!(estimate > 0)) noEstimate += 1;
    store.addPlan({
      date: r.date, platform: r.platform, startTime: r.startTime, endTime: r.endTime,
      estimate, source: r.platform === 'income' ? r.summary : '',
      note: r.summary.slice(0, 60),
    });
    added += 1;
  }
  calRows = [];
  $('#cal-preview').classList.add('hidden');
  $('#cal-status').innerHTML = `✓ Added ${added} plan${added === 1 ? '' : 's'}.${noEstimate ? ` ${noEstimate} ha${noEstimate === 1 ? 's' : 've'} no estimate yet — tap them in Log → Plan to add one.` : ''}`;
  toast(`Added ${added} to your planner ✓`);
  showLogForm('plan');
  showView('log');
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
  $('#drive-deduction').textContent = `${fmtMoney(0)} mileage deduction so far`;
  const stateEl = $('#drive-state');
  stateEl.textContent = 'GPS 取得中 · GETTING GPS…'; stateEl.className = 'drive-status';

  tracker = new DriveTracker();
  acquireWakeLock();
  driveTimer = setInterval(() => {
    if (tracker) $('#drive-time').textContent = fmtDuration(tracker.elapsedMs);
  }, 1000);

  try {
    await tracker.start((u) => {
      stateEl.innerHTML = swapHTML('記録中', 'TRACKING'); stateEl.className = 'drive-status tracking';
      $('#drive-miles').textContent = u.miles.toFixed(2);
      $('#drive-deduction').textContent = `${fmtMoney(u.miles * store.getSettings().mileageRate)} mileage deduction so far`;
      if (u.accuracy != null) {
        const good = u.accuracy <= 25;
        $('#drive-accuracy').textContent = ` · GPS ±${Math.round(u.accuracy)} m${good ? '' : ' · move to open sky'}`;
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
  showLogForm('shift');
  const f = $('#shift-form');
  // Miles belong to a gig shift — if the form is on Income (miles hidden, maybe
  // mid-edit of an income entry), start a fresh shift instead.
  if (chipValue('#shift-platform') === 'income') resetShiftForm();
  f.date.value = trip.date;
  f.miles.value = (parseFloat(f.miles.value || '0') + trip.miles).toFixed(1);
  // The drive's start/stop times become the shift's start–finish (if not set).
  const hhmm = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
  if (!f.startTime.value && !f.endTime.value && trip.startedAt && trip.endedAt
      && hhmm(trip.startedAt) !== hhmm(trip.endedAt)) { // skip sub-minute drives
    f.startTime.value = hhmm(trip.startedAt);
    f.endTime.value = hhmm(trip.endedAt);
  }
  updateShiftLive();
  showView('log');
  toast(`Logged ${trip.miles.toFixed(1)} mi ✓ — add pay to save the shift`);
  f.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Live station-board clock in the sidebar (desktop).
function startClock() {
  const side = $('#side-clock');
  const hdr = $('#hdr-clock');
  const pad = (n) => String(n).padStart(2, '0');
  let lastMin = -1;
  const tick = () => {
    const d = new Date();
    if (side) side.textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    // Header clock only re-renders when the minute changes; the colon blinks in CSS.
    if (hdr && d.getMinutes() !== lastMin) {
      lastMin = d.getMinutes();
      hdr.innerHTML = `${pad(d.getHours())}<span class="blink">:</span>${pad(d.getMinutes())}`;
    }
  };
  tick();
  setInterval(tick, 1000);
}

// JP ⇄ EN: every .swap on the page flips at the same moment (one class on
// <html> every 3 s), like a real station board. Off under reduce-motion and
// while the page is hidden.
function startLangSwap() {
  decorateSwaps(document);
  // Headings rendered later (goal cards, plan form title…) get decorated too.
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => { queued = false; decorateSwaps(document); });
  }).observe(document.body, { childList: true, subtree: true });
  if (reducedMotion()) return;
  setInterval(() => {
    if (!document.hidden) document.documentElement.classList.toggle('lang-en');
  }, 3000);
}
// "English<span class=jp>日本語</span>" headings → a JP ⇄ EN swap.
function decorateSwaps(root) {
  // Only headings that still hold a raw .jp child (re-rendered ones get redone).
  root.querySelectorAll('.card-head h2, .wg-title, .ch-title').forEach((h) => {
    const jp = h.querySelector(':scope > .jp');
    if (!jp) return;
    const en = [...h.childNodes].filter((n) => n !== jp).map((n) => n.textContent).join('').trim();
    h.setAttribute('aria-label', en);
    h.innerHTML = swapHTML(escapeHtml(jp.textContent.trim()), escapeHtml(en));
  });
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
  $('#set-minmile').value = s.minPerMile;
  $('#set-minhour').value = s.minPerHour;
  $('#set-fuelprice').value = s.fuelPrice;
  $('#set-mpg').value = s.mpg;
  $('#set-minmile').addEventListener('change', (e) => { store.updateSettings({ minPerMile: parseFloat(e.target.value) || 0 }); toast('Saved'); renderOfferVerdict(); });
  $('#set-minhour').addEventListener('change', (e) => { store.updateSettings({ minPerHour: parseFloat(e.target.value) || 0 }); toast('Saved'); renderOfferVerdict(); });
  $('#set-fuelprice').addEventListener('change', (e) => { store.updateSettings({ fuelPrice: parseFloat(e.target.value) || 0 }); toast('Saved'); updateShiftLive(); });
  $('#set-mpg').addEventListener('change', (e) => { store.updateSettings({ mpg: parseFloat(e.target.value) || 0 }); toast('Saved'); updateShiftLive(); });
  $('#set-weekstart').value = String(s.weekStart);
  $('#set-mileage').addEventListener('change', (e) => { store.updateSettings({ mileageRate: parseFloat(e.target.value) || 0 }); toast('Saved'); updateShiftLive(); });
  $('#set-taxrate').addEventListener('change', (e) => { store.updateSettings({ taxRate: (parseFloat(e.target.value) || 0) / 100 }); toast('Saved'); renderDashboard(); });
  $('#set-weekstart').addEventListener('change', (e) => { store.updateSettings({ weekStart: parseInt(e.target.value, 10) }); toast('Saved'); renderTrends(); });

  $('#export-json').addEventListener('click', () => download('gig-tracker-backup.json', store.exportJSON(), 'application/json'));
  $('#export-csv').addEventListener('click', exportShiftsCSV);
  $('#import-json-file').addEventListener('change', onImportJSON);
  $('#clear-all').addEventListener('click', () => {
    const synced = sync.getSyncState().signedIn;
    if (!confirm(`Erase ALL shifts, plans and expenses${synced ? ' — on every synced device too' : ''}? Export a backup first if unsure. This cannot be undone.`)) return;
    store.clearAll(); toast('All data erased'); renderDashboard(); renderLogList();
  });
}

// ---- cloud sync UI (Settings → Cloud sync) ----
function parseFirebaseConfig(txt) {
  const m = txt.match(/\{[\s\S]*\}/);
  const objText = m ? m[0] : txt;
  try { return JSON.parse(objText); } catch { /* fall through */ }
  // tolerate a JS object literal (unquoted keys, single quotes, trailing commas)
  return (new Function('return (' + objText + ')'))();
}

function initSyncUI() {
  if (!$('#sync-card')) return;
  const err = $('#sync-error');
  const showErr = (msg) => { err.textContent = msg || ''; err.classList.toggle('hidden', !msg); };

  $('#sync-guide-toggle').addEventListener('click', (e) => { e.preventDefault(); $('#sync-guide').classList.toggle('hidden'); });
  $('#sync-change-config').addEventListener('click', (e) => { e.preventDefault(); $('#sync-config-field').classList.remove('hidden'); });
  $('#sync-email-toggle').addEventListener('click', (e) => { e.preventDefault(); $('#sync-email-box').classList.toggle('hidden'); });

  $('#sync-save-config').addEventListener('click', async () => {
    const txt = $('#sync-config').value.trim();
    if (!txt) { showErr('Paste your Firebase config first.'); return; }
    let cfg;
    try { cfg = parseFirebaseConfig(txt); } catch { showErr('Couldn’t read that config — paste the firebaseConfig object.'); return; }
    if (!cfg || !cfg.apiKey || !cfg.projectId) { showErr('Config is missing apiKey / projectId.'); return; }
    showErr('');
    await sync.configureSync(cfg);
    toast('Config saved — now sign in');
  });

  $('#sync-google').addEventListener('click', async () => {
    showErr('');
    try { await sync.signInGoogle(); toast('Signed in ✓'); }
    catch (e) { showErr(sync.getSyncState().error || e.message || 'Sign-in failed'); }
  });
  const doAuth = async (which) => {
    const email = $('#sync-email').value.trim();
    const pass = $('#sync-pass').value;
    if (!email || !pass) { showErr('Enter your email and password.'); return; }
    showErr('');
    try { await sync[which](email, pass); $('#sync-pass').value = ''; toast('Signed in ✓'); }
    catch (e) { showErr(sync.getSyncState().error || e.message || 'Sign-in failed'); }
  };
  $('#sync-signin').addEventListener('click', () => doAuth('signIn'));
  $('#sync-signup').addEventListener('click', () => doAuth('signUp'));
  $('#sync-now').addEventListener('click', async () => { await sync.syncNow(); });
  $('#sync-raycast').addEventListener('click', async () => {
    const key = sync.getConnectionKey();
    if (!key) { showErr('Sign in to cloud sync first.'); return; }
    try { await navigator.clipboard.writeText(key); toast('Raycast key copied — paste it in the extension’s preferences'); }
    catch { window.prompt('Copy your Raycast connection key:', key); }
  });
  $('#sync-signout').addEventListener('click', async () => { try { await sync.signOutSync(); toast('Signed out of sync'); } catch { /* ignore */ } });

  const STATUS = { idle: 'Signed out', loading: 'Connecting…', syncing: 'Syncing…', synced: 'Synced ✓', offline: 'Offline — will sync when back online', error: 'Error' };
  const PILL_TXT = { idle: '', loading: '接続中 …', syncing: '同期中 …', synced: '同期中 ON', offline: 'オフライン', error: 'Error' };
  const PILL = { idle: '', loading: 'busy', syncing: 'busy', synced: 'ok', offline: 'busy', error: 'err' };
  const hhmm = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

  sync.onSyncState((st) => {
    let pillText = 'Off', pillCls = '';
    if (st.signedIn) { pillText = PILL_TXT[st.status] || 'On'; pillCls = PILL[st.status] || 'ok'; }
    else if (st.configured) { pillText = st.status === 'error' ? 'Error' : 'Sign in'; pillCls = st.status === 'error' ? 'err' : ''; }
    $('#sync-pill').textContent = pillText;
    $('#sync-pill').className = 'sync-pill ' + pillCls;

    $('#sync-config-field').classList.toggle('hidden', st.configured);
    $('#sync-auth').classList.toggle('hidden', !st.configured || st.signedIn);
    $('#sync-account').classList.toggle('hidden', !st.signedIn);
    $('#sync-change-wrap').classList.toggle('hidden', st.builtIn);
    $('#sync-account-email').textContent = st.email || '';
    $('#sync-status-text').textContent = (STATUS[st.status] || '') + (st.lastSync && st.status === 'synced' ? ` · last synced ${hhmm(st.lastSync)}` : '');
    showErr(st.error || '');
  });
}

function exportShiftsCSV() {
  const rows = [['date', 'platform', 'start', 'finish', 'hours', 'gross', 'tips', 'income', 'jobs', 'miles', 'notes']];
  store.getShifts().forEach((s) => rows.push([s.date, s.platform, s.startTime || '', s.endTime || '', s.hours, s.gross, s.tips, store.shiftIncome(s), s.jobs, s.miles, (s.notes || '').replace(/"/g, '""')]));
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
      $('#set-fuelprice').value = s.fuelPrice; $('#set-mpg').value = s.mpg;
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
// "Worth it?" offer calculator (dashboard)
// =====================================================================
function initOfferCalc() {
  if (!$('#offer-card')) return;
  ['#offer-pay', '#offer-miles', '#offer-min'].forEach((s) => $(s).addEventListener('input', renderOfferVerdict));
  updateOfferAvg();
  renderOfferVerdict();
}

function updateOfferAvg() {
  const el = $('#offer-avg');
  if (!el) return;
  const s = store.summarize(store.getShifts(), store.getExpenses());
  el.textContent = s.perMile ? `your avg ${fmtMoney(s.perMile)}/mi${s.perHour ? ' · ' + fmtMoney(s.perHour) + '/hr' : ''}` : '';
}

function renderOfferVerdict() {
  const host = $('#offer-verdict');
  if (!host) return;
  const v = store.offerVerdict($('#offer-pay').value, $('#offer-miles').value, $('#offer-min').value);
  if (!v.valid) {
    host.innerHTML = '<div class="ov-hint muted">Enter an offer’s pay and miles for an instant take / skip.</div>';
    return;
  }
  const label = v.verdict === 'take' ? 'TAKE IT' : v.verdict === 'skip' ? 'SKIP' : 'MARGINAL';
  const jp = v.verdict === 'take' ? '乗車' : v.verdict === 'skip' ? '見送' : '検討';
  const flapCls = v.verdict === 'take' ? 'grn' : v.verdict === 'skip' ? 'red' : 'gold';
  const hourStat = v.hourOK === null ? ''
    : `<div class="ov-stat ${v.hourOK ? 'good' : 'bad'}"><b>${fmtMoney(v.perHour)}</b><small>/hr · min ${fmtMoney0(v.minPerHour)}</small></div>`;
  host.innerHTML = `<div class="ov-banner ${v.verdict}">
    <span class="flap lg ${flapCls}">${jp}</span>
    <div class="ov-body">
      <div class="ov-verdict-label">${label}</div>
      <div class="ov-stats">
        <div class="ov-stat ${v.mileOK ? 'good' : 'bad'}"><b>${fmtMoney(v.perMile)}</b><small>/mi · min ${fmtMoney(v.minPerMile)}</small></div>
        ${hourStat}
      </div>
    </div>
  </div>`;
}

// =====================================================================
// Year-end tax summary (Trends)
// =====================================================================
function initTaxSummary() {
  if (!$('#tax-summary-card')) return;
  $('#tax-year').addEventListener('change', renderTaxSummary);
  $('#tax-export-csv').addEventListener('click', exportTaxCSV);
  $('#tax-print').addEventListener('click', printTaxSummary);
}

function currentTaxYear() {
  const sel = $('#tax-year');
  return (sel && sel.value) || String(new Date().getFullYear());
}

function taxRowsHTML(t) {
  const row = (label, val, cls = '') => `<div class="tax-row ${cls}"><span class="tr-label">${label}</span><span class="tr-val">${val}</span></div>`;
  const cats = Object.entries(t.byCat).sort((a, b) => b[1] - a[1]).map(([c, v]) => row(escapeHtml(c), fmtMoney(v), 'sub')).join('');
  return `<div class="tax-rows">
    <div class="tax-subhead">Income</div>
    ${row('Gig base pay', fmtMoney(t.gigGross))}
    ${row('Gig tips', fmtMoney(t.gigTips))}
    ${row('Other income <small>(manual)</small>', fmtMoney(t.manualIncome))}
    ${row('Total income', fmtMoney(t.totalIncome), 'total')}
    <div class="tax-subhead">Deductions</div>
    ${row(`Standard mileage <small>(${fmt1(t.miles)} mi × ${fmtMoney(t.mileageRate)})</small>`, fmtMoney(t.mileageDeduction))}
    ${row('Actual expenses', fmtMoney(t.expenseTotal))}
    ${cats}
    ${row('Deduction applied <small>(larger)</small>', fmtMoney(t.deduction), 'total')}
    <div class="tax-subhead">Estimated tax</div>
    ${row('Taxable profit', fmtMoney(t.taxable))}
    ${row(`Estimated tax <small>(${Math.round(t.taxRate * 100)}%)</small>`, fmtMoney(t.estTax), 'total')}
    ${row('Set aside per quarter', fmtMoney(t.quarterly), 'total accent')}
  </div>`;
}

function renderTaxSummary() {
  const sel = $('#tax-year');
  if (!sel) return;
  const years = store.dataYears();
  const cur = sel.value || String(new Date().getFullYear());
  sel.innerHTML = years.map((y) => `<option value="${y}"${y === cur ? ' selected' : ''}>${y}</option>`).join('');
  $('#tax-summary-body').innerHTML = taxRowsHTML(store.taxSummary(sel.value || cur));
}

function exportTaxCSV() {
  const t = store.taxSummary(currentTaxYear());
  const rows = [['Section', 'Item', 'Amount']];
  rows.push(['Income', 'Gig base pay', t.gigGross.toFixed(2)]);
  rows.push(['Income', 'Gig tips', t.gigTips.toFixed(2)]);
  rows.push(['Income', 'Other income (manual)', t.manualIncome.toFixed(2)]);
  rows.push(['Income', 'Total income', t.totalIncome.toFixed(2)]);
  rows.push(['Deductions', `Standard mileage (${t.miles} mi @ ${t.mileageRate})`, t.mileageDeduction.toFixed(2)]);
  Object.entries(t.byCat).forEach(([c, v]) => rows.push(['Expenses', c, v.toFixed(2)]));
  rows.push(['Deductions', 'Actual expenses total', t.expenseTotal.toFixed(2)]);
  rows.push(['Deductions', 'Deduction applied (larger)', t.deduction.toFixed(2)]);
  rows.push(['Tax', 'Taxable profit', t.taxable.toFixed(2)]);
  rows.push(['Tax', `Estimated tax (${Math.round(t.taxRate * 100)}%)`, t.estTax.toFixed(2)]);
  rows.push(['Tax', 'Set aside per quarter', t.quarterly.toFixed(2)]);
  const csv = rows.map((r) => r.map((c) => (/[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : c)).join(',')).join('\n');
  download(`gig-tax-summary-${t.year}.csv`, csv, 'text/csv');
}

function printTaxSummary() {
  const t = store.taxSummary(currentTaxYear());
  const w = window.open('', '_blank');
  if (!w) { toast('Allow pop-ups to print'); return; }
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Gig Tracker — Tax summary ${t.year}</title>
    <style>
      body{font-family:-apple-system,Arial,sans-serif;max-width:640px;margin:32px auto;padding:0 20px;color:#111}
      h1{font-size:20px;margin:0 0 4px}.sub{color:#666;font-size:13px;margin:0 0 20px}
      .tax-subhead{font-size:11px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:#888;margin:18px 0 4px}
      .tax-row{display:flex;justify-content:space-between;gap:12px;padding:6px 0;border-bottom:1px solid #eee;font-size:14px}
      .tax-row.total{font-weight:800}.tax-row.sub .tr-label{padding-left:12px;color:#666;font-size:13px}
      .tr-val{font-variant-numeric:tabular-nums}.disc{color:#888;font-size:11px;margin-top:18px;line-height:1.5}
    </style></head><body>
    <h1>Tax summary — ${t.year}</h1>
    <p class="sub">Gig Tracker · generated ${new Date().toLocaleDateString()} · estimate only</p>
    ${taxRowsHTML(t)}
    <p class="disc">Estimate only — not tax advice. Deduct the larger of the standard mileage rate or actual vehicle expenses (not both); other business expenses are separate. Confirm with a tax professional.</p>
    </body></html>`);
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 300);
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
  initSyncUI();
  initInstall();
  initDrive();
  initOfferCalc();
  initTaxSummary();
  initBestHours({ fmtMoney, fmt1, focusSlot: planSlot });
  initDesk({ swapHTML, flapHTML, TRAIN_TYPES, fmtMoney, fmtMoney0, fmt1, fmtHM, escapeHtml, toast, showView, editShift, editIncome, logPlan });
  setChip('#shift-platform', 'flex');
  renderDashboard();
  renderLogList();
  startClock();
  startLangSwap();

  // Re-render when crossing the desktop breakpoint so the route strip / ticker
  // and count-up numbers appear/disappear correctly.
  window.matchMedia('(min-width: 960px)').addEventListener('change', () => renderDashboard());

  // Re-render whatever view is active when data changes — including remote
  // updates arriving from cloud sync on another device.
  store.onChange(() => {
    const active = document.querySelector('.view.active');
    if (!active) return;
    if (active.id === 'view-dashboard') renderDashboard();
    else if (active.id === 'view-campaign') renderCampaign();
    else if (active.id === 'view-log') renderLogList();
    else if (active.id === 'view-trends') renderTrends();
    else if (active.id === 'view-desk') renderDesk();
  });

  // Deep links (e.g. from Raycast): …/#desk, #log, #trends, #campaign …
  const openHash = () => {
    const v = location.hash.slice(1);
    if (['dashboard', 'campaign', 'log', 'trends', 'desk', 'import', 'settings'].includes(v)) showView(v);
  };
  window.addEventListener('hashchange', openHash);
  openHash();

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
