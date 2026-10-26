// npm run doctor — is the Claude connection set up? Checks Node, the copied
// data model, your connection key, and does one live read of your cloud data.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NO_KEY, cacheDir, endpoints, loadKey, storage } from '../config.mjs';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let problems = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m, fix) => { console.log('  ✗ ' + m + (fix ? `\n      → ${fix}` : '')); problems++; };

console.log('\nGig Tracker · Claude connection doctor\n');

const major = Number(process.versions.node.split('.')[0]);
if (major >= 20) ok(`Node ${process.versions.node}`);
else bad(`Node ${process.versions.node} is too old`, 'install Node 20 or newer (nodejs.org)');

if (fs.existsSync(path.join(here, 'node_modules/@modelcontextprotocol/sdk'))) ok('dependencies installed');
else bad('dependencies not installed', 'run `npm install` in the mcp folder');

if (fs.existsSync(path.join(here, 'lib/store.js')) && fs.existsSync(path.join(here, 'lib/cloud.js'))) ok('app data model copied in (mcp/lib)');
else bad('the app’s data model isn’t copied in', 'run `npm install` (or `node scripts/sync-core.mjs`) in the mcp folder');

const key = loadKey();
if (!key) bad('no connection key found', NO_KEY);
else if (problems === 0) {
  try {
    const { createCloud } = await import('../lib/cloud.js');
    const cloud = createCloud({ key, storage, endpoints, deviceId: 'mcp' });
    ok(`connection key is valid${cloud.email ? ` (${cloud.email})` : ''}`);
    const r = await cloud.pull();
    const db = cloud.store.getDB();
    ok(`read your cloud data: ${db.shifts.length} shifts, ${db.plans.length} plans, ${db.incomes.length} other income, ${db.expenses.length} expenses (${r.changed} changed since last time)`);
    ok(`private cache: ${cacheDir}`);
  } catch (e) {
    bad(e.message || String(e), 'copy a fresh key from the app: Settings → Cloud sync → Copy Raycast key');
  }
}

console.log(problems ? `\n${problems} problem${problems === 1 ? '' : 's'} — fix the ✗ above and run it again.\n` : '\nAll good — add the server to Claude (see mcp/README.md).\n');
process.exit(problems ? 1 : 0);
