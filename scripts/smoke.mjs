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

  console.log('\n2) Log a shift via the form');
  await page.locator('.tab[data-view=log]').click();
  await page.locator('#shift-platform .chip[data-val=doordash]').click();
  await page.fill('#shift-form [name=date]', '2026-07-06');
  await page.fill('#shift-form [name=hours]', '4');
  await page.fill('#shift-form [name=gross]', '40');
  await page.fill('#shift-form [name=tips]', '20');
  await page.fill('#shift-form [name=jobs]', '12');
  await page.fill('#shift-form [name=miles]', '30');
  await page.fill('#shift-form [name=fuel]', '10');
  const live = await page.locator('#shift-live').innerText();
  ok(/\$15\.00/.test(live), 'live $/hr = $15.00 (60/4)');
  await page.locator('#shift-submit').click();
  await page.waitForTimeout(150);
  ok((await page.locator('#log-list .record').count()) === 1, 'shift appears in list');

  console.log('\n3) Fuel created a linked expense');
  await page.locator('#log-segmented .seg[data-log=expense]').click();
  await page.waitForTimeout(100);
  const expText = await page.locator('#log-list').innerText();
  ok(/Fuel/.test(expText) && /\$10\.00/.test(expText), 'linked Fuel expense of $10 exists');

  console.log('\n4) Dashboard KPIs reflect the data');
  await page.locator('.tab[data-view=dashboard]').click();
  await page.locator('#period-pills .pill[data-period=all]').click();
  await page.waitForTimeout(150);
  const kpi = await page.locator('#kpi-grid').innerText();
  ok(/\$50/.test(kpi), 'net income = $50 (60 income - 10 fuel)');
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
