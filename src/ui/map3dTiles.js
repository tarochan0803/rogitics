import { DEFAULT_VEHICLE_CONFIG, GOOGLE_3D_TILES_KEY } from '../config.js';
import { coordinateSystem, turf } from '../utils/geo.js';

let viewer = null;
let tileset = null;
let isLoaded = false;
const onLoadQueue = [];
let animId = null;
let poses = [];
const dataSources = {};
let truckEntity = null;
let lastTruckDanger = null;
let edgeStage = null;
let tilesetReady = false;
let tilesetHasTiles = false;
let tilesetWatchTimer = null;
let map3dResizeObserver = null;
let map3dContainerId = 'map3d';
let lastVehicleConfig = { ...DEFAULT_VEHICLE_CONFIG };
let imageryFallbackUsed = false;
let imageryApplyToken = 0;
let viewMode = '2d';
let cameraLockHandler = null;
const STORAGE_TILES_KEY = 'truck_google_3d_tiles_key_v2';
let flatGroundHeight = 0;
let flatGroundRect = null;
let pendingRouteForGround = null;
const FLAT_GROUND_OFFSET = 0.6;
let lastRoute = null;
let lastRoadSurfaceGeo = null;
let lastCorridorRoute = null;
let lastCorridorMeters = 120;
let lastObstaclesGeo = null;
let lastObstaclesDefaultHeight = 3;
let lastSidewalkGeo = null;
let flatGroundRefreshId = 0;

let buildingsAll = { type: 'FeatureCollection', features: [] };
let buildingsShownGeoJSON = { type: 'FeatureCollection', features: [] };
let buildingsShownCount = 0;
let isPhotorealistic = false; // Default to lightweight schematic mode

if (typeof window !== 'undefined') {
  const rawView = window.TRUCK_DEFAULT_VIEW_MODE;
  const viewPref = typeof rawView === 'string' ? rawView.trim().toLowerCase() : rawView;
  if (viewPref === '3d' || viewPref === 3 || viewPref === true) viewMode = '3d';
  const rawPhoto = window.TRUCK_DEFAULT_PHOTOREALISTIC;
  const photoPref = typeof rawPhoto === 'string' ? rawPhoto.trim().toLowerCase() : rawPhoto;
  if (photoPref === '1' || photoPref === 'true' || photoPref === 'on' || photoPref === true || photoPref === 1) {
    isPhotorealistic = true;
  }
}

const SCHEMATIC_BUILDING_COLOR = '#94a3b8';
const SCHEMATIC_BUILDING_OUTLINE = '#475569';

const ROUTE_COLOR = '#f59e0b';
const ROUTE_GLOW = '#fde68a';
const CORRIDOR_COLOR = '#fbbf24';
const ROAD_SURFACE_COLOR = '#38bdf8';
const FLAT_GROUND_COLOR = '#0f172a';
const FLAT_GROUND_OUTLINE = '#1f2937';
const OBSTACLE_COLOR = '#ef4444';
const OBSTACLE_OUTLINE = '#fecaca';
const SIDEWALK_COLOR = '#e2e8f0';
const TRUCK_SAFE_COLOR = '#14b8a6';
const TRUCK_DANGER_COLOR = '#ef4444';
const TRUCK_SAFE_OUTLINE = '#2dd4bf';
const TRUCK_DANGER_OUTLINE = '#fecaca';
const ROUTE_HEIGHT_OFFSET = 0.2;
const SURFACE_HEIGHT_OFFSET = 0.06;
const SIDEWALK_HEIGHT_OFFSET = 0.02;
const SIDEWALK_WIDTH = 2.0;
const ENABLE_TILESET_CLIP = false;
const HIDE_GLOBE_WHEN_TILES = false;
const FORCE_DARK_BACKGROUND = true;
const ENABLE_EDGE_STAGE = false;
const ENABLE_FLAT_GROUND = false;
const FORCE_FLAT_GROUND = false;
const FLAT_GROUND_FIXED_HEIGHT = 0;
const AUTODRIVE_LOOKAHEAD_POSE_STEPS = [0, 2, 4, 7, 10, 14];
const AUTODRIVE_LATERAL_CANDIDATES_M = [0, 0.35, -0.35, 0.7, -0.7, 1.05, -1.05, 1.4, -1.4, 1.85, -1.85, 2.3, -2.3];
const AUTODRIVE_OFFSET_SMOOTH = 0.32;
const AUTODRIVE_OFFSET_EPS = 0.04;
const FLAT_GROUND_ALPHA = 0.8;
const ENABLE_FXAA = false;
const RENDER_SCALE_CAP = 1.0;
const TILESET_MAX_SSE = 4.0;
const TILESET_MAX_MEMORY_MB = 512;
const TILESET_DYNAMIC_SSE = true;
const TILESET_SKIP_LOD = true;
const TILESET_LOAD_SIBLINGS = false;
const TILESET_IMMEDIATE_LOAD = false;
const TILESET_PRELOAD = false;
const TILESET_FOVEATED_SSE = 2.0;
const SATELLITE_ARCGIS_URL = 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer';
const SATELLITE_ARCGIS_TILE_URL = `${SATELLITE_ARCGIS_URL}/tile/{z}/{y}/{x}`;
const SATELLITE_GSI_TILE_URL = 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg';
const GSI_MAX_LEVEL = 18; // GSI seamlessphoto limit to avoid 404

function getCesium() {
  return typeof Cesium !== 'undefined' ? Cesium : (window.Cesium || null);
}

function toast(msg) {
  const box = document.getElementById('toast');
  if (!box) return;
  const div = document.createElement('div');
  div.className = 'toast-item';
  div.textContent = msg;
  box.appendChild(div);
  setTimeout(() => div.remove(), 3000);
}

if (typeof window !== 'undefined') {
  if (!window.GOOGLE_3D_TILES_KEY && GOOGLE_3D_TILES_KEY) {
    window.GOOGLE_3D_TILES_KEY = GOOGLE_3D_TILES_KEY;
  }
}

function normalizeTilesKey(raw) {
  if (!raw) return '';
  if (typeof raw === 'string') {
    let trimmed = raw.trim();
    if (!trimmed) return '';
    if (trimmed === '[object Object]') return '';
    if (trimmed.startsWith('Alza')) {
      trimmed = `AIza${trimmed.slice(4)}`;
    }
    return trimmed;
  }
  if (typeof raw === 'object') {
    const candidate = raw.key ?? raw.apiKey ?? raw.value;
    if (typeof candidate === 'string') return normalizeTilesKey(candidate);
  }
  return '';
}

function attachResizeObserver(container) {
  if (!container || typeof ResizeObserver === 'undefined') return;
  if (map3dResizeObserver) map3dResizeObserver.disconnect();
  let scheduled = false;
  map3dResizeObserver = new ResizeObserver(() => {
    if (!viewer || scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      try {
        viewer.resize();
      } catch (e) { }
      try {
        viewer.scene.requestRender();
      } catch (e) { }
    });
  });
  map3dResizeObserver.observe(container);
}

function getSatelliteTileOverride() {
  if (typeof window === 'undefined') return '';
  const raw = window.SATELLITE_TILE_URL || window.SATELLITE_IMAGERY_URL || '';
  if (typeof raw !== 'string') return '';
  return raw.trim();
}

function buildTemplateProvider(Cesium, url, credit, options = {}) {
  if (!Cesium?.UrlTemplateImageryProvider || !url) return null;
  const cleanCredit = typeof credit === 'string' ? credit : undefined;
  return new Cesium.UrlTemplateImageryProvider({
    url,
    credit: cleanCredit,
    ...options
  });
}

async function createGoogle2DImageryProvider(Cesium, key) {
  if (!Cesium || !key) return null;
  try {
    const resp = await fetch(`https://tile.googleapis.com/v1/createSession?key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mapType: 'satellite',
        language: 'ja',
        region: 'JP'
      })
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!data.session) return null;

    return new Cesium.UrlTemplateImageryProvider({
      url: `https://tile.googleapis.com/v1/2dtiles/{z}/{x}/{y}?session=${data.session}&key=${key}&orientation=0`,
      credit: 'Google',
      maximumLevel: 22
    });
  } catch (e) {
    console.warn('Google 2D Tiles API failed:', e);
    return null;
  }
}

function buildFallbackSatelliteProvider(Cesium) {
  if (!Cesium) return null;
  const gsi = buildTemplateProvider(Cesium, SATELLITE_GSI_TILE_URL, 'GSI', { maximumLevel: GSI_MAX_LEVEL });
  if (gsi) return gsi;
  return buildTemplateProvider(Cesium, SATELLITE_ARCGIS_TILE_URL, 'Esri');
}

function shouldUseGoogle2DTiles() {
  if (typeof window === 'undefined') return false;
  const flag = window.USE_GOOGLE_2D_TILES;
  if (flag === true || flag === '1' || flag === 'true') return true;
  return false;
}

