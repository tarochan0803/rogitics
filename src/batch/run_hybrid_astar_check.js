#!/usr/bin/env node
/**
 * Deterministic regression checks for the dependency-free Hybrid A* maneuver planner.
 * Run from the repository root: node src/batch/run_hybrid_astar_check.js
 */
'use strict';

const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..', '..');
const DEG = Math.PI / 180;
const EPS = 1e-7;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function angleDifference(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d <= -Math.PI) d += Math.PI * 2;
  return d;
}

function rectangle(minX, minY, maxX, maxY) {
  return (x, y) => x >= minX && x <= maxX && y >= minY && y <= maxY;
}

function makeValidity({ obstacles = [], bounds }) {
  return (pose) => {
    if (bounds && (pose.x < bounds.minX || pose.x > bounds.maxX
      || pose.y < bounds.minY || pose.y > bounds.maxY)) return false;
    return !obstacles.some((blocked) => blocked(pose.x, pose.y));
  };
}

function checkPoseContract(result, start, goal, wheelBaseM, maxSteerRad, isPoseValid) {
  assert(result && Array.isArray(result.poses) && result.poses.length > 1, 'planner returned no usable pose stream');
  assert(result.poses[0].x === start.x && result.poses[0].y === start.y,
    'pose stream does not begin at start');
  const last = result.poses[result.poses.length - 1];
  assert(Math.hypot(last.x - goal.x, last.y - goal.y) <= 1.2 + EPS, 'goal position tolerance exceeded');
  assert(Math.abs(angleDifference(last.theta, goal.theta)) <= 12 * DEG + EPS,
    'goal heading tolerance exceeded');

  const minRadius = wheelBaseM / Math.tan(maxSteerRad);
  let gearSwitches = 0;
  for (let i = 1; i < result.poses.length; i++) {
    const previous = result.poses[i - 1];
    const current = result.poses[i];
    for (const key of ['x', 'y', 'theta', 'reverse', 'steeringAngle']) {
      assert(Object.prototype.hasOwnProperty.call(current, key), `pose ${i} missing ${key}`);
    }
    assert(Math.abs(current.steeringAngle) <= maxSteerRad + EPS, `steering limit exceeded at ${i}`);
    assert(isPoseValid(current), `invalid pose returned at ${i}`);
    if (current.reverse !== previous.reverse) gearSwitches++;
    const distance = Math.hypot(current.x - previous.x, current.y - previous.y);
    if (distance <= EPS) continue;
    const signedDistance = current.reverse ? -distance : distance;
    const curvature = Math.tan(current.steeringAngle) / wheelBaseM;
    const chordArgument = Math.max(-1, Math.min(1, signedDistance * curvature * 0.5));
    const expectedYawDelta = Math.abs(curvature) < 1e-12
      ? 0
      : 2 * Math.asin(chordArgument);
    const yawDelta = angleDifference(current.theta, previous.theta);
    assert(Math.abs(yawDelta - expectedYawDelta) <= 2e-6,
      `bicycle yaw mismatch at ${i}: expected ${expectedYawDelta}, got ${yawDelta}`);
    if (Math.abs(current.steeringAngle) > 1e-5) {
      const radius = Math.abs(wheelBaseM / Math.tan(current.steeringAngle));
      assert(radius + EPS >= minRadius, `minimum turning radius violated at ${i}`);
    }
    // The signed displacement is tangent to the body heading; the small residual
    // is the expected chord error of an exact circular arc, not lateral sliding.
    const lateralChord = Math.abs(-Math.sin(previous.theta) * (current.x - previous.x)
      + Math.cos(previous.theta) * (current.y - previous.y));
    assert(lateralChord <= distance * distance / Math.max(2 * minRadius, 1) + 0.002,
      `lateral-sliding residual too large at ${i}`);
    const longitudinal = Math.cos(previous.theta) * (current.x - previous.x)
      + Math.sin(previous.theta) * (current.y - previous.y);
    assert((current.reverse ? longitudinal < 0 : longitudinal > 0) || distance < 0.01,
      `motion direction mismatch at ${i}`);
  }
  assert(gearSwitches >= 2, `expected multiple gear switches, got ${gearSwitches}`);
}

