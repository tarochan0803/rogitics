import { getVehicleEnvelope } from '../3d/clearanceSolids.js';

export const REGULATION_TYPES = Object.freeze({
  ONEWAY: 'oneway',
  ACCESS: 'access',
  NO_TRUCK: 'no_truck',
  MAX_HEIGHT: 'max_height',
  MAX_WIDTH: 'max_width',
  MAX_WEIGHT: 'max_weight',
  TIME_RESTRICTION: 'time_restriction',
  TURN_RESTRICTION: 'turn_restriction',
  PRIVATE_ROAD: 'private_road',
  DESIGNATED_ROAD: 'designated_road',
  LEDGER_WIDTH: 'ledger_width'
});

export const REGULATION_SEVERITY = Object.freeze({
  BLOCK: 'block',
  PERMIT_REQUIRED: 'permit_required',
  WARNING: 'warning',
  INFO: 'info',
  UNKNOWN: 'unknown'
});

const STATUS_RANK = {
  pass: 0,
  warning: 1,
  permit_required: 2,
  blocked: 3,
  unknown: 1
};

const DEFAULT_CORRIDOR_M = 10;
const ONEWAY_REVERSE_THRESHOLD_DEG = 105;

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function parseMetersFromValue(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const str = String(value).trim().toLowerCase();
  if (!str || str === 'none' || str === 'no') return null;
  const feetInch = str.match(/^(\d+(?:\.\d+)?)'\s*(\d+(?:\.\d+)?)?\"?$/);
  if (feetInch) {
    const ft = Number(feetInch[1]);
    const inch = Number(feetInch[2] || '0');
    return ft * 0.3048 + inch * 0.0254;
  }
  const match = str.match(/([0-9]+(?:\.[0-9]+)?)\s*(m|meter|meters)?/);
  if (!match) return null;
  return finiteNumber(match[1]);
}

export function parseTonsFromValue(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const str = String(value).trim().toLowerCase();
  if (!str || str === 'none' || str === 'no') return null;
  const match = str.match(/([0-9]+(?:\.[0-9]+)?)\s*(t|ton|tons)?/);
  if (!match) return null;
  return finiteNumber(match[1]);
}

function normalizeSeverity(value) {
  const raw = String(value || '').toLowerCase();
  return Object.values(REGULATION_SEVERITY).includes(raw)
    ? raw
    : REGULATION_SEVERITY.INFO;
}

// 決定論規約: IDなし規制のfallbackに乱数を使わない（判定ログ・golden・リプレイ再現性が
// 揺れるため）。source/type/value/geometry 等の内容から安定ハッシュでIDを生成する。
function fnv1aHex(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function canonicalJson(value) {
  if (value == null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value ?? null);
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
  }
  return 'null';
}

export function stableRegulationId(input = {}, type = '') {
  const source = input.source || 'unknown';
  const body = canonicalJson({
    type,
    source,
    geometry: input.geometry || null,
    value: input.value || {},
    direction: input.direction || null,
    schedule: input.schedule || null,
    appliesTo: input.appliesTo || null
  });
  return `${source}:${type}:${fnv1aHex(body)}`;
}

export function normalizeRegulation(input = {}) {
  const type = String(input.type || '').trim();
  if (!type) return null;
  return {
    id: String(input.id || stableRegulationId(input, type)),
    type,
    geometry: input.geometry || null,
    appliesTo: input.appliesTo || null,
    value: input.value || {},
    direction: input.direction || null,
    schedule: input.schedule || null,
    conditional: !!input.conditional,
    severity: normalizeSeverity(input.severity),
    source: input.source || 'unknown',
    sourceFeatureId: input.sourceFeatureId || null,
    confidence: Number.isFinite(Number(input.confidence))
      ? Math.max(0, Math.min(1, Number(input.confidence)))
      : 0.5,
    authority: input.authority || input.source || 'unknown',
    evidence: input.evidence || null,
    updatedAt: input.updatedAt || null,
    feature: input.feature || null
  };
}

function vehicleMetrics(vehicleConfig = {}, context = {}) {
  const envelope = getVehicleEnvelope({
    vehicleConfig,
    cargoLoadType: context.cargoLoadType,
    cargoCount: context.cargoCount
  }, {
    clearanceMargin: context.clearanceMargin
  });
  const grossWeight = finiteNumber(vehicleConfig.grossWeight)
    ?? finiteNumber(vehicleConfig.vehicleWeight)
    ?? finiteNumber(vehicleConfig.weight)
    ?? 0;
  return {
    widthM: Math.max(0, Number(envelope.vehicleWidthM) || Number(vehicleConfig.vehicleWidth) || 0),
    physicalHeightM: Math.max(0, Number(envelope.physicalHeightM) || Number(vehicleConfig.vehicleHeight) || 0),
    requiredHeightM: Math.max(0, Number(envelope.requiredHeightM) || Number(vehicleConfig.vehicleHeight) || 0),
    grossWeightT: Math.max(0, grossWeight)
  };
}

export function appliesToVehicle(regulation, vehicleConfig = {}, context = {}) {
  if (!regulation) return false;
  const scope = regulation.appliesTo || {};
  if (scope.hgv === false && context.vehicleClass === 'hgv') return false;
  if (scope.vehicle === false || scope.motorVehicle === false) return false;
  return true;
}

function makeIssue(regulation, severity, reasonCode, message, match = null, extra = {}) {
  return {
    id: regulation.id,
    type: regulation.type,
    severity,
    reasonCode,
    message,
    source: regulation.source,
    sourceFeatureId: regulation.sourceFeatureId,
    confidence: regulation.confidence,
    authority: regulation.authority,
    evidence: regulation.evidence,
    rawValue: regulation.value?.raw ?? null,
    value: regulation.value || null,
    atM: Number.isFinite(match?.atM) ? Number(match.atM.toFixed(1)) : null,
    latLng: match?.latLng || null,
    routeBearing: Number.isFinite(match?.routeBearing) ? Number(match.routeBearing.toFixed(1)) : null,
    featureBearing: Number.isFinite(match?.featureBearing) ? Number(match.featureBearing.toFixed(1)) : null,
    distanceM: Number.isFinite(match?.distanceM) ? Number(match.distanceM.toFixed(1)) : null,
    ...extra
  };
}

export function evaluateRegulation(regulation, vehicleConfig = {}, context = {}) {
  if (!regulation || !appliesToVehicle(regulation, vehicleConfig, context)) return null;
  const permitMode = !!context.permitMode;
  const m = vehicleMetrics(vehicleConfig, context);
  const match = context.match || null;

  if (regulation.conditional) {
    return makeIssue(
      regulation,
      REGULATION_SEVERITY.WARNING,
      'conditional_regulation_unparsed',
      'Conditional regulation exists and needs manual confirmation.',
      match
    );
  }

  switch (regulation.type) {
    case REGULATION_TYPES.ONEWAY: {
      if (!context.directionViolation) return null;
      return makeIssue(
        regulation,
        permitMode ? REGULATION_SEVERITY.PERMIT_REQUIRED : REGULATION_SEVERITY.BLOCK,
        'oneway_reverse',
        permitMode ? 'Route uses a one-way road in reverse direction; permission is required.' : 'Route violates one-way direction.',
        match
      );
    }
    case REGULATION_TYPES.ACCESS: {
      const raw = String(regulation.value?.raw || '').toLowerCase();
      if (raw === 'no') {
        return makeIssue(regulation, REGULATION_SEVERITY.BLOCK, 'access_no', 'Road access is prohibited.', match);
      }
      if (raw === 'private' || raw === 'destination' || raw === 'delivery') {
        return makeIssue(
          regulation,
          permitMode ? REGULATION_SEVERITY.WARNING : REGULATION_SEVERITY.PERMIT_REQUIRED,
          `access_${raw}`,
          `Road access is ${raw}; confirmation or permission is required.`,
          match
        );
      }
      return null;
    }
    case REGULATION_TYPES.NO_TRUCK: {
      const raw = String(regulation.value?.raw || '').toLowerCase();
      if (raw === 'destination' || raw === 'private') {
        return makeIssue(
          regulation,
          permitMode ? REGULATION_SEVERITY.WARNING : REGULATION_SEVERITY.PERMIT_REQUIRED,
          `truck_${raw}`,
          `Truck access is ${raw}; confirmation or permission is required.`,
          match
        );
      }
      return makeIssue(regulation, REGULATION_SEVERITY.BLOCK, 'truck_forbidden', 'Truck/HGV access is prohibited.', match);
    }
    case REGULATION_TYPES.MAX_HEIGHT: {
      const limit = finiteNumber(regulation.value?.meters);
      if (!Number.isFinite(limit) || limit <= 0) return null;
      if (m.physicalHeightM > limit) {
        return makeIssue(regulation, REGULATION_SEVERITY.BLOCK, 'max_height_exceeded', 'Vehicle height exceeds legal height limit.', match, {
          actual: Number(m.physicalHeightM.toFixed(2)),
          required: Number(limit.toFixed(2)),
          deficit: Number((m.physicalHeightM - limit).toFixed(2))
        });
      }
      if (m.requiredHeightM > limit) {
        return makeIssue(regulation, REGULATION_SEVERITY.WARNING, 'max_height_margin_low', 'Vehicle fits the signed height, but clearance margin is low.', match, {
          actual: Number(m.requiredHeightM.toFixed(2)),
          required: Number(limit.toFixed(2)),
          deficit: Number((m.requiredHeightM - limit).toFixed(2))
        });
      }
      return null;
    }
    case REGULATION_TYPES.MAX_WIDTH: {
      const limit = finiteNumber(regulation.value?.meters);
      if (!Number.isFinite(limit) || limit <= 0) return null;
      if (m.widthM > limit) {
        return makeIssue(regulation, REGULATION_SEVERITY.BLOCK, 'max_width_exceeded', 'Vehicle width exceeds legal width limit.', match, {
          actual: Number(m.widthM.toFixed(2)),
          required: Number(limit.toFixed(2)),
          deficit: Number((m.widthM - limit).toFixed(2))
        });
      }
      return null;
    }
    case REGULATION_TYPES.MAX_WEIGHT: {
      const limit = finiteNumber(regulation.value?.tons);
      if (!Number.isFinite(limit) || limit <= 0 || !m.grossWeightT) return null;
      if (m.grossWeightT > limit) {
        return makeIssue(regulation, REGULATION_SEVERITY.BLOCK, 'max_weight_exceeded', 'Vehicle gross weight exceeds legal weight limit.', match, {
          actual: Number(m.grossWeightT.toFixed(2)),
          required: Number(limit.toFixed(2)),
          deficit: Number((m.grossWeightT - limit).toFixed(2))
        });
      }
      return null;
    }
    case REGULATION_TYPES.TIME_RESTRICTION:
      return makeIssue(regulation, REGULATION_SEVERITY.WARNING, 'time_restriction_unparsed', 'Time-based restriction exists and needs manual confirmation.', match);
    default:
      return null;
  }
}

function latLngOf(point) {
  if (!point) return null;
  const lat = Number(point.lat ?? point[1]);
  const lng = Number(point.lng ?? point[0]);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

function linesFromGeometry(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'Feature') return linesFromGeometry(geometry.geometry);
  if (geometry.type === 'LineString') return [geometry.coordinates || []];
  if (geometry.type === 'MultiLineString') return geometry.coordinates || [];
  return [];
}

function toXY(point, originLat) {
  const lat = Number(point.lat ?? point[1]);
  const lng = Number(point.lng ?? point[0]);
  const kx = 111320 * Math.cos((originLat || lat || 0) * Math.PI / 180);
  return { x: lng * kx, y: lat * 111320, lat, lng };
}

function distPointToSegment(p, a, b) {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  if (len2 <= 1e-9) return { distance: Math.hypot(p.x - a.x, p.y - a.y), t: 0 };
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2));
  const x = a.x + abx * t;
  const y = a.y + aby * t;
  return { distance: Math.hypot(p.x - x, p.y - y), t };
}

