import { DEFAULTS_HIDDEN, getRouteTrackingTurnRadius, yoloAuthHeaders } from '../config.js';
import { getFeatureHeightInfo, getVehicleFootprintConfig, isReliableOverheadClearanceSource } from '../3d/clearanceSolids.js';
import { coordinateSystem, safeDifference, safeIntersect, safeUnion, turf } from '../utils/geo.js';
import { simulatePathPoses } from './physics.js';
import { buildIntersectionWidening } from './intersectionWidening.js';
import { applyWidthRisk, heightClearance as riskHeightClearance } from './vehicleRiskModel.js';
import { fuseWidthForFeature } from './roadWidthModel.js';

export { estimateWidthFromTags, estimateWidthForFeature, fuseWidthForFeature } from './roadWidthModel.js';

export function buildFootprintPolygonAtPose(ptM, theta, cfg) {
  const { wheelBase, vehicleWidth, frontOverhang, rearOverhang } = cfg;
  const corners = [
    { dx: wheelBase + frontOverhang, dy: vehicleWidth / 2 },
    { dx: wheelBase + frontOverhang, dy: -vehicleWidth / 2 },
    { dx: -rearOverhang, dy: -vehicleWidth / 2 },
    { dx: -rearOverhang, dy: vehicleWidth / 2 }
  ].map((c) => {
    const x = ptM.x + c.dx * Math.cos(theta) - c.dy * Math.sin(theta);
    const y = ptM.y + c.dx * Math.sin(theta) + c.dy * Math.cos(theta);
    const ll = coordinateSystem.metersToLatLng(x, y);
    return [ll.lng, ll.lat];
  });
  corners.push(corners[0]);
  return turf.polygon([corners]);
}

export function unionBatch(polys, group = 16) {
  const arr = polys.filter(Boolean);
  if (!arr.length) return null;
  if (arr.length === 1) return arr[0];
  let cur = arr.slice();
  while (cur.length > 1) {
    const next = [];
    for (let i = 0; i < cur.length; i += group) {
      let acc = cur[i];
      for (let j = i + 1; j < Math.min(i + group, cur.length); j++) {
        try {
          acc = safeUnion(acc, cur[j]);
        } catch (err) {
          // safeUnion が返さず例外になった場合のみここへ来る（通常は safeUnion 内で処理される）
          console.warn('[unionBatch] safeUnion threw:', err.message);
        }
      }
      next.push(acc);
    }
    cur = next;
  }
  return cur[0];
}

export function chaikinSmoothRing(ring, it = 2) {
  if (!ring || ring.length < 4) return ring;
  let pts = ring.slice(0, ring.length - 1);
  for (let k = 0; k < it; k++) {
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const q = pts[(i + 1) % pts.length];
      out.push([0.75 * p[0] + 0.25 * q[0], 0.75 * p[1] + 0.25 * q[1]]);
      out.push([0.25 * p[0] + 0.75 * q[0], 0.25 * p[1] + 0.75 * q[1]]);
    }
    pts = out;
  }
  pts.push(pts[0]);
  return pts;
}

export function smoothPolygon(poly, iterations = 2) {
  if (!poly) return null;
  const g = poly.type === 'Feature' ? poly.geometry : poly;
  if (!g) return null;
  if (g.type === 'Polygon') {
    return turf.polygon(g.coordinates.map((r) => chaikinSmoothRing(r, iterations)));
  }
  if (g.type === 'MultiPolygon') {
    return turf.multiPolygon(g.coordinates.map((pg) => pg.map((r) => chaikinSmoothRing(r, iterations))));
  }
  return null;
}

/**
 * v8.1: Frenet フレーム + 曲率適応サンプリング
 *
 * 自動運転の経路追従理論（Pure Pursuit / Frenet-Serret）に基づく。
 *
 * - リアアクスルを確定経路上に固定（経路から絶対外れない）
 * - 接線方向 θ(s): ±2m 平滑化窓で算出（OSRMノイズ除去）
 * - 符号付き曲率 κ(s) = dθ/ds を有限差分で計算
 * - 曲率適応ストライド: step = min(base, 3° / |κ|)
 *     → R=5m コーナー: 0.26m 間隔、直線: 0.8m 間隔
 *     → 車両サイズに依存しない
 */
