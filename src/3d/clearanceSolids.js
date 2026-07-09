import { turf } from '../utils/geo.js';

const DEFAULT_BUILDING_HEIGHT_M = 8;
const DEFAULT_OBSTACLE_HEIGHT_M = 3;
const DEFAULT_OVERHEAD_CLEARANCE_M = 4.5;
const DEFAULT_CLEARANCE_MARGIN_M = 0.25;

function asFeatureArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (value.type === 'FeatureCollection') return Array.isArray(value.features) ? value.features : [];
  if (value.type === 'Feature') return [value];
  if (value.type) return [{ type: 'Feature', properties: {}, geometry: value }];
  return [];
}

function isPolygonLike(feature) {
  const type = feature?.geometry?.type;
  return type === 'Polygon' || type === 'MultiPolygon';
}

function truthy(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase();
    return s === '1' || s === 'true' || s === 'yes' || s === 'on';
  }
  return false;
}

function normalizeHeight(value) {
  if (typeof value === 'string') {
    const m = value.match(/-?\d+(?:\.\d+)?/);
    if (!m) return null;
    const n = Number(m[0]);
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function featureId(feature, fallbackPrefix, index) {
  const raw = feature?.properties?.id ?? feature?.id ?? feature?.properties?.osm_id ?? feature?.properties?.fid;
  if (raw != null && raw !== '') return String(raw);
  return `${fallbackPrefix}:${index}`;
}

export function isHeightOnlyFeature(feature) {
  const props = feature?.properties || {};
  return truthy(props.heightOnly)
    || truthy(props.overhead)
    || String(props.kind || '').includes('wire')
    || String(props.kind || '').includes('overhead')
    || String(props.class || '').includes('wire')
    || String(props.type || '').includes('wire');
}

export function getFeatureHeightInfo(feature, fallback = DEFAULT_OBSTACLE_HEIGHT_M) {
  const props = feature?.properties && typeof feature.properties === 'object' ? feature.properties : {};
  const candidates = [
    ['clearanceHeight', 'clearance'],
    ['clearance_height', 'clearance'],
    ['maxheight', 'tag'],
    ['max_height', 'tag'],
    ['height', 'tag'],
    ['h', 'tag'],
    ['H', 'tag'],
    ['z', 'tag'],
    ['alt', 'tag']
  ];
  for (const [key, source] of candidates) {
    const h = normalizeHeight(props[key]);
    if (h != null) return { value: h, source, key };
  }
  const levels = normalizeHeight(props['building:levels']);
  if (levels != null && levels > 0) return { value: levels * 3, source: 'levels', key: 'building:levels' };
  return {
    value: Number.isFinite(fallback) ? fallback : DEFAULT_OBSTACLE_HEIGHT_M,
    source: 'estimated',
    key: null
  };
}

export function heightClearanceMarginForSource(source) {
  if (source === 'clearance' || source === 'tag' || source === 'measured') return 0.25;
  if (source === 'levels' || source === 'building:levels') return 0.5;
  return 1.0;
}

export function getVehicleEnvelope(stateOrConfig = {}, opts = {}) {
  const vehicleConfig = stateOrConfig.vehicleConfig || stateOrConfig;
  const cargoLoadType = stateOrConfig.cargoLoadType ?? opts.cargoLoadType ?? 'none';
  const cargoCount = Number(stateOrConfig.cargoCount ?? opts.cargoCount ?? 1);
  const vehicleHeight = Math.max(0, Number(vehicleConfig?.vehicleHeight) || 0);
  const vehicleWidth = Math.max(0, Number(vehicleConfig?.vehicleWidth) || 0);
  const wheelBase = Math.max(0, Number(vehicleConfig?.wheelBase) || 0);
  const frontOverhang = Math.max(0, Number(vehicleConfig?.frontOverhang) || 0);
  const rearOverhang = Math.max(0, Number(vehicleConfig?.rearOverhang) || 0);
  const cargoStackHeight = cargoLoadType && cargoLoadType !== 'none'
    ? Math.max(0.4, Math.min(1.5, 0.6 + Math.max(0, cargoCount - 1) * 0.18))
    : 0;
  const physicalHeight = vehicleHeight + cargoStackHeight;
  const clearanceMargin = Number.isFinite(Number(opts.clearanceMargin))
    ? Math.max(0, Number(opts.clearanceMargin))
    : DEFAULT_CLEARANCE_MARGIN_M;
  return {
    vehicleHeightM: Number(vehicleHeight.toFixed(2)),
    cargoStackHeightM: Number(cargoStackHeight.toFixed(2)),
    physicalHeightM: Number(physicalHeight.toFixed(2)),
    requiredHeightM: Number((physicalHeight + clearanceMargin).toFixed(2)),
    clearanceMarginM: Number(clearanceMargin.toFixed(2)),
    vehicleWidthM: Number(vehicleWidth.toFixed(2)),
    halfWidthM: Number((vehicleWidth / 2).toFixed(2)),
    wheelBaseM: Number(wheelBase.toFixed(2)),
    frontOverhangM: Number(frontOverhang.toFixed(2)),
    rearOverhangM: Number(rearOverhang.toFixed(2)),
    frontExtentM: Number((wheelBase + frontOverhang).toFixed(2)),
    rearExtentM: Number(rearOverhang.toFixed(2)),
    lateralProbeRadiusM: Number(Math.max(0.75, vehicleWidth * 0.46).toFixed(2)),
    totalLengthM: Number((wheelBase + frontOverhang + rearOverhang).toFixed(2))
  };
}

export function getVehicleFootprintConfig(stateOrConfig = {}, opts = {}) {
  const envelope = getVehicleEnvelope(stateOrConfig, opts);
  const defaults = {
    wheelBase: Number(opts.defaultWheelBase) || 3.4,
    vehicleWidth: Number(opts.defaultVehicleWidth) || 2.5,
    frontOverhang: Number(opts.defaultFrontOverhang) || 1.0,
    rearOverhang: Number(opts.defaultRearOverhang) || 1.0
  };
  const wheelBase = envelope.wheelBaseM > 0 ? envelope.wheelBaseM : defaults.wheelBase;
  const vehicleWidth = envelope.vehicleWidthM > 0 ? envelope.vehicleWidthM : defaults.vehicleWidth;
  const frontOverhang = envelope.frontOverhangM > 0 ? envelope.frontOverhangM : defaults.frontOverhang;
  const rearOverhang = envelope.rearOverhangM > 0 ? envelope.rearOverhangM : defaults.rearOverhang;
  return {
    wheelBase,
    vehicleWidth,
    frontOverhang,
    rearOverhang,
    halfWidthM: Number((vehicleWidth / 2).toFixed(2)),
    frontExtentM: Number((wheelBase + frontOverhang).toFixed(2)),
    rearExtentM: Number(rearOverhang.toFixed(2)),
    totalLengthM: Number((wheelBase + frontOverhang + rearOverhang).toFixed(2)),
    lateralProbeRadiusM: Number(Math.max(0.75, vehicleWidth * 0.46).toFixed(2))
  };
}

function routeCorridor(route = [], vehicleWidth = 2.5) {
  if (!Array.isArray(route) || route.length < 2 || !turf?.lineString || !turf?.buffer) return null;
  try {
    const line = turf.lineString(route.map((p) => [p.lng, p.lat]));
    const radius = Math.max(3, (Number(vehicleWidth) || 2.5) / 2 + 1.2);
    return turf.buffer(line, radius, { units: 'meters', steps: 6 });
  } catch (_err) {
    return null;
  }
}

function intersectsRouteCorridor(feature, corridor) {
  if (!feature || !corridor || typeof turf?.booleanIntersects !== 'function') return false;
  try {
    return turf.booleanIntersects(feature, corridor);
  } catch (_err) {
    return false;
  }
}

export function buildCollisionSolidSet({ buildings = [], maskEdits = {} } = {}) {
  const buildingSolids = asFeatureArray(buildings)
    .filter(isPolygonLike)
    .map((feature, index) => {
      const h = getFeatureHeightInfo(feature, DEFAULT_BUILDING_HEIGHT_M);
      return {
        id: featureId(feature, 'building', index),
        role: 'building',
        label: feature?.properties?.name || feature?.properties?.building || `building ${index + 1}`,
        feature,
        heightM: h.value,
        heightSource: h.source,
        heightOnly: false
      };
    });

  const deny = asFeatureArray(maskEdits?.deny).filter(isPolygonLike);
  const obstacleSolids = [];
  const overheadSolids = [];
  deny.forEach((feature, index) => {
    const heightOnly = isHeightOnlyFeature(feature);
    const h = getFeatureHeightInfo(feature, heightOnly ? DEFAULT_OVERHEAD_CLEARANCE_M : DEFAULT_OBSTACLE_HEIGHT_M);
    const solid = {
      id: featureId(feature, heightOnly ? 'overhead' : 'obstacle', index),
      role: heightOnly ? 'overhead' : 'obstacle',
      label: feature?.properties?.label || feature?.properties?.kind || feature?.properties?.class || (heightOnly ? 'overhead obstacle' : 'obstacle'),
      feature,
      heightM: h.value,
      heightSource: h.source,
      heightOnly
    };
    if (heightOnly) overheadSolids.push(solid);
    else obstacleSolids.push(solid);
  });

  return {
    lateralSolids: [...buildingSolids, ...obstacleSolids],
    buildingSolids,
    obstacleSolids,
    overheadSolids,
    allSolids: [...buildingSolids, ...obstacleSolids, ...overheadSolids]
  };
}

export function buildClearanceSolidReport({
  route = [],
  buildings = [],
  maskEdits = {},
  vehicleConfig = {},
  cargoLoadType = 'none',
  cargoCount = 1,
  clearanceMargin = DEFAULT_CLEARANCE_MARGIN_M
} = {}) {
  const envelope = getVehicleEnvelope(
    { vehicleConfig, cargoLoadType, cargoCount },
    { clearanceMargin }
  );
  const solidSet = buildCollisionSolidSet({ buildings, maskEdits });
  const corridor = routeCorridor(route, envelope.vehicleWidthM);
  const rows = [];
  let lowClearanceCount = 0;
  let nearRouteOverheadCount = 0;
  let minClearanceM = null;

  for (const solid of solidSet.overheadSolids) {
    const nearRoute = intersectsRouteCorridor(solid.feature, corridor);
    const sourceMargin = heightClearanceMarginForSource(solid.heightSource);
    const required = envelope.physicalHeightM + sourceMargin;
    const margin = solid.heightM - required;
    const status = margin >= 0 ? 'OK' : 'NG';
    if (nearRoute) {
      nearRouteOverheadCount += 1;
      if (minClearanceM == null || margin < minClearanceM) minClearanceM = margin;
      if (status === 'NG') lowClearanceCount += 1;
    }
    rows.push({
      id: solid.id,
      role: solid.role,
      label: solid.label,
      heightM: Number(solid.heightM.toFixed(2)),
      heightSource: solid.heightSource,
      requiredHeightM: Number(required.toFixed(2)),
      marginM: Number(margin.toFixed(2)),
      status,
      nearRoute,
      feature: solid.feature
    });
  }

  rows.sort((a, b) => {
    if (a.nearRoute !== b.nearRoute) return a.nearRoute ? -1 : 1;
    if (a.status !== b.status) return a.status === 'NG' ? -1 : 1;
    return a.marginM - b.marginM;
  });

  return {
    summary: {
      buildingSolidCount: solidSet.buildingSolids.length,
      obstacleSolidCount: solidSet.obstacleSolids.length,
      overheadSolidCount: solidSet.overheadSolids.length,
      nearRouteOverheadCount,
      lowClearanceCount,
      minClearanceM: minClearanceM == null ? null : Number(minClearanceM.toFixed(2)),
      status: lowClearanceCount > 0 ? 'NG' : 'OK',
      vehicleHeightM: envelope.vehicleHeightM,
      cargoStackHeightM: envelope.cargoStackHeightM,
      requiredHeightM: envelope.requiredHeightM
    },
    envelope,
    rows,
    solidSet
  };
}

// Phase 7: 経路中央の片側にオフセットした地上障害物（駐車車両想定）。
// 中心線の前方プローブは塞ぐが、反対側に逃げ場があるため後退+切り返しで復旧可能。
export function makeRouteLateralObstacleFixture(route = [], {
  offsetM = 1.0,
  radiusM = 1.1,
  heightM = 1.6,
  id = 'phase7:fixture:lateral-obstacle'
} = {}) {
  if (!Array.isArray(route) || route.length < 2) return null;
  const mid = Math.floor(route.length / 2);
  const p0 = route[mid];
  const p1 = route[Math.min(route.length - 1, mid + 1)] || route[mid - 1];
  const lat = Number(p0?.lat);
  const lng = Number(p0?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !p1) return null;
  const cosLat = Math.cos(lat * Math.PI / 180) || 1;
  // 進行方向（メートル）
  let dx = (Number(p1.lng) - lng) * 111320 * cosLat;
  let dy = (Number(p1.lat) - lat) * 111320;
  const norm = Math.hypot(dx, dy) || 1;
  dx /= norm; dy /= norm;
  // 左向き垂直単位ベクトル
  const px = -dy;
  const py = dx;
  // 片側へ offsetM ずらした中心
  const cLat = lat + (offsetM * py) / 111320;
  const cLng = lng + (offsetM * px) / (111320 * cosLat);
  const dLat = radiusM / 111320;
  const dLng = radiusM / (111320 * cosLat);
  return {
    type: 'Feature',
    id,
    properties: {
      id,
      kind: 'phase7_lateral_obstacle_fixture',
      class: 'car',
      label: '路上障害物(切り返し検証)',
      source: 'fixture',
      height: heightM
    },
    geometry: {
      type: 'Polygon',
      coordinates: [[
        [cLng - dLng, cLat - dLat],
        [cLng + dLng, cLat - dLat],
        [cLng + dLng, cLat + dLat],
        [cLng - dLng, cLat + dLat],
        [cLng - dLng, cLat - dLat]
      ]]
    }
  };
}

export function makeRouteOverheadFixture(route = [], {
  clearanceHeightM = 3.0,
  radiusM = 5,
  id = 'phase3:fixture:low-clearance'
} = {}) {
  if (!Array.isArray(route) || route.length < 2) return null;
  const p = route[Math.floor(route.length / 2)];
  const lat = Number(p?.lat);
  const lng = Number(p?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const dLat = radiusM / 111320;
  const dLng = radiusM / (111320 * Math.cos(lat * Math.PI / 180));
  return {
    type: 'Feature',
    id,
    properties: {
      id,
      kind: 'phase3_low_clearance_fixture',
      label: '低クリアランス検証',
      heightOnly: true,
      clearanceHeight: clearanceHeightM,
      h: clearanceHeightM
    },
    geometry: {
      type: 'Polygon',
      coordinates: [[
        [lng - dLng, lat - dLat],
        [lng + dLng, lat - dLat],
        [lng + dLng, lat + dLat],
        [lng - dLng, lat + dLat],
        [lng - dLng, lat - dLat]
      ]]
    }
  };
}
