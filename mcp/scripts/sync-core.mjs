// Copy the app's data model and the Raycast cloud client into mcp/lib/, so this
// server computes goals, estimates and digests with exactly the same code as
// the app and Raycast. Runs on `npm install` (prepare) and before `npm test`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const lib = path.resolve(root, 'mcp/lib');
const files = [
  ['js/store.js', 'store.js'],
  ['js/plugins/weekly-summary.js', 'weekly-summary.js'],
  ['raycast/src/lib/cloud.js', 'cloud.js'],
  ['raycast/src/lib/shim.js', 'shim.js'],
];
fs.mkdirSync(lib, { recursive: true });
for (const [from, to] of files) {
  const src = path.join(root, from);
  if (!fs.existsSync(src)) {
    console.error(`✗ ${from} not found — this folder must stay inside the Gig repo (mcp/ next to js/ and raycast/).`);
    process.exit(1);
  }
  fs.copyFileSync(src, path.join(lib, to));
}
console.log('copied the app’s data model into mcp/lib/');
