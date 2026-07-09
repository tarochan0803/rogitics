// 道路幅の階級判定（手順5の表示層）。road_seg/width_class.py と同じ閾値・キーに揃える。
// 「4.213m」のような細かい値ではなく業務で使える階級で見せるための単一定義。

export const WIDTH_TIERS = Object.freeze([
  { key: 'ge6', label: '6m以上', min: 6.0, max: null },
  { key: 'w45_6', label: '4.5〜6m', min: 4.5, max: 6.0 },
  { key: 'w35_45', label: '3.5〜4.5m', min: 3.5, max: 4.5 },
  { key: 'lt35', label: '3.5m未満', min: 0.0, max: 3.5 }
]);

export const UNKNOWN_TIER = Object.freeze({ key: 'unknown', label: '不明', min: null, max: null });

// 階級ごとの表示色（地図帯やバッジ用）。判定結果の色とは独立。
export const TIER_COLORS = Object.freeze({
  ge6: '#2e7d32',     // 余裕
  w45_6: '#9e9d24',   // ふつう
  w35_45: '#ef6c00',  // 注意
  lt35: '#c62828',    // 狭い
  unknown: '#607d8b'  // 不明
});

export const DEFAULT_MIN_CONFIDENCE = 0.45;

// 幅[m]と信頼度から階級を返す。値なし/低信頼は unknown に倒す。
export function classifyWidth(widthM, confidence = 1.0, minConfidence = DEFAULT_MIN_CONFIDENCE) {
  const w = Number(widthM);
  if (!Number.isFinite(w)) return { ...UNKNOWN_TIER };
  if (confidence != null && Number(confidence) < minConfidence) return { ...UNKNOWN_TIER };
  for (const tier of WIDTH_TIERS) {
    const okLo = tier.min == null || w >= tier.min;
    const okHi = tier.max == null || w < tier.max;
    if (okLo && okHi) return { ...tier };
  }
  return { ...UNKNOWN_TIER };
}

export function tierColor(key) {
  return TIER_COLORS[key] || TIER_COLORS.unknown;
}
