const GSI_REVGEO = 'https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress';
const PLATEAU_GRAPHQL = 'https://api.plateauview.mlit.go.jp/datacatalog/graphql';

const catalogCache = new Map();
const muniCache = new Map();

export function boundsCenter(bounds) {
  if (!bounds) return null;
  const south = Number(bounds.south);
  const north = Number(bounds.north);
  const west = Number(bounds.west);
  const east = Number(bounds.east);
  if (![south, north, west, east].every(Number.isFinite)) return null;
  return {
    lat: (south + north) / 2,
    lng: (west + east) / 2
  };
}

export function isJapanLngLat(lat, lng) {
  const la = Number(lat);
  const ln = Number(lng);
  return Number.isFinite(la) && Number.isFinite(ln) && la >= 24 && la <= 46 && ln >= 122 && ln <= 154;
}

export async function muniCodeForPoint(lat, lng, { signal } = {}) {
  if (!isJapanLngLat(lat, lng)) return null;
  const key = `${Number(lat).toFixed(5)},${Number(lng).toFixed(5)}`;
  if (muniCache.has(key)) return muniCache.get(key);
  const resp = await fetch(`${GSI_REVGEO}?lat=${lat}&lon=${lng}`, { signal });
  if (!resp.ok) throw new Error(`GSI reverse geocoder HTTP ${resp.status}`);
  const data = await resp.json();
  const code = data?.results?.muniCd ? String(data.results.muniCd) : null;
  muniCache.set(key, code);
  return code;
}

function itemText(item) {
  return `${item?.name || ''} ${item?.url || ''}`;
}

function chooseBuildingTileset(items = [], preferLod = 'lod1') {
  const tiles = items.filter((item) => String(item.format).toUpperCase() === 'CESIUM3DTILES' && item.url);
  if (!tiles.length) return null;
  const prefer = String(preferLod || 'lod1').toLowerCase();
  let picked = null;
  if (prefer === 'lod2') {
    picked = tiles.find((item) => /lod2/i.test(itemText(item)) && !/no_texture|テクスチャなし/i.test(itemText(item)))
      || tiles.find((item) => /lod2/i.test(itemText(item)));
  } else {
    picked = tiles.find((item) => /lod1/i.test(itemText(item)));
  }
  return picked
    || tiles.find((item) => /lod1/i.test(itemText(item)))
    || tiles.find((item) => /lod2/i.test(itemText(item)) && !/no_texture|テクスチャなし/i.test(itemText(item)))
    || tiles.find((item) => /lod2/i.test(itemText(item)))
    || tiles[0];
}

export async function resolvePlateauBuildingTilesetForMuni(muniCd, { preferLod = 'lod1', signal } = {}) {
  if (!muniCd) return null;
  const key = `${muniCd}:${String(preferLod || 'lod1').toLowerCase()}`;
  if (catalogCache.has(key)) return catalogCache.get(key);
  const query = `{ datasets(input:{areaCodes:["${muniCd}"], includeTypes:["bldg"]}){ name items{ format url name } } }`;
  const resp = await fetch(PLATEAU_GRAPHQL, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query })
  });
  if (!resp.ok) throw new Error(`PLATEAU datacatalog HTTP ${resp.status}`);
  const data = await resp.json();
  if (data.errors?.length) throw new Error(data.errors[0]?.message || 'PLATEAU datacatalog error');
  const datasets = data?.data?.datasets || [];
  let items = [];
  for (const dataset of datasets) items = items.concat(dataset.items || []);
  const picked = chooseBuildingTileset(items, preferLod);
  const result = picked ? {
    url: picked.url,
    name: datasets[0]?.name || muniCd,
    itemName: picked.name || '',
    muniCd,
    format: picked.format || 'CESIUM3DTILES',
    source: 'plateau-datacatalog'
  } : null;
  catalogCache.set(key, result);
  return result;
}

export async function resolvePlateauBuildingTilesetForPoint(lat, lng, { preferLod = 'lod1', signal } = {}) {
  const muniCd = await muniCodeForPoint(lat, lng, { signal });
  if (!muniCd) return null;
  return resolvePlateauBuildingTilesetForMuni(muniCd, { preferLod, signal });
}

export async function resolvePlateauBuildingTilesetForBounds(bounds, { preferLod = 'lod1', signal } = {}) {
  const center = boundsCenter(bounds);
  if (!center) return null;
  return resolvePlateauBuildingTilesetForPoint(center.lat, center.lng, { preferLod, signal });
}
