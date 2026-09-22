/* ─────────────────────────────────────────────
   台股監控 — Service Worker
   Strategy:
     • HTML navigation  → Network-first (always fetch latest,
                            fall back to cache when offline)
     • watchlist.css    → Network-first (must not lag behind the HTML)
     • icons / manifest → Cache-first (stable assets)
     • JSON data files  → Pass-through (never cached by SW)
     • Cross-origin     → Pass-through (APIs, CDN, fonts)
───────────────────────────────────────────── */

// Bump version whenever sw.js itself is updated.
const CACHE_VERSION = 'tw-stock-v143';

// 訂閱輪換用的 Cache：不隨版本清掉，否則升級 SW 就把待同步的訂閱弄丟了。
const PUSH_SYNC_CACHE = 'push-sync';
const PUSH_SYNC_URL   = './__push_sync__';   // 假 URL，只當 Cache 的 key 用
const PUSH_KEY_URL    = './__push_key__';    // 頁面訂閱時寫入的 VAPID 公鑰
const PENDING_ALERT_URL = './__pending_alert__'; // 點通知後要跳去的位置（冷啟動備援）

// Static assets cached for offline CSS/icon support.
// watchlist.html is NOT listed here — it is handled by network-first navigation.
const PRECACHE_STATIC = [
  './watchlist.html',   // pre-fetched once so offline fallback is ready immediately
  './watchlist.css',
  './manifest.json',
  './icons/icon.svg',
  './icons/icon-maskable.svg',
  './icons/icon-192.png',
  './icons/badge-96.png',
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
      Promise.all(keys.filter(k => k !== CACHE_VERSION && k !== PUSH_SYNC_CACHE)
                      .map(k => caches.delete(k)))
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

  const assetName = url.pathname.split('/').pop();

  // ④ Network-first: watchlist.css
  //    HTML 走 network-first、CSS 走 cache-first 的話，部署完的那一刻使用者拿到的
  //    是「新的 HTML ＋ 舊的 CSS」：這一版新加的樣式類別在舊 CSS 裡還不存在，
  //    掛著 .btn 的按鈕就退回 Bootstrap 預設的深色字＋透明底，在深色面板上等於隱形。
  //    真的發生過（自訂規則面板的「新增規則」）。CSS 跟著 HTML 一起走 network-first，
  //    兩邊才不會版本錯開；離線時仍然回退到快取。
  if (assetName === 'watchlist.css') {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          if (response.ok) {
            caches.open(CACHE_VERSION).then(c => c.put(event.request, response.clone()));
          }
          return response;
        })
        // 離線回退要 ignoreSearch：快取裡存的是不帶 ?v= 的那份
        .catch(async () =>
          (await caches.match(event.request, { ignoreSearch: true }))
            || new Response('', { status: 503 }))
    );
    return;
  }

  // ⑤ Cache-first: icons, manifest
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
    // 圖示必須是 PNG：Chromium 的通知圖片解碼器不支援 SVG（桌機與 Android 皆然），
    // 給 SVG 等於整塊圖示空白。iOS 兩個都忽略，直接用主畫面的 App 圖示。
    body:     data.body  || '',
    icon:     data.icon  || './icons/icon-192.png',   // 後端可依訊號帶不同圖示
    badge:    data.badge || './icons/badge-96.png',   // Android 狀態列單色小圖
    data:     { url: data.url || './watchlist.html' },
    tag:      data.tag   || 'stock-alert',        // 每則 alert 帶專屬 tag → 通知各自保留，系統自動堆疊
    renotify: true,
    vibrate:  [200, 100, 200],
  };
  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

