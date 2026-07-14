#!/usr/bin/env node
/**
 * run_teacher_site_routes.js
 *
 * Runs generated teacher access routes in index3D and compares observed
 * passability against teacher labels.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const puppeteer = require(path.join(__dirname, 'node_modules', 'puppeteer'));
const { runRoute } = require('./l4RegressionLib.js');

const DEFAULT_OUT = path.join(ROOT, 'runtime', 'teacher_data');
const DEFAULT_VEHICLES = ['2t_flat', '3t_flat', '4t_flat', '10t_unic'];

function parseArgs(argv) {
  const opts = {
    routes: null,
    outDir: DEFAULT_OUT,
    base: 'http://127.0.0.1:8099',
    vehicles: DEFAULT_VEHICLES,
    routeId: null,
    limit: Infinity,
    timeoutS: 90,
    strict: true
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--routes') opts.routes = path.resolve(next());
    else if (a === '--out') opts.outDir = path.resolve(next());
    else if (a === '--base') opts.base = next();
    else if (a === '--vehicles') opts.vehicles = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--route-id') opts.routeId = next();
    else if (a === '--limit') opts.limit = Math.max(1, parseInt(next(), 10) || 1);
    else if (a === '--timeout') opts.timeoutS = Number(next()) || opts.timeoutS;
    else if (a === '--strict') opts.strict = true;
    else if (a === '--no-strict') opts.strict = false;
    else if (a === '--help' || a === '-h') {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  return opts;
}

function printUsage() {
  console.log([
    'Usage:',
    '  node src/batch/run_teacher_site_routes.js --routes runtime/teacher_data/teacher_site_routes_<id>.json',
    '',
    'Options:',
    '  --base <url>             App URL. Default http://127.0.0.1:8099',
    '  --vehicles <a,b,c>       Vehicle presets. Default 2t/3t/4t/10t',
    '  --route-id <id>          Run one exact route record',
    '  --limit <N>              Max route records to run',
    '  --timeout <sec>          Per-run timeout',
    '  --strict                 Fail on label conflicts (default)',
    '  --no-strict              Allow label conflicts for exploratory runs'
  ].join('\n'));
}

function latestRoutesFile(dir) {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir)
    .filter((n) => /^teacher_site_routes_\d+\.json$/.test(n))
    .map((name) => {
      const file = path.join(dir, name);
      return { file, mtime: fs.statSync(file).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  return files[0]?.file || null;
}

function labelFor(route, vehicle) {
  if ((route.observedPositivePresets || []).includes(vehicle)) return 'OBSERVED_POSITIVE';
  if ((route.inferredPassablePresets || []).includes(vehicle)) return 'INFERRED_PASSABLE';
  if ((route.weakNegativePresets || []).includes(vehicle)) return 'WEAK_NEGATIVE';
  return 'UNKNOWN';
}

function compare(label, verdict) {
  const pass = verdict === 'PASS';
  if (label === 'OBSERVED_POSITIVE') return pass ? 'OK' : 'FALSE_NEGATIVE';
  if (label === 'INFERRED_PASSABLE') return pass ? 'OK_INFERRED' : 'INFERRED_CONFLICT';
  if (label === 'WEAK_NEGATIVE') return pass ? 'WEAK_CONFLICT_REVIEW' : 'SUPPORTS_WEAK_NEGATIVE';
  return 'NO_LABEL';
}

function relWorldUrl(worldFile) {
  const rel = String(worldFile || '').replace(/\\/g, '/');
  if (rel.startsWith('runtime/')) return rel;
  const abs = path.resolve(ROOT, worldFile || '');
  return path.relative(ROOT, abs).replace(/\\/g, '/');
}

function summarizeRouteLevel(results) {
  const summary = {
    total: results.length,
    observedPositive: { ok: 0, falseNegative: 0 },
    inferredPassable: { ok: 0, conflict: 0 },
    weakNegative: { supports: 0, review: 0 },
    failMonitor: 0,
    timeouts: 0,
    incomplete: 0,
    errors: 0,
    pageErrors: 0
  };
  for (const r of results) {
    if (r.label === 'OBSERVED_POSITIVE') {
      if (r.comparison === 'OK') summary.observedPositive.ok++;
      else summary.observedPositive.falseNegative++;
    } else if (r.label === 'INFERRED_PASSABLE') {
      if (r.comparison === 'OK_INFERRED') summary.inferredPassable.ok++;
      else summary.inferredPassable.conflict++;
    } else if (r.label === 'WEAK_NEGATIVE') {
      if (r.comparison === 'SUPPORTS_WEAK_NEGATIVE') summary.weakNegative.supports++;
      else summary.weakNegative.review++;
    }
    if (r.verdict === 'FAIL_MONITOR') summary.failMonitor++;
    if (r.verdict === 'TIMEOUT') summary.timeouts++;
    if (r.verdict === 'FAIL_INCOMPLETE') summary.incomplete++;
    if (r.verdict === 'ERROR' || r.comparison === 'RUN_ERROR') summary.errors++;
    summary.pageErrors += Array.isArray(r.pageErrors) ? r.pageErrors.length : 0;
  }
  return summary;
}

function summarizeSiteLevel(results) {
  const groups = new Map();
  for (const r of results) {
    const key = `${r.pointId}|${r.vehicle}`;
    if (!groups.has(key)) {
      groups.set(key, {
        pointId: r.pointId,
        vehicle: r.vehicle,
        label: r.label,
        runs: [],
        anyPass: false,
        anyRunError: false,
        anyFailMonitor: false,
        blockingVerdicts: new Set(),
        pageErrors: 0
      });
    }
    const g = groups.get(key);
    g.runs.push(r);
    g.anyPass = g.anyPass || r.verdict === 'PASS';
    if (['ERROR', 'TIMEOUT', 'FAIL_MONITOR', 'FAIL_INCOMPLETE', 'MRM_OK'].includes(r.verdict)
      || r.comparison === 'RUN_ERROR') {
      g.blockingVerdicts.add(r.verdict || 'RUN_ERROR');
    }
    g.anyRunError = g.anyRunError || r.verdict === 'ERROR'
      || r.verdict === 'TIMEOUT' || r.comparison === 'RUN_ERROR';
    g.anyFailMonitor = g.anyFailMonitor || r.verdict === 'FAIL_MONITOR';
    g.pageErrors += Array.isArray(r.pageErrors) ? r.pageErrors.length : 0;
  }
  const records = [];
  const summary = {
    total: groups.size,
    observedPositive: { ok: 0, falseNegative: 0 },
    inferredPassable: { ok: 0, conflict: 0 },
    weakNegative: { supports: 0, review: 0 },
    runErrors: 0,
    failMonitor: 0,
    timeouts: 0,
    incomplete: 0,
    pageErrors: 0
  };
  for (const g of groups.values()) {
    const hasBlockingRun = g.blockingVerdicts.size > 0;
    const effectivePass = g.anyPass && !hasBlockingRun;
    let comparison = 'NO_LABEL';
    if (g.label === 'OBSERVED_POSITIVE') {
      comparison = effectivePass ? 'OK' : 'FALSE_NEGATIVE';
      if (effectivePass) summary.observedPositive.ok++;
      else summary.observedPositive.falseNegative++;
    } else if (g.label === 'INFERRED_PASSABLE') {
      comparison = effectivePass ? 'OK_INFERRED' : 'INFERRED_CONFLICT';
      if (effectivePass) summary.inferredPassable.ok++;
      else summary.inferredPassable.conflict++;
    } else if (g.label === 'WEAK_NEGATIVE') {
      comparison = effectivePass ? 'WEAK_CONFLICT_REVIEW' : 'SUPPORTS_WEAK_NEGATIVE';
      if (effectivePass) summary.weakNegative.review++;
      else summary.weakNegative.supports++;
    }
    if (g.anyRunError) summary.runErrors++;
    if (g.blockingVerdicts.has('FAIL_MONITOR')) summary.failMonitor++;
    if (g.blockingVerdicts.has('TIMEOUT')) summary.timeouts++;
    if (g.blockingVerdicts.has('FAIL_INCOMPLETE')) summary.incomplete++;
    summary.pageErrors += g.pageErrors;
    records.push({
      pointId: g.pointId,
      vehicle: g.vehicle,
      label: g.label,
      comparison,
      anyPass: effectivePass,
      observedPass: g.anyPass,
      anyFailMonitor: g.anyFailMonitor,
      blockingVerdicts: [...g.blockingVerdicts].sort(),
      runCount: g.runs.length,
      bestVerdicts: [...new Set(g.runs.map((r) => r.verdict))]
    });
  }
  return { summary, records };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const routesFile = opts.routes || latestRoutesFile(opts.outDir);
  if (!routesFile) {
    console.error('usage: node src/batch/run_teacher_site_routes.js --routes <teacher_site_routes.json>');
    return 2;
  }
  const payload = JSON.parse(fs.readFileSync(routesFile, 'utf8'));
  const selectedRoutes = opts.routeId
    ? (payload.routes || []).filter((route) => route?.id === opts.routeId)
    : (payload.routes || []);
  const routes = selectedRoutes.slice(0, Number.isFinite(opts.limit) ? opts.limit : undefined);
  if (!routes.length) throw new Error('routes file has no route records');
  fs.mkdirSync(opts.outDir, { recursive: true });

  const chromeArgs = [];
  if (process.env.PUPPETEER_NO_SANDBOX === '1') {
    chromeArgs.push('--no-sandbox', '--disable-setuid-sandbox');
  }
  const browser = await puppeteer.launch({ headless: true, args: chromeArgs });
  const results = [];
  const runId = Date.now();
  const traceDir = path.join(opts.outDir, `teacher_traces_${runId}`);
  try {
    for (const route of routes) {
      for (const vehicle of opts.vehicles) {
        const page = await browser.newPage();
        page.setDefaultTimeout(120000);
        const pageErrors = [];
        page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 160)));
        try {
          await page.goto(`${opts.base}/index3D_V2.0.html`, { waitUntil: 'domcontentloaded' });
          await page.waitForSelector('#vehiclePreset', { timeout: 90000 });
          await page.select('#vehiclePreset', vehicle);
          await page.waitForFunction(
            'typeof window.index3DSetRoute === "function" && typeof window.index3DLoadCompiledWorld === "function" && typeof window.index3DPlay === "function"',
            { timeout: 90000 }
          );
          const cand = {
            id: `${route.id}-${vehicle}`,
            route: route.route,
            lenM: route.approach?.routeLenM || 0
          };
          const r = await runRoute(page, `${opts.base}/${relWorldUrl(route.worldFile)}`, cand, {
            timeoutS: opts.timeoutS,
            traceDir,
            worldHash: route.worldHash
          });
          const label = labelFor(route, vehicle);
          const comparison = compare(label, r.verdict);
          results.push({
            routeId: route.id,
            pointId: route.pointId,
            vehicle,
            label,
            comparison,
            verdict: r.verdict,
            mrmReason: r.mrmReason || null,
            firstViolation: r.firstViolation || null,
            progressM: r.progressM,
            totalM: r.totalM,
            worldHash: route.worldHash,
            snapDistM: route.snap?.distM ?? null,
            routeLenM: route.approach?.routeLenM ?? null,
            pageErrors: [...pageErrors, ...(r.pageErrors || [])],
            traceFile: r.traceFile || null
          });
          const mark = comparison.includes('CONFLICT') || comparison === 'FALSE_NEGATIVE' || r.verdict === 'FAIL_MONITOR'
            ? 'REVIEW'
            : 'OK';
          console.log(`[${mark}] ${route.pointId} ${vehicle} label=${label} verdict=${r.verdict}`
            + `${r.mrmReason ? ' mrm=' + r.mrmReason : ''} cmp=${comparison}`);
        } catch (err) {
          const label = labelFor(route, vehicle);
          results.push({
            routeId: route.id,
            pointId: route.pointId,
            vehicle,
            label,
            comparison: 'RUN_ERROR',
            verdict: 'ERROR',
            error: String(err?.message || err).slice(0, 300),
            worldHash: route.worldHash,
            pageErrors
          });
          console.warn(`[ERROR] ${route.pointId} ${vehicle}: ${err?.message || err}`);
        } finally {
          await page.close().catch(() => {});
        }
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  const routeLevel = summarizeRouteLevel(results);
  const siteLevel = summarizeSiteLevel(results);
  const outFile = path.join(opts.outDir, `teacher_site_run_${runId}.json`);
  fs.writeFileSync(outFile, JSON.stringify({
    version: 1,
    generatedAt: new Date().toISOString(),
    routesFile: path.relative(ROOT, routesFile).replace(/\\/g, '/'),
    vehicles: opts.vehicles,
    summary: {
      routeLevel,
      siteLevel: siteLevel.summary
    },
    siteResults: siteLevel.records,
    results
  }, null, 2) + '\n', 'utf8');
  console.log(`summary(route): ${JSON.stringify(routeLevel)}`);
  console.log(`summary(site): ${JSON.stringify(siteLevel.summary)}`);
  console.log(`saved: ${outFile}`);
  const hasConflicts = siteLevel.summary.observedPositive.falseNegative > 0
    || siteLevel.summary.inferredPassable.conflict > 0
    || routeLevel.observedPositive.falseNegative > 0
    || routeLevel.inferredPassable.conflict > 0
    || routeLevel.failMonitor > 0;
  return routeLevel.pageErrors === 0
    && siteLevel.summary.runErrors === 0
    && siteLevel.summary.failMonitor === 0
    && siteLevel.summary.timeouts === 0
    && siteLevel.summary.incomplete === 0
    && (!opts.strict || !hasConflicts) ? 0 : 1;
}

if (require.main === module) {
  main().then((code) => process.exit(code)).catch((err) => {
    console.error(err.stack || err.message || err);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  labelFor,
  compare,
  summarizeRouteLevel,
  summarizeSiteLevel
};
