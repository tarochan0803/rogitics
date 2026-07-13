#!/usr/bin/env node
'use strict';
/**
 * run_switchback_probe.js — 切り返し(K-turn)/recovery 暴走の回帰プローブ。
 *
 * 背景: K-turnプランナが「その場でほぼ一回転するピルエット軌道」を生成するバグがあり、
 * 別作業者が map3dThree.js 側を修正中。本プローブはヘッドレスブラウザでデモワールドを
 * 再生し、window.index3DGetRecoveryDebug() が返す maneuver 一覧の健全性（過大な旋回角・
 * 過大な長さ・多発）を検査して再発を防止する。
 *
 * 契約（別作業者が map3dThree.js に実装中のフック）:
 *   window.index3DGetRecoveryDebug() -> {
 *     maneuvers: [{ source, sM, lengthM, headingSweepDeg, gearChanges, poseCount, accepted, rejectReason }],
 *     count
 *   }
 * フックが未定義の場合（未実装段階）は [SKIP] を出して exit 0 とし、本プローブが壊れないようにする。
 *
 * run_index3d_smoke.js / l4RegressionLib.js のハーネスパターンを踏襲。
 */

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const DEFAULT_TARGET = process.env.LOGISTICS_INDEX3D_URL || 'http://127.0.0.1:8080/index3D_V2.0.html';
const TIMEOUT_MS = 90000;

// 切り返し健全性のしきい値（暴走ピルエット検出用）
const MAX_HEADING_SWEEP_DEG = 270;
const MAX_MANEUVER_LENGTH_M = 45;
const MAX_ACCEPTED_MANEUVERS = 3;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const opts = { target: DEFAULT_TARGET, timeoutMs: TIMEOUT_MS };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--target') opts.target = next();
    else if (arg.startsWith('--target=')) opts.target = arg.slice('--target='.length);
    else if (arg === '--timeout') opts.timeoutMs = Number(next()) || opts.timeoutMs;
    else if (arg.startsWith('--timeout=')) opts.timeoutMs = Number(arg.slice('--timeout='.length)) || opts.timeoutMs;
  }
  return opts;
}

function getChromeExecutablePath() {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  try {
    const bundled = puppeteer.executablePath();
    return bundled && fs.existsSync(bundled) ? bundled : null;
  } catch (_err) {
    return null;
  }
}

