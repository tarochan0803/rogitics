/**
 * autoFollowCore.js — 経路自動追従の決定論的コア（Phase 0）
 *
 * ブラウザ(truckDrive.js)と Node ヘッドレス(run_sim_repro.js)が同じ数学を共有する。
 * そのため依存ゼロ（DOM/turf/store禁止）・純関数のみ。ここが崩れると
 * 「バグ報告=シード+tick番号で完全再現」が成立しなくなる。
 *
 * 決定論の規約:
 * - 時間は固定タイムステップ dtS のみで進む（可変dt・壁時計は入力にしない）
 * - 乱数は必ず createRng(seed) を使う（Math.random 禁止）
 * - speedFn は (sM, state) の純関数であること（外部の壁時計・DOMを見ない）
 */

const DEG2RAD = Math.PI / 180;

// ── seeded RNG (mulberry32) ──────────────────────────────────────────────────
export function createRng(seed = 1) {
  let t = (seed >>> 0) || 1;
  return function rand() {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

// ── route geometry (equirectangular local approx — truckDrive と同一) ───────
export function bearing(a, b) {
  const dLng = (b.lng - a.lng) * DEG2RAD;
  const p1 = a.lat * DEG2RAD;
  const p2 = b.lat * DEG2RAD;
  const y = Math.sin(dLng) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dLng);
  return (Math.atan2(y, x) / DEG2RAD + 360) % 360;
}

export function buildCumulative(route) {
  const cum = [0];
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1];
    const b = route[i];
    const dlat = (b.lat - a.lat) * 111320;
    const dlng = (b.lng - a.lng) * 111320 * Math.cos(a.lat * DEG2RAD);
    cum[i] = cum[i - 1] + Math.sqrt(dlat * dlat + dlng * dlng);
  }
  return cum;
}

export function sampleRouteAt(route, cum, s) {
  const total = cum[cum.length - 1];
  const sc = Math.max(0, Math.min(total, s));
  let lo = 0;
  let hi = cum.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= sc) lo = mid; else hi = mid;
  }
  const t = (cum[hi] - cum[lo]) > 1e-6 ? (sc - cum[lo]) / (cum[hi] - cum[lo]) : 0;
  return {
    lat: route[lo].lat + (route[hi].lat - route[lo].lat) * t,
    lng: route[lo].lng + (route[hi].lng - route[lo].lng) * t
  };
}

// ── deterministic auto-follow simulation ─────────────────────────────────────
/**
 * createAutoFollowSim({ route, dtS, lookaheadM, speedFn })
 * - route:      [{lat,lng}, ...]（2点以上）
 * - dtS:        固定タイムステップ秒（既定 0.05）
 * - lookaheadM: heading 計算の先読み距離（truckDrive と同じ既定 4m）
 * - speedFn:    (sM, state) => その地点の許容速度 m/s（純関数）
 * 返り値: { step(), run(maxSteps), state }
 */
export function createAutoFollowSim({ route, dtS = 0.05, lookaheadM = 4, speedFn } = {}) {
  if (!Array.isArray(route) || route.length < 2) {
    throw new Error('createAutoFollowSim: route must have >= 2 points');
  }
  const cum = buildCumulative(route);
  const totalM = cum[cum.length - 1];
  const speed = typeof speedFn === 'function' ? speedFn : () => 5;

  const state = {
    tick: 0,
    tS: 0,
    sM: 0,
    lat: route[0].lat,
    lng: route[0].lng,
    headingDeg: bearing(route[0], route[Math.min(1, route.length - 1)]),
    speedMS: 0,
    done: totalM <= 0
  };

  function step() {
    if (state.done) return state;
    const v = Math.max(0, Number(speed(state.sM, state)) || 0);
    state.sM = Math.min(state.sM + v * dtS, totalM);
    const cur = sampleRouteAt(route, cum, state.sM);
    const ahead = sampleRouteAt(route, cum, Math.min(state.sM + lookaheadM, totalM));
    state.lat = cur.lat;
    state.lng = cur.lng;
    if (ahead.lat !== cur.lat || ahead.lng !== cur.lng) {
      state.headingDeg = bearing(cur, ahead);
    }
    state.speedMS = v;
    state.tick += 1;
    state.tS = state.tick * dtS;
    if (state.sM >= totalM) state.done = true;
    return state;
  }

  function run(maxSteps = 200000) {
    while (!state.done && state.tick < maxSteps) step();
    return state;
  }

  return { step, run, state, totalM, cum };
}
