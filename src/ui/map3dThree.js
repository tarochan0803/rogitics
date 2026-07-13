// map3dThree.js — 軽量3Dビュー (Three.js)。Cesium の代替。
// 座標系: X=東(m), Z=-匁Em), Y=高さ(m)。地面は XZ 平面、E
import { store } from '../state.js';
import { simulatePathPoses } from '../core/physics.js';
import { coordinateSystem, safeDifference, safeUnion, turf } from '../utils/geo.js';
import { buildRoadUnion } from '../core/feasibility.js';
import { normalizeRouteForVehicle } from '../core/trajectoryPlanner.js';
import { buildIntersectionWidening } from '../core/intersectionWidening.js';
import { RUNTIME_CONFIG } from '../config.js';
import { getMapInstance } from './map2d.js';
import { buildAutonomyDriveReport } from '../sim/autonomy/behaviorPlanner.js';
import { createSafetyMonitor, evaluateSafetyInvariants } from '../sim/safetyMonitor.js';
import { fuseWidthForFeature } from '../core/roadWidthModel.js';
import {
  buildCollisionSolidSet,
  getVehicleEnvelope,
  getVehicleFootprintConfig
} from '../3d/clearanceSolids.js';
import { createPlateauTiles, findPlateauArea } from '../3d/plateauTiles.js';

let THREE = (typeof window !== 'undefined') ? window.THREE : null;

let scene = null;
let camera = null;
let renderer = null;
let controls = null;
let plateauHandle = null;
let plateauActive = false;
let plateauKey = '';
let plateauLoadingKey = '';
let plateauLoadSeq = 0;
let plateauLastStatus = { state: 'idle' };
let animId = null;
let container = null;
let originLL = null;          // { lat, lng } 蝗ｺ螳壼次轤ｹ
let truckGroup = null;
let truckBody = null;
let truckEdges = null;
let truckPaintMeshes = [];
let truckEdgeMeshes = [];
let truckFrontWheels = []; // steering pivots for front axle wheels
let truckTrailObjects = [];
let truckTrailLastM = -Infinity;
let truckTrailLastPos = null;
// 建物マテリアル参照（外観スライダーでライブ更新するため保持）。
let buildingFillMat = null;
let buildingRoofMat = null;
let buildingEdgeMat = null;
let lateralCollisionFeatures = [];
let lateralCollisionBboxes = [];
let overheadCollisionFeatures = []; // heightOnly: 電線/看板/庇など頭上障害物
let overheadCollisionBboxes = [];
let overheadCollisionHeights = [];
let collisionSolidMetrics = { lateral: 0, overhead: 0, lowClearance: 0 };
let collisionAccum = 0;       // 接触チェック間引き用
let contactCount3d = 0;
let safetyRoadSurfaceGeo = null;
let safetyMonitor3D = null;
let safetyLastResult3D = null;
let safetyMrmStop3D = null;
let safetyLastTrace3D = null;
let safetySimTimeS = 0;
let autoDriveOffsetM = 0;
let autoDriveTargetOffsetM = 0;
let autoDriveAvoidCount = 0;
let autoDriveWasOffset = false;
let autoDriveWasDanger = false;
let routeXZ = [];
let routeCum = [];
let progressM = 0;            // 襍ｰ陦御ｽ咲ｽｮ(m)
let drivePoses = [];          // 物理モデルの時系列 pose
let driveTimeS = 0;
let driveDurationS = 0;
let drivePoseMode = false;
let drivePlaybackRouteSource = 'raw';
let drivePlaybackRouteMetrics = null;
let autonomyReport3D = null;
let autonomyCurrentSample = null;
let autonomyCurrentLimit = null;
let recoveryPlayback3D = null;
let recoveryHandledKeys3D = new Set();
let switchbackHandled3D = new Set();
let switchbackHandledZones3D = [];
let recoveryPlaybackCount3D = 0;
let recoveryBypassUntilM = 0;
let recoveryOffsetHoldM = 0;
let recoveryOffsetHoldUntilM = 0;
let truckRenderHeading = 0;
let lastTruckPos = null;
let playing = false;
let followCam = true;
let lastTs = 0;
let google2dTileSessionPromise = null;
let google2dTileSession = null;
let cachedRoadSurfaceSig = '';
let cachedRoadSurfaceGeo = null;
let lastRoadQualityMetrics = { intersectionCaps: 0, roadEdges: 0, centerlines: 0, onewayArrows: 0 };
let lastIntersectionNodes = []; // 交差点コーナー補正ノード（描画・メトリクス用）

const ROAD_SURFACE_COLOR = 0x273447;
const ROAD_SURFACE_ALPHA = 0.28;
const ROAD_SURFACE_HEIGHT = 0.04;
const THREE_ROAD_LAYER_DEFAULTS = Object.freeze({
  roadSurface: true,
  road: false,
  centerline: true,
  roadEdge: true,
  sidewalk: false,
  route: true,
  onewayArrow: true,
  intersectionCap: false,
  building: true,
  buildingFootprint: false,
  sweptArea: true,
  truckTrail: true
});
const threeRoadLayerVisibility = { ...THREE_ROAD_LAYER_DEFAULTS };
const AUTODRIVE_LOOKAHEAD_M = [0, 2, 4, 7, 10, 14];
const AUTODRIVE_LATERAL_CANDIDATES_M = [0, 0.35, -0.35, 0.7, -0.7, 1.05, -1.05, 1.4, -1.4, 1.85, -1.85, 2.3, -2.3];
const AUTODRIVE_OFFSET_EPS = 0.04;
const AUTONOMY_SENSOR_PREVIEW_LIMIT = 56;
const TRUCK_TRAIL_STEP_M = 1.25;
const TRUCK_TRAIL_MAX = 360;
const GROUND_TILE_DEFAULT_ZOOM = 19;
const GROUND_TILE_RADIUS = 4; // 9x9 tiles. HighDPI z19 keeps coverage usable while improving close-up detail.
const DEFAULT_THREE3D_PIXEL_RATIO_MAX = 1.25;

function isReady() { return !!(THREE && renderer && scene); }

function numericWindowValue(name, fallback, min = -Infinity, max = Infinity) {
  if (typeof window === 'undefined') return fallback;
  const raw = Number(window[name]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(max, raw));
}

function rendererPixelRatioMax() {
  return numericWindowValue('THREE3D_PIXEL_RATIO_MAX', DEFAULT_THREE3D_PIXEL_RATIO_MAX, 0.75, 2);
}

function applyRendererPixelRatio() {
  if (!renderer) return;
  const dpr = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1;
  renderer.setPixelRatio(Math.min(dpr, rendererPixelRatioMax()));
}

function currentRoadSurfaceAlpha() {
  return numericWindowValue('ROAD_SURFACE_ALPHA', ROAD_SURFACE_ALPHA, 0.03, 0.6);
}

function setObjectTagVisible(tag, visible) {
  if (!scene || !tag) return;
  scene.traverse((obj) => {
    if (obj?.userData?.tag === tag) obj.visible = !!visible;
  });
}

function applyThreeRoadLayerVisibility() {
  for (const [tag, visible] of Object.entries(threeRoadLayerVisibility)) {
    setObjectTagVisible(tag, visible);
  }
}

// 動的に生成されるメッシュ（軌跡など）が、再描画を待たず即座に現在の表示状態に従うように。
function layerVisible(tag) {
  return threeRoadLayerVisibility[tag] !== false;
}

function applyRoadSurfaceAlpha(alpha = currentRoadSurfaceAlpha()) {
  if (!scene) return;
  const opacity = Math.max(0.03, Math.min(0.6, Number(alpha) || ROAD_SURFACE_ALPHA));
  scene.traverse((obj) => {
    if (obj?.userData?.tag !== 'roadSurface') return;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const mat of mats) {
      if (!mat) continue;
      mat.transparent = true;
      mat.opacity = opacity;
      mat.depthWrite = false;
      mat.needsUpdate = true;
    }
  });
}

export function setThreeRoadLayerVisible(tag, visible) {
  if (!Object.prototype.hasOwnProperty.call(threeRoadLayerVisibility, tag)) return false;
  threeRoadLayerVisibility[tag] = !!visible;
  setObjectTagVisible(tag, visible);
  return true;
}

export function getThreeRoadLayerVisibility() {
  return { ...threeRoadLayerVisibility };
}

export function resetThreeRoadLayerVisibility() {
  Object.assign(threeRoadLayerVisibility, THREE_ROAD_LAYER_DEFAULTS);
  applyThreeRoadLayerVisibility();
  return getThreeRoadLayerVisibility();
}

export function setThreeRoadSurfaceAlpha(alpha) {
  const value = Math.max(0.03, Math.min(0.6, Number(alpha) || ROAD_SURFACE_ALPHA));
  if (typeof window !== 'undefined') window.ROAD_SURFACE_ALPHA = value;
  applyRoadSurfaceAlpha(value);
  return value;
}

// 濃さ(0=白, 1=黒)をグレースケールのhexへ変換。建物外形線の「濃さ」スライダー用。
function darknessToHex(d) {
  const v = Math.max(0, Math.min(1, Number(d)));
  const ch = Math.round(255 * (1 - v));
  return (ch << 16) | (ch << 8) | ch;
}

// 建物の外観（塗り/屋根/外形線の不透明度・外形線の濃さ）をライブ更新する。
// window.* に保存しつつ、現在のマテリアルにも即反映（描画ループが常時回るので次フレームで反映）。
export function setThreeBuildingAppearance(patch = {}) {
  if (typeof window === 'undefined') return;
  if (patch.fillOpacity != null) {
    const v = Math.max(0.15, Math.min(0.95, Number(patch.fillOpacity)));
    window.BUILDING_FILL_OPACITY = v;
    if (buildingFillMat) buildingFillMat.opacity = v;
  }
  if (patch.roofOpacity != null) {
    const v = Math.max(0.05, Math.min(0.95, Number(patch.roofOpacity)));
    window.BUILDING_ROOF_OPACITY = v;
    if (buildingRoofMat) buildingRoofMat.opacity = v;
  }
  if (patch.edgeOpacity != null) {
    const v = Math.max(0.1, Math.min(1.0, Number(patch.edgeOpacity)));
    window.BUILDING_EDGE_OPACITY = v;
    if (buildingEdgeMat) buildingEdgeMat.opacity = v;
  }
  if (patch.edgeDarkness != null) {
    const hex = darknessToHex(patch.edgeDarkness);
    window.BUILDING_EDGE_COLOR = hex;
    if (buildingEdgeMat) buildingEdgeMat.color.setHex(hex);
  }
}

// PLATEAU 3D建物の不透明度をライブ調整。window.PLATEAU_OPACITY を更新し、現在のタイル群へ即時再適用。
export function setThreePlateauOpacity(opacity) {
  if (typeof window === 'undefined') return;
  const value = Math.max(0.15, Math.min(1, Number(opacity)));
  window.PLATEAU_OPACITY = value;
  try { plateauHandle?.applyOpacity?.(); } catch (_e) { /* タイル未読込時は無視 */ }
  return value;
}

function autoDriveOffsetResponseS() {
  return numericWindowValue('AUTODRIVE_OFFSET_RESPONSE_S', 1.35, 0.25, 5.0);
}

function autoDriveOffsetMaxRateMps() {
  return numericWindowValue('AUTODRIVE_OFFSET_MAX_RATE_MPS', 0.55, 0.1, 3.0);
}

function approachAutoDriveOffset(targetM, dtS) {
  const target = Number.isFinite(Number(targetM)) ? Number(targetM) : 0;
  const dt = Math.max(0.001, Math.min(0.2, Number(dtS) || 0.016));
  const response = autoDriveOffsetResponseS();
  const alpha = 1 - Math.exp(-dt / response);
  const desiredDelta = (target - autoDriveOffsetM) * alpha;
  const maxDelta = autoDriveOffsetMaxRateMps() * dt;
  const delta = Math.max(-maxDelta, Math.min(maxDelta, desiredDelta));
  autoDriveOffsetM += delta;
  if (Math.abs(autoDriveOffsetM) < AUTODRIVE_OFFSET_EPS && Math.abs(target) < AUTODRIVE_OFFSET_EPS) {
    autoDriveOffsetM = 0;
  }
  return autoDriveOffsetM;
}

function truckTrailMode() {
  const mode = String(window.TRUCK_TRAIL_MODE || 'footprint').toLowerCase();
  return mode === 'footprint' ? 'footprint' : 'line';
}

function truckTrailStepM() {
  return TRUCK_TRAIL_STEP_M;
}

function truckTrailMax() {
  return TRUCK_TRAIL_MAX;
}

function truckTrailRadiusM() {
  return numericWindowValue('TRUCK_TRAIL_RADIUS_M', 0.22, 0.03, 1.0);
}

function truckTrailHeightM() {
  return numericWindowValue('TRUCK_TRAIL_HEIGHT_M', 0.28, 0.05, 3.0);
}

function truckTrailVolumeAlpha() {
  return numericWindowValue('TRUCK_TRAIL_VOLUME_ALPHA', 0.1, 0.02, 0.5);
}

function trimTruckTrailObjects(limit = truckTrailMax()) {
  while (truckTrailObjects.length > limit) {
    const old = truckTrailObjects.shift();
    scene?.remove(old);
    old?.geometry?.dispose?.();
    old?.material?.dispose?.();
  }
}

function addTruckTrailDot(pos, danger = false) {
  if (!pos || !THREE || !scene) return false;
  const geo = new THREE.SphereGeometry(truckTrailRadiusM() * 1.7, 12, 8);
  const mat = new THREE.MeshBasicMaterial({
    color: danger ? 0xef4444 : 0xf59e0b,
    transparent: true,
    opacity: 0.9,
    depthTest: false,
    depthWrite: false
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'truck-center-trail';
  mesh.userData.tag = 'truckTrail';
  mesh.visible = layerVisible('truckTrail');
  mesh.position.set(pos.x, truckTrailHeightM(), pos.z);
  mesh.renderOrder = 20;
  scene.add(mesh);
  truckTrailObjects.push(mesh);
  trimTruckTrailObjects();
  return true;
}

function addTruckTrailSegment(prev, pos, danger = false) {
  if (!prev || !pos || !THREE || !scene) return false;
  const y = truckTrailHeightM();
  const a = new THREE.Vector3(prev.x, y, prev.z);
  const b = new THREE.Vector3(pos.x, y, pos.z);
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  if (!(len > 0.05)) return false;
  const geo = new THREE.CylinderGeometry(truckTrailRadiusM(), truckTrailRadiusM(), len, 10, 1, true);
  const mat = new THREE.MeshBasicMaterial({
    color: danger ? 0xef4444 : 0xf59e0b,
    transparent: true,
    opacity: 0.88,
    depthTest: false,
    depthWrite: false
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'truck-center-trail';
  mesh.userData.tag = 'truckTrail';
  mesh.visible = layerVisible('truckTrail');
  mesh.position.copy(a).add(b).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  mesh.renderOrder = 20;
  scene.add(mesh);
  truckTrailObjects.push(mesh);
  trimTruckTrailObjects();
  return true;
}

export function isThree3DOpen() {
  const wrap = document.getElementById('map3dWrap');
  return !!wrap && wrap.classList.contains('open');
}

// ── 緯度経度 → XZ メートル（原点固定） ──────────────────────────
function llToXZ(lat, lng) {
  const mPerLat = 111320;
  const mPerLng = 111320 * Math.cos((originLL?.lat || 0) * Math.PI / 180);
  return {
    x: (lng - originLL.lng) * mPerLng,
    z: -(lat - originLL.lat) * mPerLat
  };
}

// XZ メートル → 緯度経度（接触判定で turf に渡すため）
function xzToLL(x, z) {
  const mPerLat = 111320;
  const mPerLng = 111320 * Math.cos((originLL?.lat || 0) * Math.PI / 180);
  return {
    lat: originLL.lat - z / mPerLat,
    lng: originLL.lng + x / mPerLng
  };
}

function normAngle(a) {
  let out = a;
  while (out > Math.PI) out -= Math.PI * 2;
  while (out < -Math.PI) out += Math.PI * 2;
  return out;
}

function getPlaybackSpeedScale() {
  if (typeof document === 'undefined') return 1;
  const raw = Number(document.getElementById('playbackSpeed')?.value);
  if (!Number.isFinite(raw)) return 1;
  return Math.max(0.25, Math.min(4, raw));
}

function headingFromPhysicsTheta(theta) {
  return Math.atan2(Math.cos(theta), Math.sin(theta));
}

function interpolateAngle(a, b, t) {
  return normAngle(a + normAngle(b - a) * t);
}

function setSimTelemetry({ speedMS = 0, steeringAngle = 0, model = 'kinematic bicycle' } = {}) {
  const modelEl = document.getElementById('map3dModelStatus');
  const speedEl = document.getElementById('map3dSpeedStatus');
  const steerEl = document.getElementById('map3dSteerStatus');
  if (modelEl) modelEl.textContent = model;
  if (speedEl) speedEl.textContent = `${(Number(speedMS || 0) * 3.6).toFixed(1)}km/h`;
  if (steerEl) steerEl.textContent = `${(Number(steeringAngle || 0) * 180 / Math.PI).toFixed(1)}deg`;
}

function setAutonomyTelemetry(sample = null, report = autonomyReport3D, limit = null) {
  const statusEl = document.getElementById('map3dAutonomyStatus');
  const sensorEl = document.getElementById('map3dSensorStatus');
  const summary = report?.summary || {};
  const mode = limit?.mode || sample?.mode || summary.status || 'standby';
  if (statusEl) {
    const stop = Number(summary.stopEventCount || 0);
    const slow = Number(summary.slowEventCount || 0);
    statusEl.textContent = `${mode}${stop ? ` / stop ${stop}` : (slow ? ` / slow ${slow}` : '')}`;
    statusEl.classList.toggle('ng', mode === 'STOP');
    statusEl.classList.toggle('warn', ['SLOW', 'YIELD', 'SATURATED', 'ROAD_EDGE_CRAWL', 'MONITORED_CRAWL', 'RECOVER'].includes(mode));
  }
  if (sensorEl) {
    const clearance = sample?.forwardClearanceM ?? summary.minForwardClearanceM;
    const allowed = Number.isFinite(Number(limit?.allowedMS))
      ? Number(limit.allowedMS) * 3.6
      : (sample?.allowedSpeedKmh ?? summary.minAllowedSpeedKmh);
    const clearanceText = Number.isFinite(Number(clearance)) ? `${Number(clearance).toFixed(1)}m` : `${summary.sensorRangeM || '-'}m+`;
    const speedText = Number.isFinite(Number(allowed)) ? `${Number(allowed).toFixed(1)}km/h` : '-';
    sensorEl.textContent = `${clearanceText} / ${speedText}`;
  }
}

// ── シーン初期匁E─────────────────────────────────────────────────────
function ensureScene() {
  if (!THREE && typeof window !== 'undefined' && window.THREE) THREE = window.THREE;
  if (!THREE) { console.warn('[three3d] THREE is not ready'); return false; }
  container = document.getElementById('map3d');
  if (!container) return false;
  if (renderer) return true;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0f172a);
  scene.fog = new THREE.Fog(0x0f172a, 300, 1200);
  if (typeof window !== 'undefined') window.__scene3d = scene; // デバッグ/検証用にシーンを公開
  const w = container.clientWidth || 800;
  const h = container.clientHeight || 500;
  camera = new THREE.PerspectiveCamera(55, w / h, 0.5, 5000);
  camera.position.set(40, 60, 80);

  const antialias = typeof window !== 'undefined' && window.THREE3D_ANTIALIAS === true;
  renderer = new THREE.WebGLRenderer({ antialias, powerPreference: 'high-performance' });
  applyRendererPixelRatio();
  renderer.setSize(w, h);
  container.innerHTML = '';
  container.appendChild(renderer.domElement);

  const amb = new THREE.AmbientLight(0xffffff, 0.65);
  scene.add(amb);
  const sun = new THREE.DirectionalLight(0xffffff, 0.9);
  sun.position.set(120, 200, 80);
  scene.add(sun);

  if (THREE.OrbitControls) {
    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.1;
    controls.maxPolarAngle = Math.PI / 2.05; // 地面より下に回り込まない
    controls.addEventListener('start', () => { followCam = false; });
  }

  window.addEventListener('resize', resizeThree3D);
  return true;
}

// ── シーン内容の構築 ─────────────────────────────────────────
function clearMeshesByTag(tag) {
  if (!scene) return;
  const remove = [];
  scene.traverse((obj) => { if (obj.userData && obj.userData.tag === tag) remove.push(obj); });
  remove.forEach((o) => { scene.remove(o); o.geometry?.dispose?.(); o.material?.dispose?.(); });
}

function countObjectsByTag(tag) {
  if (!scene) return 0;
  let count = 0;
  scene.traverse((obj) => { if (obj.userData && obj.userData.tag === tag) count++; });
  return count;
}


function addGround() {
  clearMeshesByTag('ground');
  const geo = new THREE.PlaneGeometry(4000, 4000);
  const mat = new THREE.MeshLambertMaterial({ color: 0x1e293b });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = -0.05;
  mesh.userData.tag = 'ground';
  scene.add(mesh);
  const grid = new THREE.GridHelper(2000, 200, 0x334155, 0x1e2a44);
  grid.userData.tag = 'ground';
  scene.add(grid);
}

// Webメルカトルのタイル座標ヘルパー。
function _lonToTileX(lon, z) { return (lon + 180) / 360 * Math.pow(2, z); }
function _latToTileY(lat, z) {
  const r = lat * Math.PI / 180;
  return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z);
}
function _tileXToLon(x, z) { return x / Math.pow(2, z) * 360 - 180; }
function _tileYToLat(y, z) {
  const n = Math.PI - 2 * Math.PI * y / Math.pow(2, z);
  return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

function getGoogleMapsKey() {
  return String(
    RUNTIME_CONFIG.googleMapsApiKey ||
    window.LOGISTICS_RUNTIME_CONFIG?.googleMapsApiKey ||
    window.USER_CONFIG?.googleMapsApiKey ||
    ''
  ).trim();
}

async function getGoogle2dTileSession() {
  const key = getGoogleMapsKey();
  if (!key) return null;
  if (google2dTileSession) return google2dTileSession;
  if (!google2dTileSessionPromise) {
    google2dTileSessionPromise = fetch(`https://tile.googleapis.com/v1/createSession?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mapType: 'satellite',
        language: 'ja-JP',
        region: 'JP',
        imageFormat: 'jpeg',
        scale: 'scaleFactor2x',
        highDpi: true
      })
    })
      .then((res) => {
        if (!res.ok) throw new Error(`Google 2D Tiles session failed: HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => {
        if (!data?.session) throw new Error('Google 2D Tiles session missing');
        google2dTileSession = {
          session: data.session,
          tileSize: Number(data.tileWidth || data.tileHeight) || 256
        };
        return google2dTileSession;
      })
      .catch((e) => {
        google2dTileSessionPromise = null;
        console.warn('[three3d] Google 2D satellite tiles unavailable, falling back to GSI', e?.message || e);
        return null;
      });
  }
  return google2dTileSessionPromise;
}

function getGroundTileZoom(provider = {}) {
  try {
    const z = Number(getMapInstance()?.getZoom?.());
    if (Number.isFinite(z)) {
      const preferred = provider.name === 'gsi-seamlessphoto'
        ? Math.round(z)
        : Math.max(GROUND_TILE_DEFAULT_ZOOM, Math.round(z));
      return Math.max(18, Math.min(provider.maxZoom || GROUND_TILE_DEFAULT_ZOOM, preferred));
    }
  } catch (e) { /* ignore */ }
  return Math.min(provider.maxZoom || GROUND_TILE_DEFAULT_ZOOM, GROUND_TILE_DEFAULT_ZOOM);
}

function getCurrentMapCenterLL() {
  try {
    const center = getMapInstance()?.getCenter?.();
    const lat = Number(center?.lat);
    const lng = Number(center?.lng);
    if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
  } catch (e) { /* ignore */ }
  return null;
}

function templateTileUrl(template, z, x, y) {
  return String(template || '')
    .replace(/\{z\}/g, encodeURIComponent(z))
    .replace(/\{x\}/g, encodeURIComponent(x))
    .replace(/\{y\}/g, encodeURIComponent(y));
}

function getCustomSatelliteProvider() {
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
  const tileSize = Number(
    (typeof window !== 'undefined' && window.SATELLITE_TILE_SIZE) ||
    RUNTIME_CONFIG.satelliteTileSize ||
    512
  );
  const name = String(
    (typeof window !== 'undefined' && window.SATELLITE_TILE_NAME) ||
    RUNTIME_CONFIG.satelliteTileName ||
    'custom-satellite'
  );
  return {
    name,
    tileSize: Number.isFinite(tileSize) && tileSize > 0 ? tileSize : 512,
    maxZoom: Number.isFinite(maxZoom) && maxZoom > 0 ? maxZoom : 20,
    url: (z, x, y) => templateTileUrl(template, z, x, y)
  };
}

async function getGroundTileProvider(preferGoogle = true) {
  const custom = getCustomSatelliteProvider();
  if (custom) return custom;
  const key = getGoogleMapsKey();
  const useGoogle = preferGoogle && window.USE_GOOGLE_2D_TILES !== false && !!key;
  if (useGoogle) {
    const session = await getGoogle2dTileSession();
    if (session) {
      return {
        name: 'google-2d-satellite',
        tileSize: session.tileSize || 256,
        maxZoom: 20,
        url: (z, x, y) => `https://tile.googleapis.com/v1/2dtiles/${z}/${x}/${y}?session=${encodeURIComponent(session.session)}&key=${encodeURIComponent(key)}`
      };
    }
  }
  // 非公式エンドポイント(mt1.google.com)はスクレイピング扱いで規約違反のため使わない。
  // 公式 Map Tiles API が使えない場合は GSI 航空写真へフォールバックする。
  return {
    name: 'gsi-seamlessphoto',
    tileSize: 256,
    // GSI seamlessphotoはz18まで。z19以上は404になる。
    maxZoom: 18,
    url: (z, x, y) => `https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/${z}/${x}/${y}.jpg`
  };
}

async function stitchGroundTiles(provider, z, k) {
  const cx = Math.floor(_lonToTileX(originLL.lng, z));
  const cy = Math.floor(_latToTileY(originLL.lat, z));
  const size = 2 * k + 1;
  const canvas = document.createElement('canvas');
  canvas.width = provider.tileSize * size;
  canvas.height = provider.tileSize * size;
  const ctx = canvas.getContext('2d');
  let loaded = 0;

  const jobs = [];
  for (let dy = -k; dy <= k; dy++) {
    for (let dx = -k; dx <= k; dx++) {
      const tx = cx + dx, ty = cy + dy;
      const url = provider.url(z, tx, ty);
      jobs.push(new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          try {
            ctx.drawImage(img, (dx + k) * provider.tileSize, (dy + k) * provider.tileSize, provider.tileSize, provider.tileSize);
            loaded++;
          } catch (e) { /* tainted/bad image: keep blank tile */ }
          resolve();
        };
        img.onerror = () => resolve();
        img.src = url;
      }));
    }
  }
  await Promise.all(jobs);
  return { canvas, cx, cy, loaded };
}

