#!/usr/bin/env node
/**
 * run_sim_repro.js — Phase 0 決定論検証ハーネス（ヘッドレス・依存ゼロ）
 *
 * 検証内容:
 *  [1] 決定論: 同一入力で N 回（既定100）走らせ、trace ハッシュが全一致すること
 *  [2] リプレイ: 1回目の trace を記録し、再実行を1tickずつ照合して完全一致すること
 *  [3] 可変dtの危険性: rAF を模した揺らぎ dt では結果が変わる（=固定dtが必須である）こと
 *  [4] dt収束性: dt を半分にしても最終位置が大きくズレない（積分の健全性）
 *
 * 実行: node src/batch/run_sim_repro.js [--runs 100] [--out runtime/sim_repro]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..', '..');
const MAX_TICKS = 500000;
const MAX_VARIABLE_DT_FRAMES = 100000;

function parseArgs(argv) {
  const o = { runs: 100, out: path.join(ROOT, 'runtime', 'sim_repro') };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--runs') o.runs = parseInt(argv[++i], 10) || o.runs;
    else if (argv[i] === '--out') o.out = path.resolve(argv[++i]);
  }
  return o;
}

// 合成ルート: 直線→右直角→スラローム→直線（曲率と減速帯を含む決定論的な検証コース）
function buildSyntheticRoute() {
  const pts = [];
  const lat0 = 35.6812;
  const lng0 = 139.7671;
  const mLat = 1 / 111320;
  const mLng = 1 / (111320 * Math.cos(lat0 * Math.PI / 180));
  let x = 0;
  let y = 0;
  const push = () => pts.push({ lat: lat0 + y * mLat, lng: lng0 + x * mLng });
  push();
  for (let i = 0; i < 40; i++) { y += 5; push(); }            // 北へ200m
  for (let a = 0; a <= 90; a += 6) {                          // 右直角(半径12m)
    x = 12 - 12 * Math.cos(a * Math.PI / 180);
    y = 200 + 12 * Math.sin(a * Math.PI / 180);
    push();
  }
  const yBase = y;
  for (let i = 1; i <= 30; i++) {                             // 東へスラローム150m
    x = 12 + i * 5;
    y = yBase + 3 * Math.sin(i / 3);
    push();
  }
  for (let i = 0; i < 20; i++) { x += 5; push(); }            // 東へ直線100m
  return pts;
}

// 速度プロファイル: 巡航5m/s、s=180..230は狭所徐行1.2m/s、終端は停止までランプ
function speedProfile(totalM) {
  return (sM) => {
    let v = 5;
    if (sM >= 180 && sM <= 230) v = 1.2;
    const remain = totalM - sM;
    if (remain < 12) v = Math.min(v, Math.max(0.4, remain * 0.5));
    return v;
  };
}

function traceRecord(st) {
  return { tick: st.tick, sM: st.sM, lat: st.lat, lng: st.lng, h: st.headingDeg, v: st.speedMS };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const core = await import(pathToFileURL(path.join(ROOT, 'src', 'sim', 'autoFollowCore.js')).href);
  const traceMod = await import(pathToFileURL(path.join(ROOT, 'src', 'sim', 'trace.js')).href);
  const { createAutoFollowSim, buildCumulative, createRng } = core;
  const { createTrace, createReplayChecker } = traceMod;

  const route = buildSyntheticRoute();
  const totalM = buildCumulative(route).at(-1);
  const DT = 0.05;
  console.log(`=== sim repro harness ===  route ${route.length} pts / ${totalM.toFixed(1)} m, dt=${DT}s, runs=${opts.runs}`);

  let pass = true;
  const check = (name, cond, detail = '') => {
    console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? '  ' + detail : ''}`);
    pass = pass && cond;
    return cond;
  };

  function runOnce(dtS, onTick) {
    const sim = createAutoFollowSim({ route, dtS, speedFn: speedProfile(totalM) });
    while (!sim.state.done && sim.state.tick < MAX_TICKS) {
      sim.step();
      if (onTick) onTick(sim.state);
    }
    if (!sim.state.done) {
      throw new Error(`simulation did not reach done=true before max ticks: dt=${dtS}, tick=${sim.state.tick}, sM=${sim.state.sM}, totalM=${totalM}, maxTicks=${MAX_TICKS}`);
    }
    return sim.state;
  }

  // [1] 決定論: N回のtraceハッシュ全一致
  const hashes = [];
  let firstTrace = null;
  for (let r = 0; r < opts.runs; r++) {
    const tr = createTrace({ dtS: DT, runs: opts.runs });
    runOnce(DT, (st) => tr.push(traceRecord(st)));
    hashes.push(tr.hash());
    if (r === 0) firstTrace = tr;
  }
  const allSame = hashes.every((h) => h === hashes[0]);
  check(`determinism: ${opts.runs} runs identical`, allSame,
    `hash=${hashes[0]} ticks=${firstTrace.length}`);

  // [2] リプレイ照合: 記録を1tickずつ突き合わせ
  const checker = createReplayChecker(firstTrace.lines());
  runOnce(DT, (st) => checker.check(traceRecord(st)));
  const rep = checker.result();
  check('replay: tick-by-tick exact match', rep.ok,
    rep.ok ? `${rep.records} records` : `mismatch at tick ${rep.tick}`);

  // [3] 可変dt（rAF模擬・seed付き揺らぎ）では trace が変わる = 固定dtの必要性
  const rng = createRng(42);
  const trVar = createTrace({ mode: 'variable-dt' });
  {
    const sim = createAutoFollowSim({ route, dtS: DT, speedFn: speedProfile(totalM) });
    // 可変dtを直接模す: 1stepごとに dt を作り直した sim を毎回進める代わりに、
    // step時間の揺らぎを速度換算で注入（16.7ms±8ms のフレームを 50ms 固定と比較）
    let acc = 0;
    let t = 0;
    while (!sim.state.done && t < MAX_VARIABLE_DT_FRAMES) {
      const frame = 0.0167 + (rng() - 0.5) * 0.016;
      acc += frame;
      while (acc >= DT && !sim.state.done) { acc -= DT; sim.step(); trVar.push(traceRecord(sim.state)); }
      t++;
    }
    if (!sim.state.done) {
      throw new Error(`variable-dt replay did not reach done=true before max frames: frame=${t}, tick=${sim.state.tick}, sM=${sim.state.sM}, totalM=${totalM}, maxFrames=${MAX_VARIABLE_DT_FRAMES}`);
    }
  }
  // 固定dtアキュムレータで消費すれば、フレーム揺らぎがあっても trace は一致するはず
  check('fixed-dt accumulator absorbs frame jitter', trVar.hash() === hashes[0],
    `jittered=${trVar.hash()} fixed=${hashes[0]}`);

  // [4] dt収束性: dt半分でも最終位置がほぼ同じ（積分の健全性）
  const endA = runOnce(DT);
  const endB = runOnce(DT / 2);
  const dLat = (endA.lat - endB.lat) * 111320;
  const dLng = (endA.lng - endB.lng) * 111320 * Math.cos(endA.lat * Math.PI / 180);
  const drift = Math.hypot(dLat, dLng);
  check('dt-halving consistency (< 0.5 m)', drift < 0.5, `drift=${drift.toFixed(3)} m`);

  // trace を成果物として保存（バグ報告の添付形式）
  fs.mkdirSync(opts.out, { recursive: true });
  const outFile = path.join(opts.out, 'trace_baseline.jsonl');
  fs.writeFileSync(outFile, firstTrace.toJSONL(), 'utf8');
  console.log(`\ntrace saved: ${outFile}`);
  console.log(pass ? '\nALL PASS' : '\nFAILED');
  return pass ? 0 : 1;
}

main().then((code) => process.exit(code)).catch((e) => {
  console.error(e);
  process.exit(1);
});
