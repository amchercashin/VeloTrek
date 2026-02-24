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
        iconSize: [22, 28],
        iconAnchor: [11, 14]
      }),
      zIndexOffset: 1000
    }).addTo(map);

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

  function onPosition(position) {
    const { latitude, longitude, accuracy, heading, speed } = position.coords;
    const latlng = L.latLng(latitude, longitude);

    accuracyCircle.setLatLng(latlng);
    accuracyCircle.setRadius(accuracy);
    headingMarker.setLatLng(latlng);

    // Поворот стрелки направления
    if (heading !== null && !isNaN(heading)) {
      const arrow = headingMarker.getElement();
      if (arrow) {
        arrow.querySelector('.gps-heading-arrow').style.transform = `rotate(${heading}deg)`;
      }
    }

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

    // Sample route points for performance
    const step = Math.max(1, Math.floor(routePoints.length / 1000));
    for (let i = 0; i < routePoints.length; i += step) {
      const point = routePoints[i];
      const dist = haversine(lat, lon, point[0], point[1]);
      if (dist < minDist) {
        minDist = dist;
        nearestPoint = point;
      }
    }

    // Refine search near the nearest found point
    if (nearestPoint) {
      const idx = routePoints.indexOf(nearestPoint);
      const start = Math.max(0, idx - step);
      const end = Math.min(routePoints.length, idx + step);
      for (let i = start; i < end; i++) {
        const point = routePoints[i];
        const dist = haversine(lat, lon, point[0], point[1]);
        if (dist < minDist) {
          minDist = dist;
          nearestPoint = point;
        }
      }
    }

    return { point: nearestPoint, distance: minDist };
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

  return { init, start, stop, setFollowMode, getState };
})();
