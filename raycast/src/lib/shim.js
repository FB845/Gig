// store.js (copied from the app) keeps its database in `localStorage`. Raycast
// commands run in Node, so give it an in-memory one before it loads; the real
// persistence is the cloud cache in cloud.js.
if (typeof globalThis.localStorage === 'undefined') {
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
    clear: () => mem.clear(),
  };
}
