/**
 * l4RegressionLib.js — L4回帰系（代表ルート回帰/シナリオ行列）の共有部品。
 * run_l4_route_regression.js と run_l4_scenario_matrix.js が使う。
 * ここはハーネス側の計測ユーティリティ（シミュ本体の幾何は autoFollowCore が単一実装）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function lineLenM(coords) {
  let m = 0;
  for (let i = 1; i < coords.length; i++) {
    const dlat = (coords[i][1] - coords[i - 1][1]) * 111320;
    const dlng = (coords[i][0] - coords[i - 1][0]) * 111320 * Math.cos((coords[i][1] * Math.PI) / 180);
    m += Math.hypot(dlat, dlng);
  }
  return m;
}

function mainLineOf(geometry) {
  if (geometry?.type === 'LineString') return geometry.coordinates;
  if (geometry?.type === 'MultiLineString') {
    let best = null;
    for (const part of geometry.coordinates || []) {
      if (!best || lineLenM(part) > lineLenM(best)) best = part;
    }
    return best;
  }
  return null;
}

function safeFilePart(value) {
  return String(value || '')
    .replace(/[^a-z0-9_.-]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120) || 'route';
}

// 形状分類: セグメント方位の最大折れ角と累積折れ角から 直線/カーブ/急折れ を判定
function classifyShape(coords) {
  if (!coords || coords.length < 3) return 'straight';
  const headings = [];
  for (let i = 1; i < coords.length; i++) {
    const dlat = (coords[i][1] - coords[i - 1][1]) * 111320;
    const dlng = (coords[i][0] - coords[i - 1][0]) * 111320 * Math.cos((coords[i][1] * Math.PI) / 180);
    if (Math.hypot(dlat, dlng) < 1) continue; // 1m未満のノイズ点は無視
    headings.push((Math.atan2(dlng, dlat) * 180) / Math.PI);
  }
  let maxTurn = 0;
  let totalTurn = 0;
  for (let i = 1; i < headings.length; i++) {
    let d = Math.abs(headings[i] - headings[i - 1]);
    if (d > 180) d = 360 - d;
    maxTurn = Math.max(maxTurn, d);
    totalTurn += d;
  }
  if (maxTurn >= 60) return 'sharp';
  if (maxTurn >= 20 || totalTurn >= 45) return 'curve';
  return 'straight';
}

// 幅帯（widthClass.js の階級と整合）/ 勾配帯
function widthBandOf(widthM) {
  if (!Number.isFinite(widthM)) return 'unknown';
  if (widthM < 3.5) return 'lt35';
  if (widthM < 4.5) return 'w35_45';
  if (widthM < 6) return 'w45_6';
  return 'ge6';
}

function gradeBandOf(gradePct) {
  if (!Number.isFinite(gradePct)) return 'flat';
  const absGradePct = Math.abs(gradePct);
  if (absGradePct >= 8) return 'steep';
  if (absGradePct >= 3) return 'mid';
  return 'flat';
}

// world 内の実道路から候補を列挙（分類つき・決定論順）
function collectCandidates(world, { minLenM = 60, minWidthM = 3.0 } = {}) {
  const cands = [];
  for (const f of world.layers.roads || []) {
    const line = mainLineOf(f.geometry);
    if (!line || line.length < 2) continue;
    const lenM = lineLenM(line);
    if (lenM < minLenM) continue;
    const widthM = Number(f.properties?.fgdWidthM ?? f.properties?.gsiWidthEstimate);
    if (Number.isFinite(widthM) && widthM < minWidthM) continue;
    const grade = Number(f.properties?.demGradeMedianPct);
    cands.push({
      id: String(f.properties?.id || ''),
      lenM: Math.round(lenM),
      widthM: Number.isFinite(widthM) ? Math.round(widthM * 10) / 10 : null,
      gradePct: Number.isFinite(grade) ? grade : null,
      shape: classifyShape(line),
      widthBand: widthBandOf(widthM),
      gradeBand: gradeBandOf(grade),
      route: line.map((c) => ({ lat: c[1], lng: c[0] }))
    });
  }
  cands.sort((a, b) => (b.lenM - a.lenM) || (a.id < b.id ? -1 : 1));
  return cands;
}

function completionToleranceM(totalM) {
  return Math.max(2, totalM * 0.02);
}

function isNearGoalCompletion({ safety, drive, candidateLengthM }) {
  const progressM = Number(safety?.progressM ?? drive?.progressM);
  const totalM = Number(safety?.routeTotalM ?? drive?.totalM ?? candidateLengthM);
  return Number.isFinite(progressM)
    && Number.isFinite(totalM)
    && totalM > 0
    && progressM >= totalM - completionToleranceM(totalM)
    && typeof drive?.playing === 'boolean'
    && drive.playing === false;
}

function classifyRouteOutcome({ safety, drive, candidateLengthM, timedOut }) {
  const mrmReason = safety?.mrmStop?.reason || null;
  if (mrmReason === 'safety_invariant_violation') return 'FAIL_MONITOR';
  if (mrmReason) return 'MRM_OK';
  if (safety?.status === 'VIOLATION') return 'FAIL_MONITOR';
  if (isNearGoalCompletion({ safety, drive, candidateLengthM })) return 'PASS';
  if (timedOut) return 'TIMEOUT';
  return 'FAIL_INCOMPLETE';
}

/**
 * 1ルート実行: ①経路確定→②compiled world読込→③再生→Safety/Phase4集計。
 * PASSには、実際の再生完了シグナルと終端近傍の進捗の両方が必要。
 */
