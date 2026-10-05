// npm run doctor — why can't `npm run dev` find Raycast? Checks the things the
// Raycast CLI depends on and says what to do about each.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m, fix) => { console.log('  ✗ ' + m + (fix ? `\n      → ${fix}` : '')); problems++; };
const run = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
let problems = 0;

console.log('\nGig Tracker · Raycast doctor\n');

// 1. macOS
if (process.platform === 'darwin') ok(`macOS ${run('sw_vers', ['-productVersion'])}`);
else bad(`this is ${process.platform}, not macOS`, 'run it on the Mac where Raycast is installed');

// 2. Node
const need = [22, 22, 2];
const have = process.versions.node.split('.').map(Number);
const newer = have[0] !== need[0] ? have[0] > need[0] : have[1] !== need[1] ? have[1] > need[1] : have[2] >= need[2];
if (newer) ok(`Node ${process.versions.node}`);
else bad(`Node ${process.versions.node} — the Raycast API here needs ${need.join('.')} or newer`, 'install the current Node 22 LTS (nodejs.org or `brew upgrade node`), then `npm install` again');

// 3. dependencies
const api = path.join(here, 'node_modules/@raycast/api/package.json');
if (fs.existsSync(api)) ok(`@raycast/api ${JSON.parse(fs.readFileSync(api, 'utf8')).version} installed`);
else bad('dependencies not installed', 'run `npm install` in the raycast folder');

// 4. Raycast app(s) installed — and their bundle IDs / versions
if (process.platform === 'darwin') {
  const apps = run('mdfind', ["kMDItemCFBundleIdentifier == 'com.raycast.macos*'"]).split('\n').filter(Boolean);
  for (const p of ['/Applications/Raycast.app', path.join(os.homedir(), 'Applications/Raycast.app')]) if (fs.existsSync(p) && !apps.includes(p)) apps.push(p);
  if (!apps.length) bad('no Raycast app found', 'install Raycast from raycast.com');
  const ids = [];
  for (const a of apps) {
    const plist = path.join(a, 'Contents/Info');
    const id = run('defaults', ['read', plist, 'CFBundleIdentifier']);
    const ver = run('defaults', ['read', plist, 'CFBundleShortVersionString']);
    ids.push(id);
    ok(`found ${a} (${id || '?'}, v${ver || '?'})`);
  }
  // 5. running? The CLI looks for com.raycast.macos (or RAY_Target's flavour).
  const target = process.env.RAY_Target;
  const want = target && target !== 'x' ? `com.raycast.macos.${target === 'debug' || target === 'x-development' ? 'development' : target === 'x-internal' ? 'internal' : target}` : 'com.raycast.macos';
  if (run('/usr/bin/lsappinfo', ['find', `bundleid=${want}`])) ok(`Raycast (${want}) is running`);
  else {
    const other = ids.find((id) => id && id !== want && run('/usr/bin/lsappinfo', ['find', `bundleid=${id}`]));
    if (other) bad(`the running Raycast is ${other}, but the CLI talks to ${want}`, `run \`RAY_Target=${other.replace('com.raycast.macos.', '')} npm run dev\`, or use Raycast's "Import Extension" command instead (below)`);
    else bad(`Raycast (${want}) isn't running`, 'open Raycast first, then `npm run dev`');
  }
}

// 6. extension manifest sanity
const pkg = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8'));
if (pkg.name && pkg.commands?.length) ok(`extension "${pkg.title}" with ${pkg.commands.length} commands`);
else bad('package.json is missing name/commands');

console.log(problems
  ? `\n${problems} thing${problems === 1 ? '' : 's'} to fix. Also works without the CLI: open Raycast → run "Import Extension" → choose this raycast folder.\n`
  : '\nAll good. Run `npm run dev` with Raycast open; the commands appear in Raycast as "Campaign 350", "Log Shift", … (search "Gig").\nNo luck? Raycast → "Import Extension" → choose this raycast folder.\n');
process.exit(problems ? 1 : 0);