function applySatelliteImagery({ forceFallback = false } = {}) {
  const Cesium = getCesium();
  if (!viewer || !Cesium) return;
  const token = ++imageryApplyToken;
  if (!forceFallback) imageryFallbackUsed = false;

  const applyByKey = async () => {
    // 1. Try Override
    const override = getSatelliteTileOverride();
    if (override) {
      applyProvider(buildTemplateProvider(Cesium, override, 'Satellite'));
      return;
    }

    const tilesKey = getTilesKey();
    const useTilesApi = shouldUseGoogle2DTiles();

    // 2. Try Google Map Tiles API (Session) if available.
    if (!forceFallback && useTilesApi && tilesKey) {
      const provider = await createGoogle2DImageryProvider(Cesium, tilesKey);
      if (provider && token === imageryApplyToken) {
        applyProvider(provider);
        return;
      }
    }

    // 3. Fallback to GSI / Esri
    if (token === imageryApplyToken) {
      imageryFallbackUsed = true;
      applyProvider(buildFallbackSatelliteProvider(Cesium));
    }
  };

  const applyProvider = (provider) => {
    if (!provider || !viewer?.imageryLayers || token !== imageryApplyToken) return;
    let layer = null;
    try {
      viewer.scene.globe.show = true;
      viewer.imageryLayers.removeAll(false);
      layer = viewer.imageryLayers.addImageryProvider(provider);
    } catch (e) { return; }

    if (layer) {
      layer.show = true;
      layer.alpha = 1;
    }

    // Handle provider errors (e.g. session expiry)
    if (provider.errorEvent?.addEventListener) {
      provider.errorEvent.addEventListener(() => {
        if (imageryFallbackUsed || token !== imageryApplyToken) return;
        imageryFallbackUsed = true;
        applySatelliteImagery({ forceFallback: true });
      });
    }

    // Force render
    const ready = provider.readyPromise;
    if (ready && typeof ready.then === 'function') {
      ready
        .then(() => { if (token === imageryApplyToken) viewer.scene.requestRender(); })
        .catch(() => {
          if (imageryFallbackUsed || token !== imageryApplyToken) return;
          imageryFallbackUsed = true;
          applySatelliteImagery({ forceFallback: true });
        });
    } else {
      viewer.scene.requestRender();
    }
  };

  applyByKey();
}

function resolveMap3DContainer() {
  if (typeof document === 'undefined') return null;
  if (map3dContainerId && typeof map3dContainerId !== 'string') return map3dContainerId;
  const id = map3dContainerId || 'map3d';
  return document.getElementById(id);
}

function canRenderInContainer(container) {
  if (!container || typeof container.getBoundingClientRect !== 'function') return false;
  const rect = container.getBoundingClientRect();
  return rect.width > 2 && rect.height > 2;
}

function ensureViewer() {
  if (viewer) return viewer;
  const Cesium = getCesium();
  if (!Cesium) return null;
  const container = resolveMap3DContainer();
  if (!canRenderInContainer(container)) return null;
  createViewer(container, Cesium);
  return viewer;
}

function runWhenReady(fn) {
  if (viewer && isLoaded) {
    fn();
    return;
  }
  onLoadQueue.push(fn);
}

export function onViewerReady(fn) {
  runWhenReady(fn);
}

export function getViewer() {
  return viewer;
}

export function getViewMode() {
  return viewMode;
}

function syncTopDownCamera() {
  const Cesium = getCesium();
  if (!viewer || !Cesium) return;
  const carto = viewer.camera.positionCartographic;
  if (!carto) return;
  const height = Number.isFinite(carto.height) ? carto.height : 800;
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromRadians(carto.longitude, carto.latitude, height),
    orientation: {
      heading: 0,
      pitch: -Cesium.Math.PI_OVER_TWO,
      roll: 0
    }
  });
}

function applyViewMode() {
  const Cesium = getCesium();
  if (!viewer || !Cesium) return;
  const ctrl = viewer.scene.screenSpaceCameraController;
  if (viewMode === '2d') {
    ctrl.enableTilt = false;
    ctrl.enableRotate = false;
    ctrl.enableLook = false;
    ctrl.enableTranslate = true;
    ctrl.enableZoom = true;
    syncTopDownCamera();
  } else {
    ctrl.enableTilt = true;
    ctrl.enableRotate = true;
    ctrl.enableLook = true;
    ctrl.enableTranslate = true;
    ctrl.enableZoom = true;
  }
  try {
    viewer.scene.requestRender();
  } catch (e) { }
}

function attachCameraLock() {
  if (!viewer || cameraLockHandler) return;
  cameraLockHandler = () => {
    if (viewMode !== '2d') return;
    const Cesium = getCesium();
    if (!Cesium) return;
    const pitchDiff = Math.abs(viewer.camera.pitch + Cesium.Math.PI_OVER_TWO);
    const headingDiff = Math.abs(viewer.camera.heading);
    const rollDiff = Math.abs(viewer.camera.roll);
    if (pitchDiff > 0.0005 || headingDiff > 0.0005 || rollDiff > 0.0005) {
      syncTopDownCamera();
    }
  };
  try {
    viewer.scene.preRender.addEventListener(cameraLockHandler);
  } catch (e) { }
}

export function setViewMode(mode) {
  const next = mode === '3d' ? '3d' : '2d';
  if (viewMode === next) return;
  viewMode = next;
  const Cesium = getCesium();
  if (viewer && Cesium) {
    try {
      viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    } catch (e) { }
  }
  applyViewMode();
}

export function toggleViewMode() {
  setViewMode(viewMode === '2d' ? '3d' : '2d');
}

function flushQueue() {
  const queue = onLoadQueue.splice(0);
  for (const fn of queue) {
    try {
      fn();
    } catch (e) {
      console.warn('map3d tiles op failed', e);
    }
  }
}

function getGoogle3dTilesKey() {
  if (typeof window !== 'undefined') {
    const override = window.GOOGLE_3D_TILES_KEY;
    const normalized = normalizeTilesKey(override);
    if (normalized) return normalized;
  }
  return null;
}

function getGoogleMapsScriptKey() {
  if (typeof document === 'undefined') return null;
  const script = document.querySelector('script[src*="maps.googleapis.com/maps/api/js"]');
  if (!script) return null;
  try {
    const url = new URL(script.src);
    return normalizeTilesKey(url.searchParams.get('key'));
  } catch (e) {
    return null;
  }
}

function getStoredTilesKey() {
  try {
    if (typeof localStorage === 'undefined') return null;
    const v = localStorage.getItem(STORAGE_TILES_KEY);
    const normalized = normalizeTilesKey(v);
    if (!normalized && v) localStorage.removeItem(STORAGE_TILES_KEY);
    return normalized || null;
  } catch (e) {
    return null;
  }
}

function setStoredTilesKey(key) {
  try {
    if (typeof localStorage === 'undefined') return;
    const normalized = normalizeTilesKey(key);
    if (!normalized) {
      localStorage.removeItem(STORAGE_TILES_KEY);
      return;
    }
    localStorage.setItem(STORAGE_TILES_KEY, normalized);
  } catch (e) { }
}

function getTilesKey() {
  return getStoredTilesKey() || getGoogle3dTilesKey() || getGoogleMapsScriptKey();
}

async function createTilesetWithKey(key) {
  const Cesium = getCesium();
  if (!Cesium) throw new Error('Cesium not loaded');
  const normalized = normalizeTilesKey(key);
  if (!normalized) throw new Error('3D tiles API key missing/invalid');
  const url = buildTilesUrl(normalized);
  if (!url) throw new Error('3D tiles URL missing');
  return await Cesium.Cesium3DTileset.fromUrl(url, { maximumScreenSpaceError: 2 });
}

function buildTilesUrl(key) {
  if (typeof window !== 'undefined') {
    const override = window.GOOGLE_3D_TILES_URL;
    if (typeof override === 'string' && override.trim()) return override.trim();
  }
  const normalized = normalizeTilesKey(key);
  if (!normalized) return null;
  return `https://tile.googleapis.com/v1/3dtiles/root.json?key=${encodeURIComponent(normalized)}`;
}

function updateTilesStatus(msg) {
  const el = document.getElementById('tilesStatus');
  if (el) el.textContent = msg;
}

