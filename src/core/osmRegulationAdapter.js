import {
  REGULATION_SEVERITY,
  REGULATION_TYPES,
  normalizeRegulation,
  parseKmhFromValue,
  parseMetersFromValue,
  parseTonsFromValue
} from './regulationModel.js';

const OSM_CONFIDENCE = 0.55;
const OSM_DIMENSION_CONFIDENCE = 0.6;

function getTags(feature = {}) {
  const props = feature.properties || {};
  return props.tags && typeof props.tags === 'object' ? props.tags : props;
}

function sourceFeatureId(feature = {}) {
  const props = feature.properties || {};
  const raw = feature.id ?? props.id ?? props.osm_id ?? props['@id'] ?? props.fid;
  return raw == null || raw === '' ? null : String(raw);
}

function sourceId(feature, suffix) {
  return `${sourceFeatureId(feature) || 'osm-feature'}:${suffix}`;
}

function lower(value) {
  return String(value ?? '').trim().toLowerCase();
}

function hasValue(tags, key) {
  return tags && tags[key] != null && String(tags[key]).trim() !== '';
}

function makeReg(feature, type, suffix, opts = {}) {
  const properties = feature?.properties || {};
  return normalizeRegulation({
    id: sourceId(feature, suffix),
    type,
    geometry: feature.geometry || null,
    appliesTo: opts.appliesTo || null,
    source: 'osm',
    sourceFeatureId: sourceFeatureId(feature),
    confidence: opts.confidence ?? OSM_CONFIDENCE,
    authority: 'OSM',
    severity: opts.severity ?? REGULATION_SEVERITY.INFO,
    value: opts.value || {},
    direction: opts.direction || null,
    conditional: !!opts.conditional,
    schedule: opts.schedule || null,
    evidence: opts.evidence || null,
    updatedAt: properties.updatedAt || properties.timestamp || properties['@timestamp'] || null,
    feature
  });
}

function vehicleScopeForTag(tag = '') {
  const parts = String(tag).toLowerCase().split(':');
  if (parts.includes('hgv')) return { hgv: true };
  if (parts.includes('goods') || parts.includes('truck')) return { goods: true };
  return { motorVehicle: true };
}

function pushAccess(regs, feature, tag, raw, type = REGULATION_TYPES.ACCESS) {
  const value = lower(raw);
  if (!value) return;
  if (['no', 'private', 'destination', 'delivery', 'customers', 'permit', 'agricultural', 'forestry'].includes(value)) {
    regs.push(makeReg(feature, type, `${tag}:${value}`, {
      value: { raw: value, tag },
      appliesTo: vehicleScopeForTag(tag),
      severity: value === 'no' ? REGULATION_SEVERITY.BLOCK : REGULATION_SEVERITY.PERMIT_REQUIRED,
      evidence: { tag, rawValue: raw }
    }));
  }
}

function pushDimension(regs, feature, tag, type, raw, parser, unitKey) {
  const parsed = parser(raw);
  const conditional = tag.endsWith(':conditional');
  if (parsed == null && !conditional) return;
  regs.push(makeReg(feature, type, tag, {
    value: {
      [unitKey]: parsed,
      raw,
      tag,
      conditionalRaw: conditional ? String(raw) : null
    },
    appliesTo: vehicleScopeForTag(tag),
    conditional,
    confidence: OSM_DIMENSION_CONFIDENCE,
    severity: conditional ? REGULATION_SEVERITY.WARNING : REGULATION_SEVERITY.INFO,
    evidence: { tag, rawValue: raw }
  }));
}

function pushConditionalAccess(regs, feature, tag, raw, type, extraValue = {}) {
  if (!hasValue({ [tag]: raw }, tag)) return;
  regs.push(makeReg(feature, type, tag, {
    value: { raw: String(raw), conditionalRaw: String(raw), tag, ...extraValue },
    appliesTo: vehicleScopeForTag(tag),
    conditional: true,
    severity: REGULATION_SEVERITY.WARNING,
    evidence: { tag, rawValue: raw }
  }));
}

