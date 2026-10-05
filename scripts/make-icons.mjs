// Render the logo (icons/logo.svg, glyph icons/glyph.svg) to every PNG the app
// and the Raycast extension need, with the pre-installed Chromium.
//   node scripts/make-icons.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE = process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const logo = fs.readFileSync(path.join(root, 'icons/logo.svg'), 'utf8');
const glyph = fs.readFileSync(path.join(root, 'icons/glyph.svg'), 'utf8');

// size: px · radius: corner rounding (0 = square, full bleed) · safe: content
// scale (maskable icons keep the mark in the middle 80%) · dots: unlit-dot
// texture (dropped at tiny sizes where it turns to noise).
const JOBS = [
  ['icons/icon-512.png', 512, 0.2237, 1, true],
  ['icons/icon-192.png', 192, 0.2237, 1, true],
  ['icons/icon-maskable-512.png', 512, 0, 0.8, true],
  ['icons/icon-maskable-192.png', 192, 0, 0.8, true],
  ['icons/apple-touch-icon.png', 180, 0, 1, true],
  ['icons/favicon-32.png', 32, 0.18, 1, false],
  ['raycast/assets/icon.png', 512, 0.2237, 1, true],
];

const browser = await chromium.launch({ executablePath: EXE });
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const [out, size, radius, safe, dots] of JOBS) {
  let svg = logo.replace('<svg ', `<svg width="${size}" height="${size}" `);
  if (!dots) svg = svg.replace(/<rect class="dots"[^>]*\/>/, '');
  if (safe !== 1) svg = svg.replace('<g class="mark">', `<g class="mark" transform="translate(${256 * (1 - safe)} ${256 * (1 - safe)}) scale(${safe})">`);
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent"><div style="width:${size}px;height:${size}px;border-radius:${radius * size}px;overflow:hidden">${svg}</div></body></html>`);
  await page.screenshot({ path: path.join(root, out), omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  console.log('wrote', out);
}
// Menu-bar glyph for Raycast: black (light menu bar) and white (dark), @2x.
for (const [out, color] of [['raycast/assets/menubar-icon.png', '#000'], ['raycast/assets/menubar-icon@dark.png', '#fff']]) {
  const size = 36;
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent;color:${color}">${glyph.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  await page.screenshot({ path: path.join(root, out), omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  console.log('wrote', out);
}
await browser.close();
