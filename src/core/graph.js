import { DEFAULTS_HIDDEN } from '../config.js';
import { estimateWidthFromTags as estimateRoadWidthFromTags } from './roadWidthModel.js';
import { coordinateSystem, normA, d2r, r2d, turf } from '../utils/geo.js';

// P2-2: A* + binary heap priority queue
// 線形 pickMin (O(V²)) を heap pop (O(log V)) に置換するための最小ヒープ。
class MinHeap {
  constructor() { this.h = []; }
  get size() { return this.h.length; }
  push(item, priority) {
    this.h.push({ item, priority });
    this._siftUp(this.h.length - 1);
  }
  pop() {
    const n = this.h.length;
    if (!n) return null;
    const top = this.h[0];
    const last = this.h.pop();
    if (n > 1) {
      this.h[0] = last;
      this._siftDown(0);
    }
    return top;
  }
  _siftUp(i) {
    const h = this.h;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (h[p].priority <= h[i].priority) break;
      const t = h[p]; h[p] = h[i]; h[i] = t;
      i = p;
    }
  }
  _siftDown(i) {
    const h = this.h;
    const n = h.length;
    while (true) {
      const l = i * 2 + 1, r = l + 1;
      let s = i;
      if (l < n && h[l].priority < h[s].priority) s = l;
      if (r < n && h[r].priority < h[s].priority) s = r;
      if (s === i) break;
      const t = h[s]; h[s] = h[i]; h[i] = t;
      i = s;
    }
  }
}

