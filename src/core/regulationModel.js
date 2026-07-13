import { getVehicleEnvelope } from '../3d/clearanceSolids.js';

export const REGULATION_TYPES = Object.freeze({
  ONEWAY: 'oneway',
  ACCESS: 'access',
  NO_TRUCK: 'no_truck',
  MAX_HEIGHT: 'max_height',
  MAX_WIDTH: 'max_width',
  MAX_WEIGHT: 'max_weight',
  MAX_WEIGHT_RATING: 'max_weight_rating',
  PAYLOAD_CLASS: 'payload_class_restriction',
  MAX_AXLE_LOAD: 'max_axle_load',
  MAX_LENGTH: 'max_length',
  MAX_SPEED: 'max_speed',
  MIN_SPEED: 'min_speed',
  SCHOOL_ZONE: 'school_zone',
  HAZMAT: 'hazmat_restriction',
  TOLL: 'toll',
  BARRIER: 'barrier',
  CHAIN_REQUIRED: 'chain_required',
  SEASONAL: 'seasonal_restriction',
  STOP_CONTROL: 'stop_control',
  PARKING_RESTRICTION: 'parking_restriction',
  DATA_FRESHNESS: 'regulation_data_freshness',
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
const ISSUE_RANK = { block: 4, permit_required: 3, unknown: 2, warning: 2, info: 0 };

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

export function parseKmhFromValue(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const str = String(value).trim().toLowerCase();
  if (!str || ['none', 'signals', 'variable', 'walk'].includes(str)) return null;
  const mph = str.match(/([0-9]+(?:\.[0-9]+)?)\s*mph/);
  if (mph) return Number(mph[1]) * 1.609344;
  const match = str.match(/([0-9]+(?:\.[0-9]+)?)/);
  return match ? finiteNumber(match[1]) : null;
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
  const ratedPayload = finiteNumber(vehicleConfig.ratedPayloadT)
    ?? finiteNumber(vehicleConfig.payloadCapacityT)
    ?? finiteNumber(vehicleConfig.maxPayloadT)
    ?? 0;
  const axleLoad = finiteNumber(context.actualMaxAxleLoadT)
    ?? finiteNumber(vehicleConfig.maxAxleLoadT)
    ?? 0;
  const actualGrossWeight = finiteNumber(context.actualGrossWeightT)
    ?? finiteNumber(context.plannedGrossWeightT)
    ?? finiteNumber(vehicleConfig.actualGrossWeightT)
    ?? grossWeight;
  return {
    widthM: Math.max(0, Number(envelope.vehicleWidthM) || Number(vehicleConfig.vehicleWidth) || 0),
    physicalHeightM: Math.max(0, Number(envelope.physicalHeightM) || Number(vehicleConfig.vehicleHeight) || 0),
    requiredHeightM: Math.max(0, Number(envelope.requiredHeightM) || Number(vehicleConfig.vehicleHeight) || 0),
    grossWeightT: Math.max(0, grossWeight),
    actualGrossWeightT: Math.max(0, actualGrossWeight),
    ratedPayloadT: Math.max(0, ratedPayload),
    maxAxleLoadT: Math.max(0, axleLoad),
    lengthM: Math.max(0, Number(envelope.totalLengthM) || 0),
    isGoods: vehicleConfig.isGoodsVehicle !== false,
    isHgv: vehicleConfig.isHgv === true || grossWeight > 3.5,
    isHazmat: context.isHazmat === true || context.hazmat === true
      || /hazmat|dangerous|危険物/i.test(String(context.cargoLoadType || '')),
    snowChainsFitted: context.snowChainsFitted === true
  };
}

export function appliesToVehicle(regulation, vehicleConfig = {}, context = {}) {
  if (!regulation) return false;
  const scope = regulation.appliesTo || {};
  const metrics = vehicleMetrics(vehicleConfig, context);
  if (scope.hgv === true && !metrics.isHgv) return false;
  if (scope.goods === true && !metrics.isGoods) return false;
  if (scope.hgv === false && metrics.isHgv) return false;
  if (scope.goods === false && metrics.isGoods) return false;
  if (scope.vehicle === false || scope.motorVehicle === false) return false;
  const except = Array.isArray(regulation.value?.except)
    ? regulation.value.except.map((v) => String(v).toLowerCase())
    : String(regulation.value?.except || '').toLowerCase().split(/[;,]/).map((v) => v.trim()).filter(Boolean);
  if (except.includes('hgv') && metrics.isHgv) return false;
  if (except.includes('goods') && metrics.isGoods) return false;
  if (except.includes('motor_vehicle') || except.includes('motorcar')) return false;
  return true;
}

const DAY_INDEX = Object.freeze({ Su: 0, Mo: 1, Tu: 2, We: 3, Th: 4, Fr: 5, Sa: 6 });

function splitConditionalClauses(raw) {
  const out = [];
  let depth = 0;
  let start = 0;
  const text = String(raw || '');
  for (let i = 0; i <= text.length; i++) {
    const ch = text[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if ((ch === ';' && depth === 0) || i === text.length) {
      const clause = text.slice(start, i).trim();
      const at = clause.indexOf('@');
      if (at > 0) out.push({ value: clause.slice(0, at).trim(), condition: clause.slice(at + 1).trim() });
      start = i + 1;
    }
  }
  return out;
}

function zonedClock(dateValue, timeZone = 'Asia/Tokyo') {
  if (dateValue == null || dateValue === '') return null;
  const date = dateValue instanceof Date ? dateValue : new Date(dateValue);
  if (!Number.isFinite(date.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(date);
    const get = (type) => parts.find((p) => p.type === type)?.value;
    const dayText = get('weekday')?.slice(0, 2);
    const day = DAY_INDEX[dayText];
    const hour = Number(get('hour'));
    const minute = Number(get('minute'));
    return Number.isInteger(day) && Number.isFinite(hour) && Number.isFinite(minute)
      ? { day, minuteOfDay: hour * 60 + minute }
      : null;
  } catch (_err) {
    return null;
  }
}

function dayInRange(day, from, to) {
  if (from <= to) return day >= from && day <= to;
  return day >= from || day <= to;
}

function evaluateConditionalExpression(condition, metrics, context = {}) {
  let rest = String(condition || '').trim().replace(/^\(+|\)+$/g, ' ');
  if (!rest) return { state: 'unknown', reason: 'empty_condition' };
  let active = true;
  let recognized = false;

  const metricMap = {
    weight: metrics.actualGrossWeightT,
    weightrating: metrics.grossWeightT,
    payload: metrics.ratedPayloadT,
    axleload: metrics.maxAxleLoadT,
    length: metrics.lengthM,
    width: metrics.widthM,
    height: metrics.physicalHeightM
  };
  rest = rest.replace(/\b(weight|weightrating|payload|axleload|length|width|height)\s*(<=|>=|<|>|=)\s*([0-9]+(?:\.[0-9]+)?)/gi,
    (all, name, op, rawLimit) => {
      recognized = true;
      const actual = Number(metricMap[String(name).toLowerCase()]);
      const limit = Number(rawLimit);
      if (!(actual > 0) || !Number.isFinite(limit)) return ' __unknown__ ';
      if (op === '<') active = active && actual < limit;
      else if (op === '<=') active = active && actual <= limit;
      else if (op === '>') active = active && actual > limit;
      else if (op === '>=') active = active && actual >= limit;
      else active = active && Math.abs(actual - limit) < 1e-9;
      return ' ';
    });

  const hasDay = /\b(?:Mo|Tu|We|Th|Fr|Sa|Su)(?:\s*-\s*(?:Mo|Tu|We|Th|Fr|Sa|Su))?\b/i.test(rest);
  const hasTime = /\b\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}\b/.test(rest);
  if (hasDay || hasTime) {
    recognized = true;
    const clock = zonedClock(context.assessmentTime ?? context.departureTime, context.timeZone || 'Asia/Tokyo');
    if (!clock) return { state: 'unknown', reason: 'assessment_time_required' };
    if (hasDay) {
      const dayMatches = [];
      rest = rest.replace(/\b(Mo|Tu|We|Th|Fr|Sa|Su)(?:\s*-\s*(Mo|Tu|We|Th|Fr|Sa|Su))?\b/gi,
        (all, from, to) => {
          dayMatches.push(dayInRange(clock.day, DAY_INDEX[from.slice(0, 1).toUpperCase() + from.slice(1, 2).toLowerCase()],
            DAY_INDEX[(to || from).slice(0, 1).toUpperCase() + (to || from).slice(1, 2).toLowerCase()]));
          return ' ';
        });
      active = active && dayMatches.some(Boolean);
    }
    if (hasTime) {
      const timeMatches = [];
      rest = rest.replace(/\b(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\b/g,
        (all, h1, m1, h2, m2) => {
          const from = Number(h1) * 60 + Number(m1);
          const to = Number(h2) * 60 + Number(m2);
          const now = clock.minuteOfDay;
          timeMatches.push(from <= to ? now >= from && now < to : now >= from || now < to);
          return ' ';
        });
      active = active && timeMatches.some(Boolean);
    }
  }

  rest = rest.replace(/\b(destination|delivery)\b/gi, (all, purpose) => {
    recognized = true;
    const actual = String(context.accessPurpose || '').toLowerCase();
    if (!actual) return ' __unknown__ ';
    active = active && (actual === String(purpose).toLowerCase() || (purpose.toLowerCase() === 'destination' && actual === 'delivery'));
    return ' ';
  });

  if (/\b(PH|SH|school_days|wet|snow|ice)\b/i.test(rest) || rest.includes('__unknown__')) {
    return { state: 'unknown', reason: 'unsupported_condition' };
  }
  rest = rest.replace(/\bAND\b|[(),]/gi, ' ').replace(/\s+/g, ' ').trim();
  if (rest || !recognized) return { state: 'unknown', reason: 'unsupported_condition' };
  return { state: active ? 'active' : 'inactive', reason: null };
}

function resolveConditional(regulation, metrics, context) {
  const raw = regulation.value?.conditionalRaw ?? regulation.value?.raw;
  const clauses = splitConditionalClauses(raw);
  if (!clauses.length) return { state: 'unknown', reason: 'conditional_syntax' };
  let unknownReason = null;
  for (const clause of clauses) {
    const result = evaluateConditionalExpression(clause.condition, metrics, context);
    if (result.state === 'active') return { ...result, effectiveValue: clause.value };
    if (result.state === 'unknown') unknownReason = result.reason || 'conditional_unresolved';
  }
  return unknownReason ? { state: 'unknown', reason: unknownReason } : { state: 'inactive', reason: null };
}

function typedConditionalValue(type, raw) {
  switch (type) {
    case REGULATION_TYPES.MAX_HEIGHT:
    case REGULATION_TYPES.MAX_WIDTH:
    case REGULATION_TYPES.MAX_LENGTH:
      return { meters: parseMetersFromValue(raw) };
    case REGULATION_TYPES.MAX_WEIGHT:
    case REGULATION_TYPES.MAX_WEIGHT_RATING:
    case REGULATION_TYPES.MAX_AXLE_LOAD:
      return { tons: parseTonsFromValue(raw) };
    case REGULATION_TYPES.PAYLOAD_CLASS:
      return { minimumT: parseTonsFromValue(raw) };
    case REGULATION_TYPES.MAX_SPEED:
    case REGULATION_TYPES.MIN_SPEED:
      return { kmh: parseKmhFromValue(raw) };
    default:
      return {};
  }
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

  let effectiveRegulation = regulation;
  if (regulation.conditional) {
    const resolved = resolveConditional(regulation, m, context);
    if (resolved.state === 'inactive') return null;
    if (resolved.state === 'active') {
      effectiveRegulation = {
        ...regulation,
        conditional: false,
        value: {
          ...(regulation.value || {}),
          ...typedConditionalValue(regulation.type, resolved.effectiveValue),
          raw: resolved.effectiveValue
        }
      };
    } else {
      return makeIssue(
        regulation,
        REGULATION_SEVERITY.WARNING,
        resolved.reason === 'assessment_time_required' ? 'conditional_time_required' : 'conditional_regulation_unparsed',
        resolved.reason === 'assessment_time_required'
          ? 'A departure time is required to evaluate this conditional regulation.'
          : 'Conditional regulation exists and needs manual confirmation.',
        match,
        { conditionalRaw: regulation.value?.conditionalRaw ?? regulation.value?.raw ?? null }
      );
    }
  }

  regulation = effectiveRegulation;

  if (regulation.value?.locationOnly && regulation.type === REGULATION_TYPES.HAZMAT && !m.isHazmat) return null;
  if (regulation.value?.locationOnly) {
    return makeIssue(
      regulation,
      REGULATION_SEVERITY.WARNING,
      'traffic_sign_road_match_required',
      'A regulation sign was found near the route, but its affected road must be confirmed.',
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
      if (['private', 'destination', 'delivery', 'customers', 'permit', 'agricultural', 'forestry'].includes(raw)) {
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
      if (raw === 'yes' || raw === 'designated' || raw === 'permissive') return null;
      if (['destination', 'private', 'delivery', 'customers', 'permit', 'agricultural', 'forestry'].includes(raw)) {
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
      if (!Number.isFinite(limit) || limit <= 0 || !m.actualGrossWeightT) return null;
      if (m.actualGrossWeightT > limit) {
        return makeIssue(regulation, REGULATION_SEVERITY.BLOCK, 'max_weight_exceeded', 'Vehicle gross weight exceeds legal weight limit.', match, {
          actual: Number(m.actualGrossWeightT.toFixed(2)),
          required: Number(limit.toFixed(2)),
          deficit: Number((m.actualGrossWeightT - limit).toFixed(2))
        });
      }
      return null;
    }
    case REGULATION_TYPES.MAX_WEIGHT_RATING: {
      const limit = finiteNumber(regulation.value?.tons) ?? parseTonsFromValue(regulation.value?.raw);
      if (!Number.isFinite(limit) || limit <= 0 || !m.grossWeightT) return null;
      if (m.grossWeightT > limit) {
        return makeIssue(regulation, REGULATION_SEVERITY.BLOCK, 'max_weight_rating_exceeded', 'Vehicle maximum authorized mass exceeds the permitted rating.', match, {
          actual: Number(m.grossWeightT.toFixed(2)), required: Number(limit.toFixed(2)), deficit: Number((m.grossWeightT - limit).toFixed(2))
        });
      }
      return null;
    }
    case REGULATION_TYPES.PAYLOAD_CLASS: {
      const threshold = finiteNumber(regulation.value?.minimumT) ?? parseTonsFromValue(regulation.value?.raw);
      if (!Number.isFinite(threshold) || threshold <= 0) {
        return makeIssue(regulation, REGULATION_SEVERITY.WARNING, 'payload_threshold_unknown', 'A payload-class truck restriction exists, but its threshold is unknown.', match);
      }
      if (!m.ratedPayloadT) {
        return makeIssue(regulation, REGULATION_SEVERITY.UNKNOWN, 'vehicle_payload_rating_unknown', 'Vehicle rated payload is required for this restriction.', match, { required: threshold });
      }
      if (m.ratedPayloadT >= threshold) {
        return makeIssue(regulation, REGULATION_SEVERITY.BLOCK, 'payload_class_prohibited', 'Vehicle rated payload is within the prohibited truck class.', match, {
          actual: Number(m.ratedPayloadT.toFixed(2)), required: Number(threshold.toFixed(2)), comparison: '>='
        });
      }
      return null;
    }
    case REGULATION_TYPES.MAX_AXLE_LOAD: {
      const limit = finiteNumber(regulation.value?.tons) ?? parseTonsFromValue(regulation.value?.raw);
      if (!Number.isFinite(limit) || limit <= 0) return null;
      if (!m.maxAxleLoadT) {
        return makeIssue(regulation, REGULATION_SEVERITY.UNKNOWN, 'vehicle_axle_load_unknown', 'Maximum axle load is required for this regulation.', match, { required: limit });
      }
      if (m.maxAxleLoadT > limit) {
        return makeIssue(regulation, REGULATION_SEVERITY.BLOCK, 'max_axle_load_exceeded', 'Vehicle axle load exceeds the legal limit.', match, {
          actual: Number(m.maxAxleLoadT.toFixed(2)), required: Number(limit.toFixed(2)), deficit: Number((m.maxAxleLoadT - limit).toFixed(2))
        });
      }
      return null;
    }
    case REGULATION_TYPES.MAX_LENGTH: {
      const limit = finiteNumber(regulation.value?.meters) ?? parseMetersFromValue(regulation.value?.raw);
      if (!Number.isFinite(limit) || limit <= 0 || !m.lengthM) return null;
      if (m.lengthM > limit) {
        return makeIssue(regulation, REGULATION_SEVERITY.BLOCK, 'max_length_exceeded', 'Vehicle length exceeds the legal limit.', match, {
          actual: Number(m.lengthM.toFixed(2)), required: Number(limit.toFixed(2)), deficit: Number((m.lengthM - limit).toFixed(2))
        });
      }
      return null;
    }
    case REGULATION_TYPES.MAX_SPEED: {
      const limit = finiteNumber(regulation.value?.kmh) ?? parseKmhFromValue(regulation.value?.raw);
      if (!Number.isFinite(limit) || limit <= 0) return null;
      return makeIssue(regulation, REGULATION_SEVERITY.INFO, 'speed_limit', `Speed limit is ${Math.round(limit)} km/h.`, match, { required: Number(limit.toFixed(1)) });
    }
    case REGULATION_TYPES.MIN_SPEED: {
      const limit = finiteNumber(regulation.value?.kmh) ?? parseKmhFromValue(regulation.value?.raw);
      if (!Number.isFinite(limit) || limit <= 0) return null;
      return makeIssue(regulation, REGULATION_SEVERITY.INFO, 'minimum_speed', `Minimum speed is ${Math.round(limit)} km/h.`, match, { required: Number(limit.toFixed(1)) });
    }
    case REGULATION_TYPES.SCHOOL_ZONE:
      return makeIssue(regulation, REGULATION_SEVERITY.WARNING, 'school_zone_caution', 'School zone: check signed access times and operate at reduced speed.', match, {
        speedLimitKmh: finiteNumber(regulation.value?.kmh)
      });
    case REGULATION_TYPES.HAZMAT: {
      if (!m.isHazmat) return null;
      const requiredClass = String(regulation.value?.hazmatClass || '').toLowerCase();
      const declaredClasses = Array.isArray(context.hazmatClasses)
        ? context.hazmatClasses.map((value) => String(value).toLowerCase())
        : [];
      if (requiredClass && !declaredClasses.length) {
        return makeIssue(regulation, REGULATION_SEVERITY.UNKNOWN, 'hazmat_class_unknown', 'Hazardous-goods class must be confirmed for this restriction.', match, {
          hazmatClass: requiredClass
        });
      }
      if (requiredClass && !declaredClasses.includes(requiredClass)) return null;
      const raw = String(regulation.value?.raw || '').toLowerCase();
      if (raw === 'yes' || raw === 'designated' || raw === 'permissive') return null;
      if (['destination', 'delivery', 'private', 'permit'].includes(raw)) {
        return makeIssue(regulation, REGULATION_SEVERITY.PERMIT_REQUIRED, 'hazmat_permission_required', 'Hazardous-goods access requires confirmation or permission.', match);
      }
      return makeIssue(regulation, REGULATION_SEVERITY.BLOCK, 'hazmat_forbidden', 'Vehicles carrying hazardous goods are prohibited.', match);
    }
    case REGULATION_TYPES.TOLL:
      return makeIssue(regulation, REGULATION_SEVERITY.INFO, 'toll_road', 'A toll or road charge applies to this route.', match, {
        charge: regulation.value?.charge || null
      });
    case REGULATION_TYPES.BARRIER: {
      const kind = String(regulation.value?.kind || regulation.value?.raw || '').toLowerCase();
      const access = String(regulation.value?.access || '').toLowerCase();
      const fixed = ['bollard', 'block', 'bar', 'chain', 'jersey_barrier', 'barrier_board'].includes(kind);
      if (fixed) {
        if (Number(match?.distanceM) > 2.5) return null;
        if (!['yes', 'permissive', 'designated'].includes(access)) {
          return makeIssue(regulation, REGULATION_SEVERITY.BLOCK, 'fixed_barrier', 'A fixed vehicle barrier blocks the route.', match);
        }
        return null;
      }
      if (Number(match?.distanceM) > 3.5) return null;
      if (access === 'no') return makeIssue(regulation, REGULATION_SEVERITY.BLOCK, 'barrier_access_no', 'Barrier access is prohibited.', match);
      if (['yes', 'permissive', 'designated'].includes(access)) {
        return makeIssue(regulation, REGULATION_SEVERITY.INFO, 'controlled_barrier_accessible', 'A publicly accessible controlled barrier exists on the route.', match);
      }
      return makeIssue(regulation, REGULATION_SEVERITY.PERMIT_REQUIRED, 'controlled_barrier', 'A gate or controlled barrier requires access confirmation.', match);
    }
    case REGULATION_TYPES.CHAIN_REQUIRED:
      if (m.snowChainsFitted) return null;
      if (context.snowChainsFitted === false) {
        return makeIssue(regulation, REGULATION_SEVERITY.BLOCK, 'snow_chains_required', 'Tire chains are required for this road.', match);
      }
      return makeIssue(regulation, REGULATION_SEVERITY.UNKNOWN, 'snow_chain_status_unknown', 'Confirm that tire chains are fitted before using this road.', match);
    case REGULATION_TYPES.SEASONAL: {
      const raw = String(regulation.value?.raw || '').toLowerCase();
      const construction = regulation.value?.construction === true || raw.includes('construction');
      if (construction && regulation.value?.closed !== false) {
        return makeIssue(regulation, REGULATION_SEVERITY.BLOCK, 'road_under_construction', 'Road is closed or unavailable due to construction.', match);
      }
      return makeIssue(regulation, REGULATION_SEVERITY.WARNING, 'seasonal_or_winter_restriction', 'Seasonal or winter road availability must be confirmed.', match);
    }
    case REGULATION_TYPES.STOP_CONTROL:
      return makeIssue(regulation, REGULATION_SEVERITY.INFO, 'mandatory_stop', 'A mandatory stop or give-way control exists on the route.', match, {
        control: regulation.value?.control || regulation.value?.raw || null
      });
    case REGULATION_TYPES.PARKING_RESTRICTION: {
      const routeTotalM = Number(context.routeTotalM);
      const nearDestination = Number.isFinite(routeTotalM) && Number.isFinite(match?.atM)
        && routeTotalM - match.atM <= Math.max(10, Number(context.destinationParkingRadiusM) || 30);
      if (!nearDestination) return null;
      const noStopping = String(regulation.value?.raw || '').toLowerCase().includes('no_stopping');
      return makeIssue(regulation, REGULATION_SEVERITY.WARNING,
        noStopping ? 'destination_no_stopping' : 'destination_no_parking',
        noStopping ? 'No-stopping restriction exists near the destination.' : 'No-parking restriction exists near the destination.', match);
    }
    case REGULATION_TYPES.TURN_RESTRICTION:
      if (context.turnUncertain) {
        return makeIssue(regulation, REGULATION_SEVERITY.WARNING, 'turn_restriction_unresolved', 'Turn restriction exists but route sequence could not be matched reliably.', match);
      }
      if (!context.turnViolation) return null;
      return makeIssue(regulation, permitMode ? REGULATION_SEVERITY.PERMIT_REQUIRED : REGULATION_SEVERITY.BLOCK,
        'turn_restriction_violation', `Route violates ${regulation.value?.restriction || 'a turn restriction'}.`, match, {
          restriction: regulation.value?.restriction || null
        });
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
  if (geometry.type === 'Point') {
    const c = geometry.coordinates || [];
    return c.length >= 2 ? [[c, [Number(c[0]) + 1e-9, Number(c[1])]]] : [];
  }
  if (geometry.type === 'MultiPoint') {
    return (geometry.coordinates || []).filter((c) => c?.length >= 2)
      .map((c) => [c, [Number(c[0]) + 1e-9, Number(c[1])]]);
  }
  if (geometry.type === 'LineString') return [geometry.coordinates || []];
  if (geometry.type === 'MultiLineString') return geometry.coordinates || [];
  if (geometry.type === 'Polygon') return geometry.coordinates || [];
  if (geometry.type === 'MultiPolygon') return (geometry.coordinates || []).flat();
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

function axisAngleDeltaDeg(a, b) {
  return Math.min(angleDeltaDeg(a, b), angleDeltaDeg(a, (Number(b) + 180) % 360));
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

function matchTurnRestriction(routeSegs, regulation, corridorM) {
  const relation = regulation?.value?.relation;
  if (!relation) {
    const match = bestRouteMatch(routeSegs, regulation?.geometry, corridorM);
    return match ? { match, turnViolation: false, turnUncertain: true } : null;
  }
  const viaGeometry = relation.viaGeometry || null;
  const fromGeometry = relation.fromGeometry || null;
  const toGeometry = relation.toGeometry || null;
  if (!viaGeometry || !fromGeometry || !toGeometry) {
    const match = bestRouteMatch(routeSegs, regulation?.geometry, corridorM);
    return match ? { match, turnViolation: false, turnUncertain: true } : null;
  }
  const viaMatch = bestRouteMatch(routeSegs, viaGeometry, Math.min(corridorM, 7));
  if (!viaMatch) return null;
  const station = viaMatch.atM;
  const windowM = 55;
  const approach = routeSegs.filter((seg) => seg.cum < station - 0.5 && seg.cum + seg.len >= station - windowM);
  const departure = routeSegs.filter((seg) => seg.cum + seg.len > station + 0.5 && seg.cum <= station + windowM);
  let fromMatch = bestRouteMatch(approach, fromGeometry, Math.min(corridorM, 9));
  if (fromMatch && axisAngleDeltaDeg(fromMatch.routeBearing, fromMatch.featureBearing) > 48) fromMatch = null;
  if (!fromMatch || fromMatch.atM > station + 4) return null;
  let toMatch = bestRouteMatch(departure, toGeometry, Math.min(corridorM, 9));
  if (toMatch && axisAngleDeltaDeg(toMatch.routeBearing, toMatch.featureBearing) > 48) toMatch = null;
  const kind = String(regulation.value?.restriction || relation.restriction || '').toLowerCase();
  if (!kind.startsWith('no_') && !kind.startsWith('only_')) {
    return { match: viaMatch, turnViolation: false, turnUncertain: true };
  }
  const continuesPastVia = routeSegs.some((seg) => seg.cum + seg.len > station + 2);
  if (!continuesPastVia) return null;
  return {
    match: viaMatch,
    turnViolation: kind.startsWith('no_') ? !!toMatch : !toMatch,
    turnUncertain: false
  };
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
  const routeTotalM = routeSegs.length
    ? routeSegs[routeSegs.length - 1].cum + routeSegs[routeSegs.length - 1].len
    : 0;
  const corridorM = Number.isFinite(Number(options.corridorM))
    ? Math.max(1, Number(options.corridorM))
    : DEFAULT_CORRIDOR_M;
  const issues = [];
  let matchedRegulationCount = 0;

  for (const regulation of normalized) {
    const turnMatch = regulation.type === REGULATION_TYPES.TURN_RESTRICTION
      ? matchTurnRestriction(routeSegs, regulation, corridorM)
      : null;
    const match = regulation.type === REGULATION_TYPES.TURN_RESTRICTION
      ? turnMatch?.match
      : bestRouteMatch(routeSegs, regulation.geometry, corridorM);
    if (!match) continue;
    matchedRegulationCount++;
    const directionViolation = regulation.type === REGULATION_TYPES.ONEWAY
      ? isOnewayDirectionViolation(regulation, match)
      : false;
    const issue = evaluateRegulation(regulation, vehicleConfig, {
      ...options,
      match,
      routeTotalM,
      directionViolation,
      turnViolation: !!turnMatch?.turnViolation,
      turnUncertain: regulation.type === REGULATION_TYPES.TURN_RESTRICTION
        ? (turnMatch?.turnUncertain ?? true)
        : false
    });
    if (issue) issues.push(issue);
  }

  const freshness = options.dataFreshness || options.regulationFreshness || null;
  const freshnessState = String(freshness?.overall || '').toLowerCase();
  if (freshnessState === 'stale' || freshnessState === 'expired' || freshnessState === 'error') {
    const unavailable = freshnessState === 'expired' || freshnessState === 'error';
    const freshnessRegulation = normalizeRegulation({
      id: `system:regulation-freshness:${freshnessState}`,
      type: REGULATION_TYPES.DATA_FRESHNESS,
      source: 'system',
      authority: 'LOGISTICS_OS',
      confidence: 1,
      severity: unavailable ? REGULATION_SEVERITY.UNKNOWN : REGULATION_SEVERITY.WARNING,
      value: { raw: freshnessState, sources: freshness.sources || null },
      evidence: { tag: 'source_freshness', rawValue: freshnessState }
    });
    issues.push(makeIssue(
      freshnessRegulation,
      unavailable ? REGULATION_SEVERITY.UNKNOWN : REGULATION_SEVERITY.WARNING,
      unavailable ? 'regulation_data_unavailable' : 'official_regulation_data_incomplete',
      unavailable
        ? '道路規制データが期限切れまたは取得不能です。通行可否の確認が必要です。'
        : 'OSMは更新済みですが、公的な月次・リアルタイム規制データが未設定または要確認です。'
    ));
  }

  issues.sort((a, b) => {
    const severity = (ISSUE_RANK[b?.severity] || 0) - (ISSUE_RANK[a?.severity] || 0);
    if (severity) return severity;
    const atA = Number.isFinite(a?.atM) ? a.atM : Infinity;
    const atB = Number.isFinite(b?.atM) ? b.atM : Infinity;
    return atA - atB;
  });

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
