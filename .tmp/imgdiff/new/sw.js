'use strict';

// Disable offline caching so UI updates are always immediate.
self.addEventListener('install', event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => caches.delete(k)));
    await self.clients.claim();
    await self.registration.unregister();
  })());
});

self.addEventListener('fetch', () => {
  // Intentionally no fetch interception.
});