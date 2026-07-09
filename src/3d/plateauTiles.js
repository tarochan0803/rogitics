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
const DEFAULT_PLATEAU_Y_OFFSET_M = -3.5;
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
    outerGroup.position.y = plateauYOffsetM(); // 微調整用（任意）
    outerGroup.add(pivot);
    scene.add(outerGroup);
    applyPlateauOpacity(tiles.group);

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
        // 微調整(window.PLATEAU_Y_OFFSET)を毎フレーム反映（コンソールから即時に合わせ込めるように）
        if (outerGroup) outerGroup.position.y = plateauYOffsetM();
      } catch (_e) { /* streaming中の一時エラーは無視 */ }
    },
    dispose() {
      try { if (outerGroup) scene.remove(outerGroup); } catch (_e) {}
      try { if (tiles?.dispose) tiles.dispose(); } catch (_e) {}
      tiles = null; pivot = null; outerGroup = null;
    }
  };
}

export default { findPlateauArea, createPlateauTiles };
