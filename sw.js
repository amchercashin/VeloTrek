const CACHE_NAME = 'velotrek-v3';

const SHELL_FILES = [
  './',
  './index.html',
  './route.html',
  './css/style.css',
  './js/app.js',
  './js/route.js',
  './js/map.js',
  './js/kml-parser.js',
  './js/offline.js',
  './js/gps.js',
  './manifest.json',
  './routes/index.json'
];

const CDN_FILES = [
  'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.min.css',
  'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.min.js',
  'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js',
  'https://cdn.jsdelivr.net/npm/idb@8/build/umd.js'
];

// Install — кэшируем shell и CDN
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll([...SHELL_FILES, ...CDN_FILES]);
    })
  );
  self.skipWaiting();
});

// Activate — удаляем старые кэши
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      );
    })
  );
  self.clients.claim();
});

// Fetch
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // НЕ перехватываем тайловые запросы — они идут через IndexedDB в map.js
  if (url.hostname === 'tile.openstreetmap.org' ||
      url.hostname.includes('tile.') ||
      url.pathname.match(/\/\d+\/\d+\/\d+\.(png|jpg|pbf)/)) {
    return;
  }

  // GitHub API — network only (кэшируется в localStorage через app.js)
  if (url.hostname === 'api.github.com') {
    return;
  }

  // KML/KMZ файлы из routes/ — network-first
  if (url.pathname.includes('/routes/') &&
      (url.pathname.endsWith('.kml') || url.pathname.endsWith('.kmz'))) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Raw GitHub content (для загрузки маршрутов) — network-first
  if (url.hostname === 'raw.githubusercontent.com') {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Всё остальное — cache-first
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      });
    })
  );
});
