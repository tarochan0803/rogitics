#!/usr/bin/env node
/**
 * run_safety_check.js — Safety Monitor（Phase 3）の単体検証（ネット/ブラウザ不要）
 *
 * evaluateSafetyInvariants / createSafetyMonitor を、注入モックturfで検査する。
 * 検査項目: 正常系OK / 道路逸脱 / 道路逸脱advisory / 接触 / 前方clearance<=0 / 未計測(null)は違反にしない
 *           / カーブ速度超過(許容差込み) / firstViolation捕捉+traceハッシュ安定
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

async function main() {
  const mod = await import(pathToFileURL(path.join(ROOT, 'src', 'sim', 'safetyMonitor.js')).href);
  const { evaluateSafetyInvariants, createSafetyMonitor } = mod;

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

  console.log(pass ? '\nsafety check ALL PASS' : '\nsafety check FAILED');
  return pass ? 0 : 1;
}

main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
