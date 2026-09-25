/**
 * Нижняя шторка поверх карты: «peek» (шапка с главными действиями) ↔ «full».
 * Тянется за шапку; на широком экране становится боковой панелью (через CSS),
 * и логика перетаскивания отключается.
 */
import { prefersReducedMotion } from "../lib/dom.js";

export function createSheet(root, { onChange } = {}) {
  const head = root.querySelector(".sheet__head");
  const body = root.querySelector(".sheet__body");
  const wide = window.matchMedia("(min-width: 900px)");
  let state = "peek";
  let offsets = { full: 0, peek: 0, hidden: 0 };
  let current = 0;

  function measure() {
    const h = root.offsetHeight;
    const peek = Math.min(head.offsetHeight, h);
    offsets = { full: 0, peek: h - peek, hidden: h + 24 };
    if (!dragging) apply(offsets[state], false);
  }

  function apply(y, animate) {
    current = y;
    if (wide.matches) {
      root.style.transform = "";
      return;
    }
    root.classList.toggle("is-animating", animate && !prefersReducedMotion());
    root.style.transform = `translate3d(0, ${Math.round(y)}px, 0)`;
  }

  function visibleHeight() {
    if (wide.matches) return 0;
    return Math.max(0, root.offsetHeight - offsets[state]);
  }

  function setState(next, { animate = true } = {}) {
    state = next;
    root.dataset.state = next;
    body.scrollTop = next === "full" ? body.scrollTop : 0;
    root.setAttribute("aria-expanded", String(next === "full"));
    apply(offsets[next], animate);
    onChange?.(next, visibleHeight());
  }

  // --- перетаскивание -------------------------------------------------------
  let dragging = false;
  let pointerId = null;
  let startY = 0;
  let startOffset = 0;
  let lastY = 0;
  let lastT = 0;
  let velocity = 0;
  let suppressClick = false;

  head.addEventListener("pointerdown", (e) => {
    if (wide.matches || e.button > 0) return;
    pointerId = e.pointerId;
    startY = lastY = e.clientY;
    lastT = e.timeStamp;
    startOffset = current;
    velocity = 0;
  });

  head.addEventListener("pointermove", (e) => {
    if (e.pointerId !== pointerId) return;
    const dy = e.clientY - startY;
    if (!dragging) {
      if (Math.abs(dy) < 6) return;
      dragging = true;
      head.setPointerCapture(pointerId);
      root.classList.remove("is-animating");
    }
    let y = startOffset + dy;
    // Резиновое сопротивление за пределами крайних положений
    if (y < offsets.full) y = offsets.full - Math.sqrt(offsets.full - y) * 3;
    if (y > offsets.peek) y = offsets.peek + Math.sqrt(y - offsets.peek) * 3;
    const dt = e.timeStamp - lastT;
    if (dt > 0) velocity = 0.8 * ((e.clientY - lastY) / dt) + 0.2 * velocity;
    lastY = e.clientY;
    lastT = e.timeStamp;
    apply(y, false);
  });

  const end = (e) => {
    if (e.pointerId !== pointerId) return;
    pointerId = null;
    if (!dragging) return;
    dragging = false;
    suppressClick = true;
    setTimeout(() => (suppressClick = false), 0);
    let next;
    if (velocity < -0.45) next = "full";
    else if (velocity > 0.45) next = "peek";
    else next = current < (offsets.full + offsets.peek) / 2 ? "full" : "peek";
    setState(next);
  };
  head.addEventListener("pointerup", end);
  head.addEventListener("pointercancel", end);

  // Тап по «ручке» или заголовку переключает состояние
  head.addEventListener(
    "click",
    (e) => {
      if (suppressClick) {
        e.stopPropagation();
        e.preventDefault();
        return;
      }
      if (wide.matches) return;
      if (e.target.closest("button, a, input, [data-no-toggle]")) return;
      setState(state === "full" ? "peek" : "full");
    },
    true,
  );

  const ro = new ResizeObserver(() => measure());
  ro.observe(head);
  ro.observe(root);
  wide.addEventListener("change", () => {
    measure();
    onChange?.(state, visibleHeight());
  });

  return {
    setState,
    measure,
    visibleHeight,
    get state() {
      return state;
    },
    destroy() {
      ro.disconnect();
    },
  };
}
