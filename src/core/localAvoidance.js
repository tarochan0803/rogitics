// localAvoidance.js — 局所回避プランナ（決定論・純関数・外部ライブラリ追加なし）
//
// 目的: 正規化済み中心線をなぞるだけの再生軌道に、教科書的な横オフセット回避を足す。
//   (1) 道端の地上障害物（駐車車両など）をコサインベル形の横スワイプで避ける
//   (2) 道路面が広く使える急コーナーで、道路面内に収まる範囲だけ膨らみを許容する
//
// 設計原則:
//   - Math.random / Date.now / window / three への依存禁止（Node で単体検証できる純関数）。
//   - 幾何は呼び出し側から渡された turf（src/utils/geo.js の turf 単一実装）を使う。
//   - オフセットは元経路の法線方向。候補≤9 × サンプル≤40 × ホットスポット≤8 に計算量を収める。
//   - 失敗時・データ不足時は元経路をそのまま返す（フェイルセーフ。呼び出し側で例外も握る）。

import { getVehicleFootprintConfig } from '../3d/clearanceSolids.js';

// ── チューニング定数（単一の真実源） ─────────────────────────────────────
const DETECT_STRIDE_M = 4.0;        // ホットスポット検出のストライド
const CORRIDOR_MARGIN_M = 0.6;      // 車両コリドー半幅 = 車幅/2 + これ
const CORNER_ANGLE_DEG = 40;        // これ以上の折れ角をコーナーホットスポット扱い
const CORNER_WINDOW_M = 10.0;       // 折れ角を測る前後の距離
const MERGE_DIST_M = 8.0;           // 近接ホットスポットの統合距離
const MAX_HOTSPOTS = 8;             // ホットスポット上限（超過は手前から8つ）
const SCORE_STRIDE_M = 2.0;         // 候補評価のフットプリント設置ストライド
const OFFSET_AMPLITUDES_M = [0, 0.6, -0.6, 1.2, -1.2, 1.8, -1.8, 2.4, -2.4]; // |A|昇順・0優先

// スコア重み（道路逸脱を最優先で回避。逸脱ペナルティが他項を圧倒する）
const W_ROAD = 100.0;   // 道路面外の隅×距離
const W_DEV = 1.0;      // |オフセット|の逸脱ペナルティ
const W_CURV = 8.0;     // 曲率増加ペナルティ（rad 合計）

const DEG = Math.PI / 180;

function normalizeAngle(a) {
  let angle = a;
  while (angle > Math.PI) angle -= 2 * Math.PI;
  while (angle < -Math.PI) angle += 2 * Math.PI;
  return angle;
}

// 局所平面直交座標（等距円筒近似）。routeLL[0] を原点に固定して決定論的に射影する。
function makeProjector(lat0, lng0) {
  const cosLat = Math.cos(lat0 * DEG) || 1;
  const mLat = 111320;
  const mLng = 111320 * cosLat;
  return {
    toM(lat, lng) { return { x: (lng - lng0) * mLng, y: (lat - lat0) * mLat }; },
    toLL(x, y) { return { lat: lat0 + y / mLat, lng: lng0 + x / mLng }; }
  };
}

// コサインベル: |x|<half で 0.5(1+cos(πx/half))、外側は 0。頂点で 1、±half で 0。
function cosineBell(x, half) {
  if (!(half > 0)) return 0;
  const ax = Math.abs(x);
  if (ax >= half) return 0;
  return 0.5 * (1 + Math.cos(Math.PI * ax / half));
}

// 経路をローカルメートルへ射影し、累積距離・接線・左法線を前計算する。
function buildRouteFrame(routeLL, projector) {
  const P = routeLL.map((p) => projector.toM(p.lat, p.lng));
  const n = P.length;
  const cum = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    cum[i] = cum[i - 1] + Math.hypot(P[i].x - P[i - 1].x, P[i].y - P[i - 1].y);
  }
  // 接線（中央差分）と左法線
  const tan = new Array(n);
  const nrm = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = P[Math.max(0, i - 1)];
    const b = P[Math.min(n - 1, i + 1)];
    let tx = b.x - a.x;
    let ty = b.y - a.y;
    const len = Math.hypot(tx, ty) || 1;
    tx /= len; ty /= len;
    tan[i] = { x: tx, y: ty };
    nrm[i] = { x: -ty, y: tx }; // 左法線
  }
  return { P, cum, tan, nrm, totalM: cum[n - 1] };
}

// 累積距離 s のローカル座標を線形補間で返す。
function sampleAt(frame, s) {
  const { P, cum } = frame;
  const total = cum[cum.length - 1];
  const sC = Math.max(0, Math.min(total, s));
  let i = 0;
  for (let k = 1; k < cum.length; k++) {
    if (sC <= cum[k]) { i = k - 1; break; }
    i = k - 1;
  }
  const j = Math.min(cum.length - 1, i + 1);
  const segLen = cum[j] - cum[i];
  const t = segLen > 1e-6 ? (sC - cum[i]) / segLen : 0;
  return { x: P[i].x + (P[j].x - P[i].x) * t, y: P[i].y + (P[j].y - P[i].y) * t };
}

