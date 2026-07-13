// PLATEAU 3D Tiles ストリーミング（見た目用の建物）。
// - 国交省 PLATEAU VIEW 配信の 3D Tiles を 3d-tiles-renderer でストリーミング表示。
// - 低品質（setResolutionScale 小）で軽量化。カメラ移動に応じて動的ロード。
// - カバー外 / ライブラリ未読込 / 取得失敗時は null を返し、呼び出し側が OSM 建物へフォールバック。
// - 判定用ジオメトリには使わない（衝突は OSM フットプリントのまま）。
//
// 座標系: index3D は原点(originLL)中心の平面ENU（x=東, y=上, z=-北）。
// PLATEAU タイルは地心直交座標(ECEF)なので、ECEF→ローカルENU 変換行列を pivot に適用して整合させる。

// 大まかな日本域（この外なら PLATEAU 問い合わせ自体を行わない）
export function findPlateauArea(lat, lng) {
  const la = Number(lat); const ln = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln)) return null;
  if (la >= 24 && la <= 46 && ln >= 122 && ln <= 154) return { name: 'JP' };
  return null;
}

const GSI_REVGEO = 'https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress';
const PLATEAU_GRAPHQL = 'https://api.plateauview.mlit.go.jp/datacatalog/graphql';
const _tilesetCache = new Map(); // muniCd -> {url,name}|null

// lat/lng → 自治体コード（GSI逆ジオコーダ）
async function muniCodeFor(lat, lng, signal) {
  const resp = await fetch(`${GSI_REVGEO}?lat=${lat}&lon=${lng}`, { signal });
  if (!resp.ok) throw new Error(`GSI revgeo HTTP ${resp.status}`);
  const d = await resp.json();
  const code = d?.results?.muniCd;
  return code ? String(code) : null;
}

// 自治体コード → 建物3D Tiles(LOD2優先)の tileset URL（PLATEAU datacatalog）
async function plateauBldgTileset(muniCd, signal) {
  if (_tilesetCache.has(muniCd)) return _tilesetCache.get(muniCd);
  const query = `{ datasets(input:{areaCodes:["${muniCd}"], includeTypes:["bldg"]}){ name items{ format url name } } }`;
  const resp = await fetch(PLATEAU_GRAPHQL, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query })
  });
  if (!resp.ok) throw new Error(`datacatalog HTTP ${resp.status}`);
  const d = await resp.json();
  const datasets = d?.data?.datasets || [];
  let items = [];
  for (const ds of datasets) items = items.concat(ds.items || []);
  const tiles = items.filter((it) => String(it.format).toUpperCase() === 'CESIUM3DTILES' && it.url);
  // Default back to the pre-Google-3D-Tiles lightweight path: LOD1 first.
  // Set window.PLATEAU_PREFER_LOD = 'lod2' only when explicitly testing LOD2.
  const preferLod = String((typeof window !== 'undefined' && window.PLATEAU_PREFER_LOD) || 'lod1').toLowerCase();
  const tag = (t) => `${t.name} ${t.url}`;
  let pick = null;
  if (preferLod === 'lod2') {
    pick = tiles.find((t) => /lod2/i.test(tag(t)) && !/no_texture|テクスチャなし/i.test(tag(t)))
      || tiles.find((t) => /lod2/i.test(tag(t)));
  } else {
    pick = tiles.find((t) => /lod1/i.test(tag(t)));
  }
  pick = pick
    || tiles.find((t) => /lod1/i.test(tag(t)))
    || tiles.find((t) => /no_texture|テクスチャなし/i.test(tag(t)))
    || tiles[0];
  const result = pick ? { url: pick.url, name: datasets[0]?.name || muniCd } : null;
  _tilesetCache.set(muniCd, result);
  return result;
}

// 経路位置からPLATEAU建物タイルURLを実行時解決（無ければ null → OSMフォールバック）
async function resolvePlateauTileset(lat, lng, signal) {
  if (!findPlateauArea(lat, lng)) return null;
  const muniCd = await muniCodeFor(lat, lng, signal);
  if (!muniCd) return null;
  return plateauBldgTileset(muniCd, signal);
}

