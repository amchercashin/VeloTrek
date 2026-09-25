/**
 * Распаковка одного файла из ZIP (KMZ) нативным DecompressionStream —
 * заменяет JSZip (~100 КБ) десятком строк.
 */

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

function findEndOfCentralDirectory(view) {
  // Комментарий архива ≤ 64 КБ, поэтому ищем сигнатуру с конца
  const min = Math.max(0, view.byteLength - 22 - 0xffff);
  for (let i = view.byteLength - 22; i >= min; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) return i;
  }
  throw new Error("Повреждённый KMZ: не найден каталог архива");
}

/** Список записей архива: [{ name, method, compressedSize, offset }] */
export function listEntries(buffer) {
  const view = new DataView(buffer);
  const eocd = findEndOfCentralDirectory(view);
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (view.getUint32(p, true) !== CEN_SIG) throw new Error("Повреждённый KMZ");
    const method = view.getUint16(p + 10, true);
    const compressedSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const offset = view.getUint32(p + 42, true);
    const name = decoder.decode(new Uint8Array(buffer, p + 46, nameLen));
    entries.push({ name, method, compressedSize, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export async function readEntry(buffer, entry) {
  const view = new DataView(buffer);
  const p = entry.offset;
  if (view.getUint32(p, true) !== LOC_SIG) throw new Error("Повреждённый KMZ");
  const start = p + 30 + view.getUint16(p + 26, true) + view.getUint16(p + 28, true);
  const data = new Uint8Array(buffer, start, entry.compressedSize);
  if (entry.method === 0) return new TextDecoder().decode(data);
  if (entry.method !== 8) throw new Error("Неподдерживаемое сжатие в KMZ");
  if (typeof DecompressionStream === "undefined") {
    throw new Error("Браузер не умеет распаковывать KMZ — обновите его");
  }
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Response(stream).text();
}

/** Текст KML из KMZ: doc.kml или первый .kml в архиве. */
export async function kmlFromKmz(buffer) {
  const entries = listEntries(buffer);
  const kml =
    entries.find((e) => e.name.toLowerCase() === "doc.kml") ||
    entries.find((e) => e.name.toLowerCase().endsWith(".kml"));
  if (!kml) throw new Error("В KMZ не найден файл KML");
  return readEntry(buffer, kml);
}
