import { getRearAxleMinTurnRadius, getRouteTrackingTurnRadius } from '../config.js';

function finiteNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function normalizeVehicleModel(vehicleConfig = {}) {
  const wheelBase = Math.max(0.5, finiteNumber(vehicleConfig.wheelBase, 3.4));
  const frontOverhang = Math.max(0, finiteNumber(vehicleConfig.frontOverhang, 1.1));
  const rearOverhang = Math.max(0, finiteNumber(vehicleConfig.rearOverhang, 1.5));
  const vehicleWidth = Math.max(0.8, finiteNumber(vehicleConfig.vehicleWidth, 2.0));
  const vehicleHeight = Math.max(0, finiteNumber(vehicleConfig.vehicleHeight, 2.5));
  const grossWeight = Math.max(0, finiteNumber(vehicleConfig.grossWeight, 8.0));
  const totalLength = wheelBase + frontOverhang + rearOverhang;
  const configuredSpeed = finiteNumber(vehicleConfig.vehicleSpeed, 3.5);
  const maxSpeed = Math.max(0.5, Math.min(8.0, configuredSpeed));
  const heavyFactor = grossWeight >= 20 ? 0.78 : (grossWeight >= 8 ? 0.88 : 1.0);

  const rearAxleMinTurnRadius = getRearAxleMinTurnRadius(vehicleConfig);
  const routeTrackingMinTurnRadius = getRouteTrackingTurnRadius(vehicleConfig);
  const templateTurnRadius = finiteNumber(vehicleConfig.templateTurnRadius, routeTrackingMinTurnRadius || 6.0);
  const minTurnRadius = Math.max(
    0.5,
    routeTrackingMinTurnRadius || rearAxleMinTurnRadius || templateTurnRadius || 6.0
  );

  return {
    ...vehicleConfig,
    wheelBase,
    frontOverhang,
    rearOverhang,
    vehicleWidth,
    vehicleHeight,
    grossWeight,
    totalLength,
    maxSpeed,
    crawlSpeed: Math.max(0.35, finiteNumber(vehicleConfig.crawlSpeed, 0.65)),
    maxDecel: Math.max(0.6, finiteNumber(vehicleConfig.maxDecel, 2.2 * heavyFactor)),
    maxAccel: Math.max(0.4, finiteNumber(vehicleConfig.maxAccel, 1.2 * heavyFactor)),
    maxLatAccel: Math.max(0.35, finiteNumber(vehicleConfig.maxLatAccel, 1.15 * heavyFactor)),
    maxJerk: Math.max(0.2, finiteNumber(vehicleConfig.maxJerk, 1.2 * heavyFactor)),
    maxSteeringAngleDeg: Math.max(1, finiteNumber(vehicleConfig.maxSteeringAngle, 40)),
    rearAxleMinTurnRadius,
    routeTrackingMinTurnRadius,
    templateTurnRadius,
    minTurnRadius
  };
}

export function footprintConfig(model) {
  return {
    wheelBase: model.wheelBase,
    vehicleWidth: model.vehicleWidth,
    frontOverhang: model.frontOverhang,
    rearOverhang: model.rearOverhang
  };
}
