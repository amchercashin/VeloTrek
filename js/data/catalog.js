/**
 * Каталог маршрутов: routes/index.json (генерируется GitHub Action).
 * Stale-while-revalidate: мгновенно из localStorage, свежая версия — в фоне.
 */
import { storage } from "../lib/dom.js";
import { decodePolyline } from "../lib/geo.js";

const CACHE_KEY = "versty:catalog:v2";

/** Цвета разделов — по порядку; неизвестные разделы получают следующий цвет палитры. */
const SECTION_TONES = ["violet", "green", "orange", "rose", "sky", "amber"];
const KNOWN_TONES = {
  "Москва": "violet",
  "Однодневки Подмосковья": "green",
  "Походы 2-3 дня МО": "orange",
  "Велопутешествия": "rose",
};

/** Короткие подписи для чипов фильтра. */
const SHORT_NAMES = {
  "Однодневки Подмосковья": "Однодневки",
  "Походы 2-3 дня МО": "Походы 2–3 дня",
};

/** Порядок разделов: от коротких прогулок к дальним путешествиям; новые — в конце. */
const SECTION_ORDER = ["Москва", "Однодневки Подмосковья", "Походы 2-3 дня МО", "Велопутешествия"];
const rank = (name) => {
  const i = SECTION_ORDER.indexOf(name);
  return i === -1 ? SECTION_ORDER.length : i;
};

function normalize(raw) {
  const sections = (raw.sections || [])
    .filter((s) => s.routes?.length)
    .sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name, "ru"));
  const routes = [];
  sections.forEach((section, si) => {
    const tone = KNOWN_TONES[section.name] || SECTION_TONES[si % SECTION_TONES.length];
    section.tone = tone;
    section.short = SHORT_NAMES[section.name] || section.name;
    for (const r of section.routes) {
      // «1. Запад. Вдоль Москвы-реки» → номер 1, направление «Запад», название
      const m = r.name.match(/^\s*(\d+)\s*[.)]\s*(.+)$/);
      let name = m ? m[2] : r.name;
      const dir = name.match(/^([А-ЯЁ][а-яё]+(?:\/[а-яё-]+)?)\.\s+(.+)$/);
      if (dir) name = dir[2];
      routes.push({
        id: r.filename,
        name,
        number: m ? Number(m[1]) : null,
        direction: dir ? dir[1] : null,
        section: section.name,
        sectionShort: section.short,
        tone,
        km: r.mainKm || r.stats?.track_km || 0,
        totalKm: r.stats?.track_km || 0,
        tracks: r.segmentCount || 1,
        pois: r.poiCount || 0,
        climb: r.stats?.climb_m || null,
        bbox: r.bbox,
        encoded: r.line || [],
        error: r.error || null,
        search: `${r.name} ${section.name}`.toLowerCase().replace(/ё/g, "е"),
      });
    }
  });
  return { sections, routes, generated: raw.generated };
}

/** Геометрия для силуэта/обзорной карты — декодируется лениво и один раз. */
export function routeLines(route) {
  if (!route._lines) route._lines = route.encoded.map((s) => decodePolyline(s));
  return route._lines;
}

async function fetchIndex() {
  const resp = await fetch("routes/index.json", { cache: "no-cache" });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

/**
 * Возвращает каталог как можно быстрее. onUpdate(catalog) — если в фоне пришла
 * более свежая версия, отличная от показанной.
 */
export async function loadCatalog(onUpdate) {
  const cached = storage.get(CACHE_KEY);
  if (cached?.data) {
    fetchIndex()
      .then((fresh) => {
        if (fresh.generated === cached.data.generated) return;
        storage.set(CACHE_KEY, { data: fresh });
        onUpdate?.(normalize(fresh));
      })
      .catch(() => {});
    return normalize(cached.data);
  }
  const fresh = await fetchIndex();
  storage.set(CACHE_KEY, { data: fresh });
  return normalize(fresh);
}
