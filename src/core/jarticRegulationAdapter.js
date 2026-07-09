// =============================================================================
// JARTIC / xROAD 規制アダプタ（外部・公的規制データの「口」）
// -----------------------------------------------------------------------------
// 役割: JARTIC（日本道路交通情報センター）/ xROAD（国交省データプラットフォーム）等の
//       公的な交通規制レコードを、既存の規制モデル（regulationModel.js）が扱える
//       正規化済み regulation に変換する。OSM アダプタ（osmRegulationAdapter.js）と
//       同じ出力契約なので、assessRegulationsForRoute にそのまま流せる。
//
// このファイルは「口」。実際の API 取得（fetch/認証/座標系変換）は将来差し込む。
//   - registerExternalRegulationFetcher(source, fn) で取得関数を登録
//   - fetchExternalRegulations({bbox, routeLL}) が登録済み fetcher を呼び→正規化→キャッシュ
//   - 取得関数が未登録なら何もしない（[] を返す）ので、配線しても既存挙動は不変。
//
// 入力レコードの想定形（fetcher が返す 1 件）: ※全部任意。最低限 geometry と種別が要る
//   {
//     id?,                         // ソース側ID（あれば sourceFeatureId に入る）
//     kind | type | 規制種別 | name | raw,   // 規制種別（日本語ラベル可 or REGULATION_TYPES 値）
//     geometry,                    // GeoJSON LineString/MultiLineString/Point（規制区間/地点）
//     meters | tons | limit | value:{meters,tons,raw}, // 寸法/重量制限の数値
//     direction,                   // 一方通行の向き 'forward'|'reverse'（'逆'等も可）
//     schedule | 時間規制,          // 時間帯規制の生データ
//     conditional?, confidence?, authority?, updatedAt?, source?
//   }
//   GeoJSON Feature をそのまま渡してもよい（properties を読みに行く）。
// =============================================================================

import {
  REGULATION_SEVERITY,
  REGULATION_TYPES,
  normalizeRegulation,
  parseMetersFromValue,
  parseTonsFromValue
} from './regulationModel.js';

export const EXTERNAL_REGULATION_SOURCES = Object.freeze({
  JARTIC: 'jartic',
  XROAD: 'xroad'
});

// 公的データは OSM より信頼度を高く扱う（applyWidthRisk 等の保守化と整合）
const SOURCE_DEFAULTS = {
  jartic: { authority: 'JARTIC', confidence: 0.9 },
  xroad: { authority: 'xROAD/MLIT', confidence: 0.85 }
};
const FALLBACK_CONFIDENCE = 0.8;

const KNOWN_TYPES = new Set(Object.values(REGULATION_TYPES));

function lower(value) {
  return String(value ?? '').trim().toLowerCase();
}

