/** Мелкие DOM-утилиты без зависимостей. */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Экранирует строку для вставки в HTML (текст и значения атрибутов). */
export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
}

/** Создаёт элемент из HTML-строки (первый элемент верхнего уровня). */
export function el(markup) {
  const t = document.createElement("template");
  t.innerHTML = markup.trim();
  return t.content.firstElementChild;
}

/** Вызывает fn не чаще одного раза за кадр, с последними аргументами. */
export function rafThrottle(fn) {
  let frame = 0;
  let lastArgs = null;
  return (...args) => {
    lastArgs = args;
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      fn(...lastArgs);
    });
  };
}

export function debounce(fn, ms) {
  let t = 0;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/** Безопасный доступ к localStorage: приватный режим/квоты не должны ронять приложение. */
export const storage = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* квота или приватный режим — не критично */
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* noop */
    }
  },
};

export const prefersReducedMotion = () =>
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

export const isStandalone = () =>
  window.matchMedia?.("(display-mode: standalone)").matches ||
  navigator.standalone === true;
