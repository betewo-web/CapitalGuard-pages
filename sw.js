/* ─────────────────────────────────────────────
   台股監控 — Service Worker
   Strategy:
     • HTML navigation  → Network-first (always fetch latest,
                            fall back to cache when offline)
     • CSS / icons      → Cache-first (stable assets)
     • JSON data files  → Pass-through (never cached by SW)
     • Cross-origin     → Pass-through (APIs, CDN, fonts)
───────────────────────────────────────────── */

// Bump version whenever sw.js itself is updated.
const CACHE_VERSION = 'tw-stock-v3';

// Static assets cached for offline CSS/icon support.
// watchlist.html is NOT listed here — it is handled by network-first navigation.
const PRECACHE_STATIC = [
  './watchlist.html',   // pre-fetched once so offline fallback is ready immediately
  './watchlist.css',
  './manifest.json',
  './icons/icon.svg',
  './icons/icon-maskable.svg',
];

// ── Install ─────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(cache => cache.addAll(PRECACHE_STATIC))
      .catch(() => {}) // non-fatal in dev / offline environments
  );
  self.skipWaiting();
});

// ── Activate ────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ── Fetch ───────────────────────────────────────
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // ① Pass-through: all cross-origin requests (APIs, CDN, fonts, etc.)
  if (url.origin !== self.location.origin) return;

  // ② Pass-through: JSON data files (universe.json, report_data_latest.json ...)
  if (url.pathname.endsWith('.json')) return;

  // ③ Network-first: HTML navigation
  //    Always fetches the latest version from the server.
  //    Cached copy is the offline fallback only.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          if (response.ok) {
            // Update the cache with the fresh HTML
            caches.open(CACHE_VERSION).then(c => c.put(event.request, response.clone()));
          }
          return response;
        })
        .catch(async () => {
          // Offline fallback
          return (await caches.match(event.request))
              || (await caches.match('./watchlist.html'))
              || new Response('Offline', { status: 503 });
        })
    );
    return;
  }

  // ④ Cache-first: CSS, icons, manifest
  const assetName = url.pathname.split('/').pop();
  const isCachedAsset = PRECACHE_STATIC.some(a => a.split('/').pop() === assetName);
  if (!isCachedAsset) return; // pass-through anything else

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (response.ok) {
          caches.open(CACHE_VERSION).then(c => c.put(event.request, response.clone()));
        }
        return response;
      }).catch(() => new Response('', { status: 503 }));
    })
  );
});

// ── Web Push: receive push message ───────────────
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data?.json() || {}; } catch {}

  const title = data.title || '台股監控';
  const options = {
    body:     data.body  || '',
    icon:     './icons/icon.svg',
    badge:    './icons/icon.svg',
    data:     { url: data.url || './watchlist.html' },
    tag:      data.tag   || 'stock-alert',
    renotify: true,
    vibrate:  [200, 100, 200],
  };
  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

// ── Web Push: notification click → open/focus PWA ─
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = event.notification.data?.url || './watchlist.html';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      // Focus existing PWA window if open
      for (const c of list) {
        if (c.url.includes('watchlist') && 'focus' in c) return c.focus();
      }
      // Otherwise open a new window
      if (clients.openWindow) return clients.openWindow(target);
    })
  );
});