function applyTilesetQuality(next) {
  if (!next) return;
  if (typeof next.maximumScreenSpaceError === 'number') next.maximumScreenSpaceError = TILESET_MAX_SSE;
  if (typeof next.maximumMemoryUsage === 'number') next.maximumMemoryUsage = TILESET_MAX_MEMORY_MB;
  if ('preloadWhenHidden' in next) next.preloadWhenHidden = TILESET_PRELOAD;
  if ('preloadFlightDestinations' in next) next.preloadFlightDestinations = TILESET_PRELOAD;
  if ('dynamicScreenSpaceError' in next) next.dynamicScreenSpaceError = TILESET_DYNAMIC_SSE;
  if ('dynamicScreenSpaceErrorDensity' in next) next.dynamicScreenSpaceErrorDensity = 0.0025;
  if ('dynamicScreenSpaceErrorFactor' in next) next.dynamicScreenSpaceErrorFactor = 4.0;
  if ('dynamicScreenSpaceErrorHeightFalloff' in next) next.dynamicScreenSpaceErrorHeightFalloff = 0.25;
  if ('skipLevelOfDetail' in next) next.skipLevelOfDetail = TILESET_SKIP_LOD;
  if ('skipScreenSpaceErrorFactor' in next) next.skipScreenSpaceErrorFactor = 16;
  if ('skipLevels' in next) next.skipLevels = 1;
  if ('loadSiblings' in next) next.loadSiblings = TILESET_LOAD_SIBLINGS;
  if ('immediatelyLoadDesiredLevelOfDetail' in next) next.immediatelyLoadDesiredLevelOfDetail = TILESET_IMMEDIATE_LOAD;
  if ('cullWithChildrenBounds' in next) next.cullWithChildrenBounds = true;
  if ('foveatedScreenSpaceError' in next) next.foveatedScreenSpaceError = TILESET_FOVEATED_SSE;
  if ('foveatedConeSize' in next) next.foveatedConeSize = 0.25;
  if ('foveatedMinimumScreenSpaceErrorRelaxation' in next) next.foveatedMinimumScreenSpaceErrorRelaxation = 0.4;
  if ('progressiveResolutionHeightFraction' in next) next.progressiveResolutionHeightFraction = 0.5;
}

function ensureEdgeStage() {
  const Cesium = getCesium();
  if (!ENABLE_EDGE_STAGE || !viewer || !Cesium || edgeStage) return;
  if (!Cesium.PostProcessStageLibrary?.createEdgeDetectionStage) return;
  try {
    edgeStage = Cesium.PostProcessStageLibrary.createEdgeDetectionStage();
    edgeStage.uniforms.color = Cesium.Color.WHITE.withAlpha(0.6);
    edgeStage.uniforms.length = 0.02;
    edgeStage.enabled = true;
    viewer.scene.postProcessStages.add(edgeStage);
  } catch (e) {
    edgeStage = null;
  }
}

function updateEdgeSelection() {
  if (!edgeStage) return;
  try {
    edgeStage.selected = tileset ? [tileset] : [];
  } catch (e) { }
}

function watchTilesetLoad(next) {
  const Cesium = getCesium();
  if (!viewer || !next || !Cesium) return;
  tilesetReady = false;
  tilesetHasTiles = false;
  if (tilesetWatchTimer) clearTimeout(tilesetWatchTimer);

  try {
    const markTilesVisible = () => {
      if (!tilesetHasTiles) {
        tilesetHasTiles = true;
        updateTilesStatus('3D Tiles: streaming...');
        if (HIDE_GLOBE_WHEN_TILES) {
          try {
            viewer.scene.globe.show = false;
          } catch (e) { }
          try {
            viewer.imageryLayers?.removeAll?.();
          } catch (e) { }
        }
        updateEdgeSelection();
      }
      try {
        viewer.scene.requestRender();
      } catch (e) { }
    };
    if (next.tileVisible?.addEventListener) {
      next.tileVisible.addEventListener(markTilesVisible);
    } else {
      next.tileLoad?.addEventListener?.(markTilesVisible);
    }
  } catch (e) { }

  try {
    next.allTilesLoaded?.addEventListener?.(() => {
      updateTilesStatus('3D Tiles: loaded');
    });
  } catch (e) { }

  try {
    next.tileFailed?.addEventListener?.((err) => {
      console.warn('3D Tiles tile failed', err);
      updateTilesStatus('3D Tiles: tile failed (check API key)');
      try {
        viewer.scene.globe.show = true;
      } catch (e) { }
    });
  } catch (e) { }

  try {
    const readyPromise = next.readyPromise;
    if (readyPromise && typeof readyPromise.then === 'function') {
      readyPromise
        .then(() => {
          tilesetReady = true;
          if (!tilesetHasTiles) updateTilesStatus('3D Tiles: ready');
          updateEdgeSelection();
          if (pendingRouteForGround || lastRoute) refreshFlatGround(pendingRouteForGround || lastRoute);
          try {
            viewer.zoomTo(next);
          } catch (e) { }
        })
        .catch((err) => {
          console.warn('3D Tiles ready failed', err);
          updateTilesStatus('3D Tiles: load failed (check API key)');
          try {
            viewer.scene.globe.show = true;
          } catch (e) { }
        });
    }
  } catch (e) { }

  tilesetWatchTimer = setTimeout(() => {
    if (!tilesetHasTiles) {
      updateTilesStatus('3D Tiles: no tiles (check API key/referrer)');
      try {
        viewer.scene.globe.show = true;
      } catch (e) { }
    }
  }, 4000);
}

async function loadTilesetWithKey(key) {
  const Cesium = getCesium();
  if (!Cesium) return;
  if (!isPhotorealistic) {
    if (tileset) {
      try {
        viewer?.scene?.primitives?.remove?.(tileset);
      } catch (e) { }
      try {
        if (typeof tileset.destroy === 'function') tileset.destroy();
      } catch (e) { }
      tileset = null;
    }
    tilesetReady = false;
    tilesetHasTiles = false;
    if (tilesetWatchTimer) {
      clearTimeout(tilesetWatchTimer);
      tilesetWatchTimer = null;
    }
    updateTilesStatus('3D Tiles: off');
    return;
  }
  if (!viewer && !ensureViewer()) {
    updateTilesStatus('3D Tiles: open the 3D panel to initialize');
    return;
  }

  // If not in photorealistic mode, just ensure tileset is removed and update status
  if (!isPhotorealistic) {
    if (tileset) {
      try { viewer.scene.primitives.remove(tileset); } catch (e) { }
      tileset = null;
    }
    updateTilesStatus('3D Tiles: off');
    return;
  }

  const trimmed = normalizeTilesKey(key);
  if (!trimmed) {
    updateTilesStatus('3D Tiles: API key required (Map Tiles API)');
    return;
  }
  if (trimmed.startsWith('Alza')) {
    console.warn('API Key likely has a typo: "Alza" should be "AIza"');
    updateTilesStatus('3D Tiles: Key typo detected (Alza -> AIza)');
  }

  if (tileset) {
    try {
      viewer.scene.primitives.remove(tileset);
    } catch (e) { }
    try {
      if (typeof tileset.destroy === 'function') tileset.destroy();
    } catch (e) { }
    tileset = null;
  }
  tilesetReady = false;
  tilesetHasTiles = false;
  if (tilesetWatchTimer) {
    clearTimeout(tilesetWatchTimer);
    tilesetWatchTimer = null;
  }

  updateTilesStatus('3D Tiles: loading...');
  try {
    try {
      viewer.scene.globe.show = true;
    } catch (e) { }
    tileset = await createTilesetWithKey(trimmed);
    applyTilesetQuality(tileset);
    viewer.scene.primitives.add(tileset);
    ensureEdgeStage();
    watchTilesetLoad(tileset);
    try {
      await viewer.zoomTo(tileset);
    } catch (e) { }
    updateTilesStatus('3D Tiles: ready');
    if (pendingRouteForGround || lastRoute) refreshFlatGround(pendingRouteForGround || lastRoute);
    try {
      viewer.scene.requestRender();
    } catch (e) { }
  } catch (e) {
    console.warn('failed to load Google 3D Tiles', e);
    updateTilesStatus('3D Tiles: load failed (check API key)');
  }
}

function bindTilesKeyUi() {
  const input = document.getElementById('tilesApiKey');
  const btn = document.getElementById('tilesApply');
  if (input) {
    const current = getTilesKey();
    if (current) input.value = current;
  }
  if (btn) {
    btn.addEventListener('click', () => {
      const key = input?.value?.trim() ?? '';
      setStoredTilesKey(key);
      loadTilesetWithKey(key);
    });
  }
}

function getDataSource(name) {
  const Cesium = getCesium();
  if (!viewer || !Cesium) return null;
  if (!dataSources[name]) {
    dataSources[name] = new Cesium.CustomDataSource(name);
    viewer.dataSources.add(dataSources[name]);
  }
  return dataSources[name];
}

function toCartesianPositions(coords, Cesium) {
  return coords.map(([lng, lat]) => Cesium.Cartesian3.fromDegrees(lng, lat));
}

function asFeatureCollection(geojson) {
  if (!geojson) return { type: 'FeatureCollection', features: [] };
  if (geojson.type === 'FeatureCollection') return geojson;
  if (geojson.type === 'Feature') return { type: 'FeatureCollection', features: [geojson] };
  if (geojson.type) {
    return { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: geojson }] };
  }
  return { type: 'FeatureCollection', features: [] };
}

