/** Форматирование чисел и единиц для русского интерфейса. */

const nf0 = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat("ru-RU", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

/** Число для километров: 0,8 · 12 · 136 (десятые только у коротких). */
export function kmValue(km) {
  if (!Number.isFinite(km)) return "—";
  return km < 10 ? nf1.format(km) : nf0.format(Math.round(km));
}

/** Число с одним знаком после запятой: 18,4 */
export function oneDecimal(v) {
  return Number.isFinite(v) ? nf1.format(v) : "—";
}

export function int(v) {
  return Number.isFinite(v) ? nf0.format(Math.round(v)) : "—";
}

/** Расстояние в метрах → { value, unit }: «240 м», «1,2 км», «36 км». */
export function distanceParts(meters) {
  if (!Number.isFinite(meters)) return { value: "—", unit: "" };
  if (meters < 950) return { value: nf0.format(Math.round(meters / 10) * 10 || Math.round(meters)), unit: "м" };
  return { value: kmValue(meters / 1000), unit: "км" };
}

export function distance(meters) {
  const { value, unit } = distanceParts(meters);
  return unit ? `${value} ${unit}` : value;
}

export function bytes(n) {
  if (!Number.isFinite(n) || n <= 0) return "0 МБ";
  const mb = n / (1024 * 1024);
  if (mb < 1) return `${nf0.format(Math.max(1, Math.round(n / 1024)))} КБ`;
  if (mb < 10) return `${nf1.format(mb)} МБ`;
  if (mb < 1024) return `${nf0.format(Math.round(mb))} МБ`;
  return `${nf1.format(mb / 1024)} ГБ`;
}

/** Длительность в мс → «0:48» или «1:05:12». */
export function duration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  return h > 0 ? `${h}:${mm}` : `${m}:${String(s).padStart(2, "0")}`;
}

/** Русское склонение: plural(5, ["точка", "точки", "точек"]) → «точек». */
export function plural(n, [one, few, many]) {
  const n10 = n % 10;
  const n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return one;
  if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return few;
  return many;
}

export function count(n, forms) {
  return `${nf0.format(n)} ${plural(n, forms)}`;
}

/** Примерное время загрузки: «меньше минуты», «~3 мин». */
export function eta(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  if (seconds < 50) return "меньше минуты";
  const min = Math.round(seconds / 60);
  if (min < 60) return `~${min} мин`;
  return `~${oneDecimal(min / 60)} ч`;
}
