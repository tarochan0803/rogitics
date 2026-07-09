// Phase 5: Perception Fusion
// Street View / YOLO 縺ｮ讀懷・邨先棡繧偵碁％霍ｯ蟷・呵｣懶ｼ・idth_ai・峨阪→縲碁囿螳ｳ迚ｩ・・askEdits.deny・峨阪↓
// 螟画鋤縺励￣hase 2 縺ｮ蟷・檮蜷・/ Phase 3-4 縺ｮ髫懷ｮｳ迚ｩ繝ｻ閾ｪ蠕句愛譁ｭ縺ｸ豬√＠霎ｼ繧縺溘ａ縺ｮ繝ｭ繧ｸ繝・け螻､縲・//
// 險ｭ險域婿驥・
// - 邨瑚ｷｯ荳翫ｒ stationing・井ｸ螳夐俣髫斐・繧ｵ繝ｳ繝励Ν轤ｹ・峨〒邂｡逅・☆繧九・// - 蟷・・1譫壹〒豎ｺ繧√★縲∝酔荳驕楢ｷｯ縺ｫ邏舌▼縺剰､・焚 station 繧ｵ繝ｳ繝励Ν縺ｮ荳ｭ螟ｮ蛟､ + 繝輔Ξ繝ｼ繝謨ｰ縺ｧ菫｡鬆ｼ蠎ｦ繧貞・縺吶・// - 譌｢蟄伜ｹ・°繧牙､ｧ縺阪￥螟悶ｌ縲√°縺､菫｡鬆ｼ蠎ｦ縺碁ｫ倥＞繧ゅ・縺縺題・蜍墓治逕ｨ縲ゆｽ惹ｿ｡鬆ｼ蠎ｦ縺ｯ縲檎｢ｺ隱榊ｾ・■縲阪↓谿九☆縲・// - YOLO 縺檎┌縺・/ Street View 縺悟ｼ輔￠縺ｪ縺・ｴ蜷医〒繧り誠縺｡縺ｪ縺・ｈ縺・∝粋謌舌せ繧ｭ繝｣繝ｳ繧堤畑諢上☆繧九・
import { estimateEffectiveRoadWidth } from '../core/feasibility.js';
import { projectToNearestWay } from '../core/graph.js';

function turfRef() {
  return (typeof window !== 'undefined' && window.turf) ? window.turf : null;
}

function median(values) {
  const arr = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!arr.length) return null;
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

function featureIdOf(feature) {
  if (!feature) return null;
  if (feature.id != null) return String(feature.id);
  if (feature.properties?.id != null) return String(feature.properties.id);
  return null;
}

const STREETVIEW_WIDTH_CLASSES = new Set(['bicycle', 'motorcycle', 'car', 'truck', 'bus', 'train']);
const STREETVIEW_OBSTACLE_CLASSES = new Set([
  'person', 'bicycle', 'motorcycle', 'car', 'truck', 'bus', 'traffic cone',
  'cone', 'barrier', 'construction', 'stop sign', 'traffic light', 'wire',
  'overhead wire', 'cable', 'overhang', 'guardrail', 'guard rail', 'curb',
  'kerb', 'utility pole', 'electric pole', 'pole', 'sign', 'road sign',
  'signboard', 'bollard', 'fence', 'plant', 'tree'
]);
const STREETVIEW_HEIGHT_CLASSES = new Set(['wire', 'overhead wire', 'cable', 'overhang', 'traffic light']);

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
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

function detectionName(det) {
  return String(det?.name ?? det?.class ?? det?.label ?? '').trim().toLowerCase();
}

function detectionConfidence(det) {
  const n = Number(det?.conf ?? det?.confidence ?? det?.score);
  return Number.isFinite(n) ? n : 0;
}

