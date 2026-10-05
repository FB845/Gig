// Two-device cloud-sync test against the Firebase emulators (no real project).
//
//   npm i -g firebase-tools        # once (needs Java 11+)
//   node scripts/sync-test.mjs     # starts the auth + firestore emulators itself
//
// FIREBASE_BIN can point at a firebase CLI binary if it isn't on PATH.
// "desktop" and "phone" are separate browser profiles (separate localStorage /
// IndexedDB), like two real devices signed into the same account.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.woff2': 'font/woff2' };
const FIREBASE = process.env.FIREBASE_BIN || 'firebase';
const PROJECT = 'demo-gig';
const EMU = 'localhost:9099,localhost:8080';
const CONFIG = { apiKey: 'demo-key', authDomain: `${PROJECT}.firebaseapp.com`, projectId: PROJECT, appId: 'demo-app' };

const fails = [];
const ok = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ ') + msg); if (!cond) fails.push(msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- emulators ----
const emu = spawn(FIREBASE, ['emulators:start', '--only', 'auth,firestore', '--project', PROJECT], { cwd: path.join(root, 'firebase'), stdio: ['ignore', 'pipe', 'pipe'] });
let emuLog = '';
emu.stdout.on('data', (d) => { emuLog += d; });
emu.stderr.on('data', (d) => { emuLog += d; });
for (let i = 0; i < 120 && !/All emulators ready/.test(emuLog); i++) await sleep(500);
if (!/All emulators ready/.test(emuLog)) { console.error(emuLog); emu.kill(); process.exit(1); }
await fetch(`http://localhost:8080/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
await fetch(`http://localhost:9099/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE' });

// ---- app server ----
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.join(root, p);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;
const browser = await chromium.launch({ executablePath: EXE });
const errors = [];

// The Firebase SDK comes from gstatic. Fetch it with curl (which honours any
// HTTPS proxy) into a local cache and serve it to the browser from there.
const SDK_CACHE = path.join(os.tmpdir(), 'gig-firebase-sdk');
fs.mkdirSync(SDK_CACHE, { recursive: true });
async function serveSDK(route) {
  const url = route.request().url();
  const file = path.join(SDK_CACHE, url.replace(/[^a-z0-9.]+/gi, '_').slice(0, 200));
  try {
    if (!fs.existsSync(file)) {
      const type = execFileSync('curl', ['-sSfL', '-o', file, '-w', '%{content_type}', url]).toString();
      fs.writeFileSync(file + '.type', type || 'text/javascript');
    }
    await route.fulfill({ status: 200, contentType: fs.readFileSync(file + '.type', 'utf8'), body: fs.readFileSync(file) });
  } catch { await route.abort(); }
}

async function device(name, width) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
  await ctx.route(/^https:\/\/(www\.gstatic\.com|apis\.google\.com)\//, serveSDK);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => {
    const t = m.text();
    if ((m.type() === 'warning' || m.type() === 'error') && !/INTERNET_DISCONNECTED|transport errored|Service Worker registration blocked|Could not reach Cloud Firestore/.test(t)) console.log(`    [${name} ${m.type()}] ${t.slice(0, 200)}`);
  });
  await page.goto(base + '/index.html');
  await page.evaluate(({ cfg, emu }) => {
    localStorage.setItem('gigtracker.sync', JSON.stringify({ config: cfg }));
    localStorage.setItem('gigtracker.syncEmulator', emu);
  }, { cfg: CONFIG, emu: EMU });
  await page.reload({ waitUntil: 'networkidle' });
  return { name, ctx, page, s: (fn, arg) => page.evaluate(async ({ fn, arg }) => { const s = await import('./js/store.js'); return new Function('s', 'arg', `return (${fn})(s, arg)`)(s, arg); }, { fn: fn.toString(), arg }) };
}
const state = (d) => d.page.evaluate(async () => (await import('./js/sync.js')).getSyncState());
async function waitFor(d, fn, arg, label, ms = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await d.s(fn, arg)) return true; await sleep(150); }
  console.log(`    (timed out waiting: ${label})`); return false;
}
async function signIn(d, which) {
  await d.page.locator('.tab[data-view=settings]:visible, .snav[data-view=settings]:visible').first().click();
  await d.page.locator('#sync-email-toggle').click();
  await d.page.fill('#sync-email', 'driver@example.com');
  await d.page.fill('#sync-pass', 'hunter22');
  await d.page.locator(which === 'up' ? '#sync-signup' : '#sync-signin').click();
  for (let i = 0; i < 60; i++) { const st = await state(d); if (st.signedIn && st.status === 'synced') return st; await sleep(200); }
  return state(d);
}
const shiftIds = (s) => s.getShifts().map((x) => x.id).sort();

