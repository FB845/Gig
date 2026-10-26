#!/usr/bin/env node
// Gig Tracker MCP server — read-only, live access to your tracker for Claude
// Desktop / Cowork / Claude Code. It reads your cloud-synced data the same way
// the Raycast extension does (your connection key → Firestore REST), keeps a
// private cache on this computer, and answers with the app's own maths.
// It never writes: nothing here can change your data.
//
// stdout is the MCP channel — log to stderr only.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { NO_KEY, endpoints, freshMs, loadKey, storage } from './config.mjs';

let lib;
try {
  const { createCloud, store } = await import('./lib/cloud.js');
  const { buildDigest } = await import('./lib/weekly-summary.js');
  lib = { createCloud, store, buildDigest };
} catch (e) {
  console.error('Gig Tracker MCP: the app’s data model isn’t copied in yet — run `npm install` in the mcp folder.\n', e.message);
  process.exit(1);
}
const { createCloud, store, buildDigest } = lib;

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const dayOf = (iso) => DOW[new Date(iso + 'T00:00:00').getDay()];
const ISO = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD');
const PLATFORM = z.enum(['flex', 'doordash', 'other']);
const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); return store.isoDate(d); };
const weekStartOf = (iso) => store.isoDate(store.startOfWeek(new Date(iso + 'T00:00:00')));

// ---- live data: pull what changed, serialised so calls never overlap ----
let cloud = null;
let lastPull = 0;
let asOf = 0;
let chain = Promise.resolve();

async function fresh() {
  const key = loadKey();
  if (!key) throw new Error(NO_KEY);
  cloud ||= createCloud({ key, storage, endpoints, deviceId: 'mcp' });
  if (Date.now() - lastPull < freshMs && lastPull) return '';
  try {
    const r = await cloud.pull();
    lastPull = Date.now();
    asOf = r.lastSync;
    return '';
  } catch (e) {
    const o = await cloud.open();
    asOf = o.lastSync;
    if (!asOf) throw new Error(`Couldn’t reach your cloud data and there's no saved copy yet: ${e.message}`);
    return `Couldn’t reach the cloud (${e.message}) — showing the copy from ${new Date(asOf).toLocaleString()}.`;
  }
}

function tool(name, config, fn) {
  server.registerTool(name, { ...config, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }, (args) => {
    const run = chain.then(async () => {
      try {
        const note = await fresh();
        const out = fn(args || {});
        return { content: [{ type: 'text', text: JSON.stringify({ ...(note ? { note } : {}), data_as_of: asOf ? new Date(asOf).toISOString() : null, ...out }) }] };
      } catch (e) {
        return { isError: true, content: [{ type: 'text', text: String(e.message || e) }] };
      }
    });
    chain = run.catch(() => {});
    return run;
  });
}

const server = new McpServer(
  { name: 'gig-tracker', version: '1.0.0' },
  {
    instructions: [
      'Read-only access to the user\'s live Gig Tracker data: their delivery/rideshare shifts (Amazon Flex, DoorDash, other), other income, expenses, planned blocks and goals.',
      'Money is US dollars; times are 24-hour HH:MM in the user\'s local time; dates are YYYY-MM-DD. Weeks start on the user\'s configured week-start day.',
      'Start with gig_status for "where am I now". Use gig_weekly_digest to write a weekly summary, gig_week for a week\'s schedule and gaps, gig_stats for totals over a period, gig_best_hours for when they earn best, gig_records for the underlying rows.',
      'The goal is the user\'s own: a daily target (CAMPAIGN daily) with earned days off once a week\'s goal is met early. Flex blocks are estimated at the standard $26.50/hr; other platforms have no automatic estimate.',
      'Nothing here can change their data. To log or plan something, tell them to use the app or Raycast.',
    ].join('\n'),
  },
);

