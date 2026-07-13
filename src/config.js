export const DEFAULTS_HIDDEN = {
  useRoadGraph: true,
  uTurnAngleDeg: 165,
  sweepStep: 0.4,       // v7.2 fix: 0.8竊・.4 more accurate sweep polygon
  footprintStep: 0.4,   // v7.2 fix: 0.8竊・.4
  contactStep: 0.4,
  showClearanceHeatmap: true,
  heatmapMaxClear: 1.0,
  heatmapBuckets: 6
};

export const API_ENDPOINTS = {
  OVERPASS: [
    'https://lz4.overpass-api.de/api/interpreter',
    'https://z.overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass-api.de/api/interpreter',
    'https://overpass.openstreetmap.fr/api/interpreter'
  ],
  NOMINATIM_SEARCH: 'https://nominatim.openstreetmap.org/search',
  OSRM_ROUTE: 'https://router.project-osrm.org/route/v1/driving',
  ZIPS_BASE: 'https://api.zip-site.com/api'
};

// user_config.js・磯・蟶・ｨｭ螳壹ヵ繧｡繧､繝ｫ・峨・蛟､繧貞━蜈医＠縲∵悴險ｭ螳壽凾縺ｯ繝・ヵ繧ｩ繝ｫ繝亥､縺ｫ繝輔か繝ｼ繝ｫ繝舌ャ繧ｯ
const _runtime = (typeof window !== 'undefined' && window.LOGISTICS_RUNTIME_CONFIG) || {};
const _legacy = (typeof window !== 'undefined' && window.USER_CONFIG) || {};

function getRuntimeValue(key, fallback = '') {
  const runtimeValue = _runtime[key];
  if (runtimeValue !== undefined && runtimeValue !== null && runtimeValue !== '') return runtimeValue;
  const legacyValue = _legacy[key];
  if (legacyValue !== undefined && legacyValue !== null && legacyValue !== '') return legacyValue;
  return fallback;
}

function getRuntimeNumber(key, fallback) {
  const value = Number(getRuntimeValue(key, fallback));
  return Number.isFinite(value) ? value : fallback;
}

function getRuntimeBoolean(key, fallback = false) {
  const value = getRuntimeValue(key, fallback);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const lower = value.toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(lower)) return true;
    if (['0', 'false', 'no', 'off'].includes(lower)) return false;
  }
  return Boolean(value);
}

export const RUNTIME_CONFIG = Object.freeze({
  googleMapsApiKey: getRuntimeValue('googleMapsApiKey', ''),
  yoloServerUrl: getRuntimeValue('yoloServerUrl', ''),
  // Sprint1 P0-4: YOLO server X-Api-Key (must match server/app.py YOLO_API_KEY)
  yoloApiKey: getRuntimeValue('yoloApiKey', ''),
  remoteVoxelServerUrl: getRuntimeValue('remoteVoxelServerUrl', ''),
  satelliteTileUrlTemplate: getRuntimeValue('satelliteTileUrlTemplate', ''),
  satelliteTileAttribution: getRuntimeValue('satelliteTileAttribution', ''),
  satelliteTileMaxZoom: getRuntimeNumber('satelliteTileMaxZoom', 0),
  satelliteTileSize: getRuntimeNumber('satelliteTileSize', 0),
  satelliteTileName: getRuntimeValue('satelliteTileName', ''),
  plateauBuildingsUrl: getRuntimeValue('plateauBuildingsUrl', ''),
  defaultDriverSkill: getRuntimeNumber('defaultDriverSkill', 1.0),
  companyName: getRuntimeValue('companyName', ''),
  reporterName: getRuntimeValue('reporterName', ''),
  zipsEnabled: getRuntimeBoolean('zipsEnabled', false)
});

/**
 * Sprint1 P0-4: Helper that attaches X-Api-Key to YOLO server fetches.
 * @param {Record<string, string>} [extraHeaders]
 * @returns {Record<string, string>}
 */