// s 地点の弦方位（前後 window の平均進行方向の近似）
function chordBearing(frame, s, window) {
  const a = sampleAt(frame, s - window);
  const b = sampleAt(frame, s + window);
  return Math.atan2(b.y - a.y, b.x - a.x);
}

// フットプリント4隅をローカルメートルで返す（後輪軸(x,y)基準・feasibility と同じ規約）。
function footprintCornersM(x, y, heading, fp) {
  const c = Math.cos(heading);
  const s = Math.sin(heading);
  const front = fp.frontExtentM;   // wheelBase + frontOverhang
  const rear = fp.rearExtentM;     // rearOverhang
  const hw = fp.halfWidthM;
  const local = [
    [front, hw], [front, -hw], [-rear, -hw], [-rear, hw]
  ];
  return local.map(([dx, dy]) => ({ x: x + dx * c - dy * s, y: y + dx * s + dy * c }));
}

function cornersToPolygonLL(cornersM, projector, turf) {
  const ring = cornersM.map((p) => {
    const ll = projector.toLL(p.x, p.y);
    return [ll.lng, ll.lat];
  });
  ring.push(ring[0]);
  return turf.polygon([ring]);
}

function bboxOfLLRing(cornersM, projector) {
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
  for (const p of cornersM) {
    const ll = projector.toLL(p.x, p.y);
    if (ll.lng < minLng) minLng = ll.lng;
    if (ll.lat < minLat) minLat = ll.lat;
    if (ll.lng > maxLng) maxLng = ll.lng;
    if (ll.lat > maxLat) maxLat = ll.lat;
  }
  return [minLng, minLat, maxLng, maxLat];
}

function bboxesOverlap(a, b) {
  if (!a || !b) return true; // bbox 取得失敗時は保守的に交差可能性ありとする
  return !(a[2] < b[0] || b[2] < a[0] || a[3] < b[1] || b[3] < a[1]);
}

function safeBbox(turf, feature) {
  try { return turf.bbox(feature); } catch (_e) { return null; }
}

// ── ホットスポット検出 ────────────────────────────────────────────────
function detectHotspots(frame, obstacles, obstacleBboxes, projector, corridorHalf, turf) {
  const spots = [];
  const total = frame.totalM;
  const canIntersect = typeof turf?.booleanIntersects === 'function';

  for (let s = 0; s <= total; s += DETECT_STRIDE_M) {
    const c = sampleAt(frame, s);
    const heading = chordBearing(frame, s, DETECT_STRIDE_M / 2);
    const cH = Math.cos(heading), sH = Math.sin(heading);

    // (a) 障害物近接: station を中心に進行方向 DETECT_STRIDE、法線方向 ±corridorHalf の矩形セル
    let obstacleHit = false;
    if (canIntersect && obstacles.length) {
      const halfLen = DETECT_STRIDE_M / 2;
      const cellM = [
        { x: c.x + cH * halfLen - sH * corridorHalf, y: c.y + sH * halfLen + cH * corridorHalf },
        { x: c.x + cH * halfLen + sH * corridorHalf, y: c.y + sH * halfLen - cH * corridorHalf },
        { x: c.x - cH * halfLen + sH * corridorHalf, y: c.y - sH * halfLen - cH * corridorHalf },
        { x: c.x - cH * halfLen - sH * corridorHalf, y: c.y - sH * halfLen + cH * corridorHalf }
      ];
      const cellBbox = bboxOfLLRing(cellM, projector);
      let cellPoly = null;
      for (let j = 0; j < obstacles.length; j++) {
        if (!bboxesOverlap(cellBbox, obstacleBboxes[j])) continue;
        if (!cellPoly) cellPoly = cornersToPolygonLL(cellM, projector, turf);
        try {
          if (turf.booleanIntersects(cellPoly, obstacles[j])) { obstacleHit = true; break; }
        } catch (_e) { /* 判定不能はスキップ */ }
      }
    }

    // (b) コーナー: 前後 CORNER_WINDOW の弦方位の差
    let cornerHit = false;
    let turnDeg = 0;
    if (s >= CORNER_WINDOW_M && s <= total - CORNER_WINDOW_M) {
      const before = chordBearing(frame, s - CORNER_WINDOW_M / 2, CORNER_WINDOW_M / 2);
      const after = chordBearing(frame, s + CORNER_WINDOW_M / 2, CORNER_WINDOW_M / 2);
      turnDeg = Math.abs(normalizeAngle(after - before)) / DEG;
      if (turnDeg >= CORNER_ANGLE_DEG) cornerHit = true;
    }

    if (obstacleHit || cornerHit) {
      spots.push({ sM: s, obstacle: obstacleHit, corner: cornerHit, turnDeg });
    }
  }

  // 近接ホットスポットの統合
  const merged = [];
  for (const spot of spots) {
    const last = merged[merged.length - 1];
    if (last && spot.sM - last.sMax <= MERGE_DIST_M) {
      last.sMax = spot.sM;
      last.sM = (last.sMin + last.sMax) / 2;
      last.obstacle = last.obstacle || spot.obstacle;
      last.corner = last.corner || spot.corner;
      last.turnDeg = Math.max(last.turnDeg, spot.turnDeg);
    } else {
      merged.push({ sMin: spot.sM, sMax: spot.sM, sM: spot.sM, obstacle: spot.obstacle, corner: spot.corner, turnDeg: spot.turnDeg });
    }
  }
  return merged.slice(0, MAX_HOTSPOTS);
}