async function runRoute(page, worldFileUrl, cand, { timeoutS = 90, traceDir, worldHash } = {}) {
  await page.evaluate((route) => window.index3DSetRoute(route), cand.route);
  await page.evaluate(async (url) => {
    const w = await fetch(url).then((r) => r.json());
    return window.index3DLoadCompiledWorld(w);
  }, worldFileUrl);
  await page.evaluate(() => window.index3DPlay());

  let last = null;
  let driveLast = null;
  let completed = false;
  let terminal = false;
  const deadline = Date.now() + timeoutS * 1000;
  while (Date.now() < deadline) {
    await sleep(1000);
    const snapshot = await page.evaluate(() => ({
      safety: window.index3DGetSafetyMetrics?.() || null,
      drive: window.index3DGetAutonomyDriveMetrics?.()
        || window.index3DGetStats?.()?.phase4
        || null
    }));
    last = snapshot.safety;
    driveLast = snapshot.drive;
    if (last?.status === 'MRM_STOP' || last?.status === 'MRM_FAILED' || last?.status === 'VIOLATION') {
      terminal = true;
      break;
    }
    completed = isNearGoalCompletion({ safety: last, drive: driveLast, candidateLengthM: cand.lenM });
    if (completed) {
      terminal = true;
      break;
    }
  }
  const timedOut = !terminal && Date.now() >= deadline;
  const phase4 = driveLast || await page.evaluate(() => window.index3DGetStats()?.phase4 || null);

  const mrmReason = last?.mrmStop?.reason || null;
  const progressM = Number(last?.progressM ?? phase4?.progressM) || 0;
  const totalM = Number(last?.routeTotalM ?? phase4?.totalM) || cand.lenM;
  const verdict = classifyRouteOutcome({
    safety: last,
    drive: phase4,
    candidateLengthM: cand.lenM,
    timedOut
  });

  let traceFile = null;
  if (verdict !== 'PASS' && verdict !== 'MRM_OK' && traceDir) {
    const savedTrace = await page.evaluate(() => window.index3DGetSafetyTrace?.() || null);
    const traceText = typeof savedTrace?.traceJSONL === 'string' ? savedTrace.traceJSONL : '';
    if (traceText) {
      fs.mkdirSync(traceDir, { recursive: true });
      traceFile = path.join(traceDir, `${safeFilePart(worldHash)}_${safeFilePart(cand.id)}_${safeFilePart(verdict)}.jsonl`);
      fs.writeFileSync(traceFile, traceText, 'utf8');
    }
  }

  return {
    verdict,
    progressM: Math.round(progressM),
    totalM: Math.round(totalM),
    ticks: last?.tick || 0,
    status: last?.status || null,
    drivePlaying: typeof phase4?.playing === 'boolean' ? phase4.playing : null,
    completionEvidence: isNearGoalCompletion({ safety: last, drive: phase4, candidateLengthM: cand.lenM }),
    timedOut,
    mrmReason,
    firstViolation: last?.firstViolation?.violations?.[0]?.type || null,
    minAllowedKmh: phase4?.minAllowedSpeedKmh ?? null,
    stopEvents: phase4?.stopEventCount ?? null,
    traceFile
  };
}

module.exports = {
  sleep,
  lineLenM,
  mainLineOf,
  safeFilePart,
  classifyShape,
  widthBandOf,
  gradeBandOf,
  collectCandidates,
  completionToleranceM,
  isNearGoalCompletion,
  classifyRouteOutcome,
  runRoute
};
