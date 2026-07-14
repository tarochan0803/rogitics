import { buildCollisionSolidSet, getVehicleEnvelope, getVehicleFootprintConfig } from '../../3d/clearanceSolids.js';
import { buildIntersectionWidening } from '../../core/intersectionWidening.js';
import { getRouteTrackingTurnRadius } from '../../config.js';
import { projectToNearestWay } from '../../core/graph.js';
import { fuseWidthForFeature } from '../../core/roadWidthModel.js';
import { getRiskTuning, autonomousSpeedFactor, curveSpeedLimitMS, narrowWidthSpeedFactor, roadGradeSpeedFactor, effectiveBrakeDecelMSS } from '../../core/vehicleRiskModel.js';
import { normA, turf } from '../../utils/geo.js';

const DEFAULT_SENSOR_RANGE_M = 34;
const DEFAULT_SAMPLE_SPACING_M = 3;
const DEFAULT_RAY_STEP_M = 1.5;
const DEFAULT_DECEL_MSS = 1.25;
const DEFAULT_REACTION_MARGIN_M = 2.0;

function clamp(value, lo, hi) {
  return Math.max(lo, Math.min(hi, value));
}

// ⑤ 旋回半径 R で横へ d ずらす S字（対向2円弧）の縦距離。
// 片側円弧の横変位 = R(1-cosφ)、縦距離 = R sinφ。対称2円弧で横=2R(1-cosφ)=d。
// → cosφ = 1 - d/(2R), 縦距離 = 2R sinφ。旋回半径が大きいほど滑らかな移行に長い距離が要る。
function sCurveLongitudinalM(lateralM, turnRadiusM, fallbackLenM = 6) {
  const d = Math.abs(Number(lateralM) || 0);
  const R = Number(turnRadiusM) || 0;
  if (!(d > 0)) return 0;
  if (!(R > 0)) return Math.max(fallbackLenM, d * 3);
  const phi = Math.acos(clamp(1 - d / (2 * R), -1, 1));
  return Math.max(2 * R * Math.sin(phi), d * 1.5);
}

// ⑤ recovery の側方オフセット候補・後退距離を車両寸法・最小旋回半径から導出する。
// 幅広車ほど横刻みは大きく/上限も少し広め、旋回半径が大きいほど移行距離=後退距離が伸びる。
function deriveRecoveryParams({ footprint, vehicleLength, minTurnRadiusM, override = {} }) {
  const width = Math.max(1.6, Number(footprint?.vehicleWidth) || 2.5);
  const step = clamp(width * 0.55, 0.7, 1.5);
  const maxLateralM = clamp(width * 1.05, 1.4, 3.2);
  const offsets = [];
  for (let k = 1; k * step <= maxLateralM + 1e-6; k += 1) {
    const v = round(k * step, 2);
    offsets.push(v, -v);
  }
  if (!offsets.length) offsets.push(round(maxLateralM, 2), -round(maxLateralM, 2));
  const base = {
    enabled: true,
    minReverseM: Math.max(1.5, vehicleLength * 0.25),
    maxReverseM: Math.max(6, vehicleLength * 1.2),
    maxLateralM,
    lateralOffsets: offsets,
    // 旋回半径が不明でも車長基準の下限で S字移行距離を見積もる
    turnRadiusM: Math.max(Number(minTurnRadiusM) || 0, vehicleLength * 1.5),
    vehicleLength
  };
  return { ...base, ...(override || {}) };
}

function round(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const m = 10 ** digits;
  return Math.round(n * m) / m;
}

function asRoutePoints(route) {
  if (!Array.isArray(route)) return [];
  return route
    .map((p) => ({ lat: Number(p?.lat), lng: Number(p?.lng) }))
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
}

function buildLine(route) {
  const pts = asRoutePoints(route);
  if (pts.length < 2 || typeof turf?.lineString !== 'function') return null;
  try {
    return turf.lineString(pts.map((p) => [p.lng, p.lat]));
  } catch (_err) {
    return null;
  }
}

function routeLengthM(line) {
  try {
    return (turf.length(line, { units: 'kilometers' }) || 0) * 1000;
  } catch (_err) {
    return 0;
  }
}

function alongM(line, sM) {
  try {
    return turf.along(line, Math.max(0, sM) / 1000, { units: 'kilometers' });
  } catch (_err) {
    return null;
  }
}

