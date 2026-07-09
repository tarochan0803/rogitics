import { RUNTIME_CONFIG, yoloAuthHeaders } from '../config.js';
import { turf } from '../utils/geo.js';
import { getObstacleHeightRange } from './voxelCollision.js';

function isWebGpuAvailable() {
  try {
    return typeof navigator !== 'undefined' && !!navigator.gpu;
  } catch (_err) {
    return false;
  }
}

function bbox(feature) {
  try {
    return turf.bbox(feature);
  } catch (_err) {
    return null;
  }
}

function bboxIntersects(a, b) {
  if (!a || !b) return true;
  return !(a[0] > b[2] || a[2] < b[0] || a[1] > b[3] || a[3] < b[1]);
}

function centerOfBbox(bb) {
  return bb ? { lng: (bb[0] + bb[2]) * 0.5, lat: (bb[1] + bb[3]) * 0.5 } : null;
}

function isHeightRelevant(obstacle, vehicleHeight, clearance) {
  const range = getObstacleHeightRange(obstacle);
  if (!range) return true;
  const vehTop = Math.max(0, Number(vehicleHeight) || 0) + Math.max(0, Number(clearance) || 0);
  return range.low <= vehTop + 0.01;
}

function remoteVoxelBaseUrl() {
  const explicit = String(RUNTIME_CONFIG.remoteVoxelServerUrl || '').trim();
  if (explicit) return explicit.replace(/\/$/, '');
  const yolo = String(RUNTIME_CONFIG.yoloServerUrl || '').trim();
  return yolo ? yolo.replace(/\/$/, '') : '';
}

function geometryPayload(feature, id) {
  if (!feature?.geometry) return null;
  return {
    id: String(feature.id || feature.properties?.id || id),
    geometry: feature.geometry,
    properties: feature.properties || {}
  };
}

// リモート voxel サーバーが落ちている時、毎回タイムアウトを待つと判定が極端に遅くなる。
// 一度失敗したら一定時間（クールダウン）はリモートを試さず即CPUフォールバックする。
let _remoteVoxelDownUntil = 0;
const REMOTE_VOXEL_TIMEOUT_MS = 1500;     // 4.5s → 1.5s（速く諦める）
const REMOTE_VOXEL_COOLDOWN_MS = 60000;   // 失敗後60秒はスキップ

