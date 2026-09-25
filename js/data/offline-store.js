/**
 * Офлайн-хранилище в IndexedDB.
 *
 *   tiles     key "z/x/y"  → Blob тайла
 *   tileRefs  key "z/x/y"  → [routeId, …] — какие маршруты используют тайл
 *                             (общие тайлы не удаляются вместе с одним маршрутом)
 *   routes    key routeId  → манифест скачивания (см. saveDownload)
 *   routeData key routeId  → разобранный маршрут для открытия без сети
 *
 * Имя базы и первые три хранилища совместимы с прежней версией приложения,
 * поэтому уже скачанные карты переживают обновление.
 */
import { openDB, request, done } from "../lib/idb.js";

const DB_NAME = "velotrek-tiles";
const DB_VERSION = 3;
const TILES = "tiles";
const REFS = "tileRefs";
const ROUTES = "routes";
const ROUTE_DATA = "routeData";

let dbPromise = null;

function db() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, (d) => {
      for (const name of [TILES, REFS, ROUTES, ROUTE_DATA]) {
        if (!d.objectStoreNames.contains(name)) d.createObjectStore(name);
      }
    }).catch((e) => {
      dbPromise = null;
      throw e;
    });
  }
  return dbPromise;
}

/** Манифест прежней версии — просто массив ключей тайлов. */
function normalizeManifest(id, value) {
  if (!value) return null;
  if (Array.isArray(value)) {
    return { id, keys: value, bytes: 0, savedAt: 0, name: "", legacy: true };
  }
  return { id, ...value };
}

export async function getTile(key) {
  const d = await db();
  return request(d.transaction(TILES).objectStore(TILES).get(key));
}

export async function putTile(key, blob) {
  const d = await db();
  const tx = d.transaction(TILES, "readwrite");
  tx.objectStore(TILES).put(blob, key);
  return done(tx);
}

/** Какие из ключей уже лежат в базе. Один readonly-проход без чтения блобов. */
export async function existingTiles(keys) {
  const d = await db();
  const store = d.transaction(TILES).objectStore(TILES);
  const found = new Set();
  await Promise.all(
    keys.map((key) =>
      request(store.count(key)).then((n) => {
        if (n) found.add(key);
      }),
    ),
  );
  return found;
}

export async function getDownload(id) {
  const d = await db();
  return normalizeManifest(id, await request(d.transaction(ROUTES).objectStore(ROUTES).get(id)));
}

export async function listDownloads() {
  const d = await db();
  const store = d.transaction(ROUTES).objectStore(ROUTES);
  const [keys, values] = await Promise.all([request(store.getAllKeys()), request(store.getAll())]);
  return keys.map((id, i) => normalizeManifest(id, values[i]));
}

/**
 * Сохраняет манифест маршрута и проставляет ссылки на тайлы.
 * meta: { name, bytes, expected, complete }
 */
export async function saveDownload(id, tileKeys, meta = {}) {
  const d = await db();
  const tx = d.transaction([ROUTES, REFS], "readwrite");
  const routes = tx.objectStore(ROUTES);
  const refs = tx.objectStore(REFS);

  const prevReq = routes.get(id);
  prevReq.onsuccess = () => {
    const prev = normalizeManifest(id, prevReq.result);
    const keys = [...new Set([...(prev?.keys || []), ...tileKeys])];
    for (const key of keys) {
      const r = refs.get(key);
      r.onsuccess = () => {
        const list = r.result || [];
        if (!list.includes(id)) refs.put([...list, id], key);
      };
    }
    routes.put(
      {
        keys,
        name: meta.name || prev?.name || "",
        bytes: meta.bytes ?? prev?.bytes ?? 0,
        expected: meta.expected ?? keys.length,
        complete: meta.complete ?? true,
        savedAt: Date.now(),
      },
      id,
    );
  };
  return done(tx);
}

/** Удаляет маршрут: его данные, манифест и тайлы, на которые больше никто не ссылается. */
export async function deleteDownload(id) {
  const d = await db();
  const tx = d.transaction([ROUTES, REFS, TILES, ROUTE_DATA], "readwrite");
  const routes = tx.objectStore(ROUTES);
  const refs = tx.objectStore(REFS);
  const tiles = tx.objectStore(TILES);

  const req = routes.get(id);
  req.onsuccess = () => {
    const manifest = normalizeManifest(id, req.result);
    for (const key of manifest?.keys || []) {
      const r = refs.get(key);
      r.onsuccess = () => {
        const rest = (r.result || []).filter((x) => x !== id);
        if (rest.length) {
          refs.put(rest, key);
        } else {
          refs.delete(key);
          tiles.delete(key);
        }
      };
    }
    routes.delete(id);
    tx.objectStore(ROUTE_DATA).delete(id);
  };
  return done(tx);
}

export async function clearAll() {
  const d = await db();
  const tx = d.transaction([TILES, REFS, ROUTES, ROUTE_DATA], "readwrite");
  for (const name of [TILES, REFS, ROUTES, ROUTE_DATA]) tx.objectStore(name).clear();
  return done(tx);
}

export async function saveRouteData(id, data) {
  const d = await db();
  const tx = d.transaction(ROUTE_DATA, "readwrite");
  tx.objectStore(ROUTE_DATA).put({ ...data, savedAt: Date.now() }, id);
  return done(tx);
}

export async function getRouteData(id) {
  const d = await db();
  return request(d.transaction(ROUTE_DATA).objectStore(ROUTE_DATA).get(id));
}

/** Просит браузер не вытеснять данные при нехватке места (важно для офлайн-карт). */
export async function requestPersistence() {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

export async function storageInfo() {
  try {
    const [estimate, persisted] = await Promise.all([
      navigator.storage?.estimate?.() ?? null,
      navigator.storage?.persisted?.() ?? false,
    ]);
    return { usage: estimate?.usage ?? null, quota: estimate?.quota ?? null, persisted };
  } catch {
    return { usage: null, quota: null, persisted: false };
  }
}
