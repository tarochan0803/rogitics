// 手順3-4: 航空写真セグメンテーション幅サーバ(road_seg) のクライアント。
//
// road_seg サーバ(/segment_road_width)は SV/YOLO と同じ widthSamples
// {roadId, widthM, frameConfidence} を返すので、既存の aggregateWidthSuggestions →
// store.applyPerceptionWidthAi にそのまま流せる（width_ai=AI推定として適用）。
// = runPerceptionFusion の「航空写真版ドロップイン代替」。
//
// 既定エンドポイントは window.ROAD_SEG_URL か http://127.0.0.1:8012。

import { aggregateWidthSuggestions } from './perceptionFusion.js';
import { store } from '../state.js';
import { classifyWidth } from '../core/widthClass.js';

function baseUrl() {
  if (typeof window !== 'undefined' && window.ROAD_SEG_URL) return String(window.ROAD_SEG_URL).replace(/\/$/, '');
  return 'http://127.0.0.1:8012';
}

function defaultSurfaceBackend(opts = {}) {
  if (opts.backend) return opts.backend;
  if (typeof window !== 'undefined') {
    return window.ROAD_SEG_SURFACE_BACKEND || window.ROAD_SEG_BACKEND || 'pretrained';
  }
  return 'pretrained';
}

function roadsToRequest(features) {
  // 経路コリドーの LineString/MultiLineString だけを送る（SV/YOLOと同じ対象範囲）。
  const roads = [];
  for (const f of (Array.isArray(features) ? features : [])) {
    const g = f?.geometry;
    if (!g || (g.type !== 'LineString' && g.type !== 'MultiLineString')) continue;
    const id = f.id != null ? f.id : f.properties?.id;
    if (id == null) continue;
    roads.push({ id: String(id), geometry: { type: g.type, coordinates: g.coordinates } });
  }
  return roads;
}

// road_seg サーバへ問い合わせて widthSamples を得る。
// opts: { zoom, backend, layer, spacingM, maxHalfWidthM, signal }
export async function fetchAerialWidthSamples(features, opts = {}) {
  const roads = roadsToRequest(features);
  if (!roads.length) return { widthSamples: [], summaries: [], meta: { roadCount: 0 } };
  const body = {
    roads,
    zoom: opts.zoom ?? 18,
    backend: opts.backend ?? 'threshold',
    layer: opts.layer ?? 'seamlessphoto',
    spacingM: opts.spacingM ?? 8.0,
    maxHalfWidthM: opts.maxHalfWidthM ?? 12.0,
    minConfidence: opts.minConfidence ?? 0.45
  };
  const res = await fetch(`${baseUrl()}/segment_road_width`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: opts.signal
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`road_seg /segment_road_width ${res.status}: ${txt.slice(0, 300)}`);
  }
  return res.json();
}

// 航空写真の widthSamples を既存知覚融合へ流して width_ai を適用する。
// runPerceptionFusion と同じ集約→適用ロジック（航空写真版）。
// 返り値: { appliedCount, suggestions, summaries }
export async function applyAerialWidthFusion(opts = {}) {
  const st = store.getState();
  const features = st.geoJsonDataSets || [];
  if (!features.length) throw new Error('道路(geoJsonDataSets)がありません。先に道路取得してください。');

  const { widthSamples, summaries, meta } = await fetchAerialWidthSamples(features, opts);
  const agg = aggregateWidthSuggestions(features, widthSamples, {
    autoApplyConfidence: opts.autoApplyConfidence ?? 0.7,
    minDeltaM: opts.minDeltaM ?? 0.6,
    defaultRoadWidth: opts.defaultRoadWidth ?? 6
  });

  const aiWidthMap = {};
  const appliedIds = [];
  for (const sug of agg.suggestions) {
    if (sug.autoApply && sug.roadId != null && Number.isFinite(sug.suggestedWidth)) {
      const id = String(sug.roadId);
      // width_ai は {width, confidence} 形で渡すと信頼度も記録される。
      aiWidthMap[id] = { width: Number(sug.suggestedWidth), confidence: Number(sug.confidence) };
      appliedIds.push(id);
    }
  }
  if (appliedIds.length) store.applyPerceptionWidthAi(aiWidthMap);

  // 階級つきサマリ（表示層・ログ用）
  const classed = (summaries || []).map((s) => ({
    ...s,
    ...classifyWidth(s.widthM, s.confidence)
  }));
  return { appliedCount: appliedIds.length, appliedIds, suggestions: agg.suggestions, summaries: classed, meta };
}

