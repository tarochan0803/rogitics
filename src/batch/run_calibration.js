#!/usr/bin/env node
/**
 * run_calibration.js — ①自動較正: 教師データを損失関数に RISK_TUNING を探索する。
 *
 * 仕組み（フィジカルAIの実務形）:
 *   パラメータ候補 → ヘッドレスplanner評価(320走行/候補・ブラウザ不要) → 損失 →
 *   seed付きランダム探索+ベスト近傍refine → 最良候補を報告。
 *   ※plannerレベルの評価（Monitor面判定なし）なので、最終確認は
 *     採用候補を applyRiskTuning でブラウザ実走（teacher run）して行う二段構え。
 *
 * 損失 = 強正例FN率 + 0.3×推定passable矛盾率 + 0.15×弱負例通過率（過permissive抑止）
 *
 * 使い方:
 *   node src/batch/run_calibration.js [--samples 32] [--refine 8] [--seed 7]
 *       [--routes runtime/teacher_data/teacher_site_routes_*.json]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { evalRoutePlanner, loadMods } = require('./headlessPlanner.js');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT_DIR = path.join(ROOT, 'runtime', 'calibration');

function parseArgs(argv) {
  const o = { samples: 32, refine: 8, seed: 7, routes: null, vehicles: ['2t_flat', '3t_flat', '4t_flat', '10t_unic'] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--samples') o.samples = parseInt(argv[++i], 10) || o.samples;
    else if (a === '--refine') o.refine = parseInt(argv[++i], 10) || o.refine;
    else if (a === '--seed') o.seed = parseInt(argv[++i], 10) || o.seed;
    else if (a === '--routes') o.routes = argv[++i];
    else if (a === '--vehicles') o.vehicles = argv[++i].split(',');
  }
  return o;
}

function latestRoutesFile() {
  const dir = path.join(ROOT, 'runtime', 'teacher_data');
  const files = fs.readdirSync(dir).filter((f) => /^teacher_site_routes_\d+\.json$/.test(f)).sort();
  if (!files.length) throw new Error('teacher_site_routes_*.json がありません（build_teacher_site_routes を先に）');
  return path.join(dir, files[files.length - 1]);
}

// 探索空間（bounds）。値はすべて RISK_TUNING.narrowWidth 系。
const SPACE = [
  { key: 'stopMarginM', lo: 0.10, hi: 0.50 },
  { key: 'crawlMarginM', lo: 0.50, hi: 1.20 },
  { key: 'crawlFactor', lo: 0.30, hi: 0.60 },
  { key: 'curveSwingWidthMultiplier', lo: 1.00, hi: 2.00 },
  { key: 'curveSwingWidthMultiplierMax', lo: 1.50, hi: 2.50 },
  { key: 'switchbackTurnDeg', lo: 30, hi: 60 },
  { key: 'curveSwingSoftCrawlFactor', lo: 0.20, hi: 0.50 }
];

function sampleConfig(rng, center = null, spread = 1.0) {
  const nw = {};
  for (const p of SPACE) {
    let v;
    if (center) {
      const c = center[p.key];
      const range = (p.hi - p.lo) * 0.15 * spread;
      v = Math.min(p.hi, Math.max(p.lo, c + (rng() * 2 - 1) * range));
    } else {
      v = p.lo + rng() * (p.hi - p.lo);
    }
    nw[p.key] = Math.round(v * 1000) / 1000;
  }
  // 整合制約
  if (nw.crawlMarginM <= nw.stopMarginM + 0.1) nw.crawlMarginM = nw.stopMarginM + 0.1;
  if (nw.curveSwingWidthMultiplierMax < nw.curveSwingWidthMultiplier) {
    nw.curveSwingWidthMultiplierMax = nw.curveSwingWidthMultiplier;
  }
  return { narrowWidth: nw };
}

function labelFor(routeRec, vehicle) {
  // ビルダーが焼き込んだプリセット別ラベル（run_teacher_site_routes と同一規約）を使う
  if ((routeRec.observedPositivePresets || []).includes(vehicle)) return 'OBSERVED_POSITIVE';
  if ((routeRec.inferredPassablePresets || []).includes(vehicle)) return 'INFERRED_PASSABLE';
  return 'WEAK_NEGATIVE';
}

async function evalConfig(routes, vehicles, overrides) {
  // 地点×車種で「どれかのアプローチがPASS_PLANなら通れる」集計
  const bySiteVeh = new Map();
  for (const rt of routes) {
    const wf = rt.worldFile.replace(/\\/g, '/');
    const worldFile = wf.includes('runtime') ? wf.slice(wf.indexOf('runtime')) : wf;
    for (const veh of vehicles) {
      const r = await evalRoutePlanner({
        worldFile, route: rt.route, vehiclePreset: veh, riskOverrides: overrides
      });
      const key = `${rt.pointId}|${veh}`;
      const cur = bySiteVeh.get(key) || { pass: false, label: labelFor(rt, veh) };
      cur.pass = cur.pass || r.verdict === 'PASS_PLAN';
      bySiteVeh.set(key, cur);
    }
  }
  let obsTotal = 0, obsFn = 0, infTotal = 0, infConflict = 0, weakTotal = 0, weakPass = 0;
  for (const { pass, label } of bySiteVeh.values()) {
    if (label === 'OBSERVED_POSITIVE') { obsTotal++; if (!pass) obsFn++; }
    else if (label === 'INFERRED_PASSABLE') { infTotal++; if (!pass) infConflict++; }
    else { weakTotal++; if (pass) weakPass++; }
  }
  const fnRate = obsTotal ? obsFn / obsTotal : 0;
  const confRate = infTotal ? infConflict / infTotal : 0;
  const weakPassRate = weakTotal ? weakPass / weakTotal : 0;
  const loss = fnRate + 0.3 * confRate + 0.15 * weakPassRate;
  return { loss: Math.round(loss * 10000) / 10000, fnRate, confRate, weakPassRate, obsTotal, obsFn };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const routesFile = opts.routes ? path.resolve(opts.routes) : latestRoutesFile();
  const routes = JSON.parse(fs.readFileSync(routesFile, 'utf8')).routes;
  const { core } = await loadMods();
  const rng = core.createRng(opts.seed);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log(`calibration: routes=${routes.length} vehicles=${opts.vehicles.length} samples=${opts.samples}+refine=${opts.refine} seed=${opts.seed}`);

  const baseline = await evalConfig(routes, opts.vehicles, null);
  console.log('[baseline]', JSON.stringify(baseline));

  const tried = [];
  let best = { overrides: null, ...baseline };
  for (let i = 0; i < opts.samples; i++) {
    const cfg = sampleConfig(rng);
    const m = await evalConfig(routes, opts.vehicles, cfg);
    tried.push({ cfg, ...m });
    if (m.loss < best.loss) best = { overrides: cfg, ...m };
    console.log(`[${String(i + 1).padStart(2, '0')}/${opts.samples}] loss=${m.loss} fn=${(m.fnRate * 100).toFixed(0)}% conf=${(m.confRate * 100).toFixed(0)}% weakPass=${(m.weakPassRate * 100).toFixed(0)}%${m.loss <= best.loss ? '  << best' : ''}`);
  }
  for (let i = 0; i < opts.refine && best.overrides; i++) {
    const cfg = sampleConfig(rng, best.overrides.narrowWidth, 0.6);
    const m = await evalConfig(routes, opts.vehicles, cfg);
    tried.push({ cfg, ...m });
    if (m.loss < best.loss) best = { overrides: cfg, ...m };
    console.log(`[refine ${i + 1}/${opts.refine}] loss=${m.loss}${m.loss <= best.loss ? '  << best' : ''}`);
  }

  const out = {
    generatedAt: new Date().toISOString(),
    routesFile: path.relative(ROOT, routesFile),
    vehicles: opts.vehicles,
    seed: opts.seed,
    baseline,
    best,
    tried
  };
  const outFile = path.join(OUT_DIR, `calibration_${Date.now()}.json`);
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2), 'utf8');
  console.log(`\nbaseline loss=${baseline.loss} (FN ${(baseline.fnRate * 100).toFixed(0)}%) → best loss=${best.loss} (FN ${(best.fnRate * 100).toFixed(0)}%)`);
  console.log('best overrides:', JSON.stringify(best.overrides));
  console.log(`saved: ${outFile}`);
  console.log('次: ベスト候補をブラウザ二段確認 → applyRiskTuning をアプリ既定に昇格するか判断');
  return 0;
}

main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
