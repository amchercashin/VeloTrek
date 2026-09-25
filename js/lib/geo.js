/**
 * Геометрия на сфере и в локальной проекции.
 * Точки маршрута — массивы [lat, lon, ele?].
 */

const R = 6371008.8;
const RAD = Math.PI / 180;

export function haversine(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * RAD;
  const dLon = (lon2 - lon1) * RAD;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Азимут из точки 1 в точку 2, градусы от севера по часовой. */
export function bearing(lat1, lon1, lat2, lon2) {
  const φ1 = lat1 * RAD;
  const φ2 = lat2 * RAD;
  const Δλ = (lon2 - lon1) * RAD;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((Math.atan2(y, x) / RAD) + 360) % 360;
}

export function lineLength(points) {
  let d = 0;
  for (let i = 1; i < points.length; i++) {
    d += haversine(points[i - 1][0], points[i - 1][1], points[i][0], points[i][1]);
  }
  return d;
}

export function bboxOf(segments, extraPoints = []) {
  const b = { minLat: 90, maxLat: -90, minLon: 180, maxLon: -180 };
  const add = (lat, lon) => {
    if (lat < b.minLat) b.minLat = lat;
    if (lat > b.maxLat) b.maxLat = lat;
    if (lon < b.minLon) b.minLon = lon;
    if (lon > b.maxLon) b.maxLon = lon;
  };
  for (const seg of segments) for (const p of seg) add(p[0], p[1]);
  for (const p of extraPoints) add(p.lat, p.lon);
  return b.minLat <= b.maxLat ? b : null;
}

/**
 * Индекс трека для навигации: накопленные расстояния по каждому сегменту,
 * чтобы по ближайшей проекции сразу знать «км N из M».
 */
export function buildTrackIndex(segments) {
  return segments.map((points) => {
    const cum = new Float64Array(points.length);
    for (let i = 1; i < points.length; i++) {
      cum[i] =
        cum[i - 1] +
        haversine(points[i - 1][0], points[i - 1][1], points[i][0], points[i][1]);
    }
    return { points, cum, length: cum[cum.length - 1] || 0 };
  });
}

/**
 * Ближайшая точка трека к (lat, lon) — проекция на отрезки, а не на вершины:
 * при редких точках (200–300 м) расстояние до вершин сильно завышено.
 */
export function nearestOnTrack(index, lat, lon) {
  const kx = 111320 * Math.cos(lat * RAD);
  const ky = 110574;
  let best = null;
  let bestD2 = Infinity;

  for (let s = 0; s < index.length; s++) {
    const { points, cum, length } = index[s];
    if (points.length === 1) {
      const dx = (points[0][1] - lon) * kx;
      const dy = (points[0][0] - lat) * ky;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = { segment: s, along: 0, segmentLength: length, point: points[0] };
      }
      continue;
    }
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      const ax = (a[1] - lon) * kx;
      const ay = (a[0] - lat) * ky;
      const dx = (b[1] - a[1]) * kx;
      const dy = (b[0] - a[0]) * ky;
      const len2 = dx * dx + dy * dy;
      const t = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
      const px = ax + dx * t;
      const py = ay + dy * t;
      const d2 = px * px + py * py;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = {
          segment: s,
          along: cum[i - 1] + (cum[i] - cum[i - 1]) * t,
          segmentLength: length,
          point: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t],
        };
      }
    }
  }

  if (!best) return null;
  best.distance = Math.sqrt(bestD2);
  return best;
}

/** Декодирует Google Encoded Polyline в [[lat, lon], ...]. */
export function decodePolyline(str, precision = 5) {
  const factor = 10 ** precision;
  const out = [];
  let index = 0;
  let lat = 0;
  let lon = 0;
  while (index < str.length) {
    for (let k = 0; k < 2; k++) {
      let result = 0;
      let shift = 0;
      let byte;
      do {
        byte = str.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20 && index < str.length);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (k === 0) lat += delta;
      else lon += delta;
    }
    out.push([lat / factor, lon / factor]);
  }
  return out;
}

/**
 * Проецирует линии в SVG-путь внутри квадрата size×size с отступом.
 * Сохраняет пропорции (equirectangular с поправкой на широту).
 */
export function linesToSvgPath(lines, size, pad = 6) {
  const all = lines.flat();
  if (!all.length) return { d: "", start: null, end: null };
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const k = Math.cos(((all[0][0] + all[all.length - 1][0]) / 2) * RAD);
  for (const [lat, lon] of all) {
    const x = lon * k;
    const y = -lat;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const w = maxX - minX || 1e-9;
  const h = maxY - minY || 1e-9;
  const scale = (size - pad * 2) / Math.max(w, h);
  const ox = pad + (size - pad * 2 - w * scale) / 2;
  const oy = pad + (size - pad * 2 - h * scale) / 2;
  const P = ([lat, lon]) => [
    +(ox + (lon * k - minX) * scale).toFixed(1),
    +(oy + (-lat - minY) * scale).toFixed(1),
  ];
  const d = lines
    .filter((l) => l.length > 1)
    .map((l) => "M" + l.map((p) => P(p).join(" ")).join("L"))
    .join("");
  // Старт/финиш — по самому длинному (основному) треку
  const main = lines.reduce((a, b) => (b.length > a.length ? b : a), lines[0]);
  return { d, start: P(main[0]), end: P(main[main.length - 1]) };
}
