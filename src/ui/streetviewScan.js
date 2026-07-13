import { store } from '../state.js';
import { SV_OBSTACLE_CLASSES, OBSTACLE_PROFILES, RUNTIME_CONFIG, confidenceRadiusGain, yoloAuthHeaders } from '../config.js';
import { densifyRouteLL, projectToNearestWay } from '../core/graph.js';
import { buildRoadUnion } from '../core/feasibility.js';
import { turf } from '../utils/geo.js';
import * as taskManager from './taskManager.js';
import { getMapInstance } from './map2d.js';
import { perceptionWidthAiConfidence } from '../core/vehicleRiskModel.js';

// 項目4: 地点キャッシュ（メモリ、開発時のみ localStorage, TTL）
// 同一路線・同一地点の再スキャン/再YOLOを避ける。画像本体は保存せず、
// パノラマ照会結果(pano)と YOLO 検出結果(det)は通常メモリ内だけに保持する。
const SV_CACHE_PREFIX = 'svcache:';
const SV_CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 日
const SV_CACHE_GRID_M = 5;                          // 約5m grid に量子化
const SV_CACHE_HEADING_BUCKET = 15;                 // 15°刻み
const _svMemCache = new Map();
let _svCacheStats = { panoHit: 0, panoMiss: 0, detHit: 0, detSent: 0 };

function _svAllowDerivedPersistentCache() {
  return typeof window !== 'undefined' && window.INDEX3D_ALLOW_STREETVIEW_DERIVED_CACHE === true;
}

// lat/lng を ~5m grid に丸め、heading を 15°刻みに量子化したキー。heading 省略時は位置のみ。
function _svGridKey(lat, lng, heading) {
  const la = Number(lat), ln = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln)) return null;
  const gLat = Math.round(la / (SV_CACHE_GRID_M / 111320));
  const mPerDegLng = 111320 * Math.cos(la * Math.PI / 180) || 1;
  const gLng = Math.round(ln / (SV_CACHE_GRID_M / mPerDegLng));
  if (heading == null) return `${gLat}_${gLng}`;
  const buckets = Math.round(360 / SV_CACHE_HEADING_BUCKET);
  const hb = ((Math.round((Number(heading) || 0) / SV_CACHE_HEADING_BUCKET) % buckets) + buckets) % buckets;
  return `${gLat}_${gLng}_${hb}`;
}

function _svCacheGet(kind, key) {
  if (!key) return null;
  const full = `${SV_CACHE_PREFIX}${kind}:${key}`;
  const mem = _svMemCache.get(full);
  if (mem) {
    if (mem.exp > Date.now()) return mem.data;
    _svMemCache.delete(full);
  }
  if (!_svAllowDerivedPersistentCache()) return null;
  try {
    const raw = localStorage.getItem(full);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || !(obj.exp > Date.now())) { localStorage.removeItem(full); return null; }
    _svMemCache.set(full, obj);
    return obj.data;
  } catch (_) {
    return null;
  }
}

function _svCacheSet(kind, key, data) {
  if (!key) return;
  const full = `${SV_CACHE_PREFIX}${kind}:${key}`;
  const obj = { exp: Date.now() + SV_CACHE_TTL_MS, data };
  _svMemCache.set(full, obj);
  if (!_svAllowDerivedPersistentCache()) return;
  try {
    localStorage.setItem(full, JSON.stringify(obj));
  } catch (_) {
    // localStorage 不可/容量超過時はメモリキャッシュのみで継続。
  }
}

// 開発/検証用: 永続キャッシュ全消し（明示的な開発フラグ有効時のみ）。
export function clearStreetViewCache() {
  _svMemCache.clear();
  _svCacheStats = { panoHit: 0, panoMiss: 0, detHit: 0, detSent: 0 };
  if (!_svAllowDerivedPersistentCache()) return 0;
  try {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(SV_CACHE_PREFIX)) keys.push(k);
    }
    keys.forEach((k) => localStorage.removeItem(k));
    return keys.length;
  } catch (_) {
    return 0;
  }
}

const EMPTY_FEATURE_COLLECTION = { type: 'FeatureCollection', features: [] };
function getBuildingsShownGeoJSON() {
  // 3D view is disabled in v8.2; keep this as a safe no-op source.
  return EMPTY_FEATURE_COLLECTION;
}

let lastFrames = [];
let scanToken = 0;
let analyzeToken = 0;
let segToken = 0;
let panorama = null;
let panoramaContainer = null;
let driveTimer = null;
let driveFrames = [];
let driveIndex = 0;
let appliedPerceptionWidthRoadIds = [];

// 笏笏 Street View viewpoint marker on Leaflet map 笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏笏
let _svViewpointMarker = null;

function _svViewpointArrowSvg(heading) {
  const h = Number(heading) || 0;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 36 36">
    <circle cx="18" cy="18" r="8" fill="#22d3ee" opacity="0.85"/>
    <circle cx="18" cy="18" r="6" fill="rgba(6,9,18,0.7)"/>
    <g transform="rotate(${h} 18 18)">
      <polygon points="18,4 22,16 18,13 14,16" fill="#22d3ee"/>
    </g>
  </svg>`;
}

function _updateSvViewpointMarker(lat, lng, heading) {
  const map = getMapInstance();
  if (!map || !window.L) return;
  const pos = [lat, lng];
  if (_svViewpointMarker) {
    _svViewpointMarker.setLatLng(pos);
    const el = _svViewpointMarker.getElement();
    const inner = el?.querySelector('.sv-vp-inner');
    if (inner) inner.innerHTML = _svViewpointArrowSvg(heading);
  } else {
    const icon = window.L.divIcon({
      className: 'sv-viewpoint-wrapper',
      html: `<div class="sv-vp-inner">${_svViewpointArrowSvg(heading)}</div>`,
      iconSize: [36, 36],
      iconAnchor: [18, 18],
    });
    _svViewpointMarker = window.L.marker(pos, { icon, zIndexOffset: 900, interactive: false, keyboard: false }).addTo(map);
  }
}

function _removeSvViewpointMarker() {
  const map = getMapInstance();
  if (_svViewpointMarker) {
    if (map) { try { map.removeLayer(_svViewpointMarker); } catch {} }
    _svViewpointMarker = null;
  }
}
let lastSegClassNames = [];
const OBSTACLE_ALLOWED_CLASSES = new Set(SV_OBSTACLE_CLASSES || ['person', 'traffic light', 'stop sign']);
const WIDTH_DET_CLASSES = new Set(['bicycle', 'motorcycle', 'car', 'truck', 'bus', 'train']);
const WIDTH_ESTIMATE = {
  confMin: 0.3,
  minBoxPx: 14,
  minDistance: 4,
  maxDistance: 45,
  minRouteOffset: 0.8,
  maxRouteOffset: 5,
  maxNearestDist: 14,
  percentile: 0.4,
  baseMargin: 0.5,
  minWidth: 3,
  maxWidth: 8
};
const SEG_SIDEWALK_CLASSES = new Set([
  'sidewalk',
  'sidewalk_paved',
  'sidewalk_unpaved',
  'crosswalk',
  'curb',
  'walkway',
  'pedestrian'
]);
const SEG_BUILDING_CLASSES = new Set([
  'building',
  'building-other',
  'wall',
  'fence',
  'garage',
  'house'
]);
const SEG_CLASS_FILTER = [...SEG_SIDEWALK_CLASSES, ...SEG_BUILDING_CLASSES];
const SEG_MIN_CONF = 0.35;
const SEG_CAMERA_HEIGHT_M = 1.6;
const SEG_FOV_H = 90;
const SEG_SIDEWALK_MIN_Y = 0.62;
const SEG_BUILDING_MIN_Y = 0.5;

function byId(id) {
  return document.getElementById(id);
}

function setStatus(msg) {
  const el = byId('svStatus');
  if (el) el.textContent = msg;
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function getGoogleMapsKey() {
  const script = document.querySelector('script[src*="maps.googleapis.com/maps/api/js"]');
  if (!script) return null;
  try {
    const url = new URL(script.src);
    return url.searchParams.get('key');
  } catch (e) {
    return null;
  }
}

function buildStreetViewUrl(lat, lng, heading, key) {
  if (!key) return null;
  const params = new URLSearchParams({
    size: '640x360',
    location: `${lat},${lng}`,
    heading: `${heading}`,
    pitch: '0',
    fov: '90',
    source: 'outdoor',
    key
  });
  return `https://maps.googleapis.com/maps/api/streetview?${params.toString()}`;
}

