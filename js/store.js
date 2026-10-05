// store.js — on-device data layer + metrics for the Gig Tracker.
// All data lives in localStorage. No accounts, no server, fully private.

const KEY = 'gigtracker.v1';

export const PLATFORMS = {
  flex: { id: 'flex', label: 'Amazon Flex', color: '#6aa8ff', short: 'Flex', jp: 'フレックス' },
  doordash: { id: 'doordash', label: 'DoorDash', color: '#ff6b5f', short: 'Dasher', jp: 'ドアダッシュ' },
  other: { id: 'other', label: 'Other', color: '#a78bfa', short: 'Other', jp: 'その他' },
};

// Amazon Flex block-length presets (hours) and block types.
export const FLEX_BLOCK_PRESETS = [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5];
// Ordered slowest → fastest, matching JR train types (普通/快速/急行/特急).
export const FLEX_TAGS = ['Local', 'Rapid', 'Express', 'Rapid Express'];

export const EXPENSE_CATEGORIES = [
  'Fuel', 'Tolls', 'Maintenance', 'Car Payment', 'Insurance',
  'Phone', 'Supplies', 'Parking', 'Hot Bags', 'Other',
];

const DEFAULT_DB = {
  version: 1,
  rev: 0, // last local-write timestamp (ms)
  settings: {
    // IRS standard mileage rate (business). 2025 = $0.70/mi. Editable.
    mileageRate: 0.70,
    // Set-aside % of net profit for self-employment + income tax. 25% is a
    // common rule-of-thumb starting point for gig drivers.
    taxRate: 0.25,
    // Minimum acceptable rates for the "Worth it?" offer calculator.
    minPerMile: 1.5,
    minPerHour: 20,
    // Fuel auto-cost: shift fuel expense = miles / mpg × fuelPrice. Both editable
    // in Settings; a per-shift MPG can override the default vehicle MPG.
    fuelPrice: 3.50, // $/gallon
    mpg: 25,         // default vehicle miles per gallon
    weekStart: 1, // 0=Sun, 1=Mon
    currency: 'USD',
  },
  shifts: [],   // { id, platform, date, hours, gross, tips, jobs, miles, notes, createdAt }
  expenses: [], // { id, date, category, amount, note, platform, linkedShiftId, createdAt }
  trips: [],    // { id, date, miles, startedAt, endedAt, durationMs, fixes, linkedShiftId }
  incomes: [],  // manual non-gig income (e.g. TraceHaus): { id, date, source, amount, note, createdAt }
  plans: [],    // planned blocks/shifts: { id, date, platform, startTime, endTime, hours, tag, estimate, source, note, loggedType, loggedId, createdAt }
};

// Campaign 350: earn $350/day, every day, 2026-09-12 → 2026-12-31.
// Weekly ($2,450) and monthly (daily × days) goals are derived from `daily`;
// hitting one early earns days off (see periodGoalStats).
export const CAMPAIGN = { start: '2026-09-12', end: '2026-12-31', daily: 350 };

let db = load();
const listeners = new Set();

// Coerce any parsed/remote object into the full DB shape (fills new defaults).
function coerce(parsed) {
  return {
    ...structuredClone(DEFAULT_DB),
    ...parsed,
    settings: { ...DEFAULT_DB.settings, ...(parsed.settings || {}) },
    shifts: parsed.shifts || [],
    expenses: parsed.expenses || [],
    trips: parsed.trips || [],
    incomes: parsed.incomes || [],
    plans: parsed.plans || [],
  };
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(DEFAULT_DB);
    return coerce(JSON.parse(raw));
  } catch (e) {
    console.error('Failed to load DB, starting fresh', e);
    return structuredClone(DEFAULT_DB);
  }
}

function save() { localStorage.setItem(KEY, JSON.stringify(db)); }
function notify(origin) { listeners.forEach((fn) => fn(db, origin)); }

// Local user change: bump the revision and tell listeners (cloud sync pushes it).
function persist() {
  db.rev = Date.now();
  save();
  notify('local');
}

// ---- cloud-sync hooks (used by js/sync.js when signed in) ----
export function getDB() { return structuredClone(db); }
export function getRev() { return db.rev || 0; }

// Per-record cloud sync: apply individual records from another device.
// changes: [{ col: 'shifts'|'expenses'|'trips'|'incomes'|'plans'|'settings', id, data|null }]
// data null = deleted there. Doesn't bump rev (it isn't a local edit).
export const SYNC_COLS = ['shifts', 'expenses', 'trips', 'incomes', 'plans'];
export function applyRecords(changes) {
  if (!changes.length) return;
  for (const { col, id, data } of changes) {
    if (col === 'settings') { if (data) db.settings = { ...DEFAULT_DB.settings, ...data }; continue; }
    if (!SYNC_COLS.includes(col)) continue;
    const list = db[col];
    const i = list.findIndex((x) => x.id === id);
    if (!data) { if (i >= 0) list.splice(i, 1); continue; }
    const rec = { ...data, id };
    if (i >= 0) list[i] = rec; else list.push(rec);
  }
  save();
  notify('remote');
}

export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getSettings() {
  return { ...db.settings };
}

export function updateSettings(patch) {
  db.settings = { ...db.settings, ...patch };
  persist();
}