function orientation(a, b, c) {
  return (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y);
}

function segmentsCross(a, b, c, d) {
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);
  return (o1 * o2 < 0) && (o3 * o4 < 0);
}

function segmentDistance(a, b, c, d) {
  if (segmentsCross(a, b, c, d)) return { distance: 0, routeT: 0.5, featureT: 0.5 };
  const ac = distPointToSegment(a, c, d);
  const bc = distPointToSegment(b, c, d);
  const ca = distPointToSegment(c, a, b);
  const da = distPointToSegment(d, a, b);
  const choices = [
    { distance: ac.distance, routeT: 0, featureT: ac.t },
    { distance: bc.distance, routeT: 1, featureT: bc.t },
    { distance: ca.distance, routeT: ca.t, featureT: 0 },
    { distance: da.distance, routeT: da.t, featureT: 1 }
  ];
  choices.sort((x, y) => x.distance - y.distance);
  return choices[0];
}

function bearingDeg(a, b) {
  const A = latLngOf(a);
  const B = latLngOf(b);
  if (!A || !B) return null;
  const lat1 = A.lat * Math.PI / 180;
  const lat2 = B.lat * Math.PI / 180;
  const dLng = (B.lng - A.lng) * Math.PI / 180;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  const deg = Math.atan2(y, x) * 180 / Math.PI;
  return (deg + 360) % 360;
}

