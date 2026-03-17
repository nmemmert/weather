'use strict';

self.addEventListener('message', event => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

const CACHE = 'weather-v5';

// App shell cached on install for offline resilience.
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
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Never intercept API/tile traffic.
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

  const isShell =
    request.mode === 'navigate' ||
    request.destination === 'document' ||
    request.destination === 'script' ||
    request.destination === 'style';

  if (isShell) {
    // Network-first keeps app updates fresh; cache as fallback.
    event.respondWith(
      fetch(request)
        .then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE).then(cache => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => caches.match(request).then(cached => cached || caches.match('/')))
    );
    return;
  }

  // Cache-first for static assets.
  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(response => {
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