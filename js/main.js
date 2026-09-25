/**
 * Вёрсты — точка входа: маршрутизация, связь представлений, Service Worker.
 *
 *   #/            каталог (список)
 *   #/map         каталог (карта всех маршрутов)
 *   #/r/<файл>    маршрут
 */
import { $ } from "./lib/dom.js";
import { loadCatalog } from "./data/catalog.js";
import { listDownloads } from "./data/offline-store.js";
import * as downloads from "./data/downloads.js";
import { count } from "./lib/format.js";
import { createCatalogView } from "./views/catalog.js";
import { createRouteView } from "./views/route.js";
import { maybeShowOnboarding, showDownloads } from "./views/panels.js";
import { toast } from "./ui/feedback.js";

let catalog = null;
let catalogScroll = 0;
let navigatedInApp = false;

const catalogView = createCatalogView($("#catalog"), {
  onOpenDownloads: () => showDownloads({ catalog, onChanged: refreshSaved }),
});

const routeView = createRouteView($("#route"), {
  onClose: () => {
    // Вернуться «назад», если пришли из каталога; иначе (прямая ссылка) — заменить адрес
    if (navigatedInApp) history.back();
    else location.replace("#/");
  },
  onDownloadsChanged: refreshSaved,
});

async function refreshSaved() {
  try {
    const downloads = await listDownloads();
    catalogView.setSaved(downloads.map((d) => d.id));
  } catch {
    /* IndexedDB недоступна (приватный режим) — просто без отметок */
  }
}

// Итоги скачиваний сообщаем глобально: пользователь мог уже уйти с экрана маршрута
downloads.subscribe(({ id, job, result, error }) => {
  catalogView.setProgress(id, job?.progress || null);
  if (job) return;
  refreshSaved();
  const name = catalog?.routes.find((r) => r.id === id)?.name;
  const where = name ? `«${name}»` : "маршрута";
  if (error) toast(error.message || "Ошибка скачивания", { tone: "danger", duration: 6000 });
  else if (result?.cancelled) toast("Скачивание остановлено. Уже скачанное сохранено");
  else if (result?.failed) {
    toast(`Карта ${where}: не скачалось ${count(result.failed, ["фрагмент", "фрагмента", "фрагментов"])}. Откройте маршрут и нажмите «Докачать»`, {
      duration: 6000,
    });
  } else if (result) toast(`Карта ${where} скачана — можно ехать без сети`, { tone: "ok" });
});

function parseHash() {
  const h = location.hash.replace(/^#/, "");
  if (h.startsWith("/r/")) return { name: "route", id: decodeURIComponent(h.slice(3)) };
  if (h === "/map") return { name: "catalog", mode: "map" };
  return { name: "catalog", mode: "list" };
}

function route() {
  const r = parseHash();
  const html = document.documentElement;
  if (r.name === "route") {
    if (routeView.currentId === r.id && !$("#route").hidden) return;
    catalogScroll = window.scrollY;
    html.classList.add("route-open");
    $("#catalog").inert = true;
    const meta = catalog?.routes.find((x) => x.id === r.id) || null;
    routeView.open(r.id, meta);
    document.title = `${meta?.name || "Маршрут"} — Вёрсты`;
  } else {
    if (!$("#route").hidden) {
      routeView.close();
      html.classList.remove("route-open");
      $("#catalog").inert = false;
      requestAnimationFrame(() => window.scrollTo(0, catalogScroll));
    }
    catalogView.setMode(r.mode);
    document.title = "Вёрсты — веломаршруты без интернета";
  }
}

window.addEventListener("hashchange", () => {
  navigatedInApp = true;
  route();
});

// --- статус сети ----------------------------------------------------------------
function updateNetwork() {
  document.documentElement.classList.toggle("is-offline", !navigator.onLine);
}
window.addEventListener("online", updateNetwork);
window.addEventListener("offline", updateNetwork);
updateNetwork();

// --- загрузка каталога ---------------------------------------------------------------
async function boot() {
  try {
    const show = (next) => {
      catalog = next;
      catalogView.setCatalog(next);
      // Карточки перерисованы — возвращаем на них прогресс идущих скачиваний
      for (const job of downloads.active()) catalogView.setProgress(job.id, job.progress);
    };
    show(await loadCatalog(show));
  } catch (e) {
    catalogView.showError(
      navigator.onLine ? e.message : "Нет интернета, а каталог ещё ни разу не загружался.",
      boot,
    );
  }
  refreshSaved();
}

route();
boot().then(() => {
  const r = parseHash();
  if (r.name === "route") {
    // Приложение открыто сразу на маршруте — дополняем его данными каталога
    routeView.setMeta(catalog?.routes.find((x) => x.id === r.id));
  } else {
    maybeShowOnboarding();
  }
  // Прогреваем карту в простое, чтобы маршрут открывался мгновенно
  const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 1500));
  idle(() => import("./map/leaflet.js").then((m) => m.loadLeaflet()).catch(() => {}));
});

// --- Service Worker ---------------------------------------------------------------------
if ("serviceWorker" in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker
    .register("sw.js")
    .then((reg) => {
      setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
    })
    .catch(() => {});
  let notified = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController || notified) return;
    notified = true;
    // Во время поездки не перезагружаем — только ненавязчиво сообщаем
    toast("Вышло обновление приложения", {
      duration: 0,
      action: routeView.navigating ? null : { label: "Обновить", onClick: () => location.reload() },
    });
  });
}