function angleDeltaDeg(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function routeSegments(routeLL = []) {
  const pts = routeLL.map(latLngOf).filter(Boolean);
  const out = [];
  let cum = 0;
  const originLat = pts[0]?.lat || 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const A = toXY(a, originLat);
    const B = toXY(b, originLat);
    const len = Math.hypot(B.x - A.x, B.y - A.y);
    if (len <= 0.05) continue;
    out.push({ a, b, A, B, len, cum, bearing: bearingDeg(a, b) });
    cum += len;
  }
  return out;
}

function interpolateLatLng(a, b, t) {
  return {
    lat: a.lat + (b.lat - a.lat) * t,
    lng: a.lng + (b.lng - a.lng) * t
  };
}

function bestRouteMatch(routeSegs, geometry, corridorM) {
  if (!routeSegs.length || !geometry) return null;
  const originLat = routeSegs[0].a.lat || 0;
  let best = null;
  for (const line of linesFromGeometry(geometry)) {
    if (!Array.isArray(line) || line.length < 2) continue;
    for (let i = 0; i < line.length - 1; i++) {
      const fa = latLngOf(line[i]);
      const fb = latLngOf(line[i + 1]);
      if (!fa || !fb) continue;
      const FA = toXY(fa, originLat);
      const FB = toXY(fb, originLat);
      const featureBearing = bearingDeg(fa, fb);
      for (const rs of routeSegs) {
        const d = segmentDistance(rs.A, rs.B, FA, FB);
        if (!best || d.distance < best.distanceM) {
          best = {
            distanceM: d.distance,
            atM: rs.cum + rs.len * d.routeT,
            latLng: interpolateLatLng(rs.a, rs.b, d.routeT),
            routeBearing: rs.bearing,
            featureBearing
          };
        }
      }
    }
  }
  if (!best || best.distanceM > corridorM) return null;
  return best;
}

