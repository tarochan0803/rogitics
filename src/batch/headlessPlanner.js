/**
 * headlessPlanner.js — behaviorPlanner をブラウザ無しで回す共有基盤（①較正/③RL基盤）。
 * globalThis.turf / polygonClipping を注入してから core モジュールを動的importする。
 * 評価は planner レベル（STOP/速度/切り返し推奨）。Monitorの面判定はブラウザ二段目で行う。
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..', '..');

let modsPromise = null;
function loadMods() {
  if (!modsPromise) {
    globalThis.turf = require('@turf/turf');
    globalThis.polygonClipping = require('polygon-clipping');
    const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
    modsPromise = (async () => ({
      planner: await imp('src/sim/autonomy/behaviorPlanner.js'),
      risk: await imp('src/core/vehicleRiskModel.js'),
      config: await imp('src/config.js'),
      core: await imp('src/sim/autoFollowCore.js')
    }))();
  }
  return modsPromise;
}

const worldCache = new Map();
function loadWorld(file) {
  const key = path.resolve(ROOT, file);
  if (!worldCache.has(key)) worldCache.set(key, JSON.parse(fs.readFileSync(key, 'utf8')));
  return worldCache.get(key);
}

/**
 * planner を1回実行し、ヘッドレス判定を返す。
 * verdict: 'PASS_PLAN'（planner上は完走可能） / 'STOP_PLAN'（未解決STOPあり）
 * detail: 最初のSTOP位置・切り返し推奨数・最低許容速度など
 */
async function evalRoutePlanner({ worldFile, route, vehiclePreset, riskOverrides = null, cruiseSpeedKmh = 18 }) {
  const { planner, risk, config } = await loadMods();
  const world = loadWorld(worldFile);
  if (riskOverrides) risk.applyRiskTuning(riskOverrides); else risk.resetRiskTuning();
  try {
    const report = planner.buildAutonomyDriveReport({
      route,
      roads: world.layers.roads || [],
      buildings: world.layers.buildings || [],
      vehicleConfig: config.VEHICLE_PRESETS[vehiclePreset] || {},
      cruiseSpeedKmh
    });
    const samples = report.samples || [];
    const stops = samples.filter((s) => s.mode === 'STOP');
    const unresolvedStop = (report.summary?.recoveryStatus === 'UNRESOLVED')
      || (stops.length > 0 && !(report.summary?.recoveredStopCount > 0));
    const switchbacks = samples.filter((s) => s.switchbackRecommended).length;
    return {
      verdict: unresolvedStop ? 'STOP_PLAN' : 'PASS_PLAN',
      firstStopSM: stops.length ? stops[0].sM : null,
      stopCount: stops.length,
      switchbackSamples: switchbacks,
      minAllowedKmh: report.summary?.minAllowedSpeedKmh ?? null,
      sampleCount: samples.length
    };
  } finally {
    risk.resetRiskTuning();
  }
}

module.exports = { loadMods, loadWorld, evalRoutePlanner };