function bearingAt(line, sM, totalM) {
  try {
    const s0 = clamp(sM, 0, totalM);
    const s1 = clamp(s0 + 1.5, 0, totalM);
    const useBackSegment = (s1 - s0) < 0.5 && s0 > 0.5;
    const a = alongM(line, useBackSegment ? clamp(s0 - 1.5, 0, totalM) : s0);
    const b = alongM(line, useBackSegment ? s0 : s1);
    if (!a || !b) return 0;
    return turf.bearing(a, b);
  } catch (_err) {
    return 0;
  }
}

function turnAngleAhead(line, sM, totalM, lookAheadM = 9) {
  const b0 = bearingAt(line, sM, totalM) * Math.PI / 180;
  const b1 = bearingAt(line, clamp(sM + lookAheadM, 0, totalM), totalM) * Math.PI / 180;
  return Math.abs(normA(b1 - b0));
}

function mergeMaskEdits(maskEdits = {}, extraMaskDeny = []) {
  return {
    allow: Array.isArray(maskEdits.allow) ? maskEdits.allow : [],
    deny: [
      ...(Array.isArray(maskEdits.deny) ? maskEdits.deny : []),
      ...(Array.isArray(extraMaskDeny) ? extraMaskDeny : [])
    ]
  };
}

function solidBlocksVehicle(solid, envelope) {
  if (!solid?.feature?.geometry) return false;
  if (solid.role === 'overhead') {
    if (solid.clearanceReliable === false) return false;
    const h = Number(solid.heightM);
    return Number.isFinite(h) ? h < envelope.requiredHeightM : true;
  }
  return true;
}

function buildBlockers({ buildings, maskEdits, envelope }) {
  const solidSet = buildCollisionSolidSet({ buildings, maskEdits });
  return ([...(solidSet.obstacleSolids || []), ...(solidSet.overheadSolids || [])])
    .filter((solid) => solidBlocksVehicle(solid, envelope))
    .map((solid) => ({
      id: solid.id,
      role: solid.role,
      label: solid.label,
      heightM: Number.isFinite(Number(solid.heightM)) ? Number(solid.heightM) : null,
      heightSource: solid.heightSource || null,
      clearanceReliable: solid.clearanceReliable !== false,
      feature: solid.feature
    }));
}

function blockerIntersectsProbe(blocker, probe) {
  if (!blocker?.feature || !probe || typeof turf?.booleanIntersects !== 'function') return false;
  try {
    return turf.booleanIntersects(probe, blocker.feature);
  } catch (_err) {
    return false;
  }
}

function findFirstBlock({ line, totalM, sM, blockers, probeRadiusM, sensorRangeM, rayStepM }) {
  if (!line || !blockers.length || typeof turf?.buffer !== 'function') return null;
  const maxD = Math.min(sensorRangeM, Math.max(0, totalM - sM));
  for (let d = 0; d <= maxD + 1e-6; d += rayStepM) {
    const p = alongM(line, sM + d);
    if (!p) continue;
    let probe = null;
    try {
      probe = turf.buffer(p, probeRadiusM, { units: 'meters', steps: 4 });
    } catch (_err) {
      probe = null;
    }
    if (!probe) continue;
    for (const blocker of blockers) {
      if (blockerIntersectsProbe(blocker, probe)) {
        return {
          distanceM: round(d, 2),
          blockerId: blocker.id,
          blockerRole: blocker.role,
          blockerLabel: blocker.label,
          blockerHeightM: blocker.heightM
        };
      }
    }
  }
  return null;
}

// Phase 7: 側方オフセット点が blocker を避けられるか（切り返しで横へ逃げられるか）を判定
function lateralOffsetClears({ line, totalM, blockStationM, headingDeg, offsetM, blocker, probeRadiusM }) {
  if (!line || !blocker?.feature || typeof turf?.destination !== 'function' || typeof turf?.buffer !== 'function') {
    return false;
  }
  try {
    const base = alongM(line, clamp(blockStationM, 0, totalM));
    if (!base) return false;
    const perpBearing = headingDeg + (offsetM >= 0 ? 90 : -90);
    const offPoint = turf.destination(base, Math.abs(offsetM) / 1000, perpBearing, { units: 'kilometers' });
    const probe = turf.buffer(offPoint, probeRadiusM, { units: 'meters', steps: 4 });
    if (!probe) return false;
    return !turf.booleanIntersects(probe, blocker.feature);
  } catch (_err) {
    return false;
  }
}

