const SHELL_VERSION = 20;
const SHELL_CACHE = "velotrek-shell-v" + SHELL_VERSION;
const ROUTES_CACHE = "velotrek-routes";

const SHELL_FILES = [
  "./",
  "./index.html",
  "./route.html",
  "./css/style.css",
  "./js/app.js",
  "./js/route.js",
  "./js/map.js",
  "./js/kml-parser.js",
  "./js/offline.js",
  "./js/gps.js",
  "./manifest.json",
];

const CDN_FILES = [
  "https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.min.css",
  "https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.min.js",
  "https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js",
  "https://cdn.jsdelivr.net/npm/idb@8/build/umd.js",
];

// Install — кэшируем shell и CDN
self.addEventListener("install", (event) => {
  const bust = "?_sw=" + SHELL_CACHE;
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => {
      const cdnPromise = cache.addAll(CDN_FILES);
      const shellPromise = Promise.all(
        SHELL_FILES.map((url) =>
          fetch(url + bust, { cache: "no-cache" }).then((resp) => {
            if (!resp.ok) throw new Error(url);
            return cache.put(url, resp);
          }),
        ),
      );
      return Promise.all([cdnPromise, shellPromise]);
    }),
  );
  self.skipWaiting();
});

// Activate — миграция маршрутов из старого кэша, очистка
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();

      // Миграция: перенести KML/KMZ/index.json из старого единого кэша velotrek-vN
      for (const key of keys) {
        if (/^velotrek-v\d+$/.test(key)) {
          await migrateRoutesFromOldCache(key);
        }
      }

      // Удалить все кэши кроме текущего shell и routes
      const allKeys = await caches.keys();
      await Promise.all(
        allKeys
          .filter((k) => k !== SHELL_CACHE && k !== ROUTES_CACHE)
          .map((k) => caches.delete(k)),
      );

      await self.clients.claim();

      // Уведомить клиентов об обновлении
      const clients = await self.clients.matchAll({ type: "window" });
      for (const client of clients) {
        client.postMessage({ type: "SW_UPDATED", version: SHELL_VERSION });
      }
    })(),
  );
});

async function migrateRoutesFromOldCache(oldCacheName) {
  const oldCache = await caches.open(oldCacheName);
  const routesCache = await caches.open(ROUTES_CACHE);
  const requests = await oldCache.keys();

  for (const request of requests) {
    const url = new URL(request.url);
    const isRoute =
      url.pathname.endsWith(".kml") ||
      url.pathname.endsWith(".kmz") ||
      url.pathname.endsWith("index.json") ||
      url.hostname === "raw.githubusercontent.com";
    if (isRoute) {
      const response = await oldCache.match(request);
      if (response) {
        await routesCache.put(request, response);
      }
    }
  }
}

// Fetch
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // НЕ перехватываем тайловые запросы — они идут через IndexedDB в map.js
  if (
    url.hostname === "tile.openstreetmap.org" ||
    url.hostname.includes("tile.") ||
    url.pathname.match(/\/\d+\/\d+\/\d+\.(png|jpg|pbf)/)
  ) {
    return;
  }

  // GitHub API — network only (кэшируется в localStorage через app.js)
  if (url.hostname === "api.github.com") {
    return;
  }

  // index.json — network-first → ROUTES_CACHE
  if (
    url.pathname.endsWith("/routes/index.json") ||
    url.pathname.endsWith("index.json")
  ) {
    event.respondWith(networkFirst(event.request, ROUTES_CACHE));
    return;
  }

  // KML/KMZ файлы из routes/ — network-first → ROUTES_CACHE
  if (
    url.pathname.includes("/routes/") &&
    (url.pathname.endsWith(".kml") || url.pathname.endsWith(".kmz"))
  ) {
    event.respondWith(networkFirst(event.request, ROUTES_CACHE));
    return;
  }

  // Raw GitHub content (маршруты) — network-first → ROUTES_CACHE
  if (url.hostname === "raw.githubusercontent.com") {
    event.respondWith(networkFirst(event.request, ROUTES_CACHE));
    return;
  }

  // Всё остальное — cache-first (app shell)
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches
            .open(SHELL_CACHE)
            .then((cache) => cache.put(event.request, clone));
        }
        return response;
      });
    }),
  );
});

function networkFirst(request, cacheName) {
  return fetch(request, { cache: "no-cache" })
    .then((response) => {
      const clone = response.clone();
      caches.open(cacheName).then((cache) => cache.put(request, clone));
      return response;
    })
    .catch(() => caches.match(request));
}

// Message API — запросы от клиентов
self.addEventListener("message", (event) => {
  const { type, payload } = event.data || {};
  const port = (event.ports && event.ports[0]) || null;

  function reply(data) {
    if (port) port.postMessage(data);
    else if (event.source) event.source.postMessage(data);
  }

  if (type === "CHECK_ROUTE_CACHED") {
    event.waitUntil(
      (async () => {
        const cache = await caches.open(ROUTES_CACHE);
        const response = await cache.match(payload.url);
        reply({
          type: "ROUTE_CACHE_STATUS",
          payload: { url: payload.url, cached: !!response },
        });
      })(),
    );
  }

  if (type === "CACHE_ROUTE") {
    event.waitUntil(
      (async () => {
        try {
          const cache = await caches.open(ROUTES_CACHE);
          const response = await fetch(payload.url);
          if (response.ok) {
            await cache.put(payload.url, response);
            reply({
              type: "ROUTE_CACHED",
              payload: { url: payload.url, success: true },
            });
          } else {
            reply({
              type: "ROUTE_CACHED",
              payload: { url: payload.url, success: false },
            });
          }
        } catch (e) {
          reply({
            type: "ROUTE_CACHED",
            payload: { url: payload.url, success: false, error: e.message },
          });
        }
      })(),
    );
  }
});