function firstFinite(...values) {
  for (const v of values) {
    if (v == null || v === '') continue; // Number(null)===0 / Number('')===0 を弾く
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function asArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (value.type === 'FeatureCollection') return Array.isArray(value.features) ? value.features : [];
  if (value.records && Array.isArray(value.records)) return value.records;
  return [value];
}

// GeoJSON Feature を素のレコード（properties + geometry）に展開
function unwrapRecord(rawRecord) {
  if (rawRecord && rawRecord.type === 'Feature') {
    const props = rawRecord.properties || {};
    return {
      ...props,
      geometry: rawRecord.geometry,
      id: rawRecord.id ?? props.id ?? props['@id'] ?? null
    };
  }
  return rawRecord;
}

function pickKindText(record) {
  return String(
    record.kind ?? record.regulationType ?? record['規制種別'] ?? record.kisei ??
    record.name ?? record.label ?? record.raw ?? ''
  );
}

// 規制種別 → REGULATION_TYPES。明示 type が既知ならそれを採用、無ければ日本語ラベルから推定。
function resolveType(record) {
  const explicit = lower(record.type);
  if (KNOWN_TYPES.has(explicit)) return explicit;
  const text = pickKindText(record);
  if (!text) return null;
  if (/高さ|最大高|height/i.test(text)) return REGULATION_TYPES.MAX_HEIGHT;
  if (/幅員|車幅|最大幅|幅制限|width/i.test(text)) return REGULATION_TYPES.MAX_WIDTH;
  if (/重量|総重量|重さ|weight/i.test(text)) return REGULATION_TYPES.MAX_WEIGHT;
  if (/一方通行|oneway/i.test(text)) return REGULATION_TYPES.ONEWAY;
  if (/指定方向外|右折|左折|転回|uターン|turn/i.test(text)) return REGULATION_TYPES.TURN_RESTRICTION;
  // 大型・貨物系の通行止めはトラック禁止として扱う
  if (/(大型|貨物|トラック|hgv|truck)/i.test(text) && /(通行止|通行禁止|進入禁止|禁止)/.test(text)) {
    return REGULATION_TYPES.NO_TRUCK;
  }
  if (/通行止|車両通行止|車両進入禁止|進入禁止|通行禁止|閉鎖|closed|no\s*entry/i.test(text)) {
    return REGULATION_TYPES.ACCESS;
  }
  if (/時間|時間帯|曜日|time/i.test(text)) return REGULATION_TYPES.TIME_RESTRICTION;
  return null;
}

const PERMIT_LIKE_RE = /許可|関係者|指定車|沿道|地元|destination|private|permit|delivery/i;

// 種別ごとに value を組み立てる。ok=false は「評価に必要な値が取れず採用しない」。
function buildValue(record, type) {
  const raw = pickKindText(record) || (record.value && record.value.raw) || null;
  switch (type) {
    case REGULATION_TYPES.MAX_HEIGHT:
    case REGULATION_TYPES.MAX_WIDTH: {
      const meters = firstFinite(
        record.meters, record.value?.meters, record.limit,
        parseMetersFromValue(record.value?.raw), parseMetersFromValue(raw)
      );
      return { value: { meters: meters ?? null, raw }, ok: meters != null };
    }
    case REGULATION_TYPES.MAX_WEIGHT: {
      const tons = firstFinite(
        record.tons, record.value?.tons, record.limit,
        parseTonsFromValue(record.value?.raw), parseTonsFromValue(raw)
      );
      return { value: { tons: tons ?? null, raw }, ok: tons != null };
    }
    case REGULATION_TYPES.ACCESS: {
      // 全面通行止め=no(BLOCK) / 許可車のみ等=destination(要許可)
      const permitLike = PERMIT_LIKE_RE.test(raw || '');
      return { value: { raw: permitLike ? 'destination' : 'no' }, ok: true };
    }
    case REGULATION_TYPES.NO_TRUCK: {
      const permitLike = PERMIT_LIKE_RE.test(raw || '');
      // '' → evaluateRegulation で truck_forbidden(BLOCK)
      return { value: { raw: permitLike ? 'destination' : '' }, ok: true };
    }
    case REGULATION_TYPES.ONEWAY:
      return { value: { raw: raw || 'oneway' }, ok: true };
    case REGULATION_TYPES.TIME_RESTRICTION:
    case REGULATION_TYPES.TURN_RESTRICTION:
    default:
      return { value: { raw }, ok: true };
  }
}

function defaultSeverityFor(type) {
  switch (type) {
    case REGULATION_TYPES.ACCESS:
    case REGULATION_TYPES.NO_TRUCK:
      return REGULATION_SEVERITY.BLOCK;
    case REGULATION_TYPES.TIME_RESTRICTION:
      return REGULATION_SEVERITY.WARNING;
    default:
      return REGULATION_SEVERITY.INFO;
  }
}

// ---- geometry を規制マッチ可能な形へ ----------------------------------------
// regulationModel の経路マッチは LineString/MultiLineString のみ対応。
// 規制「地点」(Point) は微小セグメントへ変換し、経路がその点の近傍を通るか測れるようにする。
function tinySeg(coord) {
  if (!Array.isArray(coord) || coord.length < 2) return null;
  const lng = Number(coord[0]);
  const lat = Number(coord[1]);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  const e = 1e-6; // 約0.1m。距離計算用にセグメントを成立させるだけ
  return [[lng, lat], [lng + e, lat]];
}

function normalizeGeometryForMatching(geometry) {
  if (!geometry) return null;
  if (geometry.type === 'Feature') return normalizeGeometryForMatching(geometry.geometry);
  if (geometry.type === 'LineString' || geometry.type === 'MultiLineString') return geometry;
  if (geometry.type === 'Point') {
    const seg = tinySeg(geometry.coordinates);
    return seg ? { type: 'LineString', coordinates: seg } : null;
  }
  if (geometry.type === 'MultiPoint') {
    const segs = (geometry.coordinates || []).map(tinySeg).filter(Boolean);
    return segs.length ? { type: 'MultiLineString', coordinates: segs } : null;
  }
  if (geometry.type === 'GeometryCollection') {
    const coords = [];
    for (const g of geometry.geometries || []) {
      const n = normalizeGeometryForMatching(g);
      if (!n) continue;
      if (n.type === 'LineString') coords.push(n.coordinates);
      else if (n.type === 'MultiLineString') coords.push(...n.coordinates);
    }
    return coords.length ? { type: 'MultiLineString', coordinates: coords } : null;
  }
  return null;
}

// =============================================================================
// 1 レコード → 正規化 regulation（採用不可なら null）
// =============================================================================
export function regulationFromExternalRecord(rawRecord, opts = {}) {
  const record = unwrapRecord(rawRecord);
  if (!record) return null;

  const geometry = normalizeGeometryForMatching(record.geometry || record.geom || null);
  if (!geometry) return null;

  const type = resolveType(record);
  if (!type) return null;

  const { value, ok } = buildValue(record, type);
  if (!ok) return null; // 例: 寸法制限なのに数値が取れない → 評価できないので捨てる

  const source = lower(record.source) || lower(opts.source) || 'external';
  const def = SOURCE_DEFAULTS[source] || {};
  const confidence = firstFinite(record.confidence, opts.confidence, def.confidence, FALLBACK_CONFIDENCE);
  const conditional = !!record.conditional || type === REGULATION_TYPES.TIME_RESTRICTION;

  let direction = null;
  if (type === REGULATION_TYPES.ONEWAY) {
    const d = lower(record.direction);
    direction = (d === 'reverse' || d === '-1' || d === '逆' || d === '逆方向') ? 'reverse' : 'forward';
  }

  return normalizeRegulation({
    // IDなしレコードは normalizeRegulation の stableRegulationId（内容ハッシュ）に任せる。
    // 乱数fallbackは判定ログ・golden・リプレイの再現性を壊すため禁止。
    id: record.id != null && record.id !== '' ? `${source}:${record.id}` : undefined,
    type,
    geometry,
    source,
    sourceFeatureId: record.id != null && record.id !== '' ? String(record.id) : null,
    authority: record.authority || opts.authority || def.authority || source,
    confidence,
    conditional,
    direction,
    value,
    schedule: record.schedule || record['時間規制'] || null,
    severity: defaultSeverityFor(type),
    updatedAt: record.updatedAt || record.updated || null,
    evidence: { kind: pickKindText(record) || null, raw: value.raw ?? null }
  });
}

// =============================================================================
// レコード配列 → 正規化 regulation レイヤ
// =============================================================================
export function buildExternalRegulationLayer(records = [], opts = {}) {
  return asArray(records)
    .map((r) => regulationFromExternalRecord(r, opts))
    .filter(Boolean);
}

export function buildJarticRegulationLayer(records = []) {
  return buildExternalRegulationLayer(records, {
    source: EXTERNAL_REGULATION_SOURCES.JARTIC,
    ...SOURCE_DEFAULTS.jartic
  });
}

export function buildXroadRegulationLayer(records = []) {
  return buildExternalRegulationLayer(records, {
    source: EXTERNAL_REGULATION_SOURCES.XROAD,
    ...SOURCE_DEFAULTS.xroad
  });
}

// 複数ソースのレイヤを id 重複排除しつつ結合
export function mergeRegulationLayers(...layers) {
  const seen = new Set();
  const out = [];
  for (const layer of layers) {
    for (const reg of asArray(layer)) {
      if (!reg) continue;
      const key = reg.id || `${reg.source}:${reg.type}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(reg);
    }
  }
  return out;
}

// =============================================================================
// 取得「口」: fetcher 登録レジストリ + 現在有効な外部規制キャッシュ
// -----------------------------------------------------------------------------
// 実 API（JARTIC/xROAD）を叩く取得関数をここに登録すれば、判定パイプライン全体に
// 外部規制が流れる。未登録なら getActiveExternalRegulations() は [] のまま。
// =============================================================================
const fetchers = new Map(); // source -> async ({bbox, routeLL, signal}) => records[]
let activeExternalRegulations = [];

export function registerExternalRegulationFetcher(source, fn) {
  if (typeof fn !== 'function') throw new Error('fetcher must be a function');
  fetchers.set(lower(source), fn);
}

export function hasRegulationFetcher(source) {
  return fetchers.has(lower(source));
}

export function getRegisteredRegulationSources() {
  return [...fetchers.keys()];
}

// 判定時に同期で読む「現在有効な外部規制」（既に正規化済みの regulation 配列）
export function setActiveExternalRegulations(regs) {
  activeExternalRegulations = asArray(regs).filter(Boolean);
  return activeExternalRegulations.length;
}

export function getActiveExternalRegulations() {
  return activeExternalRegulations.slice();
}

export function clearActiveExternalRegulations() {
  activeExternalRegulations = [];
}

// 登録済み fetcher を呼んで規制を取得→正規化→マージ→キャッシュ更新。戻り値は正規化レイヤ。
export async function fetchExternalRegulations({ bbox, routeLL, sources, signal } = {}) {
  const wanted = (Array.isArray(sources) && sources.length ? sources : getRegisteredRegulationSources())
    .map(lower);
  const collected = [];
  for (const source of wanted) {
    const fn = fetchers.get(source);
    if (!fn) continue;
    try {
      const records = await fn({ bbox, routeLL, signal });
      collected.push(...buildExternalRegulationLayer(records, { source, ...(SOURCE_DEFAULTS[source] || {}) }));
    } catch (err) {
      if (typeof console !== 'undefined') console.warn(`[regulation] fetcher "${source}" failed:`, err);
    }
  }
  const merged = mergeRegulationLayers(collected);
  setActiveExternalRegulations(merged);
  return merged;
}

// ブラウザでの目視検証/手動注入用のデバッグハンドル。
// 例: NCN_REGULATION.setExternal([{kind:'大型貨物等通行止', geometry:{type:'LineString',coordinates:[[139.7,35.6],[139.71,35.6]]}}])
//     のあと、もう一度ルート生成/搬入判定を実行すると候補カードと2D規制点に反映される。
if (typeof window !== 'undefined') {
  window.NCN_REGULATION = window.NCN_REGULATION || {};
  Object.assign(window.NCN_REGULATION, {
    setExternal: (records, opts = {}) =>
      setActiveExternalRegulations(buildExternalRegulationLayer(records, opts)),
    setJartic: (records) => setActiveExternalRegulations(buildJarticRegulationLayer(records)),
    setXroad: (records) => setActiveExternalRegulations(buildXroadRegulationLayer(records)),
    get: getActiveExternalRegulations,
    clear: clearActiveExternalRegulations,
    registerFetcher: registerExternalRegulationFetcher,
    fetch: fetchExternalRegulations,
    sources: getRegisteredRegulationSources
  });
}
