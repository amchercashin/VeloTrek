#!/usr/bin/env node
/**
 * Сквозной сценарий в настоящем Chromium (Playwright):
 * каталог → маршрут → скачать карту → без сети → открыть снова → навигация по GPS.
 *
 *   npx http-server -p 8080 -c-1 .   # в другом терминале
 *   node tests/e2e.mjs [http://localhost:8080] [папка-для-скриншотов]
 *
 * E2E_STUB_TILES=1 — отдавать тайлы-заглушки вместо OpenStreetMap
 * (для CI и сред, где сервер тайлов недоступен или медленный).
 */
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const BASE = process.argv[2] || "http://localhost:8080";
const SHOTS = process.argv[3] || null;
const ROUTE = "Москва/10-filevskiy-park.kml";
// Точка с середины трека — там GPS должен показать «на маршруте»
const coords = readFileSync(new URL(`../routes/${ROUTE}`, import.meta.url), "utf8")
  .match(/<coordinates>([\s\S]*?)<\/coordinates>/g)
  .map((c) => c.replace(/<\/?coordinates>/g, "").trim().split(/\s+/))
  .sort((a, b) => b.length - a.length)[0];
const [ON_LON, ON_LAT] = coords[Math.floor(coords.length / 2)].split(",").map(Number);

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  locale: "ru-RU",
  ignoreHTTPSErrors: true,
  permissions: ["geolocation"],
  geolocation: { latitude: ON_LAT, longitude: ON_LON, accuracy: 8 },
});
if (process.env.E2E_STUB_TILES) {
  const png = readFileSync(new URL("../icons/icon-192.png", import.meta.url));
  await ctx.route(/tile\.openstreetmap\.org/, (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: png, headers: { "access-control-allow-origin": "*" } }),
  );
}
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && !m.text().includes("net::") && errors.push(m.text()));

let step = 0;
async function check(name, fn) {
  step++;
  try {
    await fn();
    console.log(`ok ${step} - ${name}`);
  } catch (e) {
    console.log(`not ok ${step} - ${name}\n  ${e.message.split("\n")[0]}`);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/fail-${step}.png` });
    process.exitCode = 1;
  }
}
const shot = (name) => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png` });

await page.goto(BASE + "/");

await check("онбординг показывается при первом запуске", async () => {
  await page.locator(".panel--onboard").waitFor({ timeout: 5000 });
  await page.locator(".panel--onboard [data-close]").last().click();
  await page.locator(".panel--onboard").waitFor({ state: "detached" });
});

await check("каталог рисует все маршруты", async () => {
  await page.locator(".card[data-id]").first().waitFor();
  const n = await page.locator(".card[data-id]").count();
  if (n < 30) throw new Error(`карточек ${n}`);
});

await check("поиск фильтрует список", async () => {
  await page.fill(".search input", "яуз");
  await page.waitForTimeout(200);
  const visible = await page.locator(".card[data-id]:visible").count();
  if (visible !== 1) throw new Error(`видно ${visible}`);
  await page.click(".search__clear");
});

await check("открывается маршрут и считается размер карты", async () => {
  await page.click(`.card[data-id="${ROUTE}"]`);
  await page.locator(".offline[data-state=none]").waitFor({ timeout: 15000 });
  const text = await page.locator(".offline").innerText();
  if (!/МБ/.test(text)) throw new Error(text);
  await shot("e2e-route");
});

await check("карта скачивается в IndexedDB", async () => {
  await page.click("[data-action=download]");
  await page.locator(".offline[data-state=ready], .offline[data-state=partial]").waitFor({ timeout: 120000 });
  await shot("e2e-downloaded");
});

await check("без сети маршрут открывается из памяти телефона", async () => {
  await page.click("[data-action=back]");
  await page.locator(`.card.is-saved[data-id="${ROUTE}"]`).waitFor();
  await ctx.setOffline(true);
  await page.reload();
  await page.locator(".card[data-id]").first().waitFor({ timeout: 10000 });
  await page.click(`.card[data-id="${ROUTE}"]`);
  await page.locator(".offline[data-state=ready], .offline[data-state=partial]").waitFor({ timeout: 10000 });
  await page.waitForTimeout(1500);
  const blobTiles = await page.$$eval(".route-map img.leaflet-tile", (els) => els.filter((e) => e.src.startsWith("blob:") || e.currentSrc.startsWith("blob:")).length);
  const loaded = await page.$$eval(".route-map img.leaflet-tile-loaded", (els) => els.length);
  if (!loaded) throw new Error("нет ни одного тайла");
  if (!blobTiles) throw new Error("тайлы не из IndexedDB");
  console.log(`  # тайлов на экране: ${loaded}, из памяти: ${blobTiles}`);
  await shot("e2e-offline");
});

await check("навигация: HUD, «на маршруте», скорость", async () => {
  await page.click("[data-action=go]");
  await page.locator(".hud").waitFor();
  await page.locator(".hud__status[data-tone=ok]").waitFor({ timeout: 10000 });
  await shot("e2e-nav");
});

await check("навигация: сход с трека показывает расстояние и стрелку", async () => {
  await ctx.setGeolocation({ latitude: ON_LAT + 0.005, longitude: ON_LON, accuracy: 8 });
  await page.locator(".hud__status[data-tone=danger]").waitFor({ timeout: 10000 });
  const text = await page.locator(".hud__status").innerText();
  if (!/до трека/.test(text)) throw new Error(text);
  await shot("e2e-offroute");
});

await check("«назад» во время поездки спрашивает подтверждение", async () => {
  await page.goBack();
  await page.locator(".dialog").waitFor({ timeout: 5000 });
  await page.locator(".dialog button[value=ok]").click();
  await page.locator(".hud").waitFor({ state: "hidden" });
});

await ctx.setOffline(false);
if (errors.length) {
  console.log("not ok - ошибки в консоли:\n  " + errors.join("\n  "));
  process.exitCode = 1;
}
await browser.close();
