import { DEFAULT_VEHICLE_PRESET, RUNTIME_CONFIG, VEHICLE_PRESETS } from './config.js';
import { store } from './state.js';
import { geocodeSearch } from './api/nominatim.js';
import { chibanToAddress } from './api/zenrinChiban.js';
import { fetchOsrmRoute } from './api/osrm.js';
import { initMap2D, focusToRoute, getMapInstance, setSearchMarker, focusTo } from './ui/map2d.js';
import {
  initThree3D,
  openThree3D,
  renderSceneThree,
  playThree3D,
  stopThree3D,
  resizeThree3D,
  getRoadSurfaceMetrics,
  getCollisionSolidMetrics,
  getAutonomyDriveMetrics,
  getSafetyMonitorMetrics,
  getPlateauTilesMetrics,
  getThreeRoadLayerVisibility,
  setThreeRoadLayerVisible,
  setThreeRoadSurfaceAlpha,
  setThreeBuildingAppearance,
  setThreePlateauOpacity,
  getThreeDiagnosticLayerVisibility,
  setThreeDiagnosticLayerVisible,
  setThreeDiagnosticSvPoints
} from './ui/map3dThree.js';
import { initControls } from './ui/controls.js';
import { buildLocalWorld, clampAoiRadius, thinRoute } from './3d/localWorldBuilder.js';
import { buildRoadWidthRows, summarizeRoadWidths, formatWidthSource, summarizeSourceCounts } from './3d/roadWidthReport.js';
import { applyAerialRoadSurface, clearAerialRoadSurface, exposeRoadSegDebug } from './3d/roadSegClient.js';
import { buildClearanceSolidReport, makeRouteOverheadFixture, makeRouteLateralObstacleFixture } from './3d/clearanceSolids.js';
import { buildAutonomyDriveReport } from './sim/autonomy/behaviorPlanner.js';
import {
  aggregateWidthSuggestions,
  buildPerceptionScanFromStreetViewFrames,
  buildObstacleFeatures,
  makeSyntheticPerceptionScan
} from './3d/perceptionFusion.js';
import { scanStreetView, analyzeStreetView, getStreetViewFrames } from './ui/streetviewScan.js';
import { html, unsafeHtml } from './utils/html.js';

const DEFAULT_START = '東京駅';
const DEFAULT_GOAL = '丸の内仲通り';
const DEMO_ENDPOINTS = [
  { lat: 35.680700, lng: 139.764600, name: '丸の内仲通り 北側' },
  { lat: 35.679900, lng: 139.764200, name: '丸の内仲通り 南側' }
];

const state = {
  routeLoaded: false,
  worldLoaded: false,
  loadingWorld: false,
  lastWorldMetrics: null,
  lastRouteMeta: null,
  lastSolidReport: null,
  lastAutonomyReport: null,
  lastPerceptionReport: null,
  perceptionObstacleIds: [],
  perceptionWidthRoadIds: [],
  lastEndpointSignature: '',
  worldAbortController: null,
  autoPerceptionRunning: false,
  autoPerceptionQueued: null,
  autoPerceptionGeneration: 0,
  lastAutoPerceptionSignature: ''
};

function byId(id) {
  return document.getElementById(id);
}

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setText(id, value) {
  const el = byId(id);
  if (el) el.textContent = value;
}

function setStatus(value) {
  setText('index3dStatus', value);
}

function logLine(value) {
  const el = byId('index3dLog');
  if (!el) return;
  const line = document.createElement('div');
  line.textContent = `[${new Date().toLocaleTimeString()}] ${value}`;
  el.prepend(line);
  while (el.children.length > 30) el.removeChild(el.lastChild);
}

function toast(msg) {
  const box = byId('toast');
  if (!box) return;
  const div = document.createElement('div');
  div.className = 'toast-item';
  div.textContent = msg;
  box.appendChild(div);
  setTimeout(() => div.remove(), 2600);
}

function formatMeters(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '-';
  if (n >= 1000) return `${(n / 1000).toFixed(2)}km`;
  return `${Math.round(n)}m`;
}

