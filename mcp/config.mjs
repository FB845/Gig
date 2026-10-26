// Where the server finds your connection key and keeps its cache.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const NO_KEY = 'No connection key yet. In the Gig Tracker app open Settings → Cloud sync → "Copy Raycast key", then either put it in this server’s env as GIG_TRACKER_KEY (Claude Desktop config) or save it to ~/.config/gig-tracker/key. Details: mcp/README.md.';

export function loadKey() {
  const env = (process.env.GIG_TRACKER_KEY || '').trim();
  if (env) return env;
  const file = process.env.GIG_TRACKER_KEY_FILE || path.join(os.homedir(), '.config', 'gig-tracker', 'key');
  try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; }
}

export const cacheDir = process.env.GIG_CACHE_DIR || path.join(os.homedir(), '.cache', 'gig-tracker-mcp');
const cacheFile = path.join(cacheDir, 'cache.json');

// A JSON file adapter for cloud.js's { get, set } storage. It holds a copy of
// your data, so it's private to you (0600).
let mem = null;
const load = () => {
  if (mem) return mem;
  try { mem = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch { mem = {}; }
  return mem;
};
export const storage = {
  async get(k) { return load()[k]; },
  async set(k, v) {
    load()[k] = v;
    fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    const tmp = `${cacheFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(mem), { mode: 0o600 });
    fs.renameSync(tmp, cacheFile);
  },
};

// Tests point these at a fake Firebase.
export const endpoints = {
  ...(process.env.GIG_TEST_AUTH_URL ? { auth: process.env.GIG_TEST_AUTH_URL } : {}),
  ...(process.env.GIG_TEST_FIRESTORE_URL ? { firestore: process.env.GIG_TEST_FIRESTORE_URL } : {}),
};
// How long a fetched copy counts as fresh (each call re-checks the cloud after this).
export const freshMs = Number(process.env.GIG_FRESH_SECONDS ?? 20) * 1000;
