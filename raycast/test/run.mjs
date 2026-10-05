// Bundle test/render.tsx with @raycast/api swapped for the mock, then run it.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
execFileSync('node', [path.join(here, '../scripts/copy-core.mjs')], { stdio: 'inherit' });
const out = path.join(here, '.render.cjs');
await build({
  entryPoints: [path.join(here, 'render.tsx')], bundle: true, platform: 'node', format: 'cjs', outfile: out,
  jsx: 'automatic', alias: { '@raycast/api': path.join(here, 'raycast-mock.tsx') }, logLevel: 'error',
});
execFileSync('node', [out], { stdio: 'inherit' });
