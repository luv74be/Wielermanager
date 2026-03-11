// Service Worker – Wielermanager
// Cacht de app-shell voor offline gebruik en snellere laadtijden

const CACHE_NAME = 'wielermanager-v1';

// Bestanden die altijd gecacht worden (app shell)
const SHELL_ASSETS = [
  '/',
  '/static/css/style.css',
  '/static/js/app.js',
  '/static/js/teams.js',
  '/static/img/logo-180.png',
  '/static/img/logo-512.png',
  '/static/img/logo.svg',
];

// ── Install: cache app shell ──────────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL_ASSETS))
  );
  self.skipWaiting();
});

// ── Activate: verwijder oude caches ──────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ── Fetch: network-first voor API, cache-first voor assets ───────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // API-calls altijd via netwerk (nooit cachen)
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Statische assets: cache-first, dan netwerk
  if (url.pathname.startsWith('/static/')) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(resp => {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
          return resp;
        });
      })
    );
    return;
  }

  // Hoofd-HTML: network-first, fallback naar cache
  event.respondWith(
    fetch(event.request)
      .then(resp => {
        const clone = resp.clone();
        caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
        return resp;
      })
      .catch(() => caches.match(event.request))
  );
});
