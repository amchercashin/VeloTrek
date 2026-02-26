/**
 * KML/KMZ парсер для VeloTrek.
 * Извлекает маршруты, POI и статистику из KML-файлов.
 */
const KMLParser = (() => {
  const KML_NS = 'http://www.opengis.net/kml/2.2';

  function parse(kmlString) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(kmlString, 'text/xml');

    const parseError = doc.querySelector('parsererror');
    if (parseError) {
      throw new Error('Некорректный KML-файл');
    }

    const result = {
      name: '',
      description: '',
      stats: {},
      pois: [],
      segments: [],
      bbox: { minLat: 90, maxLat: -90, minLon: 180, maxLon: -180 }
    };

    const docEl = doc.getElementsByTagNameNS(KML_NS, 'Document')[0];
    if (!docEl) {
      throw new Error('KML не содержит элемент Document');
    }

    result.name = getTextNS(docEl, 'name') || '';
    result.description = getTextNS(docEl, 'description') || '';

    const placemarks = doc.getElementsByTagNameNS(KML_NS, 'Placemark');

    for (const pm of placemarks) {
      const point = pm.getElementsByTagNameNS(KML_NS, 'Point')[0];
      const multiGeo = pm.getElementsByTagNameNS(KML_NS, 'MultiGeometry')[0];
      const lineString = pm.getElementsByTagNameNS(KML_NS, 'LineString')[0];

      if (point) {
        const poi = parsePoint(pm, point);
        if (poi) {
          result.pois.push(poi);
          updateBBox(result.bbox, poi.lat, poi.lon);
        }
      } else if (multiGeo) {
        const lineStrings = multiGeo.getElementsByTagNameNS(KML_NS, 'LineString');
        for (const ls of lineStrings) {
          const segment = parseCoordinates(ls);
          if (segment.length > 0) {
            result.segments.push(segment);
            for (const [lat, lon] of segment) {
              updateBBox(result.bbox, lat, lon);
            }
          }
        }
      } else if (lineString) {
        const segment = parseCoordinates(lineString);
        if (segment.length > 0) {
          result.segments.push(segment);
          for (const [lat, lon] of segment) {
            updateBBox(result.bbox, lat, lon);
          }
        }
      }
    }

    // Вычисляем track_km — суммарная длина всех сегментов по координатам
    let trackKm = 0;
    for (const seg of result.segments) {
      for (let i = 1; i < seg.length; i++) {
        trackKm += haversineKm(seg[i-1][0], seg[i-1][1], seg[i][0], seg[i][1]);
      }
    }
    if (trackKm > 0) {
      result.stats.track_km = Math.round(trackKm * 10) / 10;
    }

    // Вычисляем span_km — диагональ bounding box
    const bb = result.bbox;
    if (bb.minLat < 90) {
      const dlatKm  = (bb.maxLat - bb.minLat) * 111.32;
      const midLat  = (bb.maxLat + bb.minLat) / 2;
      const dlonKm  = (bb.maxLon - bb.minLon) * 111.32 * Math.cos(midLat * Math.PI / 180);
      result.stats.span_km = Math.round(Math.sqrt(dlatKm * dlatKm + dlonKm * dlonKm) * 10) / 10;
    }

    // Вычисляем статистику высот из координат трека
    Object.assign(result.stats, calcElevationStats(result.segments));

    return result;
  }

  function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon/2) * Math.sin(dLon/2);
    return R * 2 * Math.asin(Math.sqrt(a));
  }

  function getTextNS(parent, tagName) {
    const children = parent.childNodes;
    for (const child of children) {
      if (child.localName === tagName && child.namespaceURI === KML_NS) {
        return child.textContent;
      }
    }
    return null;
  }

  function parsePoint(placemark, pointEl) {
    const coordsEl = pointEl.getElementsByTagNameNS(KML_NS, 'coordinates')[0];
    if (!coordsEl) return null;

    const coords = coordsEl.textContent.trim().split(',');
    if (coords.length < 2) return null;

    return {
      name: getTextNS(placemark, 'name') || '',
      description: getTextNS(placemark, 'description') || '',
      lon: parseFloat(coords[0]),
      lat: parseFloat(coords[1]),
      elevation: parseFloat(coords[2]) || 0
    };
  }

  function parseCoordinates(lineStringEl) {
    const coordsEl = lineStringEl.getElementsByTagNameNS(KML_NS, 'coordinates')[0];
    if (!coordsEl) return [];

    const coordText = coordsEl.textContent.trim();
    return coordText.split(/\s+/).filter(Boolean).map(triplet => {
      const parts = triplet.split(',').map(Number);
      const lon = parts[0];
      const lat = parts[1];
      const ele = parts[2] || 0;
      return [lat, lon, ele];
    });
  }

  function calcElevationStats(segments) {
    // Скользящее среднее (окно 5 точек) перед суммированием подъёмов/спусков.
    // Точки треков расположены через ~200–300 м, окно сглаживает суб-километровые
    // артефакты SRTM-интерполяции, сохраняя реальный рельеф.
    const WINDOW = 5;
    const HALF = Math.floor(WINDOW / 2);
    let climb = 0, descent = 0;
    let minEle = Infinity, maxEle = -Infinity;
    let hasEle = false;

    for (const seg of segments) {
      const eles = seg.map(p => p[2]).filter(e => e);
      if (eles.length < 2) continue;
      hasEle = true;
      for (const e of eles) {
        if (e < minEle) minEle = e;
        if (e > maxEle) maxEle = e;
      }

      // Скользящее среднее
      const smoothed = eles.map((_, i) => {
        const s = Math.max(0, i - HALF);
        const end = Math.min(eles.length - 1, i + HALF);
        let sum = 0;
        for (let j = s; j <= end; j++) sum += eles[j];
        return sum / (end - s + 1);
      });

      for (let i = 1; i < smoothed.length; i++) {
        const diff = smoothed[i] - smoothed[i - 1];
        if (diff > 0) climb += diff;
        else descent -= diff;
      }
    }

    if (!hasEle) return {};
    return {
      elevation_min_m: Math.round(minEle),
      elevation_max_m: Math.round(maxEle),
      climb_m: Math.round(climb),
      descent_m: Math.round(descent),
    };
  }

  function updateBBox(bbox, lat, lon) {
    if (lat < bbox.minLat) bbox.minLat = lat;
    if (lat > bbox.maxLat) bbox.maxLat = lat;
    if (lon < bbox.minLon) bbox.minLon = lon;
    if (lon > bbox.maxLon) bbox.maxLon = lon;
  }

  async function loadFromUrl(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Ошибка загрузки: ${response.status}`);

    if (url.endsWith('.kmz')) {
      const buffer = await response.arrayBuffer();
      const zip = await JSZip.loadAsync(buffer);
      const kmlFile = zip.file('doc.kml') || zip.file(/\.kml$/i)[0];
      if (!kmlFile) throw new Error('В KMZ не найден файл KML');
      const kmlText = await kmlFile.async('string');
      return parse(kmlText);
    } else {
      const kmlText = await response.text();
      return parse(kmlText);
    }
  }

  return { parse, loadFromUrl };
})();