// ---- shaping records for output ----
const notes = (rec, include) => (include ? { notes: rec.notes ?? rec.note ?? '' } : {});
const planOut = (p, inc = false) => ({
  id: p.id, date: p.date, day: dayOf(p.date), start: p.startTime || null, end: p.endTime || null, platform: p.platform,
  block_type: p.tag || null, hours: p.hours || null, estimate: r2(p.estimate), source: p.source || undefined,
  status: store.planStatus(p), ...(inc ? { note: p.note || '' } : {}),
});
const shiftOut = (s, inc = false) => {
  const inc$ = store.shiftIncome(s);
  return {
    id: s.id, date: s.date, day: dayOf(s.date), platform: s.platform, start: s.startTime || null, end: s.endTime || null,
    hours: r2(s.hours), base_pay: r2(s.gross), tips: r2(s.tips), income: r2(inc$), per_hour: s.hours ? r2(inc$ / s.hours) : null,
    miles: r2(s.miles), deliveries: s.jobs || 0, block_type: s.tag || null, scheduled_hours: s.scheduledHours || null, ...notes(s, inc),
  };
};
const incomeOut = (i, inc = false) => ({ id: i.id, date: i.date, day: dayOf(i.date), source: i.source, amount: r2(i.amount), start: i.startTime || null, end: i.endTime || null, hours: r2(i.hours), ...notes(i, inc) });
const expenseOut = (e, inc = false) => ({ id: e.id, date: e.date, day: dayOf(e.date), category: e.category, amount: r2(e.amount), ...notes(e, inc) });
const tripOut = (t, inc = false) => { const { notes: n, note, ...rest } = t; return { ...rest, ...(inc ? { notes: n ?? note ?? '' } : {}) }; };

// ---- tools ----
tool('gig_status', {
  title: 'Where am I now?',
  description: 'The current state: today\'s earnings vs the daily goal, this week and month goal progress (earned, planned, shortfall, days off earned), the campaign pace, today\'s and upcoming planned blocks, and blocks waiting to be logged.',
  inputSchema: {},
}, () => {
  const today = store.todayISO();
  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const daily = store.CAMPAIGN.daily;
  const earned = store.dailyIncome(today);
  const goal = (g) => ({
    start: g.start, end: g.end, goal: r2(g.goal), earned: r2(g.earned), planned: r2(g.planned), projected: r2(g.projected),
    goal_met: g.met, goal_met_on: g.metOn, remaining: r2(g.remaining), shortfall_after_plans: r2(g.shortfall),
    days_left_after_today: g.daysLeft, per_day_needed: r2(g.perDayNeeded), days_off_earned: g.daysOff, banked_rolls_into_next: r2(g.banked),
    will_meet_with_plans: g.projMet, will_meet_on: g.projMetOn,
  });
  const camp = store.campaignStats();
  const open = store.getPlans().filter((p) => store.planOpen(p) && p.date >= today);
  return {
    today: { date: today, day: dayOf(today), now: hhmm, earned: r2(earned), daily_goal: daily, to_go: r2(Math.max(0, daily - earned)), goal_hit: earned >= daily, planned_still_to_come: r2(store.trajectory(today, today)[0].planned) },
    week: goal(store.weeklyGoalStats()),
    month: goal(store.monthlyGoalStats()),
    campaign: {
      start: camp.start, end: camp.end, daily_goal: camp.daily, days_elapsed: camp.daysElapsed, days_remaining: camp.daysRemaining,
      earned_to_date: r2(camp.earnedToDate), goal_to_date: r2(camp.goalToDate), ahead_of_pace: r2(camp.ahead),
      remaining_goal: r2(camp.remainingGoal), required_per_day: r2(camp.requiredPace), streak_days: camp.streak,
    },
    todays_plans: open.filter((p) => p.date === today).map((p) => planOut(p)),
    upcoming_plans: open.filter((p) => p.date > today).slice(0, 8).map((p) => planOut(p)),
    waiting_to_be_logged: store.plansToLog().map((p) => planOut(p)),
  };
});

tool('gig_week', {
  title: 'A week\'s schedule',
  description: 'One week laid out day by day: what you earned, what is planned, the shifts/plans/income on each day, whether the weekly goal is covered (and the day it is met), and the best open slots to fill a shortfall. Defaults to this week.',
  inputSchema: { date: ISO.optional().describe('Any date inside the week you want (default: today)') },
}, ({ date }) => {
  const today = store.todayISO();
  const ws = weekStartOf(date || today);
  const dw = store.deskWeek(ws, today);
  const plans = store.getPlans(), shifts = store.getShifts(), incomes = store.getIncomes();
  return {
    week: { start: ws, end: dw.end, is_current: dw.isCurrent },
    goal: r2(dw.goal), earned: r2(dw.earned), planned: r2(dw.planned), projected: r2(dw.projected), shortfall: r2(dw.shortfall),
    goal_met_on: dw.metOn, free_days_earned: dw.daysOff, hours_on_clock: r2(dw.hours),
    days: dw.days.map((d) => ({
      date: d.date, day: dayOf(d.date), earned: r2(d.actual), planned: r2(d.planned),
      plans: plans.filter((p) => p.date === d.date).map((p) => planOut(p)),
      shifts: shifts.filter((s) => s.date === d.date).map((s) => shiftOut(s)),
      other_income: incomes.filter((i) => i.date === d.date).map((i) => incomeOut(i)),
    })),
    suggested_open_slots: store.suggestSlots(ws, { max: 6, nowISO: today }).map((s) => ({ date: s.date, day: dayOf(s.date), start: s.startTime, end: s.endTime, platform: s.platform, typical_per_hour: r2(s.rate), estimate: r2(s.estimate), on_a_free_day: s.freeDay })),
  };
});

