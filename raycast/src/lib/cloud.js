// cloud.js — Gig Tracker's cloud sync for Raycast (plain JS so Node tests can
// run it too). Same Firestore layout and rules as the web app (js/sync.js):
//   users/{uid}/records/{col}~{id} = { col, id, data, deleted, ts, dev }
// Talks to Firebase over REST with the connection key copied from the app
// (Settings → Cloud sync → Copy Raycast key): a refresh token for your
// sign-in, exchanged for short-lived ID tokens.
//
// Records are cached (via the `storage` adapter you pass in), so commands open
// instantly from cache and then fetch only what changed since last time.
import './shim.js';
import * as store from './store.js';

const SKEW_MS = 5 * 60 * 1000;
const COLS = ['shifts', 'expenses', 'trips', 'incomes', 'plans'];

// ---- connection key ----
export function parseKey(key) {
  const k = String(key || '').trim();
  if (!k.startsWith('gt1.')) throw new Error('That isn’t a Gig Tracker key — copy it from the app: Settings → Cloud sync → Copy Raycast key.');
  let json;
  try {
    const b64 = k.slice(4).replace(/-/g, '+').replace(/_/g, '/');
    json = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  } catch { throw new Error('The connection key looks damaged — copy it again from the app.'); }
  if (!json.k || !json.p || !json.r) throw new Error('The connection key is incomplete — copy it again from the app.');
  return { apiKey: json.k, projectId: json.p, refreshToken: json.r, email: json.e || '' };
}

