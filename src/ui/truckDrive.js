/**
 * truckDrive.js — 2D route auto-follow and truck footprint overlay
 * - Route auto-follow consumes the autonomy speed model
 * - Spherical earth position update (Haversine forward)
 * - Off-road detection: red highlight when outside loaded road network
 * - Trail segments change color on road status transition
 * - Stylish SVG truck icon (top-down, cab=north)
 */
import { getMapInstance } from './map2d.js';
import { store } from '../state.js';
import { getVehicleFootprintConfig } from '../3d/clearanceSolids.js';
import { buildAutonomyDriveReport } from '../sim/autonomy/behaviorPlanner.js';
import { turf } from '../utils/geo.js';
import { fuseWidthForFeature } from '../core/feasibility.js';
import { autonomousSpeedFactor } from '../core/vehicleRiskModel.js';
import { bearing as coreBearing, buildCumulative, sampleRouteAt } from '../sim/autoFollowCore.js';

// ── Constants ───────────────────────────────────────────────────────────────
const DEG2RAD = Math.PI / 180;
const R_EARTH  = 6371000; // metres
const TRAIL_STEP_M = 1.5;        // metres between trail sample points
// 決定論規約(autoFollowCore): 物理はシミュ時間の固定ステップのみで進める。
// 描画フレーム(rAF)の揺らぎはアキュムレータで吸収する（run_sim_repro で検証済み）。
const SIM_DT_S = 0.05;           // fixed physics timestep
const OFF_ROAD_CHECK_S = 0.35;   // sim-seconds between road-detection passes

// ── Mutable vehicle config ──────────────────────────────────────────────────
let truckWM    = 2.5;
let wheelbaseM = 4.0;

function _currentFootprint() {
  return getVehicleFootprintConfig(store.getState()?.vehicleConfig || {}, {
    defaultWheelBase: wheelbaseM,
    defaultVehicleWidth: truckWM,
    defaultRearOverhang: 1.5
  });
}

export function setDriveConfig({ widthM, wbM, maxSpeedKmh } = {}) {
  if (widthM      != null) truckWM    = Math.max(0.5, widthM);
  if (wbM         != null) wheelbaseM = Math.max(1.0, wbM);
}

// ── State ───────────────────────────────────────────────────────────────────
let driveLat = 35.6762;
let driveLng = 139.6503;
let heading  = 0;   // clockwise from north
let speed    = 0;   // m/s

// Off-road detection
let isOffRoad       = false;
let lastOffRoadSimT = -1;  // sim-seconds（壁時計でなくシミュ時間基準＝決定論）
// 通行リスクモデル: 最寄り道路の幅信頼度（0..1）。自律走行速度の減速に使う。
// 1=信頼できる（等速）、低いほど「幅が不確か」→慎重に減速。
let curRoadConfidence = 1;

// Marker
let marker = null;

// 実寸フットプリント描画（車格連動）と木材外形
let vehicleFootprintLayer = null;
let cargoFootprintLayer = null;

// heading(北から時計回り) を基準に、前方 fwdM・右方 rightM オフセットした緯度経度を返す
function _offsetLatLng(lat, lng, headingDeg, fwdM, rightM) {
  const th = headingDeg * DEG2RAD;
  const eastM = fwdM * Math.sin(th) + rightM * Math.cos(th);
  const northM = fwdM * Math.cos(th) - rightM * Math.sin(th);
  return [
    lat + northM / 111320,
    lng + eastM / (111320 * Math.cos(lat * DEG2RAD))
  ];
}

