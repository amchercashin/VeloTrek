/**
 * Карта VeloTrek.
 * Инициализация Leaflet, кастомный офлайн тайл-слой, отрисовка маршрутов и POI.
 */
const VeloMap = (() => {
  const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  const TILE_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

  let map = null;
  let tileLayer = null;
  let routeLayer = null;
  let poiLayer = null;
  let fullscreenBtn = null;

  // SVG-иконки для кнопки fullscreen — тёмные с белой тенью, читаются на любом фоне
  const FS_STYLE = 'filter:drop-shadow(0 0 2px #fff) drop-shadow(0 1px 2px rgba(0,0,0,.6))';
  const EXPAND_SVG = `<svg style="${FS_STYLE}" viewBox="0 0 24 24" width="22" height="22"><path fill="#111" d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>`;
  const COLLAPSE_SVG = `<svg style="${FS_STYLE}" viewBox="0 0 24 24" width="22" height="22"><path fill="#111" d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/></svg>`;

  // Кастомный тайл-слой с поддержкой офлайн (IndexedDB)
  const OfflineTileLayer = L.TileLayer.extend({
    createTile: function (coords, done) {
      const tile = document.createElement('img');
      tile.alt = '';
      tile.setAttribute('role', 'presentation');

      const key = `${coords.z}/${coords.x}/${coords.y}`;
      const self = this;

      OfflineTiles.getTile(key).then(blob => {
        if (blob) {
          tile.src = URL.createObjectURL(blob);
          done(null, tile);
        } else {
          // Загрузка из сети
          const url = self.getTileUrl(coords);
          fetch(url)
            .then(response => {
              if (!response.ok) throw new Error('Tile fetch failed');
              return response.blob();
            })
            .then(blob => {
              OfflineTiles.putTile(key, blob).catch(() => {});
              tile.src = URL.createObjectURL(blob);
              done(null, tile);
            })
            .catch(() => {
              // Оффлайн и нет кэша — серый placeholder
              tile.src = createPlaceholderTile();
              done(null, tile);
            });
        }
      }).catch(() => {
        // Ошибка IndexedDB — прямая загрузка
        tile.src = self.getTileUrl(coords);
        tile.onload = () => done(null, tile);
        tile.onerror = (e) => {
          tile.src = createPlaceholderTile();
          done(null, tile);
        };
      });

      return tile;
    }
  });

  let placeholderDataUrl = null;
  function createPlaceholderTile() {
    if (placeholderDataUrl) return placeholderDataUrl;
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#e8e8e8';
    ctx.fillRect(0, 0, 256, 256);
    ctx.strokeStyle = '#d0d0d0';
    ctx.lineWidth = 1;
    ctx.strokeRect(0, 0, 256, 256);
    placeholderDataUrl = canvas.toDataURL();
    return placeholderDataUrl;
  }

  function init(containerId, options = {}) {
    map = L.map(containerId, {
      zoomControl: true,
      attributionControl: true,
      ...options
    });

    tileLayer = new OfflineTileLayer(TILE_URL, {
      attribution: TILE_ATTRIBUTION,
      maxZoom: 19,
      crossOrigin: 'anonymous'
    });
    tileLayer.addTo(map);

    // Убираем флаг из attribution prefix (Leaflet 1.9+ добавляет 🇺🇦 SVG)
    map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>');

    // Кнопка полного экрана
    const FullscreenControl = L.Control.extend({
      options: { position: 'topright' },
      onAdd: function () {
        const container = L.DomUtil.create('div', 'leaflet-control leaflet-fullscreen-control');
        fullscreenBtn = L.DomUtil.create('a', 'leaflet-fullscreen-btn', container);
        fullscreenBtn.href = '#';
        fullscreenBtn.role = 'button';
        fullscreenBtn.title = 'Полный экран';
        fullscreenBtn.innerHTML = EXPAND_SVG;
        L.DomEvent.disableClickPropagation(container);
        L.DomEvent.on(fullscreenBtn, 'click', L.DomEvent.preventDefault);
        return container;
      }
    });
    new FullscreenControl().addTo(map);

    // По умолчанию — центр России
    map.setView([55.75, 37.62], 6);

    return map;
  }

  function showRoute(routeData) {
    if (routeLayer) {
      routeLayer.remove();
    }
    if (poiLayer) {
      poiLayer.remove();
    }

    // Полилинии маршрута
    const routeLines = routeData.segments.map(segment => {
      const latlngs = segment.map(([lat, lon]) => [lat, lon]);
      return L.polyline(latlngs, {
        color: '#40916C',
        weight: 5,
        opacity: 0.9,
        lineCap: 'round',
        lineJoin: 'round'
      });
    });
    routeLayer = L.layerGroup(routeLines).addTo(map);

    // POI маркеры
    const poiMarkers = routeData.pois.map(poi => {
      return L.circleMarker([poi.lat, poi.lon], {
        radius: 7,
        fillColor: '#E76F51',
        color: '#ffffff',
        weight: 2,
        fillOpacity: 0.9
      }).bindPopup(
        `<b>${escapeHtml(poi.name)}</b>` +
        (poi.description ? `<br>${escapeHtml(poi.description).substring(0, 200)}` : '')
      );
    });
    poiLayer = L.layerGroup(poiMarkers).addTo(map);

    // Подгоняем карту под маршрут
    if (routeData.bbox.minLat < routeData.bbox.maxLat) {
      map.fitBounds([
        [routeData.bbox.minLat, routeData.bbox.minLon],
        [routeData.bbox.maxLat, routeData.bbox.maxLon]
      ], { padding: [30, 30] });
    }
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function getMap() {
    return map;
  }

  function getTileUrl() {
    return TILE_URL;
  }

  function getFullscreenBtn() {
    return fullscreenBtn;
  }

  function getFullscreenSVGs() {
    return { EXPAND_SVG, COLLAPSE_SVG };
  }

  return { init, showRoute, getMap, getTileUrl, getFullscreenBtn, getFullscreenSVGs };
})();