export function yoloAuthHeaders(extraHeaders = {}) {
  const headers = { ...extraHeaders };
  const key = RUNTIME_CONFIG.yoloApiKey;
  if (key) headers['X-Api-Key'] = key;
  return headers;
}

export const GOOGLE_3D_TILES_KEY = RUNTIME_CONFIG.googleMapsApiKey;

export const ZIPS_CONFIG = Object.freeze({
  enabled: RUNTIME_CONFIG.zipsEnabled
});

export const VEHICLE_PRESETS = {
  '2t_flat': {
    label: '2t Flatbed', bodyType: 'flatbed',
    wheelBase: 2.5, frontOverhang: 1.08, rearOverhang: 1.11,
    vehicleWidth: 1.7, vehicleHeight: 2.0, grossWeight: 4.5, ratedPayloadT: 2,
    bedLength: 3.1, maxRearLoadLength: 3.41, maxLegalLength: 5.628,
    maxSteeringAngle: 40, templateTurnRadius: 6
  },
  '2t_unic': {
    label: '2t Unic', bodyType: 'unic',
    wheelBase: 2.5, frontOverhang: 1.08, rearOverhang: 1.11,
    vehicleWidth: 1.7, vehicleHeight: 2.0, grossWeight: 4.5, ratedPayloadT: 2,
    bedLength: 2.6, maxRearLoadLength: 2.86, maxLegalLength: 5.628,
    maxSteeringAngle: 40, templateTurnRadius: 6
  },
  '3t_flat': {
    label: '3t Flatbed', bodyType: 'flatbed',
    wheelBase: 3.4, frontOverhang: 1.1, rearOverhang: 1.7,
    vehicleWidth: 2.1, vehicleHeight: 2.2, grossWeight: 5.0, ratedPayloadT: 3,
    bedLength: 4.36, maxRearLoadLength: 4.796, maxLegalLength: 7.44,
    maxSteeringAngle: 40, templateTurnRadius: 7
  },
  '3t_unic': {
    label: '3t Unic', bodyType: 'unic',
    wheelBase: 3.4, frontOverhang: 1.1, rearOverhang: 1.7,
    vehicleWidth: 2.1, vehicleHeight: 2.2, grossWeight: 5.0, ratedPayloadT: 3,
    bedLength: 4.5, maxRearLoadLength: 4.95, maxLegalLength: 7.44,
    maxSteeringAngle: 40, templateTurnRadius: 7
  },
  '4t_flat': {
    label: '4t Flatbed', bodyType: 'flatbed',
    wheelBase: 4.69, frontOverhang: 1.31, rearOverhang: 2.0,
    vehicleWidth: 2.3, vehicleHeight: 2.5, grossWeight: 8.0, ratedPayloadT: 4,
    bedLength: 6.2, maxRearLoadLength: 6.82, maxLegalLength: 9.6,
    maxSteeringAngle: 42, templateTurnRadius: 8.5
  },
  '4t_unic': {
    label: '4t Unic', bodyType: 'unic',
    wheelBase: 4.69, frontOverhang: 1.31, rearOverhang: 2.0,
    vehicleWidth: 2.3, vehicleHeight: 2.5, grossWeight: 8.0, ratedPayloadT: 4,
    bedLength: 5.5, maxRearLoadLength: 6.05, maxLegalLength: 9.6,
    maxSteeringAngle: 42, templateTurnRadius: 8.5
  },
  '10t_unic': {
    label: '10t Unic', bodyType: 'unic',
    wheelBase: 6.5, frontOverhang: 1.5, rearOverhang: 4.0,
    vehicleWidth: 2.5, vehicleHeight: 3.6, grossWeight: 20, ratedPayloadT: 10,
    bedLength: 8.5, maxRearLoadLength: 9.35, maxLegalLength: 14.4,
    maxSteeringAngle: 45, templateTurnRadius: 11
  },
  'trailer_15t': {
    label: 'Trailer 15t', bodyType: 'trailer',
    wheelBase: 6.5, frontOverhang: 1.5, rearOverhang: 4.0,
    vehicleWidth: 2.5, vehicleHeight: 3.8, grossWeight: 25, ratedPayloadT: 15,
    bedLength: 8.7, maxRearLoadLength: 9.57, maxLegalLength: 14.4,
    maxSteeringAngle: 45, templateTurnRadius: 12
  }
};

