import { d2r, normA } from '../utils/geo.js';
import { getVehicleFootprintConfig } from '../3d/clearanceSolids.js';
import { curveSpeedLimitMS } from './vehicleRiskModel.js';

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

function projectPointOnPath(x, y, pathData) {
  const segs = pathData.segments;
  if (!segs.length) return null;
  let best = null;
  // v7.3: Global search to always find the closest point
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const denom = seg.len * seg.len;
    const t = clamp(((x - seg.x0) * seg.dx + (y - seg.y0) * seg.dy) / denom, 0, 1);
    const px = seg.x0 + seg.dx * t;
    const py = seg.y0 + seg.dy * t;
    const distSq = (x - px) ** 2 + (y - py) ** 2;
    if (!best || distSq < best.distSq) {
      best = { segIdx: i, s: seg.s0 + seg.len * t, px, py, distSq };
    }
  }
  return best;
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
  const STEER_SPEED = 0.01 * frameMultiplier;
  const ACCELERATION = 0.05 * frameMultiplier;
  const BRAKING_FORCE = 0.15 * frameMultiplier;
  const FRICTION = 0.015 * frameMultiplier;

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
    }
    const steerRatio = Math.abs(steeringAngle) / MAX_STEER;

    // ステアリング操作優先（目標角度と現在の角度のズレが大きい場合は、速度を極度に落としてハンドルを回す）
    if (steerDiff > 0.05) {
      targetSpeed = 0.3; // 早送りカーブにならず、止まりがけでハンドルを回す (S字振れ防止)
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

    // Accelerate / Brake logic
    if (v > targetSpeed + 0.3) {
      v -= BRAKING_FORCE;
    } else if (v > targetSpeed) {
      v -= FRICTION;
    } else {
      v += ACCELERATION;
    }
    if (v < 0) v = 0;

    // Stop fully at destination
    if (waypoints.length <= 1 && dist < 1.0 && Math.abs(v) < 0.2) {
      v = 0;
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
  }

  if (poses.length === 0 || Math.hypot(poses[poses.length - 1].x - x, poses[poses.length - 1].y - y) > 0.1) {
    poses.push(makePose());
  }

  return poses;
}