try {
  console.log('\n1) Desktop signs up and uploads its data');
  const desk = await device('desktop', 1280);
  await desk.s((s) => {
    s.addShift({ platform: 'flex', date: '2026-10-01', hours: 3.5, gross: 84, miles: 30, tag: 'Express', mpg: 25 });
    s.addShift({ platform: 'doordash', date: '2026-10-02', hours: 4, gross: 110, tips: 20, miles: 40, mpg: 25 });
    s.addPlan({ date: '2026-10-07', platform: 'flex', startTime: '08:00', endTime: '11:30', estimate: 88 });
    s.updateSettings({ fuelPrice: 3.89 });
  });
  const st1 = await signIn(desk, 'up');
  ok(st1.signedIn && st1.status === 'synced', `desktop signed in + synced (${st1.status}${st1.error ? ': ' + st1.error : ''})`);
  const docs = await (await fetch(`http://localhost:8080/v1/projects/${PROJECT}/databases/(default)/documents:runQuery`, {
    method: 'POST', headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId: 'records', allDescendants: true }] } }),
  })).json();
  const kinds = docs.filter((d) => d.document).map((d) => d.document.name.split('/').pop().split('~')[0]);
  ok(kinds.filter((k) => k === 'shifts').length === 2 && kinds.includes('plans') && kinds.includes('settings') && kinds.includes('expenses'),
    `one cloud doc per record (${kinds.length}: ${[...new Set(kinds)].join(', ')})`);

  console.log('\n2) Phone (with its own earlier shift) signs in → union, cloud settings kept');
  const phone = await device('phone', 390);
  await phone.s((s) => s.addShift({ platform: 'doordash', date: '2026-09-30', hours: 2, gross: 45, miles: 12, mpg: 25 }));
  const st2 = await signIn(phone, 'in');
  ok(st2.signedIn && st2.status === 'synced', `phone signed in + synced (${st2.status}${st2.error ? ': ' + st2.error : ''})`);
  ok(await waitFor(phone, (s) => s.getShifts().length === 3 && s.getPlans().length === 1, null, 'phone union'), 'phone has desktop\'s 2 shifts + plan, and kept its own shift');
  ok(await phone.s((s) => s.getSettings().fuelPrice) === 3.89, 'phone took desktop\'s settings (fuel $3.89), not its defaults');
  ok(await waitFor(desk, (s) => s.getShifts().length === 3, null, 'desktop gets phone shift'), 'desktop received the phone\'s earlier shift');

  console.log('\n3) Live: plan on desktop → appears on phone');
  await desk.s((s) => s.addPlan({ date: '2026-10-08', platform: 'doordash', startTime: '17:00', endTime: '21:00', estimate: 120, note: 'dinner rush' }));
  ok(await waitFor(phone, (s) => s.getPlans().some((p) => p.note === 'dinner rush'), null, 'plan live'), 'new desktop plan shows up on the phone');

  console.log('\n4) Same moment, different records: both edits survive');
  const [s1, s2] = await desk.s((s) => s.getShifts().filter((x) => x.date >= '2026-10-01').map((x) => x.id).sort());
  await Promise.all([
    desk.s((s, id) => s.updateShift(id, { gross: 99 }), s1),
    phone.s((s, id) => s.updateShift(id, { notes: 'long wait at store' }), s2),
  ]);
  const both = (s, a) => { const x = s.getShifts(); return x.find((r) => r.id === a[0])?.gross === 99 && x.find((r) => r.id === a[1])?.notes === 'long wait at store'; };
  ok(await waitFor(desk, both, [s1, s2], 'desk both') && await waitFor(phone, both, [s1, s2], 'phone both'), 'desktop edit + phone edit both present on both devices');

  console.log('\n5) Delete on phone → gone on desktop (and stays gone)');
  const planId = await phone.s((s) => s.getPlans().find((p) => p.note === 'dinner rush').id);
  await phone.s((s, id) => s.deletePlan(id), planId);
  ok(await waitFor(desk, (s, id) => !s.getPlans().some((p) => p.id === id), planId, 'delete'), 'deleted plan disappears on desktop');

  console.log('\n6) Phone offline: edits on both sides merge when it reconnects');
  await phone.ctx.setOffline(true);
  await phone.s((s) => s.addExpense({ date: '2026-10-03', category: 'Tolls', amount: 6.5, note: 'bridge' }));
  await desk.s((s) => s.addExpense({ date: '2026-10-03', category: 'Phone', amount: 20, note: 'plan' }));
  await sleep(1500);
  ok(!(await desk.s((s) => s.getExpenses().some((e) => e.note === 'bridge'))), 'while offline, desktop doesn\'t have the phone\'s toll yet');
  await phone.ctx.setOffline(false);
  await phone.page.evaluate(() => window.dispatchEvent(new Event('online')));
  const hasBoth = (s) => { const e = s.getExpenses(); return e.some((x) => x.note === 'bridge') && e.some((x) => x.note === 'plan' && x.category === 'Phone'); };
  ok(await waitFor(desk, hasBoth, null, 'desk offline merge', 20000) && await waitFor(phone, hasBoth, null, 'phone offline merge', 20000), 'after reconnecting, both devices have both expenses');

  console.log('\n7) Settings change syncs; reload keeps everything without re-uploading');
  await phone.s((s) => s.updateSettings({ mpg: 31 }));
  ok(await waitFor(desk, (s) => s.getSettings().mpg === 31, null, 'mpg'), 'phone MPG change reaches desktop');
  await sleep(800);
  const before = await desk.s((s) => ({ shifts: s.getShifts().length, plans: s.getPlans().length, expenses: s.getExpenses().length }));
  let writes = 0;
  desk.page.on('request', (r) => { if (/Write\/channel|commit/.test(r.url()) && r.method() === 'POST') writes++; });
  await desk.page.reload({ waitUntil: 'load' }); // Firestore keeps a stream open, so never "networkidle"
  for (let i = 0; i < 40 && !(await state(desk)).signedIn; i++) await sleep(200);
  await sleep(2500);
  const after = await desk.s((s) => ({ shifts: s.getShifts().length, plans: s.getPlans().length, expenses: s.getExpenses().length }));
  ok(JSON.stringify(before) === JSON.stringify(after) && (await state(desk)).signedIn, `desktop reload: still signed in, same data (${JSON.stringify(after)})`);
  ok(writes === 0, `no records re-uploaded on reload (${writes} write requests)`);
  await desk.s((s) => s.addExpense({ date: '2026-10-04', category: 'Parking', amount: 4, note: 'control' }));
  for (let i = 0; i < 30 && writes === 0; i++) await sleep(200);
  ok(writes > 0, `(control) a real edit after reload IS uploaded — the write counter works (${writes})`);
  ok(await waitFor(phone, (s) => s.getExpenses().some((e) => e.note === 'control'), null, 'control'), 'post-reload edit reaches the phone');

  console.log('\n8) Security rules: another account can\'t read or write this one');
  const emuAccounts = await (await fetch(`http://localhost:9099/identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:query`, { method: 'POST', headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' }, body: '{}' })).json();
  const ownerUid = emuAccounts.userInfo.find((u) => u.email === 'driver@example.com').localId;
  const intruder = await (await fetch('http://localhost:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-key', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'other@example.com', password: 'hunter22', returnSecureToken: true }) })).json();
  const asIntruder = { Authorization: `Bearer ${intruder.idToken}`, 'Content-Type': 'application/json' };
  const fsBase = `http://localhost:8080/v1/projects/${PROJECT}/databases/(default)/documents`;
  const rd = await fetch(`${fsBase}/users/${ownerUid}/records`, { headers: asIntruder });
  const wr = await fetch(`${fsBase}/users/${ownerUid}/records?documentId=shifts~evil`, { method: 'POST', headers: asIntruder, body: JSON.stringify({ fields: { col: { stringValue: 'shifts' } } }) });
  const own = await fetch(`${fsBase}/users/${intruder.localId}/records`, { headers: asIntruder });
  ok(rd.status === 403 && wr.status === 403, `other account: read ${rd.status}, write ${wr.status} (403 = denied)`);
  ok(own.status === 200, `…but it can use its own space (${own.status})`);

  console.log('\n9) Google sign-in (emulator popup) on a third device');
  const lap = await device('laptop', 1280);
  await lap.page.locator('.snav[data-view=settings]').click();
  if (process.env.SHOTS) await lap.page.locator('#sync-card').screenshot({ path: `${process.env.SHOTS}/sync-signin.png` });
  const [popup] = await Promise.all([lap.page.waitForEvent('popup'), lap.page.locator('#sync-google').click()]);
  await popup.waitForLoadState();
  await popup.getByText('Add new account').click();
  await popup.locator('#email-input').fill('driver.google@example.com');
  await popup.locator('#sign-in').click();
  let gst = await state(lap);
  for (let i = 0; i < 50 && !(gst.signedIn && gst.status === 'synced'); i++) { await sleep(200); gst = await state(lap); }
  ok(gst.signedIn && gst.status === 'synced' && gst.email === 'driver.google@example.com', `Google popup sign-in works (${gst.email || gst.error || gst.status})`);
  ok(await lap.page.locator('#sync-account:not(.hidden)').count() === 1 && /driver\.google/.test(await lap.page.locator('#sync-account-email').innerText()), 'Settings shows the signed-in account');

  if (process.env.SHOTS) {
    await phone.page.locator('.tab[data-view=settings]').click(); await sleep(300);
    await phone.page.locator('#sync-card').screenshot({ path: `${process.env.SHOTS}/sync-signedin.png` });
  }

  console.log('\n10) Final state identical on both devices');
  const snapshot = (s) => JSON.stringify({ sh: s.getShifts().map((x) => [x.id, x.gross, x.notes]).sort(), pl: s.getPlans().map((x) => x.id).sort(), ex: s.getExpenses().map((x) => x.id).sort(), set: s.getSettings() });
  ok(await desk.s(snapshot) === await phone.s(snapshot), 'desktop and phone data match exactly');
  ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
} catch (e) {
  console.error('TEST CRASH:', e);
  fails.push('crash: ' + e.message);
} finally {
  await browser.close();
  server.close();
  emu.kill('SIGINT');
}
console.log('\n' + (fails.length ? `FAILED (${fails.length}):\n- ` + fails.join('\n- ') : 'SYNC: ALL PASSED ✓'));
process.exit(fails.length ? 1 : 0);
