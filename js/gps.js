/**
 * GPS-трекер для VeloTrek.
 * Отслеживает позицию, показывает маркер на карте, рассчитывает расстояние до маршрута.
 */
const GPSTracker = (() => {
  let map = null;
  let routeData = null;
  let watchId = null;
  let wakeLock = null;
  let accuracyCircle = null;
  let headingMarker = null;
  let isTracking = false;
  let followMode = true;
  let routePoints = [];
  let onUpdate = null;
  let orientationHandler = null;
  let compassHeading = null;

  // Пороги для доверия GPS heading:
  // - скорость выше ~5 км/ч (GPS вектор движения стабилен)
  // - точность лучше 50м (при глушении accuracy резко падает)
  const GPS_SPEED_MIN_MS = 1.5;   // м/с ≈ 5 км/ч
  const GPS_ACCURACY_MAX_M = 50;  // метров

  function init(leafletMap, route, callback) {
    map = leafletMap;
    routeData = route;
    onUpdate = callback;
    routePoints = route.segments.flat();
  }

  async function start() {
    if (!navigator.geolocation) {
      throw new Error('Геолокация не поддерживается');
    }

    // Wake Lock — экран не гаснет
    try {
      if ('wakeLock' in navigator) {
        wakeLock = await navigator.wakeLock.request('screen');
        document.addEventListener('visibilitychange', reacquireWakeLock);
      }
    } catch (e) {
      console.warn('Wake Lock недоступен:', e);
    }

    // Круг точности (ненавязчивый)
    accuracyCircle = L.circle([0, 0], {
      radius: 0,
      fillColor: '#EA4335',
      fillOpacity: 0.06,
      color: '#EA4335',
      weight: 0.5,
      opacity: 0.25
    }).addTo(map);

    // Стрелка направления — основной маркер позиции
    headingMarker = L.marker([0, 0], {
      icon: L.divIcon({
        className: 'gps-heading',
        html: '<div class="gps-heading-arrow"></div>',
        iconSize: [12, 16],
        iconAnchor: [6, 8]
      }),
      zIndexOffset: 1000
    }).addTo(map);

    // Компас устройства — работает даже стоя на месте
    await setupCompass();

    watchId = navigator.geolocation.watchPosition(
      onPosition,
      onError,
      {
        enableHighAccuracy: true,
        maximumAge: 3000,
        timeout: 15000
      }
    );

    isTracking = true;
  }

  // Подключаем компас через DeviceOrientationEvent.
  // iOS 13+ требует явного разрешения (вызывается из user gesture через start()).
  async function setupCompass() {
    const handler = (e) => {
      let heading = null;
      if (typeof e.webkitCompassHeading === 'number') {
        // iOS: webkitCompassHeading — градусы от севера по часовой
        heading = e.webkitCompassHeading;
      } else if (e.absolute && typeof e.alpha === 'number') {
        // Android: alpha — градусы против часовой от севера, конвертируем
        heading = (360 - e.alpha) % 360;
      }
      if (heading !== null) {
        compassHeading = heading;
        rotateArrow(heading);
      }
    };

    try {
      if (typeof DeviceOrientationEvent !== 'undefined' &&
          typeof DeviceOrientationEvent.requestPermission === 'function') {
        // iOS 13+
        const state = await DeviceOrientationEvent.requestPermission();
        if (state === 'granted') {
          orientationHandler = handler;
          window.addEventListener('deviceorientation', handler);
        }
      } else if (typeof DeviceOrientationEvent !== 'undefined') {
        // Android и остальные
        orientationHandler = handler;
        window.addEventListener('deviceorientationabsolute', handler, true);
        window.addEventListener('deviceorientation', handler, true);
      }
    } catch (e) {
      console.warn('Компас недоступен:', e);
    }
  }

  function rotateArrow(heading) {
    if (!headingMarker) return;
    const el = headingMarker.getElement();
    if (!el) return;
    const arrowEl = el.querySelector('.gps-heading-arrow');
    if (arrowEl) {
      arrowEl.style.transform = `rotate(${heading}deg)`;
    }
  }

  function onPosition(position) {
    const { latitude, longitude, accuracy, heading, speed } = position.coords;
    const latlng = L.latLng(latitude, longitude);

    accuracyCircle.setLatLng(latlng);
    accuracyCircle.setRadius(accuracy);
    headingMarker.setLatLng(latlng);

    // GPS heading — только при хорошем сигнале и достаточной скорости.
    // При глушении accuracy резко растёт, при малой скорости heading ненадёжен.
    const gpsHeadingReliable = heading !== null && !isNaN(heading)
      && (speed || 0) >= GPS_SPEED_MIN_MS
      && accuracy <= GPS_ACCURACY_MAX_M;

    if (gpsHeadingReliable) {
      rotateArrow(heading);
    }
    // Иначе компас (обновляется непрерывно через DeviceOrientationEvent)

    if (followMode) {
      map.panTo(latlng, { animate: true, duration: 0.5 });
    }

    // Расстояние до маршрута
    const nearest = findNearestPoint(latitude, longitude);

    if (onUpdate) {
      onUpdate({
        lat: latitude,
        lon: longitude,
        accuracy,
        heading,
        speed: speed || 0,
        nearestPoint: nearest.point,
        distanceToRoute: nearest.distance,
        onRoute: nearest.distance < 100
      });
    }
  }

  function onError(error) {
    console.warn('GPS ошибка:', error.message);
    if (onUpdate) {
      onUpdate({ error: error.message });
    }
  }

  function findNearestPoint(lat, lon) {
    let minDist = Infinity;
    let nearestPoint = null;

    for (const segment of routeData.segments) {
      if (segment.length === 1) {
        const point = segment[0];
        const dist = haversine(lat, lon, point[0], point[1]);
        if (dist < minDist) {
          minDist = dist;
          nearestPoint = point;
        }
        continue;
      }

      for (let i = 1; i < segment.length; i++) {
        const nearest = nearestOnSegment(lat, lon, segment[i - 1], segment[i]);
        if (nearest.distance < minDist) {
          minDist = nearest.distance;
          nearestPoint = nearest.point;
        }
      }
    }

    return { point: nearestPoint, distance: minDist };
  }

  function nearestOnSegment(lat, lon, a, b) {
    const latScale = 111320;
    const lonScale = 111320 * Math.cos((lat * Math.PI) / 180);
    const ax = (a[1] - lon) * lonScale;
    const ay = (a[0] - lat) * latScale;
    const bx = (b[1] - lon) * lonScale;
    const by = (b[0] - lat) * latScale;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    const x = ax + dx * t;
    const y = ay + dy * t;
    return {
      point: [
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        (a[2] || 0) + ((b[2] || 0) - (a[2] || 0)) * t,
      ],
      distance: Math.sqrt(x * x + y * y),
    };
  }

  function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function stop() {
    if (watchId !== null) {
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
    }
    if (wakeLock) {
      wakeLock.release();
      wakeLock = null;
      document.removeEventListener('visibilitychange', reacquireWakeLock);
    }
    if (orientationHandler) {
      window.removeEventListener('deviceorientationabsolute', orientationHandler, true);
      window.removeEventListener('deviceorientation', orientationHandler, true);
      orientationHandler = null;
    }
    compassHeading = null;
    if (headingMarker) {
      accuracyCircle.remove();
      headingMarker.remove();
      accuracyCircle = null;
      headingMarker = null;
    }
    isTracking = false;
    followMode = true;
  }

  async function reacquireWakeLock() {
    if (document.visibilityState === 'visible' && isTracking) {
      try {
        wakeLock = await navigator.wakeLock.request('screen');
      } catch (e) {
        // Ignore
      }
    }
  }

  function setFollowMode(enabled) {
    followMode = enabled;
  }

  function getState() {
    return { isTracking, followMode };
  }

  return { init, start, stop, setFollowMode, getState, _test: { findNearestPoint } };
})();
