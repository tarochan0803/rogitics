#!/usr/bin/env node
/**
 * run_l4_route_regression.js — Phase 3 完了条件の回帰: 代表ルートを無介入走行させ、
 * 「完走(OK) or 理由コード付きMRM停止」を機械判定する。Safety Monitor違反=FAIL
 * （planner/道路面側のバグとして扱う）。
 *
 * ルートは compiled world 内の実道路中心線から自動選定（長い順・幅3m以上、
 * --steep で急勾配道路を優先）。経路は index3DSetRoute（OSRM不使用・決定論）で確定し、
 * PROCEDURES の順序（①経路→②world→③走行）で実行する。
 *
 * 使い方（サーバは別途 http://127.0.0.1:8099 で配信しておく）:
 *   node src/batch/run_l4_route_regression.js --worlds c6c4f2e9,75cce456 --routes 10
 *   node src/batch/run_l4_route_regression.js --worlds 75cce456 --routes 5 --steep
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const puppeteer = require(path.join(__dirname, 'node_modules', 'puppeteer'));

function parseArgs(argv) {
  const o = {
    worlds: [], routes: 10, steep: false,
    base: 'http://127.0.0.1:8099', out: path.join(ROOT, 'runtime', 'l4_regression'),
    minLenM: 80, minWidthM: 3.0, speedKmh: 18, timeoutS: 60
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--worlds') o.worlds = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--routes') o.routes = parseInt(argv[++i], 10) || o.routes;
    else if (a === '--steep') o.steep = true;
    else if (a === '--base') o.base = argv[++i];
    else if (a === '--out') o.out = path.resolve(argv[++i]);
    else if (a === '--min-len') o.minLenM = Number(argv[++i]) || o.minLenM;
    else if (a === '--timeout') o.timeoutS = Number(argv[++i]) || o.timeoutS;
  }
  return o;
}

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

// world 内の実道路から代表ルート候補を選定（決定論: 長さ降順→id昇順）
function pickRoutes(world, { routes, minLenM, minWidthM, steep }) {
  const cands = [];
  for (const f of world.layers.roads || []) {
    const line = mainLineOf(f.geometry);
    if (!line || line.length < 2) continue;
    const lenM = lineLenM(line);
    const widthM = Number(f.properties?.fgdWidthM ?? f.properties?.gsiWidthEstimate);
    const grade = Number(f.properties?.demGradeMedianPct);
    if (lenM < minLenM) continue;
    if (Number.isFinite(widthM) && widthM < minWidthM) continue;
    cands.push({
      id: String(f.properties?.id || ''),
      lenM: Math.round(lenM),
      widthM: Number.isFinite(widthM) ? Math.round(widthM * 10) / 10 : null,
      gradePct: Number.isFinite(grade) ? grade : null,
      route: line.map((c) => ({ lat: c[1], lng: c[0] }))
    });
  }
  cands.sort((a, b) => {
    if (steep) {
      const ga = a.gradePct ?? -1;
      const gb = b.gradePct ?? -1;
      if (gb !== ga) return gb - ga;
    }
    return (b.lenM - a.lenM) || (a.id < b.id ? -1 : 1);
  });
  return cands.slice(0, routes);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function safeFilePart(value) {
  return String(value || '')
    .replace(/[^a-z0-9_.-]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120) || 'route';
}

async function runRoute(browser, baseUrl, worldFileUrl, cand, { speedKmh, timeoutS, traceDir, worldHash }) {
  const page = await browser.newPage();
  page.setDefaultTimeout(120000);
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 160)));

  // ①経路確定 → ②compiled world 読込 → ③再生
  try {
    await page.goto(`${baseUrl}/index3D_V2.0.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      'typeof window.index3DSetRoute === "function" && typeof window.index3DLoadCompiledWorld === "function"',
      { timeout: 90000 });

    await page.evaluate((route) => window.index3DSetRoute(route), cand.route);
    await page.evaluate(async (url) => {
      const w = await fetch(url).then((r) => r.json());
      return window.index3DLoadCompiledWorld(w);
    }, worldFileUrl);
    await page.evaluate(() => window.index3DPlay());

    let last = null;
    let stableFor = 0;
    let prevTick = -1;
    const deadline = Date.now() + timeoutS * 1000;
    while (Date.now() < deadline) {
      await sleep(1000);
      last = await page.evaluate(() => window.index3DGetSafetyMetrics());
      if (last?.status === 'MRM_STOP' || last?.status === 'VIOLATION') break;
      if ((last?.tick || 0) === prevTick) {
        stableFor += 1;
        if (stableFor >= 4) break; // 進捗停止=再生完了とみなす
      } else {
        stableFor = 0;
        prevTick = last?.tick || 0;
      }
    }
    const phase4 = await page.evaluate(() => window.index3DGetStats()?.phase4 || null);

    const mrmReason = last?.mrmStop?.reason || null;
    const progressM = Number(last?.progressM) || 0;
    const totalM = Number(last?.routeTotalM) || cand.lenM;
    let verdict;
    if (mrmReason === 'safety_invariant_violation') verdict = 'FAIL_MONITOR';
    else if (mrmReason) verdict = 'MRM_OK'; // 理由コード付き安全停止（完了条件上は許容）
    else if (last?.status === 'VIOLATION') verdict = 'FAIL_MONITOR';
    else if (progressM >= totalM * 0.7) verdict = 'PASS'; // 実走破の証明（見せかけ完走を弾く）
    else verdict = 'FAIL_INCOMPLETE'; // MRMも違反も無いのに走破していない（物理/再生の問題）

    let traceFile = null;
    if (verdict !== 'PASS') {
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
      mrmReason,
      firstViolation: last?.firstViolation?.violations?.[0]?.type || null,
      minAllowedKmh: phase4?.minAllowedSpeedKmh ?? null,
      stopEvents: phase4?.stopEventCount ?? null,
      traceFile,
      pageErrors
    };
  } finally {
    await page.close().catch(() => {});
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.worlds.length) {
    console.error('usage: node src/batch/run_l4_route_regression.js --worlds <hash,...> [--routes N] [--steep]');
    return 2;
  }
  fs.mkdirSync(opts.out, { recursive: true });

  const browser = await puppeteer.launch({ headless: true });

  const runId = Date.now();
  const traceDir = path.join(opts.out, `traces_${runId}`);
  const results = [];
  for (const hash of opts.worlds) {
    const worldPath = path.join(ROOT, 'runtime', 'worlds', `world_${hash}.json`);
    const world = JSON.parse(fs.readFileSync(worldPath, 'utf8'));
    const picks = pickRoutes(world, opts);
    console.log(`\n=== world ${hash}: ${picks.length} routes (steep=${opts.steep}) ===`);
    for (const cand of picks) {
      const r = await runRoute(browser, opts.base, `runtime/worlds/world_${hash}.json`, cand, { ...opts, traceDir, worldHash: hash });
      results.push({ world: hash, ...cand, route: undefined, ...r });
      console.log(`[${r.verdict === 'PASS' ? 'PASS' : r.verdict === 'MRM_OK' ? 'MRM ' : 'FAIL'}] ${cand.id}`
        + `  len=${cand.lenM}m w=${cand.widthM ?? '?'}m grade=${cand.gradePct ?? '-'}%`
        + `  prog=${r.progressM}/${r.totalM}m ticks=${r.ticks} status=${r.status}`
        + `${r.mrmReason ? ' mrm=' + r.mrmReason : ''}${r.firstViolation ? ' viol=' + r.firstViolation : ''}`
        + ` minV=${r.minAllowedKmh ?? '?'}km/h`);
    }
  }
  await browser.close();

  const pass = results.filter((r) => r.verdict === 'PASS').length;
  const mrmOk = results.filter((r) => r.verdict === 'MRM_OK').length;
  const fail = results.length - pass - mrmOk;
  const pageErrorCount = results.reduce((sum, r) => sum + (Array.isArray(r.pageErrors) ? r.pageErrors.length : 0), 0);
  const summary = { total: results.length, pass, mrmOk, fail, pageErrors: pageErrorCount };
  const outFile = path.join(opts.out, `regression_${runId}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ summary, results }, null, 2), 'utf8');
  console.log(`\nsummary: total=${summary.total} PASS=${pass} MRM_OK=${mrmOk} FAIL=${fail} pageErrors=${pageErrorCount}`);
  console.log(`saved: ${outFile}`);
  // Phase 3 完了条件: Monitor違反=0（FAILなし）。MRM_OK は理由コード付き安全停止として許容。
  return fail === 0 && pageErrorCount === 0 ? 0 : 1;
}

main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
