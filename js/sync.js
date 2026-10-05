// sync.js — OPTIONAL Firebase (Firestore) cloud sync, one document per record.
//
// The app works entirely on-device; sync starts once a Firebase config exists
// (built into js/firebase-config.js, or pasted in Settings) and you sign in.
// The SDK only loads then, and every call is guarded so a failure (offline,
// bad config, denied rules) can never break the local app.
//
// Layout: users/{uid}/records/{col}~{id} = { col, id, data, deleted, ts, dev }
//   col  = shifts | expenses | trips | incomes | plans | settings (id 'main')
//   ts   = server timestamp of the write; devices listen for ts > last seen,
//          so opening the app only downloads what changed.
//   deleted records stay as tombstones so a delete reaches every device.
//
// Each device keeps a "shadow": a hash of every record as last synced. A local
// change is pushed by diffing the store against the shadow (only changed
// records are written). A remote change is applied unless this device has its
// own unpushed edit to that same record — then the local edit wins and is
// pushed. Edits to different records on desktop and phone always both survive.
import * as store from './store.js';
import { FIREBASE_CONFIG } from './firebase-config.js';

const SYNC_KEY = 'gigtracker.sync';           // config + account, NOT synced
const SHADOW_KEY = 'gigtracker.syncShadow';   // { uid, lastTs, h: { key: hash } }
const EMU_KEY = 'gigtracker.syncEmulator';    // tests only: "authHost:port,fsHost:port"
const FB = 'https://www.gstatic.com/firebasejs/10.12.5';
const BATCH = 400;                            // Firestore allows 500 writes/batch
const SKEW_MS = 5 * 60 * 1000;                // re-read a little history on start

let cfg = loadJSON(SYNC_KEY);                 // { config, email, method }
let shadow = loadJSON(SHADOW_KEY);
let fb = null;                                // loaded SDK + handles
let records = null;                           // users/{uid}/records collection
let unsub = null;
let pushTimer = null;
let pushing = false, pushAgain = false;
const deviceId = getDeviceId();

let state = { configured: isConfigured(), builtIn: !!FIREBASE_CONFIG, signedIn: false, email: cfg.email || '', status: 'idle', error: '', lastSync: shadow.lastSync || 0 };
const stateListeners = new Set();

function loadJSON(k) { try { return JSON.parse(localStorage.getItem(k)) || {}; } catch { return {}; } }
function saveCfg() { localStorage.setItem(SYNC_KEY, JSON.stringify(cfg)); }
function saveShadow() { localStorage.setItem(SHADOW_KEY, JSON.stringify(shadow)); }
function getDeviceId() {
  let id = localStorage.getItem('gigtracker.deviceId');
  if (!id) { id = (crypto.randomUUID && crypto.randomUUID()) || String(Math.random()).slice(2); localStorage.setItem('gigtracker.deviceId', id); }
  return id;
}

// Tests point a pasted demo config at the local emulators; otherwise the
// built-in config wins.
function activeConfig() { return (localStorage.getItem(EMU_KEY) && cfg.config) || FIREBASE_CONFIG || cfg.config || null; }
export function isConfigured() { const c = activeConfig(); return !!(c && c.apiKey && c.projectId); }
export function getSyncState() { return { ...state }; }
export function onSyncState(cb) { stateListeners.add(cb); cb(getSyncState()); return () => stateListeners.delete(cb); }
function setState(patch) { state = { ...state, ...patch }; stateListeners.forEach((f) => f(getSyncState())); }

// ---- stable hashing (key order independent) ----
function stable(v) {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}
function hash(v) {
  const s = stable(v);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36) + ':' + s.length;
}

// The store as a flat map of sync keys → { col, id, data }.
function localRecords() {
  const db = store.getDB();
  const m = new Map();
  for (const col of store.SYNC_COLS) for (const r of db[col]) m.set(`${col}~${r.id}`, { col, id: r.id, data: r });
  m.set('settings~main', { col: 'settings', id: 'main', data: db.settings });
  return m;
}

// ---- setup ----
// Paste-a-config path (only used when js/firebase-config.js is empty).
export async function configureSync(configObj) {
  cfg.config = configObj; saveCfg();
  setState({ configured: true, error: '' });
  await initFirebase();
}