// ── Web Push: 訂閱輪換 ────────────────────────────────────────
// Safari / iOS 會定期換掉 push 訂閱，Chrome 在還原資料或權限異動時也會。
// 沒有這個 handler 的話，舊 endpoint 失效、新的沒人回報後端，
// 通知就此靜音，而且沒有任何錯誤訊息——iPhone 上最常見。
//
// SW 讀不到 localStorage，拿不到使用者的 access token，因此無法自己寫回
// Supabase。這裡負責「立刻重新訂閱」並把結果留在 Cache，
// 由頁面下次開啟時（那時才有 token）補寫進資料庫。
function _b64ToUint8Array(b64) {
  const pad = '='.repeat((4 - b64.length % 4) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

self.addEventListener('pushsubscriptionchange', event => {
  event.waitUntil((async () => {
    const oldEndpoint = event.oldSubscription?.endpoint || null;
    let sub = event.newSubscription || null;

    if (!sub) {
      // 部分瀏覽器只給 oldSubscription，得自己重新訂閱
      let key = event.oldSubscription?.options?.applicationServerKey || null;
      if (!key) {
        try {
          const cache = await caches.open(PUSH_SYNC_CACHE);
          const res = await cache.match(PUSH_KEY_URL);
          if (res) key = _b64ToUint8Array(await res.text());
        } catch { /* 沒有金鑰就放棄，頁面開啟時的保險機制會補訂閱 */ }
      }
      if (!key) return;
      try {
        sub = await self.registration.pushManager.subscribe({
          userVisibleOnly: true, applicationServerKey: key,
        });
      } catch { return; }
    }

    try {
      const cache = await caches.open(PUSH_SYNC_CACHE);
      await cache.put(PUSH_SYNC_URL, new Response(JSON.stringify({
        oldEndpoint, subscription: sub.toJSON(),
      }), { headers: { 'Content-Type': 'application/json' } }));
    } catch { /* 寫不進去也還有頁面端的比對機制 */ }

    // 頁面正開著就叫它立刻同步，不必等下次啟動
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of list) c.postMessage({ type: 'push-subscription-changed' });
  })());
});

// ── Web Push: notification click → open/focus PWA ─
// 後端把 event_key 放進網址（?alert=…#inbox）。視窗沒開：直接用這個網址開，
// 頁面開機時讀到參數就切到通知頁並把該則置中。視窗已開：只 focus 的話畫面
// 會停在使用者上次離開的地方，所以再 postMessage 把網址交給頁面，由頁面自己跳。
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = event.notification.data?.url || './watchlist.html';
  const at = Date.now();   // 這一次點擊的識別：頁面用它避免「訊息」與「Cache 備援」兩條路各跳一次
  event.waitUntil((async () => {
    // 備援：iOS 從通知啟動主畫面 App 時常忽略 openWindow 的網址，直接開
    // manifest 的 start_url，?alert= 就這樣掉了；視窗在背景被系統凍結時
    // postMessage 也可能石沉大海。先把目標寫進 Cache，頁面開機或回前景時
    // 若沒收到訊息就來這裡拿（只認 60 秒內的，用完即刪）。
    try {
      const cache = await caches.open(PUSH_SYNC_CACHE);
      await cache.put(PENDING_ALERT_URL, new Response(
        JSON.stringify({ url: target, at }),
        { headers: { 'Content-Type': 'application/json' } }));
    } catch { /* 沒有 Cache 也還有網址那條路 */ }

    const list = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    // 視窗已開：先送訊息再 focus。iOS 偶爾會留下已被系統回收的殭屍 client，
    // focus 會失敗——那就改走開新視窗，別讓點擊沒有任何反應。
    for (const c of list) {
      if (c.url.includes('watchlist') && 'focus' in c) {
        try { c.postMessage({ type: 'notification-click', url: target, at }); } catch { /* 頁面已不在 */ }
        try {
          await c.focus();
          return;
        } catch { /* 殭屍 client：往下開新視窗 */ }
      }
    }
    if (clients.openWindow) {
      try { await clients.openWindow(target); } catch { /* 開不了也還有 Cache 備援 */ }
    }
  })());
});

