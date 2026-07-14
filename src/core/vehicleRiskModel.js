// 通行リスクモデル（vehicleRiskModel）
// -----------------------------------------------------------------------------
// 「道路幅の不確かさ(confidence) → 通行判定 → 自律走行判断」を 1 本で扱うための
// 共通モジュール。幅推定で作られた confidence を下流（判定マージン・自律走行速度・
// 車高クリアランス・カーブ速度）へ一元的に伝播させる単一の真実源。
//
// 設計方針:
//  - 物流車両は「狭いかもしれない道」を甘く見ない。信頼度が低いほど保守的（下振れ）に倒す。
//  - すべての係数は RISK_TUNING に集約し、ここを動かせば判定/走行/表示が連動して変わる。
//  - 後段（②幅融合の保守化 / ③旋回半径ベースのカーブ速度 / ④判定と走行の envelope 統一 /
//    ⑤recovery の横オフセット連動）も、この場所に足していけるようにしておく。

export const RISK_TUNING = Object.freeze({
  // 幅信頼度 → 有効道路幅スケール（保守側=下振れ）。
  //  - 非strict: 高信頼ほぼ等倍。低信頼で緩やかに縮小（既存判定をほぼ崩さず confidence を効かせる）。
  //  - strict  : 旧 estimateEffectiveRoadWidth の 0.85〜0.98 をそのまま踏襲。
  width: {
    softFloor: 0.92,   // 非strict: confidence=0 のときの最小スケール
    softCeil: 1.00,    // 非strict: confidence=1 のときのスケール
    strictFloor: 0.85, // strict: confidence=0
    strictCeil: 0.98,  // strict: confidence=1
    minValue: 2.0      // 有効幅の下限(m)。極端な縮小を防ぐ
  },
  // 幅信頼度 → 判定マージン上乗せ(m)。車両クラス別マージンに加算する用途。
  // ※ 現状は width スケールで保守化しているため二重計上回避で判定側未配線。
  //   recovery 横オフセット(⑤) や HUD 表示など、別軸で使うために用意。
  margin: {
    atZeroConf: 0.40,  // confidence=0 で +0.40m
    atFullConf: 0.00   // confidence=1 で +0.00m
  },
  // 幅信頼度 → 自律走行速度係数。低信頼の道では速度を落として「不確かなら慎重に」を実装。
  speed: {
    minFactor: 0.55,   // confidence=0 のときの速度係数
    fullFactor: 1.00   // confidence=1 のときの速度係数
  },
  // 建物高さソース信頼度 → 車高クリアランス(m)。feasibility.js の heightClearanceFor と統一。
  height: {
    measured: 0.25,    // OSM height/h 等の実測タグ
    levels: 0.50,      // building:levels からの推定
    estimated: 1.00    // DEM/フォールバック等の推定
  },
  // ③用: 旋回半径ベースのカーブ速度上限。横加速度上限から v=sqrt(a*R)。
  curve: {
    lateralAccelMS2: 1.2, // 許容横加速度(m/s^2)。物流車両は低めに。
    minSpeedMS: 1.0       // カーブでも完全停止はしない下限速度(m/s)
  },
  // 有効道路幅と車幅の余裕(m) → 速度係数。余裕が薄い狭幅路はカーブで車体角が
  // 道路帯からはみ出す（Safety Monitor違反になる）ため、planner側で先に落とす。
  narrowWidth: {
    stopMarginM: 0.30,  // 片側合計の余裕がこれ以下 → 進入不可（STOP相当=係数0）
    crawlMarginM: 0.90, // これ以下で徐行係数へ線形移行
    crawlFactor: 0.45,  // 徐行時の速度係数
    curveSwingMaxM: 3.0,
    // 実測較正(i-6267): 乗数1.0はコーナー実掃引を過小評価し、turn53°/余裕1.15mの
    // 「どのゲートにも掛からない隙間」で逸脱した → 下限1.5へ
    curveSwingWidthMultiplier: 1.5,
    curveSwingWidthMultiplierMax: 2.0,
    curveSwingMultiplierMinLfM: 4.0,
    curveSwingMultiplierMaxLfM: 8.0,
    switchbackTurnDeg: 45,
    // スイング超過コーナーへの接近徐行係数。0.18は体感「遅すぎ」だったため0.35へ
    // （切り返しK-turnが入ったので、徐行で無理に通す前提が不要になった）。
    curveSwingSoftCrawlFactor: 0.35
  },
  // 勾配(%) → 自律走行速度係数。ワールドコンパイラが道路へ焼き込む
  // demGradeMedianPct/demGradeMaxPct を減速に変換する（登坂トルク・降坂制動の保守化）。
  grade: {
    flatPct: 3.0,      // ここまでは平坦扱い（係数1.0）
    steepPct: 12.0,    // ここで minFactor に到達（それ以上も minFactor で頭打ち）
    minFactor: 0.60    // 急勾配での速度係数下限
  },
  // 縦方向動力学（勾配・路面摩擦・積載を反映した制動/加速）の係数。単一の真実源。
  // physics.js（simulatePathPoses / createKinematicPathFollower）と behaviorPlanner.js が
  // 同じここを参照するため、制動距離の見積もりと実挙動の物理が一致する。
  // 教科書物理: θ=atan(gradePct/100)。制動は重力の斜面成分で上りは助かり／下りは食われる。
  longitudinal: {
    muDry: 0.7,                  // 乾燥路の付着係数（タイヤ限界の目安）
    muWet: 0.5,                  // 湿潤路の付着係数
    comfortDecelMSS: 2.8,        // 平坦・乾燥での目標減速度（従来固定値=後方互換の基準）
    comfortAccelMSS: 1.2,        // 平坦での目標加速度（従来固定値=後方互換の基準）
    minAccelMSS: 0,              // 登坂能力を超える場合は加速不能を正直に返す
    gravityMSS: 9.80665,         // 重力加速度 g
    uphillDecelBonusFactor: 1.3, // 上り制動ボーナスの上限＝comfortDecelMSS×この値
    accelGradePenaltyFactor: 0.6, // 登坂で駆動力が食われる簡易係数（パワートレイン余裕）
    // 総重量 t による運用上の快適加減速のデレート。8t 以下は基準値、以降は
    // 8/grossWeight を使い、極端な設定値でも 0.55 未満にはしない。これは
    // ブレーキ系/動力系の運用余裕を表す決定論的な保守係数で、タイヤ摩擦には掛けない。
    referenceGrossWeightT: 8,
    minOperationalMassFactor: 0.55
  },
  // 項目4用: YOLO 検出スコア → width_ai の confidence。スコアが高いほど信頼度を上げる。
  // 既定の固定 0.75 を、検出スコアに応じ scoreLo..scoreHi を confMin..confMax へ線形写像する。
  perception: {
    widthAiConfMin: 0.55, // 低スコア時の width_ai 信頼度
    widthAiConfMax: 0.80, // 高スコア時の width_ai 信頼度
    scoreLo: 0.30,        // この検出スコア以下で confMin
    scoreHi: 0.75         // この検出スコア以上で confMax
  }
});

