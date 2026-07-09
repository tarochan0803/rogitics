import {
  REGULATION_SEVERITY,
  REGULATION_TYPES,
  normalizeRegulation,
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
  return normalizeRegulation({
    id: sourceId(feature, suffix),
    type,
    geometry: feature.geometry || null,
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
    feature
  });
}

function pushAccess(regs, feature, tag, raw, type = REGULATION_TYPES.ACCESS) {
  const value = lower(raw);
  if (!value) return;
  if (['no', 'private', 'destination', 'delivery'].includes(value)) {
    regs.push(makeReg(feature, type, `${tag}:${value}`, {
      value: { raw: value, tag },
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
      tag
    },
    conditional,
    confidence: OSM_DIMENSION_CONFIDENCE,
    severity: conditional ? REGULATION_SEVERITY.WARNING : REGULATION_SEVERITY.INFO,
    evidence: { tag, rawValue: raw }
  }));
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
    confidence: OSM_CONFIDENCE,
    severity: REGULATION_SEVERITY.INFO,
    evidence: { tag, rawValue: raw }
  }));
}

export function regulationsFromOsmFeature(feature = {}) {
  const tags = getTags(feature);
  if (!feature?.geometry || !tags || typeof tags !== 'object') return [];
  const regs = [];

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

  for (const tag of ['oneway', 'oneway:vehicle', 'oneway:hgv']) {
    if (hasValue(tags, tag)) pushOneway(regs, feature, tag, tags[tag]);
  }

  for (const [tag, raw] of Object.entries(tags)) {
    if (!tag.endsWith(':conditional')) continue;
    if (tag.startsWith('maxheight') || tag.startsWith('maxwidth') || tag.startsWith('maxweight')) continue;
    if (tag.startsWith('access') || tag.startsWith('vehicle') || tag.startsWith('hgv') || tag.startsWith('goods')) {
      regs.push(makeReg(feature, REGULATION_TYPES.TIME_RESTRICTION, tag, {
        value: { raw, tag },
        conditional: true,
        severity: REGULATION_SEVERITY.WARNING,
        evidence: { tag, rawValue: raw }
      }));
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
