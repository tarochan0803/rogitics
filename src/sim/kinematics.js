import { coordinateSystem, normA } from '../utils/geo.js';
import { simulatePathPoses } from '../core/physics.js';
import { normalizeVehicleModel } from './vehicleModel.js';

function routeToMeters(routeLL) {
  if (!Array.isArray(routeLL) || routeLL.length < 2) return [];
  const first = routeLL[0];
  if (!Number.isFinite(Number(first?.lat)) || !Number.isFinite(Number(first?.lng))) return [];
  coordinateSystem.setOrigin(Number(first.lat), Number(first.lng));
  return routeLL
    .map((p) => ({ lat: Number(p.lat), lng: Number(p.lng) }))
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng))
    .map((p) => coordinateSystem.latLngToMeters(p.lat, p.lng));
}

function cumulativePoseDistances(poses) {
  const cum = new Array(poses.length).fill(0);
  for (let i = 1; i < poses.length; i++) {
    const a = poses[i - 1];
    const b = poses[i];
    cum[i] = cum[i - 1] + Math.hypot(b.x - a.x, b.y - a.y);
  }
  return cum;
}

function curvatureAt(poses, i) {
  if (i <= 0 || i >= poses.length - 1) return 0;
  const a = poses[i - 1];
  const b = poses[i];
  const c = poses[i + 1];
  const ds1 = Math.hypot(b.x - a.x, b.y - a.y);
  const ds2 = Math.hypot(c.x - b.x, c.y - b.y);
  const ds = Math.max(1e-3, (ds1 + ds2) * 0.5);
  const dTheta = normA(c.theta - a.theta);
  return dTheta / Math.max(1e-3, ds1 + ds2);
}

function buildSpeedProfile(samples, model) {
  const n = samples.length;
  const speed = new Array(n).fill(model.maxSpeed);
  for (let i = 0; i < n; i++) {
    const absK = Math.abs(samples[i].curvature);
    const curveLimit = absK > 1e-5
      ? Math.sqrt(Math.max(0.01, model.maxLatAccel) / absK)
      : model.maxSpeed;
    speed[i] = Math.min(model.maxSpeed, curveLimit);
  }

  for (let i = n - 2; i >= 0; i--) {
    const ds = Math.max(0.05, samples[i + 1].s - samples[i].s);
    const reachable = Math.sqrt(Math.max(0, speed[i + 1] ** 2 + 2 * model.maxDecel * ds));
    speed[i] = Math.min(speed[i], reachable);
  }

  for (let i = 1; i < n; i++) {
    const ds = Math.max(0.05, samples[i].s - samples[i - 1].s);
    const reachable = Math.sqrt(Math.max(0, speed[i - 1] ** 2 + 2 * model.maxAccel * ds));
    speed[i] = Math.min(speed[i], reachable);
  }

  return speed;
}

function buildDriveSimulation(samples, speed, model) {
  const timeline = [];
  let t = 0;
  let maxBrakeDemand = 0;
  let maxSteerDeg = 0;
  let stopAndGoCount = 0;

  for (let i = 0; i < samples.length; i++) {
    const cur = samples[i];
    const prev = i > 0 ? samples[i - 1] : null;
    const ds = prev ? Math.max(0.05, cur.s - prev.s) : 0;
    const v0 = prev ? speed[i - 1] : speed[i];
    const v1 = speed[i];
    const avgV = Math.max(0.2, (v0 + v1) * 0.5);
    if (prev) t += ds / avgV;
    const accel = prev ? (v1 * v1 - v0 * v0) / (2 * ds) : 0;
    const brakeDemand = Math.max(0, -accel) / Math.max(0.1, model.maxDecel);
    const steerRad = Math.atan(model.wheelBase * cur.curvature);
    const steerDeg = steerRad * 180 / Math.PI;
    maxBrakeDemand = Math.max(maxBrakeDemand, brakeDemand);
    maxSteerDeg = Math.max(maxSteerDeg, Math.abs(steerDeg));
    if (prev && v0 < model.crawlSpeed * 1.15 && v1 >= model.crawlSpeed * 1.15) stopAndGoCount += 1;
    timeline.push({
      s: Number(cur.s.toFixed(2)),
      t: Number(t.toFixed(2)),
      speedMps: Number(v1.toFixed(2)),
      speedKph: Number((v1 * 3.6).toFixed(1)),
      accelMps2: Number(accel.toFixed(2)),
      brakeDemand: Number(Math.min(1, brakeDemand).toFixed(2)),
      steeringDeg: Number(steerDeg.toFixed(1)),
      radius: Number.isFinite(cur.radius) ? Number(cur.radius.toFixed(2)) : null,
      latLng: sampleLatLngAtPose(cur.pose)
    });
  }

  const stride = Math.max(1, Math.ceil(timeline.length / 120));
  return {
    timeSeconds: Number(t.toFixed(1)),
    sampleCount: timeline.length,
    previewStride: stride,
    preview: timeline.filter((_, i) => i % stride === 0 || i === timeline.length - 1),
    metrics: {
      maxSteeringAngleDeg: Number(maxSteerDeg.toFixed(1)),
      maxBrakeDemand: Number(Math.min(1, maxBrakeDemand).toFixed(2)),
      stopAndGoCount
    }
  };
}

