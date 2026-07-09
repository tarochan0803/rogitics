import { API_ENDPOINTS } from '../config.js';
import { fetchWithTimeout } from '../utils/fetchTimeout.js';

const OSRM_DEFAULT_OPTS = {
  overview: 'full',
  geometries: 'geojson',
  steps: false,
  annotations: false
};

// OSRM 公式デモはレート制限・タイムアウトで詰まることがある。
// ただし短すぎると直線/道路グラフへ落ちやすいので、通常操作では少し待つ。
const OSRM_TIMEOUT_MS = 10000;

function osrmRouteToResult(route) {
  const coordsOut = route?.geometry?.coordinates?.map(([lng, lat]) => ({ lat, lng })) || [];
  return {
    coordinates: coordsOut,
    distance: route?.distance,
    duration: route?.duration,
    raw: route
  };
}

// 複数候補（OSRM alternatives）を取得する。失敗/未対応時は空配列を返す。
// alternatives: true で OSRM 既定本数、数値で本数指定。最短のみで良いときは fetchOsrmRoute を使う。
export async function fetchOsrmRoutes(points, options = {}) {
  if (!Array.isArray(points) || points.length < 2) {
    throw new Error('At least two points are required');
  }
  const opts = { ...OSRM_DEFAULT_OPTS, alternatives: 3, ...options };
  const coords = points.map((p) => `${p.lng},${p.lat}`).join(';');
  const params = new URLSearchParams({
    overview: opts.overview,
    geometries: opts.geometries,
    steps: String(opts.steps),
    annotations: String(opts.annotations),
    alternatives: String(opts.alternatives)
  });
  const url = `${API_ENDPOINTS.OSRM_ROUTE}/${coords}?${params.toString()}`;
  const res = await fetchWithTimeout(url, {}, OSRM_TIMEOUT_MS);
  if (!res.ok) {
    throw new Error(`OSRM error: ${res.status}`);
  }
  const data = await res.json();
  if (data.code !== 'Ok' || !Array.isArray(data.routes) || data.routes.length === 0) {
    return [];
  }
  return data.routes.map(osrmRouteToResult).filter((r) => r.coordinates.length >= 2);
}

export async function fetchOsrmRoute(points, options = {}) {
  if (!Array.isArray(points) || points.length < 2) {
    throw new Error('At least two points are required');
  }
  const opts = { ...OSRM_DEFAULT_OPTS, ...options };
  const coords = points.map((p) => `${p.lng},${p.lat}`).join(';');
  const params = new URLSearchParams({
    overview: opts.overview,
    geometries: opts.geometries,
    steps: String(opts.steps),
    annotations: String(opts.annotations)
  });
  const url = `${API_ENDPOINTS.OSRM_ROUTE}/${coords}?${params.toString()}`;
  const res = await fetchWithTimeout(url, {}, OSRM_TIMEOUT_MS);
  if (!res.ok) {
    throw new Error(`OSRM error: ${res.status}`);
  }
  const data = await res.json();
  if (data.code !== 'Ok' || !data.routes || data.routes.length === 0) {
    return null;
  }
  return osrmRouteToResult(data.routes[0]);
}
