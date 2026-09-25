/**
 * Модальные панели: знакомство с приложением и «Офлайн-карты» (скачанное и место).
 */
import { el, esc, storage, isStandalone } from "../lib/dom.js";
import * as fmt from "../lib/format.js";
import * as store from "../data/offline-store.js";
import { icon } from "../ui/icons.js";
import { thumb, routeHref } from "../ui/route-card.js";
import { confirmDialog, toast } from "../ui/feedback.js";

const ONBOARDED_KEY = "versty:onboarded";
const REPO_URL = "https://github.com/amchercashin/VeloTrek";

let installPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installPrompt = e;
});

const isIOS = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

function panel(content, { cls = "" } = {}) {
  // Фокус — на саму карточку, чтобы на первой кнопке не загоралась рамка фокуса
  const dlg = el(`<dialog class="panel ${cls}"><div class="panel__card" tabindex="-1" autofocus>${content}</div></dialog>`);
  document.body.appendChild(dlg);
  dlg.addEventListener("click", (e) => {
    if (e.target === dlg || e.target.closest("[data-close]")) dlg.close();
  });
  dlg.addEventListener("close", () => {
    dlg.classList.add("is-closing");
    setTimeout(() => dlg.remove(), 200);
  });
  dlg.showModal();
  return dlg;
}

function installBlock() {
  if (isStandalone()) return "";
  if (installPrompt) {
    return `
      <div class="install">
        <div class="install__text"><b>Установите приложение</b><span>Иконка на экране, запуск без браузера и без сети</span></div>
        <button class="btn btn--primary" type="button" data-install>${icon("plusSquare", { size: 20 })}Установить</button>
      </div>`;
  }
  if (isIOS()) {
    return `
      <div class="install">
        <div class="install__text"><b>Добавьте на экран «Домой»</b>
          <span>Нажмите ${icon("share", { size: 16, cls: "inline-icon" })} в Safari, затем «На экран „Домой“» — приложение будет открываться без сети, а карты не удалятся</span>
        </div>
      </div>`;
  }
  return "";
}

export function maybeShowOnboarding() {
  if (storage.get(ONBOARDED_KEY)) return;
  showOnboarding();
}

export function showOnboarding() {
  const dlg = panel(
    `
    <div class="onboard">
      <div class="onboard__art" aria-hidden="true">
        <svg viewBox="0 0 320 150">
          <defs>
            <pattern id="ob-grid" width="16" height="16" patternUnits="userSpaceOnUse"><path d="M16 0H0V16" fill="none" class="onboard__grid"/></pattern>
          </defs>
          <rect width="320" height="150" fill="url(#ob-grid)"/>
          <path class="onboard__water" d="M-10 118c40-10 60 6 96-4s52-30 92-22 70 30 150 8"/>
          <path class="onboard__route-casing" d="M34 110c20-40 58-58 92-48s40 40 74 36 40-52 86-60"/>
          <path class="onboard__route" pathLength="1" d="M34 110c20-40 58-58 92-48s40 40 74 36 40-52 86-60"/>
          <circle class="onboard__start" cx="34" cy="110" r="7"/>
          <g class="onboard__post" transform="translate(280 22)">
            <rect x="-6" y="0" width="12" height="46" rx="2"/>
            <path d="M-6 8l12-6M-6 20l12-6M-6 32l12-6M-6 44l12-6"/>
          </g>
        </svg>
      </div>
      <h2 class="onboard__title">Маршруты, которые не&nbsp;пропадут без связи</h2>
      <ol class="steps">
        <li><span class="steps__n">1</span><div><b>Выберите маршрут</b><span>Прогулки по Москве, однодневки и походы на 2–3 дня по Подмосковью.</span></div></li>
        <li><span class="steps__n">2</span><div><b>Скачайте карту дома</b><span>По Wi‑Fi, за пару минут. Карта хранится в телефоне.</span></div></li>
        <li><span class="steps__n">3</span><div><b>Едьте без интернета</b><span>GPS работает без связи: видно, где вы, куда смотрите и не сбились ли с трека. Мобильный интернет можно выключить — батарея скажет спасибо.</span></div></li>
      </ol>
      ${installBlock()}
      <button class="btn btn--go btn--block" type="button" data-close>К маршрутам</button>
    </div>`,
    { cls: "panel--onboard" },
  );
  dlg.querySelector("[data-install]")?.addEventListener("click", async () => {
    installPrompt?.prompt();
    const choice = await installPrompt?.userChoice.catch(() => null);
    installPrompt = null;
    if (choice?.outcome === "accepted") dlg.close();
  });
  dlg.addEventListener("close", () => storage.set(ONBOARDED_KEY, true));
}

/**
 * Панель «Офлайн-карты». catalog — для названий и силуэтов;
 * onChanged — после удаления.
 */
