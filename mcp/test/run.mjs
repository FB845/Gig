// npm test — starts a fake Firebase (auth + Firestore REST), launches the MCP
// server against it over stdio, and drives it with the real MCP client.
// Never touches your real project or data.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
execFileSync('node', [path.join(here, '../scripts/sync-core.mjs')], { stdio: 'ignore' });

let fails = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗'} ${m}`); if (!c) fails++; };

// ---- seed data, relative to today so goals mean something ----
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return iso(d); };
const today = day(0), yest = day(-1), tom = day(1);
const records = [
  { col: 'settings', id: 'main', data: { mileageRate: 0.7, taxRate: 0.25, fuelPrice: 3.5, mpg: 25, weekStart: 1 } },
  { col: 'shifts', id: 's1', data: { id: 's1', platform: 'flex', date: today, startTime: '06:00', endTime: '09:30', hours: 3.5, gross: 92, tips: 8, miles: 30, jobs: 12, tag: 'Express', notes: 'SECRET-NOTE', createdAt: '2026-01-01T00:00:00Z' } },
  { col: 'shifts', id: 's2', data: { id: 's2', platform: 'doordash', date: yest, startTime: '17:00', endTime: '20:00', hours: 3, gross: 50, tips: 30, miles: 22, jobs: 9, createdAt: '2026-01-01T00:00:00Z' } },
  { col: 'incomes', id: 'i1', data: { id: 'i1', date: yest, source: 'TraceHaus', payType: 'flat', amount: 300, hours: 0, note: 'invoice 12' } },
  { col: 'expenses', id: 'e1', data: { id: 'e1', date: yest, category: 'Tolls', amount: 7.5, note: 'SECRET-EXP' } },
  { col: 'plans', id: 'p1', data: { id: 'p1', date: tom, platform: 'flex', startTime: '09:00', endTime: '12:30', hours: 3.5, tag: 'Local', estimate: 92.75, note: 'SECRET-PLAN', createdAt: '2026-01-01T00:00:00Z' } },
  { col: 'shifts', id: 'gone', data: { id: 'gone', platform: 'flex', date: yest, hours: 1, gross: 999 } }, // deleted below
];