async function initFirebase() {
  if (!isConfigured() || fb) return;
  try {
    setState({ status: 'loading', error: '' });
    const [appM, authM, fsM] = await Promise.all([
      import(`${FB}/firebase-app.js`),
      import(`${FB}/firebase-auth.js`),
      import(`${FB}/firebase-firestore.js`),
    ]);
    const app = appM.initializeApp(activeConfig());
    const auth = authM.getAuth(app);
    let dbF;
    try {
      // Offline cache shared across tabs: queued writes survive a reload.
      dbF = fsM.initializeFirestore(app, { localCache: fsM.persistentLocalCache({ tabManager: fsM.persistentMultipleTabManager() }) });
    } catch { dbF = fsM.getFirestore(app); }
    const emu = localStorage.getItem(EMU_KEY);
    if (emu) {
      const [a, f] = emu.split(',');
      authM.connectAuthEmulator(auth, `http://${a}`, { disableWarnings: true });
      const [h, p] = f.split(':'); fsM.connectFirestoreEmulator(dbF, h, Number(p));
    }
    fb = { app, auth, dbF, authM, fsM };
    authM.onAuthStateChanged(auth, onAuth);
  } catch (e) {
    console.warn('Firebase init failed', e);
    setState({ status: 'error', error: 'Could not load Firebase (needs internet the first time).' });
  }
}

async function onAuth(user) {
  if (unsub) { unsub(); unsub = null; }
  if (!user) { records = null; setState({ signedIn: false, status: 'idle' }); return; }
  cfg.email = user.email || ''; saveCfg();
  setState({ signedIn: true, email: cfg.email, status: 'syncing', error: '' });
  const { fsM, dbF } = fb;
  records = fsM.collection(dbF, 'users', user.uid, 'records');
  try {
    if (shadow.uid !== user.uid) await firstLink(user.uid);
    listen();
    await push();
  } catch (e) {
    setState({ status: 'error', error: readableErr(e) });
  }
}

// First sign-in on this device: union this device's records with the cloud's.
// Cloud settings win (a new phone shouldn't reset desktop's settings); for a
// record on both sides with different content, this device's copy is pushed.
// Cloud deletions are honoured.
async function firstLink(uid) {
  const { fsM } = fb;
  shadow = { uid, lastTs: 0, h: {} };
  const snap = await fsM.getDocs(records);
  const local = localRecords();
  const changes = [];
  snap.forEach((d) => {
    const r = d.data();
    const ts = r.ts ? r.ts.toMillis() : 0;
    if (ts > shadow.lastTs) shadow.lastTs = ts;
    if (r.deleted) {
      if (local.has(d.id)) changes.push({ col: r.col, id: r.id, data: null });
      return;
    }
    const mine = local.get(d.id);
    if (mine && r.col !== 'settings' && hash(mine.data) !== hash(r.data)) return; // keep + push ours
    changes.push({ col: r.col, id: r.id, data: r.data });
    shadow.h[d.id] = hash(r.data);
  });
  store.applyRecords(changes);
  saveShadow();
}

// Live changes from other devices (only docs newer than we've seen).
function listen() {
  const { fsM } = fb;
  const since = fsM.Timestamp.fromMillis(Math.max(0, (shadow.lastTs || 0) - SKEW_MS));
  const q = fsM.query(records, fsM.where('ts', '>', since), fsM.orderBy('ts'));
  unsub = fsM.onSnapshot(q, { includeMetadataChanges: false }, (snap) => {
    const local = localRecords();
    const changes = [];
    snap.docChanges().forEach((ch) => {
      if (ch.type === 'removed') return; // left the query window — not a delete
      const d = ch.doc;
      if (d.metadata.hasPendingWrites) return; // our own write echoing back
      const r = d.data();
      const ts = r.ts ? r.ts.toMillis() : 0;
      if (ts > (shadow.lastTs || 0)) shadow.lastTs = ts;
      const k = d.id;
      const mine = local.get(k);
      // This device changed it since the last sync → keep ours; push() sends it.
      if ((mine ? hash(mine.data) : undefined) !== shadow.h[k]) return;
      if (r.deleted) {
        delete shadow.h[k];
        if (mine) changes.push({ col: r.col, id: r.id, data: null });
      } else {
        const h = hash(r.data);
        if (h === shadow.h[k]) return; // already have it
        shadow.h[k] = h;
        changes.push({ col: r.col, id: r.id, data: r.data });
      }
    });
    store.applyRecords(changes);
    shadow.lastSync = Date.now(); saveShadow();
    if (!pushTimer && !pushing) setState({ status: 'synced', error: '', lastSync: shadow.lastSync });
  }, (e) => setState({ status: 'error', error: readableErr(e) }));
}

function schedulePush() {
  clearTimeout(pushTimer);
  setState({ status: 'syncing' });
  pushTimer = setTimeout(() => { pushTimer = null; push(); }, 600);
}