function getApiBase() {
  const inputVal = String(byId('yoloApiBase')?.value || '').trim();
  if (inputVal) return inputVal.replace(/\/$/, '');
  const list = byId('svFrameList');
  const raw = list?.dataset?.apiBase ?? '';
  const trimmed = String(raw).trim();
  const runtime = String(RUNTIME_CONFIG?.yoloServerUrl || '').trim();
  return trimmed ? trimmed.replace(/\/$/, '') : runtime.replace(/\/$/, '');
}

function getPanoramaContainer() {
  const pano = byId('svPano');
  if (pano) return pano;
  const viewport = byId('svViewport');
  if (viewport) return viewport;
  return byId('svPanorama');
}

function setStreetViewMode(show) {
  const wrap = byId('map3dWrap');
  if (wrap) wrap.classList.toggle('streetview-mode', !!show);
  const viewport = byId('svViewport');
  if (viewport) viewport.classList.toggle('active', !!show);
  const panel = byId('svPanorama');
  if (panel) panel.classList.toggle('active', !!show && !viewport);
}

function getTagValue(feature, key) {
  const props = feature?.properties && typeof feature.properties === 'object' ? feature.properties : {};
  const tags = props.tags && typeof props.tags === 'object' ? props.tags : null;
  return (tags && tags[key] != null ? tags[key] : props[key]) ?? null;
}

function isTruthyTag(value) {
  if (value == null) return false;
  const v = String(value).toLowerCase();
  return v === 'yes' || v === 'true' || v === '1';
}

