import { turf } from '../utils/geo.js';
import { store } from '../state.js';
import { fetchRoadsAndSidewalks } from '../api/overpass.js';
import { RUNTIME_CONFIG } from '../config.js';
import { resolvePlateauBuildingTilesetForBounds } from '../api/plateauCatalog.js';

function getPlateauUrlFromUi() {
  return String(
    document.getElementById('plateauUrlInput')?.value ||
    document.getElementById('plateauBuildingsUrl')?.value ||
    RUNTIME_CONFIG.plateauBuildingsUrl ||
    ''
  ).trim();
}

function shouldAutoLoadPlateau() {
  return !(typeof window !== 'undefined' && window.PLATEAU_AUTO_DISABLE === true);
}

function plateauPreferLod() {
  return String((typeof window !== 'undefined' && window.PLATEAU_PREFER_LOD) || 'lod1').toLowerCase();
}

async function resolvePlateauTilesetForBoundsToStore(bounds) {
  if (!shouldAutoLoadPlateau()) {
    store.setState({ plateauTileset: null });
    return null;
  }
  try {
    const tileset = await resolvePlateauBuildingTilesetForBounds(bounds, { preferLod: plateauPreferLod() });
    store.setState({ plateauTileset: tileset || null });
    if (typeof window !== 'undefined') window.PLATEAU_AUTO_TILESET = tileset || null;
    if (tileset?.url) {
      console.log(`[plateau] auto tileset: ${tileset.muniCd || ''} ${tileset.itemName || tileset.name || ''}`);
    }
    return tileset || null;
  } catch (e) {
    console.warn('[plateau] auto tileset lookup failed:', e?.message || e);
    store.setState({ plateauTileset: null });
    if (typeof window !== 'undefined') window.PLATEAU_AUTO_TILESET = null;
    return null;
  }
}

function renderThreeSceneAfterDataLoad() {
  try {
    globalThis.__index3d_renderSceneThree?.();
  } catch (e) {
    console.warn('[three3d] render after data load failed:', e?.message || e);
  }
}

// 道路読込時にOSM建物と対応するPLATEAUタイルを更新し、2D/3Dの対象範囲を揃える。
// 手動指定のPLATEAU GeoJSONも上書き/統合ソースとして残す。
async function loadBuildingsHybrid(bounds) {
  const statusEl = document.getElementById('buildingStatus');
  if (statusEl) statusEl.textContent = '建物: OSM / PLATEAU 読込中...';
  let features = [];
  try {
    const { fetchBuildings } = await import('../api/overpass.js');
    const bldgFc = await fetchBuildings(bounds);
    features = bldgFc?.features || [];
  } catch (e) {
    console.warn('[buildings] OSM建物取得失敗:', e?.message || e);
  }
  const plateauUrl = getPlateauUrlFromUi();
  let plateauCount = 0;
  if (plateauUrl) {
    try {
      const { fetchPlateauBuildings, mergeFeaturesById } = await import('../api/plateau.js');
      const pla = await fetchPlateauBuildings(plateauUrl);
      plateauCount = pla.length;
      features = mergeFeaturesById(pla, features); // PLATEAU を優先（実測高さ）
      console.log(`[buildings] PLATEAU ${pla.length} + OSM → 統合 ${features.length}`);
    } catch (e) {
      console.warn('[buildings] PLATEAU取得失敗（OSMのみ使用）:', e?.message || e);
    }
  }
  const plateauTileset = await resolvePlateauTilesetForBoundsToStore(bounds);
  try { store.setBuildingsGeoJSON(features); } catch (e) { }
  if (statusEl) {
    const tilesetLabel = plateauTileset?.itemName || plateauTileset?.name || '';
    if (plateauCount > 0) {
      statusEl.textContent = `建物: PLATEAU GeoJSON ${plateauCount} + OSM合計 ${features.length}`;
    } else if (tilesetLabel) {
      statusEl.textContent = `建物: OSM ${features.length} + PLATEAUタイル ${tilesetLabel}`;
    } else {
      statusEl.textContent = `建物: OSM ${features.length} / PLATEAUタイルなし`;
    }
  }
  return features.length;
}
// width imports removed — road coloring disabled in v7.2
import { initWidthEditor, openForFeature as openWidthEditor, setWidthEditEnabled } from './widthEditor.js';
import { showStreetViewAt } from './streetviewScan.js';
// 幅帯の表示は判定と同じ有効幅（roadWidthModel→applyWidthRisk）を使い、表示=判定に揃える。
import { estimateEffectiveRoadWidth } from '../core/feasibility.js';

let map;
let manualAddEnabled = true;
let obstacleAddEnabled = false;
let obstaclePolygonDrawEnabled = false;
let activeObstaclePolygonDrawer = null;
let waypointInsertMode = false;
let obstacleRadiusMeters = 1.5;
let obstacleHeightMeters = 3.0;

const layers = {};
const LAYER_NAMES = ['buildings', 'roads', 'sidewalks', 'endpoints', 'route', 'sweep', 'feasibility', 'obstacles', 'search', 'roadWidths', 'regulations'];

const ACCENT = '#06b6d4';
// v7.2: 経路を目立たせるため、経路=オレンジ系、道路=控えめなグレー/ブルー
const ROUTE_COLOR = '#f59e0b';       // amber — 道路色と明確に区別
const ROAD_COLOR = '#94a3b8';        // light slate — 衛星画像上で視認可能
const ROAD_SELECTED = '#38bdf8';     // sky blue — 選択時だけ明るく
const SIDEWALK_COLOR = '#475569';    // dark slate
const SWEEP_COLOR = '#3b82f6';       // blue
const SWEEP_OUTLINE = '#1e40af';     // dark blue
const FEAS_DANGER = '#ef4444';       // red
const FEAS_OK = '#22c55e';           // green
const REGULATION_COLORS = {
  block: '#ef4444',
  permit_required: '#fb923c',
  warning: '#facc15',
  unknown: '#94a3b8',
  info: '#38bdf8'
};

function toast(msg) {
  const box = document.getElementById('toast');
  if (!box) return;
  const div = document.createElement('div');
  div.className = 'toast-item';
  div.textContent = msg;
  box.appendChild(div);
  setTimeout(() => div.remove(), 2000);
}

function cssColor(varName, fallback) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(varName)?.trim();
    return v || fallback;
  } catch (e) {
    return fallback;
  }
}

function ensureLayer(name) {
  if (!layers[name]) {
    layers[name] = L.layerGroup();
    if (map) layers[name].addTo(map);
  }
  return layers[name];
}

