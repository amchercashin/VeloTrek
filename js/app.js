/**
 * Каталог маршрутов VeloTrek.
 * Загружает routes/index.json (генерируется GitHub Action),
 * кэширует результат в localStorage для работы оффлайн.
 */
const App = (() => {
  const CACHE_KEY = 'velotrek-catalog';
  const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 часа

  // Определяем базовый URL для загрузки файлов маршрутов
  function getRouteBaseUrl() {
    const hostname = window.location.hostname;
    const pathname = window.location.pathname;

    // GitHub Pages: username.github.io/repo-name/
    if (hostname.endsWith('.github.io')) {
      const owner = hostname.replace('.github.io', '');
      const pathParts = pathname.split('/').filter(Boolean);
      const repo = pathParts[0] || '';
      const base = repo ? `/${repo}` : '';
      return { base, owner, repo };
    }

    // Локальная разработка и прочее
    return { base: '', owner: null, repo: null };
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
      localStorage.setItem(CACHE_KEY, JSON.stringify({
        timestamp: Date.now(),
        sections
      }));
    } catch {
      // localStorage недоступен или заполнен
    }
  }

  async function loadCatalog() {
    const cached = getCachedCatalog();

    try {
      const response = await fetch('routes/index.json');
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
    const track = stats.track_km ? `${stats.track_km} км` : '';
    const span  = stats.span_km  ? `${stats.span_km} км`  : '';
    const elevation = (stats.elevation_min_m && stats.elevation_max_m)
      ? `${stats.elevation_min_m}–${stats.elevation_max_m} м`
      : '';
    const climb   = stats.climb_m   ? `${stats.climb_m} м`   : '';
    const descent = stats.descent_m ? `${stats.descent_m} м` : '';

    return `
      <div class="route-card" data-route="${encodeURIComponent(route.filename)}">
        <h2 class="route-card__title">${escapeHtml(route.name)}</h2>
        <div class="route-card__stats">
          ${track ? `<span class="stat" title="Суммарная длина трека"><span class="stat__icon">🗺️</span> ${track}</span>` : ''}
          ${span  ? `<span class="stat" title="Размах (диагональ)"><span class="stat__icon">📏</span> ${span}</span>` : ''}
          ${elevation ? `<span class="stat" title="Высоты мин–макс"><span class="stat__icon">⛰</span> ${elevation}</span>` : ''}
          ${climb   ? `<span class="stat" title="Суммарный подъём"><span class="stat__icon">↗</span> ${climb}</span>`   : ''}
          ${descent ? `<span class="stat" title="Суммарный спуск"><span class="stat__icon">↘</span> ${descent}</span>` : ''}
          ${route.poiCount ? `<span class="stat" title="Точки интереса"><span class="stat__icon">📍</span> ${route.poiCount} точек</span>` : ''}
        </div>
        ${route.error ? `<p class="route-card__error">Ошибка загрузки</p>` : ''}
      </div>
    `;
  }

  function renderCatalog(sections, container) {
    const totalRoutes = sections.reduce((n, s) => n + (s.routes || []).length, 0);
    if (totalRoutes === 0) {
      container.innerHTML = '<p class="empty-state">Маршруты не найдены. Добавьте KML-файл в папку <code>routes/</code> репозитория.</p>';
      return;
    }

    container.innerHTML = sections.map(section => `
      <h2 class="section-header">${escapeHtml(section.name)}</h2>
      ${(section.routes || []).map(renderRouteCard).join('')}
    `).join('');

    // Навигация по клику на карточку (div вместо <a> для поддержки вложенных ссылок)
    container.addEventListener('click', (e) => {
      if (e.target.closest('a')) return; // Клик по ссылке в описании — не переходим
      const card = e.target.closest('.route-card');
      if (card && card.dataset.route) {
        window.location.href = `route.html?route=${card.dataset.route}`;
      }
    });
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  /** Извлекает чистый текст из HTML-описания (KML CDATA) */
  function stripHtml(html) {
    const tmp = document.createElement('div');
    tmp.innerHTML = html.replace(/<br\s*\/?>/gi, ' ');
    return (tmp.textContent || '').replace(/\s+/g, ' ').trim();
  }

  /** Превращает URL в тексте в кликабельные ссылки */
  function linkify(text) {
    return text.replace(/https?:\/\/[^\s<>"']+/g, url => {
      const clean = url.replace(/[.,;:!?)]+$/, '');
      const tail = url.slice(clean.length);
      return `<a href="${clean}" target="_blank" rel="noopener noreferrer" class="desc-link">${clean}</a>${tail}`;
    });
  }

  function detectRepo() {
    const hostname = window.location.hostname;
    const pathname = window.location.pathname;
    if (hostname.endsWith('.github.io')) {
      const owner = hostname.replace('.github.io', '');
      const pathParts = pathname.split('/').filter(Boolean);
      const repo = pathParts[0] || owner + '.github.io';
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