async function tryRemoteVoxelCollision({ fps, obs, vehicleHeight, clearance, voxelSizeMeters, maxContactPoints }) {
  const base = remoteVoxelBaseUrl();
  if (!base || typeof fetch !== 'function') return null;
  // 直近で接続失敗していればリモートをスキップ（無駄なタイムアウト待ちを防ぐ）
  if (Date.now() < _remoteVoxelDownUntil) return null;
  const payload = {
    footprints: fps.map((f, i) => geometryPayload(f, `fp-${i}`)).filter(Boolean),
    obstacles: obs.map((f, i) => geometryPayload(f, `ob-${i}`)).filter(Boolean),
    vehicleHeight,
    clearance,
    voxelSizeMeters,
    maxContactPoints
  };
  if (!payload.footprints.length || !payload.obstacles.length) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REMOTE_VOXEL_TIMEOUT_MS);
  try {
    const resp = await fetch(`${base}/voxel-collision`, {
      method: 'POST',
      headers: yoloAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload),
      signal: ctrl.signal
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    if (!data || !data.status) throw new Error('invalid voxel response');
    return {
      status: data.status,
      backend: `remote:${data.backend || 'unknown'}`,
      remote: true,
      remoteUrl: base,
      gpu: data.gpu || null,
      webgpuAvailable: isWebGpuAvailable(),
      voxelSizeMeters: Number(data.voxelSizeMeters ?? voxelSizeMeters),
      contactCount: Number(data.contactCount) || 0,
      totalSamples: Number(data.totalSamples) || fps.length,
      contactRatio: Number(data.contactRatio) || 0,
      firstContact: data.firstContact || null,
      violations: Array.isArray(data.violations) ? data.violations : [],
      contactPoints: data.contactPoints || { type: 'FeatureCollection', features: [] }
    };
  } catch (e) {
    // 接続失敗 → 一定時間リモートをスキップして即CPUにフォールバック
    _remoteVoxelDownUntil = Date.now() + REMOTE_VOXEL_COOLDOWN_MS;
    console.warn(`[voxel] remote GPU unavailable (${e.message}); using local CPU for next ${REMOTE_VOXEL_COOLDOWN_MS / 1000}s`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function getVoxelCollisionCapabilities() {
  const remoteUrl = remoteVoxelBaseUrl();
  return {
    webgpuAvailable: isWebGpuAvailable(),
    remoteUrl,
    backend: isWebGpuAvailable() ? 'webgpu-ready-cpu-raster' : 'cpu-voxel-raster'
  };
}

export async function runFullVoxelCollision({
  footprints = [],
  obstacles = [],
  vehicleHeight = 0,
  clearance = 0.25,
  voxelSizeMeters = 0.5,
  maxContactPoints = 240
} = {}) {
  const fps = Array.isArray(footprints) ? footprints.filter(Boolean) : [];
  const obs = Array.isArray(obstacles) ? obstacles.filter((f) => f?.geometry) : [];
  const capabilities = getVoxelCollisionCapabilities();
  if (!fps.length || !obs.length) {
    return {
      status: 'OK',
      backend: capabilities.backend,
      webgpuAvailable: capabilities.webgpuAvailable,
      voxelSizeMeters,
      contactCount: 0,
      totalSamples: fps.length,
      contactRatio: 0,
      violations: [],
      contactPoints: { type: 'FeatureCollection', features: [] }
    };
  }

  const remoteResult = await tryRemoteVoxelCollision({
    fps,
    obs,
    vehicleHeight,
    clearance,
    voxelSizeMeters,
    maxContactPoints
  });
  if (remoteResult) return remoteResult;

  const obstacleBboxes = obs.map(bbox);
  const obstacleRanges = obs.map(getObstacleHeightRange);
  const pointStride = Math.max(1, Math.ceil(fps.length / Math.max(20, Number(maxContactPoints) || 240)));
  const violations = [];
  const pointFeatures = [];
  let contactCount = 0;
  let firstContact = null;

  for (let i = 0; i < fps.length; i++) {
    const fp = fps[i];
    const fpBbox = bbox(fp);
    if (!fpBbox) continue;
    for (let j = 0; j < obs.length; j++) {
      if (!bboxIntersects(fpBbox, obstacleBboxes[j])) continue;
      if (!isHeightRelevant(obs[j], vehicleHeight, clearance)) continue;
      let hit = false;
      try {
        hit = turf.booleanIntersects(fp, obs[j]);
      } catch (_err) {
        hit = false;
      }
      if (!hit) continue;
      contactCount += 1;
      const center = centerOfBbox(fpBbox);
      const props = obs[j].properties || {};
      const heightOnly = props.heightOnly === true
        || props.heightOnly === 1
        || (typeof props.heightOnly === 'string' && ['1', 'true', 'yes'].includes(props.heightOnly.toLowerCase()));
      const reason = heightOnly ? 'overhang' : 'building_contact';
      if (!firstContact && center) firstContact = { lat: center.lat, lng: center.lng, reason };
      if (i % pointStride === 0 && center) {
        pointFeatures.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [center.lng, center.lat] },
          properties: {
            reason,
            obstacleId: obs[j].id || props.id || null,
            backend: capabilities.backend,
            obstacleHeight: obstacleRanges[j]?.high ?? null
          }
        });
      }
      violations.push({
        type: reason,
        poseIndex: i,
        obstacleId: obs[j].id || props.id || null,
        obstacleHeight: obstacleRanges[j]?.high ?? null,
        required: Number((Number(vehicleHeight || 0) + Number(clearance || 0)).toFixed(2))
      });
      break;
    }
  }

  return {
    status: contactCount === 0 ? 'OK' : 'NG',
    backend: capabilities.backend,
    webgpuAvailable: capabilities.webgpuAvailable,
    voxelSizeMeters,
    contactCount,
    totalSamples: fps.length,
    contactRatio: fps.length ? contactCount / fps.length : 0,
    firstContact,
    violations,
    contactPoints: { type: 'FeatureCollection', features: pointFeatures }
  };
}
