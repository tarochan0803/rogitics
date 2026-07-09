import { HIGHWAY_DEFAULT_WIDTH } from '../config.js';

const OSM_WIDTH_KEYS = ['width', 'width:carriageway', 'ROADWIDTH', 'roadwidth', '幅員', '道路幅'];
const AI_WIDTH_KEYS = ['width_ai', 'width:ai', 'ai_width', 'roadwidth_ai'];
const AI_WIDTH_SOURCES = new Set(AI_WIDTH_KEYS);

export const WIDTH_SOURCE_CONFIDENCE = Object.freeze({
  user_override: 1.00,
  fgd_edge: 0.88,
  width: 0.85,
  'width:carriageway': 0.85,
  ROADWIDTH: 0.85,
  roadwidth: 0.85,
  '幅員': 0.85,
  '道路幅': 0.85,
  width_ai: 0.75,
  'width:ai': 0.75,
  ai_width: 0.75,
  roadwidth_ai: 0.75,
  gsi_width_range: 0.72,
  'lanes*width': 0.70,
  highway_type: 0.60
});

const WIDTH_SOURCE_PRIORITY = Object.freeze({
  user_override: 100,
  fgd_edge: 92,
  width: 90,
  'width:carriageway': 90,
  ROADWIDTH: 90,
  roadwidth: 90,
  '幅員': 90,
  '道路幅': 90,
  width_ai: 80,
  'width:ai': 80,
  ai_width: 80,
  roadwidth_ai: 80,
  gsi_width_range: 75,
  'lanes*width': 55,
  highway_type: 30
});

const FALLBACK_SOURCE = 'highway_type';
const DERIVED_SOURCE = 'lanes*width';
const GSI_SOURCE = 'gsi_width_range';
const FGD_EDGE_SOURCE = 'fgd_edge'; // 基盤地図 道路縁からの実測級全幅（ワールドコンパイラが付与）
const OSM_MEASURED_SOURCES = new Set([...OSM_WIDTH_KEYS, FGD_EDGE_SOURCE]);

// ② 道路幅と歩道の分離
// 「道路全体幅(total)」とみなすソース。これらは歩道/駐車帯ぶんを控除して車道幅(carriageway)へ寄せる。
// OSM width / 手動上書き / YOLO(width_ai) / lanes×width は車道幅とみなし控除しない。
// FGD道路縁は edge-to-edge の全体幅なので控除対象。
const TOTAL_WIDTH_SOURCES = new Set([GSI_SOURCE, FALLBACK_SOURCE, FGD_EDGE_SOURCE]);
const SIDEWALK_DEFAULT_W = 2.0;   // 1側あたりの既定歩道幅(m)
const PARKING_DEFAULT_W = 2.2;    // 1側あたりの既定駐車帯幅(m)
const MIN_CARRIAGEWAY_M = 2.0;    // 控除後に残す車道幅の下限(m)

function sidewalkSideCount(val) {
  const v = String(val || '').toLowerCase();
  if (v === 'both') return 2;
  if (v === 'left' || v === 'right' || v === 'yes' || v === 'separate') return 1;
  return 0;
}

// OSM の sidewalk / parking:lane タグから「総幅から差し引く控除量(m)」を見積もる。
// タグが無ければ 0（タグ無し道は従来どおり＝退行させない）。
function parseSidewalkDeduction(tags) {
  let deductM = 0;
  const notes = [];

  const swSides = sidewalkSideCount(tags.sidewalk);
  if (swSides > 0) {
    const wBoth = finiteWidth(tags['sidewalk:both:width']);
    const wL = finiteWidth(tags['sidewalk:left:width']);
    const wR = finiteWidth(tags['sidewalk:right:width']);
    const wGen = finiteWidth(tags['sidewalk:width']);
    let sw;
    if (wBoth != null) sw = wBoth * 2;
    else if (wL != null || wR != null) sw = (wL ?? SIDEWALK_DEFAULT_W) + (wR ?? (swSides >= 2 ? SIDEWALK_DEFAULT_W : 0));
    else if (wGen != null) sw = wGen * swSides;
    else sw = SIDEWALK_DEFAULT_W * swSides;
    deductM += sw;
    notes.push('sidewalk');
  }

  for (const side of ['both', 'left', 'right']) {
    const pk = String(tags[`parking:lane:${side}`] ?? '').toLowerCase();
    if (pk && pk !== 'no' && pk !== 'none' && pk !== 'separate') {
      const mult = side === 'both' ? 2 : 1;
      const w = finiteWidth(tags[`parking:lane:${side}:width`]) || PARKING_DEFAULT_W;
      deductM += w * mult;
      notes.push(`parking:${side}`);
    }
  }

  return { deductM: Math.max(0, deductM), notes };
}