function pushSimpleReg(regs, feature, type, suffix, raw, opts = {}) {
  regs.push(makeReg(feature, type, suffix, {
    value: { raw, tag: opts.tag || suffix, ...(opts.value || {}) },
    appliesTo: opts.appliesTo || vehicleScopeForTag(opts.tag || suffix),
    conditional: !!opts.conditional,
    severity: opts.severity ?? REGULATION_SEVERITY.INFO,
    confidence: opts.confidence ?? OSM_CONFIDENCE,
    evidence: { tag: opts.tag || suffix, rawValue: raw }
  }));
}

function pushRestrictionRelation(regs, feature, tags) {
  const relation = feature.properties?.restrictionRelation;
  if (!relation) return;
  const conditionalRaw = tags['restriction:conditional'] || null;
  const modeRestriction = Object.entries(tags).find(([key]) => /^restriction:(hgv|goods|motorcar|motor_vehicle)$/.test(key));
  const conditionalRestriction = conditionalRaw ? String(conditionalRaw).split(/[;@]/)[0].trim() : null;
  const restriction = modeRestriction?.[1] || tags.restriction || relation.restriction || conditionalRestriction || null;
  const mode = modeRestriction?.[0]?.split(':')[1] || (String(tags.type || '').includes(':hgv') ? 'hgv' : null);
  const appliesTo = mode === 'hgv' ? { hgv: true } : (mode === 'goods' ? { goods: true } : { motorVehicle: true });
  regs.push(makeReg(feature, REGULATION_TYPES.TURN_RESTRICTION, 'turn-relation', {
    value: {
      raw: conditionalRaw || restriction,
      conditionalRaw,
      restriction,
      except: String(tags.except || '').split(/[;,]/).map((v) => v.trim()).filter(Boolean),
      relation
    },
    appliesTo,
    conditional: !!conditionalRaw,
    severity: conditionalRaw ? REGULATION_SEVERITY.WARNING : REGULATION_SEVERITY.BLOCK,
    confidence: 0.72,
    evidence: { tag: conditionalRaw ? 'restriction:conditional' : 'restriction', rawValue: conditionalRaw || restriction }
  }));
}

function pushBarrier(regs, feature, tags) {
  const kind = lower(tags.barrier);
  if (!kind) return;
  if (kind === 'toll_booth') {
    pushSimpleReg(regs, feature, REGULATION_TYPES.TOLL, 'barrier:toll_booth', 'yes', {
      tag: 'barrier', value: { charge: tags.charge ?? null }, severity: REGULATION_SEVERITY.INFO
    });
    return;
  }
  const vehicleAccess = lower(tags.motor_vehicle ?? tags.vehicle ?? tags.access);
  const passable = ['yes', 'permissive', 'designated'].includes(vehicleAccess);
  const fixed = ['bollard', 'block', 'bar', 'chain', 'jersey_barrier', 'barrier_board'].includes(kind);
  const controlled = ['gate', 'lift_gate', 'swing_gate', 'sliding_gate', 'rising_bollard'].includes(kind);
  if (!fixed && !controlled && vehicleAccess !== 'no') return;
  regs.push(makeReg(feature, REGULATION_TYPES.BARRIER, `barrier:${kind}`, {
    value: { raw: kind, kind, access: vehicleAccess || null, locked: lower(tags.locked) || null },
    appliesTo: { motorVehicle: true },
    severity: fixed && !passable ? REGULATION_SEVERITY.BLOCK : REGULATION_SEVERITY.PERMIT_REQUIRED,
    confidence: 0.65,
    evidence: { tag: 'barrier', rawValue: kind }
  }));
}

function pushParkingRestrictions(regs, feature, tags) {
  for (const [tag, rawValue] of Object.entries(tags || {})) {
    const raw = lower(rawValue);
    if (!/^(parking|stopping)(:|$)/.test(tag)) continue;
    if (!/(no_parking|no_stopping|no|restricted)/.test(raw)) continue;
    pushSimpleReg(regs, feature, REGULATION_TYPES.PARKING_RESTRICTION, tag, raw, {
      tag,
      severity: REGULATION_SEVERITY.WARNING
    });
  }
}

function isSchoolZone(tags) {
  if (lower(tags.school_zone) === 'yes') return true;
  const values = [
    tags.hazard,
    tags.restriction,
    tags['maxspeed:variable'],
    tags['zone:maxspeed']
  ].map(lower);
  return values.some((v) => v.includes('school_zone') || v.includes('school'));
}