export function calibrateSharpCurveThresholdFromAnalysis(analysis = {}, vehicleConfig = {}, opts = {}) {
  const samples = Array.isArray(analysis.samples) ? analysis.samples : [];
  const driverSkill = Number(opts.driverSkill ?? vehicleConfig.driverSkill ?? 1.0) || 1.0;
  const model = analysis.model || normalizeVehicleModel(vehicleConfig);
  const radii = samples
    .map((s) => Number(s.radius))
    .filter((r) => Number.isFinite(r) && r > 0 && r < 50)
    .sort((a, b) => a - b);
  const thresholds = [4, 5, 6, 7, 8, 10, 12];
  const currentThreshold = Math.max(4.0, Math.min(8.0, 6.0 - (driverSkill - 1.0) * 2.0));
  const p05 = radii.length ? radii[Math.min(radii.length - 1, Math.floor(radii.length * 0.05))] : null;
  const p10 = radii.length ? radii[Math.min(radii.length - 1, Math.floor(radii.length * 0.10))] : null;
  const recommended = Math.max(
    4,
    Math.min(12, Math.max(currentThreshold, Number(model.minTurnRadius || 0) * 0.95))
  );
  return {
    currentThreshold: Number(currentThreshold.toFixed(2)),
    recommendedThreshold: Number(recommended.toFixed(2)),
    minObservedRadius: radii.length ? Number(radii[0].toFixed(2)) : null,
    p05Radius: Number.isFinite(p05) ? Number(p05.toFixed(2)) : null,
    p10Radius: Number.isFinite(p10) ? Number(p10.toFixed(2)) : null,
    vehicleMinRadius: Number((model.minTurnRadius || 0).toFixed(2)),
    thresholdCounts: thresholds.map((threshold) => ({
      threshold,
      samplesBelow: radii.filter((r) => r < threshold).length
    }))
  };
}

function sampleLatLngAtPose(pose) {
  const ll = coordinateSystem.metersToLatLng(pose.x, pose.y);
  return { lat: ll.lat, lng: ll.lng };
}