tool('gig_weekly_digest', {
  title: 'Weekly digest',
  description: 'The same digest the app\'s Weekly summary feature sends to Claude: that week\'s totals, per-day income, platform and Flex block-type rates, best/worst shifts, expenses by category, the previous four weeks, plan status and next week\'s plan. Use it to write a weekly summary. No notes or places.',
  inputSchema: { week: z.union([z.enum(['this', 'last']), ISO]).optional().describe('"this" (default), "last", or any date inside the week') },
}, ({ week }) => {
  const today = store.todayISO();
  const base = weekStartOf(today);
  const ws = !week || week === 'this' ? base : week === 'last' ? addDays(base, -7) : weekStartOf(week);
  return { digest: buildDigest(store, ws, today) };
});

tool('gig_stats', {
  title: 'Totals for a period',
  description: 'Income, expenses, net, hours, miles, $/hr, $/mile, tax set-aside estimate and mileage deduction over a period, with breakdowns by platform, by weekday and by Flex block type.',
  inputSchema: {
    period: z.enum(['week', 'month', '30d', 'year', 'all']).optional().describe('Default: month (this calendar month). Ignored when from/to are given.'),
    from: ISO.optional(), to: ISO.optional(),
    platform: PLATFORM.optional().describe('Limit gig shifts to one platform (expenses and other income are not filtered)'),
  },
}, ({ period, from, to, platform }) => {
  const range = from || to ? { from: from || null, to: to || null } : store.rangeFor(period || 'month');
  const inR = (x) => (!range.from || x.date >= range.from) && (!range.to || x.date <= range.to);
  const shifts = store.getShifts().filter((s) => inR(s) && (!platform || s.platform === platform));
  const expenses = store.getExpenses().filter(inR);
  const incomes = store.getIncomes().filter(inR);
  const settings = store.getSettings();
  const s = store.summarize(shifts, expenses, settings, incomes);
  const group = (rows, keyOf) => {
    const m = new Map();
    for (const x of rows) { const k = keyOf(x); const g = m.get(k) || { shifts: 0, income: 0, hours: 0, miles: 0 }; g.shifts++; g.income += store.shiftIncome(x); g.hours += x.hours || 0; g.miles += x.miles || 0; m.set(k, g); }
    return m;
  };
  const fmt = (g) => ({ shifts: g.shifts, income: r2(g.income), hours: r2(g.hours), miles: r2(g.miles), per_hour: g.hours ? r2(g.income / g.hours) : null, per_mile: g.miles ? r2(g.income / g.miles) : null });
  return {
    range, platform: platform || 'all',
    totals: {
      gig_income: r2(s.gigIncome), base_pay: r2(s.gross), tips: r2(s.tips), other_income: r2(s.manualIncome), total_income: r2(s.totalIncome),
      expenses: r2(s.expenseTotal), net: r2(s.net), hours: r2(s.hours), miles: r2(s.miles), deliveries: s.jobs, shifts: s.shiftCount,
      per_hour: s.hours ? r2(s.perHour) : null, per_mile: s.miles ? r2(s.perMile) : null, per_delivery: s.jobs ? r2(s.perJob) : null,
      mileage_deduction: r2(s.mileageDeduction), taxable_estimate: r2(s.taxableEstimate), tax_set_aside_estimate: r2(s.taxSetAside), take_home_after_tax: r2(s.takeHomeAfterTax),
    },
    by_platform: Object.fromEntries([...group(shifts, (x) => x.platform)].map(([k, g]) => [k, fmt(g)])),
    by_weekday: [...group(shifts, (x) => new Date(x.date + 'T00:00:00').getDay())].sort((a, b) => a[0] - b[0]).map(([k, g]) => ({ day: DOW[k], ...fmt(g) })),
    flex_by_block_type: store.flexByTag(shifts).map((t) => ({ type: t.tag, blocks: t.count, income: r2(t.income), per_hour: r2(t.perHour), block_time_used_pct: t.effPct ? Math.round(t.effPct) : null })),
    expenses_by_category: Object.fromEntries([...expenses.reduce((m, e) => m.set(e.category || 'Other', (m.get(e.category || 'Other') || 0) + (e.amount || 0)), new Map())].map(([k, v]) => [k, r2(v)])),
  };
});

