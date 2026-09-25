/**
 * Загрузка и разбор маршрута (KML/KMZ).
 *
 * Порядок источников:
 *   1. Скачанная копия из IndexedDB — мгновенно и без сети (важно при «лежащей» связи).
 *      Если сеть есть, файл тихо перепроверяется в фоне.
 *   2. Сеть (Service Worker кэширует файл, network-first).
 */
import { kmlFromKmz } from "../lib/unzip.js";
import { lineLength, bboxOf } from "../lib/geo.js";
import * as store from "./offline-store.js";

const KML_NS = "http://www.opengis.net/kml/2.2";

export function routeUrl(id) {
  return "routes/" + id.split("/").map(encodeURIComponent).join("/");
}

/** Адрес файла у прежней версии приложения — там же он мог остаться в кэше SW. */
function legacyUrl(id) {
  const m = location.hostname.match(/^(.+)\.github\.io$/);
  const repo = location.pathname.split("/").filter(Boolean)[0];
  if (!m || !repo) return null;
  return `https://raw.githubusercontent.com/${m[1]}/${repo}/main/routes/${id}`;
}

function children(parent, name) {
  const byNs = parent.getElementsByTagNameNS(KML_NS, name);
  if (byNs.length) return [...byNs];
  return [...parent.getElementsByTagName("*")].filter((e) => e.localName === name);
}

function ownText(parent, name) {
  for (const child of parent.children) {
    if (child.localName === name) return child.textContent.trim();
  }
  return "";
}

function parseCoords(text) {
  const out = [];
  for (const triplet of text.trim().split(/\s+/)) {
    const [lon, lat, ele] = triplet.split(",").map(Number);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      out.push(Number.isFinite(ele) ? [lat, lon, ele] : [lat, lon]);
    }
  }
  return out;
}

/** Статистика высот со сглаживанием скользящим средним (окно 5) против шума SRTM. */
function elevationStats(segments) {
  const HALF = 2;
  let climb = 0, descent = 0, min = Infinity, max = -Infinity, has = false;
  for (const seg of segments) {
    const eles = seg.map((p) => p[2]).filter(Number.isFinite);
    if (eles.length < 2) continue;
    has = true;
    for (const e of eles) {
      if (e < min) min = e;
      if (e > max) max = e;
    }
    let prev = null;
    for (let i = 0; i < eles.length; i++) {
      const s = Math.max(0, i - HALF);
      const e = Math.min(eles.length - 1, i + HALF);
      let sum = 0;
      for (let j = s; j <= e; j++) sum += eles[j];
      const v = sum / (e - s + 1);
      if (prev !== null) {
        if (v > prev) climb += v - prev;
        else descent += prev - v;
      }
      prev = v;
    }
  }
  if (!has) return {};
  return {
    elevationMin: Math.round(min),
    elevationMax: Math.round(max),
    climb: Math.round(climb),
    descent: Math.round(descent),
  };
}

export function parseKml(text) {
  const doc = new DOMParser().parseFromString(text, "text/xml");
  if (doc.querySelector("parsererror")) throw new Error("Некорректный KML-файл");
  const root = children(doc, "Document")[0] || doc.documentElement;

  const segments = [];
  const pois = [];
  for (const pm of children(doc, "Placemark")) {
    const point = children(pm, "Point")[0];
    if (point) {
      const c = parseCoords(children(point, "coordinates")[0]?.textContent || "")[0];
      if (c) {
        pois.push({
          name: ownText(pm, "name"),
          description: ownText(pm, "description"),
          lat: c[0],
          lon: c[1],
        });
      }
      continue;
    }
    for (const ls of children(pm, "LineString")) {
      const pts = parseCoords(children(ls, "coordinates")[0]?.textContent || "");
      if (pts.length) segments.push(pts);
    }
  }
  if (!segments.length && !pois.length) throw new Error("В файле нет трека");

  const lengths = segments.map(lineLength);
  const mainLength = lengths.length ? Math.max(...lengths) : 0;
  return {
    name: ownText(root, "name"),
    description: ownText(root, "description"),
    segments,
    // «Основные» треки — сопоставимые по длине с самым длинным; короткие — варианты и подъезды
    mainSegments: lengths.map((l) => l >= mainLength * 0.4),
    lengths,
    mainLength,
    totalLength: lengths.reduce((a, b) => a + b, 0),
    pois,
    bbox: bboxOf(segments, pois),
    elevation: elevationStats(segments),
  };
}

async function fetchRoute(id, { timeout = 0 } = {}) {
  const ctrl = new AbortController();
  const timer = timeout ? setTimeout(() => ctrl.abort(), timeout) : 0;
  let resp;
  try {
    try {
      resp = await fetch(routeUrl(id), { signal: ctrl.signal });
    } catch (e) {
      const legacy = legacyUrl(id);
      if (!legacy || ctrl.signal.aborted) throw e;
      resp = await fetch(legacy, { signal: ctrl.signal });
    }
  } catch {
    // Сюда попадают только сетевые ошибки и таймаут — ошибки разбора файла идут ниже как есть
    throw new Error("Нет связи, а маршрут не сохранён на устройстве");
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) throw new Error(`Файл маршрута недоступен (HTTP ${resp.status})`);
  const text = id.toLowerCase().endsWith(".kmz")
    ? await kmlFromKmz(await resp.arrayBuffer())
    : await resp.text();
  return parseKml(text);
}

const fingerprint = (r) =>
  `${r.name}|${r.description.length}|${r.pois.length}|${r.segments.map((s) => s.length).join(",")}`;

/**
 * Возвращает { data, source: "device" | "network" }.
 * onRefresh(data) вызывается, если сохранённая копия устарела и в фоне пришла новая.
 */
export async function loadRoute(id, { onRefresh } = {}) {
  const saved = await store.getRouteData(id).catch(() => null);
  if (saved?.segments) {
    if (navigator.onLine) {
      fetchRoute(id, { timeout: 15000 })
        .then(async (fresh) => {
          if (fingerprint(fresh) === fingerprint(saved)) return;
          await store.saveRouteData(id, fresh);
          onRefresh?.(fresh);
        })
        .catch(() => {});
    }
    return { data: saved, source: "device" };
  }
  return { data: await fetchRoute(id), source: "network" };
}