function trafficSignText(tags) {
  return Object.entries(tags || {})
    .filter(([key]) => key === 'traffic_sign' || key.startsWith('traffic_sign:') || key.includes('supplementary'))
    .map(([, value]) => String(value ?? ''))
    .join(';');
}

function payloadThresholdFromTags(tags, signText) {
  for (const key of ['maxpayload', 'max_payload', 'payload_limit', 'traffic_sign:payload']) {
    const parsed = parseTonsFromValue(tags?.[key]);
    if (parsed != null) return parsed;
  }
  const aroundSign = String(signText || '').match(/(?:JP:305-2|JP:503-C)[^;]*?([0-9]+(?:\.[0-9]+)?)\s*t/i);
  return aroundSign ? Number(aroundSign[1]) : null;
}

function pushTrafficSigns(regs, feature, tags) {
  const raw = trafficSignText(tags);
  if (!raw) return;
  const upper = raw.toUpperCase();
  const locationOnly = feature.geometry?.type === 'Point' || feature.geometry?.type === 'MultiPoint';
  if (/JP:305-2(?:\D|$)/i.test(raw)) {
    const minimumT = payloadThresholdFromTags(tags, raw);
    regs.push(makeReg(feature, REGULATION_TYPES.PAYLOAD_CLASS, 'traffic_sign:JP:305-2', {
      value: { raw, tag: 'traffic_sign', minimumT, locationOnly },
      appliesTo: { goods: true },
      confidence: locationOnly ? 0.45 : OSM_CONFIDENCE,
      severity: minimumT == null || locationOnly ? REGULATION_SEVERITY.WARNING : REGULATION_SEVERITY.BLOCK,
      evidence: { tag: 'traffic_sign', rawValue: raw, signCode: 'JP:305-2' }
    }));
  } else if (upper.includes('JP:305')) {
    regs.push(makeReg(feature, REGULATION_TYPES.NO_TRUCK, 'traffic_sign:JP:305', {
      value: { raw: 'no', tag: 'traffic_sign', locationOnly },
      appliesTo: { hgv: true },
      confidence: locationOnly ? 0.45 : OSM_CONFIDENCE,
      severity: locationOnly ? REGULATION_SEVERITY.WARNING : REGULATION_SEVERITY.BLOCK,
      evidence: { tag: 'traffic_sign', rawValue: raw, signCode: 'JP:305' }
    }));
  }
  if (/JP:(302|303|304)(?:\D|$)/i.test(raw)) {
    regs.push(makeReg(feature, REGULATION_TYPES.ACCESS, 'traffic_sign:vehicle-prohibition', {
      value: { raw: 'no', tag: 'traffic_sign', locationOnly },
      appliesTo: { motorVehicle: true },
      confidence: locationOnly ? 0.45 : OSM_CONFIDENCE,
      severity: locationOnly ? REGULATION_SEVERITY.WARNING : REGULATION_SEVERITY.BLOCK,
      evidence: { tag: 'traffic_sign', rawValue: raw }
    }));
  }
  if (/JP:301(?:\D|$)|JP:325-4(?:\D|$)/i.test(raw)) {
    pushSimpleReg(regs, feature, REGULATION_TYPES.ACCESS, 'traffic_sign:full-prohibition', 'no', {
      tag: 'traffic_sign', value: { locationOnly }, severity: locationOnly ? REGULATION_SEVERITY.WARNING : REGULATION_SEVERITY.BLOCK
    });
  }
  if (/JP:310-3(?:\D|$)/i.test(raw)) {
    pushSimpleReg(regs, feature, REGULATION_TYPES.CHAIN_REQUIRED, 'traffic_sign:JP:310-3', raw, {
      tag: 'traffic_sign', value: { locationOnly }, severity: REGULATION_SEVERITY.UNKNOWN
    });
  }
  if (/JP:(311(?:-[A-F])?|312|313)(?:\D|$)/i.test(raw)) {
    pushSimpleReg(regs, feature, REGULATION_TYPES.TURN_RESTRICTION, 'traffic_sign:turn', raw, {
      tag: 'traffic_sign', value: { locationOnly }, severity: REGULATION_SEVERITY.WARNING
    });
  }
  if (/JP:319(?:\D|$)/i.test(raw)) {
    pushSimpleReg(regs, feature, REGULATION_TYPES.HAZMAT, 'traffic_sign:JP:319', 'no', {
      tag: 'traffic_sign', value: { locationOnly }, severity: locationOnly ? REGULATION_SEVERITY.WARNING : REGULATION_SEVERITY.BLOCK
    });
  }
  const dimensionalSigns = [
    [/JP:320(?:\D|$)/i, REGULATION_TYPES.MAX_WEIGHT, 'tons'],
    [/JP:321(?:\D|$)/i, REGULATION_TYPES.MAX_HEIGHT, 'meters'],
    [/JP:322(?:\D|$)/i, REGULATION_TYPES.MAX_WIDTH, 'meters'],
    [/JP:323(?:\D|$)/i, REGULATION_TYPES.MAX_SPEED, 'kmh'],
    [/JP:324(?:\D|$)/i, REGULATION_TYPES.MIN_SPEED, 'kmh']
  ];
  for (const [pattern, type, unitKey] of dimensionalSigns) {
    if (!pattern.test(raw)) continue;
    pushSimpleReg(regs, feature, type, `traffic_sign:${type}`, raw, {
      tag: 'traffic_sign', value: { [unitKey]: null, locationOnly }, severity: REGULATION_SEVERITY.WARNING
    });
  }
  if (/JP:(315|316)(?:\D|$)/i.test(raw)) {
    const noStopping = /JP:315(?:\D|$)/i.test(raw);
    pushSimpleReg(regs, feature, REGULATION_TYPES.PARKING_RESTRICTION, 'traffic_sign:parking', noStopping ? 'no_stopping' : 'no_parking', {
      tag: 'traffic_sign', value: { locationOnly: false }, severity: REGULATION_SEVERITY.WARNING
    });
  }
  if (/JP:330(?:\D|$)/i.test(raw)) {
    pushSimpleReg(regs, feature, REGULATION_TYPES.STOP_CONTROL, 'traffic_sign:stop', 'stop', {
      tag: 'traffic_sign', value: { control: 'stop', locationOnly: false }, severity: REGULATION_SEVERITY.INFO
    });
  }
}