function objectProfile(name) {
  const key = String(name || '').toLowerCase();
  if (key === 'bicycle') return { height: 1.5, width: 0.7, length: 1.8, radius: 0.6, box: true };
  if (key === 'motorcycle') return { height: 1.4, width: 0.8, length: 2.1, radius: 0.7, box: true };
  if (key === 'car') return { height: 1.5, width: 1.8, length: 4.5, radius: 1.25, box: true };
  if (key === 'truck') return { height: 3.0, width: 2.5, length: 7.0, radius: 1.8, box: true };
  if (key === 'bus') return { height: 3.2, width: 2.5, length: 9.5, radius: 1.9, box: true };
  if (key === 'train') return { height: 3.5, width: 3.0, length: 12.0, radius: 2.0, box: true };
  if (key.includes('cone')) return { height: 0.8, width: 0.4, radius: 0.45 };
  if (key.includes('guard')) return { height: 1.1, width: 0.35, length: 4.5, radius: 0.35, linear: true };
  if (key.includes('curb') || key.includes('kerb')) return { height: 0.2, width: 0.25, length: 3.0, radius: 0.25, linear: true };
  if (key.includes('barrier') || key.includes('fence')) return { height: 1.0, width: 0.4, length: 2.2, radius: 0.7, linear: true };
  if (key.includes('wire') || key.includes('cable')) return { height: 5.0, width: 0.15, length: 8.0, radius: 0.2, linear: true, overhead: true };
  if (key.includes('pole')) return { height: 8.0, width: 0.35, radius: 0.35 };
  if (key.includes('sign')) return { height: 2.4, width: 0.6, radius: 0.35 };
  if (key.includes('tree') || key.includes('plant')) return { height: 2.4, width: 1.2, radius: 1.0 };
  return { height: 1.7, width: 0.8, radius: 0.8 };
}

