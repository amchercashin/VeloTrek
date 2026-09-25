/** Тосты и диалог подтверждения. */
import { el, esc } from "../lib/dom.js";

let toastEl = null;
let toastTimer = 0;

/**
 * Короткое неблокирующее уведомление.
 * action: { label, onClick } — необязательная кнопка.
 */
export function toast(message, { action = null, duration = 3600, tone = "" } = {}) {
  toastEl?.remove();
  clearTimeout(toastTimer);
  toastEl = el(`
    <div class="toast ${tone ? "toast--" + tone : ""}" role="status" aria-live="polite">
      <span class="toast__text">${esc(message)}</span>
      ${action ? `<button class="toast__action" type="button">${esc(action.label)}</button>` : ""}
    </div>`);
  if (action) {
    toastEl.querySelector(".toast__action").addEventListener("click", () => {
      action.onClick();
      hide();
    });
  }
  document.body.appendChild(toastEl);
  requestAnimationFrame(() => toastEl?.classList.add("is-in"));
  const hide = () => {
    const t = toastEl;
    if (!t) return;
    t.classList.remove("is-in");
    setTimeout(() => t.remove(), 250);
    if (toastEl === t) toastEl = null;
  };
  if (duration) toastTimer = setTimeout(hide, duration);
  return hide;
}

/** Модальное подтверждение на <dialog>. Возвращает Promise<boolean>. */
export function confirmDialog({ title, text = "", ok = "Да", cancel = "Отмена", danger = false }) {
  return new Promise((resolve) => {
    const dlg = el(`
      <dialog class="dialog">
        <form method="dialog" class="dialog__card">
          <h2 class="dialog__title">${esc(title)}</h2>
          ${text ? `<p class="dialog__text">${esc(text)}</p>` : ""}
          <div class="dialog__actions">
            <button class="btn btn--ghost" value="cancel">${esc(cancel)}</button>
            <button class="btn ${danger ? "btn--danger" : "btn--primary"}" value="ok" autofocus>${esc(ok)}</button>
          </div>
        </form>
      </dialog>`);
    document.body.appendChild(dlg);
    dlg.addEventListener("close", () => {
      resolve(dlg.returnValue === "ok");
      dlg.remove();
    });
    // Клик по фону закрывает диалог
    dlg.addEventListener("click", (e) => {
      if (e.target === dlg) dlg.close("cancel");
    });
    dlg.showModal();
  });
}