function bboxIntersects(a, b) {
  return !(a[0] > b[2] || a[2] < b[0] || a[1] > b[3] || a[3] < b[1]);
}

function bboxOfFeature(feature) {
  if (!feature || !turf?.bbox) return null;
  try {
    return turf.bbox(feature);
  } catch (e) {
    return null;
  }
}

function normalizeBuildingsGeoJSON(geojson) {
  const fc = asFeatureCollection(geojson);
  const features = (fc.features || []).filter((f) => {
    const g = f?.geometry;
    return g && (g.type === 'Polygon' || g.type === 'MultiPolygon');
  });
  return { type: 'FeatureCollection', features };
}

function computeRouteRect(simRoute, paddingMeters = 80) {
  if (!simRoute || simRoute.length < 2) return null;
  let minLng = simRoute[0].lng;
  let maxLng = simRoute[0].lng;
  let minLat = simRoute[0].lat;
  let maxLat = simRoute[0].lat;
  simRoute.forEach((p) => {
    minLng = Math.min(minLng, p.lng);
    maxLng = Math.max(maxLng, p.lng);
    minLat = Math.min(minLat, p.lat);
    maxLat = Math.max(maxLat, p.lat);
  });
  const padDeg = Math.max(0, Number(paddingMeters) || 0) / 111000;
  return {
    west: minLng - padDeg,
    south: minLat - padDeg,
    east: maxLng + padDeg,
    north: maxLat + padDeg
  };
}

function getRouteCenter(simRoute) {
  if (!simRoute || !simRoute.length) return null;
  const mid = simRoute[Math.floor(simRoute.length / 2)];
  return { lng: mid.lng, lat: mid.lat };
}

function updateFlatGroundPlane(rect, height) {
  const Cesium = getCesium();
  if (!viewer || !Cesium) return;
  const ds = getDataSource('ground');
  if (!ds) return;
  ds.entities.removeAll();
  if (!rect) return;
  const coords = [
    [rect.west, rect.south],
    [rect.east, rect.south],
    [rect.east, rect.north],
    [rect.west, rect.north],
    [rect.west, rect.south]
  ];
  const positions = coords.map(([lng, lat]) => Cesium.Cartesian3.fromDegrees(lng, lat));
  ds.entities.add({
    polygon: {
      hierarchy: positions,
      material: Cesium.Color.fromCssColorString(FLAT_GROUND_COLOR).withAlpha(FLAT_GROUND_ALPHA),
      outline: true,
      outlineColor: Cesium.Color.fromCssColorString(FLAT_GROUND_OUTLINE).withAlpha(0.4),
      height: height
    }
  });
}

function updateTilesetClipping(center, height) {
  const Cesium = getCesium();
  if (!tileset || !viewer || !Cesium) return;
  if (!ENABLE_TILESET_CLIP) {
    if (tileset.clippingPlanes) tileset.clippingPlanes = null;
    return;
  }
  if (!center || !Number.isFinite(height)) return;
  if (!tilesetReady && !tilesetHasTiles) return;
  try {
    const origin = Cesium.Cartesian3.fromDegrees(center.lng, center.lat, height);
    const modelMatrix = Cesium.Transforms.eastNorthUpToFixedFrame(origin);
    const plane = new Cesium.ClippingPlane(new Cesium.Cartesian3(0, 0, -1), 0.0);
    tileset.clippingPlanes = new Cesium.ClippingPlaneCollection({
      planes: [plane],
      unionClippingRegions: true,
      edgeWidth: 1.0,
      edgeColor: Cesium.Color.WHITE.withAlpha(0.2),
      modelMatrix
    });
  } catch (e) {
    console.warn('clipping plane failed', e);
  }
}

async function refreshFlatGround(simRoute) {
  const Cesium = getCesium();
  if (!viewer || !Cesium || !simRoute || simRoute.length < 2) return;
  const token = ++flatGroundRefreshId;
  pendingRouteForGround = simRoute;
  const rect = computeRouteRect(simRoute, 90);
  const center = getRouteCenter(simRoute);
  let height = FORCE_FLAT_GROUND ? FLAT_GROUND_FIXED_HEIGHT : 0;
  if (!FORCE_FLAT_GROUND && center) {
    try {
      const carto = Cesium.Cartographic.fromDegrees(center.lng, center.lat);
      if (typeof viewer.scene.sampleHeightMostDetailed === 'function') {
        const result = await viewer.scene.sampleHeightMostDetailed([carto]);
        const h = result?.[0]?.height;
        if (Number.isFinite(h)) height = h;
      } else if (viewer.scene.sampleHeightSupported && typeof viewer.scene.sampleHeight === 'function') {
        const h = viewer.scene.sampleHeight(carto);
        if (Number.isFinite(h)) height = h;
      } else if (typeof viewer.scene.globe?.getHeight === 'function') {
        const h = viewer.scene.globe.getHeight(carto);
        if (Number.isFinite(h)) height = h;
      }
    } catch (e) { }
  }

  if (token !== flatGroundRefreshId) return;
  const baseHeight = Number.isFinite(height) ? height : 0;
  flatGroundHeight = baseHeight + (FORCE_FLAT_GROUND ? 0 : FLAT_GROUND_OFFSET);
  if (ENABLE_FLAT_GROUND) {
    flatGroundRect = rect;
    updateFlatGroundPlane(rect, flatGroundHeight);
    updateTilesetClipping(center, flatGroundHeight);
  } else {
    flatGroundRect = null;
    updateFlatGroundPlane(null, 0);
    updateTilesetClipping(null, NaN);
  }

  if (lastRoute) renderRoute(lastRoute);
  if (lastRoadSurfaceGeo) renderRoadSurface(lastRoadSurfaceGeo);
  if (lastCorridorRoute) renderCorridor(lastCorridorRoute, lastCorridorMeters);
  if (lastSidewalkGeo) renderSidewalks(lastSidewalkGeo);
  if (lastObstaclesGeo) renderObstacles(lastObstaclesGeo);
  if (lastRoute) renderStaticTruck(lastRoute);
  try {
    viewer.scene.requestRender();
  } catch (e) { }
}

function setPolygonEntities(ds, geojson, { fillColor, fillOpacity, outlineColor, outlineOpacity, height } = {}) {
  const Cesium = getCesium();
  if (!ds || !Cesium) return;
  ds.entities.removeAll();
  const fc = asFeatureCollection(geojson);
  const features = Array.isArray(fc.features) ? fc.features : [];
  const material = Cesium.Color.fromCssColorString(fillColor || '#ffffff').withAlpha(fillOpacity ?? 0.2);
  const outline = Cesium.Color.fromCssColorString(outlineColor || '#ffffff').withAlpha(outlineOpacity ?? 0.4);
  const useHeight = Number.isFinite(height);
  const heightRef = Cesium.HeightReference?.NONE;
  const finalHeight = useHeight ? height : 0;

  const addPolygon = (coords) => {
    if (!coords || !coords.length) return;
    const ring = coords[0];
    if (!Array.isArray(ring) || ring.length < 3) return;
    const positions = toCartesianPositions(ring, Cesium);
    ds.entities.add({
      polygon: {
        hierarchy: positions,
        material,
        outline: true,
        outlineColor: outline,
        heightReference: heightRef,
        height: finalHeight
      }
    });
  };

  features.forEach((f) => {
    const g = f?.geometry;
    if (!g) return;
    if (g.type === 'Polygon') addPolygon(g.coordinates);
    if (g.type === 'MultiPolygon') g.coordinates.forEach(addPolygon);
  });
}

function getFeatureHeight(feature, fallback = 3) {
  const props = feature?.properties || {};
  const h = props.h ?? props.height ?? props.alt;
  const n = Number(h);
  if (Number.isFinite(n)) return Math.max(0.5, Math.min(50, n));
  return fallback;
}

function isHeightOnlyFeature(feature) {
  const v = feature?.properties?.heightOnly;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v === 1;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    return s === '1' || s === 'true' || s === 'yes';
  }
  return false;
}

function getGroundHeight() {
  if (Number.isFinite(flatGroundHeight)) return flatGroundHeight;
  return 0;
}

function bearingRadFromVector(dx, dy, fallbackTheta = 0) {
  if (Number.isFinite(dx) && Number.isFinite(dy)) {
    const mag = Math.hypot(dx, dy);
    if (mag > 1e-4) return Math.atan2(dx, dy);
  }
  return Math.PI / 2 - (Number.isFinite(fallbackTheta) ? fallbackTheta : 0);
}

function truckHeadingFromBearingRad(bearingRad) {
  const Cesium = getCesium();
  if (!Cesium) return 0;
  return Cesium.Math.negativePiToPi(bearingRad - Math.PI / 2);
}

function normalizeAngleRad(a) {
  let v = a % (Math.PI * 2);
  if (v > Math.PI) v -= Math.PI * 2;
  if (v < -Math.PI) v += Math.PI * 2;
  return v;
}