export async function showDownloads({ catalog, onChanged }) {
  const dlg = panel(
    `
    <header class="panel__head">
      <h2 class="panel__title">Офлайн-карты</h2>
      <button class="icon-btn" type="button" data-close aria-label="Закрыть">${icon("close")}</button>
    </header>
    <div class="panel__body" data-content><div class="skeleton-lines"><span></span><span></span></div></div>`,
    { cls: "panel--downloads" },
  );
  const content = dlg.querySelector("[data-content]");

  async function render() {
    const [downloads, info] = await Promise.all([store.listDownloads().catch(() => []), store.storageInfo()]);
    const byId = new Map((catalog?.routes || []).map((r) => [r.id, r]));
    const total = downloads.reduce((s, d) => s + (d.bytes || 0), 0);
    downloads.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));

    const usage =
      info.quota && info.usage != null
        ? `<div class="meter" aria-hidden="true"><span style="transform:scaleX(${Math.min(1, info.usage / info.quota)})"></span></div>
           <p class="muted">Занято ${fmt.bytes(info.usage)} из доступных ${fmt.bytes(info.quota)}</p>`
        : "";
    const persist = info.persisted
      ? `<p class="note note--ok">${icon("checkCircle", { size: 18 })}Браузер не удалит карты при нехватке места</p>`
      : `<p class="note">${icon("info", { size: 18 })}Браузер может очистить карты, если на телефоне кончится место. Установите приложение на экран «Домой» — так надёжнее.</p>`;

    const list = downloads.length
      ? `<ul class="dl-list">${downloads
          .map((d) => {
            const r = byId.get(d.id);
            const name = r?.name || d.name || d.id.split("/").pop();
            return `
            <li class="dl ${r ? "tone-" + r.tone : ""}">
              <a class="dl__main" href="${routeHref(d.id)}" data-close>
                <span class="dl__thumb">${r ? thumb(r, 44) : icon("route")}</span>
                <span class="dl__text"><b>${esc(name)}</b>
                <span>${d.bytes ? fmt.bytes(d.bytes) : fmt.count(d.keys.length, ["тайл", "тайла", "тайлов"])}${d.complete === false ? " · не полностью" : ""}${d.savedAt ? " · " + new Date(d.savedAt).toLocaleDateString("ru-RU", { day: "numeric", month: "short" }) : ""}</span></span>
              </a>
              <button class="icon-btn icon-btn--sm" type="button" data-delete="${esc(d.id)}" aria-label="Удалить ${esc(name)}">${icon("trash", { size: 18 })}</button>
            </li>`;
          })
          .join("")}</ul>`
      : `<div class="empty empty--compact"><p class="empty__title">Пока ничего не скачано</p><p class="empty__text">Откройте маршрут и нажмите «Скачать» — карта будет работать без интернета.</p></div>`;

    content.innerHTML = `
      ${downloads.length ? `<p class="panel__lead"><b>${fmt.count(downloads.length, ["маршрут", "маршрута", "маршрутов"])}</b> · ${fmt.bytes(total)}</p>` : ""}
      ${list}
      ${usage}
      ${persist}
      ${downloads.length > 1 ? `<button class="btn btn--ghost btn--danger-text" type="button" data-clear>Удалить все карты</button>` : ""}
      <nav class="panel__links">
        <button class="link-row" type="button" data-onboarding>${icon("info", { size: 20 })}<span>Как пользоваться</span></button>
        <a class="link-row" href="${REPO_URL}#добавление-маршрута" target="_blank" rel="noopener">${icon("plusSquare", { size: 20 })}<span>Добавить свой маршрут<small>KML/KMZ через GitHub</small></span></a>
      </nav>
      <p class="attribution">Картографические данные © участники OpenStreetMap</p>`;
  }

  content.addEventListener("click", async (e) => {
    const del = e.target.closest("[data-delete]");
    if (del) {
      const ok = await confirmDialog({ title: "Удалить карту?", ok: "Удалить", danger: true });
      if (!ok) return;
      await store.deleteDownload(del.dataset.delete).catch((err) => toast(err.message, { tone: "danger" }));
      onChanged?.();
      return render();
    }
    if (e.target.closest("[data-clear]")) {
      const ok = await confirmDialog({
        title: "Удалить все офлайн-карты?",
        text: "Без сети маршруты станут недоступны, пока вы не скачаете их снова.",
        ok: "Удалить все",
        danger: true,
      });
      if (!ok) return;
      await store.clearAll().catch((err) => toast(err.message, { tone: "danger" }));
      onChanged?.();
      return render();
    }
    if (e.target.closest("[data-onboarding]")) {
      dlg.close();
      showOnboarding();
    }
  });

  await render();
}