function configuredSatelliteTileLayer() {
  const template = String(
    (typeof window !== 'undefined' && (window.SATELLITE_TILE_URL || window.SATELLITE_TILE_TEMPLATE)) ||
    RUNTIME_CONFIG.satelliteTileUrlTemplate ||
    ''
  ).trim();
  if (!template) return null;
  const maxZoom = Number(
    (typeof window !== 'undefined' && window.SATELLITE_TILE_MAX_ZOOM) ||
    RUNTIME_CONFIG.satelliteTileMaxZoom ||
    20
  );
  const attribution = String(
    (typeof window !== 'undefined' && window.SATELLITE_TILE_ATTRIBUTION) ||
    RUNTIME_CONFIG.satelliteTileAttribution ||
    ''
  );
  const name = String(
    (typeof window !== 'undefined' && window.SATELLITE_TILE_NAME) ||
    RUNTIME_CONFIG.satelliteTileName ||
    'custom-satellite'
  );
  return {
    name,
    url: template,
    maxNativeZoom: Number.isFinite(maxZoom) && maxZoom > 0 ? maxZoom : 20,
    attribution
  };
}

function setupGoogleTiles() {
  // Commercial-clean default: use GSI seamlessphoto. Do not call unofficial
  // Google tile endpoints such as mt1.google.com.
  const customLayer = configuredSatelliteTileLayer();
  const baseLayer = L.tileLayer(customLayer?.url || 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg', {
    maxZoom: 21,
    maxNativeZoom: customLayer?.maxNativeZoom || 18,
    attribution: customLayer?.attribution || '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener noreferrer">地理院タイル</a>'
  }).addTo(map);
  window.index3DMapBase = customLayer?.name || 'gsi-seamlessphoto';

  const allowGoogleRouteMap = typeof window !== 'undefined' && window.USE_GOOGLE_2D_ROUTE_MAP === true;
  if (!allowGoogleRouteMap) return;

  let googleLayer = null;
  function ensureGoogleMapsScript() {
    const key = String(RUNTIME_CONFIG.googleMapsApiKey || window.USER_CONFIG?.googleMapsApiKey || '').trim();
    if (!key || typeof document === 'undefined') return;
    if (typeof google !== 'undefined' && google.maps) return;
    if (document.querySelector('script[src*="maps.googleapis.com/maps/api/js"]')) return;
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&loading=async`;
    s.async = true;
    s.defer = true;
    document.head.appendChild(s);
  }

  function tryAdd() {
    if (typeof L === 'undefined') return false;
    if (typeof L.gridLayer?.googleMutant !== 'function') return false;
    if (typeof google === 'undefined' || !google.maps) return false;
    try {
      googleLayer = L.gridLayer.googleMutant({ type: 'satellite', maxZoom: 21 });
      googleLayer.addTo(map);
      try { map.removeLayer(baseLayer); } catch (e) { }
      window.index3DMapBase = 'google-satellite-jsapi';
      console.log('[map2d] Google satellite layer loaded via Maps JavaScript API');
      return true;
    } catch (e) {
      console.warn('[map2d] GoogleMutant init failed', e);
      return false;
    }
  }

  ensureGoogleMapsScript();
  if (tryAdd()) return;

  let attempts = 0;
  const timer = setInterval(() => {
    attempts++;
    if (tryAdd()) {
      clearInterval(timer);
    } else if (attempts > 30) {
      clearInterval(timer);
      console.warn('[map2d] Google Maps JS not available, keep GSI seamlessphoto base layer');
    }
  }, 500);
}

export function initMap2D(containerId = 'map') {
  if (typeof L === 'undefined') {
    console.error('[map2d] Leaflet not loaded');
    const statusEl = document.getElementById('status-message');
    if (statusEl) statusEl.textContent = '地図ライブラリの読み込みに失敗しました。ネットワークを確認してください。';
    return;
  }

  map = L.map(containerId, {
    zoomControl: true,
    preferCanvas: true,
    maxZoom: 21
  });

  map.setView([35.68, 139.76], 14);
  setupGoogleTiles();
  LAYER_NAMES.forEach(name => ensureLayer(name));
  map.on('click', onMapClick);
  map.on('draw:created', onDrawCreated);
  map.on('contextmenu', (e) => {
    L.DomEvent.preventDefault(e);
    showStreetViewAt(e.latlng.lat, e.latlng.lng, 0);
  });
  store.subscribe(render);
  initWidthEditor(map, store);
  setupZoomRerender();
  window._leafletMap = map;
  console.log('[map2d] Leaflet map initialized');
}

function featureIdOf(feature) {
  if (!feature) return null;
  if (feature.id != null) return String(feature.id);
  const pid = feature.properties?.id;
  if (pid != null) return String(pid);
  return null;
}

function addObstacleFeature(feature, { source = 'manual' } = {}) {
  if (!feature?.geometry) return false;
  const id = `obs-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  feature.properties = {
    ...(feature.properties || {}),
    id,
    type: 'obstacle',
    source,
    height: obstacleHeightMeters,
    heightOnly: false
  };
  const edits = store.getState().maskEdits || { allow: [], deny: [] };
  store.setMaskEdits({
    allow: edits.allow || [],
    deny: [...(edits.deny || []), feature]
  }, { replace: true });
  return true;
}

function onDrawCreated(e) {
  if (!obstaclePolygonDrawEnabled) return;
  const layer = e?.layer;
  if (!layer || typeof layer.toGeoJSON !== 'function') return;
  if (addObstacleFeature(layer.toGeoJSON(), { source: 'manual_polygon' })) {
    toast(`ポリゴン障害物を追加しました（高さ=${obstacleHeightMeters.toFixed(1)}m）`);
  }
  setObstaclePolygonDrawMode(false);
}