// 3d-tiles-renderer は ESM のみ。?external=three で three を内包させず、
// ページの importmap が指す THREE 0.132 を共有させる（単一インスタンス → "Multiple instances" 衝突回避）。
const TILES_RENDERER_URL = 'https://esm.sh/3d-tiles-renderer@0.4.27?external=three';
const TILES_PLUGINS_URL = 'https://esm.sh/3d-tiles-renderer@0.4.27/plugins?external=three';
const DRACO_DECODER_PATH = 'https://www.gstatic.com/draco/versioned/decoders/1.5.7/';
const DEFAULT_PLATEAU_Y_OFFSET_M = 0;
// map3dThree.js の道路面 (ROAD_SURFACE_HEIGHT) と同じ表示基準。
export const PLATEAU_DISPLAY_GROUND_Y_M = 0.04;
const DEFAULT_PLATEAU_GROUND_TARGET_Y_M = PLATEAU_DISPLAY_GROUND_Y_M;
const DEFAULT_PLATEAU_OPACITY = 0.52;
let _ctorPromise = null;
function loadTilesRendererCtor() {
  if (_ctorPromise) return _ctorPromise;
  _ctorPromise = import(/* @vite-ignore */ TILES_RENDERER_URL)
    .then((m) => m.TilesRenderer || m.default?.TilesRenderer || null)
    .catch((e) => {
      console.warn('[plateau] 3d-tiles-renderer load failed:', e?.message || e);
      return null;
    });
  return _ctorPromise;
}

// PLATEAU の b3dm は Draco 圧縮。GLTFExtensionsPlugin に DRACOLoader を渡して登録する。
let _gltfPluginPromise = null;
function loadGltfDracoPlugin() {
  if (_gltfPluginPromise) return _gltfPluginPromise;
  _gltfPluginPromise = Promise.all([
    import(/* @vite-ignore */ TILES_PLUGINS_URL),
    import(/* @vite-ignore */ 'three/addons/loaders/DRACOLoader.js')
  ]).then(([plugins, dracoMod]) => {
    const GLTFExtensionsPlugin = plugins.GLTFExtensionsPlugin || plugins.default?.GLTFExtensionsPlugin;
    const DRACOLoader = dracoMod.DRACOLoader || dracoMod.default?.DRACOLoader;
    if (!GLTFExtensionsPlugin || !DRACOLoader) return null;
    return { GLTFExtensionsPlugin, DRACOLoader };
  }).catch((e) => {
    console.warn('[plateau] GLTF/DRACO plugin load failed:', e?.message || e);
    return null;
  });
  return _gltfPluginPromise;
}

// WGS84 楕円体上の緯度経度+楕円体高(h) → ECEF(m)
function ecef(lat, lng, h = 0) {
  const rLat = lat * Math.PI / 180;
  const rLng = lng * Math.PI / 180;
  const a = 6378137.0;
  const f = 1.0 / 298.257223563;
  const e2 = f * (2.0 - f);
  const N = a / Math.sqrt(1.0 - e2 * Math.sin(rLat) ** 2);
  return {
    x: (N + h) * Math.cos(rLat) * Math.cos(rLng),
    y: (N + h) * Math.cos(rLat) * Math.sin(rLng),
    z: (N * (1.0 - e2) + h) * Math.sin(rLat)
  };
}

// ECEF → index3D ローカル(x=東, y=上, z=-北) の Matrix4 を作る。
// originHeightM: 原点の楕円体高（ジオイド分。建物基部を地面 y≈0 に落とすため）。
function ecefToLocalMatrix(THREE, originLL, originHeightM = 0) {
  const lat = originLL.lat * Math.PI / 180;
  const lng = originLL.lng * Math.PI / 180;
  const sLat = Math.sin(lat); const cLat = Math.cos(lat);
  const sLng = Math.sin(lng); const cLng = Math.cos(lng);
  const east = { x: -sLng, y: cLng, z: 0 };
  const north = { x: -sLat * cLng, y: -sLat * sLng, z: cLat };
  const up = { x: cLat * cLng, y: cLat * sLng, z: sLat };
  const O = ecef(originLL.lat, originLL.lng, originHeightM);
  const dot = (v) => v.x * O.x + v.y * O.y + v.z * O.z;
  const m = new THREE.Matrix4();
  // local.x = east·(p-O), local.y = up·(p-O), local.z = -north·(p-O)
  m.set(
    east.x, east.y, east.z, -dot(east),
    up.x, up.y, up.z, -dot(up),
    -north.x, -north.y, -north.z, dot(north),
    0, 0, 0, 1
  );
  return m;
}

