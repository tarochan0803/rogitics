#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const DEFAULT_FIXTURES = path.join(ROOT_DIR, 'benchmarks', 'golden-routes.json');
const DEFAULT_TARGET = process.env.LOGISTICS_BENCH_URL || 'http://127.0.0.1:8080/index8.2.html';
const DEFAULT_OUTPUT_DIR = path.join(ROOT_DIR, 'runtime', 'benchmarks');

function parseArgs(argv) {
  const options = {
    fixtures: DEFAULT_FIXTURES,
    target: DEFAULT_TARGET,
    outDir: DEFAULT_OUTPUT_DIR,
    caseId: null,
    dryRun: false,
    headless: true,
    navigationTimeoutMs: 90000,
    caseTimeoutMs: 120000
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--fixtures') options.fixtures = path.resolve(next());
    else if (arg.startsWith('--fixtures=')) options.fixtures = path.resolve(arg.slice('--fixtures='.length));
    else if (arg === '--target') options.target = next();
    else if (arg.startsWith('--target=')) options.target = arg.slice('--target='.length);
    else if (arg === '--out') options.outDir = path.resolve(next());
    else if (arg.startsWith('--out=')) options.outDir = path.resolve(arg.slice('--out='.length));
    else if (arg === '--case') options.caseId = next();
    else if (arg.startsWith('--case=')) options.caseId = arg.slice('--case='.length);
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--headful') options.headless = false;
    else if (arg === '--timeout') options.caseTimeoutMs = Number(next()) || options.caseTimeoutMs;
    else if (arg.startsWith('--timeout=')) options.caseTimeoutMs = Number(arg.slice('--timeout='.length)) || options.caseTimeoutMs;
    else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function printUsage() {
  console.log([
    'Usage: node src/batch/run_golden_benchmark.js [options]',
    '',
    'Options:',
    '  --fixtures <path>   Fixture JSON. Default: benchmarks/golden-routes.json',
    '  --target <url>      App URL. Default: LOGISTICS_BENCH_URL or http://127.0.0.1:8080/index8.2.html',
    '  --out <dir>         Output directory. Default: runtime/benchmarks',
    '  --case <id>         Run only one fixture case',
    '  --timeout <ms>      Per-case timeout. Default: 120000',
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

function isFiniteCoordPoint(point) {
  return Number.isFinite(Number(point?.lat)) && Number.isFinite(Number(point?.lng));
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
    if (!testCase.id || typeof testCase.id !== 'string') {
      errors.push(`${prefix}: id is required.`);
    } else if (ids.has(testCase.id)) {
      errors.push(`${prefix}: duplicate id "${testCase.id}".`);
    } else {
      ids.add(testCase.id);
    }
    if (!testCase.vehiclePreset || typeof testCase.vehiclePreset !== 'string') {
      errors.push(`${prefix}: vehiclePreset is required.`);
    }
    if (!Array.isArray(testCase.endpoints) || testCase.endpoints.length < 2) {
      errors.push(`${prefix}: endpoints must include at least 2 points.`);
    } else {
      testCase.endpoints.forEach((point, pointIndex) => {
        if (!isFiniteCoordPoint(point)) errors.push(`${prefix}.endpoints[${pointIndex}]: lat/lng must be finite numbers.`);
      });
    }
    const expected = testCase.expected || {};
    if (expected.overallStatusAnyOf && !Array.isArray(expected.overallStatusAnyOf)) {
      errors.push(`${prefix}.expected.overallStatusAnyOf must be an array when present.`);
    }
    if ('passable' in expected && expected.passable !== null && typeof expected.passable !== 'boolean') {
      errors.push(`${prefix}.expected.passable must be true, false, or null.`);
    }
  });
  return errors;
}

function pickCases(fixtures, caseId) {
  const cases = fixtures.cases || [];
  if (!caseId) return cases;
  return cases.filter((testCase) => testCase.id === caseId);
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

async function launchBrowser(options) {
  const executablePath = getChromeExecutablePath();
  const launchOptions = {
    headless: options.headless ? 'new' : false,
    defaultViewport: { width: 1440, height: 1000 },
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  };
  if (executablePath) launchOptions.executablePath = executablePath;
  return puppeteer.launch(launchOptions);
}

async function waitForApp(page, timeoutMs) {
  await page.waitForFunction(() => (
    window.store
    && typeof window.store.getState === 'function'
    && typeof window.store.setSelectedEndpoints === 'function'
    && typeof window.runSingleVehicleAssessment === 'function'
  ), { timeout: timeoutMs });
}

function expectedStatuses(expected = {}) {
  if (Array.isArray(expected.overallStatusAnyOf)) return expected.overallStatusAnyOf.filter(Boolean);
  if (typeof expected.overallStatus === 'string') return [expected.overallStatus];
  return [];
}

function isPassableStatus(status) {
  return status === 'PASS' || status === 'CONDITIONAL';
}

function compareCase(testCase, actual) {
  const expected = testCase.expected || {};
  const failures = [];
  const allowedStatuses = expectedStatuses(expected);
  const statusUniverse = ['CONDITIONAL', 'NG', 'PASS'];
  const sortedAllowed = [...new Set(allowedStatuses)].sort();
  const isNonStrictSeedStatus = sortedAllowed.length === statusUniverse.length
    && statusUniverse.every((status, index) => sortedAllowed[index] === status);
  const hasStrictStatusExpectation = allowedStatuses.length > 0 && !isNonStrictSeedStatus;
  if (hasStrictStatusExpectation && !allowedStatuses.includes(actual.overallStatus)) {
    failures.push(`overallStatus expected one of ${allowedStatuses.join(', ')}, got ${actual.overallStatus || 'null'}`);
  }
  if (Number.isFinite(Number(expected.minScore)) && Number(actual.score) < Number(expected.minScore)) {
    failures.push(`score expected >= ${expected.minScore}, got ${actual.score}`);
  }
  if (Number.isFinite(Number(expected.maxViolationCount)) && Number(actual.violationsCount) > Number(expected.maxViolationCount)) {
    failures.push(`violations expected <= ${expected.maxViolationCount}, got ${actual.violationsCount}`);
  }
  if (Number.isFinite(Number(expected.maxContactRatio)) && Number(actual.contactRatio) > Number(expected.maxContactRatio)) {
    failures.push(`contactRatio expected <= ${expected.maxContactRatio}, got ${actual.contactRatio}`);
  }
  if (typeof expected.passable === 'boolean') {
    const actualPassable = isPassableStatus(actual.overallStatus);
    if (actualPassable !== expected.passable) failures.push(`passable expected ${expected.passable}, got ${actualPassable}`);
  }
  return {
    checked: hasStrictStatusExpectation
      || Number.isFinite(Number(expected.minScore))
      || Number.isFinite(Number(expected.maxViolationCount))
      || Number.isFinite(Number(expected.maxContactRatio))
      || typeof expected.passable === 'boolean',
    passed: failures.length === 0,
    failures
  };
}

async function runCase(page, testCase, options) {
  return page.evaluate(async ({ testCase: browserCase, timeoutMs }) => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const waitFor = async (predicate, timeout, label) => {
      const start = performance.now();
      while (performance.now() - start < timeout) {
        if (predicate()) return;
        await sleep(250);
      }
      throw new Error(`Timed out waiting for ${label}`);
    };
    const finite = (value) => Number.isFinite(Number(value));
    const numOrNull = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);

    if (typeof window.fullReset === 'function') {
      window.fullReset();
      await sleep(500);
    }
    if (!window.store || typeof window.store.getState !== 'function') throw new Error('window.store is not available.');

    const endpoints = browserCase.endpoints.map((point, index) => ({
      id: `golden-${browserCase.id}-${index}`,
      name: point.name || (index === 0 ? 'start' : `point-${index + 1}`),
      lat: Number(point.lat),
      lng: Number(point.lng)
    }));
    if (endpoints.some((point) => !finite(point.lat) || !finite(point.lng))) {
      throw new Error(`Invalid endpoint coordinate in ${browserCase.id}.`);
    }

    if (typeof window.store.applyVehiclePreset === 'function') window.store.applyVehiclePreset(browserCase.vehiclePreset);
    if (typeof window.store.setDriverSkill === 'function' && browserCase.driverSkill != null) {
      window.store.setDriverSkill(Number(browserCase.driverSkill));
    }
    const vehicleSelect = document.getElementById('vehiclePreset');
    if (vehicleSelect) {
      vehicleSelect.value = browserCase.vehiclePreset;
      vehicleSelect.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (browserCase.enableYolo === false) {
      const yoloToggle = document.getElementById('autoSatYoloOnDelivery');
      if (yoloToggle) yoloToggle.checked = false;
    }

    window.store.setSelectedEndpoints(endpoints);
    const routeStart = performance.now();
    if (typeof window.onOsrmRoute === 'function') {
      await window.onOsrmRoute();
    } else {
      const routeButton = document.getElementById('osrm-route');
      if (!routeButton) throw new Error('Route function and #osrm-route button are both unavailable.');
      routeButton.click();
    }

    await waitFor(() => {
      const state = window.store.getState();
      return Array.isArray(state.simRoute) && state.simRoute.length >= 2;
    }, Math.min(timeoutMs, 60000), 'route generation');

    let state = window.store.getState();
    const routeMs = Math.round(performance.now() - routeStart);
    const routePointCount = state.simRoute.length;
    const routeMeta = state.routeMeta ? { ...state.routeMeta } : null;
    const routeCandidates = Array.isArray(state.routeCandidates) ? state.routeCandidates.length : 0;

    const roadStart = performance.now();
    if (browserCase.loadRoads !== false) {
      if (typeof window.loadRoadsWideArea !== 'function') throw new Error('window.loadRoadsWideArea is not available.');
      await window.loadRoadsWideArea(state.simRoute);
      await sleep(800);
    }
    state = window.store.getState();
    const roadMs = Math.round(performance.now() - roadStart);
    const roadCount = Array.isArray(state.geoJsonDataSets) ? state.geoJsonDataSets.length : 0;
    if (browserCase.loadRoads !== false && roadCount === 0 && !browserCase.allowNoRoads) {
      throw new Error('No road data was loaded for this benchmark case.');
    }
    const widthFusion = typeof window.validateWidthFusion === 'function'
      ? window.validateWidthFusion()
      : null;

    const assessmentStart = performance.now();
    const assessment = await window.runSingleVehicleAssessment(browserCase.vehiclePreset);
    const assessmentMs = Math.round(performance.now() - assessmentStart);
    if (!assessment) throw new Error('runSingleVehicleAssessment returned no result.');

    const contact = assessment.contactFeasibility || {};
    const collision = assessment.collisionReport || {};
    const kinematics = assessment.kinematics || {};
    const voxel = assessment.voxelCollision || {};
    const violations = Array.isArray(assessment.violations) ? assessment.violations : [];
    const contactRatio = numOrNull(contact.contactRatio ?? collision.contactRatio ?? contact.overflowRatio);

    return {
      id: browserCase.id,
      name: browserCase.name || browserCase.id,
      vehiclePreset: browserCase.vehiclePreset,
      driverSkill: numOrNull(browserCase.driverSkill),
      overallStatus: assessment.overallStatus || null,
      overallStatusReason: assessment.overallStatusReason || null,
      score: numOrNull(assessment.score),
      distanceMeters: numOrNull(assessment.distanceMeters),
      routeMode: assessment.routeMode || routeMeta?.kind || routeMeta?.source || null,
      routeDisplayName: routeMeta?.displayName || null,
      routePointCount,
      routeCandidates,
      roadCount,
      widthFusion: widthFusion
        ? {
          averageConfidence: widthFusion.averageConfidence,
          yoloCoverage: widthFusion.yoloCoverage,
          disagreementCount: widthFusion.disagreementCount
        }
        : null,
      routeMs,
      roadMs,
      assessmentMs,
      violationsCount: violations.length,
      violationTypes: violations.map((v) => v?.type || 'unknown').slice(0, 20),
      contactRatio,
      contactCount: numOrNull(contact.contactCount ?? collision.contactCount),
      collisionStatus: collision.status || null,
      voxelBackend: voxel.backend || null,
      voxelRemote: !!voxel.remote,
      voxelGpu: voxel.gpu || null,
      voxelStatus: voxel.status || null,
      kinematicStatus: kinematics.status || null,
      curveCalibration: kinematics.curveCalibration || null,
      driveSimulation: kinematics.driveSimulation
        ? {
          timeSeconds: kinematics.driveSimulation.timeSeconds,
          sampleCount: kinematics.driveSimulation.sampleCount,
          metrics: kinematics.driveSimulation.metrics
        }
        : null
    };
  }, { testCase, timeoutMs: options.caseTimeoutMs });
}

function summarize(caseResults, startedAt, finishedAt, options) {
  const completed = caseResults.filter((entry) => entry.status === 'completed');
  const errored = caseResults.filter((entry) => entry.status === 'error');
  const checked = completed.filter((entry) => entry.expectation?.checked);
  const failed = checked.filter((entry) => !entry.expectation.passed);
  const statusCounts = {};
  let scoreSum = 0;
  let scoreCount = 0;
  let expectedPassableCount = 0;
  let expectedImpossibleCount = 0;
  let falseNegativeCount = 0;
  let falsePositiveCount = 0;

  for (const entry of completed) {
    const status = entry.actual.overallStatus || 'UNKNOWN';
    statusCounts[status] = (statusCounts[status] || 0) + 1;
    if (Number.isFinite(Number(entry.actual.score))) {
      scoreSum += Number(entry.actual.score);
      scoreCount += 1;
    }
    const expectedPassable = entry.expected?.passable;
    if (typeof expectedPassable === 'boolean') {
      const actualPassable = isPassableStatus(entry.actual.overallStatus);
      if (expectedPassable) {
        expectedPassableCount += 1;
        if (!actualPassable) falseNegativeCount += 1;
      } else {
        expectedImpossibleCount += 1;
        if (actualPassable) falsePositiveCount += 1;
      }
    }
  }

  return {
    generatedAt: finishedAt.toISOString(),
    startedAt: startedAt.toISOString(),
    target: options.target,
    fixtureFile: displayPath(options.fixtures),
    total: caseResults.length,
    completed: completed.length,
    errors: errored.length,
    expectationsChecked: checked.length,
    failedExpectations: failed.length,
    passRate: checked.length ? Number(((checked.length - failed.length) / checked.length).toFixed(4)) : null,
    statusCounts,
    averageScore: scoreCount ? Number((scoreSum / scoreCount).toFixed(2)) : null,
    falseNegativeCount,
    falseNegativeRate: expectedPassableCount ? Number((falseNegativeCount / expectedPassableCount).toFixed(4)) : null,
    falsePositiveCount,
    falsePositiveRate: expectedImpossibleCount ? Number((falsePositiveCount / expectedImpossibleCount).toFixed(4)) : null
  };
}

function markdownSummary(summary, caseResults) {
  const rows = caseResults.map((entry) => {
    if (entry.status === 'error') {
      return `| ${entry.id} | ${entry.vehiclePreset || '-'} | ERROR | - | - | ${escapePipe(entry.error)} |`;
    }
    const actual = entry.actual;
    const mark = !entry.expectation?.checked ? 'MEASURE' : (entry.expectation.passed ? 'OK' : 'FAIL');
    const reasons = entry.expectation?.failures?.join('; ') || '';
    return `| ${entry.id} | ${actual.vehiclePreset} | ${actual.overallStatus || '-'} | ${actual.score ?? '-'} | ${mark} | ${escapePipe(reasons)} |`;
  });
  return [
    '# Golden Route Benchmark Summary',
    '',
    `- Generated: ${summary.generatedAt}`,
    `- Target: ${summary.target}`,
    `- Fixture: ${summary.fixtureFile}`,
    `- Completed: ${summary.completed}/${summary.total}`,
    `- Failed expectations: ${summary.failedExpectations}`,
    `- Average score: ${summary.averageScore ?? '-'}`,
    `- False NG rate: ${summary.falseNegativeRate ?? '-'}`,
    `- False OK rate: ${summary.falsePositiveRate ?? '-'}`,
    '',
    '| Case | Vehicle | Status | Score | Check | Notes |',
    '| --- | --- | --- | ---: | --- | --- |',
    ...rows,
    ''
  ].join('\n');
}

function escapePipe(value) {
  return String(value || '').replace(/\|/g, '\\|');
}

function appendJsonl(filePath, value) {
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const fixtures = readJson(options.fixtures);
  const validationErrors = validateFixtures(fixtures);
  if (validationErrors.length) {
    validationErrors.forEach((error) => console.error(`[golden] fixture error: ${error}`));
    process.exit(1);
  }

  const cases = pickCases(fixtures, options.caseId);
  if (!cases.length) throw new Error(options.caseId ? `No fixture case matched "${options.caseId}".` : 'No fixture cases to run.');

  console.log(`[golden] fixtures: ${options.fixtures}`);
  console.log(`[golden] cases: ${cases.length}`);
  if (options.dryRun) {
    console.log('[golden] dry-run OK. Browser execution skipped.');
    return;
  }

  const startedAt = new Date();
  const runDir = path.join(options.outDir, timestampForPath(startedAt));
  fs.mkdirSync(runDir, { recursive: true });
  const jsonlPath = path.join(runDir, 'results.jsonl');
  const browserMessages = [];

  const browser = await launchBrowser(options);
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(options.caseTimeoutMs);
    page.on('console', (msg) => {
      const text = msg.text();
      browserMessages.push({ type: msg.type(), text });
      if (text.includes('[auto-route]') || text.includes('[route]') || text.includes('SyntaxError')) {
        console.log(`[browser:${msg.type()}] ${text}`);
      }
    });
    page.on('pageerror', (err) => {
      browserMessages.push({ type: 'pageerror', text: err.stack || err.message });
      console.error(`[browser:pageerror] ${err.message}`);
    });

    await page.goto(options.target, { waitUntil: 'domcontentloaded', timeout: options.navigationTimeoutMs });
    await waitForApp(page, options.navigationTimeoutMs);

    const caseResults = [];
    for (const testCase of cases) {
      console.log(`[golden] run ${testCase.id} (${testCase.vehiclePreset})`);
      const started = new Date();
      try {
        const actual = await runCase(page, testCase, options);
        const expectation = compareCase(testCase, actual);
        const entry = {
          id: testCase.id,
          name: testCase.name || testCase.id,
          vehiclePreset: testCase.vehiclePreset,
          status: 'completed',
          startedAt: started.toISOString(),
          finishedAt: new Date().toISOString(),
          expected: testCase.expected || {},
          expectation,
          actual
        };
        caseResults.push(entry);
        appendJsonl(jsonlPath, entry);
        const mark = !expectation.checked ? 'MEASURE' : (expectation.passed ? 'OK' : 'FAIL');
        console.log(`[golden] ${testCase.id}: ${actual.overallStatus} score=${actual.score} ${mark}`);
      } catch (err) {
        const entry = {
          id: testCase.id,
          name: testCase.name || testCase.id,
          vehiclePreset: testCase.vehiclePreset,
          status: 'error',
          startedAt: started.toISOString(),
          finishedAt: new Date().toISOString(),
          expected: testCase.expected || {},
          error: err.stack || err.message
        };
        caseResults.push(entry);
        appendJsonl(jsonlPath, entry);
        console.error(`[golden] ${testCase.id}: ERROR ${err.message}`);
      }
    }

    const finishedAt = new Date();
    const summary = summarize(caseResults, startedAt, finishedAt, options);
    fs.writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify({ summary, cases: caseResults }, null, 2), 'utf8');
    fs.writeFileSync(path.join(runDir, 'summary.md'), markdownSummary(summary, caseResults), 'utf8');
    fs.writeFileSync(path.join(runDir, 'browser-console.json'), JSON.stringify(browserMessages, null, 2), 'utf8');

    console.log(`[golden] output: ${runDir}`);
    console.log(`[golden] completed=${summary.completed}/${summary.total} failedExpectations=${summary.failedExpectations} errors=${summary.errors}`);
    if (summary.failedExpectations > 0 || summary.errors > 0) process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(`[golden] fatal: ${err.stack || err.message}`);
  process.exit(1);
});