// ---- fake Firebase ----
const enc = (v) => {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(enc) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)])) } };
};
const seen = { token: 0, query: 0, bearer: [] };
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.url.startsWith('/securetoken.googleapis.com/v1/token')) {
      seen.token++;
      return send(200, { id_token: 'idtok', refresh_token: 'r2', expires_in: '3600', user_id: 'uid1' });
    }
    if (req.url.includes('/users/uid1:runQuery')) {
      seen.query++; seen.bearer.push(req.headers.authorization);
      const rows = records.map((r, i) => ({ document: { name: `projects/p/databases/(default)/documents/users/uid1/records/${r.col}~${r.id}`, fields: { col: enc(r.col), id: enc(r.id), data: enc(r.data), deleted: enc(r.id === 'gone'), ts: { timestampValue: new Date(Date.now() - 60000 + i).toISOString() }, dev: enc('test') } } }));
      return send(200, rows);
    }
    send(404, { error: { message: 'not found' } });
  });
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${fake.address().port}`;
const KEY = 'gt1.' + Buffer.from(JSON.stringify({ k: 'AIza-test', p: 'proj-test', r: 'refresh-test', e: 'me@example.com' })).toString('base64url');
const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gig-mcp-'));

const connect = async (env) => {
  const transport = new StdioClientTransport({
    command: 'node', args: [path.join(here, '../server.mjs')],
    env: { PATH: process.env.PATH, HOME: os.tmpdir(), GIG_CACHE_DIR: cacheDir, GIG_FRESH_SECONDS: '0', GIG_TEST_AUTH_URL: base, GIG_TEST_FIRESTORE_URL: base, ...env },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(transport);
  return client;
};
const call = async (c, name, args = {}) => {
  const r = await c.callTool({ name, arguments: args });
  const text = r.content[0].text;
  let json = null; try { json = JSON.parse(text); } catch { /* error text */ }
  return { r, text, json };
};

console.log('\nGig Tracker MCP');
const c = await connect({ GIG_TRACKER_KEY: KEY });
const tools = (await c.listTools()).tools;
ok(['gig_status', 'gig_week', 'gig_weekly_digest', 'gig_stats', 'gig_best_hours', 'gig_records', 'gig_settings'].every((n) => tools.some((t) => t.name === n)) && tools.length === 7, 'seven tools offered');
ok(tools.every((t) => t.annotations?.readOnlyHint === true && t.annotations?.destructiveHint === false), 'every tool is marked read-only');
ok(/Read-only access/.test(c.getInstructions?.() || ''), 'server instructions explain the data and units');

let t = await call(c, 'gig_status');
ok(!t.r.isError && t.json.today.earned === 100 && t.json.today.daily_goal === 350 && t.json.today.to_go === 250, 'status: today earned $100 (92 + 8 tips) of $350, $250 to go');
ok(t.json.week.earned >= 100 && t.json.upcoming_plans.length === 1 && t.json.upcoming_plans[0].start === '09:00' && t.json.upcoming_plans[0].estimate === 92.75, 'status: week progress and tomorrow\'s planned block');
ok(!/SECRET/.test(t.text) && t.json.data_as_of, 'status: no notes, and says how fresh the data is');
ok(seen.token === 1 && seen.bearer[0] === 'Bearer idtok', 'signed in with the key (one token exchange, bearer on the query)');

t = await call(c, 'gig_records', { kind: 'shifts' });
ok(t.json.matching === 2 && t.json.records[0].date === today && t.json.records[0].per_hour === 28.57 && !t.json.records.some((r) => r.id === 'gone'), 'records: 2 shifts, newest first, deleted ones excluded');
ok(!/SECRET/.test(t.text), 'records: notes left out by default');
t = await call(c, 'gig_records', { kind: 'shifts', include_notes: true, platform: 'flex' });
ok(t.json.matching === 1 && t.json.records[0].notes === 'SECRET-NOTE', 'records: include_notes brings notes back; platform filter works');
t = await call(c, 'gig_records', { kind: 'incomes' });
ok(t.json.total_amount === 300 && t.json.records[0].source === 'TraceHaus', 'records: other income with its source');
t = await call(c, 'gig_records', { kind: 'plans' });
ok(t.json.open_plans_estimate_total === 92.75 && t.json.records[0].status === 'upcoming', 'records: plans with status and open-estimate total');

t = await call(c, 'gig_stats', { period: 'all' });
ok(t.json.totals.gig_income === 180 && t.json.totals.other_income === 300 && t.json.totals.expenses === 7.5 && t.json.by_platform.flex.income === 100 && t.json.by_platform.doordash.per_hour === 26.67, 'stats: $180 gig + $300 other, $7.50 expenses, per-platform $/hr');
t = await call(c, 'gig_stats', { period: 'all', platform: 'doordash' });
ok(t.json.totals.gig_income === 80 && t.json.totals.shifts === 1, 'stats: platform filter');

t = await call(c, 'gig_week');
ok(t.json.days.length === 7 && t.json.week.start <= today && t.json.week.end >= today && t.json.goal > 0, 'week: seven days with a goal');
t = await call(c, 'gig_week', { date: tom });
ok(t.json.days.some((d) => d.date === tom && d.plans.length === 1), 'week: any date picks its week; tomorrow\'s plan is there');

t = await call(c, 'gig_weekly_digest', { week: 'this' });
ok(t.json.digest.week_complete === false && t.json.digest.previous_weeks.length === 4 && !/SECRET|invoice/.test(t.text), 'digest: this week, four previous weeks, no notes');
t = await call(c, 'gig_best_hours', { platform: 'flex' });
ok(t.json.best.some((b) => b.hour === '06:00') && t.json.shifts_with_clock_times === 1 && /Very little/.test(t.json.note), 'best hours: the 06:00–09:30 Flex block shows, with a thin-data caution');
t = await call(c, 'gig_settings');
ok(t.json.settings.mileageRate === 0.7 && t.json.campaign.daily === 350 && t.json.flex_standard_rate_per_hour === 26.5, 'settings: rates, goal and the Flex standard rate');
t = await call(c, 'gig_records', { kind: 'shifts', from: 'yesterday' }).catch((e) => ({ r: { isError: true }, text: String(e) }));
ok(t.r.isError === true, 'bad input is refused (dates must be YYYY-MM-DD)');

// ---- offline: serve the cached copy and say so ----
await new Promise((r) => fake.close(r));
fake.closeAllConnections?.();
t = await call(c, 'gig_status');
ok(!t.r.isError && t.json.today.earned === 100 && /Couldn’t reach the cloud/.test(t.json.note), 'offline: still answers from the saved copy, and says so');
const mode = fs.statSync(path.join(cacheDir, 'cache.json')).mode & 0o777;
ok(mode === 0o600, `cache file is private (mode ${mode.toString(8)})`);
await c.close();

// ---- no key ----
const c2 = await connect({ GIG_TRACKER_KEY: '' });
t = await call(c2, 'gig_status');
ok(t.r.isError === true && /Copy Raycast key/.test(t.text), 'no key: a clear message on how to get one');
await c2.close();

fs.rmSync(cacheDir, { recursive: true, force: true });
console.log(fails ? `\nGIG MCP: ${fails} FAILED` : '\nGIG MCP: ALL PASSED ✓');
process.exit(fails ? 1 : 0);