// 再生完了/MRM停止/タイムアウトのいずれかまで index3DGetSafetyMetrics() を1秒ポーリングする
async function pollUntilSettled(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  let stableFor = 0;
  let prevTick = -1;
  while (Date.now() < deadline) {
    await sleep(1000);
    last = await page.evaluate(() => window.index3DGetSafetyMetrics?.() || null);
    if (!last) continue;
    if (last.status === 'MRM_STOP' || last.status === 'VIOLATION') break;
    const tick = Number(last.tick) || 0;
    if (tick === prevTick) {
      stableFor += 1;
      // ゴール圏内(進捗70%+)でのtick停滞は再生完了とみなす（l4RegressionLib.runRouteと同じ考え方）
      const nearGoal = Number(last.progressM || 0) >= Number(last.routeTotalM || 0) * 0.7;
      if (stableFor >= (nearGoal ? 4 : 20)) break;
    } else {
      stableFor = 0;
      prevTick = tick;
    }
  }
  return last;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const pageErrors = [];
  const chromeArgs = ['--enable-webgl', '--ignore-gpu-blocklist', '--disable-dev-shm-usage'];
  if (process.env.PUPPETEER_NO_SANDBOX === '1') {
    chromeArgs.push('--no-sandbox', '--disable-setuid-sandbox');
  }
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: getChromeExecutablePath() || undefined,
    defaultViewport: { width: 1440, height: 920 },
    args: chromeArgs
  });

  const asserts = { pass: 0, fail: 0 };
  function assertCheck(cond, label) {
    if (cond) {
      asserts.pass += 1;
      console.log(`[ASSERT] OK: ${label}`);
    } else {
      asserts.fail += 1;
      console.log(`[ASSERT] NG: ${label}`);
    }
    return cond;
  }

  let exitCode = 0;
  let summary = { target: opts.target, outcome: 'unknown' };

  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(opts.timeoutMs);
    page.on('pageerror', (err) => pageErrors.push(err.message || String(err)));

    // 自動テストではPLATEAU 3D Tilesストリーミング（外部・URL依存）を無効化する（既存スクリプトと同様）
    await page.evaluateOnNewDocument(() => { window.PLATEAU_DISABLE = true; });
    await page.goto(opts.target, { waitUntil: 'domcontentloaded', timeout: opts.timeoutMs });
    await page.waitForFunction(() => window.index3DReady === true, { timeout: opts.timeoutMs });
    // index3D_V2.0 は2Dルートマップが既定表示で、3D(#map3d)キャンバスは開くまで0x0のまま
    // （lazy init on open）。run_index3d_smoke.js と同じくどちらかが可視ならOKとする。
    await page.waitForFunction(() => {
      const canvas = document.querySelector('#map3d canvas');
      const routeMap = document.querySelector('#routeMapStage');
      const routeRect = routeMap?.getBoundingClientRect?.();
      const routeVisible = !!routeMap
        && routeRect?.width > 100
        && routeRect?.height > 100
        && getComputedStyle(routeMap).pointerEvents !== 'none';
      const canvasVisible = !!canvas && canvas.clientWidth > 100 && canvas.clientHeight > 100;
      return routeVisible || canvasVisible;
    }, { timeout: opts.timeoutMs });

    const hasDemo = await page.evaluate(() => typeof window.index3DRunDemo === 'function');
    if (hasDemo) {
      console.log('[INFO] window.index3DRunDemo() でデモワールドをロードします');
      await page.evaluate(() => window.index3DRunDemo());
      await page.waitForFunction(() => {
        const stats = window.index3DGetStats?.();
        return !!stats && stats.routePoints >= 2 && stats.worldLoaded === true;
      }, { timeout: opts.timeoutMs });
    } else {
      console.log('[INFO] window.index3DRunDemo 未定義 - デモロードをスキップします');
    }

    const hasPlay = await page.evaluate(() => typeof window.index3DPlay === 'function');
    if (hasPlay) {
      console.log('[INFO] window.index3DPlay() で再生を開始します');
      await page.evaluate(() => window.index3DPlay());
    } else {
      console.log('[INFO] window.index3DPlay 未定義 - 再生をスキップします');
    }

    const last = await pollUntilSettled(page, opts.timeoutMs);
    const progressM = last?.progressM ?? null;
    const routeTotalM = last?.routeTotalM ?? null;
    const mrmReason = last?.mrmStop?.reason ?? null;
    console.log(`[INFO] 再生終了: progressM=${progressM} / routeTotalM=${routeTotalM} status=${last?.status ?? 'null'} mrmReason=${mrmReason}`);
    summary.progressM = progressM;
    summary.routeTotalM = routeTotalM;
    summary.status = last?.status ?? null;
    summary.mrmReason = mrmReason;

    const hasRecoveryHook = await page.evaluate(() => typeof window.index3DGetRecoveryDebug === 'function');
    if (!hasRecoveryHook) {
      console.log('[SKIP] window.index3DGetRecoveryDebug 未定義（recoveryデバッグフック未実装のためプローブをスキップ）');
      summary.outcome = 'skip-hook-undefined';
      console.log(JSON.stringify(summary));
      return;
    }

    const recovery = await page.evaluate(() => window.index3DGetRecoveryDebug());
    const maneuvers = Array.isArray(recovery?.maneuvers) ? recovery.maneuvers : [];
    console.log(`[INFO] maneuver数=${maneuvers.length}（report.count=${recovery?.count ?? 'null'}）`);
    for (const m of maneuvers) {
      console.log(`[INFO]   source=${m?.source ?? '?'} sM=${m?.sM ?? '?'} lengthM=${m?.lengthM ?? '?'} `
        + `headingSweepDeg=${m?.headingSweepDeg ?? '?'} gearChanges=${m?.gearChanges ?? '?'} `
        + `poseCount=${m?.poseCount ?? '?'} accepted=${m?.accepted ?? '?'} rejectReason=${m?.rejectReason ?? ''}`);
    }
    summary.maneuverCount = maneuvers.length;
    summary.reportCount = recovery?.count ?? null;

    if (maneuvers.length === 0) {
      console.log('[INFO] switchback未発火（デモルートでK-turn/recoveryが起きなかった）- アサートはスキップします');
      summary.outcome = 'no-maneuvers';
      console.log(JSON.stringify(summary));
      return;
    }

    const accepted = maneuvers.filter((m) => m && m.accepted);
    summary.acceptedCount = accepted.length;

    const isSaneManeuver = (m) => Number.isFinite(m?.headingSweepDeg) && m.headingSweepDeg <= MAX_HEADING_SWEEP_DEG
      && Number.isFinite(m?.lengthM) && m.lengthM <= MAX_MANEUVER_LENGTH_M;
    const geometryOk = accepted.every(isSaneManeuver);
    assertCheck(geometryOk, `accepted maneuver は全て headingSweepDeg<=${MAX_HEADING_SWEEP_DEG} かつ lengthM<=${MAX_MANEUVER_LENGTH_M}`);
    if (!geometryOk) {
      for (const m of accepted) {
        if (!isSaneManeuver(m)) {
          console.log(`[ASSERT]   違反: source=${m.source} sM=${m.sM} lengthM=${m.lengthM} headingSweepDeg=${m.headingSweepDeg}`);
        }
      }
    }

    assertCheck(accepted.length <= MAX_ACCEPTED_MANEUVERS, `accepted maneuver数(${accepted.length}) <= ${MAX_ACCEPTED_MANEUVERS}`);

    assertCheck(pageErrors.length === 0, `pageerror 0件（実際=${pageErrors.length}件）`);
    if (pageErrors.length) {
      for (const e of pageErrors) console.log(`[ASSERT]   pageerror: ${e}`);
    }

    summary.outcome = asserts.fail > 0 ? 'assert-fail' : 'assert-pass';
    summary.assertPass = asserts.pass;
    summary.assertFail = asserts.fail;
    console.log(JSON.stringify(summary));

    if (asserts.fail > 0) {
      console.log(`[FAIL] アサート失敗 ${asserts.fail}件`);
      exitCode = 1;
    } else {
      console.log(`[PASS] 全アサート成功（${asserts.pass}件）`);
    }
  } finally {
    await browser.close();
  }

  process.exit(exitCode);
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
