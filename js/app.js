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
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
  window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
  if (name === 'dashboard') renderDashboard();
  if (name === 'trends') renderTrends();
  if (name === 'log') renderLogList();
}

$$('.tab').forEach((t) => t.addEventListener('click', () => showView(t.dataset.view)));

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

  // KPIs
  const kpis = [
    { label: 'Net income', value: fmtMoney0(s.net), sub: `${fmtMoney0(s.income)} in · ${fmtMoney0(s.expenseTotal)} out`, cls: s.net >= 0 ? 'accent' : 'neg' },
    { label: '$ / hour', value: s.perHour ? fmtMoney(s.perHour) : '—', sub: `${fmt1(s.hours)} hrs worked` },
    { label: '$ / mile', value: s.perMile ? fmtMoney(s.perMile) : '—', sub: `${fmt1(s.miles)} mi driven` },
    { label: 'Per delivery', value: s.perJob ? fmtMoney(s.perJob) : '—', sub: `${s.jobs} deliveries` },
  ];
  $('#kpi-grid').innerHTML = kpis.map((k) => `
    <div class="kpi ${k.cls || ''}">
      <div class="k-label">${k.label}</div>
      <div class="k-value">${k.value}</div>
      <div class="k-sub">${k.sub}</div>
    </div>`).join('');

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

  renderEarningsChart(shifts);
  renderPlatformDonut(shifts);
  renderExpensesDonut(expenses);
  renderRecentShifts(store.getShifts().slice(0, 6));
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
    renderLogList();
  }));

  // platform chip groups (generic)
  bindChips('#shift-platform');
  bindChips('#expense-platform');
  bindChips('#ocr-platform');
  bindChips('#csv-platform');

  // expense categories
  $('#expense-category').innerHTML = EXPENSE_CATEGORIES.map((c) => `<option value="${c}">${c}</option>`).join('');

  // default dates
  $('#shift-form [name=date]').value = store.todayISO();
  $('#expense-form [name=date]').value = store.todayISO();

  // live metrics on shift form
  ['gross', 'tips', 'hours', 'miles', 'jobs'].forEach((n) => {
    $(`#shift-form [name=${n}]`).addEventListener('input', updateShiftLive);
  });
  updateShiftLive();

  $('#shift-form').addEventListener('submit', onSaveShift);
  $('#expense-form').addEventListener('submit', onSaveExpense);
  $('#shift-reset').addEventListener('click', () => resetShiftForm());
  $('#expense-reset').addEventListener('click', () => resetExpenseForm());
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
  $('#shift-live').innerHTML = parts.join('');
}

function onSaveShift(e) {
  e.preventDefault();
  const f = e.target;
  const data = {
    platform: chipValue('#shift-platform') || 'other',
    date: f.date.value,
    hours: f.hours.value, gross: f.gross.value, tips: f.tips.value,
    jobs: f.jobs.value, miles: f.miles.value, fuel: f.fuel.value, notes: f.notes.value,
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
  state.editShiftId = null;
  $('#shift-form-title').textContent = 'Log a shift';
  $('#shift-submit').textContent = 'Save shift';
  updateShiftLive();
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
  f.date.value = s.date; f.hours.value = s.hours || ''; f.gross.value = s.gross || '';
  f.tips.value = s.tips || ''; f.jobs.value = s.jobs || ''; f.miles.value = s.miles || '';
  f.fuel.value = ''; f.notes.value = s.notes || '';
  state.editShiftId = id;
  $('#shift-form-title').textContent = 'Edit shift';
  $('#shift-submit').textContent = 'Update shift';
  updateShiftLive();
  showView('log');
  f.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
    if (item.hours) bits.push(`${fmt1(item.hours)}h`);
    if (item.jobs) bits.push(`${item.jobs} jobs`);
    if (item.miles) bits.push(`${fmt1(item.miles)} mi`);
    return `<li class="record" data-id="${item.id}" data-type="shift">
      <span class="rec-badge" style="background:${platColor(item.platform)}"></span>
      <div class="rec-main">
        <div class="rec-title">${friendlyDate(item.date)}</div>
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
    else store.deleteTrip(id);
    toast('Deleted');
    renderLogList(); renderDashboard();
    return;
  }
  const row = e.target.closest('.record[data-type]');
  if (row && row.closest('#log-list')) {
    if (row.dataset.type === 'shift') editShift(row.dataset.id);
    else if (row.dataset.type === 'expense') editExpense(row.dataset.id);
    // trips are read-only records; no edit
  }
});

// =====================================================================
// Trends
// =====================================================================
function renderTrends() {
  const shifts = store.getShifts();
  const expenses = store.getExpenses();

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

function initDrive() {
  $('#drive-cta').addEventListener('click', startDrive);
  $('#drive-stop').addEventListener('click', () => endDrive(true));
  $('#drive-cancel').addEventListener('click', () => endDrive(false));
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

  // re-render dashboard when data changes elsewhere
  store.onChange(() => { if ($('#view-dashboard').classList.contains('active')) renderDashboard(); });

  // register service worker for offline
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }
}
boot();