export function analyzeVehicleKinematics(routeLL, vehicleConfig = {}, opts = {}) {
  const model = normalizeVehicleModel(vehicleConfig);
  const pathM = routeToMeters(routeLL);
  if (pathM.length < 2) {
    return {
      status: 'NG',
      reason: 'route_missing',
      model,
      poses: [],
      samples: [],
      violations: []
    };
  }

  const strideMeters = Math.max(0.25, Number(opts.strideMeters) || 0.4);
  const poses = simulatePathPoses(model, pathM, strideMeters, {
    maxSteps: Math.max(60000, Math.ceil(pathM.length * 1200))
  });
  if (!Array.isArray(poses) || poses.length < 2) {
    return {
      status: 'NG',
      reason: 'pose_simulation_failed',
      model,
      poses: [],
      samples: [],
      violations: []
    };
  }

  const cum = cumulativePoseDistances(poses);
  const samples = poses.map((pose, i) => {
    const curvature = curvatureAt(poses, i);
    const radius = Math.abs(curvature) > 1e-5 ? 1 / Math.abs(curvature) : Infinity;
    return { i, pose, s: cum[i], curvature, radius };
  });
  const speed = buildSpeedProfile(samples, model);
  const driveSimulation = buildDriveSimulation(samples, speed, model);

  let minRadius = Infinity;
  let minSafeSpeed = Infinity;
  let maxLatAccel = 0;
  let maxRequiredDecel = 0;
  let impossibleTurn = null;
  let crawlLimit = null;
  const warnings = [];

  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i];
    if (Number.isFinite(sample.radius)) minRadius = Math.min(minRadius, sample.radius);
    const v = speed[i];
    minSafeSpeed = Math.min(minSafeSpeed, v);
    const latAccel = Math.abs(sample.curvature) * v * v;
    maxLatAccel = Math.max(maxLatAccel, latAccel);

    if (Number.isFinite(sample.radius) && sample.radius < model.minTurnRadius * 0.98 && !impossibleTurn) {
      impossibleTurn = {
        type: 'turning_radius',
        actual: Number(sample.radius.toFixed(2)),
        required: Number(model.minTurnRadius.toFixed(2)),
        deficit: Number((model.minTurnRadius - sample.radius).toFixed(2)),
        atKm: Number((sample.s / 1000).toFixed(3)),
        latLng: sampleLatLngAtPose(sample.pose)
      };
    }

    if (v < model.crawlSpeed && !crawlLimit) {
      crawlLimit = {
        type: 'speed_limit',
        actual: Number(v.toFixed(2)),
        required: Number(model.crawlSpeed.toFixed(2)),
        deficit: Number((model.crawlSpeed - v).toFixed(2)),
        atKm: Number((sample.s / 1000).toFixed(3)),
        latLng: sampleLatLngAtPose(sample.pose)
      };
    }

    if (i < samples.length - 1) {
      const ds = Math.max(0.05, samples[i + 1].s - sample.s);
      const decel = Math.max(0, (v * v - speed[i + 1] * speed[i + 1]) / (2 * ds));
      maxRequiredDecel = Math.max(maxRequiredDecel, decel);
    }
  }

  if (Number.isFinite(minSafeSpeed) && minSafeSpeed < model.maxSpeed * 0.65) {
    warnings.push({
      type: 'slowdown_required',
      actual: Number(minSafeSpeed.toFixed(2)),
      required: Number(model.maxSpeed.toFixed(2)),
      deficit: Number((model.maxSpeed - minSafeSpeed).toFixed(2)),
      atKm: null,
      latLng: null
    });
  }

  const violations = [];
  if (impossibleTurn) violations.push(impossibleTurn);
  if (crawlLimit) violations.push(crawlLimit);
  if (maxRequiredDecel > model.maxDecel * 1.02) {
    violations.push({
      type: 'braking_limit',
      actual: Number(maxRequiredDecel.toFixed(2)),
      required: Number(model.maxDecel.toFixed(2)),
      deficit: Number((maxRequiredDecel - model.maxDecel).toFixed(2)),
      atKm: null,
      latLng: null
    });
  }

  return {
    status: violations.length ? 'NG' : 'OK',
    reason: violations[0]?.type || null,
    model,
    poses,
    samples,
    speedProfile: speed,
    metrics: {
      minTurnRadiusObserved: Number.isFinite(minRadius) ? Number(minRadius.toFixed(2)) : null,
      requiredTurnRadius: Number(model.minTurnRadius.toFixed(2)),
      maxSpeed: Number(model.maxSpeed.toFixed(2)),
      minRecommendedSpeed: Number.isFinite(minSafeSpeed) ? Number(minSafeSpeed.toFixed(2)) : null,
      maxLateralAccel: Number(maxLatAccel.toFixed(2)),
      maxAllowedLateralAccel: Number(model.maxLatAccel.toFixed(2)),
      maxRequiredDecel: Number(maxRequiredDecel.toFixed(2)),
      maxAllowedDecel: Number(model.maxDecel.toFixed(2))
    },
    driveSimulation,
    curveCalibration: calibrateSharpCurveThresholdFromAnalysis({ samples, model }, model, {
      driverSkill: vehicleConfig.driverSkill
    }),
    violations,
    warnings
  };
}
