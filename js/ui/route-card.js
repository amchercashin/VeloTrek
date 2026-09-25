/** Карточка маршрута и его «силуэт» — общая разметка для каталога, карты и списка скачанного. */
import { esc } from "../lib/dom.js";
import { linesToSvgPath } from "../lib/geo.js";
import { kmValue, count } from "../lib/format.js";
import { routeLines } from "../data/catalog.js";
import { icon } from "./icons.js";

export function routeHref(id) {
  return "#/r/" + encodeURIComponent(id);
}

export function thumb(route, size = 64) {
  const { d, start, end } = linesToSvgPath(routeLines(route), size, 8);
  return `
    <svg class="thumb" viewBox="0 0 ${size} ${size}" aria-hidden="true">
      <path class="thumb__casing" d="${d}"/>
      <path class="thumb__line" d="${d}"/>
      ${end ? `<circle class="thumb__end" cx="${end[0]}" cy="${end[1]}" r="2.6"/>` : ""}
      ${start ? `<circle class="thumb__start" cx="${start[0]}" cy="${start[1]}" r="3.2"/>` : ""}
    </svg>`;
}

export function metaLine(route) {
  const parts = [];
  if (route.pois) parts.push(count(route.pois, ["точка", "точки", "точек"]));
  if (route.tracks > 1) parts.push(`+${count(route.tracks - 1, ["вариант", "варианта", "вариантов"])}`);
  return parts.join(" · ");
}

export function routeCard(route, { tag = "a" } = {}) {
  const href = tag === "a" ? ` href="${routeHref(route.id)}"` : "";
  const kicker = [route.direction, route.number != null ? `№${route.number}` : null]
    .filter(Boolean)
    .join(" · ");
  return `
    <${tag} class="card tone-${route.tone}"${href} data-id="${esc(route.id)}">
      <span class="card__thumb">${thumb(route)}</span>
      <span class="card__body">
        ${kicker ? `<span class="card__kicker">${esc(kicker)}</span>` : ""}
        <span class="card__title">${esc(route.name)}</span>
        <span class="card__meta">
          <span class="card__km"><b>${kmValue(route.km)}</b>&nbsp;км</span>
          ${metaLine(route) ? `<span class="card__sub">${metaLine(route)}</span>` : ""}
        </span>
      </span>
      <span class="card__saved" title="Карта скачана">${icon("check", { size: 14 })}</span>
      <span class="card__ring" title="Карта скачивается" aria-hidden="true"></span>
    </${tag}>`;
}