function lerpAngleRad(a, b, t) {
  const delta = normalizeAngleRad(b - a);
  return normalizeAngleRad(a + delta * t);
}

function buildTruckRing(pose, vehicleConfig) {
  const wheelBase = Number(vehicleConfig?.wheelBase ?? 3.4);
  const vehicleWidth = Number(vehicleConfig?.vehicleWidth ?? 2.0);
  const frontOverhang = Number(vehicleConfig?.frontOverhang ?? 1.1);
  const rearOverhang = Number(vehicleConfig?.rearOverhang ?? 1.7);
  const theta = Number(pose?.theta ?? 0);

  const corners = [
    { dx: wheelBase + frontOverhang, dy: vehicleWidth / 2 },
    { dx: wheelBase + frontOverhang, dy: -vehicleWidth / 2 },
    { dx: -rearOverhang, dy: -vehicleWidth / 2 },
    { dx: -rearOverhang, dy: vehicleWidth / 2 }
  ];
  const ring = corners.map((c) => {
    const x = pose.x + c.dx * Math.cos(theta) - c.dy * Math.sin(theta);
    const y = pose.y + c.dx * Math.sin(theta) + c.dy * Math.cos(theta);
    const ll = coordinateSystem.metersToLatLng(x, y);
    return [ll.lng, ll.lat];
  });
  ring.push(ring[0]);
  return ring;
}

function ensureTruckEntity(vehicleConfig) {
  const Cesium = getCesium();
  if (!viewer || !Cesium) return null;
  const ds = getDataSource('truck');
  if (!ds) return null;
  const wheelBase = Number(vehicleConfig?.wheelBase ?? 3.4);
  const front = Number(vehicleConfig?.frontOverhang ?? 1.1);
  const rear = Number(vehicleConfig?.rearOverhang ?? 1.7);
  const length = Math.max(2, wheelBase + front + rear);
  const width = Math.max(1.5, Number(vehicleConfig?.vehicleWidth ?? 2.0));
  const height = Math.max(1.5, Number(vehicleConfig?.vehicleHeight ?? 2.2));

  if (!truckEntity) {
    const USE_GLTF_MODEL = false;
    if (USE_GLTF_MODEL) {
      const modelLength = 4.0;
      const scaleValue = length / modelLength;
      truckEntity = ds.entities.add({
        position: Cesium.Cartesian3.fromDegrees(0, 0, 0),
        show: true,
        model: {
          uri: 'https://raw.githubusercontent.com/CesiumGS/cesium/main/Apps/SampleData/models/CesiumMilkTruck/CesiumMilkTruck.glb',
          minimumPixelSize: 64,
          maximumScale: 20000,
          scale: scaleValue,
          color: Cesium.Color.fromCssColorString(TRUCK_SAFE_COLOR),
          colorBlendMode: Cesium.ColorBlendMode.MIX,
          colorBlendAmount: 0.4,
          heightReference: Cesium.HeightReference.NONE
        }
      });
    } else {
      truckEntity = ds.entities.add({
        position: Cesium.Cartesian3.fromDegrees(0, 0, 0),
        show: true,
        box: {
          dimensions: new Cesium.Cartesian3(length, width, height),
          material: Cesium.Color.fromCssColorString(TRUCK_SAFE_COLOR).withAlpha(0.85),
          outline: true,
          outlineColor: Cesium.Color.fromCssColorString(TRUCK_SAFE_OUTLINE)
        }
      });
    }
  } else {
    if (truckEntity.model) {
      const modelLength = 4.0;
      truckEntity.model.scale = length / modelLength;
    } else if (truckEntity.box) {
      truckEntity.box.dimensions = new Cesium.Cartesian3(length, width, height);
    }
    truckEntity.show = true;
  }
  return truckEntity;
}

function renderStaticTruck(simRoute, vehicleConfig = lastVehicleConfig) {
  const Cesium = getCesium();
  if (!viewer || !Cesium) return;
  if (!Array.isArray(simRoute) || !simRoute.length) return;
  const cfg = vehicleConfig || DEFAULT_VEHICLE_CONFIG;
  const first = simRoute[0];
  const next = simRoute[1] || simRoute[0];
  if (!first || !Number.isFinite(first.lng) || !Number.isFinite(first.lat)) return;
  const height = Math.max(1.5, Number(cfg?.vehicleHeight ?? 2.2));
  const ground = getGroundHeight();
  const position = Cesium.Cartesian3.fromDegrees(first.lng, first.lat, ground + height / 2);
  const bearingDeg = turf?.bearing ? turf.bearing([first.lng, first.lat], [next.lng, next.lat]) : 0;
  const bearingRad = Cesium.Math.toRadians(Number.isFinite(bearingDeg) ? bearingDeg : 0);
  const heading = truckHeadingFromBearingRad(bearingRad);

  const entity = ensureTruckEntity(cfg);
  if (!entity) return;
  entity.position = position;
  entity.orientation = Cesium.Transforms.headingPitchRollQuaternion(
    position,
    new Cesium.HeadingPitchRoll(heading, 0, 0)
  );
  entity.show = true;
  try {
    viewer.scene.requestRender();
  } catch (e) { }
}

function createViewer(container, Cesium) {
  if (viewer || !container || !Cesium) return;

  try {
    viewer = new Cesium.Viewer(container, {
      animation: false,
      timeline: false,
      baseLayerPicker: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      infoBox: false,
      selectionIndicator: false,
      fullscreenButton: false,
      shouldAnimate: true,
      imageryProvider: buildFallbackSatelliteProvider(Cesium)
    });
  } catch (e) {
    viewer = null;
    container.dataset.viewerError = e?.message || 'Cesium viewer failed';
    updateTilesStatus('3D Tiles: WebGL unavailable');
    console.warn('[map3d] Cesium viewer failed', e);
    return;
  }
  attachResizeObserver(container);

  try {
    viewer.resolutionScale = Math.min(RENDER_SCALE_CAP, window.devicePixelRatio || 1);
  } catch (e) { }
  try {
    if (viewer.scene?.postProcessStages?.fxaa) viewer.scene.postProcessStages.fxaa.enabled = ENABLE_FXAA;
  } catch (e) { }
  try {
    viewer.scene.requestRenderMode = true;
    viewer.scene.maximumRenderTimeChange = 0.5;
  } catch (e) { }

  viewer.scene.globe.show = true;
  viewer.scene.globe.depthTestAgainstTerrain = false;
  try {
    viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString('#0b0f1a');
  } catch (e) { }
  applySatelliteImagery();
  try {
    setTimeout(() => {
      if (!viewer || !viewer.imageryLayers) return;
      if (viewer.imageryLayers.length === 0) applySatelliteImagery();
      try {
        viewer.scene.requestRender();
      } catch (e) { }
    }, 800);
  } catch (e) { }
  try {
    if (typeof viewer.scene.globe.maximumScreenSpaceError === 'number') {
      viewer.scene.globe.maximumScreenSpaceError = 4;
    }
  } catch (e) { }
  if (FORCE_DARK_BACKGROUND) {
    viewer.scene.backgroundColor = Cesium.Color.fromCssColorString('#0b0f1a');
    try {
      if (viewer.scene.skyAtmosphere) viewer.scene.skyAtmosphere.show = false;
    } catch (e) { }
    try {
      viewer.scene.skyBox = null;
    } catch (e) { }
  } else {
    viewer.scene.backgroundColor = Cesium.Color.fromCssColorString('#dbe7f5');
  }
  try {
    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(139.7671, 35.6812, 450)
    });
  } catch (e) { }
  attachCameraLock();
  applyViewMode();

  bindTilesKeyUi();
  const key = getTilesKey();
  if (isPhotorealistic) {
    if (key) loadTilesetWithKey(key);
    else updateTilesStatus('3D Tiles: API key required (Map Tiles API)');
  } else {
    updateTilesStatus('3D Tiles: off');
  }

  isLoaded = true;
  flushQueue();
}

export function initMap3D(containerId = 'map3d') {
  map3dContainerId = containerId;
  if (!ensureViewer()) {
    updateTilesStatus('3D Tiles: open the 3D panel to initialize');
  }
}

function renderRoute(simRoute) {
  const Cesium = getCesium();
  const ds = getDataSource('route');
  if (!viewer || !Cesium || !ds) return;
  ds.entities.removeAll();
  if (!simRoute || simRoute.length < 2) return;
  const height = getGroundHeight() + 2.0;
  const positions = simRoute.map((p) => Cesium.Cartesian3.fromDegrees(p.lng, p.lat, height));
  ds.entities.add({
    polyline: {
      positions,
      width: 10,
      material: new Cesium.PolylineGlowMaterialProperty({
        glowPower: 0.2,
        color: Cesium.Color.fromCssColorString(ROUTE_GLOW)
      }),
      clampToGround: false
    }
  });
  ds.entities.add({
    polyline: {
      positions,
      width: 3.2,
      material: Cesium.Color.fromCssColorString(ROUTE_COLOR),
      clampToGround: false
    }
  });
  try {
    viewer.scene.requestRender();
  } catch (e) { }
}

