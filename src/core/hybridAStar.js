// Deterministic, dependency-free Hybrid A* for slow vehicle maneuvers.
// The pose origin is the rear axle. theta is the body heading in radians.

const TAU = Math.PI * 2;
const EPS = 1e-9;

function finite(value) {
  return Number.isFinite(Number(value));
}

function normalizeAngle(angle) {
  let result = angle % TAU;
  if (result > Math.PI) result -= TAU;
  if (result <= -Math.PI) result += TAU;
  return result;
}

function angleDifference(a, b) {
  return normalizeAngle(a - b);
}

function makePose(x, y, theta, reverse, steeringAngle) {
  return {
    x,
    y,
    theta: normalizeAngle(theta),
    reverse: Boolean(reverse),
    steeringAngle
  };
}

function validPose(pose) {
  return finite(pose?.x) && finite(pose?.y) && finite(pose?.theta);
}

function normalizeBounds(bounds) {
  if (!bounds) return null;
  const minX = Number(bounds.minX);
  const maxX = Number(bounds.maxX);
  const minY = Number(bounds.minY);
  const maxY = Number(bounds.maxY);
  if (![minX, maxX, minY, maxY].every(Number.isFinite)
    || minX > maxX || minY > maxY) return null;
  return { minX, maxX, minY, maxY };
}

function inBounds(pose, bounds) {
  return !bounds || (
    pose.x >= bounds.minX - EPS && pose.x <= bounds.maxX + EPS
    && pose.y >= bounds.minY - EPS && pose.y <= bounds.maxY + EPS
  );
}

function normalizeOptions(options = {}, wheelBaseM, maxSteerRad) {
  const steeringBinCount = Math.max(3, Math.floor(Number(options.steeringBinCount) || 5));
  const oddBinCount = steeringBinCount % 2 === 0 ? steeringBinCount + 1 : steeringBinCount;
  const stepM = Math.max(0.2, Number(options.stepM) || 1.0);
  const integrationStepM = Math.max(0.05, Math.min(stepM, Number(options.integrationStepM) || 0.25));
  const positionResolutionM = Math.max(0.05, Number(options.positionResolutionM) || stepM * 0.75);
  const headingResolutionRad = Math.max(
    Math.PI / 180,
    Number(options.headingResolutionRad) || Math.PI / 12
  );

  return {
    stepM,
    integrationStepM,
    steeringBinCount: oddBinCount,
    positionResolutionM,
    headingResolutionRad,
    goalPositionToleranceM: Math.max(0.05, Number(options.goalPositionToleranceM) || 1.2),
    goalHeadingToleranceRad: Math.max(
      Math.PI / 180,
      Number(options.goalHeadingToleranceRad) || (12 * Math.PI / 180)
    ),
    maxNodes: Math.max(1, Math.floor(Number(options.maxNodes) || 60000)),
    maxExpansions: Math.max(1, Math.floor(Number(options.maxExpansions) || 50000)),
    distanceCost: Math.max(0, Number(options.distanceCost) || 1),
    reverseCost: Math.max(0, Number(options.reverseCost) || 0.15),
    gearSwitchCost: Math.max(0, Number(options.gearSwitchCost) || 8),
    steeringChangeCost: Math.max(0, Number(options.steeringChangeCost) || 1.5),
    heuristicWeight: Math.max(0, Number(options.heuristicWeight) || 1),
    allowReverse: options.allowReverse !== false,
    allowForward: options.allowForward !== false,
    allowGearSwitch: options.allowGearSwitch !== false,
    maxSteeringChangeRad: finite(options.maxSteeringChangeRad)
      ? Math.max(0, Number(options.maxSteeringChangeRad))
      : Infinity,
    wheelBaseM,
    maxSteerRad
  };
}

function steeringAngles(maxSteerRad, count) {
  const angles = [];
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0 : i / (count - 1);
    angles.push(-maxSteerRad + (2 * maxSteerRad * t));
  }
  // Avoid a floating-point -0 and guarantee the center action is exactly zero.
  angles[Math.floor(count / 2)] = 0;
  return angles;
}

