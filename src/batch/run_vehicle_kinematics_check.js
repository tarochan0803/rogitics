#!/usr/bin/env node
/**
 * Vehicle kinematics regression checks.
 *
 * Run: node src/batch/run_vehicle_kinematics_check.js
 *
 * Checks the public physics pose stream against the active vehicle presets.
 * Includes a signed-speed forward-to-reverse check using stepKinematicBicycle.
 */
'use strict';

const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..', '..');
const DT = 0.05;
const STEER_RATE_RAD_PER_S = 0.45; // physics.js: 0.0075 * 60
const EPS = 1e-6;

function angleDifference(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function foldedPath() {
  // A long lead-in makes the initial heading deterministic; the two corners
  // exercise both left and right steering without requesting an impossible arc.
  return [
    { x: -36, y: 0 }, { x: -12, y: 0 }, { x: 0, y: 0 },
    { x: 0, y: 24 }, { x: 24, y: 24 }, { x: 48, y: 24 }
  ];
}

function checkForwardKinematics(name, config, simulatePathPoses) {
  const poses = simulatePathPoses({ ...config }, foldedPath(), 0.1, { dt: DT, maxSteps: 30000 });
  assert(poses.length > 10, `${name}: insufficient poses (${poses.length})`);

  const maxSpeed = Number(config.vehicleSpeed);
  const wheelBase = Number(config.wheelBase);
  const maxSteer = Number(config.maxSteeringAngle) * Math.PI / 180;
  const minRadius = wheelBase / Math.tan(maxSteer);
  let maxLateralStep = 0;
  let maxSteerRate = 0;
  let observedMinRadius = Infinity;
  let maxYawMotionError = 0;

  for (let i = 1; i < poses.length; i++) {
    const previous = poses[i - 1];
    const current = poses[i];
    const dx = current.x - previous.x;
    const dy = current.y - previous.y;
    const distance = Math.hypot(dx, dy);
    const elapsed = current.timeS - previous.timeS;
    assert(elapsed >= -EPS, `${name}: non-monotonic pose time at ${i}`);

    // A pose may be emitted just after its stride threshold, so permit one
    // integration step beyond the configured stride, but no lateral jump.
    const lateral = Math.abs(-Math.sin(previous.theta) * dx + Math.cos(previous.theta) * dy);
    maxLateralStep = Math.max(maxLateralStep, lateral);
    assert(lateral <= 0.03 + EPS,
      `${name}: lateral teleport at ${i}: ${lateral.toFixed(4)}m`);
    assert(distance <= maxSpeed * elapsed + 0.03 + EPS,
      `${name}: position jump at ${i}: ${distance.toFixed(4)}m over ${elapsed.toFixed(3)}s`);

    if (elapsed > EPS) {
      const steerRate = Math.abs(current.steeringAngle - previous.steeringAngle) / elapsed;
      maxSteerRate = Math.max(maxSteerRate, steerRate);
      assert(steerRate <= STEER_RATE_RAD_PER_S + 1e-4,
        `${name}: steering-rate violation at ${i}: ${steerRate.toFixed(4)}rad/s`);
    }

    if (Math.abs(current.steeringAngle) > 1e-5) {
      const radius = Math.abs(wheelBase / Math.tan(current.steeringAngle));
      observedMinRadius = Math.min(observedMinRadius, radius);
      assert(radius + EPS >= minRadius,
        `${name}: turning-radius violation at ${i}: ${radius.toFixed(4)}m < ${minRadius.toFixed(4)}m`);
    }

    // Rear-axle velocity of a bicycle model must remain aligned with body yaw.
    // Ignore stopped samples, where a direction is undefined.
    if (distance > 0.01) {
      const motionYaw = Math.atan2(dy, dx);
      const yawError = Math.abs(angleDifference(motionYaw, previous.theta));
      maxYawMotionError = Math.max(maxYawMotionError, yawError);
      assert(yawError <= 0.08,
        `${name}: body yaw/motion mismatch at ${i}: ${(yawError * 180 / Math.PI).toFixed(2)}deg`);
    }
  }

  return { poses: poses.length, maxLateralStep, maxSteerRate, observedMinRadius, minRadius, maxYawMotionError };
}

function checkForwardToReverse(config, stepKinematicBicycle) {
  const wheelBase = Number(config.wheelBase);
  const targetSteeringAngle = 0.22;
  let state = { x: 0, y: 0, theta: 0, speedMS: 0, steeringAngle: 0, timeS: 0, travelM: 0 };
  const states = [state];

  // First establish forward travel, then request the opposite direction while
  // retaining steering so both position and yaw are exercised in reverse.
  for (let i = 0; i < 50; i++) {
    state = stepKinematicBicycle(config, state, { targetSpeedMS: 2.0, targetSteeringAngle }, DT);
    states.push(state);
  }
  for (let i = 0; i < 80; i++) {
    state = stepKinematicBicycle(config, state, { targetSpeedMS: -1.5, targetSteeringAngle }, DT);
    states.push(state);
  }

  const speeds = states.map((pose) => pose.speedMS);
  const firstReverse = speeds.findIndex((speed) => speed < -0.02);
  assert(speeds.some((speed) => speed > 0.02), 'forward command never produced forward speed');
  assert(firstReverse > 0, 'reverse command never produced reverse speed');
  assert(speeds.slice(0, firstReverse).some((speed) => Math.abs(speed) <= EPS),
    'direction change did not pass through zero speed');

  let maxReverseMotionYawError = 0;
  let reverseYawSteps = 0;
  for (let i = firstReverse; i < states.length; i++) {
    const previous = states[i - 1];
    const current = states[i];
    const dx = current.x - previous.x;
    const dy = current.y - previous.y;
    const distance = Math.hypot(dx, dy);
    if (distance <= EPS) continue;

    const motionYaw = Math.atan2(dy, dx);
    const reverseMotionYawError = Math.abs(angleDifference(motionYaw, previous.theta + Math.PI));
    maxReverseMotionYawError = Math.max(maxReverseMotionYawError, reverseMotionYawError);
    assert(reverseMotionYawError <= 0.01,
      `reverse position/yaw mismatch at ${i}: ${(reverseMotionYawError * 180 / Math.PI).toFixed(3)}deg`);

    const expectedYawDelta = ((previous.speedMS + current.speedMS) * 0.5 * DT / wheelBase)
      * Math.tan(current.steeringAngle);
    const yawDelta = angleDifference(current.theta, previous.theta);
    assert(Math.abs(yawDelta - expectedYawDelta) <= 1e-8,
      `reverse yaw integration mismatch at ${i}: expected ${expectedYawDelta}, got ${yawDelta}`);
    if (yawDelta < -EPS) reverseYawSteps++;
  }
  assert(reverseYawSteps > 0, 'reverse steering did not produce reverse-signed yaw updates');

  return { firstReverse, maxReverseMotionYawError, reverseYawSteps };
}

async function main() {
  const physics = await import(pathToFileURL(path.join(ROOT, 'src', 'core', 'physics.js')).href);
  const configModule = await import(pathToFileURL(path.join(ROOT, 'src', 'config.js')).href);
  const { simulatePathPoses, stepKinematicBicycle } = physics;
  const { VEHICLE_PRESETS, buildVehicleConfig } = configModule;
  let passed = 0;
  let failed = 0;

  for (const presetName of Object.keys(VEHICLE_PRESETS)) {
    try {
      const result = checkForwardKinematics(presetName, buildVehicleConfig(presetName), simulatePathPoses);
      console.log(`[PASS] ${presetName}: poses=${result.poses}, lateral<=${result.maxLateralStep.toFixed(4)}m, `
        + `radius>=${result.observedMinRadius.toFixed(3)}m (limit ${result.minRadius.toFixed(3)}m), `
        + `steerRate<=${result.maxSteerRate.toFixed(3)}rad/s, yaw/motion<=${(result.maxYawMotionError * 180 / Math.PI).toFixed(2)}deg`);
      passed++;
    } catch (error) {
      console.error(`[FAIL] ${presetName}: ${error.message}`);
      failed++;
    }
  }

  try {
    const result = checkForwardToReverse(buildVehicleConfig('4t_flat'), stepKinematicBicycle);
    console.log('[PASS] forward-to-reverse through zero: '
      + `reverse starts at tick ${result.firstReverse}, `
      + `reverse yaw/motion<=${(result.maxReverseMotionYawError * 180 / Math.PI).toFixed(3)}deg, `
      + `reverse yaw steps=${result.reverseYawSteps}`);
    passed++;
  } catch (error) {
    console.error(`[FAIL] forward-to-reverse through zero: ${error.message}`);
    failed++;
  }

  console.log(`Vehicle kinematics: ${passed} passed, ${failed} failed.`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((error) => {
  console.error(`[FAIL] setup: ${error.stack || error.message}`);
  process.exitCode = 1;
});