// ---- Firestore value <-> JS ----
function enc(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(enc) } };
  return { mapValue: { fields: encFields(v) } };
}
function encFields(o) {
  const f = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) f[k] = enc(v);
  return f;
}
function dec(v) {
  if (!v || 'nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('stringValue' in v) return v.stringValue;
  if ('timestampValue' in v) return Date.parse(v.timestampValue);
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(dec);
  if ('mapValue' in v) return decFields(v.mapValue.fields || {});
  return null;
}
function decFields(f) {
  const o = {};
  for (const [k, v] of Object.entries(f || {})) o[k] = dec(v);
  return o;
}

// Same stable hash as the web app's sync (key-order independent).
function stable(v) {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}
const same = (a, b) => stable(a) === stable(b);

function localRecords() {
  const db = store.getDB();
  const m = new Map();
  for (const col of COLS) for (const r of db[col]) m.set(`${col}~${r.id}`, { col, id: r.id, data: r });
  m.set('settings~main', { col: 'settings', id: 'main', data: db.settings });
  return m;
}

// ---- client ----
// storage: { get(key) → Promise<string|undefined>, set(key, value) → Promise }
// endpoints (tests): { auth: 'http://localhost:9099', firestore: 'http://localhost:8080' }
export function createCloud({ key, storage, endpoints = {}, deviceId = 'raycast' }) {
  const cfg = parseKey(key);
  const AUTH = endpoints.auth ? `${endpoints.auth}/securetoken.googleapis.com` : 'https://securetoken.googleapis.com';
  const FS = endpoints.firestore || 'https://firestore.googleapis.com';
  const DB = `projects/${cfg.projectId}/databases/(default)/documents`;
  const CACHE = `cache.${cfg.projectId}`;
  let cache = null; // { uid, lastTs, records: { key: { col, id, data, deleted } } }
  let token = null; // { idToken, uid, exp }

  async function readCache() {
    if (cache) return cache;
    try { cache = JSON.parse((await storage.get(CACHE)) || 'null'); } catch { cache = null; }
    if (!cache || !cache.records) cache = { uid: '', lastTs: 0, records: {} };
    return cache;
  }
  const writeCache = () => storage.set(CACHE, JSON.stringify(cache));

  async function auth() {
    if (token && token.exp > Date.now() + 60_000) return token;
    const saved = await storage.get(`token.${cfg.projectId}`);
    if (saved) { try { const t = JSON.parse(saved); if (t.exp > Date.now() + 60_000 && t.rt === cfg.refreshToken) return (token = t); } catch { /* refresh */ } }
    const refresh = (await storage.get(`refresh.${cfg.refreshToken.slice(-12)}`)) || cfg.refreshToken;
    const res = await fetch(`${AUTH}/v1/token?key=${encodeURIComponent(cfg.apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refresh)}`,
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = (j.error && j.error.message) || res.statusText;
      throw new Error(/TOKEN_EXPIRED|INVALID_REFRESH_TOKEN|USER_DISABLED|USER_NOT_FOUND/.test(msg)
        ? 'Your Raycast key has expired or was revoked — copy a new one from the app (Settings → Cloud sync).'
        : `Sign-in failed: ${msg}`);
    }
    if (j.refresh_token && j.refresh_token !== refresh) await storage.set(`refresh.${cfg.refreshToken.slice(-12)}`, j.refresh_token);
    token = { idToken: j.id_token, uid: j.user_id, exp: Date.now() + Number(j.expires_in || 3600) * 1000, rt: cfg.refreshToken };
    await storage.set(`token.${cfg.projectId}`, JSON.stringify(token));
    return token;
  }

  async function api(path, body) {
    const t = await auth();
    const res = await fetch(`${FS}/v1/${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${t.idToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = Array.isArray(j) ? j[0] && j[0].error : j.error;
      throw new Error(res.status === 403 ? 'Permission denied — check the Firestore rules in your Firebase project.' : `Cloud error: ${(e && e.message) || res.statusText}`);
    }
    return j;
  }

  // Load the cached records into the store (synchronous view of your data).
  function loadIntoStore() {
    store.clearAll();
    const changes = Object.values(cache.records).filter((r) => !r.deleted).map((r) => ({ col: r.col, id: r.id, data: r.data }));
    store.applyRecords(changes);
  }

  // Fetch records changed since the last sync (all of them the first time).
  async function pull() {
    await readCache();
    const t = await auth();
    if (cache.uid !== t.uid) cache = { uid: t.uid, lastTs: 0, records: {} };
    const since = new Date(Math.max(0, (cache.lastTs || 0) - SKEW_MS)).toISOString();
    const rows = await api(`${DB}/users/${t.uid}:runQuery`, {
      structuredQuery: {
        from: [{ collectionId: 'records' }],
        where: { fieldFilter: { field: { fieldPath: 'ts' }, op: 'GREATER_THAN', value: { timestampValue: since } } },
        orderBy: [{ field: { fieldPath: 'ts' }, direction: 'ASCENDING' }],
      },
    });
    let n = 0;
    for (const row of rows) {
      if (!row.document) continue;
      const r = decFields(row.document.fields);
      const k = row.document.name.split('/').pop();
      if (r.ts > (cache.lastTs || 0)) cache.lastTs = r.ts;
      cache.records[k] = { col: r.col, id: r.id, data: r.data, deleted: !!r.deleted };
      n++;
    }
    cache.lastSync = Date.now();
    await writeCache();
    loadIntoStore();
    return { changed: n, lastSync: cache.lastSync };
  }

  // Run `fn(store)` (e.g. s => s.addShift({...})) on your current data and
  // upload exactly what it changed — new/edited records, and deletions as
  // tombstones (like the web app). Never runs on an empty, unsynced store.
  async function mutate(fn) {
    await readCache();
    const t = await auth();
    if (!cache.lastSync || cache.uid !== t.uid) await pull();
    loadIntoStore();
    const before = localRecords();
    const result = fn(store);
    const after = localRecords();
    const writes = [];
    for (const [k, r] of after) {
      const b = before.get(k);
      if (!b || !same(b.data, r.data)) writes.push({ k, col: r.col, id: r.id, data: r.data });
    }
    for (const [k, r] of before) if (!after.has(k)) writes.push({ k, col: r.col, id: r.id, data: null });
    for (let i = 0; i < writes.length; i += 400) {
      await api(`${DB}:commit`, {
        writes: writes.slice(i, i + 400).map((w) => ({
          update: { name: `${DB}/users/${t.uid}/records/${w.k}`, fields: encFields({ col: w.col, id: w.id, data: w.data, deleted: !w.data, dev: deviceId }) },
          updateTransforms: [{ fieldPath: 'ts', setToServerValue: 'REQUEST_TIME' }],
        })),
      });
    }
    for (const w of writes) cache.records[w.k] = { col: w.col, id: w.id, data: w.data, deleted: !w.data };
    await writeCache();
    return { result, written: writes.length };
  }

  return {
    store,
    email: cfg.email,
    // Cached data only — instant.
    async open() { await readCache(); loadIntoStore(); return { lastSync: cache.lastSync || 0 }; },
    pull,
    mutate,
  };
}

export { store };