function muddyGroundTexture(canvas) {
  if (!canvas) return canvas;
  const saturation = numericWindowValue('GROUND_TEXTURE_SATURATION', 1.0, 0.05, 1.4);
  const brightness = numericWindowValue('GROUND_TEXTURE_BRIGHTNESS', 1.0, 0.25, 1.4);
  const contrast = numericWindowValue('GROUND_TEXTURE_CONTRAST', 1.0, 0.25, 1.5);
  const blurPx = numericWindowValue('GROUND_TEXTURE_BLUR_PX', 0, 0, 3);
  const tintAlpha = numericWindowValue('GROUND_TEXTURE_TINT_ALPHA', 0, 0, 0.65);
  if (
    Math.abs(saturation - 1) < 0.01
    && Math.abs(brightness - 1) < 0.01
    && Math.abs(contrast - 1) < 0.01
    && blurPx < 0.01
    && tintAlpha < 0.01
  ) {
    return canvas;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  const src = document.createElement('canvas');
  src.width = canvas.width;
  src.height = canvas.height;
  const srcCtx = src.getContext('2d');
  if (!srcCtx) return canvas;
  srcCtx.drawImage(canvas, 0, 0);
  ctx.save();
  try {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.filter = `blur(${blurPx}px) saturate(${saturation}) brightness(${brightness}) contrast(${contrast})`;
    ctx.drawImage(src, 0, 0);
    ctx.filter = 'none';
    if (tintAlpha > 0) {
      ctx.fillStyle = `rgba(10, 16, 22, ${tintAlpha})`;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
  } finally {
    ctx.restore();
  }
  return canvas;
}

// 2Dと同系統の衛星タイルを地面テクスチャとして貼る。
// Google 2D Tiles API が使えればGoogle衛星、失敗時はGSI seamlessphotoへフォールバック、E
async function addSatelliteGround() {
  if (!originLL) return false;
  const k = GROUND_TILE_RADIUS;
  let provider = await getGroundTileProvider(true);
  let z = Math.min(getGroundTileZoom(provider), provider.maxZoom || 19);
  let stitched = await stitchGroundTiles(provider, z, k);
  if (provider.name !== 'gsi-seamlessphoto' && stitched.loaded === 0) {
    provider = await getGroundTileProvider(false);
    z = Math.min(getGroundTileZoom(provider), provider.maxZoom || 18);
    stitched = await stitchGroundTiles(provider, z, k);
  }
  if (stitched.loaded === 0) return false;

  // ステッチ範囲の地理境界 → メートル
  const westLon = _tileXToLon(stitched.cx - k, z);
  const eastLon = _tileXToLon(stitched.cx + k + 1, z);
  const northLat = _tileYToLat(stitched.cy - k, z);
  const southLat = _tileYToLat(stitched.cy + k + 1, z);
  const tl = llToXZ(northLat, westLon);
  const br = llToXZ(southLat, eastLon);
  const width = Math.abs(br.x - tl.x);
  const depth = Math.abs(br.z - tl.z);
  if (!(width > 0) || !(depth > 0)) return false;

  clearMeshesByTag('ground');
  muddyGroundTexture(stitched.canvas);
  const tex = new THREE.CanvasTexture(stitched.canvas);
  tex.anisotropy = renderer?.capabilities?.getMaxAnisotropy?.() || 1;
  if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  const geo = new THREE.PlaneGeometry(width, depth);
  const mat = new THREE.MeshBasicMaterial({ map: tex });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  // Position the stitched tile plane at its geographic center.
  // 衛星画像(特にGoogle)はOSM道路ベクターと測地基準が数m食い違うことがある。
  // window.GROUND_IMAGERY_OFFSET_M = { east, north }（m）で画像をベクターに合わせて微調整できる。
  const imgOff = (typeof window !== 'undefined' && window.GROUND_IMAGERY_OFFSET_M) || {};
  const offEast = Number(imgOff.east) || 0;   // +east(m)
  const offNorth = Number(imgOff.north) || 0; // +north(m) … world z は南正なので減算
  mesh.position.set((tl.x + br.x) / 2 + offEast, -0.1, (tl.z + br.z) / 2 - offNorth);
  mesh.userData.tag = 'ground';
  scene.add(mesh);
  const statusEl = document.getElementById('tilesStatus');
  const tileTotal = (2 * k + 1) ** 2;
  if (statusEl) statusEl.textContent = `3D地面: 衛星画像 ${provider.name} z${z} ${provider.tileSize}px (${stitched.loaded}/${tileTotal} tiles)`;
  console.log(`[three3d] satellite ground loaded: ${provider.name} z${z} ${provider.tileSize}px (${stitched.loaded}/${tileTotal})`);
  return true;
}

function normalizedRingPoints(ring) {
  if (!Array.isArray(ring) || ring.length < 3) return [];
  const out = [];
  for (const pt of ring) {
    const lng = Number(pt?.[0]);
    const lat = Number(pt?.[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const { x, z } = llToXZ(lat, lng);
    out.push({ x, z });
  }
  if (out.length >= 2) {
    const a = out[0];
    const b = out[out.length - 1];
    if (Math.hypot(a.x - b.x, a.z - b.z) < 0.01) out.pop();
  }
  return out.length >= 3 ? out : [];
}

function pathFromBuildingRing(ring) {
  const pts = normalizedRingPoints(ring);
  if (pts.length < 3) return null;
  const path = new THREE.Path();
  pts.forEach((p, i) => {
    if (i === 0) path.moveTo(p.x, -p.z);
    else path.lineTo(p.x, -p.z);
  });
  path.closePath();
  return path;
}

function shapeFromPolygon(poly) {
  if (!Array.isArray(poly) || !poly.length) return null;
  const outer = pathFromBuildingRing(poly[0]);
  if (!outer) return null;
  const shape = new THREE.Shape(outer.getPoints());
  for (let i = 1; i < poly.length; i++) {
    const hole = pathFromBuildingRing(poly[i]);
    if (hole) shape.holes.push(hole);
  }
  return shape;
}

function pushBuildingRingSegments(points, y, out) {
  if (!Array.isArray(points) || points.length < 3) return;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    out.push(new THREE.Vector3(a.x, y, a.z), new THREE.Vector3(b.x, y, b.z));
  }
}

function buildBuildingOutline(poly, minH, height, mat) {
  if (!Array.isArray(poly) || !poly.length) return null;
  const bottomY = Math.max(0, Number(minH) || 0);
  const topY = Math.max(bottomY + 0.2, Number(height) || bottomY + 8);
  const verts = [];
  for (let ringIndex = 0; ringIndex < poly.length; ringIndex++) {
    const pts = normalizedRingPoints(poly[ringIndex]);
    if (pts.length < 3) continue;
    pushBuildingRingSegments(pts, bottomY + 0.03, verts);
    pushBuildingRingSegments(pts, topY + 0.03, verts);
    const stride = pts.length > 80 ? 4 : (pts.length > 36 ? 2 : 1);
    for (let i = 0; i < pts.length; i += stride) {
      const p = pts[i];
      verts.push(new THREE.Vector3(p.x, bottomY + 0.03, p.z), new THREE.Vector3(p.x, topY + 0.03, p.z));
    }
  }
  if (!verts.length) return null;
  const geo = new THREE.BufferGeometry().setFromPoints(verts);
  return new THREE.LineSegments(geo, mat);
}

function addBuildings(buildings) {
  clearMeshesByTag('building');
  // PLATEAU が表示されている時は OSM 押し出しを自動で薄くし、視覚の主張がぶつからないようにする。
  const osmDim = (plateauActive && plateauKeepOsmBuildings()) ? 0.4 : 1.0;
  const fillOpacity = numericWindowValue('BUILDING_FILL_OPACITY', 0.78, 0.15, 0.95) * osmDim;
  const roofOpacity = numericWindowValue('BUILDING_ROOF_OPACITY', 0.72, 0.05, 0.95) * osmDim;
  const edgeOpacity = numericWindowValue('BUILDING_EDGE_OPACITY', 0.38, 0.1, 1.0) * (osmDim < 1 ? 0.6 : 1.0);
  const fillMat = new THREE.MeshLambertMaterial({
    color: 0x8ea0ad,
    transparent: true,
    opacity: fillOpacity,
    side: THREE.FrontSide,
    depthWrite: true
  });
  const roofMat = new THREE.MeshBasicMaterial({
    color: 0xcbd5df,
    transparent: true,
    opacity: roofOpacity,
    side: THREE.DoubleSide,
    depthWrite: true
  });
  // 外形線の色は window.BUILDING_EDGE_COLOR で調整可（既定はダーク=濃い輪郭）。
  const edgeColorHex = Number.isFinite(Number(window.BUILDING_EDGE_COLOR))
    ? Number(window.BUILDING_EDGE_COLOR)
    : 0x26313f;
  const edgeMat = new THREE.LineBasicMaterial({
    color: edgeColorHex,
    transparent: true,
    opacity: edgeOpacity,
    depthTest: true,
    depthWrite: false
  });
  buildingFillMat = fillMat;
  buildingRoofMat = roofMat;
  buildingEdgeMat = edgeMat;
  let count = 0;
  for (const f of buildings || []) {
    const g = f?.geometry;
    if (!g) continue;
    const polys = g.type === 'Polygon' ? [g.coordinates] : (g.type === 'MultiPolygon' ? g.coordinates : null);
    if (!polys) continue;
    const heightRaw = Number(f.properties?.height);
    const height = Number.isFinite(heightRaw) && heightRaw > 0 ? heightRaw : 8;
    const minH = Number(f.properties?.minHeight) || 0;
    for (const poly of polys) {
      const shape = shapeFromPolygon(poly);
      if (!shape) continue;
      try {
        const extrude = new THREE.ExtrudeGeometry(shape, { depth: Math.max(1, height - minH), bevelEnabled: false });
        const mesh = new THREE.Mesh(extrude, fillMat);
        mesh.rotation.x = -Math.PI / 2;
        mesh.position.y = minH;
        mesh.userData.tag = 'building';
        // Render after ground so the see-through alpha blends naturally.
        mesh.renderOrder = 6;
        scene.add(mesh);
        const roof = new THREE.Mesh(new THREE.ShapeGeometry(shape), roofMat);
        roof.rotation.x = -Math.PI / 2;
        roof.position.y = height + 0.035;
        roof.userData.tag = 'building';
        roof.renderOrder = 7;
        scene.add(roof);
        const edges = buildBuildingOutline(poly, minH, height, edgeMat);
        if (edges) {
          edges.userData.tag = 'building';
          edges.renderOrder = 12;
          scene.add(edges);
        }
        count++;
      } catch (e) { /* skip bad polygon */ }
    }
    if (count > 4000) break;
  }
  return count;
}

// 建物の底面リングを地面に線で描く。地面と建物のズレ（PLATEAU高さ補正）確認用。既定は非表示。
function addBuildingFootprints(buildings) {
  clearMeshesByTag('buildingFootprint');
  const visible = layerVisible('buildingFootprint');
  const mat = new THREE.LineBasicMaterial({
    color: 0xfbbf24,
    transparent: true,
    opacity: 0.85,
    depthTest: false,
    depthWrite: false
  });
  let count = 0;
  for (const f of buildings || []) {
    const g = f?.geometry;
    if (!g) continue;
    const polys = g.type === 'Polygon' ? [g.coordinates] : (g.type === 'MultiPolygon' ? g.coordinates : null);
    if (!polys) continue;
    for (const poly of polys) {
      const ring = poly?.[0];
      if (!Array.isArray(ring) || ring.length < 3) continue;
      const pts = ring.map(([lng, lat]) => {
        const { x, z } = llToXZ(lat, lng);
        return new THREE.Vector3(x, 0.06, z);
      });
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat);
      line.userData.tag = 'buildingFootprint';
      line.visible = visible;
      line.renderOrder = 13;
      scene.add(line);
      count++;
      if (count > 4000) break;
    }
    if (count > 4000) break;
  }
  return count;
}

function addExtrudedFeature(feature, heightM, tag, mat, { minHeightM = 0 } = {}) {
  const g = feature?.geometry;
  if (!g) return 0;
  const polys = g.type === 'Polygon' ? [g.coordinates] : (g.type === 'MultiPolygon' ? g.coordinates : null);
  if (!polys) return 0;
  let count = 0;
  for (const poly of polys) {
    const ring = poly?.[0];
    if (!Array.isArray(ring) || ring.length < 3) continue;
    const shape = new THREE.Shape();
    ring.forEach((pt, i) => {
      const { x, z } = llToXZ(pt[1], pt[0]);
      if (i === 0) shape.moveTo(x, -z);
      else shape.lineTo(x, -z);
    });
    try {
      const extrude = new THREE.ExtrudeGeometry(shape, {
        depth: Math.max(0.2, Number(heightM) - Number(minHeightM || 0)),
        bevelEnabled: false
      });
      const mesh = new THREE.Mesh(extrude, mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = Number(minHeightM || 0);
      mesh.userData.tag = tag;
      scene.add(mesh);
      count++;
    } catch (_err) { }
  }
  return count;
}

function addFlatFeatureAtHeight(feature, heightM, tag, mat) {
  const g = feature?.geometry;
  if (!g) return 0;
  const polys = g.type === 'Polygon' ? [g.coordinates] : (g.type === 'MultiPolygon' ? g.coordinates : null);
  if (!polys) return 0;
  let count = 0;
  for (const poly of polys) {
    const ring = poly?.[0];
    if (!Array.isArray(ring) || ring.length < 3) continue;
    const path = pathFromRing(ring);
    if (!path) continue;
    try {
      const shape = new THREE.Shape(path.getPoints());
      const geo = new THREE.ShapeGeometry(shape);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = Math.max(0.2, Number(heightM) || 0);
      mesh.renderOrder = 4;
      mesh.userData.tag = tag;
      scene.add(mesh);

      const edgeGeo = new THREE.EdgesGeometry(geo);
      const edge = new THREE.LineSegments(edgeGeo, new THREE.LineBasicMaterial({ color: 0xf97316, transparent: true, opacity: 0.9 }));
      edge.rotation.x = -Math.PI / 2;
      edge.position.y = mesh.position.y + 0.02;
      edge.userData.tag = tag;
      scene.add(edge);
      count++;
    } catch (_err) { }
  }
  return count;
}

function addCollisionSolids(solidSet, state) {
  clearMeshesByTag('collisionSolid');
  clearMeshesByTag('overheadSolid');
  const obstacleMat = new THREE.MeshLambertMaterial({ color: 0xef4444, transparent: true, opacity: 0.32, side: THREE.DoubleSide });
  const overheadOkMat = new THREE.MeshBasicMaterial({ color: 0x22c55e, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false });
  const overheadNgMat = new THREE.MeshBasicMaterial({ color: 0xef4444, transparent: true, opacity: 0.34, side: THREE.DoubleSide, depthWrite: false });
  const envelope = getVehicleEnvelope(state, { clearanceMargin: 0.25 });
  let obstacleCount = 0;
  let overheadCount = 0;
  let lowClearance = 0;

  for (const solid of solidSet?.obstacleSolids || []) {
    obstacleCount += addExtrudedFeature(solid.feature, solid.heightM || 3, 'collisionSolid', obstacleMat);
  }
  for (const solid of solidSet?.overheadSolids || []) {
    const h = Number(solid.heightM) || 0;
    const ng = solid.clearanceReliable !== false && h < envelope.requiredHeightM;
    if (ng) lowClearance++;
    overheadCount += addFlatFeatureAtHeight(solid.feature, h, 'overheadSolid', ng ? overheadNgMat : overheadOkMat);
  }

  collisionSolidMetrics = {
    lateral: (solidSet?.lateralSolids || []).length,
    buildings: (solidSet?.buildingSolids || []).length,
    obstacles: (solidSet?.obstacleSolids || []).length,
    overhead: (solidSet?.overheadSolids || []).length,
    renderedObstacles: obstacleCount,
    renderedOverhead: overheadCount,
    lowClearance,
    requiredHeightM: envelope.requiredHeightM
  };
  return obstacleCount + overheadCount;
}

function routeSig3D(route) {
  const arr = Array.isArray(route) ? route : [];
  if (!arr.length) return '0';
  const a = arr[0];
  const b = arr[arr.length - 1];
  return `${arr.length}:${Number(a.lat).toFixed(6)},${Number(a.lng).toFixed(6)}:${Number(b.lat).toFixed(6)},${Number(b.lng).toFixed(6)}`;
}

function roadsSig3D(roads) {
  const arr = Array.isArray(roads) ? roads : [];
  if (!arr.length) return '0';
  const first = String(arr[0]?.id ?? arr[0]?.properties?.id ?? '');
  const last = String(arr[arr.length - 1]?.id ?? arr[arr.length - 1]?.properties?.id ?? '');
  return `${arr.length}:${first}:${last}`;
}

function widthOverridesSig3D(overrides) {
  const o = overrides && typeof overrides === 'object' ? overrides : {};
  const keys = Object.keys(o).sort();
  if (!keys.length) return 'w:0';
  return 'w:' + keys.map((k) => `${k}=${Number(o[k]).toFixed(2)}`).join(',');
}

function maskSig3D(maskEdits) {
  const edits = maskEdits && typeof maskEdits === 'object' ? maskEdits : {};
  const collect = (arr) => (Array.isArray(arr) ? arr : [])
    .map((f) => String(f?.properties?.id ?? f?.id ?? ''))
    .filter(Boolean)
    .sort()
    .join(',');
  return `a:${collect(edits.allow)}:d:${collect(edits.deny)}`;
}

function roundMetric(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const scale = 10 ** digits;
  return Math.round(n * scale) / scale;
}

function buildPlaybackRouteForVehicle(route, state) {
  drivePlaybackRouteSource = 'raw';
  drivePlaybackRouteMetrics = null;
  if (!Array.isArray(route) || route.length < 2) return route || [];

  // 3D再生では確定済みの走行ルートだけを丸める。
  // selectedRoadRoute や候補再採点を使うと、粗い選択線を再解釈して斜めに飛ぶ経路を作ることがある。
  try {
    const normalized = normalizeRouteForVehicle(route, state?.vehicleConfig || {});
    if (Array.isArray(normalized) && normalized.length >= 2) {
      drivePlaybackRouteSource = 'route-normalizer';
      drivePlaybackRouteMetrics = {
        inputPoints: route.length,
        outputPoints: normalized.length,
        pointGrowth: roundMetric(normalized.length / Math.max(1, route.length), 2)
      };
      return normalized;
    }
  } catch (e) {
    console.warn('[three3d] playback route normalization failed, using raw route:', e?.message || e);
  }

  drivePlaybackRouteMetrics = {
    inputPoints: route.length,
    outputPoints: route.length,
    reason: 'raw-route'
  };
  return route;
}

function isPolygonFeature(feature) {
  const type = feature?.geometry?.type;
  return type === 'Polygon' || type === 'MultiPolygon';
}

function applyMaskEditsToRoadSurface(roadSurface, maskEdits) {
  if (!roadSurface) return roadSurface;
  const edits = maskEdits && typeof maskEdits === 'object' ? maskEdits : {};
  let cur = roadSurface;

  for (const f of (Array.isArray(edits.allow) ? edits.allow : [])) {
    if (!isPolygonFeature(f)) continue;
    try { cur = safeUnion(cur, f); } catch (e) { }
  }
  for (const f of (Array.isArray(edits.deny) ? edits.deny : [])) {
    if (!isPolygonFeature(f)) continue;
    try {
      const next = safeDifference(cur, f);
      cur = next || null;
      if (!cur) break;
    } catch (e) { }
  }
  return cur;
}

function getRoadSurfaceGeo(state) {
  const route = state?.simRoute || [];
  const roads = state?.geoJsonDataSets || [];
  if (!route.length || route.length < 2 || !roads.length) return null;

  // 交差点コーナー補正ノードは描画/メトリクス用に常に算出（旋回半径ベース）。
  const widening = buildIntersectionWidening(route, state?.vehicleConfig || {});
  lastIntersectionNodes = widening.nodes;
  lastRoadQualityMetrics.intersectionCaps = widening.count;

  // 判定側(analyzeContactFeasibility)が生成した roadUnion は既に同じ補正キャップを含む。
  const fromFeasibility = state?._lastFeasibilityLayers?.roadUnion || null;
  if (fromFeasibility) return fromFeasibility;

  const sig = [
    routeSig3D(route),
    roadsSig3D(roads),
    Number(state?.vehicleConfig?.vehicleWidth ?? 0).toFixed(2),
    Number(state?.vehicleConfig?.widthMargin ?? 0).toFixed(2),
    maskSig3D(state?.maskEdits),
    widthOverridesSig3D(state?.widthOverrides) // Phase2: 手動幅上書きでキャッシュを無効化し3D路面を即時更新
  ].join('|');
  if (sig === cachedRoadSurfaceSig) return cachedRoadSurfaceGeo;

  cachedRoadSurfaceSig = sig;
  cachedRoadSurfaceGeo = null;

  try {
    if (!turf?.lineString || !turf?.buffer || !turf?.bbox) return null;
    const line = turf.lineString(route.map((p) => [p.lng, p.lat]));
    const corridor = turf.buffer(line, 120, { units: 'meters', steps: 6 });
    const clipBox = turf.bbox(corridor);
    const vehicleWidth = Number(state?.vehicleConfig?.vehicleWidth ?? 0);
    const widthMargin = Number(state?.vehicleConfig?.widthMargin ?? 0.3);
    const defaultW = Math.max(6, vehicleWidth + widthMargin * 2);
    // 交差点コーナー補正キャップを buildRoadUnion に渡し、判定側と同じ補正後の道路面を得る。
    const roadSurface = buildRoadUnion(roads, defaultW, 0, clipBox, { intersectionCaps: widening.caps });
    const surface = applyMaskEditsToRoadSurface(roadSurface, state?.maskEdits);
    cachedRoadSurfaceGeo = surface;
  } catch (e) {
    cachedRoadSurfaceGeo = null;
  }

  return cachedRoadSurfaceGeo;
}

function countGeoVertices(geo) {
  const g = geo?.type === 'Feature' ? geo.geometry : geo;
  if (!g) return 0;
  let count = 0;
  if (g.type === 'Polygon') {
    for (const ring of g.coordinates || []) count += ring?.length || 0;
  } else if (g.type === 'MultiPolygon') {
    for (const poly of g.coordinates || []) {
      for (const ring of poly || []) count += ring?.length || 0;
    }
  }
  return count;
}

function simplifyRoadSurfaceGeo(geo) {
  if (!geo || countGeoVertices(geo) <= 5000 || !turf?.simplify) return geo;
  try {
    return turf.simplify(geo, { tolerance: 0.0000025, highQuality: false, mutate: false }) || geo;
  } catch (e) {
    return geo;
  }
}

function pathFromRing(ring) {
  if (!Array.isArray(ring) || ring.length < 3) return null;
  const path = new THREE.Path();
  let started = false;
  for (const pt of ring) {
    const lng = Number(pt?.[0]);
    const lat = Number(pt?.[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const { x, z } = llToXZ(lat, lng);
    if (!started) {
      path.moveTo(x, -z);
      started = true;
    } else {
      path.lineTo(x, -z);
    }
  }
  return started ? path : null;
}

function addRoadSurfacePolygon(poly, mat) {
  if (!Array.isArray(poly) || poly.length < 1) return 0;
  const outer = pathFromRing(poly[0]);
  if (!outer) return 0;
  const shape = new THREE.Shape(outer.getPoints());
  for (let i = 1; i < poly.length; i++) {
    const hole = pathFromRing(poly[i]);
    if (hole) shape.holes.push(hole);
  }
  try {
    const geo = new THREE.ShapeGeometry(shape);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = ROAD_SURFACE_HEIGHT;
    mesh.renderOrder = 2;
    mesh.userData.tag = 'roadSurface';
    scene.add(mesh);
    return 1;
  } catch (e) {
    return 0;
  }
}

let lastRoadSurfaceMetrics = { areaM2: 0, vertices: 0, polygons: 0 };

function addRoadSurface(roadSurfaceGeo) {
  clearMeshesByTag('roadSurface');
  lastRoadSurfaceMetrics = { areaM2: 0, vertices: 0, polygons: 0 };
  if (!roadSurfaceGeo) return 0;
  const simplified = simplifyRoadSurfaceGeo(roadSurfaceGeo);
  const geom = simplified?.geometry || simplified;
  if (!geom) return 0;

  // Phase2検証用: レンダリングした走行面の面積/頂点数を記録（幅上書き前後の比較に使う）
  try {
    lastRoadSurfaceMetrics.vertices = countGeoVertices(simplified);
    if (turf?.area) lastRoadSurfaceMetrics.areaM2 = Math.round(turf.area(simplified));
    lastRoadSurfaceMetrics.polygons = geom.type === 'MultiPolygon' ? (geom.coordinates?.length || 0) : 1;
  } catch (_) {}

  const mat = new THREE.MeshBasicMaterial({
    color: ROAD_SURFACE_COLOR,
    transparent: true,
    opacity: currentRoadSurfaceAlpha(),
    side: THREE.DoubleSide,
    depthWrite: false
  });

  let count = 0;
  if (geom.type === 'Polygon') {
    count += addRoadSurfacePolygon(geom.coordinates, mat);
  } else if (geom.type === 'MultiPolygon') {
    for (const poly of geom.coordinates || []) count += addRoadSurfacePolygon(poly, mat);
  }
  return count;
}

function addRoads(roads) {
  clearMeshesByTag('road');
  const mat = new THREE.LineBasicMaterial({ color: 0x64748b, transparent: true, opacity: 0.28 });
  let count = 0;
  for (const f of roads || []) {
    const g = f?.geometry;
    if (!g) continue;
    const lines = g.type === 'LineString' ? [g.coordinates]
      : (g.type === 'MultiLineString' ? g.coordinates : null);
    if (!lines) continue;
    for (const coords of lines) {
      if (!Array.isArray(coords) || coords.length < 2) continue;
      const pts = coords.map(([lng, lat]) => {
        const { x, z } = llToXZ(lat, lng);
        return new THREE.Vector3(x, 0.15, z);
      });
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const line = new THREE.Line(geo, mat);
      line.userData.tag = 'road';
      scene.add(line);
      count++;
    }
    if (count > 6000) break;
  }
  return count;
}

// 交差点コーナー補正の可視化（旋回半径ベースのキャップ円を地面に描く）。
function addIntersectionCaps(nodes) {
  clearMeshesByTag('intersectionCap');
  const arr = Array.isArray(nodes) ? nodes : [];
  if (!arr.length) return 0;
  const visible = layerVisible('intersectionCap');
  const mat = new THREE.LineBasicMaterial({
    color: 0xa78bfa,
    transparent: true,
    opacity: 0.8,
    depthTest: false,
    depthWrite: false
  });
  const SEG = 28;
  let count = 0;
  for (const node of arr) {
    if (!Number.isFinite(node?.lat) || !Number.isFinite(node?.lng)) continue;
    const center = llToXZ(node.lat, node.lng);
    const rM = Math.max(0.5, Number(node.radiusM) || 1);
    const pts = [];
    for (let k = 0; k <= SEG; k++) {
      const t = (k / SEG) * Math.PI * 2;
      pts.push(new THREE.Vector3(center.x + Math.cos(t) * rM, 0.07, center.z + Math.sin(t) * rM));
    }
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat);
    line.userData.tag = 'intersectionCap';
    line.visible = visible;
    line.renderOrder = 14;
    scene.add(line);
    count++;
  }
  return count;
}

function roadTags(feature) {
  const props = feature?.properties || {};
  return (props.tags && typeof props.tags === 'object') ? props.tags : props;
}

function onewayDirectionFromTags(tags = {}) {
  const raw = String(tags.oneway ?? tags['oneway:vehicle'] ?? '').trim().toLowerCase();
  if (raw === 'yes' || raw === '1' || raw === 'true') return 1;
  if (raw === '-1' || raw === 'reverse') return -1;
  const junction = String(tags.junction || '').trim().toLowerCase();
  if (junction === 'roundabout' || junction === 'circular') return 1;
  return 0;
}

function addOnewayArrows(roads) {
  clearMeshesByTag('onewayArrow');
  lastRoadQualityMetrics.onewayArrows = 0;
  if (!THREE || !scene) return 0;
  const maxArrows = 850;
  const minSegmentM = 10;
  const spacingM = 34;
  const arrowLen = 3.6;
  const arrowHalfW = 1.25;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, -arrowLen * 0.55,
    -arrowHalfW, 0, arrowLen * 0.45,
    arrowHalfW, 0, arrowLen * 0.45
  ], 3));
  geo.setIndex([0, 1, 2]);
  geo.computeVertexNormals();
  const mat = new THREE.MeshBasicMaterial({
    color: 0xfff1a8,
    transparent: true,
    opacity: 0.88,
    side: THREE.DoubleSide,
    depthWrite: false,
    depthTest: false
  });

  const transforms = [];
  const placeArrow = (x, z, heading) => {
    if (transforms.length >= maxArrows) return;
    transforms.push({ x, z, heading });
  };

  for (const f of roads || []) {
    const tags = roadTags(f);
    const dir = onewayDirectionFromTags(tags);
    if (!dir) continue;
    const g = f?.geometry;
    if (!g) continue;
    const lines = g.type === 'LineString' ? [g.coordinates]
      : (g.type === 'MultiLineString' ? g.coordinates : null);
    if (!lines) continue;
    for (const coords of lines) {
      if (!Array.isArray(coords) || coords.length < 2) continue;
      for (let i = 0; i < coords.length - 1; i++) {
        const aLL = coords[i];
        const bLL = coords[i + 1];
        const a = llToXZ(aLL?.[1], aLL?.[0]);
        const b = llToXZ(bLL?.[1], bLL?.[0]);
        if (!Number.isFinite(a.x) || !Number.isFinite(a.z) || !Number.isFinite(b.x) || !Number.isFinite(b.z)) continue;
        let dx = b.x - a.x;
        let dz = b.z - a.z;
        const len = Math.hypot(dx, dz);
        if (!Number.isFinite(len) || len < minSegmentM) continue;
        if (dir < 0) {
          dx = -dx;
          dz = -dz;
        }
        // 矢印ジオメトリは先端=ローカル-z。Y軸回転θで先端の世界方向は(-sinθ,-cosθ)。
        // 道路方向(dx,dz)へ先端を向けるには θ=atan2(-dx,-dz)。
        // （旧 atan2(dx,-dz) は東西道路で逆向き・斜め道路で鏡像になっていた）
        const heading = Math.atan2(-dx, -dz);
        const arrows = Math.max(1, Math.floor(len / spacingM));
        for (let j = 0; j < arrows; j++) {
          const t = (j + 1) / (arrows + 1);
          placeArrow(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t, heading);
          if (transforms.length >= maxArrows) break;
        }
        if (transforms.length >= maxArrows) break;
      }
      if (transforms.length >= maxArrows) break;
    }
    if (transforms.length >= maxArrows) break;
  }
  if (!transforms.length) {
    geo.dispose();
    mat.dispose();
    return 0;
  }
  const mesh = new THREE.InstancedMesh(geo, mat, transforms.length);
  const matrix = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scale = new THREE.Vector3(1, 1, 1);
  for (let i = 0; i < transforms.length; i++) {
    const t = transforms[i];
    pos.set(t.x, 0.68, t.z);
    quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), t.heading);
    matrix.compose(pos, quat, scale);
    mesh.setMatrixAt(i, matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.renderOrder = 9;
  mesh.userData.tag = 'onewayArrow';
  scene.add(mesh);
  lastRoadQualityMetrics.onewayArrows = transforms.length;
  return transforms.length;
}

function addCenterlines(roads) {
  clearMeshesByTag('centerline');
  const mat = new THREE.LineDashedMaterial({
    color: 0xf8fafc,
    dashSize: 2.8,
    gapSize: 2.2,
    transparent: true,
    opacity: 0.62
  });
  let count = 0;
  for (const f of roads || []) {
    const g = f?.geometry;
    if (!g) continue;
    const lines = g.type === 'LineString' ? [g.coordinates]
      : (g.type === 'MultiLineString' ? g.coordinates : null);
    if (!lines) continue;
    for (const coords of lines) {
      if (!Array.isArray(coords) || coords.length < 2) continue;
      const pts = coords.map(([lng, lat]) => {
        const { x, z } = llToXZ(lat, lng);
        return new THREE.Vector3(x, 0.32, z);
      });
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat);
      line.computeLineDistances();
      line.userData.tag = 'centerline';
      scene.add(line);
      count++;
    }
    if (count > 5000) break;
  }
  lastRoadQualityMetrics.centerlines = count;
  return count;
}