export const DEFAULT_VEHICLE_PRESET = '4t_flat';

export const WIDTH_MARGIN_BY_CLASS = Object.freeze({
  narrow: 0.20,
  medium: 0.25,
  wide: 0.35,
  oversized: 0.45
});

export function getWidthMarginForVehicle(vehicleWidth) {
  const w = Number(vehicleWidth) || 0;
  if (w <= 2.0) return WIDTH_MARGIN_BY_CLASS.narrow;
  if (w <= 2.2) return WIDTH_MARGIN_BY_CLASS.medium;
  if (w <= 2.5) return WIDTH_MARGIN_BY_CLASS.wide;
  return WIDTH_MARGIN_BY_CLASS.oversized;
}

export function buildVehicleConfig(presetName = DEFAULT_VEHICLE_PRESET) {
  const preset = VEHICLE_PRESETS[presetName] ?? VEHICLE_PRESETS[DEFAULT_VEHICLE_PRESET];
  if (!preset) {
    console.error('[buildVehicleConfig] 繝励Μ繧ｻ繝・ヨ縺瑚ｦ九▽縺九ｊ縺ｾ縺帙ｓ:', presetName);
    return VEHICLE_PRESETS[DEFAULT_VEHICLE_PRESET] ? buildVehicleConfig(DEFAULT_VEHICLE_PRESET) : {};
  }
  const width = Number(preset.vehicleWidth) || 2.0;
  const wb = Number(preset.wheelBase) || 3.4;
  const fo = Number(preset.frontOverhang) || 1.0;
  const ro = Number(preset.rearOverhang) || 1.5;
  const turnRadius = Number(preset.templateTurnRadius) || 0;
  if (!Number.isFinite(width + wb + fo + ro)) {
    console.error('[buildVehicleConfig] 繝励Μ繧ｻ繝・ヨ縺ｫ荳肴ｭ｣縺ｪ蛟､:', presetName, preset);
  }
  const totalLength = wb + fo + ro;

  // P1-3: 譌ｧ widthMargin 蠑擾ｼ・.25 + 0.15*(w-1.7) + 0.03*(wb-3)・峨ｒ蟒・ｭ｢縲・  // 霆贋ｸ｡蟷・け繝ｩ繧ｹ蛻･縺ｮ繝ｫ繝・け繧｢繝・・陦ｨ縺ｫ鄂ｮ謠帙＠縲∬ｻ頑ｼ縺ｨ辟｡髢｢菫ゅ↑驕主､ｧ繝槭・繧ｸ繝ｳ繧呈椛蛻ｶ縲・  const widthMargin = getWidthMarginForVehicle(width);
  const widthMargin = getWidthMarginForVehicle(width);
  const vehicleSpeed = Math.max(3.0, Math.min(5.5, 5.2 - 0.25 * (wb - 4.5) - 0.15 * (width - 2.2)));
  // v8.0: lookahead繧貞ｮ滄圀縺ｮ繝峨Λ繧､繝舌・縺ｫ霑代＞蛟､縺ｫ蠑輔″荳翫￡・育洒縺吶℃繧九→S蟄玲険繧後・蜴溷屏・・  // 4t(8m霆・: 2.5m竊・.6m, 10t(12m霆・: 2.5m竊・.4m
  const lookaheadDistanceBase = Math.max(4.0, Math.min(10.0, 0.7 * totalLength));
  const lookaheadDistanceRatio = Math.max(0.5, Math.min(0.9, 0.62 + 0.04 * (vehicleSpeed - 4.5)));
  // 螟ｧ蝙玖ｻ翫・繧ｫ繝ｼ繝匁ｸ幃溘ｒ繧医ｊ蠑ｷ縺・  const curveReductionRatio = Math.max(0.5, Math.min(0.85, 0.6 + 0.04 * (turnRadius - 7)));

  const curveReductionRatio = Math.max(0.5, Math.min(0.85, 0.6 + 0.04 * (turnRadius - 7)));

  return {
    ...preset,
    widthMargin: Number(widthMargin.toFixed(2)),
    vehicleSpeed: Number(vehicleSpeed.toFixed(2)),
    lookaheadDistanceBase: Number(lookaheadDistanceBase.toFixed(1)),
    lookaheadDistanceRatio: Number(lookaheadDistanceRatio.toFixed(2)),
    curveReductionRatio: Number(curveReductionRatio.toFixed(2))
  };
}