function isOnewayDirectionViolation(regulation, match) {
  if (!match || !Number.isFinite(match.routeBearing) || !Number.isFinite(match.featureBearing)) return false;
  const allowedBearing = regulation.direction === 'reverse'
    ? (match.featureBearing + 180) % 360
    : match.featureBearing;
  return angleDeltaDeg(match.routeBearing, allowedBearing) > ONEWAY_REVERSE_THRESHOLD_DEG;
}

export function deriveRegulationStatus(issues = []) {
  const counts = {
    blockCount: 0,
    permitRequiredCount: 0,
    warningCount: 0,
    unknownCount: 0
  };
  for (const issue of issues) {
    if (issue?.severity === REGULATION_SEVERITY.BLOCK) counts.blockCount++;
    else if (issue?.severity === REGULATION_SEVERITY.PERMIT_REQUIRED) counts.permitRequiredCount++;
    else if (issue?.severity === REGULATION_SEVERITY.WARNING) counts.warningCount++;
    else if (issue?.severity === REGULATION_SEVERITY.UNKNOWN) counts.unknownCount++;
  }
  let status = 'pass';
  if (counts.blockCount) status = 'blocked';
  else if (counts.permitRequiredCount) status = 'permit_required';
  else if (counts.warningCount) status = 'warning';
  else if (counts.unknownCount) status = 'unknown';
  return { status, ...counts };
}

