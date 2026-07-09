/**
 * roadMetrics.js — 基盤地図「道路縁」から中心線ごとの実測級道路幅を計測（Phase 2）
 *
 * 中心線に沿って垂線をレイキャストし、左右の道路縁（FGD RdEdg 折れ線群）との交点距離を
 * 測って全幅（edge-to-edge）を出す。road_seg（航空写真マスク版）と同じ思想:
 * 1断面で決めず多断面の中央値で誤差を均す。依存ゼロの純関数（Node/ブラウザ両用・決定論）。
 *
 * 注意: 道路縁は歩道込みの「道路全体幅」。車道幅への控除は roadWidthModel の
 * TOTAL_WIDTH_SOURCES 側で行う（ここでは幾何だけ）。
 */

const DEG2RAD = Math.PI / 180;

// 経度緯度→局所メートル（AOI規模なら十分な等距円筒近似）
function toLocal(coords, lat0) {
  const kx = 111320 * Math.cos(lat0 * DEG2RAD);
  return coords.map((c) => ({ x: c[0] * kx, y: c[1] * 111320 }));
}

// レイ p + t*n と線分 a-b の交点 t（0<=u<=1）。なければ null。
function raySegT(p, n, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const det = n.x * (-dy) - n.y * (-dx); // [n, -(b-a)] の行列式
  if (Math.abs(det) < 1e-12) return null;
  const rx = a.x - p.x;
  const ry = a.y - p.y;
  const t = (rx * (-dy) - ry * (-dx)) / det;
  const u = (n.x * ry - n.y * rx) / det;
  return u >= 0 && u <= 1 ? t : null;
}

/**
 * measureWidthFromEdges(centerline, edges, opts) -> { widthM, nSections, coverage } | null
 * - centerline: [[lon,lat],...]
 * - edges: [ [[lon,lat],...], ... ]（道路縁の折れ線群）
 * - 各断面: 左右それぞれ最近傍交点。片側でも欠けた断面は捨てる。
 * - coverage = 有効断面 / 全断面。低いと信頼できない（交差点・データ欠け）。
 */
export function measureWidthFromEdges(centerline, edges, {
  spacingM = 10,
  maxHalfWidthM = 15,
  minSections = 3,
  minCoverage = 0.3
} = {}) {
  if (!Array.isArray(centerline) || centerline.length < 2 || !edges?.length) return null;
  const lat0 = centerline.reduce((s, c) => s + c[1], 0) / centerline.length;
  const line = toLocal(centerline, lat0);
  const edgePts = edges.map((e) => toLocal(e, lat0)).filter((e) => e.length >= 2);
  if (!edgePts.length) return null;

  // 中心線を等間隔サンプル（位置+単位接線）
  const stations = [];
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1];
    const b = line[i];
    const segLen = Math.hypot(b.x - a.x, b.y - a.y);
    if (segLen < 1e-6) continue;
    const tx = (b.x - a.x) / segLen;
    const ty = (b.y - a.y) / segLen;
    const n = Math.max(1, Math.floor(segLen / spacingM));
    for (let k = 0; k < n; k++) {
      const f = (k + 0.5) / n;
      stations.push({ p: { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f }, nx: -ty, ny: tx });
    }
  }
  if (!stations.length) return null;

  const widths = [];
  for (const st of stations) {
    let left = Infinity;
    let right = Infinity;
    const n = { x: st.nx, y: st.ny };
    for (const edge of edgePts) {
      for (let i = 1; i < edge.length; i++) {
        const t = raySegT(st.p, n, edge[i - 1], edge[i]);
        if (t == null) continue;
        if (t > 0.2 && t < left) left = t;
        else if (t < -0.2 && -t < right) right = -t;
      }
    }
    if (left <= maxHalfWidthM && right <= maxHalfWidthM) widths.push(left + right);
  }

  const coverage = widths.length / stations.length;
  if (widths.length < minSections || coverage < minCoverage) return null;
  widths.sort((a, b) => a - b);
  const mid = widths.length >> 1;
  const median = widths.length % 2 ? widths[mid] : (widths[mid - 1] + widths[mid]) / 2;
  return {
    widthM: Math.round(median * 100) / 100,
    nSections: widths.length,
    coverage: Math.round(coverage * 100) / 100
  };
}

// bbox周辺の縁だけに絞る前処理（全縁×全道路の総当たりを避ける）
export function edgesNearLine(centerline, edges, marginM = 25) {
  const lats = centerline.map((c) => c[1]);
  const lons = centerline.map((c) => c[0]);
  const lat0 = lats.reduce((s, v) => s + v, 0) / lats.length;
  const dLat = marginM / 111320;
  const dLon = marginM / (111320 * Math.cos(lat0 * DEG2RAD));
  const s = Math.min(...lats) - dLat;
  const n = Math.max(...lats) + dLat;
  const w = Math.min(...lons) - dLon;
  const e = Math.max(...lons) + dLon;
  return edges.filter((edge) => edge.some((c) => c[0] >= w && c[0] <= e && c[1] >= s && c[1] <= n));
}