function addRoadEdgesFromSurface(roadSurfaceGeo) {
  clearMeshesByTag('roadEdge');
  lastRoadQualityMetrics.roadEdges = 0;
  const geom = roadSurfaceGeo?.geometry || roadSurfaceGeo;
  if (!geom) return 0;
  const mat = new THREE.LineBasicMaterial({ color: 0xe0f2fe, transparent: true, opacity: 0.46 });
  const polygons = geom.type === 'Polygon' ? [geom.coordinates] : (geom.type === 'MultiPolygon' ? geom.coordinates : []);
  let count = 0;
  for (const poly of polygons) {
    for (const ring of poly || []) {
      if (!Array.isArray(ring) || ring.length < 3) continue;
      const pts = ring.map(([lng, lat]) => {
        const { x, z } = llToXZ(lat, lng);
        return new THREE.Vector3(x, 0.36, z);
      });
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat);
      line.userData.tag = 'roadEdge';
      scene.add(line);
      count++;
      if (count > 1000) break;
    }
    if (count > 1000) break;
  }
  lastRoadQualityMetrics.roadEdges = count;
  return count;
}

// Phase2: 歩道/路肩の簡易レイヤー（判定の真値ではなく文脈表示）
function addSidewalks(sidewalks) {
  clearMeshesByTag('sidewalk');
  const arr = Array.isArray(sidewalks) ? sidewalks : [];
  if (!arr.length) return 0;
  const mat = new THREE.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.55 });
  let count = 0;
  for (const f of arr) {
    const g = f?.geometry;
    if (!g) continue;
    const lines = g.type === 'LineString' ? [g.coordinates]
      : (g.type === 'MultiLineString' ? g.coordinates : null);
    if (!lines) continue;
    for (const coords of lines) {
      if (!Array.isArray(coords) || coords.length < 2) continue;
      const pts = coords.map(([lng, lat]) => {
        const { x, z } = llToXZ(lat, lng);
        return new THREE.Vector3(x, 0.22, z);
      });
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat);
      line.userData.tag = 'sidewalk';
      scene.add(line);
      count++;
    }
    if (count > 4000) break;
  }
  return count;
}

// Phase2検証用: 直近に描画した走行面の面穁E頂点数を返す
export function getRoadSurfaceMetrics() {
  return { ...lastRoadSurfaceMetrics };
}

export function getCollisionSolidMetrics() {
  return { ...collisionSolidMetrics, roadQuality: { ...lastRoadQualityMetrics } };
}

export function getAutonomyDriveMetrics() {
  const totalM = routeCum.length ? routeCum[routeCum.length - 1] : 0;
  const liveMode = recoveryPlayback3D
    ? 'RECOVER'
    : (recoveryBypassUntilM > (Number(progressM) || 0) + 0.25
      ? 'RECOVER'
      : (autonomyCurrentLimit?.mode || autonomyCurrentSample?.mode || autonomyReport3D?.summary?.status || null));
  const currentSample = autonomyCurrentSample
    ? {
      sM: autonomyCurrentSample.sM ?? null,
      mode: autonomyCurrentSample.mode ?? null,
      allowedSpeedKmh: autonomyCurrentSample.allowedSpeedKmh ?? null,
      widthMarginM: autonomyCurrentSample.widthMarginM ?? null,
      staticWidthMarginM: autonomyCurrentSample.staticWidthMarginM ?? null,
      narrowSpeedFactor: autonomyCurrentSample.narrowSpeedFactor ?? null,
      swingSoftStop: autonomyCurrentSample.swingSoftStop ?? false,
      curveSwingM: autonomyCurrentSample.curveSwingM ?? null,
      curveSwingWidthMultiplier: autonomyCurrentSample.curveSwingWidthMultiplier ?? null,
      forwardClearanceM: autonomyCurrentSample.forwardClearanceM ?? null,
      blockerId: autonomyCurrentSample.blockerId ?? null,
      pathRadiusM: autonomyCurrentSample.pathRadiusM ?? null,
      effectivePathRadiusM: autonomyCurrentSample.effectivePathRadiusM ?? null,
      turnDeg: autonomyCurrentSample.turnDeg ?? null,
      intersectionRelaxed: autonomyCurrentSample.intersectionRelaxed ?? false,
      intersectionCapRadiusM: autonomyCurrentSample.intersectionCapRadiusM ?? null,
      intersectionCapDistanceM: autonomyCurrentSample.intersectionCapDistanceM ?? null
    }
    : null;
  return autonomyReport3D
    ? {
      ...autonomyReport3D.summary,
      currentMode: liveMode,
      currentForwardClearanceM: autonomyCurrentSample?.forwardClearanceM ?? null,
      currentAllowedSpeedKmh: Number.isFinite(Number(autonomyCurrentLimit?.allowedMS))
        ? Math.round(Number(autonomyCurrentLimit.allowedMS) * 36) / 10
        : (autonomyCurrentSample?.allowedSpeedKmh ?? null),
      currentSample,
      recoveryPlaybackCount: recoveryPlaybackCount3D,
      progressM: Math.round((Number(progressM) || 0) * 10) / 10,
      totalM: Math.round((Number(totalM) || 0) * 10) / 10,
      playing,
      drivePoseMode,
      drivePlaybackRouteSource,
      drivePlaybackRouteMetrics: drivePlaybackRouteMetrics ? { ...drivePlaybackRouteMetrics } : null,
      safety: getSafetyMonitorMetrics(),
      recoveryBypassUntilM: Math.round((Number(recoveryBypassUntilM) || 0) * 10) / 10,
      recoveryOffsetHoldM: Math.round((Number(recoveryOffsetHoldM) || 0) * 100) / 100
    }
    : null;
}