// ── 較正用の可変チューニング層 ──────────────────────────────────────────────
// RISK_TUNING は既定値（凍結）。自動較正・実験は applyRiskTuning で上書きする。
// ブラウザでも window から: import して applyRiskTuning({narrowWidth:{stopMarginM:0.4}})
let tuning = RISK_TUNING;
function mergeTuning(base, over) {
  const out = { ...base };
  for (const k of Object.keys(over || {})) {
    const v = over[k];
    out[k] = (v && typeof v === 'object' && !Array.isArray(v)) ? { ...base[k], ...v } : v;
  }
  return out;
}
export function getRiskTuning() { return tuning; }
export function applyRiskTuning(overrides = {}) { tuning = mergeTuning(RISK_TUNING, overrides); return tuning; }
export function resetRiskTuning() { tuning = RISK_TUNING; return tuning; }

/** 0..1 にクランプ。非数は 0 扱い（=最も保守的）。 */
export function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** lo..hi を t(0..1) で線形補間。 */
function lerp(lo, hi, t) {
  return lo + (hi - lo) * clamp01(t);
}

/** 任意区間 [lo,hi] へクランプ。非数は lo（最も保守的）扱い。 */
function clampRange(x, lo, hi) {
  const n = Number(x);
  if (!Number.isFinite(n)) return lo;
  return n < lo ? lo : n > hi ? hi : n;
}

