// Phase 2: 道路幅の根拠（finalWidth と sources/confidence）を UI 向けに整形するモジュール。
// 既存の幅融合ロジック（feasibility.js）を再利用し、3D エントリで「なぜこの幅なのか」を追える形にする。
import {
  fuseWidthForFeature,
  estimateEffectiveRoadWidth,
  buildWidthFusionValidationReport
} from '../core/feasibility.js';

// 幅員ソースの内部キー → UI 表示ラベル。主採用/補助の内訳を読みやすくする。
const WIDTH_SOURCE_LABELS = {
  user_override: '手動',
  userOverrideWidth: '手動',
  width: 'OSM実測',
  'width:carriageway': 'OSM実測',
  ROADWIDTH: 'OSM実測',
  roadwidth: 'OSM実測',
  '幅員': 'OSM実測',
  '道幅': 'OSM実測',
  width_ai: 'YOLO',
  'width:ai': 'YOLO',
  ai_width: 'YOLO',
  roadwidth_ai: 'YOLO',
  gsi_width_range: 'GSI幅員',
  'lanes*width': '車線推定',
  highway_type: '種別推定'
};

export function formatWidthSource(source) {
  if (!source) return '既定';
  return WIDTH_SOURCE_LABELS[source] || source;
}

// sourceCounts 形式 { key: n } を表示ラベルで集約して { label: n } にする。
export function summarizeSourceCounts(counts = {}) {
  const out = {};
  for (const [key, n] of Object.entries(counts || {})) {
    const label = formatWidthSource(key);
    out[label] = (out[label] || 0) + n;
  }
  return out;
}

function featureIdOf(feature) {
  if (!feature) return null;
  if (feature.id != null) return String(feature.id);
  const pid = feature?.properties?.id;
  if (pid != null) return String(pid);
  return null;
}

function tagsOf(feature) {
  const props = feature?.properties && typeof feature.properties === 'object' ? feature.properties : {};
  const tags = props.tags && typeof props.tags === 'object' ? props.tags : props;
  return tags;
}

function roadName(feature) {
  const t = tagsOf(feature);
  return String(t.name || t['name:ja'] || t.ref || t.highway || '道路');
}

function hasManualOverride(feature, overrides = {}) {
  const id = featureIdOf(feature);
  if (id && overrides && overrides[id] != null) return true;
  const t = tagsOf(feature);
  return t.userOverrideWidth != null;
}

/**
 * 道路ごとの幅根拠行を作る。
 * @returns {{ id, name, highway, finalWidth, rawWidth, confidence, sources, hasOverride }[]}
 */
export function buildRoadWidthRows(roads, { defaultRoadWidth = 6, overrides = {}, limit = 200 } = {}) {
  const arr = Array.isArray(roads) ? roads : [];
  const rows = [];
  for (const f of arr) {
    const g = f?.geometry?.type;
    if (g !== 'LineString' && g !== 'MultiLineString') continue;
    const est = estimateEffectiveRoadWidth(f, { defaultRoadWidth });
    const fused = fuseWidthForFeature(f);
    rows.push({
      id: featureIdOf(f),
      name: roadName(f),
      highway: String(tagsOf(f).highway || ''),
      finalWidth: Number.isFinite(est?.value) ? Number(est.value.toFixed(2)) : null,
      rawWidth: Number.isFinite(est?.rawValue) ? Number(est.rawValue.toFixed(2)) : null,
      widthMin: Number.isFinite(Number(tagsOf(f).gsiWidthMin ?? tagsOf(f).widthMin))
        ? Number(Number(tagsOf(f).gsiWidthMin ?? tagsOf(f).widthMin).toFixed(2))
        : null,
      widthMax: Number.isFinite(Number(tagsOf(f).gsiWidthMax ?? tagsOf(f).widthMax))
        ? Number(Number(tagsOf(f).gsiWidthMax ?? tagsOf(f).widthMax).toFixed(2))
        : null,
      widthRangeLabel: String(tagsOf(f).gsiWidthLabel || ''),
      confidence: Number((fused?.confidence || 0).toFixed(2)),
      primarySource: fused?.primarySource || null,
      sources: Array.isArray(fused?.sources) ? fused.sources : [],
      hasOverride: hasManualOverride(f, overrides)
    });
  }
  // 信頼度が低い / 幅が不明なものを上に出して確認を促す
  rows.sort((a, b) => (a.confidence - b.confidence) || ((a.finalWidth || 0) - (b.finalWidth || 0)));
  return rows.slice(0, limit);
}

/**
 * 幅員の全体サマリ（coverage, 信頼度分布, source 内訳）。
 */
export function summarizeRoadWidths(roads) {
  return buildWidthFusionValidationReport(Array.isArray(roads) ? roads : []);
}

export default { buildRoadWidthRows, summarizeRoadWidths, formatWidthSource, summarizeSourceCounts };