function plateauYOffsetM() {
  const raw = Number(window.PLATEAU_Y_OFFSET);
  return Number.isFinite(raw) ? raw : DEFAULT_PLATEAU_Y_OFFSET_M;
}

export function plateauGroundTargetY() {
  const raw = Number(typeof window !== 'undefined' ? window.PLATEAU_GROUND_TARGET_Y : NaN);
  return Number.isFinite(raw) ? raw : DEFAULT_PLATEAU_GROUND_TARGET_Y_M;
}

function plateauGroundAlignEnabled() {
  return !(typeof window !== 'undefined' && window.PLATEAU_GROUND_ALIGN === false);
}

// 地盤推定に使う水平半径(m)。原点(ローカル0,0)からこの距離内のメッシュだけを見る。
function plateauSampleRadiusM() {
  const raw = Number(typeof window !== 'undefined' ? window.PLATEAU_SAMPLE_RADIUS_M : NaN);
  return Number.isFinite(raw) && raw > 0 ? raw : 120;
}

// 接地候補は原点に近いものを優先する。遠方LODの混入で局所地盤が変わらないよう、
// 半径内でも最近傍の少数候補だけから中央値を求める。
export function estimatePlateauGroundY(samples, { radiusM = 120, maxCandidates = 16 } = {}) {
  const radius = Number(radiusM);
  const limit = Math.max(1, Math.floor(Number(maxCandidates) || 16));
  if (!(radius > 0) || !Array.isArray(samples)) return null;
  const candidates = [...samples]
    .filter((s) => s?.groundEligible !== false
      && Number.isFinite(Number(s?.distanceM))
      && Number(s.distanceM) <= radius
      && Number.isFinite(Number(s?.minY)))
    .sort((a, b) => Number(a.distanceM) - Number(b.distanceM))
    .slice(0, limit);
  if (!candidates.length) return null;
  const values = candidates.map((s) => Number(s.minY)).sort((a, b) => a - b);
  const mid = values.length >> 1;
  const groundEstimateY = values.length % 2
    ? values[mid]
    : (values[mid - 1] + values[mid]) / 2;
  return {
    groundEstimateY,
    minY: Math.min(...values),
    maxY: Math.max(...values),
    candidates: candidates.length,
    nearestDistanceM: Number(candidates[0].distanceM)
  };
}

export function shouldResamplePlateauGround({
  force = false,
  sampleAttempted = false,
  meshCount = 0,
  now = 0,
  lastSampleMs = 0,
  signature = '',
  lastSignature = '',
  lastMeshCount = 0,
  groundStable = false,
  intervalMs = 1500
} = {}) {
  if (force || !sampleAttempted) return meshCount > 0 || force;
  if (now - lastSampleMs < intervalMs) return false;
  return signature !== lastSignature
    || Math.abs(meshCount - lastMeshCount) !== 0
    || !groundStable;
}

function plateauOpacity() {
  const raw = Number(window.PLATEAU_OPACITY);
  return Number.isFinite(raw) ? Math.max(0.15, Math.min(1, raw)) : DEFAULT_PLATEAU_OPACITY;
}

function makePlateauMaterialTransparent(material, opacity) {
  if (!material) return material;
  if (!material.userData?.plateauTransparentClone) {
    material = material.clone ? material.clone() : material;
    material.userData = { ...(material.userData || {}), plateauTransparentClone: true };
  }
  material.transparent = opacity < 1;
  material.opacity = opacity;
  material.depthWrite = opacity >= 0.85;
  material.needsUpdate = true;
  return material;
}

function applyPlateauOpacity(group) {
  if (!group?.traverse) return;
  const opacity = plateauOpacity();
  group.traverse((obj) => {
    if (!obj?.isMesh || !obj.material) return;
    obj.material = Array.isArray(obj.material)
      ? obj.material.map((mat) => makePlateauMaterialTransparent(mat, opacity))
      : makePlateauMaterialTransparent(obj.material, opacity);
  });
}

