// Headless smoke test: serve the app, drive the UI, assert core behavior.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.join(root, p);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('nf'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

const fails = [];
const ok = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ ') + msg); if (!cond) fails.push(msg); };

await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const base = `http://localhost:${port}`;

const browser = await chromium.launch({ executablePath: EXE });
const page = await browser.newContext({ viewport: { width: 390, height: 800 } }).then((c) => c.newPage());
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

try {
  console.log('\n1) Load app');
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForTimeout(300);
  ok(await page.locator('h1').innerText() === 'Gig Tracker', 'app title renders');
  ok(await page.locator('#view-dashboard.active').count() === 1, 'dashboard is default view');
  ok(await page.locator('#update-banner.hidden').count() === 1, 'update banner present and hidden by default');

  console.log('\n2) Log a shift via the form');
  await page.locator('.tab[data-view=log]').click();
  await page.locator('#shift-platform .chip[data-val=doordash]').click();
  await page.fill('#shift-form [name=date]', '2026-07-06');
  await page.fill('#shift-form [name=hoursH]', '4');
  await page.fill('#shift-form [name=gross]', '40');
  await page.fill('#shift-form [name=tips]', '20');
  await page.fill('#shift-form [name=jobs]', '12');
  await page.fill('#shift-form [name=miles]', '30');
  // MPG-based auto fuel: 30 mi ÷ 25 mpg × $3.50/gal (default) = $4.20
  await page.fill('#shift-form [name=mpg]', '25');
  const live = await page.locator('#shift-live').innerText();
  ok(/\$15\.00/.test(live), 'live $/hr = $15.00 (60/4)');
  ok(/Fuel est\./.test(live) && /\$4\.20/.test(live), 'live fuel estimate = $4.20 (30/25 × $3.50)');
  await page.locator('#shift-submit').click();
  await page.waitForTimeout(150);
  ok((await page.locator('#log-list .record').count()) === 1, 'shift appears in list');

  console.log('\n3) MPG auto-created a linked fuel expense');
  await page.locator('#log-segmented .seg[data-log=expense]').click();
  await page.waitForTimeout(100);
  const expText = await page.locator('#log-list').innerText();
  ok(/Fuel/.test(expText) && /\$4\.20/.test(expText), 'auto Fuel expense of $4.20 exists');

  console.log('\n4) Dashboard KPIs reflect the data');
  await page.locator('.tab[data-view=dashboard]').click();
  await page.locator('#period-pills .pill[data-period=all]').click();
  await page.waitForTimeout(700); // let the LED count-up settle
  const kpi = await page.locator('#kpi-grid').innerText();
  ok(/\$56\b/.test(kpi), 'net income = $56 (60 income - $4.20 fuel, rounded)');
  ok(/\$4\b/.test(kpi), 'expenses out = $4 ($4.20 auto fuel, rounded)');
  ok(/\$15\.00/.test(kpi), '$/hour = $15.00');
  ok((await page.locator('#chart-earnings svg .bar').count()) >= 1, 'earnings chart drew bars');
  ok((await page.locator('#chart-platform svg .slice').count()) >= 1, 'platform donut drew slices');

  console.log('\n5) OCR text extraction (unit, in page)');
  const ocr = await page.evaluate(async () => {
    const m = await import('./js/parse.js');
    const sample = 'DoorDash\\nDash summary\\nTotal earnings $58.40\\nCustomer tips $22.00\\n15 deliveries\\n42.3 mi\\nJul 5, 2026';
    return m.extractFromText(sample.replace(/\\n/g, '\n'));
  });
  ok(ocr.platform === 'doordash', 'OCR detected DoorDash');
  ok(Math.abs(ocr.tips - 22) < 0.01, 'OCR tips = 22');
  ok(Math.abs(ocr.gross - 36.4) < 0.01, 'OCR base = total - tips = 36.40');
  ok(ocr.jobs === 15, 'OCR deliveries = 15');
  ok(Math.abs(ocr.miles - 42.3) < 0.01, 'OCR miles = 42.3');
  ok(ocr.date === '2026-07-05', 'OCR date parsed = 2026-07-05');

  console.log('\n6) CSV parsing (unit, in page)');
  const csv = await page.evaluate(async () => {
    const m = await import('./js/parse.js');
    const text = 'Date,Base Pay,Tips,Miles,Deliveries\n2026-07-01,30.00,12.50,25,8\n07/02/2026,28,15,22,7';
    return m.csvToShifts(text, 'doordash');
  });
  ok(csv.shifts.length === 2, 'CSV parsed 2 rows');
  ok(csv.shifts[0].date === '2026-07-01' && csv.shifts[1].date === '2026-07-02', 'CSV dates normalized (ISO + US)');
  ok(Math.abs(csv.shifts[0].gross - 30) < 0.01 && csv.shifts[0].jobs === 8, 'CSV fields mapped');

  console.log('\n7) Persistence across reload');
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(200);
  await page.locator('.tab[data-view=log]').click();
  ok((await page.locator('#log-list .record').count()) === 1, 'shift persisted after reload');

  console.log('\n8) Trends render without error');
  await page.locator('.tab[data-view=trends]').click();
  await page.waitForTimeout(150);
  ok((await page.locator('#view-trends svg').count()) >= 2, 'trend charts rendered');

  console.log('\n9) GPS mileage math (geo.js)');
  const geo = await page.evaluate(async () => {
    const g = await import('./js/geo.js');
    // ~1 mile north: 1 deg lat ≈ 69 mi, so 1/69 deg ≈ 1 mi
    const oneMi = g.haversineMiles({ lat: 40, lon: -74 }, { lat: 40 + 1 / 69.0, lon: -74 });
    // straight-line drive of 5 fixes, ~0.25 mi apart, plus a jitter point + a GPS jump
    const t0 = 1_000_000;
    const pts = [];
    for (let i = 0; i < 6; i++) pts.push({ lat: 40 + (i * 0.25) / 69, lon: -74, accuracy: 8, t: t0 + i * 20000 });
    pts.splice(3, 0, { lat: 40 + (2.001 * 0.25) / 69, lon: -74, accuracy: 8, t: t0 + 45000 }); // tiny jitter
    const acc = g.accumulate(pts);
    // tracker via ingest
    const tr = new g.DriveTracker();
    let last = 0; tr.ingest(40, -74, 8, t0); tr.ingest(40 + 1 / 69, -74, 8, t0 + 60000); last = tr.miles;
    return { oneMi, accMiles: acc.miles, trackerMiles: last };
  });
  ok(Math.abs(geo.oneMi - 1) < 0.02, `haversine 1° lat step ≈ 1 mi (got ${geo.oneMi.toFixed(3)})`);
  ok(Math.abs(geo.accMiles - 1.25) < 0.05, `accumulate 5×0.25mi ≈ 1.25 mi, jitter ignored (got ${geo.accMiles})`);
  ok(Math.abs(geo.trackerMiles - 1) < 0.02, `DriveTracker.ingest odometer ≈ 1 mi (got ${geo.trackerMiles})`);

  console.log('\n10) Tax set-aside math (store.summarize)');
  const tax = await page.evaluate(async () => {
    const s = await import('./js/store.js');
    // income 1000, expenses 100, miles 300 @ 0.70 = 210 deduction (> expenses)
    const shifts = [{ platform: 'flex', date: '2026-07-01', gross: 800, tips: 200, hours: 40, miles: 300, jobs: 100 }];
    const exp = [{ date: '2026-07-01', amount: 100 }];
    return s.summarize(shifts, exp, { mileageRate: 0.70, taxRate: 0.25 });
  });
  ok(Math.abs(tax.mileageDeduction - 210) < 0.01, 'mileage deduction = 300×0.70 = $210');
  ok(Math.abs(tax.taxableEstimate - 790) < 0.01, 'taxable = 1000 - max(100,210) = $790');
  ok(Math.abs(tax.taxSetAside - 197.5) < 0.01, 'set-aside = 790×0.25 = $197.50');
  ok(Math.abs(tax.takeHomeAfterTax - (900 - 197.5)) < 0.01, 'take-home = net(900) - tax(197.5)');

  console.log('\n11) Trip record + tax card in UI');
  await page.evaluate(async () => {
    const s = await import('./js/store.js');
    s.addTrip({ date: '2026-07-06', miles: 12.4, durationMs: 1800000, fixes: 40 });
  });
  await page.locator('.tab[data-view=log]').click();
  await page.locator('#log-segmented .seg[data-log=trip]').click();
  await page.waitForTimeout(100);
  ok(/12\.4 mi/.test(await page.locator('#log-list').innerText()), 'tracked trip shows in mileage log');
  await page.locator('.tab[data-view=dashboard]').click();
  await page.locator('#period-pills .pill[data-period=all]').click();
  await page.waitForTimeout(120);
  ok(/Set aside for taxes/i.test(await page.locator('#tax-card').innerText()), 'tax set-aside card renders on dashboard');
  ok((await page.locator('#drive-cta').count()) === 1, 'Start drive button present');

  console.log('\n12) Flex block presets + tags + actual-vs-scheduled %');
  await page.evaluate(async () => { (await import('./js/store.js')).clearAll(); });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(200);
  await page.locator('.tab[data-view=log]').click();
  ok((await page.locator('#flex-block-field:not(.hidden)').count()) === 1, 'Flex block field visible for Flex (default)');
  await page.locator('#shift-blockpreset .chip[data-val="3"]').click();
  ok((await page.locator('#shift-form [name=hoursH]').inputValue()) === '3' && (await page.locator('#shift-form [name=hoursM]').inputValue()) === '0', 'actual time prefilled to 3h 0m from block');
  await page.fill('#shift-form [name=hoursH]', '2'); // finished a 3:00 block at 2h20m
  await page.fill('#shift-form [name=hoursM]', '20');
  await page.locator('#shift-tag .chip[data-val="Rapid Express"]').click();
  await page.fill('#shift-form [name=date]', '2026-07-07');
  await page.fill('#shift-form [name=gross]', '66');
  await page.locator('#shift-form [name=gross]').dispatchEvent('input');
  ok(/78%/.test(await page.locator('#shift-live').innerText()), 'live "Block time" = 78% (2h20m / 3h, not rounded)');
  await page.locator('#shift-submit').click();
  await page.waitForTimeout(150);
  const fx = await page.evaluate(async () => (await import('./js/store.js')).getShifts()[0]);
  ok(fx.scheduledHours === 3 && Math.abs(fx.hours - 2 - 20 / 60) < 0.001, 'saved scheduled=3, actual=2h20m (2.333h, minute-precise)');
  ok(fx.tag === 'Rapid Express', 'saved tag = Rapid Express');
  ok(/特急/.test(await page.locator('#log-list').innerText()) && /78%\)/.test(await page.locator('#log-list').innerText()), 'shift row shows 種別 badge (特急) + (78%)');

  await page.locator('#shift-platform .chip[data-val="doordash"]').click();
  ok((await page.locator('#flex-block-field.hidden').count()) === 1, 'Flex fields hidden for DoorDash');
  ok((await page.locator('#hours-label').innerText()) === 'Hours worked', 'hours label reverts to "Hours worked" for DoorDash');

  await page.locator('.tab[data-view=dashboard]').click();
  await page.locator('#period-pills .pill[data-period=all]').click();
  await page.waitForTimeout(150);
  ok((await page.locator('#flex-eff-card:not(.hidden)').count()) === 1, 'Flex efficiency card shown on dashboard');
  ok(/78%/.test(await page.locator('#flex-eff-card').innerText()), 'efficiency card shows 78%');

  const eff = await page.evaluate(async () => {
    const s = await import('./js/store.js');
    return s.summarize([
      { platform: 'flex', date: '2026-07-01', scheduledHours: 3, hours: 2.25, gross: 60, tips: 0 },
      { platform: 'flex', date: '2026-07-02', scheduledHours: 2, hours: 2, gross: 40, tips: 0 },
    ], [], { mileageRate: 0.70, taxRate: 0.25 });
  });
  ok(Math.abs(eff.actualVsScheduledPct - 85) < 0.01, 'summarize actual-vs-scheduled = 85% ((2.25+2)/(3+2))');

  console.log('\n13) Flex pay by block type (Trends breakdown)');
  const byTag = await page.evaluate(async () => {
    const s = await import('./js/store.js');
    return s.flexByTag([
      { platform: 'flex', date: '2026-07-01', tag: 'Rapid Express', scheduledHours: 2, hours: 1.5, gross: 44, tips: 6 },
      { platform: 'flex', date: '2026-07-02', tag: 'Local', scheduledHours: 3, hours: 3, gross: 45, tips: 3 },
      { platform: 'doordash', date: '2026-07-03', tag: '', gross: 30, tips: 10, hours: 2 },
    ]);
  });
  ok(byTag.length === 2, 'flexByTag returns 2 tagged groups (ignores DoorDash/untagged)');
  ok(byTag[0].tag === 'Local', 'groups ordered by FLEX_TAGS (Local first)');
  const rapid = byTag.find((t) => t.tag === 'Rapid Express');
  ok(Math.abs(rapid.perHour - 50 / 1.5) < 0.01, 'Rapid Express $/hr = 50/1.5 = 33.33');
  ok(Math.abs(rapid.effPct - 75) < 0.01, 'Rapid Express block time = 1.5/2 = 75%');
  await page.locator('.tab[data-view=trends]').click();
  await page.waitForTimeout(150);
  ok((await page.locator('#flex-tag-card:not(.hidden)').count()) === 1, 'Flex-by-block-type card visible in Trends');
  ok((await page.locator('#chart-flex-tag svg .bar').count()) >= 1, 'block-type $/hr bar chart drew bars');
  ok(/Rapid Express/.test(await page.locator('#flex-tag-list').innerText()), 'block-type list shows Rapid Express');

  console.log('\n14) Route-strip total matches KPI income for every range');
  await page.evaluate(async () => {
    const s = await import('./js/store.js');
    s.clearAll();
    s.addShift({ platform: 'flex', date: s.todayISO(), gross: 100, tips: 20, hours: 4, jobs: 10, miles: 30 });
    const d = new Date(); d.setDate(d.getDate() - 100);
    s.addShift({ platform: 'doordash', date: s.isoDate(d), gross: 80, tips: 10, hours: 3, jobs: 8, miles: 20 });
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('.tab[data-view=dashboard]').click();
  await page.waitForTimeout(150);
  for (const period of ['week', 'month', 'year', 'all']) {
    await page.locator(`#period-pills .pill[data-period=${period}]`).click();
    await page.waitForTimeout(120);
    const r = await page.evaluate(async (p) => {
      const s = await import('./js/store.js');
      const { from, to } = s.rangeFor(p);
      const income = s.inRange(s.getShifts(), from, to).reduce((a, x) => a + s.shiftIncome(x), 0);
      const el = document.querySelector('#rs-total');
      return { income, shown: el ? el.textContent.trim() : '' };
    }, period);
    const expect = '$' + Math.round(r.income).toLocaleString();
    ok(r.income === 0 || r.shown === expect, `${period}: rollsign ${r.shown || '(empty)'} == income ${expect}`);
  }

  console.log('\n15) Campaign 350 metrics (fixed nowISO for determinism)');
  const c = await page.evaluate(async () => {
    const s = await import('./js/store.js');
    s.clearAll();
    s.addShift({ platform: 'flex', date: '2026-10-01', gross: 150, tips: 50, hours: 4, jobs: 10, miles: 30 }); // 200
    s.addIncome({ date: '2026-10-01', source: 'TraceHaus', amount: 200 }); // today 400 → hit
    s.addIncome({ date: '2026-09-30', source: 'TraceHaus', amount: 350 }); // hit
    s.addShift({ platform: 'doordash', date: '2026-09-29', gross: 80, tips: 20, hours: 3, jobs: 8, miles: 20 }); // 100 miss
    return s.campaignStats('2026-10-01');
  });
  ok(c.totalDays === 111 && c.totalGoal === 38850, 'campaign = 111 days / $38,850');
  ok(c.daysElapsed === 20, 'days elapsed = 20 (9/12→10/1)');
  ok(c.daysRemaining === 92, 'days remaining = 92 (10/1→12/31)');
  ok(Math.abs(c.earnedToDate - 850) < 0.01, 'earned to date = $850');
  ok(c.goalToDate === 7000, 'goal to date = 20×350 = $7,000');
  ok(Math.abs(c.ahead + 6150) < 0.01, 'behind by $6,150');
  ok(Math.abs(c.remainingGoal - 38000) < 0.01, 'remaining goal = $38,000');
  ok(c.behindPace === true && Math.abs(c.requiredPace - 38000 / 92) < 0.01, 'required pace ≈ $413/day (behind)');
  ok(c.todayHit === true && Math.abs(c.todayTotal - 400) < 0.01, 'today HIT at $400');
  ok(c.streak === 2, 'streak = 2 (10/1 + 9/30, broken by 9/29 miss)');

  console.log('\n15b) MPG auto fuel-cost logic (store)');
  const fuel = await page.evaluate(async () => {
    const s = await import('./js/store.js');
    s.clearAll();
    // default settings: mpg 25, fuelPrice $3.50
    const perShiftMpg = s.fuelCostFor({ miles: 30, mpg: 25 });      // 30/25 × 3.50 = 4.20
    const defaultMpg = s.fuelCostFor({ miles: 50 });                // 50/25 × 3.50 = 7.00
    const noMiles = s.fuelCostFor({ miles: 0, mpg: 25 });           // 0
    s.updateSettings({ fuelPrice: 4.00, mpg: 20 });
    const afterSettings = s.fuelCostFor({ miles: 40 });             // 40/20 × 4.00 = 8.00
    s.updateSettings({ fuelPrice: 3.50, mpg: 25 });                 // restore
    // updateShift should recompute the single linked fuel expense
    const shift = s.addShift({ platform: 'flex', date: '2026-10-01', gross: 100, hours: 2, miles: 30, mpg: 25 });
    const fuel1 = s.getExpenses().filter((e) => e.category === 'Fuel' && e.linkedShiftId === shift.id);
    s.updateShift(shift.id, { miles: 60 });
    const fuel2 = s.getExpenses().filter((e) => e.category === 'Fuel' && e.linkedShiftId === shift.id);
    return { perShiftMpg, defaultMpg, noMiles, afterSettings,
      f1: fuel1.length, f1amt: fuel1[0] ? fuel1[0].amount : null,
      f2: fuel2.length, f2amt: fuel2[0] ? fuel2[0].amount : null };
  });
  ok(Math.abs(fuel.perShiftMpg - 4.20) < 0.001, 'per-shift MPG: 30/25 × $3.50 = $4.20');
  ok(Math.abs(fuel.defaultMpg - 7.00) < 0.001, 'default MPG: 50/25 × $3.50 = $7.00');
  ok(fuel.noMiles === 0, 'no miles → $0 fuel');
  ok(Math.abs(fuel.afterSettings - 8.00) < 0.001, 'editable price/MPG: 40/20 × $4.00 = $8.00');
  ok(fuel.f1 === 1 && Math.abs(fuel.f1amt - 4.20) < 0.001, 'addShift auto-created one $4.20 fuel expense');
  ok(fuel.f2 === 1 && Math.abs(fuel.f2amt - 8.40) < 0.001, 'updateShift recomputed to one $8.40 fuel expense (60/25 × $3.50)');

  console.log('\n15c) Weekly goal $2,450 → days off (store)');
  const wk = await page.evaluate(async () => {
    const s = await import('./js/store.js');
    // 2026-10-07 is a Wednesday; week (Mon-start) = Oct 5–11, day 3 of 7.
    s.clearAll();
    s.addIncome({ date: '2026-10-05', source: 'X', amount: 2500 });
    const met = s.weeklyGoalStats('2026-10-07');
    s.clearAll();
    s.addIncome({ date: '2026-10-05', source: 'X', amount: 1000 });
    const notMet = s.weeklyGoalStats('2026-10-07');
    s.clearAll();
    return { met, notMet };
  });
  ok(wk.met.weekly === 2450, 'weekly goal = $2,450');
  ok(wk.met.weekStart === '2026-10-05' && wk.met.weekEnd === '2026-10-11', 'week span Mon 10/5 → Sun 10/11');
  ok(wk.met.daysElapsed === 3 && wk.met.daysLeft === 4, 'Wed = day 3, 4 days left');
  ok(wk.met.met === true && wk.met.daysOff === 4, 'goal met early → 4 days off earned');
  ok(wk.notMet.met === false && wk.notMet.daysOff === 0, 'goal not met → 0 days off');
  ok(Math.abs(wk.notMet.remaining - 1450) < 0.01, 'remaining = $1,450 (2450 - 1000)');
  ok(Math.abs(wk.notMet.perDayNeeded - 290) < 0.01, 'per-day needed = $290 (1450 / 5 days incl today)');

  console.log('\n16) Income entry + campaign ledger (UI)');
  await page.evaluate(async () => { (await import('./js/store.js')).clearAll(); });
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('.tab[data-view=log]').click();
  await page.locator('#log-segmented .seg[data-log=income]').click();
  await page.waitForTimeout(100);
  ok((await page.locator('#income-form:not(.hidden)').count()) === 1, 'Income segment shows income form');
  const today = await page.evaluate(async () => (await import('./js/store.js')).todayISO());
  await page.fill('#income-form [name=date]', today);
  await page.fill('#income-form [name=amount]', '500');
  await page.fill('#income-form [name=source]', 'TraceHaus');
  await page.locator('#income-submit').click();
  await page.waitForTimeout(120);
  ok(/TraceHaus/.test(await page.locator('#log-list').innerText()) && /\$500/.test(await page.locator('#log-list').innerText()), 'manual income saved + listed');
  await page.evaluate(async () => { const s = await import('./js/store.js'); s.addShift({ platform: 'flex', date: s.todayISO(), gross: 100, tips: 20, hours: 3, jobs: 8, miles: 20 }); });
  await page.locator('.tab[data-view=campaign]').click();
  await page.waitForTimeout(150);
  ok((await page.locator('#view-campaign.active').count()) === 1, 'campaign view active');
  ok(/CAMPAIGN 350/.test(await page.locator('#camp-hero').innerText()), 'hero renders');
  ok(await page.evaluate(() => { const h = document.querySelector('#camp-hero'); return h.offsetHeight >= h.scrollHeight - 2; }), 'hero card not clipped (no class collision)');
  ok(/WEEKLY GOAL/.test(await page.locator('#week-goal').innerText()) && /2,450/.test(await page.locator('#week-goal').innerText()), 'weekly goal card renders with $2,450 target');
  ok((await page.locator('#camp-kpis .kpi').count()) === 6, 'six campaign stat tiles');
  ok((await page.locator('#camp-chart svg .bar').count()) >= 1, '14-day chart drew bars');
  ok((await page.locator('#camp-chart svg .refline').count()) === 1, '$350 reference line drawn');
  ok(/TraceHaus/.test(await page.locator('#camp-ledger').innerText()), 'ledger shows manual income');
  ok((await page.locator('#camp-ledger [data-del="income"]').count()) === 1, 'manual income deletable in ledger');
  ok((await page.locator('#camp-ledger [data-del="shift"]').count()) === 0, 'gig shift NOT deletable in ledger');
  await page.evaluate(() => { window.confirm = () => true; });
  await page.locator('#camp-ledger [data-del="income"]').click();
  await page.waitForTimeout(120);
  const after = await page.evaluate(async () => { const s = await import('./js/store.js'); return { inc: s.getIncomes().length, shifts: s.getShifts().length }; });
  ok(after.inc === 0 && after.shifts === 1, 'deleting ledger income removed income, kept the gig shift');

  console.log('\n17) Cloud sync — store hooks + UI (no network)');
  const syncStore = await page.evaluate(async () => {
    const s = await import('./js/store.js');
    s.clearAll();
    s.addShift({ platform: 'flex', date: '2026-09-14', gross: 100, tips: 20, hours: 3 });
    const rev1 = s.getRev();
    s.applyRemote({ rev: 999, shifts: [{ id: 'r1', platform: 'doordash', date: '2026-09-13', gross: 50, tips: 10, hours: 2 }], expenses: [], trips: [], incomes: [], settings: {} });
    const afterApply = { rev: s.getRev(), ids: s.getShifts().map((x) => x.id) };
    s.mergeRemote({ shifts: [{ id: 'r2', platform: 'flex', date: '2026-09-12', gross: 80, tips: 0, hours: 2 }], expenses: [], trips: [], incomes: [], settings: {} });
    return { rev1, afterApply, afterMerge: s.getShifts().map((x) => x.id).sort() };
  });
  ok(syncStore.rev1 > 0, 'getRev bumps on a local change');
  ok(syncStore.afterApply.rev === 999, 'applyRemote keeps the remote rev (last-write-wins)');
  ok(syncStore.afterApply.ids.length === 1 && syncStore.afterApply.ids[0] === 'r1', 'applyRemote replaced local data');
  ok(syncStore.afterMerge.length === 2 && syncStore.afterMerge.includes('r1') && syncStore.afterMerge.includes('r2'), 'mergeRemote unions both sides by id');

  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('.tab[data-view=settings]').click();
  await page.waitForTimeout(100);
  ok((await page.locator('#sync-card').count()) === 1, 'Cloud sync card present in Settings');
  ok((await page.locator('#sync-pill').innerText()).trim() === 'Off', 'sync pill shows Off when unconfigured');
  ok((await page.locator('#sync-config-field:not(.hidden)').count()) === 1, 'config field shown when unconfigured');
  ok((await page.locator('#sync-auth.hidden').count()) === 1, 'sign-in hidden until configured');
  await page.fill('#sync-config', 'not a config');
  await page.locator('#sync-save-config').click();
  await page.waitForTimeout(100);
  ok((await page.locator('#sync-error:not(.hidden)').count()) === 1, 'invalid config shows an error (no network)');

  console.log('\n18) "Worth it?" offer calculator + tax summary');
  const ov = await page.evaluate(async () => {
    const s = await import('./js/store.js');
    const set = { minPerMile: 1.5, minPerHour: 20 };
    return {
      take: s.offerVerdict(20, 8, 25, set),
      skip: s.offerVerdict(4, 8, 25, set),
      marginal: s.offerVerdict(14, 8, 60, set),
      noMin: s.offerVerdict(20, 8, 0, set),
      invalid: s.offerVerdict(0, 8, 25, set),
    };
  });
  ok(ov.take.verdict === 'take' && Math.abs(ov.take.perMile - 2.5) < 0.01, 'offer $20/8mi/25min → TAKE (2.5/mi, 48/hr)');
  ok(ov.skip.verdict === 'skip', 'offer $4/8mi → SKIP');
  ok(ov.marginal.verdict === 'marginal', 'offer $14/8mi/60min → MARGINAL (mile ok, hour low)');
  ok(ov.noMin.verdict === 'take' && ov.noMin.hourOK === null, 'no minutes → judged on $/mi only');
  ok(ov.invalid.valid === false, 'no pay → invalid');

  const tx = await page.evaluate(async () => {
    const s = await import('./js/store.js');
    s.clearAll();
    s.updateSettings({ mileageRate: 0.70, taxRate: 0.25 });
    s.addShift({ platform: 'flex', date: '2026-03-01', gross: 1000, tips: 200, hours: 40, miles: 500, jobs: 100 });
    s.addExpense({ date: '2026-04-01', category: 'Phone', amount: 100 });
    s.addIncome({ date: '2026-05-01', source: 'TraceHaus', amount: 3000 });
    s.addShift({ platform: 'flex', date: '2025-12-31', gross: 999, tips: 0, hours: 1, miles: 1 }); // other year — ignored
    return s.taxSummary('2026');
  });
  ok(Math.abs(tx.totalIncome - 4200) < 0.01, 'tax: total income = gig 1200 + manual 3000 = 4200');
  ok(Math.abs(tx.mileageDeduction - 350) < 0.01, 'tax: standard mileage = 500×0.70 = 350');
  ok(Math.abs(tx.deduction - 350) < 0.01, 'tax: deduction applied = larger(exp 100, mileage 350)');
  ok(Math.abs(tx.taxable - 3850) < 0.01, 'tax: taxable = 4200 − 350 = 3850');
  ok(Math.abs(tx.estTax - 962.5) < 0.01, 'tax: estimated tax = 3850×25% = 962.50');
  ok(Math.abs(tx.quarterly - 240.625) < 0.01, 'tax: quarterly set-aside = 240.63');
  ok(tx.byCat.Phone === 100, 'tax: expenses grouped by category');

  await page.reload({ waitUntil: 'networkidle' });
  await page.evaluate(async () => { const s = await import('./js/store.js'); s.clearAll(); s.addShift({ platform: 'flex', date: '2026-06-01', gross: 400, tips: 50, hours: 20, miles: 200, jobs: 40 }); s.addIncome({ date: '2026-06-02', source: 'TraceHaus', amount: 1000 }); });
  await page.reload({ waitUntil: 'networkidle' });
  await page.fill('#offer-pay', '20'); await page.fill('#offer-miles', '8');
  ok((await page.locator('#offer-verdict .ov-banner.take').count()) === 1, 'dashboard offer calc shows TAKE');
  await page.fill('#offer-pay', '4');
  ok((await page.locator('#offer-verdict .ov-banner.skip').count()) === 1, 'offer calc flips to SKIP live');
  await page.locator('.tab[data-view=trends]').click();
  await page.waitForTimeout(150);
  ok((await page.locator('#tax-summary-card').count()) === 1, 'tax summary card present in Trends');
  ok((await page.locator('#tax-summary-body .tax-row').count()) >= 5, 'tax summary rows rendered');
  ok(/Total income/.test(await page.locator('#tax-summary-body').innerText()), 'tax summary shows Total income');

  ok(errors.length === 0, 'no console/page errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
} catch (e) {
  console.error('TEST CRASH:', e);
  fails.push('crash: ' + e.message);
} finally {
  await browser.close();
  server.close();
}

console.log('\n' + (fails.length ? `FAILED (${fails.length}):\n- ` + fails.join('\n- ') : 'ALL PASSED ✓'));
process.exit(fails.length ? 1 : 0);
