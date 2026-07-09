#!/usr/bin/env node
/**
 * compile_world.js — Phase 1 ワールドコンパイラ CLI
 *
 * AOI(bbox) → GSI rdcl 道路中心線 + DEM標高プロファイル(dem5a→5b→10b) を取得し、
 * バージョン付き world_<hash>.json に焼き込む。全HTTP応答は runtime/world_cache/ に
 * ディスクキャッシュされ、--offline でネット無し再コンパイルができる。
 *
 * 使い方:
 *   node src/batch/compile_world.js --selfcheck                 # ネット不要の検証（CI用）
 *   node src/batch/compile_world.js --bbox 139.765,35.679,139.770,35.684
 *   node src/batch/compile_world.js --bbox ... --offline        # キャッシュのみで再現
 *
 * 検証（完了条件）:
 *   [1] 同一AOI再コンパイルで hash 一致（selfcheck: モックfetchで2回焼き比較）
 *   [2] --offline（fetch遮断）でも同一 hash を再生成できる
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..', '..');
const CACHE_DIR = path.join(ROOT, 'runtime', 'world_cache');
const OUT_DIR = path.join(ROOT, 'runtime', 'worlds');
const RDCL_Z = 16;
// 日本の車道の実在上限勾配相当（急坂の特殊例で~25%）。これ超はDEMノイズ/高架跨ぎとみなす。
const MAX_GRADE_CAP_PCT = 30;
// FGD RdEdg は中心線と別タイル/別ポリラインで少し離れることがある。
// 計測閾値（断面数/coverage）は緩めず、候補縁の探索範囲だけ広げてカバレッジを上げる。
const FGD_EDGE_SEARCH_MARGIN_M = 40;

function parseArgs(argv) {
  const o = { bbox: null, out: OUT_DIR, offline: false, refresh: false, selfcheck: false, demSpacingM: 20 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--bbox') o.bbox = argv[++i].split(',').map(Number);
    else if (a === '--out') o.out = path.resolve(argv[++i]);
    else if (a === '--offline') o.offline = true;
    else if (a === '--refresh') o.refresh = true; // 建物・規制(Overpass)を強制再取得
    else if (a === '--selfcheck') o.selfcheck = true;
    else if (a === '--dem-spacing') o.demSpacingM = Number(argv[++i]) || 20;
  }
  return o;
}

// ── ディスクキャッシュ付き fetch（--offline はキャッシュのみ） ────────────────
// 更新ポリシー: GSIタイル(地形・道路形状)は事実上静的→無期限キャッシュ。
// Overpass(建物・規制)は変わり得る→TTL 7日、--refresh で強制再取得（定期更新の実装）。
const OVERPASS_TTL_S = 7 * 24 * 3600;

function makeCachedFetch({ offline, refresh, fnv1a }) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  return async function fetchText(url) {
    const file = path.join(CACHE_DIR, fnv1a(url) + '.body');
    const isOverpass = url.includes('overpass-api.de');
    if (fs.existsSync(file)) {
      const ageS = (Date.now() - fs.statSync(file).mtimeMs) / 1000;
      const expired = isOverpass && !offline && (refresh || ageS > OVERPASS_TTL_S);
      if (!expired) {
        const body = fs.readFileSync(file, 'utf8');
        return body === '\x00MISS' ? null : body;
      }
    }
    if (offline) throw new Error(`offline: cache miss for ${url}`);
    const res = await fetch(url, {
      headers: { 'User-Agent': 'LOGISTICS_OS-world_compile/0.1' },
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) {
      fs.writeFileSync(file, '\x00MISS', 'utf8'); // 404等も記録し再訪しない
      return null;
    }
    const body = await res.text();
    fs.writeFileSync(file, body, 'utf8');
    return body;
  };
}

// ── rdcl 道路取得（src/api/gsi.js と同じタイル計算・Node用に自己完結） ──────
function tileRange(bbox, z) {
  const [west, south, east, north] = bbox;
  const n = 2 ** z;
  const tx = (lon) => Math.floor(((lon + 180) / 360) * n);
  const ty = (lat) => {
    const r = (lat * Math.PI) / 180;
    return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
  };
  return { x0: tx(west), x1: tx(east), y0: ty(north), y1: ty(south) };
}

// rdcl の幅員ランク（数値1-4/テキスト）→ 幅レンジ。src/api/gsi.js と同じ規約で
// gsiWidth* を付与する（これが無いと道路面の帯が既定幅になり、広い道でも
// Safety Monitor が道路逸脱を誤検知する）。テキストは 13m-19.5m / 19.5m以上 も解析。
function rdclWidthRange(rnkWidth) {
  const text = String(rnkWidth ?? '').trim();
  const rank = Number(rnkWidth);
  if (rank === 1) return { min: 13.0, max: null, estimate: 13.0, confidence: 0.72, label: '13m+' };
  if (rank === 2) return { min: 5.5, max: 13.0, estimate: 5.5, confidence: 0.74, label: '5.5-13m' };
  if (rank === 3) return { min: 3.0, max: 5.5, estimate: 3.0, confidence: 0.74, label: '3-5.5m' };
  if (rank === 4) return { min: null, max: 3.0, estimate: 2.5, confidence: 0.62, label: '<3m' };
  if (/19\.?5\s*m.*(以上|\+)/i.test(text)) return { min: 19.5, max: null, estimate: 19.5, confidence: 0.72, label: '19.5m+' };
  if (/13\s*m.*19\.?5/i.test(text)) return { min: 13.0, max: 19.5, estimate: 13.0, confidence: 0.74, label: '13-19.5m' };
  if (/13\s*m.*(以上|\+)/i.test(text)) return { min: 13.0, max: null, estimate: 13.0, confidence: 0.72, label: '13m+' };
  if (/5\.?5\s*m.*13\s*m/i.test(text)) return { min: 5.5, max: 13.0, estimate: 5.5, confidence: 0.74, label: '5.5-13m' };
  if (/3\s*m.*5\.?5\s*m/i.test(text)) return { min: 3.0, max: 5.5, estimate: 3.0, confidence: 0.74, label: '3-5.5m' };
  if (/3\s*m.*(未満|以下)|(-3m|<\s*3)/i.test(text)) return { min: null, max: 3.0, estimate: 2.5, confidence: 0.62, label: '<3m' };
  return { min: null, max: null, estimate: null, confidence: 0.25, label: 'unknown' };
}

function rdclHighwayClass(widthRange) {
  if (widthRange.min >= 13) return 'primary';
  if (widthRange.min >= 5.5) return 'secondary';
  if (widthRange.min >= 3) return 'tertiary';
  if (widthRange.max === 3.0) return 'residential';
  return 'unclassified';
}

async function fetchRdclRoads(bbox, fetchText) {
  const { x0, x1, y0, y1 } = tileRange(bbox, RDCL_Z);
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > 120) throw new Error('AOIが広すぎます（rdcl 120タイル上限）');
  const features = [];
  const seen = new Set();
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      const body = await fetchText(`https://cyberjapandata.gsi.go.jp/xyz/experimental_rdcl/${RDCL_Z}/${x}/${y}.geojson`);
      if (!body) continue;
      let data = null;
      try { data = JSON.parse(body); } catch { continue; }
      for (const f of data?.features || []) {
        const t = f?.geometry?.type;
        if (t !== 'LineString' && t !== 'MultiLineString') continue;
        const rid = f.properties?.rID != null ? String(f.properties.rID) : JSON.stringify(f.geometry.coordinates).slice(0, 48);
        if (seen.has(rid)) continue;
        seen.add(rid);
        const rnkWidth = f.properties?.rnkWidth;
        const widthRange = rdclWidthRange(rnkWidth);
        f.properties = {
          ...(f.properties || {}),
          id: `gsi-${rid}`,
          source: 'GSI:rdcl',
          highway: rdclHighwayClass(widthRange),
          gsiRnkWidth: rnkWidth ?? null,
          gsiWidthMin: widthRange.min,
          gsiWidthMax: widthRange.max,
          gsiWidthEstimate: widthRange.estimate,
          gsiWidthConfidence: widthRange.confidence,
          gsiWidthLabel: widthRange.label,
          widthSource: 'gsi:rnkWidth',
          widthConfidence: widthRange.confidence
        };
        features.push(f);
      }
    }
  }
  return features;
}

// ── OSM建物取得（Overpass GET・キャッシュ経由で--offline対応） ───────────────
async function fetchOsmBuildings(bbox, fetchText) {
  const [west, south, east, north] = bbox;
  const q = `[out:json][timeout:25];(way["building"](${south},${west},${north},${east}););out geom;`;
  const body = await fetchText('https://overpass-api.de/api/interpreter?data=' + encodeURIComponent(q));
  if (!body) return [];
  let data = null;
  try { data = JSON.parse(body); } catch { return []; }
  const feats = [];
  for (const el of data?.elements || []) {
    if (el.type !== 'way' || !Array.isArray(el.geometry) || el.geometry.length < 3) continue;
    const ring = el.geometry.map((g) => [g.lon, g.lat]);
    const [x0, y0] = ring[0];
    const [x1, y1] = ring[ring.length - 1];
    if (x0 !== x1 || y0 !== y1) ring.push([x0, y0]);
    feats.push({
      type: 'Feature',
      properties: {
        id: `osm-b${el.id}`,
        building: el.tags?.building || 'yes',
        height: el.tags?.height ?? null,
        levels: el.tags?.['building:levels'] ?? null,
        source: 'OSM'
      },
      geometry: { type: 'Polygon', coordinates: [ring] }
    });
  }
  return feats;
}

// ── OSM規制付きway取得（寸法制限・一方通行。生タグのまま焼き込み、正規化はロード時） ──
async function fetchOsmRegulations(bbox, fetchText) {
  const [west, south, east, north] = bbox;
  const bb = `(${south},${west},${north},${east})`;
  const q = `[out:json][timeout:25];(way["maxheight"]${bb};way["maxwidth"]${bb};way["maxweight"]${bb};way["maxlength"]${bb};way["oneway"="yes"]${bb};);out geom;`;
  const body = await fetchText('https://overpass-api.de/api/interpreter?data=' + encodeURIComponent(q));
  if (!body) return [];
  let data = null;
  try { data = JSON.parse(body); } catch { return []; }
  const feats = [];
  for (const el of data?.elements || []) {
    if (el.type !== 'way' || !Array.isArray(el.geometry) || el.geometry.length < 2) continue;
    feats.push({
      type: 'Feature',
      properties: { id: `osm-w${el.id}`, tags: el.tags || {}, source: 'OSM' },
      geometry: { type: 'LineString', coordinates: el.geometry.map((g) => [g.lon, g.lat]) }
    });
  }
  return feats;
}

// ── 基盤地図情報 道路縁（FGD RdEdg, GSI experimental_fgd ベクトルタイル。z18のみ配信） ──
async function fetchFgdRoadEdges(bbox, fetchText) {
  const { x0, x1, y0, y1 } = tileRange(bbox, 18);
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > 300) {
    console.warn('[fgd] AOIが広くz18タイル数が上限超過。道路縁の付与をスキップします。');
    return [];
  }
  const edges = [];
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      const body = await fetchText(`https://cyberjapandata.gsi.go.jp/xyz/experimental_fgd/18/${x}/${y}.geojson`);
      if (!body) continue;
      let data = null;
      try { data = JSON.parse(body); } catch { continue; }
      for (const f of data?.features || []) {
        if (f?.properties?.class !== 'RdEdg') continue;
        const g = f.geometry;
        if (g?.type === 'LineString' && g.coordinates?.length >= 2) edges.push(g.coordinates);
        else if (g?.type === 'MultiLineString') for (const part of g.coordinates || []) {
          if (part?.length >= 2) edges.push(part);
        }
      }
    }
  }
  return edges;
}

// rdcl は z16 タイル丸ごと返るため、AOI bbox と重なる道路だけに絞る
// （feature bbox の重なり判定。境界跨ぎ道路は経路連続性のため残す）。
function clipFeaturesToBbox(features, bbox, marginDeg = 0.0002) {
  const [west, south, east, north] = bbox;
  const w = west - marginDeg;
  const s = south - marginDeg;
  const e = east + marginDeg;
  const n = north + marginDeg;
  return features.filter((f) => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const line of _linesOf(f.geometry)) {
      for (const c of line) {
        if (c[0] < minX) minX = c[0];
        if (c[0] > maxX) maxX = c[0];
        if (c[1] < minY) minY = c[1];
        if (c[1] > maxY) maxY = c[1];
      }
    }
    return maxX >= w && minX <= e && maxY >= s && minY <= n;
  });
}

function _linesOf(geometry) {
  if (geometry?.type === 'LineString') return [geometry.coordinates];
  if (geometry?.type === 'MultiLineString') return geometry.coordinates || [];
  return [];
}

function firstLineOf(geometry) {
  if (geometry?.type === 'LineString') return geometry.coordinates;
  if (geometry?.type === 'MultiLineString') return geometry.coordinates?.[0] || null;
  return null;
}

// FGD実測幅の探索上限: 広幅員道路（丸の内級）は対側の縁まで15mでは届かないため、
// rdcl幅ランク連動で拡大する。上限25m=全幅50mまで（それ以上は並行街路の縁を掴むリスク）。
function fgdMaxHalfWidthFor(props) {
  const est = Number(props?.gsiWidthEstimate);
  if (!Number.isFinite(est) || est <= 0) return 15;
  return Math.min(25, Math.max(15, est * 1.25));
}

// FGD実測幅のサニティガード: rdcl幅員ランクと大きく矛盾する実測は
// 「交差点ギャップや並行道路の縁を掴んだ」疑いとして棄却する。
// 縁->縁は歩道込み全幅なので、車道幅(rdclランク)の1.7倍までを許容。
function fgdWidthSanity(widthM, props) {
  const w = Number(widthM);
  if (!Number.isFinite(w) || w <= 0) return { ok: false, reason: 'no-width' };
  if (w > 45) return { ok: false, reason: 'absurd-wide' };
  // ランク上限なし（19.5m以上等）は null → Number(null)=0 になるため、正の値のみ有効とする
  const pos = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
  const est = pos(props?.gsiWidthEstimate);
  const min = pos(props?.gsiWidthMin);
  const max = pos(props?.gsiWidthMax);
  // 縁->縁は「車道+両側歩道」の全幅。歩道は車道幅に比例しないため乗算でなく
  // 加算許容（+5m≒両側2.5m歩道）で見る。実測: ×1.7だと狭路の正当な全幅を誤棄却した。
  const base = max ?? est;
  const upper = base != null ? base * 1.5 + 5 : 45;
  if (w > upper) return { ok: false, reason: 'over-rank' };
  if (w < 2.0) return { ok: false, reason: 'under-drivable' }; // 車道下限(roadWidthModelと整合)
  if (min != null && w < min * 0.7) return { ok: false, reason: 'under-rank' };
  return { ok: true, reason: null };
}

// 道路ごとに ①FGD道路縁からの実測級全幅 ②DEM勾配 を properties へ付与（決定論）
async function enrichRoads(roads, fgdEdges, demSampler, mods) {
  const { measureWidthFromEdges, edgesNearLine } = mods.roadMetrics;
  let widthCount = 0;
  let gradeCount = 0;
  let widthRejected = 0;
  for (const road of roads) {
    const line = firstLineOf(road.geometry);
    if (!line || line.length < 2) continue;
    if (fgdEdges.length) {
      const near = edgesNearLine(line, fgdEdges, FGD_EDGE_SEARCH_MARGIN_M);
      const maxHalfWidthM = fgdMaxHalfWidthFor(road.properties);
      const m = near.length ? measureWidthFromEdges(line, near, { maxHalfWidthM }) : null;
      if (m) {
        const sanity = fgdWidthSanity(m.widthM, road.properties);
        if (sanity.ok) {
          // 道路縁は歩道込みの全体幅。車道への控除は roadWidthModel(TOTAL_WIDTH_SOURCES)側。
          road.properties.fgdWidthM = m.widthM;
          road.properties.fgdWidthConfidence = Math.round(Math.min(0.88, 0.6 + 0.35 * m.coverage) * 100) / 100;
          road.properties.fgdWidthSections = m.nSections;
          widthCount++;
        } else {
          widthRejected++;
        }
      }
    }
    const route = line.map((c) => ({ lat: c[1], lng: c[0] }));
    const prof = await demSampler.profileAlong(route, 20);
    const grades = prof.map((p) => p.gradePct).filter((g) => g != null).map(Math.abs);
    // 勾配ロバスト化: 短すぎる道路片（勾配サンプル<2）は付与しない。
    // 高架・堀・段差跨ぎでDEM差分が跳ねる（東京駅周辺で66%等）ため、最大値は
    // 実在勾配の上限相当 MAX_GRADE_CAP_PCT でクリップし、中央値も併記する。
    if (grades.length >= 2) {
      const sorted = [...grades].sort((a, b) => a - b);
      const mid = sorted.length >> 1;
      const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
      road.properties.demGradeMaxPct = Math.round(Math.min(MAX_GRADE_CAP_PCT, Math.max(...grades)) * 100) / 100;
      road.properties.demGradeMedianPct = Math.round(Math.min(MAX_GRADE_CAP_PCT, median) * 100) / 100;
      road.properties.demElevStartM = prof[0].elevM;
      road.properties.demElevEndM = prof[prof.length - 1].elevM;
      gradeCount++;
    }
  }
  return { widthCount, gradeCount, widthRejected };
}

// AOI中心を通る対角ルートでDEMプロファイル（AOI地形の代表断面 + 各道路の勾配は今後拡張）
function aoiDiagonalRoute(bbox) {
  const [west, south, east, north] = bbox;
  return [
    { lat: south, lng: west },
    { lat: (south + north) / 2, lng: (west + east) / 2 },
    { lat: north, lng: east }
  ];
}

async function compile(bbox, { fetchText, demSpacingM }, mods) {
  const { createDemSampler } = mods.dem;
  const { bakeWorld, sortFeaturesStable } = mods.worldFile;

  const roads = sortFeaturesStable(clipFeaturesToBbox(await fetchRdclRoads(bbox, fetchText), bbox));
  const buildings = sortFeaturesStable(await fetchOsmBuildings(bbox, fetchText));
  const regulations = sortFeaturesStable(await fetchOsmRegulations(bbox, fetchText));
  const fgdEdges = await fetchFgdRoadEdges(bbox, fetchText);
  const dem = createDemSampler({ fetchText });
  const enrich = await enrichRoads(roads, fgdEdges, dem, mods);
  const demProfile = await dem.profileAlong(aoiDiagonalRoute(bbox), demSpacingM);
  const demOk = demProfile.filter((p) => p.elevM != null).length;

  const aoi = { bbox, rdclZoom: RDCL_Z, demSpacingM };
  const layers = { roads, buildings, regulations, demProfile };
  const { world, hash } = bakeWorld({
    aoi,
    layers,
    meta: { compiledAt: new Date().toISOString(), roadCount: roads.length, buildingCount: buildings.length, regulationCount: regulations.length, fgdEdgeCount: fgdEdges.length, fgdWidthCount: enrich.widthCount, fgdWidthRejected: enrich.widthRejected, gradeCount: enrich.gradeCount, demSamples: demProfile.length, demResolved: demOk }
  });
  return { world, hash, stats: { roads: roads.length, buildings: buildings.length, regulations: regulations.length, fgdEdges: fgdEdges.length, fgdWidths: enrich.widthCount, fgdRejected: enrich.widthRejected, grades: enrich.gradeCount, demSamples: demProfile.length, demResolved: demOk } };
}

// ── selfcheck: モックfetchで決定論を検証（ネット不要・CI用） ─────────────────
async function selfcheck(mods) {
  const { fnv1a } = mods.trace;
  let pass = true;
  const check = (name, cond, detail = '') => {
    console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? '  ' + detail : ''}`);
    pass = pass && cond;
  };

  // 決定論的な合成レスポンス: rdcl=1本の道、DEM=北東へ上る斜面(標高 = 10 + 行/列比例)
  const mockFetch = async (url) => {
    if (url.includes('experimental_rdcl')) {
      return JSON.stringify({
        type: 'FeatureCollection',
        features: [
          { type: 'Feature', properties: { rID: 'r2', rnkWidth: '19.5m以上' }, geometry: { type: 'LineString', coordinates: [[139.767, 35.681], [139.768, 35.682]] } },
          { type: 'Feature', properties: { rID: 'r1', rnkWidth: 2 }, geometry: { type: 'LineString', coordinates: [[139.766, 35.680], [139.767, 35.681]] } },
          { type: 'Feature', properties: { rID: 'r3-far', rnkWidth: 3 }, geometry: { type: 'LineString', coordinates: [[140.5, 36.5], [140.51, 36.51]] } }
        ]
      });
    }
    if (url.includes('overpass-api.de') && url.includes('maxheight')) {
      return JSON.stringify({ elements: [
        { type: 'way', id: 30, tags: { maxheight: '3.3', oneway: 'yes' }, geometry: [
          { lat: 35.6802, lon: 139.7662 }, { lat: 35.6804, lon: 139.7664 }] }
      ] });
    }
    if (url.includes('overpass-api.de')) {
      return JSON.stringify({ elements: [
        { type: 'way', id: 20, tags: { building: 'yes' }, geometry: [
          { lat: 35.6801, lon: 139.7661 }, { lat: 35.6801, lon: 139.7663 }, { lat: 35.6803, lon: 139.7663 }, { lat: 35.6801, lon: 139.7661 }] },
        { type: 'way', id: 10, tags: { building: 'house', 'building:levels': '2' }, geometry: [
          { lat: 35.6805, lon: 139.7665 }, { lat: 35.6805, lon: 139.7667 }, { lat: 35.6807, lon: 139.7667 }, { lat: 35.6805, lon: 139.7665 }] }
      ] });
    }
    if (url.includes('/dem5a/')) {
      // タイル座標から「グローバル連続」な北東上りの斜面を生成（タイル境界で不連続にならない）
      const m = url.match(/dem5a\/(\d+)\/(\d+)\/(\d+)\.txt$/);
      const tx = Number(m[2]);
      const ty = Number(m[3]);
      const rows = [];
      for (let r = 0; r < 256; r++) {
        const gRow = ty * 256 + r;
        rows.push(new Array(256).fill(0).map((_, c) => {
          const gCol = tx * 256 + c;
          return (10 + 0.01 * (gCol - 29000 * 256) - 0.01 * (gRow - 12900 * 256)).toFixed(2);
        }).join(','));
      }
      return rows.join('\n');
    }
    return null;
  };

  const bbox = [139.765, 35.679, 139.770, 35.684];
  const a = await compile(bbox, { fetchText: mockFetch, demSpacingM: 50 }, mods);
  const b = await compile(bbox, { fetchText: mockFetch, demSpacingM: 50 }, mods);
  check('recompile hash identical', a.hash === b.hash, `hash=${a.hash} roads=${a.stats.roads}`);
  check('roads sorted deterministically', a.world.layers.roads[0].properties.id === 'gsi-r1');
  {
    const r1 = a.world.layers.roads.find((r) => r.properties.id === 'gsi-r1'); // rnk=2
    const r2 = a.world.layers.roads.find((r) => r.properties.id === 'gsi-r2'); // "19.5m以上"
    check('rdcl width rank -> gsiWidth* baked',
      r1?.properties.gsiWidthEstimate === 5.5 && r1?.properties.highway === 'secondary'
      && r2?.properties.gsiWidthMin === 19.5 && r2?.properties.gsiWidthEstimate === 19.5,
      `r1=${r1?.properties.gsiWidthLabel} r2=${r2?.properties.gsiWidthLabel}`);
  }
  check('buildings baked + sorted', a.stats.buildings === 2 && a.world.layers.buildings[0].properties.id === 'osm-b10');
  check('regulations baked (maxheight way)', a.stats.regulations === 1
    && a.world.layers.regulations[0].properties.tags.maxheight === '3.3');
  // 道路縁→幅の幾何: 南北100mの中心線と±2mの平行縁 → 全幅4.0m を復元できること
  {
    const lat0 = 35.68;
    const lng0 = 139.767;
    const dLat = 100 / 111320;
    const dLng = 2 / (111320 * Math.cos(lat0 * Math.PI / 180));
    const center = [[lng0, lat0], [lng0, lat0 + dLat]];
    const edgeL = [[lng0 - dLng, lat0 - 0.0001], [lng0 - dLng, lat0 + dLat + 0.0001]];
    const edgeR = [[lng0 + dLng, lat0 - 0.0001], [lng0 + dLng, lat0 + dLat + 0.0001]];
    const m = mods.roadMetrics.measureWidthFromEdges(center, [edgeL, edgeR]);
    check('fgd edge width geometry (4.0m)', m != null && Math.abs(m.widthM - 4.0) < 0.05,
      `got ${m?.widthM}m sections=${m?.nSections} cov=${m?.coverage}`);
    // 広幅員: ±14m縁（全幅28m・丸の内級）は旧上限15mでは測れず、ランク連動上限で測れること
    const dLngW = 14 / (111320 * Math.cos(lat0 * Math.PI / 180));
    const edgeLW = [[lng0 - dLngW, lat0 - 0.0001], [lng0 - dLngW, lat0 + dLat + 0.0001]];
    const edgeRW = [[lng0 + dLngW, lat0 - 0.0001], [lng0 + dLngW, lat0 + dLat + 0.0001]];
    const wideProps = { gsiWidthEstimate: 19.5, gsiWidthMin: 19.5, gsiWidthMax: null };
    const mWide = mods.roadMetrics.measureWidthFromEdges(center, [edgeLW, edgeRW],
      { maxHalfWidthM: fgdMaxHalfWidthFor(wideProps) });
    check('fgd wide boulevard measurable (28m, rank-linked cap)',
      mWide != null && Math.abs(mWide.widthM - 28.0) < 0.1,
      `got ${mWide?.widthM}m cap=${fgdMaxHalfWidthFor(wideProps)}m`);
  }
  // 過大/過小幅ガード: rdclランクと矛盾する実測は棄却
  {
    const narrowProps = { gsiWidthEstimate: 3.0, gsiWidthMin: 3.0, gsiWidthMax: 5.5 };
    const wideProps = { gsiWidthEstimate: 19.5, gsiWidthMin: 19.5, gsiWidthMax: null };
    check('fgd sanity guard (over/under rank rejected, plausible kept)',
      fgdWidthSanity(12, narrowProps).ok === true           // 3-5.5m道+両歩道=全幅12m→正当
      && fgdWidthSanity(15, narrowProps).ok === false       // 3-5.5m道で15m→並行縁の誤掴み
      && fgdWidthSanity(4.6, narrowProps).ok === true       // 妥当
      && fgdWidthSanity(1.5, narrowProps).ok === false      // 車道下限未満→非現実
      && fgdWidthSanity(28, wideProps).ok === true          // 19.5m+で全幅28m→歩道込みで妥当
      && fgdWidthSanity(60, wideProps).ok === false         // 60m→棄却
      && fgdWidthSanity(10, wideProps).ok === false,        // 19.5m+なのに10m→中央分離帯等の誤計測
      `narrow15=${fgdWidthSanity(15, narrowProps).reason} w1.5=${fgdWidthSanity(1.5, narrowProps).reason} wide60=${fgdWidthSanity(60, wideProps).reason}`);
  }
  check('roads clipped to bbox (far road dropped)', a.stats.roads === 2
    && !a.world.layers.roads.some((r) => r.properties.id === 'gsi-r3-far'));
  check('per-road DEM grade attached (robust: median + capped max)', a.stats.grades === 2
    && Number.isFinite(a.world.layers.roads[0].properties.demGradeMaxPct)
    && Number.isFinite(a.world.layers.roads[0].properties.demGradeMedianPct)
    && a.world.layers.roads.every((r) => (r.properties.demGradeMaxPct ?? 0) <= 30));
  const prof = a.world.layers.demProfile;
  const resolved = prof.filter((p) => p.elevM != null);
  check('dem profile resolved', resolved.length === prof.length && resolved.length >= 5, `samples=${prof.length}`);
  const grades = prof.map((p) => p.gradePct).filter((g) => g != null);
  check('uphill grade detected (>0)', grades.length > 0 && grades.every((g) => g > 0),
    `grade≈${grades.length ? grades[0].toFixed(2) : '-'}%`);
  const { parseWorld } = mods.worldFile;
  const round = parseWorld(JSON.stringify(a.world));
  check('parse + hash verify roundtrip', round.hashOk === true);
  // meta（compiledAt）が hash に影響しないこと
  const c = { ...a.world, meta: { compiledAt: 'DIFFERENT' } };
  check('meta excluded from hash', parseWorld(JSON.stringify(c)).hashOk === true);
  console.log(pass ? '\nselfcheck ALL PASS' : '\nselfcheck FAILED');
  return pass ? 0 : 1;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const mods = {
    dem: await import(pathToFileURL(path.join(ROOT, 'src', 'world', 'demTiles.js')).href),
    worldFile: await import(pathToFileURL(path.join(ROOT, 'src', 'world', 'worldFile.js')).href),
    trace: await import(pathToFileURL(path.join(ROOT, 'src', 'sim', 'trace.js')).href),
    roadMetrics: await import(pathToFileURL(path.join(ROOT, 'src', 'world', 'roadMetrics.js')).href)
  };

  if (opts.selfcheck) return selfcheck(mods);

  if (!opts.bbox || opts.bbox.length !== 4 || opts.bbox.some((v) => !Number.isFinite(v))) {
    console.error('usage: node src/batch/compile_world.js --bbox minLon,minLat,maxLon,maxLat [--offline] [--selfcheck]');
    return 2;
  }
  const fetchText = makeCachedFetch({ offline: opts.offline, refresh: opts.refresh, fnv1a: mods.trace.fnv1a });
  const { world, hash, stats } = await compile(opts.bbox, { fetchText, demSpacingM: opts.demSpacingM }, mods);
  fs.mkdirSync(opts.out, { recursive: true });
  const file = path.join(opts.out, `world_${hash}.json`);
  fs.writeFileSync(file, JSON.stringify(world), 'utf8');
  console.log(`world compiled: ${file}`);
  console.log(`hash=${hash} roads=${stats.roads} buildings=${stats.buildings} regulations=${stats.regulations} demSamples=${stats.demSamples} demResolved=${stats.demResolved} offline=${opts.offline}`);
  return 0;
}

main().then((c) => process.exit(c)).catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
