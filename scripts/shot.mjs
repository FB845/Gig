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
const page = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 }).then((c) => c.newPage());
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
    const hours = 2 + Math.round(Math.random() * 6);
    const gross = Math.round((hours * (12 + Math.random() * 6)) * 100) / 100;
    const tips = p === 'doordash' ? Math.round(Math.random() * 25 * 100) / 100 : Math.round(Math.random() * 8 * 100) / 100;
    s.addShift({ platform: p, date: s.isoDate(d), hours, gross, tips, jobs: 4 + Math.round(Math.random() * 14), miles: Math.round((hours * 9) * 10) / 10, fuel: Math.random() < 0.4 ? Math.round(Math.random() * 25 * 100) / 100 : 0 });
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
// clean the seed so shipped app starts empty
await page.evaluate(async () => { (await import('./js/store.js')).clearAll(); });
await browser.close(); server.close();
console.log('shots saved');