export function parseMetersFromTag(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  const str = String(v).trim().toLowerCase();
  const feetInch = str.match(/^(\d+)'\s*(\d+)?\"?$/);
  if (feetInch) {
    const ft = parseFloat(feetInch[1]);
    const inch = parseFloat(feetInch[2] || '0');
    return ft * 0.3048 + inch * 0.0254;
  }
  const meters = str.match(/([0-9]+\.?[0-9]*)\s*m/);
  if (meters) return parseFloat(meters[1]);
  const n = parseFloat(str);
  return Number.isNaN(n) ? null : n;
}

export function parseTonsFromTag(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  const str = String(v).trim().toLowerCase();
  const t = str.match(/([0-9]+\.?[0-9]*)\s*t/);
  if (t) return parseFloat(t[1]);
  const n = parseFloat(str);
  return Number.isNaN(n) ? null : n;
}

function parseMaxWidthFromTags(tags = {}) {
  if (!tags) return null;
  const keys = ['maxwidth', 'maxwidth:physical', 'maxwidth:legal', 'maxwidth:signed', 'maxwidth:conditional'];
  for (const k of keys) {
    if (tags[k] != null) {
      const w = parseMetersFromTag(tags[k]);
      if (w) return w;
    }
  }
  return null;
}

// P2-4: 路面品質・通行制約タグからコスト乗数を算出
// 大型車向け: 舗装路 > 砂利 > 未舗装 / 滑らかさ良 > 普通 > 悪 / 林道グレード低 > 高
function surfaceCostMultiplier(tags) {
  let mul = 1.0;
  const surface = String(tags?.surface || '').toLowerCase();
  if (surface) {
    if (['paved', 'asphalt', 'concrete', 'paving_stones', 'concrete:plates'].includes(surface)) {
      mul *= 1.0;
    } else if (['unpaved', 'compacted', 'fine_gravel', 'gravel'].includes(surface)) {
      mul *= 1.25;
    } else if (['dirt', 'ground', 'earth', 'mud', 'sand', 'grass'].includes(surface)) {
      mul *= 1.6;
    }
  }
  const smoothness = String(tags?.smoothness || '').toLowerCase();
  if (smoothness) {
    if (['excellent', 'good'].includes(smoothness)) mul *= 1.0;
    else if (smoothness === 'intermediate') mul *= 1.1;
    else if (['bad', 'very_bad'].includes(smoothness)) mul *= 1.35;
    else if (['horrible', 'very_horrible', 'impassable'].includes(smoothness)) mul *= 1.8;
  }
  const tracktype = String(tags?.tracktype || '').toLowerCase();
  if (tracktype) {
    const m = tracktype.match(/grade\s*(\d)/);
    if (m) {
      const g = parseInt(m[1], 10);
      if (g >= 3) mul *= 1.2;
      if (g >= 4) mul *= 1.4;
      if (g >= 5) mul *= 1.7;
    }
  }
  return mul;
}

// 大型車（HGV）禁止チェック。`no` の場合エッジを排除、`designated` は許可。
function isHgvForbidden(tags) {
  const hgv = String(tags?.hgv || '').toLowerCase();
  if (hgv === 'no' || hgv === 'private' || hgv === 'destination') return hgv === 'no';
  return false;
}

export function buildRoadGraph(geoJsonDataSets = [], opts = {}) {
  const {
    ignoreOneway = false,
    ignoreOnewayOnMultiLane = false, // Keep legal direction unless permission mode explicitly overrides it.
    vehicleHeight = 0,
    vehicleWeight = 0,
    vehicleWidth = 0,
    minRoadWidth = 0,
    narrowPenaltyFactor = 1.2
  } = opts;
  const allowed = new Set([
    'motorway',
    'trunk',
    'primary',
    'secondary',
    'tertiary',
    'unclassified',
    'residential',
    'service',
    'living_street',
    'motorway_link',
    'trunk_link',
    'primary_link',
    'secondary_link',
    'tertiary_link'
  ]);

  const nodes = new Map();
  const segments = [];
  const keyOf = (lng, lat) => `${lat.toFixed(6)},${lng.toFixed(6)}`;
  const ensure = (lng, lat) => {
    const k = keyOf(lng, lat);
    if (!nodes.has(k)) nodes.set(k, { id: k, lat, lng, edges: new Map() });
    return nodes.get(k);
  };
  const addDirEdge = (k1, k2, w, dir) => {
    const n1 = nodes.get(k1);
    const n2 = nodes.get(k2);
    const upd = (a, b) => {
      const cur = a.edges.get(b.id);
      if (cur == null || w < cur) a.edges.set(b.id, w);
    };
    if (dir === +1) upd(n1, n2);
    else if (dir === -1) upd(n2, n1);
    else {
      upd(n1, n2);
      upd(n2, n1);
    }
  };

  for (const f of geoJsonDataSets) {
    const tags = (f.properties && (f.properties.tags || f.properties)) || {};
    const hw = tags.highway;
    if (hw && !allowed.has(hw)) continue;
    const access = tags.access?.toLowerCase();
    if (access === 'no' || access === 'private') continue;
    const truck = tags.truck?.toLowerCase();
    if (truck === 'no') continue;
    const motorcar = tags.motorcar?.toLowerCase();
    if (motorcar === 'no') continue;
    // P2-4: HGV (大型車) 禁止タグを尊重。`hgv=designated` は許可、`hgv=no` のみ除外。
    if (String(tags.hgv || '').toLowerCase() === 'no') continue;
    if (vehicleHeight > 0) {
      const maxH = parseMetersFromTag(tags.maxheight);
      if (maxH !== null && vehicleHeight > maxH) continue;
    }
    if (vehicleWeight > 0) {
      const maxW = parseTonsFromTag(tags.maxweight);
      if (maxW !== null && vehicleWeight > maxW) continue;
    }
    if (vehicleWidth > 0) {
      const maxWidth = parseMaxWidthFromTags(tags);
      if (maxWidth !== null && vehicleWidth > maxWidth) continue;
    }
    let dir = 0;
    if (!ignoreOneway) {
      const ow = (tags.oneway ?? '').toString().toLowerCase();
      if (ow === 'yes' || ow === '1' || ow === 'true') dir = +1;
      else if (ow === '-1' || ow === 'reverse') dir = -1;
      // 複数車線道路ではトラックが両方向に通行可能（Uターンや対向車線使用）
      if (dir !== 0 && ignoreOnewayOnMultiLane) {
        const lc = parseInt(tags.lanes || '0', 10);
        if (!isNaN(lc) && lc >= 2) dir = 0;
      }
    }
    const widthInfo = estimateRoadWidthFromTags(tags);
    const widthEstimate = widthInfo.value;
    const widthRequirement = Math.max(Number(minRoadWidth) || 0, Number(vehicleWidth) || 0);
    let widthPenalty = 1.0;
    if (widthRequirement > 0 && Number.isFinite(widthEstimate)) {
      const shortfall = Math.max(0, widthRequirement - widthEstimate);
      if (shortfall > 0) {
        const ratio = Math.min(1, shortfall / Math.max(0.1, widthRequirement));
        const k = Number.isFinite(narrowPenaltyFactor) ? Math.max(0, narrowPenaltyFactor) : 0;
        widthPenalty += k * ratio;
      }
    }
    // P2-4: 路面品質コスト乗数を統合（舗装/砂利/未舗装、滑らかさ、林道グレード）
    const surfaceMul = surfaceCostMultiplier(tags);
    const totalCostMul = widthPenalty * surfaceMul;
    const addLine = (coords) => {
      for (let i = 0; i < coords.length - 1; i++) {
        const a = coords[i];
        const b = coords[i + 1];
        const k1 = keyOf(a[0], a[1]);
        const k2 = keyOf(b[0], b[1]);
        ensure(a[0], a[1]);
        ensure(b[0], b[1]);
        const dist = turf.distance(turf.point(a), turf.point(b), { units: 'meters' });
        if (dist > 0.05) {
          const cost = dist * totalCostMul;
          addDirEdge(k1, k2, cost, dir);
          segments.push({
            fromKey: k1,
            toKey: k2,
            from: a,
            to: b,
            tags,
            width: widthEstimate,
            widthSource: widthInfo.source,
            widthConfidence: widthInfo.confidence,
            widthFusionPolicy: widthInfo.fusionPolicy,
            widthDisagreement: widthInfo.disagreement,
            widthPenalty,
            surfaceMul
          });
        }
      }
    };
    const g = f.geometry;
    if (!g) continue;
    if (g.type === 'LineString') addLine(g.coordinates);
    else if (g.type === 'MultiLineString') g.coordinates.forEach(addLine);
  }

  return { nodes, segments };
}

export function nearestSnapOnGraph(graph, lat, lng, opts = {}) {
  // P2-3: opts.maxDistance — 投影上限 (m)。超過時は dist=Infinity を返し、呼び出し側で fallback 判定可。
  const maxDistanceM = Number.isFinite(opts?.maxDistance) ? Number(opts.maxDistance) : Infinity;
  const Pm = coordinateSystem.latLngToMeters(lat, lng);
  let best = { dist: Infinity };
  for (const seg of graph.segments) {
    const A = coordinateSystem.latLngToMeters(seg.from[1], seg.from[0]);
    const B = coordinateSystem.latLngToMeters(seg.to[1], seg.to[0]);
    const ABx = B.x - A.x;
    const ABy = B.y - A.y;
    const len2 = ABx * ABx + ABy * ABy;
    if (len2 < 1e-6) continue;
    const t = Math.max(0, Math.min(1, ((Pm.x - A.x) * ABx + (Pm.y - A.y) * ABy) / len2));
    const Sx = A.x + t * ABx;
    const Sy = A.y + t * ABy;
    const dist = Math.hypot(Pm.x - Sx, Pm.y - Sy);
    if (dist < best.dist) {
      const Sll = coordinateSystem.metersToLatLng(Sx, Sy);
      const segLen = Math.sqrt(len2);
      best = { lat: Sll.lat, lng: Sll.lng, fromKey: seg.fromKey, toKey: seg.toKey, dFrom: t * segLen, dTo: (1 - t) * segLen, dist, segLen };
    }
  }
  if (best.dist > maxDistanceM) return { dist: Infinity };
  return best;
}

// P2-3: Top-K 候補スナップを返す。UI で「最寄り道路を選択」カード表示に利用。
// 同一セグメントの重複は除外。距離昇順で最大 K 件。
export function nearestSnapAlternatives(graph, lat, lng, opts = {}) {
  const topK = Math.max(1, Number(opts?.topK) || 3);
  const maxDistanceM = Number.isFinite(opts?.maxDistance) ? Number(opts.maxDistance) : 30;
  const Pm = coordinateSystem.latLngToMeters(lat, lng);
  const candidates = [];
  for (const seg of graph.segments) {
    const A = coordinateSystem.latLngToMeters(seg.from[1], seg.from[0]);
    const B = coordinateSystem.latLngToMeters(seg.to[1], seg.to[0]);
    const ABx = B.x - A.x;
    const ABy = B.y - A.y;
    const len2 = ABx * ABx + ABy * ABy;
    if (len2 < 1e-6) continue;
    const t = Math.max(0, Math.min(1, ((Pm.x - A.x) * ABx + (Pm.y - A.y) * ABy) / len2));
    const Sx = A.x + t * ABx;
    const Sy = A.y + t * ABy;
    const dist = Math.hypot(Pm.x - Sx, Pm.y - Sy);
    if (dist > maxDistanceM) continue;
    const Sll = coordinateSystem.metersToLatLng(Sx, Sy);
    const segLen = Math.sqrt(len2);
    candidates.push({
      lat: Sll.lat, lng: Sll.lng,
      fromKey: seg.fromKey, toKey: seg.toKey,
      dFrom: t * segLen, dTo: (1 - t) * segLen,
      dist, segLen,
      width: seg.width, widthSource: seg.widthSource,
      tags: seg.tags
    });
  }
  candidates.sort((a, b) => a.dist - b.dist);
  return candidates.slice(0, topK);
}

export function shortestPathWithTmpAngle(graph, startSnap, endSnap, opts = {}) {
  const forbidU = !!opts.forbidUTurn;
  const uThresh = d2r(Math.max(90, Math.min(179, opts.uTurnAngle ?? DEFAULTS_HIDDEN.uTurnAngleDeg)));
  const kTurn = Math.max(0, parseFloat(opts.turnCostK ?? 0));
  const adj = new Map();
  const add = (u, v, w) => {
    if (!adj.has(u)) adj.set(u, new Map());
    if (!adj.has(v)) adj.set(v, new Map());
    const m = adj.get(u);
    if (!m.has(v) || w < m.get(v)) m.set(v, w);
  };

  graph.nodes.forEach((n) => {
    if (!adj.has(n.id)) adj.set(n.id, new Map());
    n.edges.forEach((w, vid) => add(n.id, vid, w));
  });

  const SK = '__S';
  const EK = '__E';
  add(SK, startSnap.fromKey, Math.max(0.01, startSnap.dFrom));
  add(SK, startSnap.toKey, Math.max(0.01, startSnap.dTo));
  add(endSnap.fromKey, EK, Math.max(0.01, endSnap.dFrom));
  add(endSnap.toKey, EK, Math.max(0.01, endSnap.dTo));

  // P2-2: A* ヒューリスティック用に終点を meters 座標で固定
  // 0.95 倍に縮める = 弱い inflate で admissibility を残しつつ探索を加速
  const HEURISTIC_FACTOR = 0.95;
  const endLat = Number(endSnap?.lat);
  const endLng = Number(endSnap?.lng);
  const endMeters = (Number.isFinite(endLat) && Number.isFinite(endLng))
    ? coordinateSystem.latLngToMeters(endLat, endLng)
    : null;
  const startLat = Number(startSnap?.lat);
  const startLng = Number(startSnap?.lng);
  const startMeters = (Number.isFinite(startLat) && Number.isFinite(startLng))
    ? coordinateSystem.latLngToMeters(startLat, startLng)
    : null;
  const nodeMetersCache = new Map();
  function nodeMeters(id) {
    if (nodeMetersCache.has(id)) return nodeMetersCache.get(id);
    let v = null;
    if (id === SK) v = startMeters;
    else if (id === EK) v = endMeters;
    else {
      const n = graph.nodes.get(id);
      if (n) v = coordinateSystem.latLngToMeters(n.lat, n.lng);
    }
    nodeMetersCache.set(id, v);
    return v;
  }
  function heuristic(id) {
    if (!endMeters || id === EK) return 0;
    const m = nodeMeters(id);
    if (!m) return 0;
    return Math.hypot(m.x - endMeters.x, m.y - endMeters.y) * HEURISTIC_FACTOR;
  }

  const dist = new Map(); // gScore
  const prev = new Map();
  const closed = new Set();
  dist.set(SK, 0);
  prev.set(SK, null);

  const heap = new MinHeap();
  heap.push(SK, heuristic(SK));

  const angleAt = (aId, bId, cId) => {
    const A = graph.nodes.get(aId);
    const B = graph.nodes.get(bId);
    const C = graph.nodes.get(cId);
    if (!A || !B || !C) return 0;
    const Am = nodeMeters(aId);
    const Bm = nodeMeters(bId);
    const Cm = nodeMeters(cId);
    if (!Am || !Bm || !Cm) return 0;
    const a1 = Math.atan2(Bm.y - Am.y, Bm.x - Am.x);
    const a2 = Math.atan2(Cm.y - Bm.y, Cm.x - Bm.x);
    let d = Math.abs(normA(a2 - a1));
    if (d > Math.PI) d = 2 * Math.PI - d;
    return d;
  };

  while (heap.size) {
    const top = heap.pop();
    if (!top) break;
    const u = top.item;
    if (closed.has(u)) continue;
    if (u === EK) break;
    closed.add(u);
    const m = adj.get(u);
    if (!m) continue;
    const du = dist.get(u);
    for (const [v, w] of m) {
      if (closed.has(v)) continue;
      let extraFactor = 1.0;
      const p = prev.get(u);
      if (p && p !== SK && graph.nodes.has(p) && graph.nodes.has(u) && graph.nodes.has(v)) {
        const d = angleAt(p, u, v);
        if (forbidU && d >= uThresh) continue;
        if (kTurn > 0) extraFactor += kTurn * (d / Math.PI);
      }
      const alt = du + w * extraFactor;
      if (alt < (dist.get(v) ?? Infinity)) {
        dist.set(v, alt);
        prev.set(v, u);
        heap.push(v, alt + heuristic(v));
      }
    }
  }

  if (!dist.has(EK)) return null;
  const path = [];
  let cur = EK;
  while (cur) {
    path.push(cur);
    cur = prev.get(cur);
  }
  path.reverse();
  return path;
}

export function keysToLatLngs(keys, graph, startSnap, endSnap) {
  const out = [];
  out.push({ lat: startSnap.lat, lng: startSnap.lng });
  for (let i = 1; i < keys.length - 1; i++) {
    const k = keys[i];
    const n = graph.nodes.get(k);
    if (n) out.push({ lat: n.lat, lng: n.lng });
  }
  out.push({ lat: endSnap.lat, lng: endSnap.lng });
  return out;
}

export function fullRoadRoute(pointsLL, opts = {}, graphOrFeatures = null) {
  const g =
    graphOrFeatures && graphOrFeatures.nodes
      ? graphOrFeatures
      : buildRoadGraph(graphOrFeatures || [], opts.graphOptions || {});
  if (!g || g.nodes.size === 0) return null;
  const route = [];
  for (let i = 0; i < pointsLL.length - 1; i++) {
    const s = nearestSnapOnGraph(g, pointsLL[i].lat, pointsLL[i].lng);
    const t = nearestSnapOnGraph(g, pointsLL[i + 1].lat, pointsLL[i + 1].lng);
    const segKeys = shortestPathWithTmpAngle(g, s, t, opts);
    if (!segKeys) return null;
    const seg = keysToLatLngs(segKeys, g, s, t);
    if (route.length) seg.shift();
    route.push(...seg);
  }
  return route;
}

export function pruneTinyLoops(routeLL, minSegM = 0.8, maxBackAngleDeg = 165) {
  if (!routeLL || routeLL.length < 3) return routeLL;
  // E1: coordinateSystem を処理対象経路の始点に設定（共有シングルトンの競合防止）
  if (Number.isFinite(routeLL[0]?.lat) && Number.isFinite(routeLL[0]?.lng)) {
    coordinateSystem.setOrigin(routeLL[0].lat, routeLL[0].lng);
  }
  const out = [routeLL[0]];
  const cosLim = Math.cos(d2r(maxBackAngleDeg));
  for (let i = 1; i < routeLL.length - 1; i++) {
    const A = out[out.length - 1];
    const B = routeLL[i];
    const C = routeLL[i + 1];
    const Am = coordinateSystem.latLngToMeters(A.lat, A.lng);
    const Bm = coordinateSystem.latLngToMeters(B.lat, B.lng);
    const Cm = coordinateSystem.latLngToMeters(C.lat, C.lng);
    const v1 = { x: Bm.x - Am.x, y: Bm.y - Am.y };
    const v2 = { x: Cm.x - Bm.x, y: Cm.y - Bm.y };
    const L1 = Math.hypot(v1.x, v1.y);
    const L2 = Math.hypot(v2.x, v2.y);
    if (L1 < minSegM) continue;
    const cosAng = L1 > 1e-6 && L2 > 1e-6 ? (v1.x * v2.x + v1.y * v2.y) / (L1 * L2) : 1;
    if (cosAng < cosLim) continue;
    out.push(B);
  }
  out.push(routeLL[routeLL.length - 1]);
  return out;
}

export function applyTurnTemplates(routeLL, Rmin) {
  if (!routeLL || routeLL.length < 3 || !isFinite(Rmin) || Rmin <= 0) return routeLL;
  // Keep a small endpoint guard to avoid start/end hooks without disabling short urban turns.
  const skipMarginM = Math.max(3.5, Math.min(10, Rmin * 0.9));
  const cum = [0];
  for (let i = 1; i < routeLL.length; i++) {
    cum[i] = cum[i - 1] + turf.distance([routeLL[i - 1].lng, routeLL[i - 1].lat], [routeLL[i].lng, routeLL[i].lat], { units: 'meters' });
  }
  const out = [routeLL[0]];
  for (let i = 1; i < routeLL.length - 1; i++) {
    if (cum[i] < skipMarginM || cum[cum.length - 1] - cum[i] < skipMarginM) {
      out.push(routeLL[i]);
      continue;
    }
    const A = routeLL[i - 1];
    const B = routeLL[i];
    const C = routeLL[i + 1];
    const Am = coordinateSystem.latLngToMeters(A.lat, A.lng);
    const Bm = coordinateSystem.latLngToMeters(B.lat, B.lng);
    const Cm = coordinateSystem.latLngToMeters(C.lat, C.lng);
    let v1 = { x: Bm.x - Am.x, y: Bm.y - Am.y };
    let v2 = { x: Cm.x - Bm.x, y: Cm.y - Bm.y };
    const L1 = Math.hypot(v1.x, v1.y);
    const L2 = Math.hypot(v2.x, v2.y);
    if (L1 < 1e-6 || L2 < 1e-6) {
      out.push(B);
      continue;
    }
    v1 = { x: v1.x / L1, y: v1.y / L1 };
    v2 = { x: v2.x / L2, y: v2.y / L2 };
    const e1 = { x: -v1.x, y: -v1.y };
    const e2 = v2;
    let cosPhi = e1.x * e2.x + e1.y * e2.y;
    cosPhi = Math.max(-1, Math.min(1, cosPhi));
    const phi = Math.acos(cosPhi);
    if (phi < d2r(5) || Math.abs(Math.PI - phi) < d2r(5)) {
      out.push(B);
      continue;
    }
    let d = Rmin * Math.tan(phi / 2);
    d = Math.max(0.2, Math.min(d, Math.min(L1, L2) * 0.45));
    if (!isFinite(d) || d <= 0.2) {
      out.push(B);
      continue;
    }
    const Pin = { x: Bm.x + e1.x * d, y: Bm.y + e1.y * d };
    const Pout = { x: Bm.x + e2.x * d, y: Bm.y + e2.y * d };
    let bis = { x: e1.x + e2.x, y: e1.y + e2.y };
    const bl = Math.hypot(bis.x, bis.y);
    if (bl < 1e-9) {
      out.push(B);
      continue;
    }
    bis = { x: bis.x / bl, y: bis.y / bl };
    // d がキャップされた場合、実効半径で再計算して Pin/Pout でのアーク接線を正確に保つ
    const effectiveRmin = d / Math.tan(phi / 2);
    const h = effectiveRmin / Math.sin(phi / 2);
    const Ctr = { x: Bm.x + bis.x * h, y: Bm.y + bis.y * h };
    let a1 = Math.atan2(Pin.y - Ctr.y, Pin.x - Ctr.x);
    let a2 = Math.atan2(Pout.y - Ctr.y, Pout.x - Ctr.x);
    let dAng = normA(a2 - a1);
    if (Math.abs(dAng) > Math.PI) dAng += dAng > 0 ? -2 * Math.PI : 2 * Math.PI;
    const arcLen = Math.abs(dAng) * effectiveRmin;
    const steps = Math.max(6, Math.min(48, Math.round(arcLen / 1.0)));
    const PinLL = coordinateSystem.metersToLatLng(Pin.x, Pin.y);
    out.push({ lat: PinLL.lat, lng: PinLL.lng });
    for (let k = 1; k < steps; k++) {
      const t = a1 + dAng * (k / steps);
      const px = Ctr.x + effectiveRmin * Math.cos(t);
      const py = Ctr.y + effectiveRmin * Math.sin(t);
      const ll = coordinateSystem.metersToLatLng(px, py);
      out.push({ lat: ll.lat, lng: ll.lng });
    }
    const PoutLL = coordinateSystem.metersToLatLng(Pout.x, Pout.y);
    out.push({ lat: PoutLL.lat, lng: PoutLL.lng });
  }
  out.push(routeLL[routeLL.length - 1]);
  return out;
}

export function densifyRouteLL(routeLL, stepM) {
  if (!routeLL || routeLL.length < 2) return routeLL;
  try {
    const line = turf.lineString(routeLL.map((p) => [p.lng, p.lat]));
    const totalKm = turf.length(line, { units: 'kilometers' });
    if (totalKm <= 0) return routeLL;
    const stepKm = stepM / 1000;
    const out = [];
    for (let d = 0; d <= totalKm + 1e-9; d += stepKm) {
      const pt = turf.along(line, d, { units: 'kilometers' });
      out.push({ lat: pt.geometry.coordinates[1], lng: pt.geometry.coordinates[0] });
    }
    return out;
  } catch (err) {
    return routeLL;
  }
}

/**
 * 経路の自己交差ループを除去する。
 * OSRMが一方通行回避で生成した「交差点を通り過ぎてUターンして戻る」ループを検出し、
 * 交差点を直接ショートカットすることで除去する。
 * ※ 密化前のスパースな経路（OSRM生点）に対して呼ぶこと（O(n²)だが点数が少ないので高速）。
 */
/**
 * 近接ループ除去: 交差しないが「同じ点の近くを二度通る」U字迂回を検出してショートカット。
 * OSRMが一方通行回避でブロックを一周するケースに有効。
 * スパースな経路（密化前）に対して呼ぶこと。
 */
export function removeProximityLoops(routeLL, maxGapM = 8, minSkip = 12, minDetourRatio = 4.0, maxPasses = 4) {
  // 近接しているだけではカットしない。
  // 「i→j 間の経路長 ÷ i-j 直線距離」が minDetourRatio 倍以上の場合だけループとみなす。
  if (!routeLL || routeLL.length < minSkip + 2) return routeLL;
  let cur = routeLL;
  for (let pass = 0; pass < maxPasses; pass++) {
    let found = false;
    outer: for (let i = 0; i < cur.length - minSkip - 1; i++) {
      const a = cur[i];
      for (let j = i + minSkip; j < Math.min(cur.length, i + 60); j++) {
        const b = cur[j];
        // 緯度経度の差で粗いフィルタ
        if (Math.abs(a.lat - b.lat) * 111320 > maxGapM * 2) continue;
        if (Math.abs(a.lng - b.lng) * 111320 * Math.cos(a.lat * Math.PI / 180) > maxGapM * 2) continue;
        let directD;
        try {
          directD = turf.distance([a.lng, a.lat], [b.lng, b.lat], { units: 'meters' });
        } catch (e) { continue; }
        if (directD > maxGapM) continue;

        // i→j 間の経路長を計算
        let pathLen = 0;
        for (let k = i; k < j; k++) {
          try {
            pathLen += turf.distance([cur[k].lng, cur[k].lat], [cur[k + 1].lng, cur[k + 1].lat], { units: 'meters' });
          } catch (e) {}
        }
        // 経路長が直線距離の minDetourRatio 倍以上のときだけカット
        const ratio = directD > 0.1 ? pathLen / directD : 0;
        if (ratio >= minDetourRatio) {
          cur = [...cur.slice(0, i + 1), ...cur.slice(j)];
          console.info(`[removeProximityLoops] pass ${pass + 1}: i=${i} j=${j} gap=${directD.toFixed(1)}m path=${pathLen.toFixed(0)}m ratio=${ratio.toFixed(1)} → ${j - i - 1}点スキップ`);
          found = true;
          break outer;
        }
      }
    }
    if (!found) break;
  }
  return cur;
}

export function removeSelfIntersectingLoops(routeLL, maxPasses = 4) {
  if (!routeLL || routeLL.length < 4) return routeLL;
  let cur = routeLL;
  for (let pass = 0; pass < maxPasses; pass++) {
    const next = _cutFirstSelfIntersection(cur);
    if (next === cur) break; // no intersection found
    console.info(`[removeSelfIntersectingLoops] pass ${pass + 1}: ${cur.length} → ${next.length} 点（ループ除去）`);
    cur = next;
  }
  return cur;
}

function _cutFirstSelfIntersection(routeLL) {
  const n = routeLL.length;
  // 2つの線分 (ax,ay)-(bx,by) と (cx,cy)-(dx,dy) の交点を返す
  function segCross(ax, ay, bx, by, cx, cy, dx, dy) {
    const dx1 = bx - ax, dy1 = by - ay;
    const dx2 = dx - cx, dy2 = dy - cy;
    const denom = dx1 * dy2 - dy1 * dx2;
    if (Math.abs(denom) < 1e-14) return null;
    const t = ((cx - ax) * dy2 - (cy - ay) * dx2) / denom;
    const u = ((cx - ax) * dy1 - (cy - ay) * dx1) / denom;
    // 端点ギリギリ（0.01〜0.99）のみ交差とみなす（頂点共有を除外）
    if (t > 0.01 && t < 0.99 && u > 0.01 && u < 0.99) {
      return { lat: ay + t * dy1, lng: ax + t * dx1 };
    }
    return null;
  }
  for (let i = 0; i < n - 1; i++) {
    const a = routeLL[i], b = routeLL[i + 1];
    for (let j = i + 2; j < n - 1; j++) {
      const c = routeLL[j], d = routeLL[j + 1];
      const pt = segCross(a.lng, a.lat, b.lng, b.lat, c.lng, c.lat, d.lng, d.lat);
      if (pt) {
        // ループ除去: route[0..i] + 交差点 + route[j+1..]
        return [...routeLL.slice(0, i + 1), pt, ...routeLL.slice(j + 1)];
      }
    }
  }
  return routeLL;
}

// v7.4: Detect and trim hook/loop artifacts at route endpoints.
// Walks from each end inward. If the route doubles back toward the
// start/end (measured by cumulative distance from endpoint decreasing),
// trim the offending tail.
export function removeRouteHooks(routeLL, lookbackM = 40) {
  if (!routeLL || routeLL.length < 4) return routeLL;
  // E1: coordinateSystem を処理対象経路の始点に設定（共有シングルトンの競合防止）
  if (Number.isFinite(routeLL[0]?.lat) && Number.isFinite(routeLL[0]?.lng)) {
    coordinateSystem.setOrigin(routeLL[0].lat, routeLL[0].lng);
  }
  const toM = (a, b) => {
    const Am = coordinateSystem.latLngToMeters(a.lat, a.lng);
    const Bm = coordinateSystem.latLngToMeters(b.lat, b.lng);
    return Math.hypot(Am.x - Bm.x, Am.y - Bm.y);
  };

  let start = 0;
  let end = routeLL.length - 1;

  // Trim hook at route END: walk backward from end, check if distance to
  // endpoint starts increasing (= route overshoots then comes back)
  {
    const ep = routeLL[end];
    let maxDist = 0;
    let maxIdx = end;
    // Search backward from end for the farthest point within lookbackM of travel
    let travel = 0;
    for (let i = end - 1; i >= Math.max(0, end - 200); i--) {
      travel += toM(routeLL[i], routeLL[i + 1]);
      if (travel > lookbackM) break;
      const d = toM(routeLL[i], ep);
      if (d > maxDist) {
        maxDist = d;
        maxIdx = i;
      }
    }
    // If the farthest point is NOT the travel-start (i.e. route overshoots
    // then comes back), trim everything after maxIdx up to end-1
    if (maxIdx < end - 2 && maxDist > 5) {
      // Check: does the route come closer to ep after maxIdx? (= hook pattern)
      const distAfterPeak = toM(routeLL[maxIdx + 1], ep);
      if (distAfterPeak < maxDist * 0.85) {
        // Hook detected: trim the overshoot, keep up to maxIdx then jump to end
        end = maxIdx;
      }
    }
  }

  // Trim hook at route START: walk forward from start
  {
    const sp = routeLL[start];
    let maxDist = 0;
    let maxIdx = start;
    let travel = 0;
    for (let i = start + 1; i <= Math.min(routeLL.length - 1, start + 200); i++) {
      travel += toM(routeLL[i], routeLL[i - 1]);
      if (travel > lookbackM) break;
      const d = toM(routeLL[i], sp);
      if (d > maxDist) {
        maxDist = d;
        maxIdx = i;
      }
    }
    if (maxIdx > start + 2 && maxDist > 5) {
      const distBeforePeak = toM(routeLL[maxIdx - 1], sp);
      if (distBeforePeak < maxDist * 0.85) {
        start = maxIdx;
      }
    }
  }

  if (start === 0 && end === routeLL.length - 1) return routeLL;
  const trimmed = routeLL.slice(start, end + 1);
  // 注意: 元の始点・終点を強制上書きしない。
  // 上書きするとフック除去後の点と元始点の間に大きなジャンプが生じ、
  // densifyRouteLL がそこを直線補間 → generateVehiclePoses で急方向転換を検知 →
  // 曲率適応サンプリングが爆発してくねくね軌跡になる。
  return trimmed;
}

export function smoothPath(routeLL, windowSize = 5) {
  if (!routeLL || routeLL.length < windowSize) return routeLL;
  const smoothed = [];
  const halfWindow = Math.floor(windowSize / 2);
  for (let i = 0; i < halfWindow; i++) smoothed.push(routeLL[i]);
  for (let i = halfWindow; i < routeLL.length - halfWindow; i++) {
    let sumLat = 0;
    let sumLng = 0;
    for (let j = -halfWindow; j <= halfWindow; j++) {
      sumLat += routeLL[i + j].lat;
      sumLng += routeLL[i + j].lng;
    }
    smoothed.push({ lat: sumLat / windowSize, lng: sumLng / windowSize });
  }
  for (let i = routeLL.length - halfWindow; i < routeLL.length; i++) smoothed.push(routeLL[i]);
  smoothed[0] = routeLL[0];
  smoothed[smoothed.length - 1] = routeLL[smoothed.length - 1];
  return smoothed;
}

export function projectToNearestWay(pointLL, geoJsonDataSets = []) {
  if (!geoJsonDataSets || geoJsonDataSets.length === 0) return null;
  const pt = turf.point([pointLL.lng, pointLL.lat]);
  let best = null;
  for (const feat of geoJsonDataSets) {
    const g = feat.geometry;
    if (!g) continue;
    const processLine = (coords) => {
      const line = turf.lineString(coords);
      const snapped = turf.nearestPointOnLine(line, pt);
      const dm = turf.pointToLineDistance(pt, line, { units: 'meters' });
      if (!best || dm < best.dist) {
        best = { dist: dm, snapped, feature: feat };
      }
    };
    if (g.type === 'LineString') processLine(g.coordinates);
    else if (g.type === 'MultiLineString') g.coordinates.forEach(processLine);
  }
  return best;
}
