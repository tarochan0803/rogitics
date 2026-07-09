#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const DEFAULT_FIXTURES = path.join(ROOT_DIR, 'benchmarks', 'index3d-golden-routes.json');
const DEFAULT_TARGET = process.env.LOGISTICS_INDEX3D_URL || 'http://127.0.0.1:8080/index3D_V1.0.html';
const DEFAULT_OUTPUT_DIR = path.join(ROOT_DIR, 'runtime', 'benchmarks3d');

function parseArgs(argv) {
  const opts = {
    fixtures: DEFAULT_FIXTURES,
    target: DEFAULT_TARGET,
    outDir: DEFAULT_OUTPUT_DIR,
    caseId: null,
    dryRun: false,
    headless: true,
    timeoutMs: 120000,
    fpsMs: 1600
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--fixtures') opts.fixtures = path.resolve(next());
    else if (arg.startsWith('--fixtures=')) opts.fixtures = path.resolve(arg.slice('--fixtures='.length));
    else if (arg === '--target') opts.target = next();
    else if (arg.startsWith('--target=')) opts.target = arg.slice('--target='.length);
    else if (arg === '--out') opts.outDir = path.resolve(next());
    else if (arg.startsWith('--out=')) opts.outDir = path.resolve(arg.slice('--out='.length));
    else if (arg === '--case') opts.caseId = next();
    else if (arg.startsWith('--case=')) opts.caseId = arg.slice('--case='.length);
    else if (arg === '--timeout') opts.timeoutMs = Number(next()) || opts.timeoutMs;
    else if (arg.startsWith('--timeout=')) opts.timeoutMs = Number(arg.slice('--timeout='.length)) || opts.timeoutMs;
    else if (arg === '--fps-ms') opts.fpsMs = Number(next()) || opts.fpsMs;
    else if (arg.startsWith('--fps-ms=')) opts.fpsMs = Number(arg.slice('--fps-ms='.length)) || opts.fpsMs;
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--headful') opts.headless = false;
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
    'Usage: node src/batch/run_index3d_benchmark.js [options]',
    '',
    'Options:',
    '  --fixtures <path>   Fixture JSON. Default: benchmarks/index3d-golden-routes.json',
    '  --target <url>      App URL. Default: LOGISTICS_INDEX3D_URL or http://127.0.0.1:8080/index3D_V1.0.html',
    '  --out <dir>         Output directory. Default: runtime/benchmarks3d',
    '  --case <id>         Run only one fixture case',
    '  --timeout <ms>      Per-case timeout. Default: 120000',
    '  --fps-ms <ms>       FPS sampling window. Default: 1600',
    '  --headful           Show Chrome window',
    '  --dry-run           Validate fixtures without opening the app'
  ].join('\n'));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function timestampForPath(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function displayPath(filePath) {
  const rel = path.relative(ROOT_DIR, filePath);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.replace(/\\/g, '/');
  return filePath;
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

function validateFixtures(fixtures) {
  const errors = [];
  if (!fixtures || typeof fixtures !== 'object') return ['Fixture root must be an object.'];
  if (!Array.isArray(fixtures.cases)) return ['Fixture root must include a cases array.'];
  const ids = new Set();
  fixtures.cases.forEach((testCase, index) => {
    const prefix = `cases[${index}]`;
    if (!testCase || typeof testCase !== 'object') {
      errors.push(`${prefix}: case must be an object.`);
      return;
    }
    if (!testCase.id || typeof testCase.id !== 'string') errors.push(`${prefix}: id is required.`);
    else if (ids.has(testCase.id)) errors.push(`${prefix}: duplicate id "${testCase.id}".`);
    else ids.add(testCase.id);
    if (!testCase.route && (!Array.isArray(testCase.endpoints) || testCase.endpoints.length < 2)) {
      errors.push(`${prefix}: route=\"demo\" or at least two endpoints are required.`);
    }
    if (testCase.route && testCase.route !== 'demo') errors.push(`${prefix}: unsupported route "${testCase.route}".`);
    if (!testCase.vehiclePreset || typeof testCase.vehiclePreset !== 'string') {
      errors.push(`${prefix}: vehiclePreset is required.`);
    }
    if (testCase.endpoints) {
      testCase.endpoints.forEach((point, pointIndex) => {
        if (!Number.isFinite(Number(point?.lat)) || !Number.isFinite(Number(point?.lng))) {
          errors.push(`${prefix}.endpoints[${pointIndex}]: lat/lng must be finite numbers.`);
        }
      });
    }
  });
  return errors;
}

function pickCases(fixtures, caseId) {
  const cases = fixtures.cases || [];
  if (!caseId) return cases;
  return cases.filter((testCase) => testCase.id === caseId);
}

async function launchBrowser(opts) {
  const executablePath = getChromeExecutablePath();
  const launchOptions = {
    headless: opts.headless,
    defaultViewport: { width: 1440, height: 920 },
    args: ['--enable-webgl', '--ignore-gpu-blocklist', '--disable-dev-shm-usage']
  };
  if (executablePath) launchOptions.executablePath = executablePath;
  return puppeteer.launch(launchOptions);
}

async function waitForIndex3D(page, target, timeoutMs) {
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  await page.waitForFunction(() => window.index3DReady === true, { timeout: timeoutMs });
  await page.waitForSelector('#map3d canvas', { timeout: timeoutMs });
  await page.waitForFunction(() => {
    const canvas = document.querySelector('#map3d canvas');
    return !!canvas && canvas.clientWidth > 100 && canvas.clientHeight > 100;
  }, { timeout: timeoutMs });
}

async function runRouteSetup(page, testCase, timeoutMs) {
  return page.evaluate(async ({ testCase: browserCase, timeoutMs: browserTimeout }) => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const waitFor = async (predicate, timeout, label) => {
      const start = performance.now();
      while (performance.now() - start < timeout) {
        if (predicate()) return;
        await sleep(150);
      }
      throw new Error(`Timed out waiting for ${label}`);
    };
    const started = performance.now();
    const preset = browserCase.vehiclePreset || '4t_flat';
    if (window.store?.applyVehiclePreset) window.store.applyVehiclePreset(preset);
    const select = document.getElementById('vehiclePreset');
    if (select) {
      select.value = preset;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }

    if (browserCase.route === 'demo') {
      await window.index3DRunDemo();
    } else if (Array.isArray(browserCase.endpoints) && browserCase.endpoints.length >= 2) {
      const points = browserCase.endpoints.map((p, index) => ({
        id: `bench3d-${browserCase.id}-${index}`,
        lat: Number(p.lat),
        lng: Number(p.lng),
        label: p.name || `point-${index + 1}`
      }));
      const coords = points.map((p) => `${p.lng},${p.lat}`).join(';');
      const params = new URLSearchParams({
        overview: 'full',
        geometries: 'geojson',
        steps: 'false',
        annotations: 'false'
      });
      const res = await fetch(`https://router.project-osrm.org/route/v1/driving/${coords}?${params.toString()}`);
      if (!res.ok) throw new Error(`OSRM HTTP ${res.status}`);
      const json = await res.json();
      const route = json.routes?.[0];
      if (!route?.geometry?.coordinates?.length) throw new Error('OSRM returned no route');
      const simRoute = route.geometry.coordinates.map(([lng, lat]) => ({ lat, lng }));
      window.store.setSelectedEndpoints(points);
      window.store.setRoutePlan({
        selectionRoute: simRoute,
        trajectoryRoute: simRoute,
        candidates: [],
        routeMeta: {
          source: 'index3d-benchmark',
          displayName: browserCase.id,
          distance: route.distance,
          duration: route.duration
        }
      });
      await window.index3DLoadWorld();
      window.index3DPlay();
    } else {
      throw new Error('No supported route source');
    }

    await waitFor(() => {
      const stats = window.index3DGetStats?.();
      return !!stats && stats.routePoints >= 2 && stats.worldLoaded === true;
    }, browserTimeout, '3D world load');
    return Math.round(performance.now() - started);
  }, { testCase, timeoutMs });
}

async function measureFps(page, fpsMs) {
  return page.evaluate((durationMs) => new Promise((resolve) => {
    let frames = 0;
    let first = null;
    let last = null;
    const step = (ts) => {
      if (first == null) first = ts;
      last = ts;
      frames += 1;
      if (ts - first >= durationMs) {
        const seconds = Math.max(0.001, (last - first) / 1000);
        resolve({
          frames,
          durationMs: Math.round(last - first),
          fps: Math.round((frames / seconds) * 10) / 10
        });
      } else {
        requestAnimationFrame(step);
      }
    };
    requestAnimationFrame(step);
  }), fpsMs);
}

async function collectCaseMetrics(page, testCase, loadTimeMs, fpsMs) {
  const fixtureResult = testCase.fixture === 'low-clearance'
    ? await page.evaluate(() => window.index3DRunPhase4Validation?.() || null)
    : null;

  const perceptionResult = testCase.perception
    ? await page.evaluate(() => window.index3DRunPerceptionFixture?.() || null)
    : null;

  const fps = await measureFps(page, fpsMs);
  const metrics = await page.evaluate(() => {
    const stats = window.index3DGetStats?.() || {};
    const solid = window.index3DGetClearanceSolidReport?.() || null;
    const autonomy = window.index3DGetAutonomyReport?.() || null;
    const perception = window.index3DGetPerceptionReport?.() || null;
    const width = window.index3DGetRoadWidthReport?.() || null;
    const surface = window.index3DGetRoadSurfaceMetrics?.() || null;
    const contactCount = Number(document.getElementById('map3dCollisionCount')?.textContent || 0) || 0;
    return {
      stats,
      solidSummary: solid?.summary || null,
      autonomySummary: autonomy?.summary || null,
      perceptionSummary: perception?.summary || null,
      widthSummary: width?.summary || null,
      roadSurface: surface || null,
      contactCount
    };
  });

  const fixtureSummary = fixtureResult?.fixtureSummary || null;
  const activeAutonomy = fixtureSummary || metrics.autonomySummary || {};
  const obstacleSolids = Number(metrics.solidSummary?.obstacleSolidCount || 0) + Number(metrics.solidSummary?.overheadSolidCount || 0);
  return {
    loadTimeMs,
    fps,
    routePoints: metrics.stats.routePoints || 0,
    roads: metrics.stats.roadFeatures || 0,
    buildings: metrics.stats.buildingFeatures || 0,
    contactCount: metrics.contactCount,
    minimumClearanceM: metrics.solidSummary?.minClearanceM ?? activeAutonomy.minForwardClearanceM ?? null,
    stopEventCount: Number(activeAutonomy.stopEventCount || 0),
    slowEventCount: Number(activeAutonomy.slowEventCount || 0),
    steeringSaturationRatio: Number(activeAutonomy.steeringSaturationRatio || 0),
    reverseCount: Number(activeAutonomy.reverseCount || 0),
    recoveredStopCount: Number(activeAutonomy.recoveredStopCount || 0),
    unresolvedStopCount: Number(activeAutonomy.unresolvedStopCount || 0),
    recoveryStatus: activeAutonomy.recoveryStatus || null,
    yoloCoverage: Number(metrics.widthSummary?.yoloCoverage || 0),
    obstacleSolids,
    autonomyStatus: activeAutonomy.status || null,
    minAllowedSpeedKmh: activeAutonomy.minAllowedSpeedKmh ?? null,
    maxAllowedSpeedKmh: activeAutonomy.maxAllowedSpeedKmh ?? null,
    phase3: metrics.solidSummary,
    phase4: metrics.autonomySummary,
    phase5: metrics.perceptionSummary,
    fixture: fixtureResult ? {
      ok: !!fixtureResult.ok,
      detected: !!fixtureResult.detected,
      fixtureId: fixtureResult.fixtureId,
      summary: fixtureResult.fixtureSummary
    } : null,
    perception: perceptionResult ? {
      source: perceptionResult.summary?.source || null,
      appliedCount: perceptionResult.summary?.appliedCount ?? null,
      pendingCount: perceptionResult.summary?.pendingCount ?? null,
      obstacleCount: perceptionResult.summary?.obstacleCount ?? null
    } : null
  };
}

function compareExpected(testCase, actual) {
  const expected = testCase.expected || {};
  const failures = [];
  const statusAnyOf = Array.isArray(expected.statusAnyOf) ? expected.statusAnyOf : [];
  if (statusAnyOf.length && !statusAnyOf.includes(actual.autonomyStatus)) {
    failures.push(`status expected one of ${statusAnyOf.join(', ')}, got ${actual.autonomyStatus || 'null'}`);
  }
  const checks = [
    ['minStopEventCount', actual.stopEventCount, (a, e) => a >= e, '>='],
    ['maxStopEventCount', actual.stopEventCount, (a, e) => a <= e, '<='],
    ['maxContactCount', actual.contactCount, (a, e) => a <= e, '<='],
    ['minFps', actual.fps?.fps, (a, e) => a >= e, '>='],
    ['minYoloCoverage', actual.yoloCoverage, (a, e) => a >= e, '>='],
    ['minObstacleSolids', actual.obstacleSolids, (a, e) => a >= e, '>='],
    ['maxMinAllowedSpeedKmh', actual.minAllowedSpeedKmh, (a, e) => a <= e, '<='],
    ['maxSteeringSaturationRatio', actual.steeringSaturationRatio, (a, e) => a <= e, '<=']
  ];
  for (const [key, actualValue, fn, op] of checks) {
    if (!Number.isFinite(Number(expected[key]))) continue;
    if (!Number.isFinite(Number(actualValue)) || !fn(Number(actualValue), Number(expected[key]))) {
      failures.push(`${key}: expected actual ${op} ${expected[key]}, got ${actualValue}`);
    }
  }
  return {
    checked: statusAnyOf.length > 0 || checks.some(([key]) => Number.isFinite(Number(expected[key]))),
    passed: failures.length === 0,
    failures
  };
}

function summarize(results, startedAt, finishedAt, opts) {
  const completed = results.filter((r) => r.status === 'completed');
  const errored = results.filter((r) => r.status === 'error');
  const checked = completed.filter((r) => r.expectation.checked);
  const failed = checked.filter((r) => !r.expectation.passed);
  const avg = (key) => {
    const vals = completed.map((r) => Number(r.actual?.[key])).filter(Number.isFinite);
    return vals.length ? Number((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(3)) : null;
  };
  return {
    generatedAt: finishedAt.toISOString(),
    startedAt: startedAt.toISOString(),
    target: opts.target,
    fixtureFile: displayPath(opts.fixtures),
    total: results.length,
    completed: completed.length,
    errors: errored.length,
    expectationsChecked: checked.length,
    failedExpectations: failed.length,
    averageFps: avg('fpsValue'),
    averageLoadTimeMs: avg('loadTimeMs'),
    averageYoloCoverage: avg('yoloCoverage')
  };
}

function normalizeForSummary(entry) {
  if (entry.status !== 'completed') return entry;
  return {
    ...entry,
    actual: {
      ...entry.actual,
      fpsValue: entry.actual.fps?.fps ?? null
    }
  };
}

function markdownSummary(summary, results) {
  const rows = results.map((entry) => {
    if (entry.status === 'error') {
      return `| ${entry.id} | ${entry.classification || '-'} | ERROR | - | - | - | - | ${escapePipe(entry.error)} |`;
    }
    const actual = entry.actual;
    const mark = !entry.expectation.checked ? 'MEASURE' : (entry.expectation.passed ? 'OK' : 'FAIL');
    const notes = entry.expectation.failures.join('; ');
    return `| ${entry.id} | ${entry.classification || '-'} | ${actual.autonomyStatus || '-'} | ${actual.fps?.fps ?? '-'} | ${actual.loadTimeMs} | ${actual.stopEventCount} | ${actual.yoloCoverage} | ${mark}${notes ? `: ${escapePipe(notes)}` : ''} |`;
  });
  return [
    '# index3D Benchmark Summary',
    '',
    `- Generated: ${summary.generatedAt}`,
    `- Target: ${summary.target}`,
    `- Fixture: ${summary.fixtureFile}`,
    `- Completed: ${summary.completed}/${summary.total}`,
    `- Failed expectations: ${summary.failedExpectations}`,
    `- Average FPS: ${summary.averageFps ?? '-'}`,
    `- Average load time ms: ${summary.averageLoadTimeMs ?? '-'}`,
    '',
    '| Case | Class | Status | FPS | Load ms | Stop | YOLO coverage | Check |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: | --- |',
    ...rows,
    ''
  ].join('\n');
}

function escapePipe(value) {
  return String(value || '').replace(/\|/g, '\\|');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const fixtures = readJson(opts.fixtures);
  const errors = validateFixtures(fixtures);
  if (errors.length) {
    errors.forEach((error) => console.error(`[index3d-bench] fixture error: ${error}`));
    process.exit(1);
  }
  const cases = pickCases(fixtures, opts.caseId);
  if (!cases.length) throw new Error(opts.caseId ? `No fixture case matched "${opts.caseId}".` : 'No fixture cases to run.');
  console.log(`[index3d-bench] fixtures: ${opts.fixtures}`);
  console.log(`[index3d-bench] cases: ${cases.length}`);
  if (opts.dryRun) {
    console.log('[index3d-bench] dry-run OK. Browser execution skipped.');
    return;
  }

  fs.mkdirSync(opts.outDir, { recursive: true });
  const startedAt = new Date();
  const runDir = path.join(opts.outDir, timestampForPath(startedAt));
  fs.mkdirSync(runDir, { recursive: true });
  const browser = await launchBrowser(opts);
  const results = [];
  const browserMessages = [];

  try {
    for (const testCase of cases) {
      console.log(`[index3d-bench] run ${testCase.id}`);
      const page = await browser.newPage();
      page.setDefaultTimeout(opts.timeoutMs);
      page.on('console', (msg) => {
        const text = msg.text();
        browserMessages.push({ caseId: testCase.id, type: msg.type(), text });
      });
      page.on('pageerror', (err) => {
        browserMessages.push({ caseId: testCase.id, type: 'pageerror', text: err.stack || err.message });
      });
      const started = new Date();
      try {
        await waitForIndex3D(page, opts.target, opts.timeoutMs);
        const loadTimeMs = await runRouteSetup(page, testCase, opts.timeoutMs);
        const actual = await collectCaseMetrics(page, testCase, loadTimeMs, opts.fpsMs);
        const expectation = compareExpected(testCase, actual);
        const entry = normalizeForSummary({
          id: testCase.id,
          name: testCase.name || testCase.id,
          classification: testCase.classification || null,
          status: 'completed',
          startedAt: started.toISOString(),
          finishedAt: new Date().toISOString(),
          expected: testCase.expected || {},
          expectation,
          actual
        });
        results.push(entry);
        const mark = !expectation.checked ? 'MEASURE' : (expectation.passed ? 'OK' : 'FAIL');
        console.log(`[index3d-bench] ${testCase.id}: ${actual.autonomyStatus} fps=${actual.fps?.fps} stop=${actual.stopEventCount} ${mark}`);
      } catch (err) {
        results.push({
          id: testCase.id,
          name: testCase.name || testCase.id,
          classification: testCase.classification || null,
          status: 'error',
          startedAt: started.toISOString(),
          finishedAt: new Date().toISOString(),
          expected: testCase.expected || {},
          error: err.stack || err.message
        });
        console.error(`[index3d-bench] ${testCase.id}: ERROR ${err.message}`);
      } finally {
        await page.close().catch(() => {});
      }
    }

    const finishedAt = new Date();
    const summary = summarize(results, startedAt, finishedAt, opts);
    fs.writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify({ summary, cases: results }, null, 2), 'utf8');
    fs.writeFileSync(path.join(runDir, 'summary.md'), markdownSummary(summary, results), 'utf8');
    fs.writeFileSync(path.join(runDir, 'browser-console.json'), JSON.stringify(browserMessages, null, 2), 'utf8');

    console.log(`[index3d-bench] output: ${runDir}`);
    console.log(`[index3d-bench] completed=${summary.completed}/${summary.total} failedExpectations=${summary.failedExpectations} errors=${summary.errors}`);
    if (summary.failedExpectations > 0 || summary.errors > 0) process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(`[index3d-bench] fatal: ${err.stack || err.message}`);
  process.exit(1);
});
