import { API_ENDPOINTS, ZIPS_CONFIG } from '../config.js';
import { getSession, buildLmtinf } from './zips.js';

/**
 * Extract standard address result from ZIPS API response.
 * Handles both address search and cleansing response shapes.
 */
function extractAddressResult(json, positionKey = 'position') {
  const item = json?.result?.item?.[0];
  if (!item) return { address: null, position: null, hitCount: 0, raw: json };

  const hitCount = json?.result?.info?.hit ?? 0;
  const address = item.address ?? null;

  let pos = item[positionKey] ?? item.position ?? item.match_position ?? null;
  let latlng = null;
  if (Array.isArray(pos) && pos.length >= 2) {
    // ZIPS returns [lng, lat] order
    latlng = { lat: Number(pos[1]), lng: Number(pos[0]) };
  }

  return { address, position: latlng, hitCount, raw: json };
}

/**
 * Extract result from bluemap_to_address API response.
 * The response nests address within item[0].address[0].
 */
function extractBluemapToAddressResult(json) {
  const item = json?.result?.item?.[0];
  if (!item) return { address: null, position: null, raw: json };

  const addrArray = item.address;
  if (!Array.isArray(addrArray) || !addrArray.length || addrArray[0] == null) {
    return { address: null, position: null, raw: json };
  }

  const first = addrArray[0];
  const address = first.address ?? null;

  let latlng = null;
  const pos = first.position ?? null;
  if (Array.isArray(pos) && pos.length >= 2) {
    latlng = { lat: Number(pos[1]), lng: Number(pos[0]) };
  }

  return { address, position: latlng, raw: json };
}

/**
 * 地番→住所 変換 (Lot number to address conversion)
 *
 * @param {string} bluemapAddress - The lot number address (地番), e.g. "東京都港区芝浦三丁目1番1号"
 * @param {object} [config] - ZIPS_CONFIG override
 * @returns {Promise<{address: string|null, position: {lat: number, lng: number}|null, raw: object}>}
 */
export async function bluemapToAddress(bluemapAddress, config = ZIPS_CONFIG) {
  if (!bluemapAddress || !bluemapAddress.trim()) {
    throw new Error('bluemapAddress is empty');
  }

  const session = await getSession(config);
  const lmtinf = buildLmtinf(session.funcs, 'bluemap_to_address');

  const baseUrl = `${API_ENDPOINTS.ZIPS_BASE}/zips/general/bluemap_to_address`;
  const url =
    `${baseUrl}?` +
    `zis_zips_authkey=${encodeURIComponent(session.kid)}` +
    `&zis_authtype=aid` +
    `&zis_aid=${encodeURIComponent(session.aid)}` +
    `&zis_lmtinf=${lmtinf}` +
    `&bluemap_address=${encodeURIComponent(bluemapAddress.trim())}` +
    `&datum=JGD`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`ZIPS bluemap_to_address error: ${res.status}`);
  }

  const json = await res.json();
  if (json.status !== 'OK') {
    throw new Error(`ZIPS bluemap_to_address failed: ${json.status}`);
  }

  return extractBluemapToAddressResult(json);
}

/**
 * 住所キーワード検索 (Address word search)
 *
 * @param {string} word - Search keyword
 * @param {object} [options]
 * @param {number} [options.matchType=3] - Match type (1=前方一致, 2=後方一致, 3=部分一致)
 * @param {string} [options.addressLevel='TBN'] - 'OAZ'=大字, 'TBN'=地番・戸番
 * @param {string} [options.limit='0,1'] - Result offset,count
 * @param {object} [config] - ZIPS_CONFIG override
 * @returns {Promise<{address: string|null, position: {lat: number, lng: number}|null, hitCount: number, raw: object}>}
 */
