/**
 * Настройки экрана: стиль карты (авто/день/ночь), затемнение в поездке
 * и «не гасить экран». Общие для всех карт приложения.
 *
 * Системную яркость веб-приложение менять не может — такого API в браузерах нет.
 * Затемнение — это чёрная полупрозрачная пелена поверх картинки: на OLED-экранах
 * тёмные пиксели светятся слабее и реально экономят заряд.
 */
import { storage } from "../lib/dom.js";

const KEY = "versty:screen";
const LEGACY_NIGHT_KEY = "versty:night-map";
const dark = window.matchMedia("(prefers-color-scheme: dark)");

const listeners = new Set();

function load() {
  const saved = storage.get(KEY, null);
  if (saved) return { mapStyle: "auto", dim: 0, keepAwake: true, ...saved };
  // Прежняя версия хранила только флаг ночной карты
  const legacyNight = storage.get(LEGACY_NIGHT_KEY, false);
  return { mapStyle: legacyNight ? "night" : "auto", dim: 0, keepAwake: true };
}

let state = load();

export function get() {
  return state;
}

export function set(patch) {
  state = { ...state, ...patch };
  storage.set(KEY, state);
  apply();
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Тёмная ли сейчас карта с учётом режима «авто». */
export function isNightMap() {
  return state.mapStyle === "night" || (state.mapStyle === "auto" && dark.matches);
}

function apply() {
  document.documentElement.classList.toggle("map-night", isNightMap());
  for (const fn of listeners) fn(state);
}

dark.addEventListener("change", apply);
apply();