function renderCorridor(simRoute, corridorMeters) {
  const ds = getDataSource('corridor');
  if (!ds || !simRoute || simRoute.length < 2 || !turf?.buffer) {
    if (ds) ds.entities.removeAll();
    return;
  }
  try {
    const line = turf.lineString(simRoute.map((p) => [p.lng, p.lat]));
    const corridor = turf.buffer(line, Math.max(20, Number(corridorMeters) || 120), { units: 'meters', steps: 6 });
    setPolygonEntities(ds, corridor, {
      fillColor: CORRIDOR_COLOR,
      fillOpacity: 0.08,
      outlineColor: CORRIDOR_COLOR,
      outlineOpacity: 0.25,
      height: getGroundHeight() + SURFACE_HEIGHT_OFFSET
    });
  } catch (e) {
    ds.entities.removeAll();
  }
}

function renderRoadSurface(roadUnionGeo) {
  const ds = getDataSource('roadSurface');
  if (!ds) return;
  if (!roadUnionGeo) {
    ds.entities.removeAll();
    return;
  }
  setPolygonEntities(ds, roadUnionGeo, {
    fillColor: ROAD_SURFACE_COLOR,
    fillOpacity: 0.22,
    outlineColor: '#e0f2fe',
    outlineOpacity: 0.55,
    height: getGroundHeight() + SURFACE_HEIGHT_OFFSET
  });
}

function renderSidewalks(geojson) {
  const Cesium = getCesium();
  const ds = getDataSource('sidewalks');
  if (!viewer || !Cesium || !ds) return;
  ds.entities.removeAll();
  if (!geojson) return;
  const fc = asFeatureCollection(geojson);
  const features = Array.isArray(fc.features) ? fc.features : [];
  const height = getGroundHeight() + SIDEWALK_HEIGHT_OFFSET;
  const material = Cesium.Color.fromCssColorString(SIDEWALK_COLOR).withAlpha(0.6);

  const addLine = (coords) => {
    if (!Array.isArray(coords) || coords.length < 2) return;
    const positions = coords.map(([lng, lat]) => Cesium.Cartesian3.fromDegrees(lng, lat, height));
    ds.entities.add({
      polyline: {
        positions,
        width: SIDEWALK_WIDTH,
        material
      }
    });
  };

  features.forEach((f) => {
    const g = f?.geometry;
    if (!g) return;
    if (g.type === 'LineString') addLine(g.coordinates);
    if (g.type === 'MultiLineString') g.coordinates.forEach(addLine);
  });
}

