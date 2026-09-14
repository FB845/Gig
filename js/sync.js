// sync.js — OPTIONAL Firebase (Firestore) cloud sync.
//
// Fully opt-in: the app works entirely on-device until the user pastes a
// Firebase config and signs in. The Firebase SDK is only loaded once a config
// exists, and every call is guarded so a failure (offline, bad config, denied
// rules) can never break the local app. The whole DB is stored as one document
// at gigtracker/{uid}; conflicts resolve last-write-wins by `rev`, except the
// first time a device links an account, when local + remote are union-merged so
// neither side's existing entries are lost.
import * as store from './store.js';

const SYNC_KEY = 'gigtracker.sync';       // config lives here, NOT in the synced DB
const FB = 'https://www.gstatic.com/firebasejs/10.12.5';

let cfg = loadCfg();          // { config, email, linkedUid }
let fb = null;                // { app, auth, dbF, authM, fsM }
let userDoc = null;
let unsubSnap = null;
let pushTimer = null;
let applyingRemote = false;

let state = { configured: isConfigured(), signedIn: false, email: cfg.email || '', status: 'idle', error: '' };
const stateListeners = new Set();

function loadCfg() { try { return JSON.parse(localStorage.getItem(SYNC_KEY)) || {}; } catch { return {}; } }
function saveCfg() { localStorage.setItem(SYNC_KEY, JSON.stringify(cfg)); }

export function isConfigured() { return !!(cfg.config && cfg.config.apiKey && cfg.config.projectId); }
export function getSyncState() { return { ...state }; }
export function onSyncState(cb) { stateListeners.add(cb); cb(getSyncState()); return () => stateListeners.delete(cb); }
function setState(patch) { state = { ...state, ...patch }; stateListeners.forEach((f) => f(getSyncState())); }

// Save a Firebase config object and (re)initialize.
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
    const app = appM.initializeApp(cfg.config);
    const auth = authM.getAuth(app);
    const dbF = fsM.getFirestore(app);
    try { await fsM.enableIndexedDbPersistence(dbF); } catch { /* multi-tab or unsupported */ }
    fb = { app, auth, dbF, authM, fsM };
    authM.onAuthStateChanged(auth, onAuth);
  } catch (e) {
    setState({ status: 'error', error: 'Could not load Firebase (needs internet the first time).' });
  }
}

async function onAuth(user) {
  if (unsubSnap) { unsubSnap(); unsubSnap = null; }
  if (!user) { setState({ signedIn: false, status: 'idle' }); return; }
  cfg.email = user.email || ''; saveCfg();
  setState({ signedIn: true, email: cfg.email, status: 'syncing', error: '' });
  const { fsM, dbF } = fb;
  userDoc = fsM.doc(dbF, 'gigtracker', user.uid);

  try {
    const snap = await fsM.getDoc(userDoc);
    const remote = snap.exists() ? snap.data() : null;
    const firstLink = cfg.linkedUid !== user.uid;
    if (firstLink) {
      if (remote && remote.data) store.mergeRemote(remote.data); // union — never lose entries
      cfg.linkedUid = user.uid; saveCfg();
      await push();
    } else if (remote && remote.data && (remote.rev || 0) > store.getRev()) {
      applyRemoteSafe(remote.data);
    } else {
      await push();
    }
  } catch (e) {
    setState({ status: 'error', error: readableErr(e) });
    return;
  }

  // Live updates from other devices.
  unsubSnap = fsM.onSnapshot(userDoc, (snap) => {
    if (!snap.exists() || snap.metadata.hasPendingWrites) return; // ignore our own echoes
    const remote = snap.data();
    if ((remote.rev || 0) > store.getRev()) applyRemoteSafe(remote.data);
    setState({ status: 'synced', error: '' });
  }, (e) => setState({ status: 'error', error: readableErr(e) }));

  setState({ status: 'synced' });
}

function applyRemoteSafe(data) {
  applyingRemote = true;
  try { store.applyRemote(data); } finally { applyingRemote = false; }
}

function schedulePush() {
  clearTimeout(pushTimer);
  setState({ status: 'syncing' });
  pushTimer = setTimeout(push, 700);
}

async function push() {
  if (!fb || !userDoc) return;
  try {
    const { fsM } = fb;
    const data = store.getDB();
    await fsM.setDoc(userDoc, { data, rev: data.rev || Date.now(), updatedAt: fsM.serverTimestamp() });
    setState({ status: 'synced', error: '' });
  } catch (e) {
    setState({ status: 'error', error: readableErr(e) });
  }
}

export async function signIn(email, password) { return authOp('signInWithEmailAndPassword', email, password); }
export async function signUp(email, password) { return authOp('createUserWithEmailAndPassword', email, password); }
async function authOp(op, email, password) {
  if (!fb) await initFirebase();
  if (!fb) throw new Error('Sync isn’t configured yet.');
  cfg.email = email; saveCfg();
  return fb.authM[op](fb.auth, email, password);
}
export async function signOutSync() {
  cfg.linkedUid = null; saveCfg();
  if (unsubSnap) { unsubSnap(); unsubSnap = null; }
  if (fb) await fb.authM.signOut(fb.auth);
  setState({ signedIn: false, status: 'idle' });
}

function readableErr(e) {
  const code = (e && e.code) || '';
  if (code.includes('permission-denied')) return 'Permission denied — check your Firestore security rules.';
  if (code.includes('wrong-password') || code.includes('invalid-credential')) return 'Wrong email or password.';
  if (code.includes('email-already-in-use')) return 'That email already has an account — sign in instead.';
  if (code.includes('weak-password')) return 'Password too weak (min 6 characters).';
  if (code.includes('invalid-email')) return 'That email address looks invalid.';
  if (code.includes('unavailable') || code.includes('network')) return 'Offline — changes will sync when you reconnect.';
  return (e && (e.message || code)) || 'Sync error.';
}

// Push local changes to the cloud (debounced). Registered once; ignores changes
// that originated from a remote apply/merge so we don't echo them back.
store.onChange((_db, origin) => {
  if (origin === 'remote' || origin === 'merge' || applyingRemote) return;
  if (state.signedIn) schedulePush();
});

// Auto-start if the user already configured sync on this device.
if (isConfigured()) initFirebase();
