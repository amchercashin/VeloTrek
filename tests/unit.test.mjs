/**
 * Юнит-тесты чистых модулей (без браузера): node --test tests/
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { haversine, nearestOnTrack, buildTrackIndex, decodePolyline, bearing, linesToSvgPath } from "../js/lib/geo.js";
import { corridorTiles } from "../js/data/tiles.js";
import { kmlFromKmz } from "../js/lib/unzip.js";
import * as fmt from "../js/lib/format.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

test("расстояние до трека меряется до отрезка, а не только до вершин", () => {
  const index = buildTrackIndex([[[55, 37], [55, 38]]]);
  const near = nearestOnTrack(index, 55.001, 37.5);
  assert.ok(near.distance < 150, `distance ${near.distance}`);
  // Проекция на середину отрезка — половина его длины
  const half = haversine(55, 37, 55, 38) / 2;
  assert.ok(Math.abs(near.along - half) < 500, `along ${near.along}`);
});

test("азимут на север и восток", () => {
  assert.ok(Math.abs(bearing(55, 37, 56, 37) - 0) < 0.5);
  assert.ok(Math.abs(bearing(0, 37, 0, 38) - 90) < 0.5);
});

test("коридор тайлов без дыр даже при редких точках трека", () => {
  // Две точки в 30 км друг от друга: на z16 это ~90 тайлов подряд
  const keys = corridorTiles([[[55.5, 37.0], [55.5, 37.5]]], { min: 16, max: 16 });
  const xs = [...new Set(keys.map((k) => Number(k.split("/")[1])))].sort((a, b) => a - b);
  for (let i = 1; i < xs.length; i++) assert.equal(xs[i] - xs[i - 1], 1, "дыра в коридоре");
  assert.ok(xs.length > 80);
});

test("коридор не дублирует тайлы и покрывает все уровни", () => {
  const keys = corridorTiles([[[55.7, 37.6], [55.72, 37.65], [55.7, 37.6]]]);
  assert.equal(new Set(keys).size, keys.length);
  const zooms = new Set(keys.map((k) => Number(k.split("/")[0])));
  assert.deepEqual([...zooms].sort((a, b) => a - b), [10, 11, 12, 13, 14, 15, 16]);
});

test("полилинии из index.json декодируются в координаты маршрута", () => {
  const index = JSON.parse(readFileSync(join(ROOT, "routes/index.json"), "utf8"));
  for (const section of index.sections) {
    for (const r of section.routes) {
      assert.ok(r.line?.length, `нет геометрии у ${r.filename}`);
      const pts = r.line.flatMap((l) => decodePolyline(l));
      for (const [lat, lon] of pts) {
        assert.ok(lat >= r.bbox.minLat - 1e-4 && lat <= r.bbox.maxLat + 1e-4, `${r.filename}: lat ${lat}`);
        assert.ok(lon >= r.bbox.minLon - 1e-4 && lon <= r.bbox.maxLon + 1e-4, `${r.filename}: lon ${lon}`);
      }
      assert.ok(r.mainKm > 0 && r.mainKm <= r.stats.track_km + 0.1, `${r.filename}: mainKm`);
    }
  }
});

test("силуэт маршрута помещается в миниатюру", () => {
  const { d, start, end } = linesToSvgPath([[[55, 37], [55.1, 37.2], [55.05, 37.4]]], 64, 8);
  assert.match(d, /^M/);
  for (const [x, y] of [start, end]) {
    assert.ok(x >= 8 && x <= 56 && y >= 8 && y <= 56);
  }
});

test("KMZ распаковывается без JSZip", async () => {
  const buf = readFileSync(join(ROOT, "routes/Москва/03-zelyonoe-kolco-moskvy.kmz"));
  const kml = await kmlFromKmz(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  assert.match(kml, /<kml[\s>]/);
  assert.match(kml, /<coordinates>/);
});

test("русские склонения и форматы", () => {
  assert.equal(fmt.plural(1, ["точка", "точки", "точек"]), "точка");
  assert.equal(fmt.plural(3, ["точка", "точки", "точек"]), "точки");
  assert.equal(fmt.plural(11, ["точка", "точки", "точек"]), "точек");
  assert.equal(fmt.plural(22, ["точка", "точки", "точек"]), "точки");
  assert.equal(fmt.duration(65 * 60 * 1000), "1:05");
  assert.equal(fmt.duration(48 * 1000), "0:48");
  assert.equal(fmt.distance(240), "240\u00a0м");
});

test("Service Worker кэширует все модули и ассеты оболочки", () => {
  const sw = readFileSync(join(ROOT, "sw.js"), "utf8");
  const listed = new Set([...sw.matchAll(/"\.\/([^"]+)"/g)].map((m) => m[1]));
  const walk = (dir) =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? walk(p) : [relative(ROOT, p)];
    });
  const required = [...walk(join(ROOT, "js")), ...walk(join(ROOT, "fonts")), ...walk(join(ROOT, "vendor")), "css/app.css"];
  const missing = required.filter((f) => !listed.has(f.split("\\").join("/")));
  assert.deepEqual(missing, [], "добавьте файлы в SHELL_FILES в sw.js");
  assert.match(sw, /const SHELL_VERSION = \d+;/, "формат версии нужен workflow bump-sw-version");
});

test("генератор каталога (Python) и приложение (JS) одинаково кодируют геометрию", () => {
  const out = execFileSync("python3", ["-c", `
import importlib.util, json
spec = importlib.util.spec_from_file_location("gi", "scripts/generate-index.py")
gi = importlib.util.module_from_spec(spec); spec.loader.exec_module(gi)
print(gi.encode_polyline([(38.5, -120.2), (40.7, -120.95), (43.252, -126.453)]))
`], { cwd: ROOT, encoding: "utf8" }).trim();
  // Эталон из документации Google Encoded Polyline
  assert.equal(out, "_p~iF~ps|U_ulLnnqC_mqNvxq`@");
  assert.deepEqual(decodePolyline(out), [[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]]);
});