// Phase 7: STOP を起こした blocker に対し、後退 + 側方切り返しで回避できるか試す。
// 頭上障害物（高さ不足）は後退しても通れないため復旧不可。
function evaluateRecovery({ line, totalM, stopSample, blocker, vehicleLength, probeRadiusM, params }) {
  if (!blocker) return { resolved: false, reason: 'no-blocker' };
  if (blocker.role === 'overhead') {
    return { resolved: false, reason: 'overhead-clearance', reverseUsed: false };
  }
  const blockStationM = clamp(
    Number(stopSample.sM) + (Number(stopSample.forwardClearanceM) || 0),
    0,
    totalM
  );
  const headingDeg = bearingAt(line, blockStationM, totalM);
  for (const offsetM of params.lateralOffsets) {
    if (Math.abs(offsetM) > params.maxLateralM + 1e-6) continue;
    if (lateralOffsetClears({ line, totalM, blockStationM, headingDeg, offsetM, blocker, probeRadiusM })) {
      // ⑤ S字移行距離を旋回半径から算出し、後退距離をそれに連動させる（幾何的に滑らかな回避）。
      const transitionLenM = sCurveLongitudinalM(offsetM, params.turnRadiusM, vehicleLength);
      const reverseDistM = clamp(transitionLenM * 0.5, params.minReverseM, params.maxReverseM);
      return {
        resolved: true,
        reverseUsed: true,
        reverseDistM: round(reverseDistM, 2),
        transitionLenM: round(transitionLenM, 2),
        lateralOffsetM: round(offsetM, 2),
        blockerId: blocker.id,
        blockerRole: blocker.role,
        sM: stopSample.sM
      };
    }
  }
  return { resolved: false, reason: 'no-lateral-bypass', reverseUsed: false, blockerId: blocker.id, sM: stopSample.sM };
}

// 連続する STOP サンプルを1つの「行き詰まりゾーン」にまとめ、各ゾーンで復旧を試みる。
function planRecoveries({ line, totalM, samples, blockers, vehicleLength, probeRadiusM, params }) {
  const blockerById = new Map(blockers.map((b) => [b.id, b]));
  const events = [];
  let reverseCount = 0;
  let replanCount = 0;
  let recoveredStopCount = 0;
  let unresolvedStopCount = 0;

  let i = 0;
  while (i < samples.length) {
    if (samples[i].mode !== 'STOP') { i += 1; continue; }
    // ゾーンの先頭 STOP サンプル
    const zoneStart = samples[i];
    let j = i;
    while (j < samples.length && samples[j].mode === 'STOP') j += 1;
    const blocker = zoneStart.blockerId ? blockerById.get(zoneStart.blockerId) : null;
    replanCount += 1; // 行き詰まりごとに再計画を1回試行
    const rec = evaluateRecovery({ line, totalM, stopSample: zoneStart, blocker, vehicleLength, probeRadiusM, params });
    if (rec.resolved) {
      recoveredStopCount += 1;
      if (rec.reverseUsed) reverseCount += 1;
    } else {
      unresolvedStopCount += 1;
    }
    events.push({
      sM: zoneStart.sM,
      blockerId: rec.blockerId || zoneStart.blockerId || null,
      blockerRole: rec.blockerRole || zoneStart.blockerRole || null,
      resolved: rec.resolved,
      reason: rec.reason || null,
      reverseDistM: rec.reverseDistM ?? null,
      transitionLenM: rec.transitionLenM ?? null,
      lateralOffsetM: rec.lateralOffsetM ?? null
    });
    i = j;
  }

  return {
    reverseCount,
    replanCount,
    recoveredStopCount,
    unresolvedStopCount,
    recoveryStatus: unresolvedStopCount > 0 ? 'UNRESOLVED' : (recoveredStopCount > 0 ? 'RESOLVED' : 'NONE'),
    recoveryEvents: events.slice(0, 40)
  };
}

function classifySample({
  cruiseMS,
  curveLimitMS,
  obstacleLimitMS,
  confidenceFactor = 1,
  gradeFactor = 1,
  narrowFactor = 1,
  firstBlock,
  steeringRatio,
  turnRadiusDeficitM = 0
}) {
  const baseAllowedMS = Math.max(0, Math.min(cruiseMS, curveLimitMS, obstacleLimitMS));
  // narrowFactor は 0（進入不可=STOP）を許すため 0.05 クランプしない
  const allowedMS = baseAllowedMS
    * clamp(Number(confidenceFactor) || 1, 0.05, 1)
    * clamp(Number(gradeFactor) || 1, 0.05, 1)
    * clamp(Number.isFinite(Number(narrowFactor)) ? Number(narrowFactor) : 1, 0, 1);
  if (allowedMS <= 0.05) return { mode: 'STOP', allowedMS };
  if (firstBlock && obstacleLimitMS < cruiseMS * 0.72) return { mode: 'YIELD', allowedMS };
  if (turnRadiusDeficitM > 0 || steeringRatio >= 0.95) return { mode: 'SATURATED', allowedMS };
  if (allowedMS < cruiseMS * 0.92) return { mode: 'SLOW', allowedMS };
  return { mode: 'CRUISE', allowedMS };
}