export async function addressWordSearch(word, options = {}, config = ZIPS_CONFIG) {
  if (!word || !word.trim()) {
    throw new Error('search word is empty');
  }

  const {
    matchType = 3,
    addressLevel = 'TBN',
    limit = '0,1'
  } = options;

  const session = await getSession(config);
  const lmtinf = buildLmtinf(session.funcs, 'address');

  const baseUrl = `${API_ENDPOINTS.ZIPS_BASE}/zips/general/address`;
  const url =
    `${baseUrl}?` +
    `zis_zips_authkey=${encodeURIComponent(session.kid)}` +
    `&zis_authtype=aid` +
    `&zis_aid=${encodeURIComponent(session.aid)}` +
    `&zis_lmtinf=${lmtinf}` +
    `&word=${encodeURIComponent(word.trim())}` +
    `&word_match_type=${matchType}` +
    `&address_level=${addressLevel}` +
    `&limit=${encodeURIComponent(limit)}` +
    `&datum=JGD`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`ZIPS address search error: ${res.status}`);
  }

  const json = await res.json();
  if (json.status !== 'OK') {
    throw new Error(`ZIPS address search failed: ${json.status}`);
  }

  return extractAddressResult(json);
}

/**
 * 座標→住所 逆ジオコーディング (Reverse geocode from coordinates)
 *
 * @param {number} lat - Latitude
 * @param {number} lng - Longitude
 * @param {object} [options]
 * @param {string} [options.addressLevel='TBN']
 * @param {object} [config]
 * @returns {Promise<{address: string|null, position: {lat, lng}|null, hitCount: number, raw: object}>}
 */
export async function reverseGeocode(lat, lng, options = {}, config = ZIPS_CONFIG) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error('Invalid coordinates');
  }

  const { addressLevel = 'TBN' } = options;

  const session = await getSession(config);
  const lmtinf = buildLmtinf(session.funcs, 'address');

  const baseUrl = `${API_ENDPOINTS.ZIPS_BASE}/zips/general/address`;
  // ZIPS expects position as "lng,lat" format
  const url =
    `${baseUrl}?` +
    `zis_zips_authkey=${encodeURIComponent(session.kid)}` +
    `&zis_authtype=aid` +
    `&zis_aid=${encodeURIComponent(session.aid)}` +
    `&zis_lmtinf=${lmtinf}` +
    `&address_level=${addressLevel}` +
    `&position=${lng},${lat}` +
    `&limit=${encodeURIComponent('0,1')}` +
    `&datum=JGD`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`ZIPS reverse geocode error: ${res.status}`);
  }

  const json = await res.json();
  if (json.status !== 'OK') {
    throw new Error(`ZIPS reverse geocode failed: ${json.status}`);
  }

  return extractAddressResult(json);
}

/**
 * 住所クレンジング (Address cleansing/normalization)
 *
 * @param {string} word - Input address text (can be messy/partial)
 * @param {object} [config] - ZIPS_CONFIG override
 * @returns {Promise<{address: string|null, position: {lat: number, lng: number}|null, hitCount: number, raw: object}>}
 */
export async function addressCleansing(word, config = ZIPS_CONFIG) {
  if (!word || !word.trim()) {
    throw new Error('address text is empty');
  }

  const session = await getSession(config);
  const lmtinf = buildLmtinf(session.funcs, 'ac_standard');

  const baseUrl = `${API_ENDPOINTS.ZIPS_BASE}/service/ac_standard`;
  const url =
    `${baseUrl}?` +
    `zis_zips_authkey=${encodeURIComponent(session.kid)}` +
    `&zis_authtype=aid` +
    `&zis_aid=${encodeURIComponent(session.aid)}` +
    `&zis_lmtinf=${lmtinf}` +
    `&word=${encodeURIComponent(word.trim())}` +
    `&use_kana=true` +
    `&datum=JGD`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`ZIPS address cleansing error: ${res.status}`);
  }

  const json = await res.json();
  if (json.status !== 'OK') {
    throw new Error(`ZIPS address cleansing failed: ${json.status}`);
  }

  return extractAddressResult(json, 'match_position');
}