function distanceMeters(a, b) {
  const lat1 = Number(a?.lat) * Math.PI / 180;
  const lat2 = Number(b?.lat) * Math.PI / 180;
  const dLat = lat2 - lat1;
  const dLng = (Number(b?.lng) - Number(a?.lng)) * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function buildDirectRouteResult(points, samplesPerSegment = 24) {
  if (!Array.isArray(points) || points.length < 2) return null;
  const coordinates = [];
  let distance = 0;
  for (let s = 0; s < points.length - 1; s++) {
    const a = points[s];
    const b = points[s + 1];
    distance += distanceMeters(a, b);
    const steps = Math.max(2, samplesPerSegment);
    for (let i = 0; i <= steps; i++) {
      if (s > 0 && i === 0) continue;
      const t = i / steps;
      coordinates.push({
        lat: Number(a.lat) + (Number(b.lat) - Number(a.lat)) * t,
        lng: Number(a.lng) + (Number(b.lng) - Number(a.lng)) * t
      });
    }
  }
  return {
    coordinates,
    distance,
    duration: distance / 6.0,
    raw: { fallback: 'direct' }
  };
}

function getGoogleKey() {
  return String(RUNTIME_CONFIG.googleMapsApiKey || window.USER_CONFIG?.googleMapsApiKey || '').trim();
}

function updateMetrics() {
  const st = store.getState();
  const endpointSig = endpointSignature(st.selectedEndpoints || []);
  if (endpointSig !== state.lastEndpointSignature) {
    state.lastEndpointSignature = endpointSig;
    if (state.routeLoaded || state.worldLoaded) {
      state.routeLoaded = false;
      state.worldLoaded = false;
      state.lastWorldMetrics = null;
      state.lastSolidReport = null;
      state.lastAutonomyReport = null;
      state.lastPerceptionReport = null;
      state.perceptionObstacleIds = [];
      state.perceptionWidthRoadIds = [];
    }
  }
  const metrics = state.lastWorldMetrics || {};
  setText('metricRoutePoints', String(st.simRoute?.length || 0));
  setText('metricRoads', String(metrics.roadFeatures ?? st.geoJsonDataSets?.length ?? 0));
  setText('metricBuildings', String(metrics.buildingFeatures ?? st.buildingsGeoJSON?.length ?? 0));
  setText('metricAoi', metrics.boundsAreaHa != null ? `${metrics.boundsAreaHa}ha` : '-');
  setText('metricDistance', state.lastRouteMeta?.distance != null ? formatMeters(state.lastRouteMeta.distance) : '-');
  setText('metricContacts', byId('map3dCollisionCount')?.textContent || '0');

  window.index3DStats = {
    ready: !!window.index3DReady,
    routePoints: st.simRoute?.length || 0,
    roadFeatures: st.geoJsonDataSets?.length || 0,
    buildingFeatures: st.buildingsGeoJSON?.length || 0,
    worldLoaded: state.worldLoaded,
    worldLoading: state.loadingWorld,
    routeLoaded: state.routeLoaded,
    phase3: state.lastSolidReport?.summary || null,
    phase4: state.lastAutonomyReport?.summary || getAutonomyDriveMetrics() || null,
    safety: getSafetyMonitorMetrics(),
    phase5: state.lastPerceptionReport?.summary || null,
    plateau: getPlateauTilesMetrics(),
    mapBase: window.index3DMapBase || null,
    metrics
  };
  updateRouteGuide(st);
  updateActionAvailability();
  updateResultPill();
  if (state.worldLoaded) {
    renderSolidPanel();
    renderAutonomyPanel();
    renderPerceptionPanel();
  }
}

// 詳細(diag-open) トグルの表示同期。
function syncDiagToggle() {
  const btn = byId('diagToggle');
  if (!btn) return;
  const open = document.body.classList.contains('diag-open');
  btn.setAttribute('aria-pressed', String(open));
  btn.textContent = open ? '詳細 ▴' : '詳細 ▾';
}

// 通常時に見せる唯一の結論サマリー。
// 接触ありへ遷移したら診断パネルを自動で開く（隠した詳細が必要になる瞬間）。
let _lastResultState = null;
function updateResultPill() {
  const pill = byId('resultPill');
  if (!pill) return;
  const contacts = Number(byId('map3dCollisionCount')?.textContent || '0') || 0;
  let stateName = 'idle';
  let label = '経路を設定';
  if (state.worldLoaded) {
    if (contacts > 0) {
      stateName = 'blocked';
      label = `要確認・接触 ${contacts}件`;
    } else {
      stateName = 'ready';
      label = '準備完了・接触なし';
    }
  } else if (state.routeLoaded) {
    stateName = 'warn';
    label = '3Dワールド未読込';
  }
  pill.dataset.state = stateName;
  setText('resultPillText', label);
  if (stateName === 'blocked' && _lastResultState !== 'blocked') {
    document.body.classList.add('diag-open');
    syncDiagToggle();
  }
  _lastResultState = stateName;
}

// Map detail プリセット: 個別トグル17個を一括設定（プリセット=ショートカット、
// 個別トグルは Advanced layers に温存）。各 input の change を発火して既存配線を通す。
const MAP_DETAIL_PRESETS = {
  basic: { road: ['roadSurface', 'route', 'building', 'sweptArea', 'truckTrail'], diag: [] },
  standard: {
    road: ['roadSurface', 'centerline', 'roadEdge', 'route',
      'onewayArrow', 'building', 'sweptArea', 'truckTrail'],
    diag: []
  },
  debug: { road: 'all', diag: 'all' }
};
function applyMapDetailPreset(level) {
  const preset = MAP_DETAIL_PRESETS[level] || MAP_DETAIL_PRESETS.standard;
  document.querySelectorAll('.three-road-layer[data-three-layer]').forEach((input) => {
    const tag = input.dataset.threeLayer;
    const want = preset.road === 'all' ? true : preset.road.includes(tag);
    if (input.checked !== want) {
      input.checked = want;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  document.querySelectorAll('.three-diag-layer[data-three-diag]').forEach((input) => {
    const tag = input.dataset.threeDiag;
    const want = preset.diag === 'all' ? true : preset.diag.includes(tag);
    if (input.checked !== want) {
      input.checked = want;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
}

function updateActionAvailability() {
  const ready = !!state.worldLoaded;
  for (const id of ['perceptionRun', 'perceptionRealRun', 'perceptionClear', 'roadSegSurfaceApply', 'roadSegSurfaceClear']) {
    const btn = byId(id);
    if (!btn) continue;
    btn.disabled = !ready;
    btn.title = ready ? '' : '先に経路を確定し、3Dワールドを読み込んでください。'
  }
}

function initThreeRoadLayerControls() {
  const alphaInput = byId('roadSurfaceAlpha');
  const alphaValue = byId('roadSurfaceAlphaValue');
  const renderAlpha = (value) => {
    const applied = setThreeRoadSurfaceAlpha(value);
    if (alphaInput && String(alphaInput.value) !== String(applied)) alphaInput.value = applied.toFixed(2);
    if (alphaValue) alphaValue.textContent = applied.toFixed(2);
  };
  if (alphaInput) {
    renderAlpha(alphaInput.value || 0.10);
    alphaInput.addEventListener('input', () => renderAlpha(alphaInput.value));
  }

  const visibility = getThreeRoadLayerVisibility();
  document.querySelectorAll('.three-road-layer[data-three-layer]').forEach((input) => {
    const tag = input.dataset.threeLayer;
    if (!tag) return;
    if (Object.prototype.hasOwnProperty.call(visibility, tag)) {
      input.checked = !!visibility[tag];
    }
    input.addEventListener('change', () => {
      setThreeRoadLayerVisible(tag, input.checked);
      logLine(`3Dレイヤー ${tag}: ${input.checked ? '表示' : '非表示'}`);
    });
  });

  // PLATEAU 高さ補正スライダー。window.PLATEAU_Y_OFFSET を毎フレーム反映するのでライブ調整可能。
  const plateauYInput = byId('plateauYOffset');
  const plateauYValue = byId('plateauYOffsetValue');
  if (plateauYInput) {
    const applyPlateauY = (raw) => {
      const v = Math.max(-15, Math.min(5, Number(raw)));
      if (!Number.isFinite(v)) return;
      window.PLATEAU_Y_OFFSET = v;
      if (plateauYValue) plateauYValue.textContent = `${v.toFixed(1)}m`;
    };
    // HTML head 等で既に値が設定されていればそれを初期表示に採用する。
    const existing = Number(window.PLATEAU_Y_OFFSET);
    if (Number.isFinite(existing)) plateauYInput.value = String(existing);
    applyPlateauY(plateauYInput.value);
    plateauYInput.addEventListener('input', () => applyPlateauY(plateauYInput.value));
  }

  if (typeof window !== 'undefined') {
    window.index3DSetThreeRoadLayerVisible = setThreeRoadLayerVisible;
    window.index3DGetThreeRoadLayerVisibility = getThreeRoadLayerVisibility;
    window.index3DSetRoadSurfaceAlpha = renderAlpha;
  }
}

// 項目5: 診断レイヤー（デバッグ用）のトグル配線。
function initThreeDiagnosticControls() {
  const visibility = getThreeDiagnosticLayerVisibility();
  document.querySelectorAll('.three-diag-layer[data-three-diag]').forEach((input) => {
    const tag = input.dataset.threeDiag;
    if (!tag) return;
    if (Object.prototype.hasOwnProperty.call(visibility, tag)) {
      input.checked = !!visibility[tag];
    }
    input.addEventListener('change', () => {
      // SV 点レイヤーは最新のスキャン結果を注入してから表示する。
      if (tag === 'diagSvPoints' && input.checked) {
        setThreeDiagnosticSvPoints(getStreetViewFrames());
      }
      setThreeDiagnosticLayerVisible(tag, input.checked);
      logLine(`3D診断 ${tag}: ${input.checked ? '表示' : '非表示'}`);
    });
  });

  if (typeof window !== 'undefined') {
    window.index3DSetDiagnosticLayerVisible = setThreeDiagnosticLayerVisible;
    window.index3DGetDiagnosticLayerVisibility = getThreeDiagnosticLayerVisibility;
    window.index3DSetDiagnosticSvPoints = setThreeDiagnosticSvPoints;
  }
}

function setRouteStep(id, { done = false, active = false, text = '' } = {}) {
  const el = byId(id);
  if (!el) return;
  el.classList.toggle('done', !!done);
  el.classList.toggle('active', !!active);
  const stateEl = el.querySelector('span');
  if (stateEl) stateEl.textContent = text;
}

function setRoutePrimary(action, label, { disabled = false } = {}) {
  const btn = byId('routeGuidePrimary');
  if (!btn) return;
  btn.dataset.routeAction = action;
  btn.textContent = label;
  btn.disabled = !!disabled;
}

function endpointSignature(endpoints = []) {
  return endpoints
    .map((p) => `${Number(p.lat).toFixed(7)},${Number(p.lng).toFixed(7)}`)
    .join('|');
}

function routeSignature(route = []) {
  return (Array.isArray(route) ? route : [])
    .map((p) => `${Number(p.lat).toFixed(7)},${Number(p.lng).toFixed(7)}`)
    .join('|');
}

function perceptionContextMatches(expectedRouteSignature, generation) {
  if (generation != null && generation !== state.autoPerceptionGeneration) return false;
  if (expectedRouteSignature && expectedRouteSignature !== routeSignature(store.getState().simRoute || [])) return false;
  return true;
}

function routeSummary(st = store.getState()) {
  const simRouteReady = (st.simRoute?.length || 0) >= 2;
  return {
    roads: st.geoJsonDataSets?.length || 0,
    endpoints: st.selectedEndpoints?.length || 0,
    routePoints: st.simRoute?.length || 0,
    simRouteReady,
    routeReady: simRouteReady && state.routeLoaded,
    worldReady: state.worldLoaded,
    worldLoading: state.loadingWorld
  };
}

function updateRouteGuide(st = store.getState()) {
  const s = routeSummary(st);
  const endpointsReady = s.endpoints >= 2;
  const roadsReady = s.roads > 0;
  const routeReady = s.routeReady;
  const worldReady = s.worldReady;
  const activeStep = !roadsReady ? 'roads' : (!endpointsReady ? 'points' : (!routeReady ? 'confirm' : (!worldReady ? 'world' : 'run')));
  const show3D = routeReady && worldReady;
  document.body?.classList?.toggle('route-mode', !show3D);
  document.body?.classList?.toggle('sim-mode', show3D);
  if (document.body) document.body.dataset.routeStep = activeStep;

  setRouteStep('routeStepRoads', {
    done: roadsReady,
    active: activeStep === 'roads',
    text: roadsReady ? `${s.roads}本` : '未読込'
  });
  setRouteStep('routeStepPoints', {
    done: endpointsReady,
    active: activeStep === 'points',
    text: `${Math.min(s.endpoints, 2)}/2`
  });
  setRouteStep('routeStepConfirm', {
    done: routeReady,
    active: activeStep === 'confirm',
    text: routeReady ? '確定済み' : (s.simRouteReady ? '候補あり' : '待機中')
  });
  setRouteStep('routeStepWorld', {
    done: worldReady,
    active: activeStep === 'world' || activeStep === 'run',
    text: worldReady ? '準備完了' : (s.worldLoading ? '読込中' : '待機中')
  });

  const manualBtn = byId('toggleManualEndpointMode');
  if (manualBtn) {
    manualBtn.textContent = manualBtn.classList.contains('active') ? '地点追加 ON' : '地点追加 OFF';
  }
  const confirmBtn = byId('confirm-route');
  if (confirmBtn) {
    confirmBtn.textContent = routeReady ? '経路確定済み' : 'この経路を確定';
    confirmBtn.disabled = !endpointsReady || routeReady;
  }
  const scope = byId('routeMapScope');
  if (scope) {
    const radius = clampAoiRadius(byId('index3dRadius')?.value);
    scope.textContent = `道路: 表示範囲 / 3D: 経路周辺 ${radius}m`;
  }

  if (!roadsReady) {
    setText('routeGuideTitle', '道路データを読み込む');
    setText('routeGuideHint', 'まず現在表示している範囲の道路を読み込みます。');
    setText('routeMapTitle', '道路データ範囲');
    setText('routeMapCaption', '道路読込後、出発地と目的地を選択します。');
    setRoutePrimary('roads', '1. 道路を読み込む');
    return;
  }

  if (!endpointsReady) {
    const next = s.endpoints <= 0 ? '出発地' : '目的地';
    setText('routeGuideTitle', `${next}を選択`);
    setText('routeGuideHint', `地図上で${next}をクリックしてください。`);
    setText('routeMapTitle', `${next}を選択`);
    setText('routeMapCaption', `地図上で${next}をクリックしてください。`);
    setRoutePrimary('points', `2. ${next}を待機中`);
    return;
  }

  if (!routeReady) {
    setText('routeGuideTitle', '経路を確定');
    setText('routeGuideHint', s.simRouteReady ? '表示中の候補経路を確定し、3Dワールド作成へ進みます。' : '選択地点から候補経路を作成します。');
    setText('routeMapTitle', '候補経路');
    setText('routeMapCaption', '出発地と目的地はまだ調整できます。');
    setRoutePrimary('confirm', '3. 経路を確定');
    return;
  }

  if (!worldReady) {
    setText('routeGuideTitle', s.worldLoading ? '3Dワールド読込中' : '3Dワールドを読み込む');
    setText('routeGuideHint', '確定した経路の周辺に3Dワールドを構築します。');
    setText('routeMapTitle', '確定済み経路');
    setText('routeMapCaption', '3Dワールドを読み込めます。');
    setRoutePrimary('world', s.worldLoading ? '4. 読込中...' : '4. 3Dワールドを読み込む', { disabled: s.worldLoading });
    return;
  }

  setText('routeGuideTitle', 'シミュレーション実行');
  setText('routeGuideHint', '3Dワールドとトラックシミュレーションの準備が完了しました。');
  setText('routeMapTitle', '3Dシミュレーション');
  setText('routeMapCaption', '3Dワールド読込済み。');
  setRoutePrimary('run', '5. 実行');
}

function flashRouteMap() {
  const section = byId('routeMapStage');
  const map = getMapInstance();
  if (section) {
    section.scrollIntoView({ behavior: 'smooth', block: 'center' });
    section.classList.add('map-attention');
    setTimeout(() => section.classList.remove('map-attention'), 1600);
  }
  if (map) setTimeout(() => map.invalidateSize(), 180);
}

function ensureEndpointMode() {
  const btn = byId('toggleManualEndpointMode');
  if (btn && !btn.classList.contains('active')) btn.click();
}

function routeFromStoreEndpoints() {
  const endpoints = store.getState().selectedEndpoints || [];
  if (endpoints.length < 2) throw new Error('地図上で出発地と目的地を選択してください。');
  return endpoints.map((p) => ({ lat: Number(p.lat), lng: Number(p.lng), name: p.label || `地点 ${p.id || ''}` }));
}

async function geocodeInput(inputId, label) {
  const value = String(byId(inputId)?.value || '').trim();
  if (!value) throw new Error(`${label}が空です。`);
  const hit = await geocodeSearch(value, { googleKey: getGoogleKey() });
  if (!hit || !Number.isFinite(hit.lat) || !Number.isFinite(hit.lng)) {
    throw new Error(`${label}が見つかりませんでした。`);
  }
  return hit;
}

function applyRoute(routeResult, endpoints, source = 'osrm') {
  const route = thinRoute(routeResult.coordinates || [], 1200);
  if (route.length < 2) throw new Error('経路点が不足しています。');

  store.setSelectedEndpoints(endpoints.map((p, idx) => ({
    id: `index3d-${idx + 1}`,
    lat: p.lat,
    lng: p.lng,
    label: p.name || `地点 ${idx + 1}`
  })));
  store.setRoutePlan({
    selectionRoute: route,
    trajectoryRoute: route,
    candidates: [],
    routeMeta: {
      source,
      displayName: source.toUpperCase(),
      distance: routeResult.distance,
      duration: routeResult.duration
    }
  });

  state.routeLoaded = true;
  state.worldLoaded = false;
  state.lastWorldMetrics = null;
  state.lastSolidReport = null;
  state.lastAutonomyReport = null;
  state.lastRouteMeta = {
    source,
    distance: routeResult.distance,
    duration: routeResult.duration
  };

  try { focusToRoute(route); } catch (e) { }
  try {
    const first = route[0];
    setSearchMarker(first.lat, first.lng, '出発地');
  } catch (e) { }

  renderSceneThree(store.getState());
  updateMetrics();
  logLine(`経路読込: ${route.length}点 / ${formatMeters(routeResult.distance)}`);
}

async function buildRouteFromPlaces({ autoWorld = true } = {}) {
  setStatus('地点を検索しています...');
  const start = await geocodeInput('index3dStart', '出発地');
  const goal = await geocodeInput('index3dGoal', '目的地');
  setStatus('OSRMで経路を作成しています...');
  const route = await fetchOsrmRoute([start, goal]);
  if (!route?.coordinates?.length) throw new Error('OSRMから経路が返りませんでした。');
  applyRoute(route, [start, goal], 'osrm');
  setStatus('経路を読み込みました。');
  toast('経路を読み込みました');
  if (autoWorld) await loadWorldForRoute();
}

async function buildRouteFromMapPoints({ autoWorld = true } = {}) {
  const endpoints = routeFromStoreEndpoints();
  setStatus('地図上の地点から経路を作成しています...');
  const route = await fetchOsrmRoute(endpoints);
  if (!route?.coordinates?.length) throw new Error('OSRMから経路が返りませんでした。');
  applyRoute(route, endpoints, 'osrm-map');
  setStatus('地図上の地点から経路を読み込みました。');
  toast('地図上の地点から経路を読み込みました');
  if (autoWorld) await loadWorldForRoute();
}

async function buildDemoRoute({ autoWorld = true } = {}) {
  setStatus('短いデモ経路を作成しています...');
  let route = null;
  let source = 'osrm-demo';
  try {
    route = await fetchOsrmRoute(DEMO_ENDPOINTS);
  } catch (e) {
    console.warn('[index3d] demo OSRM failed, using direct fallback:', e?.message || e);
  }
  if (!route?.coordinates?.length) {
    route = buildDirectRouteResult(DEMO_ENDPOINTS);
    source = 'direct-demo';
  }
  if (!route?.coordinates?.length) throw new Error('デモ経路を作成できませんでした。');
  applyRoute(route, DEMO_ENDPOINTS, source);
  setStatus('デモ経路を読み込みました。');
  toast('デモ経路を読み込みました');
  if (autoWorld) await loadWorldForRoute();
}

function startAutoPerceptionScan(routeSig, generation) {
  state.autoPerceptionRunning = true;
  logLine('自動知覚: 経路周辺をSV/YOLOでスキャン中...');
  Promise.resolve()
    .then(() => runRealPerceptionFusion({ expectedRouteSignature: routeSig, generation, auto: true }))
    .then((report) => {
      if (report?.summary?.isReal && perceptionContextMatches(routeSig, generation)) {
        state.lastAutoPerceptionSignature = routeSig;
      }
    })
    .catch((e) => console.warn('[index3D] auto perception failed:', e?.message || e))
    .finally(() => {
      state.autoPerceptionRunning = false;
      const queued = state.autoPerceptionQueued;
      state.autoPerceptionQueued = null;
      if (
        queued &&
        queued.generation === state.autoPerceptionGeneration &&
        perceptionContextMatches(queued.routeSignature, queued.generation)
      ) {
        startAutoPerceptionScan(queued.routeSignature, queued.generation);
      }
    });
}

function scheduleAutoPerceptionScan() {
  if (typeof window !== 'undefined' && window.INDEX3D_AUTO_PERCEPTION === false) return;
  const routeSig = routeSignature(store.getState().simRoute || []);
  if (!routeSig) return;
  if (state.lastAutoPerceptionSignature === routeSig && state.lastPerceptionReport?.summary?.isReal) {
    logLine('自動知覚: 現在の経路には既にSV/YOLO結果があるためスキップしました。');
    return;
  }
  const generation = ++state.autoPerceptionGeneration;
  if (state.autoPerceptionRunning) {
    state.autoPerceptionQueued = { routeSignature: routeSig, generation };
    logLine('自動知覚: 現在のスキャン後に最新経路を処理します。');
    return;
  }
  startAutoPerceptionScan(routeSig, generation);
}

async function loadWorldForRoute() {
  const st = store.getState();
  if (!st.simRoute || st.simRoute.length < 2) throw new Error('先に経路を作成してください。');

  if (state.worldAbortController) state.worldAbortController.abort();
  const controller = new AbortController();
  state.worldAbortController = controller;
  state.loadingWorld = true;
  state.worldLoaded = false;
  updateMetrics();

  const radius = clampAoiRadius(byId('index3dRadius')?.value);
  const plateauUrl = String(byId('plateauBuildingsUrl')?.value || byId('plateauUrlInput')?.value || '').trim();
  setStatus(`ローカル3Dワールドを読み込み中（AOI ${radius}m）...`);
  logLine(`3Dワールド読込開始: AOI半径 ${radius}m`);

  try {
    const world = await buildLocalWorld(st.simRoute, {
      radiusMeters: radius,
      plateauUrl,
      roadDataSource: byId('roadDataSource')?.value || 'hybrid',
      signal: controller.signal
    });
    store.setGeoJsonDataSets(world.roads);
    store.setSidewalkGeoJSON(world.sidewalks);
    store.setBuildingsGeoJSON(world.buildings);
    store.setState({ plateauTileset: world.plateauTileset || null, compiledWorldHash: null });
    if (typeof window !== 'undefined') window.PLATEAU_AUTO_TILESET = world.plateauTileset || null;
    state.lastWorldMetrics = world.metrics;
    state.routeLoaded = true;
    state.worldLoaded = true;
    const plateauTileLabel = world.metrics.plateauTilesetItem || world.metrics.plateauTilesetName || '';
    setText('buildingStatus', plateauTileLabel
      ? `OSM建物 ${world.metrics.buildingFeatures} + PLATEAUタイル ${plateauTileLabel}`
      : (world.metrics.plateauBuildingFeatures > 0
        ? `PLATEAU ${world.metrics.plateauBuildingFeatures} + OSM合計 ${world.metrics.buildingFeatures}`
        : `OSM建物 ${world.metrics.buildingFeatures} / PLATEAUタイルなし`));
    renderSceneThree(store.getState());
    renderRoadWidthPanel();
    renderSolidPanel();
    renderAutonomyPanel();
    setStatus('3Dワールドを読み込みました。');
    toast('3Dワールドを読み込みました');
    logLine(`3Dワールド読込完了: 道路=${world.metrics.roadFeatures}, 建物=${world.metrics.buildingFeatures}, PLATEAU=${plateauTileLabel || 'なし'}, AOI=${world.metrics.boundsAreaHa}ha`);
    // 経路確定→3D world読込が済んだら、経路コリドーの道へ AI(width_ai) を自動適用する。
    // 実SV/YOLO（runRealPerceptionFusion）は Google API を使う。window.INDEX3D_AUTO_PERCEPTION=false で無効化。
    // 非ブロッキング + 世代ガードつき。古いスキャン結果は新ルートへ適用しない。
    scheduleAutoPerceptionScan();
  } finally {
    if (state.worldAbortController === controller) state.worldAbortController = null;
    state.loadingWorld = false;
    updateMetrics();
  }
}

// ===== 道路幅: 採用根拠表示 + 手動上書き =====
function vehicleDefaultRoadWidth() {
  const vc = store.getState().vehicleConfig || {};
  const w = Number(vc.vehicleWidth) || 2.5;
  const m = Number(vc.widthMargin) || 0.3;
  return Math.max(6, w + m * 2);
}

function selectRoadForWidth(id, name) {
  state.selectedRoadId = id || null;
  const editor = byId('roadWidthEditor');
  if (editor) editor.hidden = !id;
  setText('rwSelectedName', name || '-');
  const idEl = byId('rwSelectedId');
  if (idEl) idEl.textContent = id ? `#${id}` : '';
  const rows = state.lastRoadWidthRows || [];
  const row = rows.find((r) => String(r.id) === String(id));
  const input = byId('roadWidthInput3d');
  if (input && row && Number.isFinite(row.finalWidth)) input.value = String(row.finalWidth);
  document.querySelectorAll('#roadWidthList .rw-item').forEach((el) => {
    el.classList.toggle('selected', String(el.dataset.roadId) === String(id));
  });
}

function renderRoadWidthPanel() {
  const list = byId('roadWidthList');
  const summaryEl = byId('roadWidthSummary');
  if (!list || !summaryEl) return;
  const st = store.getState();
  const roads = st.geoJsonDataSets || [];
  if (!roads.length) {
    list.innerHTML = '';
    summaryEl.textContent = '3D化後に道路ごとの採用幅と根拠を表示します。';
    return;
  }

  const rows = buildRoadWidthRows(roads, {
    defaultRoadWidth: vehicleDefaultRoadWidth(),
    overrides: st.widthOverrides || {},
    limit: 120
  });
  state.lastRoadWidthRows = rows;
  const summary = summarizeRoadWidths(roads);

  const cov = Math.round((summary.osmMeasuredCoverage || 0) * 100);
  const yolo = Math.round((summary.yoloCoverage || 0) * 100);
  const avg = (summary.averageConfidence || 0).toFixed(2);
  const b = summary.confidenceBuckets || {};
  // 主採用ソース内訳（1道路1票）。何で判断しているかを最優先で見せる。
  const primaryLabels = summarizeSourceCounts(summary.primarySourceCounts || {});
  const primaryText = Object.entries(primaryLabels)
    .sort((a, b2) => b2[1] - a[1])
    .map(([label, n]) => `${label} ${n}`)
    .join(' · ') || '-';
  summaryEl.innerHTML = html`${summary.featureCount}本 / 実測 ${cov}% / YOLO ${yolo}% / 平均信頼度 ${avg}<br><span class="rw-primary">主採用: ${primaryText}</span><br><span class="rw-buckets">高 ${b.high || 0} · 中 ${b.medium || 0} · 低 ${b.low || 0} · 不明 ${b.none || 0}</span>`;

  list.innerHTML = rows.map((r) => {
    const conf = Math.round((r.confidence || 0) * 100);
    const cls = r.confidence >= 0.8 ? 'high' : (r.confidence >= 0.6 ? 'mid' : (r.confidence > 0 ? 'low' : 'none'));
    const primaryLabel = formatWidthSource(r.primarySource);
    // 補助 = 主採用以外の寄与ソース（重複ラベルは除外）。
    const auxLabels = [...new Set(
      (r.sources || [])
        .filter((s) => s !== r.primarySource)
        .map((s) => formatWidthSource(s))
        .filter((label) => label !== primaryLabel)
    )];
    const auxHtml = auxLabels.length
      ? unsafeHtml(html`<span class="rw-src-aux">+${auxLabels.join(', ')}</span>`)
      : '';
    const titleSrc = r.sources.length ? r.sources.join('+') : 'default';
    const ov = r.hasOverride ? unsafeHtml(' <span class="rw-ov">手動</span>') : '';
    const w = Number.isFinite(r.finalWidth) ? `${r.finalWidth}m` : '-';
    return html`<div class="rw-item" data-road-id="${r.id ?? ''}" role="button" tabindex="0" title="${titleSrc}"><span class="rw-name">${r.name}${ov}</span><span class="rw-w">${w}</span><span class="rw-conf ${cls}">${conf}%</span><span class="rw-src"><span class="rw-src-main">${primaryLabel}</span>${auxHtml}</span></div>`;
  }).join('');

  list.querySelectorAll('.rw-item').forEach((el) => {
    const handler = () => selectRoadForWidth(el.dataset.roadId, el.querySelector('.rw-name')?.textContent || '');
    el.addEventListener('click', handler);
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handler(); } });
  });

  if (state.selectedRoadId) selectRoadForWidth(state.selectedRoadId, null);
}

function applyWidthOverrideFromUi() {
  const id = state.selectedRoadId;
  const value = Number(byId('roadWidthInput3d')?.value);
  if (!id || !Number.isFinite(value)) { toast('道路を選択し、幅を入力してください'); return; }
  store.applyWidthOverride(id, value);
  renderSceneThree(store.getState());
  renderRoadWidthPanel();
  renderSolidPanel();
  renderAutonomyPanel();
  updateMetrics();
  logLine(`道路 #${id} 幅上書き -> ${value}m`);
  setStatus(`道路幅を ${value}m に変更しました。`);
}

function resetWidthOverrideFromUi() {
  const id = state.selectedRoadId;
  if (!id) return;
  store.resetWidthOverride(id);
  renderSceneThree(store.getState());
  renderRoadWidthPanel();
  renderSolidPanel();
  renderAutonomyPanel();
  updateMetrics();
  logLine(`道路 #${id} の幅上書きを解除しました`);
}

// ===== 建物・障害物ソリッド + 頭上クリアランス =====
function setRoadSegSurfaceSummary(text, kind = '') {
  const el = byId('roadSegSurfaceSummary');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('warn', kind === 'warn');
  el.classList.toggle('ok', kind === 'ok');
}

function refreshWorldAfterMaskEdit() {
  renderSceneThree(store.getState());
  renderSolidPanel();
  renderAutonomyPanel();
  updateMetrics();
}

async function applyRoadSegSurfaceFromUi() {
  if (!state.worldLoaded) {
    toast('先に3Dワールドを読み込んでください');
    return;
  }
  const btn = byId('roadSegSurfaceApply');
  if (btn) btn.disabled = true;
  const preferredBackend = (window.ROAD_SEG_SURFACE_BACKEND || 'pretrained');
  setRoadSegSurfaceSummary('航空写真から道路面を推定中...');
  try {
    const result = await applyAerialRoadSurface({
      backend: preferredBackend,
      roadBufferM: 28,
      cellPx: 6,
      fillRatio: 0.35,
      minAreaM2: 12,
      maxPolygons: 400
    });
    refreshWorldAfterMaskEdit();
    const count = result.appliedCount || 0;
    const cells = result.meta?.cellCount ?? '-';
    const backend = result.meta?.segmenter || preferredBackend;
    queueMicrotask(() => setRoadSegSurfaceSummary(`road_seg surface ${count} polygons / backend=${backend} / cells=${cells}`, count ? 'ok' : 'warn'));
    logLine(`road_seg surface: polygons=${count} backend=${backend} cells=${cells}`);
    setRoadSegSurfaceSummary(`道路面補強 ${count}ポリゴン / cells=${cells}`, count ? 'ok' : 'warn');
    logLine(`road_seg道路面補強: polygons=${count} cells=${cells}`);
  } catch (e) {
    const msg = e?.message || String(e);
    setRoadSegSurfaceSummary(`道路面補強に失敗: ${msg}`, 'warn');
    throw e;
  } finally {
    if (btn) btn.disabled = !state.worldLoaded;
  }
}

function clearRoadSegSurfaceFromUi() {
  const result = clearAerialRoadSurface();
  refreshWorldAfterMaskEdit();
  setRoadSegSurfaceSummary(`road_seg道路面補強を解除: ${result.removedCount || 0}件`, 'warn');
  logLine(`road_seg道路面補強解除: removed=${result.removedCount || 0}`);
}

function buildCurrentSolidReport(extraMaskDeny = []) {
  const st = store.getState();
  const maskEdits = {
    allow: st.maskEdits?.allow || [],
    deny: [...(st.maskEdits?.deny || []), ...(Array.isArray(extraMaskDeny) ? extraMaskDeny : [])]
  };
  return buildClearanceSolidReport({
    route: st.simRoute || [],
    buildings: st.buildingsGeoJSON || [],
    maskEdits,
    vehicleConfig: st.vehicleConfig || {},
    cargoLoadType: st.cargoLoadType,
    cargoCount: st.cargoCount,
    clearanceMargin: 0.25
  });
}

function renderSolidPanel() {
  const summaryEl = byId('solidSummary');
  const listEl = byId('solidList');
  if (!summaryEl || !listEl) return;
  const st = store.getState();
  if (!state.worldLoaded || !st.simRoute?.length) {
    summaryEl.textContent = '3D化後に建物、地上障害物、頭上障害物を表示します。';
    listEl.innerHTML = '';
    return;
  }

  const report = buildCurrentSolidReport();
  state.lastSolidReport = report;
  const s = report.summary || {};
  const solidMetrics = getCollisionSolidMetrics();
  const rq = solidMetrics.roadQuality || {};
  const statusClass = s.lowClearanceCount > 0 ? 'ng' : 'ok';
  summaryEl.innerHTML = html`
    <span class="solid-status ${statusClass}">${s.status}</span>
    建物 ${s.buildingSolidCount || 0} / 地上障害物 ${s.obstacleSolidCount || 0} / 頭上障害物 ${s.overheadSolidCount || 0}
    <br><span class="solid-sub">必要高 ${s.requiredHeightM}m / 車高 ${s.vehicleHeightM}m + 積載 ${s.cargoStackHeightM}m / 経路近傍の頭上 ${s.nearRouteOverheadCount || 0} / 低クリアランス ${s.lowClearanceCount || 0}</span>
    <br><span class="solid-sub">道路補正: 交差点 ${rq.intersectionCaps || 0} / 道路端 ${rq.roadEdges || 0} / 中心線 ${rq.centerlines || 0} / 一方通行 ${rq.onewayArrows || 0}</span>
  `;

  const rows = report.rows || [];
  if (!rows.length) {
    listEl.innerHTML = '<div class="solid-empty">頭上障害物はまだありません。Street View/YOLOまたは手動マスクの heightOnly が入ると表示されます。</div>';
    return;
  }
  listEl.innerHTML = rows.slice(0, 80).map((row) => {
    const cls = row.status === 'NG' ? 'ng' : 'ok';
    const near = row.nearRoute ? '経路上' : '経路外';
    return html`<div class="solid-row ${cls}"><span class="solid-name">${row.label || row.id}</span><span class="solid-near">${near}</span><span class="solid-height">高さ ${row.heightM}m / 必要 ${row.requiredHeightM}m</span><span class="solid-margin">余裕 ${row.marginM}m</span></div>`;
  }).join('');
}

function runPhase3Validation() {
  const st = store.getState();
  const base = buildCurrentSolidReport();
  const required = Number(base.summary?.requiredHeightM) || 3.0;
  const fixture = makeRouteOverheadFixture(st.simRoute || [], {
    clearanceHeightM: Math.max(1.8, required - 0.4),
    radiusM: 5
  });
  const withFixture = buildCurrentSolidReport(fixture ? [fixture] : []);
  const metrics = getCollisionSolidMetrics();
  return {
    ok: !!fixture && withFixture.summary.lowClearanceCount > base.summary.lowClearanceCount,
    baseSummary: base.summary,
    fixtureSummary: withFixture.summary,
    fixtureId: fixture?.properties?.id || null,
    collisionSolidMetrics: metrics
  };
}

// ===== 自律走行: センサー / 速度 / 停止計画 =====
function buildCurrentAutonomyReport(extraMaskDeny = []) {
  const st = store.getState();
  const maskEdits = {
    allow: st.maskEdits?.allow || [],
    deny: [...(st.maskEdits?.deny || []), ...(Array.isArray(extraMaskDeny) ? extraMaskDeny : [])]
  };
  return buildAutonomyDriveReport({
    route: st.simRoute || [],
    roads: st.geoJsonDataSets || [],
    buildings: st.buildingsGeoJSON || [],
    maskEdits,
    vehicleConfig: st.vehicleConfig || {},
    cargoLoadType: st.cargoLoadType,
    cargoCount: st.cargoCount,
    cruiseSpeedKmh: Number(byId('index3dSpeed')?.value || 18),
    sensorRangeM: 34,
    sampleSpacingM: 3,
    rayStepM: 1.5
  });
}

function renderAutonomyPanel() {
  const summaryEl = byId('autonomySummary');
  const listEl = byId('autonomyList');
  if (!summaryEl || !listEl) return;
  const st = store.getState();
  if (!state.worldLoaded || !st.simRoute?.length) {
    summaryEl.textContent = '3D化後に前方センサー、速度制限、停止判断を表示します。';
    listEl.innerHTML = '';
    return;
  }

  const report = buildCurrentAutonomyReport();
  state.lastAutonomyReport = report;
  const s = report.summary || {};
  const cls = s.status === 'STOP' ? 'ng' : (s.status === 'SLOW' ? 'warn' : 'ok');
  const live = getAutonomyDriveMetrics() || null;
  const liveMode = live?.currentMode || (live?.status ?? '-');
  const liveCls = liveMode === 'STOP' ? 'ng' : ((liveMode === 'SLOW' || liveMode === 'YIELD' || liveMode === 'SATURATED') ? 'warn' : 'ok');
  const recoveryPlayback = Number(live?.recoveryPlaybackCount || 0);
  const liveDetail = live
    ? html`許容 ${live.currentAllowedSpeedKmh ?? '-'}km/h / 前方 ${live.currentForwardClearanceM ?? '-'}m / 復旧 ${recoveryPlayback}`
    : '再生開始後に更新';
  summaryEl.innerHTML = html`
    <div class="autonomy-line"><span class="autonomy-tag">計画</span>
      <span class="autonomy-status ${cls}">${s.status}</span>
      センサー ${s.sensorRangeM}m / ブロッカー ${s.blockerCount} / サンプル ${s.sampleCount}</div>
    <div class="autonomy-line"><span class="autonomy-tag live">実走</span>
      <span class="autonomy-status ${liveCls}">${liveMode}</span>
      ${unsafeHtml(liveDetail)}</div>
    <span class="autonomy-sub">最小前方余裕 ${s.minForwardClearanceM ?? '-'}m / 停止 ${s.stopEventCount || 0} / 減速 ${s.slowEventCount || 0} / 操舵飽和 ${(Number(s.steeringSaturationRatio || 0) * 100).toFixed(1)}%</span>
    <br><span class="autonomy-sub">許容速度 ${s.minAllowedSpeedKmh ?? '-'}-${s.maxAllowedSpeedKmh ?? '-'}km/h / 初回停止 ${s.firstStopDistanceM ?? '-'}m</span>
    <br><span class="autonomy-sub">最小経路半径 ${s.minPathRadiusM ?? '-'}m / 車両最小 ${s.vehicleMinTurnRadiusM ?? '-'}m / 最大不足 ${s.maxTurnRadiusDeficitM ?? 0}m</span>
    <br><span class="autonomy-sub">復旧 ${s.recoveryStatus ?? 'なし'} / 後退 ${s.reverseCount ?? 0} / 再計画 ${s.replanCount ?? 0} / 復旧済み ${s.recoveredStopCount ?? 0} / 未解決 ${s.unresolvedStopCount ?? 0}</span>
  `;

  const rows = (report.samples || [])
    .filter((row) => row.mode !== 'CRUISE' || row.blockerId)
    .slice(0, 60);
  if (!rows.length) {
    listEl.innerHTML = '<div class="autonomy-empty">この経路では停止または大きな減速はありません。</div>';
    return;
  }
  listEl.innerHTML = rows.map((row) => {
    const rowCls = row.mode === 'STOP' ? 'ng' : (row.mode === 'SLOW' || row.mode === 'YIELD' || row.mode === 'SATURATED' ? 'warn' : 'ok');
    const blocker = row.blockerId ? ` / ${row.blockerId}` : '';
    const clearance = row.forwardClearanceM == null ? '-' : `${row.forwardClearanceM}m`;
    const radius = row.pathRadiusM == null ? '-' : `${row.pathRadiusM}m`;
    const minTurn = row.vehicleMinTurnRadiusM == null ? '-' : `${row.vehicleMinTurnRadiusM}m`;
    const deficit = Number(row.turnRadiusDeficitM) > 0 ? ` / 不足 ${row.turnRadiusDeficitM}m` : '';
    const curve = row.curveLimitKmh == null ? '-' : `${row.curveLimitKmh}km/h`;
    const roadConf = row.roadConfidence == null ? '-' : `${Math.round(row.roadConfidence * 100)}%`;
    const confFactor = row.confidenceSpeedFactor == null ? '-' : `x${row.confidenceSpeedFactor}`;
    return html`<div class="autonomy-row ${rowCls}"><span class="autonomy-mode">${row.mode}</span><span class="autonomy-s">${row.sM}m${blocker}</span><span class="autonomy-speed">${row.allowedSpeedKmh}km/h</span><span class="autonomy-clearance">前方 ${clearance} / 旋回 ${row.turnDeg}deg / R ${radius} 最小 ${minTurn}${deficit} / カーブ ${curve} / 信頼度 ${roadConf} ${confFactor}</span></div>`;
  }).join('');
}

function runPhase4Validation() {
  const st = store.getState();
  const base = buildCurrentAutonomyReport();
  const required = Number(buildCurrentSolidReport().summary?.requiredHeightM) || 3.0;
  const fixture = makeRouteOverheadFixture(st.simRoute || [], {
    clearanceHeightM: Math.max(1.8, required - 0.4),
    radiusM: 5,
    id: 'phase4:fixture:autonomy-stop'
  });
  const withFixture = buildCurrentAutonomyReport(fixture ? [fixture] : []);
  const fixtureId = fixture?.properties?.id || fixture?.id || null;
  const ids = withFixture.summary?.blockingSolidIds || [];
  const detected = fixtureId ? ids.includes(fixtureId) : false;
  return {
    ok: !!fixture && detected && Number(withFixture.summary?.stopEventCount || 0) > 0,
    baseSummary: base.summary,
    fixtureSummary: withFixture.summary,
    fixtureId,
    detected,
    runtimeMetrics: getAutonomyDriveMetrics()
  };
}

// ===== Phase 5: Perception Fusion (Street View / YOLO -> width + obstacles) =====
function removeDenyMaskEditsByIds(ids) {
  const idSet = new Set((Array.isArray(ids) ? ids : []).map((id) => String(id)).filter(Boolean));
  if (!idSet.size) return;
  const current = store.getState().maskEdits || {};
  const next = {
    allow: current.allow || [],
    deny: (current.deny || []).filter((f) => !idSet.has(String(f?.properties?.id ?? f?.id ?? '')))
  };
  store.setMaskEdits(next, { replace: true });
}

function clearPerceptionObstacles() {
  removeDenyMaskEditsByIds(state.perceptionObstacleIds || []);
  state.perceptionObstacleIds = [];
}

function clearPerceptionWidths() {
  const ids = (state.perceptionWidthRoadIds || []).map((id) => String(id)).filter(Boolean);
  if (ids.length) {
    // AI 適用は width_ai のみ削除。手動上書き(userOverrideWidth)には触れない。
    store.clearPerceptionWidthAi(ids);
  }
  state.perceptionWidthRoadIds = [];
}

// 経路クリア/リセット時に再生停止、知覚補正クリア、3D再描画まで行う。
function resetSimAfterRouteChange() {
  try { stopThree3D(); } catch (_e) {}
  state.autoPerceptionGeneration += 1;
  state.autoPerceptionQueued = null;
  state.lastAutoPerceptionSignature = '';
  clearPerceptionObstacles();
  clearPerceptionWidths();
  clearAerialRoadSurface();
  setRoadSegSurfaceSummary('経路変更によりroad_seg道路面補強をクリアしました。');
  state.routeLoaded = false;
  state.worldLoaded = false;
  state.lastWorldMetrics = null;
  state.lastSolidReport = null;
  state.lastAutonomyReport = null;
  state.lastPerceptionReport = null;
  try { renderSceneThree(store.getState()); } catch (_e) {}
  renderPerceptionPanel();
  updateMetrics();
  logLine('経路をクリア: 3Dシーンと知覚結果をリセットしました');
}

// Street View / YOLOフレームを知覚融合へ直接渡す。合成スキャンは検証用に残す。
function acquirePerceptionScan({ preferStreetView = false, allowSyntheticFallback = true } = {}) {
  const st = store.getState();
  const googleKey = !!getGoogleKey();
  if (preferStreetView) {
    const frames = getStreetViewFrames();
    const realScan = buildPerceptionScanFromStreetViewFrames(frames, st.geoJsonDataSets || [], st.simRoute || [], { stationSpacingM: 15 });
    const usable = (realScan.widthSamples?.length || 0) > 0 || (realScan.detections?.length || 0) > 0;
    if (usable) {
      return { ...realScan, diag: { preferStreetView: true, googleKey, frames: frames.length, usedDetections: realScan.meta?.usedDetections ?? 0 } };
    }
    const reason = !googleKey
      ? 'Street View / YOLOは利用できません: Google Maps APIキーが未設定です。'
      : `Street View / YOLOで利用可能な検出がありません（${frames.length}フレーム）。`;
    if (!allowSyntheticFallback) {
      return {
        source: 'streetview-yolo',
        stations: realScan.stations || [],
        widthSamples: [],
        detections: [],
        skipReason: reason,
        diag: { preferStreetView: true, googleKey, frames: frames.length, usedDetections: 0 }
      };
    }
    const fb = makeSyntheticPerceptionScan(st.geoJsonDataSets || [], st.simRoute || [], { stationSpacingM: 15 });
    return {
      ...fb,
      skipReason: `${reason} 合成スキャンへフォールバックしました。`,
      diag: { preferStreetView: true, googleKey, frames: frames.length, usedDetections: 0 }
    };
  }
  const scan = makeSyntheticPerceptionScan(st.geoJsonDataSets || [], st.simRoute || [], { stationSpacingM: 15 });
  return {
    ...scan,
    skipReason: '合成スキャンを使用しました。実際のStreet View由来の障害物proxyを使うにはSV/YOLOを実行してください。',
    diag: { preferStreetView: false, googleKey, frames: 0, usedDetections: 0 }
  };
}

function runPerceptionFusion({
  autoApplyConfidence = 0.7,
  preferStreetView = false,
  scanOverride = null,
  allowSyntheticFallback = true,
  expectedRouteSignature = null,
  generation = null
} = {}) {
  const st = store.getState();
  if (!st.simRoute?.length || !(st.geoJsonDataSets?.length)) {
    toast('先に経路を確定し、3Dワールドを読み込んでください。');
    return null;
  }
  if (!perceptionContextMatches(expectedRouteSignature, generation)) {
    logLine('知覚融合をスキップ: 適用前に経路が変更されました。');
    return null;
  }

  const scan = scanOverride || acquirePerceptionScan({ preferStreetView, allowSyntheticFallback });
  if (!perceptionContextMatches(expectedRouteSignature, generation)) {
    logLine('知覚融合をスキップ: スキャン取得後に経路が変更されました。');
    return null;
  }
  const agg = aggregateWidthSuggestions(st.geoJsonDataSets, scan.widthSamples, {
    autoApplyConfidence,
    minDeltaM: 0.6,
    defaultRoadWidth: vehicleDefaultRoadWidth()
  });

  // 高信頼の幅だけをwidth_aiとして自動適用する。再スキャン時の蓄積を防ぐため、
  // 前回の知覚幅補正を先に戻す。
  clearPerceptionWidths();
  let appliedCount = 0;
  const appliedWidthIds = [];
  // AI 知覚幅は width_ai（推定・0.75）として適用。手動上書き(userOverrideWidth)は authoritative
  // なので別フィールドのまま温存され、AI に潰されない。経路コリドーの道だけが対象。
  const aiWidthMap = {};
  for (const sug of agg.suggestions) {
    if (sug.autoApply && sug.roadId != null && Number.isFinite(sug.suggestedWidth)) {
      const id = String(sug.roadId);
      aiWidthMap[id] = Number(sug.suggestedWidth);
      appliedWidthIds.push(id);
      appliedCount += 1;
    }
  }
  if (appliedWidthIds.length) {
    store.applyPerceptionWidthAi(aiWidthMap);
  }
  state.perceptionWidthRoadIds = appliedWidthIds;

  // YOLO障害物をmaskEdits.denyへ一括注入し、建物/障害物判定と自律走行判定に反映する。
  // 1件ずつaddMaskEditすると毎回再計算が走るため、setMaskEditsでまとめて反映する。
  clearPerceptionObstacles();
  const obstacles = buildObstacleFeatures(scan.detections).filter((f) => f?.properties?.id);
  const obstacleIds = obstacles.map((f) => String(f.properties.id));
  if (obstacles.length) {
    const cur = store.getState().maskEdits || {};
    store.setMaskEdits({ allow: cur.allow || [], deny: [...(cur.deny || []), ...obstacles] }, { replace: true });
  }
  state.perceptionObstacleIds = obstacleIds;

  const widthReport = summarizeRoadWidths(store.getState().geoJsonDataSets || []);
  const overheadCount = obstacles.filter((f) => f?.properties?.heightOnly).length;
  const report = {
    summary: {
      source: scan.source,
      skipReason: scan.skipReason || null,
      stationCount: scan.stations?.length || 0,
      coverageRoads: agg.coverageRoads,
      appliedCount,
      pendingCount: agg.pendingCount,
      obstacleCount: obstacles.length,
      overheadCount,
      yoloCoverage: widthReport.yoloCoverage,
      averageConfidence: widthReport.averageConfidence,
      // 実SV/YOLO診断
      isReal: scan.source === 'streetview-yolo',
      googleKey: !!scan.diag?.googleKey,
      frames: Number(scan.diag?.frames ?? scan.meta?.frameCount ?? 0),
      usedDetections: Number(scan.diag?.usedDetections ?? scan.meta?.usedDetections ?? 0)
    },
    suggestions: agg.suggestions,
    obstacles: obstacles.map((f) => ({
      id: f.properties.id,
      label: f.properties.label,
      class: f.properties.class,
      confidence: f.properties.confidence,
      heightOnly: !!f.properties.heightOnly,
      proxyShape: f.properties.proxyShape || 'circle',
      lengthM: f.properties.lengthM,
      widthM: f.properties.widthM
    }))
  };
  state.lastPerceptionReport = report;

  renderSceneThree(store.getState());
  renderRoadWidthPanel();
  renderSolidPanel();
  renderPerceptionPanel();
  updateMetrics();
  logLine(`知覚融合: 幅適用 ${appliedCount} / 保留 ${agg.pendingCount} / 障害物 ${obstacles.length} (${scan.source})`);
  if (scan.skipReason && !obstacles.length && !appliedCount && !agg.pendingCount) {
    setStatus(scan.skipReason);
  } else {
    setStatus(`知覚融合: 幅適用 ${appliedCount} / 保留 ${agg.pendingCount} / 障害物 ${obstacles.length}`);
  }
  return report;
}

function streetViewYoloEnabled() {
  return typeof window !== 'undefined' && window.INDEX3D_ENABLE_STREETVIEW_YOLO === true;
}

async function runRealPerceptionFusion({ expectedRouteSignature = null, generation = null, auto = false } = {}) {
  if (!streetViewYoloEnabled()) {
    const message = 'Street View/YOLOは商用クリーン設定で無効です。社内検証時のみ INDEX3D_ENABLE_STREETVIEW_YOLO=true にしてください。';
    setStatus(message);
    logLine(message);
    if (!auto) toast(message);
    return null;
  }
  const st = store.getState();
  if (!st.simRoute?.length || !(st.geoJsonDataSets?.length)) {
    toast('先に経路を確定し、3Dワールドを読み込んでください。');
    return null;
  }
  if (!perceptionContextMatches(expectedRouteSignature, generation)) {
    logLine('Street View/YOLOスキャンをスキップ: 開始前に経路が変更されました。');
    return null;
  }
  clearPerceptionObstacles();
  clearPerceptionWidths();
  state.lastPerceptionReport = null;
  renderSceneThree(store.getState());
  renderPerceptionPanel();
  updateMetrics();
  setStatus('Street View/YOLOスキャンを実行中...');
  logLine('Street View/YOLOスキャンを開始しました。');
  try {
    const scanResult = await scanStreetView();
    if (!scanResult?.ok) {
      const reason = scanResult?.reason || 'scan_failed';
      const message = `Street Viewスキャンをスキップ: ${reason}`;
      setStatus(message);
      if (!auto) toast(message);
      return null;
    }
    if (!perceptionContextMatches(expectedRouteSignature, generation)) {
      logLine('Street View/YOLOスキャン結果を破棄: Street View取得後に経路が変更されました。');
      return null;
    }
    const analyzeResult = await analyzeStreetView();
    if (!analyzeResult?.ok) {
      const reason = analyzeResult?.reason || 'analyze_failed';
      const message = `YOLO解析をスキップ: ${reason}`;
      setStatus(message);
      if (!auto) toast(message);
      return null;
    }
    if (!perceptionContextMatches(expectedRouteSignature, generation)) {
      logLine('Street View/YOLOスキャン結果を破棄: YOLO解析後に経路が変更されました。');
      return null;
    }
    return runPerceptionFusion({ preferStreetView: true, allowSyntheticFallback: false, expectedRouteSignature, generation });
  } catch (e) {
    const message = e?.message || String(e);
    console.warn('[index3D] real perception scan failed:', message);
    setStatus(`Street View/YOLO失敗: ${message}`);
    if (!auto) toast(`Street View/YOLO失敗: ${message}`);
    return null;
  }
}

function clearPerceptionFusion() {
  clearPerceptionObstacles();
  clearPerceptionWidths();
  state.lastPerceptionReport = null;
  state.lastAutoPerceptionSignature = '';
  renderSceneThree(store.getState());
  renderRoadWidthPanel();
  renderSolidPanel();
  renderPerceptionPanel();
  updateMetrics();
  logLine('知覚由来の障害物と幅補正をクリアしました');
}

function renderPerceptionPanel() {
  const summaryEl = byId('perceptionSummary');
  const listEl = byId('perceptionList');
  if (!summaryEl || !listEl) return;
  if (!state.worldLoaded) {
    summaryEl.textContent = '3D化後に Street View / YOLO 由来の幅補正と障害物proxyを反映します。';
    listEl.innerHTML = '';
    return;
  }
  const report = state.lastPerceptionReport;
  if (!report) {
    summaryEl.textContent = 'SV/YOLOを実行すると、実検出から障害物proxyを描画します。';
    listEl.innerHTML = '';
    return;
  }

  const s = report.summary || {};
  const yolo = Math.round((s.yoloCoverage || 0) * 100);
  const sourceLabel = s.isReal ? 'Street View / YOLO' : '合成スキャン';
  const sourceCls = s.isReal ? 'ok' : 'mut';
  const diag = `キー:${s.googleKey ? 'あり' : 'なし'} / フレーム:${s.frames ?? 0} / 検出:${s.usedDetections ?? 0}`;
  const skipPart = s.skipReason ? html`<br><span class="perception-sub warn">${s.skipReason}</span>` : '';
  summaryEl.innerHTML = html`<span class="perception-status ${sourceCls}">${sourceLabel}</span> 幅適用 ${s.appliedCount || 0} / 保留 ${s.pendingCount || 0} / 障害物 ${s.obstacleCount || 0} / 頭上 ${s.overheadCount || 0}<br><span class="perception-sub">YOLO幅カバー率 ${yolo}% / スキャン地点 ${s.stationCount || 0} / ${diag}</span>${unsafeHtml(skipPart)}`;

  const sugRows = (report.suggestions || []).slice(0, 40).map((g) => {
    const cls = g.autoApply ? 'ok' : (g.pendingReason === 'low-confidence' ? 'warn' : 'mut');
    const stateText = g.autoApply ? '適用' : (g.pendingReason === 'low-confidence' ? '確認' : '小差分');
    const cur = g.currentWidth == null ? '-' : `${g.currentWidth}m`;
    return html`<div class="perception-row ${cls}"><span class="pc-name">道路 #${g.roadId}</span><span class="pc-w">${cur} -> ${g.suggestedWidth}m</span><span class="pc-conf">${Math.round((g.confidence || 0) * 100)}% x${g.frameCount}</span><span class="pc-state">${stateText}</span></div>`;
  }).join('');

  const obsRows = (report.obstacles || []).map((o) => {
    const shape = o.proxyShape || 'circle';
    const size = Number.isFinite(Number(o.lengthM)) && Number.isFinite(Number(o.widthM))
      ? `${Number(o.lengthM).toFixed(1)}x${Number(o.widthM).toFixed(1)}m`
      : shape;
    return html`<div class="perception-row ${o.heightOnly ? 'warn' : 'mut'}"><span class="pc-name">${o.label || o.class || '障害物'}</span><span class="pc-w">${o.heightOnly ? '頭上' : '地上'} ${size}</span><span class="pc-conf">${Math.round((o.confidence || 0) * 100)}%</span><span class="pc-state">${shape.toUpperCase()}</span></div>`;
  }).join('');

  listEl.innerHTML = sugRows + obsRows || '<div class="perception-empty">反映できる候補はありません。</div>';
}

// ===== 復旧挙動（後退 / 再計画）検証 =====
function runPhase7Validation() {
  const st = store.getState();
  const route = st.simRoute || [];
  // 復旧可能な地上障害物: 側方オフセットで停止後、後退と切り返しで回避できる。
  const groundFx = makeRouteLateralObstacleFixture(route, {});
  const groundReport = buildCurrentAutonomyReport(groundFx ? [groundFx] : []);
  const g = groundReport.summary || {};
  // 頭上の低クリアランス: 後退しても通過できないため復旧不可。
  const required = Number(buildCurrentSolidReport().summary?.requiredHeightM) || 3.0;
  const overheadFx = makeRouteOverheadFixture(route, {
    clearanceHeightM: Math.max(1.8, required - 0.4),
    radiusM: 5,
    id: 'phase7:fixture:overhead'
  });
  const overheadReport = buildCurrentAutonomyReport(overheadFx ? [overheadFx] : []);
  const o = overheadReport.summary || {};

  const groundRecovered = Number(g.stopEventCount || 0) > 0
    && Number(g.reverseCount || 0) > 0
    && Number(g.recoveredStopCount || 0) > 0;
  const overheadUnresolved = Number(o.stopEventCount || 0) > 0
    && Number(o.reverseCount || 0) === 0
    && o.recoveryStatus === 'UNRESOLVED';

  return {
    ok: !!groundFx && !!overheadFx && groundRecovered && overheadUnresolved,
    ground: {
      fixtureId: groundFx?.properties?.id || null,
      stopEventCount: g.stopEventCount ?? null,
      reverseCount: g.reverseCount ?? null,
      replanCount: g.replanCount ?? null,
      recoveredStopCount: g.recoveredStopCount ?? null,
      unresolvedStopCount: g.unresolvedStopCount ?? null,
      recoveryStatus: g.recoveryStatus ?? null,
      recoveryEvents: groundReport.recoveryEvents || []
    },
    overhead: {
      fixtureId: overheadFx?.properties?.id || null,
      stopEventCount: o.stopEventCount ?? null,
      reverseCount: o.reverseCount ?? null,
      recoveryStatus: o.recoveryStatus ?? null
    },
    runtimeMetrics: getAutonomyDriveMetrics()
  };
}

async function runPhase7PlaybackValidation({ timeoutMs = 22000, speedKmh = 32 } = {}) {
  const st = store.getState();
  const route = st.simRoute || [];
  if (!state.worldLoaded || route.length < 2) {
    return { ok: false, reason: 'world-not-loaded' };
  }

  clearPerceptionFusion();
  const fixture = makeRouteLateralObstacleFixture(route, { id: 'phase7:playback:lateral-obstacle' });
  if (!fixture) return { ok: false, reason: 'fixture-unavailable' };
  const fixtureId = fixture.properties?.id || fixture.id;
  store.addMaskEdit('deny', fixture);
  renderSceneThree(store.getState());
  renderSolidPanel();
  renderAutonomyPanel();
  updateMetrics();

  openThree3D();
  playThree3D(Number(speedKmh) || 32);

  const started = Date.now();
  const samples = [];
  let ok = false;
  let lastMetrics = null;
  while (Date.now() - started < timeoutMs) {
    await waitMs(500);
    const metrics = getAutonomyDriveMetrics() || {};
    lastMetrics = metrics;
    samples.push({
      tMs: Date.now() - started,
      mode: metrics.currentMode || null,
      progressM: metrics.progressM ?? null,
      totalM: metrics.totalM ?? null,
      recoveryPlaybackCount: metrics.recoveryPlaybackCount ?? 0,
      recoveryBypassUntilM: metrics.recoveryBypassUntilM ?? 0,
      playing: !!metrics.playing
    });
    const recovered = Number(metrics.recoveryPlaybackCount || 0) > 0;
    const movedPastRecovery = Number(metrics.progressM || 0) >= Math.max(12, Number(metrics.recoveryBypassUntilM || 0) - 1);
    const notStopped = metrics.currentMode !== 'STOP';
    if (recovered && movedPastRecovery && notStopped) {
      ok = true;
      break;
    }
  }

  stopThree3D();
  removeDenyMaskEditsByIds([fixtureId]);
  renderSceneThree(store.getState());
  renderSolidPanel();
  renderAutonomyPanel();
  updateMetrics();

  return {
    ok,
    fixtureId,
    timeoutMs,
    metrics: lastMetrics,
    samples: samples.slice(-12)
  };
}

function runPhase5Validation() {
  // 実行前
  const beforeWidth = summarizeRoadWidths(store.getState().geoJsonDataSets || []);
  const beforeSurface = getRoadSurfaceMetrics() || {};
  const beforeSolids = buildCurrentSolidReport().summary || {};
  const beforeObstacles = Number(beforeSolids.obstacleSolidCount || 0) + Number(beforeSolids.overheadSolidCount || 0);

  const report = runPerceptionFusion();

  // 実行後
  const afterWidth = summarizeRoadWidths(store.getState().geoJsonDataSets || []);
  const afterSurface = getRoadSurfaceMetrics() || {};
  const afterSolids = buildCurrentSolidReport().summary || {};
  const afterObstacles = Number(afterSolids.obstacleSolidCount || 0) + Number(afterSolids.overheadSolidCount || 0);

  // 経路出口周辺のwidth_aiが反映されているかを確認する。
  // Phase2で既にwidth_aiがある場合もあるため、増加ではなくcoverage>0かつ自動適用発生で判定する。
  const yoloCoverageOk = Number(afterWidth.yoloCoverage || 0) > 0 && Number(report?.summary?.appliedCount || 0) > 0;
  const surfaceChanged = Number(afterSurface.areaM2 || 0) !== Number(beforeSurface.areaM2 || 0);
  const pendingKept = Number(report?.summary?.pendingCount || 0) > 0;
  const obstaclesAdded = afterObstacles > beforeObstacles;

  return {
    ok: !!report && yoloCoverageOk && surfaceChanged && pendingKept && obstaclesAdded,
    yoloCoverageBefore: beforeWidth.yoloCoverage,
    yoloCoverageAfter: afterWidth.yoloCoverage,
    surfaceAreaBefore: beforeSurface.areaM2 ?? null,
    surfaceAreaAfter: afterSurface.areaM2 ?? null,
    surfaceChanged,
    obstacleSolidsBefore: beforeObstacles,
    obstacleSolidsAfter: afterObstacles,
    appliedCount: report?.summary?.appliedCount ?? 0,
    pendingCount: report?.summary?.pendingCount ?? 0,
    pendingKept,
    autonomy: getAutonomyDriveMetrics()
  };
}

function run3D() {
  const opened = openThree3D();
  if (!opened) throw new Error('3Dビューを開けませんでした。');
  renderSceneThree(store.getState());
  playThree3D(Number(byId('index3dSpeed')?.value || 18));
  renderAutonomyPanel();
  setStatus('3Dシミュレーション実行中。');
  logLine('3Dシミュレーションを開始しました。');
}

function stop3D() {
  stopThree3D();
  setStatus('3Dシミュレーションを一時停止しました。');
  logLine('3Dシミュレーションを一時停止しました。');
}

function reset3D() {
  stopThree3D();
  renderSceneThree(store.getState());
  renderAutonomyPanel();
  setStatus('3Dシーンをリセットしました。');
  logLine('3Dシーンをリセットしました。');
}

function setDemoInputs() {
  const search = byId('search-input');
  if (search && !search.value) search.value = DEFAULT_START;
}

function waitForRouteReady(timeoutMs = 8000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const st = store.getState();
      if (st.simRoute?.length >= 2) {
        resolve(st);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error('経路確定後も経路が生成されませんでした。'));
        return;
      }
      setTimeout(tick, 150);
    };
    tick();
  });
}