export function getRearAxleMinTurnRadius(vehicleConfig = {}) {
  const wb = Number(vehicleConfig?.wheelBase) || 0;
  const maxSteerDeg = Number(vehicleConfig?.maxSteeringAngle) || 0;
  if (!(wb > 0) || !(maxSteerDeg > 0 && maxSteerDeg < 89.9)) return 0;
  const steerRad = maxSteerDeg * Math.PI / 180;
  const tanSteer = Math.tan(steerRad);
  if (!Number.isFinite(tanSteer) || Math.abs(tanSteer) < 1e-6) return 0;
  return wb / tanSteer;
}

export function getRouteTrackingTurnRadius(vehicleConfig = {}) {
  const rearAxleRadius = getRearAxleMinTurnRadius(vehicleConfig);
  const templateRadius = Number(vehicleConfig?.templateTurnRadius) || 0;
  if (!(rearAxleRadius > 0)) return templateRadius > 0 ? templateRadius : 0;
  if (!(templateRadius > 0)) return rearAxleRadius;
  return Math.min(templateRadius, Math.max(rearAxleRadius * 1.08, rearAxleRadius + 0.4));
}

export const DEFAULT_VEHICLE_CONFIG = buildVehicleConfig();

// ZIPS API function metadata (id/subid pairs for lmtinf)
export const ZIPS_FUNC_DATA = {
  address_to_bluemap: { id: '0002', subid: '0022' },
  bluemap_to_address: { id: '0002', subid: '0027' },
  address: { id: '0002', subid: '0001' },
  bm_address: { id: '0002', subid: '0007' },
  ac_standard: { id: '0004', subid: '0001' },
  ac_premium: { id: '0004', subid: '0003' },
  bluemap_cleansing: { id: '0004', subid: '0005' }
};

// Collision detection configuration
export const COLLISION_CONFIG = {
  checkIntervalFps: 12,
  bboxPadding: 0.0001,
  maxContactMarkers: 200,
  dangerColor: '#ef4444',
  warningColor: '#f59e0b',
  markerRadius: 1.5
};



// Obstacle detection classes for Street View analysis.
export const SV_OBSTACLE_CLASSES = new Set([
  'person', 'bicycle', 'motorcycle', 'car', 'truck', 'bus',
  'traffic cone', 'cone', 'barrier', 'construction',
  'traffic light', 'stop sign',
  'utility pole', 'electric pole', 'pole',
  'sign', 'road sign', 'signboard',
  'wire', 'overhead wire', 'cable', 'overhang',
  'fire hydrant', 'parking meter', 'bench',
  'guardrail', 'guard rail', 'curb', 'kerb', 'bollard', 'fence',
  'tree', 'plant'
]);

