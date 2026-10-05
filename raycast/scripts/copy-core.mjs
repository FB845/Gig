// Copy the app's data model into the extension, so Raycast computes goals,
// estimates and suggestions with exactly the same code as the app.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '../../js/store.js');
const dst = path.resolve(here, '../src/lib/store.js');
if (!fs.existsSync(path.resolve(here, '../node_modules/@raycast/api'))) {
  console.error('\n✗ Raycast tools aren’t installed in this folder yet.\n  Run `npm install` here (in raycast/), then `npm run dev` again.\n  (`npm run doctor` checks everything else.)\n');
  process.exit(1);
}
fs.copyFileSync(src, dst);
console.log('copied js/store.js → raycast/src/lib/store.js');
