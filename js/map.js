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
        color: '#0288D1',
        weight: 5,
        opacity: 0.85,
        lineCap: 'round',
        lineJoin: 'round'
      });
    });
    routeLayer = L.layerGroup(routeLines).addTo(map);

    // POI маркеры
    const poiMarkers = routeData.pois.map(poi => {
      return L.circleMarker([poi.lat, poi.lon], {
        radius: 7,
        fillColor: '#DB4436',
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

  return { init, showRoute, getMap, getTileUrl };
})();
