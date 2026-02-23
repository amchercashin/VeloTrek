/**
 * Оркестратор страницы маршрута VeloTrek.
 * Загружает маршрут, инициализирует карту, управляет скачиванием и GPS.
 */
const RoutePage = (() => {
  let routeData = null;
  let downloadController = null;

  async function init() {
    const params = new URLSearchParams(window.location.search);
    const filename = params.get('route');

    if (!filename) {
      showError('Маршрут не указан');
      return;
    }

    showLoading();

    try {
      routeData = await loadRoute(filename);
      render(routeData);
      initMap(routeData);
      initDownload(routeData);
      initGPS(routeData);
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
    document.getElementById('loading').classList.add('hidden');
    document.getElementById('route-content').classList.remove('hidden');

    document.getElementById('route-name').textContent = data.name;
    document.getElementById('header-title').textContent = data.name;

    const rawDesc = data.description || '';
    const descEl = document.getElementById('route-desc');
    if (rawDesc) {
      // Описание в KML может содержать HTML (CDATA с <br> и др.)
      // <br> заменяем на пробел ДО парсинга — textContent не добавляет разделитель вокруг <br>
      const tmp = document.createElement('div');
      tmp.innerHTML = rawDesc.replace(/<br\s*\/?>/gi, ' ');
      const plainDesc = tmp.textContent || '';
      descEl.textContent = plainDesc.replace(/\s+/g, ' ').trim();
    } else {
      descEl.classList.add('hidden');
    }

    const statsEl = document.getElementById('route-stats');
    const stats = data.stats || {};

    const parts = [];
    if (stats.track_km) parts.push(`🗺️ ${stats.track_km} км`);
    if (stats.span_km)  parts.push(`📏 ${stats.span_km} км`);
    if (stats.elevation_min_m && stats.elevation_max_m) parts.push(`⛰ ${stats.elevation_min_m}–${stats.elevation_max_m} м`);
    if (stats.climb_m) parts.push(`↗ ${stats.climb_m} м`);
    if (stats.descent_m) parts.push(`↘ ${stats.descent_m} м`);
    if (data.pois.length) parts.push(`📍 ${data.pois.length} точек`);
    statsEl.innerHTML = parts.map(p => `<span class="stat">${p}</span>`).join('');
  }

  function initMap(data) {
    const map = VeloMap.init('map');
    VeloMap.showRoute(data);
  }

  function initDownload(data) {
    const downloadBtn = document.getElementById('btn-download');
    const downloadPanel = document.getElementById('download-panel');
    const downloadStatus = document.getElementById('download-status');
    const progressFill = document.getElementById('progress-fill');
    const cancelBtn = document.getElementById('btn-cancel-download');

    // Подсчёт тайлов
    const tiles = OfflineTiles.getTilesForRoute(data, 10, 16);
    const estimatedSize = OfflineTiles.formatSize(OfflineTiles.estimateSize(tiles.length));
    downloadBtn.textContent = `Скачать карту (~${estimatedSize})`;

    downloadBtn.addEventListener('click', async () => {
      downloadBtn.classList.add('hidden');
      downloadPanel.classList.remove('hidden');
      downloadStatus.textContent = 'Проверяю кэш...';

      downloadController = new AbortController();

      cancelBtn.addEventListener('click', () => {
        if (downloadController) downloadController.abort();
      });

      try {
        const result = await OfflineTiles.downloadTiles(data, VeloMap.getTileUrl(), {
          zoomMin: 10,
          zoomMax: 16,
          concurrency: 4,
          delayMs: 100,
          signal: downloadController.signal,
          onProgress: (progress) => {
            if (progress.phase === 'checking') {
              downloadStatus.textContent = 'Проверяю кэш...';
            } else if (progress.phase === 'downloading') {
              const pct = progress.total > 0
                ? Math.round((progress.completed / progress.total) * 100)
                : 100;
              progressFill.style.width = pct + '%';
              downloadStatus.textContent =
                `Скачано ${progress.completed} из ${progress.total} тайлов` +
                (progress.cached ? ` (${progress.cached} уже в кэше)` : '') +
                (progress.failed ? ` | Ошибок: ${progress.failed}` : '');
            } else if (progress.phase === 'done') {
              progressFill.style.width = '100%';
              progressFill.classList.add('progress-bar__fill--done');
              cancelBtn.classList.add('hidden');

              if (progress.cancelled) {
                downloadStatus.textContent = 'Скачивание отменено';
                // Через секунду — снова показываем кнопку скачивания
                setTimeout(() => {
                  downloadPanel.classList.add('hidden');
                  downloadBtn.classList.remove('hidden');
                }, 1200);
              } else {
                const total = progress.completed + progress.cached;
                downloadStatus.textContent =
                  `✓ Готово — ${total} тайлов в памяти`;
                // Через 2 секунды скрываем панель, кнопка меняется на «✓ Карта скачана»
                setTimeout(() => {
                  downloadPanel.classList.add('hidden');
                  downloadBtn.textContent = '✓ Карта скачана';
                  downloadBtn.classList.remove('btn--primary');
                  downloadBtn.classList.add('btn--success');
                  downloadBtn.disabled = true;
                  downloadBtn.classList.remove('hidden');
                }, 2000);
              }
            }
          }
        });
      } catch (e) {
        downloadStatus.textContent = `Ошибка: ${e.message}`;
      }
    });
  }

  function initGPS(data) {
    const gpsBtn = document.getElementById('btn-gps');
    const gpsPanel = document.getElementById('gps-panel');
    const gpsSpeed = document.getElementById('gps-speed');
    const gpsDistance = document.getElementById('gps-distance');
    const centerBtn = document.getElementById('btn-center');

    let gpsStarted = false;

    gpsBtn.addEventListener('click', async () => {
      if (!gpsStarted) {
        try {
          GPSTracker.init(VeloMap.getMap(), data, (update) => {
            if (update.error) {
              gpsDistance.textContent = '—';
              gpsSpeed.textContent = '—';
              return;
            }

            const speedKmh = (update.speed * 3.6).toFixed(1);
            gpsSpeed.textContent = speedKmh;

            const distM = Math.round(update.distanceToRoute);
            gpsDistance.textContent = distM > 1000
              ? (distM / 1000).toFixed(1) + ' км'
              : distM + ' м';

            const distEl = gpsDistance;
            if (!update.onRoute) {
              distEl.classList.add('gps-panel__value--off-route');
            } else {
              distEl.classList.remove('gps-panel__value--off-route');
            }
          });

          await GPSTracker.start();
          gpsStarted = true;
          gpsBtn.textContent = 'Стоп';
          gpsBtn.classList.remove('btn--success');
          gpsBtn.classList.add('btn--danger');
          gpsPanel.classList.remove('hidden');
        } catch (e) {
          alert('GPS недоступен: ' + e.message);
        }
      } else {
        GPSTracker.stop();
        gpsStarted = false;
        gpsBtn.textContent = 'Навигация';
        gpsBtn.classList.remove('btn--danger');
        gpsBtn.classList.add('btn--success');
        gpsPanel.classList.add('hidden');
      }
    });

    centerBtn.addEventListener('click', () => {
      GPSTracker.setFollowMode(true);
    });

    // Отключаем follow-mode при ручном перетаскивании карты
    VeloMap.getMap().on('dragstart', () => {
      GPSTracker.setFollowMode(false);
    });
  }

  function showLoading() {
    document.getElementById('loading').classList.remove('hidden');
    document.getElementById('route-content').classList.add('hidden');
    document.getElementById('error').classList.add('hidden');
  }

  function showError(msg) {
    document.getElementById('loading').classList.add('hidden');
    document.getElementById('route-content').classList.add('hidden');
    const errorEl = document.getElementById('error');
    errorEl.classList.remove('hidden');
    errorEl.querySelector('.error-msg__text').textContent = msg;
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', () => RoutePage.init());