/**
 * PLATEAU 3D Tiles を scene に取り付ける。成功で handle、カバー外/未対応/失敗で null。
 * 3d-tiles-renderer の動的import待ちのため async。
 * @returns {Promise<{ update:Function, dispose:Function, area:object }|null>}
 */
export async function createPlateauTiles({ THREE, scene, camera, renderer, originLL, lodScale = 0.3, tileset = null, onStatus, onError } = {}) {
  if (!THREE || !scene || !camera || !originLL) return null;
  // 実行時にPLATEAU建物タイルURLを解決（GSI→datacatalog）。無ければ null（OSMフォールバック）
  let area = null;
  try {
    area = tileset?.url
      ? {
        url: tileset.url,
        name: tileset.name || tileset.itemName || tileset.muniCd || 'PLATEAU',
        itemName: tileset.itemName || '',
        muniCd: tileset.muniCd || ''
      }
      : await resolvePlateauTileset(originLL.lat, originLL.lng);
  } catch (e) {
    onStatus?.({ state: 'resolve-failed', reason: e?.message || String(e) });
    return null;
  }
  if (!area?.url) return null;
  onStatus?.({ state: 'resolved', area: area.name });

  const Ctor = await loadTilesRendererCtor();
  if (!Ctor) {
    onStatus?.({ state: 'unavailable', reason: '3d-tiles-renderer 未読込' });
    return null;
  }

  // Draco対応プラグイン（PLATEAU b3dmに必須）。tileset処理の前に登録する。
  const gltf = await loadGltfDracoPlugin();

  let tiles = null;
  let pivot = null;
  let outerGroup = null;
  let failed = false;
  let opacityPass = 0;
  // 接地の安定化用の内部状態（表示のみ。物理/判定には一切使わない）
  const AUTO_SHIFT_CLAMP_M = 120;  // 局所候補だけを使うため、標高差を十分に吸収する
  const SAMPLE_MIN_INTERVAL_MS = 1500; // 再サンプルの最小間隔
  const SHIFT_LERP = 0.15;         // 適用シフトのスルー係数（ジャンプ防止）
  const STABLE_DIFF_M = 0.3;       // 連続サンプル差がこれ未満なら安定
  const MAX_MESH_VERTS = 4000;     // 1メッシュあたりの頂点走査上限（stride算出用）
  let _lastSampleMs = 0;
  let _lastSampleMeshCount = 0;
  let _lastMeshSignature = '';
  let _sampleAttempted = false;
  let _prevGroundEstimateY = null;
  let _groundStable = false;
  let _targetShiftM = 0;   // サンプルで決まる目標シフト
  let _appliedShiftM = 0;  // 実際に適用中のシフト（毎フレーム目標へlerp）
  const nowMs = () => ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now());
  const countMeshes = () => {
    let n = 0;
    try { pivot?.traverse?.((o) => { if (o?.isMesh) n += 1; }); } catch (_e) { n = 0; }
    return n;
  };
  const meshSignature = () => {
    const parts = [];
    try {
      pivot?.traverse?.((o) => {
        if (!o?.isMesh || !o.geometry) return;
        const a = o.geometry.attributes?.position;
        const b = o.geometry.boundingBox;
        const e = o.matrixWorld?.elements || [];
        parts.push([
          o.geometry.uuid || o.geometry.id || '',
          a?.count || 0,
          b ? `${b.min.x.toFixed(1)},${b.min.y.toFixed(1)},${b.min.z.toFixed(1)},${b.max.x.toFixed(1)},${b.max.y.toFixed(1)},${b.max.z.toFixed(1)}` : '',
          e.length ? `${e[12].toFixed(1)},${e[13].toFixed(1)},${e[14].toFixed(1)}` : ''
        ].join(':'));
      });
    } catch (_e) { return ''; }
    return parts.join('|');
  };
  const groundMetrics = {
    autoGroundAlign: plateauGroundAlignEnabled(),
    manualOffsetM: plateauYOffsetM(),
    baseMinY: null,
    baseMaxY: null,
    autoShiftM: 0,
    appliedYOffsetM: plateauYOffsetM(),
    sampled: false,
    meshCount: 0,
    lastSampleReason: 'not-sampled',
    // 追加フィールド（半径限定・中央値ベースの接地）
    sampleRadiusM: plateauSampleRadiusM(),
    meshesInRadius: 0,
    groundEstimateY: null,
    groundStable: false
  };
  // 原点(ローカル0,0)から水平R以内に実際に入る頂点だけを見て、最近傍候補の中央値で地盤を推定する。
  // メッシュ中心やタイル全体のminYは使わないため、遠方LOD・屋根面・タイル境界に引きずられない。
  // 計測は接地シフトを0に戻した素のワールド座標で行う（x=東, z=-北, y=上）。
  const sampleBaseBounds = () => {
    if (!outerGroup || !pivot || !THREE?.Box3) return null;
    const meshCount = countMeshes();
    groundMetrics.meshCount = meshCount;
    if (meshCount <= 0) {
      groundMetrics.lastSampleReason = 'no-mesh';
      return null;
    }
    const prevY = outerGroup.position.y;
    outerGroup.position.y = 0;
    outerGroup.updateMatrixWorld(true);
    let result = null;
    try {
      // デバッグ用: tiles.group ローカル系の全体bbox（接地には使わない）
      try {
        tiles?.group?.updateMatrixWorld?.(true);
        const inv = new THREE.Matrix4().copy(tiles.group.matrixWorld).invert();
        const localBox = new THREE.Box3();
        pivot.traverse?.((obj) => {
          if (!obj?.isMesh || !obj.geometry) return;
          if (!obj.geometry.boundingBox) obj.geometry.computeBoundingBox?.();
          if (!obj.geometry.boundingBox) return;
          const b = obj.geometry.boundingBox.clone().applyMatrix4(obj.matrixWorld).applyMatrix4(inv);
          localBox.union(b);
        });
        if (!localBox.isEmpty()) {
          groundMetrics.localMinY = Number(localBox.min.y.toFixed(2));
          groundMetrics.localMaxY = Number(localBox.max.y.toFixed(2));
          groundMetrics.localWidthM = Number((localBox.max.x - localBox.min.x).toFixed(2));
          groundMetrics.localHeightYM = Number((localBox.max.y - localBox.min.y).toFixed(2));
          groundMetrics.localDepthZM = Number((localBox.max.z - localBox.min.z).toFixed(2));
        }
      } catch (_e) { /* debug metrics only */ }

      const R = plateauSampleRadiusM();
      groundMetrics.sampleRadiusM = R;
      const v = new THREE.Vector3();
      const localSamples = [];
      let sampledVertices = 0;
      try {
        pivot.traverse?.((obj) => {
          const attr = obj?.isMesh ? obj.geometry?.attributes?.position : null;
          if (!attr?.count || !obj.matrixWorld) return;
          const stride = Math.max(1, Math.floor(attr.count / MAX_MESH_VERTS));
          let meshMinY = Infinity;
          let meshMaxY = -Infinity;
          let nearestDistanceM = Infinity;
          let localVertexCount = 0;
          for (let i = 0; i < attr.count; i += stride) {
            v.fromBufferAttribute(attr, i).applyMatrix4(obj.matrixWorld);
            if (!Number.isFinite(v.y)) continue;
            const distanceM = Math.hypot(v.x, v.z);
            if (distanceM <= R) {
              if (v.y < meshMinY) meshMinY = v.y;
              if (v.y > meshMaxY) meshMaxY = v.y;
              if (distanceM < nearestDistanceM) nearestDistanceM = distanceM;
              localVertexCount += 1;
              sampledVertices += 1;
            }
          }
          if (localVertexCount > 0 && Number.isFinite(meshMinY)) {
            localSamples.push({
              minY: meshMinY,
              maxY: meshMaxY,
              distanceM: nearestDistanceM,
              verticalSpanM: meshMaxY - meshMinY,
              // 建物屋根だけの平面メッシュは地盤候補から除外する。
              groundEligible: (meshMaxY - meshMinY) >= 0.5
            });
          }
        });
      } catch (_e) { /* ストリーミング途中の不完全メッシュは今回のサンプルから除外 */ }

      const estimate = estimatePlateauGroundY(localSamples, { radiusM: R });
      groundMetrics.meshesInRadius = localSamples.length;
      if (estimate) {
        groundMetrics.rawMinY = Number(estimate.minY.toFixed(2));
        groundMetrics.rawMaxY = Number(estimate.maxY.toFixed(2));
        groundMetrics.rawHeightM = Number((estimate.maxY - estimate.minY).toFixed(2));
        groundMetrics.vertexSampleCount = sampledVertices;
        groundMetrics.lastSampleReason = 'local-nearest-median';
        result = {
          minY: estimate.minY,
          maxY: estimate.maxY,
          groundEstimateY: estimate.groundEstimateY,
          meshesInRadius: estimate.candidates,
          meshCount
        };
        return result;
      }
      groundMetrics.lastSampleReason = localSamples.length ? 'no-local-ground' : 'no-local-vertices';
      return null;
    } finally {
      outerGroup.position.y = prevY;
      outerGroup.updateMatrixWorld(true);
    }
  };
  // 接地シフトの決定＋適用。サンプルは条件成立時のみ、適用は毎フレームlerpでスルーする。
  const refreshGroundPlacement = (forceSample = false) => {
    if (!outerGroup) return;
    const manualOffset = plateauYOffsetM();
    const enabled = plateauGroundAlignEnabled();
    groundMetrics.autoGroundAlign = enabled;
    groundMetrics.manualOffsetM = manualOffset;

    if (!enabled) {
      // 自動接地 無効: シフト0で手動オフセットのみ（既存挙動を維持）
      _targetShiftM = 0; _appliedShiftM = 0;
      groundMetrics.baseMinY = null;
      groundMetrics.baseMaxY = null;
      groundMetrics.groundEstimateY = null;
      groundMetrics.autoShiftM = 0;
      groundMetrics.sampled = false;
      groundMetrics.groundStable = false;
      outerGroup.position.y = manualOffset;
      groundMetrics.appliedYOffsetM = Number(outerGroup.position.y.toFixed(2));
      return;
    }

    // メッシュ数だけでなく、同数のLOD差し替えも検出して再サンプルする。
    // update() は毎フレーム呼ばれるため、全メッシュ走査はサンプル窓だけで行う。
    const now = nowMs();
    const sampleWindowOpen = forceSample
      || (_sampleAttempted ? now - _lastSampleMs >= SAMPLE_MIN_INTERVAL_MS : now - _lastSampleMs >= 250);
    let meshCount = _lastSampleMeshCount;
    let signature = _lastMeshSignature;
    let doSample = false;
    if (sampleWindowOpen) {
      meshCount = countMeshes();
      signature = meshSignature();
      groundMetrics.meshCount = meshCount;
      doSample = shouldResamplePlateauGround({
        force: forceSample,
        sampleAttempted: _sampleAttempted,
        meshCount,
        now,
        lastSampleMs: _lastSampleMs,
        signature,
        lastSignature: _lastMeshSignature,
        lastMeshCount: _lastSampleMeshCount,
        groundStable: _groundStable,
        intervalMs: SAMPLE_MIN_INTERVAL_MS
      });
    }

    if (doSample) {
      const bounds = sampleBaseBounds();
      _lastSampleMs = now;
      _lastMeshSignature = signature;
      _lastSampleMeshCount = meshCount;
      if (bounds) {
        _sampleAttempted = true;
        groundMetrics.baseMinY = Number(bounds.minY.toFixed(2));
        groundMetrics.baseMaxY = Number(bounds.maxY.toFixed(2));
        groundMetrics.groundEstimateY = Number(bounds.groundEstimateY.toFixed(2));
        // 連続2回のサンプル差が小さければ安定とみなす
        _groundStable = (_prevGroundEstimateY != null)
          && (Math.abs(bounds.groundEstimateY - _prevGroundEstimateY) < STABLE_DIFF_M);
        _prevGroundEstimateY = bounds.groundEstimateY;
        groundMetrics.groundStable = _groundStable;
        // 目標シフト = ターゲットY − 地盤推定Y、±120mでクランプ
        let shift = plateauGroundTargetY() - bounds.groundEstimateY;
        shift = Math.max(-AUTO_SHIFT_CLAMP_M, Math.min(AUTO_SHIFT_CLAMP_M, shift));
        _targetShiftM = shift;
        groundMetrics.autoShiftM = Number(shift.toFixed(2));
        groundMetrics.sampled = true;
      }
      if (!bounds && meshCount > 0) _sampleAttempted = true;
    }

    // 毎フレーム lerp で目標シフトへ寄せる（ストリーミングのジャンプを吸収）
    _appliedShiftM += (_targetShiftM - _appliedShiftM) * SHIFT_LERP;
    outerGroup.position.y = _appliedShiftM + manualOffset;
    groundMetrics.appliedYOffsetM = Number(outerGroup.position.y.toFixed(2));
  };
  try {
    tiles = new Ctor(area.url);
    if (gltf && tiles.registerPlugin) {
      try {
        const draco = new gltf.DRACOLoader();
        draco.setDecoderPath(DRACO_DECODER_PATH);
        tiles.registerPlugin(new gltf.GLTFExtensionsPlugin({ dracoLoader: draco }));
      } catch (pe) { console.warn('[plateau] draco plugin register failed:', pe?.message || pe); }
    }
    if (tiles.setCamera) tiles.setCamera(camera);
    if (tiles.setResolutionFromRenderer) tiles.setResolutionFromRenderer(camera, renderer);
    if (tiles.setResolutionScale) tiles.setResolutionScale(Math.max(0.1, Math.min(1, Number(lodScale) || 0.3)));
    // 軽量化: 誤差許容を大きめにして粗いLODを優先（白箱寄り）
    if ('errorTarget' in tiles) tiles.errorTarget = 24;
    if ('maxDepth' in tiles) tiles.maxDepth = 12;

    // pivot: ECEF→ローカルENU 変換。outer: 接地補正（ジオイド/地形標高ぶんの鉛直オフセットを吸収）。
    // 原点の楕円体高 = ジオイド高(日本≈37m) で建物基部を地面付近へ。手動微調整は window.PLATEAU_GEOID_H。
    const geoidH = Number.isFinite(Number(window.PLATEAU_GEOID_H)) ? Number(window.PLATEAU_GEOID_H) : 37;
    pivot = new THREE.Group();
    pivot.name = 'plateauTilesPivot';
    pivot.matrixAutoUpdate = false;
    pivot.matrix.copy(ecefToLocalMatrix(THREE, originLL, geoidH));
    pivot.matrixWorldNeedsUpdate = true;
    pivot.add(tiles.group);
    outerGroup = new THREE.Group();
    outerGroup.name = 'plateauTilesOuter';
    outerGroup.position.y = plateauYOffsetM(); // 自動接地後の微調整用（任意）
    outerGroup.add(pivot);
    scene.add(outerGroup);
    applyPlateauOpacity(tiles.group);
    refreshGroundPlacement(true);

    tiles.addEventListener?.('load-tileset', () => onStatus?.({ state: 'streaming', area: area.name }));
    tiles.addEventListener?.('load-error', (e) => {
      failed = true;
      onError?.(e?.error || new Error('tile load error'));
    });
  } catch (err) {
    onError?.(err);
    try { if (outerGroup) scene.remove(outerGroup); if (tiles?.dispose) tiles.dispose(); } catch (_e) {}
    return null;
  }

  return {
    area,
    get failed() { return failed; },
    // window.PLATEAU_OPACITY 変更時に即時再適用する（スライダー用）。
    applyOpacity() {
      try { applyPlateauOpacity(tiles?.group); } catch (_e) {}
    },
    update() {
      if (failed || !tiles) return;
      try {
        if (tiles.setResolutionFromRenderer) tiles.setResolutionFromRenderer(camera, renderer);
        tiles.update();
        if ((++opacityPass % 12) === 0) applyPlateauOpacity(tiles.group);
        // 接地は半径限定・中央値ベースで局所地盤へ合わせる。再サンプル要否と適用lerpは
        // refreshGroundPlacement 内部で判定する（毎フレーム呼ぶだけでよい）。
        // window.PLATEAU_Y_OFFSET は接地後の微調整として毎フレーム反映される。
        refreshGroundPlacement();
      } catch (_e) { /* streaming中の一時エラーは無視 */ }
    },
    getMetrics() {
      return { ...groundMetrics };
    },
    dispose() {
      try { if (outerGroup) scene.remove(outerGroup); } catch (_e) {}
      try { if (tiles?.dispose) tiles.dispose(); } catch (_e) {}
      tiles = null; pivot = null; outerGroup = null;
    }
  };
}

export default { findPlateauArea, createPlateauTiles };
