/**
 * gymEnv.js — ③RL基盤: 搬入走行の gym 互換環境（reset/step/reward/done/info）。
 *
 * 決定論コア(autoFollowCore)＋behaviorPlannerのサンプル列を環境ダイナミクスとして、
 * ブラウザ無しで方策学習の試行を回せる。要件どおり
 * 「入らなかった理由（reasonCode）」「入ったときの挙動（trace）」を毎エピソード返す。
 *
 * v1の行動空間: 離散4段 { 0:停止, 1:徐行, 2:計画速度, 3:全速 }
 *  - 計画速度(allowedSpeedMS)超過は減点＋Safety cutoff（planner STOPゾーン進入で即MRM終了）
 *  - 物理はplanner忠実度（Monitorの面判定はブラウザ二段で最終確認する設計と同じ思想）
 *
 * 使用（Node）: headlessPlanner.loadMods() で turf 注入後に import すること。
 */

import { buildAutonomyDriveReport } from './autonomy/behaviorPlanner.js';
import { createRng } from './autoFollowCore.js';
import { createTrace } from './trace.js';

const ACTION_SPEEDS = ['STOP', 'CRAWL', 'PLAN', 'FULL'];

export function createDeliveryGymEnv({
  roads = [],
  buildings = [],
  route = [],
  vehicleConfig = {},
  cruiseSpeedKmh = 18,
  dtS = 0.25,          // RL用は粗め刻み（1step=0.25s）で十分・高速
  maxSteps = 2400,
  seed = 1
} = {}) {
  const report = buildAutonomyDriveReport({
    route, roads, buildings, vehicleConfig, cruiseSpeedKmh
  });
  const samples = report.samples || [];
  const totalM = samples.length ? samples[samples.length - 1].sM : 0;
  const cruiseMS = Math.max(0.6, cruiseSpeedKmh / 3.6);

  function sampleAt(sM) {
    if (!samples.length) return null;
    let lo = 0, hi = samples.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (samples[mid].sM <= sM) lo = mid; else hi = mid;
    }
    return samples[lo];
  }

  let state = null;

  function observationOf(sM, speedMS) {
    const s = sampleAt(sM) || {};
    return {
      // 正規化済み観測ベクトル（RLフレームワークへは Object.values で渡せる）
      progress: totalM > 0 ? sM / totalM : 1,
      speed: speedMS / 10,
      allowed: (Number(s.allowedSpeedMS) || 0) / 10,
      mode: ['CRUISE', 'SLOW', 'YIELD', 'SATURATED', 'STOP'].indexOf(s.mode) / 4,
      turn: Math.min(1, (Number(s.turnDeg) || 0) / 90),
      grade: Math.min(1, Math.abs(Number(s.gradePct) || 0) / 15),
      swing: Math.min(1, (Number(s.curveSwingM) || 0) / 3),
      widthMargin: Math.max(-1, Math.min(1, (Number(s.widthMarginM) ?? 2) / 2)),
      clearance: Math.min(1, (Number(s.forwardClearanceM) ?? 34) / 34),
      switchback: s.switchbackRecommended ? 1 : 0
    };
  }

  return {
    actionSpace: ACTION_SPEEDS,
    observationKeys: Object.keys(observationOf(0, 0)),
    plannerSummary: report.summary,

    reset() {
      state = {
        sM: 0, speedMS: 0, tick: 0,
        rng: createRng(seed),
        trace: createTrace({ env: 'delivery-gym', routeLenM: Math.round(totalM), vehicle: vehicleConfig?.label || 'default' }),
        done: false, reason: null
      };
      return observationOf(0, 0);
    },

    step(action) {
      if (!state || state.done) throw new Error('call reset() first');
      const s = sampleAt(state.sM) || {};
      const allowedMS = Math.max(0, Number(s.allowedSpeedMS) || 0);
      const target = action === 0 ? 0
        : action === 1 ? Math.min(allowedMS, cruiseMS * 0.25)
        : action === 2 ? allowedMS
        : cruiseMS; // FULL: 計画を無視して巡航速度
      // 加減速制約（±2.5 m/s^2）で速度を追従
      const dv = Math.max(-2.5 * dtS, Math.min(2.5 * dtS, target - state.speedMS));
      state.speedMS = Math.max(0, state.speedMS + dv);
      state.sM = Math.min(totalM, state.sM + state.speedMS * dtS);
      state.tick += 1;

      let reward = (state.speedMS * dtS) / Math.max(1, totalM) * 100; // 進捗報酬
      reward -= 0.01; // 時間ペナルティ
      const overspeed = state.speedMS - allowedMS;
      if (overspeed > 0.3) reward -= overspeed * 0.5; // 計画速度超過（危険運転）減点

      const cur = sampleAt(state.sM) || {};
      let info = { reasonCode: null, mode: cur.mode || null };
      // Safety cutoff: STOPゾーンへ有意な速度で進入 → MRM終了（理由コード付き）
      if (cur.mode === 'STOP' && state.speedMS > 0.3) {
        state.done = true;
        state.reason = cur.switchbackRecommended ? 'MRM_SWITCHBACK_ZONE' : 'MRM_STOP_ZONE';
        reward -= 5;
      } else if (state.sM >= totalM - 0.5) {
        state.done = true;
        state.reason = 'GOAL';
        reward += 10;
      } else if (state.tick >= maxSteps) {
        state.done = true;
        state.reason = 'TIMEOUT';
        reward -= 2;
      }
      info.reasonCode = state.reason;
      info.progressM = Math.round(state.sM * 10) / 10;
      info.totalM = Math.round(totalM * 10) / 10;

      state.trace.push({
        tick: state.tick, sM: Math.round(state.sM * 100) / 100,
        v: Math.round(state.speedMS * 100) / 100, a: action,
        allowed: Math.round(allowedMS * 100) / 100
      });

      return {
        observation: observationOf(state.sM, state.speedMS),
        reward: Math.round(reward * 1000) / 1000,
        done: state.done,
        info
      };
    },

    // 「入ったときの挙動」= trace（JSONL/ハッシュで再現可能）
    episodeTrace() {
      return state ? { hash: state.trace.hash(), jsonl: state.trace.toJSONL(), reason: state.reason } : null;
    }
  };
}