/**
 * 路面状態を 'dry'|'wet' に正規化。vehicleConfig.surfaceCondition があれば surface 引数より優先。
 * @param {string} surface 明示的な路面指定（既定 'dry'）
 * @param {object|null} vehicleConfig surfaceCondition を持ちうる車両設定
 * @returns {'dry'|'wet'}
 */
function resolveSurfaceCondition(surface, vehicleConfig) {
  const raw = (vehicleConfig && vehicleConfig.surfaceCondition != null)
    ? vehicleConfig.surfaceCondition
    : surface;
  return String(raw).toLowerCase() === 'wet' ? 'wet' : 'dry';
}

function operationalMassFactor(vehicleConfig) {
  const L = tuning.longitudinal;
  const grossWeightT = [
    vehicleConfig?.actualGrossWeightT,
    vehicleConfig?.grossWeight,
    vehicleConfig?.vehicleWeight,
    vehicleConfig?.weight
  ].map(Number).find((weight) => Number.isFinite(weight) && weight > 0);
  if (!Number.isFinite(grossWeightT) || grossWeightT <= L.referenceGrossWeightT) return 1;
  return clampRange(L.referenceGrossWeightT / grossWeightT, L.minOperationalMassFactor, 1);
}

/**
 * 幅信頼度に応じた有効道路幅スケール（保守側=下振れ）。
 * confidence が高いほど 1.0 に近づき、低いほど縮小する。
 * @param {number} confidence 0..1
 * @param {{strictMode?: boolean}} [opts]
 * @returns {number} スケール係数
 */
export function widthConfidenceScale(confidence, { strictMode = false } = {}) {
  const c = clamp01(confidence);
  const w = tuning.width;
  return strictMode ? lerp(w.strictFloor, w.strictCeil, c)
                    : lerp(w.softFloor, w.softCeil, c);
}

/**
 * 幅信頼度に応じて有効幅を縮小して返す（下限 minValue でクランプ）。
 * estimateEffectiveRoadWidth から呼ぶ共通入口。
 * @param {number} rawWidthM 生の幅(m)
 * @param {number} confidence 0..1
 * @param {{strictMode?: boolean}} [opts]
 * @returns {{value:number, scale:number}}
 */
export function applyWidthRisk(rawWidthM, confidence, { strictMode = false } = {}) {
  const raw = Number(rawWidthM);
  if (!Number.isFinite(raw) || raw <= 0) return { value: null, scale: 1 };
  const scale = widthConfidenceScale(confidence, { strictMode });
  const value = Math.max(tuning.width.minValue, raw * scale);
  return { value, scale };
}

/**
 * 項目4: YOLO 検出スコア(0..1) → width_ai の confidence(0..1)。
 * scoreLo..scoreHi を widthAiConfMin..widthAiConfMax へ線形写像。
 * @param {number} score YOLO 検出スコア（複数検出の代表値）
 * @returns {number} width_ai に付与する信頼度
 */
export function perceptionWidthAiConfidence(score) {
  const p = tuning.perception;
  const s = Number(score);
  if (!Number.isFinite(s)) return p.widthAiConfMin;
  const t = (s - p.scoreLo) / Math.max(1e-6, p.scoreHi - p.scoreLo);
  return lerp(p.widthAiConfMin, p.widthAiConfMax, t);
}

/**
 * 幅信頼度に応じた判定マージン上乗せ(m)。低信頼ほど大きい。
 * @param {number} confidence 0..1
 * @returns {number} 追加マージン(m)
 */
export function confidenceMargin(confidence) {
  const c = clamp01(confidence);
  return lerp(tuning.margin.atZeroConf, tuning.margin.atFullConf, c);
}

