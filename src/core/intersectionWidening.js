// 交差点コーナー補正（intersection widening）の単一ソース。
//
// 目的: 交差点の旋回ノードで「車両が実際に振り出して通る範囲」を道路面に足し込む。
// これは見た目だけでなく走行判定（buildRoadUnion 経由の roadUnion）とスイープにも効く。
// サイズは車両の旋回半径（getRouteTrackingTurnRadius）と旋回の振れ角から導出するため、
// 3Dスイープ（実際の車両外形軌跡）と幾何的に整合する。
import { turf } from '../utils/geo.js';
import { getRouteTrackingTurnRadius } from '../config.js';

// 経路頂点 b における進行方向の振れ角（deflection, rad）。0=直進, π=Uターン。
function deflectionAngle(a, b, c) {
  if (!a || !b || !c) return 0;
  const ax = a.lng - b.lng;
  const ay = a.lat - b.lat;
  const cx = c.lng - b.lng;
  const cy = c.lat - b.lat;
  const al = Math.hypot(ax, ay);
  const cl = Math.hypot(cx, cy);
  if (al < 1e-9 || cl < 1e-9) return 0;
  const dot = (ax * cx + ay * cy) / (al * cl);
  const interior = Math.acos(Math.max(-1, Math.min(1, dot)));
  return Math.abs(Math.PI - interior); // 内角の補角 = 振れ角
}

// 旋回ノードのコーナー半径(m)。車両の旋回半径 R と外形・振れ角から導出。
// 前外側コーナーは半径 Router = hypot(R + 半幅, 前端距離) の弧を描くため、
// その「弧外へのはみ出し量 swing = Router - R」を振れ角に応じて足す。
export function intersectionCapRadiusM(vehicleConfig = {}, deflectRad = Math.PI / 2) {
  const width = Number(vehicleConfig?.vehicleWidth) || 2.3;
  const wb = Number(vehicleConfig?.wheelBase) || 4.0;
  const fo = Number(vehicleConfig?.frontOverhang) || 1.0;
  const margin = Number(vehicleConfig?.widthMargin) || 0.3;
  const half = width / 2 + margin;
  const frontDist = wb + fo;
  const R = getRouteTrackingTurnRadius(vehicleConfig)
    || Number(vehicleConfig?.templateTurnRadius)
    || 6;
  const Router = Math.hypot(R + half, frontDist);
  const swing = Math.max(0, Router - R);
  const deflect = Math.max(0, Math.min(1, Number(deflectRad) / Math.PI));
  const radius = half + swing * (0.35 + 0.9 * deflect);
  return Math.max(half + 0.3, Math.min(R * 1.25 + half, radius));
}

/**
 * 経路の旋回ノードごとにコーナー補正キャップを生成する。
 * @returns {{ caps: object[], nodes: {lng,lat,radiusM,deflectionDeg}[], count: number }}
 *   caps  : turf Polygon（buildRoadUnion に渡して union する用）
 *   nodes : 描画・メトリクス用のノード情報
 */
export function buildIntersectionWidening(route = [], vehicleConfig = {}, {
  minDeflectionDeg = 22,
  maxNodes = 80,
  spanSteps = 3
} = {}) {
  if (!turf?.point || !turf?.buffer || !Array.isArray(route) || route.length < 3) {
    return { caps: [], nodes: [], count: 0 };
  }
  const minDeflect = (Number(minDeflectionDeg) || 0) * Math.PI / 180;
  const caps = [];
  const nodes = [];
  for (let i = 1; i < route.length - 1; i++) {
    const prev = route[Math.max(0, i - spanSteps)];
    const cur = route[i];
    const next = route[Math.min(route.length - 1, i + spanSteps)];
    const deflect = deflectionAngle(prev, cur, next);
    if (deflect < minDeflect) continue;
    if (!Number.isFinite(cur?.lng) || !Number.isFinite(cur?.lat)) continue;
    const radiusM = intersectionCapRadiusM(vehicleConfig, deflect);
    try {
      const cap = turf.buffer(turf.point([cur.lng, cur.lat]), radiusM, { units: 'meters', steps: 10 });
      if (cap) {
        caps.push(cap);
        nodes.push({
          lng: cur.lng,
          lat: cur.lat,
          radiusM: Number(radiusM.toFixed(2)),
          deflectionDeg: Number((deflect * 180 / Math.PI).toFixed(1))
        });
      }
    } catch (_err) { /* skip bad node */ }
    i += spanSteps + 1; // 同一交差点での重複キャップを避ける
    if (caps.length >= maxNodes) break;
  }
  return { caps, nodes, count: caps.length };
}

export default { buildIntersectionWidening, intersectionCapRadiusM };
