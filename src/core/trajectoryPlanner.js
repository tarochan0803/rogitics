import { getRouteTrackingTurnRadius } from '../config.js';
import { coordinateSystem, d2r, turf } from '../utils/geo.js';
import { analyzeContactFeasibility } from './feasibility.js';
import { applyTurnTemplates, densifyRouteLL, pruneTinyLoops, removeRouteHooks } from './graph.js';

function routeLengthMeters(routeLL) {
  if (!Array.isArray(routeLL) || routeLL.length < 2) return 0;
  try {
    const line = turf.lineString(routeLL.map((p) => [p.lng, p.lat]));
    return turf.length(line, { units: 'meters' });
  } catch (e) {
    return 0;
  }
}

function maxDeviationMeters(candidate, base) {
  if (!Array.isArray(candidate) || candidate.length < 2) return 0;
  if (!Array.isArray(base) || base.length < 2) return 0;
  try {
    const line = turf.lineString(base.map((p) => [p.lng, p.lat]));
    let maxD = 0;
    const stride = Math.max(1, Math.floor(candidate.length / 120));
    for (let i = 0; i < candidate.length; i += stride) {
      const p = candidate[i];
      const d = turf.pointToLineDistance(turf.point([p.lng, p.lat]), line, { units: 'meters' });
      if (Number.isFinite(d) && d > maxD) maxD = d;
    }
    return maxD;
  } catch (e) {
    return 0;
  }
}

function estimateTightestTurnRadius(routeLL) {
  if (!Array.isArray(routeLL) || routeLL.length < 3) return null;
  coordinateSystem.setOrigin(routeLL[0].lat, routeLL[0].lng);
  let minRadius = Infinity;
  for (let i = 1; i < routeLL.length - 1; i++) {
    const a = routeLL[i - 1];
    const b = routeLL[i];
    const c = routeLL[i + 1];
    const am = coordinateSystem.latLngToMeters(a.lat, a.lng);
    const bm = coordinateSystem.latLngToMeters(b.lat, b.lng);
    const cm = coordinateSystem.latLngToMeters(c.lat, c.lng);
    const v1x = bm.x - am.x;
    const v1y = bm.y - am.y;
    const v2x = cm.x - bm.x;
    const v2y = cm.y - bm.y;
    const l1 = Math.hypot(v1x, v1y);
    const l2 = Math.hypot(v2x, v2y);
    if (l1 < 1 || l2 < 1) continue;
    const dot = (v1x * v2x + v1y * v2y) / (l1 * l2);
    const angle = Math.acos(Math.max(-1, Math.min(1, dot)));
    if (!Number.isFinite(angle) || angle < d2r(8)) continue;
    const r = Math.min(l1, l2) / Math.max(Math.tan(angle / 2), 1e-3);
    if (Number.isFinite(r) && r > 0) minRadius = Math.min(minRadius, r);
  }
  return Number.isFinite(minRadius) ? minRadius : null;
}

export function normalizeRouteForVehicle(routeLL, vehicleConfig) {
  if (!Array.isArray(routeLL) || routeLL.length < 2) return null;
  const Rmin = getRouteTrackingTurnRadius(vehicleConfig);
  const base = pruneTinyLoops(routeLL);
  const dehooked = removeRouteHooks(base, Math.max(25, Rmin * 2.2));
  const cleaned = pruneTinyLoops(dehooked, 0.9, 160);
  let shaped = cleaned;
  if (Rmin > 0 && cleaned.length > 2) {
    try {
      coordinateSystem.setOrigin(cleaned[0].lat, cleaned[0].lng);
      shaped = applyTurnTemplates(cleaned, Rmin);
    } catch (e) {
      shaped = cleaned;
    }
  }
  const dense = densifyRouteLL(shaped, 1.5);
  return dense && dense.length >= 2 ? dense : null;
}

function normalizeVec(x, y) {
  const len = Math.hypot(x, y);
  if (!(len > 1e-6)) return null;
  return { x: x / len, y: y / len };
}

function cosineBell(x, halfWidth) {
  if (!(halfWidth > 0)) return 0;
  const ax = Math.abs(x);
  if (ax >= halfWidth) return 0;
  return 0.5 * (1 + Math.cos(Math.PI * ax / halfWidth));
}

function leftNormal(x, y) {
  return { x: -y, y: x };
}

function rightNormal(x, y) {
  return { x: y, y: -x };
}

