/**
 * Минимальная обёртка над IndexedDB на промисах (вместо библиотеки idb).
 * Все операции внутри транзакции ставятся синхронно, поэтому транзакция
 * не закрывается раньше времени.
 */

export function openDB(name, version, upgrade) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, version);
    req.onupgradeneeded = (e) => upgrade(req.result, e.oldVersion, req.transaction);
    req.onsuccess = () => {
      const db = req.result;
      // Другая вкладка обновляет схему — уступаем, чтобы не блокировать её
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("База данных занята другой вкладкой"));
  });
}

export function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new DOMException("Транзакция прервана", "AbortError"));
  });
}
