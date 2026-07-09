import { fullRoadRoute, pruneTinyLoops, removeRouteHooks, densifyRouteLL } from './graph.js';
import { turf } from '../utils/geo.js';
import { getRouteTrackingTurnRadius } from '../config.js';

function toPointFeature(value) {
  if (!value) return null;
  if (value.type === 'Feature') return value;
  if (value.type === 'Point') return { type: 'Feature', properties: {}, geometry: value };
  if (typeof value.lat === 'number' && typeof value.lng === 'number') {
    return { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [value.lng, value.lat] } };
  }
  return null;
}

function normalizeContactPoints(contactPoints) {
  if (!contactPoints) return [];
  if (Array.isArray(contactPoints)) {
    return contactPoints.map(toPointFeature).filter(Boolean);
  }
  if (contactPoints.type === 'FeatureCollection') {
    return (contactPoints.features || []).map(toPointFeature).filter(Boolean);
  }
  const single = toPointFeature(contactPoints);
  return single ? [single] : [];
}

function computeRouteDistances(routeLL) {
  const cum = [0];
  for (let i = 1; i < routeLL.length; i++) {
    const a = routeLL[i - 1];
    const b = routeLL[i];
    let d = 0;
    try {
      d = turf.distance([a.lng, a.lat], [b.lng, b.lat], { units: 'kilometers' }) * 1000;
    } catch (e) {
      d = 0;
    }
    cum[i] = cum[i - 1] + (Number.isFinite(d) ? d : 0);
  }
  return cum;
}

function routeLengthMeters(routeLL) {
  if (!Array.isArray(routeLL) || routeLL.length < 2) return Infinity;
  try {
    const line = turf.lineString(routeLL.map((p) => [p.lng, p.lat]));
    const len = turf.length(line, { units: 'kilometers' }) * 1000;
    return Number.isFinite(len) ? len : Infinity;
  } catch (e) {
    return Infinity;
  }
}

function findIndexAtDistance(cum, distM) {
  if (!cum || !cum.length) return 0;
  if (distM <= 0) return 0;
  const last = cum[cum.length - 1];
  if (distM >= last) return cum.length - 1;
  for (let i = 1; i < cum.length; i++) {
    if (cum[i] >= distM) return i;
  }
  return cum.length - 1;
}

export function identifyCollisionSegments(contactPoints, simRoute, groupDistanceM = 15, bufferMeters = 20) {
  if (!simRoute || simRoute.length < 2) return [];
  const contacts = normalizeContactPoints(contactPoints);
  if (!contacts.length) return [];

  const line = turf.lineString(simRoute.map((p) => [p.lng, p.lat]));
  const totalLenM = turf.length(line, { units: 'kilometers' }) * 1000;
  const cum = computeRouteDistances(simRoute);

  const locs = [];
  contacts.forEach((pt) => {
    let snap = null;
    try {
      snap = turf.nearestPointOnLine(line, pt, { units: 'meters' });
    } catch (e) {
      snap = null;
    }
    if (!snap) return;
    let loc = Number(snap.properties?.location);
    if (!Number.isFinite(loc)) return;
    if (loc > totalLenM * 1.5) loc *= 1000;
    loc = Math.max(0, Math.min(totalLenM, loc));
    locs.push(loc);
  });
  if (!locs.length) return [];

  locs.sort((a, b) => a - b);
  const clusters = [];
  let cur = [locs[0]];
  for (let i = 1; i < locs.length; i++) {
    const v = locs[i];
    if (v - cur[cur.length - 1] <= groupDistanceM) {
      cur.push(v);
    } else {
      clusters.push(cur);
      cur = [v];
    }
  }
  clusters.push(cur);

  return clusters.map((group) => {
    const startDist = Math.max(0, group[0] - bufferMeters);
    const endDist = Math.min(totalLenM, group[group.length - 1] + bufferMeters);
    const startIdx = findIndexAtDistance(cum, startDist);
    const endIdx = Math.max(startIdx + 1, findIndexAtDistance(cum, endDist));
    return {
      startIdx,
      endIdx,
      startDist,
      endDist,
      contactCount: group.length
    };
  });
}

function isHeightOnlyFeature(feature) {
  const v = feature?.properties?.heightOnly;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v === 1;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    return s === '1' || s === 'true' || s === 'yes';
  }
  return false;
}

