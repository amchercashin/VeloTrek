/**
 * Отрисовка маршрута на карте: основной трек с обводкой, варианты пунктиром,
 * старт/финиш и точки интереса.
 */
import { esc } from "../lib/dom.js";
import { haversine } from "../lib/geo.js";

export const cssVar = (name) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function flagIcon(L, kind, label) {
  return L.divIcon({
    className: "map-flag",
    html: `<span class="map-flag__pin map-flag__pin--${kind}" aria-label="${esc(label)}"></span>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  });
}

export function drawRoute(L, map, route, { onPoiClick } = {}) {
  const group = L.featureGroup();
  const renderer = L.canvas({ padding: 0.4, tolerance: 8 });
  const color = cssVar("--route") || "#f0561d";
  const casing = cssVar("--route-casing") || "#ffffff";

  // Сначала варианты (под основным), потом основной трек
  const order = route.segments
    .map((seg, i) => ({ seg, main: route.mainSegments?.[i] ?? true }))
    .sort((a, b) => Number(a.main) - Number(b.main));

  for (const { seg, main } of order) {
    if (seg.length < 2) continue;
    if (main) {
      L.polyline(seg, { renderer, color: casing, weight: 9, opacity: 0.95, interactive: false }).addTo(group);
      L.polyline(seg, { renderer, color, weight: 5, opacity: 1, interactive: false }).addTo(group);
    } else {
      L.polyline(seg, { renderer, color: casing, weight: 6, opacity: 0.8, interactive: false }).addTo(group);
      L.polyline(seg, {
        renderer, color, weight: 3, opacity: 0.9, dashArray: "2 7", lineCap: "round", interactive: false,
      }).addTo(group);
    }
  }

  // Старт и финиш основного трека; кольцевой маршрут — одна метка
  const mainIdx = route.lengths?.length
    ? route.lengths.indexOf(Math.max(...route.lengths))
    : 0;
  const main = route.segments[mainIdx];
  if (main?.length > 1) {
    const a = main[0];
    const b = main[main.length - 1];
    const loop = haversine(a[0], a[1], b[0], b[1]) < 300;
    L.marker(a, { icon: flagIcon(L, loop ? "loop" : "start", "Старт"), keyboard: false, zIndexOffset: 500 }).addTo(group);
    if (!loop) L.marker(b, { icon: flagIcon(L, "finish", "Финиш"), keyboard: false, zIndexOffset: 500 }).addTo(group);
  }

  const poiMarkers = route.pois.map((poi, i) => {
    const m = L.circleMarker([poi.lat, poi.lon], {
      renderer,
      radius: 6,
      color: cssVar("--poi-ring") || "#fff",
      weight: 2.5,
      fillColor: cssVar("--poi") || "#16362a",
      fillOpacity: 1,
    });
    m.bindPopup(
      `<strong>${esc(poi.name || "Точка")}</strong>` +
        (poi.description ? `<p>${esc(stripTags(poi.description).slice(0, 280))}</p>` : ""),
      { closeButton: false, maxWidth: 260, autoPanPaddingTopLeft: [16, 80], autoPanPaddingBottomRight: [16, 200] },
    );
    m.on("click", () => onPoiClick?.(i));
    m.addTo(group);
    return m;
  });

  group.addTo(map);
  return { group, poiMarkers };
}

function stripTags(html) {
  const t = document.createElement("template");
  t.innerHTML = html.replace(/<br\s*\/?>/gi, " ");
  return (t.content.textContent || "").replace(/\s+/g, " ").trim();
}

export function boundsOf(L, bbox) {
  return L.latLngBounds([bbox.minLat, bbox.minLon], [bbox.maxLat, bbox.maxLon]);
}