// ── 候補評価 ──────────────────────────────────────────────────────────
// 指定ホットスポットに対し、各オフセット振幅のスコアを計算し最良を返す。
function evaluateHotspot(spot, frame, roadSurface, obstacles, obstacleBboxes, projector, fp, taperL, turf) {
  const canPointInPoly = !!roadSurface && typeof turf?.booleanPointInPolygon === 'function';
  const canIntersect = obstacles.length > 0 && typeof turf?.booleanIntersects === 'function';
  const total = frame.totalM;
  const sApex = spot.sM;
  const winMin = Math.max(0, sApex - taperL);
  const winMax = Math.min(total, sApex + taperL);

  // 評価対象のサンプル station（フットプリント前方拡張分だけ手前に伸ばす）
  const evalMin = Math.max(0, winMin - fp.frontExtentM);
  const evalMax = Math.min(total, winMax + fp.frontExtentM);
  const sampleS = [];
  for (let s = evalMin; s <= evalMax + 1e-6; s += SCORE_STRIDE_M) sampleS.push(s);
  if (sampleS.length > 40) sampleS.length = 40; // 計算量ガード

  let best = { amplitude: 0, score: Infinity };

  for (const amplitude of OFFSET_AMPLITUDES_M) {
    // この振幅での候補経路（ローカル座標）を作る。オフセットは元経路法線方向。
    const offAt = (s) => amplitude * cosineBell(s - sApex, taperL);
    const candAt = (s) => {
      const base = sampleAt(frame, s);
      // 法線は最近傍頂点のもので近似（オフセットは小さく安定）
      const idx = nearestIndex(frame, s);
      const nrm = frame.nrm[idx];
      const o = offAt(s);
      return { x: base.x + nrm.x * o, y: base.y + nrm.y * o };
    };

    let rejected = false;
    let roadPenalty = 0;
    let devPenalty = 0;
    let curvPenalty = 0;
    let prevHeading = null;

    for (const s of sampleS) {
      const pos = candAt(s);
      const ahead = candAt(Math.min(evalMax, s + 0.5));
      const behind = candAt(Math.max(evalMin, s - 0.5));
      const heading = Math.atan2(ahead.y - behind.y, ahead.x - behind.x);
      const cornersM = footprintCornersM(pos.x, pos.y, heading, fp);

      // (i) 障害物交差 → 即棄却
      if (canIntersect) {
        const fpBbox = bboxOfLLRing(cornersM, projector);
        let fpPoly = null;
        for (let j = 0; j < obstacles.length; j++) {
          if (!bboxesOverlap(fpBbox, obstacleBboxes[j])) continue;
          if (!fpPoly) fpPoly = cornersToPolygonLL(cornersM, projector, turf);
          try {
            if (turf.booleanIntersects(fpPoly, obstacles[j])) { rejected = true; break; }
          } catch (_e) { /* skip */ }
        }
        if (rejected) break;
      }

      // (ii) 道路面外にはみ出す隅の数 × 距離（|オフセット|を距離プロキシに使う）
      if (canPointInPoly) {
        let outside = 0;
        for (const cm of cornersM) {
          const ll = projector.toLL(cm.x, cm.y);
          let inside = false;
          try { inside = turf.booleanPointInPolygon(turf.point([ll.lng, ll.lat]), roadSurface); } catch (_e) { inside = true; }
          if (!inside) outside++;
        }
        if (outside > 0) roadPenalty += outside * (0.5 + Math.abs(offAt(s)));
      }

      // (iii) 逸脱ペナルティ（|オフセット|に比例）
      devPenalty += Math.abs(offAt(s));

      // (iv) 曲率増加ペナルティ（サンプル間の折れ角合計）
      if (prevHeading != null) curvPenalty += Math.abs(normalizeAngle(heading - prevHeading));
      prevHeading = heading;
    }

    if (rejected) continue;
    const score = roadPenalty * W_ROAD + devPenalty * W_DEV + curvPenalty * W_CURV;
    // |A|昇順・0優先で走査しているので strict < のみ採用（同点は小さい振幅を保持）
    if (score < best.score) best = { amplitude, score };
  }

  return best;
}