function generateVehiclePoses(pathM, strideMeters, vehicleConfig) {
  const baseStride = Math.max(0.2, Number(strideMeters) || 0.8);
  const footprint = getVehicleFootprintConfig(vehicleConfig, { defaultVehicleWidth: 2.0 });
  const wb = footprint.wheelBase;
  const fo = footprint.frontOverhang;
  const halfWidth = footprint.halfWidthM;
  const ro = footprint.rearOverhang;

  // フロントバンパー分だけ末端を切り詰める（リアアクスル基準補正）
  const trimmedPath = trimPathEnd(pathM, wb + fo);
  const pathToUse = trimmedPath.length >= 2 ? trimmedPath : pathM;

  // S1: 近接ウェイポイントを除去（< 0.1m）- 0.3m では交差点前後の微細カーブが消える
  const dedupPath = [pathToUse[0]];
  for (let i = 1; i < pathToUse.length; i++) {
    const prev = dedupPath[dedupPath.length - 1];
    if (Math.hypot(pathToUse[i].x - prev.x, pathToUse[i].y - prev.y) >= 0.1) {
      dedupPath.push(pathToUse[i]);
    }
  }
  const cleanPath = dedupPath.length >= 2 ? dedupPath : pathToUse;

  // ── 弧長パラメータ化 ─────────────────────────────────────────────
  const cum = [0];
  for (let i = 1; i < cleanPath.length; i++) {
    cum[i] = cum[i - 1] + Math.hypot(
      cleanPath[i].x - cleanPath[i - 1].x,
      cleanPath[i].y - cleanPath[i - 1].y
    );
  }
  const totalLen = cum[cum.length - 1];
  if (totalLen < 0.01) return [];

  try {
    const simConfig = { ...(vehicleConfig || {}) };
    delete simConfig._startHeading;
    const physicsPoses = simulatePathPoses(simConfig, cleanPath, baseStride, {
      maxSteps: Math.max(60000, Math.ceil(totalLen / Math.max(0.05, baseStride * 0.2)) * 4)
    });
    if (Array.isArray(physicsPoses) && physicsPoses.length >= 2) {
      return physicsPoses;
    }
  } catch (e) {
    console.warn('[generateVehiclePoses] physics simulation fallback:', e.message);
  }

  function sampleAt(s) {
    const sc = Math.max(0, Math.min(totalLen, s));
    let lo = 0, hi = cum.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= sc) lo = mid; else hi = mid;
    }
    const t = (cum[hi] - cum[lo]) > 1e-6 ? (sc - cum[lo]) / (cum[hi] - cum[lo]) : 0;
    return {
      x: cleanPath[lo].x + (cleanPath[hi].x - cleanPath[lo].x) * t,
      y: cleanPath[lo].y + (cleanPath[hi].y - cleanPath[lo].y) * t,
    };
  }

  // S2: Frenet 接線方向 θ(s): ±1.2m 平滑化窓（2.0m では R<2m の急カーブでθがずれる）
  const THW = 1.2;
  function thetaAt(s) {
    const a = sampleAt(s - THW), b = sampleAt(s + THW);
    return Math.atan2(b.y - a.y, b.x - a.x);
  }

  // ── 符号付き曲率 κ(s) = dθ/ds ───────────────────────────────────
  function kappaAt(s) {
    try {
      const h = 1.0;
      let dt = thetaAt(s + h) - thetaAt(s - h);
      while (dt > Math.PI) dt -= 2 * Math.PI;
      while (dt < -Math.PI) dt += 2 * Math.PI;
      const k = dt / (2 * h);
      return Number.isFinite(k) ? k : 0; // NaN ガード: 無効ジオメトリでも安全に0返却
    } catch (e) {
      return 0;
    }
  }

  // ── 曲率適応サンプリング: 1ステップあたりの方向変化 ≤ 3° ─────────
  const MAX_DTHETA = 3 * Math.PI / 180;

  function makePose(s) {
    const pos = sampleAt(s);
    const theta = thetaAt(s);
    const c = Math.cos(theta), sv = Math.sin(theta);
    const pt = (dx, dy) => ({ x: pos.x + dx * c - dy * sv, y: pos.y + dx * sv + dy * c });
    return {
      ...pos, theta,
      fl: pt(wb + fo, -halfWidth),
      fr: pt(wb + fo, halfWidth),
      rl: pt(-ro, -halfWidth),
      rr: pt(-ro, halfWidth),
    };
  }

  const poses = [];
  let s = 0;
  while (s < totalLen) {
    poses.push(makePose(s));
    const kappa = kappaAt(s);
    const step = Math.abs(kappa) > 1e-6
      ? Math.min(baseStride, MAX_DTHETA / Math.abs(kappa))
      : baseStride;
    s += Math.max(0.1, step);
  }
  poses.push(makePose(totalLen)); // 末端を必ず含める

  return poses;
}

/**
 * 経路末端をtrimMeters分だけ切り詰める。
 * トラックのフロントバンパー（wheelBase + frontOverhang）がゴール地点で止まるように
 * リアアクスル基準の物理シミュレーションを補正するために使用。
 */
function trimPathEnd(pathM, trimMeters) {
  if (!pathM || pathM.length < 2 || trimMeters <= 0) return pathM;
  let total = 0;
  const lens = [0];
  for (let i = 1; i < pathM.length; i++) {
    total += Math.hypot(pathM[i].x - pathM[i - 1].x, pathM[i].y - pathM[i - 1].y);
    lens.push(total);
  }
  const targetLen = total - trimMeters;
  if (targetLen <= 0) return pathM.slice(0, 2);
  const result = [];
  for (let i = 0; i < pathM.length; i++) {
    if (lens[i] <= targetLen) {
      result.push(pathM[i]);
    } else {
      const prevLen = lens[i - 1];
      const t = (targetLen - prevLen) / (lens[i] - prevLen);
      result.push({
        x: pathM[i - 1].x + (pathM[i].x - pathM[i - 1].x) * t,
        y: pathM[i - 1].y + (pathM[i].y - pathM[i - 1].y) * t
      });
      break;
    }
  }
  return result.length >= 2 ? result : pathM.slice(0, 2);
}

/** 経路上を均等ストライドで直接歩いてポーズを生成する */
function walkPathDirectly(pathM, stride) {
  if (!pathM || pathM.length < 2) return [];
  const cum = [0];
  for (let i = 1; i < pathM.length; i++) {
    cum[i] = cum[i - 1] + Math.hypot(pathM[i].x - pathM[i - 1].x, pathM[i].y - pathM[i - 1].y);
  }
  const totalLen = cum[cum.length - 1];
  if (totalLen < 0.01) return [];

  function sampleAt(s) {
    const sc = Math.max(0, Math.min(totalLen, s));
    let lo = 0, hi = cum.length - 1;
    while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= sc) lo = mid; else hi = mid; }
    const t = (cum[hi] - cum[lo]) > 1e-6 ? (sc - cum[lo]) / (cum[hi] - cum[lo]) : 0;
    return { x: pathM[lo].x + (pathM[hi].x - pathM[lo].x) * t, y: pathM[lo].y + (pathM[hi].y - pathM[lo].y) * t };
  }

  // S2: ±1.2m のルックアヘッドでθを計算（2.0m では R<2m 急カーブでθがずれる）
  const THW = 1.2;
  const poses = [];
  for (let s = 0; s <= totalLen; s += stride) {
    const a = sampleAt(s - THW), b = sampleAt(s + THW);
    poses.push({ ...sampleAt(s), theta: Math.atan2(b.y - a.y, b.x - a.x) });
  }
  const tail = sampleAt(totalLen);
  const tailA = sampleAt(totalLen - THW);
  if (poses.length && (totalLen - (poses.length - 1) * stride) > stride * 0.1) {
    poses.push({ ...tail, theta: Math.atan2(tail.y - tailA.y, tail.x - tailA.x) });
  }
  return poses;
}

