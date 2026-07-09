// P3-1: 高さレイヤ別 2D 衝突判定 (ボクセル化のフォールバック実装)
// 庇・看板・電線など「heightOnly な障害物」を Z 軸方向で正しく判定するためのモジュール。
// WebGPU ベースのフルボクセル化は将来拡張、現状は 2.5D（高さ範囲チェック + 2D 交差）で代替する。

import { turf } from '../utils/geo.js';

/**
 * 障害物の高さ範囲を抽出する。
 * properties.h / height: 天端高さ
 * properties.minHeight / h_min / min_height: 最低高さ (デフォルト 0)
 * @returns {{ low: number, high: number } | null}
 */
export function getObstacleHeightRange(obstacle) {
  const props = obstacle?.properties;
  if (!props || typeof props !== 'object') return null;
  const high = Number(props.h ?? props.height ?? props.H ?? Infinity);
  const lowRaw = props.minHeight ?? props.h_min ?? props.min_height ?? 0;
  const low = Math.max(0, Number(lowRaw) || 0);
  if (!Number.isFinite(high) || high < 0.05) return null;
  return { low, high };
}

/**
 * 障害物が車両の高さ範囲（地面 〜 車両天端 + clearance）と Z 軸で重なるか判定。
 * 庇・電線などで障害物の最低高が車両天端を上回るならパス（潜れる）。
 */
export function isObstacleInVehicleHeightRange(obstacle, vehicleHeight, clearance = 0.25) {
  const range = getObstacleHeightRange(obstacle);
  if (!range) return true; // 高さ不明なら安全側で衝突候補に残す
  const vehTop = Math.max(0, Number(vehicleHeight) || 0) + Math.max(0, Number(clearance) || 0);
  // 障害物の最低高が車両天端より高い → 潜れる
  if (range.low > vehTop + 0.01) return false;
  return true;
}

/**
 * フットプリントと障害物の 2.5D 衝突判定。
 * @param {Feature<Polygon>} footprintPolygon - 車両フットプリント
 * @param {Feature} obstacle - 障害物 (Polygon or Point の Feature)
 * @param {number} vehicleHeight - 車両高さ
 * @param {number} clearance - クリアランス
 * @returns {{ hit: boolean, reason: string, obstacleHeight: number|null }}
 */
export function check25DCollision(footprintPolygon, obstacle, vehicleHeight, clearance = 0.25) {
  if (!footprintPolygon || !obstacle) return { hit: false, reason: 'invalid_input', obstacleHeight: null };
  if (!isObstacleInVehicleHeightRange(obstacle, vehicleHeight, clearance)) {
    return { hit: false, reason: 'above_vehicle', obstacleHeight: getObstacleHeightRange(obstacle)?.high ?? null };
  }
  try {
    if (turf.booleanIntersects(footprintPolygon, obstacle)) {
      const props = obstacle.properties || {};
      const range = getObstacleHeightRange(obstacle);
      const heightOnly = props.heightOnly === true
        || props.heightOnly === 1
        || (typeof props.heightOnly === 'string' && ['1', 'true', 'yes'].includes(props.heightOnly.toLowerCase()));
      return {
        hit: true,
        reason: heightOnly ? 'overhang' : 'building_contact',
        obstacleHeight: range?.high ?? null,
        obstacleHeightLow: range?.low ?? null
      };
    }
  } catch (e) { /* ignore */ }
  return { hit: false, reason: 'no_overlap', obstacleHeight: null };
}

/**
 * バッチ 2.5D 衝突チェック。既存 batchCollisionCheck と同等の戻り値形式を保つ。
 * @param {object} params
 * @param {Array} params.poses - 経路ポーズ列 ({x, y, theta, lat?, lng?})
 * @param {Array<Feature<Polygon>>} params.footprints - ポーズと対応するフットプリント
 * @param {Array<Feature>} params.obstacles - 障害物リスト
 * @param {number} params.vehicleHeight
 * @param {number} [params.clearance=0.25]
 * @param {number} [params.maxContactPoints=240]
 */
export function batchCollisionCheck25D({
  poses,
  footprints,
  obstacles,
  vehicleHeight,
  clearance = 0.25,
  maxContactPoints = 240
}) {
  if (!Array.isArray(poses) || !poses.length || !Array.isArray(footprints) || !footprints.length) {
    return {
      status: 'OK',
      contactCount: 0,
      totalSamples: poses?.length || 0,
      contactRatio: 0,
      violations: [],
      contactPoints: { type: 'FeatureCollection', features: [] }
    };
  }

  const obs = Array.isArray(obstacles) ? obstacles : [];
  const violations = [];
  const features = [];
  const total = poses.length;
  const stride = Math.max(1, Math.ceil(total / Math.max(20, Number(maxContactPoints) || 240)));
  let contactCount = 0;
  let firstContact = null;

  // 障害物の高さ範囲を事前計算してキャッシュ
  const obsRanges = obs.map(getObstacleHeightRange);

  for (let i = 0; i < total; i++) {
    const fp = footprints[Math.min(footprints.length - 1, i)];
    if (!fp) continue;
    for (let j = 0; j < obs.length; j++) {
      const ob = obs[j];
      // Z 軸での早期スキップ
      if (obsRanges[j]) {
        const vehTop = vehicleHeight + clearance;
        if (obsRanges[j].low > vehTop + 0.01) continue;
      }
      try {
        if (!turf.booleanIntersects(fp, ob)) continue;
      } catch (e) { continue; }

      const props = ob.properties || {};
      const heightOnly = props.heightOnly === true
        || props.heightOnly === 1
        || (typeof props.heightOnly === 'string' && ['1', 'true', 'yes'].includes(props.heightOnly.toLowerCase()));
      const reason = heightOnly ? 'overhang' : 'building_contact';
      contactCount += 1;
      const pose = poses[i];
      if (!firstContact && pose) {
        firstContact = { lat: Number(pose.lat) || 0, lng: Number(pose.lng) || 0, reason };
      }
      if (i % stride === 0 && pose) {
        features.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [Number(pose.lng) || 0, Number(pose.lat) || 0] },
          properties: {
            reason,
            obstacleId: ob.id || props.id || null,
            obstacleHeight: obsRanges[j]?.high ?? null
          }
        });
      }
      violations.push({
        type: heightOnly ? 'overhang' : 'building_contact',
        poseIndex: i,
        obstacleId: ob.id || props.id || null,
        obstacleHeight: obsRanges[j]?.high ?? null,
        required: vehicleHeight + clearance
      });
      break; // 同一 pose で複数障害物カウント不要
    }
  }

  return {
    status: contactCount === 0 ? 'OK' : 'NG',
    contactCount,
    totalSamples: total,
    contactRatio: total ? contactCount / total : 0,
    violations,
    contactPoints: { type: 'FeatureCollection', features },
    firstContact
  };
}