function filterRoadsByPolygons(roads, polygons) {
  const arr = Array.isArray(roads) ? roads : [];
  const polys = Array.isArray(polygons) ? polygons.filter(Boolean) : [];
  if (!polys.length) return arr;
  if (typeof turf?.bbox !== 'function' || typeof turf?.booleanIntersects !== 'function') return arr;

  const polyBboxes = polys.map((p) => {
    try {
      return turf.bbox(p);
    } catch (e) {
      return null;
    }
  });

  const out = [];
  for (const f of arr) {
    const g = f?.geometry;
    if (!g) {
      out.push(f);
      continue;
    }
    let fb = null;
    try {
      fb = turf.bbox(f);
    } catch (e) {
      out.push(f);
      continue;
    }
    let blocked = false;
    for (let i = 0; i < polys.length; i++) {
      const pb = polyBboxes[i];
      if (pb && fb && (fb[0] > pb[2] || fb[2] < pb[0] || fb[1] > pb[3] || fb[3] < pb[1])) continue;
      try {
        if (turf.booleanIntersects(f, polys[i])) {
          blocked = true;
          break;
        }
      } catch (e) {}
    }
    if (!blocked) out.push(f);
  }
  return out;
}

export function localReroute(segmentStartIdx, segmentEndIdx, simRoute, geoJsonDataSets, vehicleConfig, maskEdits, obstacleBuffer = 8) {
  if (!simRoute || simRoute.length < 2) return null;
  if (!geoJsonDataSets || !geoJsonDataSets.length) return null;
  const startIdx = Math.max(0, Math.min(simRoute.length - 2, Number(segmentStartIdx)));
  const endIdx = Math.max(startIdx + 1, Math.min(simRoute.length - 1, Number(segmentEndIdx)));
  const start = simRoute[startIdx];
  const end = simRoute[endIdx];
  if (!start || !end) return null;
  if (!Number.isFinite(start.lat) || !Number.isFinite(start.lng) ||
      !Number.isFinite(end.lat) || !Number.isFinite(end.lng)) return null;
  // セグメントが短すぎる場合は迂回できないためスキップ
  if (endIdx - startIdx < 2 && simRoute.length > 4) return null;

  let block = null;
  try {
    const line = turf.lineString(simRoute.slice(startIdx, endIdx + 1).map((p) => [p.lng, p.lat]));
    block = turf.buffer(line, Math.max(3, Number(obstacleBuffer) || 8), { units: 'meters', steps: 6 });
  } catch (e) {
    block = null;
  }

  const denyRaw = Array.isArray(maskEdits?.deny) ? maskEdits.deny : [];
  const denyPolys = denyRaw.filter((f) => f?.geometry && !isHeightOnlyFeature(f));
  const tempBlocks = block ? [...denyPolys, block] : denyPolys;
  const routingRoads = filterRoadsByPolygons(geoJsonDataSets, tempBlocks);

  const widthMargin = Math.max(0, Number(vehicleConfig?.widthMargin ?? 0));
  const vehicleWidth = Math.max(0, Number(vehicleConfig?.vehicleWidth ?? 0));
  const minRoadWidth = vehicleWidth > 0 ? vehicleWidth + widthMargin * 2 : 0;
  const opts = {
    forbidUTurn: true,
    uTurnAngle: 165,
    turnCostK: 0.8,
    graphOptions: {
      ignoreOneway: false,
      vehicleHeight: vehicleConfig?.vehicleHeight,
      vehicleWeight: vehicleConfig?.grossWeight,
      vehicleWidth,
      minRoadWidth
    },
    geoJsonDataSets: routingRoads
  };

  const rerouted = fullRoadRoute([start, end], opts, routingRoads);
  if (!rerouted || rerouted.length < 2) return null;
  return { route: rerouted, blockedArea: block };
}

function postProcessRoute(routeLL, vehicleConfig) {
  if (!routeLL || routeLL.length < 2) return routeLL;
  const lookback = Math.max(20, getRouteTrackingTurnRadius(vehicleConfig) * 2.0);
  let out = pruneTinyLoops(routeLL, 0.9, 160);
  out = removeRouteHooks(out, lookback);
  out = pruneTinyLoops(out, 0.9, 160);
  out = densifyRouteLL(out, 1.5);
  return out;
}