tool('gig_best_hours', {
  title: 'Best hours to work',
  description: 'When the user earns best: $/hr by weekday and hour from their own timed shifts (each shift\'s pay spread over the hours it covered). Returns the best and worst cells with enough history (≥1 h).',
  inputSchema: {
    platform: z.enum(['all', 'flex', 'doordash', 'other']).optional(),
    days: z.number().int().min(0).max(1000).optional().describe('Look-back window in days (default 90; 0 = all history)'),
    net: z.boolean().optional().describe('Subtract mileage cost (IRS rate) from pay'),
    top: z.number().int().min(1).max(30).optional().describe('How many best/worst cells (default 8)'),
  },
}, ({ platform, days, net, top }) => {
  const n = top || 8;
  const heat = store.hourlyHeat({ platform: platform || 'all', days: days ?? 90, net: !!net });
  const cells = [];
  heat.cells.forEach((row, dow) => row.forEach((c, hour) => { if (c.rate != null && c.hours >= 1) cells.push({ day: DOW[dow], hour: `${String(hour).padStart(2, '0')}:00`, per_hour: r2(c.rate), hours_of_data: r2(c.hours), shifts: c.shifts }); }));
  cells.sort((a, b) => b.per_hour - a.per_hour);
  return {
    platform: platform || 'all', window_days: days ?? 90, net_of_mileage: !!net,
    shifts_with_clock_times: heat.timed, shifts_total: heat.total,
    best: cells.slice(0, n), worst: cells.length > n * 2 ? cells.slice(-n).reverse() : [],
    note: heat.timed < 5 ? 'Very little timed history — treat this as a hint, not a pattern.' : undefined,
  };
});

tool('gig_records', {
  title: 'Underlying records',
  description: 'The raw rows: shifts, plans, other income, expenses or trips, newest first, with optional date range and platform filter. Notes are left out unless include_notes is true.',
  inputSchema: {
    kind: z.enum(['shifts', 'plans', 'incomes', 'expenses', 'trips']),
    from: ISO.optional(), to: ISO.optional(),
    platform: PLATFORM.optional().describe('shifts and plans only'),
    limit: z.number().int().min(1).max(500).optional().describe('Default 50'),
    include_notes: z.boolean().optional(),
  },
}, ({ kind, from, to, platform, limit, include_notes }) => {
  const inc = !!include_notes;
  const src = { shifts: store.getShifts, plans: store.getPlans, incomes: store.getIncomes, expenses: store.getExpenses, trips: store.getTrips }[kind]();
  const rows = src
    .filter((x) => (!from || x.date >= from) && (!to || x.date <= to) && (!platform || !['shifts', 'plans'].includes(kind) || x.platform === platform))
    .sort((a, b) => (b.date + (b.startTime || '')).localeCompare(a.date + (a.startTime || '')));
  const shape = { shifts: shiftOut, plans: planOut, incomes: incomeOut, expenses: expenseOut, trips: tripOut }[kind];
  const out = rows.slice(0, limit || 50).map((x) => shape(x, inc));
  const total = kind === 'shifts' ? rows.reduce((a, s) => a + store.shiftIncome(s), 0) : kind === 'incomes' ? rows.reduce((a, i) => a + i.amount, 0) : kind === 'expenses' ? rows.reduce((a, e) => a + e.amount, 0) : kind === 'plans' ? rows.filter((p) => store.planOpen(p)).reduce((a, p) => a + p.estimate, 0) : null;
  return { kind, matching: rows.length, returned: out.length, ...(total != null ? { [kind === 'plans' ? 'open_plans_estimate_total' : 'total_amount']: r2(total) } : {}), records: out };
});

tool('gig_settings', {
  title: 'Settings and goals',
  description: 'The rates and goals the app uses: IRS mileage rate, tax set-aside %, fuel price and MPG, minimum $/mile and $/hr, the daily goal and campaign window, and the Flex standard rate.',
  inputSchema: {},
}, () => ({ settings: store.getSettings(), campaign: store.CAMPAIGN, flex_standard_rate_per_hour: store.FLEX_RATE }));

// ---- go ----
await server.connect(new StdioServerTransport());
console.error('Gig Tracker MCP ready (read-only).');
