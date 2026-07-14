import { d2r, normA } from '../utils/geo.js';
import { getVehicleFootprintConfig } from '../3d/clearanceSolids.js';
import { curveSpeedLimitMS, effectiveBrakeDecelMSS, effectiveAccelMSS } from './vehicleRiskModel.js';

function getInitialHeading(pathM) {
  if (!pathM || pathM.length < 2) return 0;
  // v7.7 fix: Look significantly further (12m) to ignore initial noise
  const p0 = pathM[0];
  let lookIdx = 1;
  const scanDist = 12.0;
  while (lookIdx < pathM.length - 1) {
    const d = Math.hypot(pathM[lookIdx].x - p0.x, pathM[lookIdx].y - p0.y);
    if (d > scanDist) break;
    lookIdx++;
  }
  return Math.atan2(pathM[lookIdx].y - p0.y, pathM[lookIdx].x - p0.x);
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function hasOperationalMass(config) {
  return [config?.actualGrossWeightT, config?.grossWeight, config?.vehicleWeight, config?.weight]
    .map(Number)
    .some((weight) => Number.isFinite(weight) && weight > 0);
}

function buildPathData(pathM) {
  const segments = [];
  let totalLength = 0;
  for (let i = 0; i < pathM.length - 1; i++) {
    const a = pathM[i];
    const b = pathM[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) continue;
    segments.push({ x0: a.x, y0: a.y, dx, dy, len, s0: totalLength, s1: totalLength + len });
    totalLength += len;
  }
  return { segments, totalLength };
}

function projectPointOnPath(x, y, pathData, minS = 0, maxS = Infinity) {
  const segs = pathData.segments;
  if (!segs.length) return null;
  let best = null;
  const loS = Math.max(0, Number(minS) || 0);
  const hiS = Number.isFinite(Number(maxS)) ? Number(maxS) : Infinity;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg.s1 < loS || seg.s0 > hiS) continue;
    const denom = seg.len * seg.len;
    const segMinT = clamp((loS - seg.s0) / seg.len, 0, 1);
    const segMaxT = clamp((hiS - seg.s0) / seg.len, 0, 1);
    const t = clamp(((x - seg.x0) * seg.dx + (y - seg.y0) * seg.dy) / denom, segMinT, segMaxT);
    const px = seg.x0 + seg.dx * t;
    const py = seg.y0 + seg.dy * t;
    const distSq = (x - px) ** 2 + (y - py) ** 2;
    if (!best || distSq < best.distSq) {
      best = { segIdx: i, s: seg.s0 + seg.len * t, px, py, distSq };
    }
  }
  return best;
}

function approachValue(current, target, maxDelta) {
  if (current < target - maxDelta) return current + maxDelta;
  if (current > target + maxDelta) return current - maxDelta;
  return target;
}

/**
 * Advance one rear-axle pose with a signed-speed kinematic bicycle model.
 * A direction change must pass through zero; the integrator never flips gear
 * while the vehicle is moving.
 */
export function stepKinematicBicycle(config = {}, state = {}, control = {}, dt = 0.05) {
  const stepS = clamp(Number(dt) || 0, 0, 0.2);
  const footprint = getVehicleFootprintConfig(config, { defaultVehicleWidth: 2.0 });
  const wheelBase = Math.max(0.5, Number(footprint.wheelBase) || 3.4);
  const maxSteer = d2r(Math.max(1, Number(config.maxSteeringAngle) || 38));
  const steerRate = Math.max(0.05, Number(config.maxSteeringRateRadS) || 0.45);
  const configuredAccel = Number(config.maxAccel);
  const configuredDecel = Number(config.maxDecel);
  const maxAccel = Number.isFinite(configuredAccel) ? Math.max(0, configuredAccel) : 1.2;
  // Zero is meaningful: a wet, steep downhill can have no net stopping capability.
  const maxDecel = Number.isFinite(configuredDecel) ? Math.max(0, configuredDecel) : 2.8;

  let x = Number(state.x) || 0;
  let y = Number(state.y) || 0;
  let theta = Number(state.theta) || 0;
  let speedMS = Number(state.speedMS) || 0;
  let steeringAngle = clamp(Number(state.steeringAngle) || 0, -maxSteer, maxSteer);
  const requestedSpeed = Number.isFinite(Number(control.targetSpeedMS))
    ? Number(control.targetSpeedMS)
    : 0;
  const requestedSteer = clamp(Number(control.targetSteeringAngle) || 0, -maxSteer, maxSteer);

  // Brake to a complete stop before selecting the opposite direction.
  const changingDirection = Math.abs(speedMS) > 0.02
    && Math.abs(requestedSpeed) > 0.02
    && Math.sign(speedMS) !== Math.sign(requestedSpeed);
  const targetSpeed = changingDirection ? 0 : requestedSpeed;
  const acceleratingSameDirection = Math.abs(speedMS) < 0.02
    || Math.sign(speedMS) === Math.sign(targetSpeed);
  const speedRate = acceleratingSameDirection && Math.abs(targetSpeed) > Math.abs(speedMS)
    ? maxAccel
    : maxDecel;

  const previousSpeed = speedMS;
  speedMS = approachValue(speedMS, targetSpeed, speedRate * stepS);
  if (changingDirection && Math.abs(speedMS) < 0.02) speedMS = 0;
  steeringAngle = approachValue(steeringAngle, requestedSteer, steerRate * stepS);

  // Midpoint inputs keep the exact-arc integration continuous under rate limits.
  const vMid = (previousSpeed + speedMS) * 0.5;
  const ds = vMid * stepS;
  const dTheta = (ds / wheelBase) * Math.tan(steeringAngle);
  if (Math.abs(dTheta) < 1e-8) {
    x += ds * Math.cos(theta);
    y += ds * Math.sin(theta);
  } else {
    const radius = ds / dTheta;
    x += radius * (Math.sin(theta + dTheta) - Math.sin(theta));
    y -= radius * (Math.cos(theta + dTheta) - Math.cos(theta));
    theta = normA(theta + dTheta);
  }

  return {
    ...state,
    x,
    y,
    theta,
    speedMS,
    steeringAngle,
    timeS: (Number(state.timeS) || 0) + stepS,
    travelM: (Number(state.travelM) || 0) + Math.abs(ds),
    gear: speedMS < -0.02 ? -1 : (speedMS > 0.02 ? 1 : 0)
  };
}

