/**
 * Тайлы: источник, расчёт коридора вдоль маршрута и скачивание для офлайна.
 */
import * as store from "./offline-store.js";

export const TILE_SOURCE = {
  url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
  maxZoom: 19,
};

/** Уровни масштаба для офлайна и ширина коридора (в тайлах по обе стороны трека). */
export const OFFLINE_ZOOMS = { min: 10, max: 16 };
const BUFFER = { 10: 1, 11: 1, 12: 1, 13: 1, 14: 1, 15: 1, 16: 1 };

/** Средний размер тайла OSM в Подмосковье — для оценки до скачивания. */
const AVG_TILE_BYTES = 14 * 1024;
/** Эмпирическая скорость: тайлов в секунду при 4 параллельных запросах. */
const TILES_PER_SECOND = 25;
const TILE_TIMEOUT_MS = 20000;

export function tileUrl(z, x, y) {
  return TILE_SOURCE.url.replace("{z}", z).replace("{x}", x).replace("{y}", y);
}

const lonToX = (lon, n) => ((lon + 180) / 360) * n;
function latToY(lat, n) {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
}

/**
 * Все тайлы коридора вдоль треков на уровнях min..max.
 *
 * Линия «растеризуется» с шагом ≤ ½ тайла между соседними точками, поэтому
 * в коридоре нет дыр даже при редких точках трека и на крупных масштабах.
 */
export function corridorTiles(segments, { min = OFFLINE_ZOOMS.min, max = OFFLINE_ZOOMS.max } = {}) {
  const keys = [];
  for (let z = min; z <= max; z++) {
    const n = 2 ** z;
    const buf = BUFFER[z] ?? 1;
    const seen = new Set();
    const add = (tx, ty) => {
      for (let dx = -buf; dx <= buf; dx++) {
        for (let dy = -buf; dy <= buf; dy++) {
          const x = tx + dx;
          const y = ty + dy;
          if (x < 0 || y < 0 || x >= n || y >= n) continue;
          const id = x * n + y;
          if (!seen.has(id)) {
            seen.add(id);
            keys.push(`${z}/${x}/${y}`);
          }
        }
      }
    };
    for (const seg of segments) {
      if (!seg.length) continue;
      let px = lonToX(seg[0][1], n);
      let py = latToY(seg[0][0], n);
      add(Math.floor(px), Math.floor(py));
      for (let i = 1; i < seg.length; i++) {
        const x = lonToX(seg[i][1], n);
        const y = latToY(seg[i][0], n);
        const steps = Math.ceil(Math.max(Math.abs(x - px), Math.abs(y - py)) * 2);
        for (let s = 1; s <= steps; s++) {
          const t = s / steps;
          add(Math.floor(px + (x - px) * t), Math.floor(py + (y - py) * t));
        }
        if (steps === 0) add(Math.floor(x), Math.floor(y));
        px = x;
        py = y;
      }
    }
  }
  return keys;
}

/** Оценка до скачивания: число тайлов, байты, секунды. */
export function estimate(segments) {
  const keys = corridorTiles(segments);
  return {
    keys,
    tiles: keys.length,
    bytes: keys.length * AVG_TILE_BYTES,
    seconds: keys.length / TILES_PER_SECOND,
  };
}

/**
 * Состояние офлайн-карты маршрута: доля нужных тайлов, отмеченных в манифесте.
 * Считается без чтения блобов, поэтому мгновенно.
 */
export async function offlineStatus(id, segments) {
  const manifest = await store.getDownload(id).catch(() => null);
  if (!manifest) return { state: "none", ratio: 0, manifest: null };
  const have = new Set(manifest.keys);
  const needed = corridorTiles(segments);
  let hit = 0;
  for (const k of needed) if (have.has(k)) hit++;
  const ratio = needed.length ? hit / needed.length : 0;
  return { state: ratio >= 0.98 ? "ready" : "partial", ratio, manifest };
}

class QuotaError extends Error {}

/**
 * Скачивает коридор тайлов маршрута.
 * onProgress({ phase, done, total, bytes, failed }) вызывается не чаще раза в кадр.
 * Возвращает { ok, cancelled, failed, bytes, tiles }.
 */
export async function downloadRoute({ id, name, segments, signal, onProgress = () => {} }) {
  await store.requestPersistence();

  const keys = corridorTiles(segments);
  onProgress({ phase: "checking", done: 0, total: keys.length, bytes: 0, failed: 0 });

  const existing = await store.existingTiles(keys);
  const queue = keys.filter((k) => !existing.has(k));
  const saved = [...existing];
  const total = keys.length;
  let doneCount = existing.size;
  let bytes = 0;
  let failedKeys = [];
  let quotaHit = false;

  let pending = false;
  const report = (phase = "downloading") => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      onProgress({ phase, done: doneCount, total, bytes, failed: failedKeys.length });
    });
  };
  report();

  async function fetchTile(key) {
    const [z, x, y] = key.split("/");
    // Свой таймаут на каждый тайл: «повисший» запрос при плохой связи не должен стопорить очередь
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    signal?.addEventListener("abort", onAbort);
    const timer = setTimeout(() => ctrl.abort(), TILE_TIMEOUT_MS);
    let blob;
    try {
      const resp = await fetch(tileUrl(z, x, y), { signal: ctrl.signal, mode: "cors", credentials: "omit" });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      blob = await resp.blob();
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
    try {
      await store.putTile(key, blob);
    } catch (e) {
      if (e?.name === "QuotaExceededError") throw new QuotaError();
      throw e;
    }
    bytes += blob.size;
    saved.push(key);
  }

  async function run(list, concurrency) {
    let i = 0;
    const failed = [];
    const worker = async () => {
      while (i < list.length && !signal?.aborted && !quotaHit) {
        const key = list[i++];
        try {
          await fetchTile(key);
          doneCount++;
        } catch (e) {
          if (e instanceof QuotaError) quotaHit = true;
          else if (!signal?.aborted) failed.push(key);
        }
        report();
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    return failed;
  }

  failedKeys = await run(queue, 4);
  // Одна повторная попытка для сбойных тайлов — обычно это кратковременные 429/5xx
  if (failedKeys.length && !signal?.aborted && !quotaHit) {
    await new Promise((r) => setTimeout(r, 1500));
    failedKeys = await run(failedKeys, 2);
  }

  const cancelled = !!signal?.aborted;
  // Размер уже имевшихся тайлов оцениваем по средним только что скачанных
  const avg = saved.length > existing.size ? bytes / (saved.length - existing.size) : AVG_TILE_BYTES;
  const totalBytes = Math.round(bytes + existing.size * avg);

  if (saved.length) {
    await store.saveDownload(id, saved, {
      name,
      bytes: totalBytes,
      expected: total,
      complete: !cancelled && !quotaHit && failedKeys.length === 0,
    });
  }

  onProgress({ phase: "done", done: saved.length, total, bytes: totalBytes, failed: failedKeys.length });

  if (quotaHit) {
    const err = new Error("На устройстве закончилось место для карт");
    err.code = "quota";
    throw err;
  }
  return {
    ok: !cancelled && failedKeys.length === 0,
    cancelled,
    failed: failedKeys.length,
    bytes: totalBytes,
    tiles: saved.length,
    total,
  };
}