function buildTightEntranceCase() {
  const bounds = { minX: -15, maxX: 15, minY: -15, maxY: 15 };
  // The west approach, central blocks, and upper wall form a narrow 90-degree
  // entrance. The free bays require forward, reverse, forward, reverse motion.
  const obstacles = [
    rectangle(1.0, 3.0, 5.0, 9.0),
    rectangle(-7.0, 2.0, -1.0, 4.0),
    rectangle(-8.0, 3.0, -2.0, 7.0),
    rectangle(0.0, 0.0, 4.0, 4.0),
    rectangle(-7.0, 8.0, -4.0, 12.0)
  ];
  return {
    bounds,
    obstacles,
    start: { x: -9.0, y: 3.0, theta: 0 },
    goal: { x: 9.0, y: 5.0, theta: 90 * DEG }
  };
}

async function main() {
  const { planHybridAStarManeuver } = await import(
    pathToFileURL(path.join(ROOT, 'src', 'core', 'hybridAStar.js')).href
  );
  let passed = 0;
  let failed = 0;

  try {
    const wheelBaseM = 4.2;
    const maxSteerRad = 32 * DEG;
    const scenario = buildTightEntranceCase();
    const result = planHybridAStarManeuver({
      ...scenario,
      wheelBaseM,
      maxSteerRad,
      isPoseValid: makeValidity(scenario),
      options: {
        stepM: 0.8,
        integrationStepM: 0.1,
        steeringBinCount: 7,
        positionResolutionM: 0.6,
        headingResolutionRad: 10 * DEG,
        maxNodes: 90000,
        maxExpansions: 70000,
        gearSwitchCost: 5,
        steeringChangeCost: 0.8
      }
    });
    checkPoseContract(result, scenario.start, scenario.goal, wheelBaseM, maxSteerRad, makeValidity(scenario));
    assert(result.metrics.gearSwitches >= 2, 'tight entrance did not require repeated reversing');
    assert(result.metrics.reverseDistanceM > 1, 'tight entrance did not use reverse travel');
    console.log(`[PASS] tight 4t entrance: poses=${result.poses.length}, gears=${result.metrics.gearSwitches}, `
      + `reverse=${result.metrics.reverseDistanceM.toFixed(2)}m, expanded=${result.metrics.expandedNodes}`);
    passed++;
  } catch (error) {
    console.error(`[FAIL] tight 4t entrance: ${error.message}`);
    failed++;
  }

  try {
    const bounds = { minX: -4, maxX: 14, minY: -4, maxY: 4 };
    const obstacle = rectangle(2.0, -1.2, 8.0, 1.2);
    const start = { x: -2, y: 2.8, theta: 0 };
    const goal = { x: 11, y: -2.8, theta: 0 };
    const result = planHybridAStarManeuver({
      start,
      goal,
      wheelBaseM: 3.4,
      maxSteerRad: 30 * DEG,
      bounds,
      isPoseValid: makeValidity({ bounds, obstacles: [obstacle] }),
      options: { stepM: 0.7, integrationStepM: 0.1, steeringBinCount: 5, maxNodes: 50000 }
    });
    assert(result, 'obstacle case unexpectedly failed');
    assert(result.poses.every((pose) => !obstacle(pose.x, pose.y)), 'obstacle was intersected');
    console.log(`[PASS] obstacle avoidance: poses=${result.poses.length}, expanded=${result.metrics.expandedNodes}`);
    passed++;
  } catch (error) {
    console.error(`[FAIL] obstacle avoidance: ${error.message}`);
    failed++;
  }

  try {
    const input = {
      start: { x: 0, y: 0, theta: 0 },
      goal: { x: 20, y: 0, theta: 0 },
      wheelBaseM: 4,
      maxSteerRad: 28 * DEG,
      bounds: { minX: -2, maxX: 22, minY: -2, maxY: 2 },
      isPoseValid: () => true,
      options: { stepM: 1, integrationStepM: 0.1, steeringBinCount: 5, maxNodes: 15000 }
    };
    const first = planHybridAStarManeuver(input);
    const second = planHybridAStarManeuver(input);
    assert(JSON.stringify(first) === JSON.stringify(second), 'planner output is not deterministic');
    console.log(`[PASS] deterministic repeatability: poses=${first.poses.length}, cost=${first.metrics.cost.toFixed(3)}`);
    passed++;
  } catch (error) {
    console.error(`[FAIL] deterministic repeatability: ${error.message}`);
    failed++;
  }

  console.log(`Hybrid A*: ${passed} passed, ${failed} failed.`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((error) => {
  console.error(`[FAIL] setup: ${error.stack || error.message}`);
  process.exitCode = 1;
});
