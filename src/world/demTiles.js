/**
 * demTiles.js — GSI 標高タイル（テキスト形式）による地形サンプラ（Phase 1）
 *
 * dem5a/dem5b(z15, 5m格子, 航空レーザ±0.3m) → dem10b(z14, 10m格子) の順でフォールバック。
 * テキストタイル（CSV, 欠測="e"）なのでPNGデコード不要＝Node/ブラウザ両用・依存ゼロ。
 *
 * 決定論規約: fetchImpl/cache を注入可能にし、コンパイル時に取得した生タイルを
 * ワールドファイルへ焼き込む。シミュレーション時はネットワークに触れない。
 */

const TILE = 256;

export const DEM_PROVIDERS = [
  { layer: 'dem5a', z: 15, cellM: 5 },
  { layer: 'dem5b', z: 15, cellM: 5 },
  { layer: 'dem10b', z: 14, cellM: 10 }
];

export function demTileUrl(layer, z, x, y) {
  return `https://cyberjapandata.gsi.go.jp/xyz/${layer}/${z}/${x}/${y}.txt`;
}

export function lonLatToTilePixel(lon, lat, z) {
  const n = 2 ** z;
  const xF = ((lon + 180) / 360) * n;
  const r = (lat * Math.PI) / 180;
  const yF = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
  const tx = Math.floor(xF);
  const ty = Math.floor(yF);
  return { tx, ty, px: (xF - tx) * TILE, py: (yF - ty) * TILE };
}

// テキストタイル→Float64Array(256*256)。欠測は NaN。
export function parseDemText(text) {
  const grid = new Float64Array(TILE * TILE).fill(NaN);
  const rows = String(text).split('\n');
  for (let r = 0; r < Math.min(TILE, rows.length); r++) {
    const cols = rows[r].split(',');
    for (let c = 0; c < Math.min(TILE, cols.length); c++) {
      const v = cols[c];
      if (v !== 'e' && v !== '') {
        const n = Number(v);
        if (Number.isFinite(n)) grid[r * TILE + c] = n;
      }
    }
  }
  return grid;
}

/**
 * createDemSampler({ fetchText, cache }) — 標高サンプラ
 * - fetchText(url) => Promise<string|null>  … 注入必須（Node/ブラウザ/キャッシュ差し替え）
 * - cache: Map<url, Float64Array|null>      … タイルのメモリキャッシュ（省略時内蔵）
 */
export function createDemSampler({ fetchText, cache = new Map() } = {}) {
  if (typeof fetchText !== 'function') throw new Error('createDemSampler: fetchText required');

  async function tileGrid(layer, z, tx, ty) {
    const url = demTileUrl(layer, z, tx, ty);
    if (cache.has(url)) return cache.get(url);
    let grid = null;
    try {
      const text = await fetchText(url);
      grid = text != null ? parseDemText(text) : null;
    } catch (_e) {
      grid = null;
    }
    cache.set(url, grid);
    return grid;
  }

  // 標高[m]。プロバイダ順にフォールバック。取得不能/欠測は null。
  async function elevation(lon, lat) {
    for (const p of DEM_PROVIDERS) {
      const { tx, ty, px, py } = lonLatToTilePixel(lon, lat, p.z);
      const grid = await tileGrid(p.layer, p.z, tx, ty);
      if (!grid) continue;
      const v = bilinear(grid, px, py);
      if (Number.isFinite(v)) return { elevM: v, source: p.layer };
    }
    return null;
  }

  // ルート([{lat,lng}])沿いの標高プロファイルと勾配。spacingM間隔でサンプル。
  async function profileAlong(route, spacingM = 20) {
    const pts = resample(route, spacingM);
    const out = [];
    let prev = null;
    for (const pt of pts) {
      const e = await elevation(pt.lng, pt.lat);
      const rec = { sM: pt.sM, lat: pt.lat, lng: pt.lng, elevM: e ? e.elevM : null, source: e ? e.source : null, gradePct: null };
      if (prev && rec.elevM != null && prev.elevM != null && rec.sM > prev.sM) {
        rec.gradePct = ((rec.elevM - prev.elevM) / (rec.sM - prev.sM)) * 100;
      }
      out.push(rec);
      prev = rec;
    }
    return out;
  }

  return { elevation, profileAlong, cache };
}

function bilinear(grid, px, py) {
  // タイル内クランプの双一次補間（タイル境界跨ぎは最近傍相当に丸める）
  const x = Math.min(TILE - 1.001, Math.max(0, px - 0.5));
  const y = Math.min(TILE - 1.001, Math.max(0, py - 0.5));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const g = (r, c) => grid[r * TILE + c];
  const v00 = g(y0, x0);
  const v01 = g(y0, x0 + 1);
  const v10 = g(y0 + 1, x0);
  const v11 = g(y0 + 1, x0 + 1);
  const vals = [v00, v01, v10, v11];
  if (vals.every(Number.isFinite)) {
    return v00 * (1 - fx) * (1 - fy) + v01 * fx * (1 - fy) + v10 * (1 - fx) * fy + v11 * fx * fy;
  }
  const finite = vals.filter(Number.isFinite);
  return finite.length ? finite[0] : NaN;
}

function resample(route, spacingM) {
  const pts = (Array.isArray(route) ? route : [])
    .map((p) => ({ lat: Number(p.lat), lng: Number(p.lng) }))
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  if (pts.length < 2) return pts.map((p) => ({ ...p, sM: 0 }));
  const out = [];
  let acc = 0;
  let next = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const dlat = (b.lat - a.lat) * 111320;
    const dlng = (b.lng - a.lng) * 111320 * Math.cos((a.lat * Math.PI) / 180);
    const seg = Math.hypot(dlat, dlng);
    while (next <= acc + seg) {
      const t = seg > 1e-9 ? (next - acc) / seg : 0;
      out.push({ sM: next, lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t });
      next += spacingM;
    }
    acc += seg;
  }
  const last = pts[pts.length - 1];
  if (!out.length || out[out.length - 1].sM < acc - 1e-6) out.push({ sM: acc, lat: last.lat, lng: last.lng });
  return out;
}
