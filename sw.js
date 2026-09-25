/**
 * Service Worker «Вёрст».
 *
 * - Оболочка приложения (HTML/CSS/JS/шрифты/Leaflet) — cache-first, версия
 *   SHELL_VERSION поднимается GitHub Action при каждом изменении файлов.
 * - Каталог и файлы маршрутов — network-first с таймаутом: при «лежащей»
 *   связи в лесу не ждём минуту, а отдаём сохранённую копию.
 * - Тайлы карты не трогаем: скачанные лежат в IndexedDB (см. js/data/tiles.js).
 */
const SHELL_VERSION = 26;
const SHELL_CACHE = "versty-shell-v" + SHELL_VERSION;
const ROUTES_CACHE = "velotrek-routes"; // имя сохранено: там файлы маршрутов прежней версии
const NETWORK_TIMEOUT_MS = 4000;

const SHELL_FILES = [
  "./",
  "./index.html",
  "./route.html",
  "./manifest.json",
  "./css/app.css",
  "./fonts/onest-cyrillic.woff2",
  "./fonts/onest-latin.woff2",
  "./vendor/leaflet/leaflet.js",
  "./vendor/leaflet/leaflet.css",
  "./icons/icon.svg",
  "./icons/favicon-32x32.png",
  "./icons/icon-192.png",
  "./js/main.js",
  "./js/data/catalog.js",
  "./js/data/downloads.js",
  "./js/data/offline-store.js",
  "./js/data/route.js",
  "./js/data/tiles.js",
  "./js/lib/dom.js",
  "./js/lib/format.js",
  "./js/lib/geo.js",
  "./js/lib/idb.js",
  "./js/lib/sanitize.js",
  "./js/lib/unzip.js",
  "./js/map/leaflet.js",
  "./js/map/route-layer.js",
  "./js/nav/navigator.js",
  "./js/ui/feedback.js",
  "./js/ui/icons.js",
  "./js/ui/route-card.js",
  "./js/ui/sheet.js",
  "./js/views/catalog.js",
  "./js/views/panels.js",
  "./js/views/route.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // cache: "reload" — мимо HTTP-кэша GitHub Pages, чтобы не законсервировать старые файлы
      await cache.addAll(SHELL_FILES.map((url) => new Request(url, { cache: "reload" })));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k !== SHELL_CACHE && k !== ROUTES_CACHE).map((k) => caches.delete(k)),
      );
      if (self.registration.navigationPreload) {
        await self.registration.navigationPreload.disable().catch(() => {});
      }
      await self.clients.claim();
    })(),
  );
});

function isRouteData(url) {
  return (
    url.hostname === "raw.githubusercontent.com" ||
    (url.origin === self.location.origin &&
      url.pathname.includes("/routes/") &&
      /\.(kml|kmz|json)$/i.test(url.pathname))
  );
}

async function networkFirst(request) {
  const cache = await caches.open(ROUTES_CACHE);
  const network = fetch(request, { cache: "no-cache" }).then((response) => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  });
  const cached = await cache.match(request);
  if (!cached) return network;
  // Есть сохранённая копия — ждём сеть не дольше таймаута
  const timeout = new Promise((resolve) => setTimeout(() => resolve(cached), NETWORK_TIMEOUT_MS));
  return Promise.race([network.catch(() => cached), timeout]);
}

async function shellFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request, { ignoreSearch: true });
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok && request.method === "GET") cache.put(request, response.clone());
  return response;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  if (isRouteData(url)) {
    event.respondWith(networkFirst(request));
    return;
  }

  if (url.origin !== self.location.origin) return; // тайлы и прочие внешние запросы — напрямую

  if (request.mode === "navigate") {
    // Одностраничное приложение: любая навигация внутри scope — это index.html
    event.respondWith(
      caches
        .open(SHELL_CACHE)
        .then((c) => c.match(url.pathname.endsWith("route.html") ? "./route.html" : "./index.html"))
        .then((cached) => cached || fetch(request)),
    );
    return;
  }

  event.respondWith(shellFirst(request));
});