/**
 * Stateful online path follower. Unlike simulatePathPoses(), this is stepped by
 * the live scene and can resume from a recovery pose without snapping back to a
 * precomputed timeline.
 */
export function createKinematicPathFollower(config = {}, pathM = [], opts = {}) {
  const points = Array.isArray(pathM)
    ? pathM.filter((p) => Number.isFinite(Number(p?.x)) && Number.isFinite(Number(p?.y)))
      .map((p) => ({ x: Number(p.x), y: Number(p.y) }))
    : [];
  const pathData = buildPathData(points);
  // 縦方向動力学: 進行距離 s→勾配% を返す純関数 gradeAtM（省略可）と config.surfaceCondition を
  // 消費する。未指定かつ乾燥なら dynamicLong=false で従来挙動（config.maxDecel/maxAccel をそのまま使用）。
  // 指定時は「平坦・乾燥の基準」からの乗算スケールで config 値を尊重したまま勾配・路面を反映する。
  const gradeFn = typeof opts.gradeAtM === 'function' ? opts.gradeAtM : null;
  const speedLimitAtM = typeof opts.speedLimitAtM === 'function' ? opts.speedLimitAtM : null;
  const surfaceCond = String(config?.surfaceCondition || '').toLowerCase() === 'wet' ? 'wet' : 'dry';
  const dynamicLong = !!gradeFn || surfaceCond === 'wet' || hasOperationalMass(config);
  const baseBrakeMSS = effectiveBrakeDecelMSS({ gradePct: 0, surface: 'dry' });
  const baseAccelMSS = effectiveAccelMSS({ gradePct: 0 });
  const initialTheta = Number.isFinite(Number(opts.theta)) ? Number(opts.theta) : getInitialHeading(points);
  let state = {
    x: Number.isFinite(Number(opts.x)) ? Number(opts.x) : (points[0]?.x || 0),
    y: Number.isFinite(Number(opts.y)) ? Number(opts.y) : (points[0]?.y || 0),
    theta: initialTheta,
    speedMS: Number(opts.speedMS) || 0,
    steeringAngle: Number(opts.steeringAngle) || 0,
    timeS: Number(opts.timeS) || 0,
    travelM: Number(opts.travelM) || 0,
    progressS: clamp(Number(opts.progressS) || 0, 0, pathData.totalLength),
    lateralErrorM: 0,
    gear: 0
  };

  const projectState = (allowBacktrackM = 2) => {
    const minS = Math.max(0, state.progressS - Math.max(0, allowBacktrackM));
    const maxS = Math.min(pathData.totalLength, state.progressS + 35);
    const projection = projectPointOnPath(state.x, state.y, pathData, minS, maxS);
    if (!projection) return null;
    state.progressS = Math.max(state.progressS, projection.s);
    state.lateralErrorM = Math.sqrt(Math.max(0, projection.distSq));
    return projection;
  };

  const longitudinalLimitsAtS = (s) => {
    const configuredDecel = Number(config.maxDecel);
    const configuredAccel = Number(config.maxAccel);
    const baseConfiguredDecel = Number.isFinite(configuredDecel) ? Math.max(0, configuredDecel) : 2.8;
    const baseConfiguredAccel = Number.isFinite(configuredAccel) ? Math.max(0, configuredAccel) : 1.2;
    if (!dynamicLong) {
      return {
        maxDecel: baseConfiguredDecel,
        maxAccel: baseConfiguredAccel
      };
    }
    const gp = gradeFn ? Number(gradeFn(s)) : 0;
    const gpSafe = Number.isFinite(gp) ? gp : 0;
    // Explicit limits are already calibrated for this vehicle. Applying the
    // gross-weight factor again would double-derate them.
    const brakeVehicleConfig = Number.isFinite(configuredDecel) ? null : config;
    const accelVehicleConfig = Number.isFinite(configuredAccel) ? null : config;
    const brakeScale = effectiveBrakeDecelMSS({
      gradePct: gpSafe,
      surface: surfaceCond,
      vehicleConfig: brakeVehicleConfig
    }) / baseBrakeMSS;
    const accelScale = effectiveAccelMSS({ gradePct: gpSafe, vehicleConfig: accelVehicleConfig }) / baseAccelMSS;
    return {
      maxDecel: baseConfiguredDecel * brakeScale,
      maxAccel: baseConfiguredAccel * accelScale
    };
  };

  const limitedSpeedAtS = (s, fallback) => {
    if (!speedLimitAtM) return fallback;
    try {
      const limited = Number(speedLimitAtM(s));
      return Number.isFinite(limited) && limited >= 0 ? Math.min(fallback, limited) : fallback;
    } catch (_err) {
      return fallback;
    }
  };

  const speedLimitEnvelope = (sNow, baseTargetSpeed, speedMS) => {
    if (!speedLimitAtM) return baseTargetSpeed;
    const intervalM = clamp(Number(opts.speedLimitPreviewIntervalM) || 2, 0.5, 10);
    const configuredPreviewM = Number(opts.speedLimitPreviewM);
    const currentDecel = longitudinalLimitsAtS(sNow).maxDecel;
    const brakingPreviewM = currentDecel > 1e-6
      ? (speedMS * speedMS) / (2 * currentDecel) + 15
      : 120;
    const previewM = Math.min(
      Math.max(0, pathData.totalLength - sNow),
      Math.max(30, Number.isFinite(configuredPreviewM) ? configuredPreviewM : 0, brakingPreviewM)
    );
    const samples = [{ s: sNow, limit: limitedSpeedAtS(sNow, baseTargetSpeed) }];
    for (let ds = intervalM; ds < previewM; ds += intervalM) {
      const s = Math.min(pathData.totalLength, sNow + ds);
      samples.push({ s, limit: limitedSpeedAtS(s, baseTargetSpeed) });
    }
    const endS = Math.min(pathData.totalLength, sNow + previewM);
    if (samples[samples.length - 1].s < endS - 1e-6) {
      samples.push({ s: endS, limit: limitedSpeedAtS(endS, baseTargetSpeed) });
    }

    let allowed = samples[samples.length - 1].limit;
    for (let i = samples.length - 2; i >= 0; i--) {
      const fromS = samples[i].s;
      const toS = samples[i + 1].s;
      const midS = (fromS + toS) * 0.5;
      // A single interval uses its worst available braking, not the optimistic current grade.
      const intervalDecel = Math.min(
        longitudinalLimitsAtS(fromS).maxDecel,
        longitudinalLimitsAtS(midS).maxDecel,
        longitudinalLimitsAtS(toS).maxDecel
      );
      const reachable = intervalDecel > 1e-6
        ? Math.sqrt(Math.max(0, allowed * allowed + 2 * intervalDecel * (toS - fromS)))
        : allowed;
      allowed = Math.min(samples[i].limit, reachable);
    }
    return allowed;
  };

  const reset = (pose = {}) => {
    state = {
      ...state,
      ...pose,
      x: Number.isFinite(Number(pose.x)) ? Number(pose.x) : state.x,
      y: Number.isFinite(Number(pose.y)) ? Number(pose.y) : state.y,
      theta: Number.isFinite(Number(pose.theta)) ? Number(pose.theta) : state.theta,
      speedMS: Number(pose.speedMS) || 0,
      steeringAngle: Number(pose.steeringAngle) || 0,
      progressS: clamp(Number.isFinite(Number(pose.progressS)) ? Number(pose.progressS) : state.progressS, 0, pathData.totalLength)
    };
    projectState(8);
    return { ...state };
  };

  const step = (dt, command = {}) => {
    if (!pathData.segments.length) return { ...state, done: true };
    const projection = projectState();
    const footprint = getVehicleFootprintConfig(config, { defaultVehicleWidth: 2.0 });
    const wheelBase = Math.max(0.5, Number(footprint.wheelBase) || 3.4);
    const baseLookahead = Math.max(2.5, Number(config.lookaheadDistanceBase) || wheelBase * 1.2);
    const ratio = Math.max(0, Number(config.lookaheadDistanceRatio) || 0.45);
    const lookaheadM = Math.max(2.5, baseLookahead + Math.abs(state.speedMS) * ratio);
    const target = samplePathAtS(pathData, state.progressS + lookaheadM);
    const targetHeading = target ? Math.atan2(target.y - state.y, target.x - state.x) : state.theta;
    const alpha = normA(targetHeading - state.theta);
    const actualLookahead = target ? Math.max(1, Math.hypot(target.x - state.x, target.y - state.y)) : lookaheadM;
    const targetSteeringAngle = Math.atan2(2 * wheelBase * Math.sin(alpha), actualLookahead);
    const remainingM = Math.max(0, pathData.totalLength - state.progressS);
    let targetSpeedMS = Number.isFinite(Number(command.targetSpeedMS))
      ? Math.max(0, Number(command.targetSpeedMS))
      : Math.max(0, Number(config.vehicleSpeed) || 3.5);
    // dynamicLong=false（gradeAtM/surface/load 未指定・乾燥）なら stepConfig=config で従来と完全一致。
    const limits = longitudinalLimitsAtS(state.progressS);
    const maxDecel = limits.maxDecel;
    const stepConfig = dynamicLong ? { ...config, ...limits } : config;
    const stoppingCap = Math.sqrt(Math.max(0, 2 * maxDecel * Math.max(0, remainingM - 0.35)));
    targetSpeedMS = Math.min(targetSpeedMS, stoppingCap);
    targetSpeedMS = Math.min(targetSpeedMS, speedLimitEnvelope(state.progressS, targetSpeedMS, Math.abs(state.speedMS)));
    if (remainingM <= 0.35) targetSpeedMS = 0;

    state = stepKinematicBicycle(stepConfig, state, { targetSpeedMS, targetSteeringAngle }, dt);
    projectState();
    const done = pathData.totalLength - state.progressS <= 0.35 && Math.abs(state.speedMS) <= 0.08;
    return {
      ...state,
      done,
      targetSteeringAngle,
      targetSpeedMS,
      remainingM: Math.max(0, pathData.totalLength - state.progressS),
      projectionS: projection?.s ?? state.progressS,
      brakingAvailable: maxDecel > 1e-6,
      nonStoppable: maxDecel <= 1e-6 && Math.abs(state.speedMS) > targetSpeedMS + 0.02
    };
  };

  return {
    step,
    reset,
    getState: () => ({ ...state }),
    getTotalLength: () => pathData.totalLength
  };
}

