/**
 * Менеджер скачиваний: загрузки живут отдельно от экранов (можно вернуться
 * в каталог и выбрать ещё маршрут) и идут строго по очереди, чтобы не
 * перегружать сервер тайлов и мобильную сеть.
 */
import * as tiles from "./tiles.js";
import * as store from "./offline-store.js";

const jobs = new Map(); // id → { id, name, state: "queued" | "running", progress, ctrl }
const listeners = new Set();
let chain = Promise.resolve();

function emit(id, extra = {}) {
  const job = jobs.get(id) || null;
  for (const fn of listeners) fn({ id, job, ...extra });
}

/** Подписка на изменения: fn({ id, job, result?, error? }). Возвращает отписку. */
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function get(id) {
  return jobs.get(id) || null;
}

export function active() {
  return [...jobs.values()];
}

export function cancel(id) {
  const job = jobs.get(id);
  if (!job) return;
  job.ctrl.abort();
  if (job.state === "queued") {
    jobs.delete(id);
    emit(id, { result: { cancelled: true } });
  }
}

/** Ставит маршрут в очередь. data — разобранный маршрут (сегменты нужны для коридора). */
export function enqueue(id, name, data) {
  if (jobs.has(id)) return;
  const job = {
    id,
    name,
    state: "queued",
    progress: { phase: "queued", done: 0, total: 0, bytes: 0, failed: 0 },
    ctrl: new AbortController(),
  };
  jobs.set(id, job);
  emit(id);

  chain = chain.then(async () => {
    if (job.ctrl.signal.aborted) return;
    job.state = "running";
    emit(id);
    try {
      // Сначала сам маршрут — он откроется без сети даже при отмене скачивания карты
      await store.saveRouteData(id, data);
      await store.requestPersistence();
      const result = await tiles.downloadRoute({
        id,
        name,
        segments: data.segments,
        signal: job.ctrl.signal,
        onProgress: (p) => {
          job.progress = p;
          emit(id);
        },
      });
      jobs.delete(id);
      emit(id, { result });
    } catch (error) {
      jobs.delete(id);
      emit(id, { error });
    }
  });
}

// Пока идёт скачивание, закрытие вкладки прервёт его — предупреждаем
window.addEventListener("beforeunload", (e) => {
  if (jobs.size) {
    e.preventDefault();
    e.returnValue = "";
  }
});