function pushOneway(regs, feature, tag, raw) {
  const value = lower(raw);
  if (!value) return;
  let direction = null;
  if (value === 'yes' || value === '1' || value === 'true') direction = 'forward';
  else if (value === '-1' || value === 'reverse') direction = 'reverse';
  if (!direction) return;
  regs.push(makeReg(feature, REGULATION_TYPES.ONEWAY, `${tag}:${value}`, {
    direction,
    value: { raw: value, tag },
    appliesTo: vehicleScopeForTag(tag),
    confidence: OSM_CONFIDENCE,
    severity: REGULATION_SEVERITY.INFO,
    evidence: { tag, rawValue: raw }
  }));
}

export function regulationsFromOsmFeature(feature = {}) {
  const tags = getTags(feature);
  if (!feature?.geometry || !tags || typeof tags !== 'object') return [];
  const regs = [];

  pushRestrictionRelation(regs, feature, tags);
  pushTrafficSigns(regs, feature, tags);
  pushBarrier(regs, feature, tags);
  pushParkingRestrictions(regs, feature, tags);

  pushAccess(regs, feature, 'access', tags.access, REGULATION_TYPES.ACCESS);
  pushAccess(regs, feature, 'vehicle', tags.vehicle, REGULATION_TYPES.ACCESS);
  pushAccess(regs, feature, 'motor_vehicle', tags.motor_vehicle, REGULATION_TYPES.ACCESS);
  pushAccess(regs, feature, 'motorcar', tags.motorcar, REGULATION_TYPES.ACCESS);
  pushAccess(regs, feature, 'truck', tags.truck, REGULATION_TYPES.NO_TRUCK);
  pushAccess(regs, feature, 'hgv', tags.hgv, REGULATION_TYPES.NO_TRUCK);
  pushAccess(regs, feature, 'goods', tags.goods, REGULATION_TYPES.NO_TRUCK);

  for (const tag of ['maxheight', 'maxheight:physical', 'maxheight:legal', 'maxheight:signed', 'maxheight:conditional']) {
    if (hasValue(tags, tag)) pushDimension(regs, feature, tag, REGULATION_TYPES.MAX_HEIGHT, tags[tag], parseMetersFromValue, 'meters');
  }
  for (const tag of ['maxwidth', 'maxwidth:physical', 'maxwidth:legal', 'maxwidth:signed', 'maxwidth:conditional']) {
    if (hasValue(tags, tag)) pushDimension(regs, feature, tag, REGULATION_TYPES.MAX_WIDTH, tags[tag], parseMetersFromValue, 'meters');
  }
  for (const tag of ['maxweight', 'maxweight:conditional']) {
    if (hasValue(tags, tag)) pushDimension(regs, feature, tag, REGULATION_TYPES.MAX_WEIGHT, tags[tag], parseTonsFromValue, 'tons');
  }
  for (const tag of [
    'maxweightrating', 'maxweightrating:hgv', 'maxweightrating:goods',
    'maxweightrating:conditional', 'maxweightrating:hgv:conditional', 'maxweightrating:goods:conditional'
  ]) {
    if (hasValue(tags, tag)) pushDimension(regs, feature, tag, REGULATION_TYPES.MAX_WEIGHT_RATING, tags[tag], parseTonsFromValue, 'tons');
  }
  for (const tag of ['maxaxleload', 'maxaxleload:conditional']) {
    if (hasValue(tags, tag)) pushDimension(regs, feature, tag, REGULATION_TYPES.MAX_AXLE_LOAD, tags[tag], parseTonsFromValue, 'tons');
  }
  for (const tag of ['maxlength', 'maxlength:conditional']) {
    if (hasValue(tags, tag)) pushDimension(regs, feature, tag, REGULATION_TYPES.MAX_LENGTH, tags[tag], parseMetersFromValue, 'meters');
  }
  for (const tag of ['maxspeed', 'maxspeed:hgv', 'maxspeed:conditional', 'maxspeed:hgv:conditional']) {
    if (hasValue(tags, tag)) pushDimension(regs, feature, tag, REGULATION_TYPES.MAX_SPEED, tags[tag], parseKmhFromValue, 'kmh');
  }
  for (const tag of ['minspeed', 'minspeed:hgv', 'minspeed:conditional', 'minspeed:hgv:conditional']) {
    if (hasValue(tags, tag)) pushDimension(regs, feature, tag, REGULATION_TYPES.MIN_SPEED, tags[tag], parseKmhFromValue, 'kmh');
  }

  for (const tag of ['hazmat', 'hazmat:water', 'hazmat:explosive']) {
    if (!hasValue(tags, tag)) continue;
    const raw = lower(tags[tag]);
    if (!['no', 'private', 'destination', 'delivery', 'permit', 'yes', 'designated', 'permissive'].includes(raw)) continue;
    pushSimpleReg(regs, feature, REGULATION_TYPES.HAZMAT, tag, raw, {
      tag,
      value: { hazmatClass: tag.includes(':') ? tag.split(':')[1] : null },
      severity: raw === 'no' ? REGULATION_SEVERITY.BLOCK : REGULATION_SEVERITY.PERMIT_REQUIRED
    });
  }
  for (const tag of ['toll:hgv', 'toll']) {
    if (['yes', '1', 'true'].includes(lower(tags[tag]))) {
      pushSimpleReg(regs, feature, REGULATION_TYPES.TOLL, tag, tags[tag], {
        tag, appliesTo: tag.includes('hgv') ? { hgv: true } : { motorVehicle: true },
        value: { charge: tags.charge ?? tags['charge:hgv'] ?? null }
      });
    }
  }
  if (lower(tags.highway) === 'pedestrian' || lower(tags.highway) === 'footway') {
    const motorAccess = lower(tags.motor_vehicle ?? tags.vehicle ?? tags.access);
    if (!['yes', 'permissive', 'designated', 'delivery', 'destination'].includes(motorAccess)) {
      pushSimpleReg(regs, feature, REGULATION_TYPES.ACCESS, 'pedestrian-road', 'no', {
        tag: 'highway', severity: REGULATION_SEVERITY.BLOCK
      });
    }
  }
  if (lower(tags.construction) && lower(tags.construction) !== 'no') {
    pushSimpleReg(regs, feature, REGULATION_TYPES.SEASONAL, 'construction', `construction:${tags.construction}`, {
      tag: 'construction', value: { construction: true, closed: lower(tags.access) !== 'yes' }, severity: REGULATION_SEVERITY.BLOCK
    });
  }
  if (['yes', 'winter', 'summer'].includes(lower(tags.seasonal))
    || ['no', 'limited'].includes(lower(tags.winter_service))
    || lower(tags.snowplowing) === 'no') {
    pushSimpleReg(regs, feature, REGULATION_TYPES.SEASONAL, 'seasonal',
      tags.seasonal ?? tags.winter_service ?? tags.snowplowing, {
        tag: hasValue(tags, 'seasonal') ? 'seasonal' : (hasValue(tags, 'winter_service') ? 'winter_service' : 'snowplowing'),
        severity: REGULATION_SEVERITY.WARNING
      });
  }
  if (['required', 'yes'].includes(lower(tags.snow_chains ?? tags.winter_equipment))) {
    pushSimpleReg(regs, feature, REGULATION_TYPES.CHAIN_REQUIRED, 'snow-chains', tags.snow_chains ?? tags.winter_equipment, {
      tag: hasValue(tags, 'snow_chains') ? 'snow_chains' : 'winter_equipment', severity: REGULATION_SEVERITY.UNKNOWN
    });
  }
  if (['stop', 'give_way'].includes(lower(tags.highway))) {
    pushSimpleReg(regs, feature, REGULATION_TYPES.STOP_CONTROL, `highway:${tags.highway}`, tags.highway, {
      tag: 'highway', value: { control: lower(tags.highway), locationOnly: false }, severity: REGULATION_SEVERITY.INFO
    });
  }

  if (isSchoolZone(tags)) {
    const kmh = parseKmhFromValue(tags.maxspeed ?? tags['maxspeed:conditional']);
    regs.push(makeReg(feature, REGULATION_TYPES.SCHOOL_ZONE, 'school_zone', {
      value: { raw: tags.school_zone ?? tags.hazard ?? tags.restriction ?? tags['maxspeed:variable'] ?? tags['zone:maxspeed'], kmh },
      severity: REGULATION_SEVERITY.WARNING,
      confidence: OSM_CONFIDENCE,
      evidence: { tag: 'school_zone/hazard/restriction', rawValue: tags }
    }));
  }

  for (const tag of ['oneway', 'oneway:vehicle', 'oneway:hgv']) {
    if (hasValue(tags, tag)) pushOneway(regs, feature, tag, tags[tag]);
  }

  for (const [tag, raw] of Object.entries(tags)) {
    if (!tag.endsWith(':conditional')) continue;
    if (/^(maxheight|maxwidth|maxweight|maxweightrating|maxaxleload|maxlength|maxspeed|minspeed|restriction)/.test(tag)) continue;
    if (/^(access|vehicle|motor_vehicle|motorcar):conditional$/.test(tag)) {
      pushConditionalAccess(regs, feature, tag, raw, REGULATION_TYPES.ACCESS);
    } else if (/^(truck|hgv|goods):conditional$/.test(tag)) {
      pushConditionalAccess(regs, feature, tag, raw, REGULATION_TYPES.NO_TRUCK);
    } else if (/^hazmat(?::[^:]+)?:conditional$/.test(tag)) {
      const parts = tag.split(':');
      pushConditionalAccess(regs, feature, tag, raw, REGULATION_TYPES.HAZMAT, {
        hazmatClass: parts.length > 2 ? parts[1] : null
      });
    }
  }

  return regs.filter(Boolean);
}

function asFeatureArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (value.type === 'FeatureCollection') return Array.isArray(value.features) ? value.features : [];
  if (value.type === 'Feature') return [value];
  if (value.type) return [{ type: 'Feature', properties: {}, geometry: value }];
  return [];
}

export function buildOsmRegulationLayer(roadFeatures = []) {
  const regs = [];
  for (const feature of asFeatureArray(roadFeatures)) {
    regs.push(...regulationsFromOsmFeature(feature));
  }
  return regs;
}
