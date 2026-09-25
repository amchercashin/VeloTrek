/**
 * Каталог: поиск, фильтры по разделам и «скачанные», список и обзорная карта.
 */
import { $, $$, esc, debounce } from "../lib/dom.js";
import { count } from "../lib/format.js";
import { routeLines } from "../data/catalog.js";
import { icon } from "../ui/icons.js";
import { routeCard, routeHref } from "../ui/route-card.js";
import { createMap } from "../map/leaflet.js";
import { cssVar } from "../map/route-layer.js";

const FILTER_KEY = "versty:filter";

// Фильтр помним только в пределах сессии: при новом запуске видно весь каталог
const session = {
  get: () => {
    try {
      return sessionStorage.getItem(FILTER_KEY) || "all";
    } catch {
      return "all";
    }
  },
  set: (v) => {
    try {
      sessionStorage.setItem(FILTER_KEY, v);
    } catch {
      /* приватный режим */
    }
  },
};

export function createCatalogView(root, { onOpenDownloads }) {
  let catalog = null;
  let saved = new Set();
  let filter = session.get();
  let query = "";
  let mode = "list";
  let overview = null; // { map, L, lines: Map<id, layer[]> }
  let selectedId = null;

  root.innerHTML = `
    <header class="topbar">
      <a class="brand" href="#/" aria-label="Вёрсты — на главную">
        <svg class="brand__mark" viewBox="0 0 32 32" aria-hidden="true"><use href="#brand-mark"/></svg>
        <span class="brand__name">Вёрсты</span>
      </a>
      <div class="topbar__actions">
        <span class="net-pill" data-net>${icon("offline", { size: 16 })}Без сети</span>
        <button class="icon-btn" type="button" data-action="downloads" aria-label="Скачанные карты">
          ${icon("box")}<span class="icon-btn__badge" data-saved-count hidden></span>
        </button>
      </div>
    </header>

    <div class="hero">
      <h1 class="hero__title">Куда поедем?</h1>
      <p class="hero__sub" data-hero-sub>Веломаршруты по Москве и области. Скачайте карту — и едьте без интернета.</p>
    </div>

    <div class="toolbar">
      <div class="toolbar__row">
        <label class="search">
          ${icon("search", { size: 20 })}
          <input type="search" placeholder="Название, река, город" enterkeyhint="search" autocomplete="off" aria-label="Поиск маршрута" />
          <button class="search__clear" type="button" aria-label="Очистить" hidden>${icon("close", { size: 18 })}</button>
        </label>
        <div class="seg" role="group" aria-label="Вид">
          <button type="button" data-mode="list" aria-pressed="true" aria-label="Списком">${icon("list", { size: 20 })}</button>
          <button type="button" data-mode="map" aria-pressed="false" aria-label="На карте">${icon("map", { size: 20 })}</button>
        </div>
      </div>
      <div class="chips" role="group" aria-label="Разделы" data-chips></div>
    </div>

    <main class="catalog" data-list>
      ${skeleton()}
    </main>

    <div class="overview" data-overview hidden>
      <div class="overview__map" data-overview-map></div>
      <div class="overview__card" data-overview-card hidden></div>
    </div>`;

  const list = $("[data-list]", root);
  const chips = $("[data-chips]", root);
  const input = $(".search input", root);
  const clearBtn = $(".search__clear", root);

  // --- события ---------------------------------------------------------------
  $("[data-action=downloads]", root).addEventListener("click", onOpenDownloads);

  input.addEventListener(
    "input",
    debounce(() => {
      query = input.value.trim().toLowerCase().replace(/ё/g, "е");
      clearBtn.hidden = !query;
      applyFilter({ refit: true });
    }, 60),
  );
  clearBtn.addEventListener("click", () => {
    input.value = "";
    query = "";
    clearBtn.hidden = true;
    applyFilter();
    input.focus();
  });

  chips.addEventListener("click", (e) => {
    const chip = e.target.closest("[data-filter]");
    if (!chip) return;
    filter = chip.dataset.filter;
    session.set(filter);
    applyFilter({ refit: true });
    chip.scrollIntoView({ inline: "nearest", block: "nearest", behavior: "smooth" });
  });

  $$(".seg button", root).forEach((b) =>
    b.addEventListener("click", () => {
      const next = b.dataset.mode;
      location.hash = next === "map" ? "#/map" : "#/";
    }),
  );

  list.addEventListener("click", (e) => {
    if (e.target.closest("[data-reset]")) {
      filter = "all";
      input.value = "";
      query = "";
      clearBtn.hidden = true;
      applyFilter();
    }
  });

  // --- рендер -----------------------------------------------------------------
  function skeleton() {
    return `<div class="group" aria-busy="true">${'<div class="card card--skeleton"><span class="card__thumb"></span><span class="card__body"><span></span><span></span></span></div>'.repeat(6)}</div>`;
  }

  function renderChips() {
    const total = catalog.routes.length;
    const items = [
      { id: "all", label: "Все", n: total },
      ...catalog.sections.map((s) => ({ id: s.name, label: s.short, n: s.routes.length, tone: s.tone })),
      { id: "saved", label: "Скачанные", n: saved.size, saved: true },
    ];
    chips.innerHTML = items
      .map(
        (c) => `
        <button type="button" class="chip ${c.tone ? "tone-" + c.tone : ""} ${c.saved ? "chip--saved" : ""}"
          data-filter="${esc(c.id)}" aria-pressed="${c.id === filter}">
          ${c.saved ? icon("download", { size: 16 }) : c.tone ? '<span class="chip__dot"></span>' : ""}
          ${esc(c.label)}<span class="chip__n">${c.n}</span>
        </button>`,
      )
      .join("");
  }

  function renderList() {
    list.innerHTML =
      catalog.sections
        .map(
          (s) => `
          <section class="group tone-${s.tone}" data-section="${esc(s.name)}">
            <h2 class="group__title"><span class="group__dot"></span>${esc(s.name)}<span class="group__n">${s.routes.length}</span></h2>
            <div class="group__cards">
              ${catalog.routes.filter((r) => r.section === s.name).map((r) => routeCard(r)).join("")}
            </div>
          </section>`,
        )
        .join("") +
      `<div class="empty" data-empty hidden>
         <p class="empty__title">Ничего не нашлось</p>
         <p class="empty__text" data-empty-text></p>
         <button class="btn btn--ghost" type="button" data-reset>Показать все маршруты</button>
       </div>`;
  }

  function matches(route) {
    if (filter === "saved" && !saved.has(route.id)) return false;
    if (filter !== "all" && filter !== "saved" && route.section !== filter) return false;
    if (query && !route.search.includes(query)) return false;
    return true;
  }

  function applyFilter({ refit = false } = {}) {
    if (!catalog) return;
    // Раздел мог пропасть из каталога после обновления
    if (filter !== "all" && filter !== "saved" && !catalog.sections.some((s) => s.name === filter)) {
      filter = "all";
    }
    $$("[data-filter]", chips).forEach((c) => c.setAttribute("aria-pressed", String(c.dataset.filter === filter)));

    const visible = new Set(catalog.routes.filter(matches).map((r) => r.id));
    for (const card of $$(".card[data-id]", list)) card.hidden = !visible.has(card.dataset.id);
    for (const group of $$(".group[data-section]", list)) {
      group.hidden = !$(".card[data-id]:not([hidden])", group);
    }
    const empty = $("[data-empty]", list);
    empty.hidden = visible.size > 0;
    if (!visible.size) {
      $("[data-empty-text]", list).textContent =
        filter === "saved" && !query
          ? "Вы ещё не скачали ни одной карты. Откройте маршрут и нажмите «Скачать карту» — она будет доступна без интернета."
          : "Попробуйте другое название или сбросьте фильтр.";
    }
    if (overview && mode === "map") updateOverview(visible, { fit: refit });
  }

  function markSaved() {
    for (const card of $$(".card[data-id]", root)) {
      card.classList.toggle("is-saved", saved.has(card.dataset.id));
    }
    const badge = $("[data-saved-count]", root);
    badge.hidden = !saved.size;
    badge.textContent = saved.size;
    const chipN = $("[data-filter=saved] .chip__n", chips);
    if (chipN) chipN.textContent = saved.size;
  }

  // --- обзорная карта ----------------------------------------------------------
  async function ensureOverview() {
    if (overview) return overview;
    const { L, map } = await createMap($("[data-overview-map]", root));
    const renderer = L.canvas({ padding: 0.3, tolerance: 12 });
    const lines = new Map();
    for (const r of catalog.routes) {
      const color = cssVar(`--tone-${r.tone}`);
      const layers = routeLines(r).map((pts) =>
        L.polyline(pts, { renderer, color, weight: 3.5, opacity: 0.9, lineCap: "round" })
          .on("click", (e) => {
            L.DomEvent.stopPropagation(e);
            select(r.id);
          })
          .addTo(map),
      );
      lines.set(r.id, layers);
    }
    map.on("click", () => select(null));
    overview = { L, map, lines };
    return overview;
  }

  function updateOverview(visible, { fit = false } = {}) {
    const { L, map, lines } = overview;
    const bounds = L.latLngBounds([]);
    for (const [id, layers] of lines) {
      const show = visible.has(id);
      for (const l of layers) {
        if (show && !map.hasLayer(l)) l.addTo(map);
        if (!show && map.hasLayer(l)) l.remove();
        if (show) bounds.extend(l.getBounds());
      }
    }
    if (selectedId && !visible.has(selectedId)) select(null);
    if (fit && bounds.isValid()) map.fitBounds(bounds, { padding: [24, 24], maxZoom: 13 });
  }

  function select(id) {
    selectedId = id;
    const { lines } = overview;
    for (const [rid, layers] of lines) {
      for (const l of layers) {
        l.setStyle({
          weight: rid === id ? 6 : 3.5,
          opacity: id && rid !== id ? 0.35 : 0.9,
        });
        if (rid === id) l.bringToFront();
      }
    }
    const card = $("[data-overview-card]", root);
    const route = id && catalog.routes.find((r) => r.id === id);
    card.hidden = !route;
    if (route) {
      card.innerHTML = `${routeCard(route, { tag: "div" })}
        <a class="btn btn--primary overview__open" href="${routeHref(route.id)}">Открыть маршрут${icon("chevron", { size: 20 })}</a>`;
      card.querySelector(".card").classList.toggle("is-saved", saved.has(route.id));
    }
  }

  async function setMode(next) {
    mode = next;
    root.dataset.mode = mode;
    $$(".seg button", root).forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === mode)));
    const isMap = mode === "map";
    $("[data-overview]", root).hidden = !isMap;
    list.hidden = isMap;
    document.documentElement.classList.toggle("lock-scroll", isMap);
    if (isMap && catalog) {
      const first = !overview;
      try {
        await ensureOverview();
      } catch {
        return;
      }
      overview.map.invalidateSize();
      updateOverview(new Set(catalog.routes.filter(matches).map((r) => r.id)), { fit: first });
    }
  }

  return {
    setCatalog(next) {
      const firstRender = !catalog;
      catalog = next;
      $("[data-hero-sub]", root).textContent =
        `${count(catalog.routes.length, ["маршрут", "маршрута", "маршрутов"])} по Москве и области. Скачайте карту — и едьте без интернета.`;
      renderChips();
      renderList();
      markSaved();
      applyFilter();
      if (overview && !firstRender) {
        // Каталог обновился — перестраиваем обзорную карту с нуля
        overview.map.remove();
        overview = null;
        if (mode === "map") setMode("map");
      } else if (mode === "map") {
        setMode("map");
      }
    },
    setSaved(ids) {
      saved = new Set(ids);
      markSaved();
      if (catalog) applyFilter();
    },
    /** Прогресс скачивания на карточке (null — скачивание закончилось). */
    setProgress(id, progress) {
      for (const card of $$(`.card[data-id="${CSS.escape(id)}"]`, root)) {
        card.classList.toggle("is-downloading", !!progress);
        const pct = progress?.total ? progress.done / progress.total : 0;
        card.style.setProperty("--p", pct);
      }
    },
    setMode,
    get mode() {
      return mode;
    },
    showError(message, retry) {
      list.innerHTML = `
        <div class="empty">
          <p class="empty__title">Не удалось загрузить маршруты</p>
          <p class="empty__text">${esc(message)}</p>
          <button class="btn btn--primary" type="button" data-retry>Повторить</button>
        </div>`;
      $("[data-retry]", list).addEventListener("click", retry);
    },
  };
}