function samplePathAtS(pathData, s) {
  const segs = pathData.segments;
  if (!segs.length) return null;
  const sC = clamp(s, 0, pathData.totalLength);
  let idx = 0;
  for (let i = 0; i < segs.length; i++) {
    if (sC <= segs[i].s1) { idx = i; break; }
    idx = i;
  }
  const seg = segs[idx];
  const t = seg.len > 1e-3 ? (sC - seg.s0) / seg.len : 0;
  return { x: seg.x0 + seg.dx * t, y: seg.y0 + seg.dy * t, theta: Math.atan2(seg.dy, seg.dx), s: sC };
}

export function simulatePathPoses(config, pathM, strideMeters, opts = {}) {
  const dt = opts.dt ?? 0.05;
  const maxSteps = opts.maxSteps ?? 60000;
  const speedLimitAtM = typeof opts.speedLimitAtM === 'function' ? opts.speedLimitAtM : null;
  // 縦方向動力学: 進行距離 s→勾配% を返す純関数 gradeAtM（省略可）と config.surfaceCondition を
  // 消費する。未指定かつ乾燥なら dynamicLong=false で下の固定係数（=従来値）をそのまま使い、
  // 出力は従来と bit 一致（後方互換）。純関数なら勾配ありでも決定論を保つ。
  const gradeAtM = typeof opts.gradeAtM === 'function' ? opts.gradeAtM : null;
  const surfaceCond = String(config?.surfaceCondition || '').toLowerCase() === 'wet' ? 'wet' : 'dry';
  const dynamicLong = !!gradeAtM || surfaceCond === 'wet' || hasOperationalMass(config);
  // 平坦・乾燥の基準（スケール分母）。flat-dry では numerator/denominator=1.0 で固定係数に厳密一致し、
  // gradeAtM=()=>0 でも省略時と bit 一致する（後方互換）。
  const baseBrakeMSS = effectiveBrakeDecelMSS({ gradePct: 0, surface: 'dry' });
  const baseAccelMSS = effectiveAccelMSS({ gradePct: 0 });
  if (!pathM || pathM.length < 2) return [];

  // Vehicle Config mapping
  const footprint = getVehicleFootprintConfig(config, { defaultVehicleWidth: 2.0 });
  const wb = footprint.wheelBase;
  const rawMaxSteer = Number(config.maxSteeringAngle) || 38;
  const MAX_STEER = d2r(rawMaxSteer);

  // Acceleration & Friction limiters
  const MAX_SPEED = Number(config.vehicleSpeed) || 3.5;

  // Vehicle geometry for 4-corner sweep (sim.html ベース)
  const halfWidth = footprint.halfWidthM;
  const fo = footprint.frontOverhang;
  const ro = footprint.rearOverhang;

  // Scaling factors to normalize time step into similar magnitude of the browser sim
  const frameMultiplier = dt * 60; // 0.05 * 60 = 3 frames / tick. Using 60fps equivalent.
  // 実車トラックの忠実度改善（v8.2 #46）: 加減速・操舵レートを機敏すぎない実挙動へ。
  // per-tick = k * frameMultiplier、per-second = k * 60（frameMultiplier=dt*60 で dt が相殺）。
  const A_BRAKE_MS2 = 2.8;                                 // 先読みブレーキと共有する減速度 [m/s²]
  const STEER_SPEED = 0.0075 * frameMultiplier;            // 0.45 rad/s 相当（従来0.6）
  const ACCELERATION = 0.02 * frameMultiplier;             // 1.2 m/s² 相当（従来3.0）
  const BRAKING_FORCE = (A_BRAKE_MS2 / 60) * frameMultiplier; // 2.8 m/s² 相当（従来9.0）
  const FRICTION = 0.015 * frameMultiplier;                // 0.9 m/s² 相当（据え置き）

  let x = pathM[0].x;
  let y = pathM[0].y;
  let theta = getInitialHeading(pathM);
  let v = 0;
  let steeringAngle = 0;

  // sim.html の getPoint() と同じロジック — 後輪軸(x,y)基準で4隅を計算
  function getCorners(cx, cy, th) {
    const c = Math.cos(th), s = Math.sin(th);
    const pt = (dx, dy) => ({ x: cx + dx * c - dy * s, y: cy + dx * s + dy * c });
    return {
      fl: pt(wb + fo, -halfWidth),  // front-left
      fr: pt(wb + fo, halfWidth),  // front-right
      rl: pt(-ro, -halfWidth),  // rear-left
      rr: pt(-ro, halfWidth)   // rear-right
    };
  }

  // 停止テール対策: speedLimitAtMがハード停止(0)を返す区間でv=0のまま
  // waypointsが残り続けると、maxSteps(=3000秒相当)まで空回りし「凍結ポーズ」を
  // 最後にpushしてしまう。直近5秒でtraveledDistanceの増分がほぼ無ければ打ち切る。
  const NO_PROGRESS_WINDOW_S = 5.0;
  const NO_PROGRESS_MIN_DELTA_M = 0.05;
  const noProgressWindowSteps = Math.max(1, Math.round(NO_PROGRESS_WINDOW_S / dt));
  const distanceHistory = new Array(noProgressWindowSteps).fill(0);
  let halted = false;
  let haltReason = null;

  let simTime = 0;
  let traveledDistance = 0;
  const makePose = () => ({
    x,
    y,
    theta,
    speedMS: v,
    steeringAngle,
    timeS: simTime,
    travelM: traveledDistance,
    ...getCorners(x, y, theta)
  });
  const poses = [makePose()];
  let accumDistance = 0;

  const waypoints = pathM.map(p => ({ x: p.x, y: p.y }));
  let lastWaypoint = waypoints.shift();
  if (waypoints.length === 0) return poses;

  for (let step = 0; step < maxSteps; step++) {
    if (waypoints.length === 0) break;

    // 縦方向動力学: この tick の勾配・路面から有効制動/加速度を引く。
    // dynamicLong=false なら固定係数（A_BRAKE_MS2 / BRAKING_FORCE / ACCELERATION）のまま=従来挙動。
    // 簡略化: 先読みブレーキも現在地点の aBrakeTick を用いる（先読み地点の勾配ではない旨をコメント明記）。
    let aBrakeTick = A_BRAKE_MS2;
    let brakingForceTick = BRAKING_FORCE;
    let accelTick = ACCELERATION;
    if (dynamicLong) {
      const gp = gradeAtM ? Number(gradeAtM(traveledDistance)) : 0;
      const gpSafe = Number.isFinite(gp) ? gp : 0;
      // 平坦・乾燥を基準にした乗算スケール（flat-dry では scale=1.0 → 固定係数に厳密一致）。
      const brakeScale = effectiveBrakeDecelMSS({ gradePct: gpSafe, surface: surfaceCond, vehicleConfig: config }) / baseBrakeMSS;
      const accelScale = effectiveAccelMSS({ gradePct: gpSafe, vehicleConfig: config }) / baseAccelMSS;
      aBrakeTick = A_BRAKE_MS2 * brakeScale;
      brakingForceTick = BRAKING_FORCE * brakeScale;
      accelTick = ACCELERATION * accelScale;
    }

    const target = waypoints[0];

    // Front axle position
    const frontX = x + Math.cos(theta) * wb;
    const frontY = y + Math.sin(theta) * wb;

    const dx = target.x - frontX;
    const dy = target.y - frontY;
    const dist = Math.hypot(dx, dy);

    let pathDx = target.x - lastWaypoint.x;
    let pathDy = target.y - lastWaypoint.y;
    let pathLen = Math.hypot(pathDx, pathDy);

    let ux = pathLen > 0 ? pathDx / pathLen : 0;
    let uy = pathLen > 0 ? pathDy / pathLen : 0;

    let vx = frontX - lastWaypoint.x;
    let vy = frontY - lastWaypoint.y;
    let dot = vx * ux + vy * uy; // Distance projected onto path direction

    // Advanced waypoint elimination based on proximity (0.5m) or overshoot (dot >= pathLen)
    if (dist < 0.5 || (pathLen > 0 && dot >= pathLen)) {
      lastWaypoint = waypoints.shift();
      if (waypoints.length === 0) break;
      continue;
    }

    let targetAngleForSteer = 0;

    // Dynamic lookahead scaling with speed for smoother cornering and stability
    let baseLh = Number(config.lookaheadDistanceBase) || (wb * 1.5);
    let lhRatio = Number(config.lookaheadDistanceRatio) || 0.4; // 0.8から下げて内周りしやすくする
    let lookaheadDist = baseLh + v * lhRatio;

    let lookaheadX = target.x;
    let lookaheadY = target.y;

    if (pathLen > 0.1) {
      let proj = Math.max(0, dot);
      let rem = lookaheadDist;

      if (proj + rem <= pathLen) {
        lookaheadX = lastWaypoint.x + ux * (proj + rem);
        lookaheadY = lastWaypoint.y + uy * (proj + rem);
      } else {
        rem -= (pathLen - proj);
        let currWP = target;

        for (let i = 1; i < waypoints.length; i++) {
          let nextWP = waypoints[i];
          let segDx = nextWP.x - currWP.x;
          let segDy = nextWP.y - currWP.y;
          let segLen = Math.hypot(segDx, segDy);

          if (rem <= segLen) {
            let segUx = segLen > 0 ? segDx / segLen : 0;
            let segUy = segLen > 0 ? segDy / segLen : 0;
            lookaheadX = currWP.x + segUx * rem;
            lookaheadY = currWP.y + segUy * rem;
            rem = 0;
            break;
          } else {
            rem -= segLen;
            currWP = nextWP;
            lookaheadX = currWP.x;
            lookaheadY = currWP.y;
          }
        }

        if (rem > 0 && waypoints.length >= 2) {
          let last1 = waypoints[waypoints.length - 2];
          let last2 = waypoints[waypoints.length - 1];
          let lDx = last2.x - last1.x;
          let lDy = last2.y - last1.y;
          let lLen = Math.hypot(lDx, lDy);
          if (lLen > 0) {
            let lUx = lDx / lLen;
            let lUy = lDy / lLen;
            lookaheadX = last2.x + lUx * rem;
            lookaheadY = last2.y + lUy * rem;
          }
        }
      }
      targetAngleForSteer = Math.atan2(lookaheadY - frontY, lookaheadX - frontX);
    } else {
      targetAngleForSteer = Math.atan2(dy, dx);
    }

    let alpha = normA(targetAngleForSteer - theta);

    // Use actual distance to the lookahead point, smoothly clamped for stability
    let actualLookaheadDist = Math.hypot(lookaheadX - frontX, lookaheadY - frontY);

    let effectiveLookahead = Math.max(actualLookaheadDist, lookaheadDist);

    // 大型車の外輪差: カーブほどルックアヘッドを長く保ち、大回り（外振り）挙動を再現する
    // ※ 内回りにするロジック（内切り）は削除 — 実際のトラックは鋭角カーブで外に膨らむ
    if (Math.abs(alpha) > Math.PI / 4) {
      // 鋭角カーブ: ルックアヘッドを長めに保って大回りを促す
      effectiveLookahead = Math.max(effectiveLookahead, wb * 2.5);
    } else if (Math.abs(alpha) > Math.PI / 8) {
      // 中程度カーブ: 少し長めに
      let excess = Math.abs(alpha) - Math.PI / 8;
      let ratio = excess / (Math.PI / 8); // 0.0 to 1.0
      let wideLh = wb * 2.5;
      effectiveLookahead = effectiveLookahead * (1 - ratio) + wideLh * ratio;
    }

    let requiredSteer = Math.atan2(2.0 * wb * Math.sin(alpha), effectiveLookahead);

    // Clamp steer
    if (requiredSteer > MAX_STEER) requiredSteer = MAX_STEER;
    if (requiredSteer < -MAX_STEER) requiredSteer = -MAX_STEER;

    const steerDiff = Math.abs(requiredSteer - steeringAngle);

    // Turn steering wheel gradually
    if (steeringAngle < requiredSteer - STEER_SPEED) {
      steeringAngle += STEER_SPEED;
    } else if (steeringAngle > requiredSteer + STEER_SPEED) {
      steeringAngle -= STEER_SPEED;
    } else {
      steeringAngle = requiredSteer;
    }

    // High-quality speed control logic (product-level smoothness)
    let targetSpeed = MAX_SPEED;
    if (speedLimitAtM) {
      try {
        const limited = Number(speedLimitAtM(traveledDistance));
        if (Number.isFinite(limited) && limited >= 0) targetSpeed = Math.min(targetSpeed, limited);
      } catch (_err) {
        // Keep the physics solver deterministic if a caller-supplied limiter fails.
      }

      // 先読みブレーキ（v8.2 #46）: 現在地点の制限だけ見ると、弱いブレーキだと STOP/徐行区間へ
      // 突っ込み過ぎる。前方 s_i の各制限に対し「今から a_brake で減速して間に合う最大速度」
      //   v_allow(s_i) = √(limit(s_i)² + 2·a_brake·(s_i − s_now))
      // を評価し、その最小を採用する（standard backward pass）。制限関数が無ければスキップ。
      const horizonM = aBrakeTick > 1e-6
        ? Math.max(15, (v * v) / (2 * aBrakeTick) + 10)
        : 120;
      for (let ds = 2; ds <= horizonM; ds += 2) {
        let lim;
        try {
          lim = Number(speedLimitAtM(traveledDistance + ds));
        } catch (_err) {
          continue;
        }
        if (!Number.isFinite(lim) || lim < 0) continue;
        const allowed = Math.sqrt(lim * lim + 2 * aBrakeTick * ds);
        if (allowed < targetSpeed) targetSpeed = allowed;
      }
    }
    const steerRatio = Math.abs(steeringAngle) / MAX_STEER;

    // ステアリング操作優先。従来の 0.3m/s 固定は交差点で「停止してハンドル待ち」に見えやすい。
    // 安全停止は上位の speedLimitAtM に任せ、操舵追従だけでは段階的な減速に留める。
    if (steerDiff > 0.05) {
      const prepFactor = clamp(1.0 - (steerDiff / Math.max(MAX_STEER, 1e-6)), 0.22, 0.55);
      targetSpeed = Math.min(targetSpeed, Math.max(0.75, MAX_SPEED * prepFactor));
    } else {
      // カーブ中は速度を落としてゆっくり曲がる（ドリフト大回り防止）
      targetSpeed *= Math.max(0.1, 1.0 - steerRatio * 0.9);
    }

    if (waypoints.length >= 2) {
      const dx2 = waypoints[1].x - waypoints[0].x;
      const dy2 = waypoints[1].y - waypoints[0].y;
      const nextRouteAngle = Math.atan2(dy2, dx2);
      const currentRouteAngle = Math.atan2(pathDy, pathDx);

      const turnSeverity = Math.abs(normA(nextRouteAngle - currentRouteAngle));
      const brakingDistance = Math.max(10.0, v * 3.5);

      if (dist < brakingDistance) {
        const curveConfigMod = Number(config.curveReductionRatio) || 0.6;
        const cornerSpeedLimit = MAX_SPEED * Math.max(0.1, 1.0 - (turnSeverity / Math.PI) * (1.0 + curveConfigMod));
        const weight = 1.0 - (dist / brakingDistance);
        const suggestedSpeed = targetSpeed * (1 - weight * 0.9) + cornerSpeedLimit * weight;
        targetSpeed = Math.min(targetSpeed, suggestedSpeed);

        // ① 前方カーブの旋回半径から横加速度上限で先読み減速（v ≤ √(a_lat·R)）。
        // 2セグメントの交角から R≈min(seg)/tan(θ/2) を推定し、planning と同じ curveSpeedLimitMS を適用。
        const nextSegLen = Math.hypot(dx2, dy2);
        if (turnSeverity > 1e-3 && pathLen > 0.1 && nextSegLen > 0.1) {
          const halfAngle = Math.min(Math.PI / 2 - 1e-3, turnSeverity / 2);
          const aheadRadius = Math.min(pathLen, nextSegLen) / Math.tan(halfAngle);
          const aheadCap = curveSpeedLimitMS({ turnRadiusM: aheadRadius, baseSpeedMS: MAX_SPEED });
          if (Number.isFinite(aheadCap)) targetSpeed = Math.min(targetSpeed, aheadCap);
        }
      }
    } else if (waypoints.length === 1 && dist < 8.0) {
      targetSpeed = Math.min(targetSpeed, MAX_SPEED * Math.max(0.05, dist / 8.0));
    }

    // ① 現在の舵角から旋回半径 R を出し、横加速度上限で速度を抑える（コーナリング中の整合）。
    // 直進(R→∞)では curveSpeedLimitMS が base を返すため減速しない。最低速度は RISK_TUNING.curve.minSpeedMS。
    if (Math.abs(steeringAngle) > 1e-3) {
      const turnRadius = Math.abs(wb / Math.tan(steeringAngle));
      const latCap = curveSpeedLimitMS({ turnRadiusM: turnRadius, baseSpeedMS: targetSpeed });
      if (Number.isFinite(latCap)) targetSpeed = Math.min(targetSpeed, latCap);
    }

    // Accelerate / Brake logic（縦方向動力学: 勾配・路面で更新した per-tick 値を使用）
    if (v > targetSpeed + 0.3) {
      v -= brakingForceTick;
    } else if (v > targetSpeed) {
      // 低速ブレーキもその地点の有効制動を上回らせない。特に制動不能な
      // 湿潤急降坂で固定の乾燥摩擦を注入しない。
      v -= dynamicLong ? Math.min(FRICTION, brakingForceTick) : FRICTION;
    } else if (v < targetSpeed) {
      v += accelTick;
    }
    if (v < 0) v = 0;

    // 目的地到達: 最終waypoint手前1.0m未満で徐行まで落ちたら「到着」として終了する。
    // v=0のままループを続けると、waypoint消化条件(0.5m)に届かない 0.5〜1.0m 帯で
    // 永久デッドロックになり「止まったままシミュレーションが進まない」症状になる。
    if (waypoints.length <= 1 && dist < 1.0 && Math.abs(v) < 0.2) {
      v = 0;
      break;
    }

    // Exact arc update for kinematic bicycle model (product-level accuracy to prevent drift over dt)
    if (Math.abs(steeringAngle) < 1e-4) {
      x += v * Math.cos(theta) * dt;
      y += v * Math.sin(theta) * dt;
    } else {
      let R = wb / Math.tan(steeringAngle);
      let d_theta = (v / wb) * Math.tan(steeringAngle) * dt;
      x += R * (Math.sin(theta + d_theta) - Math.sin(theta));
      y -= R * (Math.cos(theta + d_theta) - Math.cos(theta));
      theta = normA(theta + d_theta);
    }

    // Lock heading initially if starting cold
    if (step < 6 && poses.length < 2) {
      theta = config._startHeading || getInitialHeading(pathM);
      config._startHeading = theta;
    }

    simTime += dt;
    traveledDistance += v * dt;
    accumDistance += v * dt;
    if (accumDistance >= strideMeters) {
      accumDistance = 0;
      poses.push(makePose());
    }

    // 直近5秒(noProgressWindowSteps)分の移動距離が閾値未満なら進捗なしと判定して打ち切る。
    const histIdx = step % noProgressWindowSteps;
    if (step >= noProgressWindowSteps) {
      const deltaWindow = traveledDistance - distanceHistory[histIdx];
      if (deltaWindow < NO_PROGRESS_MIN_DELTA_M) {
        halted = true;
        haltReason = 'no_progress';
        break;
      }
    }
    distanceHistory[histIdx] = traveledDistance;
  }

  if (halted) {
    // 打ち切り時点の最終ポーズを必ずpushし、halted/haltReasonのみを非破壊で付与する
    // (既存フィールド・poses配列の形は変えない。呼び出し側の後方互換を維持)。
    const finalPose = makePose();
    finalPose.halted = true;
    finalPose.haltReason = haltReason;
    poses.push(finalPose);
  } else if (poses.length === 0 || Math.hypot(poses[poses.length - 1].x - x, poses[poses.length - 1].y - y) > 0.1) {
    poses.push(makePose());
  }

  return poses;
}
