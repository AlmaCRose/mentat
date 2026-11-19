'use strict';
// Mentat's service worker (the web and phone app). It lets Mentat install to a home screen and open
// without a connection (showing the last copy of the page), and shows phone alerts the Mentat server
// pushes (when you've turned those on). Pages always come from the network first, so a new version
// shows at once; your data (/api/) is never cached here.

const CACHE = 'mentat-app-v1';

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(['/app/', '/app/web.css', '/app/host.js', '/app/mentat-core.js'])).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const u = new URL(req.url);
  if (req.method !== 'GET' || u.origin !== self.location.origin || u.pathname.startsWith('/api/')) return;
  if (!u.pathname.startsWith('/app/') && !u.pathname.startsWith('/assets/')) return;
  e.respondWith(fetch(req).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {}); }
    return res;
  }).catch(() => caches.match(req).then(hit => hit || (req.mode === 'navigate' ? caches.match('/app/') : Response.error()))));
});

// ---- Phone alerts pushed by the Mentat server ----
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { title: 'Mentat', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Mentat', {
    body: d.body || '', tag: d.tag || undefined, renotify: !!d.tag, icon: '/assets/mentat-icon-192.png', badge: '/assets/mentat-icon-192.png',
    data: { url: d.url || '/app/' }, timestamp: d.at || Date.now(),
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/app/';
  e.waitUntil((async () => {
    // A Torn page: open it (in the browser, or Torn PDA via its link). Mentat itself: bring it up.
    if (!url.startsWith('/app/')) return self.clients.openWindow(url);
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const app = open.find(c => new URL(c.url).pathname.startsWith('/app/'));
    if (app) return app.focus();
    return self.clients.openWindow(url);
  })());
});
