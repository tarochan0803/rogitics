import { getVehicleFootprintConfig } from '../3d/clearanceSolids.js';
import { COLLISION_CONFIG } from '../config.js';
import { coordinateSystem, turf } from '../utils/geo.js';
import { buildFootprintPolygonAtPose } from './feasibility.js';

const DEFAULT_HEIGHT_CLEARANCE = 0.25;

function isPolygonLikeFeature(feature) {
  const g = feature?.geometry;
  return !!g && (g.type === 'Polygon' || g.type === 'MultiPolygon');
}

function asFeatureArray(geo) {
  if (!geo) return [];
  if (Array.isArray(geo)) return geo;
  if (geo.type === 'FeatureCollection') return Array.isArray(geo.features) ? geo.features : [];
  if (geo.type === 'Feature') return [geo];
  if (geo.type) return [{ type: 'Feature', properties: {}, geometry: geo }];
  return [];
}

function bboxOfFeature(feature) {
  try {
    return turf.bbox(feature);
  } catch (e) {
    return null;
  }
}

function expandBbox(bbox, pad) {
  if (!bbox || bbox.length !== 4 || !Number.isFinite(pad) || pad <= 0) return bbox;
  // BBox を正規化してから展開（反転BBoxによる誤判定を防ぐ）
  const minX = Math.min(bbox[0], bbox[2]);
  const minY = Math.min(bbox[1], bbox[3]);
  const maxX = Math.max(bbox[0], bbox[2]);
  const maxY = Math.max(bbox[1], bbox[3]);
  return [minX - pad, minY - pad, maxX + pad, maxY + pad];
}

function bboxIntersects(a, b) {
  if (!a || !b) return true;
  return !(a[0] > b[2] || a[2] < b[0] || a[1] > b[3] || a[3] < b[1]);
}

function bboxOfRing(ring) {
  let bb = null;
  for (const pt of ring || []) {
    const x = pt?.[0];
    const y = pt?.[1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (!bb) bb = [x, y, x, y];
    else {
      if (x < bb[0]) bb[0] = x;
      if (y < bb[1]) bb[1] = y;
      if (x > bb[2]) bb[2] = x;
      if (y > bb[3]) bb[3] = y;
    }
  }
  return bb;
}

function normalizeHeight(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function getFeatureHeight(feature, fallback = 3) {
  const props = feature?.properties && typeof feature.properties === 'object' ? feature.properties : {};
  const candidates = [props.h, props.height, props.H, props.z, props.alt];
  for (const v of candidates) {
    const h = normalizeHeight(v);
    if (h != null) return h;
  }
  return Number.isFinite(fallback) ? fallback : 3;
}

function isHeightOnly(feature) {
  const v = feature?.properties?.heightOnly;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v === 1;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    return s === '1' || s === 'true' || s === 'yes';
  }
  return false;
}

function ensureOrigin(origin) {
  if (!origin) return;
  const lat = Number(origin.lat);
  const lng = Number(origin.lng);
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    coordinateSystem.setOrigin(lat, lng);
  }
}

export function buildCollisionIndex({
  roadUnion = null,
  obstacles = null,
  bboxPadding = COLLISION_CONFIG.bboxPadding,
  obstacleDefaultHeight = 3
} = {}) {
  const obstacleFeatures = asFeatureArray(obstacles).filter(isPolygonLikeFeature);
  const obstacleBboxes = obstacleFeatures.map((f) => expandBbox(bboxOfFeature(f), bboxPadding));
  const obstacleHeights = obstacleFeatures.map((f) => getFeatureHeight(f, obstacleDefaultHeight));
  const obstacleHeightOnly = obstacleFeatures.map((f) => isHeightOnly(f));

  let roadUnionBbox = null;
  if (roadUnion) {
    roadUnionBbox = expandBbox(bboxOfFeature(roadUnion), bboxPadding);
  }

  return {
    roadUnion,
    roadUnionBbox,
    obstacleFeatures,
    obstacleBboxes,
    obstacleHeights,
    obstacleHeightOnly,
    bboxPadding
  };
}