// 現在の driveLat/lng/heading と車格から、実寸トラック＋木材を地図に描画
function _drawVehicleAndCargo(map) {
  if (!map) return;
  const st = store.getState();
  const fp = _currentFootprint();
  const width = fp.vehicleWidth;
  const halfW = fp.halfWidthM;
  const wb = fp.wheelBase;
  const fo = fp.frontOverhang;
  const ro = fp.rearOverhang;
  const front = wb + fo;   // リアアクスル基準の前端
  const rear = -ro;        // 後端

  const corners = [
    _offsetLatLng(driveLat, driveLng, heading, front, -halfW),
    _offsetLatLng(driveLat, driveLng, heading, front, halfW),
    _offsetLatLng(driveLat, driveLng, heading, rear, halfW),
    _offsetLatLng(driveLat, driveLng, heading, rear, -halfW)
  ];
  const color = isOffRoad ? '#ef4444' : '#22d3ee';
  if (!vehicleFootprintLayer) {
    vehicleFootprintLayer = L.polygon(corners, {
      color, weight: 2, opacity: 0.95, fillColor: color, fillOpacity: 0.16, interactive: false
    }).addTo(map);
  } else {
    vehicleFootprintLayer.setLatLngs(corners);
    vehicleFootprintLayer.setStyle({ color, fillColor: color });
  }

  // ── 木材外形 ──────────────────────────────────────────────
  const loadActive = st.cargoLoadType && st.cargoLoadType !== 'none';
  if (loadActive) {
    const cargoLenM = (Number(st.cargoLength) || 4000) / 1000;
    const cargoWM = Math.min(width, (Number(st.cargoWidthMm) || 1000) / 1000);
    const placement = st.cargoPlacement || 'center';
    const cHalf = cargoWM / 2;
    const maxOff = Math.max(0, halfW - cHalf);
    const bedRear = rear + 0.08;
    const bedFront = Math.max(bedRear + 0.9, front - 1.25);
    let rightCenter = 0;
    let forwardCenter = bedFront - cargoLenM / 2;
    let yawRad = 0;
    if (placement === 'left') rightCenter = -maxOff;
    else if (placement === 'right') rightCenter = maxOff;
    else if (placement === 'head_out') forwardCenter = bedRear + cargoLenM / 2;
    else if (placement === 'diagonal') {
      forwardCenter = (bedRear + bedFront) / 2;
      yawRad = 15 * Math.PI / 180;
    }
    const c = Math.cos(yawRad);
    const s = Math.sin(yawRad);
    const halfLen = cargoLenM / 2;
    const localCorners = [
      [-cHalf, halfLen],
      [cHalf, halfLen],
      [cHalf, -halfLen],
      [-cHalf, -halfLen]
    ].map(([x, z]) => ({
      right: rightCenter + x * c + z * s,
      forward: forwardCenter - x * s + z * c
    }));
    const cargoCorners = localCorners.map((p) => _offsetLatLng(driveLat, driveLng, heading, p.forward, p.right));
    const overhang = localCorners.some((p) => p.forward > front || p.forward < rear || Math.abs(p.right) > halfW);
    const woodColor = overhang ? '#f97316' : '#d97706';
    if (!cargoFootprintLayer) {
      cargoFootprintLayer = L.polygon(cargoCorners, {
        color: woodColor, weight: 2, opacity: 0.95,
        fillColor: '#b45309', fillOpacity: 0.45, dashArray: '4,3', interactive: false
      }).addTo(map);
    } else {
      cargoFootprintLayer.setLatLngs(cargoCorners);
      cargoFootprintLayer.setStyle({ color: woodColor });
    }
  } else if (cargoFootprintLayer) {
    try { map.removeLayer(cargoFootprintLayer); } catch {}
    cargoFootprintLayer = null;
  }
}

function _removeVehicleFootprint() {
  const map = getMapInstance();
  if (vehicleFootprintLayer) { if (map) try { map.removeLayer(vehicleFootprintLayer); } catch {} vehicleFootprintLayer = null; }
  if (cargoFootprintLayer) { if (map) try { map.removeLayer(cargoFootprintLayer); } catch {} cargoFootprintLayer = null; }
}

// Trail: multiple segments, each a { l: L.polyline, r: L.polyline }
// A new segment starts every time isOffRoad changes
let trailSegs   = [];   // all finished segments
let curPtsL     = [];   // accumulating left points for current segment
let curPtsR     = [];   // accumulating right points for current segment
let curOffRoad  = false;
let lastTrailPt = null;