async function loadWorldAfterExistingConfirm() {
  if (byId('index3dAutoWorld')?.checked === false) return;
  try {
    await waitForRouteReady();
    state.routeLoaded = true;
    await loadWorldForRoute();
    renderSceneThree(store.getState());
  } catch (e) {
    console.warn('[index3d] post-confirm 3D load skipped:', e?.message || e);
    setStatus(e.message || String(e));
  }
}

async function handleRoutePrimaryAction() {
  const action = byId('routeGuidePrimary')?.dataset.routeAction || 'roads';
  try {
    if (action === 'roads') {
      setStatus('表示範囲の道路を読み込んでいます...');
      byId('topRefreshData')?.click();
      return;
    }
    if (action === 'points') {
      ensureEndpointMode();
      flashRouteMap();
      setStatus('経路マップ上で出発地と目的地をクリックしてください。');
      return;
    }
    if (action === 'confirm') {
      byId('confirm-route')?.click();
      return;
    }
    if (action === 'world') {
      await loadWorldForRoute();
      return;
    }
    if (action === 'run') {
      run3D();
    }
  } catch (e) {
    console.error(e);
    setStatus(e.message || String(e));
    toast(e.message || String(e));
  }
}

function wireControls() {
  byId('routeGuidePrimary')?.addEventListener('click', () => {
    handleRoutePrimaryAction();
  });

  byId('index3dDemoRoute')?.addEventListener('click', async () => {
    try {
      setDemoInputs();
      await buildDemoRoute({ autoWorld: true });
      run3D();
    } catch (e) {
      console.error(e);
      setStatus(e.message);
      toast(e.message);
    }
  });

  byId('index3dLoadWorld')?.addEventListener('click', async () => {
    try { await loadWorldForRoute(); }
    catch (e) { console.error(e); setStatus(e.message); toast(e.message); }
  });

  byId('index3dRun')?.addEventListener('click', () => {
    try { run3D(); } catch (e) { console.error(e); setStatus(e.message); toast(e.message); }
  });
  byId('index3dPause')?.addEventListener('click', stop3D);
  byId('index3dReset')?.addEventListener('click', reset3D);
  byId('index3dPanelPlay')?.addEventListener('click', run3D);
  byId('index3dPanelPause')?.addEventListener('click', stop3D);
  byId('index3dPanelReset')?.addEventListener('click', reset3D);
  byId('confirm-route')?.addEventListener('click', () => {
    setStatus('経路を確定しています...');
    setTimeout(() => loadWorldAfterExistingConfirm(), 250);
  });
  byId('clear-endpoints')?.addEventListener('click', () => resetSimAfterRouteChange());
  byId('reset-route')?.addEventListener('click', () => resetSimAfterRouteChange());

  byId('vehiclePreset')?.addEventListener('change', (event) => {
    store.applyVehiclePreset(event.target.value || DEFAULT_VEHICLE_PRESET);
    renderSceneThree(store.getState());
    renderAutonomyPanel();
    updateMetrics();
  });

  byId('index3dSpeed')?.addEventListener('input', (event) => {
    setText('index3dSpeedValue', `${Number(event.target.value || 18).toFixed(0)}km/h`);
    renderAutonomyPanel();
  });

  byId('playbackSpeed')?.addEventListener('input', (event) => {
    const value = Math.max(0.25, Math.min(4, Number(event.target.value) || 1));
    setText('playbackSpeedValue', `x${value.toFixed(2)}`);
  });

  // 木材積載（カーゴ）: index3D では未配線だったため store に反映されず、3D・軌跡・
  // 頭上クリアランスのいずれにも出ていなかった。ここで storeへ流して再描画する。
  ['index3dCargoLoad', 'index3dCargoLength', 'index3dCargoCount', 'index3dCargoWidth', 'index3dCargoPlacement']
    .forEach((id) => byId(id)?.addEventListener('change', applyCargoFromUi));
  // 起動時の既定値も store へ反映（このあと bootstrap が renderSceneThree する）。
  applyCargoFromUi({ render: false });

  byId('rwApply')?.addEventListener('click', () => {
    try { applyWidthOverrideFromUi(); } catch (e) { console.error(e); toast(e.message || String(e)); }
  });
  byId('rwReset')?.addEventListener('click', () => {
    try { resetWidthOverrideFromUi(); } catch (e) { console.error(e); toast(e.message || String(e)); }
  });
  byId('roadSegSurfaceApply')?.addEventListener('click', () => {
    applyRoadSegSurfaceFromUi().catch((e) => { console.error(e); toast(e.message || String(e)); });
  });
  byId('roadSegSurfaceClear')?.addEventListener('click', () => {
    try { clearRoadSegSurfaceFromUi(); } catch (e) { console.error(e); toast(e.message || String(e)); }
  });
  const perceptionRunBtn = byId('perceptionRun');
  if (perceptionRunBtn && !streetViewYoloEnabled()) {
    perceptionRunBtn.disabled = true;
    perceptionRunBtn.title = '商用クリーン設定では無効です。社内検証時のみ INDEX3D_ENABLE_STREETVIEW_YOLO=true にしてください。';
  }
  perceptionRunBtn?.addEventListener('click', () => {
    runRealPerceptionFusion().catch((e) => { console.error(e); toast(e.message || String(e)); });
  });
  byId('perceptionRealRun')?.addEventListener('click', () => {
    try { runPerceptionFusion(); } catch (e) { console.error(e); toast(e.message || String(e)); }
  });
  byId('perceptionClear')?.addEventListener('click', () => {
    try { clearPerceptionFusion(); } catch (e) { console.error(e); toast(e.message || String(e)); }
  });

  byId('diagToggle')?.addEventListener('click', () => {
    document.body.classList.toggle('diag-open');
    syncDiagToggle();
  });
  byId('mapDetailPreset')?.addEventListener('change', (e) => {
    applyMapDetailPreset(e.target.value);
    logLine(`地図表示: ${e.target.value}`);
  });

  byId('chibanButton')?.addEventListener('click', onChibanConvert);
  byId('chibanInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); onChibanConvert(); }
  });

  wireAppearanceControls();

  window.addEventListener('resize', () => {
    try { resizeThree3D(); } catch (e) { }
  });
}

