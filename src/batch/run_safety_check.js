#!/usr/bin/env node
/**
 * run_safety_check.js — Safety Monitor（Phase 3）の単体検証（ネット/ブラウザ不要）
 *
 * evaluateSafetyInvariants / createSafetyMonitor を、注入モックturfで検査する。
 * 検査項目: 正常系OK / 道路逸脱 / 道路逸脱advisory / 接触 / 前方clearance<=0 / 未計測(null)は違反にしない
 *           / カーブ速度超過(許容差込み) / firstViolation捕捉+traceハッシュ安定
 *           / 推定だけの頭上クリアランスはADVISORY
 *
 * 実行: node src/batch/run_safety_check.js
 */
'use strict';

const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..', '..');

// 面積・内包・差分を feature の擬似プロパティで返すモックturf。
// footprint: { _areaM2, _outsideAreaM2 } を持つ疑似feature。
const mockTurf = {
  area: (f) => Number(f?._areaM2) || 0,
  booleanWithin: (fp, _road) => (Number(fp?._outsideAreaM2) || 0) <= 0,
  difference: (fp, _road) => {
    const out = Number(fp?._outsideAreaM2) || 0;
    return out > 0 ? { _areaM2: out } : null;
  }
};

// 局所回避プランナ検証用: 実 turf（src/batch/node_modules/@turf/turf）を使う。
const realTurf = require('@turf/turf');
globalThis.turf = realTurf;