// Write every record that differs from the shadow; tombstone the vanished ones.
async function push() {
  if (!fb || !records) return;
  if (pushing) { pushAgain = true; return; }
  pushing = true;
  try {
    const { fsM, dbF } = fb;
    const local = localRecords();
    const writes = [];
    for (const [k, r] of local) {
      const h = hash(r.data);
      if (shadow.h[k] !== h) writes.push({ k, col: r.col, id: r.id, data: r.data, h });
    }
    for (const k of Object.keys(shadow.h)) {
      if (!local.has(k)) { const [col, ...rest] = k.split('~'); writes.push({ k, col, id: rest.join('~'), data: null }); }
    }
    for (let i = 0; i < writes.length; i += BATCH) {
      const batch = fsM.writeBatch(dbF);
      for (const w of writes.slice(i, i + BATCH)) {
        batch.set(fsM.doc(records, w.k), {
          col: w.col, id: w.id, data: w.data, deleted: !w.data, ts: fsM.serverTimestamp(), dev: deviceId,
        });
      }
      if (!navigator.onLine) setState({ status: 'offline' });
      await batch.commit(); // resolves once the server has it (queued while offline)
      for (const w of writes.slice(i, i + BATCH)) { if (w.data) shadow.h[w.k] = w.h; else delete shadow.h[w.k]; }
      saveShadow();
    }
    shadow.lastSync = Date.now(); saveShadow();
    setState({ status: 'synced', error: '', lastSync: shadow.lastSync });
  } catch (e) {
    setState({ status: 'error', error: readableErr(e) });
  } finally {
    pushing = false;
    if (pushAgain) { pushAgain = false; push(); }
  }
}

// ---- sign-in ----
// Google: popup (works in desktop browsers and mobile Safari). Some home-screen
// web apps can't open the popup — use email/password there (same method on
// every device, so they share one account).
export async function signInGoogle() {
  // The popup must open inside the tap itself; if the SDK is still loading,
  // finish loading and ask for a second tap rather than get the popup blocked.
  if (!fb) {
    await initFirebase();
    const msg = fb ? 'Still connecting — tap Sign in with Google again.' : (state.error || 'Sync isn’t configured yet.');
    setState({ error: msg });
    throw new Error(msg);
  }
  const { authM, auth } = fb;
  cfg.method = 'google'; saveCfg();
  try {
    return await authM.signInWithPopup(auth, new authM.GoogleAuthProvider());
  } catch (e) {
    setState({ error: readableErr(e) });
    throw e;
  }
}
export async function signIn(email, password) { return authOp('signInWithEmailAndPassword', email, password); }
export async function signUp(email, password) { return authOp('createUserWithEmailAndPassword', email, password); }
async function authOp(op, email, password) {
  if (!fb) await initFirebase();
  if (!fb) throw new Error('Sync isn’t configured yet.');
  cfg.email = email; cfg.method = 'email'; saveCfg();
  try { return await fb.authM[op](fb.auth, email, password); }
  catch (e) { setState({ error: readableErr(e) }); throw e; }
}
export async function signOutSync() {
  if (unsub) { unsub(); unsub = null; }
  records = null;
  if (fb) await fb.authM.signOut(fb.auth);
  setState({ signedIn: false, status: 'idle' });
}
// A key for the Raycast extension (or any other trusted client of yours): the
// project's public config plus this sign-in's refresh token, which lets it act
// as you on your own records. Treat it like a password.
export function getConnectionKey() {
  const user = fb && fb.auth.currentUser;
  const c = activeConfig();
  if (!user || !c) return null;
  const json = JSON.stringify({ v: 1, k: c.apiKey, p: c.projectId, r: user.refreshToken, e: user.email || '' });
  return 'gt1.' + btoa(unescape(encodeURIComponent(json))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export async function syncNow() { if (records) { listenRestart(); await push(); } }
function listenRestart() { if (unsub) { unsub(); unsub = null; } listen(); }

function readableErr(e) {
  const code = (e && e.code) || '';
  if (code.includes('permission-denied')) return 'Permission denied — check your Firestore security rules.';
  if (code.includes('wrong-password') || code.includes('invalid-credential')) return 'Wrong email or password.';
  if (code.includes('email-already-in-use')) return 'That email already has an account — sign in instead.';
  if (code.includes('account-exists-with-different-credential')) return 'That email signs in another way — use the same method as your other device.';
  if (code.includes('weak-password')) return 'Password too weak (min 6 characters).';
  if (code.includes('invalid-email')) return 'That email address looks invalid.';
  if (code.includes('popup-blocked') || code.includes('operation-not-supported') || code.includes('web-storage-unsupported')) return 'Google sign-in can’t open here — use email & password instead (on every device).';
  if (code.includes('popup-closed') || code.includes('cancelled-popup')) return 'Sign-in window closed.';
  if (code.includes('unauthorized-domain')) return 'This site isn’t an authorized domain — add it in Firebase → Authentication → Settings.';
  if (code.includes('unavailable') || code.includes('network')) return 'Offline — changes will sync when you reconnect.';
  return (e && (e.message || code)) || 'Sync error.';
}

// Push local changes (debounced). Changes that came from the cloud are already
// in the shadow, so diffing finds nothing to echo back.
store.onChange((_db, origin) => {
  if (origin === 'remote') return;
  if (state.signedIn) schedulePush();
});
window.addEventListener('online', () => { if (state.signedIn) push(); });

// Auto-start when this device already has (or the app ships) a config.
if (isConfigured()) initFirebase();