// ---- ids ----
let counter = 0;
function uid() {
  // Records sync between devices, so ids must be globally unique.
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  counter += 1;
  const t = typeof performance !== 'undefined' ? Math.floor(performance.now() * 1000) : counter;
  return `${t.toString(36)}-${counter.toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

// ---- shifts ----
export function getShifts() {
  return [...db.shifts].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

// Auto fuel cost for a shift: miles / mpg × fuelPrice. Uses the shift's own MPG
// if set, else the default vehicle MPG from settings. Returns 0 when it can't be
// computed (no miles, no mpg, or no fuel price). Rounded to cents.
export function fuelCostFor(shift, settings = db.settings) {
  const miles = num(shift.miles);
  const mpg = num(shift.mpg) > 0 ? num(shift.mpg) : num(settings.mpg);
  const price = num(settings.fuelPrice);
  if (!(miles > 0) || !(mpg > 0) || !(price > 0)) return 0;
  return Math.round((miles / mpg) * price * 100) / 100;
}

export function addShift(data) {
  const shift = normalizeShift({ id: uid(), createdAt: new Date().toISOString(), ...data });
  db.shifts.push(shift);
  // Auto-log a linked fuel expense computed from miles / MPG × fuel price.
  const fuel = fuelCostFor(shift);
  if (fuel > 0) {
    addExpense({
      date: shift.date,
      category: 'Fuel',
      amount: fuel,
      platform: shift.platform,
      note: 'Auto (miles ÷ MPG × fuel price)',
      linkedShiftId: shift.id,
    }, true);
  }
  persist();
  return shift;
}

export function updateShift(id, data) {
  const i = db.shifts.findIndex((s) => s.id === id);
  if (i === -1) return null;
  db.shifts[i] = normalizeShift({ ...db.shifts[i], ...data });
  const shift = db.shifts[i];
  // Recompute the auto fuel expense: drop the old auto-linked one, recreate from
  // the new miles/MPG. Leaves any manually-added Fuel expense untouched.
  db.expenses = db.expenses.filter((e) => !(e.linkedShiftId === id && e.category === 'Fuel'));
  const fuel = fuelCostFor(shift);
  if (fuel > 0) {
    addExpense({
      date: shift.date,
      category: 'Fuel',
      amount: fuel,
      platform: shift.platform,
      note: 'Auto (miles ÷ MPG × fuel price)',
      linkedShiftId: shift.id,
    }, true);
  }
  persist();
  return db.shifts[i];
}

export function deleteShift(id) {
  db.shifts = db.shifts.filter((s) => s.id !== id);
  // clean up linked expenses
  db.expenses = db.expenses.filter((e) => e.linkedShiftId !== id);
  persist();
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

// Decimal hours between two "HH:MM" clock times. A finish before the start is
// treated as crossing midnight (e.g. 22:00 → 01:30 = 3.5 h); identical times
// are 0 (far likelier a slip than a 24-hour shift).
export function hoursBetween(start, end) {
  if (!HHMM.test(start || '') || !HHMM.test(end || '')) return 0;
  const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  let diff = toMin(end) - toMin(start);
  if (diff < 0) diff += 24 * 60;
  return diff / 60;
}

function normalizeShift(s) {
  return {
    id: s.id,
    platform: s.platform in PLATFORMS ? s.platform : 'other',
    date: s.date,
    hours: num(s.hours),                 // actual time worked
    // Optional clock times ("HH:MM") when logged as start–finish; `hours` is
    // still the source of truth for every metric.
    startTime: HHMM.test(s.startTime || '') ? s.startTime : '',
    endTime: HHMM.test(s.endTime || '') ? s.endTime : '',
    scheduledHours: num(s.scheduledHours), // Flex block length (scheduled)
    tag: FLEX_TAGS.includes(s.tag) ? s.tag : '', // Flex block type
    gross: num(s.gross),
    tips: num(s.tips),
    jobs: Math.round(num(s.jobs)),
    miles: num(s.miles),
    mpg: num(s.mpg),  // per-shift MPG override (0 = use default from settings)
    notes: s.notes || '',
    createdAt: s.createdAt || new Date().toISOString(),
  };
}

// ---- expenses ----
export function getExpenses() {
  return [...db.expenses].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

export function addExpense(data, deferPersist = false) {
  const exp = {
    id: uid(),
    date: data.date,
    category: EXPENSE_CATEGORIES.includes(data.category) ? data.category : 'Other',
    amount: num(data.amount),
    note: data.note || '',
    platform: data.platform && data.platform in PLATFORMS ? data.platform : '',
    linkedShiftId: data.linkedShiftId || null,
    createdAt: new Date().toISOString(),
  };
  db.expenses.push(exp);
  if (!deferPersist) persist();
  return exp;
}

export function updateExpense(id, data) {
  const i = db.expenses.findIndex((e) => e.id === id);
  if (i === -1) return null;
  db.expenses[i] = { ...db.expenses[i], ...data, amount: num(data.amount ?? db.expenses[i].amount) };
  persist();
  return db.expenses[i];
}

export function deleteExpense(id) {
  db.expenses = db.expenses.filter((e) => e.id !== id);
  persist();
}

// ---- trips (GPS mileage log) ----
export function getTrips() {
  return [...db.trips].sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
}

export function addTrip(data) {
  const startedAt = data.startedAt || Date.now();
  const trip = {
    id: uid(),
    date: data.date || isoDate(new Date(startedAt)),
    miles: num(data.miles),
    startedAt,
    endedAt: data.endedAt || startedAt,
    durationMs: data.durationMs || 0,
    fixes: data.fixes || 0,
    linkedShiftId: data.linkedShiftId || null,
    createdAt: new Date().toISOString(),
  };
  db.trips.push(trip);
  persist();
  return trip;
}

export function deleteTrip(id) {
  db.trips = db.trips.filter((t) => t.id !== id);
  persist();
}

// ---- manual income (non-gig, e.g. TraceHaus) ----
export function getIncomes() {
  return [...db.incomes].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

export function addIncome(data) {
  const inc = normalizeIncome({ id: uid(), createdAt: new Date().toISOString(), ...data });
  db.incomes.push(inc);
  persist();
  return inc;
}

export function updateIncome(id, data) {
  const i = db.incomes.findIndex((x) => x.id === id);
  if (i === -1) return null;
  db.incomes[i] = normalizeIncome({ ...db.incomes[i], ...data });
  persist();
  return db.incomes[i];
}

export function deleteIncome(id) {
  db.incomes = db.incomes.filter((i) => i.id !== id);
  persist();
}

// Manual income is either a flat amount or paid by the hour. For hourly income
// the amount is always derived (rate × hours) so it can't drift; the optional
// start/finish clock times mirror shifts. Older records (no payType) are flat.
function normalizeIncome(i) {
  const hourly = i.payType === 'hourly';
  const rate = hourly ? num(i.rate) : 0;
  const hours = hourly ? num(i.hours) : 0;
  return {
    id: i.id,
    date: i.date,
    source: (i.source || '').trim() || 'Income',
    payType: hourly ? 'hourly' : 'flat',
    rate,
    hours,
    startTime: hourly && HHMM.test(i.startTime || '') ? i.startTime : '',
    endTime: hourly && HHMM.test(i.endTime || '') ? i.endTime : '',
    amount: hourly ? Math.round(rate * hours * 100) / 100 : num(i.amount),
    note: i.note || '',
    createdAt: i.createdAt || new Date().toISOString(),
  };
}

// ---- plans (planner: pre-planned blocks/shifts with estimated earnings) ----
// A plan is a forecast, never income: it only feeds the "income trajectory"
// until you log the real shift/income from it ("Log it"), which links the two.
export const PLAN_PLATFORMS = ['flex', 'doordash', 'other', 'income'];

function normalizePlan(p) {
  const platform = PLAN_PLATFORMS.includes(p.platform) ? p.platform : 'other';
  const startTime = HHMM.test(p.startTime || '') ? p.startTime : '';
  const endTime = HHMM.test(p.endTime || '') ? p.endTime : '';
  return {
    id: p.id,
    date: p.date,
    platform,
    startTime,
    endTime,
    hours: startTime && endTime ? hoursBetween(startTime, endTime) : num(p.hours),
    tag: platform === 'flex' && FLEX_TAGS.includes(p.tag) ? p.tag : '',
    estimate: num(p.estimate),
    source: platform === 'income' ? (p.source || '').trim() : '',
    note: p.note || '',
    loggedType: p.loggedType === 'shift' || p.loggedType === 'income' ? p.loggedType : '',
    loggedId: p.loggedId || '',
    createdAt: p.createdAt || new Date().toISOString(),
  };
}

// Oldest first (agenda order): by date, then start time.
export function getPlans() {
  return [...db.plans].sort((a, b) => (a.date + (a.startTime || '99')).localeCompare(b.date + (b.startTime || '99')));
}

export function addPlan(data) {
  const plan = normalizePlan({ id: uid(), createdAt: new Date().toISOString(), ...data });
  db.plans.push(plan);
  persist();
  return plan;
}

export function updatePlan(id, data) {
  const i = db.plans.findIndex((p) => p.id === id);
  if (i === -1) return null;
  db.plans[i] = normalizePlan({ ...db.plans[i], ...data });
  persist();
  return db.plans[i];
}

// Put back a plan exactly as it was (same id) — used by undo.
export function restorePlan(p) {
  db.plans = db.plans.filter((x) => x.id !== p.id);
  db.plans.push(normalizePlan(p));
  persist();
}

export function deletePlan(id) {
  db.plans = db.plans.filter((p) => p.id !== id);
  persist();
}

// Link a plan to the shift/income that was logged from it.
export function markPlanLogged(id, loggedType, loggedId) {
  return updatePlan(id, { loggedType, loggedId });
}

// A plan counts as logged only while its linked record still exists (delete
// the shift and the plan goes back to planned/missed).
export function planLogged(p) {
  if (!p.loggedId) return false;
  const arr = p.loggedType === 'income' ? db.incomes : db.shifts;
  return arr.some((x) => x.id === p.loggedId);
}

// 'logged' | 'missed' (past, never logged) | 'today' | 'upcoming'
export function planStatus(p, nowISO = todayISO()) {
  if (planLogged(p)) return 'logged';
  if (p.date < nowISO) return 'missed';
  return p.date === nowISO ? 'today' : 'upcoming';
}

// Your recent $/hr on a platform (last 60 days, else all-time; else all
// platforms) — used to suggest an estimate for a planned block.
export function suggestedRate(platform, nowISO = todayISO()) {
  const cutoff = addDaysISO(nowISO, -59);
  const rate = (list) => {
    const h = list.reduce((a, s) => a + num(s.hours), 0);
    return h > 0 ? list.reduce((a, s) => a + shiftIncome(s), 0) / h : 0;
  };
  const mine = db.shifts.filter((s) => s.platform === platform && num(s.hours) > 0);
  return rate(mine.filter((s) => s.date >= cutoff)) || rate(mine) || rate(db.shifts.filter((s) => num(s.hours) > 0));
}

// Other plans on the same date whose clock times overlap `plan`.
export function planOverlaps(plan, excludeId = plan.id) {
  if (!HHMM.test(plan.startTime || '') || !HHMM.test(plan.endTime || '')) return [];
  const span = (p) => {
    const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
    const s = toMin(p.startTime);
    let e = toMin(p.endTime);
    if (e <= s) e += 1440; // overnight
    return [s, e];
  };
  const [s1, e1] = span(plan);
  return db.plans.filter((p) => p.id !== excludeId && p.date === plan.date && p.startTime && p.endTime && !planLogged(p))
    .filter((p) => { const [s2, e2] = span(p); return s1 < e2 && s2 < e1; });
}

// date(ISO) -> sum of estimates for plans still to come (today onward, not yet
// logged). Past un-logged plans are "missed" and drop out of the trajectory.
function plannedByDateMap(nowISO = todayISO()) {
  const m = new Map();
  for (const p of db.plans) {
    if (p.date < nowISO || planLogged(p)) continue;
    m.set(p.date, (m.get(p.date) || 0) + num(p.estimate));
  }
  return m;
}

// [{ date, actual, planned }] for each day in [fromISO, toISO] — the income
// trajectory (real income so far + what's planned ahead).
export function trajectory(fromISO, toISO, nowISO = todayISO()) {
  const actual = incomeByDateMap();
  const planned = plannedByDateMap(nowISO);
  const out = [];
  for (let d = fromISO; d <= toISO; d = addDaysISO(d, 1)) {
    out.push({ date: d, actual: actual.get(d) || 0, planned: planned.get(d) || 0 });
  }
  return out;
}

// =====================================================================
// Planning desk analytics (desktop): when do you actually earn best?
// =====================================================================
const toMinutes = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const fromMinutes = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const dowOf = (iso) => new Date(iso + 'T00:00:00').getDay(); // 0 = Sun

// [startMin, endMin) for anything with clock times; overnight runs past 1440.
export function spanOf(x) {
  if (!HHMM.test(x.startTime || '') || !HHMM.test(x.endTime || '')) return null;
  const s = toMinutes(x.startTime);
  let e = toMinutes(x.endTime);
  if (e <= s) e += 1440;
  return [s, e];
}

// $/hr by weekday (0 = Sun) × hour of day, from gig shifts logged with start–
// finish times. Each shift's pay is spread evenly over the minutes it covered;
// `net` takes off the IRS mileage rate (fuel + wear) the same way.
//   opts: { platform: 'all'|'flex'|'doordash'|'other', days: 0 (all) | N, net }
// → { cells[7][24] = { rate|null, hours, shifts }, timed, total }
export function hourlyHeat({ platform = 'all', days = 90, net = false } = {}, nowISO = todayISO()) {
  const from = days ? addDaysISO(nowISO, -(days - 1)) : '';
  const cells = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({ earned: 0, hours: 0, ids: new Set() })));
  const rate = db.settings.mileageRate;
  let timed = 0, total = 0;
  for (const sh of db.shifts) {
    if (sh.date > nowISO || (from && sh.date < from)) continue;
    if (platform !== 'all' && sh.platform !== platform) continue;
    total++;
    const span = spanOf(sh);
    if (!span) continue;
    timed++;
    const [s, e] = span;
    const pay = shiftIncome(sh) - (net ? num(sh.miles) * rate : 0);
    const perMin = pay / (e - s);
    const dow = dowOf(sh.date);
    for (let m = s; m < e;) {
      const next = Math.min(e, (Math.floor(m / 60) + 1) * 60);
      const c = cells[(dow + Math.floor(m / 1440)) % 7][Math.floor(m / 60) % 24];
      c.earned += perMin * (next - m); c.hours += (next - m) / 60; c.ids.add(sh.id);
      m = next;
    }
  }
  return {
    timed, total,
    cells: cells.map((row) => row.map((c) => ({ rate: c.hours >= 0.5 ? c.earned / c.hours : null, hours: c.hours, shifts: c.ids.size }))),
  };
}

// Expected $/hr for a slot (weekday × clock span) on a platform, from the heat
// map; falls back to your overall recent rate when the slot has no history.
// Your own scale for a heat map, by percentile rank among the cells that
// have data — level 4 ("best") is your top fifth whatever you earn. Tied
// rates share the lower level, so a flat week doesn't light up everything.
// level(rate) → -1 (no data) … 4; bands[L] = [min, max] $/hr in that level.
export function heatScale(heat) {
  const xs = heat.cells.flat().map((c) => c.rate).filter((r) => r != null).sort((a, b) => a - b);
  const n = xs.length;
  const below = (r) => { let lo = 0, hi = n; while (lo < hi) { const m = (lo + hi) >> 1; if (xs[m] < r) lo = m + 1; else hi = m; } return lo; };
  const level = (r) => (r == null || !n ? -1 : Math.min(4, Math.floor((5 * below(r)) / Math.max(1, n - 1))));
  const bands = [null, null, null, null, null];
  for (const r of xs) { const L = level(r); bands[L] = bands[L] ? [bands[L][0], r] : [r, r]; }
  return { level, bands, n };
}

// Average $/hr over a clock span from a precomputed heat map, or null when
// less than half the span has history.
export function rateFromHeat(heat, dateISO, startTime, endTime) {
  const span = spanOf({ startTime, endTime });
  if (!span || !heat) return null;
  const dow = dowOf(dateISO);
  let w = 0, sum = 0, covered = 0;
  for (let m = span[0]; m < span[1]; m += 60) {
    const c = heat.cells[(dow + Math.floor(m / 1440)) % 7][Math.floor(m / 60) % 24];
    w += 1;
    if (c.rate != null) { sum += c.rate; covered += 1; }
  }
  return covered && covered * 2 >= w ? sum / covered : null;
}
// Heat map for estimating: last 90 days, else all-time if that has nothing.
export function estimateHeat(platform, nowISO = todayISO()) {
  const h = hourlyHeat({ platform, days: 90 }, nowISO);
  return h.timed ? h : hourlyHeat({ platform, days: 0 }, nowISO);
}

// Expected $/hr for a slot (weekday × clock span) on a platform, from the heat
// map; falls back to your overall recent rate when the slot has no history.
export function slotRate(dateISO, startTime, endTime, platform, nowISO = todayISO()) {
  const fallback = suggestedRate(platform === 'income' ? 'other' : platform, nowISO);
  if (platform === 'income') return { rate: fallback, fromSlot: false };
  const r = rateFromHeat(estimateHeat(platform, nowISO), dateISO, startTime, endTime);
  return r != null ? { rate: r, fromSlot: true } : { rate: fallback, fromSlot: false };
}
export function estimateFor({ date, startTime, endTime, platform }, nowISO = todayISO()) {
  const h = hoursBetween(startTime, endTime);
  const { rate, fromSlot } = slotRate(date, startTime, endTime, platform, nowISO);
  return { estimate: Math.round(rate * h), rate, fromSlot, hours: h };
}

// Everything on the clock for a date: open plans + logged shifts/incomes with
// times → [{ id, kind, startMin, endMin }].
function busyOn(dateISO) {
  const out = [];
  for (const p of db.plans) if (p.date === dateISO && !planLogged(p)) { const sp = spanOf(p); if (sp) out.push(sp); }
  for (const x of [...db.shifts, ...db.incomes]) if (x.date === dateISO) { const sp = spanOf(x); if (sp) out.push(sp); }
  return out;
}
const overlaps = (a, list) => list.some((b) => a[0] < b[1] && b[0] < a[1]);

// The week the desk shows: per-day actual + still-planned money, the goal, and
// when the plan would meet it (and which free days that earns).
export function deskWeek(weekStartISO, nowISO = todayISO()) {
  const dates = Array.from({ length: 7 }, (_, i) => addDaysISO(weekStartISO, i));
  const end = dates[6];
  const actualMap = incomeByDateMap();
  const plannedMap = plannedByDateMap(nowISO);
  const isCurrent = nowISO >= weekStartISO && nowISO <= end;
  let goal;
  if (isCurrent) goal = weeklyGoalStats(nowISO).goal;
  else {
    const inCampaign = dates.filter((d) => d >= CAMPAIGN.start && d <= CAMPAIGN.end).length;
    goal = CAMPAIGN.daily * (inCampaign || 7);
  }
  const days = dates.map((d) => {
    const actual = actualMap.get(d) || 0;
    const planned = plannedMap.get(d) || 0;
    const busy = actual > 0 || planned > 0 || db.plans.some((p) => p.date === d && !planLogged(p));
    return { date: d, actual, planned, total: actual + planned, busy, past: d < nowISO };
  });
  const earned = days.reduce((a, d) => a + d.actual, 0);
  const planned = days.reduce((a, d) => a + d.planned, 0);
  let cum = 0, metOn = null;
  for (const d of days) { cum += d.total; if (metOn === null && cum >= goal) metOn = d.date; }
  const daysOff = metOn ? days.filter((d) => d.date > metOn && !d.busy && d.date >= nowISO).map((d) => d.date) : [];
  // Hours on the clock and the money earned/planned in them (for $/hr —
  // "anytime" plans and flat incomes have money but no hours, so skip them).
  let hours = 0, timedMoney = 0;
  const inWeek = (x) => x.date >= weekStartISO && x.date <= end;
  for (const s of db.shifts) if (inWeek(s) && num(s.hours) > 0) { hours += num(s.hours); timedMoney += shiftIncome(s); }
  for (const i of db.incomes) if (inWeek(i) && num(i.hours) > 0) { hours += num(i.hours); timedMoney += num(i.amount); }
  for (const p of db.plans) if (inWeek(p) && p.date >= nowISO && !planLogged(p) && num(p.hours) > 0) { hours += num(p.hours); timedMoney += num(p.estimate); }
  return { start: weekStartISO, end, dates, days, goal, earned, planned, projected: earned + planned, shortfall: Math.max(0, goal - earned - planned), metOn, daysOff, hours, timedMoney, isCurrent };
}

// Best open slots in a week, from your heat map: 2–4 h windows where every
// hour has history, on whichever platform pays best there, not overlapping
// anything already on the clock (or each other), from now on. Days with
// nothing on them are flagged `freeDay` so the desk can prefer keeping them.
export function suggestSlots(weekStartISO, { max = 6, perDay = 2, nowISO = todayISO(), nowMin = null } = {}) {
  const plats = ['flex', 'doordash', 'other'];
  const heats = Object.fromEntries(plats.map((p) => [p, estimateHeat(p, nowISO)]));
  const actual = incomeByDateMap();
  const minute = nowMin ?? (new Date().getHours() * 60 + new Date().getMinutes());
  const cands = [];
  const busyMap = {};
  for (let i = 0; i < 7; i++) {
    const date = addDaysISO(weekStartISO, i);
    if (date < nowISO) continue;
    const busy = busyOn(date);
    busyMap[date] = busy;
    const freeDay = !busy.length && !(actual.get(date) > 0) && !db.plans.some((p) => p.date === date && !planLogged(p));
    const dow = dowOf(date);
    for (const p of plats) {
      const cells = heats[p].cells[dow];
      for (let h = 6; h <= 21; h++) {
        if (date === nowISO && h * 60 < minute + 30) continue;
        for (const L of [3, 2, 4]) {
          if (h + L > 24) continue;
          const hs = Array.from({ length: L }, (_, k) => cells[h + k]);
          if (hs.some((c) => c.rate == null)) continue;
          const span = [h * 60, (h + L) * 60];
          if (overlaps(span, busy)) continue;
          const rate = hs.reduce((a, c) => a + c.rate, 0) / L;
          cands.push({ date, startTime: fromMinutes(span[0]), endTime: fromMinutes(span[1]), span, platform: p, rate, hours: L, estimate: Math.round(rate * L), shifts: Math.max(...hs.map((c) => c.shifts)), freeDay });
        }
      }
    }
  }
  cands.sort((a, b) => b.rate - a.rate || b.estimate - a.estimate);
  const chosen = [];
  const count = {};
  for (const c of cands) {
    if (chosen.length >= max) break;
    if ((count[c.date] || 0) >= perDay) continue;
    const taken = chosen.filter((x) => x.date === c.date).map((x) => x.span);
    if (overlaps(c.span, taken)) continue;
    chosen.push(c);
    count[c.date] = (count[c.date] || 0) + 1;
  }
  return chosen.map(({ span, ...rest }) => rest);
}

// Copy a week's plan into another week (same weekdays): open plans, plus
// timed shifts/incomes as plans at what they actually paid. Skips anything
// that would overlap what's already in the target week. Returns the new ids.
export function copyWeekPlans(fromWeekISO, toWeekISO) {
  const offset = daysInclusive(fromWeekISO, toWeekISO) - 1;
  const fromEnd = addDaysISO(fromWeekISO, 6);
  const src = [];
  for (const p of db.plans) {
    if (p.date < fromWeekISO || p.date > fromEnd || planLogged(p)) continue;
    src.push({ date: p.date, platform: p.platform, startTime: p.startTime, endTime: p.endTime, hours: p.hours, tag: p.tag, estimate: p.estimate, source: p.source, note: p.note });
  }
  for (const s of db.shifts) {
    if (s.date < fromWeekISO || s.date > fromEnd || !spanOf(s)) continue;
    src.push({ date: s.date, platform: s.platform, startTime: s.startTime, endTime: s.endTime, tag: s.tag, estimate: Math.round(shiftIncome(s)) });
  }
  for (const i of db.incomes) {
    if (i.date < fromWeekISO || i.date > fromEnd || !spanOf(i)) continue;
    src.push({ date: i.date, platform: 'income', source: i.source, startTime: i.startTime, endTime: i.endTime, estimate: Math.round(num(i.amount)) });
  }
  const ids = [];
  for (const x of src) {
    const date = addDaysISO(x.date, offset);
    const sp = spanOf(x);
    if (sp && overlaps(sp, busyOn(date))) continue;
    if (!sp && db.plans.some((p) => p.date === date && !p.startTime && p.platform === x.platform && !planLogged(p))) continue;
    const plan = normalizePlan({ ...x, id: uid(), date, createdAt: new Date().toISOString() });
    db.plans.push(plan);
    ids.push(plan.id);
  }
  if (ids.length) persist();
  return ids;
}

// ---- bulk import ----
export function importShifts(rows) {
  let added = 0;
  for (const r of rows) {
    if (!r.date) continue;
    addShiftQuiet(r);
    added += 1;
  }
  persist();
  return added;
}

function addShiftQuiet(data) {
  const shift = normalizeShift({ id: uid(), createdAt: new Date().toISOString(), ...data });
  db.shifts.push(shift);
  // Prefer an explicit imported fuel figure; otherwise auto-compute from MPG.
  const fuel = (data.fuel && Number(data.fuel) > 0) ? Number(data.fuel) : fuelCostFor(shift);
  if (fuel > 0) {
    db.expenses.push({
      id: uid(), date: shift.date, category: 'Fuel', amount: fuel,
      note: (data.fuel && Number(data.fuel) > 0) ? 'Imported' : 'Auto (miles ÷ MPG × fuel price)',
      platform: shift.platform, linkedShiftId: shift.id,
      createdAt: new Date().toISOString(),
    });
  }
  return shift;
}

// ---- export / import full backup ----
export function exportJSON() {
  return JSON.stringify(db, null, 2);
}

export function importJSON(text, { merge = false } = {}) {
  const incoming = JSON.parse(text);
  if (!incoming || !Array.isArray(incoming.shifts)) throw new Error('Invalid backup file');
  if (merge) {
    db.shifts.push(...incoming.shifts.map(normalizeShift));
    db.expenses.push(...(incoming.expenses || []));
    db.trips.push(...(incoming.trips || []));
    db.incomes.push(...(incoming.incomes || []).map(normalizeIncome));
    db.plans.push(...(incoming.plans || []).map(normalizePlan));
  } else {
    db = {
      ...structuredClone(DEFAULT_DB),
      ...incoming,
      settings: { ...DEFAULT_DB.settings, ...(incoming.settings || {}) },
      shifts: (incoming.shifts || []).map(normalizeShift),
      expenses: incoming.expenses || [],
      trips: incoming.trips || [],
      incomes: (incoming.incomes || []).map(normalizeIncome),
      plans: (incoming.plans || []).map(normalizePlan),
    };
  }
  persist();
}

export function clearAll() {
  db = structuredClone(DEFAULT_DB);
  persist();
}

// =====================================================================
// Metrics
// =====================================================================

function num(v) {
  const n = typeof v === 'string' ? parseFloat(v.replace(/[^0-9.\-]/g, '')) : Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function shiftIncome(s) {
  return num(s.gross) + num(s.tips);
}

// Aggregate income/expense/derived metrics over a set of shifts + expenses.
// Pass `incomes` (manual non-gig income, e.g. TraceHaus) to fold it into the
// TOTAL money figures — net, taxable, tax set-aside, take-home. The per-unit
// efficiency rates ($/hr, $/mi, $/job) stay on GIG income only, because manual
// income has no hours/miles/deliveries to divide by.
export function summarize(shifts, expenses, settings = db.settings, incomes = []) {
  const gigIncome = shifts.reduce((a, s) => a + shiftIncome(s), 0);
  const gross = shifts.reduce((a, s) => a + num(s.gross), 0);
  const tips = shifts.reduce((a, s) => a + num(s.tips), 0);
  const hours = shifts.reduce((a, s) => a + num(s.hours), 0);
  const miles = shifts.reduce((a, s) => a + num(s.miles), 0);
  // Actual vs scheduled time, over shifts that have both (Flex blocks).
  const schedShifts = shifts.filter((s) => num(s.scheduledHours) > 0 && num(s.hours) > 0);
  const schedPlanned = schedShifts.reduce((a, s) => a + num(s.scheduledHours), 0);
  const schedActual = schedShifts.reduce((a, s) => a + num(s.hours), 0);
  const jobs = shifts.reduce((a, s) => a + num(s.jobs), 0);
  const manualIncome = incomes.reduce((a, i) => a + num(i.amount), 0);
  const totalIncome = gigIncome + manualIncome;
  const expenseTotal = expenses.reduce((a, e) => a + num(e.amount), 0);
  const mileageDeduction = miles * num(settings.mileageRate);
  const net = totalIncome - expenseTotal;
  // Taxable profit uses the larger of actual expenses or the standard mileage
  // deduction (you can't claim both). Never below zero.
  const taxableEstimate = Math.max(0, totalIncome - Math.max(expenseTotal, mileageDeduction));
  const taxSetAside = taxableEstimate * num(settings.taxRate);
  return {
    // `income` stays gig income for backward-compat + the rate metrics below.
    income: gigIncome, gigIncome, manualIncome, totalIncome,
    gross, tips, hours, miles, jobs,
    expenseTotal, net, mileageDeduction,
    taxableEstimate, taxSetAside,
    takeHomeAfterTax: net - taxSetAside,
    schedPlanned, schedActual, schedShiftCount: schedShifts.length,
    // % of scheduled block time actually spent (<100% = finished blocks early).
    actualVsScheduledPct: schedPlanned ? (schedActual / schedPlanned) * 100 : 0,
    perHour: hours ? gigIncome / hours : 0,
    perMile: miles ? gigIncome / miles : 0,
    perJob: jobs ? gigIncome / jobs : 0,
    netPerHour: hours ? net / hours : 0,
    shiftCount: shifts.length,
  };
}

// Per-block-type breakdown for Amazon Flex: income, hours, $/hr and block
// efficiency for each tag. Ordered by FLEX_TAGS. Only tagged Flex shifts count.
export function flexByTag(shifts) {
  const map = new Map();
  for (const s of shifts) {
    if (s.platform !== 'flex' || !s.tag) continue;
    if (!map.has(s.tag)) map.set(s.tag, { tag: s.tag, count: 0, income: 0, hours: 0, miles: 0, schedPlanned: 0, schedActual: 0 });
    const o = map.get(s.tag);
    o.count += 1;
    o.income += shiftIncome(s);
    o.hours += num(s.hours);
    o.miles += num(s.miles);
    if (num(s.scheduledHours) > 0 && num(s.hours) > 0) {
      o.schedPlanned += num(s.scheduledHours);
      o.schedActual += num(s.hours);
    }
  }
  return FLEX_TAGS.filter((t) => map.has(t)).map((t) => {
    const o = map.get(t);
    return {
      ...o,
      perHour: o.hours ? o.income / o.hours : 0,
      perBlock: o.count ? o.income / o.count : 0,
      effPct: o.schedPlanned ? (o.schedActual / o.schedPlanned) * 100 : 0,
    };
  });
}

// "Worth it?" — grade a delivery offer against your minimum acceptable rates.
export function offerVerdict(pay, miles, minutes, settings = db.settings) {
  pay = num(pay); miles = num(miles); minutes = num(minutes);
  if (!(pay > 0) || !(miles > 0)) return { valid: false };
  const minPerMile = num(settings.minPerMile) || 1.5;
  const minPerHour = num(settings.minPerHour) || 20;
  const perMile = pay / miles;
  const perHour = minutes > 0 ? pay / (minutes / 60) : 0;
  const mileOK = perMile >= minPerMile;
  const hourOK = minutes > 0 ? perHour >= minPerHour : null;
  let verdict;
  if (hourOK === null) verdict = mileOK ? 'take' : 'skip';
  else if (mileOK && hourOK) verdict = 'take';
  else if (!mileOK && !hourOK) verdict = 'skip';
  else verdict = 'marginal';
  return { valid: true, perMile, perHour, minPerMile, minPerHour, mileOK, hourOK, verdict };
}

// Year-end tax summary (estimate). Combines gig income + manual (e.g. TraceHaus)
// income; standard mileage deduction vs actual expenses; estimated tax + quarterly.
export function taxSummary(year) {
  const from = `${year}-01-01`, to = `${year}-12-31`;
  const shifts = inRange(getShifts(), from, to);
  const expenses = inRange(getExpenses(), from, to);
  const incomes = inRange(getIncomes(), from, to);
  const s = summarize(shifts, expenses);
  const manualIncome = incomes.reduce((a, i) => a + num(i.amount), 0);
  const totalIncome = s.income + manualIncome;
  const rate = num(db.settings.taxRate);
  const deduction = Math.max(s.expenseTotal, s.mileageDeduction);
  const taxable = Math.max(0, totalIncome - deduction);
  const estTax = taxable * rate;
  const byCat = {};
  expenses.forEach((e) => { byCat[e.category] = (byCat[e.category] || 0) + num(e.amount); });
  return {
    year,
    gigGross: s.gross, gigTips: s.tips, gigIncome: s.income,
    manualIncome, totalIncome,
    miles: s.miles, mileageRate: num(db.settings.mileageRate), mileageDeduction: s.mileageDeduction,
    expenseTotal: s.expenseTotal, byCat,
    deduction, taxable, taxRate: rate, estTax, quarterly: estTax / 4,
    shiftCount: s.shiftCount, incomeCount: incomes.length,
  };
}

// Distinct calendar years present across all records (newest first).
export function dataYears() {
  const set = new Set();
  for (const arr of [db.shifts, db.expenses, db.incomes]) for (const r of arr) if (r.date) set.add(r.date.slice(0, 4));
  set.add(String(new Date().getFullYear()));
  return [...set].sort().reverse();
}

// =====================================================================
// Campaign 350
// =====================================================================

// One map of date(ISO) -> total income that day (gig shift income + manual).
function incomeByDateMap() {
  const m = new Map();
  for (const s of db.shifts) m.set(s.date, (m.get(s.date) || 0) + shiftIncome(s));
  for (const i of db.incomes) m.set(i.date, (m.get(i.date) || 0) + num(i.amount));
  return m;
}

// Total income (gig + manual) for a single ISO date.
export function dailyIncome(iso) {
  return incomeByDateMap().get(iso) || 0;
}

// [{ date, total }] for each day in [fromISO, toISO] inclusive.
export function dailyTotals(fromISO, toISO) {
  const m = incomeByDateMap();
  const out = [];
  const d = new Date(fromISO + 'T00:00:00');
  const end = new Date(toISO + 'T00:00:00');
  while (d <= end) {
    const iso = isoDate(d);
    out.push({ date: iso, total: m.get(iso) || 0 });
    d.setDate(d.getDate() + 1);
  }
  return out;
}

function daysInclusive(aISO, bISO) {
  const a = new Date(aISO + 'T00:00:00');
  const b = new Date(bISO + 'T00:00:00');
  return Math.floor((b - a) / 86400000) + 1;
}

// Full Campaign 350 status as of `nowISO` (defaults to today), computed from
// the real date — nothing hardcoded except the campaign window/goal.
export function campaignStats(nowISO = todayISO()) {
  const { start, end, daily } = CAMPAIGN;
  const totalDays = daysInclusive(start, end);   // 111
  const totalGoal = totalDays * daily;           // 38,850
  const started = nowISO >= start;
  const ended = nowISO > end;
  const throughISO = ended ? end : (started ? nowISO : start);
  const daysElapsed = started ? daysInclusive(start, throughISO) : 0; // incl. today
  const daysRemaining = ended ? 0 : daysInclusive(started ? nowISO : start, end); // incl. today
  const goalToDate = daysElapsed * daily;

  const m = incomeByDateMap();
  let earnedToDate = 0;
  for (const [d, v] of m) if (d >= start && d <= throughISO) earnedToDate += v;

  const remainingGoal = Math.max(0, totalGoal - earnedToDate);
  const requiredPace = daysRemaining > 0 ? remainingGoal / daysRemaining : 0;
  const ahead = earnedToDate - goalToDate; // + = ahead of the $350/day line

  const todayTotal = m.get(nowISO) || 0;
  const todayHit = todayTotal >= daily;

  // Streak: consecutive $350+ days counting back from today. If today hasn't
  // hit yet, count back from yesterday so an in-progress day doesn't zero it.
  let streak = 0;
  const startD = new Date(start + 'T00:00:00');
  const cur = new Date(nowISO + 'T00:00:00');
  if ((m.get(isoDate(cur)) || 0) < daily) cur.setDate(cur.getDate() - 1);
  while (cur >= startD) {
    if ((m.get(isoDate(cur)) || 0) >= daily) { streak += 1; cur.setDate(cur.getDate() - 1); }
    else break;
  }

  return {
    start, end, daily, totalDays, totalGoal,
    started, ended, daysElapsed, daysRemaining,
    todayTotal, todayHit,
    earnedToDate, goalToDate, ahead,
    remainingGoal, requiredPace, behindPace: requiredPace > daily,
    streak,
  };
}

// ---- Weekly / monthly goals with day-off roll-over ----
//
// Each period's base goal is $350 × its days inside the campaign window (a full
// week = $2,450; September, which starts 9/12, = 19 days = $6,650). Once the
// running total meets the goal, the rest of the period's days are EARNED DAYS
// OFF. Income logged on an earned day off is "banked" and rolls over, lowering
// the NEXT period's goal (week → next week, month → next month). If the carry
// exceeds a whole period's goal, the excess keeps rolling forward.

function addDaysISO(iso, n) {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return isoDate(d);
}

// Full calendar bounds of the week/month containing `iso`.
function periodBounds(kind, iso) {
  if (kind === 'month') {
    const [y, m] = iso.split('-').map(Number);
    return { start: isoDate(new Date(y, m - 1, 1)), end: isoDate(new Date(y, m, 0)) };
  }
  const start = isoDate(startOfWeek(new Date(iso + 'T00:00:00')));
  return { start, end: addDaysISO(start, 6) };
}

// Clip a period to the campaign window; outside the campaign, use it as-is.
function clipToCampaign(b) {
  const start = b.start < CAMPAIGN.start ? CAMPAIGN.start : b.start;
  const end = b.end > CAMPAIGN.end ? CAMPAIGN.end : b.end;
  return start <= end ? { start, end } : b;
}

function periodGoalStats(kind, nowISO = todayISO()) {
  const { daily } = CAMPAIGN;
  const m = incomeByDateMap();
  // Walk the roll-over chain from the period containing the campaign start (or
  // now, if earlier) up to the period containing `nowISO`.
  let full = periodBounds(kind, nowISO < CAMPAIGN.start ? nowISO : CAMPAIGN.start);
  let carryIn = 0;
  for (;;) {
    const p = clipToCampaign(full);
    const totalDays = daysInclusive(p.start, p.end);
    const baseGoal = daily * totalDays;
    const goal = Math.max(0, baseGoal - carryIn);
    const excess = Math.max(0, carryIn - baseGoal);
    const isCurrent = nowISO >= full.start && nowISO <= full.end;
    const through = isCurrent && nowISO < p.end ? nowISO : p.end;

    let earned = 0, banked = 0;
    // A zero goal (fully covered by roll-over) is met before the period starts.
    let metOn = goal === 0 ? addDaysISO(p.start, -1) : null;
    for (let d = p.start; d <= through; d = addDaysISO(d, 1)) {
      const v = m.get(d) || 0;
      if (earned >= goal) banked += v; // goal already met before this day → earned day off
      earned += v;
      if (metOn === null && earned >= goal) metOn = d;
    }

    if (isCurrent) {
      const clampedNow = nowISO < p.start ? p.start : nowISO > p.end ? p.end : nowISO;
      const daysElapsed = daysInclusive(p.start, clampedNow);
      const daysLeft = totalDays - daysElapsed; // days remaining after today
      const met = earned >= goal;
      const remaining = Math.max(0, goal - earned);

      // Trajectory: add plans still to come in this period (today onward) and
      // find the day the plan would reach the goal.
      const plannedMap = plannedByDateMap(nowISO);
      let planned = 0, cum = earned, projMetOn = met ? metOn : null;
      for (let d = clampedNow; d <= p.end; d = addDaysISO(d, 1)) {
        const v = plannedMap.get(d) || 0;
        planned += v; cum += v;
        if (projMetOn === null && cum >= goal) projMetOn = d;
      }
      const projected = earned + planned;
      const projMet = projected >= goal;
      // Days off the plan would earn: every day after the projected meet day
      // (never fewer than today's real days off).
      const projDaysOff = projMet ? Math.min(daysLeft, daysInclusive(projMetOn, p.end) - 1) : 0;

      return {
        planned, projected, projMet, projMetOn, projDaysOff,
        shortfall: Math.max(0, goal - projected),
        kind, daily, start: p.start, end: p.end, totalDays,
        baseGoal, carryIn, goal, earned,
        daysElapsed, daysLeft, met, metOn, remaining,
        perDayNeeded: met ? 0 : remaining / (daysLeft + 1), // counting today
        daysOff: met ? daysLeft : 0,                         // after today
        todayOff: met && metOn < clampedNow,                 // met before today
        banked,                                              // rolls into next period
        pct: goal > 0 ? Math.min(100, (earned / goal) * 100) : 100,
      };
    }
    carryIn = excess + banked;
    full = periodBounds(kind, addDaysISO(full.end, 1));
  }
}

export function weeklyGoalStats(nowISO = todayISO()) { return periodGoalStats('week', nowISO); }
export function monthlyGoalStats(nowISO = todayISO()) { return periodGoalStats('month', nowISO); }

// ---- date helpers ----
export function todayISO() {
  const d = new Date();
  return isoDate(d);
}

export function isoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function startOfWeek(d, weekStart = db.settings.weekStart) {
  const x = new Date(d);
  const diff = (x.getDay() - weekStart + 7) % 7;
  x.setDate(x.getDate() - diff);
  x.setHours(0, 0, 0, 0);
  return x;
}

// Filter shifts/expenses to a range [from, to] inclusive (ISO date strings).
export function inRange(items, from, to) {
  return items.filter((i) => (!from || i.date >= from) && (!to || i.date <= to));
}

// Named ranges for the dashboard.
export function rangeFor(period) {
  const now = new Date();
  const to = isoDate(now);
  if (period === 'week') return { from: isoDate(startOfWeek(now)), to };
  if (period === 'month') {
    const f = new Date(now.getFullYear(), now.getMonth(), 1);
    return { from: isoDate(f), to };
  }
  if (period === 'year') {
    const f = new Date(now.getFullYear(), 0, 1);
    return { from: isoDate(f), to };
  }
  if (period === '30d') {
    const f = new Date(now); f.setDate(f.getDate() - 29);
    return { from: isoDate(f), to };
  }
  return { from: null, to: null }; // all time
}

export { num };
