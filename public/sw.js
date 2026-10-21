// Hush service worker.
//
// Its only job is to receive a push and show it. There is no offline cache and
// no background sync — an anonymous inbox is not something you want mirrored to
// disk on the device, and a cache would quietly do exactly that.

self.addEventListener('install', (event) => {
  // Take over as soon as possible; there is no cached state to migrate.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let payload = { title: 'a slip arrived', body: 'someone wrote to you.', url: '/' };

  if (event.data) {
    try {
      payload = { ...payload, ...event.data.json() };
    } catch {
      // A malformed payload must not throw inside the worker; fall back to the
      // generic notification so the owner still learns something arrived.
    }
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      tag: payload.tag ?? 'hush',
      // Replacing rather than stacking: five unread messages are still one
      // "you have messages" fact, and a wall of notifications on a lock screen
      // is exactly the wrong thing for a private app.
      renotify: true,
      icon: '/favicon.svg',
      badge: '/favicon.svg',
      data: { url: payload.url ?? '/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const target = new URL(event.notification.data?.url ?? '/', self.location.origin).href;

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });

      // Reuse a tab that is already on this origin rather than opening another.
      for (const client of windows) {
        if (new URL(client.url).origin === self.location.origin) {
          await client.focus();
          if ('navigate' in client) await client.navigate(target);
          return;
        }
      }

      await self.clients.openWindow(target);
    })(),
  );
});
