#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");

function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      return result.then(
        () => ({ name, ok: true }),
        (error) => ({ name, ok: false, error }),
      );
    }
    return Promise.resolve({ name, ok: true });
  } catch (error) {
    return Promise.resolve({ name, ok: false, error });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function createElementStub() {
  const el = {
    textContent: "",
    innerHTML: "",
    classList: { add() {}, remove() {}, toggle() {} },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    setAttribute() {},
    addEventListener() {},
    removeEventListener() {},
  };
  return el;
}

function loadBrowserScript(filename, globals = {}, append = "") {
  const code = fs.readFileSync(path.join(ROOT, filename), "utf8");
  const context = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    URL,
    navigator: {},
    window: {
      location: { hostname: "localhost", pathname: "/" },
      addEventListener() {},
      removeEventListener() {},
    },
    document: {
      body: { dataset: {}, classList: { add() {}, remove() {}, toggle() {} } },
      createElement: createElementStub,
      querySelector() {
        return null;
      },
      getElementById() {
        return createElementStub();
      },
      addEventListener() {},
    },
    localStorage: {
      _store: {},
      getItem(key) {
        return this._store[key] || null;
      },
      setItem(key, value) {
        this._store[key] = String(value);
      },
      removeItem(key) {
        delete this._store[key];
      },
    },
    sessionStorage: {
      setItem() {},
      getItem() {
        return null;
      },
      removeItem() {},
    },
    IntersectionObserver: function () {
      return { observe() {}, disconnect() {} };
    },
    requestAnimationFrame(fn) {
      return fn();
    },
    ...globals,
  });
  vm.runInContext(code + append, context, { filename });
  return context;
}

async function main() {
  const results = await Promise.all([
    test("catalog keeps stale cache as offline fallback after TTL", async () => {
      const now = Date.now();
      const sections = [{ name: "Old", routes: [] }];
      const context = loadBrowserScript("js/app.js", {
        fetch: async () => {
          throw new Error("offline");
        },
      }, ";globalThis.__App = App;");
      context.localStorage.setItem(
        "velotrek-catalog",
        JSON.stringify({
          timestamp: now - 25 * 60 * 60 * 1000,
          sections,
        }),
      );
      const loaded = await context.__App.loadCatalog();
      assert(loaded === sections || loaded[0].name === "Old", "expired cache was not returned");
    }),

    test("GPS nearest distance is measured to a segment, not only route points", () => {
      const L = {
        circle() {
          return { addTo() { return this; }, setLatLng() {}, setRadius() {}, remove() {} };
        },
        marker() {
          return { addTo() { return this; }, setLatLng() {}, getElement() { return null; }, remove() {} };
        },
        divIcon() {
          return {};
        },
        latLng(lat, lon) {
          return { lat, lon };
        },
      };
      const context = loadBrowserScript("js/gps.js", { L }, ";globalThis.__GPSTracker = GPSTracker;");
      assert(context.__GPSTracker._test, "test helpers are not exposed");
      context.__GPSTracker.init(
        { panTo() {} },
        { segments: [[[55, 37, 0], [55, 38, 0]]] },
        () => {},
      );
      const nearest = context.__GPSTracker._test.findNearestPoint(55.001, 37.5);
      assert(nearest.distance < 150, `distance was ${nearest.distance}m`);
    }),
  ]);

  let failed = 0;
  for (const result of results) {
    if (result.ok) {
      console.log(`ok - ${result.name}`);
    } else {
      failed++;
      console.error(`not ok - ${result.name}`);
      console.error(result.error && result.error.stack ? result.error.stack : result.error);
    }
  }
  if (failed) process.exit(1);
}

main();
