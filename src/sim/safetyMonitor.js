/**
 * Safety Monitor for L4SIM runtime playback.
 *
 * Keeps the monitor independent from the planner: callers provide the current
 * footprint, road surface, speed, and collision facts for each simulation tick.
 * On the first invariant violation, the caller can trigger MRM and persist the
 * trace JSONL returned by this monitor.
 */
import { createTrace } from './trace.js';

const DEFAULT_ROAD_OUTSIDE_RATIO = 0.08;
const DEFAULT_ROAD_OUTSIDE_AREA_M2 = 0.8;
const DEFAULT_SPEED_TOLERANCE_MS = 0.35;

function finite(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round(value, digits = 3) {
  const n = finite(value);
  if (n == null) return null;
  const m = 10 ** digits;
  return Math.round(n * m) / m;
}

function areaM2(turf, feature) {
  try {
    const v = turf?.area?.(feature);
    return Number.isFinite(Number(v)) ? Number(v) : null;
  } catch (_err) {
    return null;
  }
}

function roadOutsideMetrics(turf, footprint, roadSurface) {
  if (!turf || !footprint || !roadSurface) {
    return { checked: false, outsideRatio: null, outsideAreaM2: null };
  }
  const fpArea = areaM2(turf, footprint);
  if (!(fpArea > 0)) return { checked: false, outsideRatio: null, outsideAreaM2: null };

  try {
    if (typeof turf.booleanWithin === 'function' && turf.booleanWithin(footprint, roadSurface)) {
      return { checked: true, outsideRatio: 0, outsideAreaM2: 0 };
    }
  } catch (_err) {
    // Fall through to area-based check.
  }

  try {
    if (typeof turf.difference === 'function') {
      const outside = turf.difference(footprint, roadSurface);
      const outsideArea = outside ? (areaM2(turf, outside) || 0) : 0;
      return {
        checked: true,
        outsideRatio: fpArea > 0 ? outsideArea / fpArea : null,
        outsideAreaM2: outsideArea
      };
    }
  } catch (_err) {
    // Fall through to conservative boolean result.
  }

  return { checked: true, outsideRatio: 1, outsideAreaM2: fpArea };
}

export function evaluateSafetyInvariants({
  turf,
  footprint,
  roadSurface,
  speedMS,
  curveLimitMS,
  collision = false,
  forwardClearanceM = null,
  tolerances = {}
} = {}) {
  const roadOutside = roadOutsideMetrics(turf, footprint, roadSurface);
  const roadOutsideRatioLimit = finite(tolerances.roadOutsideRatio) ?? DEFAULT_ROAD_OUTSIDE_RATIO;
  const roadOutsideAreaLimit = finite(tolerances.roadOutsideAreaM2) ?? DEFAULT_ROAD_OUTSIDE_AREA_M2;
  const speedToleranceMS = finite(tolerances.speedToleranceMS) ?? DEFAULT_SPEED_TOLERANCE_MS;
  const roadSurfaceMode = String(tolerances.roadSurfaceMode || 'mrm');
  const violations = [];
  const warnings = [];

  if (
    roadOutside.checked
    && (Number(roadOutside.outsideRatio) > roadOutsideRatioLimit)
    && (Number(roadOutside.outsideAreaM2) > roadOutsideAreaLimit)
  ) {
    const excursion = {
      type: 'road_surface_excursion',
      severity: roadSurfaceMode === 'advisory' ? 'advisory' : 'mrm',
      outsideRatio: round(roadOutside.outsideRatio, 3),
      outsideAreaM2: round(roadOutside.outsideAreaM2, 2)
    };
    if (roadSurfaceMode === 'advisory') warnings.push(excursion);
    else violations.push(excursion);
  }

  if (collision) {
    violations.push({ type: 'clearance_contact', severity: 'mrm' });
  }

  const clearance = finite(forwardClearanceM);
  if (clearance != null && clearance <= 0) {
    violations.push({
      type: 'forward_clearance_non_positive',
      severity: 'mrm',
      forwardClearanceM: round(clearance, 2)
    });
  }

  const speed = finite(speedMS);
  const curveLimit = finite(curveLimitMS);
  if (speed != null && curveLimit != null && curveLimit >= 0 && speed > curveLimit + speedToleranceMS) {
    violations.push({
      type: 'curve_speed_limit_exceeded',
      severity: 'mrm',
      speedMS: round(speed, 3),
      curveLimitMS: round(curveLimit, 3)
    });
  }

  return {
    ok: violations.length === 0,
    violations,
    warnings,
    metrics: {
      roadChecked: roadOutside.checked,
      roadOutsideRatio: round(roadOutside.outsideRatio, 3),
      roadOutsideAreaM2: round(roadOutside.outsideAreaM2, 2)
    }
  };
}

// 持続的な大幅逸脱の既定閾値: advisory の道路逸脱でも「車体の半分以上かつ8m²超が
// この秒数連続で帯外」なら、幅推定の保守化ノイズではなく実質的なオフロード走行として
// 違反へ昇格させる。瞬間的な張り出し（K-turnスイング・コーナー掃引）は昇格しない。
const DEFAULT_ROAD_OUTSIDE_HARD_RATIO = 0.5;
const DEFAULT_ROAD_OUTSIDE_HARD_AREA_M2 = 8.0;
const DEFAULT_ROAD_OUTSIDE_HARD_SUSTAIN_S = 2.0;

export function createSafetyMonitor(meta = {}) {
  const trace = createTrace({
    monitor: 'l4sim-safety',
    version: 1,
    ...meta
  });
  let tick = 0;
  let firstViolation = null;
  let lastResult = null;
  let grossExcursionStartS = null;

  return {
    push(ctx = {}) {
      tick += 1;
      const result = evaluateSafetyInvariants(ctx);

      // advisoryモードの道路逸脱でも、大幅な帯外が持続する場合は違反へ昇格する。
      // roadSurface が渡らない tick（端点猶予など）は連続カウントをリセットする。
      const tol = ctx.tolerances || {};
      const hardRatio = finite(tol.roadOutsideHardRatio) ?? DEFAULT_ROAD_OUTSIDE_HARD_RATIO;
      const hardArea = finite(tol.roadOutsideHardAreaM2) ?? DEFAULT_ROAD_OUTSIDE_HARD_AREA_M2;
      const sustainS = finite(tol.roadOutsideHardSustainS) ?? DEFAULT_ROAD_OUTSIDE_HARD_SUSTAIN_S;
      const simTimeS = finite(ctx.simTimeS);
      const gross = result.metrics.roadChecked
        && Number(result.metrics.roadOutsideRatio) > hardRatio
        && Number(result.metrics.roadOutsideAreaM2) > hardArea;
      if (gross && simTimeS != null) {
        if (grossExcursionStartS == null) grossExcursionStartS = simTimeS;
        const heldS = simTimeS - grossExcursionStartS;
        if (heldS >= sustainS) {
          result.violations.push({
            type: 'road_surface_excursion_sustained',
            severity: 'mrm',
            outsideRatio: result.metrics.roadOutsideRatio,
            outsideAreaM2: result.metrics.roadOutsideAreaM2,
            heldS: round(heldS, 2)
          });
          result.ok = false;
        }
      } else {
        grossExcursionStartS = null;
      }
      const record = {
        tick,
        simTimeS: round(ctx.simTimeS, 3),
        progressM: round(ctx.progressM, 2),
        lat: round(ctx.lat, 7),
        lng: round(ctx.lng, 7),
        headingDeg: round(ctx.headingDeg, 2),
        speedMS: round(ctx.speedMS, 3),
        allowedMS: round(ctx.allowedMS, 3),
        curveLimitMS: round(ctx.curveLimitMS, 3),
        mode: ctx.mode || null,
        collision: ctx.collision ? 1 : 0,
        roadOutsideRatio: result.metrics.roadOutsideRatio,
        violationCount: result.violations.length,
        warningCount: result.warnings.length
      };
      trace.push(record);
      lastResult = { ...result, tick, record };
      if (!firstViolation && result.violations.length) {
        firstViolation = { tick, record, violations: result.violations };
      }
      return lastResult;
    },
    get tick() {
      return tick;
    },
    get firstViolation() {
      return firstViolation;
    },
    get lastResult() {
      return lastResult;
    },
    hash() {
      return trace.hash();
    },
    toJSONL() {
      return trace.toJSONL();
    },
    metrics() {
      return {
        tick,
        traceHash: trace.hash(),
        firstViolation,
        lastResult
      };
    }
  };
}