function quantize(value, resolution) {
  return Math.round(value / resolution);
}

function stateKey(node, opts) {
  const x = quantize(node.x, opts.positionResolutionM);
  const y = quantize(node.y, opts.positionResolutionM);
  const theta = quantize(normalizeAngle(node.theta), opts.headingResolutionRad);
  const steer = quantize(node.steeringAngle, Math.max(Math.PI / 1800, opts.maxSteerRad / 100));
  return `${x},${y},${theta},${node.reverse ? 1 : 0},${steer}`;
}

function integrateBicycle(pose, signedDistance, steeringAngle, wheelBaseM, distanceM) {
  const distance = Math.max(0, distanceM);
  if (distance <= EPS) return makePose(pose.x, pose.y, pose.theta, signedDistance < 0, steeringAngle);

  const curvature = Math.tan(steeringAngle) / wheelBaseM;
  const signedArc = signedDistance >= 0 ? distance : -distance;
  const deltaTheta = signedArc * curvature;
  if (Math.abs(curvature) < 1e-12) {
    return makePose(
      pose.x + signedArc * Math.cos(pose.theta),
      pose.y + signedArc * Math.sin(pose.theta),
      pose.theta,
      signedDistance < 0,
      steeringAngle
    );
  }

  const radius = 1 / curvature;
  return makePose(
    pose.x + radius * (Math.sin(pose.theta + deltaTheta) - Math.sin(pose.theta)),
    pose.y - radius * (Math.cos(pose.theta + deltaTheta) - Math.cos(pose.theta)),
    pose.theta + deltaTheta,
    signedDistance < 0,
    steeringAngle
  );
}

function simulatePrimitive(node, reverse, steeringAngle, opts) {
  const signedDistance = reverse ? -opts.stepM : opts.stepM;
  const sampleCount = Math.max(1, Math.ceil(opts.stepM / opts.integrationStepM));
  const samples = [];
  let current = makePose(node.x, node.y, node.theta, reverse, steeringAngle);
  const subDistance = opts.stepM / sampleCount;
  for (let i = 0; i < sampleCount; i++) {
    const next = integrateBicycle(current, reverse ? -subDistance : subDistance,
      steeringAngle, opts.wheelBaseM, subDistance);
    samples.push(next);
    current = next;
  }
  return { end: current, samples };
}

function primitiveCost(node, reverse, steeringAngle, opts) {
  return opts.stepM * (opts.distanceCost + (reverse ? opts.reverseCost : 0))
    + opts.steeringChangeCost * Math.abs(steeringAngle - node.steeringAngle);
}

function heuristic(node, goal, opts) {
  const distance = Math.hypot(goal.x - node.x, goal.y - node.y);
  const heading = Math.abs(angleDifference(goal.theta, node.theta));
  const radius = opts.wheelBaseM / Math.max(EPS, Math.tan(opts.maxSteerRad));
  return opts.heuristicWeight * (distance * opts.distanceCost + Math.min(distance, radius) * heading * 0.25);
}

function isGoal(node, goal, opts) {
  return Math.hypot(goal.x - node.x, goal.y - node.y) <= opts.goalPositionToleranceM
    && Math.abs(angleDifference(goal.theta, node.theta)) <= opts.goalHeadingToleranceRad;
}

class MinHeap {
  constructor() { this.items = []; }

  push(item) {
    const a = this.items;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const parent = Math.floor((i - 1) / 2);
      if (compareQueueItems(a[parent], item) <= 0) break;
      a[i] = a[parent];
      i = parent;
    }
    a[i] = item;
  }

  pop() {
    const a = this.items;
    if (!a.length) return null;
    const result = a[0];
    const last = a.pop();
    if (a.length && last) {
      let i = 0;
      while (true) {
        const left = i * 2 + 1;
        if (left >= a.length) break;
        const right = left + 1;
        let child = left;
        if (right < a.length && compareQueueItems(a[right], a[left]) < 0) child = right;
        if (compareQueueItems(a[child], last) >= 0) break;
        a[i] = a[child];
        i = child;
      }
      a[i] = last;
    }
    return result;
  }

  get size() { return this.items.length; }
}