// 外観調整: 各要素のスライダー（建物 塗り/屋根/輪郭の濃さ・不透明度、道路面の濃さ）と
// 表示/非表示トグルを配線。表示トグルは既存の Advanced layers チェックボックスへ同期させる。
function wireAppearanceControls() {
  const bindRange = (id, valId, decimals, fn) => {
    const el = byId(id);
    if (!el) return;
    const upd = () => {
      const v = Number(el.value);
      if (valId) setText(valId, v.toFixed(decimals));
      fn(v);
    };
    el.addEventListener('input', upd);
    upd(); // 起動時に既定値を反映（window.* を初期化）
  };
  bindRange('bldgEdgeDark', 'bldgEdgeDarkVal', 2, (v) => setThreeBuildingAppearance({ edgeDarkness: v }));
  bindRange('bldgEdgeOpacity', 'bldgEdgeOpacityVal', 2, (v) => setThreeBuildingAppearance({ edgeOpacity: v }));
  bindRange('bldgFill', 'bldgFillVal', 2, (v) => setThreeBuildingAppearance({ fillOpacity: v }));
  bindRange('bldgRoof', 'bldgRoofVal', 2, (v) => setThreeBuildingAppearance({ roofOpacity: v }));
  bindRange('appRoadAlpha', 'appRoadAlphaVal', 2, (v) => {
    setThreeRoadSurfaceAlpha(v);
    // 3D World 側の道路面スライダーとも値を合わせる。
    const other = byId('roadSurfaceAlpha');
    if (other && Number(other.value) !== v) other.value = String(v);
    setText('roadSurfaceAlphaValue', v.toFixed(2));
  });
  bindRange('appPlateauOpacity', 'appPlateauOpacityVal', 2, (v) => setThreePlateauOpacity(v));

  // 表示/非表示: Advanced layers の同名チェックボックスと双方向同期して一元化。
  document.querySelectorAll('.appvis[data-vis]').forEach((cb) => {
    const tag = cb.dataset.vis;
    const adv = document.querySelector(`.three-road-layer[data-three-layer="${tag}"]`);
    cb.addEventListener('change', () => {
      if (adv) {
        if (adv.checked !== cb.checked) {
          adv.checked = cb.checked;
          adv.dispatchEvent(new Event('change', { bubbles: true }));
        }
      } else {
        setThreeRoadLayerVisible(tag, cb.checked);
      }
    });
    // Advanced 側やプリセットで切り替わったらこのトグルにも反映（再ディスパッチはしない）。
    if (adv) adv.addEventListener('change', () => { if (cb.checked !== adv.checked) cb.checked = adv.checked; });
  });
}