function findDominantTurn(routeLL) {
  if (!Array.isArray(routeLL) || routeLL.length < 3) return null;
  coordinateSystem.setOrigin(routeLL[0].lat, routeLL[0].lng);
  let best = null;
  for (let i = 1; i < routeLL.length - 1; i++) {
    const a = routeLL[i - 1];
    const b = routeLL[i];
    const c = routeLL[i + 1];
    const am = coordinateSystem.latLngToMeters(a.lat, a.lng);
    const bm = coordinateSystem.latLngToMeters(b.lat, b.lng);
    const cm = coordinateSystem.latLngToMeters(c.lat, c.lng);
    const v1x = bm.x - am.x;
    const v1y = bm.y - am.y;
    const v2x = cm.x - bm.x;
    const v2y = cm.y - bm.y;
    const l1 = Math.hypot(v1x, v1y);
    const l2 = Math.hypot(v2x, v2y);
    if (l1 < 3 || l2 < 3) continue;
    const dot = (v1x * v2x + v1y * v2y) / (l1 * l2);
    const angle = Math.acos(Math.max(-1, Math.min(1, dot)));
    if (!Number.isFinite(angle) || angle < d2r(15) || angle > d2r(170)) continue;
    const cross = v1x * v2y - v1y * v2x;
    if (Math.abs(cross) < 1e-6) continue;
    const n1 = cross > 0 ? leftNormal(v1x / l1, v1y / l1) : rightNormal(v1x / l1, v1y / l1);
    const n2 = cross > 0 ? leftNormal(v2x / l2, v2y / l2) : rightNormal(v2x / l2, v2y / l2);
    const inside = normalizeVec(n1.x + n2.x, n1.y + n2.y);
    if (!inside) continue;
    const score = angle * Math.min(l1, l2);
    if (!best || score > best.score) {
      best = { idx: i, inside, legM: Math.min(l1, l2), angle, score };
    }
  }
  return best;
}

function shiftRouteAroundTurn(routeLL, turn, shiftM) {
  if (!Array.isArray(routeLL) || routeLL.length < 3 || !turn || !(shiftM > 0)) return routeLL;
  coordinateSystem.setOrigin(routeLL[0].lat, routeLL[0].lng);
  const cum = [0];
  for (let i = 1; i < routeLL.length; i++) {
    const a = coordinateSystem.latLngToMeters(routeLL[i - 1].lat, routeLL[i - 1].lng);
    const b = coordinateSystem.latLngToMeters(routeLL[i].lat, routeLL[i].lng);
    cum[i] = cum[i - 1] + Math.hypot(b.x - a.x, b.y - a.y);
  }
  const centerS = cum[turn.idx];
  const halfWindow = Math.max(10, Math.min(26, turn.legM * 1.2));
  return routeLL.map((p, idx) => {
    if (idx === 0 || idx === routeLL.length - 1) return { ...p };
    const dist = Math.abs(cum[idx] - centerS);
    if (dist >= halfWindow) return { ...p };
    const weight = 0.5 * (1 + Math.cos(Math.PI * dist / halfWindow));
    const pm = coordinateSystem.latLngToMeters(p.lat, p.lng);
    const ll = coordinateSystem.metersToLatLng(
      pm.x - turn.inside.x * shiftM * weight,
      pm.y - turn.inside.y * shiftM * weight
    );
    return { lat: ll.lat, lng: ll.lng };
  });
}

