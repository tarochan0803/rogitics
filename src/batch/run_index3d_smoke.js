#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const DEFAULT_TARGET = process.env.LOGISTICS_INDEX3D_URL || 'http://127.0.0.1:8080/index3D_V1.0.html';
const DEFAULT_OUTPUT_DIR = path.join(ROOT_DIR, 'runtime', 'logs');

function parseArgs(argv) {
  const opts = {
    target: DEFAULT_TARGET,
    outDir: DEFAULT_OUTPUT_DIR,
    headless: true,
    demo: false,
    existingRoute: false,
    phase7Playback: false,
    timeoutMs: 90000
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--target') opts.target = next();
    else if (arg.startsWith('--target=')) opts.target = arg.slice('--target='.length);
    else if (arg === '--out') opts.outDir = path.resolve(next());
    else if (arg.startsWith('--out=')) opts.outDir = path.resolve(arg.slice('--out='.length));
    else if (arg === '--demo') opts.demo = true;
    else if (arg === '--existing-route') opts.existingRoute = true;
    else if (arg === '--phase7-playback') { opts.phase7Playback = true; opts.demo = true; }
    else if (arg === '--headful') opts.headless = false;
    else if (arg === '--timeout') opts.timeoutMs = Number(next()) || opts.timeoutMs;
    else if (arg.startsWith('--timeout=')) opts.timeoutMs = Number(arg.slice('--timeout='.length)) || opts.timeoutMs;
    else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return opts;
}

function printUsage() {
  console.log([
    'Usage: node src/batch/run_index3d_smoke.js [options]',
    '',
    'Options:',
    '  --target <url>   App URL. Default: LOGISTICS_INDEX3D_URL or http://127.0.0.1:8080/index3D_V1.0.html',
    '  --out <dir>      Output directory. Default: runtime/logs',
    '  --demo           Also run the network-backed demo route/world load',
    '  --existing-route Run the index9-style road/endpoints/confirm flow',
    '  --phase7-playback Run the live reverse/replan playback validation',
    '  --headful        Show the browser window',
    '  --timeout <ms>   Timeout. Default: 90000'
  ].join('\n'));
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

function redactUrl(url) {
  return String(url || '').replace(/([?&]key=)[^&]+/gi, '$1<redacted>');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  fs.mkdirSync(opts.outDir, { recursive: true });

  const pageErrors = [];
  const consoleErrors = [];
  const requestFailures = [];
  const chromeArgs = ['--enable-webgl', '--ignore-gpu-blocklist', '--disable-dev-shm-usage'];
  if (process.env.PUPPETEER_NO_SANDBOX === '1') {
    chromeArgs.push('--no-sandbox', '--disable-setuid-sandbox');
  }
  const browser = await puppeteer.launch({
    headless: opts.headless,
    executablePath: getChromeExecutablePath() || undefined,
    defaultViewport: { width: 1440, height: 920 },
    args: chromeArgs
  });

  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(opts.timeoutMs);
    page.on('pageerror', (err) => pageErrors.push(err.message || String(err)));
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('requestfailed', (req) => {
      const url = req.url();
      if (/favicon|transparent\.png/i.test(url)) return;
      requestFailures.push(`${req.failure()?.errorText || 'failed'} ${redactUrl(url)}`);
    });

    // 自動テストではPLATEAU 3D Tilesストリーミング（外部・URL依存）を無効化し、OSM建物経路を検証する
    await page.evaluateOnNewDocument(() => { window.PLATEAU_DISABLE = true; });
    await page.goto(opts.target, { waitUntil: 'domcontentloaded', timeout: opts.timeoutMs });
    await page.waitForFunction(() => window.index3DReady === true, { timeout: opts.timeoutMs });
    await page.waitForSelector('#map3d canvas', { timeout: opts.timeoutMs });
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

    if (opts.demo) {
      await page.evaluate(() => window.index3DRunDemo());
      await page.waitForFunction(() => {
        const stats = window.index3DGetStats?.();
        return !!stats && stats.routePoints >= 2 && stats.worldLoaded === true;
      }, { timeout: opts.timeoutMs });
    }

    if (opts.existingRoute) {
      await page.click('#topRefreshData');
      await page.waitForFunction(() => {
        const stats = window.index3DGetStats?.();
        return !!stats && stats.roadFeatures > 0;
      }, { timeout: opts.timeoutMs });

      await page.evaluate(() => {
        const map = window._leafletMap;
        if (!map || !window.L) throw new Error('Leaflet map is unavailable');
        const fireClick = (lat, lng) => {
          map.fire('click', {
            latlng: window.L.latLng(lat, lng),
            layerPoint: map.latLngToLayerPoint([lat, lng]),
            containerPoint: map.latLngToContainerPoint([lat, lng]),
            originalEvent: new MouseEvent('click')
          });
        };
        fireClick(35.680700, 139.764600);
        fireClick(35.679900, 139.764200);
      });

      await page.waitForFunction(() => {
        const stats = window.index3DGetStats?.();
        return !!stats && stats.routePoints >= 2;
      }, { timeout: opts.timeoutMs });
      await page.click('#confirm-route');
      await page.waitForFunction(() => {
        const stats = window.index3DGetStats?.();
        const confirm = document.getElementById('confirm-route');
        const confirmedText = String(confirm?.textContent || '').includes('確定済み');
        return !!stats && stats.routePoints >= 2 && stats.worldLoaded === true && (!!confirm?.disabled || confirmedText);
      }, { timeout: opts.timeoutMs });
    }

    const stats = await page.evaluate(() => window.index3DGetStats?.() || null);

    // Phase 2 検証: 道路幅の根拠が取得でき、手動上書きで3D走行面（面積）が更新されること
    let phase2 = null;
    let phase3 = null;
    let phase4 = null;
    let phase5 = null;
    let phase7 = null;
    let phase7Playback = null;
    if (stats?.worldLoaded) {
      phase2 = await page.evaluate(() => {
        const report = window.index3DGetRoadWidthReport?.();
        if (!report || !Array.isArray(report.rows) || !report.rows.length) {
          return { ok: false, reason: 'no road width rows' };
        }
        const before = window.index3DGetRoadSurfaceMetrics?.() || {};
        const target = report.rows.find((r) => r.id != null) || report.rows[0];
        const baseW = Number.isFinite(target.finalWidth) ? target.finalWidth : 6;
        const newW = Math.min(40, Math.max(baseW + 12, 24));
        const after = window.index3DApplyWidthOverride?.(target.id, newW) || {};
        return {
          ok: true,
          featureCount: report.summary?.featureCount ?? report.rows.length,
          osmMeasuredCoverage: report.summary?.osmMeasuredCoverage ?? null,
          yoloCoverage: report.summary?.yoloCoverage ?? null,
          averageConfidence: report.summary?.averageConfidence ?? null,
          overrideRoadId: String(target.id),
          widthBefore: baseW,
          widthApplied: newW,
          surfaceAreaBefore: before.areaM2 ?? null,
          surfaceAreaAfter: after.areaM2 ?? null,
          surfaceAreaIncreased: Number(after.areaM2 || 0) > Number(before.areaM2 || 0)
        };
      });
      if (phase2 && phase2.ok && !phase2.surfaceAreaIncreased) {
        throw new Error(`Phase2: width override did not update road surface (before=${phase2.surfaceAreaBefore}, after=${phase2.surfaceAreaAfter})`);
      }

      phase3 = await page.evaluate(() => {
        const report = window.index3DGetClearanceSolidReport?.();
        const validation = window.index3DRunPhase3Validation?.();
        if (!report || !validation) return { ok: false, reason: 'phase3 hooks unavailable' };
        return {
          ok: !!validation.ok,
          buildingSolidCount: report.summary?.buildingSolidCount ?? null,
          obstacleSolidCount: report.summary?.obstacleSolidCount ?? null,
          overheadSolidCount: report.summary?.overheadSolidCount ?? null,
          lowClearanceCount: report.summary?.lowClearanceCount ?? null,
          fixtureLowClearanceCount: validation.fixtureSummary?.lowClearanceCount ?? null,
          fixtureId: validation.fixtureId,
          collisionSolidMetrics: validation.collisionSolidMetrics
        };
      });
      if (!phase3?.ok) {
        throw new Error(`Phase3: clearance validation failed (${phase3?.reason || JSON.stringify(phase3)})`);
      }

      phase4 = await page.evaluate(() => {
        const report = window.index3DGetAutonomyReport?.();
        const validation = window.index3DRunPhase4Validation?.();
        if (!report || !validation) return { ok: false, reason: 'phase4 hooks unavailable' };
        return {
          ok: !!validation.ok,
          status: report.summary?.status ?? null,
          sampleCount: report.summary?.sampleCount ?? null,
          blockerCount: report.summary?.blockerCount ?? null,
          minForwardClearanceM: report.summary?.minForwardClearanceM ?? null,
          stopEventCount: report.summary?.stopEventCount ?? null,
          slowEventCount: report.summary?.slowEventCount ?? null,
          steeringSaturationRatio: report.summary?.steeringSaturationRatio ?? null,
          fixtureStopEventCount: validation.fixtureSummary?.stopEventCount ?? null,
          fixtureDetected: validation.detected,
          fixtureId: validation.fixtureId,
          fixtureMinAllowedSpeedKmh: validation.fixtureSummary?.minAllowedSpeedKmh ?? null,
          baseMinAllowedSpeedKmh: validation.baseSummary?.minAllowedSpeedKmh ?? null
        };
      });
      if (!phase4?.ok) {
        throw new Error(`Phase4: autonomy validation failed (${phase4?.reason || JSON.stringify(phase4)})`);
      }

      // Phase 5 検証: 知覚スキャン（合成）で width_ai が増え（yoloCoverage>0）、3D走行面が更新され、
      // 低信頼の幅候補は自動採用されず（pending>0）、YOLO障害物が接触判定ソリッドに反映される。
      phase5 = await page.evaluate(() => {
        const validation = window.index3DRunPhase5Validation?.();
        const report = window.index3DGetPerceptionReport?.();
        if (!validation || !report) return { ok: false, reason: 'phase5 hooks unavailable' };
        // 補正クリアで width_ai（yoloCoverage）が baseline まで戻ることを検証
        const clearedWidth = window.index3DClearPerception?.() || {};
        const clearReport = window.index3DGetPerceptionReport?.();
        return {
          ok: !!validation.ok,
          source: report.summary?.source ?? null,
          yoloCoverageBefore: validation.yoloCoverageBefore,
          yoloCoverageAfter: validation.yoloCoverageAfter,
          surfaceAreaBefore: validation.surfaceAreaBefore,
          surfaceAreaAfter: validation.surfaceAreaAfter,
          surfaceChanged: validation.surfaceChanged,
          obstacleSolidsBefore: validation.obstacleSolidsBefore,
          obstacleSolidsAfter: validation.obstacleSolidsAfter,
          appliedCount: validation.appliedCount,
          pendingCount: validation.pendingCount,
          pendingKept: validation.pendingKept,
          // クリア検証
          yoloCoverageAfterClear: Number(clearedWidth.yoloCoverage || 0),
          reportClearedToNull: clearReport == null,
          clearResetsWidth: Number(clearedWidth.yoloCoverage || 0) <= Number(validation.yoloCoverageBefore || 0)
        };
      });
      if (!phase5?.ok) {
        throw new Error(`Phase5: perception fusion validation failed (${phase5?.reason || JSON.stringify(phase5)})`);
      }
      if (!phase5.clearResetsWidth || !phase5.reportClearedToNull) {
        throw new Error(`Phase5: 補正クリアが幅補正を戻していない (afterClear=${phase5.yoloCoverageAfterClear}, before=${phase5.yoloCoverageBefore})`);
      }

      // Phase 7 検証: 復旧可能な地上障害物では後退+切り返し（reverseCount>0）で復旧し、
      // 頭上の低クリアランスでは後退しても通れず未復旧（reverseCount=0, UNRESOLVED）になる。
      phase7 = await page.evaluate(() => {
        const v = window.index3DRunPhase7Validation?.();
        if (!v) return { ok: false, reason: 'phase7 hooks unavailable' };
        return {
          ok: !!v.ok,
          groundStopEvents: v.ground?.stopEventCount ?? null,
          groundReverseCount: v.ground?.reverseCount ?? null,
          groundRecoveredStopCount: v.ground?.recoveredStopCount ?? null,
          groundRecoveryStatus: v.ground?.recoveryStatus ?? null,
          overheadStopEvents: v.overhead?.stopEventCount ?? null,
          overheadReverseCount: v.overhead?.reverseCount ?? null,
          overheadRecoveryStatus: v.overhead?.recoveryStatus ?? null
        };
      });
      if (!phase7?.ok) {
        throw new Error(`Phase7: recovery validation failed (${phase7?.reason || JSON.stringify(phase7)})`);
      }

      if (opts.phase7Playback) {
        phase7Playback = await page.evaluate(() => window.index3DRunPhase7PlaybackValidation?.({ timeoutMs: 22000, speedKmh: 32 }) || null);
        if (!phase7Playback?.ok) {
          throw new Error(`Phase7 playback: live recovery did not progress (${phase7Playback?.reason || JSON.stringify(phase7Playback)})`);
        }
      }
    }

    const canvasBox = await page.$eval('#map3d canvas', (canvas) => ({
      width: canvas.clientWidth,
      height: canvas.clientHeight
    }));
    const screenshot = path.join(opts.outDir, `index3d_smoke_${Date.now()}.png`);
    await page.screenshot({ path: screenshot, fullPage: false });

    const fatalErrors = [
      ...pageErrors,
      // PLATEAU(CORS/取得失敗→OSMフォールバック) や 未起動の任意ローカルサーバ(YOLO :8001 等)は致命扱いしない
      ...consoleErrors.filter((line) => !/Google|favicon|ERR_ABORTED|ERR_CONNECTION_TIMED_OUT|429|504|Too Many Requests|Gateway Timeout|ResizeObserver|plateau|mlit\.go\.jp|3d-tiles|tileset\.json|CORS|Failed to fetch|esm\.sh|ERR_CONNECTION_REFUSED|:8001|yolo/i.test(line))
    ];
    if (fatalErrors.length) {
      throw new Error(`Browser errors:\n${fatalErrors.join('\n')}`);
    }

    console.log(JSON.stringify({
      ok: true,
      target: opts.target,
      canvas: canvasBox,
      stats,
      phase2,
      phase3,
      phase4,
      phase5,
      phase7,
      phase7Playback,
      requestFailures: requestFailures.slice(0, 8),
      screenshot
    }, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
