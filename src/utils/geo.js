// The browser entrypoint loads Turf via a script tag before app modules.
// Avoiding remote ESM imports here keeps Node-side checks/imports usable.
const turf = (typeof globalThis !== 'undefined' && globalThis.turf) ? globalThis.turf : {};
if (!(typeof globalThis !== 'undefined' && globalThis.turf) && typeof console !== 'undefined') {
  console.warn('[geo] Turf global is unavailable. Load turf.min.js before using geometry utilities.');
}

export const d2r = (deg) => deg * Math.PI / 180;
export const r2d = (rad) => rad * 180 / Math.PI;

export const normA = (a) => {
  let angle = a;
  while (angle > Math.PI) angle -= 2 * Math.PI;
  while (angle < -Math.PI) angle += 2 * Math.PI;
  return angle;
};

// ポリゴンの総頂点数を返す（スタックオーバーフロー予防用）
function countVertices(geo) {
  const g = geo?.type === 'Feature' ? geo.geometry : geo;
  if (!g) return 0;
  let n = 0;
  if (g.type === 'Polygon') {
    for (const ring of g.coordinates) n += ring.length;
  } else if (g.type === 'MultiPolygon') {
    for (const poly of g.coordinates) for (const ring of poly) n += ring.length;
  }
  return n;
}

// 頂点数が多いポリゴンをsimplifyで圧縮する。失敗した場合は元を返す
function simplifyIfComplex(geo, maxVertices = 800) {
  if (countVertices(geo) <= maxVertices) return geo;
  // 0.5m相当の簡略化許容度（約0.0000045度）
  const toleranceDeg = 0.0000045;
  try {
    const s = turf.simplify(geo, { tolerance: toleranceDeg, highQuality: false, mutate: false });
    return s || geo;
  } catch (e) {
    return geo;
  }
}

export function geoToPC(geo) {
  const g = (geo.type === 'Feature') ? geo.geometry : geo;
  if (g.type === 'Polygon') return [g.coordinates];
  if (g.type === 'MultiPolygon') return g.coordinates;
  const poly = turf.buffer(geo, 0.001, { units: 'meters' });
  const gg = (poly.type === 'Feature') ? poly.geometry : poly;
  return gg.type === 'Polygon' ? [gg.coordinates] : gg.coordinates;
}

export function pcToGeo(pc) {
  if (!pc || !pc.length) return null;
  return (pc.length === 1) ? turf.polygon(pc[0]) : turf.multiPolygon(pc);
}

export function safeUnion(a, b) {
  try {
    return turf.union(a, b);
  } catch (err) {
    const pcLib = typeof polygonClipping !== 'undefined'
      ? polygonClipping
      : (typeof window !== 'undefined' ? window.polygonClipping : undefined);
    if (pcLib) {
      try {
        // 頂点数が多いとpolygon-clippingがスタックオーバーフローするため事前に簡略化
        const sa = simplifyIfComplex(a);
        const sb = simplifyIfComplex(b);
        const pc = pcLib.union(geoToPC(sa), geoToPC(sb));
        const g = pcToGeo(pc);
        if (g) return g;
      } catch (fallbackErr) {
        // ユーザーに不要なエラーログを見せないように警告を抑制
        // console.warn('safeUnion polygon-clipping fallback failed', fallbackErr.message ?? fallbackErr);
        // フォールバックも失敗した場合は大きい方を返して処理を継続
        try { return countVertices(a) >= countVertices(b) ? a : b; } catch (e2) { /* skip */ }
      }
    }
    return a; // throwせず元のポリゴンを返して処理続行
  }
}

export function safeDifference(a, b) {
  try {
    return turf.difference(a, b);
  } catch (err) {
    const pcLib = typeof polygonClipping !== 'undefined'
      ? polygonClipping
      : (typeof window !== 'undefined' ? window.polygonClipping : undefined);
    if (pcLib) {
      try {
        const sa = simplifyIfComplex(a);
        const sb = simplifyIfComplex(b);
        const pc = pcLib.difference(geoToPC(sa), geoToPC(sb));
        const g = pcToGeo(pc);
        if (g) return g;
        return null;
      } catch (fallbackErr) {
        console.warn('safeDifference polygon-clipping fallback failed', fallbackErr.message ?? fallbackErr);
      }
    }
    return a; // throwせず元のポリゴンを返す
  }
}

export function safeIntersect(a, b) {
  try {
    return turf.intersect(a, b);
  } catch (err) {
    const pcLib = typeof polygonClipping !== 'undefined'
      ? polygonClipping
      : (typeof window !== 'undefined' ? window.polygonClipping : undefined);
    if (pcLib) {
      try {
        const pc = pcLib.intersection(geoToPC(a), geoToPC(b));
        const g = pcToGeo(pc);
        if (g) return g;
        return null;
      } catch (fallbackErr) {
        console.warn('safeIntersect polygon-clipping fallback failed', fallbackErr);
      }
    }
    throw err;
  }
}

export const coordinateSystem = {
  origin: null,
  setOrigin(lat, lng) {
    this.origin = turf.point([lng, lat]);
  },
  latLngToMeters(lat, lng) {
    if (!this.origin) return { x: 0, y: 0 };
    const to = turf.point([lng, lat]);
    const distKm = turf.distance(this.origin, to, { units: 'kilometers' });
    const bearing = turf.bearing(this.origin, to);
    const rad = d2r(bearing);
    const distM = distKm * 1000.0;
    return { x: distM * Math.sin(rad), y: distM * Math.cos(rad) };
  },
  metersToLatLng(x, y) {
    if (!this.origin) return { lat: 0, lng: 0 };
    const distM = Math.hypot(x, y);
    if (distM < 1e-6) {
      const [lng0, lat0] = this.origin.geometry.coordinates;
      return formatLatLng(lat0, lng0);
    }
    let rad = Math.atan2(x, y);
    let bearing = r2d(rad);
    if (bearing < 0) bearing += 360;
    const dest = turf.destination(this.origin, distM / 1000.0, bearing, { units: 'kilometers' });
    return formatLatLng(dest.geometry.coordinates[1], dest.geometry.coordinates[0]);
  }
};

function formatLatLng(lat, lng) {
  const hasLeaflet = typeof L !== 'undefined' && typeof L.latLng === 'function';
  return hasLeaflet ? L.latLng(lat, lng) : { lat, lng };
}

export { turf };