let lastTs = null;

// ── Tron-style semi-transparent truck (top-down, north = up) ────────────────
function _truckSvg(accent, glow) {
  // 30×48 viewBox. Body = translucent rect, neon outline, nose bar, centre line, wheel slots.
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 48" width="30" height="48">
  <defs>
    <filter id="g${glow}" x="-40%" y="-40%" width="180%" height="180%">
      <feGaussianBlur stdDeviation="2" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  <!-- body fill -->
  <rect x="2" y="2" width="26" height="44" rx="2" fill="rgba(2,20,40,0.42)" stroke="${accent}" stroke-width="1.6" filter="url(#g${glow})"/>
  <!-- front nose bar -->
  <rect x="3" y="2" width="24" height="4" rx="1" fill="${accent}" opacity="0.9"/>
  <!-- cab divider line -->
  <line x1="2" y1="16" x2="28" y2="16" stroke="${accent}" stroke-width="1" opacity="0.6"/>
  <!-- centre axis line -->
  <line x1="15" y1="18" x2="15" y2="44" stroke="${accent}" stroke-width="0.7" opacity="0.35" stroke-dasharray="2,3"/>
  <!-- wheel slots -->
  <rect x="1" y="8"  width="3" height="7" rx="1" fill="${accent}" opacity="0.55"/>
  <rect x="26" y="8"  width="3" height="7" rx="1" fill="${accent}" opacity="0.55"/>
  <rect x="1" y="30" width="3" height="7" rx="1" fill="${accent}" opacity="0.55"/>
  <rect x="26" y="30" width="3" height="7" rx="1" fill="${accent}" opacity="0.55"/>
  <rect x="1" y="38" width="3" height="7" rx="1" fill="${accent}" opacity="0.55"/>
  <rect x="26" y="38" width="3" height="7" rx="1" fill="${accent}" opacity="0.55"/>
</svg>`;
}
const SVG_ON  = _truckSvg('#22d3ee', 'c');
const SVG_OFF = _truckSvg('#ff4444', 'r');

// ── Public API ───────────────────────────────────────────────────────────────

export function clearTrail() {
  const map = getMapInstance();
  for (const seg of trailSegs) {
    if (map) { try { map.removeLayer(seg.l); map.removeLayer(seg.r); } catch {} }
  }
  trailSegs   = [];
  curPtsL     = [];
  curPtsR     = [];
  curOffRoad  = false;
  lastTrailPt = null;
}

// ── Input ───────────────────────────────────────────────────────────────────

function _detectOffRoad() {
  const s = store.getState();
  const datasets = s.geoJsonDataSets;
  if (!datasets || datasets.length === 0) {
    isOffRoad = false;
    return;
  }

  const pt = turf.point([driveLng, driveLat]);
  const threshold = _currentFootprint().halfWidthM + 1.5; // metres: half-width + margin
  let minDist = Infinity;
  let nearestFeat = null;

  for (const feat of datasets) {
    if (!feat?.geometry) continue;
    try {
      const geom = feat.geometry;
      if (geom.type === 'LineString') {
        const d = turf.pointToLineDistance(pt, feat, { units: 'kilometers' }) * 1000;
        if (d < minDist) { minDist = d; nearestFeat = feat; if (minDist < threshold) break; }
      } else if (geom.type === 'MultiLineString') {
        for (const coords of geom.coordinates) {
          const d = turf.pointToLineDistance(pt, turf.lineString(coords), { units: 'kilometers' }) * 1000;
          if (d < minDist) { minDist = d; nearestFeat = feat; if (minDist < threshold) break; }
        }
        if (minDist < threshold) break;
      }
    } catch { /* skip malformed feature */ }
  }

  isOffRoad = minDist > threshold;

  // 通行リスクモデル: 走行中の道路の幅信頼度を更新（自律走行の減速判断に伝播）。
  if (nearestFeat) {
    try {
      const conf = fuseWidthForFeature(nearestFeat)?.confidence;
      curRoadConfidence = Number.isFinite(conf) ? conf : 1;
    } catch { curRoadConfidence = 1; }
  } else {
    curRoadConfidence = 1;
  }
}

// ── Trail segment management ─────────────────────────────────────────────────
function _appendTrail(map) {
  if (!map) return;

  // Flush existing segment if road-status changed
  if (isOffRoad !== curOffRoad && (curPtsL.length >= 2)) {
    _flushTrailSeg(map);
    curPtsL    = [];
    curPtsR    = [];
    lastTrailPt = null;
  }
  curOffRoad = isOffRoad;

  // Distance gate
  if (lastTrailPt) {
    const dlat = (driveLat - lastTrailPt[0]) * 111320;
    const dlng = (driveLng - lastTrailPt[1]) * 111320 * Math.cos(driveLat * DEG2RAD);
    if (Math.sqrt(dlat*dlat + dlng*dlng) < TRAIL_STEP_M) return;
  }
  lastTrailPt = [driveLat, driveLng];

  // Lateral offsets for truck width
  const perpRad = (heading + 90) * DEG2RAD;
  const halfW   = _currentFootprint().halfWidthM;
  const dLatM   = 1 / 111320;
  const dLngM   = 1 / (111320 * Math.cos(driveLat * DEG2RAD));
  const offLat  = Math.cos(perpRad) * halfW * dLatM;
  const offLng  = Math.sin(perpRad) * halfW * dLngM;

  curPtsL.push([driveLat + offLat, driveLng + offLng]);
  curPtsR.push([driveLat - offLat, driveLng - offLng]);

  if (curPtsL.length < 2) return;

  // Find or create current segment layers
  const last = trailSegs.at?.(-1);
  const color   = isOffRoad ? '#ef4444' : '#22d3ee';
  const opacity = isOffRoad ? 0.85 : 0.7;
  const style = { color, weight: 1.5, opacity, lineCap: 'round', lineJoin: 'round' };

  if (last && last.offRoad === isOffRoad && last.l) {
    last.l.setLatLngs(curPtsL);
    last.r.setLatLngs(curPtsR);
  } else {
    const seg = {
      offRoad: isOffRoad,
      l: L.polyline(curPtsL.slice(), style).addTo(map),
      r: L.polyline(curPtsR.slice(), style).addTo(map),
    };
    trailSegs.push(seg);
  }
}

function _flushTrailSeg(map) {
  // Finalise current points into the last segment (already added to map)
  // Nothing extra needed; polylines are updated in-place by _appendTrail
}

// ── Marker helpers ───────────────────────────────────────────────────────────
function _spawnMarker(map) {
  _removeMarker();
  const icon = L.divIcon({
    className:  'drive-truck-wrapper',
    html:       `<div class="drive-truck-icon" data-offroad="false">${SVG_ON}</div>`,
    iconSize:   [30, 48],
    iconAnchor: [15, 24],
  });
  marker = L.marker([driveLat, driveLng], {
    icon,
    zIndexOffset: 1000,
    interactive:  false,
    keyboard:     false,
  }).addTo(map);
}

function _removeMarker() {
  const map = getMapInstance();
  if (marker) { if (map) try { map.removeLayer(marker); } catch {} marker = null; }
}

// ── UI helpers ───────────────────────────────────────────────────────────────
function _setUi(on) {
  const hud = document.getElementById('driveHud');
  if (hud) { hud.hidden = !on; hud.classList.toggle('offroad', false); }
}

function _toast(msg) {
  const box = document.getElementById('toast');
  if (!box) return;
  const d = document.createElement('div');
  d.className = 'toast-item';
  d.textContent = msg;
  box.appendChild(d);
  setTimeout(() => d.remove(), 3000);
}

// ── Auto-follow route simulation ─────────────────────────────────────────────
let autoActive  = false;
let autoRafId   = null;
let autoRoute   = [];
let autoCum     = [];   // cumulative arc-lengths
let autoS       = 0;    // current arc-length position (metres)
let autoSpeedMS = 5;    // m/s
let autoAutonomyReport = null;
let simAcc      = 0;    // 固定dtアキュムレータ（未消化のフレーム時間）
let simTimeS    = 0;    // シミュレーション経過時間（物理・判定の唯一の時計）

export function isAutoFollowActive() { return autoActive; }

export function startAutoFollow(speedKmh = 18) {
  const map = getMapInstance();
  if (!map) { _toast('マップが未初期化'); return; }
  const rt = store.getState().simRoute;
  if (!rt || rt.length < 2) { _toast('先にルートを確定してください'); return; }

  if (autoActive) stopAutoFollow();

  autoActive  = true;
  autoSpeedMS = Math.max(1, Number(speedKmh) || 18) / 3.6;
  autoRoute   = rt;
  autoS       = 0;
  try {
    const st = store.getState();
    autoAutonomyReport = buildAutonomyDriveReport({
      route: rt,
      roads: st.geoJsonDataSets || [],
      buildings: st.buildingsGeoJSON || [],
      maskEdits: st.maskEdits || {},
      vehicleConfig: st.vehicleConfig || {},
      cargoLoadType: st.cargoLoadType,
      cargoCount: st.cargoCount,
      cruiseSpeedKmh: Number(speedKmh) || 18
    });
  } catch (e) {
    autoAutonomyReport = null;
    console.warn('[truckDrive] autonomy auto-follow report failed:', e?.message || e);
  }

  // Cumulative arc-lengths（決定論コアと同一実装を共有）
  autoCum = buildCumulative(autoRoute);

  driveLat  = autoRoute[0].lat;
  driveLng  = autoRoute[0].lng;
  heading   = coreBearing(autoRoute[0], autoRoute[Math.min(1, autoRoute.length - 1)]);
  isOffRoad = false;
  lastOffRoadSimT = -1;
  simAcc    = 0;
  simTimeS  = 0;
  lastTs    = null;

  clearTrail();
  _spawnMarker(map);
  map.setView([driveLat, driveLng], Math.max(map.getZoom(), 17), { animate: false });
  document.addEventListener('keydown', _onAutoKey);
  autoRafId = requestAnimationFrame(_autoLoop);
  _setAutoUi(true);
  _toast('🚛 自動走行開始 — ESC で停止');
}

export function stopAutoFollow() {
  if (!autoActive) return;
  autoActive = false;
  autoAutonomyReport = null;
  if (autoRafId) { cancelAnimationFrame(autoRafId); autoRafId = null; }
  document.removeEventListener('keydown', _onAutoKey);
  _flushTrailSeg(getMapInstance());
  _removeMarker();
  _removeVehicleFootprint();
  _setAutoUi(false);
}

function _onAutoKey(e) {
  if (e.key === 'Escape') stopAutoFollow();
}

// 幾何は決定論コア(autoFollowCore.js)と共有。ここでの再実装は禁止
//（ブラウザとヘッドレス検証で数学が食い違うと再現性が壊れるため）。
function _sampleRouteAt(s) {
  return sampleRouteAt(autoRoute, autoCum, s);
}

function _sampleAutoAutonomyAt(sM) {
  const samples = autoAutonomyReport?.samples || [];
  if (!samples.length) return null;
  let lo = 0;
  let hi = samples.length - 1;
  const s = Number(sM) || 0;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if ((Number(samples[mid].sM) || 0) <= s) lo = mid;
    else hi = mid;
  }
  const a = samples[lo];
  const b = samples[hi];
  if (!b) return a;
  return Math.abs((Number(a.sM) || 0) - s) <= Math.abs((Number(b.sM) || 0) - s) ? a : b;
}

function _autoAllowedSpeedMS(nominalMS, sM) {
  const sample = _sampleAutoAutonomyAt(sM);
  if (!sample) return nominalMS * autonomousSpeedFactor(curRoadConfidence);
  if (sample.mode === 'STOP') return 0;
  const allowed = Number(sample.allowedSpeedMS);
  return Number.isFinite(allowed) ? Math.max(0, Math.min(nominalMS, allowed)) : nominalMS;
}

function _autoLoop(ts) {
  if (!autoActive) return;
  // 描画フレームの経過時間はアキュムレータに貯めるだけ。物理は SIM_DT_S 固定で進める
  //（フレームレート非依存＝同一入力なら常に同一軌跡。run_sim_repro.js で検証）。
  const frameDt = lastTs !== null ? Math.min((ts - lastTs) / 1000, 0.25) : 0;
  lastTs = ts;
  simAcc += frameDt;

  const total = autoCum[autoCum.length - 1];
  let effSpeedMS = speed;
  while (simAcc >= SIM_DT_S && autoS < total) {
    simAcc -= SIM_DT_S;
    simTimeS += SIM_DT_S;
    // 道路検出もシミュ時間基準（壁時計だと実行ごとに判定タイミングが変わる）
    if (simTimeS - lastOffRoadSimT >= OFF_ROAD_CHECK_S) {
      lastOffRoadSimT = simTimeS;
      const p = _sampleRouteAt(autoS);
      driveLat = p.lat;
      driveLng = p.lng;
      _detectOffRoad();
    }
    // 通行リスクモデル: 最寄り道路の幅信頼度に応じて自律走行速度を落とす（不確かなら慎重に）。
    effSpeedMS = _autoAllowedSpeedMS(autoSpeedMS, autoS);
    autoS = Math.min(autoS + effSpeedMS * SIM_DT_S, total);
  }

  const cur   = _sampleRouteAt(autoS);
  const ahead = _sampleRouteAt(Math.min(autoS + 4, total));
  driveLat = cur.lat;
  driveLng = cur.lng;
  heading  = coreBearing(cur, ahead);
  speed    = effSpeedMS;

  const map = getMapInstance();

  _appendTrail(map);

  if (marker && map) {
    marker.setLatLng([driveLat, driveLng]);
    const iconDiv = marker.getElement()?.querySelector('.drive-truck-icon');
    if (iconDiv) {
      if (iconDiv.dataset.offroad !== String(isOffRoad)) {
        iconDiv.innerHTML = isOffRoad ? SVG_OFF : SVG_ON;
        iconDiv.dataset.offroad = String(isOffRoad);
        iconDiv.classList.toggle('offroad', isOffRoad);
      }
      iconDiv.style.transform = `rotate(${heading}deg)`;
    }
    _drawVehicleAndCargo(map);
    map.panTo([driveLat, driveLng], { animate: true, duration: 0.1, easeLinearity: 1 });
  }

  // HUD（実走行速度＝リスクモデルで減速後の値を表示）
  const kmh = (effSpeedMS * 3.6).toFixed(0);
  const el_s = document.getElementById('driveSpeedVal');
  const el_h = document.getElementById('driveHeadingVal');
  const el_g = document.getElementById('driveGearVal');
  if (el_s) el_s.textContent = kmh;
  if (el_h) el_h.textContent = `${heading.toFixed(0)}°`;
  if (el_g) el_g.textContent = 'A';
  const alertEl = document.getElementById('driveOffRoadAlert');
  const hud = document.getElementById('driveHud');
  if (alertEl) alertEl.hidden = !isOffRoad;
  if (hud) hud.classList.toggle('offroad', isOffRoad);

  if (autoS >= total) {
    _toast('🏁 ゴール到着');
    stopAutoFollow();
    return;
  }
  autoRafId = requestAnimationFrame(_autoLoop);
}

function _setAutoUi(on) {
  document.getElementById('autoFollowBtn')?.classList.toggle('active', on);
  const hud = document.getElementById('driveHud');
  if (hud) { hud.hidden = !on; hud.classList.toggle('offroad', false); }
}
