// sw.js — offline-capable service worker.
//
// Strategy: NETWORK-FIRST for the app shell + code (HTML/JS/CSS/manifest) so a
// single reload always gets the latest version when you're online, falling back
// to cache when offline. CACHE-FIRST for static images/icons (they rarely change
// and this keeps things fast). Bump CACHE on every release to purge old files.
const CACHE = 'gig-tracker-v9';
const ASSETS = [
  './',
  './index.html',
  './css/app.css',
  './js/app.js',
  './js/store.js',
  './js/charts.js',
  './js/parse.js',
  './js/ocr.js',
  './js/geo.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png',
];

self.addEventListener('install', (e) => {
  // Precache the shell, but DON'T auto-activate — wait in the "installed" state
  // so the page can show an "update available" banner and let the user choose
  // when to switch (avoids reloading out from under someone mid-entry).
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
});

// The page posts this when the user taps "Refresh" on the update banner.
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Never intercept the OCR engine (large, cross-origin) — go straight to network.
  if (url.hostname.includes('jsdelivr') || url.hostname.includes('tesseract')) return;
  if (url.origin !== self.location.origin) return;

  const isAppCode = req.mode === 'navigate'
    || url.pathname === '/'
    || url.pathname.endsWith('/index.html')
    || /\.(?:js|css|webmanifest)$/.test(url.pathname);

  if (isAppCode) {
    // Network-first: fresh on every online reload, cached fallback when offline.
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req).then((c) => c || caches.match('./index.html')))
    );
  } else {
    // Cache-first for images/icons/etc.
    e.respondWith(
      caches.match(req).then((cached) => cached || fetch(req).then((res) => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }))
    );
  }
});
