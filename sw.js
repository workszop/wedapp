// Bee Talk service worker: installable + works offline.
// HTML is network-first (so a new deploy shows up immediately when online); everything else is cache-first.
const CACHE = 'bee-talk-v12';
const ASSETS = ['./', 'index.html', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png'];

self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin || new URL(req.url).pathname.includes('/api/')) return;   // API calls always go to the network
  if (req.mode === 'navigate') {
    const isApp = /\/(index\.html)?$/.test(new URL(req.url).pathname);   // only the app shell is cached as index.html, not admin.html or an error page
    e.respondWith(fetch(req).then(r => { if (isApp && r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put('index.html', copy)); } return r; }).catch(() => isApp ? caches.match('index.html') : Response.error()));
    return;
  }
  e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(req, copy)); return r; })));
});
