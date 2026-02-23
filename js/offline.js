/**
 * Менеджер офлайн-тайлов для VeloTrek.
 * Хранит тайлы в IndexedDB, рассчитывает коридор, скачивает с rate-limiting.
 */
const OfflineTiles = (() => {
  const DB_NAME = 'velotrek-tiles';
  const DB_VERSION = 1;
  const STORE_NAME = 'tiles';

  let dbPromise = null;

  function getDB() {
    if (!dbPromise) {
      dbPromise = idb.openDB(DB_NAME, DB_VERSION, {
        upgrade(db) {
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            db.createObjectStore(STORE_NAME);
          }
        }
      });
    }
    return dbPromise;
  }

  async function getTile(key) {
    const db = await getDB();
    return db.get(STORE_NAME, key);
  }

  async function putTile(key, blob) {
    const db = await getDB();
    return db.put(STORE_NAME, blob, key);
  }

  async function deleteTilesForRoute(routeId) {
    const db = await getDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    let cursor = await store.openCursor();
    let deleted = 0;
    while (cursor) {
      // Tiles are stored with keys like "z/x/y", route association is tracked separately
      cursor = await cursor.continue();
    }
    await tx.done;
    return deleted;
  }

  function lon2tile(lon, zoom) {
    return Math.floor((lon + 180) / 360 * Math.pow(2, zoom));
  }

  function lat2tile(lat, zoom) {
    const latRad = lat * Math.PI / 180;
    return Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * Math.pow(2, zoom));
  }

  function getTilesForRoute(routeData, zoomMin, zoomMax) {
    const tiles = new Set();

    // For low zoom levels (10-13), use full bounding box
    const bbox = routeData.bbox;
    for (let z = zoomMin; z <= Math.min(13, zoomMax); z++) {
      const xMin = lon2tile(bbox.minLon - 0.01, z);
      const xMax = lon2tile(bbox.maxLon + 0.01, z);
      const yMin = lat2tile(bbox.maxLat + 0.01, z);
      const yMax = lat2tile(bbox.minLat - 0.01, z);
      for (let x = xMin; x <= xMax; x++) {
        for (let y = yMin; y <= yMax; y++) {
          tiles.add(`${z}/${x}/${y}`);
        }
      }
    }

    // For high zoom levels (14-16), use corridor along route points
    const seenAtZoom = {};
    for (let z = Math.max(14, zoomMin); z <= zoomMax; z++) {
      seenAtZoom[z] = new Set();
      const buffer = 1; // 1 tile buffer each side
      for (const segment of routeData.segments) {
        // Sample every Nth point to reduce computation (at z16, tiles are ~345m)
        const step = Math.max(1, Math.floor(segment.length / 500));
        for (let i = 0; i < segment.length; i += step) {
          const [lat, lon] = segment[i];
          const cx = lon2tile(lon, z);
          const cy = lat2tile(lat, z);
          for (let dx = -buffer; dx <= buffer; dx++) {
            for (let dy = -buffer; dy <= buffer; dy++) {
              const key = `${z}/${cx + dx}/${cy + dy}`;
              if (!seenAtZoom[z].has(key)) {
                seenAtZoom[z].add(key);
                tiles.add(key);
              }
            }
          }
        }
        // Also include last point
        if (segment.length > 0) {
          const [lat, lon] = segment[segment.length - 1];
          const cx = lon2tile(lon, z);
          const cy = lat2tile(lat, z);
          for (let dx = -buffer; dx <= buffer; dx++) {
            for (let dy = -buffer; dy <= buffer; dy++) {
              tiles.add(`${z}/${cx + dx}/${cy + dy}`);
            }
          }
        }
      }
    }

    return [...tiles];
  }

  function estimateSize(tileCount) {
    // Average OSM tile: ~15 KB
    const avgTileSize = 15 * 1024;
    return tileCount * avgTileSize;
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' Б';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' КБ';
    return (bytes / (1024 * 1024)).toFixed(1) + ' МБ';
  }

  async function downloadTiles(routeData, tileUrlTemplate, options = {}) {
    const {
      zoomMin = 10,
      zoomMax = 16,
      concurrency = 4,
      delayMs = 100,
      onProgress = () => {},
      signal = null
    } = options;

    const allTileKeys = getTilesForRoute(routeData, zoomMin, zoomMax);

    // Check which are already cached
    onProgress({ phase: 'checking', total: allTileKeys.length, completed: 0, failed: 0, cached: 0 });

    const toDownload = [];
    let cached = 0;
    for (const key of allTileKeys) {
      if (signal && signal.aborted) return { total: allTileKeys.length, completed: 0, failed: 0, cached, cancelled: true };
      const existing = await getTile(key);
      if (existing) {
        cached++;
      } else {
        toDownload.push(key);
      }
    }

    const total = toDownload.length;
    let completed = 0;
    let failed = 0;

    onProgress({ phase: 'downloading', total, completed, failed, cached });

    if (total === 0) {
      onProgress({ phase: 'done', total: 0, completed: 0, failed: 0, cached });
      return { total: allTileKeys.length, completed: 0, failed: 0, cached, cancelled: false };
    }

    const queue = [...toDownload];

    async function worker() {
      while (queue.length > 0) {
        if (signal && signal.aborted) return;

        const key = queue.shift();
        const [z, x, y] = key.split('/');
        const url = tileUrlTemplate
          .replace('{z}', z)
          .replace('{x}', x)
          .replace('{y}', y);

        try {
          const resp = await fetch(url);
          if (resp.ok) {
            const blob = await resp.blob();
            await putTile(key, blob);
            completed++;
          } else {
            failed++;
          }
        } catch {
          failed++;
        }

        onProgress({ phase: 'downloading', total, completed, failed, cached });

        if (delayMs > 0 && queue.length > 0) {
          await new Promise(r => setTimeout(r, delayMs));
        }
      }
    }

    const workers = Array.from({ length: concurrency }, () => worker());
    await Promise.all(workers);

    const cancelled = signal ? signal.aborted : false;
    onProgress({ phase: 'done', total, completed, failed, cached, cancelled });

    return { total: allTileKeys.length, completed, failed, cached, cancelled };
  }

  async function getStoredTileCount() {
    const db = await getDB();
    return db.count(STORE_NAME);
  }

  async function clearAllTiles() {
    const db = await getDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    await tx.objectStore(STORE_NAME).clear();
    await tx.done;
  }

  return {
    getTile,
    putTile,
    getTilesForRoute,
    estimateSize,
    formatSize,
    downloadTiles,
    getStoredTileCount,
    clearAllTiles
  };
})();
