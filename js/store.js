// store.js — on-device data layer + metrics for the Gig Tracker.
// All data lives in localStorage. No accounts, no server, fully private.

const KEY = 'gigtracker.v1';

export const PLATFORMS = {
  flex: { id: 'flex', label: 'Amazon Flex', color: '#60a5fa', short: 'Flex' },
  doordash: { id: 'doordash', label: 'DoorDash', color: '#ef4444', short: 'Dasher' },
  other: { id: 'other', label: 'Other', color: '#a78bfa', short: 'Other' },
};

// Amazon Flex block-length presets (hours) and block types.
export const FLEX_BLOCK_PRESETS = [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5];
export const FLEX_TAGS = ['Rapid Express', 'Express', 'Rescue', 'Normal'];

export const EXPENSE_CATEGORIES = [
  'Fuel', 'Tolls', 'Maintenance', 'Car Payment', 'Insurance',
  'Phone', 'Supplies', 'Parking', 'Hot Bags', 'Other',
];

const DEFAULT_DB = {
  version: 1,
  settings: {
    // IRS standard mileage rate (business). 2025 = $0.70/mi. Editable.
    mileageRate: 0.70,
    // Set-aside % of net profit for self-employment + income tax. 25% is a
    // common rule-of-thumb starting point for gig drivers.
    taxRate: 0.25,
    weekStart: 1, // 0=Sun, 1=Mon
    currency: 'USD',
  },
  shifts: [],   // { id, platform, date, hours, gross, tips, jobs, miles, notes, createdAt }
  expenses: [], // { id, date, category, amount, note, platform, linkedShiftId, createdAt }
  trips: [],    // { id, date, miles, startedAt, endedAt, durationMs, fixes, linkedShiftId }
};

let db = load();
const listeners = new Set();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(DEFAULT_DB);
    const parsed = JSON.parse(raw);
    // shallow-merge settings so new defaults appear for older saves
    return {
      ...structuredClone(DEFAULT_DB),
      ...parsed,
      settings: { ...DEFAULT_DB.settings, ...(parsed.settings || {}) },
      shifts: parsed.shifts || [],
      expenses: parsed.expenses || [],
      trips: parsed.trips || [],
    };
  } catch (e) {
    console.error('Failed to load DB, starting fresh', e);
    return structuredClone(DEFAULT_DB);
  }
}

function persist() {
  localStorage.setItem(KEY, JSON.stringify(db));
  listeners.forEach((fn) => fn(db));
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

export function addShift(data) {
  const shift = normalizeShift({ id: uid(), createdAt: new Date().toISOString(), ...data });
  db.shifts.push(shift);
  // optional linked fuel expense created by the form
  if (data.fuel && Number(data.fuel) > 0) {
    addExpense({
      date: shift.date,
      category: 'Fuel',
      amount: Number(data.fuel),
      platform: shift.platform,
      note: 'Logged with shift',
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
  if (data.fuel && Number(data.fuel) > 0) {
    db.expenses.push({
      id: uid(), date: shift.date, category: 'Fuel', amount: Number(data.fuel),
      note: 'Imported', platform: shift.platform, linkedShiftId: shift.id,
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
  } else {
    db = {
      ...structuredClone(DEFAULT_DB),
      ...incoming,
      settings: { ...DEFAULT_DB.settings, ...(incoming.settings || {}) },
      shifts: (incoming.shifts || []).map(normalizeShift),
      expenses: incoming.expenses || [],
      trips: incoming.trips || [],
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
