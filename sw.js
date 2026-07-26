/* ─────────────────────────────────────────────
   台股監控 — Service Worker
   Strategy:
     • Static shell only (html/css/icons/manifest)
       → Cache-first with network fallback
     • Everything else (JSON data, all APIs, CDN)
       → Pass-through: SW does NOT intercept
   This keeps the SW minimal and ensures no
   interference with live data fetching.
───────────────────────────────────────────── */

const CACHE_VERSION = 'tw-stock-v2';

// Only these explicitly-listed static files are cached.
// JSON data files and APIs are intentionally excluded.
const STATIC_SHELL = [
  './watchlist.html',
  './watchlist.css',
  './manifest.json',
  './icons/icon.svg',
  './icons/icon-maskable.svg',
];

// ── Install: pre-cache static shell ──────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(cache => cache.addAll(STATIC_SHELL))
      .catch(() => { /* non-fatal in dev */ })
  );
  self.skipWaiting();
});

// ── Activate: clean up old caches ────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_VERSION)
          .map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// ── Fetch: only intercept pre-cached shell ────
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // Pass-through: anything that is not same-origin static shell
  // (APIs, JSON data files, CDN, fonts, external services)
  if (url.origin !== self.location.origin) return;

  // Pass-through: JSON data files — always fetch fresh from server
  const path = url.pathname;
  if (path.endsWith('.json')) return;

  // Pass-through: anything outside the SW scope path
  // Only serve cache for exactly the pre-cached files
  const isShellFile = STATIC_SHELL.some(asset => {
    // Normalise: remove leading './' from asset path
    const assetPath = asset.replace(/^\.\//,'');
    return path.endsWith('/' + assetPath) || path === '/' + assetPath
      || path.endsWith(assetPath);
  });
  if (!isShellFile) return;

  // Cache-first for shell files
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (response.ok) {
          caches.open(CACHE_VERSION).then(c => c.put(event.request, response.clone()));
        }
        return response;
      }).catch(() => {
        // Offline fallback for navigation requests
        if (event.request.mode === 'navigate') {
          return caches.match('./watchlist.html');
        }
        return new Response('', { status: 503 });
      });
    })
  );
});