function biasRouteAroundTurn(routeLL, turn, { setupM = 0, apexM = 0, exitM = 0 } = {}) {
  if (!Array.isArray(routeLL) || routeLL.length < 3 || !turn) return routeLL;
  coordinateSystem.setOrigin(routeLL[0].lat, routeLL[0].lng);
  const cum = [0];
  for (let i = 1; i < routeLL.length; i++) {
    const a = coordinateSystem.latLngToMeters(routeLL[i - 1].lat, routeLL[i - 1].lng);
    const b = coordinateSystem.latLngToMeters(routeLL[i].lat, routeLL[i].lng);
    cum[i] = cum[i - 1] + Math.hypot(b.x - a.x, b.y - a.y);
  }
  const centerS = cum[turn.idx];
  const setupHalf = Math.max(6, Math.min(18, turn.legM * 0.9));
  const apexHalf = Math.max(5, Math.min(14, turn.legM * 0.65));
  const exitHalf = Math.max(6, Math.min(18, turn.legM * 0.9));
  const setupCenter = -Math.max(5, Math.min(16, turn.legM * 0.75));
  const exitCenter = Math.max(5, Math.min(16, turn.legM * 0.7));

  return routeLL.map((p, idx) => {
    if (idx === 0 || idx === routeLL.length - 1) return { ...p };
    const rel = cum[idx] - centerS;
    const setupW = setupM > 0 ? cosineBell(rel - setupCenter, setupHalf) : 0;
    const apexW = apexM > 0 ? cosineBell(rel, apexHalf) : 0;
    const exitW = exitM > 0 ? cosineBell(rel - exitCenter, exitHalf) : 0;
    // 大型車の外振りパターン:
    //   setup（カーブ前）: 外側に膨らむ = -setupM（inside方向の逆）
    //   apex（頂点） : 内側に切り込む = +apexM（inside方向）
    //   exit（御 典）: 外側に戻る   = -exitM（inside方向の逆）
    const lateral = (-setupM * setupW) + (apexM * apexW) + (-exitM * exitW);
    if (Math.abs(lateral) < 1e-3) return { ...p };
    const pm = coordinateSystem.latLngToMeters(p.lat, p.lng);
    const ll = coordinateSystem.metersToLatLng(
      pm.x + turn.inside.x * lateral,
      pm.y + turn.inside.y * lateral
    );
    return { lat: ll.lat, lng: ll.lng };
  });
}

function measureInsideApexGain(routeLL, baseRoute, turn) {
  if (!Array.isArray(routeLL) || routeLL.length < 2) return 0;
  if (!Array.isArray(baseRoute) || baseRoute.length < 2) return 0;
  if (!turn?.inside) return 0;

  coordinateSystem.setOrigin(routeLL[0].lat, routeLL[0].lng);

  const projectSamples = (route) => {
    const cum = [0];
    for (let i = 1; i < route.length; i++) {
      const a = coordinateSystem.latLngToMeters(route[i - 1].lat, route[i - 1].lng);
      const b = coordinateSystem.latLngToMeters(route[i].lat, route[i].lng);
      cum[i] = cum[i - 1] + Math.hypot(b.x - a.x, b.y - a.y);
    }
    const total = cum[cum.length - 1];
    const centerS = total * (turn.idx / Math.max(1, route.length - 1));
    const halfWindow = Math.max(4, Math.min(12, turn.legM * 0.55));
    let gain = 0;
    let weightSum = 0;
    for (let i = 1; i < route.length - 1; i++) {
      const rel = cum[i] - centerS;
      const w = cosineBell(rel, halfWindow);
      if (!(w > 0)) continue;
      const pm = coordinateSystem.latLngToMeters(route[i].lat, route[i].lng);
      gain += (pm.x * turn.inside.x + pm.y * turn.inside.y) * w;
      weightSum += w;
    }
    return weightSum > 0 ? gain / weightSum : 0;
  };

  return projectSamples(routeLL) - projectSamples(baseRoute);
}

function evaluateTrajectory(routeLL, baseRoute, options) {
  if (!Array.isArray(routeLL) || routeLL.length < 2) return null;
  const lenM = routeLengthMeters(routeLL);
  let contact = null;
  try {
    if (Array.isArray(options.geoJsonDataSets) && options.geoJsonDataSets.length) {
      contact = analyzeContactFeasibility({
        simRoute: routeLL,
        vehicleConfig: options.vehicleConfig,
        geoJsonDataSets: options.geoJsonDataSets,
        defaultRoadWidth: options.defaultRoadWidth ?? 6,
        clearanceMargin: options.clearanceMargin ?? 0.15,
        widthMargin: options.widthMargin,
        maskEdits: options.maskEdits,
        strictWidthMode: !!options.strictWidthMode,
        strideMeters: 2.0,
        maxContactPoints: 80
      });
    }
  } catch (e) {
    contact = null;
  }

  const contactRatio = Number.isFinite(contact?.contactRatio) ? contact.contactRatio : 0.5;
  const contactCount = Number.isFinite(contact?.contactCount) ? contact.contactCount : 0;
  const requiredR = getRouteTrackingTurnRadius(options.vehicleConfig);
  const tightestR = estimateTightestTurnRadius(routeLL);
  const turnShortfall = (requiredR > 0 && Number.isFinite(tightestR)) ? Math.max(0, requiredR - tightestR) : 0;
  const deviationMeters = maxDeviationMeters(routeLL, baseRoute);
  const deviationPenalty = Math.max(0, deviationMeters - 0.4) * 18;
  // 大型車の外振り（大回り）を優先するスコアリング:
  // - 内側ボーナスが外側ボーナスに変わる: 外側を通る経路を高評価する
  const outsideGain = options.turn ? Math.max(0, -measureInsideApexGain(routeLL, baseRoute, options.turn)) : 0;
  const outsideBonus = Math.min(2.2, outsideGain) * 55;
  const score = (contactRatio * 420) + (turnShortfall * 70) + (lenM * 0.028) + deviationPenalty - outsideBonus;

  return {
    route: routeLL,
    score,
    lengthMeters: lenM,
    contactRatio,
    contactCount,
    tightestRadius: tightestR,
    deviationMeters,
    outsideGain
  };
}