export function generateSweepPolygon(simRoute, vehicleConfig, { step = DEFAULTS_HIDDEN.sweepStep, smooth = false, precision = 'normal' } = {}) {
  if (!simRoute || simRoute.length < 2) return { sweepGeo: null, outline: null, poses: [] };

  const origin0 = simRoute[0];
  if (!Number.isFinite(origin0?.lat) || !Number.isFinite(origin0?.lng)) {
    console.error('[generateSweepPolygon] 始点座標が不正:', origin0);
    return { sweepGeo: null, outline: null, poses: [] };
  }
  coordinateSystem.setOrigin(origin0.lat, origin0.lng);
  const pathM = simRoute.map((ll) => coordinateSystem.latLngToMeters(ll.lat, ll.lng));
  // P2-1: precision='high' で旋回包絡の幾何精度を上げる（pseudo-Dubins 相当）
  // - サンプリングストライドを 0.5倍にして急カーブの離散誤差を低減
  // - 合成 polygon を Chaikin スムージングで滑らかにし、円弧近似を強める
  const effStep = precision === 'high' ? Math.max(0.15, Number(step) * 0.5) : step;
  const effSmooth = precision === 'high' ? true : !!smooth;
  const poses = generateVehiclePoses(pathM, effStep, vehicleConfig);
  if (!poses.length) return { sweepGeo: null, outline: null, poses: [], footprints: [] };

  const fpCfg = getVehicleFootprintConfig(vehicleConfig, { defaultVehicleWidth: 2.0 });

  const maxFootprints = 2600;
  const poseStride = Math.max(1, Math.ceil(poses.length / maxFootprints));
  const footprints = [];
  const flsPath = [], frsPath = [], rlsPath = [], rrsPath = [], ladderLines = [];

  // pose に physics.js が生成した4隅コーナーデータが含まれているか確認
  const hasPoseCorners = poses.length > 0 && poses[0].fl && poses[0].fr;

  for (let i = 0; i < poses.length; i += poseStride) {
    const p = poses[i];
    const fp = buildFootprintPolygonAtPose({ x: p.x, y: p.y }, p.theta, fpCfg);
    if (fp) {
      footprints.push(fp);
      if (hasPoseCorners) {
        // physics.js の4隅データを直接使用 (sim.html スタイル: 後輪軸基準の正確な角座標)
        const toCoord = (pt) => {
          const ll = coordinateSystem.metersToLatLng(pt.x, pt.y);
          return [ll.lng, ll.lat];
        };
        flsPath.push(toCoord(p.fl));
        frsPath.push(toCoord(p.fr));
        rlsPath.push(toCoord(p.rl));
        rrsPath.push(toCoord(p.rr));
        if (footprints.length % 7 === 1) {
          ladderLines.push([toCoord(p.rl), toCoord(p.rr)]);
        }
      } else {
        const ring = fp.geometry?.coordinates?.[0];
        if (ring && ring.length >= 4) {
          flsPath.push(ring[0]);
          frsPath.push(ring[1]);
          rrsPath.push(ring[2]);
          rlsPath.push(ring[3]);
          if (footprints.length % 7 === 1) {
            ladderLines.push([ring[2], ring[3]]);
          }
        }
      }
    }
  }
  if (((poses.length - 1) % poseStride) !== 0) {
    const tail = poses[poses.length - 1];
    const tailFp = buildFootprintPolygonAtPose({ x: tail.x, y: tail.y }, tail.theta, fpCfg);
    if (tailFp) {
      footprints.push(tailFp);
      if (hasPoseCorners && tail.fl) {
        const toCoord = (pt) => {
          const ll = coordinateSystem.metersToLatLng(pt.x, pt.y);
          return [ll.lng, ll.lat];
        };
        flsPath.push(toCoord(tail.fl));
        frsPath.push(toCoord(tail.fr));
        rlsPath.push(toCoord(tail.rl));
        rrsPath.push(toCoord(tail.rr));
      } else {
        const ring = tailFp.geometry?.coordinates?.[0];
        if (ring && ring.length >= 4) {
          flsPath.push(ring[0]);
          frsPath.push(ring[1]);
          rrsPath.push(ring[2]);
          rlsPath.push(ring[3]);
        }
      }
    }
  }

  const trajectoriesGeo = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: { stroke: '#22d3ee', weight: 1.5 }, geometry: { type: 'LineString', coordinates: flsPath } },
      { type: 'Feature', properties: { stroke: '#22d3ee', weight: 1.5 }, geometry: { type: 'LineString', coordinates: frsPath } },
      { type: 'Feature', properties: { stroke: '#ef4444', weight: 1.5 }, geometry: { type: 'LineString', coordinates: rlsPath } },
      { type: 'Feature', properties: { stroke: '#ef4444', weight: 1.5 }, geometry: { type: 'LineString', coordinates: rrsPath } }
    ]
  };
  ladderLines.forEach(line => {
    trajectoriesGeo.features.push({
      type: 'Feature', properties: { stroke: '#64748b', weight: 1 }, geometry: { type: 'LineString', coordinates: line }
    });
  });

  let sweepGeo = unionBatch(footprints);
  if (!sweepGeo) return { sweepGeo: null, outline: null, poses, footprints, trajectoriesGeo };
  if (effSmooth) {
    // precision='high' のときは Chaikin 2 反復で円弧近似を強める
    const iters = precision === 'high' ? 2 : 1;
    const sm = smoothPolygon(sweepGeo, iters);
    if (sm) sweepGeo = sm;
  }
  let outline = null;
  if (sweepGeo) {
    try {
      outline = turf.polygonToLine(sweepGeo);
    } catch (e) {
      console.warn('[generateSweepPolygon] polygonToLine failed:', e.message);
    }
  }

  return { sweepGeo, outline, poses, footprints, trajectoriesGeo };
}