export function assessRegulationsForRoute({
  routeLL,
  regulations = [],
  vehicleConfig,
  options = {}
} = {}) {
  const normalized = regulations.map(normalizeRegulation).filter(Boolean);
  const routeSegs = routeSegments(routeLL);
  const corridorM = Number.isFinite(Number(options.corridorM))
    ? Math.max(1, Number(options.corridorM))
    : DEFAULT_CORRIDOR_M;
  const issues = [];
  let matchedRegulationCount = 0;

  for (const regulation of normalized) {
    const match = bestRouteMatch(routeSegs, regulation.geometry, corridorM);
    if (!match) continue;
    matchedRegulationCount++;
    const directionViolation = regulation.type === REGULATION_TYPES.ONEWAY
      ? isOnewayDirectionViolation(regulation, match)
      : false;
    const issue = evaluateRegulation(regulation, vehicleConfig, {
      ...options,
      match,
      directionViolation
    });
    if (issue) issues.push(issue);
  }

  const summary = deriveRegulationStatus(issues);
  return {
    status: summary.status,
    violations: issues.filter((i) => i.severity === REGULATION_SEVERITY.BLOCK),
    permitRequired: issues.filter((i) => i.severity === REGULATION_SEVERITY.PERMIT_REQUIRED),
    warnings: issues.filter((i) => i.severity === REGULATION_SEVERITY.WARNING),
    unknowns: issues.filter((i) => i.severity === REGULATION_SEVERITY.UNKNOWN),
    issues,
    regulationsChecked: normalized.length,
    matchedRegulationCount,
    summary,
    sourceSummary: summarizeSources(normalized)
  };
}

function summarizeSources(regulations) {
  const out = {};
  for (const r of regulations) {
    const key = r.source || 'unknown';
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

export function mergePhysicalAndRegulationStatus(physicalStatus, regulationStatus) {
  const p = String(physicalStatus || 'blocked').toLowerCase();
  const r = String(regulationStatus || 'pass').toLowerCase();
  if (p === 'blocked' || r === 'blocked') return 'blocked';
  if (r === 'permit_required') return 'permit_required';
  if (p === 'caution' || r === 'warning') return 'caution';
  if (r === 'unknown') return 'needs_confirmation';
  return 'pass';
}

export function legacyOverallStatus(finalStatus) {
  switch (finalStatus) {
    case 'pass':
      return 'PASS';
    case 'caution':
    case 'permit_required':
    case 'needs_confirmation':
      return 'CONDITIONAL';
    default:
      return 'NG';
  }
}

export function regulationScorePenalty(assessment = null) {
  const s = assessment?.summary || {};
  return Math.min(45,
    (Number(s.blockCount) || 0) * 35 +
    (Number(s.permitRequiredCount) || 0) * 15 +
    (Number(s.warningCount) || 0) * 5 +
    (Number(s.unknownCount) || 0) * 4
  );
}
