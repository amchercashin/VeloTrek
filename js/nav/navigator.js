/**
 * Навигация по треку: GPS, компас, положение относительно маршрута.
 * Работает полностью без сети — нужны только спутники и датчики телефона.
 */
import { buildTrackIndex, nearestOnTrack, haversine, bearing } from "../lib/geo.js";

const OFF_ROUTE_M = 70; // порог «сошли с маршрута» (с поправкой на точность GPS)
const GPS_HEADING_MIN_SPEED = 1.5; // м/с ≈ 5 км/ч — ниже курс по GPS шумит
const GPS_HEADING_HOLD_MS = 3000; // после курса по GPS компас не перебивает его
const TRAIL_MIN_STEP_M = 8;

/**
 * iOS требует разрешение на компас строго из обработчика жеста,
 * до любых других await — поэтому это отдельная функция.
 */
export function requestCompassPermission() {
  const DOE = window.DeviceOrientationEvent;
  if (DOE && typeof DOE.requestPermission === "function") {
    return DOE.requestPermission().catch(() => "denied");
  }
  return Promise.resolve("granted");
}

export function createNavigator({ L, map, route, onUpdate, onFollowChange, keepAwake = true }) {
  const index = buildTrackIndex(route.segments);
  let watchId = null;
  let wakeLock = null;
  let marker = null;
  let accuracyCircle = null;
  let trail = null;
  let follow = true;
  let insets = { top: 0, bottom: 0 };
  let lastFix = null;
  let lastTrailPoint = null;
  let ridden = 0;
  let startedAt = 0;
  let speedEma = null;
  let offRoute = false;
  let heading = null;
  let gpsHeadingAt = 0;
  let compassFrame = 0;
  let pendingCompass = null;
  let orientationEvent = null;

  function setHeading(deg) {
    heading = deg;
    const arrow = marker?.getElement()?.querySelector(".you__heading");
    if (arrow) {
      arrow.style.transform = `rotate(${deg}deg)`;
      arrow.hidden = false;
    }
  }

  function onOrientation(e) {
    let h = null;
    if (typeof e.webkitCompassHeading === "number") h = e.webkitCompassHeading;
    else if (e.absolute && typeof e.alpha === "number") h = 360 - e.alpha;
    if (h === null) return;
    h = (h + (screen.orientation?.angle || 0) + 360) % 360;
    pendingCompass = h;
    // Датчик шлёт ~60 событий/с — поворачиваем стрелку не чаще раза в кадр
    if (!compassFrame) {
      compassFrame = requestAnimationFrame(() => {
        compassFrame = 0;
        if (Date.now() - gpsHeadingAt > GPS_HEADING_HOLD_MS) setHeading(pendingCompass);
      });
    }
  }

  function startCompass() {
    if (!window.DeviceOrientationEvent) return;
    orientationEvent = "ondeviceorientationabsolute" in window ? "deviceorientationabsolute" : "deviceorientation";
    window.addEventListener(orientationEvent, onOrientation);
  }

  async function acquireWakeLock() {
    if (!keepAwake || wakeLock) return;
    try {
      if ("wakeLock" in navigator && document.visibilityState === "visible") {
        wakeLock = await navigator.wakeLock.request("screen");
        // Система снимает блокировку, когда вкладка скрыта, — вернём её при возвращении
        wakeLock.addEventListener("release", () => (wakeLock = null));
      }
    } catch {
      /* нет поддержки или энергосбережение — экран просто погаснет по таймауту */
    }
  }

  function onVisibility() {
    if (document.visibilityState === "visible" && watchId !== null) acquireWakeLock();
  }

  function centerOn(latlng, animate = true) {
    // Смещаем центр так, чтобы метка была посередине видимой части (между HUD сверху и снизу)
    const shift = (insets.bottom - insets.top) / 2;
    const p = map.project(latlng, map.getZoom()).add([0, shift]);
    map.panTo(map.unproject(p, map.getZoom()), { animate, duration: 0.6, easeLinearity: 0.5 });
  }

  function onPosition(pos) {
    const { latitude: lat, longitude: lon, accuracy, speed, heading: course } = pos.coords;
    const now = pos.timestamp || Date.now();
    const latlng = L.latLng(lat, lon);

    // Скорость: из GPS, иначе по смещению между фиксами; сглаживаем
    let v = Number.isFinite(speed) && speed !== null ? speed : null;
    if (v === null && lastFix) {
      const dt = (now - lastFix.t) / 1000;
      if (dt > 0.5) v = haversine(lastFix.lat, lastFix.lon, lat, lon) / dt;
    }
    if (v !== null) speedEma = speedEma === null ? v : speedEma * 0.6 + v * 0.4;
    if (accuracy > 60) speedEma = speedEma === null ? null : speedEma * 0.8;

    // Проехано: только по уверенным фиксам, чтобы дрожание на месте не накручивало
    if (accuracy <= 35) {
      if (!lastTrailPoint) {
        lastTrailPoint = [lat, lon];
        trail.addLatLng(latlng);
      } else {
        const d = haversine(lastTrailPoint[0], lastTrailPoint[1], lat, lon);
        if (d >= Math.max(TRAIL_MIN_STEP_M, accuracy / 2)) {
          ridden += d;
          lastTrailPoint = [lat, lon];
          trail.addLatLng(latlng);
        }
      }
    }
    lastFix = { lat, lon, t: now };

    if (Number.isFinite(course) && course !== null && (speed || 0) >= GPS_HEADING_MIN_SPEED && accuracy <= 50) {
      gpsHeadingAt = Date.now();
      setHeading(course);
    }

    const firstFix = !marker.getElement()?.classList.contains("is-live");
    marker.setLatLng(latlng);
    accuracyCircle.setLatLng(latlng).setRadius(accuracy);
    marker.getElement()?.classList.add("is-live");

    if (firstFix) {
      map.setView(latlng, Math.max(map.getZoom(), 15), { animate: false });
      centerOn(latlng, false);
    } else if (follow) {
      centerOn(latlng);
    }

    const near = nearestOnTrack(index, lat, lon);
    if (near) {
      const threshold = Math.max(OFF_ROUTE_M, Math.min(accuracy, 60) * 1.2);
      const wasOff = offRoute;
      // Гистерезис: чтобы статус не мигал на границе коридора
      offRoute = offRoute ? near.distance > threshold * 0.7 : near.distance > threshold;
      if (offRoute && !wasOff) navigator.vibrate?.([180, 90, 180]);
      near.bearingTo = bearing(lat, lon, near.point[0], near.point[1]);
    }

    onUpdate?.({
      state: accuracy > 50 ? "poor" : "ok",
      lat,
      lon,
      accuracy,
      speedKmh: speedEma === null ? null : speedEma * 3.6,
      heading,
      near,
      offRoute,
      ridden,
      elapsed: Date.now() - startedAt,
      multiTrack: index.length > 1,
    });
  }

  function onError(err) {
    onUpdate?.({
      state: "error",
      code: err.code,
      message:
        err.code === 1
          ? "Нет доступа к геолокации. Разрешите его в настройках браузера."
          : err.code === 3
            ? "Ищем спутники… Без сети первый поиск может занять минуту."
            : "GPS временно недоступен",
    });
  }

  function start() {
    if (!navigator.geolocation) throw new Error("Геолокация не поддерживается этим браузером");
    startedAt = Date.now();

    accuracyCircle = L.circle([0, 0], {
      radius: 0,
      color: "#1e6bff",
      weight: 1,
      opacity: 0.35,
      fillColor: "#1e6bff",
      fillOpacity: 0.08,
      interactive: false,
    }).addTo(map);
    trail = L.polyline([], {
      color: "#1e6bff",
      weight: 4,
      opacity: 0.55,
      interactive: false,
      lineCap: "round",
    }).addTo(map);
    marker = L.marker([0, 0], {
      icon: L.divIcon({
        className: "you",
        html: '<span class="you__heading" hidden></span><span class="you__pulse"></span><span class="you__dot"></span>',
        iconSize: [56, 56],
        iconAnchor: [28, 28],
      }),
      keyboard: false,
      interactive: false,
      zIndexOffset: 1000,
    }).addTo(map);

    startCompass();
    acquireWakeLock();
    document.addEventListener("visibilitychange", onVisibility);
    map.on("dragstart", onDragStart);

    watchId = navigator.geolocation.watchPosition(onPosition, onError, {
      enableHighAccuracy: true,
      maximumAge: 2000,
      timeout: 30000,
    });
  }

  function onDragStart() {
    if (follow) {
      follow = false;
      onFollowChange?.(false);
    }
  }

  function stop() {
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
    wakeLock?.release().catch(() => {});
    wakeLock = null;
    document.removeEventListener("visibilitychange", onVisibility);
    if (orientationEvent) window.removeEventListener(orientationEvent, onOrientation);
    cancelAnimationFrame(compassFrame);
    map.off("dragstart", onDragStart);
    for (const layer of [marker, accuracyCircle, trail]) layer?.remove();
    marker = accuracyCircle = trail = null;
  }

  function setFollow(on) {
    follow = on;
    onFollowChange?.(on);
    if (on && lastFix) {
      if (map.getZoom() < 14) map.setView([lastFix.lat, lastFix.lon], 16, { animate: false });
      centerOn(L.latLng(lastFix.lat, lastFix.lon));
    }
  }

  return {
    start,
    stop,
    setFollow,
    setInsets(next) {
      insets = next;
    },
    /** «Не гасить экран»: без блокировки экран гаснет по таймауту системы. */
    setKeepAwake(on) {
      keepAwake = on;
      if (on) acquireWakeLock();
      else {
        wakeLock?.release().catch(() => {});
        wakeLock = null;
      }
    },
    get following() {
      return follow;
    },
    get hasFix() {
      return !!lastFix;
    },
  };
}