// Strict mode narrows inferred widths to avoid optimistic判定.
// V9-A2: roadWidthModel の保守的な低側融合に切り替え。
export function estimateEffectiveRoadWidth(feature, { defaultRoadWidth = 5, strictMode = false } = {}) {
  const fused = fuseWidthForFeature(feature);
  const raw = Number.isFinite(fused?.value) ? Number(fused.value) : Number(defaultRoadWidth);
  if (!Number.isFinite(raw) || raw <= 0) {
    return { value: null, rawValue: null, source: 'fallback', sources: [], confidence: 0, scale: 1 };
  }
  // V8.2: 通行リスクモデルへ confidence を伝播。信頼度が低いほど有効幅を下振れ（保守化）。
  //   strict   : 旧挙動 0.85〜0.98 を踏襲
  //   非strict : 高信頼ほぼ等倍 / 低信頼で緩やかに縮小（既存判定を崩さず confidence を効かせる）
  const { value, scale } = applyWidthRisk(raw, fused?.confidence || 0, { strictMode });
  return {
    value,
    rawValue: raw,
    source: fused?.sources?.join('+') || 'default',
    sources: fused?.sources || [],
    confidence: fused?.confidence || 0,
    scale
  };
}

export function buildWidthFusionValidationReport(features = [], { minDisagreementMeters = 1.2 } = {}) {
  const arr = Array.isArray(features) ? features : [];
  const sourceCounts = {};            // 全サンプル合計（後方互換）
  const primarySourceCounts = {};     // 主採用ソース（1道路1票）
  const auxiliarySourceCounts = {};   // 補助ソース（主採用以外のサンプル）
  const confidenceBuckets = { high: 0, medium: 0, low: 0, none: 0 };
  const disagreements = [];
  let fusedCount = 0;
  let yoloCount = 0;
  let osmMeasuredCount = 0;
  let fallbackOnlyCount = 0;
  let confidenceSum = 0;

  for (const feature of arr) {
    const fused = fuseWidthForFeature(feature);
    const samples = Array.isArray(fused.samples) ? fused.samples : [];
    if (Number.isFinite(fused.value)) fusedCount += 1;
    confidenceSum += Number(fused.confidence) || 0;

    const primary = fused.primarySource || null;
    if (primary) primarySourceCounts[primary] = (primarySourceCounts[primary] || 0) + 1;
    for (const sample of samples) {
      sourceCounts[sample.source] = (sourceCounts[sample.source] || 0) + 1;
      if (sample.source !== primary) {
        auxiliarySourceCounts[sample.source] = (auxiliarySourceCounts[sample.source] || 0) + 1;
      }
    }
    if (samples.some((s) => ['width_ai', 'width:ai', 'ai_width', 'roadwidth_ai'].includes(s.source))) yoloCount += 1;
    if (samples.some((s) => ['width', 'width:carriageway', 'ROADWIDTH', 'roadwidth'].includes(s.source))) osmMeasuredCount += 1;
    if (samples.length === 1 && samples[0].source === 'highway_type') fallbackOnlyCount += 1;

    const c = Number(fused.confidence) || 0;
    if (c >= 0.8) confidenceBuckets.high += 1;
    else if (c >= 0.6) confidenceBuckets.medium += 1;
    else if (c > 0) confidenceBuckets.low += 1;
    else confidenceBuckets.none += 1;

    if (samples.length >= 2) {
      const values = samples.map((s) => Number(s.value)).filter(Number.isFinite);
      const min = Math.min(...values);
      const max = Math.max(...values);
      if (Number.isFinite(min) && Number.isFinite(max) && max - min >= minDisagreementMeters) {
        disagreements.push({
          id: feature.id || feature.properties?.id || null,
          fusedWidth: Number(fused.value.toFixed(2)),
          confidence: Number(c.toFixed(2)),
          deltaMeters: Number((max - min).toFixed(2)),
          sources: samples.map((s) => ({
            source: s.source,
            value: Number(s.value.toFixed(2)),
            confidence: Number(s.confidence.toFixed(2))
          }))
        });
      }
    }
  }

  return {
    featureCount: arr.length,
    fusedCount,
    yoloCoverage: arr.length ? Number((yoloCount / arr.length).toFixed(3)) : 0,
    osmMeasuredCoverage: arr.length ? Number((osmMeasuredCount / arr.length).toFixed(3)) : 0,
    fallbackOnlyCount,
    averageConfidence: arr.length ? Number((confidenceSum / arr.length).toFixed(3)) : 0,
    confidenceBuckets,
    sourceCounts,
    primarySourceCounts,
    auxiliarySourceCounts,
    disagreementCount: disagreements.length,
    disagreements: disagreements
      .sort((a, b) => b.deltaMeters - a.deltaMeters)
      .slice(0, 50)
  };
}

function featureIntersectsBox(f, bbox) {
  if (!bbox) return true;
  try {
    const fb = turf.bbox(f);
    return !(fb[0] > bbox[2] || fb[2] < bbox[0] || fb[1] > bbox[3] || fb[3] < bbox[1]);
  } catch (e) {
    return true;
  }
}