function nearestIndex(frame, s) {
  const { cum } = frame;
  const total = cum[cum.length - 1];
  const sC = Math.max(0, Math.min(total, s));
  let lo = 0, hi = cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] < sC) lo = mid + 1; else hi = mid;
  }
  // lo は sC 以上の最初の頂点。前後の近い方を返す。
  if (lo > 0 && (sC - cum[lo - 1]) < (cum[lo] - sC)) return lo - 1;
  return lo;
}

/**
 * planLocalAvoidance — 局所回避プランナ本体（純関数・決定論）。
 * @param {Object} args
 * @param {Array<{lat:number,lng:number}>} args.routeLL 正規化済み経路（約1.5m間隔）
 * @param {Object|null} args.roadSurface 道路面 GeoJSON（交差点キャップ込み・Polygon/MultiPolygon Feature）
 * @param {Array<Object>} args.obstacles 地上障害物 GeoJSON Feature 配列（Polygon/MultiPolygon）
 * @param {Object} args.vehicleConfig 車両 config
 * @param {Object} args.turf src/utils/geo.js の turf
 * @returns {{routeLL:Array, hotspots:Array, adjustedCount:number}}
 */
export function planLocalAvoidance({ routeLL, roadSurface, obstacles, vehicleConfig, turf } = {}) {
  const fail = { routeLL: routeLL || [], hotspots: [], adjustedCount: 0 };
  if (!Array.isArray(routeLL) || routeLL.length < 3) return fail;
  if (!turf || typeof turf.polygon !== 'function' || typeof turf.point !== 'function') return fail;

  const obs = Array.isArray(obstacles) ? obstacles.filter((f) => f?.geometry) : [];
  const fp = getVehicleFootprintConfig(vehicleConfig || {}, { defaultVehicleWidth: 2.0 });
  const corridorHalf = fp.halfWidthM + CORRIDOR_MARGIN_M;
  // 長い車両が追従できる曲率にする。短いベルは幾何上は障害物を避けても、
  // 実際の自転車モデルが内側を切って接触する。
  const taperL = Math.max(14.0, fp.wheelBase * 4.0);

  const projector = makeProjector(routeLL[0].lat, routeLL[0].lng);
  const frame = buildRouteFrame(routeLL, projector);
  if (!(frame.totalM > 0)) return fail;

  const obstacleBboxes = obs.map((f) => safeBbox(turf, f));
  const hotspots = detectHotspots(frame, obs, obstacleBboxes, projector, corridorHalf, turf);
  if (!hotspots.length) return { routeLL, hotspots: [], adjustedCount: 0 };

  // 各頂点の総オフセット。近接ホットスポットの寄与は加算せず、絶対値が
  // 最大の候補を採用する。独立評価後の加算は未検証の過大オフセットを作る。
  const n = routeLL.length;
  const totalOffset = new Array(n).fill(0);
  let adjustedCount = 0;
  const outHotspots = [];

  for (const spot of hotspots) {
    const best = evaluateHotspot(spot, frame, roadSurface, obs, obstacleBboxes, projector, fp, taperL, turf);
    const amplitude = best.amplitude || 0;
    if (amplitude !== 0) {
      adjustedCount++;
      for (let i = 0; i < n; i++) {
        const contribution = amplitude * cosineBell(frame.cum[i] - spot.sM, taperL);
        if (Math.abs(contribution) > Math.abs(totalOffset[i])) totalOffset[i] = contribution;
      }
    }
    outHotspots.push({
      sM: Number(spot.sM.toFixed(2)),
      obstacle: !!spot.obstacle,
      corner: !!spot.corner,
      turnDeg: Number((spot.turnDeg || 0).toFixed(1)),
      chosenOffsetM: Number(amplitude.toFixed(2))
    });
  }

  if (adjustedCount === 0) return { routeLL, hotspots: outHotspots, adjustedCount: 0 };

  // 元経路法線方向へ総オフセットを適用して再構成
  const adjusted = routeLL.map((p, i) => {
    const o = totalOffset[i];
    if (Math.abs(o) < 1e-6) return { lat: p.lat, lng: p.lng };
    const nrm = frame.nrm[i];
    const base = frame.P[i];
    const ll = projector.toLL(base.x + nrm.x * o, base.y + nrm.y * o);
    return { lat: ll.lat, lng: ll.lng };
  });

  return { routeLL: adjusted, hotspots: outHotspots, adjustedCount };
}
