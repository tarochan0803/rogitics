// ゼンリン ZIPS WebAPI 地番変換（地番 → 住所 + 座標）。
//
// 「ＮＣＮ Ｗｅｂ住所検索システムv2.html」の地番住所変換機能を抜き出したもの。
// ブラウザから api.zip-site.com へ直接アクセスする方式（login → 機能検索 → 変換 → logout）。
//
// 注意:
// - 地図描画はローダー読込ごとに 1PV、地番住所変換は 1リクエストあたり 2PV を消費する。
//   契約は 10,000PV/月。多用するとすぐ上限に達するので連打しないこと。
// - 認証情報はクライアントに露出する（元の社内ツールと同条件）。公開配布する場合は
//   サーバ側プロキシ化を検討する。window.ZENRIN_ZIPS_CONFIG で上書き可能。

const DEFAULT_CONFIG = {
  baseUrl: 'https://api.zip-site.com/api',
  userId: '2Ec5mMed',
  password: 'qQE2Y2ze',
  serviceId: '50000001',
  deviceFlag: '1'
};

// 機能コード表（元ファイルの Func_Data より）。[name, FUNC_ID, FUNC_SUBID, 説明]
const FUNC_DATA = [
  ['address', '0002', '0001', '住所検索'],
  ['bm_address', '0002', '0007', 'premium 地番検索'],
  ['bluemap_to_address', '0002', '0027', 'premium 地番住所変換'],
  ['address_to_bluemap', '0002', '0022', 'premium 住所地番変換'],
  ['ac_standard', '0004', '0001', '住所クレンジング（標準）'],
  ['ac_premium', '0004', '0003', 'premium 住所クレンジング（高機能）'],
  ['bluemap_cleansing', '0004', '0005', 'premium 地番クレンジング']
];

function getConfig() {
  const override = (typeof window !== 'undefined' && window.ZENRIN_ZIPS_CONFIG) || {};
  return { ...DEFAULT_CONFIG, ...override };
}

// ログインして kid / aid と利用可能機能一覧を取得する。
async function login(cfg) {
  const url = `${cfg.baseUrl}/auth/login`
    + `?user_id=${encodeURIComponent(cfg.userId)}`
    + `&password=${encodeURIComponent(cfg.password)}`
    + `&service_id=${encodeURIComponent(cfg.serviceId)}`
    + `&device_flag=${encodeURIComponent(cfg.deviceFlag)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ZIPS login HTTP ${res.status}`);
  const json = await res.json();
  if (json?.status?.code !== '10100000') {
    throw new Error(`ZIPS login failed: ${json?.status?.code || 'unknown'}`);
  }
  return {
    kid: json.result.kid,
    aid: json.result.aid,
    funcs: json.result.items.func
  };
}

// ログアウト（PV節約のため成否は致命扱いしない）。
async function logout(cfg, aid) {
  try {
    await fetch(`${cfg.baseUrl}/auth/logout?aid=${encodeURIComponent(aid)}`);
  } catch (e) {
    console.warn('[zenrinChiban] logout failed (ignored):', e?.message || e);
  }
}

// 機能名から lmtinf（areaCode,funcInfo）を組み立てる。
function buildLmtinf(funcs, funcName) {
  const meta = FUNC_DATA.find((f) => f[0] === funcName);
  if (!meta) throw new Error(`unknown ZIPS func: ${funcName}`);
  const func = (funcs || []).find((el) => el.id === meta[1] && el.subid === meta[2]);
  if (!func) throw new Error(`ZIPS func not licensed: ${funcName}`);
  return `${func.areaCode},${func.funcInfo}`;
}

/**
 * 地番 → 住所 + 座標 変換（bluemap_to_address）。
 * @param {string} chiban 例: "東京都港区芝浦三丁目1番1号"
 * @returns {Promise<{address: string|null, lat: number|null, lng: number|null, hit: boolean, raw: object}>}
 */
export async function chibanToAddress(chiban) {
  const query = String(chiban || '').trim();
  if (!query) throw new Error('地番が空です');

  const cfg = getConfig();
  const session = await login(cfg);
  try {
    const lmtinf = buildLmtinf(session.funcs, 'bluemap_to_address');
    const url = `${cfg.baseUrl}/zips/general/bluemap_to_address`
      + `?zis_zips_authkey=${encodeURIComponent(session.kid)}`
      + `&zis_authtype=aid`
      + `&zis_aid=${encodeURIComponent(session.aid)}`
      + `&zis_lmtinf=${encodeURIComponent(lmtinf)}`
      + `&bluemap_address=${encodeURIComponent(query)}`
      + `&datum=JGD`;

    const res = await fetch(url);
    if (!res.ok) throw new Error(`ZIPS bluemap_to_address HTTP ${res.status}`);
    const json = await res.json();
    if (json.status !== 'OK') throw new Error(`ZIPS変換エラー: ${json.status}`);

    const item = json?.result?.item?.[0];
    const addr = item?.address;
    // 該当なしの場合、address は null（元ファイルと同じ判定）。
    if (!addr || addr[0] == null) {
      return { address: null, lat: null, lng: null, hit: false, raw: json };
    }
    const first = addr[0];
    const pos = first.position; // [lng, lat]
    return {
      address: first.address ?? null,
      lat: Array.isArray(pos) ? Number(pos[1]) : null,
      lng: Array.isArray(pos) ? Number(pos[0]) : null,
      hit: true,
      raw: json
    };
  } finally {
    await logout(cfg, session.aid);
  }
}