export function adjustRouteAroundCollisions({
  simRoute,
  contactPoints,
  vehicleConfig,
  geoJsonDataSets,
  maskEdits,
  maxIterations = 3,
  groupDistanceM = 15,
  segmentBufferM = 20,
  obstacleBufferM = 8,
  collisionCheck = null
} = {}) {
  if (!simRoute || simRoute.length < 2 || !vehicleConfig) {
    return { ok: false, reason: 'route_or_vehicle_missing', route: simRoute || [], adjustments: [] };
  }
  if (!geoJsonDataSets || !geoJsonDataSets.length) {
    return { ok: false, reason: 'roads_missing', route: simRoute, adjustments: [] };
  }

  let currentRoute = simRoute.map((p) => ({ ...p }));
  let contacts = normalizeContactPoints(contactPoints);
  let remainingContactCount = contacts.length;
  const adjustments = [];
  let iterations = 0;
  let needsRecheck = false;

  for (let i = 0; i < Math.max(1, Number(maxIterations) || 1); i++) {
    iterations = i + 1;
    if (!contacts.length) break;
    const segments = identifyCollisionSegments(contacts, currentRoute, groupDistanceM, segmentBufferM);
    if (!segments.length) break;

    const seg = segments[0];
    const currentContactCount = Math.max(contacts.length, remainingContactCount);
    const bufferBase = Math.max(3, Number(obstacleBufferM) || 8);
    const bufferAttempts = [...new Set([
      Number((bufferBase * 0.6).toFixed(1)),
      Number(bufferBase.toFixed(1)),
      Number((bufferBase * 1.6).toFixed(1)),
      Number((bufferBase * 2.4).toFixed(1)),
      Number((bufferBase * 3.2).toFixed(1))
    ])].filter((v) => Number.isFinite(v) && v > 0);

    let best = null;
    const attempts = [];

    for (const bufferM of bufferAttempts) {
      const reroute = localReroute(seg.startIdx, seg.endIdx, currentRoute, geoJsonDataSets, vehicleConfig, maskEdits, bufferM);
      if (!reroute || !reroute.route || reroute.route.length < 2) {
        attempts.push({ bufferM, ok: false, reason: 'reroute_failed' });
        continue;
      }

      const before = currentRoute.slice(0, seg.startIdx);
      const after = currentRoute.slice(seg.endIdx + 1);
      const mid = reroute.route.slice();
      if (mid.length > 1) {
        if (before.length) mid.shift();
        if (after.length) mid.pop();
      }
      const candidateRoute = postProcessRoute([...before, ...mid, ...after], vehicleConfig);

      let nextContacts = contacts;
      let contactCount = currentContactCount;
      let recheckFailed = false;
      if (typeof collisionCheck === 'function') {
        try {
          const res = collisionCheck(candidateRoute);
          nextContacts = normalizeContactPoints(res?.contactPoints ?? res);
          contactCount = nextContacts.length;
        } catch (e) {
          recheckFailed = true;
          needsRecheck = true;
        }
      } else {
        needsRecheck = true;
      }

      const distanceMeters = routeLengthMeters(candidateRoute);
      const attempt = {
        bufferM,
        ok: !recheckFailed,
        contactCount,
        distanceMeters: Number.isFinite(distanceMeters) ? Math.round(distanceMeters) : null,
        routePointCount: candidateRoute.length
      };
      attempts.push(attempt);

      const score = (contactCount * 100000) + (Number.isFinite(distanceMeters) ? distanceMeters : 999999);
      if (!best || score < best.score) {
        best = {
          route: candidateRoute,
          contacts: nextContacts,
          contactCount,
          score,
          bufferM,
          reroute,
          attempt
        };
      }

      if (contactCount === 0) break;
    }

    if (!best) {
      return {
        ok: false,
        reason: 'reroute_failed',
        route: currentRoute,
        adjustments,
        iterations,
        lastContactPoints: contacts,
        attemptedSegments: [{ ...seg, attempts }]
      };
    }

    if (typeof collisionCheck === 'function' && best.contactCount >= currentContactCount) {
      return {
        ok: false,
        reason: 'no_improving_reroute',
        route: currentRoute,
        adjustments,
        iterations,
        lastContactPoints: contacts,
        attemptedSegments: [{ ...seg, attempts }]
      };
    }

    currentRoute = best.route;
    remainingContactCount = best.contactCount;
    adjustments.push({
      ...seg,
      replacedCount: seg.endIdx - seg.startIdx + 1,
      newCount: best.reroute.route.length,
      selectedBufferM: best.bufferM,
      remainingContactCount: best.contactCount,
      attempts,
      blockedArea: best.reroute.blockedArea
    });

    contacts = best.contacts;
    if (needsRecheck) break;
  }

  const ok = !contacts.length && remainingContactCount === 0;
  return {
    ok,
    route: currentRoute,
    adjustments,
    iterations,
    lastContactPoints: contacts,
    needsRecheck
  };
}
