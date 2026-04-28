/**
 * Оркестратор страницы маршрута VeloTrek.
 * Загружает маршрут, инициализирует карту, управляет скачиванием и GPS.
 */
const RoutePage = (() => {
  let routeData = null;
  let downloadController = null;

  /** Превращает URL в тексте в кликабельные ссылки */
  function linkify(text) {
    return text.replace(/https?:\/\/[^\s<>"']+/g, (url) => {
      const clean = url.replace(/[.,;:!?)]+$/, "");
      const tail = url.slice(clean.length);
      return `<a href="${clean}" target="_blank" rel="noopener noreferrer" class="desc-link">${clean}</a>${tail}`;
    });
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function sanitizeDescriptionHtml(html) {
    const template = document.createElement("template");
    template.innerHTML = html;
    const allowedTags = new Set([
      "A",
      "B",
      "BR",
      "EM",
      "I",
      "LI",
      "OL",
      "P",
      "STRONG",
      "UL",
    ]);

    function cleanNode(node) {
      for (const child of [...node.childNodes]) {
        if (child.nodeType === Node.ELEMENT_NODE) {
          if (!allowedTags.has(child.tagName)) {
            if (["IFRAME", "SCRIPT", "STYLE"].includes(child.tagName)) {
              child.remove();
              continue;
            }
            cleanNode(child);
            child.replaceWith(...child.childNodes);
            continue;
          }

          for (const attr of [...child.attributes]) {
            const name = attr.name.toLowerCase();
            if (name.startsWith("on")) {
              child.removeAttribute(attr.name);
              continue;
            }
            if (child.tagName !== "A" || !["href", "target", "rel", "class"].includes(name)) {
              child.removeAttribute(attr.name);
            }
          }

          if (child.tagName === "A") {
            const href = child.getAttribute("href") || "";
            let safeHref = false;
            try {
              const parsed = new URL(href, window.location.href);
              safeHref = ["http:", "https:", "mailto:"].includes(parsed.protocol);
            } catch {}
            if (!safeHref) child.removeAttribute("href");
            child.setAttribute("target", "_blank");
            child.setAttribute("rel", "noopener noreferrer");
            child.classList.add("desc-link");
          }
        } else if (child.nodeType !== Node.TEXT_NODE) {
          child.remove();
          continue;
        }
        cleanNode(child);
      }
    }

    cleanNode(template.content);
    return template.innerHTML;
  }

  /** Показать toast-уведомление (не блокирующий alert) */
  function showToast(msg, duration = 3500) {
    const existing = document.querySelector(".toast");
    if (existing) existing.remove();
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), duration);
  }

  async function init() {
    const params = new URLSearchParams(window.location.search);
    const filename = params.get("route");

    if (!filename) {
      showError("Маршрут не указан");
      return;
    }

    showLoading();

    try {
      routeData = await loadRoute(filename);
      render(routeData);
      initMap(routeData);
      initDownload(routeData, filename);
      initGPS(routeData);
      checkOfflineStatus(routeData, filename);
    } catch (e) {
      showError(`Ошибка загрузки маршрута: ${e.message}`);
    }
  }

  async function loadRoute(filename) {
    const repo = App.detectRepo();
    let url;

    if (repo) {
      url = `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/main/routes/${filename}`;
    } else {
      // Локальная разработка или прямой деплой
      url = `routes/${filename}`;
    }

    return KMLParser.loadFromUrl(url);
  }

  function render(data) {
    document.getElementById("loading").classList.add("hidden");
    document.getElementById("route-content").classList.remove("hidden");

    document.getElementById("route-name").textContent = data.name;
    document.getElementById("header-title").textContent = data.name;

    // Описание не показываем вверху — только название и статистика
    document.getElementById("route-desc").classList.add("hidden");

    // Описание из KML рендерим ниже карты и кнопок
    const rawDesc = data.description || "";
    const descSection = document.getElementById("route-description");
    if (rawDesc && rawDesc.includes("<")) {
      descSection.innerHTML = sanitizeDescriptionHtml(rawDesc);
      descSection.classList.remove("hidden");
    }

    const statsEl = document.getElementById("route-stats");
    const stats = data.stats || {};

    const parts = [];
    if (stats.track_km) parts.push(`🗺️ ${Math.round(stats.track_km)} км`);
    if (stats.span_km) parts.push(`📏 ${Math.round(stats.span_km)} км`);
    if (stats.elevation_min_m && stats.elevation_max_m)
      parts.push(`⛰ ${stats.elevation_min_m}–${stats.elevation_max_m} м`);
    if (stats.climb_m) parts.push(`↗ ${stats.climb_m} м`);
    if (stats.descent_m) parts.push(`↘ ${stats.descent_m} м`);
    if (data.pois.length) parts.push(`📍 ${data.pois.length} точек`);
    statsEl.innerHTML = parts
      .map((p) => `<span class="stat">${p}</span>`)
      .join("");
  }

  function initMap(data) {
    const map = VeloMap.init("map");
    VeloMap.showRoute(data);
    initFullscreen(map);
  }

  function initFullscreen(map) {
    const btn = VeloMap.getFullscreenBtn();
    if (!btn) return;

    const svgs = VeloMap.getFullscreenSVGs();

    function toggle(enter) {
      const isFs =
        typeof enter === "boolean"
          ? enter
            ? document.body.classList.add("fullscreen-map") || true
            : document.body.classList.remove("fullscreen-map") || false
          : document.body.classList.toggle("fullscreen-map");
      const on = document.body.classList.contains("fullscreen-map");

      btn.innerHTML = on ? svgs.COLLAPSE_SVG : svgs.EXPAND_SVG;
      btn.title = on ? "Обычный режим" : "Полный экран";
      setTimeout(() => map.invalidateSize(), 50);
    }

    btn.addEventListener("click", () => toggle());

    document.addEventListener("keydown", (e) => {
      if (
        e.key === "Escape" &&
        document.body.classList.contains("fullscreen-map")
      ) {
        toggle(false);
      }
    });
  }

  /** Построить URL KML-файла (тот же формат что и loadRoute) */
  function getRouteUrl(filename) {
    const repo = App.detectRepo();
    if (repo) {
      return `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/main/routes/${filename}`;
    }
    return new URL(`routes/${filename}`, location.href).href;
  }

  /** Спросить SW: закэширован ли KML? */
  function isKmlCached(filename) {
    if (!navigator.serviceWorker || !navigator.serviceWorker.controller) {
      return Promise.resolve(false);
    }
    const url = getRouteUrl(filename);
    return new Promise((resolve) => {
      const ch = new MessageChannel();
      ch.port1.onmessage = (e) => resolve(e.data?.payload?.cached || false);
      setTimeout(() => resolve(false), 2000);
      navigator.serviceWorker.controller.postMessage(
        { type: "CHECK_ROUTE_CACHED", payload: { url } },
        [ch.port2],
      );
    });
  }

  /** Попросить SW явно закэшировать KML */
  function cacheKmlFile(filename) {
    if (!navigator.serviceWorker || !navigator.serviceWorker.controller) {
      return Promise.resolve(false);
    }
    const url = getRouteUrl(filename);
    return new Promise((resolve) => {
      const ch = new MessageChannel();
      ch.port1.onmessage = (e) => resolve(e.data?.payload?.success || false);
      setTimeout(() => resolve(false), 10000);
      navigator.serviceWorker.controller.postMessage(
        { type: "CACHE_ROUTE", payload: { url } },
        [ch.port2],
      );
    });
  }

  /** Проверить выборку тайлов (быстрая оценка покрытия) */
  async function sampleTilesCoverage(data) {
    const allTiles = OfflineTiles.getTilesForRoute(data, 10, 16);
    if (allTiles.length === 0) return { ratio: 0, total: 0 };

    const sampleSize = Math.min(50, allTiles.length);
    const step = Math.max(1, Math.floor(allTiles.length / sampleSize));
    let cached = 0;
    let checked = 0;

    for (let i = 0; i < allTiles.length && checked < sampleSize; i += step) {
      const tile = await OfflineTiles.getTile(allTiles[i]);
      if (tile) cached++;
      checked++;
    }

    return {
      ratio: checked > 0 ? cached / checked : 0,
      total: allTiles.length,
    };
  }

  /** Проверить и показать офлайн-статус маршрута */
  async function checkOfflineStatus(data, filename) {
    const indicator = document.getElementById("offline-indicator");
    const clearBtn = document.getElementById("btn-clear-offline");
    if (!indicator) return;

    const [kmlCached, tileStatus] = await Promise.all([
      isKmlCached(filename),
      sampleTilesCoverage(data),
    ]);

    const hasOfflineData = kmlCached || tileStatus.ratio > 0;
    if (clearBtn) {
      clearBtn.classList.toggle("hidden", !hasOfflineData);
    }

    if (kmlCached && tileStatus.ratio >= 0.95) {
      indicator.textContent = "✅ Готово оффлайн";
      indicator.className = "offline-indicator offline-indicator--ready";
      // Переименовать кнопку скачивания если карта уже полностью скачана
      const downloadBtn = document.getElementById("btn-download");
      if (downloadBtn && !downloadBtn.disabled) {
        downloadBtn.textContent = downloadBtn.textContent.replace(
          "Скачать карту",
          "Обновить карту",
        );
      }
    } else if (kmlCached && tileStatus.ratio > 0) {
      const pct = Math.round(tileStatus.ratio * 100);
      indicator.textContent = `📦 Частично (${pct}% карты)`;
      indicator.className = "offline-indicator offline-indicator--partial";
    } else if (kmlCached) {
      indicator.textContent = "📦 Маршрут сохранён, карта не скачана";
      indicator.className = "offline-indicator offline-indicator--partial";
    } else {
      indicator.textContent = "📡 Только онлайн";
      indicator.className = "offline-indicator offline-indicator--online";
    }

    indicator.classList.remove("hidden");
    return { kmlCached, tileRatio: tileStatus.ratio };
  }

  function initDownload(data, filename) {
    const downloadBtn = document.getElementById("btn-download");
    const downloadPanel = document.getElementById("download-panel");
    const downloadStatus = document.getElementById("download-status");
    const progressFill = document.getElementById("progress-fill");
    const cancelBtn = document.getElementById("btn-cancel-download");
    const clearBtn = document.getElementById("btn-clear-offline");

    // Вычисляем тайлы один раз — используем и для оценки размера, и при скачивании
    const tiles = OfflineTiles.getTilesForRoute(data, 10, 16);
    const estimatedSize = OfflineTiles.formatSize(
      OfflineTiles.estimateSize(tiles.length),
    );
    downloadBtn.textContent = `Скачать карту (~${estimatedSize})`;

    downloadBtn.addEventListener("click", async () => {
      downloadBtn.classList.add("hidden");
      downloadPanel.classList.remove("hidden");
      downloadStatus.textContent = "Подготовка...";
      progressFill.style.width = "0%";
      progressFill.classList.remove("progress-bar__fill--done");
      cancelBtn.classList.remove("hidden");

      downloadController = new AbortController();

      cancelBtn.addEventListener(
        "click",
        () => {
          if (downloadController) downloadController.abort();
        },
        { once: true },
      );

      try {
        // Сначала кэшируем KML, потом скачиваем тайлы
        await cacheKmlFile(filename);

        await OfflineTiles.downloadTiles(
          data,
          VeloMap.getTileUrl(),
          {
            zoomMin: 10,
            zoomMax: 16,
            concurrency: 4,
            delayMs: 100,
            signal: downloadController.signal,
            tiles, // передаём предварительно вычисленные тайлы
            onProgress: (progress) => {
              if (progress.phase === "checking") {
                downloadStatus.textContent = "Проверяю кэш...";
              } else if (progress.phase === "downloading") {
                const pct =
                  progress.total > 0
                    ? Math.round((progress.completed / progress.total) * 100)
                    : 100;
                progressFill.style.width = pct + "%";
                downloadStatus.textContent =
                  `Скачано ${progress.completed} из ${progress.total} тайлов` +
                  (progress.cached ? ` (${progress.cached} уже в кэше)` : "") +
                  (progress.failed ? ` | Ошибок: ${progress.failed}` : "");
              } else if (progress.phase === "done") {
                progressFill.style.width = "100%";
                progressFill.classList.add("progress-bar__fill--done");
                cancelBtn.classList.add("hidden");

                if (progress.cancelled) {
                  downloadStatus.textContent = "Скачивание отменено";
                  setTimeout(() => {
                    downloadPanel.classList.add("hidden");
                    downloadBtn.classList.remove("hidden");
                  }, 1200);
                } else if (progress.failed > 0) {
                  downloadStatus.textContent =
                    `Скачано ${progress.completed + progress.cached} тайлов, ` +
                    `ошибок: ${progress.failed}. Можно попробовать ещё раз.`;
                  OfflineTiles.saveRouteManifest(
                    filename,
                    progress.availableKeys || [],
                  ).catch(() => {});
                  checkOfflineStatus(data, filename);
                  setTimeout(() => {
                    downloadPanel.classList.add("hidden");
                    downloadBtn.textContent = "Доскачать карту";
                    downloadBtn.classList.remove("hidden");
                  }, 2500);
                } else {
                  const total = progress.completed + progress.cached;
                  downloadStatus.textContent = `✓ Готово — ${total} тайлов в памяти`;
                  OfflineTiles.saveRouteManifest(
                    filename,
                    progress.availableKeys || tiles,
                  ).catch(() => {});
                  // Обновить офлайн-индикатор
                  checkOfflineStatus(data, filename);
                  setTimeout(() => {
                    downloadPanel.classList.add("hidden");
                    downloadBtn.textContent = "✓ Карта скачана";
                    downloadBtn.classList.remove("btn--primary");
                    downloadBtn.classList.add("btn--success");
                    downloadBtn.disabled = true;
                    downloadBtn.classList.remove("hidden");
                  }, 2000);
                }
              }
            },
          },
        );
      } catch (e) {
        downloadStatus.textContent = `Ошибка: ${e.message}`;
        cancelBtn.classList.add("hidden");
        setTimeout(() => {
          downloadPanel.classList.add("hidden");
          downloadBtn.classList.remove("hidden");
        }, 1800);
      }
    });

    // Кнопка удаления офлайн-данных
    if (clearBtn) {
      clearBtn.addEventListener("click", async () => {
        clearBtn.disabled = true;
        clearBtn.textContent = "Удаление...";

        try {
          await OfflineTiles.deleteTilesForRoute(data, 10, 16, filename);

          // Удаляем KML из SW-кэша
          if ("caches" in window) {
            try {
              const cache = await caches.open("velotrek-routes");
              await cache.delete(getRouteUrl(filename));
            } catch {}
          }

          // Сбрасываем состояние кнопки скачивания
          downloadBtn.textContent = `Скачать карту (~${estimatedSize})`;
          downloadBtn.disabled = false;
          downloadBtn.classList.remove("btn--success");
          downloadBtn.classList.add("btn--primary");
          downloadBtn.classList.remove("hidden");
          downloadPanel.classList.add("hidden");
          progressFill.style.width = "0%";
          progressFill.classList.remove("progress-bar__fill--done");

          await checkOfflineStatus(data, filename);
          showToast("Офлайн-данные удалены");
        } catch (e) {
          showToast("Ошибка удаления: " + e.message);
        } finally {
          clearBtn.textContent = "Удалить";
          clearBtn.disabled = false;
        }
      });
    }
  }

  function initGPS(data) {
    const gpsBtn = document.getElementById("btn-gps");
    const gpsPanel = document.getElementById("gps-panel");
    const gpsSpeed = document.getElementById("gps-speed");
    const gpsDistance = document.getElementById("gps-distance");
    const gpsAccuracy = document.getElementById("gps-accuracy");
    const centerBtn = document.getElementById("btn-center");

    let gpsStarted = false;

    gpsBtn.addEventListener("click", async () => {
      if (!gpsStarted) {
        // Промежуточное состояние — ждём GPS
        gpsBtn.textContent = "Поиск GPS...";
        gpsBtn.disabled = true;

        // iOS 13+: запрашиваем разрешение компаса первым, до любых других await
        if (
          typeof DeviceOrientationEvent !== "undefined" &&
          typeof DeviceOrientationEvent.requestPermission === "function"
        ) {
          try {
            await DeviceOrientationEvent.requestPermission();
          } catch (e) {}
        }
        try {
          GPSTracker.init(VeloMap.getMap(), data, (update) => {
            if (update.error) {
              gpsDistance.textContent = "—";
              gpsSpeed.textContent = "—";
              if (gpsAccuracy) gpsAccuracy.textContent = "—";
              return;
            }

            const speedKmh = (update.speed * 3.6).toFixed(1);
            gpsSpeed.textContent = speedKmh;

            const distM = Math.round(update.distanceToRoute);
            gpsDistance.textContent =
              distM > 1000 ? (distM / 1000).toFixed(1) + " км" : distM + " м";

            if (!update.onRoute) {
              gpsDistance.classList.add("gps-panel__value--off-route");
            } else {
              gpsDistance.classList.remove("gps-panel__value--off-route");
            }

            // Показываем точность GPS
            if (gpsAccuracy) {
              const acc = Math.round(update.accuracy);
              gpsAccuracy.textContent = acc + " м";
              gpsAccuracy.classList.toggle("gps-panel__value--poor", acc > 50);
            }
          });

          await GPSTracker.start();
          gpsStarted = true;
          gpsBtn.disabled = false;
          gpsBtn.textContent = "Стоп";
          gpsBtn.classList.remove("btn--success");
          gpsBtn.classList.add("btn--danger");
          gpsPanel.classList.remove("hidden");
        } catch (e) {
          gpsBtn.disabled = false;
          gpsBtn.textContent = "Навигация";
          showToast("GPS недоступен: " + e.message);
        }
      } else {
        GPSTracker.stop();
        gpsStarted = false;
        gpsBtn.textContent = "Навигация";
        gpsBtn.classList.remove("btn--danger");
        gpsBtn.classList.add("btn--success");
        gpsPanel.classList.add("hidden");
      }
    });

    centerBtn.addEventListener("click", () => {
      GPSTracker.setFollowMode(true);
    });

    // Отключаем follow-mode при ручном перетаскивании карты
    VeloMap.getMap().on("dragstart", () => {
      GPSTracker.setFollowMode(false);
    });
  }

  function showLoading() {
    document.getElementById("loading").classList.remove("hidden");
    document.getElementById("route-content").classList.add("hidden");
    document.getElementById("error").classList.add("hidden");
  }

  function showError(msg) {
    document.getElementById("loading").classList.add("hidden");
    document.getElementById("route-content").classList.add("hidden");
    const errorEl = document.getElementById("error");
    errorEl.classList.remove("hidden");
    errorEl.querySelector(".error-msg__text").textContent = msg;
  }

  return { init, _test: { sanitizeDescriptionHtml } };
})();

if (!window.VELOTREK_TEST) {
  document.addEventListener("DOMContentLoaded", () => RoutePage.init());
}
