#!/usr/bin/env node
/**
 * run_l4_scenario_matrix.js — Phase 4: シナリオ行列回帰（オンデマンド実行・定期実行なし）
 *
 * ワールド群の実道路を 幅帯(4)×勾配帯(3)×形状(3) のセルへ分類し、各セル代表ルートを
 * 指定車種すべてで走行させる。大型車が狭幅路で理由コード付きMRM停止するのは正常
 * （MRM_OK）。FAIL_MONITOR / FAIL_INCOMPLETE のみが要修正。
 *
 * 使い方（サーバは http://127.0.0.1:8099 で配信しておく）:
 *   node src/batch/run_l4_scenario_matrix.js --worlds c6c4f2e9,75cce456,773f1fb4
 *       [--vehicles 2t_flat,4t_flat,10t_unic] [--max-cells 12] [--timeout 120]
 *
 * 結果: runtime/l4_regression/matrix_<runId>.json（report_l4_regression.js で前回比較）
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const puppeteer = require(path.join(__dirname, 'node_modules', 'puppeteer'));
const { collectCandidates, runRoute } = require('./l4RegressionLib.js');

function parseArgs(argv) {
  const o = {
    worlds: [], vehicles: ['2t_flat', '4t_flat', '10t_unic'],
    base: 'http://127.0.0.1:8099', out: path.join(ROOT, 'runtime', 'l4_regression'),
    maxCells: 24, timeoutS: 120, minLenM: 60
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--worlds') o.worlds = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--vehicles') o.vehicles = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--max-cells') o.maxCells = parseInt(argv[++i], 10) || o.maxCells;
    else if (a === '--timeout') o.timeoutS = Number(argv[++i]) || o.timeoutS;
    else if (a === '--base') o.base = argv[++i];
    else if (a === '--out') o.out = path.resolve(argv[++i]);
  }
  return o;
}

// セル選定: widthBand|gradeBand|shape ごとに最長ルート1本（ワールド横断・決定論）
function pickCells(worldEntries, { maxCells, minLenM }) {
  const cells = new Map();
  for (const { hash, world } of worldEntries) {
    for (const cand of collectCandidates(world, { minLenM })) {
      const key = `${cand.widthBand}|${cand.gradeBand}|${cand.shape}`;
      const cur = cells.get(key);
      if (!cur || cand.lenM > cur.cand.lenM) cells.set(key, { key, worldHash: hash, cand });
    }
  }
  return [...cells.values()]
    .sort((a, b) => (a.key < b.key ? -1 : 1))
    .slice(0, maxCells);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.worlds.length) {
    console.error('usage: node src/batch/run_l4_scenario_matrix.js --worlds <hash,...> [--vehicles a,b] [--max-cells N]');
    return 2;
  }
  fs.mkdirSync(opts.out, { recursive: true });

  const worldEntries = opts.worlds.map((hash) => ({
    hash,
    world: JSON.parse(fs.readFileSync(path.join(ROOT, 'runtime', 'worlds', `world_${hash}.json`), 'utf8'))
  }));
  const cells = pickCells(worldEntries, opts);
  console.log(`scenario cells: ${cells.length} × vehicles: ${opts.vehicles.length} = ${cells.length * opts.vehicles.length} runs`);
  for (const c of cells) {
    console.log(`  [${c.key}] ${c.cand.id} (world=${c.worldHash} len=${c.cand.lenM}m w=${c.cand.widthM ?? '?'}m grade=${c.cand.gradePct ?? '-'}%)`);
  }

  const browser = await puppeteer.launch({ headless: true });
  const pageErrors = [];

  const runId = Date.now();
  const traceDir = path.join(opts.out, `matrix_traces_${runId}`);
  const results = [];
  for (const vehicle of opts.vehicles) {
    console.log(`\n=== vehicle: ${vehicle} ===`);
    for (const cell of cells) {
      // ルート毎に新規ページ（前ルートの再生状態が混ざる偽FAILを防止。
      // run_l4_route_regression.js と同じ隔離方針）
      let page = null;
      let r;
      try {
        page = await browser.newPage();
        page.setDefaultTimeout(120000);
        page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 160)));
        await page.goto(`${opts.base}/index3D_V2.0.html`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(
          'typeof window.index3DSetRoute === "function" && typeof window.index3DLoadCompiledWorld === "function"',
          { timeout: 90000 });
        // 車種切替はUIのselectと同一経路（applyVehiclePreset + 再描画）
        await page.select('#vehiclePreset', vehicle);
        r = await runRoute(page, `runtime/worlds/world_${cell.worldHash}.json`, cell.cand,
          { timeoutS: opts.timeoutS, traceDir, worldHash: cell.worldHash });
      } catch (e) {
        const msg = String(e?.message || e).slice(0, 200);
        pageErrors.push(msg);
        r = {
          verdict: 'FAIL_UNKNOWN',
          progressM: 0,
          totalM: cell.cand.lenM,
          ticks: 0,
          status: 'ERROR',
          mrmReason: null,
          firstViolation: null,
          minAllowedKmh: null,
          stopEvents: null,
          traceFile: null,
          error: msg
        };
      } finally {
        if (page) await page.close().catch(() => {});
      }
      results.push({
        cell: cell.key, vehicle, world: cell.worldHash,
        id: cell.cand.id, lenM: cell.cand.lenM, widthM: cell.cand.widthM,
        gradePct: cell.cand.gradePct, shape: cell.cand.shape, ...r
      });
      const mark = r.verdict === 'PASS' ? 'PASS' : (r.verdict === 'MRM_OK' ? 'MRM ' : 'FAIL');
      console.log(`[${mark}] ${cell.key}  ${cell.cand.id}  prog=${r.progressM}/${r.totalM}m`
        + `${r.mrmReason ? ' mrm=' + r.mrmReason : ''}${r.firstViolation ? ' viol=' + r.firstViolation : ''}`
        + ` minV=${r.minAllowedKmh ?? '?'}km/h`);
    }
  }
  await browser.close();

  const pass = results.filter((r) => r.verdict === 'PASS').length;
  const mrmOk = results.filter((r) => r.verdict === 'MRM_OK').length;
  const fail = results.length - pass - mrmOk;
  const summary = { total: results.length, pass, mrmOk, fail, cells: cells.length, vehicles: opts.vehicles, pageErrors: pageErrors.length };
  const outFile = path.join(opts.out, `matrix_${runId}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ summary, results }, null, 2), 'utf8');
  console.log(`\nsummary: runs=${summary.total} PASS=${pass} MRM_OK=${mrmOk} FAIL=${fail} pageErrors=${pageErrors.length}`);
  console.log(`saved: ${outFile}`);
  return fail === 0 && pageErrors.length === 0 ? 0 : 1;
}

main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
