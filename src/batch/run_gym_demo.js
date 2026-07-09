#!/usr/bin/env node
/**
 * run_gym_demo.js — ③RL基盤のデモ/検証: gym環境で2つの方策を走らせ、
 * 「入れた/入れなかった理由コード・挙動trace・決定論」を確認する。
 *   方策A: 計画追従（常にaction=2） … PASS想定
 *   方策B: 無謀全速（常にaction=3） … 減点/停止ゾーン進入でMRM終了想定
 * 実行: node src/batch/run_gym_demo.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { loadMods, loadWorld } = require('./headlessPlanner.js');

const ROOT = path.resolve(__dirname, '..', '..');

async function main() {
  const { config } = await loadMods(); // turf注入込み
  const gym = await import(pathToFileURL(path.join(ROOT, 'src', 'sim', 'gymEnv.js')).href);

  const routesFile = fs.readdirSync(path.join(ROOT, 'runtime', 'teacher_data'))
    .filter((f) => /^teacher_site_routes_\d+\.json$/.test(f)).sort().pop();
  const routes = JSON.parse(fs.readFileSync(path.join(ROOT, 'runtime', 'teacher_data', routesFile), 'utf8')).routes;
  const rt = routes[0];
  const wf = rt.worldFile.replace(/\\/g, '/');
  const world = loadWorld(wf.includes('runtime') ? wf.slice(wf.indexOf('runtime')) : wf);

  let pass = true;
  const check = (n, c, d = '') => { console.log(`[${c ? 'PASS' : 'FAIL'}] ${n}  ${d}`); pass = pass && c; };

  function runEpisode(policy, seed) {
    const env = gym.createDeliveryGymEnv({
      roads: world.layers.roads, buildings: world.layers.buildings || [],
      route: rt.route, vehicleConfig: config.VEHICLE_PRESETS['2t_flat'], seed
    });
    env.reset();
    let total = 0;
    let last = null;
    for (let i = 0; i < 3000; i++) {
      last = env.step(policy);
      total += last.reward;
      if (last.done) break;
    }
    return { reason: last.info.reasonCode, totalReward: Math.round(total * 100) / 100, prog: last.info.progressM, trace: env.episodeTrace() };
  }

  const a1 = runEpisode(2, 1);
  const a2 = runEpisode(2, 1);
  const b = runEpisode(3, 1);

  check('方策A(計画追従)が理由コード付きで完走', a1.reason === 'GOAL', `reason=${a1.reason} reward=${a1.totalReward} prog=${a1.prog}m`);
  check('決定論: 同一方策・同一seedでtraceハッシュ一致', a1.trace.hash === a2.trace.hash, `hash=${a1.trace.hash}`);
  check('方策B(無謀全速)は減点され、報酬がAより低い', b.totalReward < a1.totalReward,
    `A=${a1.totalReward} B=${b.totalReward} reasonB=${b.reason}`);
  check('挙動traceが取得できる（JSONL行数>10）', a1.trace.jsonl.split('\n').length > 10,
    `${a1.trace.jsonl.split('\n').length}行`);

  console.log(pass ? '\ngym demo ALL PASS' : '\ngym demo FAILED');
  return pass ? 0 : 1;
}

main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
