/**
 * Каталог маршрутов VeloTrek.
 * Загружает routes/index.json (генерируется GitHub Action),
 * кэширует результат в localStorage для работы оффлайн.
 */
const App = (() => {
  const CACHE_KEY = "velotrek-catalog";
  const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 часа
  const PREVIEW_LIMIT = 4; // Маршрутов показывается без разворачивания

  // Определяем базовый URL для загрузки файлов маршрутов
  function getRouteBaseUrl() {
    const hostname = window.location.hostname;
    const pathname = window.location.pathname;

    // GitHub Pages: username.github.io/repo-name/
    if (hostname.endsWith(".github.io")) {
      const owner = hostname.replace(".github.io", "");
      const pathParts = pathname.split("/").filter(Boolean);
      const repo = pathParts[0] || "";
      const base = repo ? `/${repo}` : "";
      return { base, owner, repo };
    }

    // Локальная разработка и прочее
    return { base: "", owner: null, repo: null };
  }

  function getCachedCatalog() {
    try {
      const cached = localStorage.getItem(CACHE_KEY);
      if (!cached) return null;
      const data = JSON.parse(cached);
      if (Date.now() - data.timestamp > CACHE_TTL) return null;
      return data.sections;
    } catch {
      return null;
    }
  }

  function setCachedCatalog(sections) {
    try {
      localStorage.setItem(
        CACHE_KEY,
        JSON.stringify({
          timestamp: Date.now(),
          sections,
        }),
      );
    } catch {
      // localStorage недоступен или заполнен
    }
  }

  async function loadCatalog(onUpdate) {
    const cached = getCachedCatalog();

    if (cached && onUpdate) {
      // Stale-while-revalidate: отдаём кэш мгновенно, обновляем в фоне
      fetch("routes/index.json")
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (data) {
            const sections = data.sections || [];
            setCachedCatalog(sections);
            onUpdate(sections);
          }
        })
        .catch(() => {});
      return cached;
    }

    try {
      const response = await fetch("routes/index.json");
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const sections = data.sections || [];
      setCachedCatalog(sections);
      return sections;
    } catch (e) {
      // При ошибке сети — используем кэш
      if (cached) return cached;
      throw new Error(`Не удалось загрузить каталог: ${e.message}`);
    }
  }

  function renderRouteCard(route) {
    const stats = route.stats || {};
    const track = stats.track_km ? `${Math.round(stats.track_km)} км` : "";
    const span = stats.span_km ? `${Math.round(stats.span_km)} км` : "";
    const elevation =
      stats.elevation_min_m && stats.elevation_max_m
        ? `${stats.elevation_min_m}–${stats.elevation_max_m} м`
        : "";
    const climb = stats.climb_m ? `${stats.climb_m} м` : "";
    const descent = stats.descent_m ? `${stats.descent_m} м` : "";

    return `
      <div class="route-card" data-route="${encodeURIComponent(route.filename)}">
        <h2 class="route-card__title">${escapeHtml(route.name)}</h2>
        <div class="route-card__stats">
          ${track ? `<span class="stat" title="Суммарная длина трека"><span class="stat__icon">🗺️</span> ${track}</span>` : ""}
          ${span ? `<span class="stat" title="Размах (диагональ)"><span class="stat__icon">📏</span> ${span}</span>` : ""}
          ${elevation ? `<span class="stat" title="Высоты мин–макс"><span class="stat__icon">⛰</span> ${elevation}</span>` : ""}
          ${climb ? `<span class="stat" title="Суммарный подъём"><span class="stat__icon">↗</span> ${climb}</span>` : ""}
          ${descent ? `<span class="stat" title="Суммарный спуск"><span class="stat__icon">↘</span> ${descent}</span>` : ""}
          ${route.poiCount ? `<span class="stat" title="Точки интереса"><span class="stat__icon">📍</span> ${route.poiCount} точек</span>` : ""}
        </div>
        ${route.error ? `<p class="route-card__error">Ошибка загрузки</p>` : ""}
      </div>
    `;
  }

  function renderSection(section) {
    const routes = section.routes || [];
    const count = routes.length;
    const name = escapeHtml(section.name);

    if (count <= PREVIEW_LIMIT) {
      return `
        <section class="catalog-section">
          <h2 class="section-header">${name}</h2>
          ${routes.map(renderRouteCard).join("")}
        </section>`;
    }

    return `
      <section class="catalog-section catalog-section--collapsible">
        <button class="section-header section-header--toggle" aria-expanded="false">
          <span>${name}</span>
          <span class="section-header__meta">${count} <span class="section-chevron">&#9658;</span></span>
        </button>
        <div class="section-routes">
          ${routes.map(renderRouteCard).join("")}
        </div>
      </section>`;
  }

  function renderCatalog(sections, container) {
    const totalRoutes = sections.reduce(
      (n, s) => n + (s.routes || []).length,
      0,
    );
    if (totalRoutes === 0) {
      container.innerHTML =
        '<p class="empty-state">Маршруты не найдены. Добавьте KML-файл в папку <code>routes/</code> репозитория.</p>';
      return;
    }

    container.innerHTML = sections.map(renderSection).join("");

    // Точная высота peek: 3 полных карточки + половина 4-й (измеряем после layout)
    function updatePeekHeights() {
      container
        .querySelectorAll(".catalog-section--collapsible")
        .forEach((s) => {
          const routesDiv = s.querySelector(".section-routes");
          const cards = routesDiv.querySelectorAll(".route-card");
          if (cards.length < 4) return;
          let h = 0;
          for (let i = 0; i < 3; i++) {
            h +=
              cards[i].getBoundingClientRect().height +
              parseInt(getComputedStyle(cards[i]).marginBottom);
          }
          h += Math.round(cards[3].getBoundingClientRect().height / 2);
          routesDiv.style.setProperty("--peek-max-height", h + "px");
        });
    }
    requestAnimationFrame(updatePeekHeights);

    // Пересчёт при изменении ширины окна (поворот экрана, ресайз)
    if (container._resizeHandler) {
      window.removeEventListener("resize", container._resizeHandler);
    }
    let resizeTimer = null;
    container._resizeHandler = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(updatePeekHeights, 150);
    };
    window.addEventListener("resize", container._resizeHandler);

    // Снимаем старые обработчики (stale-while-revalidate может вызвать renderCatalog дважды)
    if (container._catalogClickHandler) {
      container.removeEventListener("click", container._catalogClickHandler);
    }
    if (container._catalogTouchStartHandler) {
      container.removeEventListener(
        "touchstart",
        container._catalogTouchStartHandler,
      );
      container.removeEventListener(
        "touchend",
        container._catalogTouchEndHandler,
      );
      container.removeEventListener(
        "touchmove",
        container._catalogTouchMoveHandler,
      );
    }

    // Long press для раскрытия свёрнутой секции
    let longPressTimer = null;
    let longPressStartX = 0;
    let longPressStartY = 0;

    const touchStartHandler = (e) => {
      const routesDiv = e.target.closest(
        ".catalog-section--collapsible:not(.is-expanded) .section-routes",
      );
      if (!routesDiv) return;
      const t = e.touches[0];
      longPressStartX = t.clientX;
      longPressStartY = t.clientY;
      longPressTimer = setTimeout(() => {
        const section = routesDiv.closest(".catalog-section--collapsible");
        if (section && !section.classList.contains("is-expanded")) {
          section.classList.add("is-expanded");
          section
            .querySelector(".section-header--toggle")
            .setAttribute("aria-expanded", "true");
        }
        longPressTimer = null;
      }, 400);
    };

    const touchEndHandler = () => {
      if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
    };

    const touchMoveHandler = (e) => {
      if (longPressTimer) {
        const t = e.touches[0];
        if (
          Math.abs(t.clientX - longPressStartX) > 8 ||
          Math.abs(t.clientY - longPressStartY) > 8
        ) {
          clearTimeout(longPressTimer);
          longPressTimer = null;
        }
      }
    };

    const clickHandler = (e) => {
      if (e.target.closest("a")) return;

      const toggleBtn = e.target.closest(".section-header--toggle");
      if (toggleBtn) {
        const section = toggleBtn.closest(".catalog-section--collapsible");
        if (section) {
          const expanding = !section.classList.contains("is-expanded");
          section.classList.toggle("is-expanded", expanding);
          toggleBtn.setAttribute("aria-expanded", String(expanding));
          if (!expanding) {
            toggleBtn.scrollIntoView({ behavior: "smooth", block: "start" });
          }
        }
        return;
      }

      // Навигация по карточке
      const card = e.target.closest(".route-card");
      if (card && card.dataset.route) {
        try {
          sessionStorage.setItem("velotrek-catalog-scroll", window.scrollY);
        } catch {}
        window.location.href = `route.html?route=${card.dataset.route}`;
      }
    };

    container._catalogClickHandler = clickHandler;
    container._catalogTouchStartHandler = touchStartHandler;
    container._catalogTouchEndHandler = touchEndHandler;
    container._catalogTouchMoveHandler = touchMoveHandler;

    container.addEventListener("click", clickHandler);
    container.addEventListener("touchstart", touchStartHandler, {
      passive: true,
    });
    container.addEventListener("touchend", touchEndHandler, { passive: true });
    container.addEventListener("touchmove", touchMoveHandler, {
      passive: true,
    });

    // Авто-сворачивание: когда последняя карточка расширенного раздела уходит выше экрана
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting && entry.boundingClientRect.bottom < 0) {
            const section = entry.target.closest(
              ".catalog-section--collapsible",
            );
            if (section && section.classList.contains("is-expanded")) {
              section.classList.remove("is-expanded");
              section
                .querySelector(".section-header--toggle")
                .setAttribute("aria-expanded", "false");
            }
          }
        });
      },
      { threshold: 0 },
    );

    container.querySelectorAll(".catalog-section--collapsible").forEach((s) => {
      const cards = s.querySelectorAll(".route-card");
      const lastCard = cards[cards.length - 1];
      if (lastCard) observer.observe(lastCard);
    });
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  /** Извлекает чистый текст из HTML-описания (KML CDATA) */
  function stripHtml(html) {
    const tmp = document.createElement("div");
    tmp.innerHTML = html.replace(/<br\s*\/?>/gi, " ");
    return (tmp.textContent || "").replace(/\s+/g, " ").trim();
  }

  /** Превращает URL в тексте в кликабельные ссылки */
  function linkify(text) {
    return text.replace(/https?:\/\/[^\s<>"']+/g, (url) => {
      const clean = url.replace(/[.,;:!?)]+$/, "");
      const tail = url.slice(clean.length);
      return `<a href="${clean}" target="_blank" rel="noopener noreferrer" class="desc-link">${clean}</a>${tail}`;
    });
  }

  function detectRepo() {
    const hostname = window.location.hostname;
    const pathname = window.location.pathname;
    if (hostname.endsWith(".github.io")) {
      const owner = hostname.replace(".github.io", "");
      const pathParts = pathname.split("/").filter(Boolean);
      const repo = pathParts[0] || owner + ".github.io";
      return { owner, repo };
    }
    const body = document.body;
    if (body.dataset.owner && body.dataset.repo) {
      return { owner: body.dataset.owner, repo: body.dataset.repo };
    }
    return null;
  }

  return { loadCatalog, renderCatalog, detectRepo };
})();