// ── 走行インテリジェンスHUD ──────────────────────────────────────────────
// いま自動運転が「何を考えて」走っているかを常時可視化する。
// モード/速度/幅余裕/勾配/スイング/切り返し/Safety状態。DOMは遅延生成・軽量更新。
const HUD_MODE_STYLE = {
  CRUISE: { label: '巡航', color: '#22c55e' },
  SLOW: { label: '徐行', color: '#f59e0b' },
  YIELD: { label: '譲走', color: '#f97316' },
  SATURATED: { label: '操舵限界', color: '#f59e0b' },
  ROAD_EDGE_CRAWL: { label: '監視徐行', color: '#f59e0b' },
  MONITORED_CRAWL: { label: '監視徐行', color: '#f59e0b' },
  RECOVER: { label: '復旧走行', color: '#a78bfa' },
  STOP: { label: '停止', color: '#ef4444' }
};

function ensureAutonomyHud3D() {
  let el = document.getElementById('l4AutonomyHud');
  if (el) return el;
  const wrap = document.getElementById('map3dWrap');
  if (!wrap) return null;
  el = document.createElement('div');
  el.id = 'l4AutonomyHud';
  el.style.cssText = [
    'position:absolute', 'top:10px', 'right:10px', 'z-index:40',
    'background:rgba(13,20,28,0.88)', 'border:1px solid #2a3a4a', 'border-radius:10px',
    'padding:8px 12px', 'font:12px/1.6 "Segoe UI",Meiryo,sans-serif', 'color:#e6edf3',
    'pointer-events:none', 'min-width:190px', 'backdrop-filter:blur(4px)'
  ].join(';');
  wrap.appendChild(el);
  return el;
}

let hudLastUpdateT = 0;
function updateAutonomyHud3D(sample, limit, speedMS) {
  const now = performance.now();
  if (now - hudLastUpdateT < 120) return; // ~8Hzで十分
  hudLastUpdateT = now;
  const el = ensureAutonomyHud3D();
  if (!el) return;

  const isSwitchback = recoveryPlayback3D?.kind === 'switchback';
  const isRecovery = !!recoveryPlayback3D && !isSwitchback;
  const mrm = safetyMrmStop3D;
  const mode = String(limit?.mode || sample?.mode || 'CRUISE');
  const st = HUD_MODE_STYLE[mode] || HUD_MODE_STYLE.CRUISE;

  let headline;
  if (mrm) headline = `<span style="color:#ef4444;font-weight:700">■ MRM停止</span> <span style="opacity:.8">${mrm.reason === 'safety_invariant_violation' ? '安全違反' : '進入不可'}</span>`;
  else if (isSwitchback) headline = '<span style="color:#a78bfa;font-weight:700">↩ 切り返し中</span> <span style="opacity:.8">K-turn</span>';
  else if (isRecovery) headline = '<span style="color:#a78bfa;font-weight:700">↩ 復旧走行中</span>';
  else headline = `<span style="color:${st.color};font-weight:700">● ${st.label}</span>`;

  const kmh = Math.max(0, (Number(speedMS) || 0) * 3.6);
  const rows = [`<div style="font-size:13px;margin-bottom:2px">${headline}<span style="float:right;font-weight:700">${kmh.toFixed(0)}<span style="font-size:10px;opacity:.7">km/h</span></span></div>`];

  const reasons = [];
  const margin = Number(sample?.widthMarginM);
  if (Number.isFinite(margin)) {
    const c = margin < 0.4 ? '#ef4444' : (margin < 1.0 ? '#f59e0b' : '#8b98a5');
    reasons.push(`<span style="color:${c}">幅余裕 ${margin.toFixed(1)}m</span>`);
  }
  const grade = Number(sample?.gradePct);
  if (Number.isFinite(grade) && Math.abs(grade) >= 3) {
    reasons.push(`<span style="color:#f59e0b">勾配 ${grade.toFixed(1)}%</span>`);
  }
  const swing = Number(sample?.curveSwingM);
  if (Number.isFinite(swing) && swing >= 0.3) {
    reasons.push(`<span style="color:#f59e0b">旋回振出 ${swing.toFixed(1)}m</span>`);
  }
  const clr = Number(sample?.forwardClearanceM);
  if (Number.isFinite(clr)) {
    const c = clr < 8 ? '#ef4444' : '#8b98a5';
    reasons.push(`<span style="color:${c}">前方 ${clr.toFixed(0)}m</span>`);
  }
  if (reasons.length) rows.push(`<div style="opacity:.95">${reasons.join('　')}</div>`);

  const safe = mrm ? { t: 'MRM', c: '#ef4444' }
    : (safetyMonitor3D?.firstViolation ? { t: '違反検出', c: '#ef4444' }
      : (safetyMonitor3D ? { t: '監視中 OK', c: '#22c55e' } : { t: '待機', c: '#8b98a5' }));
  rows.push(`<div style="margin-top:2px;font-size:11px;opacity:.85">Safety: <span style="color:${safe.c}">${safe.t}</span>`
    + `<span style="float:right;opacity:.7">${Math.round(progressM)}m</span></div>`);

  el.innerHTML = rows.join('');
}

export function getSafetyMonitorMetrics() {
  if (!safetyMonitor3D && safetyLastTrace3D?.metrics) {
    return {
      ...safetyLastTrace3D.metrics,
      active: false,
      traceSaved: true
    };
  }
  const first = safetyMonitor3D?.firstViolation || null;
  const last = safetyLastResult3D || safetyMonitor3D?.lastResult || null;
  const status = safetyMrmStop3D
    ? 'MRM_STOP'
    : (first ? 'VIOLATION' : (safetyMonitor3D ? 'OK' : 'IDLE'));
  return {
    active: !!safetyMonitor3D,
    status,
    tick: safetyMonitor3D?.tick || 0,
    progressM: Math.round((Number(progressM) || 0) * 10) / 10,
    routeTotalM: routeCum.length ? Math.round(routeCum[routeCum.length - 1] * 10) / 10 : 0,
    traceHash: safetyMonitor3D?.hash?.() || null,
    traceSaved: !!safetyLastTrace3D,
    firstViolation: first,
    lastViolationCount: Array.isArray(last?.violations) ? last.violations.length : 0,
    mrmStop: safetyMrmStop3D
  };
}

function compiledWorldHashFromState(state) {
  return state?.compiledWorldHash || state?.worldHash || state?.world?.hash || '';
}

function resetSafetyMonitor3D() {
  safetyMonitor3D = null;
  safetyLastResult3D = null;
  safetyMrmStop3D = null;
  safetySimTimeS = 0;
}

function startSafetyMonitor3D(state, speedKmh) {
  safetyMonitor3D = createSafetyMonitor({
    worldHash: compiledWorldHashFromState(state),
    routePoints: Array.isArray(state?.simRoute) ? state.simRoute.length : 0,
    speedKmh: Number(speedKmh) || 18,
    surface: 'three3d'
  });
  safetyLastResult3D = null;
  safetyMrmStop3D = null;
  safetySimTimeS = 0;
  if (typeof window !== 'undefined') window.INDEX3D_SAFETY_LAST_TRACE = null;
  safetyLastTrace3D = null;
}

function truckFootprintFeatureForSafety(pos, headingRad, vehicleConfig) {
  const corners = truckFootprintCorners(pos, headingRad, vehicleConfig || {});
  if (!Array.isArray(corners) || corners.length < 3 || !turf?.polygon) return null;
  const ring = corners.map((c) => {
    const ll = xzToLL(c.x, c.z);
    return [ll.lng, ll.lat];
  });
  ring.push(ring[0]);
  try {
    return turf.polygon([ring]);
  } catch (_err) {
    return null;
  }
}

function saveSafetyTrace3D(reason, detail = {}) {
  if (!safetyMonitor3D) return null;
  const payload = {
    reason,
    detail,
    metrics: getSafetyMonitorMetrics(),
    traceJSONL: safetyMonitor3D.toJSONL()
  };
  safetyLastTrace3D = payload;
  if (typeof window !== 'undefined') {
    window.INDEX3D_SAFETY_LAST_TRACE = payload;
    try {
      window.localStorage?.setItem?.('index3d:safety:lastTrace', JSON.stringify(payload));
    } catch (_err) {
      // localStorage may be unavailable in private/test contexts; the window handle is enough.
    }
  }
  return payload;
}

function triggerMrmStop3D(reason, detail = {}) {
  if (safetyMrmStop3D) return safetyMrmStop3D;
  safetyMrmStop3D = {
    reason,
    progressM: Math.round((Number(progressM) || 0) * 10) / 10,
    traceHash: safetyMonitor3D?.hash?.() || null,
    detail
  };
  saveSafetyTrace3D(reason, detail);
  playing = false;
  setTruckDanger(true);
  setSimTelemetry({
    speedMS: 0,
    steeringAngle: 0,
    model: `MRM safe stop / ${reason}`
  });
  const poseEl = document.getElementById('map3dPoseCount');
  if (poseEl) poseEl.textContent = `${Math.round(progressM)}m / MRM ${reason}`;
  console.warn('[safety-monitor] MRM stop', safetyMrmStop3D);
  return safetyMrmStop3D;
}

// 搬入の始終点は道路端・敷地際に置かれるのが正常運用のため、経路の端では
// 車体の前後張り出しが道路帯の端キャップから構造的にはみ出る。
// 始終点±この距離は道路逸脱チェックのみ猶予する（接触・カーブ超過は猶予しない）。
const SAFETY_ENDPOINT_GRACE_M = 12;
const INDEX3D_ROAD_SURFACE_TOLERANCE = {
  roadSurfaceMode: 'advisory',
  roadOutsideRatio: 0.25,
  roadOutsideAreaM2: 4.0
};

function runSafetyMonitorTick({ pos, heading, state, speedMS, sample, limit, simDt, collision, routeTotalM }) {
  if (!safetyMonitor3D || !pos) return null;
  safetySimTimeS += Math.max(0, Number(simDt) || 0);
  const ll = xzToLL(pos.x, pos.z);
  const curveLimitMS = Number.isFinite(Number(sample?.curveLimitKmh))
    ? Number(sample.curveLimitKmh) / 3.6
    : null;
  const totalM = Number.isFinite(Number(routeTotalM)) && Number(routeTotalM) > 0
    ? Number(routeTotalM)
    : (routeCum.length ? routeCum[routeCum.length - 1] : 0);
  const inEndpointGrace = totalM > 0
    && (progressM < SAFETY_ENDPOINT_GRACE_M || progressM > totalM - SAFETY_ENDPOINT_GRACE_M);
  const footprint = truckFootprintFeatureForSafety(pos, heading, state?.vehicleConfig || {});
  const hardForwardClearanceM = limit?.mode === 'STOP'
    ? (sample?.forwardClearanceM ?? null)
    : null;
  const result = safetyMonitor3D.push({
    turf,
    footprint,
    roadSurface: inEndpointGrace ? null : safetyRoadSurfaceGeo,
    tolerances: INDEX3D_ROAD_SURFACE_TOLERANCE,
    speedMS,
    allowedMS: limit?.allowedMS,
    curveLimitMS,
    collision,
    forwardClearanceM: hardForwardClearanceM,
    simTimeS: safetySimTimeS,
    progressM,
    lat: ll.lat,
    lng: ll.lng,
    headingDeg: heading * 180 / Math.PI,
    mode: limit?.mode || sample?.mode || null
  });
  safetyLastResult3D = result;
  if (!result.ok) {
    // 切り返し（K-turn）試行中の違反は「試みたが幾何的に不可能」= 理由コード付きの
    // 正常な安全停止として扱う（建物/障害物を避けて切り返せないコーナーは実在する。
    // 低速のスクリプト機動中に安全層が検出して止まるのはL4として正しい挙動）。
    const inSwitchback = recoveryPlayback3D?.kind === 'switchback';
    triggerMrmStop3D(inSwitchback ? 'switchback_infeasible' : 'safety_invariant_violation', {
      tick: result.tick,
      violations: result.violations
    });
  }
  return result;
}

export function getPlateauTilesMetrics() {
  const catalog = store.getState?.().plateauTileset || null;
  const placement = (() => {
    try { return plateauHandle?.getMetrics?.() || {}; } catch (_e) { return {}; }
  })();
  return {
    active: !!plateauActive,
    loading: !!plateauLoadingKey,
    key: plateauKey || plateauLoadingKey || '',
    status: { ...(plateauLastStatus || {}) },
    catalog,
    disabled: !!(typeof window !== 'undefined' && window.PLATEAU_DISABLE),
    keepOsmBuildings: plateauKeepOsmBuildings(),
    yOffsetM: Number.isFinite(Number(window.PLATEAU_Y_OFFSET)) ? Number(window.PLATEAU_Y_OFFSET) : 0,
    ...placement
  };
}
function addAutonomySensorPreview(report) {
  clearMeshesByTag('autonomySensor');
  if (!THREE || !scene || !report?.samples?.length) return 0;
  const mats = {
    CRUISE: new THREE.LineBasicMaterial({ color: 0x22c55e, transparent: true, opacity: 0.32 }),
    SLOW: new THREE.LineBasicMaterial({ color: 0xf59e0b, transparent: true, opacity: 0.42 }),
    YIELD: new THREE.LineBasicMaterial({ color: 0xf97316, transparent: true, opacity: 0.5 }),
    SATURATED: new THREE.LineBasicMaterial({ color: 0xf59e0b, transparent: true, opacity: 0.5 }),
    STOP: new THREE.LineBasicMaterial({ color: 0xef4444, transparent: true, opacity: 0.65 })
  };
  const samples = report.samples || [];
  const stride = Math.max(1, Math.ceil(samples.length / AUTONOMY_SENSOR_PREVIEW_LIMIT));
  let count = 0;
  for (let i = 0; i < samples.length; i += stride) {
    const sample = samples[i];
    const lat = Number(sample.lat);
    const lng = Number(sample.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const heading = Number(sample.headingDeg || 0) * Math.PI / 180;
    const length = Math.max(3, Math.min(
      Number(report.summary?.sensorRangeM) || 34,
      Number(sample.forwardClearanceM ?? report.summary?.sensorRangeM ?? 34)
    ));
    const a = llToXZ(lat, lng);
    const b = {
      x: a.x + Math.sin(heading) * length,
      z: a.z - Math.cos(heading) * length
    };
    const geo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(a.x, 0.9, a.z),
      new THREE.Vector3(b.x, 0.9, b.z)
    ]);
    const mat = mats[sample.mode] || mats.CRUISE;
    const line = new THREE.Line(geo, mat);
    line.userData.tag = 'autonomySensor';
    scene.add(line);
    count++;
  }
  return count;
}

function addRecoveryTrajectoryPreview(report) {
  clearMeshesByTag('recoveryTrajectory');
  if (!THREE || !scene || !report?.recoveryEvents?.length || routeXZ.length < 2) return 0;
  const okMat = new THREE.LineBasicMaterial({ color: 0xa78bfa, transparent: true, opacity: 0.9 });
  const failMat = new THREE.LineBasicMaterial({ color: 0xef4444, transparent: true, opacity: 0.8 });
  const markerOk = new THREE.MeshBasicMaterial({ color: 0xa78bfa });
  const markerFail = new THREE.MeshBasicMaterial({ color: 0xef4444 });
  let count = 0;
  for (const ev of report.recoveryEvents || []) {
    const sM = Number(ev?.sM);
    if (!Number.isFinite(sM)) continue;
    const heading = _routeHeadingAt(sM);
    const stop = _sampleRouteAt(sM);
    const reverseM = Math.max(0, Number(ev?.reverseDistM) || 0);
    const lateralM = Number(ev?.lateralOffsetM) || 0;
    const reverse = {
      x: stop.x - Math.sin(heading) * reverseM,
      z: stop.z + Math.cos(heading) * reverseM
    };
    const shifted = offsetXZLaterally(reverse, heading, lateralM);
    const resumeBase = _sampleRouteAt(sM + Math.max(5, reverseM));
    const resume = offsetXZLaterally(resumeBase, heading, lateralM);
    const points = ev?.resolved
      ? [
        new THREE.Vector3(stop.x, 1.35, stop.z),
        new THREE.Vector3(reverse.x, 1.35, reverse.z),
        new THREE.Vector3(shifted.x, 1.35, shifted.z),
        new THREE.Vector3(resume.x, 1.35, resume.z)
      ]
      : [
        new THREE.Vector3(stop.x, 1.35, stop.z),
        new THREE.Vector3(stop.x + Math.sin(heading) * 2.5, 1.35, stop.z - Math.cos(heading) * 2.5)
      ];
    const geo = new THREE.BufferGeometry().setFromPoints(points);
    const line = new THREE.Line(geo, ev?.resolved ? okMat : failMat);
    line.userData.tag = 'recoveryTrajectory';
    scene.add(line);
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.7, 10, 8), ev?.resolved ? markerOk : markerFail);
    dot.position.set(stop.x, 1.65, stop.z);
    dot.userData.tag = 'recoveryTrajectory';
    scene.add(dot);
    count += 1;
  }
  return count;
}

// ── 項目5: 診断レイヤー（デバッグ用・トグルで生成/破棄） ─────────────────────
// 通常描画とは独立。autonomyReport3D / roads / SV点が無ければ安全に no-op。
// 各レイヤーは一意タグを持ち、clearMeshesByTag(tag) で他に影響なく破棄できる。
const THREE_DIAG_LAYER_DEFAULTS = Object.freeze({
  diagWidthSource: false, // 道路幅ソース別の色分け（凡例と一致）
  diagStop: false,        // 通行不可(STOP)地点 = 赤
  diagSaturated: false,   // 旋回半径不足 / SATURATED = 紫
  diagOverhead: false,    // 頭上クリアランス不足 = 黄→赤
  diagSvPoints: false     // Street View スキャン済み地点 = シアン点
});
const threeDiagLayerVisibility = { ...THREE_DIAG_LAYER_DEFAULTS };
let diagnosticSvPoints = []; // 項目4連携: [{lat,lng,hit}] を外部注入（無ければ no-op）

// 道路幅ソース → 色（index3D_V2.0.html の凡例と一致させること）。
function _widthSourceColor(source) {
  const s = String(source || '');
  if (s === 'user_override') return 0x22d3ee;        // 手動上書き(authoritative)
  if (s === 'width_ai' || s === 'width:ai' || s === 'ai_width' || s === 'roadwidth_ai') return 0xf59e0b; // YOLO width_ai
  if (s === 'gsi_width_range') return 0x3b82f6;       // GSI 幅員ランク
  if (s === 'lanes*width') return 0xa855f7;           // lanes×width
  if (s === 'highway_type') return 0x94a3b8;          // highway 既定
  if (!s) return 0x64748b;                            // データ無し
  return 0x22c55e;                                    // OSM width 実測
}

function _lerpColorHex(a, b, t) {
  const tt = Math.max(0, Math.min(1, Number(t) || 0));
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  return (Math.round(ar + (br - ar) * tt) << 16)
    | (Math.round(ag + (bg - ag) * tt) << 8)
    | Math.round(ab + (bb - ab) * tt);
}

function _diagMarker(lat, lng, color, tag, { y = 1.6, r = 0.9 } = {}) {
  const la = Number(lat), ln = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln)) return false;
  const { x, z } = llToXZ(la, ln);
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 10, 8), new THREE.MeshBasicMaterial({ color }));
  mesh.position.set(x, y, z);
  mesh.userData.tag = tag;
  scene.add(mesh);
  return true;
}

function getDiagnosticAutonomyReport() {
  if (autonomyReport3D?.samples?.length) return autonomyReport3D;
  try {
    const report = (typeof window !== 'undefined' && typeof window.index3DGetAutonomyReport === 'function')
      ? window.index3DGetAutonomyReport()
      : null;
    return report?.samples?.length ? report : null;
  } catch (_) {
    return null;
  }
}

function buildDiagWidthSource() {
  clearMeshesByTag('diagWidthSource');
  if (!THREE || !scene || !originLL) return 0;
  const roads = store.getState()?.geoJsonDataSets || [];
  if (!roads.length) return 0;
  let count = 0;
  for (const f of roads) {
    const g = f?.geometry;
    if (!g) continue;
    const lines = g.type === 'LineString' ? [g.coordinates]
      : (g.type === 'MultiLineString' ? g.coordinates : null);
    if (!lines) continue;
    let color;
    try { color = _widthSourceColor(fuseWidthForFeature(f)?.primarySource); }
    catch (_) { color = _widthSourceColor(null); }
    const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.92 });
    for (const coords of lines) {
      if (!Array.isArray(coords) || coords.length < 2) continue;
      const pts = coords.map(([lng, lat]) => {
        const { x, z } = llToXZ(lat, lng);
        return new THREE.Vector3(x, 0.6, z);
      });
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat);
      line.userData.tag = 'diagWidthSource';
      scene.add(line);
      count++;
      if (count > 5000) break;
    }
    if (count > 5000) break;
  }
  return count;
}

function buildDiagStop() {
  clearMeshesByTag('diagStop');
  const report = getDiagnosticAutonomyReport();
  if (!THREE || !scene || !originLL || !report?.samples?.length) return 0;
  let count = 0;
  for (const s of report.samples) {
    if (s?.mode !== 'STOP') continue;
    if (_diagMarker(s.lat, s.lng, 0xef4444, 'diagStop', { y: 1.9, r: 1.0 })) count++;
  }
  return count;
}

function buildDiagSaturated() {
  clearMeshesByTag('diagSaturated');
  const report = getDiagnosticAutonomyReport();
  if (!THREE || !scene || !originLL || !report?.samples?.length) return 0;
  let count = 0;
  for (const s of report.samples) {
    if (!(Number(s?.turnRadiusDeficitM) > 0) && s?.mode !== 'SATURATED') continue;
    if (_diagMarker(s.lat, s.lng, 0xa855f7, 'diagSaturated', { y: 1.7, r: 0.9 })) count++;
  }
  return count;
}