function isRoadSegSurfaceFeature(feature) {
  return String(feature?.properties?.source || '') === 'road_seg_surface'
    || String(feature?.id || feature?.properties?.id || '').startsWith('road_seg_surface:');
}

function normalizeSurfaceFeature(feature, index = 0) {
  if (!feature || feature.type !== 'Feature' || !feature.geometry) return null;
  if (feature.geometry.type !== 'Polygon' && feature.geometry.type !== 'MultiPolygon') return null;
  const id = String(feature.properties?.id || feature.id || `road_seg_surface:${index}`);
  return {
    type: 'Feature',
    id,
    properties: {
      ...(feature.properties || {}),
      id,
      source: 'road_seg_surface'
    },
    geometry: feature.geometry
  };
}

export async function fetchAerialRoadSurface(features, opts = {}) {
  const roads = roadsToRequest(features);
  if (!roads.length && !opts.bbox) {
    return { type: 'FeatureCollection', features: [], meta: { roadCount: 0, featureCount: 0 } };
  }
  const body = {
    roads,
    bbox: opts.bbox || undefined,
    zoom: opts.zoom ?? 18,
    backend: defaultSurfaceBackend(opts),
    layer: opts.layer ?? 'seamlessphoto',
    marginTiles: opts.marginTiles ?? 0,
    maxTiles: opts.maxTiles ?? 64,
    roadBufferM: opts.roadBufferM ?? 28.0,
    cellPx: opts.cellPx ?? 6,
    fillRatio: opts.fillRatio ?? 0.35,
    minAreaM2: opts.minAreaM2 ?? 12.0,
    maxPolygons: opts.maxPolygons ?? 400
  };
  const res = await fetch(`${baseUrl()}/segment_road_surface`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: opts.signal
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`road_seg /segment_road_surface ${res.status}: ${txt.slice(0, 300)}`);
  }
  return res.json();
}

export function clearAerialRoadSurface() {
  const current = store.getState().maskEdits || {};
  const next = {
    allow: (current.allow || []).filter((f) => !isRoadSegSurfaceFeature(f)),
    deny: current.deny || []
  };
  const removed = (current.allow || []).length - next.allow.length;
  if (removed > 0) store.setMaskEdits(next, { replace: true });
  return { removedCount: removed };
}

export async function applyAerialRoadSurface(opts = {}) {
  const st = store.getState();
  const features = opts.features || st.geoJsonDataSets || [];
  const fc = await fetchAerialRoadSurface(features, opts);
  const incoming = (fc.features || [])
    .map((f, i) => normalizeSurfaceFeature(f, i))
    .filter(Boolean);
  const current = store.getState().maskEdits || {};
  const allowBase = opts.replace === false
    ? (current.allow || []).slice()
    : (current.allow || []).filter((f) => !isRoadSegSurfaceFeature(f));
  const next = {
    allow: [...allowBase, ...incoming],
    deny: current.deny || []
  };
  store.setMaskEdits(next, { replace: true });
  return {
    appliedCount: incoming.length,
    featureCollection: fc,
    meta: fc.meta || {}
  };
}

// デバッグ用に window へ生やす（任意）。index3dMain.js から呼ぶか、ここを import して使う。
// Debug hooks for index3dMain/browser console.
export function exposeRoadSegDebug() {
  if (typeof window === 'undefined') return;
  window.roadSegFetch = (opts) => fetchAerialWidthSamples(store.getState().geoJsonDataSets || [], opts);
  window.roadSegApply = (opts) => applyAerialWidthFusion(opts);
  window.roadSegSurfaceFetch = (opts) => fetchAerialRoadSurface(store.getState().geoJsonDataSets || [], opts);
  window.roadSegSurfaceApply = (opts) => applyAerialRoadSurface(opts);
  window.roadSegSurfaceClear = () => clearAerialRoadSurface();
}
