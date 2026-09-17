// store.js — on-device data layer + metrics for the Gig Tracker.
// All data lives in localStorage. No accounts, no server, fully private.

const KEY = 'gigtracker.v1';

export const PLATFORMS = {
  flex: { id: 'flex', label: 'Amazon Flex', color: '#60a5fa', short: 'Flex', jp: 'フレックス' },
  doordash: { id: 'doordash', label: 'DoorDash', color: '#ef4444', short: 'Dasher', jp: 'ドアダッシュ' },
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
  rev: 0, // last-write timestamp (ms) — used for cloud-sync conflict resolution
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
};

// Campaign 350: earn $350/day, every day, 2026-09-12 → 2026-12-31.
// Weekly goal = daily × 7 ($2,450); hitting it early earns days off.
export const CAMPAIGN = { start: '2026-09-12', end: '2026-12-31', daily: 350, weekly: 2450 };

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

// Local user change: bump the revision so cloud sync knows this device is newest.
function persist() {
  db.rev = Date.now();
  save();
  notify('local');
}

// ---- cloud-sync hooks (no-ops unless js/sync.js is active) ----
export function getDB() { return structuredClone(db); }
export function getRev() { return db.rev || 0; }

// Replace the whole DB with a remote copy (last-write-wins). Keeps the remote's
// rev so we don't re-push it back.
export function applyRemote(remote) {
  db = coerce(remote);
  save();
  notify('remote');
}

// Union local + remote by record id (used once when first linking an account so
// neither side's existing entries are lost). Bumps rev and returns the merged db.
export function mergeRemote(remote) {
  const r = coerce(remote);
  const union = (a, b) => {
    const m = new Map(a.map((x) => [x.id, x]));
    for (const x of b) if (!m.has(x.id)) m.set(x.id, x);
    return [...m.values()];
  };
  db = {
    ...db,
    shifts: union(db.shifts, r.shifts),
    expenses: union(db.expenses, r.expenses),
    trips: union(db.trips, r.trips),
    incomes: union(db.incomes, r.incomes),
    settings: { ...r.settings, ...db.settings },
    rev: Date.now(),
  };
  save();
  notify('merge');
  return structuredClone(db);
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
  // time-based-ish without Date.now dependency issues in normal browser runtime
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

function normalizeShift(s) {
  return {
    id: s.id,
    platform: s.platform in PLATFORMS ? s.platform : 'other',
    date: s.date,
    hours: num(s.hours),                 // actual time worked
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

function normalizeIncome(i) {
  return {
    id: i.id,
    date: i.date,
    source: (i.source || '').trim() || 'Income',
    amount: num(i.amount),
    note: i.note || '',
    createdAt: i.createdAt || new Date().toISOString(),
  };
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
  } else {
    db = {
      ...structuredClone(DEFAULT_DB),
      ...incoming,
      settings: { ...DEFAULT_DB.settings, ...(incoming.settings || {}) },
      shifts: (incoming.shifts || []).map(normalizeShift),
      expenses: incoming.expenses || [],
      trips: incoming.trips || [],
      incomes: (incoming.incomes || []).map(normalizeIncome),
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
export function summarize(shifts, expenses, settings = db.settings) {
  const income = shifts.reduce((a, s) => a + shiftIncome(s), 0);
  const gross = shifts.reduce((a, s) => a + num(s.gross), 0);
  const tips = shifts.reduce((a, s) => a + num(s.tips), 0);
  const hours = shifts.reduce((a, s) => a + num(s.hours), 0);
  const miles = shifts.reduce((a, s) => a + num(s.miles), 0);
  // Actual vs scheduled time, over shifts that have both (Flex blocks).
  const schedShifts = shifts.filter((s) => num(s.scheduledHours) > 0 && num(s.hours) > 0);
  const schedPlanned = schedShifts.reduce((a, s) => a + num(s.scheduledHours), 0);
  const schedActual = schedShifts.reduce((a, s) => a + num(s.hours), 0);
  const jobs = shifts.reduce((a, s) => a + num(s.jobs), 0);
  const expenseTotal = expenses.reduce((a, e) => a + num(e.amount), 0);
  const mileageDeduction = miles * num(settings.mileageRate);
  const net = income - expenseTotal;
  // Taxable profit uses the larger of actual expenses or the standard mileage
  // deduction (you can't claim both). Never below zero.
  const taxableEstimate = Math.max(0, income - Math.max(expenseTotal, mileageDeduction));
  const taxSetAside = taxableEstimate * num(settings.taxRate);
  return {
    income, gross, tips, hours, miles, jobs,
    expenseTotal, net, mileageDeduction,
    taxableEstimate, taxSetAside,
    takeHomeAfterTax: net - taxSetAside,
    schedPlanned, schedActual, schedShiftCount: schedShifts.length,
    // % of scheduled block time actually spent (<100% = finished blocks early).
    actualVsScheduledPct: schedPlanned ? (schedActual / schedPlanned) * 100 : 0,
    perHour: hours ? income / hours : 0,
    perMile: miles ? income / miles : 0,
    perJob: jobs ? income / jobs : 0,
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

// Weekly goal for Campaign 350: earn $2,450 (= $350 × 7) in the current week.
// Hit it before the week is out and the rest of the week's days are "earned off".
export function weeklyGoalStats(nowISO = todayISO()) {
  const weekly = CAMPAIGN.weekly;
  const daily = CAMPAIGN.daily;
  const startD = startOfWeek(new Date(nowISO + 'T00:00:00'));
  const endD = new Date(startD);
  endD.setDate(endD.getDate() + 6);
  const weekStartISO = isoDate(startD);
  const weekEndISO = isoDate(endD);

  const m = incomeByDateMap();
  let weekEarned = 0;
  for (const [d, v] of m) if (d >= weekStartISO && d <= weekEndISO) weekEarned += v;

  const daysElapsed = Math.min(7, Math.max(1, daysInclusive(weekStartISO, nowISO)));
  const daysLeft = 7 - daysElapsed; // days remaining after today
  const met = weekEarned >= weekly;
  const remaining = Math.max(0, weekly - weekEarned);
  // Per-day needed to still finish the week, counting today.
  const perDayNeeded = met ? 0 : remaining / (daysLeft + 1);
  // Days off earned: once the week's goal is met, every remaining day is free.
  const daysOff = met ? daysLeft : 0;
  const pct = weekly > 0 ? Math.min(100, (weekEarned / weekly) * 100) : 0;

  return {
    weekly, daily, weekStart: weekStartISO, weekEnd: weekEndISO,
    weekEarned, daysElapsed, daysLeft, met, remaining, perDayNeeded, daysOff, pct,
  };
}

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