function onMapClick(e) {
  const lat = e.latlng.lat;
  const lng = e.latlng.lng;
  const state = store.getState();

  if (state.isWidthEditMode) {
    const nearest = findNearestRoad(lat, lng, state.geoJsonDataSets, 30);
    if (nearest) {
      store.setSelectedRoadFeatureId(featureIdOf(nearest.feature));
      openWidthEditor(nearest.feature, e.latlng);
      setWidthEditEnabled(true);
    }
    return;
  }

  if (waypointInsertMode) {
    const simRoute = state.simRoute;
    if (simRoute && simRoute.length >= 2) {
      const idx = findInsertionIndex({ lat, lng }, simRoute, state.selectedEndpoints);
      store.insertEndpoint(idx, {
        lat, lng,
        id: `ep-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
      });
      toast(`中間点を位置 ${idx} に追加しました`);
    } else {
      toast('先にルートを設定してください');
    }
    return;
  }

  if (obstacleAddEnabled) {
    const radius = obstacleRadiusMeters;
    const height = obstacleHeightMeters;
    const circle = turf.circle([lng, lat], radius, { units: 'meters', steps: 32 });
    circle.properties = { ...(circle.properties || {}), radius, height };
    addObstacleFeature(circle, { source: 'manual_circle' });
    toast(`障害物を追加 (r=${radius}m, h=${height}m)`);
    return;
  }

  if (manualAddEnabled) {
    store.addEndpoint({
      lat, lng,
      id: `ep-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    });
    const count = (store.getState().selectedEndpoints || []).length;
    if (count >= 2) {
      toast(`📌 ${count}点目を追加 — 経路を自動計算中...`);
    } else {
      toast(`📌 ${count}点目を追加 — もう1点クリックで経路が引かれます`);
    }
  }
}

// v7.2: skip unchanged layers to avoid excessive redraws
let _lastRoadSig = '';
let _lastSidewalkSig = '';
let _lastBuildingsSig = '';

function render(state) {
  // Endpoints & route は即時描画（軽量）
  renderEndpoints(state);
  renderRoute(state);

  // Roads & sidewalks はシグネチャ変化時のみ再描画
  const roadSig = (state.geoJsonDataSets?.length ?? 0) + ':' + (state.selectedRoadFeatureId || '');
  if (roadSig !== _lastRoadSig) {
    _lastRoadSig = roadSig;
    renderRoads(state);
  }
  const swSig = String(state.sidewalkGeoJSON?.length ?? 0);
  if (swSig !== _lastSidewalkSig) {
    _lastSidewalkSig = swSig;
    renderSidewalks(state);
  }
  
  const bldgSig = String(state.buildingsGeoJSON?.length ?? 0);
  if (bldgSig !== _lastBuildingsSig) {
    _lastBuildingsSig = bldgSig;
    renderBuildings(state);
  }

  renderObstacles(state);

  if (!state.simRoute || state.simRoute.length === 0) {
    clearSweepLayers();
    clearFeasibilityLayers();
  }

  const confirmBtn = document.getElementById('confirm-route');
  const clearBtn = document.getElementById('clear-endpoints');
  const resetBtn = document.getElementById('reset-route');
  if (confirmBtn) confirmBtn.disabled = state.selectedEndpoints.length < 2;
  if (clearBtn) clearBtn.disabled = state.selectedEndpoints.length === 0;
  if (resetBtn) resetBtn.disabled = state.simRoute.length === 0;
}

function renderEndpoints(state) {
  const lg = ensureLayer('endpoints');
  lg.clearLayers();
  const accent = cssColor('--accent', ACCENT);

  state.selectedEndpoints.forEach((p, i) => {
    const marker = L.marker([p.lat, p.lng], {
      draggable: true,
      icon: L.divIcon({
        className: 'endpoint-marker-wrap',
        html: `
          <div class="endpoint-marker-bg" style="background:${accent}; border: 2px solid #fff; width: 14px; height: 14px; border-radius: 50%; box-shadow: 0 0 10px rgba(0,0,0,0.5); cursor: move;"></div>
          <div class="endpoint-label" style="position: absolute; top: -20px; left: 50%; transform: translateX(-50%); background:${accent}; color:#000; padding:1px 6px; border-radius:10px; font-size:9px; font-weight:800; white-space:nowrap; pointer-events:none;">${i + 1}</div>
        `,
        iconSize: [14, 14],
        iconAnchor: [7, 7]
      })
    }).addTo(lg);

    marker.on('dragend', (ev) => {
      const newLatLng = ev.target.getLatLng();
      store.updateEndpoint(p.id, { lat: newLatLng.lat, lng: newLatLng.lng });
    });

    marker.on('contextmenu', (ev) => {
      L.DomEvent.stopPropagation(ev);
      store.removeEndpoint(p.id);
      toast(`地点 ${i + 1} を削除しました`);
    });
  });
}

let ghostMarker = null;

function distSq(p1, p2) {
  if (!p1 || !p2) return Infinity;
  return (p1.lat - p2.lat) ** 2 + (p1.lng - p2.lng) ** 2;
}

function findInsertionIndex(latlng, simRoute, endpoints) {
  if (!simRoute || simRoute.length < 2) return endpoints.length;

  // Find index in simRoute closest to click
  let minDist = Infinity;
  let nearestIdx = 0;
  for (let i = 0; i < simRoute.length; i++) {
    const d = distSq(latlng, simRoute[i]);
    if (d < minDist) {
      minDist = d;
      nearestIdx = i;
    }
  }

  // Find where each endpoint is located in simRoute
  const epIndices = endpoints.map(ep => {
    let m = Infinity;
    let idx = 0;
    for (let i = 0; i < simRoute.length; i++) {
      const d = distSq(ep, simRoute[i]);
      if (d < m) {
        m = d;
        idx = i;
      }
    }
    return idx;
  });

  // Find the segment [j, j+1] that contains nearestIdx
  // We check if nearestIdx falls "before or at" the end of segment j
  for (let j = 0; j < epIndices.length - 1; j++) {
    // Ideally nearestIdx should be between epIndices[j] and epIndices[j+1]
    // But due to snapping, nearestIdx could be < epIndices[j] (before start)
    // or > epIndices[j+1] (after end).
    // The most robust check for "insert between j and j+1" is:
    // "Is it before the end of this segment?" 
    // (Assuming we process segs in order and haven't matched a previous one)
    if (nearestIdx <= epIndices[j + 1]) {
      return j + 1;
    }
  }

  // If nearestIdx is > last endpoint index, append to end.
  return endpoints.length;
}

function routeHash(route = []) {
  if (!Array.isArray(route) || route.length < 2) return '';
  return route
    .map((p) => `${Number(p.lat).toFixed(6)},${Number(p.lng).toFixed(6)}`)
    .join('|');
}

function renderRouteCandidates(lg, state) {
  const selectedHash = routeHash(state.simRoute || []);
  const candidates = (state.routeCandidates || [])
    .filter((c) => Array.isArray(c?.route) && c.route.length >= 2 && routeHash(c.route) !== selectedHash)
    .slice(0, 5);

  candidates.forEach((candidate) => {
    const isAvoidance = candidate.kind === 'avoidance';
    const latlngs = candidate.route.map((p) => [p.lat, p.lng]);
    const line = L.polyline(latlngs, {
      color: isAvoidance ? '#14b8a6' : '#64748b',
      weight: isAvoidance ? 4 : 3,
      opacity: isAvoidance ? 0.72 : 0.46,
      dashArray: isAvoidance ? '10 8' : '4 8',
      lineCap: 'round',
      lineJoin: 'round',
      interactive: true
    }).addTo(lg);
    const contact = Number.isFinite(Number(candidate.contactRatio))
      ? `接触 ${(Number(candidate.contactRatio) * 100).toFixed(1)}%`
      : '';
    const radius = Number.isFinite(Number(candidate.tightestRadius))
      ? `最小R ${Number(candidate.tightestRadius).toFixed(1)}m`
      : '';
    line.bindTooltip([candidate.displayName || candidate.label || '候補経路', contact, radius].filter(Boolean).join(' / '), {
      sticky: true,
      opacity: 0.92
    });
  });
}

function renderRouteChoiceLabel(lg, state) {
  const meta = state.routeMeta || {};
  if (!state.simRoute || state.simRoute.length < 2 || !meta.displayName) return;
  if (meta.kind !== 'avoidance') return;
  const idx = Math.max(0, Math.min(state.simRoute.length - 1, Math.floor(state.simRoute.length * 0.5)));
  const p = state.simRoute[idx];
  const label = `採用: 回避経路`;
  L.marker([p.lat, p.lng], {
    interactive: false,
    icon: L.divIcon({
      className: 'route-choice-label-wrap',
      html: `<div class="route-choice-label">${label}</div>`,
      iconSize: [140, 24],
      iconAnchor: [70, 12]
    })
  }).addTo(lg);
}

function renderRoute(state) {
  const lg = ensureLayer('route');
  lg.clearLayers();
  if (!state.simRoute || state.simRoute.length < 2) return;

  renderRouteCandidates(lg, state);

  if (state.selectedRoadRoute && state.selectedRoadRoute.length >= 2) {
    L.polyline(state.selectedRoadRoute.map(p => [p.lat, p.lng]), {
      color: '#38bdf8',
      weight: 2,
      opacity: 0.55,
      dashArray: '8 8',
      lineCap: 'round',
      lineJoin: 'round',
      interactive: false
    }).addTo(lg);
  }

  const latlngs = state.simRoute.map(p => [p.lat, p.lng]);

  // 経路: 3層でくっきり見えるように (外側グロー → 白縁 → オレンジコア)
  L.polyline(latlngs, {
    color: ROUTE_COLOR,
    weight: 14,
    opacity: 0.2,
    lineCap: 'round',
    lineJoin: 'round',
    className: 'route-glow',
    interactive: false
  }).addTo(lg);

  L.polyline(latlngs, {
    color: '#ffffff',
    weight: 5,
    opacity: 0.35,
    lineCap: 'round',
    lineJoin: 'round',
    interactive: false
  }).addTo(lg);

  L.polyline(latlngs, {
    color: ROUTE_COLOR,
    weight: 3.5,
    opacity: 0.95,
    lineCap: 'round',
    lineJoin: 'round',
    className: 'route-core',
    interactive: false
  }).addTo(lg);
  renderRouteChoiceLabel(lg, state);

  // Interaction line — wide invisible polyline for route dragging (Google Maps style)
  const inter = L.polyline(latlngs, {
    color: 'transparent',
    weight: 30,
    opacity: 0,
    interactive: true,
    className: 'route-interact',
    pane: 'overlayPane'
  }).addTo(lg);

  // Ghost marker follows cursor along route — drag to reroute
  inter.on('mousemove', (e) => {
    if (ghostMarker && ghostMarker._isDragging) return;
    if (!ghostMarker) {
      ghostMarker = L.marker(e.latlng, {
        draggable: true,
        icon: L.divIcon({
          className: 'ghost-marker-wrap',
          html: `<div class="ghost-marker-dot"></div>`,
          iconSize: [18, 18],
          iconAnchor: [9, 9]
        }),
        zIndexOffset: 1000
      }).addTo(lg);

      // On drag start: compute insertion index, set flag
      ghostMarker.on('dragstart', (ev) => {
        ghostMarker._isDragging = true;
        const el = ghostMarker.getElement();
        if (el) el.querySelector('.ghost-marker-dot')?.classList.add('dragging');
        const startPos = ev.target.getLatLng();
        ghostMarker._insertIdx = findInsertionIndex(
          { lat: startPos.lat, lng: startPos.lng },
          state.simRoute, state.selectedEndpoints
        );
      });

      // On drag end: insert waypoint at final position
      ghostMarker.on('dragend', (ev) => {
        const idx = ghostMarker._insertIdx;
        ghostMarker._isDragging = false;
        if (idx != null && idx >= 0) {
          const pos = ev.target.getLatLng();
          store.insertEndpoint(idx, {
            lat: pos.lat, lng: pos.lng,
            id: `ep-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
          });
        }
        ghostMarker._insertIdx = -1;
      });
    } else {
      ghostMarker.setLatLng(e.latlng);
      if (!ghostMarker._map) ghostMarker.addTo(lg);
    }
  });

  inter.on('mouseout', () => {
    if (ghostMarker && !ghostMarker._isDragging) {
      ghostMarker.remove();
      ghostMarker = null;
    }
  });
}

/* road width coloring removed in v7.2 — roads use uniform ROAD_COLOR */

function renderRoads(state) {
  const lg = ensureLayer('roads');
  lg.clearLayers();
  if (!state.geoJsonDataSets || !state.geoJsonDataSets.length) return;

  const selectedId = state.selectedRoadFeatureId;

  // v7.2: 色付け廃止 — 全道路を統一色で軽量描画
  // 個別 L.geoJSON を作らず FeatureCollection 一括で処理
  const features = state.geoJsonDataSets.filter(f => {
    const t = f?.geometry?.type;
    return t === 'LineString' || t === 'MultiLineString';
  });
  if (!features.length) return;

  // 選択中の道路だけ別レイヤーで強調
  const selected = selectedId ? features.filter(f => featureIdOf(f) === selectedId) : [];
  const normal = selectedId ? features.filter(f => featureIdOf(f) !== selectedId) : features;

  // 一括レイヤー: 統一色・統一太さ
  if (normal.length) {
    const fc = { type: 'FeatureCollection', features: normal };
    L.geoJSON(fc, {
      style: {
        color: ROAD_COLOR,
        weight: 2.5,
        opacity: 0.7,
        lineCap: 'round',
        lineJoin: 'round'
      },
      onEachFeature: (feature, layer) => {
        const tags = feature?.properties?.tags || feature?.properties || {};
        const name = tags.name || tags['name:ja'] || '';
        const hwType = tags.highway || '';
        if (name || hwType) {
          layer.bindTooltip([name, hwType].filter(Boolean).join(' / '), { sticky: true, direction: 'top', opacity: 0.85 });
        }
        layer.on('click', (ev) => {
          L.DomEvent.stopPropagation(ev);
          if (store.getState().isWidthEditMode) {
            const fid = featureIdOf(feature);
            store.setSelectedRoadFeatureId(fid);
            openWidthEditor(feature, ev.latlng);
            setWidthEditEnabled(true);
          }
        });
      }
    }).addTo(lg);
  }

  // 選択中道路
  if (selected.length) {
    L.geoJSON({ type: 'FeatureCollection', features: selected }, {
      style: {
        color: ROAD_SELECTED,
        weight: 4,
        opacity: 0.88,
        lineCap: 'round',
        lineJoin: 'round'
      }
    }).addTo(lg);
  }
}

/* zoom rerender removed in v7.2 — uniform road weight, no need to redraw */
function setupZoomRerender() { /* no-op */ }

function renderSidewalks(state) {
  const lg = ensureLayer('sidewalks');
  lg.clearLayers();
  if (!state.sidewalkGeoJSON || !state.sidewalkGeoJSON.length) return;

  // v7.2: 一括レイヤーで高速化
  const features = state.sidewalkGeoJSON.filter(f => f?.geometry);
  if (!features.length) return;
  L.geoJSON({ type: 'FeatureCollection', features }, {
    style: {
      color: SIDEWALK_COLOR,
      weight: 1.5,
      opacity: 0.55,
      dashArray: '4 6'
    }
  }).addTo(lg);
}

function renderBuildings(state) {
  const lg = ensureLayer('buildings');
  lg.clearLayers();
  const buildings = state.buildingsGeoJSON || [];
  if (buildings.length > 0) {
    L.geoJSON({ type: 'FeatureCollection', features: buildings }, {
      style: {
        color: '#f87171', // 輪郭を赤色に
        weight: 1.5,
        opacity: 0.8,
        fillColor: '#fca5a5', // 塗りつぶしは薄い赤
        fillOpacity: 0.2
      },
      interactive: false
    }).addTo(lg);
  }
}

function renderObstacles(state) {
  const lg = ensureLayer('obstacles');
  lg.clearLayers();

  const deny = state?.maskEdits?.deny;
  if (Array.isArray(deny)) {
    deny.forEach(feature => {
      if (!feature?.geometry) return;
      L.geoJSON(feature, {
        style: {
          color: '#f472b6',
          fillColor: '#f472b6',
          fillOpacity: 0.25,
          weight: 2,
          opacity: 0.8
        }
      }).addTo(lg);
    });
  }

  const allow = state?.maskEdits?.allow;
  if (Array.isArray(allow)) {
    allow.forEach(feature => {
      if (!feature?.geometry) return;
      L.geoJSON(feature, {
        style: {
          color: ACCENT,
          fillColor: ACCENT,
          fillOpacity: 0.15,
          weight: 2,
          opacity: 0.6
        }
      }).addTo(lg);
    });
  }
}

// --- Public API ---

export function getViewBounds() {
  if (!map) return null;
  const b = map.getBounds();
  return {
    west: b.getWest(),
    south: b.getSouth(),
    east: b.getEast(),
    north: b.getNorth()
  };
}

export function distanceMeters(a, b) {
  if (!a || !b) return 0;
  try {
    return turf.distance(
      turf.point([a.lng, a.lat]),
      turf.point([b.lng, b.lat]),
      { units: 'meters' }
    );
  } catch (e) {
    return 0;
  }
}

export function setManualAddMode(enabled) {
  manualAddEnabled = !!enabled;
  const btn = document.getElementById('toggleManualEndpointMode');
  if (btn) btn.classList.toggle('active', manualAddEnabled);
}

export function setObstacleAddMode(enabled) {
  obstacleAddEnabled = !!enabled;
  if (obstacleAddEnabled) setObstaclePolygonDrawMode(false);
}

export function setObstaclePolygonDrawMode(enabled) {
  obstaclePolygonDrawEnabled = !!enabled;
  const btn = document.getElementById('toggleObstaclePolygonMode');
  if (btn) btn.classList.toggle('active', obstaclePolygonDrawEnabled);
  if (!map) return;
  if (activeObstaclePolygonDrawer && typeof activeObstaclePolygonDrawer.disable === 'function') {
    try { activeObstaclePolygonDrawer.disable(); } catch (_err) { }
    activeObstaclePolygonDrawer = null;
  }
  if (!obstaclePolygonDrawEnabled) return;
  obstacleAddEnabled = false;
  const circleBtn = document.getElementById('toggleObstacleMode');
  if (circleBtn) circleBtn.classList.remove('active');
  if (!L.Draw?.Polygon) {
    toast('Leaflet.Drawが読み込まれていないため、ポリゴン障害物を描画できません。');
    obstaclePolygonDrawEnabled = false;
    if (btn) btn.classList.remove('active');
    return;
  }
  activeObstaclePolygonDrawer = new L.Draw.Polygon(map, {
    allowIntersection: false,
    showArea: true,
    shapeOptions: {
      color: '#f472b6',
      fillColor: '#f472b6',
      fillOpacity: 0.2,
      weight: 2
    }
  });
  activeObstaclePolygonDrawer.enable();
}

export function setWaypointInsertMode(enabled) {
  waypointInsertMode = !!enabled;
  const btn = document.getElementById('addWaypoint');
  if (btn) btn.classList.toggle('active', waypointInsertMode);
}

export function setObstacleDefaults({ radiusMeters, heightMeters } = {}) {
  if (Number.isFinite(radiusMeters)) obstacleRadiusMeters = radiusMeters;
  if (Number.isFinite(heightMeters)) obstacleHeightMeters = heightMeters;
}

export function getMapInstance() {
  return map;
}

export function setSearchMarker(lat, lng, label) {
  const lg = ensureLayer('search');
  lg.clearLayers();
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

  const marker = L.marker([lat, lng]);
  if (label) {
    marker.bindPopup(label);
    setTimeout(() => { try { marker.openPopup(); } catch (e) { } }, 300);
  }
  lg.addLayer(marker);
}

export async function loadRoadsForView() {
  if (!map) return;
  let useBounds = getViewBounds();
  if (!useBounds) return;

  const diagM = distanceMeters(
    { lat: useBounds.south, lng: useBounds.west },
    { lat: useBounds.north, lng: useBounds.east }
  );
  if (diagM > 5000) {
    const center = map.getCenter();
    const r = 0.008;
    useBounds = {
      west: center.lng - r,
      south: center.lat - r,
      east: center.lng + r,
      north: center.lat + r
    };
    toast('表示範囲が広すぎるため、中心付近のみ取得します');
  }

  const ds = store.getState().roadDataSource || 'hybrid';
  const { roads, sidewalks } = await fetchRoadsAndSidewalks(useBounds, ds);
  store.setGeoJsonDataSets(roads?.features || []);
  store.setSidewalkGeoJSON(sidewalks?.features || []);
  showRoadWidths(roads?.features || [], store.getState().widthOverrides || {});

  const bldgCount = await loadBuildingsHybrid(useBounds);
  renderThreeSceneAfterDataLoad();

  const roadCount = roads?.features?.length ?? 0;
  const sidewalkCount = sidewalks?.features?.length ?? 0;
  const plateauSuffix = store.getState().plateauTileset?.url ? ' / PLATEAU ok' : ' / PLATEAU none';
  toast(`道路 ${roadCount} 本 / 歩道 ${sidewalkCount} 本 / 建物 ${bldgCount} 棟${plateauSuffix}`);
}

export async function loadRoadsForRoute(route) {
  if (!route || route.length < 2) return;
  const lats = route.map(p => p.lat);
  const lngs = route.map(p => p.lng);
  // v7.2: padding縮小 (~400m) で高速化
  const pad = 0.004;
  const bounds = {
    south: Math.min(...lats) - pad,
    north: Math.max(...lats) + pad,
    west: Math.min(...lngs) - pad,
    east: Math.max(...lngs) + pad
  };
  const ds = store.getState().roadDataSource || 'hybrid';
  const { roads, sidewalks } = await fetchRoadsAndSidewalks(bounds, ds);
  store.setGeoJsonDataSets(roads?.features || []);
  store.setSidewalkGeoJSON(sidewalks?.features || []);
  showRoadWidths(roads?.features || [], store.getState().widthOverrides || {});

  const bldgCount = await loadBuildingsHybrid(bounds);
  renderThreeSceneAfterDataLoad();

  const roadCount = roads?.features?.length ?? 0;
  const plateauSuffix = store.getState().plateauTileset?.url ? ' / PLATEAU ok' : ' / PLATEAU none';
  toast(`経路周辺: 道路 ${roadCount} 本 / 建物 ${bldgCount} 棟${plateauSuffix}`);
}

/**
 * 経路周辺を広範囲(約1km四方)で道路取得。
 * 既存データとマージし、道路幅カラーを広範囲に表示。
 */
export async function loadRoadsWideArea(route, radiusDeg = 0.003, _depth = 0) {
  if (!route || route.length < 2) return;
  const lats = route.map(p => p.lat);
  const lngs = route.map(p => p.lng);

  const PAD = 0.001; // ~110m のバッファ
  const bounds = {
    south: Math.min(...lats) - PAD,
    north: Math.max(...lats) + PAD,
    west: Math.min(...lngs) - PAD,
    east: Math.max(...lngs) + PAD
  };

  // 対角が10km超の場合はセグメント分割で読み込み（最大再帰深さ=4）
  const diagM = distanceMeters(
    { lat: bounds.south, lng: bounds.west },
    { lat: bounds.north, lng: bounds.east }
  );
  if (diagM > 10000 && _depth < 4) {
    const segCount = Math.ceil(diagM / 8000);
    const segSize = Math.max(2, Math.ceil(route.length / segCount));
    for (let i = 0; i < route.length - 1; i += segSize) {
      const seg = route.slice(i, Math.min(i + segSize + 1, route.length));
      if (seg.length >= 2) {
        await loadRoadsWideArea(seg, PAD, _depth + 1);
      }
    }
    return;
  }

  const ds = store.getState().roadDataSource || 'hybrid';
  const { roads, sidewalks } = await fetchRoadsAndSidewalks(bounds, ds);
  const newFeatures = roads?.features || [];

  // 既存データとマージ（IDで重複除去）
  const existing = store.getState().geoJsonDataSets || [];
  const existingIds = new Set(existing.map(f => featureIdOf(f)).filter(Boolean));
  const merged = [...existing];
  let added = 0;
  for (const f of newFeatures) {
    const fid = featureIdOf(f);
    if (!fid || !existingIds.has(fid)) {
      merged.push(f);
      if (fid) existingIds.add(fid);
      added++;
    }
  }
  store.setGeoJsonDataSets(merged);
  showRoadWidths(merged, store.getState().widthOverrides || {});
  if (sidewalks?.features?.length) {
    const existingSw = store.getState().sidewalkGeoJSON || [];
    store.setSidewalkGeoJSON([...existingSw, ...(sidewalks.features || [])]);
  }

  // 建物データのマージ取得（OSM広域 + PLATEAU ハイブリッド、既存と重複除去マージ）
  try {
    const { fetchBuildings } = await import('../api/overpass.js');
    const bldgFc = await fetchBuildings(bounds);
    let incoming = bldgFc?.features || [];
    const plateauUrl = getPlateauUrlFromUi();
    if (plateauUrl) {
      try {
        const { fetchPlateauBuildings, mergeFeaturesById } = await import('../api/plateau.js');
        const pla = await fetchPlateauBuildings(plateauUrl);
        incoming = mergeFeaturesById(pla, incoming); // PLATEAU 優先
      } catch (e) {
        console.warn('[buildings] PLATEAU広域取得失敗（OSMのみ）:', e?.message || e);
      }
    }
    if (incoming.length) {
      const existingBldgs = store.getState().buildingsGeoJSON || [];
      const existingBldgIds = new Set(existingBldgs.map(f => f.id || featureIdOf(f)).filter(Boolean));
      const mergedBldgs = [...existingBldgs];
      for (const f of incoming) {
        const id = f.id || featureIdOf(f);
        if (!id || !existingBldgIds.has(id)) {
          mergedBldgs.push(f);
          if (id) existingBldgIds.add(id);
        }
      }
      store.setBuildingsGeoJSON(mergedBldgs);
    }
  } catch(e) {
    console.warn('建物データの広域取得に失敗:', e);
  }

  await resolvePlateauTilesetForBoundsToStore(bounds);
  renderThreeSceneAfterDataLoad();
  const plateauSuffix = store.getState().plateauTileset?.url ? ' / PLATEAU ok' : ' / PLATEAU none';
  toast(`広域道路取得: +${added}本 (合計 ${merged.length}本) / 建物情報${plateauSuffix}`);
}

export function focusTo(lat, lng, zoom = 17) {
  if (!map) {
    console.error('[map2d] focusTo: map not initialized');
    return;
  }
  try { map.invalidateSize(); } catch (e) {}
  try {
    map.setView([lat, lng], zoom, { animate: true, duration: 0.8 });
  } catch (e) {
    console.error('[map2d] focusTo: setView failed', e);
    try { map.setView([lat, lng], zoom); } catch (_) {}
  }
}

export function focusToRoute(simRoute) {
  if (!map || !simRoute || simRoute.length < 2) return;
  const bounds = L.latLngBounds(simRoute.map(p => [p.lat, p.lng]));
  map.fitBounds(bounds, { padding: [40, 40], maxZoom: 18 });
}

// バッチスクショ用: ルートの後半（ゴール付近）にズームイン
export function focusToGoalArea(simRoute, maxZoom = 19) {
  if (!map || !simRoute || simRoute.length < 2) return;
  const n = simRoute.length;
  const startIdx = Math.max(0, Math.floor(n * 0.88));
  const slice = simRoute.slice(startIdx);
  if (slice.length < 2) {
    map.setView([simRoute[n - 1].lat, simRoute[n - 1].lng], maxZoom);
    return;
  }
  const bounds = L.latLngBounds(slice.map(p => [p.lat, p.lng]));
  map.fitBounds(bounds, { padding: [20, 20], maxZoom });
}

export function showSweep(geo, outline) {
  const lg = ensureLayer('sweep');
  lg.clearLayers();

  // ユーザーの要望により、薄いスカイブルーの塗りつぶし（軌跡全体フットプリント）は表示しない
}

/**
 * sim.html スタイルのトラック4隅軌跡を描画する。
 * trajectoriesGeo: generateSweepPolygon が返す FeatureCollection
 *   features[0] fl線, [1] fr線: シアン (#22d3ee)
 *   features[2] rl線, [3] rr線: レッド (#ef4444)
 *   features[4+]  ラダー線     : スレート
 * overflowGeo: はみ出し領域があれば、その中のセグメントを赤で上書き表示。
 */
export function showTrajectory(trajectoriesGeo, overflowGeo) {
  const lg = ensureLayer('sweep');

  if (!trajectoriesGeo?.features?.length) return;

  const FRONT_COLOR  = '#22d3ee';  // sim.html の cyan (前2線)
  const REAR_COLOR   = '#ef4444';  // sim.html の red  (後2線)
  const LADDER_COLOR = '#475569';  // ラダー線
  const OUT_COLOR    = '#ff2020';  // はみ出し部分

  trajectoriesGeo.features.forEach((f, idx) => {
    if (!f?.geometry?.coordinates?.length) return;
    const coords = f.geometry.coordinates;
    const prop = f.properties || {};
    const isLadder = idx >= 4;

    let baseColor;
    if (isLadder) baseColor = LADDER_COLOR;
    else if (idx <= 1) baseColor = FRONT_COLOR;
    else baseColor = REAR_COLOR;

    const strokeColor = prop.stroke || baseColor;
    const weight = prop.weight ?? (isLadder ? 0.8 : 1.5);

    if (!overflowGeo || isLadder) {
      // ラダー線 or オーバーフロー情報なし: 単色で高速描画
      L.geoJSON(f, {
        style: {
          color: strokeColor,
          weight,
          opacity: isLadder ? 0.3 : 0.88,
          fillOpacity: 0,
          lineCap: 'round',
          lineJoin: 'round'
        }
      }).addTo(lg);
      return;
    }

    // オーバーフロー領域がある場合: セグメント単位で色分け
    // パフォーマンスのため連続する同色セグメントをまとめる
    const flush = (isOut, pts) => {
      if (pts.length < 2) return;
      L.polyline(pts.map(c => [c[1], c[0]]), {
        color: isOut ? OUT_COLOR : strokeColor,
        weight,
        opacity: 0.9,
        lineCap: 'round',
        lineJoin: 'round'
      }).addTo(lg);
    };

    let curIsOut = false;
    let curPts = [coords[0]];
    try {
      curIsOut = turf.booleanPointInPolygon(turf.point(coords[0]), overflowGeo);
    } catch (_) { }

    for (let i = 1; i < coords.length; i++) {
      let segOut = false;
      try {
        const mid = [(coords[i][0] + coords[i - 1][0]) / 2, (coords[i][1] + coords[i - 1][1]) / 2];
        segOut = turf.booleanPointInPolygon(turf.point(mid), overflowGeo);
      } catch (_) { }

      if (segOut !== curIsOut) {
        curPts.push(coords[i]);
        flush(curIsOut, curPts);
        curPts = [coords[i]];
        curIsOut = segOut;
      } else {
        curPts.push(coords[i]);
      }
    }
    flush(curIsOut, curPts);
  });
}

export function showFeasibilityLayers({ roadUnion, intersect, overflow, contactPoints } = {}) {
  const lg = ensureLayer('feasibility');
  lg.clearLayers();

  if (roadUnion) {
    L.geoJSON(roadUnion, {
      style: { color: '#475569', fillColor: '#475569', fillOpacity: 0.18, weight: 0.5, opacity: 0.4 }
    }).addTo(lg);
  }
  if (intersect) {
    L.geoJSON(intersect, {
      style: { color: FEAS_OK, fillColor: FEAS_OK, fillOpacity: 0.25, weight: 0.5, opacity: 0.5 }
    }).addTo(lg);
  }
  if (overflow) {
    L.geoJSON(overflow, {
      style: { color: FEAS_DANGER, fillColor: FEAS_DANGER, fillOpacity: 0.35, weight: 1.5, opacity: 0.8 }
    }).addTo(lg);
  }

  // コンタクトポイント: 点々ではなくシームレスなポリラインで表示
  if (contactPoints) {
    let items = [];
    if (contactPoints.type === 'FeatureCollection' && Array.isArray(contactPoints.features)) {
      items = contactPoints.features.map(f => {
        const coords = f?.geometry?.coordinates;
        if (!coords || coords.length < 2) return null;
        return {
          lat: coords[1], lng: coords[0],
          isDanger: (f.properties?.reason || '') !== 'road',
          reason: f.properties?.reason || 'unknown'
        };
      }).filter(Boolean);
    } else if (Array.isArray(contactPoints)) {
      items = contactPoints;
    }
    if (items.length < 2) return;

    // 衝突ポイントをセグメント化して連続ラインに
    const dangerPts = items.filter(p => p && Number.isFinite(p.lat) && Number.isFinite(p.lng));
    if (dangerPts.length >= 2) {
      // 連続する衝突セグメントをグループ化
      const segments = [];
      let curSeg = [dangerPts[0]];
      for (let i = 1; i < dangerPts.length; i++) {
        const prev = dangerPts[i - 1];
        const cur = dangerPts[i];
        const dist = Math.sqrt(
          Math.pow((cur.lat - prev.lat) * 111320, 2) +
          Math.pow((cur.lng - prev.lng) * 111320 * Math.cos(cur.lat * Math.PI / 180), 2)
        );
        if (dist < 15) { // 15m以内なら同一セグメント
          curSeg.push(cur);
        } else {
          if (curSeg.length >= 2) segments.push(curSeg);
          curSeg = [cur];
        }
      }
      if (curSeg.length >= 2) segments.push(curSeg);

      // 各セグメントをシームレスなポリラインで描画
      segments.forEach(seg => {
        const latlngs = seg.map(p => [p.lat, p.lng]);
        const hasDanger = seg.some(p => p.isDanger !== false);
        const color = hasDanger ? FEAS_DANGER : '#fb923c';
        // 太い半透明ライン (グロー)
        L.polyline(latlngs, {
          color, weight: 14, opacity: 0.25, lineCap: 'round', lineJoin: 'round'
        }).addTo(lg);
        // メインライン
        L.polyline(latlngs, {
          color, weight: 5, opacity: 0.75, lineCap: 'round', lineJoin: 'round'
        }).addTo(lg);
      });
    }

    // 代表マーカー: 各セグメントの中央にだけ配置 (SV連動用)
    const representativePoints = [];
    const stride = Math.max(1, Math.floor(dangerPts.length / 12));
    for (let i = 0; i < dangerPts.length; i += stride) {
      representativePoints.push(dangerPts[i]);
    }
    representativePoints.forEach(p => {
      const marker = L.circleMarker([p.lat, p.lng], {
        radius: 5,
        fillColor: p.isDanger !== false ? FEAS_DANGER : '#fb923c',
        fillOpacity: 0.6,
        color: 'transparent',
        weight: 0,
        interactive: true,
        bubblingMouseEvents: false
      }).addTo(lg);
      marker.bindTooltip(
        p.reason === 'road' ? '⚠ 道路はみ出し (クリックでSV)' : '⛔ 障害物衝突 (クリックでSV)',
        { direction: 'top', offset: [0, -6] }
      );
      marker.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        showStreetViewAt(p.lat, p.lng, 0);
      });
    });
  }
}

function regulationSeverityLabel(severity) {
  if (severity === 'block') return '不可';
  if (severity === 'permit_required') return '要許可';
  if (severity === 'warning') return '注意';
  if (severity === 'unknown') return '要確認';
  return '情報';
}

function regulationTypeLabel(type) {
  if (type === 'oneway') return '一方通行';
  if (type === 'access') return '通行権限';
  if (type === 'no_truck') return '貨物車規制';
  if (type === 'max_height') return '高さ制限';
  if (type === 'max_width') return '幅制限';
  if (type === 'max_weight') return '重量制限';
  if (type === 'time_restriction') return '時間帯規制';
  return type || '規制';
}

export function showRegulationIssues(regulationAssessment = null) {
  const lg = ensureLayer('regulations');
  lg.clearLayers();
  const issues = Array.isArray(regulationAssessment?.issues) ? regulationAssessment.issues : [];
  issues.forEach((issue) => {
    const lat = Number(issue?.latLng?.lat);
    const lng = Number(issue?.latLng?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    const severity = issue.severity || 'info';
    const color = REGULATION_COLORS[severity] || REGULATION_COLORS.info;
    const marker = L.circleMarker([lat, lng], {
      radius: severity === 'block' ? 7 : 6,
      fillColor: color,
      fillOpacity: 0.72,
      color: '#0f172a',
      opacity: 0.9,
      weight: 1.5,
      interactive: true,
      bubblingMouseEvents: false
    }).addTo(lg);
    const at = Number.isFinite(issue.atM) ? `${(issue.atM / 1000).toFixed(2)}km` : '位置不明';
    marker.bindTooltip(
      `${regulationSeverityLabel(severity)} / ${regulationTypeLabel(issue.type)} / ${issue.reasonCode || issue.message || ''} / ${at}`,
      { direction: 'top', offset: [0, -8], sticky: true }
    );
  });
}

export function showRoadWidths(geoJsonDataSets, widthOverrides = {}) {
  const lg = ensureLayer('roadWidths');
  lg.clearLayers();
  // geoJsonDataSets は Feature の配列 (FeatureCollectionではない)
  const features = Array.isArray(geoJsonDataSets) ? geoJsonDataSets : [];
  if (!features.length) return;

  function getWidth(feature) {
    // 表示=判定: 判定が実際に使う有効幅（roadWidthModel の保守的融合 + applyWidthRisk）。
    // 手動上書き（userOverrideWidth・信頼度1.0）/ YOLO width_ai / OSM / GSI / lanes /
    // highway 既定フォールバックまで、judgment と同一ロジックで一本化する。
    // widthOverrides マップは saveOverrides→features 反映前の即時表示のための先読み。
    const fid = feature.id != null ? String(feature.id)
      : feature.properties?.id != null ? String(feature.properties.id) : null;
    let featureForEstimate = feature;
    if (fid && widthOverrides[fid] != null) {
      const override = Number(widthOverrides[fid]);
      if (Number.isFinite(override)) {
        const props = feature?.properties && typeof feature.properties === 'object' ? feature.properties : {};
        if (props.tags && typeof props.tags === 'object') {
          featureForEstimate = {
            ...feature,
            properties: { ...props, tags: { ...props.tags, userOverrideWidth: override } }
          };
        } else {
          featureForEstimate = {
            ...feature,
            properties: { ...props, userOverrideWidth: override }
          };
        }
      }
    }

    const est = estimateEffectiveRoadWidth(featureForEstimate, { defaultRoadWidth: 6 });
    return Number.isFinite(est?.value) && est.value > 0 ? est.value : null;
  }

  for (const f of features) {
    if (!f?.geometry) continue;
    const geom = f.geometry;
    if (geom.type !== 'LineString' && geom.type !== 'MultiLineString') continue;

    const w = getWidth(f);
    const halfW = (w != null && w > 0) ? w / 2 : null;
    const label = w != null ? `${w.toFixed(1)}m` : '幅不明';

    const lines = geom.type === 'LineString' ? [geom.coordinates] : geom.coordinates;
    for (const coords of lines) {
      if (!coords || coords.length < 2) continue;

      if (halfW != null) {
        // 道路幅をバッファポリゴンで描画 (turf.buffer)
        try {
          const lineFeature = turf.lineString(coords);
          const buffered = turf.buffer(lineFeature, halfW, { units: 'meters' });
          if (buffered?.geometry) {
            L.geoJSON(buffered, {
              style: {
                color: '#0ea5e9',
                weight: 1.5,
                opacity: 0.7,
                fillOpacity: 0
              }
            }).addTo(lg).bindTooltip(`道路幅: ${label}`, { sticky: true, direction: 'top' });
          }
        } catch (_) {
          // バッファ失敗時は細い中心線にフォールバック
          const latlngs = coords.map(c => [c[1], c[0]]);
          L.polyline(latlngs, { color: '#0ea5e9', weight: 3, opacity: 0.7, dashArray: '6 3' })
            .addTo(lg).bindTooltip(`道路幅: ${label}`, { sticky: true, direction: 'top' });
        }
      } else {
        // 幅不明: 破線の中心線のみ
        const latlngs = coords.map(c => [c[1], c[0]]);
        L.polyline(latlngs, { color: '#94a3b8', weight: 1.5, opacity: 0.5, dashArray: '4 4' })
          .addTo(lg).bindTooltip(`道路幅: ${label}`, { sticky: true, direction: 'top' });
      }
    }
  }
}

export function clearRoadWidthLayer() {
  ensureLayer('roadWidths').clearLayers();
}

export function clearRegulationLayer() {
  ensureLayer('regulations').clearLayers();
}

export function clearSweepLayers() {
  ensureLayer('sweep').clearLayers();
}

export function clearFeasibilityLayers() {
  ensureLayer('feasibility').clearLayers();
}

export function wipeAllLayers() {
  LAYER_NAMES.forEach(name => {
    if (layers[name]) layers[name].clearLayers();
  });
}

function findNearestRoad(lat, lng, features, maxDistMeters = 50) {
  if (!features || !features.length) return null;
  const clickPt = turf.point([lng, lat]);
  let best = null;
  let bestDist = Infinity;

  for (const f of features) {
    const g = f?.geometry;
    if (!g) continue;
    if (g.type !== 'LineString' && g.type !== 'MultiLineString') continue;
    try {
      const d = turf.pointToLineDistance(clickPt, f, { units: 'meters' });
      if (d < bestDist) {
        bestDist = d;
        best = f;
      }
    } catch (e) { }
  }

  if (!best || bestDist > maxDistMeters) return null;
  return { feature: best, dist: bestDist };
}

/**
 * バッチシミュレータ用: (lat, lng) を受け取り、stateのgeoJsonDataSetsから
 * 最寄り道路上の座標 {lat, lng} を返す。道路が見つからなければ null。
 */
export function findNearestRoadCoord(lat, lng, maxDistMeters = 50) {
  const state = store.getState();
  const nearest = findNearestRoad(lat, lng, state.geoJsonDataSets, maxDistMeters);
  if (!nearest) return null;
  try {
    const pt = turf.point([lng, lat]);
    const snapped = turf.nearestPointOnLine(nearest.feature, pt, { units: 'meters' });
    return { lat: snapped.geometry.coordinates[1], lng: snapped.geometry.coordinates[0] };
  } catch (e) {
    return null;
  }
}
