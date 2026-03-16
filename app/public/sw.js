'use strict';

const CACHE = 'weather-v2';

// App shell — cached on install for offline use
const PRECACHE = [
  '/',
  '/app.js',
  '/style.css',
  '/manifest.json',
  '/icons/icon.svg'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET, API calls, and map/radar tile requests
  if (
    request.method !== 'GET' ||
    url.pathname.startsWith('/api/') ||
    url.hostname.includes('rainviewer') ||
    url.hostname.includes('openstreetmap') ||
    url.hostname.includes('cartodb') ||
    url.hostname.includes('basemaps')
  ) {
    return;
  }

  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(response => {
        // Only cache successful same-origin and trusted CDN responses
        if (response.ok && (
          url.origin === self.location.origin ||
          url.hostname.includes('googleapis') ||
          url.hostname.includes('gstatic') ||
          url.hostname.includes('unpkg.com')
        )) {
          const clone = response.clone();
          caches.open(CACHE).then(cache => cache.put(request, clone));
        }
        return response;
      });
    })
  );
});

self.addEventListener('push', event => {
  let payload = { title: 'Weather alert', body: 'New weather update available.', url: '/' };
  try {
    const data = event.data ? event.data.json() : null;
    if (data) payload = { ...payload, ...data };
  } catch {
    // Ignore malformed payload and use defaults.
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: '/icons/icon.svg',
      badge: '/icons/icon.svg',
      data: { url: payload.url || '/' },
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = event.notification?.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      const existing = windowClients.find(c => c.url.includes(self.location.origin));
      if (existing) {
        existing.focus();
        existing.navigate(target);
        return;
      }
      return clients.openWindow(target);
    })
  );
});
