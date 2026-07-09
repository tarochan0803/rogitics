import { DEFAULT_VEHICLE_CONFIG, DEFAULT_VEHICLE_PRESET, buildVehicleConfig } from './config.js';
import { analyzeContactFeasibility, analyzeFeasibility } from './core/feasibility.js';

import { loadOverrides, saveOverrides, normalizeOverrides } from './utils/widthOverrides.js';
import { loadMaskEdits, saveMaskEdits, normalizeMaskEdits } from './utils/maskEdits.js';

const subscribers = new Set();

const initialState = {
  geoJsonDataSets: [],
  sidewalkGeoJSON: [],
  buildingsGeoJSON: [],
  selectedEndpoints: [],
  selectedRoadRoute: [],
  simRoute: [],
  routeCandidates: [],
  routeMeta: null,
  vehicleConfig: { ...DEFAULT_VEHICLE_CONFIG },
  vehiclePresetName: DEFAULT_VEHICLE_PRESET,
  isWidthEditMode: false,
  selectedRoadFeatureId: null,
  widthOverrides: loadOverrides(),
  isMaskEditMode: false,
  selectedMaskEditKey: null,
  maskEdits: loadMaskEdits(),
  feasibilityMode: 'coverage',
  collisionResults: null,
  deliveryAssessment: null,
  cargoLoadType: 'none',
  cargoLength: 6000,
  cargoCount: 1,
  cargoPlacement: 'center', // 'left' | 'center' | 'right' — 荷台幅方向の積載位置
  cargoWidthMm: 1000,       // 木材総幅 (mm)
  driverSkill: 1.0,
  _lastSweepGeo: null,
  _lastFeasibilityLayers: null,
  _lastFeasibilityResult: null,
  roadDataSource: 'hybrid'
};

let state = cloneState(initialState);