function buildDiagOverhead() {
  clearMeshesByTag('diagOverhead');
  const report = getDiagnosticAutonomyReport();
  if (!THREE || !scene || !originLL || !report?.samples?.length) return 0;
  const required = Math.max(0.1, Number(report?.envelope?.requiredHeightM) || 0);
  let count = 0;
  for (const s of report.samples) {
    if (s?.blockerRole !== 'overhead') continue;
    const h = Number(s?.blockerHeightM);
    // 高さ不足度で黄→赤（高さ不明は最大=赤寄り）。
    const t = (Number.isFinite(h) && required > 0) ? Math.max(0, Math.min(1, (required - h) / required)) : 1;
    if (_diagMarker(s.lat, s.lng, _lerpColorHex(0xfde047, 0xef4444, t), 'diagOverhead', { y: 2.3, r: 1.0 })) count++;
  }
  return count;
}

function buildDiagSvPoints() {
  clearMeshesByTag('diagSvPoints');
  if (!THREE || !scene || !originLL) return 0;
  const pts = Array.isArray(diagnosticSvPoints) ? diagnosticSvPoints : [];
  if (!pts.length) return 0; // 項目4のスキャン結果が無ければ no-op
  let count = 0;
  for (const p of pts) {
    if (p?.hit === false) continue;
    if (_diagMarker(p.lat, p.lng, 0x06b6d4, 'diagSvPoints', { y: 0.8, r: 0.55 })) count++;
  }
  return count;
}

function buildDiagLayer(tag) {
  switch (tag) {
    case 'diagWidthSource': return buildDiagWidthSource();
    case 'diagStop': return buildDiagStop();
    case 'diagSaturated': return buildDiagSaturated();
    case 'diagOverhead': return buildDiagOverhead();
    case 'diagSvPoints': return buildDiagSvPoints();
    default: return 0;
  }
}

export function setThreeDiagnosticLayerVisible(tag, visible) {
  if (!Object.prototype.hasOwnProperty.call(threeDiagLayerVisibility, tag)) return false;
  threeDiagLayerVisibility[tag] = !!visible;
  if (visible) buildDiagLayer(tag);
  else clearMeshesByTag(tag);
  return true;
}

export function getThreeDiagnosticLayerVisibility() {
  return { ...threeDiagLayerVisibility };
}

// 項目4連携: SV スキャン済み地点を注入（[{lat,lng,hit}]）。ON 中なら即再描画。
export function setThreeDiagnosticSvPoints(points) {
  diagnosticSvPoints = Array.isArray(points) ? points : [];
  if (threeDiagLayerVisibility.diagSvPoints) buildDiagSvPoints();
}

// 走行再生 / ワールド再構築後に、ON 中の診断レイヤーを最新データで再生成する。
export function refreshThreeDiagnostics() {
  for (const [tag, on] of Object.entries(threeDiagLayerVisibility)) {
    if (on) buildDiagLayer(tag);
  }
}

function sampleAutonomyAtProgress(sM) {
  const samples = autonomyReport3D?.samples || [];
  if (!samples.length) return null;
  let lo = 0;
  let hi = samples.length - 1;
  const s = Number(sM) || 0;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if ((Number(samples[mid].sM) || 0) <= s) lo = mid;
    else hi = mid;
  }
  const a = samples[lo];
  const b = samples[hi];
  if (!b) return a;
  return Math.abs((Number(a.sM) || 0) - s) <= Math.abs((Number(b.sM) || 0) - s) ? a : b;
}

function isRecoveryBypassActive(sample, sM = progressM) {
  const sampleS = Number(sample?.sM);
  const targetS = Number.isFinite(sampleS) ? sampleS : (Number(sM) || 0);
  return recoveryBypassUntilM > targetS + 0.25;
}

function autonomyPlaybackLimit(sample, nominalMS) {
  if (!sample) return { scale: 1, allowedMS: nominalMS, mode: 'CRUISE' };
  const allowedMS = Math.max(0, Number(sample.allowedSpeedMS) || 0);
  const cruiseMS = Math.max(0.6, Number(sample.cruiseSpeedMS) || nominalMS || 1);
  if (sample.mode === 'STOP' || allowedMS <= 0.05) {
    const hardOverheadStop = sample.blockerRole === 'overhead';
    if (!hardOverheadStop) {
      const crawlFactor = sample.blockerId ? 0.16 : 0.20;
      const crawlMS = Math.max(0.55, Math.min(cruiseMS, (Number(nominalMS) || cruiseMS) * crawlFactor));
      return {
        scale: Math.max(0.05, Math.min(1, crawlMS / cruiseMS)),
        allowedMS: crawlMS,
        mode: sample.blockerId ? 'MONITORED_CRAWL' : 'ROAD_EDGE_CRAWL'
      };
    }
    if (isRecoveryBypassActive(sample)) {
      const bypassMS = Math.max(0.9, Math.min(cruiseMS, (Number(nominalMS) || cruiseMS) * 0.35));
      return {
        scale: Math.max(0.08, Math.min(1, bypassMS / cruiseMS)),
        allowedMS: bypassMS,
        mode: 'RECOVER'
      };
    }
    return { scale: 0, allowedMS: 0, mode: 'STOP' };
  }
  return {
    scale: Math.max(0.06, Math.min(1, allowedMS / cruiseMS)),
    allowedMS,
    mode: sample.mode || 'CRUISE'
  };
}

function normalizeCargoPlacement(value) {
  const p = String(value || 'center');
  if (['left', 'center', 'right', 'head_out', 'diagonal'].includes(p)) return p;
  return 'center';
}

function cargoBundleDimensions(cargo, vehicleWidthM = 2.5) {
  if (!cargo || !cargo.loadType || cargo.loadType === 'none') return null;
  const lengthM = Math.max(0.2, (Number(cargo.length) || 4000) / 1000);
  const widthM = Math.max(0.1, Math.min(Math.max(0.1, Number(vehicleWidthM) || 2.5), (Number(cargo.widthMm) || 1000) / 1000));
  const count = Math.max(1, Math.round(Number(cargo.count) || 1));
  const heightM = Math.max(0.34, Math.min(1.4, 0.52 + (count - 1) * 0.08));
  return { lengthM, widthM, heightM, count };
}

function cargoPoseOnBed(cargo, { bedRearM, bedFrontM, vehicleWidthM, cargoWidthM, cargoLengthM } = {}) {
  const placement = normalizeCargoPlacement(cargo?.placement);
  const halfW = Math.max(0.1, (Number(vehicleWidthM) || 2.5) / 2);
  const cargoHalfW = Math.max(0.05, (Number(cargoWidthM) || 1) / 2);
  const maxOff = Math.max(0, halfW - cargoHalfW);
  let x = 0;
  let yaw = 0;
  let z = Number(bedFrontM) - (Number(cargoLengthM) || 0) / 2;

  if (placement === 'left') x = -maxOff;
  else if (placement === 'right') x = maxOff;
  else if (placement === 'head_out') {
    // Rear end stays on the rear gate side, and long lumber protrudes over the cab/front side.
    z = Number(bedRearM) + (Number(cargoLengthM) || 0) / 2;
  } else if (placement === 'diagonal') {
    // One practical diagonal load mode. Keep the center on the bed and let the footprint expand naturally.
    z = (Number(bedRearM) + Number(bedFrontM)) / 2;
    yaw = 15 * Math.PI / 180;
  }
  return { x, z, yaw, placement };
}

function addWoodCargoMesh(group, cargo, { bedRearM, bedFrontM, vehicleWidthM, deckY } = {}) {
  const dims = cargoBundleDimensions(cargo, vehicleWidthM);
  if (!group || !dims || !THREE) return null;
  const pose = cargoPoseOnBed(cargo, {
    bedRearM,
    bedFrontM,
    vehicleWidthM,
    cargoWidthM: dims.widthM,
    cargoLengthM: dims.lengthM
  });
  const woodGeo = new THREE.BoxGeometry(dims.widthM, dims.heightM, dims.lengthM);
  const woodMat = new THREE.MeshLambertMaterial({ color: 0xb45309, transparent: true, opacity: 0.94 });
  const wood = new THREE.Mesh(woodGeo, woodMat);
  wood.name = `truck-cargo-${pose.placement}`;
  wood.position.set(pose.x, Number(deckY) + dims.heightM / 2, pose.z);
  wood.rotation.y = pose.yaw;
  wood.userData.tag = 'truck';
  group.add(wood);

  const edge = new THREE.LineSegments(
    new THREE.EdgesGeometry(woodGeo),
    new THREE.LineBasicMaterial({ color: 0xfbbf24, transparent: true, opacity: 0.82 })
  );
  edge.position.copy(wood.position);
  edge.rotation.copy(wood.rotation);
  edge.userData.tag = 'truck';
  group.add(edge);
  truckEdgeMeshes.push(edge);
  return wood;
}

function addRouteLine(simRoute) {
  clearMeshesByTag('route');
  if (!simRoute || simRoute.length < 2) return;
  const pts = simRoute.map((ll) => {
    const { x, z } = llToXZ(ll.lat, ll.lng);
    return new THREE.Vector3(x, 0.45, z);
  });
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  const mat = new THREE.LineBasicMaterial({ color: 0xf59e0b, linewidth: 3 });
  const line = new THREE.Line(geo, mat);
  line.userData.tag = 'route';
  scene.add(line);
  // 始点・終点マーカー
  const startMat = new THREE.MeshBasicMaterial({ color: 0x16a34a, transparent: true, opacity: 0.88 });
  const goalMat = new THREE.MeshBasicMaterial({ color: 0xd97706, transparent: true, opacity: 0.88 });
  const endpointGeo = new THREE.CylinderGeometry(1.25, 1.25, 0.08, 28);
  const s = new THREE.Mesh(endpointGeo, startMat);
  s.position.set(pts[0].x, 0.14, pts[0].z);
  s.userData.tag = 'route';
  scene.add(s);
  const gmesh = new THREE.Mesh(endpointGeo, goalMat);
  const goal = pts[pts.length - 1];
  gmesh.position.set(goal.x, 0.14, goal.z);
  gmesh.userData.tag = 'route';
  scene.add(gmesh);
}

function buildTruck(vehicleConfig, cargo) {
  if (truckGroup) { scene.remove(truckGroup); truckGroup = null; }
  truckGroup = new THREE.Group();
  truckGroup.userData.tag = 'truck';
  truckPaintMeshes = [];
  truckEdgeMeshes = [];
  truckFrontWheels = [];

  {
  const wb = Number(vehicleConfig?.wheelBase) || 4.0;
  const fo = Number(vehicleConfig?.frontOverhang) || 1.0;
  const ro = Number(vehicleConfig?.rearOverhang) || 1.5;
  const width = Number(vehicleConfig?.vehicleWidth) || 2.5;
  const vh = Number(vehicleConfig?.vehicleHeight) || 2.5;
  const frontF = wb + fo;
  const rearF = -ro;
  const totalLen = frontF - rearF;
  const configuredBedLength = Number(vehicleConfig?.bedLength);
  const targetBedLen = Number.isFinite(configuredBedLength) && configuredBedLength > 0
    ? configuredBedLength
    : totalLen * 0.7;
  const bedRear = rearF + 0.08;
  const bedLen = Math.max(0.9, Math.min(targetBedLen, totalLen - 1.25));
  const bedFront = bedRear + bedLen;
  const cabLen = Math.max(1.2, frontF - bedFront);
  const cabFront = frontF;
  const cabRear = cabFront - cabLen;
  const bedOuterW = width;
  const bedInnerW = width * 0.956;
  const cabW = width * 0.915;
  const wheelRadius = Math.max(0.34, Math.min(0.54, width * 0.2));
  const wheelDepth = Math.max(0.22, width * 0.13);
  const wheelY = wheelRadius + 0.08;
  const frameY = Math.max(0.48, wheelY + wheelRadius * 0.18);
  const bedFloorH = 0.18;
  const bedDeckY = Math.max(wheelY + wheelRadius + 0.1, Math.min(1.14, vh * 0.43));
  const cabBaseY = Math.max(0.34, wheelY - wheelRadius * 0.15);
  const cabH = Math.max(1.65, Math.min(2.65, vh - cabBaseY + 0.08));

  const bodyMat = new THREE.MeshLambertMaterial({ color: 0x0891b2, transparent: true, opacity: 0.76 });
  const cabMat = new THREE.MeshLambertMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.88 });
  const frameMat = new THREE.MeshLambertMaterial({ color: 0x0f172a, transparent: true, opacity: 0.92 });
  const railMat = new THREE.MeshLambertMaterial({ color: 0x94a3b8, transparent: true, opacity: 0.95 });
  const glassMat = new THREE.MeshBasicMaterial({ color: 0x0f172a, transparent: true, opacity: 0.78 });
  const lightMat = new THREE.MeshBasicMaterial({ color: 0xfacc15 });
  const tireMat = new THREE.MeshLambertMaterial({ color: 0x111827 });
  const hubMat = new THREE.MeshLambertMaterial({ color: 0xcbd5e1 });

  const addBox = (name, w, h, l, x, y, z, mat, paint = false, edgeColor = 0x67e8f9) => {
    const geo = new THREE.BoxGeometry(w, h, l);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = name;
    mesh.position.set(x, y, z);
    mesh.userData.tag = 'truck';
    truckGroup.add(mesh);
    if (paint) truckPaintMeshes.push(mesh);
    const edge = new THREE.LineSegments(
      new THREE.EdgesGeometry(geo),
      new THREE.LineBasicMaterial({ color: edgeColor, transparent: true, opacity: 0.78 })
    );
    edge.position.copy(mesh.position);
    edge.userData.tag = 'truck';
    truckGroup.add(edge);
    truckEdgeMeshes.push(edge);
    return mesh;
  };

  addBox('truck-frame', width * 0.72, 0.2, totalLen, 0, frameY, (frontF + rearF) / 2, frameMat, false, 0x475569);
  addBox('truck-bed-floor', bedInnerW, bedFloorH, bedLen, 0, bedDeckY, (bedFront + bedRear) / 2, bodyMat, true);
  const cab = addBox('truck-cab', cabW, cabH, cabLen, 0, cabBaseY + cabH / 2, (cabFront + cabRear) / 2, cabMat, true);
  truckBody = cab;
  truckEdges = truckEdgeMeshes[0] || null;

  const railH = 0.42;
  const railY = bedDeckY + bedFloorH / 2 + railH / 2;
  addBox('truck-left-side-board', 0.08, railH, bedLen, -bedOuterW * 0.5, railY, (bedFront + bedRear) / 2, railMat, false, 0xe2e8f0);
  addBox('truck-right-side-board', 0.08, railH, bedLen, bedOuterW * 0.5, railY, (bedFront + bedRear) / 2, railMat, false, 0xe2e8f0);
  addBox('truck-tailgate', bedOuterW, railH, 0.08, 0, railY, bedRear, railMat, false, 0xe2e8f0);
  addBox('truck-front-board', bedOuterW, railH + 0.24, 0.08, 0, railY + 0.12, bedFront, railMat, false, 0xe2e8f0);
  addBox('truck-left-under-run', 0.06, 0.1, bedLen * 0.72, -bedOuterW * 0.42, frameY + 0.1, bedRear + bedLen * 0.43, frameMat, false, 0x64748b);
  addBox('truck-right-under-run', 0.06, 0.1, bedLen * 0.72, bedOuterW * 0.42, frameY + 0.1, bedRear + bedLen * 0.43, frameMat, false, 0x64748b);
  addBox('truck-windshield', cabW * 0.72, 0.035, cabLen * 0.26, 0, cabBaseY + cabH * 0.76, cabFront - cabLen * 0.34, glassMat, false, 0x1e293b);
  addBox('truck-side-window-left', 0.035, cabH * 0.32, cabLen * 0.32, -cabW * 0.48, cabBaseY + cabH * 0.7, cabFront - cabLen * 0.55, glassMat, false, 0x1e293b);
  addBox('truck-side-window-right', 0.035, cabH * 0.32, cabLen * 0.32, cabW * 0.48, cabBaseY + cabH * 0.7, cabFront - cabLen * 0.55, glassMat, false, 0x1e293b);
  addBox('truck-bumper', cabW * 0.74, 0.24, 0.08, 0, cabBaseY + 0.18, cabFront + 0.04, frameMat, false, 0x475569);
  addBox('truck-headlight-left', cabW * 0.18, 0.09, 0.065, -cabW * 0.29, cabBaseY + 0.45, cabFront + 0.09, lightMat, false, 0xfacc15);
  addBox('truck-headlight-right', cabW * 0.18, 0.09, 0.065, cabW * 0.29, cabBaseY + 0.45, cabFront + 0.09, lightMat, false, 0xfacc15);
  addBox('truck-mirror-left', 0.18, 0.08, 0.18, -cabW * 0.62, cabBaseY + cabH * 0.62, cabFront - cabLen * 0.38, frameMat, false, 0x475569);
  addBox('truck-mirror-right', 0.18, 0.08, 0.18, cabW * 0.62, cabBaseY + cabH * 0.62, cabFront - cabLen * 0.38, frameMat, false, 0x475569);

  const wheelGeo = new THREE.CylinderGeometry(wheelRadius, wheelRadius, wheelDepth, 24);
  const hubGeo = new THREE.CylinderGeometry(wheelRadius * 0.42, wheelRadius * 0.42, wheelDepth + 0.015, 18);
  const axles = [0, wb].filter((z) => z > rearF && z < frontF);
  for (const z of axles) {
    const fenderName = z >= wb * 0.5 ? 'front' : 'rear';
    addBox(`truck-${fenderName}-left-fender`, wheelDepth * 0.62, 0.12, wheelRadius * 1.65, -width * 0.5, wheelY + wheelRadius * 0.82, z, railMat, false, 0xe2e8f0);
    addBox(`truck-${fenderName}-right-fender`, wheelDepth * 0.62, 0.12, wheelRadius * 1.65, width * 0.5, wheelY + wheelRadius * 0.82, z, railMat, false, 0xe2e8f0);
    const isFrontAxle = fenderName === 'front';
    for (const side of [-1, 1]) {
      const wheelX = side * (width / 2 + wheelDepth * 0.28);
      const wheel = new THREE.Mesh(wheelGeo, tireMat);
      wheel.rotation.z = Math.PI / 2;
      wheel.userData.tag = 'truck';
      const hub = new THREE.Mesh(hubGeo, hubMat);
      hub.rotation.z = Math.PI / 2;
      hub.userData.tag = 'truck';
      if (isFrontAxle) {
        // 前輪は操舵ピボット(Group)に入れ、pivot.rotation.y でステア角を表現する。
        const pivot = new THREE.Group();
        pivot.position.set(wheelX, wheelY, z);
        pivot.userData.tag = 'truck';
        wheel.position.set(0, 0, 0);
        hub.position.set(0, 0, 0);
        pivot.add(wheel);
        pivot.add(hub);
        truckGroup.add(pivot);
        truckFrontWheels.push(pivot);
      } else {
        wheel.position.set(wheelX, wheelY, z);
        hub.position.copy(wheel.position);
        truckGroup.add(wheel);
        truckGroup.add(hub);
      }
    }
  }

  const ribCount = Math.max(3, Math.min(6, Math.round(bedLen / 0.85)));
  for (let i = 1; i < ribCount; i++) {
    const z = bedRear + (bedLen * i) / ribCount;
    addBox(`truck-bed-crossmember-${i}`, bedOuterW * 0.92, 0.055, 0.05, 0, bedDeckY + 0.13, z, frameMat, false, 0x475569);
  }

  addWoodCargoMesh(truckGroup, cargo, {
    bedRearM: bedRear,
    bedFrontM: bedFront,
    vehicleWidthM: width,
    deckY: bedDeckY + bedFloorH / 2
  });

  scene.add(truckGroup);
  return;
  }

  const wb = Number(vehicleConfig?.wheelBase) || 4.0;
  const fo = Number(vehicleConfig?.frontOverhang) || 1.0;
  const ro = Number(vehicleConfig?.rearOverhang) || 1.5;
  const width = Number(vehicleConfig?.vehicleWidth) || 2.5;
  const vh = Number(vehicleConfig?.vehicleHeight) || 2.5;
  const totalLen = wb + fo + ro;

  const bodyGeo = new THREE.BoxGeometry(width, vh, totalLen);
  const bodyMat = new THREE.MeshLambertMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.55 });
  const body = new THREE.Mesh(bodyGeo, bodyMat);
  const centerOffset = (wb + fo) - totalLen / 2;
  body.position.set(0, vh / 2, centerOffset);
  truckGroup.add(body);
  truckBody = body;

  // ワイヤーフレーム輪郭
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(bodyGeo), new THREE.LineBasicMaterial({ color: 0x67e8f9 }));
  edges.position.copy(body.position);
  truckGroup.add(edges);
  truckEdges = edges;

  addWoodCargoMesh(truckGroup, cargo, {
    bedRearM: -ro,
    bedFrontM: wb + fo,
    vehicleWidthM: width,
    deckY: vh
  });

  scene.add(truckGroup);
}

function placeTruckAt(x, z, headingRad) {
  if (!truckGroup) return;
  truckGroup.position.set(x, 0, z);
  // 前方(+Z local)を進行方吁E(sin h, 0, -cos h)[東,_,北] に向けめErotation.y、E
  truckGroup.rotation.y = Math.atan2(Math.sin(headingRad), -Math.cos(headingRad));
}

function bboxIntersects3D(a, b) {
  if (!a || !b) return true;
  return !(a[0] > b[2] || a[2] < b[0] || a[1] > b[3] || a[3] < b[1]);
}