function compareQueueItems(a, b) {
  return a.f - b.f || a.h - b.h || a.g - b.g || a.order - b.order;
}

function reconstructPath(node) {
  const segments = [];
  let current = node;
  while (current) {
    if (current.segment?.length) segments.push(current.segment);
    current = current.parent;
  }

  const poses = [makePose(node.root.x, node.root.y, node.root.theta, node.root.reverse, node.root.steeringAngle)];
  for (let i = segments.length - 1; i >= 0; i--) {
    for (const pose of segments[i]) {
      const previous = poses[poses.length - 1];
      // A gear-change edge is intentionally represented by a duplicate position.
      if (Math.hypot(previous.x - pose.x, previous.y - pose.y) > EPS
        || previous.reverse !== pose.reverse
        || Math.abs(previous.steeringAngle - pose.steeringAngle) > EPS) {
        poses.push({ ...pose });
      }
    }
  }
  return poses;
}

function collectMetrics(poses, goal, node, expandedNodes, generatedNodes, maxOpenSize, status) {
  let distanceM = 0;
  let reverseDistanceM = 0;
  let gearSwitches = 0;
  let steeringChanges = 0;
  let maxSteeringAngleRad = 0;
  for (let i = 0; i < poses.length; i++) {
    maxSteeringAngleRad = Math.max(maxSteeringAngleRad, Math.abs(poses[i].steeringAngle));
    if (i > 0) {
      const ds = Math.hypot(poses[i].x - poses[i - 1].x, poses[i].y - poses[i - 1].y);
      distanceM += ds;
      if (poses[i].reverse) reverseDistanceM += ds;
      if (poses[i].reverse !== poses[i - 1].reverse) gearSwitches++;
      if (Math.abs(poses[i].steeringAngle - poses[i - 1].steeringAngle) > EPS) steeringChanges++;
    }
  }
  return {
    status,
    expandedNodes,
    generatedNodes,
    maxOpenSize,
    poseCount: poses.length,
    distanceM,
    reverseDistanceM,
    gearSwitches,
    steeringChanges,
    maxSteeringAngleRad,
    cost: node?.g ?? null,
    goalPositionErrorM: poses.length ? Math.hypot(goal.x - poses[poses.length - 1].x, goal.y - poses[poses.length - 1].y) : null,
    goalHeadingErrorRad: poses.length ? Math.abs(angleDifference(goal.theta, poses[poses.length - 1].theta)) : null
  };
}

/**
 * Plan a low-speed forward/reverse maneuver with a kinematic bicycle Hybrid A*.
 * isPoseValid receives every integration sample, including the start pose.
 * bounds is { minX, maxX, minY, maxY } in the same local metric frame.
 */
