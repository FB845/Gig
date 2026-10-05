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
// Never touch the real Firebase project from tests: the SDK "fails to load"
// (as when offline), which the app handles. scripts/sync-test.mjs covers sync.
const newCtx = async (viewport) => {
  const c = await browser.newContext({ viewport });
  await c.route(/^https:\/\/www\.gstatic\.com\/firebasejs\//, (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: 'throw new Error("no Firebase in smoke test")' }));
  return c;
};
const page = await newCtx({ width: 390, height: 800 }).then((c) => c.newPage());
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

try {
  console.log('\n1) Load app');
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForTimeout(300);
  ok(await page.title() === 'Gig Tracker' && await page.locator('#screen-title').getAttribute('aria-label') === 'GIG LINE · HOME', 'app title + per-screen LED header render');
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
  ok(/fuel/i.test(expText) && /\$4\.20/.test(expText), 'auto Fuel expense of $4.20 exists');

  console.log('\n4) Dashboard KPIs reflect the data');
  await page.locator('.tab[data-view=dashboard]').click();
  await page.locator('#period-pills .pill[data-period=all]').click();
  await page.waitForTimeout(700); // let the LED count-up settle
  const kpi = await page.locator('#kpi-grid').innerText();
  ok(/\$56\b/.test(kpi), 'net income = $56 (60 income - $4.20 fuel, rounded)');
  ok(/\$4\b/.test(kpi), 'expenses out = $4 ($4.20 auto fuel, rounded)');
  ok(/\$15\.00/.test(kpi), '$/hour = $15.00');
  ok((await page.locator('#chart-earnings svg .bar').count()) >= 1, 'earnings chart drew bars');
  ok((await page.locator('#chart-platform > span').count()) >= 1, 'platform split bar drew segments');

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
  ok((await page.locator('#hours-label').innerText()) .startsWith('Hours worked'), 'hours label reverts to "Hours worked" for DoorDash');

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
  ok((await page.locator('#flex-tag-list .tag-row .exp-track .led').count()) >= 1, 'block-type $/hr LED bars drawn');
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
  ok(wk.met.baseGoal === 2450 && wk.met.goal === 2450 && wk.met.carryIn === 0, 'weekly goal = $2,450 (no carry-in)');
  ok(wk.met.start === '2026-10-05' && wk.met.end === '2026-10-11', 'week span Mon 10/5 → Sun 10/11');
  ok(wk.met.daysElapsed === 3 && wk.met.daysLeft === 4, 'Wed = day 3, 4 days left');
  ok(wk.met.met === true && wk.met.daysOff === 4, 'goal met early → 4 days off earned');
  ok(wk.notMet.met === false && wk.notMet.daysOff === 0, 'goal not met → 0 days off');
  ok(Math.abs(wk.notMet.remaining - 1450) < 0.01, 'remaining = $1,450 (2450 - 1000)');
  ok(Math.abs(wk.notMet.perDayNeeded - 290) < 0.01, 'per-day needed = $290 (1450 / 5 days incl today)');

  console.log('\n15d) Day-off income rolls over; monthly goal');
  const ro = await page.evaluate(async () => {
    const s = await import('./js/store.js');
    s.clearAll();
    // Week of Oct 5: goal met Monday, then $400 logged Wednesday (an earned day off).
    s.addIncome({ date: '2026-10-05', source: 'X', amount: 2450 });
    s.addIncome({ date: '2026-10-07', source: 'X', amount: 400 });
    const wThis = s.weeklyGoalStats('2026-10-07');
    const wNext = s.weeklyGoalStats('2026-10-13');
    // Overshoot on the day the goal is met is NOT day-off income.
    s.clearAll();
    s.addIncome({ date: '2026-10-05', source: 'X', amount: 2800 });
    const wOvershootNext = s.weeklyGoalStats('2026-10-13');
    // Carry bigger than a whole week → next week's goal is $0, excess keeps rolling.
    s.clearAll();
    s.addIncome({ date: '2026-10-05', source: 'X', amount: 2450 });
    s.addIncome({ date: '2026-10-06', source: 'X', amount: 3000 });
    const wBig = s.weeklyGoalStats('2026-10-13');
    // Month: September is 9/12–9/30 = 19 days = $6,650. Met 9/12, $300 on 9/15 (day off).
    s.clearAll();
    s.addIncome({ date: '2026-09-12', source: 'X', amount: 6650 });
    s.addIncome({ date: '2026-09-15', source: 'X', amount: 300 });
    const mSep = s.monthlyGoalStats('2026-09-20');
    const mOct = s.monthlyGoalStats('2026-10-02');
    s.clearAll();
    const mNov = s.monthlyGoalStats('2026-11-10');
    const mDec = s.monthlyGoalStats('2026-12-31');
    return { wThis, wNext, wOvershootNext, wBig, mSep, mOct, mNov, mDec };
  });
  ok(ro.wThis.met && ro.wThis.metOn === '2026-10-05', 'week met on Mon 10/5');
  ok(ro.wThis.todayOff === true && Math.abs(ro.wThis.banked - 400) < 0.01, 'Wed is an earned day off; $400 banked');
  ok(ro.wNext.carryIn === 400 && ro.wNext.goal === 2050 && ro.wNext.baseGoal === 2450, 'next week: $400 rolled over → goal $2,050');
  ok(ro.wOvershootNext.carryIn === 0, 'overshoot on the goal day does not roll over');
  ok(ro.wBig.goal === 0 && ro.wBig.met === true && ro.wBig.todayOff === true, 'carry ≥ a week → next week fully off');
  ok(ro.mSep.baseGoal === 6650 && ro.mSep.start === '2026-09-12', 'Sept monthly goal = 19 days × $350 = $6,650');
  ok(ro.mSep.met && ro.mSep.daysOff === 10 && Math.abs(ro.mSep.banked - 300) < 0.01, 'Sept met early: 10 days off left, $300 banked');
  ok(ro.mOct.baseGoal === 10850 && ro.mOct.carryIn === 300 && ro.mOct.goal === 10550, 'Oct goal $10,850 − $300 rolled over = $10,550');
  ok(ro.mNov.baseGoal === 10500 && ro.mDec.baseGoal === 10850, 'Nov $10,500 / Dec $10,850');
  ok(6650 + ro.mOct.baseGoal + ro.mNov.baseGoal + ro.mDec.baseGoal === 38850, 'monthly goals sum to the $38,850 campaign');
  ok(ro.mDec.daysLeft === 0, 'Dec 31 = last day of the month');

  console.log('\n16) Income entry + campaign ledger (UI)');
  await page.evaluate(async () => { (await import('./js/store.js')).clearAll(); });
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('.tab[data-view=log]').click();
  ok((await page.locator('#log-segmented .seg[data-log=income]').count()) === 0, 'no separate Income segment any more');
  await page.locator('#shift-platform .chip[data-val=income]').click();
  await page.waitForTimeout(100);
  ok(await page.locator('#shift-form [name=source]').isVisible() && !(await page.locator('#shift-form [name=gross]').isVisible()), 'Income platform swaps in source/amount, hides gig fields');
  ok(!(await page.locator('#time-field').isVisible()), 'flat-rate income hides the time input');
  ok(/Log income/i.test(await page.locator('#shift-form-title').innerText()), 'form title becomes "Log income"');
  const today = await page.evaluate(async () => (await import('./js/store.js')).todayISO());
  await page.fill('#shift-form [name=date]', today);
  await page.fill('#shift-form [name=amount]', '500');
  await page.fill('#shift-form [name=source]', 'TraceHaus');
  await page.locator('#shift-submit').click();
  await page.waitForTimeout(120);
  ok(/TraceHaus/.test(await page.locator('#log-list').innerText()) && /\$500/.test(await page.locator('#log-list').innerText()), 'manual income saved + listed');
  ok(await page.evaluate(async () => { const s = await import('./js/store.js'); return s.getIncomes().length === 1 && s.getShifts().length === 0; }), 'saved to income, not as a gig shift');
  await page.evaluate(async () => { const s = await import('./js/store.js'); s.addShift({ platform: 'flex', date: s.todayISO(), gross: 100, tips: 20, hours: 3, jobs: 8, miles: 20 }); });
  await page.locator('.tab[data-view=campaign]').click();
  await page.waitForTimeout(150);
  ok((await page.locator('#view-campaign.active').count()) === 1, 'campaign view active');
  ok(/CAMPAIGN 350/.test(await page.locator('#camp-hero').innerText()), 'hero renders');
  ok(await page.evaluate(() => { const h = document.querySelector('#camp-hero'); return h.offsetHeight >= h.scrollHeight - 2; }), 'hero card not clipped (no class collision)');
  ok(/WEEKLY GOAL/.test(await page.locator('#week-goal').innerText()) && /2,450/.test(await page.locator('#week-goal').innerText()), 'weekly goal card renders with $2,450 target');
  ok(/MONTHLY GOAL/.test(await page.locator('#month-goal').innerText()), 'monthly goal card renders');
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
    const local = s.getShifts()[0];
    const rev1 = s.getRev();
    const origins = [];
    const off = s.onChange((_db, o) => origins.push(o));
    s.applyRecords([
      { col: 'shifts', id: 'r1', data: { platform: 'doordash', date: '2026-09-13', gross: 50, tips: 10, hours: 2 } },
      { col: 'shifts', id: local.id, data: { ...local, gross: 120 } },
      { col: 'plans', id: 'p1', data: { date: '2026-09-15', platform: 'flex', estimate: 80 } },
      { col: 'settings', id: 'main', data: { fuelPrice: 3.99 } },
    ]);
    const mid = { ids: s.getShifts().map((x) => x.id).sort(), gross: s.getShifts().find((x) => x.id === local.id).gross, plans: s.getPlans().length, fuel: s.getSettings().fuelPrice, mpg: s.getSettings().mpg, rev: s.getRev() };
    s.applyRecords([{ col: 'plans', id: 'p1', data: null }, { col: 'bogus', id: 'x', data: { a: 1 } }]);
    off();
    return { rev1, mid, uuid: /^[0-9a-f-]{36}$/.test(local.id), plansAfterDelete: s.getPlans().length, origins };
  });
  ok(syncStore.rev1 > 0, 'getRev bumps on a local change');
  ok(syncStore.uuid, 'record ids are UUIDs (unique across devices)');
  ok(syncStore.mid.ids.length === 2 && syncStore.mid.gross === 120 && syncStore.mid.plans === 1, 'applyRecords upserts per record (new shift + edited shift + plan)');
  ok(syncStore.mid.fuel === 3.99 && syncStore.mid.mpg === 25, 'applyRecords settings: synced value applied, missing ones defaulted');
  ok(syncStore.mid.rev === syncStore.rev1, 'remote records don\'t bump the local rev');
  ok(syncStore.plansAfterDelete === 0, 'applyRecords null data = deleted elsewhere; unknown collections ignored');
  ok(syncStore.origins.every((o) => o === 'remote'), 'remote applies notify with origin "remote" (never re-pushed)');

  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('.tab[data-view=settings]').click();
  await page.waitForTimeout(100);
  ok((await page.locator('#sync-card').count()) === 1, 'Cloud sync card present in Settings');
  // The app ships with its Firebase config built in: no paste box, just sign-in.
  ok((await page.locator('#sync-config-field.hidden').count()) === 1, 'built-in config: no paste-config box');
  ok((await page.locator('#sync-auth:not(.hidden) #sync-google').count()) === 1, 'built-in config: "Sign in with Google" shown straight away');
  ok((await page.locator('#sync-email-box.hidden').count()) === 1, 'email sign-in tucked away until asked for');
  await page.locator('#sync-email-toggle').click();
  ok((await page.locator('#sync-email-box:not(.hidden) #sync-email').count()) === 1, '"Use email instead" reveals email + password');
  ok((await page.locator('#sync-account.hidden').count()) === 1, 'account panel hidden while signed out');

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

  console.log('\n18b) summarize folds manual income into totals, rates stay gig-only');
  const sum = await page.evaluate(async () => {
    const s = await import('./js/store.js');
    const shifts = [{ platform: 'flex', date: '2026-06-01', gross: 200, tips: 0, hours: 10, miles: 50, jobs: 20 }];
    const expenses = [{ date: '2026-06-01', category: 'Fuel', amount: 20 }];
    const incomes = [{ date: '2026-06-01', source: 'TraceHaus', amount: 300 }];
    const settings = { mileageRate: 0.70, taxRate: 0.25 };
    const gigOnly = s.summarize(shifts, expenses, settings);          // no incomes
    const combined = s.summarize(shifts, expenses, settings, incomes); // with manual income
    return { gigOnly, combined };
  });
  ok(sum.combined.gigIncome === 200 && sum.combined.manualIncome === 300 && sum.combined.totalIncome === 500,
    'combined: gig 200 + manual 300 = total 500');
  ok(Math.abs(sum.combined.net - 480) < 0.01, 'combined net = 500 total − 20 expense = 480');
  ok(Math.abs(sum.gigOnly.net - 180) < 0.01, 'gig-only net (no incomes) = 200 − 20 = 180 (back-compat)');
  ok(Math.abs(sum.combined.perHour - 20) < 0.01, '$/hr stays gig-only: 200/10 = $20 (manual excluded)');
  ok(Math.abs(sum.combined.perMile - 4) < 0.01, '$/mi stays gig-only: 200/50 = $4');
  ok(Math.abs(sum.combined.perJob - 10) < 0.01, 'per-delivery stays gig-only: 200/20 = $10');
  // taxable uses total income: max(0, 500 − max(20 exp, 50×0.70=35 mileage)) = 465
  ok(Math.abs(sum.combined.taxableEstimate - 465) < 0.01, 'taxable uses total income = 500 − 35 = 465');

  console.log('\n18c) Dashboard net income combines gig + manual (UI)');
  await page.reload({ waitUntil: 'networkidle' });
  await page.evaluate(async () => {
    const s = await import('./js/store.js');
    s.clearAll();
    s.addShift({ platform: 'doordash', date: s.todayISO(), gross: 100, tips: 0, hours: 5, miles: 25, jobs: 10, mpg: 0 });
    s.addIncome({ date: s.todayISO(), source: 'TraceHaus', amount: 250 });
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('#period-pills .pill[data-period=all]').click();
  await page.waitForTimeout(700);
  const dash = await page.locator('#kpi-grid').innerText();
  ok(/\$350\b/.test(dash), 'net income shows $350 (100 gig + 250 manual)');
  ok(/250 other/.test(dash) || /\$250/.test(dash), 'net sub shows the manual-income split');
  ok(/\$20\.00/.test(dash), '$/hour = $20.00 (100/5, gig-only — manual not folded in)');
  ok((await page.locator('#earn-legend').innerText()).includes('Income'), 'earnings chart legend gains an "Income" segment');

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

  console.log('\n19) Time input: Duration ⇄ Start – Finish toggle');
  const hb = await page.evaluate(async () => {
    const s = await import('./js/store.js');
    return { day: s.hoursBetween('09:00', '12:20'), night: s.hoursBetween('22:00', '01:30'), bad: s.hoursBetween('9am', '12:00'), same: s.hoursBetween('09:00', '09:00') };
  });
  ok(hb.same === 0, 'identical start/finish → 0 (not a 24 h shift)');
  ok(Math.abs(hb.day - 10 / 3) < 1e-9, 'hoursBetween 09:00 → 12:20 = 3h20m');
  ok(Math.abs(hb.night - 3.5) < 1e-9, 'hoursBetween 22:00 → 01:30 = 3.5 h (overnight)');
  ok(hb.bad === 0, 'invalid time → 0');

  await page.evaluate(async () => { (await import('./js/store.js')).clearAll(); localStorage.removeItem('gigtracker.timeMode'); });
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('.tab[data-view=log]').click();
  ok(await page.locator('#time-duration').isVisible() && !(await page.locator('#time-range').isVisible()), 'defaults to Duration mode');
  await page.locator('#time-mode button[data-mode=range]').click();
  ok(await page.locator('#time-range').isVisible() && !(await page.locator('#time-duration').isVisible()), 'toggle shows start/finish inputs');
  ok(await page.evaluate(() => localStorage.getItem('gigtracker.timeMode')) === 'range', 'mode remembered on this device');

  // Flex block preset fills the finish time from the start time.
  await page.fill('#shift-form [name=startTime]', '09:00');
  await page.locator('#shift-blockpreset .chip[data-val="3"]').click();
  ok(await page.inputValue('#shift-form [name=endTime]') === '12:00', '3:00 block preset → finish 12:00');
  await page.fill('#shift-form [name=endTime]', '12:20');
  await page.fill('#shift-form [name=gross]', '100');
  ok(/3h 20m/.test(await page.locator('#time-range-dur').innerText()), 'live duration shows 3h 20m');
  ok(/111/.test(await page.locator('#shift-live').innerText()) && /Block time/.test(await page.locator('#shift-live').innerText()), 'live block time = 111% (3h20 of 3h)');

  // Only one of the two times → blocked.
  await page.fill('#shift-form [name=endTime]', '');
  await page.locator('#shift-submit').click();
  await page.waitForTimeout(100);
  ok(await page.evaluate(async () => (await import('./js/store.js')).getShifts().length) === 0, 'start without finish is not saved');
  await page.fill('#shift-form [name=endTime]', '09:00');
  await page.locator('#shift-submit').click();
  await page.waitForTimeout(100);
  ok(await page.evaluate(async () => (await import('./js/store.js')).getShifts().length) === 0, 'finish == start is not saved');

  await page.fill('#shift-form [name=endTime]', '12:20');
  await page.locator('#shift-submit').click();
  await page.waitForTimeout(150);
  const saved = await page.evaluate(async () => (await import('./js/store.js')).getShifts()[0]);
  ok(saved && Math.abs(saved.hours - 10 / 3) < 1e-6 && saved.startTime === '09:00' && saved.endTime === '12:20', 'saved hours 3.333 + start/finish times');
  ok(await page.locator('#time-range').isVisible() && await page.inputValue('#shift-form [name=startTime]') === '', 'form resets, stays in remembered mode');

  // Overnight shift.
  await page.fill('#shift-form [name=startTime]', '22:00');
  await page.fill('#shift-form [name=endTime]', '01:30');
  ok(/3h 30m/.test(await page.locator('#time-range-dur').innerText()) && /overnight/.test(await page.locator('#time-range-dur').innerText()), 'overnight 22:00 → 01:30 = 3h 30m, flagged');
  await page.locator('#shift-reset').click();

  // Editing a start–finish shift reopens in that mode; toggling copies the length over.
  await page.locator('#time-mode button[data-mode=duration]').click(); // device preference → duration
  await page.locator('#log-list .record[data-type=shift]').first().click();
  await page.waitForTimeout(150);
  ok(await page.locator('#time-range').isVisible() && await page.inputValue('#shift-form [name=startTime]') === '09:00', 'edit reopens a start–finish shift in that mode');
  await page.locator('#time-mode button[data-mode=duration]').click();
  ok(await page.inputValue('#shift-form [name=hoursH]') === '3' && await page.inputValue('#shift-form [name=hoursM]') === '20', 'switching to Duration carries 3h 20m over');
  await page.locator('#shift-submit').click();
  await page.waitForTimeout(150);
  const dur = await page.evaluate(async () => (await import('./js/store.js')).getShifts()[0]);
  ok(Math.abs(dur.hours - 10 / 3) < 1e-6 && dur.startTime === '' && dur.endTime === '', 'saving in Duration mode keeps hours, clears clock times');

  console.log('\n20) Income under Platform: flat vs paid by hour, combined list, convert');
  const ni = await page.evaluate(async () => {
    const s = await import('./js/store.js');
    s.clearAll();
    const h = s.addIncome({ date: '2026-10-01', source: 'TraceHaus', payType: 'hourly', rate: 45, hours: 10 / 3, startTime: '13:00', endTime: '16:20' });
    const toFlat = s.updateIncome(h.id, { payType: 'flat', amount: 300 });
    const legacy = s.addIncome({ date: '2026-10-02', source: 'Old', amount: 200 });
    const flatTimes = s.addIncome({ date: '2026-10-03', source: 'X', amount: 50, startTime: '09:00', endTime: '10:00' });
    s.clearAll();
    return { h, toFlat, legacy, flatTimes };
  });
  ok(ni.h.payType === 'hourly' && ni.h.amount === 150, 'hourly income: $45/hr × 3h20m = $150.00 (derived)');
  ok(ni.toFlat.payType === 'flat' && ni.toFlat.amount === 300 && ni.toFlat.rate === 0 && ni.toFlat.hours === 0 && ni.toFlat.startTime === '', 'switching to flat clears rate/hours/times');
  ok(ni.legacy.payType === 'flat' && ni.legacy.amount === 200, 'older income records read as flat (back-compat)');
  ok(ni.flatTimes.startTime === '' && ni.flatTimes.endTime === '', 'flat income keeps no clock times');

  await page.evaluate(async () => {
    const s = await import('./js/store.js');
    localStorage.removeItem('gigtracker.payType'); localStorage.removeItem('gigtracker.timeMode');
    const y = new Date(); y.setDate(y.getDate() - 1);
    s.addShift({ platform: 'doordash', date: s.isoDate(y), gross: 60, tips: 10, hours: 3 });
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('.tab[data-view=log]').click();
  await page.locator('#shift-platform .chip[data-val=income]').click();
  await page.locator('#pay-type button[data-pay=hourly]').click();
  ok(await page.locator('#time-field').isVisible() && await page.locator('#shift-form [name=rate]').isVisible() && !(await page.locator('#shift-form [name=amount]').isVisible()), 'Paid by hour shows rate + time input');
  ok(await page.evaluate(() => localStorage.getItem('gigtracker.payType')) === 'hourly', 'pay type remembered on this device');
  await page.fill('#shift-form [name=source]', 'TraceHaus');
  await page.fill('#shift-form [name=rate]', '45');
  await page.locator('#shift-submit').click(); // no time yet → blocked
  await page.waitForTimeout(100);
  ok(await page.evaluate(async () => (await import('./js/store.js')).getIncomes().length) === 0, 'hourly income without time is not saved');
  await page.locator('#time-mode button[data-mode=range]').click();
  await page.fill('#shift-form [name=startTime]', '13:00');
  await page.fill('#shift-form [name=endTime]', '16:20');
  ok(/\$150\.00/.test(await page.locator('#shift-live').innerText()), 'live income = $150.00 (3h20m × $45)');
  await page.locator('#shift-submit').click();
  await page.waitForTimeout(150);
  const hi = await page.evaluate(async () => (await import('./js/store.js')).getIncomes()[0]);
  ok(hi && hi.payType === 'hourly' && hi.amount === 150 && hi.startTime === '13:00' && hi.endTime === '16:20', 'saved hourly income with start/finish');
  const firstRow = page.locator('#log-list .record').first();
  ok(await firstRow.getAttribute('data-type') === 'income' && /3h 20m × \$45\.00\/hr \(13:00–16:20\)/.test(await firstRow.innerText()), 'combined list: today\'s income first, shows rate × time');
  ok((await page.locator('#log-list .record[data-type=shift]').count()) === 1, 'combined list still has yesterday\'s shift');

  // Edit reopens on Income / Paid by hour / start–finish, then convert to a gig shift.
  await firstRow.click();
  await page.waitForTimeout(150);
  ok(await page.locator('#shift-platform .chip.active').getAttribute('data-val') === 'income'
    && await page.locator('#pay-type button.active').getAttribute('data-pay') === 'hourly'
    && await page.inputValue('#shift-form [name=rate]') === '45'
    && await page.inputValue('#shift-form [name=startTime]') === '13:00', 'editing income restores platform, pay type, rate and times');
  ok(/Edit income/i.test(await page.locator('#shift-form-title').innerText()), 'title reads "Edit income"');
  await page.locator('#shift-platform .chip[data-val=doordash]').click();
  await page.fill('#shift-form [name=gross]', '80');
  await page.locator('#shift-submit').click();
  await page.waitForTimeout(150);
  const conv = await page.evaluate(async () => { const s = await import('./js/store.js'); return { inc: s.getIncomes().length, shifts: s.getShifts().length }; });
  ok(conv.inc === 0 && conv.shifts === 2, 'switching an income entry to DoorDash converts it (no duplicate)');
  await page.locator('#log-list .record[data-type=shift]').first().click();
  await page.waitForTimeout(150);
  await page.locator('#shift-platform .chip[data-val=income]').click();
  await page.locator('#pay-type button[data-pay=flat]').click();
  await page.fill('#shift-form [name=source]', 'Consulting');
  await page.fill('#shift-form [name=amount]', '70');
  await page.locator('#shift-submit').click();
  await page.waitForTimeout(150);
  const conv2 = await page.evaluate(async () => { const s = await import('./js/store.js'); return { inc: s.getIncomes().length, shifts: s.getShifts().length }; });
  ok(conv2.inc === 1 && conv2.shifts === 1, 'switching a shift to Income converts it the other way');

  // Campaign "+ Income" opens the shared form on Income.
  await page.locator('.tab[data-view=campaign]').click();
  await page.locator('#camp-add-income').click();
  await page.waitForTimeout(150);
  ok(await page.locator('#view-log.active').count() === 1 && await page.locator('#shift-platform .chip.active').getAttribute('data-val') === 'income', 'Campaign "+ Income" opens the form with Income selected');

  console.log('\n21) Planner (store): plans, status, overlaps, suggestion, trajectory');
  const pl = await page.evaluate(async () => {
    const s = await import('./js/store.js');
    s.clearAll();
    const flex = s.addPlan({ date: '2026-10-07', platform: 'flex', startTime: '09:00', endTime: '12:30', tag: 'Express', estimate: 84, source: 'ignored' });
    const inc = s.addPlan({ date: '2026-10-07', platform: 'income', estimate: 300, source: 'TraceHaus', tag: 'Express' });
    const overlap = s.planOverlaps({ date: '2026-10-07', startTime: '12:00', endTime: '14:00' }).length;
    const adjacent = s.planOverlaps({ date: '2026-10-07', startTime: '12:30', endTime: '14:00' }).length;
    const otherDay = s.planOverlaps({ date: '2026-10-08', startTime: '10:00', endTime: '11:00' }).length;
    const statuses = { past: s.planStatus(flex, '2026-10-08'), today: s.planStatus(flex, '2026-10-07'), future: s.planStatus(flex, '2026-10-06') };
    const sh = s.addShift({ platform: 'flex', date: '2026-10-07', gross: 90, hours: 3.5 });
    s.markPlanLogged(flex.id, 'shift', sh.id);
    const loggedStatus = s.planStatus(s.getPlans().find((p) => p.id === flex.id), '2026-10-08');
    s.deleteShift(sh.id);
    const afterDelete = s.planStatus(s.getPlans().find((p) => p.id === flex.id), '2026-10-08');
    // suggested $/hr from history
    s.clearAll();
    s.addShift({ platform: 'doordash', date: '2026-10-01', gross: 100, hours: 4 });
    s.addShift({ platform: 'doordash', date: '2026-10-02', gross: 60, hours: 2 });
    s.addShift({ platform: 'flex', date: '2026-10-02', gross: 30, hours: 1 });
    const rateDD = s.suggestedRate('doordash', '2026-10-05');
    const rateOther = s.suggestedRate('other', '2026-10-05'); // no history → all platforms
    // weekly trajectory: week Oct 5–11, now Wed 10/7
    s.clearAll();
    s.addIncome({ date: '2026-10-05', source: 'X', amount: 1000 });
    s.addPlan({ date: '2026-10-06', platform: 'flex', startTime: '09:00', endTime: '12:00', estimate: 999 }); // missed → excluded
    s.addPlan({ date: '2026-10-07', platform: 'flex', startTime: '09:00', endTime: '12:00', estimate: 500 });
    s.addPlan({ date: '2026-10-08', platform: 'doordash', startTime: '17:00', endTime: '21:00', estimate: 600 });
    const p9 = s.addPlan({ date: '2026-10-09', platform: 'flex', startTime: '09:00', endTime: '13:00', estimate: 400 });
    const wk = s.weeklyGoalStats('2026-10-07');
    const traj = s.trajectory('2026-10-05', '2026-10-09', '2026-10-07');
    s.deletePlan(p9.id);
    const wkShort = s.weeklyGoalStats('2026-10-07');
    s.clearAll();
    return { flex, inc, overlap, adjacent, otherDay, statuses, loggedStatus, afterDelete, rateDD, rateOther, wk, traj, wkShort };
  });
  ok(pl.flex.hours === 3.5 && pl.flex.tag === 'Express' && pl.flex.source === '', 'flex plan: 3.5 h from 09:00–12:30, keeps tag, no source');
  ok(pl.inc.source === 'TraceHaus' && pl.inc.tag === '' && pl.inc.hours === 0, 'income plan: keeps source, no tag, times optional');
  ok(pl.overlap === 1 && pl.adjacent === 0 && pl.otherDay === 0, 'overlap: 12:00–14:00 clashes; back-to-back and other days don\'t');
  ok(pl.statuses.past === 'missed' && pl.statuses.today === 'today' && pl.statuses.future === 'upcoming', 'status: missed / today / upcoming');
  ok(pl.loggedStatus === 'logged' && pl.afterDelete === 'missed', 'logged while its shift exists; back to missed if the shift is deleted');
  ok(Math.abs(pl.rateDD - 160 / 6) < 0.01, 'suggested DoorDash rate = $160 / 6h = $26.67/hr');
  ok(Math.abs(pl.rateOther - 190 / 7) < 0.01, 'no history on a platform → falls back to all platforms');
  ok(pl.wk.planned === 1500 && pl.wk.projected === 2500, 'week: $1,000 earned + $1,500 planned (missed plan excluded) = $2,500');
  ok(pl.wk.projMet && pl.wk.projMetOn === '2026-10-09' && pl.wk.projDaysOff === 2, 'plan reaches $2,450 on Fri → Sat & Sun off');
  ok(pl.traj[1].planned === 0 && pl.traj[2].planned === 500 && pl.traj[0].actual === 1000, 'trajectory: actual by day, planned only from today on');
  ok(!pl.wkShort.projMet && pl.wkShort.shortfall === 350, 'drop a plan → $350 short, flagged');
  const plSync = await page.evaluate(async () => {
    const s = await import('./js/store.js');
    s.clearAll();
    s.addPlan({ date: '2026-10-10', platform: 'flex', startTime: '09:00', endTime: '11:00', estimate: 50 });
    s.applyRecords([{ col: 'plans', id: 'remote-plan', data: { date: '2026-10-11', platform: 'doordash', startTime: '17:00', endTime: '20:00', estimate: 70 } }]);
    const merged = s.getPlans().length;
    const backup = s.exportJSON();
    s.clearAll();
    s.importJSON(backup);
    const restored = s.getPlans().map((p) => p.estimate).sort().join(',');
    s.clearAll();
    return { merged, restored };
  });
  ok(plSync.merged === 2, 'plans synced from another device sit alongside local ones');
  ok(plSync.restored === '50,70', 'plans survive backup export → restore');

  console.log('\n22) Planner (UI): plan, suggest, overlap, trajectory, Log it');
  await page.evaluate(async () => {
    const s = await import('./js/store.js');
    s.clearAll();
    const d = new Date(); d.setDate(d.getDate() - 3);
    s.addShift({ platform: 'doordash', date: s.isoDate(d), gross: 100, tips: 0, hours: 4 }); // → $25/hr
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('.tab[data-view=log]').click();
  await page.locator('#log-segmented .seg[data-log=plan]').click();
  ok(await page.locator('#plan-form').isVisible() && !(await page.locator('#shift-form').isVisible()), 'Plan segment shows the plan form');
  ok(/Planner/i.test(await page.locator('#log-list-title').innerText()), 'list titled "Planner"');
  await page.locator('#plan-platform .chip[data-val=doordash]').click();
  ok(!(await page.locator('#plan-blockpreset').isVisible()), 'block length/type only for Flex');
  await page.fill('#plan-form [name=startTime]', '18:00');
  await page.fill('#plan-form [name=endTime]', '21:00');
  ok(/blank = \$75 at your \$25\.00\/hr avg/.test(await page.locator('#plan-est-hint').innerText()), 'estimate suggestion: 3h × $25/hr = $75');
  ok(/This week with this plan|reaches the/.test(await page.locator('#plan-check').innerText()), 'shows the week-goal impact');
  await page.locator('#plan-submit').click();
  await page.waitForTimeout(120);
  const p1 = await page.evaluate(async () => (await import('./js/store.js')).getPlans()[0]);
  ok(p1 && p1.estimate === 75 && p1.platform === 'doordash', 'blank estimate saved as the $75 suggestion');

  await page.locator('#plan-platform .chip[data-val=flex]').click();
  await page.locator('#plan-blockpreset .chip[data-val="3.5"]').click();
  await page.fill('#plan-form [name=startTime]', '17:30');
  ok(await page.inputValue('#plan-form [name=endTime]') === '21:00', '3:30 block from 17:30 → finish 21:00');
  ok(/Overlaps 18:00–21:00 Dasher/.test(await page.locator('#plan-check').innerText()), 'overlap with the DoorDash plan flagged');
  await page.fill('#plan-form [name=startTime]', '09:00');
  ok(await page.inputValue('#plan-form [name=endTime]') === '12:30' && !/Overlaps/.test(await page.locator('#plan-check').innerText()), 'moving the start moves the finish; no overlap');
  await page.locator('#plan-tag .chip[data-val=Express]').click();
  await page.fill('#plan-form [name=estimate]', '84');
  await page.locator('#plan-submit').click();
  await page.waitForTimeout(120);
  ok(await page.evaluate(async () => (await import('./js/store.js')).getPlans().length) === 2, 'second plan saved');
  ok(/planned/.test(await page.locator('#log-list .plan-day').first().innerText()) && (await page.locator('#log-list .plan-log').count()) === 2, 'agenda: day header with total + "Log it" on today\'s plans');

  // Campaign: hero, goal-card trajectory, trajectory chart.
  await page.locator('.tab[data-view=campaign]').click();
  await page.waitForTimeout(150);
  ok(/\+\$159 planned today/.test(await page.locator('#camp-hero').innerText()), 'hero: +$159 planned today');
  ok(/予定/.test(await page.locator('#week-goal').innerText()) && (await page.locator('#week-goal .plan-seg').count()) === 1, 'weekly card: 予定 plan note + planned bar segment');
  ok((await page.locator('#traj-chart svg .bar.planned').count()) >= 1 && (await page.locator('#traj-chart svg .refline').count()) === 1, 'trajectory chart: dashed planned bars + $350 line');
  ok(/\$159/.test(await page.locator('#traj-sum').innerText()) && /2 blocks/.test(await page.locator('#traj-sum').innerText()), 'trajectory summary: $159 across 2 blocks');

  // Log it → real shift prefilled from the plan, linked on save.
  await page.locator('.tab[data-view=log]').click();
  await page.locator('#log-segmented .seg[data-log=plan]').click();
  const flexRow = page.locator('#log-list .plan-row', { hasText: '09:00–12:30' });
  await flexRow.locator('.plan-log').click();
  await page.waitForTimeout(150);
  ok(await page.locator('#shift-form').isVisible() && /Log planned block/i.test(await page.locator('#shift-form-title').innerText()), 'Log it opens the shift form ("Log planned block")');
  ok(await page.locator('#shift-platform .chip.active').getAttribute('data-val') === 'flex'
    && await page.inputValue('#shift-form [name=gross]') === '84'
    && await page.inputValue('#shift-form [name=startTime]') === '09:00'
    && await page.locator('#shift-tag .chip.active').getAttribute('data-val') === 'Express'
    && await page.locator('#shift-blockpreset .chip.active').getAttribute('data-val') === '3.5', 'prefilled: Flex, $84, 09:00–12:30, Express, 3:30 block');
  await page.fill('#shift-form [name=gross]', '92');
  await page.locator('#shift-submit').click();
  await page.waitForTimeout(150);
  const lg = await page.evaluate(async () => {
    const s = await import('./js/store.js');
    const p = s.getPlans().find((x) => x.startTime === '09:00');
    return { status: s.planStatus(p), shifts: s.getShifts().length, todayPlanned: s.trajectory(s.todayISO(), s.todayISO())[0].planned };
  });
  ok(lg.status === 'logged' && lg.shifts === 2, 'saving links the plan (logged) and adds the real shift');
  ok(lg.todayPlanned === 75, 'logged plan leaves the trajectory (only the $75 Dasher plan remains)');
  await page.locator('#log-segmented .seg[data-log=plan]').click();
  const loggedRow = page.locator('#log-list .plan-row', { hasText: '09:00–12:30' });
  ok(/Logged ✓/.test(await loggedRow.innerText()) && /\$92/.test(await loggedRow.innerText()) && /vs \$84 est/.test(await loggedRow.innerText()), 'agenda shows Logged ✓ — $92 actual vs $84 est');

  // Edit + delete.
  await page.locator('#log-list .plan-row', { hasText: '18:00–21:00' }).click();
  await page.waitForTimeout(100);
  ok(/Edit plan/i.test(await page.locator('#plan-form-title').innerText()) && await page.inputValue('#plan-form [name=estimate]') === '75', 'tapping a plan opens it for editing');
  await page.evaluate(() => { window.confirm = () => true; });
  await page.locator('#log-list .plan-row', { hasText: '18:00–21:00' }).locator('.rec-del').click();
  await page.waitForTimeout(120);
  ok(await page.evaluate(async () => (await import('./js/store.js')).getPlans().length) === 1, 'deleting a plan removes it');

  console.log('\n23) Calendar parsers (.ics + schedule screenshot text)');
  const cal = await page.evaluate(async () => {
    const c = await import('./js/calendar.js');
    const pad = (n) => String(n).padStart(2, '0');
    const local = (ms) => { const d = new Date(ms); return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}` }; };
    const ics = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT', 'SUMMARY:Amazon Flex block $84', 'DTSTART:20261006T160000Z', 'DTEND:20261006T193000Z', 'LOCATION:DWA6\\, Seattle', 'END:VEVENT',
      'BEGIN:VEVENT', 'SUMMARY:Dash dinner', 'DTSTART;TZID=America/Los_Angeles:20261006T170000', 'DTEND;TZID=America/Los_Angeles:20261006T210000',
      'RRULE:FREQ=WEEKLY;BYDAY=TU,TH;COUNT=4', 'EXDATE;TZID=America/Los_Angeles:20261008T170000', 'END:VEVENT',
      'BEGIN:VEVENT', 'SUMMARY:Dentist', 'DTSTART:20261007T150000', 'DURATION:PT1H', 'END:VEVENT',
      'BEGIN:VEVENT', 'SUMMARY:TraceHaus invoice due', 'DTSTART;VALUE=DATE:20261009', 'END:VEVENT',
      'BEGIN:VEVENT', 'SUMMARY:Cancelled', 'STATUS:CANCELLED', 'DTSTART:20261007T160000', 'END:VEVENT',
      'BEGIN:VEVENT', 'SUMMARY:Old', 'DTSTART:20260901T160000', 'DTEND:20260901T190000', 'END:VEVENT',
      'BEGIN:VEVENT', 'SUMMARY:Far', 'DTSTART:20270301T160000', 'DTEND:20270301T190000', 'END:VEVENT',
      'BEGIN:VEVENT', 'SUMMARY:Folded ti', ' tle', 'DTSTART:20261010T090000', 'DTEND:20261010T100000', 'END:VEVENT',
      'END:VCALENDAR'].join('\r\n');
    const r = c.parseICS(ics, { fromISO: '2026-10-05', toISO: '2026-12-04' });
    const flexExp = { s: local(Date.UTC(2026, 9, 6, 16, 0)), e: local(Date.UTC(2026, 9, 6, 19, 30)) };
    // Dash: 17:00 PDT (UTC-7) on Tue 10/6, Tue 10/13, Thu 10/15 (Thu 10/8 excluded, COUNT=4)
    const dashExp = [6, 13, 15].map((d) => local(Date.UTC(2026, 9, d, 24, 0)).date + ' ' + local(Date.UTC(2026, 9, d, 24, 0)).time);
    const shot = c.parseScheduleText('Schedule\nToday\n6:00 AM - 9:30 AM\nDWA6\n$96.00\nTue, Oct 6\n8:00 AM - 11:30 AM (3.5 hr)\n$88.00\n5:00 PM - 9:00 PM\nDoorDash dinner\nWednesday, October 7\n$120.00\n9:00 AM - 1:00 PM\n', '2026-10-05').events;
    return {
      r, flexExp, dashExp, shot,
      ranges: ['9:00 AM - 12:30 PM', '11 - 2pm', '17:00–21:00', '10-12 packages', '10 - 2 AM'].map((s) => c.timeRangeFromLine(s)),
      dates: ['Wed, Oct 7', '10/9', 'Thursday', 'Market 5', 'Jan 3'].map((s) => c.dateFromLine(s, '2026-10-05')),
    };
  });
  const ev = cal.r.events;
  const flexEv = ev.find((e) => /Flex/.test(e.summary));
  ok(flexEv && flexEv.date === cal.flexExp.s.date && flexEv.startTime === cal.flexExp.s.time && flexEv.endTime === cal.flexExp.e.time, 'UTC (Z) event converted to local time');
  ok(flexEv.platform === 'flex' && flexEv.estimate === 84 && flexEv.detail.startsWith('DWA6, Seattle'), 'platform + $ estimate + unescaped location read from the event');
  const dashOcc = ev.filter((e) => e.summary === 'Dash dinner').map((e) => e.date + ' ' + e.startTime);
  ok(JSON.stringify(dashOcc) === JSON.stringify(cal.dashExp), 'weekly RRULE (TU,TH, COUNT=4) expanded in its own time zone, EXDATE removed');
  ok(ev.find((e) => e.summary === 'Dentist').endTime === '16:00' && ev.find((e) => e.summary === 'Dentist').recognized === false, 'DURATION end; non-work event left unticked');
  const allDay = ev.find((e) => /invoice/.test(e.summary));
  ok(allDay.startTime === '' && allDay.platform === 'income', 'all-day event has no times; "invoice" → Income');
  ok(ev.some((e) => e.summary === 'Folded title'), 'folded (wrapped) lines are joined');
  ok(cal.r.cancelled === 1 && cal.r.skippedPast === 1 && cal.r.skippedLater === 1, 'cancelled, past and beyond-window events skipped + counted');
  ok(JSON.stringify(cal.ranges) === JSON.stringify([{ startTime: '09:00', endTime: '12:30' }, { startTime: '11:00', endTime: '14:00' }, { startTime: '17:00', endTime: '21:00' }, null, { startTime: '22:00', endTime: '02:00' }]), 'time ranges: 12h/24h, inferred AM/PM, counts like "10-12" ignored');
  ok(JSON.stringify(cal.dates) === JSON.stringify(['2026-10-07', '2026-10-09', '2026-10-08', null, '2027-01-03']), 'date headers: "Wed, Oct 7", 10/9, weekday, not "Market 5", Jan rolls to next year');
  ok(cal.shot.length === 4 && cal.shot.map((e) => e.date).join() === '2026-10-05,2026-10-06,2026-10-06,2026-10-07', 'screenshot: 4 blocks dated by the headers above them');
  ok(cal.shot.map((e) => e.estimate).join() === '96,88,0,120', 'screenshot: each block keeps its own price (none borrowed)');
  ok(cal.shot[2].platform === 'doordash', 'screenshot: "DoorDash" near a block sets its platform');

  console.log('\n24) Calendar import (UI): .ics + screenshot → review → planner');
  ok((await page.locator('.tab[data-view=campaign] .line-mark b').innerText()) === '350', 'Campaign tab badge reads 350 (was cut to "35")');
  const dates = await page.evaluate(async () => {
    const s = await import('./js/store.js');
    s.clearAll();
    const d = (n) => { const x = new Date(); x.setDate(x.getDate() + n); return s.isoDate(x); };
    s.addPlan({ date: d(2), platform: 'doordash', startTime: '17:00', endTime: '21:00', estimate: 90 }); // will be a duplicate
    return { d1: d(1), d2: d(2) };
  });
  const ymd = (iso) => iso.replace(/-/g, '');
  const icsText = ['BEGIN:VCALENDAR',
    'BEGIN:VEVENT', 'SUMMARY:Amazon Flex $96', `DTSTART:${ymd(dates.d1)}T080000`, `DTEND:${ymd(dates.d1)}T113000`, 'END:VEVENT',
    'BEGIN:VEVENT', 'SUMMARY:Dash', `DTSTART:${ymd(dates.d2)}T170000`, `DTEND:${ymd(dates.d2)}T210000`, 'END:VEVENT',
    'BEGIN:VEVENT', 'SUMMARY:Gym', `DTSTART:${ymd(dates.d2)}T070000`, `DTEND:${ymd(dates.d2)}T080000`, 'END:VEVENT',
    'END:VCALENDAR'].join('\r\n');
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('.tab[data-view=log]').click();
  await page.locator('#log-segmented .seg[data-log=plan]').click();
  await page.locator('#plan-import').click();
  ok(await page.locator('#view-import.active').count() === 1 && await page.locator('#cal-card').isVisible(), 'Plan → "Import calendar" opens the calendar importer');
  await page.setInputFiles('#cal-ics-file', { name: 'my.ics', mimeType: 'text/calendar', buffer: Buffer.from(icsText) });
  await page.waitForTimeout(200);
  ok((await page.locator('#cal-preview .cal-row').count()) === 3 && /Found 3 upcoming/.test(await page.locator('#cal-status').innerText()), '.ics → 3 events to review');
  const ticks = await page.locator('#cal-preview .cal-row').evaluateAll((els) => els.map((e) => e.querySelector('.cal-title').textContent.split(' ')[0] + ':' + e.querySelector('input[type=checkbox]').checked));
  ok(JSON.stringify(ticks) === '["Amazon:true","Gym:false","Dash:false"]', 'sorted by time; Flex ticked; the gym and already-planned Dash unticked');
  ok(/already planned/.test(await page.locator('#cal-preview .cal-row.is-dupe').innerText()), 'duplicate of an existing plan is flagged');
  const gymRow = page.locator('#cal-preview .cal-row', { hasText: 'Gym' });
  await gymRow.locator('input[type=checkbox]').check();
  await gymRow.locator('select').selectOption('other');
  await gymRow.locator('[data-k=estimate]').fill('15');
  ok((await page.locator('#cal-add').innerText()) === 'Add 2 to planner', 'button counts the ticked rows');
  await page.locator('#cal-add').click();
  await page.waitForTimeout(200);
  const calPlans = await page.evaluate(async () => (await import('./js/store.js')).getPlans().map((p) => `${p.platform}:${p.startTime}-${p.endTime}:${p.estimate}`).sort());
  ok(calPlans.length === 3 && calPlans.includes('flex:08:00-11:30:96') && calPlans.includes('other:07:00-08:00:15'), 'added Flex ($96 from the title) + edited gym row; no duplicate Dash');
  ok(await page.locator('#view-log.active').count() === 1 && await page.locator('#log-segmented .seg.active').getAttribute('data-log') === 'plan', 'lands on Log → Plan afterwards');

  // Screenshot path with the OCR engine stubbed (no network needed).
  await page.evaluate((d1) => {
    const [y, m, dd] = d1.split('-').map(Number);
    const hdr = new Date(y, m - 1, dd).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    window.Tesseract = { createWorker: async () => ({ recognize: async () => ({ data: { text: `Upcoming\n${hdr}\n1:00 PM - 4:30 PM\n$75.00\n` } }), terminate: async () => {} }) };
  }, dates.d1);
  await page.locator('.tab[data-view=import]').click();
  await page.setInputFiles('#cal-img-file', { name: 'shot.png', mimeType: 'image/png', buffer: Buffer.from([137, 80, 78, 71]) });
  await page.waitForTimeout(300);
  const shotRow = page.locator('#cal-preview .cal-row').first();
  ok((await page.locator('#cal-preview .cal-row').count()) === 1
    && await shotRow.locator('[data-k=date]').inputValue() === dates.d1
    && await shotRow.locator('[data-k=startTime]').inputValue() === '13:00'
    && await shotRow.locator('[data-k=estimate]').inputValue() === '75'
    && await shotRow.locator('select').inputValue() === 'flex', 'screenshot → 1 block: date from header, 13:00–16:30, $75, default platform Flex');
  await page.locator('#cal-add').click();
  await page.waitForTimeout(200);
  ok(await page.evaluate(async () => (await import('./js/store.js')).getPlans().length) === 4, 'screenshot block added to the planner');
  await page.evaluate(() => { delete window.Tesseract; });

  console.log('\n25) 白色LED theme: fonts, JP ⇄ EN swap, flaps, marquee');
  await page.evaluate(async () => {
    const s = await import('./js/store.js');
    s.clearAll();
    s.addShift({ platform: 'flex', date: s.todayISO(), gross: 200, tips: 0, hours: 3.5, miles: 30, scheduledHours: 3.5, tag: 'Express' });
    s.addPlan({ date: s.todayISO(), platform: 'doordash', startTime: '23:00', endTime: '23:30', estimate: 110 });
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(300);
  const fontsOk = await page.evaluate(async () => { await document.fonts.ready; return document.fonts.check('16px DotGothic16') && document.fonts.check('11px Silkscreen'); });
  ok(fontsOk, 'pixel fonts load from the bundled /fonts (offline-safe)');
  const fontReq = await page.evaluate(() => performance.getEntriesByType('resource').some((r) => /fonts\/DotGothic16-subset\.woff2$/.test(r.name)));
  ok(fontReq, 'DotGothic16 subset is served locally (no Google Fonts request)');
  ok((await page.locator('#departure-board .dep-row .dep-type').first().innerText()) === '急行', 'departure board: 種別 flap shows 急行');
  const dest = await page.locator('#departure-board .dep-row .dep-dest').first().innerText();
  ok(/フレックス/.test(dest) && /AMAZON FLEX/.test(dest), '行先 carries both フレックス and AMAZON FLEX');
  const flips = await page.evaluate(() => new Promise((res) => { const a = document.documentElement.classList.contains('lang-en'); setTimeout(() => res(a !== document.documentElement.classList.contains('lang-en')), 3200); }));
  ok(flips, 'JP ⇄ EN flips page-wide after 3 s (one class on <html>)');
  ok((await page.locator('.card-head h2 .swap').count()) >= 5 && await page.locator('#view-dashboard .card-head h2[aria-label="Recent shifts"]').count() === 1, 'card headings decorated into JP ⇄ EN swaps (aria-label keeps English)');
  await page.fill('#offer-pay', '20'); await page.fill('#offer-miles', '8');
  ok((await page.locator('#offer-verdict .flap.grn').innerText()) === '乗車', 'Worth it? verdict shows a green 乗車 flap');
  await page.locator('.tab[data-view=campaign]').click();
  await page.waitForTimeout(200);
  ok((await page.locator('#camp-hero .flap.org').innerText()) === '進行中', 'hero status is an orange 進行中 flap');
  ok((await page.locator('#camp-hero .ch-cells .lit').count()) === 8 && (await page.locator('#camp-hero .ch-cells .plan').count()) === 4, 'hero LED bar: 8 lit ($200) + 4 planned ($110)');
  const marq = await page.locator('#camp-marq-track').innerText();
  ok(!(await page.locator('#camp-marquee.hidden').count()) && /あと \$150/.test(marq) && /次は/.test(marq) && /DOORDASH/.test(marq), 'まもなく marquee: あと $150 · 次は … ドアダッシュ / NEXT … DOORDASH');
  ok(/WEEKLY GOAL/.test(await page.locator('#week-goal').innerText()) && /週間目標/.test(await page.locator('#week-goal').innerText()), 'goal card title flips 週間目標 ⇄ WEEKLY GOAL');
  ok((await page.locator('#traj-chart svg .led-lattice').count()) === 1, 'charts carry the LED dot lattice');

  console.log('\n26) No sideways spill on small phones (incl. iOS-wide date/time inputs)');
  {
    const narrow = await newCtx({ width: 320, height: 700 }).then((c) => c.newPage());
    await narrow.goto(base + '/index.html');
    // Clip guard off so real overflow shows; mimic iOS's wide intrinsic
    // date/time inputs at UA-level (zero) specificity.
    await narrow.addStyleTag({ content: 'html,body{overflow-x:visible!important} :where(input[type=date],input[type=time]){min-width:360px}' });
    const spills = [];
    for (const [view, sub] of [['dashboard'], ['campaign'], ['log', 'shift'], ['log', 'plan'], ['log', 'expense'], ['log', 'trip'], ['trends'], ['import'], ['settings']]) {
      await narrow.locator(`.tab[data-view=${view}]`).click();
      if (sub) await narrow.locator(`#log-segmented .seg[data-log=${sub}]`).click();
      await narrow.waitForTimeout(80);
      const w = await narrow.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (w > 0) spills.push(`${view}${sub ? '/' + sub : ''} +${w}px`);
    }
    ok(spills.length === 0, 'every screen fits 320 px wide' + (spills.length ? ': ' + spills.join(', ') : ''));
    await narrow.close();
  }

  console.log('\n27) Planning desk analytics: heat map, slot estimates, suggestions, copy week');
  const an = await page.evaluate(async () => {
    const s = await import('./js/store.js');
    s.clearAll();
    // A fixed Monday so weekdays are known. Mon 2026-09-07 … Sun 2026-09-13.
    const now = '2026-09-30';
    s.addShift({ platform: 'doordash', date: '2026-09-21', startTime: '17:00', endTime: '19:00', hours: 2, gross: 60, miles: 20 });       // Mon: $30/hr
    s.addShift({ platform: 'doordash', date: '2026-09-28', startTime: '17:00', endTime: '18:00', hours: 1, gross: 40, miles: 10 });       // Mon 17h: +$40/1h
    s.addShift({ platform: 'flex', date: '2026-09-22', startTime: '23:00', endTime: '01:00', hours: 2, gross: 50, miles: 0 });            // Tue 23h → Wed 00h
    s.addShift({ platform: 'flex', date: '2026-09-23', hours: 3, gross: 90 });                                                           // untimed
    const heat = s.hourlyHeat({ platform: 'all', days: 90 }, now);
    const net = s.hourlyHeat({ platform: 'doordash', days: 90, net: true }, now);
    const flexOnly = s.hourlyHeat({ platform: 'flex', days: 90 }, now);
    const scale = s.heatScale(heat);
    const est = s.estimateFor({ date: '2026-10-05', startTime: '17:00', endTime: '19:00', platform: 'doordash' }, now);
    const noHist = s.slotRate('2026-10-06', '09:00', '11:00', 'doordash', now);
    return {
      mon17: heat.cells[1][17], mon18: heat.cells[1][18], tue23: heat.cells[2][23], wed0: heat.cells[3][0],
      timed: heat.timed, total: heat.total, netMon18: net.cells[1][18].rate, flexMon17: flexOnly.cells[1][17].rate,
      lvlBest: scale.level(heat.cells[1][17].rate), lvlNone: scale.level(null), est, noHist,
    };
  });
  ok(Math.abs(an.mon17.rate - 35) < 0.01 && an.mon17.shifts === 2, 'heat: Mon 17h = ($30 + $40) over 2 h = $35/hr from 2 shifts');
  ok(Math.abs(an.mon18.rate - 30) < 0.01, 'heat: pay is spread evenly over the hours worked (Mon 18h = $30/hr)');
  ok(Math.abs(an.tue23.rate - 25) < 0.01 && Math.abs(an.wed0.rate - 25) < 0.01, 'heat: an overnight shift spills into the next weekday');
  ok(an.timed === 3 && an.total === 4, 'coverage: 3 of 4 shifts have clock times');
  ok(Math.abs(an.netMon18 - (30 - 10 * 0.7)) < 0.01, 'net heat takes off miles × IRS rate (Mon 18h $30 − $7 = $23/hr)');
  ok(an.flexMon17 === null, 'platform filter: no Flex history on Mon 17h');
  ok(an.lvlBest === 4 && an.lvlNone === -1, 'heat scale: your top cell is "best", empty cells have no level');
  ok(an.est.fromSlot && Math.abs(an.est.rate - 32.5) < 0.01 && an.est.estimate === 65, 'estimateFor Mon 17–19 DoorDash = avg($35, $30) × 2 h = $65');
  ok(!an.noHist.fromSlot && an.noHist.rate > 0, 'slot without history falls back to your overall rate');

  const sg = await page.evaluate(async () => {
    const s = await import('./js/store.js');
    s.clearAll();
    // 6 weeks of Mon–Sun history: DoorDash dinners pay best, Flex mornings OK.
    const day = (iso, n) => { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); return s.isoDate(d); };
    for (let n = 0; n < 45; n++) { // through Wed 9/30 ("today")
      const date = day('2026-08-17', n);
      s.addShift({ platform: 'doordash', date, startTime: '17:00', endTime: '21:00', hours: 4, gross: 140 });
      s.addShift({ platform: 'flex', date, startTime: '06:00', endTime: '09:00', hours: 3, gross: 75 });
    }
    const now = '2026-09-30'; // Wed
    const week = '2026-09-28';
    s.addPlan({ date: '2026-10-01', platform: 'doordash', startTime: '17:00', endTime: '21:00', estimate: 140 }); // Thu dinner already planned
    const sug = s.suggestSlots(week, { nowISO: now, nowMin: 12 * 60 });
    const dw = s.deskWeek(week, now);
    // Copy this week into next week, then again (second time everything overlaps).
    const first = s.copyWeekPlans(week, '2026-10-05');
    const again = s.copyWeekPlans(week, '2026-10-05');
    const next = s.getPlans().filter((p) => p.date >= '2026-10-05' && p.date <= '2026-10-11');
    return {
      sug: sug.map((x) => ({ date: x.date, t: x.startTime + '-' + x.endTime, p: x.platform, est: x.estimate, free: x.freeDay })),
      dw: { goal: dw.goal, earned: dw.earned, planned: dw.planned, metOn: dw.metOn, hours: dw.hours },
      first: first.length, again: again.length, nextKinds: [...new Set(next.map((p) => p.platform))].sort(), nextTimes: next.map((p) => p.date + ' ' + p.startTime).sort(),
    };
  });
  ok(sg.sug.length > 0 && sg.sug.every((x) => x.date >= '2026-09-30'), `suggestions only from today on (${sg.sug.length})`);
  ok(sg.sug[0].p === 'doordash' && /^17:00-2[01]:00$/.test(sg.sug[0].t), `best suggestion is a DoorDash dinner (${sg.sug[0].date} ${sg.sug[0].t})`);
  ok(!sg.sug.some((x) => x.date === '2026-10-01' && x.t.startsWith('17')), 'no suggestion on top of the already-planned Thu dinner');
  ok(!sg.sug.some((x) => x.date === '2026-09-30' && Number(x.t.slice(0, 2)) < 13), 'today: nothing before now (+30 min)');
  ok(sg.sug.every((x) => x.free === !['2026-09-30', '2026-10-01'].includes(x.date)), 'days with nothing on them are flagged as free days');
  ok(sg.dw.goal > 0 && sg.dw.planned === 140 && sg.dw.earned === 3 * 215, `deskWeek: earned ${sg.dw.earned} + planned ${sg.dw.planned} vs goal ${sg.dw.goal}`);
  ok(sg.first > 0 && sg.again === 0, `copy last week: ${sg.first} blocks copied, re-copy skips overlaps`);
  ok(sg.nextKinds.join(',') === 'doordash,flex' && sg.nextTimes.includes('2026-10-05 06:00') && sg.nextTimes.includes('2026-10-08 17:00'), 'copy brings timed shifts as plans + open plans, same weekday & time');

  console.log('\n28) Planning desk UI (desktop): drag, keys, suggestions, undo');
  {
    const dctx = await newCtx({ width: 1440, height: 1000 });
    const desk = await dctx.newPage();
    const derr = [];
    desk.on('pageerror', (e) => derr.push(e.message));
    await desk.goto(base + '/index.html');
    await desk.evaluate(async () => {
      const s = await import('./js/store.js');
      s.clearAll();
      const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return s.isoDate(d); };
      for (let n = -42; n < 0; n++) {
        s.addShift({ platform: 'doordash', date: day(n), startTime: '17:00', endTime: '21:00', hours: 4, gross: 130 });
        s.addShift({ platform: 'flex', date: day(n), startTime: '06:00', endTime: '09:30', hours: 3.5, gross: 90, tag: 'Express' });
      }
    });
    await desk.reload();
    await desk.locator('.snav[data-view=desk]').click();
    await desk.waitForTimeout(150);
    ok(await desk.locator('#view-desk.active').count() === 1 && await desk.locator('#screen-title').getAttribute('aria-label') === 'PLANNING DESK', 'GT07 opens the planning desk');
    ok(await desk.locator('.dcol').count() === 7 && await desk.locator('.d-heat').count() === 7, 'week of 7 columns with best-hours shading');
    await desk.keyboard.press('ArrowRight'); // next week: every day is in the future
    await desk.waitForTimeout(100);
    ok(/NEXT WEEK/.test(await desk.locator('#desk-week-sub').innerText()), '→ moves to next week');
    const plans = () => desk.evaluate(async () => (await import('./js/store.js')).getPlans().map((p) => ({ id: p.id, date: p.date, s: p.startTime, e: p.endTime, est: p.estimate, plat: p.platform })));
    const colBox = async (i) => desk.locator('.dcol').nth(i).boundingBox();
    const yAt = (box, min) => box.y + ((min / 60) - 6) * 32;

    // Drag-create on Tuesday 17:00 → 20:00 (DoorDash pays best there).
    let b = await colBox(1);
    await desk.mouse.move(b.x + b.width / 2, yAt(b, 17 * 60) + 2);
    await desk.mouse.down();
    await desk.mouse.move(b.x + b.width / 2, yAt(b, 18 * 60), { steps: 4 });
    ok(await desk.locator('.d-tip').count() === 1 && /est \$\d+/.test(await desk.locator('.d-tip').innerText()), 'dragging shows a live time + estimate tip');
    await desk.mouse.move(b.x + b.width / 2, yAt(b, 20 * 60), { steps: 4 });
    await desk.mouse.up();
    await desk.waitForTimeout(150);
    let ps = await plans();
    ok(ps.length === 1 && ps[0].s === '17:00' && ps[0].e === '20:00' && ps[0].plat === 'doordash' && Math.abs(ps[0].est - 97.5) <= 1, `drag-create: Tue 17:00–20:00 DoorDash, est from history (${JSON.stringify(ps[0])})`);
    ok(await desk.locator('#desk-inspector .di-when').count() === 1 && /17:00–20:00/.test(await desk.locator('#desk-inspector').innerText()), 'new block is selected in the inspector');

    // Move it to Thursday 18:00 by its body.
    const blk = desk.locator(`.dblk[data-id="${ps[0].id}"]`);
    let bb = await blk.boundingBox();
    const b3 = await colBox(3);
    await desk.mouse.move(bb.x + bb.width / 2, bb.y + 10);
    await desk.mouse.down();
    await desk.mouse.move(b3.x + b3.width / 2, bb.y + 10 + 32, { steps: 6 });
    await desk.mouse.up();
    await desk.waitForTimeout(150);
    ps = await plans();
    const thu = await desk.locator('.dcol').nth(3).getAttribute('data-date');
    ok(ps[0].date === thu && ps[0].s === '18:00' && ps[0].e === '21:00', `move: now ${ps[0].date} ${ps[0].s}–${ps[0].e}`);

    // Resize from the bottom edge to 22:00.
    bb = await desk.locator(`.dblk[data-id="${ps[0].id}"]`).boundingBox();
    await desk.mouse.move(bb.x + bb.width / 2, bb.y + bb.height - 2);
    await desk.mouse.down();
    await desk.mouse.move(bb.x + bb.width / 2, yAt(b3, 22 * 60), { steps: 5 });
    await desk.mouse.up();
    await desk.waitForTimeout(150);
    ps = await plans();
    ok(ps[0].e === '22:00' && ps[0].est > 97, `resize: ends 22:00, estimate grew to $${ps[0].est}`);

    // Inspector: a typed estimate sticks.
    await desk.fill('#di-est', '150');
    await desk.locator('#di-est').press('Tab');
    await desk.waitForTimeout(100);
    ok((await plans())[0].est === 150, 'inspector edits the estimate');

    // Overlap: another block on Thursday 19:00–20:00 → both get the warning.
    const ovId = await desk.evaluate(async (date) => (await import('./js/store.js')).addPlan({ date, platform: 'flex', startTime: '19:00', endTime: '20:00', estimate: 30 }).id, thu);
    await desk.waitForTimeout(120);
    ok(await desk.locator('.dblk.warn').count() === 2, 'overlapping blocks sit side by side with a warning outline');
    await desk.evaluate(async (id) => (await import('./js/store.js')).deletePlan(id), ovId);
    await desk.waitForTimeout(80);

    // Undo twice: the estimate edit, then the resize.
    await desk.keyboard.press('Control+z'); await desk.waitForTimeout(80);
    await desk.keyboard.press('Control+z'); await desk.waitForTimeout(80);
    ps = await plans();
    ok(ps.length === 1 && ps[0].e === '21:00' && ps[0].est !== 150, `⌘Z undoes the last two changes (back to ${ps[0].s}–${ps[0].e}, $${ps[0].est})`);

    // Suggestions: add the top one.
    const before = ps.length;
    ok(await desk.locator('#desk-sugg .d-sugg').count() > 0, 'fill-the-gap lists suggestions');
    await desk.locator('#desk-sugg .d-sugg').first().hover();
    ok(await desk.locator('.d-ghost.pv').count() === 1 && /With this:/.test(await desk.locator('#desk-gap-line').innerText()), 'hovering a suggestion previews it on the grid + new total');
    await desk.locator('#desk-sugg [data-add]').first().click();
    await desk.waitForTimeout(150);
    ok((await plans()).length === before + 1, '+ Add puts the suggestion on the plan');

    // Keys: H toggles shading, N adds a block, Delete removes the selected one, ⌘D duplicates.
    await desk.keyboard.press('h'); await desk.waitForTimeout(80);
    ok(await desk.locator('.d-heat').count() === 0, 'H turns best-hours shading off');
    await desk.keyboard.press('h'); await desk.waitForTimeout(80);
    const n0 = (await plans()).length;
    await desk.keyboard.press('n'); await desk.waitForTimeout(120);
    ok((await plans()).length === n0 + 1, 'N adds a 3-hour block at the next free slot');
    await desk.keyboard.press('Control+d'); await desk.waitForTimeout(120);
    ok((await plans()).length === n0 + 2, '⌘D duplicates the selected block');
    await desk.keyboard.press('Delete'); await desk.waitForTimeout(120);
    ok((await plans()).length === n0 + 1, 'Delete removes the selected block');

    // Copy last week into the week after.
    await desk.keyboard.press('ArrowRight'); await desk.waitForTimeout(100);
    await desk.locator('#desk-copy').click(); await desk.waitForTimeout(150);
    ok(await desk.locator('.dblk.k-plan').count() >= 3, 'copy last week fills the next week');

    // Trends heat map → "Plan this slot" opens the desk on that week.
    await desk.locator('.snav[data-view=trends]').click();
    await desk.waitForTimeout(150);
    ok(await desk.locator('#bh-grid .bh-cell').count() === 7 * 18, 'best-hours heat map: 7 days × 18 hours');
    ok(/\$\d/.test(await desk.locator('#bh-side .bh-rate').innerText()) && await desk.locator('#bh-side .bh-top li').count() > 0, 'slot detail + top slots');
    await desk.locator('#bh-grid .bh-cell[data-cell="2,18"]').click();
    ok(/Tue 18:00–19:00/.test(await desk.locator('#bh-side .bh-when').innerText()), 'clicking a cell shows that slot');
    await desk.locator('#bh-plan').click();
    await desk.waitForTimeout(150);
    ok(await desk.locator('#view-desk.active').count() === 1 && await desk.locator('.d-flash').count() === 1, '"Plan this slot" opens the desk with the hour highlighted');
    ok(derr.length === 0, 'desk: no page errors' + (derr.length ? ': ' + derr.join(' | ') : ''));
    await dctx.close();

    // On a phone, "Plan this slot" opens Log → Plan prefilled instead.
    const pctx = await newCtx({ width: 390, height: 844 });
    const ph = await pctx.newPage();
    await ph.goto(base + '/index.html');
    await ph.evaluate(async () => {
      const s = await import('./js/store.js');
      s.clearAll();
      for (let n = -21; n < 0; n++) { const d = new Date(); d.setDate(d.getDate() + n); s.addShift({ platform: 'doordash', date: s.isoDate(d), startTime: '17:00', endTime: '21:00', hours: 4, gross: 120 }); }
    });
    await ph.reload();
    await ph.locator('.tab[data-view=trends]').click();
    await ph.waitForTimeout(150);
    await ph.locator('#bh-grid .bh-cell[data-cell="5,17"]').click();
    await ph.locator('#bh-plan').click();
    await ph.waitForTimeout(150);
    ok(await ph.locator('#view-log.active #plan-form:not(.hidden)').count() === 1
      && await ph.inputValue('#plan-form [name=startTime]') === '17:00' && await ph.inputValue('#plan-form [name=endTime]') === '20:00'
      && await ph.locator('#plan-platform .chip.active').getAttribute('data-val') === 'doordash'
      && /for this slot/.test(await ph.locator('#plan-est-hint').innerText()), 'phone: "Plan this slot" opens Log → Plan prefilled (Fri 17–20 DoorDash, slot estimate)');
    await pctx.close();
  }

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