export function parseWidthMetersFromTag(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const str = String(value).trim().toLowerCase();
  const feetInch = str.match(/^(\d+)'\s*(\d+)?\"?$/);
  if (feetInch) {
    const ft = parseFloat(feetInch[1]);
    const inch = parseFloat(feetInch[2] || '0');
    return ft * 0.3048 + inch * 0.0254;
  }
  const meters = str.match(/([0-9]+\.?[0-9]*)\s*m/);
  if (meters) return parseFloat(meters[1]);
  const n = parseFloat(str);
  return Number.isNaN(n) ? null : n;
}

function tagsOf(featureOrTags) {
  if (!featureOrTags || typeof featureOrTags !== 'object') return {};
  if (featureOrTags.type === 'Feature' || featureOrTags.properties) {
    const props = featureOrTags.properties && typeof featureOrTags.properties === 'object'
      ? featureOrTags.properties
      : {};
    return props.tags && typeof props.tags === 'object' ? props.tags : props;
  }
  return featureOrTags;
}

function finiteWidth(value) {
  const n = typeof value === 'string' ? parseWidthMetersFromTag(value) : Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function clampConfidence(value, fallback, { lo = 0.2, hi = 0.97 } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

function confidenceFromTags(tags, keys, fallback) {
  for (const key of keys) {
    if (tags[key] == null) continue;
    return clampConfidence(tags[key], fallback);
  }
  return fallback;
}

function sample(source, value, confidence, extra = {}) {
  return {
    value,
    source,
    confidence,
    priority: WIDTH_SOURCE_PRIORITY[source] || 0,
    ...extra
  };
}

function gsiWidthSample(tags = {}) {
  if (!tags) return null;
  const estimate = finiteWidth(tags.gsiWidthEstimate ?? tags.widthEstimate);
  const min = finiteWidth(tags.gsiWidthMin ?? tags.widthMin);
  const max = finiteWidth(tags.gsiWidthMax ?? tags.widthMax);
  const value = estimate ?? min ?? max;
  if (!Number.isFinite(value) || value <= 0) return null;
  const confidence = clampConfidence(
    tags.gsiWidthConfidence ?? tags.widthConfidence,
    min != null || max != null ? 0.72 : 0.55,
    { lo: 0.2, hi: 0.85 }
  );
  return sample(GSI_SOURCE, value, confidence, { min, max });
}

function percentile(values, p) {
  const arr = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!arr.length) return null;
  if (arr.length === 1) return arr[0];
  const pos = Math.max(0, Math.min(1, p)) * (arr.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return arr[lo];
  const t = pos - lo;
  return arr[lo] + (arr[hi] - arr[lo]) * t;
}

function sortByAuthority(a, b) {
  return (b.priority - a.priority) || (b.confidence - a.confidence) || (a.value - b.value);
}

export function collectWidthSamplesFromTags(tagsInput = {}, sidewalk = null) {
  const tags = tagsOf(tagsInput);
  const deductM = Math.max(0, Number((sidewalk || parseSidewalkDeduction(tags)).deductM) || 0);
  const samples = [];

  for (const key of ['userOverrideWidth', 'manualWidth', 'overrideWidth', 'width_override']) {
    const w = finiteWidth(tags[key]);
    if (w != null) {
      samples.push(sample('user_override', w, WIDTH_SOURCE_CONFIDENCE.user_override));
      break;
    }
  }

  const fgdW = finiteWidth(tags.fgdWidthM ?? tags.fgd_width);
  if (fgdW != null) {
    const c = clampConfidence(tags.fgdWidthConfidence, WIDTH_SOURCE_CONFIDENCE[FGD_EDGE_SOURCE]);
    samples.push(sample(FGD_EDGE_SOURCE, fgdW, c));
  }

  for (const key of OSM_WIDTH_KEYS) {
    const w = finiteWidth(tags[key]);
    if (w != null) {
      samples.push(sample(key, w, WIDTH_SOURCE_CONFIDENCE[key] || WIDTH_SOURCE_CONFIDENCE.width));
      break;
    }
  }

  for (const key of AI_WIDTH_KEYS) {
    const w = finiteWidth(tags[key]);
    if (w != null) {
      const c = confidenceFromTags(tags, [
        `${key}_confidence`,
        `${key}:confidence`,
        `${key}_conf`,
        'widthAiConfidence',
        'width_ai_confidence',
        'roadWidthAiConfidence'
      ], WIDTH_SOURCE_CONFIDENCE[key] || WIDTH_SOURCE_CONFIDENCE.width_ai);
      samples.push(sample(key, w, c));
      break;
    }
  }

  const gsi = gsiWidthSample(tags);
  if (gsi) samples.push(gsi);

  const lanes = parseInt(tags.lanes, 10);
  if (!Number.isNaN(lanes) && lanes > 0) {
    const laneW = finiteWidth(tags['lanes:width']) || 3.0;
    samples.push(sample(DERIVED_SOURCE, lanes * laneW, WIDTH_SOURCE_CONFIDENCE[DERIVED_SOURCE]));
  }

  const highway = String(tags.highway || '').toLowerCase();
  if (highway && HIGHWAY_DEFAULT_WIDTH[highway]) {
    samples.push(sample(FALLBACK_SOURCE, HIGHWAY_DEFAULT_WIDTH[highway], WIDTH_SOURCE_CONFIDENCE.highway_type));
  }

  // ② 総幅ソース（GSI/highway既定）から歩道・駐車帯ぶんを控除して車道幅へ寄せる。
  // 控除0（タグ無し）なら従来どおり。車道幅ソースは控除しない。
  return samples.map((s) => {
    if (deductM > 0 && TOTAL_WIDTH_SOURCES.has(s.source)) {
      // 過剰控除を防ぐ: 控除しても総幅の 40%（かつ MIN_CARRIAGEWAY_M）は車道として残す。
      // 歩道幅が未指定で既定値を使う場合に、狭く誤判定（通れるのに不可）へ倒れすぎないため。
      const floor = Math.max(MIN_CARRIAGEWAY_M, s.value * 0.4);
      const carriageway = Math.max(floor, s.value - deductM);
      const appliedDeduct = s.value - carriageway;
      return { ...s, value: carriageway, totalValueM: s.value, sidewalkDeductM: appliedDeduct, widthKind: 'carriageway' };
    }
    return { ...s, widthKind: 'carriageway' };
  });
}

function pickFusionSamples(samples) {
  const manual = samples.find((s) => s.source === 'user_override');
  if (manual) return { primary: manual, used: [manual], policy: 'manual' };

  // OSM width tags are measured/declared road data. Lower-confidence perception
  // or range estimates must not shrink or overwrite them.
  const measured = samples.filter((s) => OSM_MEASURED_SOURCES.has(s.source));
  if (measured.length) {
    return { primary: [...measured].sort(sortByAuthority)[0], used: measured, policy: 'osm_measured' };
  }

  const ai = samples.filter((s) => AI_WIDTH_SOURCES.has(s.source));
  if (ai.length) {
    const primary = [...ai].sort(sortByAuthority)[0];
    return { primary, used: [primary], policy: 'ai_perception' };
  }

  const evidence = samples.filter((s) => s.source !== FALLBACK_SOURCE && s.source !== DERIVED_SOURCE);
  if (evidence.length) {
    return { primary: [...evidence].sort(sortByAuthority)[0], used: evidence, policy: 'evidence_low_percentile' };
  }

  const range = samples.filter((s) => s.source === GSI_SOURCE);
  if (range.length) {
    return { primary: [...range].sort(sortByAuthority)[0], used: range, policy: 'gsi_range' };
  }

  const derived = samples.filter((s) => s.source === DERIVED_SOURCE);
  if (derived.length) {
    return { primary: derived[0], used: derived, policy: 'derived_lanes' };
  }

  const fallback = samples.filter((s) => s.source === FALLBACK_SOURCE);
  return { primary: fallback[0] || null, used: fallback, policy: 'fallback_highway' };
}

function aggregateConfidence(primary, used, spreadRatio) {
  if (!primary) return 0;
  if (primary.source === 'user_override') return 1;
  const support = Math.min(0.14, Math.max(0, used.length - 1) * 0.045);
  const conflictPenalty = Math.min(0.28, Math.max(0, spreadRatio - 0.08) * 0.75);
  return Math.max(0.2, Math.min(1, primary.confidence + support - conflictPenalty));
}

export function fuseWidthFromSamples(inputSamples = []) {
  const samples = (Array.isArray(inputSamples) ? inputSamples : [])
    .filter((s) => Number.isFinite(Number(s?.value)) && Number(s.value) > 0)
    .map((s) => ({
      ...s,
      value: Number(s.value),
      confidence: clampConfidence(s.confidence, WIDTH_SOURCE_CONFIDENCE[s.source] || 0.5),
      priority: Number.isFinite(Number(s.priority)) ? Number(s.priority) : (WIDTH_SOURCE_PRIORITY[s.source] || 0)
    }));

  if (!samples.length) {
    return { value: null, primarySource: null, sources: [], confidence: 0, samples: [], fusionPolicy: 'none' };
  }

  const { primary, used, policy } = pickFusionSamples(samples);
  if (!primary) {
    return { value: null, primarySource: null, sources: [], confidence: 0, samples, fusionPolicy: 'none' };
  }

  if (policy === 'manual') {
    return {
      value: primary.value,
      primarySource: primary.source,
      sources: [primary.source],
      confidence: 1,
      samples,
      usedSamples: [primary],
      fusionPolicy: policy,
      disagreement: 0
    };
  }

  const values = used.map((s) => s.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const spread = Math.max(0, max - min);
  const spreadRatio = spread / Math.max(1, primary.value);
  const lowP = percentile(values, 0.25);
  const candidate = Number.isFinite(lowP) ? Math.min(primary.value, lowP) : primary.value;

  return {
    value: candidate,
    primarySource: primary.source,
    sources: used.map((s) => s.source),
    confidence: aggregateConfidence(primary, used, spreadRatio),
    samples,
    usedSamples: used,
    fusionPolicy: policy,
    disagreement: spread
  };
}

export function fuseWidthFromTags(tags = {}) {
  const t = tagsOf(tags);
  const sidewalk = parseSidewalkDeduction(t);
  const fused = fuseWidthFromSamples(collectWidthSamplesFromTags(t, sidewalk));
  // ② 診断/UI 用に分離値を添える（判定で使うのは fused.value=車道幅相当）。
  fused.sidewalkWidthM = sidewalk.deductM || 0;
  const primarySample = fused.usedSamples?.find((s) => s.source === fused.primarySource);
  fused.totalWidthM = Number.isFinite(Number(primarySample?.totalValueM))
    ? Number(primarySample.totalValueM)
    : (Number.isFinite(Number(fused.value)) ? Number(fused.value) + (sidewalk.deductM || 0) : null);
  fused.carriagewayWidthM = fused.value;
  return fused;
}

export function fuseWidthForFeature(feature) {
  return fuseWidthFromTags(tagsOf(feature));
}

export function estimateWidthFromTags(tags = {}) {
  const fused = fuseWidthFromTags(tags);
  return {
    value: fused.value,
    source: fused.primarySource,
    sources: fused.sources,
    confidence: fused.confidence,
    samples: fused.samples,
    fusionPolicy: fused.fusionPolicy,
    disagreement: fused.disagreement,
    sidewalkWidthM: fused.sidewalkWidthM ?? 0,
    totalWidthM: fused.totalWidthM ?? null,
    carriagewayWidthM: fused.carriagewayWidthM ?? fused.value
  };
}

export function estimateWidthForFeature(feature) {
  return estimateWidthFromTags(tagsOf(feature));
}