export function buildRoadUnion(geoJsonDataSets, defaultW, clearance, clipBox, options = {}) {
  const strictMode = !!options.strictMode;
  const fallbackW = Number(defaultW);
  const defaultRoadWidth = Number.isFinite(fallbackW) ? fallbackW : 6;
  const buffers = [];
  for (const f of geoJsonDataSets || []) {
    // R5: 不正ジオメトリのフィルタリング（無言混入防止）
    const geomType = f?.geometry?.type;
    if (!geomType) continue;
    if (geomType !== 'LineString' && geomType !== 'MultiLineString') continue;
    const coords = f.geometry.coordinates;
    if (!Array.isArray(coords) || !coords.length) continue;
    if (!featureIntersectsBox(f, clipBox)) continue;
    const est = estimateEffectiveRoadWidth(f, { defaultRoadWidth, strictMode });
    const w = est?.value;
    if (!Number.isFinite(w) || w <= 0) continue;
    try {
      // 複数車線道路（lanes>=2）はトラックが両車線を使って旋回するため、
      // バッファをフル幅（w）に拡大して交差点コーナーでの旋回弧をカバーする
      const fTags2 = (f.properties && (f.properties.tags || f.properties)) || {};
      const lanesCount = parseInt(fTags2.lanes || '0', 10);
      const isMultiLane = !isNaN(lanesCount) && lanesCount >= 2;
      const bufRadius = isMultiLane ? w : w / 2;
      const buf = turf.buffer(f, bufRadius, { units: 'meters', steps: 4 });
      if (!buf) continue;
      // 頂点数が多い道路バッファを事前に簡略化してpolygon-clippingのスタックオーバーフローを防ぐ
      let finalBuf = buf;
      try {
        const vCount = (function countV(g) {
          const geom = g?.type === 'Feature' ? g.geometry : g;
          if (!geom) return 0;
          let n = 0;
          if (geom.type === 'Polygon') for (const r of geom.coordinates) n += r.length;
          else if (geom.type === 'MultiPolygon') for (const p of geom.coordinates) for (const r of p) n += r.length;
          return n;
        })(buf);
        if (vCount > 200) {
          finalBuf = turf.simplify(buf, { tolerance: 0.000003, highQuality: false, mutate: false }) || buf;
        }
      } catch (se) { /* keep buf */ }
      buffers.push(finalBuf);
    } catch (err) { }
  }
  // 交差点コーナー補正キャップ（intersectionWidening）を道路面に足し込む。
  // 判定・3D表示・スイープが同じ補正後の道路面を共有するための統合点。
  const caps = Array.isArray(options.intersectionCaps) ? options.intersectionCaps : [];
  for (const cap of caps) {
    if (cap?.geometry) buffers.push(cap);
  }
  if (!buffers.length) return null;
  // v7.2: バッチunionで高速化
  const unioned = unionBatch(buffers);
  let shrunk = unioned;
  if (clearance > 0) {
    try {
      shrunk = turf.buffer(unioned, -clearance, { units: 'meters', steps: 8 });
    } catch (err) { }
  }
  return shrunk;
}

function isPolygonLikeFeature(f) {
  const g = f?.geometry;
  return !!g && (g.type === 'Polygon' || g.type === 'MultiPolygon');
}