function estimateDetectionOffset(frame, det, {
  minBoxPx = 12,
  minDistance = 3,
  maxDistance = 45
} = {}) {
  const imageSize = frame?.imageSize || frame?.segImageSize;
  const width = Number(imageSize?.width);
  const height = Number(imageSize?.height);
  const bbox = det?.bbox;
  if (!Array.isArray(bbox) || bbox.length < 4 || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  const [x1, y1, x2, y2] = bbox.map((v) => Number(v));
  if (![x1, y1, x2, y2].every((v) => Number.isFinite(v))) return null;
  const boxW = Math.max(1, x2 - x1);
  const boxH = Math.max(1, y2 - y1);
  if (boxW < minBoxPx || boxH < minBoxPx) return null;

  const name = detectionName(det);
  const profile = objectProfile(name);
  const fovH = Math.PI / 2;
  const fovV = 2 * Math.atan(Math.tan(fovH / 2) * (height / width));
  const focalX = (width / 2) / Math.tan(fovH / 2);
  const focalY = (height / 2) / Math.tan(fovV / 2);
  const distH = profile.height ? (profile.height * focalY) / boxH : null;
  const distW = profile.width ? (profile.width * focalX) / boxW : null;
  let distance = distH ?? distW;
  if (distH && distW) {
    const aspect = boxW / boxH;
    const wWeight = clamp((aspect - 0.7) / 1.2, 0, 0.8);
    distance = distH * (1 - wWeight) + distW * wWeight;
  }
  if (!Number.isFinite(distance)) return null;
  distance = clamp(distance, minDistance, maxDistance);
  const xCenter = (x1 + x2) / 2;
  const angleOffset = Math.atan((xCenter - width / 2) / focalX);
  const heading = (Number(frame?.heading) || 0) + angleOffset * 180 / Math.PI;
  return {
    distance,
    heading,
    lateral: Math.abs(Math.sin(angleOffset) * distance)
  };
}

function detectionPoint(frame, det, estimate) {
  const lat = Number(det?.lat);
  const lng = Number(det?.lng);
  if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
  const turf = turfRef();
  const fLat = Number(frame?.lat);
  const fLng = Number(frame?.lng);
  if (!turf?.destination || !Number.isFinite(fLat) || !Number.isFinite(fLng) || !estimate) return null;
  try {
    const dest = turf.destination(
      turf.point([fLng, fLat]),
      Math.max(0, Number(estimate.distance) || 0) / 1000,
      Number(estimate.heading) || 0,
      { units: 'kilometers' }
    );
    const c = dest?.geometry?.coordinates;
    return c ? { lat: c[1], lng: c[0] } : null;
  } catch (_e) {
    return null;
  }
}

function offsetLatLng(turf, center, headingDeg, forwardM, rightM) {
  const base = turf.destination(
    turf.point([center.lng, center.lat]),
    Math.abs(forwardM) / 1000,
    Number(headingDeg) + (forwardM < 0 ? 180 : 0),
    { units: 'kilometers' }
  );
  const c1 = base?.geometry?.coordinates;
  if (!c1) return null;
  const shifted = turf.destination(
    turf.point(c1),
    Math.abs(rightM) / 1000,
    Number(headingDeg) + (rightM < 0 ? -90 : 90),
    { units: 'kilometers' }
  );
  const c2 = shifted?.geometry?.coordinates;
  return c2 ? [c2[0], c2[1]] : null;
}

function orientedBoxFeature(turf, center, headingDeg, lengthM, widthM) {
  const len = Math.max(0.2, Number(lengthM) || 1);
  const wid = Math.max(0.15, Number(widthM) || 0.5);
  const corners = [
    offsetLatLng(turf, center, headingDeg, len / 2, -wid / 2),
    offsetLatLng(turf, center, headingDeg, len / 2, wid / 2),
    offsetLatLng(turf, center, headingDeg, -len / 2, wid / 2),
    offsetLatLng(turf, center, headingDeg, -len / 2, -wid / 2)
  ];
  if (corners.some((p) => !p)) return null;
  corners.push(corners[0]);
  return turf.polygon([corners]);
}

function estimateProxyDimensions(frame, det, estimate, profile) {
  const imageSize = frame?.imageSize || frame?.segImageSize;
  const imgW = Number(imageSize?.width);
  const bbox = Array.isArray(det?.bbox) ? det.bbox.map(Number) : null;
  let angularLengthM = null;
  if (bbox && bbox.length >= 4 && Number.isFinite(imgW) && imgW > 0 && estimate?.distance) {
    const boxW = Math.max(1, Math.abs(bbox[2] - bbox[0]));
    const fovH = Math.PI / 2;
    const focalX = (imgW / 2) / Math.tan(fovH / 2);
    angularLengthM = 2 * Number(estimate.distance) * Math.tan((boxW / focalX) / 2);
  }
  const linear = !!profile.linear;
  const box = !!profile.box || linear;
  const lengthM = linear
    ? clamp(angularLengthM || profile.length || 2.5, 1.0, 12.0)
    : clamp(profile.length || angularLengthM || (profile.radius || 0.8) * 2, 0.7, 12.0);
  const widthM = clamp(profile.width || (profile.radius || 0.8) * 1.2, 0.15, 3.5);
  return { box, linear, lengthM, widthM };
}

/**
 * 邨瑚ｷｯ荳翫・ station 轤ｹ繧剃ｽ懊ｋ縲ょ推 station 縺ｯ sM・亥ｧ狗せ縺九ｉ縺ｮ霍晞屬・峨→邱ｯ蠎ｦ邨悟ｺｦ繧呈戟縺､縲・ */
export function buildRouteStations(route, { spacingM = 15 } = {}) {
  const turf = turfRef();
  const pts = (Array.isArray(route) ? route : [])
    .map((p) => ({ lat: Number(p?.lat), lng: Number(p?.lng) }))
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  if (pts.length < 2 || !turf?.lineString) return [];
  const line = turf.lineString(pts.map((p) => [p.lng, p.lat]));
  const totalM = (turf.length(line, { units: 'kilometers' }) || 0) * 1000;
  const stations = [];
  const step = Math.max(4, Number(spacingM) || 15);
  for (let sM = 0; sM <= totalM + 0.01; sM += step) {
    const p = turf.along(line, Math.min(sM, totalM) / 1000, { units: 'kilometers' });
    const c = p?.geometry?.coordinates;
    if (!c) continue;
    stations.push({ sM: Math.round(Math.min(sM, totalM) * 10) / 10, lat: c[1], lng: c[0] });
  }
  return stations;
}

/**
 * 蜷御ｸ驕楢ｷｯ縺ｫ邏舌▼縺・width 繧ｵ繝ｳ繝励Ν鄒､繧帝寔邏・＠縲∵治逕ｨ蟷・・菫｡鬆ｼ蠎ｦ繝ｻ閾ｪ蜍墓治逕ｨ蜿ｯ蜷ｦ繧貞・縺吶・ * @param {Array} roads 驕楢ｷｯ GeoJSON features
 * @param {Array} widthSamples [{ roadId, widthM, frameConfidence }]
 */
export function aggregateWidthSuggestions(roads, widthSamples, {
  autoApplyConfidence = 0.7,
  minDeltaM = 0.6,
  defaultRoadWidth = 6
} = {}) {
  const roadById = new Map();
  for (const f of (Array.isArray(roads) ? roads : [])) {
    const id = featureIdOf(f);
    if (id) roadById.set(id, f);
  }

  const grouped = new Map();
  for (const s of (Array.isArray(widthSamples) ? widthSamples : [])) {
    const id = s?.roadId != null ? String(s.roadId) : null;
    const w = Number(s?.widthM);
    if (!id || !Number.isFinite(w) || w <= 0) continue;
    if (!grouped.has(id)) grouped.set(id, []);
    grouped.get(id).push({ widthM: w, frameConfidence: Number(s.frameConfidence) || 0.5 });
  }

  const suggestions = [];
  for (const [roadId, samples] of grouped.entries()) {
    const widths = samples.map((s) => s.widthM);
    const suggestedWidth = median(widths);
    if (!Number.isFinite(suggestedWidth)) continue;
    const frameCount = samples.length;
    const avgFrameConf = samples.reduce((a, s) => a + s.frameConfidence, 0) / frameCount;
    const confidence = Math.min(0.97, avgFrameConf * Math.min(1, 0.45 + 0.18 * frameCount));

    const feature = roadById.get(roadId);
    const currentWidth = feature
      ? (estimateEffectiveRoadWidth(feature, { defaultRoadWidth })?.value ?? null)
      : null;
    const delta = (Number.isFinite(currentWidth)) ? suggestedWidth - currentWidth : null;
    const bigEnough = delta == null ? true : Math.abs(delta) >= minDeltaM;
    const autoApply = confidence >= autoApplyConfidence && bigEnough;

    suggestions.push({
      roadId,
      suggestedWidth: Math.round(suggestedWidth * 100) / 100,
      currentWidth: Number.isFinite(currentWidth) ? Math.round(currentWidth * 100) / 100 : null,
      deltaM: delta == null ? null : Math.round(delta * 100) / 100,
      confidence: Math.round(confidence * 100) / 100,
      frameCount,
      autoApply,
      // 閾ｪ蜍墓治逕ｨ縺励↑縺・炊逕ｱ
      pendingReason: autoApply ? null : (confidence < autoApplyConfidence ? 'low-confidence' : 'small-delta')
    });
  }

  suggestions.sort((a, b) => b.confidence - a.confidence);
  const autoApplyCount = suggestions.filter((s) => s.autoApply).length;
  return {
    suggestions,
    coverageRoads: suggestions.length,
    autoApplyCount,
    pendingCount: suggestions.length - autoApplyCount
  };
}

/**
 * YOLO 讀懷・・育せ + 繧ｯ繝ｩ繧ｹ + 鬮倥＆/鬆ｭ荳翫ヵ繝ｩ繧ｰ・峨ｒ繝昴Μ繧ｴ繝ｳ髫懷ｮｳ迚ｩ feature 縺ｫ螟画鋤縺吶ｋ縲・ * heightOnly=true 縺ｯ鬆ｭ荳企囿螳ｳ迚ｩ・亥ｺ・髮ｻ邱壹↑縺ｩ・峨→縺励※ overhead 蛻､螳壹↓蝗槭ｋ縲・ */
export function buildObstacleFeatures(detections, { idPrefix = 'yolo:obstacle' } = {}) {
  const turf = turfRef();
  if (!turf?.buffer || !turf?.point) return [];
  const out = [];
  const seen = new Set();
  (Array.isArray(detections) ? detections : []).forEach((d, i) => {
    const lat = Number(d?.lat);
    const lng = Number(d?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    const className = d.class || (d.overhead || d.heightOnly ? 'overhead' : 'object');
    const clusterKey = `${className}:${lat.toFixed(5)}:${lng.toFixed(5)}`;
    if (seen.has(clusterKey)) return;
    seen.add(clusterKey);
    const radiusM = Math.max(0.4, Number(d.radiusM) || 1.0);
    const headingDeg = Number(d.headingDeg ?? d.heading);
    const lengthM = Number(d.lengthM);
    const widthM = Number(d.widthM);
    const useBox = (d.shape === 'box' || d.shape === 'linear' || Number.isFinite(lengthM) || Number.isFinite(widthM))
      && Number.isFinite(headingDeg);
    let poly = null;
    try {
      if (useBox) {
        poly = orientedBoxFeature(
          turf,
          { lat, lng },
          headingDeg,
          Number.isFinite(lengthM) ? lengthM : radiusM * 2,
          Number.isFinite(widthM) ? widthM : Math.max(0.25, radiusM)
        );
      }
      if (!poly) poly = turf.buffer(turf.point([lng, lat]), radiusM, { units: 'meters', steps: 6 });
    } catch (_e) { poly = null; }
    if (!poly) return;
    const id = `${idPrefix}:${d.id ?? i}`;
    const heightOnly = !!d.overhead || d.heightOnly === true;
    poly.id = id;
    poly.properties = {
      ...(poly.properties || {}),
      id,
      source: 'yolo',
      class: className,
      label: d.label || d.class || (heightOnly ? '鬆ｭ荳企囿螳ｳ迚ｩ(YOLO)' : '髫懷ｮｳ迚ｩ(YOLO)'),
      confidence: Number(d.confidence) || 0.6,
      heightOnly,
      overhead: heightOnly,
      proxyShape: useBox ? (d.shape || 'box') : 'circle',
      radiusM,
      lengthM: Number.isFinite(lengthM) ? lengthM : null,
      widthM: Number.isFinite(widthM) ? widthM : null,
      headingDeg: Number.isFinite(headingDeg) ? headingDeg : null
    };
    if (heightOnly) {
      poly.properties.height = Number(d.clearanceHeightM) || 3.0;
    } else {
      poly.properties.height = Number(d.heightM) || 1.6;
    }
    out.push(poly);
  });
  return out;
}

/**
 * Street View / YOLO 縺御ｽｿ縺医↑縺・腸蠅・髄縺代・蜷域・繧ｹ繧ｭ繝｣繝ｳ縲・ * 邨瑚ｷｯ霑大ｍ縺ｮ驕楢ｷｯ縺ｸ豎ｺ螳夊ｫ也噪縺ｫ width 繧ｵ繝ｳ繝励Ν縺ｨ髫懷ｮｳ迚ｩ繧貞牡繧雁ｽ薙※縲【oloCoverage>0 繧剃ｽ懊ｌ繧九・ * - 鬮倅ｿ｡鬆ｼ縺ｮ蟷・呵｣懶ｼ郁・蜍墓治逕ｨ縺輔ｌ繧区Φ螳夲ｼ・ * - 菴惹ｿ｡鬆ｼ縺ｮ蟷・呵｣懶ｼ育｢ｺ隱榊ｾ・■縺ｫ谿九ｋ諠ｳ螳夲ｼ・ * - 邨瑚ｷｯ荳翫・蝨ｰ荳企囿螳ｳ迚ｩ・磯ｧ占ｻ願ｻ贋ｸ｡・峨→鬆ｭ荳企囿螳ｳ迚ｩ・井ｽ弱＞蠎・ｼ・ */
export function buildPerceptionScanFromStreetViewFrames(frames, roads, route, {
  stationSpacingM = 15,
  maxNearestDistM = 16,
  widthConfMin = 0.3,
  obstacleConfMin = 0.3
} = {}) {
  const stations = buildRouteStations(route, { spacingM: stationSpacingM });
  const widthSamples = [];
  const detections = [];
  let usedFrames = 0;
  let skippedFrames = 0;
  let usedDetections = 0;

  const roadArr = Array.isArray(roads) ? roads : [];
  (Array.isArray(frames) ? frames : []).forEach((frame, frameIdx) => {
    const lat = Number(frame?.lat);
    const lng = Number(frame?.lng);
    const dets = Array.isArray(frame?.detections) ? frame.detections : [];
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !dets.length) {
      skippedFrames += 1;
      return;
    }

    let nearest = null;
    try {
      nearest = projectToNearestWay({ lat, lng }, roadArr);
    } catch (_e) {
      nearest = null;
    }
    const roadId = nearest?.feature && Number.isFinite(nearest.dist) && nearest.dist <= maxNearestDistM
      ? featureIdOf(nearest.feature)
      : null;

    const offsets = [];
    let widthConfTotal = 0;
    let widthDetCount = 0;
    dets.forEach((det, detIdx) => {
      const name = detectionName(det);
      const conf = detectionConfidence(det);
      const estimate = estimateDetectionOffset(frame, det, { minBoxPx: 14, minDistance: 4, maxDistance: 45 });
      if (roadId && STREETVIEW_WIDTH_CLASSES.has(name) && conf >= widthConfMin && estimate) {
        const offset = Number(estimate.lateral);
        if (Number.isFinite(offset) && offset >= 0.8 && offset <= 5.5) {
          offsets.push(offset);
          widthConfTotal += conf;
          widthDetCount += 1;
        }
      }

      const isObstacle = STREETVIEW_OBSTACLE_CLASSES.has(name) || name.includes('barrier') || name.includes('cone');
      if (!isObstacle || conf < obstacleConfMin) return;
      const point = detectionPoint(frame, det, estimate);
      if (!point) return;
      const profile = objectProfile(name);
      const dims = estimateProxyDimensions(frame, det, estimate, profile);
      const overhead = !!profile.overhead || STREETVIEW_HEIGHT_CLASSES.has(name);
      detections.push({
        id: `sv:${frameIdx}:${detIdx}`,
        lat: point.lat,
        lng: point.lng,
        radiusM: profile.radius,
        shape: dims.box ? (dims.linear ? 'linear' : 'box') : 'circle',
        lengthM: dims.box ? Math.round(dims.lengthM * 100) / 100 : undefined,
        widthM: dims.box ? Math.round(dims.widthM * 100) / 100 : undefined,
        headingDeg: Number.isFinite(Number(estimate?.heading)) ? Number(estimate.heading) : Number(frame?.heading) || 0,
        class: name || 'object',
        label: name || 'Street View object',
        confidence: conf,
        heightM: profile.height,
        overhead,
        clearanceHeightM: overhead ? 2.8 : undefined
      });
      usedDetections += 1;
    });

    if (roadId && offsets.length) {
      const offset = offsets.length >= 4 ? percentile(offsets, 0.4) : median(offsets);
      const widthM = clamp((offset * 2) + 0.5, 3, 8.5);
      const avgConf = widthDetCount ? widthConfTotal / widthDetCount : 0.4;
      widthSamples.push({
        roadId,
        widthM: Math.round(widthM * 100) / 100,
        frameConfidence: Math.min(0.96, Math.max(0.35, avgConf)),
        frameId: frame?.panoId || String(frameIdx)
      });
    }
    usedFrames += 1;
  });

  return {
    stations,
    widthSamples,
    detections,
    source: 'streetview-yolo',
    meta: {
      frameCount: Array.isArray(frames) ? frames.length : 0,
      usedFrames,
      skippedFrames,
      usedDetections
    }
  };
}

export function makeSyntheticPerceptionScan(roads, route, { stationSpacingM = 15 } = {}) {
  const stations = buildRouteStations(route, { spacingM: stationSpacingM });
  const roadArr = (Array.isArray(roads) ? roads : []).filter((f) => {
    const t = f?.geometry?.type;
    return (t === 'LineString' || t === 'MultiLineString') && featureIdOf(f);
  });

  const widthSamples = [];
  if (roadArr.length) {
    // 1譛ｬ逶ｮ: 隍・焚繝輔Ξ繝ｼ繝縺ｧ荳雋ｫ縺励◆迢ｭ縺・ｹ・ｼ磯ｫ倅ｿ｡鬆ｼ 竊・閾ｪ蜍墓治逕ｨ諠ｳ螳夲ｼ・    const r0 = featureIdOf(roadArr[0]);
    const r0 = featureIdOf(roadArr[0]);
    for (let i = 0; i < 5; i++) widthSamples.push({ roadId: r0, widthM: 3.4 + (i % 2) * 0.1, frameConfidence: 0.85 });
    // 2譛ｬ逶ｮ: 1繝輔Ξ繝ｼ繝縺ｮ縺ｿ縺ｮ謠ｺ繧後◆蛟､・井ｽ惹ｿ｡鬆ｼ 竊・遒ｺ隱榊ｾ・■諠ｳ螳夲ｼ・    if (roadArr[1]) {
    if (roadArr[1]) {
      widthSamples.push({ roadId: featureIdOf(roadArr[1]), widthM: 9.0, frameConfidence: 0.4 });
    }
  }

  const detections = [];
  if (stations.length >= 4) {
    const mid = stations[Math.floor(stations.length / 2)];
    detections.push({
      id: 'parked-car', lat: mid.lat, lng: mid.lng, radiusM: 1.6,
      shape: 'box', lengthM: 4.5, widthM: 1.8, headingDeg: 0,
      class: 'car', label: 'parked car (YOLO)', confidence: 0.78, heightM: 1.6
    });
    const q = stations[Math.floor(stations.length / 3)];
    detections.push({
      id: 'low-eave', lat: q.lat, lng: q.lng, radiusM: 1.2,
      shape: 'linear', lengthM: 4, widthM: 0.5, headingDeg: 0,
      class: 'overhang', label: 'low overhang (YOLO)', confidence: 0.7, overhead: true, clearanceHeightM: 2.6
    });
  }

  return { stations, widthSamples, detections, source: 'synthetic' };
}

export default {
  buildRouteStations,
  aggregateWidthSuggestions,
  buildObstacleFeatures,
  buildPerceptionScanFromStreetViewFrames,
  makeSyntheticPerceptionScan
};