/**
 * Обновление Service Worker.
 * Проверяет обновления при загрузке и каждый час.
 * Показывает тост «Доступно обновление» при смене контроллера.
 */
const SWUpdater = (() => {
  let hadController = !!(
    navigator.serviceWorker && navigator.serviceWorker.controller
  );

  async function init() {
    if (!("serviceWorker" in navigator)) return;

    try {
      const reg = await navigator.serviceWorker.register("sw.js");
      console.log("SW:", reg.scope);

      // Проверить обновления прямо сейчас
      reg.update().catch(() => {});

      // Периодическая проверка — каждый час
      setInterval(
        () => {
          reg.update().catch(() => {});
        },
        60 * 60 * 1000,
      );
    } catch (err) {
      console.warn("SW ошибка:", err);
    }

    // Когда новый SW берёт контроль — показать тост (но не при первой установке)
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (hadController) showToast();
      hadController = true;
    });
  }

  function showToast() {
    if (document.querySelector(".update-toast")) return;
    const toast = document.createElement("div");
    toast.className = "update-toast";
    toast.innerHTML =
      "<span>Доступно обновление</span>" +
      '<button class="update-toast__btn" onclick="location.reload()">Обновить</button>' +
      '<button class="update-toast__close" onclick="this.parentElement.remove()">\u00d7</button>';
    document.body.appendChild(toast);
  }

  return { init };
})();
