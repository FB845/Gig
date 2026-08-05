import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  const file = path.join(root, p);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;
const browser = await chromium.launch({ executablePath: EXE });
const shotCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, permissions: ['geolocation'], geolocation: { latitude: 40, longitude: -74, accuracy: 8 } });
const page = await shotCtx.newPage();
await page.goto(base, { waitUntil: 'networkidle' });

// seed a few weeks of realistic data
await page.evaluate(async () => {
  const s = await import('./js/store.js');
  s.clearAll();
  const plats = ['flex', 'doordash'];
  const start = new Date(2026, 5, 1);
  for (let i = 0; i < 34; i++) {
    const d = new Date(start); d.setDate(d.getDate() + i);
    if (Math.random() < 0.35) continue;
    const p = plats[Math.random() < 0.5 ? 0 : 1];
    const tags = ['Rapid Express', 'Express', 'Rescue', 'Normal'];
    const sched = [2, 2.5, 3, 3.5, 4][Math.floor(Math.random() * 5)];
    const isFlex = p === 'flex';
    const hours = isFlex ? Math.round((sched * (0.7 + Math.random() * 0.45)) * 4) / 4 : 2 + Math.round(Math.random() * 6);
    const rate = isFlex ? 14 + Math.random() * 10 : 12 + Math.random() * 6;
    const gross = Math.round((hours * rate) * 100) / 100;
    const tips = p === 'doordash' ? Math.round(Math.random() * 25 * 100) / 100 : Math.round(Math.random() * 8 * 100) / 100;
    s.addShift({ platform: p, date: s.isoDate(d), hours, gross, tips, jobs: 4 + Math.round(Math.random() * 14), miles: Math.round((hours * 9) * 10) / 10, fuel: Math.random() < 0.4 ? Math.round(Math.random() * 25 * 100) / 100 : 0, scheduledHours: isFlex ? sched : 0, tag: isFlex ? tags[Math.floor(Math.random() * 4)] : '' });
  }
  s.addExpense({ date: '2026-06-15', category: 'Maintenance', amount: 89.99, note: 'Oil change' });
  s.addExpense({ date: '2026-06-20', category: 'Phone', amount: 45 });
  s.addExpense({ date: '2026-06-28', category: 'Supplies', amount: 22.5, note: 'Hot bag' });
});
await page.reload({ waitUntil: 'networkidle' });
await page.locator('#period-pills .pill[data-period=all]').click();
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(root, 'scripts/dashboard.png'), fullPage: true });
// dark mode full page
await page.emulateMedia({ colorScheme: 'dark' });
await page.waitForTimeout(200);
await page.screenshot({ path: path.join(root, 'scripts/dashboard-dark.png'), fullPage: true });
await page.emulateMedia({ colorScheme: 'light' });
await page.locator('.tab[data-view=trends]').click();
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(root, 'scripts/trends.png') });
await page.locator('.tab[data-view=import]').click();
await page.waitForTimeout(200);
await page.screenshot({ path: path.join(root, 'scripts/import.png') });
// flex shift form with block preset + tag selected
await page.locator('.tab[data-view=log]').click();
await page.locator('#shift-blockpreset .chip[data-val="3"]').click();
await page.fill('#shift-form [name=hours]', '2.5');
await page.locator('#shift-tag .chip[data-val="Rapid Express"]').click();
await page.fill('#shift-form [name=gross]', '54');
await page.fill('#shift-form [name=tips]', '8');
await page.fill('#shift-form [name=jobs]', '31');
await page.fill('#shift-form [name=miles]', '38');
await page.locator('#shift-form [name=miles]').dispatchEvent('input');
await page.waitForTimeout(150);
await page.screenshot({ path: path.join(root, 'scripts/flex-form.png') });
// drive overlay (simulate a short drive)
await page.locator('.tab[data-view=dashboard]').click();
await page.locator('#drive-cta').click();
await page.waitForTimeout(300);
for (let i = 1; i <= 8; i++) { await shotCtx.setGeolocation({ latitude: 40 + (i * 0.9) / 69, longitude: -74, accuracy: 7 }); await page.waitForTimeout(120); }
await page.waitForTimeout(200);
await page.screenshot({ path: path.join(root, 'scripts/drive.png') });
await page.locator('#drive-cancel').click();
// clean the seed so shipped app starts empty
await page.evaluate(async () => { (await import('./js/store.js')).clearAll(); });
await browser.close(); server.close();
console.log('shots saved');