/**
 * 幅信頼度に応じた自律走行速度係数（minFactor..fullFactor）。
 * 「幅が不確かなら慎重に」。基準速度に掛けて使う。
 * @param {number} confidence 0..1
 * @returns {number} 0.55..1.0
 */
export function autonomousSpeedFactor(confidence) {
  const c = clamp01(confidence);
  return lerp(tuning.speed.minFactor, tuning.speed.fullFactor, c);
}

/**
 * 建物高さソース信頼度に応じた車高クリアランス(m)。
 * @param {{source?: string}} [info] getFeatureHeight 由来の高さ情報
 * @returns {number} クリアランス(m)
 */
export function heightClearance(info = {}) {
  const src = String(info?.source || 'estimated');
  if (src === 'tag' || src === 'measured') return tuning.height.measured;
  if (src === 'levels' || src === 'building:levels') return tuning.height.levels;
  return tuning.height.estimated;
}

/**
 * 有効道路幅と車幅の余裕に応じた速度係数。余裕≤stopMarginM は 0（進入不可=STOP）、
 * crawlMarginM までは crawlFactor へ、それ以上は 1.0。幅データ無しは 1.0（従来挙動）。
 * @param {number} effWidthM 有効道路幅(m)（融合+リスク適用後）
 * @param {number} vehicleWidthM 車幅(m)
 * @returns {{factor:number, marginM:number|null}}
 */
export function narrowWidthSpeedFactor(effWidthM, vehicleWidthM) {
  const w = Number(effWidthM);
  const v = Number(vehicleWidthM);
  if (!Number.isFinite(w) || w <= 0 || !Number.isFinite(v) || v <= 0) {
    return { factor: 1.0, marginM: null };
  }
  const n = tuning.narrowWidth;
  const margin = w - v;
  if (margin <= n.stopMarginM) return { factor: 0, marginM: margin };
  if (margin >= n.crawlMarginM) return { factor: 1.0, marginM: margin };
  const t = (margin - n.stopMarginM) / Math.max(1e-6, n.crawlMarginM - n.stopMarginM);
  return { factor: lerp(n.crawlFactor, 1.0, t), marginM: margin };
}

/**
 * 勾配(%)に応じた自律走行速度係数。flatPct までは 1.0、steepPct で minFactor、
 * 以降は頭打ち。道路 properties の demGradeMedianPct（無ければ demGradeMaxPct）を渡す。
 * @param {number} gradePct 勾配の絶対値(%)
 * @returns {number} minFactor..1.0
 */
export function gradeSpeedFactor(gradePct) {
  const g = tuning.grade;
  const p = Math.abs(Number(gradePct));
  if (!Number.isFinite(p) || p <= g.flatPct) return 1.0;
  const t = (p - g.flatPct) / Math.max(1e-6, g.steepPct - g.flatPct);
  return lerp(1.0, g.minFactor, t);
}

/**
 * 道路 feature から勾配速度係数を引く共通入口（コンパイル済みワールドの焼き込み値を読む）。
 * 勾配情報が無い道路（オンライン取得等）は 1.0 = 減速なし。
 * @param {object} feature GeoJSON Feature
 * @returns {{factor:number, gradePct:number|null}}
 */
export function roadGradeSpeedFactor(feature) {
  const p = feature?.properties || {};
  const grade = Number.isFinite(Number(p.demGradeMedianPct)) ? Number(p.demGradeMedianPct)
    : (Number.isFinite(Number(p.demGradeMaxPct)) ? Number(p.demGradeMaxPct) : null);
  if (grade == null) return { factor: 1.0, gradePct: null };
  return { factor: gradeSpeedFactor(grade), gradePct: grade };
}

/**
 * 縦方向動力学: 有効制動減速度(m/s²)。教科書物理で勾配・路面摩擦を反映する。
 * 符号規約: gradePct>0=進行方向の上り坂 / gradePct<0=下り坂。
 *   θ=atan(gradePct/100)。上り(θ>0)は重力の斜面成分が制動を助け(+g·sinθ)、
 *   下り(θ<0)は制動を食う(−g·sin|θ|)。
 * 路面: 低μ路（雨）では ①タイヤ付着限界(μ·g·cosθ)が下がる うえ、②安全側に目標減速度も
 *   グリップ比(μ/μdry)でデレーティングする（平坦・乾燥=comfortDecelMSS を基準に保つ）。
 *   ②が無いと平坦では comfort(2.8) が付着限界より小さく、雨の効きが出ないため。
 * @param {{gradePct?:number, surface?:('dry'|'wet'), vehicleConfig?:object|null}} [args]
 * @returns {number} 有効制動減速度(m/s²)。非停止可能な下りでは 0 を返す。
 */