export function buildTrajectoryPlanFromSelection(selectionRoute, options = {}) {
  if (!Array.isArray(selectionRoute) || selectionRoute.length < 2 || !options.vehicleConfig) return null;
  const selectedRoadRoute = selectionRoute.map((p) => ({ ...p }));
  const baseRoute = normalizeRouteForVehicle(selectedRoadRoute, options.vehicleConfig);
  if (!baseRoute || baseRoute.length < 2) return null;

  const candidates = [];
  const baseEval = evaluateTrajectory(baseRoute, baseRoute, options);
  if (baseEval) candidates.push(baseEval);

  const turn = findDominantTurn(selectedRoadRoute);
  if (turn) {
    const vehicleWidth = Number(options.vehicleConfig?.vehicleWidth) || 2.0;
    const widthMargin = Number(options.widthMargin ?? options.vehicleConfig?.widthMargin ?? 0.3) || 0.3;
    const clearance = Math.max(0.15, Number(options.clearanceMargin ?? 0.15) || 0.15);
    const roadHalfWidth = Math.max(
      2.6,
      (Number(options.defaultRoadWidth ?? 6) || 6) * 0.5
    );
    const usableShift = Math.max(0.8, roadHalfWidth - (vehicleWidth * 0.5 + widthMargin + clearance));
    // 大型車の外振り: 上限を広げて大回りルートを生成できるようにする
    const maxShift = Math.min(4.0, usableShift * 1.4);
    const candidateProfiles = [
      // 外振りなし（内切りのみ）
      { setupM: 0,              apexM: maxShift * 0.55, exitM: maxShift * 0.15 },
      // 軽い外振り→内切り
      { setupM: maxShift * 0.6, apexM: maxShift * 0.8,  exitM: maxShift * 0.2  },
      // 大きな外振り→しっかり内切り（大型車の典型的大回り）
      { setupM: maxShift * 1.0, apexM: maxShift,        exitM: maxShift * 0.3  },
      // 外振り最大
      { setupM: maxShift * 1.3, apexM: maxShift,        exitM: maxShift * 0.4  }
    ];
    const shifts = [...new Set([
      Number((maxShift * 0.3).toFixed(2)),
      Number((maxShift * 0.6).toFixed(2)),
      Number((maxShift * 0.9).toFixed(2)),
      Number(maxShift.toFixed(2))
    ])];
    for (const shift of shifts) {
      const shiftedSelection = shiftRouteAroundTurn(selectedRoadRoute, turn, shift);
      const candidateRoute = normalizeRouteForVehicle(shiftedSelection, options.vehicleConfig);
      if (!candidateRoute || candidateRoute.length < 2) continue;
      const evaluated = evaluateTrajectory(candidateRoute, baseRoute, { ...options, turn });
      if (evaluated) candidates.push(evaluated);
    }
    for (const profile of candidateProfiles) {
      const shapedSelection = biasRouteAroundTurn(selectedRoadRoute, turn, profile);
      const candidateRoute = normalizeRouteForVehicle(shapedSelection, options.vehicleConfig);
      if (!candidateRoute || candidateRoute.length < 2) continue;
      const evaluated = evaluateTrajectory(candidateRoute, baseRoute, { ...options, turn });
      if (evaluated) candidates.push(evaluated);
    }
  }

  const best = candidates.sort((a, b) => a.score - b.score)[0] || null;
  if (!best) return null;
  return {
    selectionRoute: selectedRoadRoute,
    trajectoryRoute: best.route,
    metrics: best,
    candidates
  };
}