function getFeatureHeight(feature, fallback = 3) {
  return getFeatureHeightInfo(feature, fallback);
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

function applyMaskEditsToRoadUnion(roadUnion, maskEdits, buildingsGeoJSON = []) {
  if (!roadUnion) return roadUnion;
  const edits = maskEdits && typeof maskEdits === 'object' ? maskEdits : {};
  const allow = Array.isArray(edits.allow) ? edits.allow.filter(isPolygonLikeFeature) : [];
  const userDeny = Array.isArray(edits.deny)
    ? edits.deny.filter(isPolygonLikeFeature).filter((f) => !isHeightOnlyFeature(f))
    : [];
  const buildings = Array.isArray(buildingsGeoJSON) ? buildingsGeoJSON.filter(isPolygonLikeFeature) : [];
  const deny = [...userDeny, ...buildings];

  let cur = roadUnion;
  for (const f of allow) {
    try {
      cur = safeUnion(cur, f);
    } catch (e) { }
  }
  for (const f of deny) {
    try {
      const next = safeDifference(cur, f);
      cur = next || null;
      if (!cur) break;
    } catch (e) { }
  }
  return cur;
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

export function analyzeContactFeasibility({
  simRoute,
  vehicleConfig,
  geoJsonDataSets,
  defaultRoadWidth,
  clearanceMargin,
  widthMargin,
  maskEdits,
  buildingsGeoJSON = [],
  strictWidthMode = false,
  strideMeters = DEFAULTS_HIDDEN.contactStep,
  maxContactPoints = 300
}) {
  if (!simRoute || simRoute.length < 2) return null;
  if (!vehicleConfig) return null;

  const contactOrigin = simRoute[0];
  if (!Number.isFinite(contactOrigin?.lat) || !Number.isFinite(contactOrigin?.lng)) {
    console.error('[analyzeContactFeasibility] 始点座標が不正:', contactOrigin);
    return null;
  }
  coordinateSystem.setOrigin(contactOrigin.lat, contactOrigin.lng);
  const pathM = simRoute.map((ll) => coordinateSystem.latLngToMeters(ll.lat, ll.lng));
  const stride = Math.max(0.2, Number(strideMeters) || 0.8);
  const poses = generateVehiclePoses(pathM, stride, vehicleConfig);
  if (!poses.length) return null;

  const defaultW = Math.max(2, Number.isFinite(Number(defaultRoadWidth)) ? Number(defaultRoadWidth) : 6);
  const clearance = Math.max(0, clearanceMargin || 0);

  let clipBox = null;
  try {
    const line = turf.lineString(simRoute.map((p) => [p.lng, p.lat]));
    const corridor = turf.buffer(line, Math.max(10, defaultW * 3), { units: 'meters', steps: 4 });
    clipBox = turf.bbox(corridor);
  } catch (e) {
    try {
      clipBox = turf.bbox(turf.lineString(simRoute.map((p) => [p.lng, p.lat])));
    } catch (err) { }
  }

  // 交差点コーナー補正: 旋回ノードで車両が振り出して通る範囲を道路面に足す（判定にも反映）。
  const intersectionCaps = buildIntersectionWidening(simRoute, vehicleConfig).caps;
  // 接触判定は物理的な道幅で行う（clearanceMarginは快適余裕でありスイープカバレッジ用）
  const roadUnionBase = buildRoadUnion(geoJsonDataSets, defaultW, 0, clipBox, { strictMode: !!strictWidthMode, intersectionCaps });
  const roadUnion = applyMaskEditsToRoadUnion(roadUnionBase, maskEdits, buildingsGeoJSON);
  // P1-2: morphological closing で交差点ギャップを吸収（dilate 0.8m → erode 0.3m → 外周は +0.5m 拡張）
  // 旧 0.5m 単純拡大ではポリゴン外形が過剰膨張し、判定が緩くなる弊害があった
  let roadForContact = roadUnion;
  if (roadUnion) {
    try {
      const dilateM = 0.8;
      const erodeM = 0.3;
      const dilated = turf.buffer(roadUnion, dilateM, { units: 'meters', steps: 4 });
      const closed = dilated ? turf.buffer(dilated, -erodeM, { units: 'meters', steps: 8 }) : null;
      roadForContact = closed || dilated || roadUnion;
    } catch (e) { }
  }

  const userDeny = Array.isArray(maskEdits?.deny) ? maskEdits.deny.filter(isPolygonLikeFeature) : [];
  const buildingsDeny = Array.isArray(buildingsGeoJSON) ? buildingsGeoJSON.filter(isPolygonLikeFeature) : [];
  const deny = [...userDeny, ...buildingsDeny];
  const obstacleBboxes = deny.map((f) => {
    try {
      return turf.bbox(f);
    } catch (e) {
      return null;
    }
  });
  const obstacleHeightInfos = deny.map((f) => getFeatureHeight(f, 3));
  const obstacleHeightOnly = deny.map((f) => isHeightOnlyFeature(f));
  const vehicleHeight = Number(vehicleConfig?.vehicleHeight ?? 0);

  // P1-3: heightClearance を建物高ソース別に段階化（タグ実測=0.25 / levels推定=0.5 / DEM等推定=1.0）
  // V8.2: 係数は通行リスクモデル(RISK_TUNING.height)へ集約。
  const heightClearanceFor = riskHeightClearance;

  // P1-1: 面積比5%許容判定 + driverSkill 乗数化
  // driverSkill: 0.5(未熟)〜2.0(熟練)。これを 1.3(緩い)〜0.7(厳しい) にマッピング。
  // outsideTolerance: 熟練 → 大きい(寛容)、未熟 → 小さい(厳しい) ※ 物理的限界 0.05 を中心に振れる
  const rawSkill = Number(vehicleConfig?.driverSkill) || 1.0;
  const skillTolMul = Math.max(0.7, Math.min(1.3, 0.7 + (rawSkill - 0.5) * 0.4));
  // 0.5→0.7, 1.0→0.9, 1.5→1.1, 2.0→1.3
  const OUTSIDE_TOLERANCE_BASE = 0.05;
  const outsideTolerance = OUTSIDE_TOLERANCE_BASE * skillTolMul;

  let contactCount = 0;
  let firstContact = null;
  const points = [];
  const violations = [];
  const pointStride = Math.max(1, Math.ceil(poses.length / Math.max(20, Number(maxContactPoints) || 300)));
  const canPointCheck = !!roadForContact && typeof turf?.booleanPointInPolygon === 'function';
  const canAreaCheck = !!roadForContact && typeof safeIntersect === 'function' && typeof turf?.area === 'function';
  const canIntersect = deny.length > 0 && typeof turf?.booleanIntersects === 'function';

  const fpCfg = getVehicleFootprintConfig(vehicleConfig, { defaultVehicleWidth: 2.0 });

  // 経路の累積距離 (km) を pose ごとに計算（違反位置の atKm 表示用）
  const cumKm = new Array(poses.length).fill(0);
  for (let i = 1; i < poses.length; i++) {
    const dx = poses[i].x - poses[i - 1].x;
    const dy = poses[i].y - poses[i - 1].y;
    cumKm[i] = cumKm[i - 1] + Math.hypot(dx, dy) / 1000;
  }

  // V9-A2/A3: 急カーブ検出 (R < threshold) + driverSkill 連動
  // 熟練ドライバーは閾値を低く (4m)、初心者は高く (7m) して早めに警告
  // R = 1/|κ| でメートル単位の旋回半径を直接得る
  const SHARP_CURVE_R = Math.max(4.0, Math.min(8.0, 6.0 - (rawSkill - 1.0) * 2.0));
  // driverSkill 0.5→7.0m, 1.0→6.0m, 1.5→5.0m, 2.0→4.0m
  const vehicleMinTurnRadius = Number(getRouteTrackingTurnRadius(vehicleConfig)) || Number(vehicleConfig?.templateTurnRadius) || 6.0;
  const sharpCurveSeen = new Set(); // 同一カーブ区間の重複violation 抑制
  function computeCurvatureAt(i) {
    if (i < 1 || i >= poses.length - 1) return 0;
    const a = poses[i - 1];
    const b = poses[i];
    const c = poses[i + 1];
    const t1 = Math.atan2(b.y - a.y, b.x - a.x);
    const t2 = Math.atan2(c.y - b.y, c.x - b.x);
    let dt = t2 - t1;
    while (dt > Math.PI) dt -= 2 * Math.PI;
    while (dt < -Math.PI) dt += 2 * Math.PI;
    const ds = (Math.hypot(b.x - a.x, b.y - a.y) + Math.hypot(c.x - b.x, c.y - b.y)) / 2;
    return ds > 1e-6 ? dt / ds : 0;
  }

  for (let i = 0; i < poses.length; i++) {
    const pose = poses[i];
    const ll = coordinateSystem.metersToLatLng(pose.x, pose.y);

    let isContact = false;
    let reason = 'road';
    let outsideRatio = 0;
    let violationDetail = null;

    // V9-A2/A3: 急カーブ検出 (R < SHARP_CURVE_R) — 接触判定とは独立
    if (i > 0 && i < poses.length - 1 && i % 5 === 0) {
      const kappa = computeCurvatureAt(i);
      const absK = Math.abs(kappa);
      if (absK > 1e-6) {
        const R = 1 / absK;
        if (R < SHARP_CURVE_R) {
          const keyLat = Math.round(ll.lat * 5000) / 5000;
          const keyLng = Math.round(ll.lng * 5000) / 5000;
          const key = `${keyLat},${keyLng}`;
          if (!sharpCurveSeen.has(key)) {
            sharpCurveSeen.add(key);
            // 車両の最小回転半径との比較 — 物理的に通過不可なら deficit > 0
            const physicalDeficit = Math.max(0, vehicleMinTurnRadius - R);
            violations.push({
              type: 'sharp_curve',
              actual: Number(R.toFixed(2)),
              required: Number(SHARP_CURVE_R.toFixed(2)),
              vehicleMinR: Number(vehicleMinTurnRadius.toFixed(2)),
              deficit: Number(physicalDeficit.toFixed(2)),
              atKm: Number(cumKm[i].toFixed(3)),
              latLng: { lat: ll.lat, lng: ll.lng }
            });
          }
        }
      }
    }

    // Pass 1: 4隅 Point-in-Polygon の高速チェック。全隅 inside なら確定 PASS。
    let anyCornerOutside = false;
    if (canPointCheck && pose.fl && pose.fr && pose.rl && pose.rr) {
      const cornersM = [pose.fl, pose.fr, pose.rl, pose.rr];
      for (const c of cornersM) {
        const cLL = coordinateSystem.metersToLatLng(c.x, c.y);
        try {
          if (!turf.booleanPointInPolygon(turf.point([cLL.lng, cLL.lat]), roadForContact)) {
            anyCornerOutside = true;
            break;
          }
        } catch (e) {
          anyCornerOutside = true;
          break;
        }
      }
    } else if (canPointCheck) {
      try {
        anyCornerOutside = !turf.booleanPointInPolygon(turf.point([ll.lng, ll.lat]), roadForContact);
      } catch (e) {
        anyCornerOutside = false;
      }
    } else {
      isContact = !roadForContact; // 道路データなし → 接触扱い
    }

    // Pass 2: 隅が outside でも面積比で精密判定 (5%許容 × driverSkill 乗数)
    if (anyCornerOutside && canAreaCheck) {
      try {
        const footprint = buildFootprintPolygonAtPose({ x: pose.x, y: pose.y }, pose.theta, fpCfg);
        const fpArea = turf.area(footprint);
        if (fpArea > 0) {
          const insideGeom = safeIntersect(footprint, roadForContact);
          const insideArea = insideGeom ? turf.area(insideGeom) : 0;
          outsideRatio = Math.max(0, 1 - insideArea / fpArea);
          if (outsideRatio > outsideTolerance) {
            isContact = true;
            reason = 'road';
            violationDetail = {
              type: 'road_excursion',
              outsideRatio: Number(outsideRatio.toFixed(3)),
              tolerance: Number(outsideTolerance.toFixed(3)),
              deficit: Number((outsideRatio - outsideTolerance).toFixed(3)),
              atKm: Number(cumKm[i].toFixed(3)),
              latLng: { lat: ll.lat, lng: ll.lng }
            };
          }
        } else {
          isContact = true;
        }
      } catch (e) {
        // 面積計算失敗時は隅の判定にフォールバック（保守的: contact 扱い）
        isContact = true;
        reason = 'road';
      }
    } else if (anyCornerOutside) {
      // 面積判定が使えない場合は従来動作（4隅 OR）
      isContact = true;
      reason = 'road';
    }

    // 障害物との交差判定（フットプリント幾何で）
    if (!isContact && canIntersect) {
      const footprint = buildFootprintPolygonAtPose({ x: pose.x, y: pose.y }, pose.theta, fpCfg);
      const ring = footprint?.geometry?.coordinates?.[0] || [];
      const fpBbox = bboxOfRing(ring);
      for (let j = 0; j < deny.length; j++) {
        const obBbox = obstacleBboxes[j];
        if (fpBbox && obBbox && !bboxIntersects(fpBbox, obBbox)) continue;
        const heightInfo = obstacleHeightInfos[j];
        const obH = heightInfo?.value;
        const clearance = heightClearanceFor(heightInfo);
        if (obstacleHeightOnly[j] && vehicleHeight > 0) {
          if (!isReliableOverheadClearanceSource(heightInfo?.source)) continue;
          if (Number.isFinite(obH) && vehicleHeight + clearance <= obH) continue;
        }
        try {
          if (turf.booleanIntersects(footprint, deny[j])) {
            isContact = true;
            reason = 'obstacle';
            violationDetail = {
              type: Number.isFinite(obH) && vehicleHeight + clearance > obH ? 'overhang' : 'building_contact',
              actual: Number.isFinite(obH) ? Number(obH.toFixed?.(2) ?? obH) : null,
              required: Number.isFinite(obH) ? Number((vehicleHeight + clearance).toFixed(2)) : null,
              clearanceSource: heightInfo?.source || 'estimated',
              clearanceUsed: Number(clearance.toFixed(2)),
              atKm: Number(cumKm[i].toFixed(3)),
              latLng: { lat: ll.lat, lng: ll.lng }
            };
            break;
          }
        } catch (e) { }
      }
    }

    if (isContact) {
      contactCount += 1;
      if (!firstContact) firstContact = { lat: ll.lat, lng: ll.lng, reason };
      if (i % pointStride === 0) {
        points.push(turf.point([ll.lng, ll.lat], { reason, outsideRatio: Number(outsideRatio.toFixed(3)) }));
      }
      if (violationDetail) violations.push(violationDetail);
    }
  }

  const totalSamples = poses.length;
  const contactRatio = totalSamples ? contactCount / totalSamples : 0;
  return {
    status: contactCount === 0 ? 'OK' : 'NG',
    contactCount: Math.min(contactCount, totalSamples),
    totalSamples,
    contactRatio: Math.min(1, contactRatio),
    roadUnion,
    contactPoints: { type: 'FeatureCollection', features: points },
    firstContact,
    violations,
    outsideTolerance: Number(outsideTolerance.toFixed(3))
  };
}

export function analyzeFeasibility({
  sweepGeo,
  geoJsonDataSets,
  defaultRoadWidth,
  clearanceMargin,
  coverageThreshold,
  vehicleWidth,
  widthMargin,
  maskEdits,
  buildingsGeoJSON = [],
  strictWidthMode = false
}) {
  if (!sweepGeo) return null;
  const defaultW = Math.max(2, Number.isFinite(Number(defaultRoadWidth)) ? Number(defaultRoadWidth) : 6);
  const th = Math.max(0.5, Math.min(1, coverageThreshold || 0.98));
  const clearance = Math.max(0, clearanceMargin || 0);
  const clipBox = turf.bbox(sweepGeo);

  const roadUnionBase = buildRoadUnion(geoJsonDataSets, defaultW, clearance, clipBox, { strictMode: !!strictWidthMode });
  const roadUnion = applyMaskEditsToRoadUnion(roadUnionBase, maskEdits, buildingsGeoJSON);
  if (!roadUnion) {
    // J2: 道路データなし vs 本当のNG を区別できるよう reason を付与
    return {
      status: 'NG',
      reason: 'no_road_data',
      coverage: 0,
      threshold: th,
      roadUnion: null,
      intersect: null,
      overflow: sweepGeo
    };
  }

  let cover = 0;
  let intersect = null;
  try {
    // J4: safeIntersect を使用して幾何学エラーによる偽NG を防ぐ
    intersect = safeIntersect(roadUnion, sweepGeo);
    const sweepArea = Math.max(1e-6, turf.area(sweepGeo));
    const interArea = intersect ? turf.area(intersect) : 0;
    cover = Math.min(1, Math.max(0, interArea / sweepArea));
  } catch (err) {
    cover = 0;
  }

  let overflow = null;
  try {
    overflow = turf.difference(sweepGeo, roadUnion);
  } catch (err) { }

  const inside = cover >= th;
  return {
    status: inside ? 'OK' : 'NG',
    coverage: cover,
    threshold: th,
    roadUnion,
    intersect,
    overflow
  };
}

// --- 衛星画像セグメンテーションによるはみ出し検証 ---

const SAT_SEG_ROAD_CLASSES = [
  'road', 'pavement', 'asphalt', 'street',
  'crosswalk', 'intersection', 'lane', 'driveway'
];

export async function verifySatelliteOverflow({
  contactPoints,
  googleMapsKey = '',
  apiBase = 'http://127.0.0.1:8001',
  zoom = 20,
  imageSize = 256,
  roadPixelThreshold = 0.55,
  maxSamples = 24
} = {}) {
  let points = [];
  if (contactPoints?.type === 'FeatureCollection' && Array.isArray(contactPoints.features)) {
    points = contactPoints.features
      .map(f => {
        const c = f?.geometry?.coordinates;
        if (!c || c.length < 2) return null;
        return { lat: c[1], lng: c[0], reason: f.properties?.reason || 'road' };
      })
      .filter(Boolean);
  } else if (Array.isArray(contactPoints)) {
    points = contactPoints.filter(p => p && Number.isFinite(p.lat) && Number.isFinite(p.lng));
  }
  if (!points.length) return { verified: 0, dismissed: 0, kept: 0, points: [] };

  // 重複除去: 近接ポイント(5m以内)をまとめる
  const unique = [];
  for (const p of points) {
    const dup = unique.find(u =>
      Math.abs(u.lat - p.lat) * 111320 < 5 &&
      Math.abs(u.lng - p.lng) * 111320 * Math.cos(p.lat * Math.PI / 180) < 5
    );
    if (!dup) unique.push(p);
  }
  const samples = unique.slice(0, maxSamples);

  // 衛星画像のセグメンテーション
  const items = samples.map((p, i) => ({
    id: `ovf_${i}`,
    image_url: `https://maps.googleapis.com/maps/api/staticmap?center=${p.lat},${p.lng}&zoom=${zoom}&size=${imageSize}x${imageSize}&maptype=satellite&key=${googleMapsKey}`,
    lat: p.lat,
    lng: p.lng,
    heading: 0
  }));

  let segResults = [];
  try {
    const resp = await fetch(`${apiBase}/segment-batch`, {
      method: 'POST',
      headers: yoloAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ items, classes: SAT_SEG_ROAD_CLASSES })
    });
    if (!resp.ok) {
      // segment-batch unavailable, try /segment one by one
      for (const item of items) {
        try {
          const r = await fetch(`${apiBase}/segment`, {
            method: 'POST',
            headers: yoloAuthHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ image_url: item.image_url, classes: SAT_SEG_ROAD_CLASSES })
          });
          if (r.ok) {
            const d = await r.json();
            segResults.push({ id: item.id, segments: d.segments || [], image_size: d.image_size });
          }
        } catch (e) { /* skip */ }
      }
    } else {
      const data = await resp.json();
      segResults = Array.isArray(data?.items) ? data.items : [];
    }
  } catch (e) {
    return { verified: 0, dismissed: 0, kept: points.length, points, error: e.message };
  }

  // 各ポイントでセグメンテーション結果を評価
  // 画像中央付近に道路セグメントが占める割合を算出
  const half = imageSize / 2;
  const centerRadius = imageSize * 0.25; // 中央50%の範囲
  let dismissed = 0;
  const keptPoints = [];

  for (let i = 0; i < samples.length; i++) {
    const seg = segResults.find(s => s.id === `ovf_${i}`);
    const segs = Array.isArray(seg?.segments) ? seg.segments : [];
    const imgSz = seg?.image_size || { width: imageSize, height: imageSize };

    // 道路クラスのセグメントが画像中央付近を占める割合を推定
    let roadPixels = 0;
    let totalCenterPixels = 0;
    const roadClassSet = new Set(SAT_SEG_ROAD_CLASSES);

    for (const s of segs) {
      const cls = (s.class_name || s.label || '').toLowerCase();
      if (!roadClassSet.has(cls)) continue;
      // bbox: [x1, y1, x2, y2] or polygon points
      const bbox = s.bbox || s.bounding_box;
      if (bbox && bbox.length >= 4) {
        // Check if segment overlaps with center region
        const cx1 = Math.max(bbox[0], half - centerRadius);
        const cy1 = Math.max(bbox[1], half - centerRadius);
        const cx2 = Math.min(bbox[2], half + centerRadius);
        const cy2 = Math.min(bbox[3], half + centerRadius);
        if (cx2 > cx1 && cy2 > cy1) {
          roadPixels += (cx2 - cx1) * (cy2 - cy1);
        }
      }
      // area field directly
      if (Number.isFinite(s.area)) {
        roadPixels += s.area;
      }
      // mask coverage
      if (Number.isFinite(s.coverage)) {
        roadPixels += s.coverage * (imgSz.width || imageSize) * (imgSz.height || imageSize);
      }
    }
    totalCenterPixels = (centerRadius * 2) * (centerRadius * 2);
    const roadRatio = totalCenterPixels > 0 ? roadPixels / totalCenterPixels : 0;

    if (roadRatio >= roadPixelThreshold) {
      // セグメンテーションで道路面を確認 → はみ出しではない
      dismissed++;
    } else {
      keptPoints.push(samples[i]);
    }
  }

  return {
    verified: samples.length,
    dismissed,
    kept: keptPoints.length,
    points: keptPoints,
    originalCount: points.length
  };
}