function parseNumber(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isUndergroundFeature(feature) {
  if (isTruthyTag(getTagValue(feature, 'tunnel'))) return true;
  if (isTruthyTag(getTagValue(feature, 'covered'))) return true;
  const layer = parseNumber(getTagValue(feature, 'layer'));
  if (layer != null && layer < 0) return true;
  const level = parseNumber(getTagValue(feature, 'level') ?? getTagValue(feature, 'level:ref'));
  if (level != null && level < 0) return true;
  const location = String(getTagValue(feature, 'location') ?? '').toLowerCase();
  if (location.includes('underground') || location.includes('tunnel')) return true;
  return false;
}

function getSurfaceRoadUnion(state) {
  if (!state?.simRoute || state.simRoute.length < 2) return null;
  const roads = Array.isArray(state.geoJsonDataSets) ? state.geoJsonDataSets : [];
  if (!roads.length) return null;
  const surfaceRoads = roads.filter((f) => !isUndergroundFeature(f));
  if (!surfaceRoads.length) return null;

  let clipBox = null;
  try {
    const line = turf.lineString(state.simRoute.map((p) => [p.lng, p.lat]));
    const corridor = turf.buffer(line, 120, { units: 'meters', steps: 6 });
    clipBox = turf.bbox(corridor);
  } catch (e) { }

  const widthMargin = Number(state.vehicleConfig?.widthMargin ?? 0.3) || 0.3;
  const vehicleWidth = Number(state.vehicleConfig?.vehicleWidth ?? 0) || 0;
  const minW = vehicleWidth + Math.max(0, widthMargin) * 2;
  const defaultW = Math.max(2, 6, minW);

  return buildRoadUnion(surfaceRoads, defaultW, 0, clipBox);
}

function buildBuildingIndex(fc) {
  const features = Array.isArray(fc?.features)
    ? fc.features.filter((f) => {
      const g = f?.geometry;
      return !!g && (g.type === 'Polygon' || g.type === 'MultiPolygon');
    })
    : [];
  const bboxes = features.map((f) => {
    try {
      return turf.bbox(f);
    } catch (e) {
      return null;
    }
  });
  return { features, bboxes };
}

function bboxContainsPoint(bbox, lng, lat) {
  if (!bbox || bbox.length !== 4) return false;
  return lng >= bbox[0] && lng <= bbox[2] && lat >= bbox[1] && lat <= bbox[3];
}

function isPointInsideBuildings(point, index) {
  if (!index?.features?.length) return false;
  const [lng, lat] = point.geometry.coordinates;
  for (let i = 0; i < index.features.length; i++) {
    const bbox = index.bboxes[i];
    if (bbox && !bboxContainsPoint(bbox, lng, lat)) continue;
    try {
      if (turf.booleanPointInPolygon(point, index.features[i])) return true;
    } catch (e) { }
  }
  return false;
}

function isPointOnSurface(point, roadUnion, buildingIndex) {
  if (roadUnion) {
    try {
      if (!turf.booleanPointInPolygon(point, roadUnion)) return false;
    } catch (e) { }
  }
  if (isPointInsideBuildings(point, buildingIndex)) return false;
  return true;
}

function getObjectProfile(name) {
  const key = normalizeSegName(name);
  const profile = OBSTACLE_PROFILES?.[key];
  if (profile) return profile;
  if (key === 'bicycle') return { height: 1.5, width: 0.7, radius: 0.6 };
  if (key === 'motorcycle') return { height: 1.4, width: 0.8, radius: 0.6 };
  if (key === 'car') return { height: 1.5, width: 1.8, radius: 1.2 };
  if (key === 'truck') return { height: 3.0, width: 2.5, radius: 1.6 };
  if (key === 'bus') return { height: 3.2, width: 2.5, radius: 1.8 };
  if (key === 'train') return { height: 3.5, width: 3.0, radius: 2.0 };
  return { height: 1.7, width: 0.8, radius: 0.8 };
}

function isHeightObstacle(name) {
  const key = normalizeSegName(name);
  return key === 'wire' || key === 'overhead wire' || key === 'cable';
}

function estimateDetectionPoint(frame, det, opts = {}) {
  const imageSize = frame?.imageSize;
  if (!imageSize) return null;
  const width = Number(imageSize.width);
  const height = Number(imageSize.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  const bbox = det?.bbox;
  if (!Array.isArray(bbox) || bbox.length < 4) return null;
  const [x1, y1, x2, y2] = bbox.map((v) => Number(v));
  if (![x1, y1, x2, y2].every((v) => Number.isFinite(v))) return null;
  const boxH = Math.max(1, y2 - y1);
  const boxW = Math.max(1, x2 - x1);
  const minBoxPx = Number(opts.minBoxPx ?? 0);
  if (Number.isFinite(minBoxPx) && minBoxPx > 0 && (boxH < minBoxPx || boxW < minBoxPx)) return null;
  const cx = width / 2;
  const xCenter = (x1 + x2) / 2;

  const fovH = 90 * Math.PI / 180;
  const fovV = 2 * Math.atan(Math.tan(fovH / 2) * (height / width));
  const focalX = (width / 2) / Math.tan(fovH / 2);
  const focalY = (height / 2) / Math.tan(fovV / 2);

  const profile = getObjectProfile(det?.name);
  const distH = profile.height ? (profile.height * focalY) / boxH : null;
  const distW = profile.width ? (profile.width * focalX) / boxW : null;
  let distRaw = distH ?? distW;
  if (distH && distW) {
    const aspect = boxW / boxH;
    const wWeight = clampValue((aspect - 0.7) / 1.2, 0, 0.8);
    distRaw = distH * (1 - wWeight) + distW * wWeight;
  }
  if (!Number.isFinite(distRaw)) return null;
  const minDistance = Number(opts.minDistance ?? 2);
  const maxDistance = Number(opts.maxDistance ?? 60);
  const dist = clampValue(distRaw, minDistance, maxDistance);
  const angleOffset = Math.atan((xCenter - cx) / focalX);
  const heading = (Number(frame?.heading ?? 0) || 0) + (angleOffset * 180) / Math.PI;

  return {
    distance: dist,
    heading,
    angleOffset,
    lateral: Math.abs(Math.sin(angleOffset) * dist)
  };
}

function clampValue(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function normalizeSegName(name) {
  return String(name || '').trim().toLowerCase();
}

function isSegClass(name, allowed) {
  if (!allowed || !allowed.size) return false;
  return allowed.has(normalizeSegName(name));
}

function pixelToGroundOffset(px, py, imageSize, { fovH = SEG_FOV_H, cameraHeight = SEG_CAMERA_HEIGHT_M } = {}) {
  if (!imageSize) return null;
  const width = Number(imageSize.width);
  const height = Number(imageSize.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  const nx = (px / width) * 2 - 1;
  const ny = 1 - (py / height) * 2;
  const fovHrad = (fovH * Math.PI) / 180;
  const tanH = Math.tan(fovHrad / 2);
  const fovVrad = 2 * Math.atan(Math.tan(fovHrad / 2) * (height / width));
  const tanV = Math.tan(fovVrad / 2);
  const dx = nx * tanH;
  const dy = ny * tanV;
  const dz = 1;
  if (dy >= -0.01) return null;
  const t = cameraHeight / -dy;
  const forward = dz * t;
  const lateral = dx * t;
  if (!Number.isFinite(forward) || !Number.isFinite(lateral) || forward <= 0) return null;
  return { forward, lateral };
}

function offsetToLatLng(origin, headingDeg, offset) {
  if (!origin || !offset || !turf?.destination) return null;
  const forwardKm = offset.forward / 1000;
  const lateralKm = Math.abs(offset.lateral) / 1000;
  const bearing = Number.isFinite(headingDeg) ? headingDeg : 0;
  const forwardPt = turf.destination([origin.lng, origin.lat], forwardKm, bearing, { units: 'kilometers' });
  const lateralHeading = bearing + (offset.lateral >= 0 ? 90 : -90);
  const lateralPt = turf.destination(forwardPt, lateralKm, lateralHeading, { units: 'kilometers' });
  const coords = lateralPt?.geometry?.coordinates;
  if (!coords) return null;
  return { lng: coords[0], lat: coords[1] };
}

function pickBoundaryPoints(segments, imageSize, classSet, minYRatio) {
  if (!segments || !segments.length || !imageSize) return { left: null, right: null };
  const height = Number(imageSize.height);
  const width = Number(imageSize.width);
  if (!Number.isFinite(height) || !Number.isFinite(width) || height <= 0 || width <= 0) return { left: null, right: null };
  const minY = height * minYRatio;
  const centerX = width / 2;
  let left = null;
  let right = null;

  segments.forEach((seg) => {
    const name = normalizeSegName(seg?.name);
    if (!isSegClass(name, classSet)) return;
    const conf = Number(seg?.conf ?? 0);
    if (!Number.isFinite(conf) || conf < SEG_MIN_CONF) return;
    const mask = Array.isArray(seg?.mask) ? seg.mask : [];
    mask.forEach((pt) => {
      const x = Number(pt?.[0]);
      const y = Number(pt?.[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      if (y < minY) return;
      if (x <= centerX) {
        if (!left || x > left.x) left = { x, y };
      }
      if (x >= centerX) {
        if (!right || x < right.x) right = { x, y };
      }
    });
  });

  return { left, right };
}

function updateTruckOverlay(state = store.getState()) {
  const overlay = byId('svTruckOverlay');
  if (!overlay) return;
  const cfg = state?.vehicleConfig || {};
  const wheelBase = Number(cfg.wheelBase ?? 0);
  const front = Number(cfg.frontOverhang ?? 0);
  const rear = Number(cfg.rearOverhang ?? 0);
  const lengthM = wheelBase + front + rear;
  const widthM = Number(cfg.vehicleWidth ?? 2.0) + Number(cfg.widthMargin ?? 0.3) * 2;
  const heightM = Number(cfg.vehicleHeight ?? 2.2);

  const widthPx = clampValue(widthM * 80, 160, 340);
  const lengthPx = clampValue(lengthM * 55, 220, 480);
  const heightPx = clampValue(heightM * 30, 60, 160);
  overlay.style.setProperty('--sv-truck-width', `${widthPx.toFixed(0)}px`);
  overlay.style.setProperty('--sv-truck-length', `${lengthPx.toFixed(0)}px`);
  overlay.style.setProperty('--sv-truck-height', `${heightPx.toFixed(0)}px`);
}

function median(values) {
  const arr = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!arr.length) return null;
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

function percentile(values, p) {
  const arr = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!arr.length) return null;
  if (p <= 0) return arr[0];
  if (p >= 1) return arr[arr.length - 1];
  const idx = (arr.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return arr[lo];
  const t = idx - lo;
  return arr[lo] * (1 - t) + arr[hi] * t;
}

function featureIdOf(feature) {
  if (!feature) return null;
  if (feature.id != null) return String(feature.id);
  const pid = feature.properties?.id;
  if (pid != null) return String(pid);
  return null;
}

function sampleRoute(simRoute, spacingMeters, maxFrames) {
  if (!Array.isArray(simRoute) || simRoute.length < 2) return [];
  const dense = densifyRouteLL(simRoute, spacingMeters);
  if (!dense || dense.length < 2) return [];

  let points = dense;
  if (Number.isFinite(maxFrames) && maxFrames > 0 && dense.length > maxFrames) {
    const step = Math.max(1, Math.ceil(dense.length / maxFrames));
    points = dense.filter((_, idx) => idx % step === 0);
    const last = dense[dense.length - 1];
    const tail = points[points.length - 1];
    if (!tail || tail.lat !== last.lat || tail.lng !== last.lng) points.push(last);
  }

  const out = [];
  for (let i = 0; i < points.length; i++) {
    const cur = points[i];
    // Y1: 譛ｫ蟆ｾ轤ｹ縺ｯ谺｡縺悟ｭ伜惠縺励↑縺・◆繧√∫峩蜑咲せ竊堤樟蝨ｨ轤ｹ縺ｮ譁ｹ蜷代ｒ豬∫畑縺吶ｋ
    //     莉･蜑阪・ points[i-1] 繧・next 縺ｫ縺励※縺翫ｊ騾・婿蜷代↓縺ｪ縺｣縺ｦ縺・◆
    let heading = 0;
    try {
      if (i + 1 < points.length) {
        // 騾壼ｸｸ: cur 竊・next
        heading = turf.bearing(turf.point([cur.lng, cur.lat]), turf.point([points[i + 1].lng, points[i + 1].lat]));
      } else if (i > 0) {
        // 譛ｫ蟆ｾ: prev 竊・cur 縺ｮ譁ｹ蜷代ｒ邯呎価
        heading = turf.bearing(turf.point([points[i - 1].lng, points[i - 1].lat]), turf.point([cur.lng, cur.lat]));
      }
    } catch (e) {
      heading = 0;
    }
    if (!Number.isFinite(heading)) heading = 0;
    if (heading < 0) heading += 360;
    out.push({ lat: cur.lat, lng: cur.lng, heading });
  }
  return out;
}

function fetchPanorama(service, lat, lng) {
  return new Promise((resolve) => {
    if (!service || !window.google?.maps) return resolve(null);
    const outdoor = window.google?.maps?.StreetViewSource?.OUTDOOR;
    const req = { location: { lat, lng }, radius: 50 };
    if (outdoor) req.source = outdoor;
    service.getPanorama(
      req,
      (data, status) => {
        if (status !== 'OK' || !data?.location?.latLng) return resolve(null);
        const loc = data.location.latLng;
        resolve({
          panoId: data.location.pano ?? null,
          lat: loc.lat(),
          lng: loc.lng()
        });
      }
    );
  });
}

function renderFrames(frames) {
  const list = byId('svFrameList');
  if (!list) return;
  list.innerHTML = '';
  frames.forEach((frame) => {
    const card = document.createElement('div');
    card.className = 'sv-frame';

    if (frame.url) {
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.src = frame.url;
      img.alt = 'Street View';
      card.appendChild(img);
    }

    const caption = document.createElement('div');
    caption.className = 'sv-caption';
    const hit = frame.hit ? 'hit' : 'miss';
    const detCount = Number(frame.detCount ?? frame.detections?.length ?? 0);
    const detText = Number.isFinite(detCount) && detCount > 0 ? ` | det ${detCount}` : '';
    caption.textContent = `${hit} ${frame.lat.toFixed(5)}, ${frame.lng.toFixed(5)}${detText}`;
    card.appendChild(caption);
    list.appendChild(card);
  });
}

function showPanorama(show) {
  setStreetViewMode(show);
}

function streetViewDisplayEnabled() {
  if (typeof window === 'undefined') return false;
  return window.INDEX3D_ENABLE_GOOGLE_STREETVIEW === true || window.INDEX3D_ENABLE_STREETVIEW_YOLO === true;
}

export function showStreetViewAt(lat, lng, heading = 0) {
  if (!streetViewDisplayEnabled()) {
    setStatus('Street View: disabled by commercial-clean settings');
    return false;
  }
  const viewport = byId('svViewport');
  if (viewport) viewport.style.display = 'block';
  _updateSvViewpointMarker(lat, lng, heading);
  const pano = ensurePanorama();
  if (!pano) {
    // Google Maps API 譛ｪ繝ｭ繝ｼ繝画凾縺ｯ繝悶Λ繧ｦ繧ｶ縺ｧStreet View繧帝幕縺・    const url = `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat},${lng}&heading=${heading || 0}&pitch=0`;
    window.open(url, '_blank', 'noopener');
    return true;
  }
  pano.setPosition({ lat, lng });
  pano.setPov({ heading: heading || 0, pitch: 0 });
  return true;
}

function ensurePanorama() {
  if (!window.google?.maps) return null;
  const container = getPanoramaContainer();
  if (!container) return null;
  if (panorama && panoramaContainer === container) {
    showPanorama(true);
    return panorama;
  }
  showPanorama(true);
  panorama = new window.google.maps.StreetViewPanorama(container, {
    addressControl: false,
    fullscreenControl: false,
    linksControl: false,
    motionTracking: false,
    panControl: false,
    zoomControl: false,
    enableCloseButton: false,
    visible: true
  });
  panoramaContainer = container;
  return panorama;
}

function getDriveIntervalMs() {
  const speed = clampNumber(byId('playbackSpeed')?.value, 0.2, 2.0, 0.6);
  return Math.round(900 / Math.max(0.2, speed));
}

function getSyncIntervalMs(state, spacingMeters) {
  const speed = Math.max(0.5, Number(state?.vehicleConfig?.vehicleSpeed ?? 4));
  const speedMul = clampNumber(byId('playbackSpeed')?.value, 0.2, 2.0, 0.6);
  const metersPerSec = speed * Math.max(0.2, speedMul);
  const spacing = Math.max(5, Number(spacingMeters) || 15);
  return Math.round((spacing / metersPerSec) * 1000);
}

function stopDrive() {
  if (driveTimer) clearInterval(driveTimer);
  driveTimer = null;
  driveFrames = [];
  driveIndex = 0;
}

function clearAppliedPerceptionWidths() {
  const ids = appliedPerceptionWidthRoadIds.map((id) => String(id)).filter(Boolean);
  if (ids.length) store.clearPerceptionWidthAi(ids);
  appliedPerceptionWidthRoadIds = [];
}

function driveStreetView() {
  if (!lastFrames.length) {
    setStatus('Street View: scan first');
    return;
  }
  const frames = lastFrames.filter((f) => f.hit && Number.isFinite(f.lat) && Number.isFinite(f.lng));
  if (!frames.length) {
    setStatus('Street View: no usable frames');
    return;
  }
  updateTruckOverlay();
  const pano = ensurePanorama();
  if (!pano) {
    setStatus('Street View: panorama unavailable');
    return;
  }

  stopDrive();
  driveFrames = frames;

  const tick = () => {
    const frame = driveFrames[driveIndex];
    if (!frame) return;
    if (frame.panoId) pano.setPano(frame.panoId);
    pano.setPosition({ lat: frame.lat, lng: frame.lng });
    pano.setPov({ heading: frame.heading || 0, pitch: 0 });
    _updateSvViewpointMarker(frame.lat, frame.lng, frame.heading || 0);
    driveIndex = (driveIndex + 1) % driveFrames.length;
    setStatus(`Street View: drive ${driveIndex}/${driveFrames.length}`);
  };

  tick();
  driveTimer = setInterval(tick, getDriveIntervalMs());
}

function buildDriveFramesForSync(state) {
  const scanned = lastFrames.filter((f) => f.hit && Number.isFinite(f.lat) && Number.isFinite(f.lng));
  if (scanned.length) return { frames: scanned, spacing: clampNumber(byId('svSpacing')?.value, 5, 50, 15) };

  const spacing = clampNumber(byId('svSpacing')?.value, 5, 50, 15);
  const maxFrames = clampNumber(byId('svMaxFrames')?.value, 6, 80, 24);
  const samples = sampleRoute(state.simRoute, spacing, maxFrames);
  if (!samples.length) return { frames: [], spacing };

  const roadUnion = getSurfaceRoadUnion(state);
  const buildingIndex = buildBuildingIndex(getBuildingsShownGeoJSON());
  const surfaceSamples = samples.filter((sample) => {
    const pt = turf.point([sample.lng, sample.lat]);
    return isPointOnSurface(pt, roadUnion, buildingIndex);
  });
  return { frames: surfaceSamples.length ? surfaceSamples : samples, spacing };
}

export function startStreetViewSync() {
  const state = store.getState();
  if (!state.simRoute || state.simRoute.length < 2) {
    setStatus('Street View: route missing');
    return;
  }
  updateTruckOverlay(state);
  const pano = ensurePanorama();
  if (!pano) {
    setStatus('Street View: panorama unavailable');
    return;
  }

  const { frames, spacing } = buildDriveFramesForSync(state);
  if (!frames.length) {
    setStatus('Street View: no frames');
    return;
  }

  stopDrive();
  driveFrames = frames;

  const intervalMs = getSyncIntervalMs(state, spacing);
  const tick = () => {
    const frame = driveFrames[driveIndex];
    if (!frame) return;
    if (frame.panoId) pano.setPano(frame.panoId);
    pano.setPosition({ lat: frame.lat, lng: frame.lng });
    pano.setPov({ heading: frame.heading || 0, pitch: 0 });
    driveIndex = (driveIndex + 1) % driveFrames.length;
    setStatus(`Street View: sync ${driveIndex}/${driveFrames.length}`);
  };

  tick();
  driveTimer = setInterval(tick, Math.max(200, intervalMs));
}

export function stopStreetViewSync() {
  stopDrive();
}

export async function scanStreetView() {
  const state = store.getState();
  stopDrive();
  lastFrames = [];
  renderFrames([]);
  if (!state.simRoute || state.simRoute.length < 2) {
    setStatus('Street View: set a route first');
    return { ok: false, reason: 'route_missing' };
  }

  const taskId = 'sv-scan-' + Date.now();
  taskManager.createTask(taskId, 'Street View 繧ｹ繧ｭ繝｣繝ｳ荳ｭ...');

  const spacing = clampNumber(byId('svSpacing')?.value, 5, 50, 15);
  const maxFrames = clampNumber(byId('svMaxFrames')?.value, 6, 80, 24);
  const samples = sampleRoute(state.simRoute, spacing, maxFrames);

  const roadUnion = getSurfaceRoadUnion(state);
  const buildingIndex = buildBuildingIndex(getBuildingsShownGeoJSON());
  let surfaceSamples = samples.filter((sample) => {
    const pt = turf.point([sample.lng, sample.lat]);
    return isPointOnSurface(pt, roadUnion, buildingIndex);
  });
  const usingFallbackSamples = surfaceSamples.length === 0;

  if (usingFallbackSamples) {
    surfaceSamples = samples;
    setStatus('Street View: no surface mask; using route samples');
  }
  if (!surfaceSamples.length) {
    setStatus('Street View: no route samples');
    taskManager.removeTask(taskId);
    return { ok: false, reason: 'no_route_samples' };
  }

  scanToken += 1;
  const token = scanToken;
  const key = getGoogleMapsKey();
  if (!key) {
    setStatus('Street View: Google Maps API key missing');
    taskManager.removeTask(taskId);
    return { ok: false, reason: 'google_key_missing' };
  }
  const service = window.google?.maps?.StreetViewService ? new window.google.maps.StreetViewService() : null;
  let hits = 0;
  const frames = [];

  for (let i = 0; i < surfaceSamples.length; i++) {
    if (token !== scanToken) {
      taskManager.removeTask(taskId);
      return { ok: false, reason: 'cancelled' };
    }
    const sample = surfaceSamples[i];
    // 項目4: パノラマ照会は位置キャッシュ（miss も {miss:true} で保存して再照会を避ける）。
    let pano = null;
    if (service) {
      const panoKey = _svGridKey(sample.lat, sample.lng, null);
      const cached = _svCacheGet('pano', panoKey);
      if (cached) {
        _svCacheStats.panoHit += 1;
        pano = cached.miss ? null : cached;
      } else {
        _svCacheStats.panoMiss += 1;
        pano = await fetchPanorama(service, sample.lat, sample.lng);
        _svCacheSet('pano', panoKey, pano || { miss: true });
      }
    }
    const useLat = pano?.lat ?? sample.lat;
    const useLng = pano?.lng ?? sample.lng;
    const pt = turf.point([useLng, useLat]);
    const onSurface = isPointOnSurface(pt, roadUnion, buildingIndex);
    const canUse = service ? (!!pano && (onSurface || usingFallbackSamples)) : true;
    if (canUse) hits += 1;
    const url = canUse ? buildStreetViewUrl(useLat, useLng, sample.heading, key) : null;
    frames.push({
      ...sample,
      lat: useLat,
      lng: useLng,
      hit: canUse,
      panoId: pano?.panoId ?? null,
      url,
      surfaceOk: onSurface
    });

    const progress = (i + 1) / surfaceSamples.length;
    taskManager.updateTask(taskId, progress, `繧ｹ繧ｭ繝｣繝ｳ荳ｭ (${i + 1}/${surfaceSamples.length})`);
  }

  lastFrames = frames;
  renderFrames(frames);
  const mode = service ? 'pano' : 'static-fallback';
  console.log(`[SV cache] pano hit ${_svCacheStats.panoHit} / miss ${_svCacheStats.panoMiss}`);
  if (hits === 0) {
    // 失敗理由を握りつぶさず明示する（パノラマが1枚も見つからない）。
    setStatus(`Street View: パノラマ未取得 (0/${surfaceSamples.length}) — 地点にSV画像が無い可能性`);
  } else {
    setStatus(`Street View: done (${hits}/${surfaceSamples.length}, ${mode}, cache ${_svCacheStats.panoHit}hit)`);
  }
  taskManager.updateTask(taskId, 1.0, 'Street View scan complete');
  setTimeout(() => taskManager.removeTask(taskId), 1500);
  return { ok: true, frames, hits, total: surfaceSamples.length, mode, cacheHits: _svCacheStats.panoHit };
}

export async function analyzeStreetView() {
  if (!lastFrames.length) {
    setStatus('YOLO: scan first');
    return { ok: false, reason: 'scan_first' };
  }

  const taskId = 'sv-analyze-' + Date.now();
  taskManager.createTask(taskId, 'AI蛻・梵 (YOLO) 螳溯｡御ｸｭ...');

  analyzeToken += 1;
  const token = analyzeToken;

  // 項目4: 検出キャッシュ（位置+heading）でヒットしたフレームは YOLO へ送らない。
  const cachedByIdx = new Map();   // idx -> {detections, imageSize}
  const keyByIdx = new Map();      // idx -> detKey（新規結果の保存用）
  const items = [];                // 未キャッシュのみ送信
  lastFrames.forEach((frame, idx) => {
    if (!frame.url) return;
    const detKey = _svGridKey(frame.lat, frame.lng, frame.heading);
    keyByIdx.set(idx, detKey);
    const cached = _svCacheGet('det', detKey);
    if (cached) {
      _svCacheStats.detHit += 1;
      cachedByIdx.set(idx, cached);
    } else {
      items.push({ id: String(idx), image_url: frame.url, lat: frame.lat, lng: frame.lng, heading: frame.heading });
    }
  });

  if (!items.length && !cachedByIdx.size) {
    setStatus('YOLO: no images');
    taskManager.removeTask(taskId);
    return { ok: false, reason: 'no_images' };
  }

  const applyResults = (freshById) => {
    let totalDet = 0;
    lastFrames = lastFrames.map((frame, idx) => {
      const fresh = freshById ? freshById.get(String(idx)) : null;
      const item = fresh || cachedByIdx.get(idx);
      if (!item) return frame;
      const dets = Array.isArray(item.detections) ? item.detections : [];
      totalDet += dets.length;
      const imageSize = item.image_size || item.imageSize || frame.imageSize;
      return { ...frame, detections: dets, detCount: dets.length, imageSize };
    });
    return totalDet;
  };

  // 全フレームがキャッシュ済みなら YOLO サーバ不要でそのまま適用。
  if (!items.length) {
    const totalDet = applyResults(null);
    renderFrames(lastFrames);
    console.log(`[YOLO cache] hit ${_svCacheStats.detHit} / sent 0 (all cached)`);
    setStatus(`YOLO: done (${totalDet} dets, cache ${cachedByIdx.size}hit, 0 sent)`);
    taskManager.updateTask(taskId, 1.0, `蛻・梵螳御ｺ・(${totalDet} 讀懷・, cache)`);
    setTimeout(() => taskManager.removeTask(taskId), 2000);
    return { ok: true, detections: totalDet, frames: lastFrames.slice(), cacheHits: cachedByIdx.size, sent: 0 };
  }

  const apiBase = getApiBase();
  if (!apiBase) {
    setStatus('YOLO: server not configured');
    taskManager.removeTask(taskId);
    throw new Error('YOLO server is not configured');
  }

  try {
    const payload = { items };
    _svCacheStats.detSent += items.length;
    taskManager.updateTask(taskId, 0.2, `繧ｵ繝ｼ繝舌・縺ｸ騾∽ｿ｡荳ｭ... (${items.length}匹, cache ${cachedByIdx.size})`);

    const res = await fetch(`${apiBase}/detect-batch`, {
      method: 'POST',
      headers: yoloAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload)
    });

    if (token !== analyzeToken) {
      taskManager.removeTask(taskId);
      return { ok: false, reason: 'cancelled' };
    }
    if (!res.ok) {
      setStatus(`YOLO: failed (${res.status}) — サーバ応答エラー`);
      taskManager.removeTask(taskId);
      return { ok: false, reason: `http_${res.status}` };
    }

    taskManager.updateTask(taskId, 0.7, '邨先棡繧貞女菫｡荳ｭ...');
    const data = await res.json();
    const respItems = Array.isArray(data?.items) ? data.items : [];
    const byIdMap = new Map(respItems.map((item) => [String(item.id ?? ''), item]));

    // 新規結果をキャッシュへ保存（idx→key で対応付け）。
    byIdMap.forEach((item, idStr) => {
      const idx = Number(idStr);
      const detKey = keyByIdx.get(idx);
      if (!detKey) return;
      _svCacheSet('det', detKey, {
        detections: Array.isArray(item.detections) ? item.detections : [],
        imageSize: item.image_size || null
      });
    });

    const totalDet = applyResults(byIdMap);
    renderFrames(lastFrames);
    console.log(`[YOLO cache] hit ${_svCacheStats.detHit} / sent ${items.length}`);
    if (totalDet === 0) {
      // 検出ゼロを握りつぶさない（道路に対象物が写っていない/画像品質）。
      setStatus(`YOLO: 検出ゼロ (${items.length}匹送信, cache ${cachedByIdx.size}) — 画像に対象物が写っていない可能性`);
    } else {
      setStatus(`YOLO: done (${totalDet} dets, ${items.length} sent, cache ${cachedByIdx.size}hit)`);
    }
    taskManager.updateTask(taskId, 1.0, `蛻・梵螳御ｺ・(${totalDet} 讀懷・)`);
    setTimeout(() => taskManager.removeTask(taskId), 2000);
    return { ok: true, detections: totalDet, frames: lastFrames.slice(), cacheHits: cachedByIdx.size, sent: items.length };
  } catch (e) {
    const isNetErr = e instanceof TypeError && /fetch|network/i.test(e.message);
    if (isNetErr) {
      setStatus('YOLO: server is not running');
      console.warn('[analyzeStreetView] YOLO server is not reachable.');
    } else {
      console.warn('YOLO analysis failed', e);
      setStatus('YOLO: error');
    }
    taskManager.removeTask(taskId);
    throw e;
  }
}

async function segmentFallback(apiBase, items, classes, token) {
  const outItems = [];
  let totalSeg = 0;
  for (const item of items) {
    if (token !== segToken) return null;
    try {
      const res = await fetch(`${apiBase}/segment`, {
        method: 'POST',
        headers: yoloAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ image_url: item.image_url, classes })
      });
      if (!res.ok) {
        if (res.status === 404) return null;
        let detail = '';
        try {
          detail = await res.text();
        } catch (e) { }
        outItems.push({
          id: item.id,
          error: `HTTP ${res.status}${detail ? `: ${detail.slice(0, 120)}` : ''}`,
          lat: item.lat,
          lng: item.lng,
          heading: item.heading
        });
        continue;
      }
      const data = await res.json();
      if (Array.isArray(data?.class_names)) lastSegClassNames = data.class_names;
      const segs = Array.isArray(data?.segments) ? data.segments : [];
      totalSeg += segs.length;
      outItems.push({
        id: item.id,
        segments: segs,
        image_size: data?.image_size,
        lat: item.lat,
        lng: item.lng,
        heading: item.heading
      });
    } catch (e) {
      outItems.push({
        id: item.id,
        error: e?.message || 'segment failed',
        lat: item.lat,
        lng: item.lng,
        heading: item.heading
      });
    }
  }
  return { items: outItems, totalSeg };
}

async function analyzeStreetViewSeg() {
  if (!lastFrames.length) {
    setStatus('SEG: scan first');
    return;
  }
  segToken += 1;
  const token = segToken;
  const apiBase = getApiBase();
  const items = lastFrames
    .map((frame, idx) => ({
      id: String(idx),
      image_url: frame.url,
      lat: frame.lat,
      lng: frame.lng,
      heading: frame.heading
    }))
    .filter((item) => !!item.image_url);
  if (!items.length) {
    setStatus('SEG: no images');
    return;
  }
  const payload = { items, classes: SEG_CLASS_FILTER };

  setStatus('SEG: analyzing...');
  let res = null;
  try {
    res = await fetch(`${apiBase}/segment-batch`, {
      method: 'POST',
      headers: yoloAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload)
    });
  } catch (e) {
    if (token !== segToken) return;
    setStatus(`SEG: server unreachable (${e.message || 'network error'})`);
    return;
  }
  if (token !== segToken) return;
  if (res.status === 404) {
    setStatus('SEG: batch missing, trying /segment ...');
    const fallback = await segmentFallback(apiBase, items, payload.classes, token);
    if (token !== segToken) return;
    if (!fallback) {
      setStatus('SEG: endpoint missing (restart server app.py)');
      return;
    }
    const byId = new Map(fallback.items.map((item) => [String(item.id ?? ''), item]));
    lastFrames = lastFrames.map((frame, idx) => {
      const item = byId.get(String(idx));
      if (!item) return frame;
      const segs = Array.isArray(item.segments) ? item.segments : [];
      const imageSize = item.image_size && typeof item.image_size === 'object' ? item.image_size : frame.imageSize;
      return { ...frame, segments: segs, segCount: segs.length, segImageSize: imageSize };
    });
    renderFrames(lastFrames);
    setStatus(`SEG: done (${fallback.totalSeg} segs)`);
    return;
  }
  if (!res.ok) {
    let detail = '';
    try {
      detail = await res.text();
    } catch (e) { }
    setStatus(`SEG: failed (${res.status})${detail ? ` ${detail.slice(0, 120)}` : ''}`);
    return;
  }
  const data = await res.json();
  if (Array.isArray(data?.class_names)) lastSegClassNames = data.class_names;
  const respItems = Array.isArray(data?.items) ? data.items : [];
  const byId = new Map(respItems.map((item) => [String(item.id ?? ''), item]));
  let totalSeg = 0;

  lastFrames = lastFrames.map((frame, idx) => {
    const item = byId.get(String(idx));
    if (!item) return frame;
    const segs = Array.isArray(item.segments) ? item.segments : [];
    totalSeg += segs.length;
    const imageSize = item.image_size && typeof item.image_size === 'object' ? item.image_size : frame.imageSize;
    return { ...frame, segments: segs, segCount: segs.length, segImageSize: imageSize };
  });

  renderFrames(lastFrames);
  if (totalSeg === 0 && Array.isArray(lastSegClassNames) && lastSegClassNames.length) {
    const modelSet = new Set(lastSegClassNames.map((n) => normalizeSegName(n)));
    const missing = SEG_CLASS_FILTER.filter((n) => !modelSet.has(normalizeSegName(n)));
    if (missing.length) {
      setStatus(`SEG: 0 segs (model lacks ${missing.length} target classes)`);
      return;
    }
  }
  setStatus(`SEG: done (${totalSeg} segs)`);
}

function isYoloFeature(feature) {
  const id = String(feature?.properties?.id ?? feature?.id ?? '');
  if (id.startsWith('yolo:')) return true;
  const kind = String(feature?.properties?.kind ?? '').toLowerCase();
  return kind === 'yolo';
}

export function applyDetectionsToObstacles() {
  const state = store.getState();
  if (!lastFrames.length) {
    setStatus('YOLO: analyze first');
    return;
  }
  const roadUnion = getSurfaceRoadUnion(state);
  const buildingIndex = buildBuildingIndex(getBuildingsShownGeoJSON());
  const denyRaw = Array.isArray(state.maskEdits?.deny) ? state.maskEdits.deny : [];
  const keep = denyRaw.filter((f) => !isYoloFeature(f));
  const newObs = [];
  let used = 0;
  let skipped = 0;

  lastFrames.forEach((frame, frameIdx) => {
    const dets = Array.isArray(frame.detections) ? frame.detections : [];
    if (!dets.length || !frame.imageSize) return;
    dets.forEach((det, detIdx) => {
      const name = String(det?.name ?? '').toLowerCase();
      if (!OBSTACLE_ALLOWED_CLASSES.has(name)) {
        skipped += 1;
        return;
      }
      const conf = Number(det?.conf ?? 0);
      if (!Number.isFinite(conf) || conf < 0.3) {
        skipped += 1;
        return;
      }
      const estimate = estimateDetectionPoint(frame, det);
      if (!estimate) {
        skipped += 1;
        return;
      }
      const origin = turf.point([frame.lng, frame.lat]);
      const dest = turf.destination(origin, estimate.distance / 1000, estimate.heading, { units: 'kilometers' });
      if (!isPointOnSurface(dest, roadUnion, buildingIndex)) {
        skipped += 1;
        return;
      }
      const profile = getObjectProfile(name);
      // P3-2: confidence 縺ｫ繧医ｋ radius 蝨ｧ邵ｮ + 邱壼ｽ｢繧ｯ繝ｩ繧ｹ縺ｯ radius 繧貞濠蛻・↓縺励※蜀・・轤ｹ霑台ｼｼ縺ｫ霑代▼縺代ｋ
      const confGain = confidenceRadiusGain(conf);
      const linearGain = profile.linear ? 0.5 : 1.0;
      const effRadius = Math.max(0.05, profile.radius * confGain * linearGain);
      const circle = turf.circle(dest.geometry.coordinates, effRadius, { units: 'meters', steps: 16 });
      const id = `yolo:${frameIdx}:${detIdx}`;
      circle.id = id;
      circle.properties = {
        ...(circle.properties || {}),
        id,
        kind: 'yolo',
        label: name,
        conf,
        confGain,
        linear: !!profile.linear,
        h: profile.height,
        heightOnly: isHeightObstacle(name)
      };
      newObs.push(circle);
      used += 1;
    });
  });

  if (!newObs.length) {
    setStatus('YOLO: no obstacles');
    return;
  }
  const allow = Array.isArray(state.maskEdits?.allow) ? state.maskEdits.allow : [];
  store.setMaskEdits({ allow, deny: [...keep, ...newObs] }, { replace: true });
  setStatus(`YOLO: obstacles ${used} (skip ${skipped})`);
}

export function applyDetectionsToWidths() {
  const state = store.getState();
  if (!lastFrames.length) {
    setStatus('WIDTH: analyze first');
    return { applied: false, reason: 'analyze_first' };
  }
  if (!Array.isArray(state.geoJsonDataSets) || !state.geoJsonDataSets.length) {
    setStatus('WIDTH: no road data - load roads first');
    return { applied: false, reason: 'no_road_data' };
  }

  clearAppliedPerceptionWidths();
  const widthByFeature = new Map();
  const confByFeature = new Map(); // 項目4: feature ごとの検出スコア（confidence 算出用）
  const widthMap = {};
  const appliedIds = [];
  let usedFrames = 0;
  let usedDet = 0;
  let skipped = 0;

  lastFrames.forEach((frame) => {
    const dets = Array.isArray(frame.detections) ? frame.detections : [];
    if (!dets.length || !frame.imageSize) return;

    const nearest = projectToNearestWay({ lat: frame.lat, lng: frame.lng }, state.geoJsonDataSets);
    if (!nearest || !nearest.feature || !Number.isFinite(nearest.dist) || nearest.dist > WIDTH_ESTIMATE.maxNearestDist) {
      skipped += 1;
      return;
    }
    const fid = featureIdOf(nearest.feature);
    if (!fid) { skipped += 1; return; }

    let roadLine = null;
    try {
      const g = nearest.feature.geometry;
      if (g?.type === 'LineString') roadLine = turf.lineString(g.coordinates);
      else if (g?.type === 'MultiLineString') roadLine = turf.multiLineString(g.coordinates);
    } catch (_) {}
    if (!roadLine) { skipped += 1; return; }

    const offsets = [];
    const frameConfs = [];
    dets.forEach((det) => {
      const name = String(det?.name ?? det?.class ?? det?.label ?? '').toLowerCase();
      if (!WIDTH_DET_CLASSES.has(name)) return;
      const conf = Number(det?.conf ?? det?.confidence ?? 0);
      if (!Number.isFinite(conf) || conf < WIDTH_ESTIMATE.confMin) {
        skipped += 1;
        return;
      }
      const estimate = estimateDetectionPoint(frame, det, WIDTH_ESTIMATE);
      if (!estimate) {
        skipped += 1;
        return;
      }
      const origin = turf.point([frame.lng, frame.lat]);
      const dest = turf.destination(origin, estimate.distance / 1000, estimate.heading, { units: 'kilometers' });
      let distToRoad = null;
      try {
        distToRoad = turf.pointToLineDistance(dest, roadLine, { units: 'meters' });
      } catch (_) {}
      const offset = Number.isFinite(distToRoad) ? distToRoad : estimate.lateral;
      if (!Number.isFinite(offset)) { skipped += 1; return; }
      if (offset < WIDTH_ESTIMATE.minRouteOffset || offset > WIDTH_ESTIMATE.maxRouteOffset) {
        skipped += 1;
        return;
      }
      offsets.push(offset);
      frameConfs.push(conf);
      usedDet += 1;
    });

    if (!offsets.length) return;
    const p = offsets.length >= 4 ? WIDTH_ESTIMATE.percentile : 0.6;
    const offset = percentile(offsets, p);
    if (!Number.isFinite(offset)) return;
    const widthEst = clampValue(offset * 2 + WIDTH_ESTIMATE.baseMargin, WIDTH_ESTIMATE.minWidth, WIDTH_ESTIMATE.maxWidth);

    if (!widthByFeature.has(fid)) widthByFeature.set(fid, []);
    widthByFeature.get(fid).push(widthEst);
    const frameConf = median(frameConfs);
    if (Number.isFinite(frameConf)) {
      if (!confByFeature.has(fid)) confByFeature.set(fid, []);
      confByFeature.get(fid).push(frameConf);
    }
    usedFrames += 1;
  });

  if (!widthByFeature.size) {
    setStatus('WIDTH: no estimates');
    return { applied: false, reason: 'no_estimates', appliedRoads: 0, usedFrames, usedDet };
  }

  widthByFeature.forEach((vals, fid) => {
    const m = median(vals);
    const w = Number.isFinite(m) ? m : vals[0];
    if (!Number.isFinite(w)) return;
    const id = String(fid);
    // 項目4: 検出スコア → width_ai confidence（固定0.75ではなくスコア連動）。
    const repScore = median(confByFeature.get(fid) || []);
    const confidence = perceptionWidthAiConfidence(repScore);
    widthMap[id] = { width: Number(w.toFixed(2)), confidence: Number(confidence.toFixed(3)) };
    appliedIds.push(id);
  });
  if (appliedIds.length) {
    store.applyPerceptionWidthAi(widthMap);
    appliedPerceptionWidthRoadIds = appliedIds;
  }

  const appliedRoads = widthByFeature.size;
  setStatus(`WIDTH: applied ${appliedRoads} roads (${usedFrames} frames, ${usedDet} dets)`);
  return {
    applied: appliedRoads > 0,
    appliedRoads,
    usedFrames,
    usedDet,
    skipped
  };
}

function applySegmentationBoundaries() {
  const state = store.getState();
  if (!lastFrames.length) {
    setStatus('SEG: analyze first');
    return;
  }

  clearAppliedPerceptionWidths();
  const widthByFeature = new Map();
  const widthMap = {};
  const appliedIds = [];
  const leftLine = [];
  const rightLine = [];
  const sidewalkConfs = []; // 項目4: 歩道セグメントの代表信頼度（項目2が歩道幅に使える口）
  const buildingPoints = [];
  const seenBuilding = new Set();
  let usedFrames = 0;
  let usedBuildings = 0;
  let hasSegments = false;

  lastFrames.forEach((frame) => {
    const segments = Array.isArray(frame.segments) ? frame.segments : [];
    const imageSize = frame.segImageSize || frame.imageSize;
    if (!segments.length || !imageSize) return;
    hasSegments = true;
    const origin = { lat: frame.lat, lng: frame.lng };
    if (!Number.isFinite(origin.lat) || !Number.isFinite(origin.lng)) return;

    const sidewalk = pickBoundaryPoints(segments, imageSize, SEG_SIDEWALK_CLASSES, SEG_SIDEWALK_MIN_Y);
    if (sidewalk.left && sidewalk.right) {
      const leftOffset = pixelToGroundOffset(sidewalk.left.x, sidewalk.left.y, imageSize);
      const rightOffset = pixelToGroundOffset(sidewalk.right.x, sidewalk.right.y, imageSize);
      if (leftOffset && rightOffset) {
        const forwardGap = Math.abs(leftOffset.forward - rightOffset.forward);
        const width = Math.abs(rightOffset.lateral - leftOffset.lateral);
        if (Number.isFinite(width) && width >= 3 && width <= 16 && forwardGap <= 6) {
          const nearest = projectToNearestWay(origin, state.geoJsonDataSets);
          if (nearest?.feature && Number.isFinite(nearest.dist) && nearest.dist <= 14) {
            const fid = featureIdOf(nearest.feature);
            if (fid) {
              if (!widthByFeature.has(fid)) widthByFeature.set(fid, []);
              widthByFeature.get(fid).push(width);
            }
          }
        }

        const leftLL = offsetToLatLng(origin, frame.heading, leftOffset);
        const rightLL = offsetToLatLng(origin, frame.heading, rightOffset);
        if (leftLL) leftLine.push([leftLL.lng, leftLL.lat]);
        if (rightLL) rightLine.push([rightLL.lng, rightLL.lat]);
        // この frame の歩道セグメント最大信頼度を記録（confidence の口）。
        let frameSwConf = 0;
        segments.forEach((seg) => {
          if (!isSegClass(seg?.name, SEG_SIDEWALK_CLASSES)) return;
          const c = Number(seg?.conf ?? 0);
          if (Number.isFinite(c) && c >= SEG_MIN_CONF) frameSwConf = Math.max(frameSwConf, c);
        });
        if (frameSwConf > 0) sidewalkConfs.push(frameSwConf);
        usedFrames += 1;
      }
    }

    const building = pickBoundaryPoints(segments, imageSize, SEG_BUILDING_CLASSES, SEG_BUILDING_MIN_Y);
    [building.left, building.right].forEach((pt) => {
      if (!pt) return;
      if (buildingPoints.length >= 160) return;
      const offset = pixelToGroundOffset(pt.x, pt.y, imageSize);
      if (!offset || offset.forward > 60) return;
      const ll = offsetToLatLng(origin, frame.heading, offset);
      if (!ll) return;
      const key = `${ll.lat.toFixed(5)},${ll.lng.toFixed(5)}`;
      if (seenBuilding.has(key)) return;
      seenBuilding.add(key);
      buildingPoints.push(ll);
    });
  });

  if (!hasSegments) {
    setStatus('SEG: no segments (run SEGMENT first)');
    return;
  }

  widthByFeature.forEach((vals, fid) => {
    const w = median(vals);
    if (!Number.isFinite(w)) return;
    const id = String(fid);
    widthMap[id] = Number(w.toFixed(2));
    appliedIds.push(id);
  });
  if (appliedIds.length) {
    store.applyPerceptionWidthAi(widthMap);
    appliedPerceptionWidthRoadIds = appliedIds;
  }

  if (leftLine.length > 1 || rightLine.length > 1) {
    const existing = Array.isArray(state.sidewalkGeoJSON) ? state.sidewalkGeoJSON : [];
    const keep = existing.filter((f) => f?.properties?.kind !== 'yolo_sidewalk');
    const next = keep.slice();
    const swConf = median(sidewalkConfs); // 歩道幅の信頼度（項目2で carriageway 控除に使える）
    const swConfRounded = Number.isFinite(swConf) ? Number(swConf.toFixed(3)) : null;
    if (leftLine.length > 1) {
      next.push({
        type: 'Feature',
        properties: { kind: 'yolo_sidewalk', side: 'left', confidence: swConfRounded },
        geometry: { type: 'LineString', coordinates: leftLine }
      });
    }
    if (rightLine.length > 1) {
      next.push({
        type: 'Feature',
        properties: { kind: 'yolo_sidewalk', side: 'right', confidence: swConfRounded },
        geometry: { type: 'LineString', coordinates: rightLine }
      });
    }
    store.setSidewalkGeoJSON(next);
  }

  if (buildingPoints.length) {
    const denyRaw = Array.isArray(state.maskEdits?.deny) ? state.maskEdits.deny : [];
    const allow = Array.isArray(state.maskEdits?.allow) ? state.maskEdits.allow : [];
    const keep = denyRaw.filter((f) => String(f?.properties?.kind ?? '') !== 'yolo_building');
    const newDeny = buildingPoints.map((pt, idx) => {
      const circle = turf.circle([pt.lng, pt.lat], 0.8, { units: 'meters', steps: 10 });
      const id = `yolo:building:${idx}`;
      circle.id = id;
      circle.properties = { ...(circle.properties || {}), id, kind: 'yolo_building', h: 6 };
      return circle;
    });
    store.setMaskEdits({ allow, deny: [...keep, ...newDeny] }, { replace: true });
    usedBuildings = newDeny.length;
  }

  setStatus(`SEG: applied widths ${widthByFeature.size} roads / buildings ${usedBuildings} / frames ${usedFrames}`);
}

function clearStreetView() {
  scanToken += 1;
  analyzeToken += 1;
  segToken += 1;
  stopDrive();
  clearAppliedPerceptionWidths();
  _removeSvViewpointMarker();
  if (panorama) {
    try {
      panorama.setVisible(false);
    } catch (e) { }
    panorama = null;
  }
  panoramaContainer = null;
  showPanorama(false);
  lastFrames = [];
  renderFrames([]);
  setStatus('Street View: cleared');
}

export function getStreetViewFrames() {
  return lastFrames.slice();
}

export function initStreetViewScan() {
  const scanBtn = byId('svScan');
  const analyzeBtn = byId('svAnalyze');
  const segBtn = byId('svSegment');
  const applySegBtn = byId('svApplySeg');
  const driveBtn = byId('svDrive');
  const stopBtn = byId('svStop');
  const applyBtn = byId('svApply');
  const applyWidthBtn = byId('svApplyWidth');
  const clearBtn = byId('svClear');
  if (scanBtn) scanBtn.addEventListener('click', () => scanStreetView().catch((e) => setStatus(`Street View: ${e.message}`)));
  if (analyzeBtn) analyzeBtn.addEventListener('click', () => analyzeStreetView().catch((e) => setStatus(`YOLO: ${e.message}`)));
  if (segBtn) segBtn.addEventListener('click', () => analyzeStreetViewSeg().catch((e) => setStatus(`SEG: ${e.message}`)));
  if (applySegBtn) applySegBtn.addEventListener('click', applySegmentationBoundaries);
  if (applyBtn) applyBtn.addEventListener('click', applyDetectionsToObstacles);
  if (applyWidthBtn) applyWidthBtn.addEventListener('click', applyDetectionsToWidths);
  if (driveBtn) driveBtn.addEventListener('click', driveStreetView);
  if (stopBtn) stopBtn.addEventListener('click', () => {
    stopDrive();
    setStatus('Street View: stopped');
  });
  if (clearBtn) clearBtn.addEventListener('click', clearStreetView);

  // SV + YOLO 邨ｱ蜷医・繧ｿ繝ｳ
  const comboBtn = byId('svScanAndAnalyze');
  if (comboBtn) comboBtn.addEventListener('click', async () => {
    try {
      setStatus('Street View: scanning窶ｦ');
      await scanStreetView();
      setStatus('YOLO: analyzing窶ｦ');
      await analyzeStreetView();
      const widthRes = applyDetectionsToWidths();
      if (widthRes?.applied) {
        setStatus(`SV + YOLO: width applied to ${widthRes.appliedRoads} roads`);
      } else {
        setStatus('SV + YOLO: complete');
      }
    } catch (e) {
      setStatus(`SV+YOLO: ${e.message}`);
    }
  });

  setStatus('Street View: idle');
}
