/**
 * Санитайзер HTML-описаний из KML: белый список тегов, ссылки только
 * http(s)/mailto и всегда в новой вкладке.
 */

const ALLOWED = new Set(["A", "B", "BR", "EM", "I", "LI", "OL", "P", "STRONG", "UL"]);
const DROP_WITH_CONTENT = new Set(["IFRAME", "SCRIPT", "STYLE", "OBJECT", "EMBED", "TEMPLATE"]);

function clean(node) {
  for (const child of [...node.childNodes]) {
    if (child.nodeType === Node.ELEMENT_NODE) {
      if (DROP_WITH_CONTENT.has(child.tagName)) {
        child.remove();
        continue;
      }
      clean(child);
      if (!ALLOWED.has(child.tagName)) {
        child.replaceWith(...child.childNodes);
        continue;
      }
      for (const attr of [...child.attributes]) {
        if (child.tagName !== "A" || attr.name.toLowerCase() !== "href") {
          child.removeAttribute(attr.name);
        }
      }
      if (child.tagName === "A") {
        let safe = false;
        try {
          const url = new URL(child.getAttribute("href") || "", location.href);
          safe = ["http:", "https:", "mailto:"].includes(url.protocol);
        } catch {
          /* некорректный URL */
        }
        if (safe) {
          child.setAttribute("target", "_blank");
          child.setAttribute("rel", "noopener noreferrer");
        } else {
          child.removeAttribute("href");
        }
      }
    } else if (child.nodeType !== Node.TEXT_NODE) {
      child.remove();
    }
  }
}

/** Возвращает безопасный HTML. Простой текст превращается в абзацы со ссылками. */
export function sanitizeDescription(raw) {
  if (!raw) return "";
  const looksLikeHtml = /<[a-z][\s\S]*>/i.test(raw);
  const source = looksLikeHtml ? raw : textToHtml(raw);
  const t = document.createElement("template");
  t.innerHTML = source;
  clean(t.content);
  return t.innerHTML.trim();
}

function textToHtml(text) {
  const escape = (s) =>
    s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  return text
    .trim()
    .split(/\n{2,}/)
    .map(
      (para) =>
        "<p>" +
        escape(para)
          .replace(/\n/g, "<br>")
          .replace(/https?:\/\/[^\s<>"']+/g, (url) => {
            const clean = url.replace(/[.,;:!?)]+$/, "");
            return `<a href="${clean}">${clean}</a>${url.slice(clean.length)}`;
          }) +
        "</p>",
    )
    .join("");
}
