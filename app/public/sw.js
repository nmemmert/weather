'use strict';

const CACHE = 'weather-v1';

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