function cloneState(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function snapshot() {
  // 既知プロパティは適切にコピー（配列・オブジェクトはシャローコピー）
  const base = {
    geoJsonDataSets: [...state.geoJsonDataSets],
    sidewalkGeoJSON: [...(state.sidewalkGeoJSON || [])],
    buildingsGeoJSON: [...(state.buildingsGeoJSON || [])],
    selectedEndpoints: state.selectedEndpoints.map((p) => ({ ...p })),
    selectedRoadRoute: (state.selectedRoadRoute || []).map((p) => ({ ...p })),
    simRoute: state.simRoute.map((p) => ({ ...p })),
    routeCandidates: (state.routeCandidates || []).map((c) => ({
      ...c,
      route: (c.route || []).map((p) => ({ ...p })),
      selectionRoute: (c.selectionRoute || []).map((p) => ({ ...p }))
    })),
    routeMeta: state.routeMeta ? { ...state.routeMeta } : null,
    vehicleConfig: { ...state.vehicleConfig },
    vehiclePresetName: state.vehiclePresetName,
    isWidthEditMode: state.isWidthEditMode,
    selectedRoadFeatureId: state.selectedRoadFeatureId,
    widthOverrides: { ...(state.widthOverrides || {}) },
    isMaskEditMode: state.isMaskEditMode,
    selectedMaskEditKey: state.selectedMaskEditKey,
    maskEdits: normalizeMaskEdits(state.maskEdits),
    feasibilityMode: state.feasibilityMode,
    collisionResults: state.collisionResults,
    deliveryAssessment: state.deliveryAssessment,
    cargoLoadType: state.cargoLoadType,
    cargoLength: state.cargoLength,
    cargoCount: state.cargoCount,
    cargoPlacement: state.cargoPlacement,
    cargoWidthMm: state.cargoWidthMm,
    driverSkill: state.driverSkill,
    _lastSweepGeo: state._lastSweepGeo,
    _lastFeasibilityLayers: state._lastFeasibilityLayers,
    _lastFeasibilityResult: state._lastFeasibilityResult,
    roadDataSource: state.roadDataSource
  };
  // initialState に追加されたが snapshot() 未対応のプロパティを自動補完
  for (const key of Object.keys(state)) {
    if (!(key in base)) {
      base[key] = state[key];
    }
  }
  return base;
}

function notify() {
  const current = snapshot();
  subscribers.forEach((fn) => fn(current));
}

function setState(partial) {
  state = { ...state, ...partial };
  notify();
}

function setGeoJsonDataSets(features = []) {
  const overrides = normalizeOverrides(state.widthOverrides);
  const next = applyWidthOverridesToFeatures(features, overrides);
  setState({ geoJsonDataSets: next });
}

function setSidewalkGeoJSON(features = []) {
  const arr = Array.isArray(features) ? features : [];
  setState({ sidewalkGeoJSON: arr });
}

function setBuildingsGeoJSON(features = []) {
  const arr = Array.isArray(features) ? features : [];
  setState({ buildingsGeoJSON: arr });
}

function clearEvaluationState() {
  return {
    collisionResults: null,
    deliveryAssessment: null,
    _lastSweepGeo: null,
    _lastFeasibilityLayers: null,
    _lastFeasibilityResult: null
  };
}

function clearRouteState() {
  return {
    selectedRoadRoute: [],
    simRoute: [],
    routeCandidates: [],
    routeMeta: null,
    ...clearEvaluationState()
  };
}

function setSelectedEndpoints(endpoints = []) {
  const nextEndpoints = endpoints.map((p) => ({ ...p }));
  setState({
    selectedEndpoints: nextEndpoints,
    ...clearRouteState()
  });
}

function addEndpoint(endpoint) {
  const id = endpoint.id ?? createEndpointId();
  const entry = { ...endpoint, id };
  const next = state.selectedEndpoints.filter((p) => p.id !== id);
  next.push(entry);
  setState({
    selectedEndpoints: next,
    ...clearRouteState()
  });
  return entry;
}

function insertEndpoint(index, endpoint) {
  const id = endpoint.id ?? createEndpointId();
  const entry = { ...endpoint, id };
  const next = [...state.selectedEndpoints];
  next.splice(index, 0, entry);
  setState({
    selectedEndpoints: next,
    ...clearRouteState()
  });
  return entry;
}

function updateEndpoint(id, patch) {
  const next = state.selectedEndpoints.map((p) => (p.id === id ? { ...p, ...patch } : p));
  setState({
    selectedEndpoints: next,
    ...clearRouteState()
  });
}

function removeEndpoint(id) {
  const next = state.selectedEndpoints.filter((p) => p.id !== id);
  setState({
    selectedEndpoints: next,
    ...clearRouteState()
  });
}

function clearEndpoints() {
  setState({
    selectedEndpoints: [],
    ...clearRouteState()
  });
}

function setRouteSelection(route = []) {
  setState({
    selectedRoadRoute: route.map((p) => ({ ...p })),
    simRoute: [],
    routeCandidates: [],
    routeMeta: null,
    ...clearEvaluationState()
  });
}

function setSimRoute(route = []) {
  setState({
    simRoute: route.map((p) => ({ ...p })),
    routeCandidates: [],
    routeMeta: null,
    ...clearEvaluationState()
  });
}

function normalizeRouteCandidates(candidates = []) {
  return (Array.isArray(candidates) ? candidates : [])
    .filter((c) => Array.isArray(c?.route) && c.route.length >= 2)
    .map((c) => ({
      ...c,
      route: c.route.map((p) => ({ ...p })),
      selectionRoute: Array.isArray(c.selectionRoute) ? c.selectionRoute.map((p) => ({ ...p })) : []
    }));
}

function setRoutePlan({ selectionRoute = [], trajectoryRoute = [], candidates = [], routeMeta = null } = {}) {
  setState({
    selectedRoadRoute: selectionRoute.map((p) => ({ ...p })),
    simRoute: trajectoryRoute.map((p) => ({ ...p })),
    routeCandidates: normalizeRouteCandidates(candidates),
    routeMeta: routeMeta ? { ...routeMeta } : null,
    ...clearEvaluationState()
  });
}

function resetRoute({ keepEndpoints = true } = {}) {
  setState({
    selectedEndpoints: keepEndpoints ? state.selectedEndpoints : [],
    ...clearRouteState()
  });
}

function setVehicleConfig(config) {
  setState({
    vehicleConfig: { ...state.vehicleConfig, ...config },
    ...clearEvaluationState()
  });
}

function applyVehiclePreset(name = DEFAULT_VEHICLE_PRESET) {
  const nextConfig = buildVehicleConfig(name);
  setState({
    vehicleConfig: nextConfig,
    vehiclePresetName: name,
    ...clearEvaluationState()
  });
}

function getState() {
  return snapshot();
}

function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

function createEndpointId() {
  return `ep-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function featureIdOf(feature) {
  if (!feature) return null;
  if (feature.id != null) return String(feature.id);
  const pid = feature.properties?.id;
  if (pid != null) return String(pid);
  return null;
}

function getTagsContainer(feature) {
  const props = feature?.properties && typeof feature.properties === 'object' ? feature.properties : {};
  const tags = props.tags && typeof props.tags === 'object' ? props.tags : null;
  return { props, tags };
}

function withWidthAi(feature, widthM, confidence) {
  const w = typeof widthM === 'number' ? widthM : Number(widthM);
  if (!Number.isFinite(w)) return feature;
  // 項目4: 検出スコア由来の信頼度があれば width_ai_confidence として併記する。
  // roadWidthModel.js の confidenceFromTags(['width_ai_confidence', ...]) がこれを拾い、
  // 固定 0.75 ではなくこの値で融合する。範囲外/未指定なら従来どおり既定信頼度になる。
  const c = Number(confidence);
  const hasConf = Number.isFinite(c) && c > 0 && c <= 1;
  const { props, tags } = getTagsContainer(feature);
  if (tags) {
    const nextTags = { ...tags, width_ai: w };
    if (hasConf) nextTags.width_ai_confidence = c;
    return { ...feature, properties: { ...props, tags: nextTags } };
  }
  const nextProps = { ...props, width_ai: w };
  if (hasConf) nextProps.width_ai_confidence = c;
  return { ...feature, properties: nextProps };
}

function withoutWidthAi(feature) {
  const { props, tags } = getTagsContainer(feature);
  if (tags) {
    const nextTags = { ...tags };
    delete nextTags.width_ai;
    delete nextTags.width_ai_confidence;
    return { ...feature, properties: { ...props, tags: nextTags } };
  }
  const nextProps = { ...props };
  delete nextProps.width_ai;
  delete nextProps.width_ai_confidence;
  return { ...feature, properties: nextProps };
}

// 手動上書きは roadWidthModel の最優先 `userOverrideWidth`（信頼度1.0・manual policy）に書く。
// YOLO 推定の width_ai（0.75）とは別フィールドにし、人が衛星画像を見て決めた車道幅が
// 保守融合や applyWidthRisk に下げられず、OSM width にも負けず authoritative になるようにする。
function withUserOverride(feature, widthM) {
  const w = typeof widthM === 'number' ? widthM : Number(widthM);
  if (!Number.isFinite(w)) return feature;
  const { props, tags } = getTagsContainer(feature);
  if (tags) {
    const nextTags = { ...tags, userOverrideWidth: w };
    return { ...feature, properties: { ...props, tags: nextTags } };
  }
  return { ...feature, properties: { ...props, userOverrideWidth: w } };
}

function withoutUserOverride(feature) {
  const { props, tags } = getTagsContainer(feature);
  if (tags) {
    const nextTags = { ...tags };
    delete nextTags.userOverrideWidth;
    return { ...feature, properties: { ...props, tags: nextTags } };
  }
  const nextProps = { ...props };
  delete nextProps.userOverrideWidth;
  return { ...feature, properties: nextProps };
}

function applyWidthOverridesToFeatures(features = [], overrides = {}) {
  const arr = Array.isArray(features) ? features : [];
  const normalized = normalizeOverrides(overrides);
  return arr.map((f) => {
    // YOLO の width_ai は温存し、手動上書きだけ付け替える（両者は別ソースとして共存）。
    const base = withoutUserOverride(f);
    const id = featureIdOf(f);
    if (!id) return base;
    const w = normalized[id];
    if (w == null) return base;
    return withUserOverride(base, w);
  });
}

function recalcFeasibilityIfPossible(nextState) {
  const mode = nextState?.feasibilityMode === 'contact' ? 'contact' : 'coverage';

  if (mode === 'contact') {
    if (!nextState.simRoute || nextState.simRoute.length < 2) {
      return { layers: nextState._lastFeasibilityLayers, result: nextState._lastFeasibilityResult };
    }
    // 道路データが空の場合は古い結果を表示せずクリア（偽陽性を防ぐ）
    if (!nextState.geoJsonDataSets || !nextState.geoJsonDataSets.length) {
      return { layers: null, result: null };
    }
    const res = analyzeContactFeasibility({
      simRoute: nextState.simRoute,
      vehicleConfig: nextState.vehicleConfig,
      geoJsonDataSets: nextState.geoJsonDataSets,
      defaultRoadWidth: 6,
      clearanceMargin: 0.3,
      widthMargin: nextState.vehicleConfig.widthMargin,
      maskEdits: nextState.maskEdits
    });
    if (!res) return { layers: null, result: null }; // 古い結果を返さずクリア
    const outline = nextState?._lastSweepGeo?.outline ?? null;
    const safeRatio = Number.isFinite(res.contactRatio) ? Math.max(0, 1 - res.contactRatio) : null;
    const nextResult = {
      generatedAt: new Date().toISOString(),
      mode,
      status: res.status,
      contactCount: res.contactCount,
      totalSamples: res.totalSamples,
      contactRatio: res.contactRatio,
      coverage: safeRatio,
      threshold: 0,
      vehicleConfig: nextState.vehicleConfig,
      selectedEndpoints: nextState.selectedEndpoints,
      simRoute: nextState.simRoute,
      sweep: nextState._lastSweepGeo,
      resultGeo: {
        roadUnion: res.roadUnion,
        contactPoints: res.contactPoints
      }
    };
    const nextLayers = { roadUnion: res.roadUnion, contactPoints: res.contactPoints, outline };
    return { layers: nextLayers, result: nextResult };
  }

  const sweepGeo = nextState?._lastSweepGeo?.geo;
  if (!sweepGeo) return { layers: nextState._lastFeasibilityLayers, result: nextState._lastFeasibilityResult };
  // 道路データが空の場合は古い結果をクリア
  if (!nextState.geoJsonDataSets || !nextState.geoJsonDataSets.length) {
    return { layers: null, result: null };
  }

  const res = analyzeFeasibility({
    sweepGeo,
    geoJsonDataSets: nextState.geoJsonDataSets,
    defaultRoadWidth: 6,
    clearanceMargin: 0.3,
    coverageThreshold: 0.98,
    vehicleWidth: nextState.vehicleConfig.vehicleWidth,
    widthMargin: nextState.vehicleConfig.widthMargin,
    maskEdits: nextState.maskEdits
  });
  if (!res) return { layers: nextState._lastFeasibilityLayers, result: nextState._lastFeasibilityResult };

  const outline = nextState?._lastSweepGeo?.outline ?? null;
  const nextResult = {
    generatedAt: new Date().toISOString(),
    mode,
    status: res.status,
    coverage: res.coverage,
    threshold: res.threshold,
    vehicleConfig: nextState.vehicleConfig,
    selectedEndpoints: nextState.selectedEndpoints,
    simRoute: nextState.simRoute,
    sweep: nextState._lastSweepGeo,
    resultGeo: {
      roadUnion: res.roadUnion,
      intersect: res.intersect,
      overflow: res.overflow
    }
  };
  const nextLayers = { roadUnion: res.roadUnion, intersect: res.intersect, overflow: res.overflow, outline };
  return { layers: nextLayers, result: nextResult };
}

export const store = {
  getState,
  subscribe,
  setState,
  setGeoJsonDataSets,
  setSidewalkGeoJSON,
  setBuildingsGeoJSON,
  setSelectedEndpoints,
  addEndpoint,
  insertEndpoint,
  updateEndpoint,
  removeEndpoint,
  clearEndpoints,
  setRouteSelection,
  setSimRoute,
  setRoutePlan,
  resetRoute,
  setVehicleConfig,
  applyVehiclePreset,
  setVehiclePresetName: applyVehiclePreset,

  setRoadDataSource(source) {
    setState({ roadDataSource: source });
  },

  setCollisionResults(results) {
    setState({ collisionResults: results || null });
  },
  setDeliveryAssessment(result) {
    setState({ deliveryAssessment: result || null });
  },
  // 木材積載設定: { loadType, length(mm), count, placement('left'|'center'|'right'), widthMm }
  setCargoConfig(patch = {}) {
    const next = {};
    if (patch.loadType !== undefined) next.cargoLoadType = patch.loadType;
    if (Number.isFinite(Number(patch.length))) next.cargoLength = Number(patch.length);
    if (Number.isFinite(Number(patch.count))) next.cargoCount = Math.max(1, Math.round(Number(patch.count)));
    if (['left', 'center', 'right', 'head_out', 'diagonal'].includes(patch.placement)) next.cargoPlacement = patch.placement;
    if (Number.isFinite(Number(patch.widthMm))) next.cargoWidthMm = Math.max(100, Number(patch.widthMm));
    if (Object.keys(next).length) setState(next);
  },
  setFeasibilityMode(mode) {
    const nextMode = mode === 'contact' ? 'contact' : 'coverage';
    if (state.feasibilityMode === nextMode) return;
    const nextState = { ...state, feasibilityMode: nextMode };
    const { layers, result } = recalcFeasibilityIfPossible(nextState);
    setState({ feasibilityMode: nextMode, _lastFeasibilityLayers: layers, _lastFeasibilityResult: result });
  },
  setWidthEditMode(enabled) {
    setState({ isWidthEditMode: !!enabled });
    if (!enabled) setState({ selectedRoadFeatureId: null });
  },
  setSelectedRoadFeatureId(featureId) {
    setState({ selectedRoadFeatureId: featureId != null ? String(featureId) : null });
  },
  updateGeoJsonFeature(featureId, patchData = {}) {
    const id = featureId != null ? String(featureId) : null;
    if (!id) {
      console.warn('[store.updateGeoJsonFeature] featureId が未指定');
      return false;
    }
    const idx = state.geoJsonDataSets.findIndex((f) => featureIdOf(f) === id);
    if (idx < 0) {
      console.warn('[store.updateGeoJsonFeature] フィーチャーが見つかりません:', id);
      return false;
    }
    const cur = state.geoJsonDataSets[idx];
    let nextFeature = cur;
    if (Object.prototype.hasOwnProperty.call(patchData, 'width_ai')) {
      const v = patchData.width_ai;
      nextFeature = v == null ? withoutWidthAi(nextFeature) : withWidthAi(nextFeature, v);
    }
    const nextArr = state.geoJsonDataSets.slice();
    nextArr[idx] = nextFeature;
    const nextState = { ...state, geoJsonDataSets: nextArr };
    const { layers, result } = recalcFeasibilityIfPossible(nextState);
    setState({ geoJsonDataSets: nextArr, _lastFeasibilityLayers: layers, _lastFeasibilityResult: result });
  },
  applyWidthOverride(featureId, widthM) {
    const id = featureId != null ? String(featureId) : null;
    const w = typeof widthM === 'number' ? widthM : Number(widthM);
    if (!id || !Number.isFinite(w)) return;
    const nextOverrides = { ...(state.widthOverrides || {}) };
    nextOverrides[id] = w;
    saveOverrides(nextOverrides);
    const idx = state.geoJsonDataSets.findIndex((f) => featureIdOf(f) === id);
    const nextArr = state.geoJsonDataSets.slice();
    if (idx >= 0) nextArr[idx] = withUserOverride(nextArr[idx], w);
    const nextState = { ...state, geoJsonDataSets: nextArr, widthOverrides: nextOverrides };
    const { layers, result } = recalcFeasibilityIfPossible(nextState);
    setState({ geoJsonDataSets: nextArr, widthOverrides: nextOverrides, _lastFeasibilityLayers: layers, _lastFeasibilityResult: result });
  },
  resetWidthOverride(featureId) {
    const id = featureId != null ? String(featureId) : null;
    if (!id) return;
    const nextOverrides = { ...(state.widthOverrides || {}) };
    delete nextOverrides[id];
    saveOverrides(nextOverrides);
    const idx = state.geoJsonDataSets.findIndex((f) => featureIdOf(f) === id);
    const nextArr = state.geoJsonDataSets.slice();
    if (idx >= 0) nextArr[idx] = withoutUserOverride(nextArr[idx]);
    const nextState = { ...state, geoJsonDataSets: nextArr, widthOverrides: nextOverrides };
    const { layers, result } = recalcFeasibilityIfPossible(nextState);
    setState({ geoJsonDataSets: nextArr, widthOverrides: nextOverrides, _lastFeasibilityLayers: layers, _lastFeasibilityResult: result });
  },
  setWidthOverrides(overrides, { replace = false } = {}) {
    const incoming = normalizeOverrides(overrides);
    const nextOverrides = replace ? incoming : { ...(state.widthOverrides || {}), ...incoming };
    saveOverrides(nextOverrides);
    const nextArr = applyWidthOverridesToFeatures(state.geoJsonDataSets, nextOverrides);
    const nextState = { ...state, geoJsonDataSets: nextArr, widthOverrides: nextOverrides };
    const { layers, result } = recalcFeasibilityIfPossible(nextState);
    setState({ geoJsonDataSets: nextArr, widthOverrides: nextOverrides, _lastFeasibilityLayers: layers, _lastFeasibilityResult: result });
  },
  clearWidthOverrides() {
    saveOverrides({});
    const nextArr = state.geoJsonDataSets.map((f) => withoutUserOverride(f));
    const nextState = { ...state, geoJsonDataSets: nextArr, widthOverrides: {} };
    const { layers, result } = recalcFeasibilityIfPossible(nextState);
    setState({ geoJsonDataSets: nextArr, widthOverrides: {}, _lastFeasibilityLayers: layers, _lastFeasibilityResult: result });
  },
  // AI(YOLO)知覚由来の幅は width_ai（信頼度0.75・推定）として一括適用する。
  // 手動上書き（userOverrideWidth・authoritative）とは別フィールドで、保守融合を素通りせず
  // OSM width / GSI / 手動上書きと正しく競合する。経路コリドーの道だけに適用される想定。
  // 値は数値（幅m）でも、{ width, confidence } でも受ける（confidence は検出スコア由来・任意）。
  applyPerceptionWidthAi(idToWidthM = {}) {
    const m = idToWidthM || {};
    const nextArr = state.geoJsonDataSets.map((f) => {
      const id = featureIdOf(f);
      if (!id) return f;
      const entry = m[id];
      if (entry == null) return f;
      const w = Number(typeof entry === 'object' ? entry.width : entry);
      if (!Number.isFinite(w) || w <= 0) return f;
      const conf = typeof entry === 'object' ? Number(entry.confidence) : NaN;
      return withWidthAi(f, w, conf);
    });
    const nextState = { ...state, geoJsonDataSets: nextArr };
    const { layers, result } = recalcFeasibilityIfPossible(nextState);
    setState({ geoJsonDataSets: nextArr, _lastFeasibilityLayers: layers, _lastFeasibilityResult: result });
  },
  clearPerceptionWidthAi(ids = []) {
    const idSet = new Set((Array.isArray(ids) ? ids : []).map((x) => String(x)));
    if (!idSet.size) return;
    const nextArr = state.geoJsonDataSets.map((f) => idSet.has(String(featureIdOf(f))) ? withoutWidthAi(f) : f);
    const nextState = { ...state, geoJsonDataSets: nextArr };
    const { layers, result } = recalcFeasibilityIfPossible(nextState);
    setState({ geoJsonDataSets: nextArr, _lastFeasibilityLayers: layers, _lastFeasibilityResult: result });
  },
  setMaskEditMode(enabled) {
    setState({ isMaskEditMode: !!enabled });
    if (!enabled) setState({ selectedMaskEditKey: null });
  },
  setSelectedMaskEditKey(key) {
    setState({ selectedMaskEditKey: key != null ? String(key) : null });
  },
  addMaskEdit(kind, feature) {
    const k = kind === 'deny' ? 'deny' : 'allow';
    const normalized = normalizeMaskEdits({ allow: state.maskEdits?.allow, deny: state.maskEdits?.deny });
    const arr = k === 'allow' ? normalized.allow.slice() : normalized.deny.slice();
    const id = feature?.properties?.id ?? feature?.id ?? null;
    if (!id) return;
    const fid = String(id);
    const cleaned = { ...feature, id: fid, properties: { ...(feature.properties || {}), id: fid } };
    const nextArr = arr.filter((f) => String(f?.properties?.id ?? f?.id ?? '') !== fid);
    nextArr.push(cleaned);
    const nextEdits = k === 'allow' ? { ...normalized, allow: nextArr } : { ...normalized, deny: nextArr };
    saveMaskEdits(nextEdits);
    const nextState = { ...state, maskEdits: nextEdits };
    const { layers, result } = recalcFeasibilityIfPossible(nextState);
    setState({ maskEdits: nextEdits, _lastFeasibilityLayers: layers, _lastFeasibilityResult: result });
  },
  removeMaskEdit(key) {
    const k = key != null ? String(key) : '';
    const sep = k.indexOf(':');
    const first = sep >= 0 ? k.slice(0, sep) : '';
    const kind = first === 'allow' || first === 'deny' ? first : '';
    const id = kind ? k.slice(sep + 1) : k;
    if (!id) return;
    const normalized = normalizeMaskEdits(state.maskEdits);
    const filter = (arr) => (arr || []).filter((f) => String(f?.properties?.id ?? f?.id ?? '') !== id);
    const nextEdits =
      kind === 'deny'
        ? { ...normalized, deny: filter(normalized.deny) }
        : kind === 'allow'
          ? { ...normalized, allow: filter(normalized.allow) }
          : { allow: filter(normalized.allow), deny: filter(normalized.deny) };
    saveMaskEdits(nextEdits);
    const nextState = { ...state, maskEdits: nextEdits, selectedMaskEditKey: null };
    const { layers, result } = recalcFeasibilityIfPossible(nextState);
    setState({ maskEdits: nextEdits, selectedMaskEditKey: null, _lastFeasibilityLayers: layers, _lastFeasibilityResult: result });
  },
  clearMaskEdits() {
    const nextEdits = { allow: [], deny: [] };
    saveMaskEdits(nextEdits);
    const nextState = { ...state, maskEdits: nextEdits, selectedMaskEditKey: null };
    const { layers, result } = recalcFeasibilityIfPossible(nextState);
    setState({ maskEdits: nextEdits, selectedMaskEditKey: null, _lastFeasibilityLayers: layers, _lastFeasibilityResult: result });
  },
  setMaskEdits(maskEdits, { replace = false } = {}) {
    const incoming = normalizeMaskEdits(maskEdits);
    const normalized = normalizeMaskEdits(state.maskEdits);
    const nextEdits = replace
      ? incoming
      : { allow: [...normalized.allow, ...incoming.allow], deny: [...normalized.deny, ...incoming.deny] };
    saveMaskEdits(nextEdits);
    const nextState = { ...state, maskEdits: nextEdits };
    const { layers, result } = recalcFeasibilityIfPossible(nextState);
    setState({ maskEdits: nextEdits, _lastFeasibilityLayers: layers, _lastFeasibilityResult: result });
  },
  setDriverSkill(skill) {
    setState({
      driverSkill: Number(skill) || 1.0,
      ...clearEvaluationState()
    });
  },
  setSweepGeo(geoObj) {
    setState({ _lastSweepGeo: geoObj });
  },
  setFeasibilityLayers(layers) {
    setState({ _lastFeasibilityLayers: layers });
  },
  setFeasibilityResult(result) {
    setState({ _lastFeasibilityResult: result });
  }
};

export { initialState, DEFAULT_VEHICLE_PRESET as initialVehiclePreset };
