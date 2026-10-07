// wOS service worker: Web Push alerts with answer buttons, and opening the right screen on a tap.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data.json(); } catch { d = { title: 'wOS', body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'wOS', { body: d.body || '', tag: d.tag, icon: '/icon-192.png', badge: '/icon-192.png', data: { url: d.url || '/inbox' }, actions: d.actions || [] }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  // Buttons on the notification open the inbox at that alert; answering takes a press there (or 1, 2, 3).
  const url = e.notification.data && e.notification.data.url ? e.notification.data.url : '/inbox';
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) { if ('focus' in c) { await c.navigate(url).catch(() => {}); return c.focus(); } }
    return self.clients.openWindow(url);
  })());
});
