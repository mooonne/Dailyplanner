// 오늘의 나 - service worker (offline cache)
const CACHE = 'odn-v3';
const ASSETS = ['/', '/index.html', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  // pages: network first so updates show up, cache as fallback (offline)
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put('/', copy)); return res; })
        .catch(() => caches.match('/'))
    );
    return;
  }
  // everything else (icons, fonts): cache first
  e.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res.ok || res.type === 'opaque') { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }))
  );
});

// cloud push (no payload): show the hourly check-in
self.addEventListener('push', e => {
  let body = '지난 시간에 무엇을 했나요? 탭해서 기록하세요';
  try { const d = e.data && e.data.json(); if (d && d.body) body = d.body; } catch (err) {}
  e.waitUntil(self.registration.showNotification('오늘의 나 🔔', {
    body, icon: '/icon-192.png', badge: '/icon-192.png', tag: 'odn-remind', renotify: true,
  }));
});

// tapping a reminder notification opens the app
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) { if ('focus' in c) return c.focus(); }
      return self.clients.openWindow('/');
    })
  );
});
