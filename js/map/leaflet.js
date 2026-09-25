/**
 * Ленивая загрузка Leaflet (локальная копия в vendor/ — работает без сети)
 * и фабрика карты с офлайн-тайлами из IndexedDB.
 */
import { TILE_SOURCE } from "../data/tiles.js";
import { getTile } from "../data/offline-store.js";

let loading = null;

export function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (!loading) {
    // Карту создаём только когда есть и скрипт, и стили: без CSS Leaflet неверно меряет контейнер
    const load = (tag, attrs) =>
      new Promise((resolve, reject) => {
        const node = Object.assign(document.createElement(tag), attrs);
        node.onload = resolve;
        node.onerror = () => reject(new Error("Не удалось загрузить карту"));
        document.head.appendChild(node);
      });
    loading = Promise.all([
      load("link", { rel: "stylesheet", href: "vendor/leaflet/leaflet.css" }),
      load("script", { src: "vendor/leaflet/leaflet.js" }),
    ])
      .then(() => window.L)
      .catch((e) => {
        loading = null;
        throw e;
      });
  }
  return loading;
}

let placeholder = null;
function placeholderTile() {
  if (!placeholder) {
    placeholder =
      "data:image/svg+xml," +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#e9e7df"/><path d="M0 0h256v256" fill="none" stroke="#dcd9cf"/></svg>',
      );
  }
  return placeholder;
}

/**
 * Слой тайлов: сначала IndexedDB (скачанные карты), затем сеть через обычный
 * <img> (браузерный HTTP-кэш, асинхронное декодирование). Просмотренные онлайн
 * тайлы в базу не пишутся — она хранит только то, что пользователь скачал явно.
 */
function createOfflineLayer(L) {
  const Layer = L.TileLayer.extend({
    createTile(coords, done) {
      const img = document.createElement("img");
      img.alt = "";
      img.setAttribute("role", "presentation");
      img.decoding = "async";
      const key = `${coords.z}/${coords.x}/${coords.y}`;
      const url = this.getTileUrl(coords);
      const fromNetwork = () => {
        let retried = false;
        img.onload = () => done(null, img);
        img.onerror = () => {
          // Одна повторная попытка — мобильная сеть часто роняет отдельные запросы
          if (!retried && navigator.onLine) {
            retried = true;
            setTimeout(() => (img.src = url), 1500);
            return;
          }
          img.onerror = null;
          img.src = placeholderTile();
          done(null, img);
        };
        img.src = url;
      };
      getTile(key)
        .then((blob) => {
          if (!blob) return fromNetwork();
          const url = URL.createObjectURL(blob);
          img.onload = () => {
            URL.revokeObjectURL(url);
            done(null, img);
          };
          img.onerror = () => {
            URL.revokeObjectURL(url);
            fromNetwork();
          };
          img.src = url;
        })
        .catch(fromNetwork);
      return img;
    },
  });
  return new Layer(TILE_SOURCE.url, {
    attribution: TILE_SOURCE.attribution,
    maxZoom: TILE_SOURCE.maxZoom,
    // Пока пользователь тянет карту, не грузим промежуточные уровни — экономия батареи и трафика
    updateWhenZooming: false,
    keepBuffer: 3,
  });
}

export async function createMap(container, options = {}) {
  const L = await loadLeaflet();
  const map = L.map(container, {
    zoomControl: false,
    attributionControl: true,
    preferCanvas: true,
    zoomSnap: 0.25,
    wheelPxPerZoomLevel: 90,
    tapTolerance: 20,
    ...options,
  });
  map.attributionControl.setPrefix(false);
  createOfflineLayer(L).addTo(map);
  if (window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
    L.control.zoom({ position: "bottomright", zoomInTitle: "Приблизить", zoomOutTitle: "Отдалить" }).addTo(map);
  }
  // Вид не задаём: вызывающий сразу делает fitBounds — так не грузятся лишние тайлы
  return { L, map };
}
