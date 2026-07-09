const DEFAULT_TIMEOUT_MS = 8000;

function waitForGoogleMaps(timeoutMs = DEFAULT_TIMEOUT_MS) {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('Google Maps JS API unavailable'));
  }
  if (window.google?.maps?.DirectionsService) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (window.google?.maps?.DirectionsService) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error('Google Maps JS API not loaded'));
      }
    }, 120);
  });
}

function toLatLngLiteral(point) {
  return { lat: Number(point.lat), lng: Number(point.lng) };
}

export async function fetchGoogleRoute(points, options = {}) {
  if (!Array.isArray(points) || points.length < 2) {
    throw new Error('At least two points are required');
  }

  await waitForGoogleMaps(options.timeoutMs);

  const origin = toLatLngLiteral(points[0]);
  const destination = toLatLngLiteral(points[points.length - 1]);
  const waypoints = points
    .slice(1, -1)
    .map((p) => ({ location: toLatLngLiteral(p), stopover: false }));

  const request = {
    origin,
    destination,
    waypoints,
    optimizeWaypoints: false,
    travelMode: window.google.maps.TravelMode.DRIVING
  };

  return await new Promise((resolve, reject) => {
    const service = new window.google.maps.DirectionsService();
    service.route(request, (result, status) => {
      if (status !== 'OK' || !result?.routes?.length) {
        reject(new Error(`Google Directions failed: ${status}`));
        return;
      }
      const route = result.routes[0];
      const path = route.overview_path || [];
      const coordinates = path.map((ll) => ({ lat: ll.lat(), lng: ll.lng() }));
      const legs = Array.isArray(route.legs) ? route.legs : [];
      const distance = legs.reduce((sum, leg) => sum + (leg.distance?.value || 0), 0);
      const duration = legs.reduce((sum, leg) => sum + (leg.duration?.value || 0), 0);
      resolve({
        coordinates,
        distance,
        duration,
        raw: route
      });
    });
  });
}