// Collision check for the current truck footprint. Keep this on the shared
// vehicle footprint model so trail, diagnostics, and avoidance agree.
function checkTruckSolidCollision(pos, headingRad, state) {
  const turf = window.turf;
  if (!turf || (!lateralCollisionFeatures.length && !overheadCollisionFeatures.length)) return false;
  const vc = state?.vehicleConfig || state || {};
  const corners = truckFootprintCorners(pos, headingRad, vc);
  if (!Array.isArray(corners) || corners.length < 3) return false;
  const ring = corners.map((c) => {
    const ll = xzToLL(c.x, c.z);
    return [ll.lng, ll.lat];
  });
  ring.push(ring[0]);
  let fp, fpb;
  try { fp = turf.polygon([ring]); fpb = turf.bbox(fp); } catch (e) { return false; }

  for (let i = 0; i < lateralCollisionFeatures.length; i++) {
    const bb = lateralCollisionBboxes[i];
    if (bb && !bboxIntersects3D(fpb, bb)) continue;
    try { if (turf.booleanIntersects(fp, lateralCollisionFeatures[i])) return true; } catch (e) { }
  }

  if (overheadCollisionFeatures.length) {
    const envelope = getVehicleEnvelope(state, { clearanceMargin: 0.25 });
    for (let i = 0; i < overheadCollisionFeatures.length; i++) {
      const bb = overheadCollisionBboxes[i];
      if (bb && !bboxIntersects3D(fpb, bb)) continue;
      if (overheadCollisionHeights[i]?.clearanceReliable === false) continue;
      const h = Number(overheadCollisionHeights[i]?.heightM);
      if (Number.isFinite(h) && h >= envelope.requiredHeightM) continue;
      try { if (turf.booleanIntersects(fp, overheadCollisionFeatures[i])) return true; } catch (e) { }
    }
  }

  return false;
}

function offsetXZLaterally(pos, headingRad, lateralM) {
  if (!pos || !Number.isFinite(lateralM) || Math.abs(lateralM) < 1e-6) return pos;
  return {
    x: pos.x + lateralM * Math.cos(headingRad),
    z: pos.z + lateralM * Math.sin(headingRad)
  };
}

function isAutoDriveOffsetSafe(offsetM, fromMeters, vc) {
  if (!lateralCollisionFeatures.length && !overheadCollisionFeatures.length) return true;
  const state = store.getState();
  for (const lookAheadM of AUTODRIVE_LOOKAHEAD_M) {
    const s = fromMeters + lookAheadM;
    const pos = _sampleRouteAt(s);
    const heading = _routeHeadingAt(s);
    const shifted = offsetXZLaterally(pos, heading, offsetM);
    if (checkTruckSolidCollision(shifted, heading, { ...state, vehicleConfig: vc })) return false;
  }
  return true;
}

function chooseAutoDriveTargetOffset(fromMeters, vc) {
  if (!lateralCollisionFeatures.length && !overheadCollisionFeatures.length) return 0;
  if (isAutoDriveOffsetSafe(0, fromMeters, vc)) return 0;
  let best = null;
  for (const offsetM of AUTODRIVE_LATERAL_CANDIDATES_M) {
    if (Math.abs(offsetM) < AUTODRIVE_OFFSET_EPS) continue;
    if (!isAutoDriveOffsetSafe(offsetM, fromMeters, vc)) continue;
    const score = Math.abs(offsetM) + Math.abs(offsetM - autoDriveTargetOffsetM) * 0.35;
    if (!best || score < best.score) best = { offsetM, score };
  }
  return best ? best.offsetM : autoDriveTargetOffsetM;
}

function setTruckDanger(danger) {
  const paint = truckPaintMeshes.length ? truckPaintMeshes : (truckBody ? [truckBody] : []);
  for (const mesh of paint) {
    if (!mesh?.material) continue;
    mesh.material.color.setHex(danger ? 0xef4444 : (mesh.name === 'truck-cab' ? 0x38bdf8 : 0x0891b2));
    mesh.material.opacity = danger ? 0.76 : (mesh.name === 'truck-cab' ? 0.88 : 0.76);
  }
  const edges = truckEdgeMeshes.length ? truckEdgeMeshes : (truckEdges ? [truckEdges] : []);
  for (const edge of edges) {
    if (edge?.material) edge.material.color.setHex(danger ? 0xfca5a5 : 0x67e8f9);
  }
}

// 前輪の操舵角を描画に反映（angleRad: +で左、-で右。telemetry の steeringAngle と同じ符号）。
function setTruckSteer(angleRad) {
  const a = Number(angleRad);
  if (!Number.isFinite(a)) return;
  const clamped = Math.max(-0.85, Math.min(0.85, a));
  for (const pivot of truckFrontWheels) {
    if (pivot) pivot.rotation.y = clamped;
  }
}

function clearTruckTrail() {
  truckTrailObjects.forEach((obj) => {
    scene?.remove(obj);
    obj.geometry?.dispose?.();
    obj.material?.dispose?.();
  });
  truckTrailObjects = [];
  truckTrailLastM = -Infinity;
  truckTrailLastPos = null;
  clearMeshesByTag('truckTrail');
}

function truckBedExtents(vehicleConfig, fp) {
  const frontF = Number(fp.frontExtentM) || ((Number(fp.wheelBase) || 4) + 1);
  const rearF = -(Number(fp.rearExtentM) || 1.5);
  const totalLen = Math.max(0.1, frontF - rearF);
  const configuredBedLength = Number(vehicleConfig?.bedLength);
  const targetBedLen = Number.isFinite(configuredBedLength) && configuredBedLength > 0
    ? configuredBedLength
    : totalLen * 0.7;
  const bedRearM = rearF + 0.08;
  const bedLenM = Math.max(0.9, Math.min(targetBedLen, totalLen - 1.25));
  return { bedRearM, bedFrontM: bedRearM + bedLenM };
}

function cargoLocalCornersForFootprint(vehicleConfig, fp) {
  const st = store.getState();
  const cargo = {
    loadType: st?.cargoLoadType,
    length: st?.cargoLength,
    count: st?.cargoCount,
    widthMm: st?.cargoWidthMm,
    placement: st?.cargoPlacement
  };
  const dims = cargoBundleDimensions(cargo, fp.vehicleWidth);
  if (!dims) return [];
  const bed = truckBedExtents(vehicleConfig || {}, fp);
  const pose = cargoPoseOnBed(cargo, {
    ...bed,
    vehicleWidthM: fp.vehicleWidth,
    cargoWidthM: dims.widthM,
    cargoLengthM: dims.lengthM
  });
  const hw = dims.widthM / 2;
  const hl = dims.lengthM / 2;
  const sinY = Math.sin(pose.yaw);
  const cosY = Math.cos(pose.yaw);
  return [
    [-hw, hl],
    [hw, hl],
    [hw, -hl],
    [-hw, -hl]
  ].map(([x, z]) => ({
    x: pose.x + x * cosY + z * sinY,
    z: pose.z - x * sinY + z * cosY
  }));
}

function convexHullLocal(points) {
  const pts = (points || [])
    .filter((p) => Number.isFinite(p?.x) && Number.isFinite(p?.z))
    .sort((a, b) => (a.x - b.x) || (a.z - b.z));
  if (pts.length <= 3) return pts;
  const cross = (o, a, b) => (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 1e-8) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 1e-8) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function truckFootprintCorners(pos, headingRad, vehicleConfig = {}) {
  const fp = getVehicleFootprintConfig(vehicleConfig || {}, {
    defaultWheelBase: 4.0,
    defaultVehicleWidth: 2.5,
    defaultFrontOverhang: 1.0,
    defaultRearOverhang: 1.5
  });
  const frontF = fp.frontExtentM;
  const rearF = -fp.rearExtentM;
  const halfW = fp.halfWidthM;
  const sinH = Math.sin(headingRad);
  const cosH = Math.cos(headingRad);
  const toWorld = (localX, localZ) => ({
    x: pos.x + localZ * sinH - localX * cosH,
    z: pos.z - localZ * cosH - localX * sinH
  });
  const base = [
    { x: -halfW, z: frontF },
    { x: halfW, z: frontF },
    { x: halfW, z: rearF },
    { x: -halfW, z: rearF }
  ];
  const local = convexHullLocal(base.concat(cargoLocalCornersForFootprint(vehicleConfig, fp)));
  return local.map((p) => toWorld(p.x, p.z));
}

function addTruckTrailFootprint(pos, headingRad, vehicleConfig = {}, travelM = progressM) {
  if (!scene || !pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.z)) return;
  const s = Number(travelM) || 0;
  const prevPos = truckTrailLastPos ? { ...truckTrailLastPos } : null;
  const movedM = truckTrailLastPos
    ? Math.hypot(pos.x - truckTrailLastPos.x, pos.z - truckTrailLastPos.z)
    : Infinity;
  const trailStep = truckTrailStepM();
  if (s - truckTrailLastM < trailStep && movedM < trailStep && truckTrailObjects.length) return;
  truckTrailLastM = s;
  truckTrailLastPos = { x: pos.x, z: pos.z };
  // この地点で車両外形が障害物に接触しているか（危険箇所の色分け用）。
  const danger = checkTruckSolidCollision(pos, headingRad, { vehicleConfig });
  // 車両外形が通った範囲（地面フットプリント）= 配送可否に直結。中心軌跡ではなく外形帯を残す。
  addSweptAreaFootprint(pos, headingRad, vehicleConfig, danger);
  if (truckTrailMode() === 'line') {
    if (prevPos) addTruckTrailSegment(prevPos, pos, danger);
    else addTruckTrailDot(pos, danger);
    return;
  }
  const wb = Number(vehicleConfig?.wheelBase) || 4.0;
  const fo = Number(vehicleConfig?.frontOverhang) || 1.0;
  const ro = Number(vehicleConfig?.rearOverhang) || 1.5;
  const width = Number(vehicleConfig?.vehicleWidth) || 2.5;
  const height = Math.max(1.2, Number(vehicleConfig?.vehicleHeight) || 2.5);
  const frontF = wb + fo;
  const rearF = -ro;
  const totalLen = frontF - rearF;
  const centerF = (frontF + rearF) / 2;
  const sinH = Math.sin(headingRad);
  const cosH = Math.cos(headingRad);
  const cx = pos.x + centerF * sinH;
  const cz = pos.z - centerF * cosH;
  const geo = new THREE.BoxGeometry(width, height, totalLen);
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshBasicMaterial({
      color: danger ? 0xef4444 : 0xf59e0b,
      transparent: true,
      opacity: truckTrailVolumeAlpha(),
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false
    })
  );
  mesh.name = 'truck-body-trail';
  mesh.userData.tag = 'truckTrail';
  mesh.visible = layerVisible('truckTrail');
  mesh.position.set(cx, 0.06 + height / 2, cz);
  mesh.rotation.y = Math.atan2(Math.sin(headingRad), -Math.cos(headingRad));
  mesh.renderOrder = 18;
  scene.add(mesh);

  const edge = new THREE.LineSegments(
    new THREE.EdgesGeometry(geo),
    new THREE.LineBasicMaterial({
      color: danger ? 0xfca5a5 : 0xffd166,
      transparent: true,
      opacity: 0.9,
      depthTest: false,
      depthWrite: false
    })
  );
  edge.name = 'truck-body-trail-edge';
  edge.userData.tag = 'truckTrail';
  edge.visible = layerVisible('truckTrail');
  edge.position.copy(mesh.position);
  edge.rotation.copy(mesh.rotation);
  edge.renderOrder = 19;
  scene.add(edge);

  truckTrailObjects.push(mesh, edge);
  trimTruckTrailObjects(truckTrailMax() * 2);
}

