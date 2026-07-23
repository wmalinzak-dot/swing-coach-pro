// Service worker: caches the app shell so the page opens offline.
//
// Only same-origin files are cached — the MediaPipe runtime and model come
// from CDNs and are fetched live, so offline mode covers the UI and the
// sample analysis, not video pose detection.

const CACHE = 'scp-v1';
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
  if (url.origin !== location.origin) return; // CDN requests go to the network
  e.respondWith(
    caches.match(e.request).then((cached) => cached || fetch(e.request))
  );
});