export function effectiveBrakeDecelMSS({ gradePct = 0, surface = 'dry', vehicleConfig = null } = {}) {
  const L = tuning.longitudinal;
  const g = L.gravityMSS;
  const cond = resolveSurfaceCondition(surface, vehicleConfig);
  const mu = cond === 'wet' ? L.muWet : L.muDry;
  const gp = Number(gradePct);
  const theta = Number.isFinite(gp) ? Math.atan(gp / 100) : 0;
  const massFactor = operationalMassFactor(vehicleConfig);
  const gripScale = mu / L.muDry;                 // 乾燥=1.0、湿潤<1.0（目標減速度の安全側デレーティング）
  const surfaceComfort = L.comfortDecelMSS * gripScale * massFactor;
  // 摩擦加速度 μg は質量に依存しない。massFactor は運用上の快適制動だけに適用する。
  const frictionCap = mu * g * Math.cos(theta);   // タイヤ付着限界（斜面では法線荷重が cosθ 倍）
  const capability = Math.min(surfaceComfort, frictionCap);
  // 上り(sinθ>0)は+、下り(sinθ<0)は−。重力の斜面成分を net 減速度へ反映。
  const net = capability + g * Math.sin(theta);
  // 湿潤/積載時にも上りボーナスは各々の surfaceComfort から導く。
  const upper = surfaceComfort * L.uphillDecelBonusFactor;
  return clampRange(net, 0, upper);
}

/**
 * 縦方向動力学: 有効加速度(m/s²)。登坂で重力が駆動力を食う分だけ加速を落とす。
 * 符号規約は effectiveBrakeDecelMSS と同じ（gradePct>0=上り）。下り(sinθ<0)は
 * comfortAccelMSS で頭打ち（駆動ボーナスは与えない=保守側）。
 * @param {{gradePct?:number, vehicleConfig?:object|null}} [args]
 * @returns {number} 有効加速度(m/s²)。登坂能力を超える場合は 0。
 */
export function effectiveAccelMSS({ gradePct = 0, vehicleConfig = null } = {}) {
  const L = tuning.longitudinal;
  const g = L.gravityMSS;
  const gp = Number(gradePct);
  const theta = Number.isFinite(gp) ? Math.atan(gp / 100) : 0;
  const operationalComfort = L.comfortAccelMSS * operationalMassFactor(vehicleConfig);
  // 上り(sinθ>0)で重力が駆動を食う。係数 0.6 はパワートレイン余裕の簡易表現。
  const a = operationalComfort - g * Math.sin(theta) * L.accelGradePenaltyFactor;
  return clampRange(a, L.minAccelMSS, operationalComfort);
}

/**
 * ③用: 旋回半径ベースのカーブ速度上限(m/s)。v = sqrt(a * R)。
 * baseSpeedMS を上限に、横加速度制約で頭打ちにする。
 * @param {{turnRadiusM:number, baseSpeedMS:number, lateralAccelMS2?:number}} args
 * @returns {number} 許容速度(m/s)
 */
export function curveSpeedLimitMS({ turnRadiusM, baseSpeedMS, lateralAccelMS2 } = {}) {
  const base = Number(baseSpeedMS);
  const R = Number(turnRadiusM);
  const a = Number(lateralAccelMS2) || tuning.curve.lateralAccelMS2;
  if (!Number.isFinite(base) || base <= 0) return 0;
  if (!Number.isFinite(R) || R <= 0) return base; // 直線扱い
  const vCurve = Math.sqrt(Math.max(0, a * R));
  return Math.max(tuning.curve.minSpeedMS, Math.min(base, vCurve));
}