// 地番変換（ゼンリンZIPS）: 地番 → 住所＋座標。成功したら地図をその地点へ移動しマーカー表示。
async function onChibanConvert() {
  const input = byId('chibanInput');
  const btn = byId('chibanButton');
  const query = input?.value?.trim();
  if (!query) { toast('地番を入力してください'); return; }

  const setChibanStatus = (msg) => setText('chibanStatus', msg);
  if (btn) btn.disabled = true;
  setChibanStatus('地番変換中…');
  try {
    const r = await chibanToAddress(query);
    if (!r.hit || r.lat == null || r.lng == null) {
      setChibanStatus('該当する地番が見つかりませんでした。');
      toast('地番変換: 該当なし');
      return;
    }
    setChibanStatus(`住所: ${r.address}\n座標: ${r.lat.toFixed(7)}, ${r.lng.toFixed(7)}`);
    focusTo(r.lat, r.lng, 18);
    setSearchMarker(r.lat, r.lng, r.address || query);
    toast(`📍 ${r.address || '地番変換成功'}`);
    logLine(`地番変換: ${query} → ${r.address} (${r.lat}, ${r.lng})`);
  } catch (e) {
    console.error('[chiban] convert failed', e);
    setChibanStatus(`エラー: ${e.message}`);
    toast(`地番変換エラー: ${e.message}`);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// UIの木材積載設定を store へ反映。store.cargoLength は mm 単位なので、
// 入力(メートル)を ×1000 する。widthMm はそのまま mm。
function applyCargoFromUi({ render = true } = {}) {
  store.setCargoConfig({
    loadType: byId('index3dCargoLoad')?.value || 'none',
    length: (Number(byId('index3dCargoLength')?.value) || 6) * 1000,
    count: Number(byId('index3dCargoCount')?.value) || 1,
    widthMm: Number(byId('index3dCargoWidth')?.value) || 1000,
    placement: byId('index3dCargoPlacement')?.value || 'center'
  });
  if (!render) return;
  renderSceneThree(store.getState());
  renderSolidPanel();
  renderAutonomyPanel();
  updateMetrics();
}

function fillVehicleOptions() {
  const select = byId('vehiclePreset');
  if (!select) return;
  select.innerHTML = '';
  for (const [key, preset] of Object.entries(VEHICLE_PRESETS)) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = preset.label || key;
    if (key === DEFAULT_VEHICLE_PRESET) opt.selected = true;
    select.appendChild(opt);
  }
}

function exposeTestHooks() {
  window.index3DRunDemo = async () => {
    setDemoInputs();
    await buildDemoRoute({ autoWorld: true });
    run3D();
    return window.index3DStats;
  };
  window.index3DLoadRoute = loadWorldAfterExistingConfirm;
  window.index3DLoadWorld = loadWorldForRoute;
  // L4SIM回帰用: 任意の経路点列を直接確定する（OSRM不使用・決定論）。
  // points: [{lat,lng},...] または [[lng,lat],...]。確定後に compiled world を読むこと。
  window.index3DSetRoute = (points) => {
    const raw = (Array.isArray(points) ? points : [])
      .map((p) => Array.isArray(p) ? { lat: Number(p[1]), lng: Number(p[0]) } : { lat: Number(p?.lat), lng: Number(p?.lng) })
      .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
    // 連続重複点（<5cm）は除去する。ゼロ長セグメントが物理ポーズ生成を発散させ、
    // 132mのルートが14kmのポーズ経路に化ける実測バグの防御（teacher-site-0001）。
    const pts = [];
    for (const q of raw) {
      const prev = pts[pts.length - 1];
      if (prev) {
        const dlat = (q.lat - prev.lat) * 111320;
        const dlng = (q.lng - prev.lng) * 111320 * Math.cos(q.lat * Math.PI / 180);
        if (Math.hypot(dlat, dlng) < 0.05) continue;
      }
      pts.push(q);
    }
    const rr = buildDirectRouteResult(pts, 4);
    if (!rr) throw new Error('index3DSetRoute: 2点以上の経路点が必要です');
    applyRoute(rr, [{ ...pts[0], name: 'test-start' }, { ...pts[pts.length - 1], name: 'test-goal' }], 'test');
    const applied = store.getState().simRoute || [];
    let lengthM = 0;
    for (let i = 1; i < applied.length; i++) {
      const dlat = (applied[i].lat - applied[i - 1].lat) * 111320;
      const dlng = (applied[i].lng - applied[i - 1].lng) * 111320 * Math.cos(applied[i].lat * Math.PI / 180);
      lengthM += Math.hypot(dlat, dlng);
    }
    return { points: applied.length, lengthM: Math.round(lengthM * 10) / 10 };
  };
  // Phase1: コンパイル済みワールド(runtime/worlds/world_<hash>.json)の読み込み口（hash検証つき）。
  // 例: fetch('runtime/worlds/world_xxxx.json').then(r=>r.json()).then(window.index3DLoadCompiledWorld)
  // loadWorldForRoute と同じ読込後処理（worldLoaded・再描画・パネル・メトリクス）を通すこと。
  window.index3DLoadCompiledWorld = async (jsonOrObj) => {
    const { applyWorldToStore } = await import('./world/worldLoader.js');
    const info = applyWorldToStore(jsonOrObj, store);
    state.worldLoaded = true;
    renderSceneThree(store.getState());
    renderRoadWidthPanel();
    renderSolidPanel();
    renderAutonomyPanel();
    updateMetrics();
    setStatus(`コンパイル済みワールドを読み込みました (hash=${info.hash})`);
    logLine(`コンパイル済みワールド読込: hash=${info.hash} roads=${info.roads} buildings=${info.buildings} regulations=${info.regulations}`);
    return info;
  };
  window.index3DPlay = run3D;
  window.__index3d_renderSceneThree = () => renderSceneThree(store.getState());
  window.index3DGetStats = () => { updateMetrics(); return window.index3DStats; };
  window.index3DGetAutonomyReport = () => state.lastAutonomyReport || buildCurrentAutonomyReport();
  window.index3DGetPlateauMetrics = () => getPlateauTilesMetrics();
  window.index3DGetSafetyMetrics = () => getSafetyMonitorMetrics();
  window.index3DGetSafetyTrace = () => window.INDEX3D_SAFETY_LAST_TRACE || null;

  // 道路幅検証フック
  window.index3DGetRoadWidthReport = () => {
    const roads = store.getState().geoJsonDataSets || [];
    return {
      summary: summarizeRoadWidths(roads),
      rows: buildRoadWidthRows(roads, {
        defaultRoadWidth: vehicleDefaultRoadWidth(),
        overrides: store.getState().widthOverrides || {},
        limit: 1000
      })
    };
  };
  window.index3DGetRoadSurfaceMetrics = () => getRoadSurfaceMetrics();
  window.index3DApplyWidthOverride = (id, widthM) => {
    store.applyWidthOverride(id, Number(widthM));
    renderSceneThree(store.getState());
    renderRoadWidthPanel();
    renderSolidPanel();
    renderAutonomyPanel();
    updateMetrics();
    return getRoadSurfaceMetrics();
  };
  window.index3DGetClearanceSolidReport = () => buildCurrentSolidReport();
  window.index3DRunPhase3Validation = runPhase3Validation;
  window.index3DRunPhase4Validation = runPhase4Validation;

  // Street View / YOLO 検証フック
  window.index3DRunPerceptionFixture = () => runPerceptionFusion();
  window.index3DRunRealPerceptionScan = () => runRealPerceptionFusion();
  window.index3DBuildStreetViewPerceptionScan = () => buildPerceptionScanFromStreetViewFrames(
    getStreetViewFrames(),
    store.getState().geoJsonDataSets || [],
    store.getState().simRoute || []
  );
  window.index3DBuildStreetViewPerceptionScanFromFrames = (frames) => buildPerceptionScanFromStreetViewFrames(
    Array.isArray(frames) ? frames : [],
    store.getState().geoJsonDataSets || [],
    store.getState().simRoute || []
  );
  window.index3DRunPerceptionFromStreetViewFrames = (frames) => {
    const scan = buildPerceptionScanFromStreetViewFrames(
      Array.isArray(frames) ? frames : [],
      store.getState().geoJsonDataSets || [],
      store.getState().simRoute || []
    );
    return runPerceptionFusion({ preferStreetView: true, scanOverride: scan });
  };
  window.index3DGetPerceptionReport = () => state.lastPerceptionReport;
  window.index3DClearPerception = () => {
    clearPerceptionFusion();
    return summarizeRoadWidths(store.getState().geoJsonDataSets || []);
  };
  window.index3DRunPhase5Validation = runPhase5Validation;
  window.index3DRunPhase7Validation = runPhase7Validation;
  window.index3DRunPhase7PlaybackValidation = runPhase7PlaybackValidation;
}

function initAccordion() {
  const defaultCollapsed = ['road-width-section', 'solid-section', 'log-section'];
  document.querySelectorAll('.index3d-control .control-section').forEach((sec) => {
    const h2 = sec.querySelector(':scope > h2');
    if (!h2) return;
    sec.classList.add('accordion');
    if (defaultCollapsed.some((c) => sec.classList.contains(c))) sec.classList.add('collapsed');
    h2.setAttribute('role', 'button');
    h2.setAttribute('tabindex', '0');
    h2.setAttribute('aria-expanded', String(!sec.classList.contains('collapsed')));
    const toggle = () => {
      const collapsed = sec.classList.toggle('collapsed');
      h2.setAttribute('aria-expanded', String(!collapsed));
    };
    h2.addEventListener('click', toggle);
    h2.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
  });
}

async function bootstrap() {
  console.log('[index3D] bootstrap start');
  fillVehicleOptions();
  setDemoInputs();
  store.applyVehiclePreset(DEFAULT_VEHICLE_PRESET);
  initMap2D('map');
  initThree3D();
  initControls();
  initThreeRoadLayerControls();
  initThreeDiagnosticControls();
  wireControls();
  initAccordion();
  exposeTestHooks();
  exposeRoadSegDebug();
  openThree3D();
  renderSceneThree(store.getState());
  const map = getMapInstance();
  if (map) setTimeout(() => map.invalidateSize(), 200);
  store.subscribe(() => updateMetrics());
  window.store = store;
  window.index3DReady = true;
  updateMetrics();
  setStatus('準備完了。左の経路マップから始めてください。');
  logLine('index3D 準備完了。');
}

bootstrap().catch((e) => {
  console.error('[index3D] bootstrap failed:', e);
  setStatus(`起動に失敗しました: ${e.message}`);
  toast(`起動に失敗しました: ${e.message}`);
});