// Object profiles for obstacle proxy generation (meters).
export const OBSTACLE_PROFILES = {
  person: { height: 1.7, width: 0.5, radius: 0.5 },
  bicycle: { height: 1.5, width: 0.7, length: 1.8, radius: 0.6, box: true },
  motorcycle: { height: 1.4, width: 0.8, length: 2.1, radius: 0.7, box: true },
  car: { height: 1.5, width: 1.8, length: 4.5, radius: 1.25, box: true },
  truck: { height: 3.0, width: 2.5, length: 7.0, radius: 1.8, box: true },
  bus: { height: 3.2, width: 2.5, length: 9.5, radius: 1.9, box: true },
  'traffic light': { height: 5.5, width: 0.6, radius: 0.4, overhead: true },
  'stop sign': { height: 2.2, width: 0.6, radius: 0.3 },
  'utility pole': { height: 8.0, width: 0.35, radius: 0.25 },
  'electric pole': { height: 8.0, width: 0.35, radius: 0.25 },
  pole: { height: 8.0, width: 0.35, radius: 0.25 },
  sign: { height: 2.5, width: 0.5, radius: 0.3 },
  'road sign': { height: 2.5, width: 0.5, radius: 0.3 },
  signboard: { height: 2.5, width: 0.5, radius: 0.3 },
  wire: { height: 5.5, width: 0.1, length: 8.0, radius: 0.1, linear: true, overhead: true },
  'overhead wire': { height: 5.5, width: 0.1, length: 8.0, radius: 0.1, linear: true, overhead: true },
  cable: { height: 5.5, width: 0.1, length: 8.0, radius: 0.1, linear: true, overhead: true },
  overhang: { height: 2.7, width: 0.5, length: 4.0, radius: 1.0, linear: true, overhead: true },
  'fire hydrant': { height: 0.9, width: 0.4, radius: 0.3 },
  'parking meter': { height: 1.5, width: 0.3, radius: 0.2 },
  bench: { height: 0.9, width: 1.5, radius: 0.8 },
  guardrail: { height: 1.2, width: 0.3, length: 4.5, radius: 0.3, linear: true },
  'guard rail': { height: 1.2, width: 0.3, length: 4.5, radius: 0.3, linear: true },
  curb: { height: 0.2, width: 0.2, length: 3.0, radius: 0.2, linear: true },
  kerb: { height: 0.2, width: 0.2, length: 3.0, radius: 0.2, linear: true },
  bollard: { height: 0.9, width: 0.2, radius: 0.25 },
  fence: { height: 1.2, width: 0.25, length: 3.0, radius: 0.4, linear: true },
  tree: { height: 3.0, width: 1.2, radius: 1.1 },
  plant: { height: 1.2, width: 0.8, radius: 0.8 }
};

export function confidenceRadiusGain(conf) {
  const c = Number(conf);
  if (!Number.isFinite(c)) return 1.0;
  if (c >= 0.7) return 1.0;
  if (c >= 0.5) return 0.9;
  if (c >= 0.3) return 0.75;
  return 0.5;
}

// Default physical road widths by OSM highway type.
export const HIGHWAY_DEFAULT_WIDTH = Object.freeze({
  motorway: 14, motorway_link: 7,
  trunk: 12, trunk_link: 7,
  primary: 10, primary_link: 6,
  secondary: 8, secondary_link: 6,
  tertiary: 7, tertiary_link: 5,
  unclassified: 6,
  residential: 6,
  living_street: 5,
  service: 5,
  track: 3.5,
  footway: 2.0,
  path: 2.0,
  cycleway: 2.5,
  pedestrian: 4.0,
  steps: 1.5,
  bridleway: 2.5,
  corridor: 2.0,
  construction: 5.0,
  road: 5.0
});

// Delivery assessment configuration
export const DELIVERY_ASSESSMENT_CONFIG = {
  maxAdjustIterations: 0,
  scoreWeights: {
    coverageBase: 100,
    collisionPenaltyFactor: 50,
    okBonus: 10
  }
};
