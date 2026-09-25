/**
 * Экран маршрута: полноэкранная карта, шторка с главным (скачать / поехать)
 * и режим навигации с HUD.
 */
import { $, esc, storage, prefersReducedMotion } from "../lib/dom.js";
import * as fmt from "../lib/format.js";
import { sanitizeDescription } from "../lib/sanitize.js";
import { loadRoute, routeUrl } from "../data/route.js";
import * as tiles from "../data/tiles.js";
import * as store from "../data/offline-store.js";
import * as downloads from "../data/downloads.js";
import { createMap } from "../map/leaflet.js";
import { drawRoute, boundsOf } from "../map/route-layer.js";
import { createNavigator, requestCompassPermission } from "../nav/navigator.js";
import { createSheet } from "../ui/sheet.js";
import { icon } from "../ui/icons.js";
import { toast, confirmDialog } from "../ui/feedback.js";
import * as screen from "../ui/screen.js";

const SCREEN_TIP_KEY = "versty:tip-screen";

export function createRouteView(root, { onClose, onDownloadsChanged }) {
  root.innerHTML = `
    <div class="route-map" data-map></div>

    <div class="map-top">
      <button class="fab" type="button" data-action="back" aria-label="К списку маршрутов">${icon("back")}</button>
      <div class="map-top__right">
        <button class="fab fab--pill" type="button" data-action="fit" hidden>${icon("route", { size: 20 })}Весь маршрут</button>
      </div>
    </div>

    <aside class="sheet" data-state="peek" aria-label="Маршрут">
      <div class="sheet__head">
        <div class="sheet__grabber" aria-hidden="true"></div>
        <div class="sheet__kicker" data-kicker></div>
        <h1 class="sheet__title" data-title></h1>
        <div class="stats" data-stats></div>
        <div class="offline" data-offline data-state="checking"></div>
        <div class="sheet__actions" data-actions></div>
      </div>
      <div class="sheet__body" data-body></div>
    </aside>

    <div class="hud" data-hud hidden>
      <div class="hud__main">
        <div class="hud__speed"><b data-speed>—</b><span>км/ч</span></div>
        <div class="hud__progress">
          <div class="hud__progress-label"><span data-along>—</span><span class="hud__muted" data-of></span></div>
          <div class="hud__bar"><span data-bar></span></div>
        </div>
      </div>
      <div class="hud__status" data-status data-tone="wait">
        <span class="hud__arrow" data-arrow hidden>${icon("arrowUp", { size: 18 })}</span>
        <span class="hud__status-text" data-status-text>Ищем спутники…</span>
        <span class="hud__net" title="Без сети — карта из памяти телефона">${icon("offline", { size: 16 })}</span>
        <span class="hud__acc" data-acc></span>
      </div>
    </div>

    <div class="navbar" data-navbar hidden>
      <div class="navbar__stats">
        <div><b data-ridden>0</b><span>км проехано</span></div>
        <div><b data-elapsed>0:00</b><span>в пути</span></div>
      </div>
      <button class="fab fab--lg" type="button" data-action="follow" aria-pressed="true" aria-label="Следовать за мной">${icon("locate")}</button>
      <button class="btn btn--stop" type="button" data-action="stop">${icon("stop", { size: 20 })}Стоп</button>
    </div>

    <button class="fab fab--screen" type="button" data-action="screen" aria-label="Экран: яркость и стиль карты" hidden>${icon("sun")}</button>

    <div class="dimmer" aria-hidden="true"></div>

    <div class="screen-pop" data-screen-pop role="dialog" aria-label="Экран" hidden>
      <div class="screen-pop__head">
        <b>Экран</b>
        <button class="icon-btn icon-btn--sm" type="button" data-action="screen-close" aria-label="Закрыть">${icon("close", { size: 18 })}</button>
      </div>
      <div class="field">
        <span class="field__label">Карта</span>
        <div class="seg seg--text" role="radiogroup" aria-label="Стиль карты">
          <button type="button" role="radio" data-map-style="auto">Авто</button>
          <button type="button" role="radio" data-map-style="day">День</button>
          <button type="button" role="radio" data-map-style="night">Ночь</button>
        </div>
        <small class="field__hint">«Авто» — как тема телефона</small>
      </div>
      <label class="field">
        <span class="field__label">Затемнение <span class="field__value" data-dim-value></span></span>
        <input class="range" type="range" min="0" max="70" step="5" data-dim />
        <small class="field__hint">На OLED-экранах тёмная картинка тратит меньше заряда. Системную яркость браузер менять не умеет — её можно убавить в пункте управления телефона.</small>
      </label>
      <label class="switch">
        <input type="checkbox" data-keep-awake />
        <span class="switch__text"><b>Не гасить экран</b><small>Если выключить, экран погаснет как обычно, а позиция обновится, когда вы его включите</small></span>
      </label>
    </div>`;

  const els = {
    map: $("[data-map]", root),
    sheet: $(".sheet", root),
    kicker: $("[data-kicker]", root),
    title: $("[data-title]", root),
    stats: $("[data-stats]", root),
    offline: $("[data-offline]", root),
    actions: $("[data-actions]", root),
    body: $("[data-body]", root),
    hud: $("[data-hud]", root),
    navbar: $("[data-navbar]", root),
    fit: $("[data-action=fit]", root),
    screenBtn: $("[data-action=screen]", root),
    screenPop: $("[data-screen-pop]", root),
  };

  let L = null;
  let map = null;
  let mapReady = null;
  let layers = null;
  let current = null; // { id, meta, data, estimate, status, download }
  let nav = null;
  let openToken = 0;

  const sheet = createSheet(els.sheet, {
    onChange: () => {
      map?.invalidateSize({ pan: false });
      updateFitButton();
    },
  });

  // --- карта ------------------------------------------------------------------
  function ensureMap() {
    if (!mapReady) {
      mapReady = createMap(els.map).then((res) => {
        L = res.L;
        map = res.map;
        map.on("moveend", updateFitButton);
        return res;
      });
      mapReady.catch(() => (mapReady = null));
    }
    return mapReady;
  }

  function mapPadding() {
    const wide = window.matchMedia("(min-width: 900px)").matches;
    const sheetH = sheet.visibleHeight();
    return wide
      ? { paddingTopLeft: [els.sheet.offsetWidth + 40, 72], paddingBottomRight: [40, 40] }
      : { paddingTopLeft: [28, 84], paddingBottomRight: [28, sheetH + 28] };
  }

  function fitRoute(animate = false) {
    const bbox = current?.data?.bbox || current?.meta?.bbox;
    if (!map || !bbox) return;
    map.fitBounds(boundsOf(L, bbox), { ...mapPadding(), animate, maxZoom: 15 });
  }

  /**
   * «Весь маршрут» показываем, только когда маршрут ушёл из видимой части карты
   * или стал совсем мелким — сразу после открытия кнопка не нужна.
   */
  function updateFitButton() {
    const bbox = current?.data?.bbox || current?.meta?.bbox;
    if (!map || !bbox || nav || !map._loaded) {
      els.fit.hidden = true;
      return;
    }
    const b = boundsOf(L, bbox);
    const nw = map.latLngToContainerPoint(b.getNorthWest());
    const se = map.latLngToContainerPoint(b.getSouthEast());
    const size = map.getSize();
    const { paddingTopLeft: tl, paddingBottomRight: br } = mapPadding();
    const tol = 32;
    const areaW = size.x - tl[0] - br[0];
    const areaH = size.y - tl[1] - br[1];
    const inside =
      nw.x >= tl[0] - tol && nw.y >= tl[1] - tol && se.x <= size.x - br[0] + tol && se.y <= size.y - br[1] + tol;
    const tooSmall = se.x - nw.x < areaW * 0.3 && se.y - nw.y < areaH * 0.3;
    els.fit.hidden = inside && !tooSmall;
  }

  // --- экран: стиль карты, затемнение, «не гасить» --------------------------------
  function renderScreen(state) {
    root.style.setProperty("--dim", state.dim / 100);
    for (const b of els.screenPop.querySelectorAll("[data-map-style]")) {
      b.setAttribute("aria-checked", String(b.dataset.mapStyle === state.mapStyle));
    }
    $("[data-dim]", els.screenPop).value = state.dim;
    $("[data-dim-value]", els.screenPop).textContent = state.dim ? `${state.dim}%` : "нет";
    $("[data-keep-awake]", els.screenPop).checked = state.keepAwake;
  }
  screen.subscribe(renderScreen);
  renderScreen(screen.get());

  els.screenPop.addEventListener("click", (e) => {
    const style = e.target.closest("[data-map-style]");
    if (style) screen.set({ mapStyle: style.dataset.mapStyle });
  });
  $("[data-dim]", els.screenPop).addEventListener("input", (e) => screen.set({ dim: Number(e.target.value) }));
  $("[data-keep-awake]", els.screenPop).addEventListener("change", (e) => {
    screen.set({ keepAwake: e.target.checked });
    nav?.setKeepAwake(e.target.checked);
  });

  function toggleScreenPop(open = els.screenPop.hidden) {
    els.screenPop.hidden = !open;
    els.screenBtn.setAttribute("aria-expanded", String(open));
  }

  // Тап мимо панели закрывает её
  root.addEventListener("pointerdown", (e) => {
    if (!els.screenPop.hidden && !e.target.closest("[data-screen-pop], [data-action=screen]")) toggleScreenPop(false);
  });

  // --- шапка шторки --------------------------------------------------------------
  function renderHead() {
    const { meta, data } = current;
    const kicker = [meta?.sectionShort, meta?.direction, meta?.number != null ? `№${meta.number}` : null]
      .filter(Boolean)
      .join(" · ");
    els.sheet.className = `sheet tone-${meta?.tone || "green"}`;
    els.kicker.innerHTML = kicker ? `<span class="tone-dot"></span>${esc(kicker)}` : "";
    els.title.textContent = meta?.name || data?.name || "Маршрут";

    const km = data ? data.mainLength / 1000 : meta?.km;
    const pois = data ? data.pois.length : meta?.pois;
    const climb = data?.elevation?.climb ?? meta?.climb;
    const tracks = data ? data.segments.length : meta?.tracks;
    const stat = (value, unit, label) =>
      `<div class="stat"><span class="stat__value">${value}<small>${unit}</small></span><span class="stat__label">${label}</span></div>`;
    els.stats.innerHTML = [
      Number.isFinite(km) ? stat(fmt.kmValue(km), "км", tracks > 1 ? "основной трек" : "длина") : "",
      pois ? stat(fmt.int(pois), "", fmt.plural(pois, ["точка", "точки", "точек"])) : "",
      climb ? stat(fmt.int(climb), "м", "набор высоты") : "",
      tracks > 1 ? stat(`+${tracks - 1}`, "", fmt.plural(tracks - 1, ["вариант", "варианта", "вариантов"])) : "",
    ].join("");
  }

  // --- офлайн-карточка ----------------------------------------------------------
  function progressTitle(p) {
    if (p.phase === "queued") return "В очереди на скачивание";
    if (p.phase === "checking") return "Готовимся…";
    return `Скачиваем карту · ${p.total ? Math.floor((p.done / p.total) * 100) : 0}%`;
  }

  function progressText(p) {
    if (p.phase === "queued") return "Начнётся, когда скачается предыдущая карта";
    const est = current.estimate ? ` из ≈ ${fmt.bytes(Math.max(current.estimate.bytes, p.bytes))}` : "";
    return `${fmt.bytes(p.bytes)}${est} · не закрывайте приложение`;
  }

  function renderOffline() {
    const { status, estimate, download, error } = current;
    const box = els.offline;
    let state = status?.state || "checking";
    if (download) state = "downloading";
    if (error) state = "error";
    box.dataset.state = state;

    const est = estimate ? `≈ ${fmt.bytes(estimate.bytes)}` : "";
    const etaText = estimate ? fmt.eta(estimate.seconds) : "";
    let html = "";
    let actions = "";
    const go = `<button class="btn btn--go" type="button" data-action="go">${icon("go", { size: 20 })}Поехали</button>`;

    switch (state) {
      case "checking":
        html = `<div class="offline__row"><span class="offline__icon">${icon("download", { size: 20 })}</span><div class="offline__text"><b>Проверяем карту…</b></div></div>`;
        actions = go;
        break;
      case "none":
        html = `
          <div class="offline__row">
            <span class="offline__icon">${icon("download", { size: 20 })}</span>
            <div class="offline__text">
              <b>Карта не скачана</b>
              <span>${navigator.onLine ? `${est}${etaText ? " · " + etaText : ""}. Скачайте до поездки, пока есть Wi‑Fi` : "Нет сети — скачать сейчас не получится"}</span>
            </div>
          </div>`;
        actions = `<button class="btn btn--primary" type="button" data-action="download" ${navigator.onLine ? "" : "disabled"}>${icon("download", { size: 20 })}Скачать</button>${go}`;
        break;
      case "partial": {
        const pct = Math.round((status.ratio || 0) * 100);
        html = `
          <div class="offline__row">
            <span class="offline__icon">${icon("download", { size: 20 })}</span>
            <div class="offline__text">
              <b>Карта скачана на ${pct}%</b>
              <span>Докачайте недостающие участки, пока есть сеть</span>
            </div>
            <button class="icon-btn icon-btn--sm" type="button" data-action="delete" aria-label="Удалить карту">${icon("trash", { size: 18 })}</button>
          </div>`;
        actions = `<button class="btn btn--primary" type="button" data-action="download" ${navigator.onLine ? "" : "disabled"}>${icon("download", { size: 20 })}Докачать</button>${go}`;
        break;
      }
      case "downloading": {
        const pct = download.total ? Math.floor((download.done / download.total) * 100) : 0;
        html = `
          <div class="offline__row">
            <span class="offline__icon offline__icon--spin">${icon("download", { size: 20 })}</span>
            <div class="offline__text">
              <b>${progressTitle(download)}</b>
              <span>${progressText(download)}</span>
            </div>
          </div>
          <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" style="--p:${pct / 100}"><span></span></div>`;
        actions = `<button class="btn btn--ghost" type="button" data-action="cancel">Отменить</button>${go}`;
        break;
      }
      case "ready": {
        const size = status.manifest?.bytes ? fmt.bytes(status.manifest.bytes) : "";
        html = `
          <div class="offline__row">
            <span class="offline__icon">${icon("checkCircle", { size: 20 })}</span>
            <div class="offline__text">
              <b>Готово к поездке без сети</b>
              <span>Карта в памяти телефона${size ? " · " + size : ""}</span>
            </div>
            <button class="icon-btn icon-btn--sm" type="button" data-action="delete" aria-label="Удалить карту">${icon("trash", { size: 18 })}</button>
          </div>`;
        actions = go;
        break;
      }
      case "error":
        html = `
          <div class="offline__row">
            <span class="offline__icon">${icon("info", { size: 20 })}</span>
            <div class="offline__text"><b>Не получилось открыть маршрут</b><span>${esc(error)}</span></div>
          </div>`;
        actions = `<button class="btn btn--primary" type="button" data-action="retry">Повторить</button>`;
        break;
    }
    box.innerHTML = html;
    els.actions.innerHTML = actions;
    els.actions.dataset.count = els.actions.children.length;
  }

  function setDownloadProgress(p) {
    current.download = p;
    // Частые обновления: меняем только прогресс и подписи, без перерисовки кнопок
    const bar = $(".progress", els.offline);
    const title = $(".offline__text b", els.offline);
    const sub = $(".offline__text span", els.offline);
    if (!bar || !title || els.offline.dataset.state !== "downloading") return renderOffline();
    const pct = p.total ? Math.floor((p.done / p.total) * 100) : 0;
    bar.style.setProperty("--p", pct / 100);
    bar.setAttribute("aria-valuenow", pct);
    title.textContent = progressTitle(p);
    sub.textContent = progressText(p);
  }

  downloads.subscribe(({ id, job }) => {
    if (!current || id !== current.id) return;
    if (job) {
      setDownloadProgress(job.progress);
    } else {
      current.download = null;
      refreshStatus();
    }
  });

  async function refreshStatus() {
    if (!current?.data) return;
    const token = openToken;
    const status = await tiles.offlineStatus(current.id, current.data.segments);
    if (token !== openToken) return;
    current.status = status;
    renderOffline();
  }

  function startDownload() {
    const { id, data, meta } = current;
    downloads.enqueue(id, meta?.name || data.name, data);
  }

  async function deleteDownload() {
    const ok = await confirmDialog({
      title: "Удалить карту маршрута?",
      text: "Без сети этот маршрут будет недоступен, пока вы не скачаете его снова.",
      ok: "Удалить",
      danger: true,
    });
    if (!ok) return;
    try {
      await store.deleteDownload(current.id);
      toast("Карта удалена");
    } catch (e) {
      toast("Не удалось удалить: " + e.message, { tone: "danger" });
    }
    await refreshStatus();
    onDownloadsChanged?.();
  }

  // --- тело шторки ----------------------------------------------------------------
  function renderBody() {
    const { data, meta } = current;
    const parts = [];

    const profile = elevationProfile(data);
    if (profile) parts.push(profile);

    if (data.segments.length > 1) {
      const variants = data.segments.length - 1;
      parts.push(`
        <section class="block">
          <h2 class="block__title">Треки</h2>
          <div class="legend">
            <span class="legend__item"><i class="legend__main"></i>Основной · ${fmt.kmValue(data.mainLength / 1000)} км</span>
            <span class="legend__item"><i class="legend__alt"></i>${fmt.count(variants, ["вариант", "варианта", "вариантов"])} и подъезды</span>
          </div>
          <p class="muted">Всего в файле ${fmt.kmValue(data.totalLength / 1000)} км треков. Короткие показаны пунктиром.</p>
        </section>`);
    }

    const desc = sanitizeDescription(data.description);
    if (desc) {
      parts.push(`<section class="block"><h2 class="block__title">О маршруте</h2><div class="prose">${desc}</div></section>`);
    }

    if (data.pois.length) {
      parts.push(`
        <section class="block">
          <h2 class="block__title">Точки на маршруте <span class="block__n">${data.pois.length}</span></h2>
          <ol class="poi-list">
            ${data.pois
              .map(
                (p, i) => `
              <li><button type="button" class="poi" data-poi="${i}">
                <span class="poi__n">${i + 1}</span>
                <span class="poi__name">${esc(p.name || "Без названия")}</span>
                ${icon("chevron", { size: 18, cls: "poi__chev" })}
              </button></li>`,
              )
              .join("")}
          </ol>
        </section>`);
    }

    parts.push(`
      <section class="block block--links">
        <a class="link-row" href="${esc(routeUrl(current.id))}" download>${icon("download", { size: 20 })}<span>Скачать файл трека (${current.id.split(".").pop().toUpperCase()})<small>для OsmAnd, Organic Maps, Locus, часов</small></span></a>
      </section>
      <p class="attribution">Карта © участники OpenStreetMap${meta?.section ? " · Раздел «" + esc(meta.section) + "»" : ""}</p>`);

    els.body.innerHTML = parts.join("");
  }

  function elevationProfile(data) {
    if (!data.elevation?.climb) return "";
    const idx = data.lengths.indexOf(data.mainLength);
    const seg = data.segments[idx];
    const pts = [];
    let dist = 0;
    for (let i = 0; i < seg.length; i++) {
      if (i) {
        const a = seg[i - 1];
        const b = seg[i];
        const kx = Math.cos((a[0] * Math.PI) / 180) * 111320;
        dist += Math.hypot((b[1] - a[1]) * kx, (b[0] - a[0]) * 110574);
      }
      if (Number.isFinite(seg[i][2])) pts.push([dist, seg[i][2]]);
    }
    if (pts.length < 10) return "";
    const W = 320;
    const H = 72;
    const minE = Math.min(...pts.map((p) => p[1]));
    const maxE = Math.max(...pts.map((p) => p[1]));
    const span = Math.max(20, maxE - minE);
    const step = Math.max(1, Math.floor(pts.length / 240));
    const xy = [];
    for (let i = 0; i < pts.length; i += step) {
      xy.push(`${((pts[i][0] / dist) * W).toFixed(1)},${(H - 4 - ((pts[i][1] - minE) / span) * (H - 12)).toFixed(1)}`);
    }
    const line = "M" + xy.join("L");
    return `
      <section class="block">
        <h2 class="block__title">Профиль высот</h2>
        <svg class="profile" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-label="Профиль высот: от ${minE} до ${maxE} м">
          <path class="profile__area" d="${line}L${W},${H}L0,${H}Z"/>
          <path class="profile__line" d="${line}"/>
        </svg>
        <div class="profile__legend"><span>${fmt.int(minE)}–${fmt.int(maxE)} м</span><span>↗ ${fmt.int(data.elevation.climb)} м · ↘ ${fmt.int(data.elevation.descent)} м</span></div>
      </section>`;
  }

  // --- навигация ------------------------------------------------------------------
  const hud = {
    speed: $("[data-speed]", root),
    along: $("[data-along]", root),
    of: $("[data-of]", root),
    bar: $("[data-bar]", root),
    status: $("[data-status]", root),
    statusText: $("[data-status-text]", root),
    arrow: $("[data-arrow]", root),
    acc: $("[data-acc]", root),
    ridden: $("[data-ridden]", root),
    elapsed: $("[data-elapsed]", root),
    follow: $("[data-action=follow]", root),
  };

  function setStatus(tone, text) {
    if (hud.status.dataset.tone !== tone) hud.status.dataset.tone = tone;
    if (hud.statusText.textContent !== text) hud.statusText.textContent = text;
  }

  function onNavUpdate(u) {
    if (u.state === "error") {
      setStatus(u.code === 1 ? "danger" : "wait", u.message);
      hud.arrow.hidden = true;
      if (u.code === 1) {
        stopNav();
        toast(u.message, { tone: "danger", duration: 6000 });
      }
      return;
    }
    hud.speed.textContent = u.speedKmh === null ? "—" : fmt.oneDecimal(u.speedKmh);
    hud.acc.textContent = `±${fmt.int(u.accuracy)} м`;
    hud.acc.classList.toggle("is-poor", u.state === "poor");

    const near = u.near;
    if (near) {
      const alongKm = near.along / 1000;
      const totalKm = near.segmentLength / 1000;
      hud.along.textContent = `км ${fmt.kmValue(alongKm)}`;
      hud.of.textContent = ` из ${fmt.kmValue(totalKm)}`;
      hud.bar.style.transform = `scaleX(${totalKm ? Math.min(1, alongKm / totalKm) : 0})`;
      if (u.offRoute) {
        setStatus("danger", `${fmt.distance(near.distance)} до трека`);
        hud.arrow.hidden = false;
        hud.arrow.style.transform = `rotate(${near.bearingTo}deg)`;
      } else {
        setStatus(u.state === "poor" ? "wait" : "ok", u.state === "poor" ? "Слабый сигнал GPS" : "На маршруте");
        hud.arrow.hidden = true;
      }
    }
    hud.ridden.textContent = fmt.kmValue(u.ridden / 1000);
    hud.elapsed.textContent = fmt.duration(u.elapsed);
  }

  function hudInsets() {
    // offsetTop/offsetHeight, а не getBoundingClientRect: на них не влияет анимация появления
    const top = els.hud.offsetTop + els.hud.offsetHeight;
    const bottom = root.offsetHeight - els.navbar.offsetTop;
    // Тосты в поездке встают под HUD, кнопка «Экран» — над нижней панелью
    document.documentElement.style.setProperty("--hud-bottom", `${top}px`);
    root.style.setProperty("--navbar-top", `${bottom}px`);
    nav?.setInsets({ top, bottom });
  }

  async function startNav() {
    if (!current?.data || nav) return;
    // Разрешение на компас на iOS — строго первым действием в обработчике нажатия
    const compass = requestCompassPermission();
    const status = current.status?.state;
    if (status !== "ready") {
      toast(
        navigator.onLine
          ? "Карта не скачана: без сети участки маршрута будут пустыми"
          : "Карта не скачана — без сети фон карты может быть пустым",
        { duration: 5000 },
      );
    }
    await compass;
    try {
      nav = createNavigator({
        L,
        map,
        route: current.data,
        onUpdate: onNavUpdate,
        onFollowChange: (on) => {
          hud.follow.setAttribute("aria-pressed", String(on));
        },
        keepAwake: screen.get().keepAwake,
      });
      nav.start();
    } catch (e) {
      nav = null;
      toast(e.message, { tone: "danger" });
      return;
    }
    setStatus("wait", "Ищем спутники…");
    hud.speed.textContent = "—";
    hud.along.textContent = "—";
    hud.of.textContent = "";
    hud.bar.style.transform = "scaleX(0)";
    hud.acc.textContent = "";
    root.classList.add("is-navigating");
    document.documentElement.classList.add("nav-active");
    els.hud.hidden = false;
    els.navbar.hidden = false;
    els.screenBtn.hidden = false;
    sheet.setState("hidden");
    els.fit.hidden = true;
    requestAnimationFrame(hudInsets);
    // Отдельная запись в истории: кнопка «назад» сначала спросит про остановку навигации
    history.pushState({ versty: "nav" }, "");

    // Один раз подсказываем про яркость: в поездке экран — главный потребитель батареи
    if (!storage.get(SCREEN_TIP_KEY)) {
      storage.set(SCREEN_TIP_KEY, true);
      setTimeout(() => {
        if (!nav) return;
        toast("Экран — главный расход батареи в поездке. Затемните картинку", {
          duration: 8000,
          action: { label: "Настроить", onClick: () => toggleScreenPop(true) },
        });
      }, 2500);
    }
  }

  function stopNav({ fromHistory = false } = {}) {
    if (!nav) return;
    nav.stop();
    nav = null;
    toggleScreenPop(false);
    root.classList.remove("is-navigating");
    document.documentElement.classList.remove("nav-active");
    els.screenBtn.hidden = true;
    els.hud.hidden = true;
    els.navbar.hidden = true;
    sheet.setState("peek");
    requestAnimationFrame(() => fitRoute(true));
    if (!fromHistory && history.state?.versty === "nav") history.back();
  }

  window.addEventListener("popstate", async () => {
    if (!nav || history.state?.versty === "nav") return;
    // «Назад» во время поездки — случайно нажать легко, поэтому переспрашиваем
    history.pushState({ versty: "nav" }, "");
    const ok = await confirmDialog({
      title: "Завершить навигацию?",
      text: "Запись поездки и слежение за маршрутом остановятся.",
      ok: "Завершить",
      cancel: "Продолжить",
    });
    if (ok) stopNav();
  });

  // --- действия ---------------------------------------------------------------------
  root.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action], [data-poi]");
    if (!btn) return;
    if (btn.dataset.poi) return focusPoi(Number(btn.dataset.poi));
    switch (btn.dataset.action) {
      case "back":
        return onClose();
      case "fit":
        return fitRoute(true);
      case "screen":
        return toggleScreenPop();
      case "screen-close":
        return toggleScreenPop(false);
      case "download":
        return startDownload();
      case "cancel":
        return downloads.cancel(current.id);
      case "delete":
        return deleteDownload();
      case "go":
        return startNav();
      case "stop":
        return stopNav();
      case "follow":
        return nav?.setFollow(true);
      case "retry":
        return open(current.id, current.meta);
    }
  });

  function focusPoi(i) {
    const marker = layers?.poiMarkers[i];
    if (!marker) return;
    sheet.setState("peek");
    requestAnimationFrame(() => {
      const target = marker.getLatLng();
      const zoom = Math.max(map.getZoom(), 14);
      // Точка должна оказаться в видимой части карты над шторкой
      const shift = sheet.visibleHeight() / 2 - 20;
      const p = map.project(target, zoom).add([0, shift]);
      map.flyTo(map.unproject(p, zoom), zoom, { duration: prefersReducedMotion() ? 0 : 0.6 });
      map.once("moveend", () => marker.openPopup());
    });
  }

  // --- жизненный цикл -------------------------------------------------------------------
  async function open(id, meta) {
    const token = ++openToken;
    if (nav) stopNav({ fromHistory: true });
    const job = downloads.get(id);
    current = { id, meta, data: null, status: null, estimate: null, download: job?.progress || null, error: null };

    root.hidden = false;
    requestAnimationFrame(() => root.classList.add("is-open"));
    renderHead();
    renderOffline();
    els.body.innerHTML = `<div class="block"><div class="skeleton-lines"><span></span><span></span><span></span></div></div>`;
    sheet.setState("peek", { animate: false });
    sheet.measure();

    try {
      await ensureMap();
      if (token !== openToken) return;
      map.invalidateSize();
      layers?.group.remove();
      layers = null;
      if (meta?.bbox) fitRoute(false);

      const { data } = await loadRoute(id, {
        onRefresh: (fresh) => {
          if (token !== openToken) return;
          showData(fresh);
          toast("Маршрут обновился");
        },
      });
      if (token !== openToken) return;
      showData(data);
    } catch (e) {
      if (token !== openToken) return;
      current.error = e.message;
      renderOffline();
      els.body.innerHTML = "";
    }
  }

  function showData(data) {
    current.data = data;
    current.estimate = tiles.estimate(data.segments);
    layers?.group.remove();
    layers = drawRoute(L, map, data);
    renderHead();
    renderBody();
    sheet.measure();
    fitRoute(false);
    refreshStatus();
  }

  function close() {
    if (nav) stopNav({ fromHistory: true });
    openToken++;
    root.classList.remove("is-open");
    const done = () => {
      if (!root.classList.contains("is-open")) root.hidden = true;
    };
    if (prefersReducedMotion()) done();
    else setTimeout(done, 260);
  }

  window.addEventListener("online", () => current?.data && renderOffline());
  window.addEventListener("offline", () => current?.data && renderOffline());
  window.addEventListener("resize", () => nav && hudInsets());

  /** Метаданные из каталога пришли позже, чем открылся маршрут (прямая ссылка). */
  function setMeta(meta) {
    if (!current || current.meta || !meta) return;
    current.meta = meta;
    renderHead();
    if (!current.data) fitRoute(false);
  }

  return {
    open,
    close,
    setMeta,
    preload: ensureMap,
    get navigating() {
      return !!nav;
    },
    get currentId() {
      return current?.id ?? null;
    },
  };
}
