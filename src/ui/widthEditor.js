import { parseMetersFromTag } from '../core/graph.js';

let map;
let store;
let layerGroup;
let enabled = false;

let activeFeatureId = null;
let centerLL = null;
let centerPt = null;
let normalUnit = null;

let leftMarker;
let rightMarker;
let labelMarker;
let crossLine;

let isUpdating = false;

const PANE_ID = 'widthEditorPane';
const hasLeaflet = () => typeof L !== 'undefined';

function featureIdOf(feature) {
  if (!feature) return null;
  if (feature.id != null) return String(feature.id);
  const pid = feature.properties?.id;
  if (pid != null) return String(pid);
  return null;
}

function getWidthMetersForFeature(feature, fallback = 6) {
  const props = feature?.properties && typeof feature.properties === 'object' ? feature.properties : {};
  const tags = props.tags && typeof props.tags === 'object' ? props.tags : null;
  // 手動上書き（最優先）→ YOLO 推定 → OSM 実測 → フォールバックの順で現在値を表示。
  const override = parseMetersFromTag(tags?.userOverrideWidth ?? props.userOverrideWidth);
  if (override != null) return override;
  const ai = parseMetersFromTag(tags?.width_ai ?? props.width_ai);
  if (ai != null) return ai;
  const osm = parseMetersFromTag(tags?.width ?? props.width);
  if (osm != null) return osm;
  return fallback;
}

function ensureLayerGroup() {
  if (!map || !hasLeaflet()) return;
  if (!map.getPane(PANE_ID)) {
    const pane = map.createPane(PANE_ID);
    pane.style.zIndex = 650;
  }
  if (!layerGroup) {
    layerGroup = L.layerGroup([], { pane: PANE_ID }).addTo(map);
  }
}

function clearInternal() {
  if (!layerGroup) return;
  layerGroup.clearLayers();
  leftMarker = rightMarker = labelMarker = crossLine = null;
  activeFeatureId = null;
  centerLL = null;
  centerPt = null;
  normalUnit = null;
}

export function initWidthEditor(mapInstance, storeInstance) {
  map = mapInstance;
  store = storeInstance;
  if (!map || !hasLeaflet()) {
    enabled = false;
    return;
  }
  ensureLayerGroup();
}

export function setWidthEditEnabled(flag) {
  enabled = !!flag;
  if (!map || !hasLeaflet()) return;
  if (!enabled) clearInternal();
}

export function clearWidthEditor() {
  clearInternal();
}

export function openForFeature(feature, clickLatLng) {
  const fid = featureIdOf(feature);
  if (store && fid) store.setSelectedRoadFeatureId(fid);
  if (!enabled || !map || !store || !hasLeaflet()) return;
  ensureLayerGroup();
  clearInternal();

  activeFeatureId = fid;

  const seg = pickBestSegment(feature, clickLatLng);
  if (!seg) return;
  centerPt = seg.centerPt;
  centerLL = seg.centerLL;
  normalUnit = seg.normalUnit;

  const widthM = getWidthMetersForFeature(feature, 6);
  const { leftLL, rightLL } = buildHandlesFromWidth(widthM);

  leftMarker = buildHandleMarker(leftLL);
  rightMarker = buildHandleMarker(rightLL);
  if (hasLeaflet()) {
    crossLine = L.polyline([leftLL, rightLL], { pane: PANE_ID, color: '#22d3ee', weight: 4, opacity: 0.95, dashArray: '6 8' });
  }
  labelMarker = buildLabelMarker(centerLL, widthM);

  layerGroup.addLayer(crossLine);
  layerGroup.addLayer(leftMarker);
  layerGroup.addLayer(rightMarker);
  layerGroup.addLayer(labelMarker);

  wireDrag(leftMarker);
  wireDrag(rightMarker);
}