export function checkPoseCollision(pose, vehicleConfig, index, opts = {}) {
  // 不正入力は null でなく明示的なエラーステータスを返す（null は呼び出し元で OK 扱いになりやすい）
  if (!pose || !vehicleConfig || !index) {
    return { status: 'ERROR', reason: 'missing_input', footprint: null };
  }
  ensureOrigin(opts.origin);

  // ④ envelope統一: 接触判定の外形も判定側スイープと同じ getVehicleFootprintConfig 経由で出す。
  // バッチ呼び出しでは batchCollisionCheck が opts.footprintConfig を渡して再計算を避ける。
  const fpCfg = opts.footprintConfig
    || getVehicleFootprintConfig(vehicleConfig, { defaultVehicleWidth: 2.0 });
  const footprint = buildFootprintPolygonAtPose(
    { x: pose.x, y: pose.y },
    pose.theta,
    fpCfg
  );
  if (!footprint) return null;

  const includeFootprint = opts.includeFootprint === true;
  const fpRing = footprint?.geometry?.coordinates?.[0] || [];
  const fpBbox = bboxOfRing(fpRing);

  const roadUnion = index.roadUnion;
  const hasRoadCheck = !!roadUnion && typeof turf?.booleanWithin === 'function';
  if (hasRoadCheck) {
    if (index.roadUnionBbox && fpBbox && !bboxIntersects(index.roadUnionBbox, fpBbox)) {
      return { status: 'NG', reason: 'road', footprint: includeFootprint ? footprint : null };
    }
    let within = true;
    try {
      within = turf.booleanWithin(footprint, roadUnion);
    } catch (e) {
      // booleanWithin が複雑ポリゴンで失敗した場合、フットプリント重心点で代替チェック
      try {
        const ring = footprint?.geometry?.coordinates?.[0];
        if (ring && ring.length >= 4 && typeof turf?.booleanPointInPolygon === 'function') {
          // 重心を計算（閉じたリングの最後の点を除く）
          const pts = ring.slice(0, -1);
          const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
          const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
          within = turf.booleanPointInPolygon(turf.point([cx, cy]), roadUnion);
        }
      } catch (e2) {
        within = true; // 二重フォールバック: 不明な場合はOK扱い
      }
    }
    if (!within) {
      return { status: 'NG', reason: 'road', footprint: includeFootprint ? footprint : null };
    }
  }

  const obstacleFeatures = index.obstacleFeatures || [];
  const hasObstacleCheck = obstacleFeatures.length > 0 && typeof turf?.booleanIntersects === 'function';
  if (hasObstacleCheck) {
    const heightClearance =
      Number.isFinite(opts.heightClearance) ? Math.max(0, opts.heightClearance) : DEFAULT_HEIGHT_CLEARANCE;
    const vehicleHeight = Number(vehicleConfig?.vehicleHeight ?? 0);

    for (let i = 0; i < obstacleFeatures.length; i++) {
      const ob = obstacleFeatures[i];
      const obBbox = index.obstacleBboxes?.[i];
      if (fpBbox && obBbox && !bboxIntersects(fpBbox, obBbox)) continue;

      const heightOnly = index.obstacleHeightOnly?.[i];
      if (heightOnly && vehicleHeight > 0) {
        const obH = index.obstacleHeights?.[i];
        if (Number.isFinite(obH) && vehicleHeight + heightClearance <= obH) continue;
      }

      try {
        if (turf.booleanIntersects(footprint, ob)) {
          return {
            status: 'NG',
            reason: 'obstacle',
            obstacleIndex: i,
            obstacle: includeFootprint ? ob : null,
            footprint: includeFootprint ? footprint : null
          };
        }
      } catch (e) {}
    }
  }

  return { status: 'OK', reason: null, footprint: includeFootprint ? footprint : null };
}

export function batchCollisionCheck(poses = [], vehicleConfig, index, opts = {}) {
  if (!Array.isArray(poses) || poses.length === 0 || !vehicleConfig || !index) return null;
  // eslint-disable-next-line no-param-reassign
  poses = poses.filter(Boolean); // null/undefined ポーズを除去
  ensureOrigin(opts.origin);

  // ④ envelope統一: footprint を1回だけ生成してポーズ全体で共有（per-pose 再計算を回避）。
  const footprintConfig = getVehicleFootprintConfig(vehicleConfig, { defaultVehicleWidth: 2.0 });
  const poseOpts = { ...opts, footprintConfig };

  const maxContactPoints = Number.isFinite(opts.maxContactPoints)
    ? opts.maxContactPoints
    : COLLISION_CONFIG.maxContactMarkers;
  const pointStride = Math.max(1, Math.ceil(poses.length / Math.max(20, maxContactPoints)));
  const contactPoints = [];
  let contactCount = 0;
  let firstContact = null;

  for (let i = 0; i < poses.length; i++) {
    const pose = poses[i];
    if (!pose) continue;
    const res = checkPoseCollision(pose, vehicleConfig, index, poseOpts);
    // ERROR ステータスも NG と区別して無視（入力不正はカウントしない）
    if (!res || res.status === 'ERROR' || res.status !== 'NG') continue;
    contactCount += 1;

    const ll = coordinateSystem.metersToLatLng(pose.x, pose.y);
    if (!firstContact) {
      firstContact = { lat: ll.lat, lng: ll.lng, reason: res.reason };
    }
    if (i % pointStride === 0) {
      contactPoints.push(turf.point([ll.lng, ll.lat], { reason: res.reason }));
    }
  }

  const totalSamples = poses.length;
  const contactRatio = totalSamples ? contactCount / totalSamples : 0;
  return {
    status: contactCount === 0 ? 'OK' : 'NG',
    contactCount,
    totalSamples,
    contactRatio,
    contactPoints: { type: 'FeatureCollection', features: contactPoints },
    firstContact
  };
}
