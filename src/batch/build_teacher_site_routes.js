#!/usr/bin/env node
/**
 * build_teacher_site_routes.js
 *
 * Turns imported teacher site points into deterministic short access routes.
 *
 * Flow:
 *   1. Load runtime/teacher_data/teacher_points.json
 *   2. Find or compile a small world around each point
 *   3. Snap the point to the nearest road in that world
 *   4. Pick a connected approach node roughly N meters away
 *   5. Emit route candidates for later browser/Safety Monitor execution
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POINTS = path.join(ROOT, 'runtime', 'teacher_data', 'teacher_points.json');
const DEFAULT_OUT_DIR = path.join(ROOT, 'runtime', 'teacher_data');
const DEFAULT_WORLD_DIR = path.join(ROOT, 'runtime', 'worlds');

function installNodeTurfLite() {
  if (globalThis.turf?.point && globalThis.turf?.distance && globalThis.turf?.bearing && globalThis.turf?.destination) return;
  const R_KM = 6371.0088;
  const toRad = (deg) => deg * Math.PI / 180;
  const toDeg = (rad) => rad * 180 / Math.PI;
  const coordsOf = (p) => Array.isArray(p) ? p : p?.geometry?.coordinates;
  globalThis.turf = {
    point: (coordinates) => ({ type: 'Feature', geometry: { type: 'Point', coordinates }, properties: {} }),
    distance: (a, b, opts = {}) => {
      const ac = coordsOf(a);
      const bc = coordsOf(b);
      const lat1 = toRad(ac[1]);
      const lat2 = toRad(bc[1]);
      const dLat = lat2 - lat1;
      const dLng = toRad(bc[0] - ac[0]);
      const h = Math.sin(dLat / 2) ** 2
        + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
      const km = 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(h)));
      return opts.units === 'meters' ? km * 1000 : km;
    },
    bearing: (a, b) => {
      const ac = coordsOf(a);
      const bc = coordsOf(b);
      const lat1 = toRad(ac[1]);
      const lat2 = toRad(bc[1]);
      const dLng = toRad(bc[0] - ac[0]);
      const y = Math.sin(dLng) * Math.cos(lat2);
      const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
      return (toDeg(Math.atan2(y, x)) + 360) % 360;
    },
    destination: (origin, distance, bearingDeg, opts = {}) => {
      const oc = coordsOf(origin);
      const distKm = opts.units === 'meters' ? distance / 1000 : distance;
      const delta = distKm / R_KM;
      const theta = toRad(bearingDeg);
      const lat1 = toRad(oc[1]);
      const lng1 = toRad(oc[0]);
      const lat2 = Math.asin(Math.sin(lat1) * Math.cos(delta)
        + Math.cos(lat1) * Math.sin(delta) * Math.cos(theta));
      const lng2 = lng1 + Math.atan2(
        Math.sin(theta) * Math.sin(delta) * Math.cos(lat1),
        Math.cos(delta) - Math.sin(lat1) * Math.sin(lat2)
      );
      return globalThis.turf.point([toDeg(lng2), toDeg(lat2)]);
    }
  };
}

function parseArgs(argv) {
  const opts = {
    points: DEFAULT_POINTS,
    outDir: DEFAULT_OUT_DIR,
    worldDir: DEFAULT_WORLD_DIR,
    world: null,
    start: 0,
    limit: 20,
    radiusM: 450,
    approachM: 120,
    minApproachM: 60,
    maxApproachM: 220,
    maxSnapM: 45,
    maxStartCandidates: 160,
    alternatives: 3,
    compile: false,
    offline: false,
    refresh: false,
    ignoreOneway: false,
    selfcheck: false
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--points') opts.points = path.resolve(next());
    else if (a === '--out') opts.outDir = path.resolve(next());
    else if (a === '--world-dir') opts.worldDir = path.resolve(next());
    else if (a === '--world') opts.world = next();
    else if (a === '--start') opts.start = Math.max(0, parseInt(next(), 10) || 0);
    else if (a === '--limit') opts.limit = Math.max(1, parseInt(next(), 10) || opts.limit);
    else if (a === '--radius-m') opts.radiusM = Number(next()) || opts.radiusM;
    else if (a === '--approach-m') opts.approachM = Number(next()) || opts.approachM;
    else if (a === '--min-approach-m') opts.minApproachM = Number(next()) || opts.minApproachM;
    else if (a === '--max-approach-m') opts.maxApproachM = Number(next()) || opts.maxApproachM;
    else if (a === '--max-snap-m') opts.maxSnapM = Number(next()) || opts.maxSnapM;
    else if (a === '--alternatives') opts.alternatives = Math.max(1, parseInt(next(), 10) || opts.alternatives);
    else if (a === '--compile') opts.compile = true;
    else if (a === '--offline') opts.offline = true;
    else if (a === '--refresh') opts.refresh = true;
    else if (a === '--ignore-oneway') opts.ignoreOneway = true;
    else if (a === '--selfcheck') opts.selfcheck = true;
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
    '  node src/batch/build_teacher_site_routes.js --limit 20 --compile',
    '',
    'Options:',
    '  --points <json>          Imported teacher points JSON',
    '  --limit <N>              Number of points to process',
    '  --start <N>              Start offset in points array',
    '  --compile                Compile missing worlds around points',
    '  --offline                Pass --offline to compile_world',
    '  --radius-m <m>           World AOI radius around each point (default 450)',
    '  --approach-m <m>         Target access route length (default 120)',
    '  --min-approach-m <m>     Approach node distance lower bound',
    '  --max-approach-m <m>     Approach node distance upper bound',
    '  --max-snap-m <m>         Max point-to-road snap distance',
    '  --alternatives <N>       Routes per point from different approach nodes (default 3)',
    '  --world <hash|path>      Force one world file/hash for all points',
    '  --ignore-oneway          Ignore one-way restrictions in route graph',
    '  --selfcheck              Run synthetic selfcheck'
  ].join('\n'));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function round(value, digits = 3) {
  const m = 10 ** digits;
  return Math.round((Number(value) || 0) * m) / m;
}

function safeFilePart(value) {
  return String(value || '')
    .replace(/[^a-z0-9_.-]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120) || 'route';
}

function bboxAround(lat, lng, radiusM) {
  const dLat = radiusM / 111320;
  const dLng = radiusM / (111320 * Math.cos(lat * Math.PI / 180));
  return [lng - dLng, lat - dLat, lng + dLng, lat + dLat];
}

function containsPoint(world, point) {
  const bbox = world?.aoi?.bbox;
  if (!Array.isArray(bbox) || bbox.length !== 4) return false;
  const [minLng, minLat, maxLng, maxLat] = bbox.map(Number);
  return point.lng >= minLng && point.lng <= maxLng && point.lat >= minLat && point.lat <= maxLat;
}

function worldPathFromHashOrPath(value, worldDir = DEFAULT_WORLD_DIR) {
  if (!value) return null;
  const direct = path.resolve(value);
  if (fs.existsSync(direct)) return direct;
  const asHash = path.join(worldDir, `world_${value.replace(/^world_|\.json$/g, '')}.json`);
  return fs.existsSync(asHash) ? asHash : null;
}

function listWorldFiles(worldDir) {
  if (!fs.existsSync(worldDir)) return [];
  return fs.readdirSync(worldDir)
    .filter((name) => /^world_[a-z0-9]+\.json$/i.test(name))
    .map((name) => path.join(worldDir, name));
}

function findExistingWorldForPoint(point, opts) {
  const forced = worldPathFromHashOrPath(opts.world, opts.worldDir);
  if (forced) {
    const world = readJson(forced);
    return { file: forced, world, forced: true };
  }
  const files = listWorldFiles(opts.worldDir)
    .map((file) => ({ file, stat: fs.statSync(file) }))
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  for (const { file } of files) {
    try {
      const world = readJson(file);
      if (containsPoint(world, point)) return { file, world, forced: false };
    } catch (_err) {
      // Ignore malformed runtime artifacts.
    }
  }
  return null;
}

function compileWorldForPoint(point, opts) {
  const bbox = bboxAround(point.lat, point.lng, opts.radiusM).map((v) => round(v, 8));
  const before = Date.now();
  const args = [
    path.join(ROOT, 'src', 'batch', 'compile_world.js'),
    '--bbox',
    bbox.join(',')
  ];
  if (opts.offline) args.push('--offline');
  if (opts.refresh) args.push('--refresh');
  console.log(`[compile] ${point.id} bbox=${bbox.join(',')}`);
  const res = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (res.status !== 0) {
    const msg = `${res.stderr || res.stdout || ''}`.trim().slice(0, 500);
    throw new Error(`compile_world failed: ${msg}`);
  }
  const candidates = listWorldFiles(opts.worldDir)
    .map((file) => ({ file, stat: fs.statSync(file) }))
    .filter((x) => x.stat.mtimeMs >= before - 1500)
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  for (const { file } of candidates) {
    const world = readJson(file);
    if (containsPoint(world, point)) return { file, world, forced: false };
  }
  const fallback = findExistingWorldForPoint(point, opts);
  if (fallback) return fallback;
  throw new Error('compiled world was not found after compile_world completed');
}

function routeLenM(route, turf) {
  let total = 0;
  for (let i = 1; i < route.length; i++) {
    total += turf.distance(
      [route[i - 1].lng, route[i - 1].lat],
      [route[i].lng, route[i].lat],
      { units: 'meters' }
    );
  }
  return total;
}

function nodeSnap(node) {
  return {
    lat: node.lat,
    lng: node.lng,
    fromKey: node.id,
    toKey: node.id,
    dFrom: 0.01,
    dTo: 0.01,
    dist: 0,
    segLen: 0
  };
}

async function loadGraphModules() {
  installNodeTurfLite();
  const graph = await import(pathToFileURL(path.join(ROOT, 'src', 'core', 'graph.js')).href);
  const geo = await import(pathToFileURL(path.join(ROOT, 'src', 'utils', 'geo.js')).href);
  return { graph, geo };
}

// 連続重複点(<5cm)を除去。グラフのsnap点がノード座標と一致すると先頭が重複し、
// ゼロ長セグメントが再生側の物理ポーズ生成を発散させる（teacher-site-0001実測）。
// index3DSetRoute側にも同じ防御があるが、成果物JSON自体を清潔に保つ。
function dedupeRoutePoints(route) {
  const out = [];
  for (const q of route || []) {
    const prev = out[out.length - 1];
    if (prev) {
      const dlat = (q.lat - prev.lat) * 111320;
      const dlng = (q.lng - prev.lng) * 111320 * Math.cos(q.lat * Math.PI / 180);
      if (Math.hypot(dlat, dlng) < 0.05) continue;
    }
    out.push(q);
  }
  return out;
}

function buildRoutesForPoint(point, world, worldFile, opts, mods) {
  const { graph: graphMod, geo } = mods;
  const roads = Array.isArray(world?.layers?.roads) ? world.layers.roads : [];
  if (!roads.length) throw new Error('world has no roads');

  geo.coordinateSystem.setOrigin(point.lat, point.lng);
  const graph = graphMod.buildRoadGraph(roads, {
    ignoreOneway: opts.ignoreOneway
  });
  if (!graph.nodes?.size || !graph.segments?.length) throw new Error('road graph is empty');

  const goalSnap = graphMod.nearestSnapOnGraph(graph, point.lat, point.lng, { maxDistance: opts.maxSnapM });
  if (!Number.isFinite(goalSnap?.dist)) {
    throw new Error(`no road snap within ${opts.maxSnapM}m`);
  }

  const goalM = geo.coordinateSystem.latLngToMeters(goalSnap.lat, goalSnap.lng);
  const startCandidates = [];
  graph.nodes.forEach((node) => {
    const m = geo.coordinateSystem.latLngToMeters(node.lat, node.lng);
    const directM = Math.hypot(m.x - goalM.x, m.y - goalM.y);
    if (directM >= opts.minApproachM && directM <= opts.maxApproachM) {
      startCandidates.push({ node, directM });
    }
  });
  startCandidates.sort((a, b) => Math.abs(a.directM - opts.approachM) - Math.abs(b.directM - opts.approachM));

  const routes = [];
  for (const cand of startCandidates.slice(0, opts.maxStartCandidates)) {
    const startSnap = nodeSnap(cand.node);
    const keys = graphMod.shortestPathWithTmpAngle(graph, startSnap, goalSnap, {
      forbidUTurn: true,
      turnCostK: 0.08
    });
    if (!keys || keys.length < 3) continue;
    const route = dedupeRoutePoints(graphMod.keysToLatLngs(keys, graph, startSnap, goalSnap));
    const lenM = routeLenM(route, geo.turf);
    if (!Number.isFinite(lenM) || lenM < opts.minApproachM * 0.5) continue;
    const score = Math.abs(lenM - opts.approachM) + Math.abs(cand.directM - opts.approachM) * 0.2 + goalSnap.dist * 2;
    routes.push({
      score,
      directM: cand.directM,
      lenM,
      route,
      startNode: cand.node.id
    });
  }
  routes.sort((a, b) => a.score - b.score || b.lenM - a.lenM);
  if (!routes.length) throw new Error('no connected approach route found');

  const relWorldFile = path.relative(ROOT, worldFile).replace(/\\/g, '/');
  return routes.slice(0, opts.alternatives).map((best, index) => ({
    id: `${point.id}-access-${String(index + 1).padStart(2, '0')}`,
    pointId: point.id,
    name: `${point.name || point.id} access route`,
    lat: point.lat,
    lng: point.lng,
    observedTruckClasses: point.observedTruckClasses || [],
    observedPositivePresets: point.observedPositivePresets || [],
    inferredPassablePresets: point.inferredPassablePresets || [],
    weakNegativePresets: point.weakNegativePresets || [],
    sourceRows: point.sourceRows || [],
    worldHash: world.hash || path.basename(worldFile).replace(/^world_|\.json$/g, ''),
    worldFile: relWorldFile,
    snap: {
      lat: round(goalSnap.lat, 8),
      lng: round(goalSnap.lng, 8),
      distM: round(goalSnap.dist, 2)
    },
    approach: {
      targetM: opts.approachM,
      directM: round(best.directM, 2),
      routeLenM: round(best.lenM, 1),
      startNode: best.startNode
    },
    routePointCount: best.route.length,
    route: best.route.map((p) => ({ lat: round(p.lat, 8), lng: round(p.lng, 8) })),
    labelPolicy: 'observed positives are strong; weak negatives require confirmation before hard NG use'
  }));
}

function summarize(routes, skipped) {
  const byMax = {};
  for (const r of routes) {
    const maxClass = Math.max(...(r.observedTruckClasses || [0]));
    byMax[maxClass] = (byMax[maxClass] || 0) + 1;
  }
  return {
    totalRoutes: routes.length,
    skipped: skipped.length,
    byMaxObservedTruckClass: byMax
  };
}

async function selfcheck() {
  const mods = await loadGraphModules();
  const world = {
    hash: 'teacher-selfcheck',
    aoi: { bbox: [139.0, 34.99, 139.01, 35.01] },
    layers: {
      roads: [
        {
          type: 'Feature',
          properties: { id: 'r-main', highway: 'residential', gsiWidthEstimate: 5.5 },
          geometry: {
            type: 'LineString',
            coordinates: [
              [139.0000, 35.0000],
              [139.0010, 35.0000],
              [139.0020, 35.0000],
              [139.0030, 35.0000]
            ]
          }
        },
        {
          type: 'Feature',
          properties: { id: 'r-branch', highway: 'residential', gsiWidthEstimate: 4.0 },
          geometry: {
            type: 'LineString',
            coordinates: [
              [139.0020, 35.0000],
              [139.0020, 35.0010]
            ]
          }
        }
      ]
    }
  };
  const point = {
    id: 'teacher-site-selfcheck',
    name: 'selfcheck',
    lat: 35.00002,
    lng: 139.00202,
    observedTruckClasses: [4],
    observedPositivePresets: ['4t_flat'],
    inferredPassablePresets: ['2t_flat', '3t_flat', '4t_flat'],
    weakNegativePresets: ['10t_unic'],
    sourceRows: [2]
  };
  const routes = buildRoutesForPoint(point, world, path.join(DEFAULT_WORLD_DIR, 'world_teacher-selfcheck.json'), {
    approachM: 120,
    minApproachM: 40,
    maxApproachM: 180,
    maxSnapM: 20,
    maxStartCandidates: 20,
    alternatives: 2,
    ignoreOneway: false
  }, mods);
  const route = routes[0];
  const checks = [
    ['route generated', Array.isArray(route.route) && route.route.length >= 2],
    ['snap distance finite', Number.isFinite(route.snap.distM) && route.snap.distM < 10],
    ['labels preserved', route.weakNegativePresets.includes('10t_unic')],
    ['world hash preserved', route.worldHash === 'teacher-selfcheck']
  ];
  let ok = true;
  for (const [name, pass] of checks) {
    console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}`);
    ok = ok && pass;
  }
  console.log(ok ? '\nselfcheck ALL PASS' : '\nselfcheck FAILED');
  return ok ? 0 : 1;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.selfcheck) return selfcheck();

  const payload = readJson(opts.points);
  const points = (payload.points || []).slice(opts.start, opts.start + opts.limit);
  if (!points.length) throw new Error('no points selected');
  fs.mkdirSync(opts.outDir, { recursive: true });

  const mods = await loadGraphModules();
  const routes = [];
  const skipped = [];
  for (const point of points) {
    try {
      let found = findExistingWorldForPoint(point, opts);
      if (!found && opts.compile) found = compileWorldForPoint(point, opts);
      if (!found) throw new Error('no compiled world found; rerun with --compile');
      const built = buildRoutesForPoint(point, found.world, found.file, opts, mods);
      routes.push(...built);
      for (const route of built) {
        console.log(`[ROUTE] ${route.id} world=${route.worldHash} snap=${route.snap.distM}m len=${route.approach.routeLenM}m labels=${route.observedPositivePresets.join('|')}`);
      }
    } catch (err) {
      const message = String(err?.message || err);
      skipped.push({ pointId: point.id, lat: point.lat, lng: point.lng, error: message });
      console.warn(`[SKIP] ${point.id}: ${message}`);
    }
  }

  const runId = Date.now();
  const outFile = path.join(opts.outDir, `teacher_site_routes_${runId}.json`);
  const out = {
    version: 1,
    generatedAt: new Date().toISOString(),
    sourcePoints: path.relative(ROOT, opts.points).replace(/\\/g, '/'),
    options: {
      start: opts.start,
      limit: opts.limit,
      radiusM: opts.radiusM,
      approachM: opts.approachM,
      minApproachM: opts.minApproachM,
      maxApproachM: opts.maxApproachM,
      maxSnapM: opts.maxSnapM,
      alternatives: opts.alternatives,
      compile: opts.compile,
      offline: opts.offline,
      ignoreOneway: opts.ignoreOneway
    },
    summary: summarize(routes, skipped),
    routes,
    skipped
  };
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log(`summary: routes=${routes.length} skipped=${skipped.length}`);
  console.log(`saved: ${outFile}`);
  return routes.length > 0 ? 0 : 1;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});
