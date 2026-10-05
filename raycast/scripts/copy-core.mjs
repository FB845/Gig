// Copy the app's data model into the extension, so Raycast computes goals,
// estimates and suggestions with exactly the same code as the app.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '../../js/store.js');
const dst = path.resolve(here, '../src/lib/store.js');
fs.copyFileSync(src, dst);
console.log('copied js/store.js → raycast/src/lib/store.js');
