// Service worker: keeps the app shell available offline.
//
// Strategy: NETWORK-FIRST with cache fallback. The site auto-deploys on every
// push, so cache-first would pin users to stale code until a manual cache
// bump — with network-first, updates arrive on the next load and the cache
// only serves when the network can't.
//
// Only same-origin files are cached — the MediaPipe runtime and model come
// from CDNs, so offline mode covers the UI and the sample analysis, not
// video pose detection.

const CACHE = 'scp-v2';
const SHELL = [
  './',
  './index.html',
  './app.js',
  './engine.js',
  './pose.js',
  './drills.js',
  './demo.js',
  './manifest.webmanifest',
  './icon.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return; // CDN requests go straight to the network
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        // Keep the cache fresh with whatever the network just served.
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
