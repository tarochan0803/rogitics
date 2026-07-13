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
const DEFAULT_PLATEAU_GROUND_TARGET_Y_M = 0;
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

function plateauGroundTargetY() {
  const raw = Number(window.PLATEAU_GROUND_TARGET_Y);
  return Number.isFinite(raw) ? raw : DEFAULT_PLATEAU_GROUND_TARGET_Y_M;
}

function plateauGroundAlignEnabled() {
  return !(typeof window !== 'undefined' && window.PLATEAU_GROUND_ALIGN === false);
}

// 地盤推定に使う水平半径(m)。原点(ローカル0,0)からこの距離内のメッシュだけを見る。
function plateauSampleRadiusM() {
  const raw = Number(typeof window !== 'undefined' ? window.PLATEAU_SAMPLE_RADIUS_M : NaN);
  return Number.isFinite(raw) && raw > 0 ? raw : 400;
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
  const AUTO_SHIFT_CLAMP_M = 25;   // 自動シフトの上限（外れ値で飛ばさない）
  const SAMPLE_MIN_INTERVAL_MS = 1500; // 再サンプルの最小間隔
  const SHIFT_LERP = 0.15;         // 適用シフトのスルー係数（ジャンプ防止）
  const STABLE_DIFF_M = 0.3;       // 連続サンプル差がこれ未満なら安定
  const MESH_CHANGE_FRAC = 0.10;   // 安定後はメッシュ数がこの割合以上変化した時だけ再サンプル
  const MIN_MESHES_FOR_MEDIAN = 3; // 半径内メッシュがこれ未満なら従来グローバル方式へ
  const MAX_MESH_VERTS = 2000;     // 1メッシュあたりの頂点走査上限（stride算出用）
  let _lastSampleMs = 0;
  let _lastSampleMeshCount = 0;
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
  // 原点(ローカル0,0)から水平R以内のメッシュだけを見て、各メッシュ最低Yの中央値で地盤を推定する。
  // 遠方の谷や外れ値頂点1点に引きずられないため、グローバルminYより局所地盤に近い。
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
      const center = new THREE.Vector3();
      const v = new THREE.Vector3();
      const perMeshMinY = [];       // 半径内メッシュごとの最低Y
      let overallMinY = Infinity; let overallMaxY = -Infinity; // 半径内の全体域
      let sampledVertices = 0; let meshesInRadius = 0;
      // フォールバック用: 全メッシュのグローバルminY/maxY
      let globalMinY = Infinity; let globalMaxY = -Infinity; let globalSampled = 0;
      try {
        pivot.traverse?.((obj) => {
          const attr = obj?.isMesh ? obj.geometry?.attributes?.position : null;
          if (!attr?.count || !obj.matrixWorld) return;
          const geom = obj.geometry;
          if (!geom.boundingBox) geom.computeBoundingBox?.();
          // メッシュ中心のワールド水平距離（x-z平面）で半径判定
          let inRadius = false;
          if (geom.boundingBox) {
            geom.boundingBox.getCenter(center).applyMatrix4(obj.matrixWorld);
            inRadius = Math.hypot(center.x, center.z) <= R;
          }
          const stride = Math.max(1, Math.floor(attr.count / MAX_MESH_VERTS));
          let meshMinY = Infinity;
          for (let i = 0; i < attr.count; i += stride) {
            v.fromBufferAttribute(attr, i).applyMatrix4(obj.matrixWorld);
            if (!Number.isFinite(v.y)) continue;
            if (v.y < globalMinY) globalMinY = v.y;
            if (v.y > globalMaxY) globalMaxY = v.y;
            globalSampled += 1;
            if (inRadius) {
              if (v.y < meshMinY) meshMinY = v.y;
              if (v.y < overallMinY) overallMinY = v.y;
              if (v.y > overallMaxY) overallMaxY = v.y;
              sampledVertices += 1;
            }
          }
          if (inRadius && Number.isFinite(meshMinY)) {
            perMeshMinY.push(meshMinY);
            meshesInRadius += 1;
          }
        });
      } catch (_e) { /* サンプル失敗時は下でフォールバック */ }

      groundMetrics.meshesInRadius = meshesInRadius;

      // 半径内メッシュが3個以上: 各メッシュ最低Yの中央値を地盤推定に採用
      if (meshesInRadius >= MIN_MESHES_FOR_MEDIAN && perMeshMinY.length >= MIN_MESHES_FOR_MEDIAN) {
        perMeshMinY.sort((a, b) => a - b);
        const mid = perMeshMinY.length >> 1;
        const median = (perMeshMinY.length % 2)
          ? perMeshMinY[mid]
          : (perMeshMinY[mid - 1] + perMeshMinY[mid]) / 2;
        groundMetrics.rawMinY = Number(overallMinY.toFixed(2));
        groundMetrics.rawMaxY = Number(overallMaxY.toFixed(2));
        groundMetrics.rawHeightM = Number((overallMaxY - overallMinY).toFixed(2));
        groundMetrics.vertexSampleCount = sampledVertices;
        groundMetrics.lastSampleReason = 'radius-median';
        result = { minY: overallMinY, maxY: overallMaxY, groundEstimateY: median, meshesInRadius, meshCount };
        return result;
      }

      // フォールバック1: 全メッシュ頂点のグローバルminY（従来方式）
      if (globalSampled > 0 && Number.isFinite(globalMinY) && Number.isFinite(globalMaxY)) {
        const height = globalMaxY - globalMinY;
        groundMetrics.rawMinY = Number(globalMinY.toFixed(2));
        groundMetrics.rawMaxY = Number(globalMaxY.toFixed(2));
        groundMetrics.rawHeightM = Number(height.toFixed(2));
        groundMetrics.vertexSampleCount = globalSampled;
        if (!(height > 0.5) || height > 600) {
          groundMetrics.lastSampleReason = 'vertex-height-out-of-range';
          return null;
        }
        groundMetrics.lastSampleReason = 'global-fallback';
        result = { minY: globalMinY, maxY: globalMaxY, groundEstimateY: globalMinY, meshesInRadius, meshCount };
        return result;
      }

      // フォールバック2: 頂点属性が無い場合のBox3（シフト0状態のまま計測）
      let box = null;
      try { box = new THREE.Box3().setFromObject(pivot); } catch (_e) { box = null; }
      if (!box || !Number.isFinite(box.min?.y) || !Number.isFinite(box.max?.y)) {
        groundMetrics.lastSampleReason = 'invalid-bounds';
        return null;
      }
      const bh = box.max.y - box.min.y;
      groundMetrics.rawMinY = Number(box.min.y.toFixed(2));
      groundMetrics.rawMaxY = Number(box.max.y.toFixed(2));
      groundMetrics.rawHeightM = Number(bh.toFixed(2));
      if (!(bh > 0.5) || bh > 1200) {
        groundMetrics.lastSampleReason = 'bounds-height-out-of-range';
        return null;
      }
      groundMetrics.lastSampleReason = 'box-fallback';
      result = { minY: box.min.y, maxY: box.max.y, groundEstimateY: box.min.y, meshesInRadius, meshCount };
      return result;
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

    // 再サンプル要否: メッシュ数変化 かつ 1.5秒経過。安定後は10%以上の変化のみ。
    const meshCount = countMeshes();
    groundMetrics.meshCount = meshCount;
    const now = nowMs();
    let doSample = false;
    if (forceSample || !groundMetrics.sampled) {
      doSample = meshCount > 0 || forceSample;
    } else if (now - _lastSampleMs >= SAMPLE_MIN_INTERVAL_MS) {
      const delta = Math.abs(meshCount - _lastSampleMeshCount);
      if (_groundStable) {
        const thresh = Math.max(1, Math.round(_lastSampleMeshCount * MESH_CHANGE_FRAC));
        doSample = delta >= thresh;
      } else {
        doSample = delta !== 0;
      }
    }

    if (doSample) {
      const bounds = sampleBaseBounds();
      if (bounds) {
        _lastSampleMs = now;
        _lastSampleMeshCount = bounds.meshCount;
        groundMetrics.baseMinY = Number(bounds.minY.toFixed(2));
        groundMetrics.baseMaxY = Number(bounds.maxY.toFixed(2));
        groundMetrics.groundEstimateY = Number(bounds.groundEstimateY.toFixed(2));
        // 連続2回のサンプル差が小さければ安定とみなす
        _groundStable = (_prevGroundEstimateY != null)
          && (Math.abs(bounds.groundEstimateY - _prevGroundEstimateY) < STABLE_DIFF_M);
        _prevGroundEstimateY = bounds.groundEstimateY;
        groundMetrics.groundStable = _groundStable;
        // 目標シフト = ターゲットY − 地盤推定Y、±25mでクランプ
        let shift = plateauGroundTargetY() - bounds.groundEstimateY;
        shift = Math.max(-AUTO_SHIFT_CLAMP_M, Math.min(AUTO_SHIFT_CLAMP_M, shift));
        _targetShiftM = shift;
        groundMetrics.autoShiftM = Number(shift.toFixed(2));
        groundMetrics.sampled = true;
      }
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