async function main() {
  const mod = await import(pathToFileURL(path.join(ROOT, 'src', 'sim', 'safetyMonitor.js')).href);
  const { evaluateSafetyInvariants, createSafetyMonitor } = mod;
  const clearanceMod = await import(pathToFileURL(path.join(ROOT, 'src', '3d', 'clearanceSolids.js')).href);
  const { buildClearanceSolidReport, buildCollisionSolidSet, getVehicleFootprintConfig } = clearanceMod;
  const avoidanceMod = await import(pathToFileURL(path.join(ROOT, 'src', 'core', 'localAvoidance.js')).href);
  const { planLocalAvoidance } = avoidanceMod;

  let pass = true;
  const check = (name, cond, detail = '') => {
    console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? '  ' + detail : ''}`);
    pass = pass && cond;
  };

  const road = { _road: true };
  const inside = { _areaM2: 12, _outsideAreaM2: 0 };
  const wayOut = { _areaM2: 12, _outsideAreaM2: 6 };

  // 1) 正常系: 道路内・非接触・余裕あり・カーブ内 → ok
  const okRes = evaluateSafetyInvariants({
    turf: mockTurf, footprint: inside, roadSurface: road,
    speedMS: 3, curveLimitMS: 5, collision: false, forwardClearanceM: 12
  });
  check('normal tick -> ok (no violations)', okRes.ok && okRes.violations.length === 0);

  // 2) 道路逸脱（比率と面積の両閾値超過）
  const outRes = evaluateSafetyInvariants({
    turf: mockTurf, footprint: wayOut, roadSurface: road, speedMS: 3
  });
  check('road_surface_excursion detected', !outRes.ok
    && outRes.violations.some((v) => v.type === 'road_surface_excursion'),
    `ratio=${outRes.metrics.roadOutsideRatio}`);

  // 3) 道路逸脱 advisory: 記録はするが停止違反にはしない（index3D の現実寄り運用）
  const advisoryOut = evaluateSafetyInvariants({
    turf: mockTurf,
    footprint: wayOut,
    roadSurface: road,
    speedMS: 3,
    tolerances: { roadSurfaceMode: 'advisory' }
  });
  check('road_surface_excursion advisory does NOT fail',
    advisoryOut.ok
    && advisoryOut.violations.length === 0
    && advisoryOut.warnings.some((v) => v.type === 'road_surface_excursion'),
    `warnings=${advisoryOut.warnings.length}`);

  // 4) 接触
  const colRes = evaluateSafetyInvariants({ turf: mockTurf, footprint: inside, roadSurface: road, collision: true });
  check('clearance_contact detected', colRes.violations.some((v) => v.type === 'clearance_contact'));

  // 5) 前方clearance<=0
  const fcRes = evaluateSafetyInvariants({ forwardClearanceM: 0 });
  check('forward_clearance_non_positive detected',
    fcRes.violations.some((v) => v.type === 'forward_clearance_non_positive'));

  // 6) 未計測(null)は違反にしない（Number(null)===0 の罠の回帰）
  const nullRes = evaluateSafetyInvariants({ forwardClearanceM: null, speedMS: 3 });
  check('null forwardClearance is NOT a violation (regression)', nullRes.ok);

  // 7) カーブ速度: 許容差内はOK、超過は違反
  const inTol = evaluateSafetyInvariants({ speedMS: 5.3, curveLimitMS: 5.0 });
  const overTol = evaluateSafetyInvariants({ speedMS: 5.6, curveLimitMS: 5.0 });
  check('curve speed within tolerance ok / exceeded detected',
    inTol.ok && overTol.violations.some((v) => v.type === 'curve_speed_limit_exceeded'),
    `tol=0.35`);

  // 8) monitor: firstViolation捕捉 + trace ハッシュが決定論
  const mkRun = () => {
    const m = createSafetyMonitor({ worldHash: 'testworld', surface: 'unit' });
    m.push({ turf: mockTurf, footprint: inside, roadSurface: road, speedMS: 3, simTimeS: 0.05, progressM: 1 });
    m.push({ turf: mockTurf, footprint: wayOut, roadSurface: road, speedMS: 3, simTimeS: 0.10, progressM: 2 });
    m.push({ turf: mockTurf, footprint: inside, roadSurface: road, speedMS: 3, simTimeS: 0.15, progressM: 3 });
    return m;
  };
  const m1 = mkRun();
  const m2 = mkRun();
  check('firstViolation captured at tick 2',
    m1.firstViolation?.tick === 2
    && m1.firstViolation.violations[0].type === 'road_surface_excursion');
  check('trace hash deterministic across runs', m1.hash() === m2.hash(), `hash=${m1.hash()}`);

  // 8b) advisoryでも「大幅逸脱の持続」は違反へ昇格（瞬間逸脱・軽度逸脱は昇格しない）
  const grossOut = { _areaM2: 16, _outsideAreaM2: 10 }; // ratio=0.625, 面積10m² > 8m²
  const adv = { roadSurfaceMode: 'advisory' };
  const mSustain = createSafetyMonitor({ worldHash: 'testworld', surface: 'unit' });
  let sustainedViolationTick = null;
  for (let i = 0; i < 60; i++) {
    const r = mSustain.push({
      turf: mockTurf, footprint: grossOut, roadSurface: road,
      speedMS: 2, simTimeS: i * 0.05, progressM: i * 0.1, tolerances: adv
    });
    if (sustainedViolationTick == null && !r.ok
      && r.violations.some((v) => v.type === 'road_surface_excursion_sustained')) {
      sustainedViolationTick = r.tick;
    }
  }
  check('sustained gross excursion escalates to violation (advisory mode)',
    sustainedViolationTick != null && sustainedViolationTick >= 40,
    `tick=${sustainedViolationTick} (2.0s @ dt0.05 => tick41)`);

  const mReset = createSafetyMonitor({ worldHash: 'testworld', surface: 'unit' });
  let resetViolated = false;
  for (let i = 0; i < 39; i++) { // 1.95s < 2.0s
    const r = mReset.push({
      turf: mockTurf, footprint: grossOut, roadSurface: road,
      speedMS: 2, simTimeS: i * 0.05, progressM: i * 0.1, tolerances: adv
    });
    if (!r.ok) resetViolated = true;
  }
  const rBack = mReset.push({
    turf: mockTurf, footprint: inside, roadSurface: road,
    speedMS: 2, simTimeS: 39 * 0.05, progressM: 3.9, tolerances: adv
  });
  const rAgain = mReset.push({
    turf: mockTurf, footprint: grossOut, roadSurface: road,
    speedMS: 2, simTimeS: 40 * 0.05, progressM: 4.0, tolerances: adv
  });
  check('gross excursion below sustain window stays advisory + resets on return',
    !resetViolated && rBack.ok && rAgain.ok);

  const mMild = createSafetyMonitor({ worldHash: 'testworld', surface: 'unit' });
  let mildViolated = false;
  for (let i = 0; i < 120; i++) { // wayOut: ratio=0.5(閾値超えず) → 何秒続いても昇格しない
    const r = mMild.push({
      turf: mockTurf, footprint: wayOut, roadSurface: road,
      speedMS: 2, simTimeS: i * 0.05, progressM: i * 0.1, tolerances: adv
    });
    if (!r.ok) mildViolated = true;
  }
  check('mild sustained excursion never escalates', !mildViolated);

  // 9) YOLO/StreetView由来のプロキシ高さだけでは、頭上障害物を即NG/MRM扱いしない
  const lowOverheadPoly = {
    type: 'Feature',
    properties: { id: 'estimated-overhead', source: 'yolo', heightOnly: true, height: 2.8 },
    geometry: { type: 'Polygon', coordinates: [[[139.0, 35.0], [139.0001, 35.0], [139.0001, 35.0001], [139.0, 35.0001], [139.0, 35.0]]] }
  };
  const measuredOverheadPoly = {
    type: 'Feature',
    properties: { id: 'measured-overhead', heightOnly: true, clearanceHeight: 2.8 },
    geometry: lowOverheadPoly.geometry
  };
  const estimatedSolid = buildCollisionSolidSet({ maskEdits: { deny: [lowOverheadPoly] } }).overheadSolids[0];
  const measuredSolid = buildCollisionSolidSet({ maskEdits: { deny: [measuredOverheadPoly] } }).overheadSolids[0];
  const estimatedReport = buildClearanceSolidReport({
    maskEdits: { deny: [lowOverheadPoly] },
    vehicleConfig: { vehicleHeight: 3.2, vehicleWidth: 2.2 }
  });
  const measuredReport = buildClearanceSolidReport({
    maskEdits: { deny: [measuredOverheadPoly] },
    vehicleConfig: { vehicleHeight: 3.2, vehicleWidth: 2.2 }
  });
  check('estimated overhead clearance is advisory, not hard NG',
    estimatedSolid?.clearanceReliable === false
    && estimatedReport.rows[0]?.status === 'ADVISORY'
    && estimatedReport.summary.status === 'OK',
    `status=${estimatedReport.rows[0]?.status}/${estimatedReport.summary.status}`);
  check('explicit clearanceHeight remains hard NG',
    measuredSolid?.clearanceReliable === true
    && measuredReport.rows[0]?.status === 'NG',
    `status=${measuredReport.rows[0]?.status}`);

  // ── 10) 局所回避プランナ（localAvoidance.js）──────────────────────────
  // 直線の道路（東西・幅±3m）＋東向き経路（1.5m間隔・約60m）を合成し、
  // 中央付近の北側(+1.0m)に地上障害物を置く。planLocalAvoidance が横オフセットで
  // 回避し、障害物交差0・道路面内維持することを実 turf で検証する。
  const LAT0 = 35.0;
  const LNG0 = 139.0;
  const M_LAT = 111320;
  const M_LNG = 111320 * Math.cos(LAT0 * Math.PI / 180);
  const dLat = (m) => m / M_LAT;
  const dLng = (m) => m / M_LNG;

  // 東向き直線経路（左法線=北）。1.5m間隔・約60m。
  const straightRoute = [];
  for (let i = 0; i <= 40; i++) straightRoute.push({ lat: LAT0, lng: LNG0 + dLng(i * 1.5) });

  // 直線道路面（東西に長い矩形・幅±3m）。
  const roadSurface = realTurf.polygon([[
    [LNG0 + dLng(-5), LAT0 + dLat(-3)],
    [LNG0 + dLng(65), LAT0 + dLat(-3)],
    [LNG0 + dLng(65), LAT0 + dLat(3)],
    [LNG0 + dLng(-5), LAT0 + dLat(3)],
    [LNG0 + dLng(-5), LAT0 + dLat(-3)]
  ]]);

  // 中央(s≈30m)の北側(+1.0m)に地上障害物ボックス（±0.8m）。
  const obLng = LNG0 + dLng(30);
  const obLat = LAT0 + dLat(1.0);
  const obstacleBox = {
    type: 'Feature',
    properties: { id: 'avoid-test-obstacle', class: 'car', height: 1.6 },
    geometry: {
      type: 'Polygon',
      coordinates: [[
        [obLng - dLng(0.8), obLat - dLat(0.8)],
        [obLng + dLng(0.8), obLat - dLat(0.8)],
        [obLng + dLng(0.8), obLat + dLat(0.8)],
        [obLng - dLng(0.8), obLat + dLat(0.8)],
        [obLng - dLng(0.8), obLat - dLat(0.8)]
      ]]
    }
  };

  const testVehicle = { vehicleWidth: 2.0, wheelBase: 2.0, frontOverhang: 0.3, rearOverhang: 0.3 };
  const fpCfg = getVehicleFootprintConfig(testVehicle, { defaultVehicleWidth: 2.0 });

  // 経路に沿ってフットプリント4隅を置き、障害物交差数と道路面外の隅数を数える検証器。
  const verifyRoute = (routeLL) => {
    let obstacleHits = 0;
    let outsideCorners = 0;
    for (let i = 1; i < routeLL.length; i++) {
      const a = routeLL[i - 1];
      const b = routeLL[i];
      const heading = Math.atan2(
        (b.lat - a.lat) * M_LAT,
        (b.lng - a.lng) * M_LNG
      );
      const c = Math.cos(heading), s = Math.sin(heading);
      const bx = (b.lng - LNG0) * M_LNG;
      const by = (b.lat - LAT0) * M_LAT;
      const local = [
        [fpCfg.frontExtentM, fpCfg.halfWidthM], [fpCfg.frontExtentM, -fpCfg.halfWidthM],
        [-fpCfg.rearExtentM, -fpCfg.halfWidthM], [-fpCfg.rearExtentM, fpCfg.halfWidthM]
      ];
      const ring = local.map(([dx, dy]) => {
        const x = bx + dx * c - dy * s;
        const y = by + dx * s + dy * c;
        return [LNG0 + x / M_LNG, LAT0 + y / M_LAT];
      });
      ring.push(ring[0]);
      const fpPoly = realTurf.polygon([ring]);
      if (realTurf.booleanIntersects(fpPoly, obstacleBox)) obstacleHits++;
      for (let k = 0; k < 4; k++) {
        if (!realTurf.booleanPointInPolygon(realTurf.point(ring[k]), roadSurface)) outsideCorners++;
      }
    }
    return { obstacleHits, outsideCorners };
  };

  // 10a) 障害物ありは横オフセットで回避し、障害物交差0・道路面内維持
  const baseline = verifyRoute(straightRoute);
  const avo = planLocalAvoidance({
    routeLL: straightRoute,
    roadSurface,
    obstacles: [obstacleBox],
    vehicleConfig: testVehicle,
    turf: realTurf
  });
  const avoVerify = verifyRoute(avo.routeLL);
  check('local avoidance: baseline route hits obstacle (fixture sanity)',
    baseline.obstacleHits > 0, `baselineHits=${baseline.obstacleHits}`);
  check('local avoidance: offsets to clear obstacle (0 hits, on road)',
    avo.adjustedCount >= 1
    && avo.routeLL.length >= 2
    && avoVerify.obstacleHits === 0
    && avoVerify.outsideCorners === 0,
    `adjusted=${avo.adjustedCount} chosen=${avo.hotspots.map((h) => h.chosenOffsetM).join(',')} hits=${avoVerify.obstacleHits} outside=${avoVerify.outsideCorners}`);

  // 10b) 障害物なしでは経路不変（同一参照を返す・調整なし）
  const avoNone = planLocalAvoidance({
    routeLL: straightRoute,
    roadSurface,
    obstacles: [],
    vehicleConfig: testVehicle,
    turf: realTurf
  });
  check('local avoidance: unchanged when no obstacles',
    avoNone.adjustedCount === 0 && avoNone.routeLL === straightRoute,
    `adjusted=${avoNone.adjustedCount} hotspots=${avoNone.hotspots.length}`);

  // ── 11) 縦方向動力学（vehicleRiskModel + physics）───────────────────────
  // 勾配・路面摩擦を反映した制動/加速度と、gradeAtM 未指定時の物理後方互換を検証する。
  const riskMod = await import(pathToFileURL(path.join(ROOT, 'src', 'core', 'vehicleRiskModel.js')).href);
  const { effectiveBrakeDecelMSS, effectiveAccelMSS } = riskMod;
  const physicsMod = await import(pathToFileURL(path.join(ROOT, 'src', 'core', 'physics.js')).href);
  const { simulatePathPoses, createKinematicPathFollower } = physicsMod;

  const flatDry = effectiveBrakeDecelMSS({ gradePct: 0, surface: 'dry' });
  check('brake: flat dry == comfort 2.8', Math.abs(flatDry - 2.8) < 1e-9, `a=${flatDry.toFixed(4)}`);

  const down8 = effectiveBrakeDecelMSS({ gradePct: -8, surface: 'dry' });
  check('brake: 8% downhill reduces decel', down8 < flatDry - 0.1, `a=${down8.toFixed(4)}`);

  const up8 = effectiveBrakeDecelMSS({ gradePct: 8, surface: 'dry' });
  check('brake: 8% uphill decel >= flat 2.8', up8 >= flatDry - 1e-9, `a=${up8.toFixed(4)}`);

  const flatWet = effectiveBrakeDecelMSS({ gradePct: 0, surface: 'wet' });
  check('brake: wet reduces decel vs dry', flatWet < flatDry - 0.1,
    `wet=${flatWet.toFixed(4)} dry=${flatDry.toFixed(4)}`);

  // 単調性: 下りが急になるほど制動は弱くなる
  const down4 = effectiveBrakeDecelMSS({ gradePct: -4, surface: 'dry' });
  const down16 = effectiveBrakeDecelMSS({ gradePct: -16, surface: 'dry' });
  check('brake: monotonic in downhill steepness', down4 > down8 && down8 > down16,
    `-4=${down4.toFixed(3)} -8=${down8.toFixed(3)} -16=${down16.toFixed(3)}`);

  const wetDown30 = effectiveBrakeDecelMSS({ gradePct: -30, surface: 'wet' });
  check('brake: wet -30% returns zero when net capability is non-positive', wetDown30 === 0,
    `a=${wetDown30.toFixed(4)}`);

  const wetUp30 = effectiveBrakeDecelMSS({ gradePct: 30, surface: 'wet' });
  check('brake: wet uphill cap derives from wet surface comfort',
    wetUp30 <= flatWet * 1.3 + 1e-9 && wetUp30 > flatWet,
    `up=${wetUp30.toFixed(4)} cap=${(flatWet * 1.3).toFixed(4)}`);

  // surfaceCondition は vehicleConfig 経由でも効く（surface 引数より優先）
  const wetViaConfig = effectiveBrakeDecelMSS({ gradePct: 0, surface: 'dry', vehicleConfig: { surfaceCondition: 'wet' } });
  check('brake: vehicleConfig.surfaceCondition overrides surface arg',
    Math.abs(wetViaConfig - flatWet) < 1e-9, `a=${wetViaConfig.toFixed(4)}`);

  // 加速: 平坦=1.2 / 上りで減る / 登坂能力を超えたら架空の加速を返さない
  const accFlat = effectiveAccelMSS({ gradePct: 0 });
  const accUp8 = effectiveAccelMSS({ gradePct: 8 });
  const accUp40 = effectiveAccelMSS({ gradePct: 40 });
  check('accel: flat == comfort 1.2', Math.abs(accFlat - 1.2) < 1e-9, `a=${accFlat.toFixed(4)}`);
  check('accel: uphill reduces accel and returns zero beyond climb capability',
    accUp8 < accFlat - 0.05 && accUp40 === 0,
    `up8=${accUp8.toFixed(3)} up40=${accUp40.toFixed(3)}`);

  const lightBrake = effectiveBrakeDecelMSS({ gradePct: 0, vehicleConfig: { grossWeight: 8 } });
  const heavyBrake = effectiveBrakeDecelMSS({ gradePct: 0, vehicleConfig: { grossWeight: 20 } });
  const lightAccel = effectiveAccelMSS({ gradePct: 0, vehicleConfig: { grossWeight: 8 } });
  const heavyAccel = effectiveAccelMSS({ gradePct: 0, vehicleConfig: { grossWeight: 20 } });
  check('load: heavy vehicle has lower operational acceleration and comfort braking',
    heavyAccel < lightAccel && heavyBrake < lightBrake,
    `accel=${lightAccel.toFixed(3)}/${heavyAccel.toFixed(3)} brake=${lightBrake.toFixed(3)}/${heavyBrake.toFixed(3)}`);

  // 後方互換: gradeAtM 未指定 == gradeAtM=()=>0（dry）で simulatePathPoses が bit 一致
  const poseHash = (poses) => poses
    .map((p) => [p.x, p.y, p.theta, p.speedMS, p.timeS, p.travelM]
      .map((n) => Number(n).toFixed(6)).join(','))
    .join(';');
  const kinePath = [
    { x: -36, y: 0 }, { x: -12, y: 0 }, { x: 0, y: 0 },
    { x: 0, y: 24 }, { x: 24, y: 24 }, { x: 48, y: 24 }
  ];
  const kineCfg = {
    vehicleWidth: 2.2, wheelBase: 3.4, frontOverhang: 1.0, rearOverhang: 1.0,
    vehicleSpeed: 5, maxSteeringAngle: 38
  };
  const posesDefault = simulatePathPoses({ ...kineCfg }, kinePath, 0.5, { dt: 0.05, maxSteps: 20000 });
  const posesZeroGrade = simulatePathPoses({ ...kineCfg }, kinePath, 0.5, { dt: 0.05, maxSteps: 20000, gradeAtM: () => 0 });
  check('physics: gradeAtM omitted == gradeAtM=()=>0 (backward compat)',
    posesDefault.length > 10 && poseHash(posesDefault) === poseHash(posesZeroGrade),
    `n=${posesDefault.length}/${posesZeroGrade.length}`);

  // 勾配ありは実際に挙動へ効く（急な下り連続で速度プロファイルが変わる）。
  const posesDownhill = simulatePathPoses({ ...kineCfg }, kinePath, 0.5, { dt: 0.05, maxSteps: 20000, gradeAtM: () => -12 });
  check('physics: nonzero grade changes the pose stream',
    poseHash(posesDownhill) !== poseHash(posesDefault),
    `n=${posesDownhill.length}`);

  const zeroBrakeHardStop = simulatePathPoses(
    { ...kineCfg, vehicleSpeed: 1, surfaceCondition: 'wet' },
    [{ x: 0, y: 0 }, { x: 1000, y: 0 }],
    0.1,
    {
      dt: 0.05,
      maxSteps: 200,
      gradeAtM: () => -30,
      speedLimitAtM: () => 0
    }
  );
  const zeroBrakeFinal = zeroBrakeHardStop[zeroBrakeHardStop.length - 1];
  check('physics: zero-brake hard STOP does not launch from rest through the low-speed branch',
    Number(zeroBrakeFinal?.speedMS) === 0 && Number(zeroBrakeFinal?.travelM) === 0,
    `speed=${Number(zeroBrakeFinal?.speedMS).toFixed(3)} travel=${Number(zeroBrakeFinal?.travelM).toFixed(3)}`);

  const follower = createKinematicPathFollower(
    { ...kineCfg, vehicleSpeed: 6, maxAccel: 1.2, maxDecel: 2.8 },
    [{ x: 0, y: 0 }, { x: 100, y: 0 }],
    { speedMS: 6, speedLimitAtM: (sM) => sM >= 50 ? 0 : Infinity }
  );
  let firstLimitedProgressM = null;
  for (let i = 0; i < 400; i++) {
    const live = follower.step(0.05, { targetSpeedMS: 6 });
    if (firstLimitedProgressM == null && live.targetSpeedMS < 5.99) firstLimitedProgressM = live.progressS;
    if (live.progressS >= 50 || live.done) break;
  }
  check('physics: live follower brakes before an upcoming STOP limit',
    firstLimitedProgressM != null && firstLimitedProgressM < 48,
    `firstLimited=${firstLimitedProgressM == null ? 'none' : firstLimitedProgressM.toFixed(2)}m`);

  const plannerMod = await import(pathToFileURL(path.join(ROOT, 'src', 'sim', 'autonomy', 'behaviorPlanner.js')).href);
  const plannerRoute = [{ lat: 35.0, lng: 139.0 }, { lat: 35.0, lng: 139.001 }];
  const plannerRoad = {
    type: 'Feature',
    properties: { demGradeMedianPct: 12, width: 8 },
    geometry: { type: 'LineString', coordinates: [[139.0, 35.0], [139.001, 35.0]] }
  };
  const plannerReport = plannerMod.buildAutonomyDriveReport({
    route: plannerRoute,
    roads: [plannerRoad],
    vehicleConfig: { ...kineCfg, grossWeight: 8 },
    sampleSpacingM: 20,
    cruiseSpeedKmh: 18
  });
  const gradedSample = plannerReport.samples.find((sample) => sample.gradePct === 12);
  check('planner: samples store conservative brakeGradePct contract',
    !!gradedSample && gradedSample.brakeGradePct === -12,
    `brakeGradePct=${gradedSample?.brakeGradePct}`);

  console.log(pass ? '\nsafety check ALL PASS' : '\nsafety check FAILED');
  return pass ? 0 : 1;
}

main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