function renderObstacles(geojson, defaultHeight = lastObstaclesDefaultHeight) {
  const Cesium = getCesium();
  const ds = getDataSource('obstacles');
  if (!Cesium || !ds) return;
  ds.entities.removeAll();
  if (!geojson) return;

  const fc = asFeatureCollection(geojson);
  const features = Array.isArray(fc.features) ? fc.features : [];
  const ground = getGroundHeight();
  features.forEach((f) => {
    const g = f?.geometry;
    if (!g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon')) return;
    let center = null;
    try {
      const c = turf.center(f);
      center = c?.geometry?.coordinates;
    } catch (e) {
      center = null;
    }
    if (!center || center.length < 2) return;
    const [lng, lat] = center;
    let area = null;
    try {
      area = turf.area(f);
    } catch (e) {
      area = null;
    }
    const radius = area ? Math.max(0.5, Math.min(8, Math.sqrt(area / Math.PI))) : 1.2;
    const height = getFeatureHeight(f, defaultHeight);
    ds.entities.add({
      position: Cesium.Cartesian3.fromDegrees(lng, lat, ground + height / 2),
      cylinder: {
        length: height,
        topRadius: radius,
        bottomRadius: radius,
        material: Cesium.Color.fromCssColorString(OBSTACLE_COLOR).withAlpha(0.55),
        outline: true,
        outlineColor: Cesium.Color.fromCssColorString(OBSTACLE_OUTLINE).withAlpha(0.8)
      }
    });
  });
}

export function setRoute3D(simRoute) {
  runWhenReady(() => {
    lastRoute = simRoute;
    renderRoute(simRoute);
    if (simRoute && simRoute.length >= 2) refreshFlatGround(simRoute);
    if (simRoute && simRoute.length) renderStaticTruck(simRoute);
  });
}

export function setRoads3D() {
  runWhenReady(() => {
    const ds = getDataSource('roads');
    if (!ds) return;
    ds.entities.removeAll();
  });
}

export function setCorridorRoads3D(_roads, simRoute, { corridorMeters = 120 } = {}) {
  runWhenReady(() => {
    lastCorridorRoute = simRoute;
    lastCorridorMeters = corridorMeters;
    renderCorridor(simRoute, corridorMeters);
  });
}

export function setRoadSurface3D(roadUnionGeo) {
  runWhenReady(() => {
    lastRoadSurfaceGeo = roadUnionGeo;
    renderRoadSurface(roadUnionGeo);
  });
}

export function clearRoadSurface3D() {
  setRoadSurface3D(null);
}

export function setSidewalks3D(geojson) {
  runWhenReady(() => {
    lastSidewalkGeo = geojson;
    renderSidewalks(geojson);
  });
}

export function clearSidewalks3D() {
  setSidewalks3D(null);
}

export function setObstaclesGeoJSON(geojson, { defaultHeight = 3 } = {}) {
  runWhenReady(() => {
    lastObstaclesGeo = geojson;
    lastObstaclesDefaultHeight = defaultHeight;
    renderObstacles(geojson, defaultHeight);
  });
}

export function clearObstacles3D() {
  runWhenReady(() => {
    const ds = getDataSource('obstacles');
    if (ds) ds.entities.removeAll();
  });
}

function renderSchematicBuildings() {
  const Cesium = getCesium();
  const ds = getDataSource('buildings');
  if (!viewer || !Cesium || !ds) return;
  ds.entities.removeAll();

  if (isPhotorealistic) return; // Don't show in real mode

  const fc = buildingsShownGeoJSON.features.length ? buildingsShownGeoJSON : buildingsAll;
  const features = Array.isArray(fc.features) ? fc.features : [];

  const material = Cesium.Color.fromCssColorString(SCHEMATIC_BUILDING_COLOR).withAlpha(0.9);
  const outline = Cesium.Color.fromCssColorString(SCHEMATIC_BUILDING_OUTLINE);
  const ground = getGroundHeight();

  features.forEach((f) => {
    const g = f?.geometry;
    if (!g) return;

    // Height from properties
    const h = getFeatureHeight(f, 3.5); // Default to 3.5m if missing
    const extrudedHeight = ground + h;

    const addPolygon = (coords) => {
      if (!coords || !coords.length) return;
      const ring = coords[0];
      if (!Array.isArray(ring) || ring.length < 3) return;
      const positions = toCartesianPositions(ring, Cesium);
      ds.entities.add({
        polygon: {
          hierarchy: positions,
          material: material,
          outline: true,
          outlineColor: outline,
          height: ground,
          extrudedHeight: extrudedHeight,
          shadows: Cesium.ShadowMode.ENABLED
        }
      });
    };

    if (g.type === 'Polygon') addPolygon(g.coordinates);
    if (g.type === 'MultiPolygon') g.coordinates.forEach(addPolygon);
  });
}

export function setBuildingsAllGeoJSON(geojson) {
  buildingsAll = normalizeBuildingsGeoJSON(geojson);
  buildingsShownGeoJSON = { type: 'FeatureCollection', features: [] };
  buildingsShownCount = 0;
  if (!isPhotorealistic) renderSchematicBuildings();
}

export function clearBuildings3D() {
  buildingsAll = { type: 'FeatureCollection', features: [] };
  buildingsShownGeoJSON = { type: 'FeatureCollection', features: [] };
  buildingsShownCount = 0;
}

export function updateBuildingsForRoute(simRoute, { corridorMeters = 150 } = {}) {
  if (!buildingsAll?.features?.length || !simRoute || simRoute.length < 2) {
    buildingsShownGeoJSON = { type: 'FeatureCollection', features: [] };
    buildingsShownCount = 0;
    return { total: buildingsAll?.features?.length ?? 0, shown: 0 };
  }

  const distance = Math.max(0, Number(corridorMeters) || 0);
  let corridor = null;
  try {
    const line = turf.lineString(simRoute.map((p) => [p.lng, p.lat]));
    corridor = distance > 0 ? turf.buffer(line, distance, { units: 'meters', steps: 6 }) : turf.buffer(line, 1, { units: 'meters', steps: 4 });
  } catch (e) {
    corridor = null;
  }

  if (!corridor) {
    buildingsShownGeoJSON = { type: 'FeatureCollection', features: [] };
    buildingsShownCount = 0;
    return { total: buildingsAll.features.length, shown: 0 };
  }

  const corridorBbox = turf.bbox(corridor);
  const candidates = [];
  for (const f of buildingsAll.features) {
    const bb = bboxOfFeature(f);
    if (!bb || !bboxIntersects(bb, corridorBbox)) continue;
    candidates.push(f);
  }

  let filtered = candidates;
  const canPreciseFilter = candidates.length <= 2500 && typeof turf.booleanIntersects === 'function';
  if (canPreciseFilter) {
    filtered = candidates.filter((f) => {
      try {
        return turf.booleanIntersects(f, corridor);
      } catch (e) {
        return true;
      }
    });
  }

  buildingsShownCount = filtered.length;
  buildingsShownGeoJSON = { type: 'FeatureCollection', features: filtered };
  return { total: buildingsAll.features.length, shown: buildingsShownCount };
}

export function getBuildings3DStats() {
  return { total: buildingsAll?.features?.length ?? 0, shown: buildingsShownCount };
}

export function getBuildingsShownGeoJSON() {
  return buildingsShownGeoJSON;
}

export function setBuildingsRenderMode() { }

export function play3D(simPoses, vehicleConfig, opts = {}) {
  const Cesium = getCesium();
  if (!viewer || !Cesium) {
    if (!ensureViewer()) {
      runWhenReady(() => play3D(simPoses, vehicleConfig, opts));
      return;
    }
  }
  if (!viewer || !Cesium) return;

  // Validate simPoses before starting animation
  if (!simPoses || !Array.isArray(simPoses) || simPoses.length === 0) {
    console.error('play3D: Invalid or empty simPoses', { simPoses });
    toast('エラー: 軌道データが空です');
    return;
  }

  // Validate pose structure
  const firstPose = simPoses[0];
  if (!firstPose || typeof firstPose.x !== 'number' || typeof firstPose.y !== 'number') {
    console.error('play3D: Invalid pose structure', { firstPose, simPoses });
    toast('エラー: 軌道データが不正です');
    return;
  }

  console.log('play3D: Starting animation', {
    poseCount: simPoses.length,
    firstPose,
    vehicleConfig
  });

  if (animId) cancelAnimationFrame(animId);
  animId = null;
  poses = simPoses || [];
  if (vehicleConfig) lastVehicleConfig = vehicleConfig;
  let progress = 0;
  let lastTs = 0;
  let cameraAccumS = 0;
  let lastHeading = null;
  let lastCameraHeading = null;
  let lastCameraTarget = null;

  const strideMeters = Math.max(0.05, Number(opts.strideMeters ?? 1.5));
  const speedMultiplierRaw = Number(opts.speedMultiplier ?? 1);
  const speedMultiplier = Number.isFinite(speedMultiplierRaw) ? Math.max(0.1, Math.min(5.0, speedMultiplierRaw)) : 1;
  const vehicleSpeed = Math.max(0.5, Number(vehicleConfig?.vehicleSpeed ?? 4.0));
  const secondsPerPose = strideMeters / vehicleSpeed / speedMultiplier;
  const followCamera = opts.followCamera !== false;
  const cameraMode = opts.cameraMode === 'top' ? 'top' : 'street';
  const cameraFpsRaw = Number(opts.cameraFps ?? 60);
  const cameraFps = Number.isFinite(cameraFpsRaw) ? Math.max(5, Math.min(60, cameraFpsRaw)) : 60;
  const cameraIntervalS = 1 / cameraFps;
  const roadUnionGeo = opts.roadUnionGeo || null;
  const obstaclesGeo = opts.obstaclesGeo || null;
  const obstacleFeatures = Array.isArray(obstaclesGeo?.features) ? obstaclesGeo.features.filter((f) => f?.geometry) : [];
  const obstacleBboxes = obstacleFeatures.map((f) => bboxOfFeature(f));
  const obstacleHeights = obstacleFeatures.map((f) => getFeatureHeight(f, lastObstaclesDefaultHeight));
  const obstacleHeightOnly = obstacleFeatures.map((f) => isHeightOnlyFeature(f));
  const heightClearance = 0.25;
  const hasRoadCheck = !!roadUnionGeo && typeof turf?.booleanWithin === 'function';
  const hasObstacleCheck = obstacleFeatures.length > 0 && typeof turf?.booleanIntersects === 'function';
  const allowCollisionCheck = hasRoadCheck || hasObstacleCheck;
  const collisionCheckFps = 12;
  const collisionCheckIntervalS = 1 / collisionCheckFps;
  let collisionAccumS = 0;
  let lastDanger = null;
  const headingSmooth = 0.35;
  const cameraSmooth = 0.25;
  const targetSmooth = 0.22;
  const loop = opts.loop === true;

  ensureTruckEntity(vehicleConfig);

  let baseGroundHeight = 0;
  if (poses.length > 0) {
    const firstPose = poses[0];
    const ll = coordinateSystem.metersToLatLng(firstPose.x, firstPose.y);
    try {
      const carto = Cesium.Cartographic.fromDegrees(ll.lng, ll.lat);
      if (viewer?.scene && typeof viewer.scene.sampleHeight === 'function') {
        const h = viewer.scene.sampleHeight(carto);
        if (Number.isFinite(h)) baseGroundHeight = h;
      }
    } catch (e) { }
  }


  let lastSampledHeight = 0;
  let _collisionCount = 0;
  let _isInDanger = false;
  let autoDriveOffsetM = 0;
  let autoDriveTargetOffsetM = 0;
  let autoDriveAvoidCount = 0;
  let autoDriveWasOffset = false;

  const samplePoseAtProgress = (rawProgress) => {
    const clamped = Math.max(0, Math.min(poses.length - 1, rawProgress));
    const baseIdx = Math.max(0, Math.min(poses.length - 1, Math.floor(clamped)));
    const nextIdx = Math.min(poses.length - 1, baseIdx + 1);
    const t = Math.max(0, Math.min(1, clamped - baseIdx));
    const a = poses[baseIdx];
    const b = poses[nextIdx] || a;
    if (!a || !b) return null;
    const pose = {
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      theta: lerpAngleRad(a.theta, b.theta, t)
    };
    const bearingRad = bearingRadFromVector(b.x - a.x, b.y - a.y, pose.theta);
    return { pose, bearingRad, baseIdx, nextIdx };
  };

  const offsetPoseLaterally = (pose, bearingRad, lateralM) => {
    if (!pose || !Number.isFinite(lateralM) || Math.abs(lateralM) < 1e-6) return pose;
    return {
      ...pose,
      x: pose.x + lateralM * Math.cos(bearingRad),
      y: pose.y - lateralM * Math.sin(bearingRad)
    };
  };

  const collisionDangerForPose = (pose) => {
    if (!allowCollisionCheck || !pose) return 0;
    try {
      const ring = buildTruckRing(pose, vehicleConfig);
      const footprint = turf.polygon([ring]);
      if (hasRoadCheck && !turf.booleanWithin(footprint, roadUnionGeo)) return 1;
      if (hasObstacleCheck) {
        const fpBbox = bboxOfFeature(footprint);
        for (let i = 0; i < obstacleFeatures.length; i++) {
          const ob = obstacleFeatures[i];
          const obBbox = obstacleBboxes[i];
          if (fpBbox && obBbox && !bboxIntersects(fpBbox, obBbox)) continue;
          if (obstacleHeightOnly[i]) {
            const obH = obstacleHeights[i];
            const vehH = Number(vehicleConfig?.vehicleHeight ?? 0);
            if (vehH > 0 && Number.isFinite(obH) && vehH + heightClearance <= obH) continue;
          }
          if (turf.booleanIntersects(footprint, ob)) return 1;
        }
      }
    } catch (e) {
      return 0;
    }
    return 0;
  };

  const isAutoDriveOffsetSafe = (offsetM, fromProgress) => {
    if (!allowCollisionCheck) return true;
    for (const stepAhead of AUTODRIVE_LOOKAHEAD_POSE_STEPS) {
      const sample = samplePoseAtProgress(fromProgress + stepAhead);
      if (!sample) return false;
      const testPose = offsetPoseLaterally(sample.pose, sample.bearingRad, offsetM);
      if (collisionDangerForPose(testPose)) return false;
    }
    return true;
  };

  const chooseAutoDriveTargetOffset = (fromProgress) => {
    if (!allowCollisionCheck) return 0;
    if (isAutoDriveOffsetSafe(0, fromProgress)) return 0;
    let best = null;
    for (const offsetM of AUTODRIVE_LATERAL_CANDIDATES_M) {
      if (Math.abs(offsetM) < AUTODRIVE_OFFSET_EPS) continue;
      if (!isAutoDriveOffsetSafe(offsetM, fromProgress)) continue;
      const score = Math.abs(offsetM) + Math.abs(offsetM - autoDriveTargetOffsetM) * 0.35;
      if (!best || score < best.score) best = { offsetM, score };
    }
    return best ? best.offsetM : autoDriveTargetOffsetM;
  };

  const step = (ts) => {
    if (!poses.length) {
      animId = null;
      return;
    }
    if (!lastTs) lastTs = ts;
    const dtS = Math.min(0.25, Math.max(0, (ts - lastTs) / 1000));
    lastTs = ts;
    if (secondsPerPose > 0) progress += dtS / secondsPerPose;
    if (progress >= poses.length - 1) progress = poses.length - 1;

    const sample = samplePoseAtProgress(progress);
    if (!sample) return;
    const { baseIdx, bearingRad } = sample;
    let p = sample.pose;

    if (allowCollisionCheck) {
      if ((collisionAccumS + dtS) >= collisionCheckIntervalS || lastDanger === null) {
        autoDriveTargetOffsetM = chooseAutoDriveTargetOffset(progress);
      }
      autoDriveOffsetM += (autoDriveTargetOffsetM - autoDriveOffsetM) * AUTODRIVE_OFFSET_SMOOTH;
      if (Math.abs(autoDriveOffsetM) < AUTODRIVE_OFFSET_EPS && Math.abs(autoDriveTargetOffsetM) < AUTODRIVE_OFFSET_EPS) {
        autoDriveOffsetM = 0;
      }
      p = offsetPoseLaterally(p, bearingRad, autoDriveOffsetM);
      const isOffsetNow = Math.abs(autoDriveOffsetM) >= 0.12;
      if (isOffsetNow && !autoDriveWasOffset) autoDriveAvoidCount++;
      autoDriveWasOffset = isOffsetNow;
    }

    const desiredHeading = truckHeadingFromBearingRad(bearingRad);
    const heading = lastHeading == null ? desiredHeading : lerpAngleRad(lastHeading, desiredHeading, headingSmooth);
    lastHeading = heading;

    // Dynamic Ground Height Sampling
    const ll = coordinateSystem.metersToLatLng(p.x, p.y);
    try {
      const carto = Cesium.Cartographic.fromDegrees(ll.lng, ll.lat);
      const h = viewer.scene.sampleHeight(carto);
      if (Number.isFinite(h)) {
        lastSampledHeight = h;
      } else {
        lastSampledHeight = getGroundHeight();
      }
    } catch (e) {
      lastSampledHeight = getGroundHeight();
    }

    if (allowCollisionCheck) {
      collisionAccumS += dtS;
      if (collisionAccumS >= collisionCheckIntervalS || lastDanger === null) {
        collisionAccumS = 0;
        p.danger = collisionDangerForPose(p);
        lastDanger = p.danger;
      } else if (lastDanger != null) {
        p.danger = lastDanger;
      }
    }

    // Updated renderPose logic embedded in step to use lastSampledHeight
    if (truckEntity) {
      const height = Math.max(1.5, Number(vehicleConfig?.vehicleHeight ?? 2.2));
      // Increased offset (+0.5) to avoid any clipping even on rough tiles
      const position = Cesium.Cartesian3.fromDegrees(ll.lng, ll.lat, lastSampledHeight + height / 2 + 0.5);
      truckEntity.position = position;
      truckEntity.orientation = Cesium.Transforms.headingPitchRollQuaternion(
        position,
        new Cesium.HeadingPitchRoll(heading, 0, 0)
      );
      if (p.danger !== lastTruckDanger) {
        lastTruckDanger = p.danger;
        const color = p.danger ? TRUCK_DANGER_COLOR : TRUCK_SAFE_COLOR;
        const outline = p.danger ? TRUCK_DANGER_OUTLINE : TRUCK_SAFE_OUTLINE;
        if (truckEntity.model) {
          truckEntity.model.color = Cesium.Color.fromCssColorString(color);
        } else if (truckEntity.box) {
          truckEntity.box.material = Cesium.Color.fromCssColorString(color).withAlpha(0.85);
          truckEntity.box.outlineColor = Cesium.Color.fromCssColorString(outline);
        }
      }
    }

    const poseEl = document.getElementById('map3dPoseCount');
    const collEl = document.getElementById('map3dCollisionCount');
    if (poseEl) {
      const offsetText = Math.abs(autoDriveOffsetM) >= 0.12
        ? ` / AUTO ${autoDriveOffsetM > 0 ? '+' : ''}${autoDriveOffsetM.toFixed(1)}m`
        : '';
      const avoidText = autoDriveAvoidCount ? ` / avoid ${autoDriveAvoidCount}` : '';
      poseEl.textContent = `${baseIdx + 1} / ${poses.length}${offsetText}${avoidText}`;
    }
    if (collEl) {
      if (p.danger && !_isInDanger) {
        _collisionCount++;
        _isInDanger = true;
      } else if (!p.danger) {
        _isInDanger = false;
      }
      collEl.textContent = _collisionCount;
      collEl.classList.toggle('ng', _collisionCount > 0);
    }

    if (followCamera) {
      cameraAccumS += dtS;
      if (cameraAccumS >= cameraIntervalS || progress >= poses.length - 1) {
        cameraAccumS = 0;
        const ground = lastSampledHeight;
        const hV = Math.max(1.5, Number(vehicleConfig?.vehicleHeight ?? 2.2));
        // Follow point is slightly above the vehicle center
        const target = Cesium.Cartesian3.fromDegrees(ll.lng, ll.lat, ground + hV * 1.5);
        const camHeading = lastCameraHeading == null ? bearingRad : lerpAngleRad(lastCameraHeading, bearingRad, cameraSmooth);
        lastCameraHeading = camHeading;
        if (lastCameraTarget) {
          lastCameraTarget = Cesium.Cartesian3.lerp(lastCameraTarget, target, targetSmooth, lastCameraTarget);
        } else {
          lastCameraTarget = Cesium.Cartesian3.clone(target, new Cesium.Cartesian3());
        }
        // Use a deeper pitch to avoid looking 'flat'
        const pitch = cameraMode === 'top' ? Cesium.Math.toRadians(-65) : Cesium.Math.toRadians(-35);
        const range = cameraMode === 'top' ? 80 : 45;
        viewer.camera.lookAt(lastCameraTarget, new Cesium.HeadingPitchRange(camHeading, pitch, range));
      }
    }

    if (progress >= poses.length - 1) {
      if (loop) {
        progress = 0;
        lastHeading = null;
        lastCameraHeading = null;
        lastCameraTarget = null;
        _collisionCount = 0;
        _isInDanger = false;
      } else {
        animId = null;
        return;
      }
    }
    try {
      viewer.scene.requestRender();
    } catch (e) { }
    animId = requestAnimationFrame(step);
  };

  if (!animId) animId = requestAnimationFrame(step);
}

export function stop3D() {
  const Cesium = getCesium();
  if (animId) cancelAnimationFrame(animId);
  animId = null;
  if (truckEntity) truckEntity.show = false;
  lastTruckDanger = null;
  if (viewer && Cesium) {
    try {
      viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    } catch (e) { }
  }
}

export function resizeMap3D() {
  if (!ensureViewer()) return;
  try {
    viewer.resize();
  } catch (e) { }
  try {
    viewer.scene.requestRender();
  } catch (e) { }
}

export function focusTileset3D() {
  if (!viewer || !tileset) return;
  try {
    viewer.zoomTo(tileset);
  } catch (e) { }
  try {
    viewer.scene.requestRender();
  } catch (e) { }
}

export function focusTo3D(lat, lng, zoom = 17) {
  const Cesium = getCesium();
  if (!viewer || !Cesium) return;
  // zoom 17 ≈ 高度 400m 程度に対応
  const heightM = Math.max(50, 400 * Math.pow(2, 17 - zoom));
  try {
    viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(lng, lat, heightM),
      duration: 1.5
    });
  } catch (e) { }
}
window.__focusTo3D__ = focusTo3D;

export function fitRoute3D(simRoute, { padding = 60 } = {}) {
  const Cesium = getCesium();
  if (!viewer || !Cesium || !simRoute || simRoute.length < 2) return;
  let minLng = simRoute[0].lng;
  let maxLng = simRoute[0].lng;
  let minLat = simRoute[0].lat;
  let maxLat = simRoute[0].lat;
  for (const p of simRoute) {
    minLng = Math.min(minLng, p.lng);
    maxLng = Math.max(maxLng, p.lng);
    minLat = Math.min(minLat, p.lat);
    maxLat = Math.max(maxLat, p.lat);
  }
  const pad = Math.max(0, Number(padding) || 0) / 111000;
  const rect = Cesium.Rectangle.fromDegrees(minLng - pad, minLat - pad, maxLng + pad, maxLat + pad);
  try {
    viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    viewer.camera.flyTo({ destination: rect, duration: 0.6 });
  } catch (e) { }
}