export function buildAutonomyDriveReport({
  route = [],
  roads = [],
  buildings = [],
  maskEdits = {},
  extraMaskDeny = [],
  vehicleConfig = {},
  cargoLoadType = 'none',
  cargoCount = 1,
  cruiseSpeedKmh = 18,
  sensorRangeM = DEFAULT_SENSOR_RANGE_M,
  sampleSpacingM = DEFAULT_SAMPLE_SPACING_M,
  rayStepM = DEFAULT_RAY_STEP_M,
  decelMSS = DEFAULT_DECEL_MSS,
  recovery = {}
} = {}) {
  const line = buildLine(route);
  const totalM = line ? routeLengthM(line) : 0;
  const roadArr = Array.isArray(roads) ? roads : [];
  const cruiseMS = Math.max(0.6, (Number(cruiseSpeedKmh) || 18) / 3.6);
  const envelope = getVehicleEnvelope(
    { vehicleConfig, cargoLoadType, cargoCount },
    { clearanceMargin: 0.25 }
  );
  const mergedMaskEdits = mergeMaskEdits(maskEdits, extraMaskDeny);
  const blockers = buildBlockers({
    buildings,
    maskEdits: mergedMaskEdits,
    envelope
  });

  if (!line || !(totalM > 0)) {
    return {
      summary: {
        status: 'NO_ROUTE',
        routeLengthM: 0,
        sampleCount: 0,
        sensorRangeM,
        blockerCount: blockers.length,
        minForwardClearanceM: null,
        stopEventCount: 0,
        slowEventCount: 0,
        steeringSaturationCount: 0,
        steeringSaturationRatio: 0,
        minAllowedSpeedKmh: 0,
        maxAllowedSpeedKmh: 0,
        firstStopDistanceM: null,
        firstBlockerId: null,
        blockingSolidIds: [],
        reverseCount: 0,
        replanCount: 0,
        recoveredStopCount: 0,
        unresolvedStopCount: 0,
        recoveryStatus: 'NONE'
      },
      samples: [],
      blockers,
      recoveryEvents: []
    };
  }

  const footprint = getVehicleFootprintConfig(vehicleConfig);
  const vehicleLength = Math.max(4, footprint.totalLengthM);
  // 交差点隅切りキャップ: 道路面(roadUnion)には既に足し込まれているが、幅ゲートは
  // 道路スカラー幅しか見ておらず「面では通れる旋回」をSTOP/K-turn推奨していた（教師
  // データFN分析で判明）。キャップ圏内のサンプルは、道路面と同じ円キャップの断面幅
  // （ノード距離dに対する 2*sqrt(r^2-d^2)）で静的な収まりだけを評価する。
  const wideningNodes = (buildIntersectionWidening(route, vehicleConfig)?.nodes) || [];
  const intersectionContextAt = (lat, lng) => {
    let best = null;
    for (const n of wideningNodes) {
      const radiusM = Number(n.radiusM) || 0;
      if (!(radiusM > 0)) continue;
      const dlat = (lat - n.lat) * 111320;
      const dlng = (lng - n.lng) * 111320 * Math.cos(lat * Math.PI / 180);
      const d = Math.hypot(dlat, dlng);
      const relaxRadiusM = radiusM + vehicleLength * 0.45;
      if (d > relaxRadiusM) continue;
      if (!best || d < best.distanceM) {
        best = {
          radiusM,
          distanceM: d,
          deflectionDeg: Number(n.deflectionDeg) || null
        };
      }
    }
    return best;
  };
  const capWidthAt = (lat, lng, baseWidthM) => {
    const base = Number(baseWidthM);
    let width = Number.isFinite(base) ? base : null;
    for (const n of wideningNodes) {
      const radiusM = Number(n.radiusM) || 0;
      if (!(radiusM > 0)) continue;
      const dlat = (lat - n.lat) * 111320;
      const dlng = (lng - n.lng) * 111320 * Math.cos(lat * Math.PI / 180);
      const d = Math.hypot(dlat, dlng);
      if (d > radiusM) continue;
      const chordHalfM = Math.sqrt(Math.max(0, radiusM * radiusM - d * d));
      const capWidthM = chordHalfM * 2;
      width = width == null ? capWidthM : Math.max(width, capWidthM);
    }
    return width;
  };
  const vehicleMinTurnRadiusM = Math.max(0, Number(getRouteTrackingTurnRadius(vehicleConfig)) || 0);
  const maxSteerDeg = Math.max(12, Number(vehicleConfig?.maxSteeringAngle) || 38);
  const safeStopM = Math.max(5, vehicleLength * 0.72 + DEFAULT_REACTION_MARGIN_M);
  const probeRadiusM = footprint.lateralProbeRadiusM;
  // ⑤ recovery パラメータを車両寸法・最小旋回半径から導出（caller の recovery で上書き可）。
  const recoveryParams = deriveRecoveryParams({
    footprint,
    vehicleLength,
    minTurnRadiusM: vehicleMinTurnRadiusM,
    override: recovery
  });
  const spacing = Math.max(1, Number(sampleSpacingM) || DEFAULT_SAMPLE_SPACING_M);
  const step = Math.max(0.8, Number(rayStepM) || DEFAULT_RAY_STEP_M);
  const samples = [];

  for (let sM = 0; sM <= totalM + 0.01; sM += spacing) {
    const s = Math.min(sM, totalM);
    const point = alongM(line, s);
    if (!point) continue;
    const coords = point.geometry?.coordinates || [0, 0];
    const nearestRoad = roadArr.length
      ? projectToNearestWay({ lat: coords[1], lng: coords[0] }, roadArr)
      : null;
    const fusedWidth = nearestRoad?.feature && Number.isFinite(nearestRoad.dist) && nearestRoad.dist <= 16
      ? fuseWidthForFeature(nearestRoad.feature)
      : null;
    const roadConfidence = fusedWidth ? (Number(fusedWidth.confidence) || 0) : 1;
    const confidenceFactor = autonomousSpeedFactor(roadConfidence);
    // ワールドコンパイラ焼き込みの勾配（demGradeMedianPct/MaxPct）→ 減速係数。
    // 勾配情報の無い道路（オンライン取得等）は 1.0 で従来挙動のまま。
    const grade = nearestRoad?.feature ? roadGradeSpeedFactor(nearestRoad.feature) : { factor: 1, gradePct: null };
    // 縦方向動力学: 停止距離計算を physics.js と同じ真実源（effectiveBrakeDecelMSS）へ統一する。
    // コンパイル済みワールドの demGradeMedianPct は絶対値（進行方向の上り/下り情報を持たない）で
    // 焼き込まれるため、制動側は最悪ケース＝下り(負符号)として渡し、停止距離を保守的に見積もる。
    // 勾配情報の無い道路（オンライン取得等）は 0=平坦。路面は vehicleConfig.surfaceCondition。
    const brakeGradePct = grade.gradePct != null ? -Math.abs(grade.gradePct) : 0;
    const brakeDecelMSS = effectiveBrakeDecelMSS({
      gradePct: brakeGradePct,
      vehicleConfig
    });
    const headingDeg = bearingAt(line, s, totalM);
    const lookAheadM = Math.max(7, vehicleLength);
    const turnRad = turnAngleAhead(line, s, totalM, lookAheadM);
    const absTurnRad = Math.abs(turnRad);
    const turnDeg = Math.abs(turnRad * 180 / Math.PI);
    const pathRadiusM = absTurnRad > 1e-3 ? lookAheadM / absTurnRad : Infinity;
    const intersectionCtx = intersectionContextAt(coords[1], coords[0]);
    const effectivePathRadiusM = intersectionCtx && Number.isFinite(pathRadiusM)
      ? Math.max(
        pathRadiusM,
        vehicleMinTurnRadiusM || 0,
        Number(intersectionCtx.radiusM) || 0
      )
      : pathRadiusM;
    const steeringRatioRaw = clamp(turnDeg / Math.max(8, maxSteerDeg * 0.75), 0, 1.35);
    const steeringRatio = intersectionCtx ? Math.min(steeringRatioRaw, 0.88) : steeringRatioRaw;
    const turnRadiusDeficitM = Number.isFinite(pathRadiusM) && vehicleMinTurnRadiusM > 0
      ? Math.max(0, vehicleMinTurnRadiusM - effectivePathRadiusM)
      : 0;
    const curveLimitMS = curveSpeedLimitMS({ turnRadiusM: effectivePathRadiusM, baseSpeedMS: cruiseMS });
    // 狭幅ゲート（曲率連動）: カーブでは車体が旋回スイング（外輪差・オーバーハングの
    // 振り出し）ぶん道路幅を余計に使う。swing ≈ Lf²/(2R)（Lf=ホイールベース+前オーバーハング）
    // を RISK_TUNING の係数で実効車幅へ加算し、有効幅との余裕で 徐行/進入不可(STOP) に落とす。
    // 直線(R=∞)はswing=0で従来どおり。これが無いと大型車が狭幅カーブで
    // Safety Monitor の道路逸脱違反になる（シナリオ行列で実測済み）。
    const swingLenM = (Number(footprint.wheelBase) || 4) + (Number(footprint.frontOverhang) || 1);
    const narrowTuning = getRiskTuning().narrowWidth || {};
    const curveSwingMaxM = Number.isFinite(Number(narrowTuning.curveSwingMaxM))
      ? Math.max(0, Number(narrowTuning.curveSwingMaxM))
      : 3;
    const curveSwingWidthMultiplierMin = Number.isFinite(Number(narrowTuning.curveSwingWidthMultiplier))
      ? Math.max(0, Number(narrowTuning.curveSwingWidthMultiplier))
      : 1;
    const curveSwingWidthMultiplierMax = Number.isFinite(Number(narrowTuning.curveSwingWidthMultiplierMax))
      ? Math.max(curveSwingWidthMultiplierMin, Number(narrowTuning.curveSwingWidthMultiplierMax))
      : curveSwingWidthMultiplierMin;
    const curveSwingMultiplierMinLfM = Number.isFinite(Number(narrowTuning.curveSwingMultiplierMinLfM))
      ? Number(narrowTuning.curveSwingMultiplierMinLfM)
      : 4;
    const curveSwingMultiplierMaxLfM = Number.isFinite(Number(narrowTuning.curveSwingMultiplierMaxLfM))
      ? Math.max(curveSwingMultiplierMinLfM + 0.1, Number(narrowTuning.curveSwingMultiplierMaxLfM))
      : 8;
    const swingVehicleT = clamp(
      (swingLenM - curveSwingMultiplierMinLfM) / Math.max(1e-6, curveSwingMultiplierMaxLfM - curveSwingMultiplierMinLfM),
      0,
      1
    );
    const curveSwingWidthMultiplier = curveSwingWidthMultiplierMin
      + (curveSwingWidthMultiplierMax - curveSwingWidthMultiplierMin) * swingVehicleT;
    const curveSwingM = Number.isFinite(effectivePathRadiusM) && effectivePathRadiusM > 0.5
      ? Math.min(curveSwingMaxM, (swingLenM * swingLenM) / (2 * effectivePathRadiusM))
      : 0;
    const effVehicleWidthM = footprint.vehicleWidth + curveSwingWidthMultiplier * curveSwingM;
    const widthWithCapM = capWidthAt(coords[1], coords[0], fusedWidth?.value);
    // 交差点隅切りキャップは「静的に道幅へ収まるか」(staticNarrow)だけに効かせる。
    // swingゲート(dynamicNarrow)には効かせない — swingはコーナーで車体角が実際に掃引する量で、
    // キャップ幅で水増しすると切り返し推奨を抑制し Safety Monitor の道路逸脱violationになる
    // （(26)の cap-aware で matrix が FAIL 0→4 に退行した原因。swingは真の幅で守る）。
    const dynamicNarrow = narrowWidthSpeedFactor(fusedWidth?.value, effVehicleWidthM);
    const staticNarrow = narrowWidthSpeedFactor(widthWithCapM, footprint.vehicleWidth);
    const swingExceeded = dynamicNarrow.factor <= 0 && staticNarrow.factor > 0 && curveSwingM > 0;
    // ソフト徐行の適格条件（行列実測で調整）:
    //  - 急折れ(≥45°)はK-turn切り返しで解決できる → 接近徐行して切り返しに任せる
    //  - スイング不足が僅か(-0.4m以内)の緩カーブ → 徐行で通す
    //  - それ以外（10tの狭幅カーブ等、切り返しでも幾何的に不足） → 従来どおり進入不可STOP
    //    （徐行で進入させると Safety Monitor の道路逸脱violationになる=10t実測6件の退行）
    const swingDeficitM = Number(dynamicNarrow.marginM);
    const softStopEligible = swingExceeded
      && (turnDeg >= 45 || (Number.isFinite(swingDeficitM) && swingDeficitM >= -0.4));
    const swingSoftStop = softStopEligible;
    const narrow = swingSoftStop
      ? {
        ...dynamicNarrow,
        factor: Math.max(
          Number(narrowTuning.curveSwingSoftCrawlFactor) || 0.18,
          Math.min(staticNarrow.factor, 0.35)
        ),
        swingSoftStop: true,
        staticMarginM: staticNarrow.marginM
      }
      : {
        ...dynamicNarrow,
        swingSoftStop: false,
        staticMarginM: staticNarrow.marginM
      };
    const switchbackTurnDeg = Number.isFinite(Number(narrowTuning.switchbackTurnDeg))
      ? Math.max(0, Number(narrowTuning.switchbackTurnDeg))
      : 25;
    // K-turn推奨: ①スイング超過の急折れ ②急折れ60°+で狭幅の懸念が少しでもある
    //（②が無いと「徐行なら通れる」判定の僅差コーナーで実掃引が帯を割る: i-6267実測）
    const switchbackRecommended = (!!narrow.swingSoftStop && turnDeg >= switchbackTurnDeg)
      || (turnDeg >= 50 && narrow.factor < 1 && staticNarrow.factor > 0);
    const firstBlock = findFirstBlock({
      line,
      totalM,
      sM: s,
      blockers,
      probeRadiusM,
      sensorRangeM,
      rayStepM: step
    });

    let obstacleLimitMS = cruiseMS;
    if (firstBlock) {
      const stopClearanceM = Number(firstBlock.distanceM) - safeStopM;
      // decelMSS 引数（後方互換で受ける）ではなく、勾配・路面連動の brakeDecelMSS で停止距離を評価。
      // 制動能力ゼロのときは停止距離を捏造せず、その障害物へ進入しない STOP とする。
      obstacleLimitMS = brakeDecelMSS <= 0 || stopClearanceM <= 0
        ? 0
        : Math.min(cruiseMS, Math.sqrt(Math.max(0, 2 * brakeDecelMSS * stopClearanceM)));
    }

    const classified = classifySample({
      cruiseMS,
      curveLimitMS,
      obstacleLimitMS,
      confidenceFactor,
      gradeFactor: grade.factor,
      narrowFactor: narrow.factor,
      firstBlock,
      steeringRatio,
      turnRadiusDeficitM
    });

    samples.push({
      sM: round(s, 1),
      lat: round(coords[1], 7),
      lng: round(coords[0], 7),
      headingDeg: round(headingDeg, 1),
      mode: classified.mode,
      allowedSpeedMS: round(classified.allowedMS, 3),
      allowedSpeedKmh: round(classified.allowedMS * 3.6, 1),
      cruiseSpeedMS: round(cruiseMS, 3),
      roadConfidence: round(roadConfidence, 3),
      confidenceSpeedFactor: round(confidenceFactor, 3),
      gradePct: grade.gradePct != null ? round(grade.gradePct, 2) : null,
      brakeGradePct: round(brakeGradePct, 2),
      gradeSpeedFactor: round(grade.factor, 3),
      brakeDecelMSS: round(brakeDecelMSS, 2),
      widthMarginM: narrow.marginM != null ? round(narrow.marginM, 2) : null,
      staticWidthMarginM: narrow.staticMarginM != null ? round(narrow.staticMarginM, 2) : null,
      // 切り返し推奨: スイング超過（=そのまま曲がると帯を割る）かつ急な折れ。
      // 徐行で突っ込んでも掃引幅は縮まないため、再生側はK-turn（後退で角度変更）で通す。
      switchbackRecommended,
      narrowSpeedFactor: round(narrow.factor, 3),
      swingSoftStop: !!narrow.swingSoftStop,
      curveSwingM: round(curveSwingM, 2),
      curveSwingWidthMultiplier: round(curveSwingWidthMultiplier, 2),
      forwardClearanceM: firstBlock ? firstBlock.distanceM : null,
      blockerId: firstBlock?.blockerId || null,
      blockerRole: firstBlock?.blockerRole || null,
      blockerLabel: firstBlock?.blockerLabel || null,
      blockerHeightM: firstBlock?.blockerHeightM ?? null,
      turnDeg: round(turnDeg, 1),
      pathRadiusM: Number.isFinite(pathRadiusM) ? round(pathRadiusM, 1) : null,
      effectivePathRadiusM: Number.isFinite(effectivePathRadiusM) ? round(effectivePathRadiusM, 1) : null,
      vehicleMinTurnRadiusM: vehicleMinTurnRadiusM > 0 ? round(vehicleMinTurnRadiusM, 1) : null,
      turnRadiusDeficitM: round(turnRadiusDeficitM, 2),
      curveLimitKmh: round(curveLimitMS * 3.6, 1),
      steeringRatio: round(steeringRatio, 3),
      steeringRatioRaw: round(steeringRatioRaw, 3),
      intersectionRelaxed: !!intersectionCtx,
      intersectionCapRadiusM: intersectionCtx ? round(intersectionCtx.radiusM, 2) : null,
      intersectionCapDistanceM: intersectionCtx ? round(intersectionCtx.distanceM, 2) : null
    });
  }

  const blockingSolidIds = [...new Set(samples.map((s) => s.blockerId).filter(Boolean))];
  const stopSamples = samples.filter((s) => s.mode === 'STOP');
  const slowSamples = samples.filter((s) => s.mode === 'SLOW' || s.mode === 'YIELD' || s.mode === 'SATURATED');
  const satSamples = samples.filter((s) => Number(s.turnRadiusDeficitM) > 0 || Number(s.steeringRatio) >= 0.95);
  const clearanceValues = samples
    .filter((s) => s.forwardClearanceM != null)
    .map((s) => Number(s.forwardClearanceM))
    .filter(Number.isFinite);
  const allowedValues = samples.map((s) => Number(s.allowedSpeedKmh)).filter(Number.isFinite);
  const pathRadiusValues = samples
    .map((s) => Number(s.pathRadiusM))
    .filter(Number.isFinite);
  const turnDeficitValues = samples
    .map((s) => Number(s.turnRadiusDeficitM))
    .filter((v) => Number.isFinite(v) && v > 0);
  const minForwardClearanceM = clearanceValues.length ? Math.min(...clearanceValues) : null;
  const minAllowedSpeedKmh = allowedValues.length ? Math.min(...allowedValues) : cruiseMS * 3.6;
  const maxAllowedSpeedKmh = allowedValues.length ? Math.max(...allowedValues) : cruiseMS * 3.6;
  const minPathRadiusM = pathRadiusValues.length ? Math.min(...pathRadiusValues) : null;
  const maxTurnRadiusDeficitM = turnDeficitValues.length ? Math.max(...turnDeficitValues) : 0;
  const status = stopSamples.length
    ? 'STOP'
    : (slowSamples.length ? 'SLOW' : 'CRUISE');

  // Phase 7: STOP ゾーンに対する後退 + 切り返しの復旧計画（reverseCount を実値化）
  const recoveryReport = recoveryParams.enabled
    ? planRecoveries({ line, totalM, samples, blockers, vehicleLength, probeRadiusM, params: recoveryParams })
    : { reverseCount: 0, replanCount: 0, recoveredStopCount: 0, unresolvedStopCount: 0, recoveryStatus: 'NONE', recoveryEvents: [] };

  return {
    summary: {
      status,
      routeLengthM: round(totalM, 1),
      sampleCount: samples.length,
      sensorRangeM: round(sensorRangeM, 1),
      blockerCount: blockers.length,
      minForwardClearanceM: minForwardClearanceM == null ? null : round(minForwardClearanceM, 1),
      stopEventCount: stopSamples.length,
      slowEventCount: slowSamples.length,
      steeringSaturationCount: satSamples.length,
      steeringSaturationRatio: samples.length ? round(satSamples.length / samples.length, 3) : 0,
      vehicleMinTurnRadiusM: vehicleMinTurnRadiusM > 0 ? round(vehicleMinTurnRadiusM, 1) : null,
      minPathRadiusM: minPathRadiusM == null ? null : round(minPathRadiusM, 1),
      maxTurnRadiusDeficitM: round(maxTurnRadiusDeficitM, 2),
      minAllowedSpeedKmh: round(minAllowedSpeedKmh, 1),
      maxAllowedSpeedKmh: round(maxAllowedSpeedKmh, 1),
      firstStopDistanceM: stopSamples[0]?.sM ?? null,
      firstBlockerId: blockingSolidIds[0] || null,
      blockingSolidIds,
      reverseCount: recoveryReport.reverseCount,
      replanCount: recoveryReport.replanCount,
      recoveredStopCount: recoveryReport.recoveredStopCount,
      unresolvedStopCount: recoveryReport.unresolvedStopCount,
      recoveryStatus: recoveryReport.recoveryStatus
    },
    samples,
    blockers,
    envelope,
    recoveryEvents: recoveryReport.recoveryEvents
  };
}