function buildHandleMarker(latlng) {
  if (!hasLeaflet()) return null;
  const icon = L.divIcon({ className: 'width-handle', html: '<div class="width-handle-inner"></div>', iconSize: [16, 16], iconAnchor: [8, 8] });
  return L.marker(latlng, { draggable: true, icon, pane: PANE_ID, zIndexOffset: 4000, keyboard: false });
}

function buildLabelMarker(latlng, widthM) {
  if (!hasLeaflet()) return null;
  const html = `<div class="width-label-inner">${Number(widthM).toFixed(1)}m</div>`;
  const icon = L.divIcon({ className: 'width-label', html, iconAnchor: [0, 0] });
  return L.marker(latlng, { icon, pane: PANE_ID, interactive: false, keyboard: false });
}

function setLabelWidth(widthM) {
  if (!labelMarker || !hasLeaflet()) return;
  labelMarker.setIcon(L.divIcon({ className: 'width-label', html: `<div class="width-label-inner">${Number(widthM).toFixed(1)}m</div>`, iconAnchor: [0, 0] }));
}

function buildHandlesFromWidth(widthM) {
  const halfM = Math.max(0, Number(widthM) || 0) / 2;
  const halfPx = metersToPixels(halfM);
  if (!hasLeaflet() || !centerPt || !normalUnit) return { leftLL: centerLL, rightLL: centerLL };
  const leftPt = L.point(centerPt.x - normalUnit.x * halfPx, centerPt.y - normalUnit.y * halfPx);
  const rightPt = L.point(centerPt.x + normalUnit.x * halfPx, centerPt.y + normalUnit.y * halfPx);
  const leftLL = map.layerPointToLatLng(leftPt);
  const rightLL = map.layerPointToLatLng(rightPt);
  return { leftLL, rightLL };
}

function metersToPixels(meters) {
  if (!hasLeaflet() || !centerPt || !normalUnit) return 0;
  const refPx = 80;
  const refPt = L.point(centerPt.x + normalUnit.x * refPx, centerPt.y + normalUnit.y * refPx);
  const refLL = map.layerPointToLatLng(refPt);
  const dist = map.distance(centerLL, refLL);
  const metersPerPx = dist > 0 ? dist / refPx : 1;
  return meters / Math.max(1e-6, metersPerPx);
}

function wireDrag(marker) {
  marker.on('dragstart', () => {
    try {
      map.dragging.disable();
    } catch (e) { }
  });
  marker.on('drag', () => onHandleDrag(marker));
  marker.on('dragend', () => {
    try {
      map.dragging.enable();
    } catch (e) { }
    const w = getCurrentWidthMeters();
    if (activeFeatureId && Number.isFinite(w)) {
      store.applyWidthOverride(activeFeatureId, w);
    }
  });
}

function onHandleDrag(dragged) {
  if (isUpdating || !centerPt || !normalUnit || !leftMarker || !rightMarker || !crossLine) return;
  isUpdating = true;
  try {
    const draggedPt = map.latLngToLayerPoint(dragged.getLatLng());
    const dx = draggedPt.x - centerPt.x;
    const dy = draggedPt.y - centerPt.y;
    const signed = dx * normalUnit.x + dy * normalUnit.y;
    const halfPx = Math.max(0, Math.abs(signed));
    if (!hasLeaflet()) return;
    const leftPt = L.point(centerPt.x - normalUnit.x * halfPx, centerPt.y - normalUnit.y * halfPx);
    const rightPt = L.point(centerPt.x + normalUnit.x * halfPx, centerPt.y + normalUnit.y * halfPx);
    const leftLL = map.layerPointToLatLng(leftPt);
    const rightLL = map.layerPointToLatLng(rightPt);
    leftMarker.setLatLng(leftLL);
    rightMarker.setLatLng(rightLL);
    crossLine.setLatLngs([leftLL, rightLL]);
    if (labelMarker) labelMarker.setLatLng(centerLL);
    const w = map.distance(leftLL, rightLL);
    setLabelWidth(w);
  } finally {
    isUpdating = false;
  }
}