export function planHybridAStarManeuver({
  start,
  goal,
  wheelBaseM,
  maxSteerRad,
  isPoseValid,
  bounds,
  options = {}
} = {}) {
  if (!validPose(start) || !validPose(goal) || !finite(wheelBaseM) || Number(wheelBaseM) <= 0
    || !finite(maxSteerRad) || Number(maxSteerRad) <= 0
    || Number(maxSteerRad) >= Math.PI / 2 || typeof isPoseValid !== 'function') return null;

  const wb = Number(wheelBaseM);
  const maxSteer = Math.abs(Number(maxSteerRad));
  const normalizedBounds = normalizeBounds(bounds);
  if (bounds && !normalizedBounds) return null;
  const opts = normalizeOptions(options, wb, maxSteer);
  const startPose = makePose(Number(start.x), Number(start.y), Number(start.theta), false, 0);
  const goalPose = makePose(Number(goal.x), Number(goal.y), Number(goal.theta), false, 0);

  const valid = (pose) => {
    if (!inBounds(pose, normalizedBounds)) return false;
    try { return Boolean(isPoseValid({ ...pose })); } catch (_error) { return false; }
  };
  if (!valid(startPose)) return null;

  const root = {
    root: startPose,
    x: startPose.x,
    y: startPose.y,
    theta: startPose.theta,
    reverse: false,
    steeringAngle: 0,
    g: 0,
    h: heuristic(startPose, goalPose, opts),
    f: heuristic(startPose, goalPose, opts),
    parent: null,
    segment: null,
    order: 0
  };
  const open = new MinHeap();
  open.push(root);
  const bestCost = new Map([[stateKey(root, opts), 0]]);
  const steering = steeringAngles(maxSteer, opts.steeringBinCount);
  let order = 1;
  let expandedNodes = 0;
  let generatedNodes = 1;
  let maxOpenSize = 1;
  let terminal = null;

  while (open.size && expandedNodes < opts.maxExpansions) {
    const node = open.pop();
    if (!node) break;
    const key = stateKey(node, opts);
    if (node.g > (bestCost.get(key) ?? Infinity) + EPS) continue;
    expandedNodes++;
    if (isGoal(node, goalPose, opts)) {
      terminal = node;
      break;
    }
    if (generatedNodes >= opts.maxNodes) continue;

    // Fixed successor ordering: same-gear steering primitives from left to right,
    // then the explicit stopped gear-change edge.
    const directions = (node.reverse && opts.allowReverse) || (!node.reverse && opts.allowForward)
      ? [node.reverse]
      : [];
    for (const reverse of directions) {
      for (const steeringAngle of steering) {
        if (Math.abs(steeringAngle - node.steeringAngle) > opts.maxSteeringChangeRad + EPS) continue;
        const simulated = simulatePrimitive(node, reverse, steeringAngle, opts);
        if (!simulated.samples.every(valid)) continue;
        const child = {
          root,
          x: simulated.end.x,
          y: simulated.end.y,
          theta: simulated.end.theta,
          reverse,
          steeringAngle,
          g: node.g + primitiveCost(node, reverse, steeringAngle, opts),
          h: heuristic(simulated.end, goalPose, opts),
          parent: node,
          segment: simulated.samples,
          order: order++
        };
        child.f = child.g + child.h;
        const childKey = stateKey(child, opts);
        if (child.g + EPS >= (bestCost.get(childKey) ?? Infinity)) continue;
        bestCost.set(childKey, child.g);
        open.push(child);
        generatedNodes++;
        if (generatedNodes >= opts.maxNodes) break;
      }
      if (generatedNodes >= opts.maxNodes) break;
    }

    if (opts.allowGearSwitch && generatedNodes < opts.maxNodes) {
      const switched = {
        root,
        x: node.x,
        y: node.y,
        theta: node.theta,
        reverse: !node.reverse,
        steeringAngle: node.steeringAngle,
        g: node.g + opts.gearSwitchCost,
        h: heuristic(node, goalPose, opts),
        parent: node,
        segment: [makePose(node.x, node.y, node.theta, !node.reverse, node.steeringAngle)],
        order: order++
      };
      switched.f = switched.g + switched.h;
      const switchedKey = stateKey(switched, opts);
      if (switched.g + EPS < (bestCost.get(switchedKey) ?? Infinity) && valid(switched.segment[0])) {
        bestCost.set(switchedKey, switched.g);
        open.push(switched);
        generatedNodes++;
      }
    }
    maxOpenSize = Math.max(maxOpenSize, open.size);
  }

  if (!terminal) return null;
  const poses = reconstructPath(terminal);
  return { poses, metrics: collectMetrics(poses, goalPose, terminal, expandedNodes, generatedNodes, maxOpenSize, 'success') };
}