// 車両外形（フットプリント四隅）を地面に敷くスイープ帯。危険地点は赤で強調。
function addSweptAreaFootprint(pos, headingRad, vehicleConfig = {}, danger = false) {
  if (!scene) return;
  const corners = truckFootprintCorners(pos, headingRad, vehicleConfig);
  if (!Array.isArray(corners) || corners.length < 3) return;
  const shape = new THREE.Shape();
  corners.forEach((c, i) => {
    if (i === 0) shape.moveTo(c.x, -c.z);
    else shape.lineTo(c.x, -c.z);
  });
  const geo = new THREE.ShapeGeometry(shape);
  const mat = new THREE.MeshBasicMaterial({
    color: danger ? 0xef4444 : 0x22d3ee,
    transparent: true,
    opacity: danger ? 0.3 : 0.14,
    side: THREE.DoubleSide,
    depthTest: false,
    depthWrite: false
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.05;
  mesh.userData.tag = 'sweptArea';
  mesh.visible = layerVisible('sweptArea');
  mesh.renderOrder = 16;
  scene.add(mesh);
  truckTrailObjects.push(mesh);
}

function recoveryEventKey(ev) {
  return `${Math.round((Number(ev?.sM) || 0) * 10)}:${ev?.blockerId || ''}`;
}

function hasHandledSwitchbackZone(sM) {
  const station = Number(sM);
  if (!Number.isFinite(station)) return false;
  return switchbackHandledZones3D.some((zone) =>
    station >= zone.startM - 1 && station <= zone.endM + 1
  );
}

function markHandledSwitchbackZone(key, sM, resumeStationM) {
  const startM = Math.max(0, (Number(sM) || 0) - 5);
  const endM = Math.max(startM, (Number(resumeStationM) || Number(sM) || 0) + 8);
  switchbackHandled3D.add(key);
  switchbackHandledZones3D.push({ key, startM, endM, resumeStationM: Number(resumeStationM) || endM });
  if (switchbackHandledZones3D.length > 80) {
    switchbackHandledZones3D.splice(0, switchbackHandledZones3D.length - 80);
  }
}

function findPlayableRecoveryEvent(sample, sM) {
  if (sample?.mode !== 'STOP') return null;
  const events = autonomyReport3D?.recoveryEvents || [];
  for (const ev of events) {
    if (!ev?.resolved || !(Number(ev.reverseDistM) > 0)) continue;
    const key = recoveryEventKey(ev);
    if (recoveryHandledKeys3D.has(key)) continue;
    const evS = Number(ev.sM);
    if (!Number.isFinite(evS)) continue;
    const sampleS = Number(sample.sM) || Number(sM) || 0;
    if (Math.abs(evS - sampleS) <= 5 || Math.abs(evS - (Number(sM) || 0)) <= 5) return ev;
  }
  return null;
}

function beginRecoveryPlayback(ev) {
  const sM = Number(ev?.sM);
  if (!Number.isFinite(sM) || routeXZ.length < 2) return false;
  const heading = _routeHeadingAt(sM);
  const stop = _sampleRouteAt(sM);
  const reverseM = Math.max(1.5, Number(ev.reverseDistM) || 4);
  const transitionLenM = Math.max(0, Number(ev.transitionLenM) || 0);
  const lateralM = Number(ev.lateralOffsetM) || 0;
  const reverse = {
    x: stop.x - Math.sin(heading) * reverseM,
    z: stop.z + Math.cos(heading) * reverseM
  };
  const shifted = offsetXZLaterally(reverse, heading, lateralM);
  // 1b(b): 復旧終了点(resume)を、引継ぎ後の通常走行が再開する地点・向きと一致させて位置飛びを防ぐ。
  const resumeForwardM = Math.max(6, reverseM + 3, transitionLenM);
  const resumeStationM = sM + resumeForwardM;
  const resumeHeading = _routeHeadingAt(resumeStationM);
  const resumeBase = _sampleRouteAt(resumeStationM);
  const resume = offsetXZLaterally(resumeBase, resumeHeading, lateralM);
  recoveryBypassUntilM = Math.max(recoveryBypassUntilM, resumeStationM + 5);
  recoveryHandledKeys3D.add(recoveryEventKey(ev));
  recoveryPlaybackCount3D += 1;
  recoveryPlayback3D = {
    sM,
    heading,
    reverseM,
    transitionLenM,
    lateralM,
    resumeForwardM,
    resumeStationM,
    stop,
    reverse,
    shifted,
    resume,
    t: 0,
    reverseTime: Math.max(0.5, reverseM / 3.0),
    shiftTime: Math.max(0.8, Math.abs(lateralM) / 0.9),
    resumeTime: Math.max(0.7, Math.max(transitionLenM, reverseM + 4) / 5.0)
  };
  return true;
}

function lerpPoint(a, b, t) {
  return {
    x: a.x + (b.x - a.x) * t,
    z: a.z + (b.z - a.z) * t
  };
}

// 最短弧で角度補間（切り返しのヘディング振りに使う）
function lerpAngleRad(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return a + d * Math.max(0, Math.min(1, t));
}

// コーナー切り返し（K-turn v1）: スイング超過の急コーナーを
// 「手前で一旦停止 → 後退しながらヘディングを出口方向へ振る → 前進で再進入」で通す。
// 位置はrecovery再生と同じスクリプト補間。妥当性は Safety Monitor が毎tick検証し、
// それでも帯を割る場合は従来どおりMRM停止する（=無理なコーナーは正直に不可）。
// ── K-turn v2: 事前検証つき軌道生成 ─────────────────────────────────────
// v2は自転車モデルでロック一杯の前進/後退アーク列を生成し、各ポーズの車体
// フットプリントを Safety Monitor と同一の判定（evaluateSafetyInvariants）で
// 事前検証する。道路面逸脱は advisory として許容し、建物/障害物に接触する
// 組合せだけを除外する。

function poseClearsSolids3D(pos, headingRad, vc) {
  const footprint = truckFootprintFeatureForSafety(pos, headingRad, vc || {});
  if (!footprint) return true;
  const collision = checkTruckSolidCollision(pos, headingRad, { vehicleConfig: vc || {} });
  const res = evaluateSafetyInvariants({
    turf,
    footprint,
    roadSurface: safetyRoadSurfaceGeo,
    collision,
    tolerances: INDEX3D_ROAD_SURFACE_TOLERANCE
  });
  return res.ok;
}

// 自転車モデル1ステップ（xz平面・既存の前進規約 x+=sin(h)·ds, z-=cos(h)·ds）
function stepBicycleXZ(pose, dsSigned, steerRad, wheelBase) {
  const h = pose.h + (dsSigned / Math.max(1, wheelBase)) * Math.tan(steerRad);
  return {
    x: pose.x + Math.sin(h) * dsSigned,
    z: pose.z - Math.cos(h) * dsSigned,
    h
  };
}

// アーク1本ぶんのポーズ列を生成・検証しながら poses に積む。失敗で false。
function pushValidatedArc(poses, vc, wheelBase, lengthM, dir, steerRad, stepDs = 0.5) {
  let pose = poses[poses.length - 1];
  const steps = Math.max(1, Math.ceil(lengthM / stepDs));
  for (let i = 0; i < steps; i++) {
    pose = stepBicycleXZ(pose, dir * stepDs, steerRad, wheelBase);
    if (!poseClearsSolids3D({ x: pose.x, z: pose.z }, pose.h, vc)) return false;
    poses.push({ ...pose, rev: dir < 0, steer: steerRad });
  }
  return true;
}

// 前進ロック f → 後退逆ロック r を n サイクル → 出口方位へ整列前進、を候補探索。
// 全ポーズが建物/障害物に当たらない最初の候補を返す（決定論順）。無ければ null。
function planKTurnPoses({ startPos, entryHeading, exitHeading, resumePos, vc }) {
  const fp = getVehicleFootprintConfig(vc || {}, { defaultWheelBase: 3.4, defaultVehicleWidth: 2.5 });
  const wb = Math.max(1.5, Number(fp.wheelBase) || 3.4);
  const steerMax = Math.min(40, Math.max(20, Number(vc?.maxSteeringAngle) || 38)) * Math.PI / 180;
  let delta = exitHeading - entryHeading;
  while (delta > Math.PI) delta -= 2 * Math.PI;
  while (delta < -Math.PI) delta += 2 * Math.PI;
  const sigma = Math.sign(delta) || 1;

  for (const n of [1, 2, 3]) {
    for (const f of [1.2, 2.0, 2.8]) {
      for (const r of [2.0, 3.0, 4.5]) {
        const poses = [{ x: startPos.x, z: startPos.z, h: entryHeading, rev: false, steer: 0 }];
        let ok = true;
        for (let c = 0; c < n && ok; c++) {
          ok = pushValidatedArc(poses, vc, wb, f, +1, sigma * steerMax)
            && pushValidatedArc(poses, vc, wb, r, -1, -sigma * steerMax);
        }
        if (!ok) continue;
        // 整列前進: 残り方位誤差を比例操舵で詰めつつ resume 点へ（最大25m）
        let pose = poses[poses.length - 1];
        let reached = false;
        for (let i = 0; i < 60; i++) {
          let err = exitHeading - pose.h;
          while (err > Math.PI) err -= 2 * Math.PI;
          while (err < -Math.PI) err += 2 * Math.PI;
          const steer = Math.max(-steerMax, Math.min(steerMax, err * 2));
          pose = stepBicycleXZ(pose, 0.5, steer, wb);
          if (!poseClearsSolids3D({ x: pose.x, z: pose.z }, pose.h, vc)) { ok = false; break; }
          poses.push({ ...pose, rev: false, steer });
          const dx = resumePos.x - pose.x;
          const dz = resumePos.z - pose.z;
          if (Math.hypot(dx, dz) <= 1.8 && Math.abs(err) <= 15 * Math.PI / 180) {
            if (poseClearsSolids3D(resumePos, exitHeading, vc)) {
              poses.push({ x: resumePos.x, z: resumePos.z, h: exitHeading, rev: false, steer: 0 });
            }
            reached = true;
            break;
          }
        }
        if (ok && reached) return { poses, cycles: n, f, r };
      }
    }
  }
  return null;
}

function beginCornerSwitchback(sample, vc) {
  const sM = Number(sample?.sM);
  if (!Number.isFinite(sM)) return false;
  const key = `sb:${Math.round(sM / 10)}`; // 同一コーナー(サンプル間隔3m)の多重発火を防ぐ
  if (switchbackHandled3D.has(key) || hasHandledSwitchbackZone(sM)) return false;
  const fp = getVehicleFootprintConfig(vc || {}, { defaultWheelBase: 3.4, defaultVehicleWidth: 2.5 });
  const vehicleLen = Math.max(4,
    (Number(fp.wheelBase) || 3.4) + (Number(fp.frontOverhang) || 1) + (Number(fp.rearOverhang) || 1));
  const entryHeading = _routeHeadingAt(Math.max(0, sM - 3));
  // 復帰点は「コーナーの曲がりが終わる地点」まで動的に延ばす（複合ベンド対応）
  let resumeForwardM = Math.max(6, vehicleLen * 0.9);
  for (let d = resumeForwardM; d <= 22; d += 2) {
    const h0 = _routeHeadingAt(sM + d);
    const h1 = _routeHeadingAt(sM + d + 3);
    let dh = Math.abs(h1 - h0);
    while (dh > Math.PI) dh = Math.abs(dh - 2 * Math.PI);
    if (dh < 8 * Math.PI / 180) { resumeForwardM = d; break; }
    resumeForwardM = d + 2;
  }
  const resumeStationM = sM + resumeForwardM;
  const exitHeading = _routeHeadingAt(resumeStationM);
  const startPos = _sampleRouteAt(Math.max(0, sM - 1.5));
  const resumePos = _sampleRouteAt(resumeStationM);

  markHandledSwitchbackZone(key, sM, resumeStationM);
  const plan = planKTurnPoses({ startPos, entryHeading, exitHeading, resumePos, vc });
  if (!plan) {
    // 建物/障害物に当たらない切り返し軌道が見つからない場合でも即MRMにはしない。
    // planner側は swingSoftStop で徐行係数を掛けているため、そのまま監視徐行で
    // アーク経路を進む（本当に通れないコーナーなら Safety Monitor の接触検出が
    // 正直な位置でMRMを出す）。ゾーンはhandled済みなので多重試行はしない。
    console.info('[switchback] infeasible plan -> continue in monitored crawl', { sM: Math.round(sM) });
    return false;
  }
  recoveryBypassUntilM = Math.max(recoveryBypassUntilM, resumeStationM + 5);
  recoveryPlaybackCount3D += 1;
  recoveryPlayback3D = {
    kind: 'switchback',
    sM,
    poses: plan.poses,
    poseIdx: 0,
    poseDistAcc: 0,
    heading: entryHeading,
    exitHeading, // store exit heading for completion frame
    lateralM: 0,
    resumeForwardM,
    resumeStationM,
    resume: resumePos,
    reverseM: 0,
    transitionLenM: 0,
    stop: startPos,
    shifted: startPos,
    t: 0,
    reverseTime: 0,
    shiftTime: 0,
    resumeTime: 0
  };
  console.info('[switchback] K-turn v2 start', {
    sM: Math.round(sM), cycles: plan.cycles, f: plan.f, r: plan.r, poses: plan.poses.length
  });
  return true;
}

// 角度を最短回りで target へ最大 maxStep だけ近づける（操舵角速度の上限）
// 1b(c): ヘディングの最大変化角を車両連動で算出する。
// 自転車モデルの最大旋回角速度 ω = |v|·tan(δmax)/wheelBase（rad/s）に dt を掛ける。
// 低速でも収束するよう下限 0.6rad/s を設ける。
function truckHeadingMaxTurnRad(vc, speedMS, dt) {
  const fp = getVehicleFootprintConfig(vc || {}, { defaultWheelBase: 3.4, defaultVehicleWidth: 2.5 });
  const wb = Math.max(1.0, Number(fp.wheelBase) || 3.4);
  const maxSteerDeg = Math.max(12, Number(vc?.maxSteeringAngle) || 38);
  const omega = Math.abs(Number(speedMS) || 0) * Math.tan(maxSteerDeg * Math.PI / 180) / wb;
  return Math.max(0.6, omega) * Math.max(0, Number(dt) || 0);
}

function approachAngle(cur, target, maxStep) {
  let d = target - cur;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  if (Math.abs(d) <= maxStep) return target;
  return cur + Math.sign(d) * maxStep;
}

function advanceRecoveryPlayback(dt) {
  const rp = recoveryPlayback3D;
  if (!rp) return null;
  // K-turn v2: 事前検証済みポーズ列を低速で順に再生（位置・方位・操舵はポーズが持つ）
  if (Array.isArray(rp.poses)) {
    if (!rp.poseDone) {
      const KTURN_SPEED_MS = 1.6;
      rp.poseDistAcc = (rp.poseDistAcc || 0) + Math.max(0, Number(dt) || 0) * KTURN_SPEED_MS;
      while (rp.poseDistAcc >= 0.5 && rp.poseIdx < rp.poses.length - 1) {
        rp.poseDistAcc -= 0.5;
        rp.poseIdx += 1;
      }
      const p = rp.poses[rp.poseIdx];
      const atEnd = rp.poseIdx >= rp.poses.length - 1;
      if (atEnd) rp.poseDone = true;
      progressM = Math.max(progressM, Number(rp.sM) || 0);
      return {
        kind: rp.kind || null,
        pos: { x: p.x, z: p.z },
        heading: p.h,
        speedMS: atEnd ? 0 : (p.rev ? -KTURN_SPEED_MS : KTURN_SPEED_MS),
        reversing: !!p.rev,
        steeringAngle: atEnd ? 0 : Math.max(-0.6, Math.min(0.6, Number(p.steer) || 0)),
        forcePoseHeading: rp.kind === 'switchback',
        resumeStationM: rp.resumeStationM
      };
    }
    // ポーズ列を消化 → 既存の完了処理（下のタイムライン末尾）へ落とす
    rp.poses = null;
    rp.t = 1e9;
  }
  rp.t += Math.max(0, Number(dt) || 0);
  const reverseEnd = rp.reverseTime;
  const total = reverseEnd + rp.resumeTime;
  if (rp.t <= reverseEnd) {
    const u = Math.max(0, Math.min(1, rp.t / reverseEnd));
    const su = u * u * (3 - 2 * u); // smoothstep: 後退開始/終了を滑らかに
    progressM = Math.max(progressM, Number(rp.sM) || 0);
    const revHeading = rp.headingTo != null ? lerpAngleRad(rp.headingFrom, rp.headingMid, su) : rp.heading;
    const revSteer = rp.headingTo != null ? (rp.steerSign || 1) * -0.4 : Math.sign(rp.lateralM) * 0.3;
    return { pos: lerpPoint(rp.stop, rp.shifted, su), heading: revHeading, speedMS: -2.0, reversing: true, steeringAngle: revSteer };
  }
  if (rp.t <= total) {
    const u = Math.max(0, Math.min(1, (rp.t - reverseEnd) / Math.max(0.01, rp.resumeTime)));
    const su = u * u * (3 - 2 * u); // smoothstep: 横逃げ→復帰を滑らかに
    progressM = Math.max(progressM, (Number(rp.sM) || 0) + (Number(rp.resumeForwardM) || 0) * su);
    const fwdHeading = rp.headingTo != null ? lerpAngleRad(rp.headingMid, rp.headingTo, su) : rp.heading;
    const fwdSteer = rp.headingTo != null ? (rp.steerSign || 1) * 0.3 : Math.sign(rp.lateralM) * -0.25;
    return { pos: lerpPoint(rp.shifted, rp.resume, su), heading: fwdHeading, speedMS: 3.0, reversing: false, steeringAngle: fwdSteer };
  }
  // 1b(b): resume を作った地点と同じ station へ進める（従来は別式で 3〜5m 前方へ瞬間移動していた）。
  const resumeM = Number.isFinite(Number(rp.resumeStationM))
    ? Number(rp.resumeStationM)
    : rp.sM + (Number(rp.resumeForwardM) || Math.max(6, rp.reverseM + 3));
  const resumePos = rp.resume || _sampleRouteAt(resumeM);
  progressM = Math.max(progressM, resumeM);
  recoveryBypassUntilM = Math.max(recoveryBypassUntilM, resumeM + 5);
  recoveryOffsetHoldM = rp.lateralM;
  recoveryOffsetHoldUntilM = Math.max(recoveryOffsetHoldUntilM, recoveryBypassUntilM);
  autoDriveOffsetM = rp.lateralM;
  autoDriveTargetOffsetM = rp.lateralM;
  // 引継ぎ直後のヘディング slew が復旧終端の位置を基準に連続するよう、直前位置を resume に合わせる。
  lastTruckPos = { x: resumePos.x, z: resumePos.z };
  if (drivePoseMode && drivePoses.length >= 2) {
    driveTimeS = Math.max(driveTimeS, _driveTimeAtTravelM(progressM));
  }
  // The precomputed physics trajectory contains the original STOP speed limit.
  // After a recovery bypass, continuing from that trajectory would snap back to the stopped pose.
  drivePoseMode = false;
  drivePoses = [];
  driveDurationS = 0;
  recoveryPlayback3D = null;
  const doneHeading = rp.kind === 'switchback' && Number.isFinite(Number(rp.exitHeading))
    ? Number(rp.exitHeading)
    : _routeHeadingAt(resumeM);
  return {
    kind: rp.kind || null,
    done: true,
    pos: resumePos,
    heading: doneHeading,
    speedMS: 0,
    reversing: false,
    steeringAngle: 0,
    forcePoseHeading: rp.kind === 'switchback',
    resumeStationM: resumeM
  };
}

// ── 外部API ──────────────────────────────────────────────────────────
export function openThree3D() {
  const wrap = document.getElementById('map3dWrap');
  if (!wrap) return false;
  wrap.classList.add('open');
  wrap.setAttribute('aria-hidden', 'false');
  wrap.style.display = 'flex';
  const fullViewport = document.body?.classList?.contains('index3d');
  if (fullViewport) {
    wrap.style.position = '';
    wrap.style.right = '';
    wrap.style.bottom = '';
    wrap.style.width = '';
    wrap.style.height = '';
    wrap.style.zIndex = '';
    wrap.style.borderRadius = '';
    wrap.style.overflow = '';
  } else {
    wrap.style.position = 'fixed';
    wrap.style.right = '20px';
    wrap.style.bottom = '20px';
    wrap.style.width = 'min(920px, calc(100vw - 40px))';
    wrap.style.height = 'min(560px, calc(100vh - 140px))';
    wrap.style.zIndex = '5000';
    wrap.style.borderRadius = '16px';
    wrap.style.overflow = 'hidden';
  }

  if (!ensureScene()) return false;
  setTimeout(() => {
    resizeThree3D();
    if (!playing) renderSceneThree(store.getState());
    startRenderLoop();
  }, 50);
  return true;
}

export function closeThree3D() {
  playing = false;
  const wrap = document.getElementById('map3dWrap');
  if (wrap) {
    wrap.classList.remove('open');
    wrap.setAttribute('aria-hidden', 'true');
    wrap.style.display = '';
  }
  if (animId) { cancelAnimationFrame(animId); animId = null; }
  disposePlateauTiles();
}

// store の現在状態から建物・経路を構築
// #5: 道路面（+余白）を建物フットプリントから差し引く。完全に道路面内の建物は衝突対象から外す。
function clipBuildingsByRoadSurface(buildings, roadSurfaceGeo, { marginM = 0.3 } = {}) {
  const turf = window.turf;
  const arr = Array.isArray(buildings) ? buildings : [];
  if (!turf?.difference || !roadSurfaceGeo || !arr.length) return arr;
  let mask = roadSurfaceGeo;
  if (marginM > 0 && turf.buffer) {
    try { mask = turf.buffer(roadSurfaceGeo, marginM, { units: 'meters', steps: 4 }) || roadSurfaceGeo; }
    catch (_e) { mask = roadSurfaceGeo; }
  }
  if (!mask) return arr;
  const out = [];
  for (const f of arr) {
    const t = f?.geometry?.type;
    if (t !== 'Polygon' && t !== 'MultiPolygon') { out.push(f); continue; }
    try {
      const diff = turf.difference(f, mask);
      if (!diff || !diff.geometry) continue; // 建物が完全に道路面内 → 衝突対象から除外
      diff.properties = { ...(f.properties || {}) };
      out.push(diff);
    } catch (_e) {
      out.push(f); // 差分失敗時は元形状を保持
    }
  }
  return out;
}

function setBuildingStatusText(msg) {
  const el = document.getElementById('buildingStatus');
  if (el) el.textContent = msg;
}

function disposePlateauTiles() {
  if (plateauHandle) {
    try { plateauHandle.dispose(); } catch (_e) {}
  }
  plateauHandle = null;
  plateauActive = false;
  plateauKey = '';
  plateauLoadingKey = '';
  plateauLastStatus = { state: 'idle' };
}

function plateauKeepOsmBuildings() {
  return !(typeof window !== 'undefined' && window.PLATEAU_KEEP_OSM_BUILDINGS === false);
}

function shortHash(text) {
  const s = String(text || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return String(h >>> 0);
}

function currentPlateauKey(state) {
  if (!originLL) return '';
  const lodScale = Number(window.PLATEAU_LOD_SCALE) || 0.3;
  const tilesetUrl = state?.plateauTileset?.url || '';
  return [
    Math.round(Number(originLL.lat) * 1e6),
    Math.round(Number(originLL.lng) * 1e6),
    Math.round(lodScale * 1000),
    shortHash(tilesetUrl)
  ].join(':');
}

function warmPlateauTiles(handle, seq, frames = 90) {
  if (!handle || !renderer || !scene || !camera || typeof requestAnimationFrame !== 'function') return;
  let count = 0;
  const tick = () => {
    if (seq !== plateauLoadSeq || handle !== plateauHandle) return;
    try {
      handle.update?.();
      renderer.render(scene, camera);
    } catch (_e) { /* best-effort warmup */ }
    count += 1;
    if (count < frames) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// 建物の見た目を PLATEAU 3D Tiles（あれば）/ OSM（無ければ）で用意する。
// 3d-tiles-renderer は動的import（非同期）。読み込み完了までは OSM 建物を表示し、
// 準備でき次第 OSM を消して PLATEAU タイルへ差し替える（カバー外/失敗時は OSM のまま）。
function setupPlateauOrOsmBuildings(state) {
  if (typeof window !== 'undefined' && window.PLATEAU_DISABLE) {
    disposePlateauTiles();
    plateauLastStatus = { state: 'disabled' };
    return;
  }
  if (!originLL || !THREE || !scene || !camera) return;
  if (!findPlateauArea(originLL.lat, originLL.lng)) {
    disposePlateauTiles();
    plateauLastStatus = { state: 'outside-area' };
    return;
  }
  const catalogTileset = state?.plateauTileset || null;
  const allowImplicitLookup = typeof window !== 'undefined' && window.PLATEAU_ALLOW_IMPLICIT_LOOKUP === true;
  if (!catalogTileset?.url && !allowImplicitLookup) {
    disposePlateauTiles();
    plateauLastStatus = { state: 'waiting-for-road-load' };
    return;
  }

  const reqOrigin = { lat: originLL.lat, lng: originLL.lng };
  const lodScale = Number(window.PLATEAU_LOD_SCALE) || 0.3;
  const key = currentPlateauKey(state);
  if (plateauHandle && plateauKey === key) return;
  if (plateauLoadingKey === key) return;
  if (plateauHandle || plateauLoadingKey) disposePlateauTiles();
  plateauLoadingKey = key;
  const seq = ++plateauLoadSeq;
  plateauLastStatus = { state: 'loading', key };
  setBuildingStatusText('PLATEAU 3D Tiles: loading...');
  createPlateauTiles({
    THREE, scene, camera, renderer, originLL, lodScale, tileset: catalogTileset,
    onStatus: (s) => {
      plateauLastStatus = { ...s, key };
      if (s?.state === 'streaming') setBuildingStatusText(`PLATEAU 3D Tiles: ${s.area} (streaming, translucent)`);
    },
    onError: (err) => {
      if (seq !== plateauLoadSeq) return;
      console.warn('[three3d] PLATEAU tiles error, keep OSM buildings:', err?.message || err);
      disposePlateauTiles();
      plateauLastStatus = { state: 'error', reason: err?.message || String(err), key };
      addBuildings(state?.buildingsGeoJSON || []);
      setBuildingStatusText(`PLATEAU failed -> OSM buildings ${state?.buildingsGeoJSON?.length || 0}`);
    }
  }).then((handle) => {
    if (seq !== plateauLoadSeq) {
      try { handle?.dispose?.(); } catch (_e) {}
      return;
    }
    plateauLoadingKey = '';
    if (!handle) return; // 未対忁E失敁EↁEOSM のまま
    // 経路が変わって原点が動いていたら破棄（古いリクエスト）
    if (!originLL || originLL.lat !== reqOrigin.lat || originLL.lng !== reqOrigin.lng) {
      try { handle.dispose(); } catch (_e) {}
      return;
    }
    plateauHandle = handle;
    plateauActive = true;
    plateauKey = key;
    plateauLastStatus = { state: 'active', area: handle.area?.name || '', key };
    if (!plateauKeepOsmBuildings()) clearMeshesByTag('building');
    setBuildingStatusText(`PLATEAU 3D Tiles: ${handle.area?.name || ''} (translucent streaming)`);
    warmPlateauTiles(handle, seq);
  }).catch((err) => {
    if (seq !== plateauLoadSeq) return;
    plateauLoadingKey = '';
    plateauLastStatus = { state: 'setup-failed', reason: err?.message || String(err), key };
    console.warn('[three3d] PLATEAU setup failed, keep OSM:', err?.message || err);
  });
}

export function renderSceneThree(state) {
  if (!ensureScene()) return;
  if (typeof globalThis !== 'undefined') globalThis.__index3d_lastState__ = state;
  const route = state?.simRoute || [];
  // Origin = route start, or first building, or current map center.
  if (route.length >= 1) originLL = { lat: route[0].lat, lng: route[0].lng };
  else if (state?.buildingsGeoJSON?.length) {
    const g = state.buildingsGeoJSON[0]?.geometry;
    const c = g?.type === 'Polygon' ? g.coordinates[0][0] : (g?.type === 'MultiPolygon' ? g.coordinates[0][0][0] : null);
    if (c) originLL = { lat: c[1], lng: c[0] };
  }
  else {
    const center = getCurrentMapCenterLL();
    if (center) originLL = center;
  }
  if (!originLL) { originLL = { lat: 35.68, lng: 139.76 }; }
  applyRendererPixelRatio();

  addGround();
  addSatelliteGround().catch((e) => console.warn('[three3d] satellite ground failed', e?.message || e));
  const roadSurfaceGeo = getRoadSurfaceGeo(state);
  safetyRoadSurfaceGeo = roadSurfaceGeo;
  const scount = addRoadSurface(roadSurfaceGeo);
  const edgeCount = addRoadEdgesFromSurface(roadSurfaceGeo);
  addIntersectionCaps(lastIntersectionNodes);

  // Building source: PLATEAU 3D Tiles when in-area and library available;
  // otherwise OSM building extrusions (ghost boxes).
  setupPlateauOrOsmBuildings(state);
  const bcount = (plateauActive && !plateauKeepOsmBuildings()) ? 0 : addBuildings(state?.buildingsGeoJSON || []);
  addBuildingFootprints(state?.buildingsGeoJSON || []);
  const rcount = addRoads(state?.geoJsonDataSets || []);
  const centerCount = addCenterlines(state?.geoJsonDataSets || []);
  const swcount = addSidewalks(state?.sidewalkGeoJSON || []);
  const arrowCount = addOnewayArrows(state?.geoJsonDataSets || []);
  // Use clipped buildings only for collision checks.
  const collisionBuildings = clipBuildingsByRoadSurface(state?.buildingsGeoJSON || [], roadSurfaceGeo, { marginM: 0.3 });
  const solidSet = buildCollisionSolidSet({
    buildings: collisionBuildings,
    maskEdits: state?.maskEdits || {}
  });
  const solidRenderCount = addCollisionSolids(solidSet, state || {});
  addRouteLine(route);

  const turf = window.turf;
  lateralCollisionFeatures = (solidSet.lateralSolids || []).map((s) => s.feature).filter((f) => f?.geometry);
  lateralCollisionBboxes = lateralCollisionFeatures.map((f) => { try { return turf ? turf.bbox(f) : null; } catch (e) { return null; } });
  const overheadCollisionSolids = (solidSet.overheadSolids || []).filter((s) => s?.feature?.geometry);
  overheadCollisionFeatures = overheadCollisionSolids.map((s) => s.feature);
  overheadCollisionBboxes = overheadCollisionFeatures.map((f) => { try { return turf ? turf.bbox(f) : null; } catch (e) { return null; } });
  overheadCollisionHeights = overheadCollisionSolids.map((s) => ({
    id: s.id,
    heightM: s.heightM,
    source: s.heightSource,
    clearanceReliable: s.clearanceReliable !== false
  }));
  contactCount3d = 0;
  collisionAccum = 0;
  clearTruckTrail();
  buildTruck(state?.vehicleConfig, {
    loadType: state?.cargoLoadType,
    length: state?.cargoLength,
    count: state?.cargoCount,
    widthMm: state?.cargoWidthMm,
    placement: state?.cargoPlacement
  });

  routeXZ = route.map((ll) => llToXZ(ll.lat, ll.lng));
  routeCum = [0];
  for (let i = 1; i < routeXZ.length; i++) {
    const a = routeXZ[i - 1], b = routeXZ[i];
    routeCum[i] = routeCum[i - 1] + Math.hypot(b.x - a.x, b.z - a.z);
  }
  progressM = 0;
  drivePoses = [];
  driveTimeS = 0;
  driveDurationS = 0;
  drivePoseMode = false;
  autonomyReport3D = null;
  autonomyCurrentSample = null;
  resetSafetyMonitor3D();
  recoveryPlayback3D = null;
  recoveryHandledKeys3D = new Set();
  switchbackHandled3D = new Set();
  switchbackHandledZones3D = [];
  recoveryPlaybackCount3D = 0;
  recoveryBypassUntilM = 0;
  recoveryOffsetHoldM = 0;
  recoveryOffsetHoldUntilM = 0;
  clearMeshesByTag('autonomySensor');
  clearMeshesByTag('recoveryTrajectory');
  setSimTelemetry({ speedMS: 0, steeringAngle: 0 });
  setAutonomyTelemetry(null, null);

  // トラックを始点に配置
  if (routeXZ.length >= 2) {
    const h0 = _routeHeadingAt(0);
    placeTruckAt(routeXZ[0].x, routeXZ[0].z, h0);
    truckRenderHeading = h0;
    lastTruckPos = { x: routeXZ[0].x, z: routeXZ[0].z };
    _frameCameraToRoute();
  }
  const stat = document.getElementById('map3dPoseCount');
  if (stat) stat.textContent = String(route.length);
  applyRoadSurfaceAlpha();
  applyThreeRoadLayerVisibility();
  refreshThreeDiagnostics(); // 項目5: ON 中の診断レイヤーを再構築後のシーンへ追従（autonomy系はreport再生成まで空）
  console.log(`[three3d] scene built: buildings=${bcount}, roadSurfaces=${scount}, roads=${rcount}, centerlines=${centerCount}, roadEdges=${edgeCount}, sidewalks=${swcount}, onewayArrows=${arrowCount}, solids=${solidRenderCount}, routePts=${route.length}`);
}

function _routeHeadingAt(s) {
  // Heading at travel distance s in radians.
  if (routeXZ.length < 2) return 0;
  const total = routeCum[routeCum.length - 1];
  const sc = Math.max(0, Math.min(total, s));
  let lo = 0, hi = routeCum.length - 1;
  while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (routeCum[mid] <= sc) lo = mid; else hi = mid; }
  const a = routeXZ[lo], b = routeXZ[hi];
  const dx = b.x - a.x;       // 譚ｱ
  const dz = b.z - a.z;
  return Math.atan2(dx, -dz);
}

function _sampleRouteAt(s) {
  const total = routeCum[routeCum.length - 1];
  const sc = Math.max(0, Math.min(total, s));
  let lo = 0, hi = routeCum.length - 1;
  while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (routeCum[mid] <= sc) lo = mid; else hi = mid; }
  const seg = routeCum[hi] - routeCum[lo];
  const t = seg > 1e-6 ? (sc - routeCum[lo]) / seg : 0;
  return {
    x: routeXZ[lo].x + (routeXZ[hi].x - routeXZ[lo].x) * t,
    z: routeXZ[lo].z + (routeXZ[hi].z - routeXZ[lo].z) * t
  };
}

function _sampleDrivePoseAtTime(timeS) {
  if (!drivePoses.length) return null;
  if (timeS <= drivePoses[0].timeS) return drivePoses[0];
  const last = drivePoses[drivePoses.length - 1];
  if (timeS >= last.timeS) return last;
  let lo = 0, hi = drivePoses.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (drivePoses[mid].timeS <= timeS) lo = mid;
    else hi = mid;
  }
  const a = drivePoses[lo], b = drivePoses[hi];
  const span = Math.max(1e-6, b.timeS - a.timeS);
  const t = Math.max(0, Math.min(1, (timeS - a.timeS) / span));
  return {
    x: a.x + (b.x - a.x) * t,
    z: a.z + (b.z - a.z) * t,
    heading: interpolateAngle(a.heading, b.heading, t),
    speedMS: a.speedMS + (b.speedMS - a.speedMS) * t,
    steeringAngle: a.steeringAngle + (b.steeringAngle - a.steeringAngle) * t,
    travelM: a.travelM + (b.travelM - a.travelM) * t,
    timeS
  };
}

function _driveTimeAtTravelM(targetM) {
  if (!drivePoses.length) return driveTimeS;
  const target = Math.max(0, Number(targetM) || 0);
  if (target <= (Number(drivePoses[0].travelM) || 0)) return Number(drivePoses[0].timeS) || 0;
  const last = drivePoses[drivePoses.length - 1];
  if (target >= (Number(last.travelM) || 0)) return Number(last.timeS) || driveTimeS;
  let lo = 0;
  let hi = drivePoses.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if ((Number(drivePoses[mid].travelM) || 0) <= target) lo = mid;
    else hi = mid;
  }
  const a = drivePoses[lo];
  const b = drivePoses[hi];
  const span = Math.max(1e-6, (Number(b.travelM) || 0) - (Number(a.travelM) || 0));
  const t = Math.max(0, Math.min(1, (target - (Number(a.travelM) || 0)) / span));
  return (Number(a.timeS) || 0) + ((Number(b.timeS) || 0) - (Number(a.timeS) || 0)) * t;
}

function _frameCameraToRoute() {
  if (!camera || routeXZ.length < 1) return;
  const start = routeXZ[0];
  camera.position.set(start.x + 30, 50, start.z + 50);
  if (controls) { controls.target.set(start.x, 0, start.z); controls.update(); }
}

// Start driving animation along the generated route.
export function playThree3D(speedKmh = 18) {
  if (!isReady()) return;
  const state = store.getState();
  const route = state?.simRoute || [];
  if (route.length < 2) return;

  // planner と物理再生は必ず同一の正規化経路（車両向けアーク付き）を評価する。
  // 生simRouteをplannerに渡すと、90°折れ点の見かけ旋回半径・ステーション(sM)が
  // 実走軌道とずれ、偽の切り返し推奨→K-turn不成立MRMになる（教師回帰で大量偽停止の主因）。
  const playbackRoute = buildPlaybackRouteForVehicle(route, state);
  const routeForDrive = (Array.isArray(playbackRoute) && playbackRoute.length >= 2) ? playbackRoute : route;

  try {
    autonomyReport3D = buildAutonomyDriveReport({
      route: routeForDrive,
      roads: state?.geoJsonDataSets || [],
      buildings: state?.buildingsGeoJSON || [],
      maskEdits: state?.maskEdits || {},
      vehicleConfig: state?.vehicleConfig || {},
      cargoLoadType: state?.cargoLoadType,
      cargoCount: state?.cargoCount,
      cruiseSpeedKmh: Number(speedKmh) || 18
    });
    autonomyCurrentSample = null;
    autonomyCurrentLimit = null;
    addAutonomySensorPreview(autonomyReport3D);
    addRecoveryTrajectoryPreview(autonomyReport3D);
    refreshThreeDiagnostics(); // 項目5: ON 中の診断レイヤーを新しいレポートで更新
    setAutonomyTelemetry(null, autonomyReport3D);
  } catch (e) {
    autonomyReport3D = null;
    autonomyCurrentSample = null;
    autonomyCurrentLimit = null;
    clearMeshesByTag('recoveryTrajectory');
    console.warn('[three3d] autonomy planner failed:', e?.message || e);
  }

  // 物理シミュレーション軌跡（後輪軸の実走ライン + 時間/速度/舵角）を生成
  let simPoses = null;
  try {
    const routeForPhysics = routeForDrive;
    coordinateSystem.setOrigin(routeForPhysics[0].lat, routeForPhysics[0].lng);
    const pathM = routeForPhysics.map((ll) => coordinateSystem.latLngToMeters(ll.lat, ll.lng));
    const simConfig = {
      ...(state.vehicleConfig || {}),
      vehicleSpeed: Math.max(1, Number(speedKmh) || 18) / 3.6
    };
    const phys = simulatePathPoses(simConfig, pathM, 0.45, {
      dt: 0.05,
      speedLimitAtM: (sM) => {
        const sample = sampleAutonomyAtProgress(sM);
        return autonomyPlaybackLimit(sample, simConfig.vehicleSpeed).allowedMS;
      }
    });
    if (Array.isArray(phys) && phys.length >= 2) {
      simPoses = phys.map((p) => {
        const ll = coordinateSystem.metersToLatLng(p.x, p.y);
        const xz = llToXZ(ll.lat, ll.lng);
        return {
          x: xz.x,
          z: xz.z,
          heading: headingFromPhysicsTheta(p.theta || 0),
          speedMS: Number(p.speedMS) || 0,
          steeringAngle: Number(p.steeringAngle) || 0,
          timeS: Number(p.timeS) || 0,
          travelM: Number(p.travelM) || 0
        };
      });
      console.log(`[three3d] physics trajectory: ${simPoses.length} poses (kinematic bicycle model)`);
      console.log('[three3d] playback route:', drivePlaybackRouteSource, drivePlaybackRouteMetrics || {});
    }
  } catch (e) {
    console.warn('[three3d] physics sim failed, fallback to raw route:', e?.message || e);
  }

  // Use the physics trajectory for the truck path when available.
  if (simPoses && simPoses.length >= 2) {
    drivePoses = simPoses;
    driveTimeS = 0;
    driveDurationS = Math.max(0, simPoses[simPoses.length - 1].timeS || 0);
    drivePoseMode = driveDurationS > 0;
    routeXZ = simPoses.map((p) => ({ x: p.x, z: p.z }));
    routeCum = [0];
    for (let i = 1; i < routeXZ.length; i++) {
      const a = routeXZ[i - 1], b = routeXZ[i];
      routeCum[i] = routeCum[i - 1] + Math.hypot(b.x - a.x, b.z - a.z);
    }
  }
  if (routeXZ.length < 2) return;

  progressM = 0;
  playing = true;
  followCam = true;
  lastTs = 0;
  const total = routeCum[routeCum.length - 1];
  const speedMS = Math.max(1, Number(speedKmh) || 18) / 3.6;
  playThree3D._speedMS = speedMS;
  playThree3D._total = total;
  setSimTelemetry({ speedMS: 0, steeringAngle: 0, model: `${drivePoseMode ? 'kinematic bicycle' : 'constant playback'} / autonomy v1` });
  contactCount3d = 0;
  autoDriveOffsetM = 0;
  autoDriveTargetOffsetM = 0;
  autoDriveAvoidCount = 0;
  autoDriveWasOffset = false;
  autoDriveWasDanger = false;
  recoveryPlayback3D = null;
  recoveryHandledKeys3D = new Set();
  switchbackHandled3D = new Set();
  switchbackHandledZones3D = [];
  recoveryPlaybackCount3D = 0;
  recoveryBypassUntilM = 0;
  recoveryOffsetHoldM = 0;
  recoveryOffsetHoldUntilM = 0;
  startSafetyMonitor3D(state, speedKmh);
  clearTruckTrail();
  truckRenderHeading = routeXZ.length >= 2 ? _routeHeadingAt(0) : 0;
  lastTruckPos = routeXZ.length >= 1 ? { x: routeXZ[0].x, z: routeXZ[0].z } : null;
  if (lastTruckPos) addTruckTrailFootprint(lastTruckPos, truckRenderHeading, state?.vehicleConfig || {}, 0);
  startRenderLoop();
}

export function stopThree3D() { playing = false; }

function startRenderLoop() {
  if (animId) return;
  const loop = (ts) => {
    animId = requestAnimationFrame(loop);
    if (!isReady()) return;

    // Keep PLATEAU 3D Tiles streaming updated as the camera moves.
    if (plateauHandle) plateauHandle.update();

    if (playing && routeXZ.length >= 2) {
      if (!lastTs) lastTs = ts;
      const dt = Math.min(0.1, (ts - lastTs) / 1000);
      const simDt = dt * getPlaybackSpeedScale();
      lastTs = ts;
      const speedMS = playThree3D._speedMS || 5;
      const total = playThree3D._total || routeCum[routeCum.length - 1];
      const preAutonomySample = sampleAutonomyAtProgress(progressM);
      const preLimit = autonomyPlaybackLimit(preAutonomySample, speedMS);
      // drivePoseMode の時系列は simulatePathPoses() で速度制限を織り込み済み。
      // ここでも scale を掛けると低速区間が二重に遅くなり、実車らしく動かない。
      const driveDt = drivePoseMode ? simDt : simDt * preLimit.scale;
      let basePos = null;
      let basePosAlreadyOffset = false;
      let heading = 0;
      let poseSpeedMS = speedMS;
      let poseSteer = 0;
      let forceHeadingNow = false;
      const bypassPlaybackActive = !recoveryPlayback3D && recoveryBypassUntilM > progressM + 0.25;
      if (drivePoseMode && !bypassPlaybackActive && drivePoses.length >= 2) {
        driveTimeS = Math.min(driveDurationS, driveTimeS + driveDt);
        const pose = _sampleDrivePoseAtTime(driveTimeS);
        basePos = pose ? { x: pose.x, z: pose.z } : _sampleRouteAt(progressM);
        heading = pose?.heading ?? _routeHeadingAt(progressM);
        poseSpeedMS = pose?.speedMS ?? speedMS;
        poseSteer = pose?.steeringAngle ?? 0;
        progressM = Math.min(total, pose?.travelM ?? progressM);
      } else {
        progressM = Math.min(total, progressM + Math.min(speedMS, preLimit.allowedMS) * simDt);
        basePos = _sampleRouteAt(progressM);
        heading = _routeHeadingAt(progressM);
      }
      autonomyCurrentSample = sampleAutonomyAtProgress(progressM) || preAutonomySample;
      const currentLimit = autonomyPlaybackLimit(autonomyCurrentSample, speedMS);
      autonomyCurrentLimit = currentLimit;
      poseSpeedMS = Math.min(poseSpeedMS, currentLimit.allowedMS);
      const currentState = store.getState();
      const vc = currentState.vehicleConfig;
      if (!recoveryPlayback3D) {
        const ev = findPlayableRecoveryEvent(autonomyCurrentSample, progressM);
        if (ev) beginRecoveryPlayback(ev);
      }
      // 切り返し（K-turn）: スイング超過の急コーナーは徐行で突っ込まず、
      // 手前で一旦停止→後退でヘディングを出口へ振ってから再進入する（planner推奨フラグ）。
      const switchbackStationM = Number(autonomyCurrentSample?.sM);
      const terminalSwitchbackGrace = total > 0 && Number.isFinite(switchbackStationM)
        && switchbackStationM >= total - SAFETY_ENDPOINT_GRACE_M;
      if (!recoveryPlayback3D && autonomyCurrentSample?.switchbackRecommended
          && !bypassPlaybackActive
          && !terminalSwitchbackGrace
          && progressM >= (Number(autonomyCurrentSample.sM) || 0) - 4) {
        beginCornerSwitchback(autonomyCurrentSample, vc);
      }
      const recoveryPose = advanceRecoveryPlayback(simDt);
      const manualRecoveryActive = recoveryPose && !recoveryPose.done;
      if (recoveryPose?.done) {
        basePos = recoveryPose.pos || _sampleRouteAt(progressM);
        basePosAlreadyOffset = !!recoveryPose.pos;
        heading = recoveryPose.heading ?? _routeHeadingAt(progressM);
        poseSpeedMS = recoveryPose.speedMS ?? 0;
        poseSteer = recoveryPose.steeringAngle ?? 0;
        // K-turn完了直後は、直前の切り返し方位を移動ベクトルslewが保持すると
        // 復帰点で車体だけ斜めに残り、道路帯を割る。完了フレームだけ経路方位へ同期する。
        forceHeadingNow = true;
      } else if (manualRecoveryActive) {
        basePos = recoveryPose.pos;
        basePosAlreadyOffset = true;
        heading = recoveryPose.heading;
        poseSpeedMS = recoveryPose.speedMS;
        poseSteer = recoveryPose.steeringAngle;
        if (recoveryPose.forcePoseHeading) forceHeadingNow = true;
      }

      // 横移動（クラブ走行）は絶対に許容しない。実車は前後進＋操舵でしか動けず、
      // 車線内を横スライドさせる回避・復旧オフセットは非物理。横オフセットは常に0。
      // 障害物で中心線が通れない場合は、横にずらして回避せず接触として現れる（=判定が正直になる）。
      autoDriveOffsetM = 0;
      autoDriveTargetOffsetM = 0;
      recoveryOffsetHoldM = 0;
      recoveryOffsetHoldUntilM = 0;

      // 復旧(後退/リプラン)が生成した物理ポーズはそのまま使い、それ以外は経路を横ずれ無しで辿る。
      const pos = basePos;
      const isOffsetNow = Math.abs(autoDriveOffsetM) >= 0.12;
      if (isOffsetNow && !autoDriveWasOffset) autoDriveAvoidCount++;
      autoDriveWasOffset = isOffsetNow;
      // 通常走行は物理モデルの向き(pose.heading=後輪軸ヘディング)を基準とし、下の slew で単一ソースへ追従させる。
      // 1b(a)+(c): ヘディングは常に単一ソースへ車両連動レートで slew する。
      // 通常走行/回避/復旧で取得元を切り替えず（deviating トグル廃止）、出入りのカクツキを除去。
      // 前進中は実移動ベクトル、後退中は車体ヘディング(pose)を目標とする。
      const reversingNow = (manualRecoveryActive && recoveryPose?.reversing) || poseSpeedMS < -0.05;
      const maxTurn = truckHeadingMaxTurnRad(vc, poseSpeedMS, simDt);
      let targetHeading = heading; // 既定: pose/復旧の車体ヘディング
      if (forceHeadingNow) {
        truckRenderHeading = heading;
      } else if (!reversingNow && lastTruckPos) {
        const mvx = pos.x - lastTruckPos.x;
        const mvz = pos.z - lastTruckPos.z;
        targetHeading = Math.hypot(mvx, mvz) > 0.03 ? Math.atan2(mvx, -mvz) : truckRenderHeading;
      }
      if (!forceHeadingNow) {
        heading = approachAngle(truckRenderHeading, targetHeading, maxTurn);
        truckRenderHeading = heading;
      }
      lastTruckPos = { x: pos.x, z: pos.z };
      placeTruckAt(pos.x, pos.z, heading);
      setTruckSteer(poseSteer);
      addTruckTrailFootprint(pos, heading, vc, progressM);
      setSimTelemetry({
        speedMS: poseSpeedMS,
        steeringAngle: poseSteer,
        model: `${manualRecoveryActive ? (recoveryPose?.kind === 'switchback' ? 'K-turn switchback' : 'reverse/replan recovery') : (drivePoseMode ? 'kinematic bicycle' : 'constant playback')} / autonomy v1`
      });
      setAutonomyTelemetry(autonomyCurrentSample, autonomyReport3D, currentLimit);

      const monitorHit = checkTruckSolidCollision(pos, heading, currentState);
      runSafetyMonitorTick({
        pos,
        heading,
        state: currentState,
        speedMS: poseSpeedMS,
        sample: autonomyCurrentSample,
        limit: currentLimit,
        simDt,
        collision: monitorHit
      });
      if (
        !safetyMrmStop3D
        && currentLimit.mode === 'STOP'
        && autonomyCurrentSample?.blockerRole === 'overhead'
        && !manualRecoveryActive
        && !recoveryPlayback3D
        && !isRecoveryBypassActive(autonomyCurrentSample, progressM)
      ) {
        triggerMrmStop3D('planner_stop_unresolved', {
          progressM: Math.round((Number(progressM) || 0) * 10) / 10,
          sample: autonomyCurrentSample || null,
          recoveryStatus: autonomyReport3D?.summary?.recoveryStatus || null
        });
      }
      updateAutonomyHud3D(autonomyCurrentSample, currentLimit, poseSpeedMS);

      // Check building contacts on simulation time.
      collisionAccum += simDt;
      if (collisionAccum >= 0.1) {
        collisionAccum = 0;
        setTruckDanger(monitorHit);
        if (monitorHit && !autoDriveWasDanger) contactCount3d++;
        autoDriveWasDanger = monitorHit;
        const cEl = document.getElementById('map3dCollisionCount');
        if (cEl) cEl.textContent = String(contactCount3d);
      }

      // 進捗表示
      const poseEl = document.getElementById('map3dPoseCount');
      if (poseEl) {
        if (safetyMrmStop3D) {
          poseEl.textContent = `${Math.round(progressM)}m / MRM ${safetyMrmStop3D.reason}`;
        } else {
        const offsetText = Math.abs(autoDriveOffsetM) >= 0.12
          ? ` / AUTO ${autoDriveOffsetM > 0 ? '+' : ''}${autoDriveOffsetM.toFixed(1)}m`
          : '';
        const avoidText = autoDriveAvoidCount ? ` / avoid ${autoDriveAvoidCount}` : '';
        const recoveryText = manualRecoveryActive ? ' / reverse' : (recoveryPlaybackCount3D ? ` / recovery ${recoveryPlaybackCount3D}` : '');
        poseEl.textContent = `${Math.round(progressM)}m / ${Math.round(total)}m${offsetText}${avoidText}${recoveryText}`;
        }
      }

      // Follow camera.
      if (followCam && camera) {
        const back = 22, up = 14;
        const camX = pos.x - Math.sin(heading) * back;
        const camZ = pos.z + Math.cos(heading) * back;
        camera.position.lerp(new THREE.Vector3(camX, up, camZ), 0.12);
        if (controls) { controls.target.lerp(new THREE.Vector3(pos.x, 2, pos.z), 0.15); }
      }

      if ((drivePoseMode && driveTimeS >= driveDurationS) || (!drivePoseMode && progressM >= total)) {
        playing = false;
        setSimTelemetry({
          speedMS: 0,
          steeringAngle: poseSteer,
          model: `${drivePoseMode ? 'kinematic bicycle' : 'constant playback'} / autonomy v1`
        });
        setAutonomyTelemetry(autonomyCurrentSample, autonomyReport3D, currentLimit);
      }
    }

    if (controls) controls.update();
    renderer.render(scene, camera);
  };
  animId = requestAnimationFrame(loop);
}

export function resizeThree3D() {
  if (!renderer || !camera || !container) return;
  const w = container.clientWidth || 800;
  const h = container.clientHeight || 500;
  applyRendererPixelRatio();
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

export function initThree3D() {
  console.log('[three3d] ready (lazy init on open)');
}