function getCurrentWidthMeters() {
  if (!leftMarker || !rightMarker) return null;
  return map.distance(leftMarker.getLatLng(), rightMarker.getLatLng());
}

function pickBestSegment(feature, clickLatLng) {
  const g = feature?.geometry;
  if (!g) return null;
  const lines = [];
  if (g.type === 'LineString') lines.push(g.coordinates);
  else if (g.type === 'MultiLineString') lines.push(...g.coordinates);
  else return null;

  ensureLayerGroup();

  const clickPt = clickLatLng ? map.latLngToLayerPoint(clickLatLng) : null;
  if (clickPt) return bestSegmentNearClick(lines, clickPt);
  return midSegmentOfLongest(lines);
}

function bestSegmentNearClick(lines, clickPt) {
  let best = null;
  for (const coords of lines) {
    if (!coords || coords.length < 2) continue;
    for (let i = 0; i < coords.length - 1; i++) {
      const aLL = L.latLng(coords[i][1], coords[i][0]);
      const bLL = L.latLng(coords[i + 1][1], coords[i + 1][0]);
      const aPt = map.latLngToLayerPoint(aLL);
      const bPt = map.latLngToLayerPoint(bLL);
      const proj = projectPointToSegment(clickPt, aPt, bPt);
      if (!proj) continue;
      if (!best || proj.distSq < best.distSq) {
        const dir = unitDir(aPt, bPt);
        if (!dir) continue;
        best = {
          distSq: proj.distSq,
          centerPt: proj.pt,
          centerLL: map.layerPointToLatLng(proj.pt),
          normalUnit: { x: -dir.y, y: dir.x }
        };
      }
    }
  }
  return best;
}

function midSegmentOfLongest(lines) {
  let bestLine = null;
  let bestLen = -1;
  for (const coords of lines) {
    if (!coords || coords.length < 2) continue;
    let len = 0;
    for (let i = 0; i < coords.length - 1; i++) {
      const aLL = L.latLng(coords[i][1], coords[i][0]);
      const bLL = L.latLng(coords[i + 1][1], coords[i + 1][0]);
      const aPt = map.latLngToLayerPoint(aLL);
      const bPt = map.latLngToLayerPoint(bLL);
      len += Math.hypot(bPt.x - aPt.x, bPt.y - aPt.y);
    }
    if (len > bestLen) {
      bestLen = len;
      bestLine = coords;
    }
  }
  if (!bestLine || bestLine.length < 2 || !hasLeaflet()) return null;
  const midIdx = Math.max(0, Math.floor((bestLine.length - 2) / 2));
  const aLL = L.latLng(bestLine[midIdx][1], bestLine[midIdx][0]);
  const bLL = L.latLng(bestLine[midIdx + 1][1], bestLine[midIdx + 1][0]);
  const aPt = map.latLngToLayerPoint(aLL);
  const bPt = map.latLngToLayerPoint(bLL);
  const dir = unitDir(aPt, bPt);
  if (!dir || !hasLeaflet()) return null;
  const midPt = L.point((aPt.x + bPt.x) / 2, (aPt.y + bPt.y) / 2);
  return { centerPt: midPt, centerLL: map.layerPointToLatLng(midPt), normalUnit: { x: -dir.y, y: dir.x } };
}

function unitDir(aPt, bPt) {
  const dx = bPt.x - aPt.x;
  const dy = bPt.y - aPt.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return null;
  return { x: dx / len, y: dy / len };
}

function projectPointToSegment(p, a, b) {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  if (len2 < 1e-9) return null;
  const apx = p.x - a.x;
  const apy = p.y - a.y;
  const t = Math.max(0, Math.min(1, (apx * abx + apy * aby) / len2));
  const x = a.x + t * abx;
  const y = a.y + t * aby;
  const dx = p.x - x;
  const dy = p.y - y;
  if (!hasLeaflet()) return { pt: { x, y }, distSq: dx * dx + dy * dy };
  return { pt: L.point(x, y), distSq: dx * dx + dy * dy };
}
