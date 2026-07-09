import { store } from '../state.js';
import { ZIPS_CONFIG, RUNTIME_CONFIG, buildVehicleConfig, getRouteTrackingTurnRadius, GOOGLE_3D_TILES_KEY, yoloAuthHeaders } from '../config.js';
import { geocodeSearch } from '../api/nominatim.js';
import { fetchOsrmRoute, fetchOsrmRoutes } from '../api/osrm.js';
import { addressToBluemap, bluemapToAddress } from '../api/zips.js';
import { loadRoadsForView, loadRoadsWideArea, setManualAddMode, setObstacleAddMode, setObstaclePolygonDrawMode, setObstacleDefaults, focusTo as focusTo2D, getMapInstance } from './map2d.js';
function focusTo(lat, lng, zoom = 17) {
  focusTo2D(lat, lng, zoom);
  try { if (window.__focusTo3D__) window.__focusTo3D__(lat, lng, zoom); } catch (e) { }
}
import { fullRoadRoute, pruneTinyLoops, removeRouteHooks, densifyRouteLL, parseMetersFromTag, smoothPath, removeSelfIntersectingLoops, removeProximityLoops, applyTurnTemplates } from '../core/graph.js';
import { coordinateSystem, d2r, safeDifference, safeUnion, turf } from '../utils/geo.js';
import { fetchWithTimeout } from '../utils/fetchTimeout.js';
import { generateSweepPolygon, analyzeContactFeasibility, analyzeFeasibility, buildRoadUnion, verifySatelliteOverflow, estimateWidthForFeature, buildWidthFusionValidationReport } from '../core/feasibility.js';
import { showSweep, showTrajectory, showFeasibilityLayers, showRegulationIssues, clearSweepLayers, clearFeasibilityLayers, showRoadWidths, clearRoadWidthLayer, clearRegulationLayer, focusToRoute, focusToGoalArea, wipeAllLayers, findNearestRoadCoord } from './map2d.js';
import { simulatePathPoses } from '../core/physics.js';
import { buildOverridesExportDoc, parseOverridesImportDoc } from '../utils/widthOverrides.js';
import { getCurrentTheme, toggleTheme, THEME_CHANGE_EVENT } from './theme.js';
import { initDeliveryPanel, renderDeliveryResult, setDeliveryProgress, exportDeliveryReport, clearDeliveryPanel } from './deliveryPanel.js';
import { MSG } from './messages.js';
import { runDeliveryAssessment } from '../core/deliveryAssessment.js';
import { buildOsmRegulationLayer } from '../core/osmRegulationAdapter.js';
import { mergeRegulationLayers, getActiveExternalRegulations } from '../core/jarticRegulationAdapter.js';
import { assessRegulationsForRoute, regulationScorePenalty } from '../core/regulationModel.js';
import { buildAutonomyDriveReport } from '../sim/autonomy/behaviorPlanner.js';
import { clearTrail, startAutoFollow, stopAutoFollow, isAutoFollowActive } from './truckDrive.js';
import { scanStreetView, analyzeStreetView, applyDetectionsToWidths } from './streetviewScan.js';
import { buildTrajectoryPlanFromSelection } from '../core/trajectoryPlanner.js';
import { fetchPlateauBuildings, mergeFeaturesById } from '../api/plateau.js';
import { html, unsafeHtml } from '../utils/html.js';
import {
  clearBuildings3D,
  clearObstacles3D,
  clearRoadSurface3D,
  fitRoute3D,
  getBuildings3DStats,
  play3D,
  resizeMap3D,
  setBuildingsRenderMode,
  setBuildingsAllGeoJSON,
  setCorridorRoads3D,
  setObstaclesGeoJSON,
  setRoadSurface3D,
  setRoads3D,
  setRoute3D,
  stop3D,
  updateBuildingsForRoute
} from './map3dTiles.js';
import {
  shortPresetKey as buildWorkflowShortPresetKey,
  renderRouteFlowButtons as renderRouteFlowButtonsView,
  renderWorkflowDock as renderWorkflowDockView,
  runWorkflowNextAction as runWorkflowNextActionView
} from './workflowController.js';
// 3D連携が無効な画面でも呼び出しが壊れないようにする。
const GBA_3D_REMOVED = false;

let ignoreRoadNetwork = false;
let searchMarker = null;

// Multi-vehicle sweep: stores sweep polygons keyed by preset name after assessment
let multiVehicleSweeps = {}; // { presetName: { sweepGeo, outline } }
let multiAssessmentResults = {}; // { presetName: deliveryAssessmentResult }
const sweepCache = {};        // { `${preset}_${skill}`: { sweepGeo, outline } } を技能別にキャッシュする
let _sweepCacheRouteKey = ''; // 経路変更時にキャッシュを無効化する
let vehicleSwitchToken = 0;
let lastWideRoadLoadSig = "";
let lastWideRoadLoadAt = 0;
const AUTO_ROUTE_REBUILD_DELAY_MS = 250;
let autoRouteRebuildTimer = null;
let autoRouteRebuildInFlight = false;
let lastAutoRouteEndpointHash = '';
let lastConfirmedRouteHash = '';
let lastPreRouteYoloWidthSig = '';
const ROUTE_ADJUSTMENT_MAX_ITERATIONS = 0;
const WIDTH_AI_KEYS = ['width_ai', 'width:ai', 'ai_width', 'roadwidth_ai'];
const SATELLITE_YOLO_CLASS_WIDTHS_M = Object.freeze({
  2: 1.8, // car
  3: 0.8, // motorcycle
  5: 2.5, // bus
  7: 2.5  // truck
});
const SATELLITE_YOLO_WIDTH_OPTIONS = Object.freeze({
  confMin: 0.28,
  minWidth: 3.5,
  maxWidth: 10.0,
  edgeMarginM: 0.35,
  baseAlongWindowM: 10.0,
  maxNormalOffsetM: 8.5,
  priorNormalSlackM: 2.2,
  priorMinScale: 0.82,
  priorMaxScale: 1.16,
  priorMaxGrowM: 1.2,
  rawWeightFew: 0.28,
  rawWeightMany: 0.42,
  nearestRoadMaxDistM: 12
});

function clearMultiVehicleCaches() {
  multiVehicleSweeps = {};
  multiAssessmentResults = {};
  Object.keys(sweepCache).forEach((k) => delete sweepCache[k]);
  _sweepCacheRouteKey = '';
  hideVehicleSweepTabs();
  // Clear fleet scanner board UI
  const container = document.getElementById('fleetMatrixContainer');
  if (container) {
    container.innerHTML = '<div style="grid-column: 1 / -1; font-size: 11px; color: #64748b; font-style: italic; text-align: center; padding: 10px 0;">判定を実行すると、全車両の合否一覧が表示されます</div>';
  }
}

function updateFleetAssessmentUI() {
  const container = document.getElementById('fleetMatrixContainer');
  if (!container) return;

  const presets = ['2t_flat', '3t_flat', '4t_flat', '10t_unic', 'trailer_15t'];
  const labels = {
    '2t_flat': { name: '2t平', spec: 'W1.7m/L5.6m' },
    '2t_unic': { name: '2tユニック', spec: 'W1.7m/L5.6m' },
    '3t_flat': { name: '3t平', spec: 'W2.1m/L7.4m' },
    '3t_unic': { name: '3tユニック', spec: 'W2.1m/L7.4m' },
    '4t_flat': { name: '4t平', spec: 'W2.3m/L9.6m' },
    '4t_unic': { name: '4tユニック', spec: 'W2.3m/L9.6m' },
    '10t_unic': { name: '10tユニック', spec: 'W2.5m/L14.4m' },
    'trailer_15t': { name: 'トレーラー', spec: 'W2.5m/L14.4m' }
  };

  container.innerHTML = '';
  
  const state = store.getState();
  const currentPreset = state.vehiclePresetName || '4t_flat';

  presets.forEach(preset => {
    const result = multiAssessmentResults[preset];
    const specInfo = labels[preset] || { name: preset, spec: '' };
    
    // Update dots on sweep navigation tabs dynamically
    const tabBtn = document.querySelector(`.vst-btn[data-preset="${preset}"]`);
    if (tabBtn) {
      tabBtn.classList.remove('pass', 'conditional', 'ng');
      if (result) {
        const statusClass = (result.overallStatus || '').toLowerCase();
        if (statusClass === 'pass') tabBtn.classList.add('pass');
        else if (statusClass === 'conditional') tabBtn.classList.add('conditional');
        else if (statusClass === 'ng') tabBtn.classList.add('ng');
      }
    }

    const card = document.createElement('div');
    card.className = 'fleet-card';
    if (preset === currentPreset) {
      card.classList.add('active');
    }

    if (result) {
      const score = Math.floor(result.score || 0);
      const status = result.overallStatus || 'N/A';
      const statusClass = status.toLowerCase();
      
      // XSS対策: specInfo は VEHICLE_PRESETS 静的データ由来だが防御的にエスケープ。
      card.innerHTML = html`
        <div class="fleet-card-title">${specInfo.name}</div>
        <div class="fleet-card-score">${score}点</div>
        <span class="fleet-card-status ${statusClass}">${status}</span>
        <div class="fleet-card-desc" style="margin-top: 5px; opacity: 0.7;">${specInfo.spec}</div>
      `;
      
      card.addEventListener('click', () => {
        document.querySelectorAll('.fleet-card').forEach(c => c.classList.remove('active'));
        card.classList.add('active');
        
        store.setVehiclePresetName(preset);
        applyPresetResult(preset);
        
        // Sync with top bar cards
        const shortKey = VEHICLE_PRESET_FULL_TO_SHORT[preset] || preset;
        document.querySelectorAll('#vehCardRow .veh-card').forEach(btn => {
          btn.classList.toggle('active', btn.dataset.veh === shortKey);
        });
      });
    } else {
      card.innerHTML = html`
        <div class="fleet-card-title">${specInfo.name}</div>
        <div class="fleet-card-score" style="font-size:12px; margin: 10px 0; color: #475569;">解析中…</div>
        <span class="fleet-card-status" style="color: #64748b; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.06);">PENDING</span>
        <div class="fleet-card-desc" style="margin-top: 5px; opacity: 0.5;">${specInfo.spec}</div>
      `;
      card.style.opacity = '0.55';
    }

    container.appendChild(card);
  });
}

async function generateAllVehicleSweeps(simRoute, driverSkill) {
  if (!simRoute || simRoute.length < 2) return;
  
  // Build initial board skeleton showing "PENDING"
  updateFleetAssessmentUI();
  
  for (const preset of ALL_ASSESSMENT_PRESETS) {
    if (multiVehicleSweeps[preset] && multiAssessmentResults[preset]) {
      updateFleetAssessmentUI();
      continue;
    }
    try {
      await runSingleVehicleAssessment(preset);
      // Stream updates progressively
      updateFleetAssessmentUI();
    } catch (e) {
      console.warn(`generateAllVehicleSweeps: ${preset} failed:`, e.message);
    }
  }
}

function applyPresetResult(preset) {
  const sweepData = multiVehicleSweeps[preset];
  const result = multiAssessmentResults[preset];

  clearSweepLayers();
  clearFeasibilityLayers();
  clearRegulationLayer();

  if (sweepData?.sweepGeo) {
    showSweep(sweepData.sweepGeo);
    const overflowGeo = result?.feasibility?.overflow || null;
    showTrajectory(sweepData.trajectoriesGeo || null, overflowGeo);
  }

  if (result) {
    renderDeliveryResult(result);
    showRegulationIssues(result.regulationAssessment);
    const resultPanel = document.getElementById('resultPanel');
    if (resultPanel) resultPanel.style.display = 'flex';
    updateHudFromAssessment(result);

    const feas = result?.feasibility;
    if (feas) {
      showFeasibilityLayers({
        roadUnion: feas.roadUnion || null,
        intersect: feas.intersect || null,
        overflow: feas.overflow || null,
        contactPoints: result?.collisionReport?.contactPoints || result?.contactFeasibility?.contactPoints || null
      });
    }
  }
}

// All standard presets to generate sweeps for
const ALL_ASSESSMENT_PRESETS = ['2t_flat', '3t_flat', '4t_flat', '10t_unic', 'trailer_15t'];

const VEHICLE_PRESET_SHORT_TO_FULL = {
  '2t': '2t_flat',
  '3t': '3t_flat',
  '4t': '4t_flat',
  '10t': '10t_unic'
};
const VEHICLE_PRESET_FULL_TO_SHORT = {
  '2t_flat': '2t',
  '2t_unic': '2t',
  '3t_flat': '3t',
  '3t_unic': '3t',
  '4t_flat': '4t',
  '4t_unic': '4t',
  '10t_unic': '10t'
};

function toFullVehiclePresetKey(raw) {
  if (!raw || raw === 'custom') return null;
  return VEHICLE_PRESET_SHORT_TO_FULL[raw] || raw;
}

function syncSelectValue(select, preferred, fallback) {
  if (!select) return;
  const hasPreferred = Array.from(select.options || []).some((opt) => opt.value === preferred);
  const hasFallback = Array.from(select.options || []).some((opt) => opt.value === fallback);
  const next = hasPreferred ? preferred : (hasFallback ? fallback : null);
  if (next && select.value !== next) select.value = next;
}

async function handleVehiclePresetChange(rawValue, sourceLabel = '車両変更') {
  const key = toFullVehiclePresetKey(rawValue);
  if (!key) return;

  const token = ++vehicleSwitchToken;
  store.applyVehiclePreset(key);

  let routeUpdated = false;
  const sAfterPreset = store.getState();
  // Keep the currently confirmed route on vehicle change.
  // Recompute only when there is no route yet.
  if ((!sAfterPreset.simRoute || sAfterPreset.simRoute.length < 2) && sAfterPreset.selectedEndpoints?.length >= 2) {
    try {
      const recomputed = await computeRouteFromEndpoints(sAfterPreset, { silent: true, prefer: 'hybrid' });
      if (token !== vehicleSwitchToken) return;
      if (applyRoutePlan(recomputed)) {
        routeUpdated = true;
      }
    } catch (e) {
      console.warn('[vehicle-change] route recompute failed', e);
    }
  }

  if (routeUpdated) {
    lastConfirmedRouteHash = '';
    clearMultiVehicleCaches();
  }

  let result = null;
  const sForAssess = store.getState();
  if (sForAssess.simRoute?.length >= 2 && routeConfirmed(sForAssess)) {
    try {
      result = await runSingleVehicleAssessment(key);
    } catch (e) {
      console.warn('[vehicle-change] assessment failed', e);
    }
  }
  if (token !== vehicleSwitchToken) return;

  if (result) {
    store.setDeliveryAssessment(result);
    applyPresetResult(key);
    showVehicleSweepTabs(key);
    toast(`${sourceLabel}: ${key} で再判定しました`);
    return;
  }

  if (multiAssessmentResults[key] || multiVehicleSweeps[key]) {
    applyPresetResult(key);
    showVehicleSweepTabs(key);
    toast(`${sourceLabel}: ${key} の結果を表示しました`);
    return;
  }

  if (routeUpdated) {
    toast(`${sourceLabel}: ${key} に変更し経路を再計算しました`);
  } else {
    toast(`${sourceLabel}: ${key} に変更しました`);
  }
}

function toast(msg) {
  const box = document.getElementById('toast');
  if (!box) return;
  const div = document.createElement('div');
  div.className = 'toast-item';
  div.textContent = msg;
  box.appendChild(div);
  setTimeout(() => div.remove(), 2000);
}

function disable3DUI() {
  if (!GBA_3D_REMOVED) return;
  const removeIds = ['map3dWrap'];
  const hideIds = [
    'open3D',
    'close3D',
    'play3D',
    'pause3D',
    'loadGbaUrl',
    'autoGbaWfs',
    'loadGbaFileBtn',
    'gbaFile',
    'clearGbaBuildings',
    'corridorMeters',
    'toggleBuildingsWireframe',
    'toggleGbaAutoLoad'
  ];
  removeIds.forEach((id) => {
    const el = document.getElementById(id);
    if (el?.remove) el.remove();
  });
  hideIds.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
}

function routeHash(route = []) {
  if (!Array.isArray(route) || route.length < 2) return '';
  return route
    .map((p) => `${Number(p.lat).toFixed(6)},${Number(p.lng).toFixed(6)}`)
    .join('|');
}

function endpointHash(endpoints = []) {
  if (!Array.isArray(endpoints) || endpoints.length < 2) return '';
  return endpoints
    .map((p) => `${Number(p.lat).toFixed(6)},${Number(p.lng).toFixed(6)}`)
    .join('|');
}

function routeCandidateKind(label, candidate = {}) {
  const source = String(label || '').toLowerCase();
  if (source === 'direct') return 'provisional';
  if (source === 'permit-shortest' || source === 'permit-fallback') return 'permit';
  if (source.includes('relaxed') || source.includes('fallback')) return 'avoidance';
  if (Number(candidate.lenRatio) > 1.12) return 'avoidance';
  if (Number(candidate.deviationMeters) > 3.0) return 'avoidance';
  return 'standard';
}

function routeCandidateName(label, kind) {
  const source = String(label || 'route');
  if (kind === 'permit') return '許可モード最短経路';
  if (kind === 'avoidance') return `回避経路 (${source})`;
  if (kind === 'provisional') return `仮経路 (${source})`;
  if (source === 'osrm') return '標準経路 (OSRM)';
  if (source === 'graph-strict') return '標準経路 (道路グラフ)';
  return `標準経路 (${source})`;
}

function routeRegulationLabel(status) {
  switch (status) {
    case 'pass': return '規制OK';
    case 'warning': return '規制注意';
    case 'permit_required': return '要許可';
    case 'blocked': return '規制不可';
    case 'unknown': return '規制要確認';
    default: return '規制未評価';
  }
}

function routeCandidateSummary(candidate, index, selectedHash = '') {
  const route = (candidate?.route || []).map((p) => ({ lat: p.lat, lng: p.lng }));
  const hash = routeHash(route);
  const kind = routeCandidateKind(candidate?.label, candidate);
  return {
    id: `${candidate?.label || 'route'}-${index + 1}-${stableHash32([hash])}`,
    rank: index + 1,
    label: candidate?.label || 'route',
    kind,
    displayName: routeCandidateName(candidate?.label, kind),
    selected: !!selectedHash && hash === selectedHash,
    score: candidate?.score,
    finalScore: Number.isFinite(Number(candidate?.finalScore)) ? Number(candidate.finalScore) : candidate?.score,
    lengthMeters: candidate?.lengthMeters,
    lenRatio: candidate?.lenRatio,
    contactRatio: candidate?.contactRatio,
    contactCount: candidate?.contactCount,
    tightestRadius: candidate?.tightestRadius,
    deviationMeters: candidate?.deviationMeters,
    autonomyRiskScore: candidate?.autonomyRiskScore,
    autonomyStatus: candidate?.autonomyStatus,
    autonomyStopEventCount: candidate?.autonomyStopEventCount,
    autonomySlowEventCount: candidate?.autonomySlowEventCount,
    autonomySteeringSaturationRatio: candidate?.autonomySteeringSaturationRatio,
    autonomyMinAllowedSpeedKmh: candidate?.autonomyMinAllowedSpeedKmh,
    autonomyMaxTurnRadiusDeficitM: candidate?.autonomyMaxTurnRadiusDeficitM,
    regulationRiskScore: candidate?.regulationRiskScore,
    regulationStatus: candidate?.regulationStatus,
    regulationBlockCount: candidate?.regulationBlockCount,
    regulationPermitRequiredCount: candidate?.regulationPermitRequiredCount,
    regulationWarningCount: candidate?.regulationWarningCount,
    regulationIssueCount: candidate?.regulationIssueCount,
    route,
    selectionRoute: (candidate?.selectionRoute || route).map((p) => ({ lat: p.lat, lng: p.lng }))
  };
}

function mergeRoutePlansAndPickBest(plans = []) {
  const seen = new Set();
  const merged = [];
  for (const plan of plans) {
    const candidates = Array.isArray(plan?.candidates) && plan.candidates.length
      ? plan.candidates
      : (plan?.trajectoryRoute?.length >= 2 ? [{
        label: plan.routeMeta?.label || 'route',
        kind: plan.routeMeta?.kind || 'standard',
        displayName: plan.routeMeta?.displayName || '経路',
        score: plan.routeMeta?.score,
        finalScore: plan.routeMeta?.finalScore,
        lengthMeters: plan.routeMeta?.lengthMeters,
        lenRatio: plan.routeMeta?.lenRatio,
        contactRatio: plan.routeMeta?.contactRatio,
        contactCount: plan.routeMeta?.contactCount,
        tightestRadius: plan.routeMeta?.tightestRadius,
        autonomyRiskScore: plan.routeMeta?.autonomyRiskScore,
        autonomyStatus: plan.routeMeta?.autonomyStatus,
        autonomyStopEventCount: plan.routeMeta?.autonomyStopEventCount,
        autonomySlowEventCount: plan.routeMeta?.autonomySlowEventCount,
        autonomySteeringSaturationRatio: plan.routeMeta?.autonomySteeringSaturationRatio,
        autonomyMinAllowedSpeedKmh: plan.routeMeta?.autonomyMinAllowedSpeedKmh,
        autonomyMaxTurnRadiusDeficitM: plan.routeMeta?.autonomyMaxTurnRadiusDeficitM,
        regulationRiskScore: plan.routeMeta?.regulationRiskScore,
        regulationStatus: plan.routeMeta?.regulationStatus,
        regulationBlockCount: plan.routeMeta?.regulationBlockCount,
        regulationPermitRequiredCount: plan.routeMeta?.regulationPermitRequiredCount,
        regulationWarningCount: plan.routeMeta?.regulationWarningCount,
        regulationIssueCount: plan.routeMeta?.regulationIssueCount,
        route: plan.trajectoryRoute,
        selectionRoute: plan.selectionRoute
      }] : []);
    for (const c of candidates) {
      if (!Array.isArray(c?.route) || c.route.length < 2) continue;
      const hash = routeHash(c.route);
      if (!hash || seen.has(hash)) continue;
      seen.add(hash);
      merged.push({ ...c, routeHash: hash });
    }
  }
  if (!merged.length) return null;
  const minLengthMeters = Math.max(
    1,
    Math.min(...merged.map((c) => (Number.isFinite(Number(c.lengthMeters)) && Number(c.lengthMeters) > 0 ? Number(c.lengthMeters) : Infinity)))
  );
  const ranked = merged
    .map((c) => ({
      ...c,
      score: Number.isFinite(Number(c.score)) ? Number(c.score) : Infinity,
      finalScore: Number.isFinite(Number(c.finalScore)) ? Number(c.finalScore) : (Number.isFinite(Number(c.score)) ? Number(c.score) : Infinity),
      contactRatio: Number.isFinite(Number(c.contactRatio)) ? Number(c.contactRatio) : 0.5,
      lenRatio: Number.isFinite(Number(c.lengthMeters)) && Number(c.lengthMeters) > 0
        ? Number(c.lengthMeters) / minLengthMeters
        : (Number.isFinite(Number(c.lenRatio)) ? Number(c.lenRatio) : 1)
    }))
    .map((c) => {
      const kind = routeCandidateKind(c.label, c);
      return {
        ...c,
        kind,
        displayName: routeCandidateName(c.label, kind)
      };
    })
    .sort((a, b) => {
      if (a.finalScore !== b.finalScore) return a.finalScore - b.finalScore;
      if (a.contactRatio !== b.contactRatio) return a.contactRatio - b.contactRatio;
      return a.lenRatio - b.lenRatio;
    });
  const bestHash = routeHash(ranked[0].route);
  const candidates = ranked.slice(0, 6).map((c, i) => ({
    ...c,
    id: c.id || `${c.label || 'route'}-${i + 1}-${stableHash32([routeHash(c.route)])}`,
    rank: i + 1,
    selected: routeHash(c.route) === bestHash
  }));
  const best = candidates[0];
  return {
    selectionRoute: (best.selectionRoute?.length >= 2 ? best.selectionRoute : best.route).map((p) => ({ ...p })),
    trajectoryRoute: best.route.map((p) => ({ ...p })),
    candidates,
    routeMeta: {
      label: best.label,
      kind: best.kind,
      displayName: best.displayName,
      score: best.score,
      finalScore: best.finalScore,
      lengthMeters: best.lengthMeters,
      lenRatio: best.lenRatio,
      contactRatio: best.contactRatio,
      contactCount: best.contactCount,
      tightestRadius: best.tightestRadius,
      autonomyRiskScore: best.autonomyRiskScore,
      autonomyStatus: best.autonomyStatus,
      autonomyStopEventCount: best.autonomyStopEventCount,
      autonomySlowEventCount: best.autonomySlowEventCount,
      autonomySteeringSaturationRatio: best.autonomySteeringSaturationRatio,
      autonomyMinAllowedSpeedKmh: best.autonomyMinAllowedSpeedKmh,
      autonomyMaxTurnRadiusDeficitM: best.autonomyMaxTurnRadiusDeficitM,
      regulationRiskScore: best.regulationRiskScore,
      regulationStatus: best.regulationStatus,
      regulationBlockCount: best.regulationBlockCount,
      regulationPermitRequiredCount: best.regulationPermitRequiredCount,
      regulationWarningCount: best.regulationWarningCount,
      regulationIssueCount: best.regulationIssueCount,
      selectedRank: best.rank,
      candidateCount: candidates.length
    }
  };
}

function confirmedRouteSignature(state = store.getState()) {
  const selectedHash = routeHash((state.selectedRoadRoute?.length || 0) >= 2 ? state.selectedRoadRoute : []);
  const trajectoryHash = routeHash(state.simRoute || []);
  if (!trajectoryHash) return '';
  return `${selectedHash || 'no-selection'}::${trajectoryHash}`;
}

function stabilizeRoutePoints(routeLL) {
  if (!Array.isArray(routeLL) || routeLL.length < 2) return routeLL;
  try {
    // スパース段階でループ除去（密化前にやることでO(n²)を小さく保つ）
    const loopFree = removeSelfIntersectingLoops(routeLL);         // 幾何学的交差ループ
    const proxFree = removeProximityLoops(loopFree?.length >= 2 ? loopFree : routeLL); // 近接U字迂回
    const denseA = densifyRouteLL(proxFree?.length >= 2 ? proxFree : routeLL, 1.0);
    const smooth = smoothPath(denseA, 7);
    const cleaned = pruneTinyLoops(smooth, 1.2, 155);
    const hooksRemoved = removeRouteHooks(cleaned?.length >= 2 ? cleaned : denseA, 80);
    const denseB = densifyRouteLL(hooksRemoved?.length >= 2 ? hooksRemoved : denseA, 1.0);
    return denseB?.length >= 2 ? denseB : routeLL;
  } catch (e) {
    return routeLL;
  }
}

function routeConfirmed(state = store.getState()) {
  const hash = confirmedRouteSignature(state);
  if (!hash || !lastConfirmedRouteHash) return false;
  return hash === lastConfirmedRouteHash;
}

function applyRoutePlan(plan) {
  const trajectoryRoute = Array.isArray(plan?.trajectoryRoute)
    ? plan.trajectoryRoute
    : (Array.isArray(plan) ? plan : null);
  if (!trajectoryRoute || trajectoryRoute.length < 2) return false;
  const selectionRoute = (Array.isArray(plan?.selectionRoute) && plan.selectionRoute.length >= 2)
    ? plan.selectionRoute
    : trajectoryRoute;
  store.setRoutePlan({
    selectionRoute,
    trajectoryRoute,
    candidates: Array.isArray(plan?.candidates) ? plan.candidates : [],
    routeMeta: plan?.routeMeta || null
  });
  // 自動生成された経路も「確定済み」として扱う。
  // これがないと auto-route で経路が引かれていても onRun が routeConfirmed=false で弾く。
  lastConfirmedRouteHash = confirmedRouteSignature(store.getState());
  return true;
}

function buildDirectEndpointPlan(endpoints = []) {
  const route = Array.isArray(endpoints)
    ? endpoints
      .filter((p) => Number.isFinite(Number(p?.lat)) && Number.isFinite(Number(p?.lng)))
      .map((p) => ({ lat: Number(p.lat), lng: Number(p.lng) }))
    : [];
  if (route.length < 2) return null;
  return {
    selectionRoute: route,
    trajectoryRoute: route,
    candidates: [{
      id: `direct-1-${stableHash32([routeHash(route)])}`,
      rank: 1,
      label: 'direct',
      kind: 'provisional',
      displayName: '仮経路 (直線)',
      selected: true,
      route,
      selectionRoute: route
    }],
    routeMeta: {
      label: 'direct',
      kind: 'provisional',
      displayName: '仮経路 (直線)',
      selectedRank: 1,
      candidateCount: 1
    }
  };
}

function buildShortestOsrmPlan(routeResult, stateForEvaluation = null) {
  const route = (routeResult?.coordinates || [])
    .filter((p) => Number.isFinite(Number(p?.lat)) && Number.isFinite(Number(p?.lng)))
    .map((p) => ({ lat: Number(p.lat), lng: Number(p.lng) }));
  if (route.length < 2) return null;
  const distance = Number.isFinite(Number(routeResult?.distance))
    ? Number(routeResult.distance)
    : routeLengthMeters(route);
  let evaluated = null;
  if (stateForEvaluation) {
    try {
      evaluated = evaluateRouteCandidate(route, stateForEvaluation, { label: 'osrm-shortest' });
    } catch (e) {
      console.warn('[route] osrm-shortest evaluation skipped', e);
    }
  }
  if (evaluated?.route?.length >= 2) {
    const summary = routeCandidateSummary(evaluated, 0, routeHash(evaluated.route));
    summary.selected = true;
    return {
      selectionRoute: (evaluated.selectionRoute?.length >= 2 ? evaluated.selectionRoute : evaluated.route).map((p) => ({ ...p })),
      trajectoryRoute: evaluated.route.map((p) => ({ ...p })),
      candidates: [summary],
      routeMeta: {
        label: summary.label,
        kind: summary.kind,
        displayName: summary.displayName,
        score: summary.score,
        finalScore: summary.finalScore,
        lengthMeters: summary.lengthMeters,
        lenRatio: summary.lenRatio,
        contactRatio: summary.contactRatio,
        contactCount: summary.contactCount,
        tightestRadius: summary.tightestRadius,
        autonomyRiskScore: summary.autonomyRiskScore,
        autonomyStatus: summary.autonomyStatus,
        autonomyStopEventCount: summary.autonomyStopEventCount,
        autonomySlowEventCount: summary.autonomySlowEventCount,
        autonomySteeringSaturationRatio: summary.autonomySteeringSaturationRatio,
        autonomyMinAllowedSpeedKmh: summary.autonomyMinAllowedSpeedKmh,
        autonomyMaxTurnRadiusDeficitM: summary.autonomyMaxTurnRadiusDeficitM,
        regulationRiskScore: summary.regulationRiskScore,
        regulationStatus: summary.regulationStatus,
        regulationBlockCount: summary.regulationBlockCount,
        regulationPermitRequiredCount: summary.regulationPermitRequiredCount,
        regulationWarningCount: summary.regulationWarningCount,
        regulationIssueCount: summary.regulationIssueCount,
        selectedRank: 1,
        candidateCount: 1,
        distance,
        duration: routeResult?.duration
      }
    };
  }
  return {
    selectionRoute: route,
    trajectoryRoute: route,
    candidates: [],
    routeMeta: {
      label: 'osrm-shortest',
      kind: 'standard',
      displayName: '最短経路 (OSRM)',
      score: distance,
      lengthMeters: distance,
      lenRatio: 1,
      contactRatio: null,
      contactCount: null,
      tightestRadius: null,
      selectedRank: 1,
      candidateCount: 0,
      distance,
      duration: routeResult?.duration
    }
  };
}

function openSettingsPanel(forceOpen = true) {
  const panel = document.getElementById('sidePanel');
  if (!panel) return;
  if (forceOpen) panel.classList.add('open');
  else panel.classList.toggle('open');
}

function shortPresetKey(raw) {
  return buildWorkflowShortPresetKey(raw, {
    toFullVehiclePresetKey,
    fullToShortMap: VEHICLE_PRESET_FULL_TO_SHORT
  });
}

function renderRouteFlowButtons(state) {
  renderRouteFlowButtonsView(state);
}

function renderWorkflowDock(state) {
  renderWorkflowDockView(state, {
    shortPresetKey,
    getRouteTrackingTurnRadius
  });
}

function scheduleAutoRouteRebuild(state) {
  const epHash = endpointHash(state?.selectedEndpoints);
  if (!epHash) {
    lastAutoRouteEndpointHash = '';
    lastConfirmedRouteHash = '';
    clearMultiVehicleCaches();
    if (autoRouteRebuildTimer) clearTimeout(autoRouteRebuildTimer);
    return;
  }
  if (epHash === lastAutoRouteEndpointHash) return;
  // 回帰テスト(index3DSetRoute)が確定した決定論ルートは自動再構築で上書きしない。
  // （上書きすると注入した実道路ポリラインが端点間の直線に潰れ、Safety Monitor が
  //   経路乖離=道路逸脱として正しくMRM停止してしまう）
  if (state?.routeMeta?.source === 'test' && state?.simRoute?.length >= 2) {
    lastAutoRouteEndpointHash = epHash;
    return;
  }
  lastConfirmedRouteHash = '';
  clearMultiVehicleCaches();
  lastAutoRouteEndpointHash = epHash;
  if (autoRouteRebuildTimer) clearTimeout(autoRouteRebuildTimer);
  autoRouteRebuildTimer = setTimeout(() => {
    // 発火時点で再確認: endpoints設定→route設定の順で通知が来るため、予約時に
    // routeMeta が未設定でも、ここでテスト確定ルートが載っていれば上書きしない。
    const cur = store.getState();
    if (cur?.routeMeta?.source === 'test' && cur?.simRoute?.length >= 2) return;
    autoRebuildRouteForEndpoints(epHash).catch((e) => {
      console.warn('[auto-route] rebuild failed', e);
    });
  }, AUTO_ROUTE_REBUILD_DELAY_MS);
}

async function refreshYoloRoadWidthsBeforeRouting(state, provisionalPlan) {
  const enabledEl = document.getElementById('autoSatYoloBeforeRoute');
  if (enabledEl && !enabledEl.checked) return { applied: false, reason: 'disabled' };
  if (!enabledEl) return { applied: false, reason: 'disabled' };
  if (!state?.geoJsonDataSets?.length) return { applied: false, reason: 'roads_missing' };

  const routeForWidth = provisionalPlan?.trajectoryRoute?.length >= 2
    ? provisionalPlan.trajectoryRoute
    : state.simRoute;
  if (!routeForWidth || routeForWidth.length < 2) return { applied: false, reason: 'route_missing' };

  const sig = [
    endpointHash(state.selectedEndpoints),
    routeHash(routeForWidth),
    roadsSig(state.geoJsonDataSets)
  ].join(':');
  if (sig && sig === lastPreRouteYoloWidthSig) return { applied: false, reason: 'cached' };

  const cached = getCachedYoloAlive();
  const yoloAlive = cached !== null ? cached : await checkYoloServerStatus();
  if (!yoloAlive) return { applied: false, reason: 'yolo_offline' };

  lastPreRouteYoloWidthSig = sig;
  setStatusMessage('衛星YOLOで周辺道路幅を推定中...');
  const result = await runSatelliteYoloEstimate({
    silent: true,
    routeOverride: routeForWidth,
    sampleSurroundingRoads: true,
    corridorMeters: 160,
    maxFrames: 80
  });
  if (result?.applied) {
    setStatusMessage(`衛星YOLOで周辺道路幅を更新: ${result.appliedRoads}本 / 候補経路を再計算中...`);
    console.log('[auto-route] satellite YOLO width applied before routing', result);
  }
  return result || { applied: false };
}

async function autoRebuildRouteForEndpoints(expectedHash) {
  if (autoRouteRebuildInFlight) return;
  autoRouteRebuildInFlight = true;
  let succeeded = false;
  let resultLengthM = 0;
  let usedFallback = false;
  let finalPlanSource = '';
  try {
    const state = store.getState();
    if (endpointHash(state.selectedEndpoints) !== expectedHash) return;
    if (!state.selectedEndpoints || state.selectedEndpoints.length < 2) return;

    console.log('[auto-route] start', { endpoints: state.selectedEndpoints.length, expectedHash });
    setStatusMessage(`🛰️ 経路計算中... (${state.selectedEndpoints.length}点)`);

    const provisionalPlan = buildDirectEndpointPlan(state.selectedEndpoints);
    if (provisionalPlan) {
      applyRoutePlan(provisionalPlan);
      console.log('[auto-route] provisional direct route applied');
      setStatusMessage('🛰️ 仮経路を表示しました。道路沿い経路を計算中...');
      await new Promise((resolve) => {
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
        else setTimeout(resolve, 0);
      });
    }

    try {
      await refreshYoloRoadWidthsBeforeRouting(state, provisionalPlan);
    } catch (e) {
      console.warn('[auto-route] satellite YOLO width skipped before routing', e);
    }

    const routingState = store.getState();
    if (endpointHash(routingState.selectedEndpoints) !== expectedHash) return;

    const routeResult = (source, promise) => promise
      .then((plan) => ({ source, plan }))
      .catch((e) => {
        console.warn(`[auto-route] ${source} reject`, e);
        return { source, plan: null, error: e };
      });
    const delayResult = (ms, source) => new Promise((resolve) => setTimeout(() => resolve({ source }), ms));
    const hasRoute = (plan) => plan?.trajectoryRoute?.length >= 2;

    setStatusMessage('経路確認中... OSRM と道路グラフを確認しています');
    toast('経路確認中... OSRM と道路グラフを確認しています');
    setStatusMessage('経路確認中... 一方通行を守る候補を確認しています');
    await new Promise((resolve) => {
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
      else setTimeout(resolve, 0);
    });

    // 通常時はOSRMを優先する。道路グラフはOSRM失敗時のフォールバック。
    // 「一方通行を許可」が明示された場合だけ、permit候補を含むhybrid評価に切り替える。
    const routePrefer = getRoutePolicySettings().permitShortest ? 'hybrid' : 'osrm';
    const routePromise = routeResult('route', computeRouteFromEndpoints(routingState, {
      silent: true,
      prefer: routePrefer,
      osrmGraphFallback: true
    }));

    const ROUTE_QUICK_APPLY_MS = 1200;
    const ROUTE_REFINE_TOTAL_MS = 2600;
    const startedAt = Date.now();

    let plan = null;
    let planSource = '';
    const routeResults = [];

    const pendingSources = new Set(['route']);
    const waitForNextRouteResult = async (deadlineMs) => {
      const remainingMs = Math.max(0, deadlineMs - (Date.now() - startedAt));
      if (remainingMs <= 0 || !pendingSources.size) return null;
      const waiters = [];
      if (pendingSources.has('route')) waiters.push(routePromise);
      if (!waiters.length) return null;
      const next = await Promise.race([
        ...waiters,
        delayResult(remainingMs, 'timeout')
      ]);
      if (!next || next.source === 'timeout') return null;
      pendingSources.delete(next.source);
      if (hasRoute(next.plan)) {
        routeResults.push(next);
        console.log(`[auto-route] ${next.source} succeeded`, { elapsedMs: Date.now() - startedAt });
      } else if (next.source === 'route') {
        console.warn('[auto-route] route empty/failed');
      }
      return next;
    };

    while (pendingSources.size && !plan) {
      const next = await waitForNextRouteResult(ROUTE_QUICK_APPLY_MS);
      if (!next) break;
      if (hasRoute(next.plan)) {
        plan = next.plan;
        planSource = next.plan?.routeMeta?.label || next.source;
        const fresh = store.getState();
        if (endpointHash(fresh.selectedEndpoints) === expectedHash) {
          applyRoutePlan(plan);
          focusToRoute(plan.trajectoryRoute);
          setStatusMessage(`暫定経路を表示しました (${next.source})。残り候補を確認中...`);
        }
      }
    }

    if (!plan && pendingSources.size) {
      setStatusMessage('経路確認中... 道路グラフで候補を作成しています');
      setStatusMessage('経路確認中... 一方通行を守る候補を待機しています');
      const next = await waitForNextRouteResult(ROUTE_REFINE_TOTAL_MS);
      if (hasRoute(next?.plan)) {
        plan = next.plan;
        planSource = next.plan?.routeMeta?.label || next.source;
      }
    }

    while (pendingSources.size && (Date.now() - startedAt) < ROUTE_REFINE_TOTAL_MS) {
      const next = await waitForNextRouteResult(ROUTE_REFINE_TOTAL_MS);
      if (!next) break;
      if (!plan && hasRoute(next.plan)) {
        plan = next.plan;
        planSource = next.plan?.routeMeta?.label || next.source;
      }
    }

    if (hasRoute(plan) && !routeResults.some((r) => r.plan === plan)) {
      routeResults.push({ source: planSource || plan?.routeMeta?.label || 'route', plan });
    }
    const mergedPlan = routeResults.length > 1
      ? mergeRoutePlansAndPickBest(routeResults.map((r) => r.plan).filter(hasRoute))
      : null;
    if (mergedPlan) {
      plan = mergedPlan;
      planSource = mergedPlan.routeMeta?.label || planSource || '';
    }

    if (!plan?.trajectoryRoute || plan.trajectoryRoute.length < 2) {
      console.warn('[auto-route] all route methods failed');
      if (provisionalPlan?.trajectoryRoute?.length >= 2) {
        plan = provisionalPlan;
        planSource = 'direct';
      } else {
        setStatusMessage('⚠ 経路が引けませんでした。道路データを再取得するか、端点を近づけてください。');
        return;
      }
    }
    usedFallback = !(planSource === 'osrm' || planSource === 'osrm-shortest');
    finalPlanSource = planSource || '';

    // await 後に endpoint が変わっていないか再確認（競合状態を防ぐ）
    const freshState = store.getState();
    if (endpointHash(freshState.selectedEndpoints) !== expectedHash) {
      console.log('[auto-route] endpoints changed during compute, aborting apply');
      return;
    }

    const currentHash = routeHash(freshState.simRoute);
    const nextHash = routeHash(plan.trajectoryRoute);
    if (nextHash && nextHash !== currentHash) {
      applyRoutePlan(plan);
      focusToRoute(plan.trajectoryRoute);
      console.log('[auto-route] route applied', { source: planSource, meta: plan.routeMeta, elapsedMs: Date.now() - startedAt });
    } else if (planSource === 'direct') {
      console.log('[auto-route] kept provisional direct route', { elapsedMs: Date.now() - startedAt });
    }
    // 経路距離 (haversine 合計) を簡易表示
    try {
      const pts = plan.trajectoryRoute;
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        const R = 6371000;
        const dLat = (b.lat - a.lat) * Math.PI / 180;
        const dLng = (b.lng - a.lng) * Math.PI / 180;
        const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
        resultLengthM += R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
      }
    } catch (e) { /* ignore */ }
    succeeded = true;
  } catch (e) {
    console.error('[auto-route] unexpected error', e);
    setStatusMessage(`⚠ 経路計算でエラー: ${e?.message || e}`);
  } finally {
    autoRouteRebuildInFlight = false;
    if (succeeded) {
      const km = resultLengthM >= 1000 ? `${(resultLengthM / 1000).toFixed(2)} km` : `${Math.round(resultLengthM)} m`;
      const routeMetaForStatus = store.getState().routeMeta || {};
      const routeTagForStatus = routeMetaForStatus.displayName || finalPlanSource || '経路';
      const routeCountForStatus = Number(routeMetaForStatus.candidateCount) > 0 ? ` / 候補${routeMetaForStatus.candidateCount}本` : '';
      const tag = finalPlanSource === 'direct' ? '(仮経路)' : (usedFallback ? '(道路グラフ)' : '(OSRM)');
      const message = `経路確定 ${km} / 採用: ${routeTagForStatus}${routeCountForStatus} ${tag} - 「搬入判定を実行」で判定できます`;
      setStatusMessage(message);
      toast(message);
    } else {
      // 失敗時は次回 trigger のため hash をリセット
      lastAutoRouteEndpointHash = '';
    }
    // 計算中に endpoint が追加で変更されていたら追跡再計算（tail rebuild）
    const tailState = store.getState();
    const tailHash = endpointHash(tailState.selectedEndpoints);
    if (tailHash && tailHash !== expectedHash && tailState.selectedEndpoints.length >= 2) {
      lastAutoRouteEndpointHash = '';
      scheduleAutoRouteRebuild(tailState);
    }
  }
}

function setStatusMessage(msg) {
  const el = document.getElementById('status-message');
  if (el && typeof msg === 'string') el.textContent = msg;
}

async function runWorkflowNextAction() {
  await runWorkflowNextActionView({
    state: store.getState(),
    loadRoadsForView,
    openSettingsPanel,
    setManualAddMode,
    toast,
    computeRouteFromEndpoints,
    applyRoutePlan,
    showResultPanel() {
      const panel = document.getElementById('resultPanel');
      if (panel) panel.style.display = 'flex';
    }
  });
}

function initWorkflowControls() {
  const runWorkflowAction = () => {
    runWorkflowNextAction().catch((e) => toast(`workflow error: ${e.message || e}`));
  };
  document.getElementById('wfNextAction')?.addEventListener('click', runWorkflowAction);
  document.getElementById('wfOpenSettings')?.addEventListener('click', () => openSettingsPanel(true));
  document.getElementById('wfToggleManual')?.addEventListener('click', () => {
    const btn = document.getElementById('toggleManualEndpointMode');
    if (btn) btn.click();
    else setManualAddMode(true);
  });
  document.getElementById('wfClearEndpoints')?.addEventListener('click', () => {
    document.getElementById('clear-endpoints')?.click();
  });
  document.querySelectorAll('[data-vehicle-short]').forEach((btn) => {
    btn.addEventListener('click', () => {
      handleVehiclePresetChange(btn.dataset.vehicleShort, 'Quick Vehicle').catch((err) => {
        toast(`vehicle change failed: ${err.message || err}`);
      });
    });
  });
}

const STORAGE_GBA_AUTO_KEY = 'truck_gba_auto_v1';
const STORAGE_BUILDINGS_MODE_KEY = 'truck_buildings_mode_v1';

function safeLocalStorageGet(key) {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(key);
  } catch (e) {
    return null;
  }
}

function safeLocalStorageSet(key, value) {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(key, value);
  } catch (e) { }
}

function isGbaAutoLoadEnabled() {
  if (GBA_3D_REMOVED) return false;
  const v = String(safeLocalStorageGet(STORAGE_GBA_AUTO_KEY) ?? '').toLowerCase();
  if (v === '0' || v === 'false' || v === 'off') return false;
  if (v === '1' || v === 'true' || v === 'on') return true;
  return true;
}

function getBuildingsModePref() {
  if (GBA_3D_REMOVED) return 'solid';
  const v = String(safeLocalStorageGet(STORAGE_BUILDINGS_MODE_KEY) ?? '').toLowerCase();
  return v === 'wire' ? 'wire' : 'solid';
}

function setBuildingsModePref(mode) {
  if (GBA_3D_REMOVED) return;
  safeLocalStorageSet(STORAGE_BUILDINGS_MODE_KEY, mode === 'wire' ? 'wire' : 'solid');
}

function setGbaAutoLoadEnabled(flag) {
  if (GBA_3D_REMOVED) return;
  safeLocalStorageSet(STORAGE_GBA_AUTO_KEY, flag ? '1' : '0');
}

let lastAutoGeneratedGbaUrl = '';
let lastAutoLoadedGbaUrl = '';
let autoGbaTimer = null;
let autoGbaAbort = null;

function renderBuildingsPrefs() {
  if (GBA_3D_REMOVED) return;
  const autoBtn = document.getElementById('toggleGbaAutoLoad');
  const wireBtn = document.getElementById('toggleBuildingsWireframe');
  if (autoBtn) autoBtn.classList.toggle('active', isGbaAutoLoadEnabled());
  if (wireBtn) wireBtn.classList.toggle('active', getBuildingsModePref() === 'wire');
  setBuildingsRenderMode(getBuildingsModePref());
}

function renderThemeToggle() {
  const btn = document.getElementById('toggleTheme');
  if (!btn) return;
  const theme = getCurrentTheme();
  btn.textContent = theme === 'dark' ? 'Light' : 'Dark';
  btn.title = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
}

function renderAdvancedMeta(state) {
  const el = document.getElementById('advancedMeta');
  if (!el) return;
  const widthCount = Object.keys(state.widthOverrides || {}).length;
  const endpointCount = state.selectedEndpoints?.length || 0;
  const routeOk = (state.simRoute?.length || 0) > 1;
  const routeStatus = routeOk ? '確定済' : '未確定';
  const meta = state.routeMeta || {};
  const adopted = meta.displayName ? ` / 採用: ${meta.displayName}` : '';
  const candidateText = Number(meta.candidateCount) > 0 ? ` / 候補: ${meta.candidateCount}本` : '';
  el.textContent = `上書き: ${widthCount}件 / 地点: ${endpointCount}点 / 経路: ${routeStatus}${adopted}${candidateText}`;
}

function fmtPercent(v) {
  const n = Number(v);
  return Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : '-';
}

function fmtMeters(v, digits = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? `${n.toFixed(digits)}m` : '-';
}

function applyRouteCandidateById(candidateId) {
  const state = store.getState();
  const candidate = (state.routeCandidates || []).find((c) => c.id === candidateId);
  if (!candidate?.route || candidate.route.length < 2) return;
  const candidates = (state.routeCandidates || []).map((c) => ({ ...c, selected: c.id === candidateId }));
  const routeMeta = {
    label: candidate.label,
    kind: candidate.kind,
    displayName: candidate.displayName,
    score: candidate.score,
    finalScore: candidate.finalScore,
    lengthMeters: candidate.lengthMeters,
    lenRatio: candidate.lenRatio,
    contactRatio: candidate.contactRatio,
    contactCount: candidate.contactCount,
    tightestRadius: candidate.tightestRadius,
    autonomyRiskScore: candidate.autonomyRiskScore,
    autonomyStatus: candidate.autonomyStatus,
    autonomyStopEventCount: candidate.autonomyStopEventCount,
    autonomySlowEventCount: candidate.autonomySlowEventCount,
    autonomySteeringSaturationRatio: candidate.autonomySteeringSaturationRatio,
    autonomyMinAllowedSpeedKmh: candidate.autonomyMinAllowedSpeedKmh,
    autonomyMaxTurnRadiusDeficitM: candidate.autonomyMaxTurnRadiusDeficitM,
    regulationRiskScore: candidate.regulationRiskScore,
    regulationStatus: candidate.regulationStatus,
    regulationBlockCount: candidate.regulationBlockCount,
    regulationPermitRequiredCount: candidate.regulationPermitRequiredCount,
    regulationWarningCount: candidate.regulationWarningCount,
    regulationIssueCount: candidate.regulationIssueCount,
    selectedRank: candidate.rank,
    candidateCount: candidates.length
  };
  lastConfirmedRouteHash = '';
  clearMultiVehicleCaches();
  store.setRoutePlan({
    selectionRoute: candidate.selectionRoute?.length >= 2 ? candidate.selectionRoute : candidate.route,
    trajectoryRoute: candidate.route,
    candidates,
    routeMeta
  });
  focusToRoute(candidate.route);
  toast(`${candidate.displayName || '候補経路'}を採用しました。判定前に経路確定してください。`);
}

function renderRouteCandidatesPanel(state) {
  const panel = document.getElementById('routeCandidatesPanel');
  if (!panel) return;
  const candidates = (state.routeCandidates || []).filter((c) => Array.isArray(c?.route) && c.route.length >= 2);
  if (!candidates.length) {
    panel.innerHTML = '';
    return;
  }
  // XSS対策: c.displayName / c.label は OSM・routing API 由来。c.id は OSM way id。html`` で自動エスケープ。
  const cards = candidates.map((c) => {
    const kindLabel = c.kind === 'avoidance' ? '回避' : (c.kind === 'provisional' ? '仮' : (c.kind === 'permit' ? '許可' : '標準'));
    const selected = c.selected ? ' selected' : '';
    const avoidance = c.kind === 'avoidance' ? ' avoidance' : '';
    const lenRatio = Number.isFinite(Number(c.lenRatio)) ? ` / 距離 ${Number(c.lenRatio).toFixed(2)}x` : '';
    const stopText = Number(c.autonomyStopEventCount || 0) > 0 ? ` / 停止 ${Number(c.autonomyStopEventCount)}` : '';
    const slowText = Number(c.autonomySlowEventCount || 0) > 0 ? ` / 減速 ${Number(c.autonomySlowEventCount)}` : '';
    const minSpeedText = Number.isFinite(Number(c.autonomyMinAllowedSpeedKmh)) ? ` / 最低 ${Number(c.autonomyMinAllowedSpeedKmh).toFixed(1)}km/h` : '';
    const deficitText = Number(c.autonomyMaxTurnRadiusDeficitM || 0) > 0 ? ` / 半径不足 ${Number(c.autonomyMaxTurnRadiusDeficitM).toFixed(1)}m` : '';
    const regCount = Number(c.regulationIssueCount || 0);
    const regText = c.regulationStatus
      ? ` / ${routeRegulationLabel(c.regulationStatus)}${regCount > 0 ? ` ${regCount}` : ''}`
      : '';
    return html`
      <button class="route-candidate-card${selected}${avoidance}" type="button" data-route-candidate-id="${c.id}">
        <div class="route-candidate-name">
          <span>${c.rank}. ${c.displayName || c.label}</span>
          <span class="route-candidate-badge">${c.selected ? '採用中' : kindLabel}</span>
        </div>
        <div class="route-candidate-metrics">
          接触 ${fmtPercent(c.contactRatio)} / 最小R ${fmtMeters(c.tightestRadius, 1)}${lenRatio}${stopText}${slowText}${minSpeedText}${deficitText}${regText}
        </div>
      </button>`;
  }).join('');
  panel.innerHTML = html`
    <div class="route-candidate-title">候補経路 (${candidates.length}本)</div>
    ${unsafeHtml(cards)}
  `;
  panel.querySelectorAll('[data-route-candidate-id]').forEach((btn) => {
    btn.addEventListener('click', () => applyRouteCandidateById(btn.dataset.routeCandidateId));
  });
}

function renderStatusMessage(state) {
  const el = document.getElementById('status-message');
  if (!el) return;

  const roadCount = state.geoJsonDataSets?.length || 0;
  const endpointCount = state.selectedEndpoints?.length || 0;
  const routeOk = (state.simRoute?.length || 0) > 1;
  const feas = state._lastFeasibilityResult;

  if (feas?.status === 'OK' || feas?.status === 'NG') {
    const badge = feas.status === 'OK' ? '<span class="badge ok">PASS</span>' : '<span class="badge ng">NG</span>';
    const cov = Number.isFinite(feas.coverage) ? ` (coverage ${(feas.coverage * 100).toFixed(1)}%)` : '';
    el.innerHTML = html`${unsafeHtml(badge)} 搬入判定${cov}`;
    return;
  }

  if (!roadCount) {
    el.textContent = '表示範囲の道路データを取得してください。';
    return;
  }
  if (endpointCount < 2) {
    el.textContent = '始点と終点を地図で指定してください。';
    return;
  }
  if (!routeOk) {
    el.textContent = '経路候補を確認して「この経路で確定」を押してください。';
    return;
  }
  const meta = state.routeMeta || {};
  if (meta.displayName) {
    const count = Number(meta.candidateCount) > 0 ? ` / 候補${meta.candidateCount}本` : '';
    el.textContent = `採用経路: ${meta.displayName}${count}。経路確定後に判定できます。`;
    return;
  }
  el.textContent = '準備完了。搬入判定を実行してください。';
}

function renderHud(state) {
  const valueEl = document.getElementById('hudFeasValue');
  const subEl = document.getElementById('hudFeasSub');
  const card = document.getElementById('hudFeasCard');
  if (!valueEl || !subEl) return;

  const roadCount = state.geoJsonDataSets?.length || 0;
  const endpointCount = state.selectedEndpoints?.length || 0;
  const routeOk = (state.simRoute?.length || 0) > 1;
  const feas = state._lastFeasibilityResult;

  if (card) card.classList.remove('ok', 'warning', 'danger');
  valueEl.classList.remove('ok', 'ng');

  if (feas?.status === 'OK') {
    valueEl.textContent = 'PASS';
    if (card) card.classList.add('ok');
    const cov = Number.isFinite(feas.coverage) ? `${(feas.coverage * 100).toFixed(1)}%` : '-';
    subEl.textContent = `カバー率 ${cov}`;
    return;
  }

  if (feas?.status === 'NG') {
    valueEl.textContent = 'NG';
    if (card) card.classList.add('danger');
    const cov = Number.isFinite(feas.coverage) ? `${(feas.coverage * 100).toFixed(1)}%` : '-';
    subEl.textContent = `カバー率 ${cov}`;
    return;
  }

  if (!roadCount) {
    valueEl.textContent = '準備中';
    subEl.textContent = '先に道路データを読み込んでください';
    return;
  }
  if (endpointCount < 2) {
    valueEl.textContent = '準備中';
    subEl.textContent = '出発地と目的地を指定してください';
    return;
  }
  if (!routeOk) {
    valueEl.textContent = '準備中';
    subEl.textContent = '経路を確定してください';
    return;
  }

  valueEl.textContent = '準備完了';
  subEl.textContent = '搬入判定を実行できます';
}

function renderWidthHud(state) {
  const card = document.getElementById('hudWidthCard');
  const valueEl = document.getElementById('hudWidthValue');
  const subEl = document.getElementById('hudWidthSub');
  if (!card || !valueEl || !subEl) return;

  const selected = getSelectedRoadFeature(state);
  const show = !!state.isWidthEditMode || !!selected;
  card.classList.toggle('hidden', !show);
  if (!show) return;

  const osmW = selected ? getWidthOsmMeters(selected) : null;
  const aiW = selected ? getWidthAiMeters(selected) : null;

  if (aiW != null) valueEl.textContent = `${aiW.toFixed(1)}m`;
  else if (osmW != null) valueEl.textContent = `${osmW.toFixed(1)}m`;
  else valueEl.textContent = '--';

  if (!state.isWidthEditMode) {
    subEl.textContent = selected ? '幅編集 OFF（道路を選択すると詳細表示）' : '幅編集 OFF';
    return;
  }

  if (!selected) {
    subEl.textContent = '幅編集 ON（道路をクリック）';
    return;
  }

  const osmText = osmW == null ? '-' : osmW.toFixed(1);
  const aiText = aiW == null ? '-' : aiW.toFixed(1);
  subEl.textContent = `OSM ${osmText}m / AI ${aiText}m（スライダーで編集）`;
}

function setSearchMarker(lat, lng, label) {
  const map = getMapInstance();
  if (!map || typeof L === 'undefined') return;
  if (searchMarker) {
    try {
      searchMarker.remove();
    } catch (e) { }
    searchMarker = null;
  }
  searchMarker = L.marker([lat, lng]).addTo(map);
  if (label) {
    searchMarker.bindPopup(label);
    searchMarker.openPopup();
  }
}

function formatTimestamp(date = new Date()) {
  const pad2 = (v) => String(v).padStart(2, '0');
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}_${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`;
}

function downloadText(filename, text, mime = 'text/plain') {
  const blob = new Blob([text], { type: `${mime}; charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function featureIdOf(feature) {
  if (!feature) return null;
  if (feature.id != null) return String(feature.id);
  const pid = feature.properties?.id;
  if (pid != null) return String(pid);
  return null;
}

function getSelectedRoadFeature(state) {
  const id = state?.selectedRoadFeatureId;
  if (!id) return null;
  return (state.geoJsonDataSets || []).find((f) => featureIdOf(f) === id) || null;
}

function getWidthAiMeters(feature) {
  const props = feature?.properties && typeof feature.properties === 'object' ? feature.properties : {};
  const tags = props.tags && typeof props.tags === 'object' ? props.tags : null;
  const v = tags?.width_ai ?? props.width_ai;
  const n = parseMetersFromTag(v);
  return n == null ? null : n;
}

function getWidthOsmMeters(feature) {
  const props = feature?.properties && typeof feature.properties === 'object' ? feature.properties : {};
  const tags = props.tags && typeof props.tags === 'object' ? props.tags : null;
  const v = tags?.width ?? props.width;
  const n = parseMetersFromTag(v);
  return n == null ? null : n;
}

function percentile(values, p) {
  const arr = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!arr.length) return null;
  if (p <= 0) return arr[0];
  if (p >= 1) return arr[arr.length - 1];
  const idx = (arr.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return arr[lo];
  const t = idx - lo;
  return arr[lo] * (1 - t) + arr[hi] * t;
}

function median(values) {
  return percentile(values, 0.5);
}

function getWidthPriorMeters(feature) {
  if (!feature) return null;
  const props = feature.properties && typeof feature.properties === 'object' ? feature.properties : {};
  const tags = props.tags && typeof props.tags === 'object' ? props.tags : null;
  const hasAi = WIDTH_AI_KEYS.some((key) => (tags && Object.prototype.hasOwnProperty.call(tags, key))
    || Object.prototype.hasOwnProperty.call(props, key));
  const normalized = hasAi
    ? {
      ...feature,
      properties: {
        ...props,
        ...(tags ? {
          tags: Object.fromEntries(
            Object.entries(tags).filter(([key]) => !WIDTH_AI_KEYS.includes(key))
          )
        } : {})
      }
    }
    : feature;
  WIDTH_AI_KEYS.forEach((key) => {
    if (normalized?.properties && Object.prototype.hasOwnProperty.call(normalized.properties, key)) {
      delete normalized.properties[key];
    }
  });
  const est = estimateWidthForFeature(normalized);
  return Number.isFinite(est?.value) ? Number(est.value) : null;
}

function computeLocalBearing(points, index) {
  try {
    if (index + 1 < points.length) {
      return turf.bearing(
        turf.point([points[index].lng, points[index].lat]),
        turf.point([points[index + 1].lng, points[index + 1].lat])
      );
    }
    if (index > 0) {
      return turf.bearing(
        turf.point([points[index - 1].lng, points[index - 1].lat]),
        turf.point([points[index].lng, points[index].lat])
      );
    }
  } catch (e) { }
  return 0;
}

function getSatelliteVehicleWidthM(det) {
  const cls = Number(det?.cls);
  if (Number.isFinite(cls) && SATELLITE_YOLO_CLASS_WIDTHS_M[cls]) return SATELLITE_YOLO_CLASS_WIDTHS_M[cls];
  const name = String(det?.name ?? '').toLowerCase();
  if (name === 'car') return 1.8;
  if (name === 'motorcycle') return 0.8;
  if (name === 'bus' || name === 'truck') return 2.5;
  return null;
}

// Satellite YOLO はAI推定なので width_ai（applyPerceptionWidthAi）として適用する。
// 手動上書き userOverrideWidth とは分離。clear 用に適用済み road id を保持。
let satelliteYoloAppliedIds = [];

function estimateSatelliteRoadWidth(item, priorWidth = null) {
  const detections = Array.isArray(item?.detections) ? item.detections : [];
  const imageWidth = Number(item?.image_size?.width);
  const imageHeight = Number(item?.image_size?.height);
  if (!detections.length || !(imageWidth > 0) || !(imageHeight > 0)) return null;

  const mpp = 156543.03 * Math.cos(((Number(item?.lat) || 35) * Math.PI) / 180) / Math.pow(2, Number(item?.zoom) || 20);
  if (!(mpp > 0)) return null;

  const heading = Number(item?.heading) || 0;
  const rad = d2r(heading);
  const alongX = Math.sin(rad);
  const alongY = -Math.cos(rad);
  const normalX = Math.cos(rad);
  const normalY = Math.sin(rad);
  const centerX = imageWidth / 2;
  const centerY = imageHeight / 2;
  const halfWidths = [];
  const alongWindowM = Math.max(
    SATELLITE_YOLO_WIDTH_OPTIONS.baseAlongWindowM,
    Number.isFinite(priorWidth) ? Math.min(16, priorWidth * 1.6) : SATELLITE_YOLO_WIDTH_OPTIONS.baseAlongWindowM
  );
  const normalLimitM = Number.isFinite(priorWidth)
    ? Math.max(4.5, priorWidth * 0.5 + SATELLITE_YOLO_WIDTH_OPTIONS.priorNormalSlackM)
    : SATELLITE_YOLO_WIDTH_OPTIONS.maxNormalOffsetM;

  detections.forEach((det) => {
    const conf = Number(det?.conf ?? 0);
    if (!Number.isFinite(conf) || conf < SATELLITE_YOLO_WIDTH_OPTIONS.confMin) return;
    const vehicleWidth = getSatelliteVehicleWidthM(det);
    if (!(vehicleWidth > 0)) return;
    const bbox = Array.isArray(det?.bbox) ? det.bbox.map((v) => Number(v)) : null;
    if (!bbox || bbox.length < 4 || !bbox.every((v) => Number.isFinite(v))) return;
    const cx = ((bbox[0] + bbox[2]) * 0.5) - centerX;
    const cy = ((bbox[1] + bbox[3]) * 0.5) - centerY;
    const alongM = (cx * alongX + cy * alongY) * mpp;
    const normalM = (cx * normalX + cy * normalY) * mpp;
    if (Math.abs(alongM) > alongWindowM) return;
    if (Math.abs(normalM) > normalLimitM) return;
    halfWidths.push(Math.abs(normalM) + vehicleWidth * 0.5 + SATELLITE_YOLO_WIDTH_OPTIONS.edgeMarginM);
  });

  if (!halfWidths.length) return null;
  if (!(Number.isFinite(priorWidth)) && halfWidths.length < 2) return null;

  const rawHalf = percentile(halfWidths, halfWidths.length >= 4 ? 0.72 : 0.6);
  if (!(rawHalf > 0)) return null;
  const rawWidth = Math.max(
    SATELLITE_YOLO_WIDTH_OPTIONS.minWidth,
    Math.min(SATELLITE_YOLO_WIDTH_OPTIONS.maxWidth, rawHalf * 2)
  );

  if (!(Number.isFinite(priorWidth) && priorWidth > 0)) {
    return { width: rawWidth, rawWidth, sampleCount: halfWidths.length };
  }

  const rawWeight = halfWidths.length >= 3
    ? SATELLITE_YOLO_WIDTH_OPTIONS.rawWeightMany
    : SATELLITE_YOLO_WIDTH_OPTIONS.rawWeightFew;
  const blended = priorWidth * (1 - rawWeight) + rawWidth * rawWeight;
  const minAllowed = Math.max(
    SATELLITE_YOLO_WIDTH_OPTIONS.minWidth,
    Math.min(priorWidth * SATELLITE_YOLO_WIDTH_OPTIONS.priorMinScale, priorWidth)
  );
  const maxAllowed = Math.min(
    SATELLITE_YOLO_WIDTH_OPTIONS.maxWidth,
    Math.max(priorWidth * SATELLITE_YOLO_WIDTH_OPTIONS.priorMaxScale, priorWidth + SATELLITE_YOLO_WIDTH_OPTIONS.priorMaxGrowM)
  );
  const width = Math.max(minAllowed, Math.min(maxAllowed, blended));
  return { width, rawWidth, priorWidth, sampleCount: halfWidths.length };
}

function renderWidthEditorPanel(state) {
  const toggle = document.getElementById('toggleWidthEditMode');
  if (toggle) toggle.classList.toggle('active', !!state.isWidthEditMode);

  const selected = getSelectedRoadFeature(state);
  const idEl = document.getElementById('selectedRoadId');
  const osmEl = document.getElementById('selectedRoadWidthOsm');
  const aiEl = document.getElementById('selectedRoadWidthAi');
  const input = document.getElementById('roadWidthInput');
  const applyBtn = document.getElementById('applyRoadWidth');
  const resetBtn = document.getElementById('resetRoadWidth');

  const fid = selected ? featureIdOf(selected) : null;
  if (idEl) idEl.textContent = fid || '-';

  const osmW = selected ? getWidthOsmMeters(selected) : null;
  const aiW = selected ? getWidthAiMeters(selected) : null;
  if (osmEl) osmEl.textContent = osmW == null ? '-' : osmW.toFixed(1);
  if (aiEl) aiEl.textContent = aiW == null ? '-' : aiW.toFixed(1);

  const hasSelection = !!fid;
  if (applyBtn) applyBtn.disabled = !hasSelection;
  if (resetBtn) resetBtn.disabled = !hasSelection;
  if (input) {
    input.disabled = !hasSelection;
    if (hasSelection) {
      const v = aiW ?? osmW;
      if (v != null) input.value = String(Number(v.toFixed(2)));
    } else {
      input.value = '';
    }
  }

  const status = document.getElementById('widthOverridesStatus');
  if (status) {
    const count = Object.keys(state.widthOverrides || {}).length;
    status.textContent = `Overrides: ${count}`;
  }
}

let lastRouteSig3d = null;
let lastRoadSig3d = null;
let cachedRoadUnion3d = null;
let cachedRoadUnionSig3d = null;

function is3DOpen() {
  if (GBA_3D_REMOVED) return false;
  if (document.body?.classList?.contains('index3d')) return false;
  return document.getElementById('map3dWrap')?.classList.contains('open');
}

function roadsSig(features) {
  const arr = Array.isArray(features) ? features : [];
  const len = arr.length;
  if (!len) return '0';
  const a = String(arr[0]?.id ?? arr[0]?.properties?.id ?? '');
  const b = String(arr[len - 1]?.id ?? arr[len - 1]?.properties?.id ?? '');
  return `${len}:${a}:${b}`;
}

function getCorridorMeters() {
  if (GBA_3D_REMOVED) return 150;
  const el = document.getElementById('corridorMeters');
  const v = Number(el?.value);
  return Number.isFinite(v) ? v : 150;
}

function stableHash32(parts) {
  let h = 2166136261;
  const feed = (s) => {
    const str = String(s ?? '');
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    h ^= 124; // "|"
    h = Math.imul(h, 16777619);
  };
  for (const p of parts) feed(p);
  return (h >>> 0).toString(16).padStart(8, '0');
}

function widthOverridesSig(overrides) {
  const obj = overrides && typeof overrides === 'object' ? overrides : {};
  const entries = Object.entries(obj)
    .map(([id, v]) => [String(id), Number(v)])
    .filter(([id, v]) => !!id && Number.isFinite(v))
    .sort((a, b) => a[0].localeCompare(b[0]));

  const parts = [];
  for (const [id, v] of entries) {
    parts.push(id);
    parts.push(v.toFixed(2));
  }
  return `${entries.length}:${stableHash32(parts)}`;
}

function maskEditsSig(maskEdits) {
  const edits = maskEdits && typeof maskEdits === 'object' ? maskEdits : {};
  const toIds = (arr) =>
    (Array.isArray(arr) ? arr : [])
      .map((f) => String(f?.properties?.id ?? f?.id ?? ''))
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
  const allowIds = toIds(edits.allow);
  const denyIds = toIds(edits.deny);
  return `allow${allowIds.length}:${stableHash32(allowIds)}:deny${denyIds.length}:${stableHash32(denyIds)}`;
}

function roadUnionSigFor3D(state) {
  const r = routeSig(state.simRoute);
  const roads = roadsSig(state.geoJsonDataSets);
  const vw = Number(state?.vehicleConfig?.vehicleWidth ?? 0).toFixed(2);
  const wm = Number(state?.vehicleConfig?.widthMargin ?? 0).toFixed(2);
  const overrides = widthOverridesSig(state?.widthOverrides);
  const masks = maskEditsSig(state?.maskEdits);
  return `${r}:${roads}:vw${vw}:wm${wm}:${overrides}:${masks}`;
}

function applyMaskEditsToRoadUnion(roadUnion, maskEdits) {
  if (!roadUnion) return roadUnion;
  const edits = maskEdits && typeof maskEdits === 'object' ? maskEdits : {};
  const allow = Array.isArray(edits.allow) ? edits.allow : [];
  const deny = Array.isArray(edits.deny) ? edits.deny : [];

  let cur = roadUnion;
  for (const f of allow) {
    const g = f?.geometry;
    if (!g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon')) continue;
    try {
      cur = safeUnion(cur, f);
    } catch (e) { }
  }
  for (const f of deny) {
    const g = f?.geometry;
    if (!g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon')) continue;
    try {
      const next = safeDifference(cur, f);
      cur = next || null;
      if (!cur) break;
    } catch (e) { }
  }
  return cur;
}

function computeRoadUnionFor3D(state) {
  try {
    if (!state.geoJsonDataSets?.length || !state.simRoute?.length) return null;
    const line = turf.lineString(state.simRoute.map((p) => [p.lng, p.lat]));
    const corridor = turf.buffer(line, 120, { units: 'meters', steps: 8 });
    const clipBox = turf.bbox(corridor);

    const widen = Math.max(0, state.vehicleConfig.widthMargin || 0.3) * 2;
    const minW = (state.vehicleConfig.vehicleWidth || 0) + widen;
    const defaultW = Math.max(2, 6, minW);
    const clearance = 0.3;

    const roadUnionBase = buildRoadUnion(state.geoJsonDataSets, defaultW, clearance, clipBox);
    return applyMaskEditsToRoadUnion(roadUnionBase, state.maskEdits);
  } catch (e) {
    return null;
  }
}

function getRoadUnionGeoFor3D(state) {
  if (!state.simRoute || state.simRoute.length < 2) return null;

  const sig = roadUnionSigFor3D(state);
  const fromFeasibility = state._lastFeasibilityLayers?.roadUnion || null;
  if (fromFeasibility) {
    cachedRoadUnionSig3d = sig;
    cachedRoadUnion3d = fromFeasibility;
    return fromFeasibility;
  }

  if (sig !== cachedRoadUnionSig3d) {
    cachedRoadUnionSig3d = sig;
    cachedRoadUnion3d = computeRoadUnionFor3D(state);
  }

  return cachedRoadUnion3d || null;
}

function syncRoadSurface3D(state) {
  if (GBA_3D_REMOVED) return;
  if (!is3DOpen()) return;
  if (!state.simRoute || state.simRoute.length < 2) {
    clearRoadSurface3D();
    return;
  }
  setRoadSurface3D(getRoadUnionGeoFor3D(state));
}

function getPlaybackSpeedMultiplier() {
  const el = document.getElementById('playbackSpeed');
  const v = Number(el?.value);
  return Number.isFinite(v) ? Math.max(0.1, Math.min(5.0, v)) : 0.6;
}

function renderPlaybackSpeed() {
  const el = document.getElementById('playbackSpeedValue');
  if (!el) return;
  const v = getPlaybackSpeedMultiplier();
  el.textContent = `x${v.toFixed(2)}`;
}

function getDriverSkill() {
  const el = document.getElementById('driverSkill');
  const v = Number(el?.value);
  return Number.isFinite(v) ? Math.max(0.5, Math.min(2.0, v)) : 1.0;
}

function renderDriverSkill() {
  const el = document.getElementById('driverSkillValue');
  if (!el) return;
  const v = getDriverSkill();
  el.textContent = v.toFixed(1);
  store.setDriverSkill(v);
}

function getStrictRoadSettings() {
  const modeEl = document.getElementById('strictWidthMode');
  const extraEl = document.getElementById('strictWidthExtra');
  const strictMode = !!modeEl?.checked;
  const rawExtra = Number(extraEl?.value);
  const extraMargin = strictMode && Number.isFinite(rawExtra)
    ? Math.max(0, Math.min(1.5, rawExtra))
    : 0;
  return {
    strictMode,
    extraMargin,
    coverageThreshold: strictMode ? 0.95 : 0.88,  // スイープ面積がroadUnionに含まれない場合に警告
    clearanceMargin: strictMode ? 0.3 : 0.15,     // 道路端からの余裕(m) 日本の狭路に合わせ緩和
    defaultRoadWidth: strictMode ? 5 : 6  // 保守的な道路全幅の既定値
  };
}

function getEffectiveWidthMargin(vehicleConfig, strict = getStrictRoadSettings()) {
  const base = Number(vehicleConfig?.widthMargin ?? 0.3);
  return Math.max(0, base) + Math.max(0, strict.extraMargin || 0);
}

function getRoutePolicySettings() {
  if (typeof document === 'undefined') return { permitShortest: false };
  const permitShortest = !!document.getElementById('permitShortestRoute')?.checked;
  return { permitShortest };
}

function renderRoutePolicyControls() {
  const status = document.getElementById('routePolicyStatus');
  if (!status) return;
  const { permitShortest } = getRoutePolicySettings();
  status.textContent = permitShortest
    ? '経路方針: 許可モード。一方通行を無視した最短候補も採用できます。'
    : '経路方針: 一方通行を守ります。';
}

function handleRoutePolicyChange() {
  renderRoutePolicyControls();
  lastConfirmedRouteHash = '';
  clearMultiVehicleCaches();
  const state = store.getState();
  if (state?.selectedEndpoints?.length >= 2) {
    lastAutoRouteEndpointHash = '';
    scheduleAutoRouteRebuild(state);
  }
}

function renderStrictWidthControls() {
  const valEl = document.getElementById('strictWidthExtraVal');
  const range = document.getElementById('strictWidthExtra');
  const mode = document.getElementById('strictWidthMode');
  if (range && mode) range.disabled = !mode.checked;
  if (valEl && range) {
    const v = Number(range.value);
    valEl.textContent = Number.isFinite(v) ? `${v.toFixed(2)}m` : '0.00m';
    if (mode && !mode.checked) valEl.textContent = '0.00m';
  }
  // 厳格設定の変更を即時反映する。
  try { store.setState({}); } catch (e) { }
}

function syncSvQuickStatus() {
  const quick = document.getElementById('svQuickStatus');
  if (!quick) return;
  const sv = document.getElementById('svStatus');
  quick.textContent = sv?.textContent?.trim() || 'SV: 待機中';
}

// YOLOサーバー状態キャッシュ（ポーリングループのみが更新 → ビジネスロジックはHTTPなしで参照）
let _yoloStatusCache = { alive: false, ts: 0 };

// 実際にHTTPリクエストを発行してサーバーを確認し、キャッシュを更新する
async function checkYoloServerStatus() {
  const dot = document.getElementById('yoloServerDot');
  const label = document.getElementById('yoloServerLabel');
  const apiBase = getAnalysisApiBase();
  if (!apiBase) {
    _yoloStatusCache = { alive: false, ts: Date.now(), detail: null };
    if (dot) { dot.style.background = '#64748b'; dot.title = '未設定'; }
    if (label) label.textContent = 'YOLO: 未設定';
    return false;
  }
  try {
    const res = await fetchWithTimeout(`${apiBase}/status`, {}, 2000);
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      const gpu = data?.gpu || {};
      const modelOk = data?.model_loaded !== false;
      const segOk = data?.seg_model_loaded !== false;
      const gpuText = gpu.cuda
        ? `CUDA ${gpu.device || ''}`.trim()
        : (gpu.torch ? 'CPU torch' : 'CPU');
      const voxelText = data?.voxel_endpoint ? 'voxel OK' : 'voxel未使用';
      _yoloStatusCache = { alive: true, ts: Date.now(), detail: data };
      if (dot) { dot.style.background = '#4caf50'; dot.title = `稼働中 / ${gpuText}`; }
      if (label) {
        label.textContent = `YOLO: 稼働中 / ${gpuText} / モデル ${modelOk ? 'OK' : 'NG'} / セグ ${segOk ? 'OK' : 'NG'} / ${voxelText}`;
      }
      return true;
    }
  } catch (_) { /* not running */ }
  _yoloStatusCache = { alive: false, ts: Date.now(), detail: null };
  if (dot) { dot.style.background = '#f44336'; dot.title = '停止中'; }
  if (label) label.textContent = `YOLO: 停止中 (${apiBase})`;
  return false;
}

// キャッシュからサーバー状態を取得（HTTPリクエストなし）
// ttlMs 以内にポーリングが更新済みならキャッシュ値を返す。期限切れなら null（不明）
function getCachedYoloAlive(ttlMs = 90000) {
  if (Date.now() - _yoloStatusCache.ts < ttlMs) return _yoloStatusCache.alive;
  return null; // キャッシュ期限切れ
}

async function startYoloViaWebServer() {
  const btn = document.getElementById('yoloServerStart');
  const origText = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = '起動中…'; }
  try {
    const res = await fetchWithTimeout(`${window.location.origin}/api/start-yolo`, { method: 'POST' }, 8000);
    if (!res.ok) {
      if (res.status === 404 || res.status === 405) {
        toast(MSG.yoloUnsupportedEnv().combined);
      } else {
        toast(MSG.yoloStartFailed({ httpStatus: res.status }).combined);
      }
      return;
    }
    const d = await res.json();
    if (d.status === 'already-running') {
      toast('YOLOサーバーはすでに起動しています');
    } else if (d.status === 'error') {
      toast(MSG.yoloStartFailed({ error: d.error }).combined);
    } else {
      toast('YOLOサーバーを起動しました（起動まで数秒かかります）');
      for (let i = 0; i < 15; i++) {
        await new Promise(r => setTimeout(r, 1000));
        const ok = await checkYoloServerStatus();
        if (ok) break;
      }
    }
  } catch (e) {
    toast(MSG.yoloStartFailed({ error: e }).combined);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = origText ?? '起動'; }
  }
}

async function runSvYoloWidthPipeline() {
  // キャッシュ優先でサーバー状態確認（キャッシュなければ実リクエスト）
  const cached = getCachedYoloAlive();
  const serverAlive = cached !== null ? cached : await checkYoloServerStatus();
  if (!serverAlive) {
    toast(MSG.yoloOffline().combined);
    throw new Error('YOLOサーバー未起動 (port 8001)');
  }
  await scanStreetView();
  await analyzeStreetView();
  return applyDetectionsToWidths();
}

function getAnalysisApiBase() {
  const inputVal = String(document.getElementById('yoloApiBase')?.value || '').trim();
  if (inputVal) return inputVal.replace(/\/$/, '');
  if (RUNTIME_CONFIG.yoloServerUrl) return RUNTIME_CONFIG.yoloServerUrl.replace(/\/$/, '');
  const dataApiBase = String(document.getElementById('svFrameList')?.dataset?.apiBase || '').trim();
  return dataApiBase ? dataApiBase.replace(/\/$/, '') : '';
}

function getGoogleMapsApiKey() {
  const keyScript = document.querySelector('script[src*="maps.googleapis.com/maps/api/js"]');
  if (!keyScript) return '';
  try {
    return new URL(keyScript.src).searchParams.get('key') || '';
  } catch (e) {
    return '';
  }
}

function lineFeaturesForWidthSampling(feature) {
  const g = feature?.geometry;
  if (!g) return [];
  if (g.type === 'LineString') return [turf.lineString(g.coordinates, feature.properties || {})];
  if (g.type === 'MultiLineString') {
    return g.coordinates
      .filter((coords) => Array.isArray(coords) && coords.length >= 2)
      .map((coords) => turf.lineString(coords, feature.properties || {}));
  }
  return [];
}

function sampleBearingOnLine(line, distM, lengthM) {
  try {
    const delta = Math.min(10, Math.max(3, lengthM * 0.12));
    const aM = Math.max(0, distM - delta);
    const bM = Math.min(lengthM, distM + delta);
    if (Math.abs(bM - aM) < 0.5) return 0;
    const a = turf.along(line, aM, { units: 'meters' });
    const b = turf.along(line, bM, { units: 'meters' });
    return turf.bearing(a, b);
  } catch (e) {
    return 0;
  }
}

function thinSamples(samples, maxFrames) {
  const max = Math.max(3, Number(maxFrames) || samples.length);
  if (samples.length <= max) return samples;
  const out = [];
  for (let i = 0; i < max; i++) {
    const idx = Math.round((i / Math.max(1, max - 1)) * (samples.length - 1));
    out.push(samples[idx]);
  }
  return out;
}

function buildSatelliteYoloSamplePlan(state, routeLL, {
  spacing = 30,
  zoom = 20,
  sampleSurroundingRoads = true,
  corridorMeters = 80,
  maxFrames = 70
} = {}) {
  const route = Array.isArray(routeLL) && routeLL.length >= 2 ? routeLL : state.simRoute;
  if (!Array.isArray(route) || route.length < 2) return { samples: [], sampledRoads: 0, mode: 'none' };

  if (sampleSurroundingRoads && Array.isArray(state.geoJsonDataSets) && state.geoJsonDataSets.length && turf?.buffer) {
    try {
      const routeLine = turf.lineString(route.map((p) => [p.lng, p.lat]));
      const corridor = turf.buffer(routeLine, Math.max(20, Number(corridorMeters) || 80), { units: 'meters', steps: 8 });
      const samples = [];
      const roadIds = new Set();

      for (const feature of state.geoJsonDataSets) {
        const fid = featureIdOf(feature);
        if (!fid || !feature?.geometry) continue;
        let intersects = false;
        try {
          intersects = turf.booleanIntersects ? turf.booleanIntersects(feature, corridor) : true;
        } catch (e) {
          intersects = true;
        }
        if (!intersects) continue;

        for (const line of lineFeaturesForWidthSampling(feature)) {
          const lengthM = turf.length(line, { units: 'meters' });
          if (!(lengthM > 2)) continue;
          const n = Math.max(1, Math.floor(lengthM / Math.max(8, Number(spacing) || 30)));
          for (let i = 0; i <= n; i++) {
            const distM = Math.min(lengthM, (i / Math.max(1, n)) * lengthM);
            const pt = turf.along(line, distM, { units: 'meters' });
            const [lng, lat] = pt.geometry.coordinates;
            samples.push({
              lng,
              lat,
              heading: sampleBearingOnLine(line, distM, lengthM),
              zoom,
              featureId: fid,
              source: 'surrounding-road'
            });
            roadIds.add(fid);
          }
        }
      }
      const thinned = thinSamples(samples, maxFrames);
      if (thinned.length) return { samples: thinned, sampledRoads: roadIds.size, mode: 'surrounding-roads' };
    } catch (e) {
      console.warn('[satellite-yolo] surrounding road sampling failed:', e.message);
    }
  }

  try {
    const routeLine = turf.lineString(route.map((p) => [p.lng, p.lat]));
    const routeLength = turf.length(routeLine, { units: 'meters' });
    const numSamples = Math.min(
      Math.max(3, Number(maxFrames) || 50),
      Math.max(3, Math.floor(routeLength / Math.max(8, Number(spacing) || 30)))
    );
    const samples = [];
    for (let i = 0; i <= numSamples; i++) {
      const dist = (i / numSamples) * routeLength;
      const pt = turf.along(routeLine, dist, { units: 'meters' });
      samples.push({ lng: pt.geometry.coordinates[0], lat: pt.geometry.coordinates[1], zoom, source: 'route' });
    }
    for (let i = 0; i < samples.length; i++) {
      samples[i].heading = computeLocalBearing(samples, i);
    }
    return { samples, sampledRoads: 0, mode: 'route' };
  } catch (e) {
    return { samples: [], sampledRoads: 0, mode: 'none' };
  }
}



function assessmentStatusRank(status) {
  if (status === 'PASS') return 3;
  if (status === 'CONDITIONAL') return 2;
  if (status === 'NG') return 1;
  return 0;
}

function pickBetterAssessmentResult(current, candidate) {
  if (!candidate) return current;
  if (!current) return candidate;
  const currentRank = assessmentStatusRank(current.overallStatus);
  const candidateRank = assessmentStatusRank(candidate.overallStatus);
  if (candidateRank > currentRank) return candidate;
  if (candidateRank < currentRank) return current;
  const currentScore = Number.isFinite(current.score) ? current.score : -Infinity;
  const candidateScore = Number.isFinite(candidate.score) ? candidate.score : -Infinity;
  return candidateScore > currentScore ? candidate : current;
}

async function reassessWithYoloEvidence({
  strictSettings = getStrictRoadSettings(),
  runSv = true,
  runSat = true
} = {}) {
  if (!runSv && !runSat) return null;
  const ready = await checkYoloServerStatus();
  if (!ready) return null;

  let appliedAnyWidth = false;
  if (runSv) {
    try {
      const svRes = await runSvYoloWidthPipeline();
      appliedAnyWidth = appliedAnyWidth || !!svRes?.applied;
    } catch (e) {
      console.warn('[yolo-reassess] sv skipped', e);
    }
  }
  if (runSat) {
    try {
      const satRes = await runSatelliteYoloEstimate({ silent: true });
      appliedAnyWidth = appliedAnyWidth || !!satRes?.applied;
    } catch (e) {
      console.warn('[yolo-reassess] satellite skipped', e);
    }
  }
  if (!appliedAnyWidth) return null;

  const state = store.getState();
  if (!state.simRoute || state.simRoute.length < 2) return null;
  const widthMargin = getEffectiveWidthMargin(state.vehicleConfig, strictSettings);

  return await runDeliveryAssessment({
    simRoute: state.simRoute,
    vehicleConfig: state.vehicleConfig,
    cargoLoadType: state.cargoLoadType,
    cargoCount: state.cargoCount,
    geoJsonDataSets: state.geoJsonDataSets,
    maskEdits: state.maskEdits,
    buildingsGeo: state.buildingsGeoJSON,
    endpoints: state.selectedEndpoints,
    vehiclePreset: state.vehiclePresetName,
    driverSkill: state.driverSkill,
    defaultRoadWidth: strictSettings.defaultRoadWidth,
    widthMargin,
    clearanceMargin: strictSettings.clearanceMargin,
    coverageThreshold: strictSettings.coverageThreshold,
    strictWidthMode: strictSettings.strictMode,
    permitMode: getRoutePolicySettings().permitShortest,
    externalRegulations: getActiveExternalRegulations(),
    allowRouteAdjustment: false,
    maxAdjustIterations: ROUTE_ADJUSTMENT_MAX_ITERATIONS
  });
}

function getObstacleRadiusMeters() {
  const el = document.getElementById('obstacleRadius');
  const v = Number(el?.value);
  return Number.isFinite(v) ? Math.max(0.2, Math.min(50, v)) : 1.5;
}

function getObstacleHeightMeters() {
  const el = document.getElementById('obstacleHeight');
  const v = Number(el?.value);
  return Number.isFinite(v) ? Math.max(0.2, Math.min(200, v)) : 3.0;
}

function renderObstacleControls() {
  const r = getObstacleRadiusMeters();
  const h = getObstacleHeightMeters();
  const rEl = document.getElementById('obstacleRadiusValue');
  const hEl = document.getElementById('obstacleHeightValue');
  if (rEl) rEl.textContent = `${r.toFixed(1)}m`;
  if (hEl) hEl.textContent = `${h.toFixed(1)}m`;
  setObstacleDefaults({ radiusMeters: r, heightMeters: h });
}

function renderObstacleStatus(state) {
  const el = document.getElementById('obstacleStatus');
  if (!el) return;
  const deny = state?.maskEdits?.deny;
  const count = Array.isArray(deny) ? deny.length : 0;
  el.textContent = `障害物: ${count}件`;
}

function refreshWidthFusionValidation(state = store.getState()) {
  const report = buildWidthFusionValidationReport(state.geoJsonDataSets || []);
  store.setState({ widthFusionValidation: report });
  console.log('[width-fusion]', report);
  const text = `幅融合: 道路 ${report.featureCount}本、YOLO ${(report.yoloCoverage * 100).toFixed(1)}%、平均信頼度 ${report.averageConfidence}、不一致 ${report.disagreementCount}`;
  setStatusMessage(text);
  toast(text);
  return report;
}

function renderPlateauStatus(message = null) {
  const el = document.getElementById('plateauStatus');
  if (!el) return;
  if (message) {
    el.textContent = message;
    return;
  }
  const buildings = store.getState().buildingsGeoJSON || [];
  const plateauCount = buildings.filter((f) => (f.properties?.source || '').includes('plateau')).length;
  el.textContent = plateauCount ? `PLATEAU: ${plateauCount} buildings loaded` : 'PLATEAU: not loaded';
}

function getPlateauUrlFromInputs() {
  return String(
    document.getElementById('plateauUrlInput')?.value ||
    document.getElementById('plateauBuildingsUrl')?.value ||
    RUNTIME_CONFIG.plateauBuildingsUrl ||
    ''
  ).trim();
}

function syncPlateauUrlInputs() {
  const inputs = [
    document.getElementById('plateauUrlInput'),
    document.getElementById('plateauBuildingsUrl')
  ].filter(Boolean);
  if (!inputs.length) return;
  const initial = getPlateauUrlFromInputs();
  if (initial) {
    inputs.forEach((input) => {
      if (!input.value) input.value = initial;
    });
  }
  inputs.forEach((input) => {
    input.addEventListener('input', () => {
      const value = input.value;
      inputs.forEach((other) => {
        if (other !== input && other.value !== value) other.value = value;
      });
    });
  });
}

async function onLoadPlateauBuildings() {
  const url = getPlateauUrlFromInputs();
  if (!url) {
    toast('Set PLATEAU GeoJSON URL first.');
    renderPlateauStatus('PLATEAU: URL missing');
    return;
  }
  renderPlateauStatus('PLATEAU: loading...');
  try {
    const features = await fetchPlateauBuildings(url);
    const state = store.getState();
    const merged = mergeFeaturesById(state.buildingsGeoJSON || [], features);
    store.setBuildingsGeoJSON(merged);
    setBuildingsAllGeoJSON(merged);
    renderPlateauStatus(`PLATEAU: ${features.length} loaded / buildings ${merged.length}`);
    toast(`PLATEAU buildings loaded: ${features.length}`);
  } catch (e) {
    console.warn('[plateau] load failed', e);
    renderPlateauStatus(`PLATEAU: failed - ${e.message}`);
    toast(`PLATEAU load failed: ${e.message}`);
  }
}

function buildDetourWaypointTrials(endpoints = [], { distances = [45, 75, 115] } = {}) {
  if (!Array.isArray(endpoints) || endpoints.length < 2 || !turf?.destination) return [];
  const midIdx = Math.floor((endpoints.length - 1) / 2);
  const a = endpoints[midIdx];
  const b = endpoints[midIdx + 1];
  const mid = {
    lat: (Number(a.lat) + Number(b.lat)) / 2,
    lng: (Number(a.lng) + Number(b.lng)) / 2
  };
  if (!Number.isFinite(mid.lat) || !Number.isFinite(mid.lng)) return [];
  const directions = [
    { bearing: 0, name: 'N' },
    { bearing: 45, name: 'NE' },
    { bearing: 90, name: 'E' },
    { bearing: 135, name: 'SE' },
    { bearing: 180, name: 'S' },
    { bearing: 225, name: 'SW' },
    { bearing: 270, name: 'W' },
    { bearing: 315, name: 'NW' }
  ];
  const trials = [];
  for (const distanceM of distances) {
    for (const dir of directions) {
      const dest = turf.destination(turf.point([mid.lng, mid.lat]), distanceM / 1000, dir.bearing, { units: 'kilometers' });
      const [lng, lat] = dest.geometry.coordinates;
      trials.push({
        name: `avoid-${dir.name}-${distanceM}m`,
        bearing: dir.bearing,
        distanceM,
        midIdx,
        waypoint: { id: `detour-wp-${dir.name}-${distanceM}`, lat, lng }
      });
    }
  }
  return trials;
}

function scoreDetourResult(detourResult, detourPlan, baseDistanceMeters = 0) {
  const statusRank = detourResult?.overallStatus === 'PASS'
    ? 0
    : (detourResult?.overallStatus === 'CONDITIONAL' ? 1 : 2);
  const violations = Number(detourResult?.violations?.length || 0);
  const contactRatio = Number(detourResult?.contactFeasibility?.contactRatio ?? detourResult?.collisionReport?.contactRatio ?? 1) || 0;
  const distance = Number(detourResult?.distanceMeters) || 0;
  const lengthPenalty = baseDistanceMeters > 0 && distance > baseDistanceMeters
    ? ((distance / baseDistanceMeters) - 1) * 35
    : 0;
  const candidatePenalty = Number(detourPlan?.routeMeta?.finalScore ?? detourPlan?.routeMeta?.score) || 0;
  return statusRank * 100000 + violations * 80 + contactRatio * 5000 + lengthPenalty + candidatePenalty * 0.05;
}

function syncObstacles3D(state) {
  if (GBA_3D_REMOVED) return;
  const deny = state?.maskEdits?.deny;
  const arr = Array.isArray(deny) ? deny : [];
  if (!arr.length) {
    clearObstacles3D();
    return;
  }
  setObstaclesGeoJSON({ type: 'FeatureCollection', features: arr });
}

function get3DCollisionObstaclesGeo(state) {
  const features = [];
  const deny = Array.isArray(state?.maskEdits?.deny) ? state.maskEdits.deny : [];
  const buildings = Array.isArray(state?.buildingsGeoJSON) ? state.buildingsGeoJSON : [];
  features.push(...deny.filter((f) => f?.geometry));
  features.push(...buildings.filter((f) => f?.geometry));
  return features.length ? { type: 'FeatureCollection', features } : null;
}

function updateGbaStatus(stats) {
  if (GBA_3D_REMOVED) return;
  const el = document.getElementById('gbaStatus');
  if (!el) return;
  const state = store.getState();
  const cur = stats || getBuildings3DStats();
  if (!cur.total) {
    el.textContent = '建物: 未読込';
    return;
  }
  if (!state.simRoute || state.simRoute.length < 2) {
    el.textContent = `\u5efa\u7269: ${cur.total} \u4ef6 (\u7d4c\u8def\u672a\u78ba\u5b9a)`;
    return;
  }
  el.textContent = `建物: ${cur.shown} / ${cur.total}（±${getCorridorMeters()}m）`;
}

function getAutoManagedGbaUrl(state = store.getState()) {
  if (GBA_3D_REMOVED) return null;
  const input = document.getElementById('gbaUrl');
  const cur = input?.value?.trim() ?? '';
  const isAutoManaged = !cur || (lastAutoGeneratedGbaUrl && cur === lastAutoGeneratedGbaUrl);
  if (!isAutoManaged) return null;
  const next = refreshGbaUrlInput(state, { force: true }) || cur;
  if (next) lastAutoGeneratedGbaUrl = next;
  return next || null;
}

function scheduleAutoGbaLoad(reason = 'auto') {
  if (GBA_3D_REMOVED) return;
  if (!isGbaAutoLoadEnabled()) return;
  if (autoGbaTimer) clearTimeout(autoGbaTimer);
  autoGbaTimer = setTimeout(() => {
    autoGbaTimer = null;
    autoLoadGbaBuildings(reason).catch((e) => console.warn('auto gba load failed', e));
  }, 150);
}

async function autoLoadGbaBuildings(reason = 'auto') {
  if (GBA_3D_REMOVED) return;
  if (!isGbaAutoLoadEnabled()) return;
  const state = store.getState();
  if (!state.simRoute || state.simRoute.length < 2) return;

  const url = getAutoManagedGbaUrl(state);
  if (!url) {
    if (reason === 'toggle') {
      toast('建物URLが手動指定のため、自動読込をスキップしました。');
    }
    return;
  }

  const curStats = getBuildings3DStats();
  if (curStats.total > 0 && url === lastAutoLoadedGbaUrl) {
    const stats = updateBuildingsForRoute(state.simRoute, { corridorMeters: getCorridorMeters() });
    updateGbaStatus(stats);
    return;
  }

  if (autoGbaAbort) {
    try {
      autoGbaAbort.abort();
    } catch (e) { }
  }
  autoGbaAbort = new AbortController();

  const status = document.getElementById('gbaStatus');
  if (status) status.textContent = '建物: 読込中...';

  const json = await fetchJsonWithCorsFallback(url, { signal: autoGbaAbort.signal });
  setBuildingsAllGeoJSON(json);
  lastAutoLoadedGbaUrl = url;

  const stats = updateBuildingsForRoute(state.simRoute, { corridorMeters: getCorridorMeters() });
  updateGbaStatus(stats);
  if (reason !== 'silent') toast(`建物を自動読込しました: ${stats.total}件`);
}

function buildCorsProxyUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return null;
  try {
    const u = new URL(raw, window.location.href);
    if (u.origin === window.location.origin) return u.href;
    return `https://corsproxy.io/?${encodeURIComponent(u.href)}`;
  } catch (e) {
    return null;
  }
}

async function fetchJsonWithCorsFallback(url, { signal } = {}) {
  const doFetch = async (u) => {
    const res = await fetch(u, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  };
  try {
    return await doFetch(url);
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    const proxied = buildCorsProxyUrl(url);
    if (!proxied || proxied === url) throw e;
    return await doFetch(proxied);
  }
}

function routeSig(simRoute) {
  if (!simRoute || simRoute.length < 2) return '';
  const a = simRoute[0];
  const b = simRoute[simRoute.length - 1];
  return `${simRoute.length}:${a.lat.toFixed(6)},${a.lng.toFixed(6)}:${b.lat.toFixed(6)},${b.lng.toFixed(6)}`;
}

function shouldReloadWideRoadData(state) {
  const sig = routeSig(state?.simRoute);
  if (!sig) return false;
  const now = Date.now();
  const staleMs = 90 * 1000;
  const noRoadData = !Array.isArray(state?.geoJsonDataSets) || state.geoJsonDataSets.length === 0;
  if (noRoadData || sig !== lastWideRoadLoadSig || (now - lastWideRoadLoadAt) > staleMs) {
    lastWideRoadLoadSig = sig;
    lastWideRoadLoadAt = now;
    return true;
  }
  return false;
}

function routeLengthMeters(routeLL) {
  if (!Array.isArray(routeLL) || routeLL.length < 2) return 0;
  try {
    const line = turf.lineString(routeLL.map((p) => [p.lng, p.lat]));
    return turf.length(line, { units: 'meters' });
  } catch (e) {
    return 0;
  }
}

function maxDeviationMeters(candidate, base) {
  if (!Array.isArray(candidate) || candidate.length < 2) return 0;
  if (!Array.isArray(base) || base.length < 2) return 0;
  try {
    const line = turf.lineString(base.map((p) => [p.lng, p.lat]));
    let maxD = 0;
    const stride = Math.max(1, Math.floor(candidate.length / 120));
    for (let i = 0; i < candidate.length; i += stride) {
      const p = candidate[i];
      const d = turf.pointToLineDistance(turf.point([p.lng, p.lat]), line, { units: 'meters' });
      if (Number.isFinite(d) && d > maxD) maxD = d;
    }
    return maxD;
  } catch (e) {
    return 0;
  }
}

function estimateTightestTurnRadius(routeLL) {
  if (!Array.isArray(routeLL) || routeLL.length < 3) return null;
  coordinateSystem.setOrigin(routeLL[0].lat, routeLL[0].lng);
  let minRadius = Infinity;
  for (let i = 1; i < routeLL.length - 1; i++) {
    const a = routeLL[i - 1];
    const b = routeLL[i];
    const c = routeLL[i + 1];
    const am = coordinateSystem.latLngToMeters(a.lat, a.lng);
    const bm = coordinateSystem.latLngToMeters(b.lat, b.lng);
    const cm = coordinateSystem.latLngToMeters(c.lat, c.lng);
    const v1x = bm.x - am.x;
    const v1y = bm.y - am.y;
    const v2x = cm.x - bm.x;
    const v2y = cm.y - bm.y;
    const l1 = Math.hypot(v1x, v1y);
    const l2 = Math.hypot(v2x, v2y);
    if (l1 < 1 || l2 < 1) continue;
    const dot = (v1x * v2x + v1y * v2y) / (l1 * l2);
    const angle = Math.acos(Math.max(-1, Math.min(1, dot)));
    if (!Number.isFinite(angle) || angle < d2r(8)) continue;
    const r = Math.min(l1, l2) / Math.max(Math.tan(angle / 2), 1e-3);
    if (Number.isFinite(r) && r > 0) minRadius = Math.min(minRadius, r);
  }
  return Number.isFinite(minRadius) ? minRadius : null;
}

function normalizeRouteForVehicle(routeLL, vehicleConfig) {
  if (!Array.isArray(routeLL) || routeLL.length < 2) return null;
  const Rmin = getRouteTrackingTurnRadius(vehicleConfig);
  const base = pruneTinyLoops(routeLL);
  const dehooked = removeRouteHooks(base, Math.max(25, Rmin * 2.2));
  const cleaned = pruneTinyLoops(dehooked, 0.9, 160);
  let shaped = cleaned;
  if (Rmin > 0 && cleaned.length > 2) {
    try {
      coordinateSystem.setOrigin(cleaned[0].lat, cleaned[0].lng);
      shaped = applyTurnTemplates(cleaned, Rmin);
    } catch (e) {
      shaped = cleaned;
    }
  }
  const dense = densifyRouteLL(shaped, 1.5);
  return dense && dense.length >= 2 ? dense : null;
}

function evaluateRouteCandidate(routeLL, state, { label = 'route' } = {}) {
  const strict = getStrictRoadSettings();
  const widthMargin = getEffectiveWidthMargin(state.vehicleConfig, strict);
  const selectionRoute = stabilizeRoutePoints(routeLL);
  const plan = buildTrajectoryPlanFromSelection(selectionRoute, {
    vehicleConfig: state.vehicleConfig,
    geoJsonDataSets: state.geoJsonDataSets,
    maskEdits: state.maskEdits,
    defaultRoadWidth: strict.defaultRoadWidth,
    clearanceMargin: strict.clearanceMargin,
    strictWidthMode: strict.strictMode,
    widthMargin
  });
  if (!plan?.trajectoryRoute || plan.trajectoryRoute.length < 2) return null;
  const metrics = plan.metrics || {};
  let autonomy = null;
  try {
    autonomy = buildAutonomyDriveReport({
      route: plan.trajectoryRoute,
      roads: state.geoJsonDataSets || [],
      buildings: state.buildingsGeoJSON || [],
      maskEdits: state.maskEdits || {},
      vehicleConfig: state.vehicleConfig || {},
      cargoLoadType: state.cargoLoadType,
      cargoCount: state.cargoCount,
      cruiseSpeedKmh: Number(document.getElementById('index3dSpeed')?.value || 18)
    })?.summary || null;
  } catch (_err) {
    autonomy = null;
  }
  const stopEvents = Number(autonomy?.stopEventCount) || 0;
  const slowEvents = Number(autonomy?.slowEventCount) || 0;
  const satRatio = Number(autonomy?.steeringSaturationRatio) || 0;
  const turnDeficit = Number(autonomy?.maxTurnRadiusDeficitM) || 0;
  const minAllowed = Number(autonomy?.minAllowedSpeedKmh);
  const autonomyRiskScore =
    stopEvents * 10000
    + slowEvents * 35
    + satRatio * 3000
    + turnDeficit * 900
    + (Number.isFinite(minAllowed) ? Math.max(0, 12 - minAllowed) * 120 : 0);
  let regulationAssessment = null;
  try {
    regulationAssessment = assessRegulationsForRoute({
      routeLL: plan.trajectoryRoute,
      regulations: mergeRegulationLayers(
        buildOsmRegulationLayer(state.geoJsonDataSets || []),
        getActiveExternalRegulations()
      ),
      vehicleConfig: state.vehicleConfig || {},
      options: {
        permitMode: getRoutePolicySettings().permitShortest,
        cargoLoadType: state.cargoLoadType,
        cargoCount: state.cargoCount,
        clearanceMargin: strict.clearanceMargin
      }
    });
  } catch (_err) {
    regulationAssessment = null;
  }
  const regulationRiskScore = regulationScorePenalty(regulationAssessment);
  const regulationSummary = regulationAssessment?.summary || {};
  const baseScore = Number.isFinite(metrics.score) ? metrics.score : Infinity;

  return {
    label,
    selectionRoute: plan.selectionRoute,
    route: plan.trajectoryRoute,
    score: baseScore,
    finalScore: Number.isFinite(baseScore) ? baseScore + autonomyRiskScore + regulationRiskScore : baseScore,
    autonomyRiskScore,
    autonomyStatus: autonomy?.status || null,
    autonomyStopEventCount: stopEvents,
    autonomySlowEventCount: slowEvents,
    autonomySteeringSaturationRatio: satRatio,
    autonomyMinAllowedSpeedKmh: Number.isFinite(minAllowed) ? minAllowed : null,
    autonomyMaxTurnRadiusDeficitM: Number.isFinite(turnDeficit) ? turnDeficit : 0,
    regulationRiskScore,
    regulationStatus: regulationAssessment?.status || 'pass',
    regulationBlockCount: Number(regulationSummary.blockCount) || 0,
    regulationPermitRequiredCount: Number(regulationSummary.permitRequiredCount) || 0,
    regulationWarningCount: Number(regulationSummary.warningCount) || 0,
    regulationIssueCount: Array.isArray(regulationAssessment?.issues) ? regulationAssessment.issues.length : 0,
    lengthMeters: Number.isFinite(metrics.lengthMeters) ? metrics.lengthMeters : 0,
    contactRatio: Number.isFinite(metrics.contactRatio) ? metrics.contactRatio : 0.5,
    contactCount: Number.isFinite(metrics.contactCount) ? metrics.contactCount : 0,
    tightestRadius: Number.isFinite(metrics.tightestRadius) ? metrics.tightestRadius : null,
    deviationMeters: Number.isFinite(metrics.deviationMeters) ? metrics.deviationMeters : 0
  };
}

async function runSingleVehicleAssessment(presetName) {
  const state = store.getState();
  if (!state.simRoute || state.simRoute.length < 2) return null;
  if (!routeConfirmed(state)) return null;

  const strict = getStrictRoadSettings();
  const vehicleConfig = { ...buildVehicleConfig(presetName), driverSkill: state.driverSkill };
  const widthMargin = getEffectiveWidthMargin(vehicleConfig, strict);

  const result = await runDeliveryAssessment({
    simRoute: state.simRoute,
    vehicleConfig,
    cargoLoadType: state.cargoLoadType,
    cargoCount: state.cargoCount,
    geoJsonDataSets: state.geoJsonDataSets,
    maskEdits: state.maskEdits,
    buildingsGeo: state.buildingsGeoJSON,
    endpoints: state.selectedEndpoints,
    vehiclePreset: presetName,
    driverSkill: state.driverSkill,
    defaultRoadWidth: strict.defaultRoadWidth,
    widthMargin,
    clearanceMargin: strict.clearanceMargin,
    coverageThreshold: strict.coverageThreshold,
    strictWidthMode: strict.strictMode,
    permitMode: getRoutePolicySettings().permitShortest,
    externalRegulations: getActiveExternalRegulations(),
    allowRouteAdjustment: false,
    maxAdjustIterations: ROUTE_ADJUSTMENT_MAX_ITERATIONS
  });

  if (!result) return null;

  multiAssessmentResults[presetName] = result;
  if (result?.sweep?.sweepGeo) {
    multiVehicleSweeps[presetName] = {
      sweepGeo: result.sweep.sweepGeo,
      outline: result.sweep.outline || null,
      trajectoriesGeo: result.sweep.trajectoriesGeo || null
    };
  }
  return result;
}

function open3DPreview() {
  if (GBA_3D_REMOVED) return;
  const state = store.getState();
  const wrap = document.getElementById('map3dWrap');
  if (!wrap) return;
  const wasOpen = wrap.classList.contains('open');
  wrap.classList.add('open');
  wrap.setAttribute('aria-hidden', 'false');
  // Inline fallback: keep it visible even if CSS gets overridden / not applied.
  wrap.style.display = 'flex';
  wrap.style.position = 'fixed';
  wrap.style.inset = '';
  wrap.style.right = '20px';
  wrap.style.bottom = '20px';
  wrap.style.width = 'min(920px, calc(100vw - 40px))';
  wrap.style.height = 'min(560px, calc(100vh - 140px))';
  wrap.style.zIndex = '5000';
  wrap.style.background = 'rgba(15, 23, 42, 0.92)';
  wrap.style.backdropFilter = 'blur(12px)';
  wrap.style.border = '1px solid var(--glass-border)';
  wrap.style.borderRadius = '16px';
  wrap.style.overflow = 'hidden';
  wrap.style.padding = '0';
  wrap.style.gap = '0';
  wrap.style.alignItems = 'stretch';
  wrap.style.justifyContent = 'stretch';

  const map3dEl = document.getElementById('map3d');
  if (map3dEl) {
    map3dEl.style.flex = '1 1 auto';
    map3dEl.style.minWidth = '0';
    map3dEl.style.borderRadius = '0';
    map3dEl.style.border = 'none';
    map3dEl.style.background = '#000';
    map3dEl.style.overflow = 'hidden';
  }

  const panelEl = document.getElementById('map3dPanel');
  if (panelEl) {
    panelEl.style.flex = '0 0 380px';
    panelEl.style.width = '380px';
    panelEl.style.maxWidth = '45%';
    panelEl.style.background = 'var(--glass-bg)';
    panelEl.style.border = '';
    panelEl.style.borderLeft = '1px solid var(--glass-border)';
    panelEl.style.borderRadius = '0';
    panelEl.style.boxShadow = 'none';
    panelEl.style.overflow = 'hidden';
    panelEl.style.display = 'flex';
    panelEl.style.flexDirection = 'column';
  }
  resizeMap3D();

  if (!wasOpen) toast('3Dプレビューを開きました');

  const roads = state.geoJsonDataSets || [];
  lastRoadSig3d = roadsSig(roads);
  setRoads3D(roads);

  if (!state.simRoute || state.simRoute.length < 2) {
    clearRoadSurface3D();
    updateGbaStatus();
    toast('3Dビューを更新するには先に経路を設定してください。');
    return;
  }

  lastRouteSig3d = routeSig(state.simRoute);
  setRoute3D(state.simRoute);
  fitRoute3D(state.simRoute);
  setCorridorRoads3D(roads, state.simRoute, { corridorMeters: 120 });
  syncRoadSurface3D(state);
  const stats = updateBuildingsForRoute(state.simRoute, { corridorMeters: getCorridorMeters() });
  updateGbaStatus(stats);
  scheduleAutoGbaLoad('open3d');
}

function close3DPreview() {
  if (GBA_3D_REMOVED) return;
  stop3D();
  const wrap = document.getElementById('map3dWrap');
  if (!wrap) return;
  wrap.classList.remove('open');
  wrap.setAttribute('aria-hidden', 'true');
  wrap.style.display = '';
  wrap.style.position = '';
  wrap.style.inset = '';
  wrap.style.right = '';
  wrap.style.bottom = '';
  wrap.style.width = '';
  wrap.style.height = '';
  wrap.style.zIndex = '';
  wrap.style.background = '';
  wrap.style.backdropFilter = '';
  wrap.style.padding = '';
  wrap.style.gap = '';
  wrap.style.border = '';
  wrap.style.borderRadius = '';
  wrap.style.overflow = '';
  wrap.style.alignItems = '';
  wrap.style.justifyContent = '';
}

function sync3D(state) {
  if (GBA_3D_REMOVED) return;
  if (!is3DOpen()) return;
  const roads = state.geoJsonDataSets || [];
  const rs = roadsSig(roads);
  if (rs !== lastRoadSig3d) {
    lastRoadSig3d = rs;
    setRoads3D(roads);
    if (state.simRoute && state.simRoute.length >= 2) {
      setCorridorRoads3D(roads, state.simRoute, { corridorMeters: 120 });
    }
  }
  syncRoadSurface3D(state);
  const sig = routeSig(state.simRoute);
  if (!sig) return;
  if (sig === lastRouteSig3d) return;
  lastRouteSig3d = sig;

  setRoute3D(state.simRoute);
  fitRoute3D(state.simRoute);
  setCorridorRoads3D(roads, state.simRoute, { corridorMeters: 120 });
  const stats = updateBuildingsForRoute(state.simRoute, { corridorMeters: getCorridorMeters() });
  updateGbaStatus(stats);
  scheduleAutoGbaLoad('route');
}

function renderCollisionHud(state) {
  const valueEl = document.getElementById('hudCollisionValue');
  const subEl = document.getElementById('hudCollisionSub');
  const card = document.getElementById('hudCollisionCard');
  if (!valueEl || !subEl) return;

  const results = state.collisionResults;
  if (card) card.classList.remove('ok', 'danger');

  if (!results || results.length === 0) {
    valueEl.textContent = '安全';
    if (card) card.classList.add('ok');
    subEl.textContent = '衝突なし';
    return;
  }

  const hits = results.filter(r => r.isHit);
  if (hits.length === 0) {
    valueEl.textContent = '安全';
    if (card) card.classList.add('ok');
    subEl.textContent = '衝突なし';
  } else {
    valueEl.textContent = `${hits.length} HIT`;
    if (card) card.classList.add('danger');
    subEl.textContent = `${hits.length} collision hits`;
  }
}

function syncHudVehicleInputs(state) {
  const full = state.vehiclePresetName;
  if (!full) return;
  const short = VEHICLE_PRESET_FULL_TO_SHORT[full] || full;

  // 上部バーは短縮キーとフルキーの両方に対応する。
  syncSelectValue(document.getElementById('vehiclePreset'), short, full);
  // Truck HUDはフルキーを保持する。
  syncSelectValue(document.getElementById('hudVehicleSelect'), full, short);
}

function renderCargoVisual(_state) {
  // No cargo SVG in current HTML - intentional no-op
}

function syncHiddenCargoFields(_state) {
  // No hidden cargo fields in current HTML - intentional no-op
}

function renderVehicleHud(state) {
  syncHudVehicleInputs(state);
  renderCargoVisual(state);
  syncHiddenCargoFields(state);
}

function updateHudFromAssessment(result) {
  if (!result) return;
  const feasEl = document.getElementById('hudFeasValue');
  if (feasEl) {
    feasEl.textContent = result.overallStatus || 'N/A';
    if (result.overallStatus === 'PASS') {
      feasEl.className = 'hud-value ok';
    } else if (result.overallStatus === 'NG') {
      feasEl.className = 'hud-value ng';
    }
  }
}

function syncAssessmentResultToUi(result, strictSettings = getStrictRoadSettings()) {
  if (!result) return;

  const currentState = store.getState();
  const resultRouteHash = routeHash(result.route || []);
  const currentRouteHash = routeHash(currentState.simRoute || []);
  if (resultRouteHash && resultRouteHash !== currentRouteHash) {
    store.setRoutePlan({
      selectionRoute: result.route,
      trajectoryRoute: result.route,
      candidates: currentState.routeCandidates || [],
      routeMeta: result.routeMeta || currentState.routeMeta || null
    });
  }

  const state = store.getState();
  store.setDeliveryAssessment(result);

  const contactFeatures =
    result?.contactFeasibility?.contactPoints?.features ||
    result?.collisionReport?.contactPoints?.features || [];
  const collisionPanelData = contactFeatures.map(f => ({
    isHit: true,
    lat: f.geometry?.coordinates?.[1],
    lng: f.geometry?.coordinates?.[0],
    reason: f.properties?.reason || 'road'
  }));
  store.setCollisionResults(collisionPanelData.length > 0 ? collisionPanelData : []);

  renderDeliveryResult(result);
  const resultPanel = document.getElementById('resultPanel');
  if (resultPanel) resultPanel.style.display = 'flex';
  updateHudFromAssessment(result);

  if (result?.sweep?.sweepGeo) {
    store.setSweepGeo({
      geo: result.sweep.sweepGeo,
      outline: result.sweep.outline || null,
      trajectoriesGeo: result.sweep.trajectoriesGeo || null
    });
    showSweep(result.sweep.sweepGeo);
    showTrajectory(result.sweep.trajectoriesGeo || null, result?.feasibility?.overflow || null);
  }

  const feas = result?.feasibility;
  if (!feas) return;
  store.setFeasibilityResult({
    generatedAt: new Date().toISOString(),
    status: feas.status,
    coverage: feas.coverage,
    threshold: Number.isFinite(feas.threshold) ? feas.threshold : strictSettings.coverageThreshold,
    vehicleConfig: state.vehicleConfig,
    selectedEndpoints: state.selectedEndpoints,
    simRoute: state.simRoute,
    sweep: result.sweep?.sweepGeo ? { geo: result.sweep.sweepGeo, outline: result.sweep.outline || null } : state._lastSweepGeo,
    resultGeo: {
      roadUnion: feas.roadUnion || null,
      intersect: feas.intersect || null,
      overflow: feas.overflow || null
    }
  });
  const layers = {
    roadUnion: feas.roadUnion || null,
    intersect: feas.intersect || null,
    overflow: feas.overflow || null,
    contactPoints: result?.collisionReport?.contactPoints || result?.contactFeasibility?.contactPoints || null
  };
  store.setFeasibilityLayers({
    roadUnion: layers.roadUnion,
    intersect: layers.intersect,
    overflow: layers.overflow,
    outline: result.sweep?.outline || null
  });
  showFeasibilityLayers(layers);
  renderFeasibilityReportBlock({
    status: feas.status,
    coverage: feas.coverage,
    threshold: Number.isFinite(feas.threshold) ? feas.threshold : strictSettings.coverageThreshold
  });
}

const GBA_WFS = {
  base: 'https://tubvsig-so2sat-vm1.srv.mwn.de/geoserver/ows',
  typeNames: 'global3D:lod1_global',
  maxCount: 8000
};

function buildGbaWfsUrlFromBbox(bbox, { count = GBA_WFS.maxCount } = {}) {
  if (!bbox || bbox.length !== 4) return null;
  const [minX, minY, maxX, maxY] = bbox;
  const params = new URLSearchParams({
    service: 'WFS',
    version: '2.0.0',
    request: 'GetFeature',
    typeNames: GBA_WFS.typeNames,
    outputFormat: 'application/json',
    srsName: 'EPSG:4326',
    bbox: `${minX},${minY},${maxX},${maxY},EPSG:4326`,
    count: String(Math.max(1, Math.min(GBA_WFS.maxCount, Number(count) || GBA_WFS.maxCount)))
  });
  return `${GBA_WFS.base}?${params.toString()}`;
}

function computeAutoGbaBbox(state) {
  try {
    if (state?.simRoute?.length >= 2 && typeof turf?.buffer === 'function') {
      const line = turf.lineString(state.simRoute.map((p) => [p.lng, p.lat]));
      const padM = Math.max(80, getCorridorMeters() + 60);
      const poly = turf.buffer(line, padM, { units: 'meters', steps: 8 });
      return turf.bbox(poly);
    }
  } catch (e) { }

  const map = getMapInstance();
  if (!map) return null;
  const b = map.getBounds();
  const diagM = map.distance(b.getSouthWest(), b.getNorthEast());
  if (diagM > 8000) return null;
  return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
}

function refreshGbaUrlInput(state = store.getState(), { force = false } = {}) {
  if (GBA_3D_REMOVED) return null;
  const bbox = computeAutoGbaBbox(state);
  if (!bbox) return null;
  const url = buildGbaWfsUrlFromBbox(bbox);
  const input = document.getElementById('gbaUrl');
  if (input && url) {
    const cur = input.value?.trim();
    if (force || !cur) input.value = url;
  }
  return url;
}

async function onAutoGbaWfs() {
  if (GBA_3D_REMOVED) return;
  const state = store.getState();
  const url = refreshGbaUrlInput(state, { force: true });
  if (!url) {
    toast('経路が短すぎます。ズームインして道路を先に読み込んでください。');
    return;
  }
  lastAutoGeneratedGbaUrl = url;
  toast('建物URLを自動生成しました（WFS）。');
  await onLoadGbaUrl();
}

async function onLoadGbaUrl() {
  if (GBA_3D_REMOVED) return;
  const input = document.getElementById('gbaUrl');
  const url = input?.value?.trim();
  if (!url) {
    toast('GeoJSON URLを入力してください');
    return;
  }
  try {
    const status = document.getElementById('gbaStatus');
    if (status) status.textContent = '建物: 読込中...';
    const json = await fetchJsonWithCorsFallback(url);
    setBuildingsAllGeoJSON(json);
    const state = store.getState();
    const stats = updateBuildingsForRoute(state.simRoute, { corridorMeters: getCorridorMeters() });
    updateGbaStatus(stats);
    toast(`建物を読み込みました: ${stats.total}件`);
  } catch (e) {
    console.warn('load buildings url failed', e);
    toast(`建物読込に失敗しました: ${e.message}`);
    updateGbaStatus();
  }
}

async function onLoadGbaFile(e) {
  if (GBA_3D_REMOVED) return;
  const file = e.target?.files?.[0];
  if (!file) return;
  try {
    const status = document.getElementById('gbaStatus');
    if (status) status.textContent = '建物: 読込中...';
    const text = await file.text();
    const json = JSON.parse(text);
    setBuildingsAllGeoJSON(json);
    const state = store.getState();
    const stats = updateBuildingsForRoute(state.simRoute, { corridorMeters: getCorridorMeters() });
    updateGbaStatus(stats);
    toast(`建物を読み込みました: ${stats.total}件`);
  } catch (err) {
    console.warn('load buildings file failed', err);
    toast(`建物ファイルの読込に失敗しました: ${err.message}`);
    updateGbaStatus();
  } finally {
    try {
      e.target.value = '';
    } catch (ignore) { }
  }
}

async function onPlay3D() {
  if (GBA_3D_REMOVED) return;
  const state = store.getState();
  if (!state.simRoute || state.simRoute.length < 2) {
    toast('先に経路を設定してください');
    return;
  }
  if (!is3DOpen()) open3DPreview();

  coordinateSystem.setOrigin(state.simRoute[0].lat, state.simRoute[0].lng);
  const pathM = state.simRoute.map((ll) => coordinateSystem.latLngToMeters(ll.lat, ll.lng));
  const strideMeters = 0.8;
  const simPoses = simulatePathPoses(state.vehicleConfig, pathM, strideMeters);
  if (!simPoses.length) {
    toast('3Dシミュレーションを開始できませんでした');
    return;
  }
  const roadUnionGeo = getRoadUnionGeoFor3D(state);
  play3D(simPoses, state.vehicleConfig, {
    strideMeters,
    speedMultiplier: getPlaybackSpeedMultiplier(),
    cameraFps: 60,
    roadUnionGeo,
    obstaclesGeo: get3DCollisionObstaclesGeo(state)
  });
}

// 衛星画像YOLOによる道路幅推定。経路確定前の候補評価からも呼び出せる。
async function runSatelliteYoloEstimate({
  silent = false,
  routeOverride = null,
  sampleSurroundingRoads = true,
  corridorMeters = 80,
  maxFrames = 70
} = {}) {
  const state = store.getState();
  const routeForSampling = Array.isArray(routeOverride) && routeOverride.length >= 2 ? routeOverride : state.simRoute;
  if (!routeForSampling || routeForSampling.length < 2) {
    if (!silent) toast('先に経路を設定してください');
    return { applied: false, appliedRoads: 0, total: 0 };
  }
  // キャッシュからYOLO状態確認（HTTPリクエストなし）
  const _cachedSat = getCachedYoloAlive();
  const yoloAlive = _cachedSat !== null ? _cachedSat : await checkYoloServerStatus();
  if (!yoloAlive) {
    if (!silent) toast('YOLOサーバーが起動していません (port 8001)');
    return { applied: false, appliedRoads: 0, total: 0 };
  }
  const statusEl = document.getElementById('satYoloStatus');
  const spacing = parseInt(document.getElementById('satYoloSpacing')?.value) || 30;
  const zoom = parseInt(document.getElementById('satYoloZoom')?.value) || 20;
  const apiBase = getAnalysisApiBase();

  if (statusEl) statusEl.textContent = '衛星画像を解析中...';

  try {
    const samplePlan = buildSatelliteYoloSamplePlan(state, routeForSampling, {
      spacing,
      zoom,
      sampleSurroundingRoads,
      corridorMeters,
      maxFrames
    });
    const samplePoints = samplePlan.samples;
    if (!samplePoints.length) {
      if (!silent) toast('衛星YOLO: サンプル地点がありません');
      if (statusEl) statusEl.textContent = '衛星YOLOのサンプル地点がありません';
      return { applied: false, appliedRoads: 0, total: 0, reason: 'no_samples' };
    }

    if (statusEl) {
      const modeText = samplePlan.mode === 'surrounding-roads'
        ? `周辺道路 ${samplePlan.sampledRoads}本`
        : '経路';
      statusEl.textContent = `${samplePoints.length}枚の衛星画像（${modeText}）をYOLO解析中...`;
    }

    // Google Maps APIキーを取得する。
    const keyScript = document.querySelector('script[src*="maps.googleapis.com/maps/api/js"]');
    let gmapKey = '';
    if (keyScript) { try { gmapKey = new URL(keyScript.src).searchParams.get('key') || ''; } catch (e) { } }

    // バッチAPI用に高解像度のStatic Map URLを生成する。
    const batchItems = samplePoints.map((p, i) => ({
      id: `sat_${i}`,
      image_url: `https://maps.googleapis.com/maps/api/staticmap?center=${p.lat},${p.lng}&zoom=${zoom}&size=256x256&maptype=satellite&key=${gmapKey}`,
      lat: p.lat,
      lng: p.lng,
      heading: p.heading ?? 0,
      zoom,
      featureId: p.featureId || null,
      source: p.source || 'route'
    }));
    const batchItemById = new Map(batchItems.map((item) => [item.id, item]));

    const curState = store.getState();
    const widthByFeature = new Map();
    // バッチを最大48件ずつ送る。
    const BATCH_SIZE = 48;
    for (let b = 0; b < batchItems.length; b += BATCH_SIZE) {
      const chunk = batchItems.slice(b, b + BATCH_SIZE);
      try {
        const resp = await fetch(`${apiBase}/detect-batch`, {
          method: 'POST',
          headers: yoloAuthHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ items: chunk, conf: 0.2 })
        });
        if (!resp.ok) continue;
        const data = await resp.json();
        // 衛星画像の解像度から1pxあたりのメートルを推定する。
        for (const item of (data.items || [])) {
          if (item.error || !item.detections?.length) continue;
          const src = batchItemById.get(item.id) || {};
          const mergedItem = {
            ...src,
            ...item,
            lat: Number(item.lat ?? src.lat),
            lng: Number(item.lng ?? src.lng),
            heading: Number(item.heading ?? src.heading ?? 0),
            zoom: Number(item.zoom ?? src.zoom ?? zoom)
          };
          // 車両系検出の位置から道路幅を推定する。
          const pt = turf.point([mergedItem.lng, mergedItem.lat]);
          let nearest = null;
          let minDist = Infinity;
          if (mergedItem.featureId) {
            nearest = (curState.geoJsonDataSets || []).find((f) => featureIdOf(f) === String(mergedItem.featureId)) || null;
            minDist = nearest ? 0 : Infinity;
          }
          if (!nearest) {
            for (const f of curState.geoJsonDataSets || []) {
              if (!f?.geometry) continue;
              const geomType = f.geometry.type;
              if (geomType !== 'LineString' && geomType !== 'MultiLineString') continue;
              try {
                const d = turf.pointToLineDistance(pt, f, { units: 'meters' });
                if (d < minDist) {
                  minDist = d;
                  nearest = f;
                }
              } catch (e) { }
            }
          }
          // 車両の占有幅とマージンから道路幅を推定する。
          if (!nearest || !Number.isFinite(minDist) || minDist > SATELLITE_YOLO_WIDTH_OPTIONS.nearestRoadMaxDistM) continue;
          const fid = featureIdOf(nearest);
          if (!fid) continue;
          const priorWidth = getWidthPriorMeters(nearest);
          const estimated = estimateSatelliteRoadWidth(mergedItem, priorWidth);
          if (!estimated?.width || !Number.isFinite(estimated.width)) continue;
          if (!widthByFeature.has(fid)) widthByFeature.set(fid, []);
          widthByFeature.get(fid).push(estimated.width);
        }
      } catch (e) { /* skip failed batch */ }
      if (statusEl) statusEl.textContent = `解析中... ${Math.min(b + BATCH_SIZE, batchItems.length)}/${batchItems.length}`;
    }

    // 推定幅を最寄りの道路featureに適用する。
    if (widthByFeature.size > 0 && curState.geoJsonDataSets) {
      // AI=width_ai として適用（手動上書き userOverrideWidth とは分離）。
      const aiWidthMap = {};
      widthByFeature.forEach((vals, fid) => {
        const w = median(vals);
        if (!Number.isFinite(w)) return;
        aiWidthMap[String(fid)] = Number(w.toFixed(2));
      });
      const appliedIds = Object.keys(aiWidthMap);
      if (appliedIds.length) {
        store.applyPerceptionWidthAi(aiWidthMap);
        satelliteYoloAppliedIds = Array.from(new Set([...satelliteYoloAppliedIds, ...appliedIds]));
      }
      const applied = appliedIds.length;
      const total = Array.from(widthByFeature.values()).reduce((sum, vals) => sum + vals.length, 0);
      if (!silent) toast(`衛星YOLO: ${total}件解析、${applied}本道路更新`);
      if (statusEl) statusEl.textContent = `完了: ${applied}本道路更新（採用 ${total}件）`;
      return {
        applied: applied > 0,
        appliedRoads: applied,
        total,
        sampleMode: samplePlan.mode,
        sampledRoads: samplePlan.sampledRoads,
        sampledFrames: samplePoints.length
      };
    } else {
      if (!silent) toast('衛星YOLO: 結果が返りませんでした');
      if (statusEl) statusEl.textContent = '結果なし。APIサーバーを確認してください。';
      return { applied: false, appliedRoads: 0, total: 0 };
    }
  } catch (e) {
    console.error('satellite YOLO error:', e);
    if (!silent) toast(`衛星YOLOエラー: ${e.message}`);
    if (statusEl) statusEl.textContent = `エラー: ${e.message}`;
    return { applied: false, appliedRoads: 0, total: 0, error: e.message };
  }
}

export function initControls() {
  renderThemeToggle();
  initWorkflowControls();
  disable3DUI();
  const yoloApiInput = document.getElementById('yoloApiBase');
  if (yoloApiInput && !String(yoloApiInput.value || '').trim() && RUNTIME_CONFIG.yoloServerUrl) {
    yoloApiInput.value = RUNTIME_CONFIG.yoloServerUrl.replace(/\/$/, '');
  }
  window.addEventListener(THEME_CHANGE_EVENT, renderThemeToggle);
  document.getElementById('toggleTheme')?.addEventListener('click', () => {
    const next = toggleTheme();
    renderThemeToggle();
    toast(next === 'dark' ? 'ダークモード ON' : 'ライトモード ON');
  });

  const runRoadRefresh = () => loadRoadsForView().catch((e) => toast(e.message));
  document.getElementById('refresh-data')?.addEventListener('click', runRoadRefresh);
  document.getElementById('topRefreshData')?.addEventListener('click', runRoadRefresh);
  
  const dsSelect = document.getElementById('roadDataSource');
  if (dsSelect) {
    dsSelect.value = store.getState().roadDataSource || 'hybrid';
    dsSelect.addEventListener('change', (e) => {
      store.setRoadDataSource(e.target.value);
    });
  }

  document.getElementById('full-reset')?.addEventListener('click', fullReset);
  document.getElementById('strictWidthMode')?.addEventListener('change', renderStrictWidthControls);
  document.getElementById('strictWidthExtra')?.addEventListener('input', renderStrictWidthControls);
  renderStrictWidthControls();
  document.getElementById('permitShortestRoute')?.addEventListener('change', handleRoutePolicyChange);
  renderRoutePolicyControls();

  const svStatusEl = document.getElementById('svStatus');
  if (svStatusEl) {
    const observer = new MutationObserver(() => syncSvQuickStatus());
    observer.observe(svStatusEl, { childList: true, subtree: true, characterData: true });
  }
  syncSvQuickStatus();

  // YOLOサーバー状態ポーリング。状態表示UIがある画面、または明示フラグがある場合だけ動かす。
  // V2.0では常時表示していないため、未起動サーバーへの /status 連打を避ける。
  let _yoloPollFailCount = 0;
  async function _yoloPoll() {
    const alive = await checkYoloServerStatus();
    _yoloPollFailCount = alive ? 0 : _yoloPollFailCount + 1;
    // 起動中: 10s、1回目失敗: 15s、2回目: 20s、3回目以降: 60s
    const delay = alive ? 10000 : Math.min(60000, 10000 + _yoloPollFailCount * 5000);
    setTimeout(_yoloPoll, delay);
  }
  const shouldPollYolo = !!document.getElementById('yoloServerLabel')
    || !!document.getElementById('yoloServerDot')
    || (typeof window !== 'undefined' && window.INDEX3D_POLL_YOLO_STATUS === true);
  if (shouldPollYolo) _yoloPoll();
  document.getElementById('yoloServerCheck')?.addEventListener('click', () => checkYoloServerStatus());
  document.getElementById('yoloServerStart')?.addEventListener('click', () => startYoloViaWebServer());

  document.getElementById('svRunQuick')?.addEventListener('click', async () => {
    const state = store.getState();
    if (!state.simRoute || state.simRoute.length < 2) {
      toast('先に経路を設定してください');
      return;
    }
    const btn = document.getElementById('svRunQuick');
    const oldText = btn?.textContent;
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'SV実行中...';
    }
    try {
      const widthRes = await runSvYoloWidthPipeline();
      if (widthRes?.applied) toast(`SV/YOLO幅更新: ${widthRes.appliedRoads}本`);
      else toast('SV/YOLO幅更新は適用されませんでした');
    } catch (e) {
      toast(`SV/YOLOエラー: ${e.message}`);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = oldText || 'SV+YOLO幅';
      }
      syncSvQuickStatus();
    }
  });

  // 設定パネルの開閉。
  document.getElementById('toggleSettingsPanel')?.addEventListener('click', () => {
    const panel = document.getElementById('sidePanel');
    if (!panel) return;
    panel.classList.toggle('open');
    panel.setAttribute('aria-hidden', panel.classList.contains('open') ? 'false' : 'true');
  });
  document.getElementById('closeSettingsPanel')?.addEventListener('click', () => {
    const panel = document.getElementById('sidePanel');
    if (!panel) return;
    // aria-hidden=true を付ける前にパネル内のフォーカスを外す（aria-hidden + focus 警告の回避）
    if (panel.contains(document.activeElement)) {
      try { document.activeElement.blur(); } catch (e) { }
    }
    panel.classList.remove('open');
    panel.setAttribute('aria-hidden', 'true');
  });

  // 搬入判定パネル。
  initDeliveryPanel({
    onRun: async () => {
      const state0 = store.getState();
      if (!state0.simRoute || state0.simRoute.length < 2) {
        toast('先に経路を設定してください');
        return;
      }
      if (!routeConfirmed(state0)) {
        toast('先に経路を確定してください。未確定または再計算中の経路は判定しません。');
        return;
      }
      const strict = getStrictRoadSettings();
      const effectiveWidthMargin = getEffectiveWidthMargin(state0.vehicleConfig, strict);
      const autoSvWidth = !!document.getElementById('autoSvWidthOnDelivery')?.checked;
      const autoSatYolo = !!document.getElementById('autoSatYoloOnDelivery')?.checked;
      const svSteps = autoSvWidth ? 3 : 0;
      const satSteps = autoSatYolo ? 1 : 0;
      const totalSteps = 1 + 1 + svSteps + satSteps + 6; // wide + buildings + sv + sat + sweep/feas/assess/satVerify/yoloRecheck/render/done
      let step = 0;
      let stepLabel = 1;

      window._isAssessing = true;
      // V9: 判定開始前に過去のフリート結果と sweep レイヤーをクリア（重なり表示を防ぐ）
      clearMultiVehicleCaches();
      clearSweepLayers();
      clearFeasibilityLayers();
      clearRegulationLayer();
      hideVehicleSweepTabs();
      // Update workflow step 4 to show "実行中"
      const _wfState4 = document.getElementById('wfState4');
      const _wfStep4  = document.getElementById('wfStep4');
      if (_wfState4) _wfState4.textContent = '⏳ 実行中...';
      if (_wfStep4)  { _wfStep4.classList.remove('done'); _wfStep4.classList.add('active'); }

      setDeliveryProgress({ step, total: totalSteps, label: '判定準備中...', active: true });
      try {
        // 前回のYOLO障害物マーカーをクリアする。
        store.clearMaskEdits();

        // 周辺道路を取得する。
        setDeliveryProgress({ step: ++step, total: totalSteps, label: '広域道路データを確認中...', active: true });
        if (shouldReloadWideRoadData(state0)) {
          try {
            await loadRoadsWideArea(state0.simRoute);
          } catch (e) {
            console.warn('wide road load skipped:', e.message);
            toast(MSG.roadFetchFail({ error: e }).combined);
          }
        }
        // 道路データが空のまま判定に進むと全接触NGになるため警告
        {
          const dsAfterLoad = store.getState().geoJsonDataSets;
          if (!dsAfterLoad || dsAfterLoad.length === 0) {
            toast(MSG.roadDataMissing().combined);
          }
        }

        // Keep user-confirmed route stable during assessment.
        // If route is missing, calculate once as fallback.
        {
          const stateForRoute = store.getState();
          if ((!stateForRoute.simRoute || stateForRoute.simRoute.length < 2) && stateForRoute.selectedEndpoints.length >= 2) {
            try {
              const recomputed = await computeRouteFromEndpoints(stateForRoute, { silent: true });
              applyRoutePlan(recomputed);
            } catch (_) { /* fall back to existing route */ }
          }
        }

        if (autoSvWidth) {
          const svStepStart = step;
          // キャッシュからYOLO状態確認（HTTPリクエストなし）
          const _cachedSv = getCachedYoloAlive();
          const yoloAlive = _cachedSv !== null ? _cachedSv : await checkYoloServerStatus();
          if (!yoloAlive) {
            toast(MSG.yoloOffline().combined);
            step = svStepStart + svSteps;
            stepLabel += svSteps;
          } else
            try {
              setDeliveryProgress({ step: ++step, total: totalSteps, label: `${stepLabel}. Street View スキャン中...`, active: true });
              stepLabel++;
              await scanStreetView();

              setDeliveryProgress({ step: ++step, total: totalSteps, label: `${stepLabel}. YOLO 解析中...`, active: true });
              stepLabel++;
              await analyzeStreetView();

              setDeliveryProgress({ step: ++step, total: totalSteps, label: `${stepLabel}. SV幅員を反映中...`, active: true });
              stepLabel++;
              const widthRes = applyDetectionsToWidths();
              if (widthRes?.applied) {
                toast(`SV/YOLOで幅員を更新: ${widthRes.appliedRoads}件`);
              }
              syncSvQuickStatus();
            } catch (svErr) {
              // YOLOサーバー未起動などでも判定は継続する。
              console.warn('SV/YOLO skipped:', svErr.message);
              toast('SV/YOLO はスキップされました');
              step = svStepStart + svSteps; // SVの全ステップを進める
              stepLabel += Math.max(0, svSteps - (step - svStepStart));
            }
        }

        // 衛星画像YOLO: SV/YOLOで幅を取れなかった道路を衛星画像で補完する。
        if (autoSatYolo) {
          setDeliveryProgress({ step: ++step, total: totalSteps, label: `${stepLabel}. 衛星YOLO幅員推定中...`, active: true });
          stepLabel++;
          try {
            const satRes = await runSatelliteYoloEstimate({ silent: true });
            if (satRes?.applied) {
              toast(`衛星YOLOで幅員を更新: ${satRes.appliedRoads}件`);
            }
          } catch (e) {
            console.warn('satellite YOLO skipped:', e.message);
          }
        }

        setDeliveryProgress({ step: ++step, total: totalSteps, label: `${stepLabel}. 軌跡生成中...`, active: true });
        stepLabel++;
        drawSweep();

        setDeliveryProgress({ step: ++step, total: totalSteps, label: `${stepLabel}. 道路適合チェック中...`, active: true });
        stepLabel++;
        const stateAfterSweep = store.getState();
        const sweepGeo = stateAfterSweep._lastSweepGeo?.geo;
        if (sweepGeo) {
          const feasRes = analyzeFeasibility({
            sweepGeo,
            geoJsonDataSets: stateAfterSweep.geoJsonDataSets,
            defaultRoadWidth: strict.defaultRoadWidth,
            clearanceMargin: strict.clearanceMargin,
            coverageThreshold: strict.coverageThreshold,
            vehicleWidth: stateAfterSweep.vehicleConfig.vehicleWidth,
            widthMargin: effectiveWidthMargin,
            maskEdits: stateAfterSweep.maskEdits,
            buildingsGeoJSON: stateAfterSweep.buildingsGeoJSON,
            strictWidthMode: strict.strictMode
          });
          if (feasRes) {
            store.setFeasibilityResult({
              generatedAt: new Date().toISOString(),
              status: feasRes.status,
              coverage: feasRes.coverage,
              threshold: feasRes.threshold,
              vehicleConfig: stateAfterSweep.vehicleConfig,
              selectedEndpoints: stateAfterSweep.selectedEndpoints,
              simRoute: stateAfterSweep.simRoute,
              sweep: stateAfterSweep._lastSweepGeo,
              resultGeo: { roadUnion: feasRes.roadUnion, intersect: feasRes.intersect, overflow: feasRes.overflow }
            });
            const outline = stateAfterSweep._lastSweepGeo?.outline;
            store.setFeasibilityLayers({
              roadUnion: feasRes.roadUnion,
              intersect: feasRes.intersect,
              overflow: feasRes.overflow,
              outline
            });
            showFeasibilityLayers({ roadUnion: feasRes.roadUnion, intersect: feasRes.intersect, overflow: feasRes.overflow, contactPoints: feasRes.contactPoints });
            renderFeasibilityReportBlock(feasRes);
          }
        }

        setDeliveryProgress({ step: ++step, total: totalSteps, label: `${stepLabel}. 搬入判定を実行中...`, active: true });
        stepLabel++;

        const state = store.getState();
        let result = await runDeliveryAssessment({
          simRoute: state.simRoute,
          vehicleConfig: state.vehicleConfig,
          cargoLoadType: state.cargoLoadType,
          cargoCount: state.cargoCount,
          geoJsonDataSets: state.geoJsonDataSets,
          maskEdits: state.maskEdits,
          buildingsGeo: state.buildingsGeoJSON,
          endpoints: state.selectedEndpoints,
          vehiclePreset: state.vehiclePresetName,
          driverSkill: state.driverSkill,
          defaultRoadWidth: strict.defaultRoadWidth,
          widthMargin: effectiveWidthMargin,
          clearanceMargin: strict.clearanceMargin,
          coverageThreshold: strict.coverageThreshold,
          strictWidthMode: strict.strictMode,
          permitMode: getRoutePolicySettings().permitShortest,
          externalRegulations: getActiveExternalRegulations(),
          allowRouteAdjustment: false,
          maxAdjustIterations: ROUTE_ADJUSTMENT_MAX_ITERATIONS
        });

        // 衛星画像セグメンテーションで、はみ出し判定を再確認する。
        setDeliveryProgress({ step: ++step, total: totalSteps, label: `${stepLabel}. 衛星画像で接触点を再確認中...`, active: true });
        stepLabel++;
        {
          const overflowPoints =
            result?.collisionReport?.contactPoints ||
            result?.contactFeasibility?.contactPoints ||
            null;
          if (overflowPoints) {
            const keyScript = document.querySelector('script[src*="maps.googleapis.com/maps/api/js"]');
            let gmKey = '';
            if (keyScript) { try { gmKey = new URL(keyScript.src).searchParams.get('key') || ''; } catch (e) { } }
            const satApiBase = getAnalysisApiBase();
            const _cachedVerify = getCachedYoloAlive();
            const satYoloAlive = _cachedVerify !== null ? _cachedVerify : await checkYoloServerStatus();
            if (!satYoloAlive) {
              console.info('[verifySatelliteOverflow] YOLOサーバー未起動のためスキップ');
            } else
              try {
                const verifyRes = await verifySatelliteOverflow({
                  contactPoints: overflowPoints,
                  googleMapsKey: gmKey,
                  apiBase: satApiBase
                });
                if (verifyRes.dismissed > 0) {
                  toast(`衛星確認: ${verifyRes.dismissed}/${verifyRes.verified} 件を誤検知として除外`);
                  // 衝突レポートの接触数を補正する。
                  if (result.collisionReport) {
                    result.collisionReport.contactCount = Math.max(0, result.collisionReport.contactCount - verifyRes.dismissed);
                    result.collisionReport.contactRatio = result.collisionReport.totalSamples > 0
                      ? result.collisionReport.contactCount / result.collisionReport.totalSamples
                      : 0;
                    if (result.collisionReport.contactCount === 0) result.collisionReport.status = 'OK';
                  }
                  if (result.contactFeasibility) {
                    result.contactFeasibility.contactCount = Math.max(0, result.contactFeasibility.contactCount - verifyRes.dismissed);
                    result.contactFeasibility.contactRatio = result.contactFeasibility.totalSamples > 0
                      ? result.contactFeasibility.contactCount / result.contactFeasibility.totalSamples
                      : 0;
                    if (result.contactFeasibility.contactCount === 0) result.contactFeasibility.status = 'OK';
                  }
                  // overallStatusを再評価する。
                  const feasOk = !result.feasibility || result.feasibility.status === 'OK';
                  const collOk = !result.collisionReport || result.collisionReport.status === 'OK';
                  const contOk = !result.contactFeasibility || result.contactFeasibility.status === 'OK';
                  if (feasOk && collOk && contOk) result.overallStatus = 'PASS';
                  else if (feasOk || collOk) result.overallStatus = 'CONDITIONAL';
                }
              } catch (satErr) {
                console.warn('satellite overflow verification skipped:', satErr.message);
              }
          }
        }

        // If still not PASS, confirm again with YOLO-derived widths on the same trajectory.
        if (result?.overallStatus !== 'PASS') {
          setDeliveryProgress({ step: ++step, total: totalSteps, label: `${stepLabel}. YOLO根拠で再評価中...`, active: true });
          stepLabel++;
          try {
            const yoloReassessed = await reassessWithYoloEvidence({
              strictSettings: strict,
              runSv: !autoSvWidth,
              runSat: !autoSatYolo
            });
            const better = pickBetterAssessmentResult(result, yoloReassessed);
            if (better !== result) {
              toast(`YOLO再評価で判定更新: ${result.overallStatus} -> ${better.overallStatus}`);
              result = better;
            }
          } catch (e) {
            console.warn('yolo reassess skipped:', e.message);
          }
        }



        setDeliveryProgress({ step: ++step, total: totalSteps, label: `${stepLabel}. 結果を反映中...`, active: true });
        stepLabel++;
        store.setDeliveryAssessment(result);
        // COLLISION パネルを搬入判定の接触結果で更新
        {
          const contactFeatures =
            result?.contactFeasibility?.contactPoints?.features ||
            result?.collisionReport?.contactPoints?.features || [];
          const collisionPanelData = contactFeatures.map(f => ({
            isHit: true,
            lat: f.geometry?.coordinates?.[1],
            lng: f.geometry?.coordinates?.[0],
            reason: f.properties?.reason || 'road'
          }));
          store.setCollisionResults(collisionPanelData.length > 0 ? collisionPanelData : []);
        }
        renderDeliveryResult(result);
        showRegulationIssues(result.regulationAssessment);
        const resultPanel = document.getElementById('resultPanel');
        if (resultPanel) resultPanel.style.display = 'flex';
        updateHudFromAssessment(result);
        if (result?.sweep?.sweepGeo) {
          store.setSweepGeo({ geo: result.sweep.sweepGeo, outline: result.sweep.outline || null, trajectoriesGeo: result.sweep.trajectoriesGeo || null });
          // 薄い塗りつぶしでスイープを表示する。
          showSweep(result.sweep.sweepGeo);
          // overflow領域は別色で表示する。
          const overflowGeo = result?.feasibility?.overflow || null;
          showTrajectory(result.sweep.trajectoriesGeo || null, overflowGeo);
        }


        const feas = result?.feasibility;
        if (feas) {
          store.setFeasibilityResult({
            generatedAt: new Date().toISOString(),
            status: feas.status,
            coverage: feas.coverage,
            threshold: Number.isFinite(feas.threshold) ? feas.threshold : strict.coverageThreshold,
            vehicleConfig: state.vehicleConfig,
            selectedEndpoints: state.selectedEndpoints,
            simRoute: state.simRoute,
            sweep: result.sweep?.sweepGeo ? { geo: result.sweep.sweepGeo, outline: result.sweep.outline || null } : state._lastSweepGeo,
            resultGeo: {
              roadUnion: feas.roadUnion || null,
              intersect: feas.intersect || null,
              overflow: feas.overflow || null
            }
          });
          const layers = {
            roadUnion: feas.roadUnion || null,
            intersect: feas.intersect || null,
            overflow: feas.overflow || null,
            contactPoints: result?.collisionReport?.contactPoints || result?.contactFeasibility?.contactPoints || null
          };
          store.setFeasibilityLayers({
            roadUnion: layers.roadUnion,
            intersect: layers.intersect,
            overflow: layers.overflow,
            outline: result.sweep?.outline || null
          });
          showFeasibilityLayers(layers);
          renderFeasibilityReportBlock({
            status: feas.status,
            coverage: feas.coverage,
            threshold: Number.isFinite(feas.threshold) ? feas.threshold : strict.coverageThreshold
          });
        }

        // 迂回試行は廃止（ユーザー指定の経路をそのまま判定する）。

        setDeliveryProgress({ step: totalSteps, total: totalSteps, label: '判定の最終処理中...', active: true });
        // Detour trials may replace `result` after the first render. Always sync the final
        // adopted assessment route, sweep, contact points, and result panel back to the UI.
        syncAssessmentResultToUi(result, strict);

        toast(MSG.assessmentResult({
          status: result.overallStatus,
          violationsCount: Array.isArray(result.violations) ? result.violations.length : 0
        }).combined);
        const stFinal = store.getState();
        showRoadWidths(stFinal.geoJsonDataSets || [], stFinal.widthOverrides || {});

        // V9: フリート判定を無効化（複数車両スイープが重なって視認性が悪くなるため）
        hideVehicleSweepTabs();

      } catch (e) {
        console.error('delivery assessment failed', e);
        toast(MSG.assessmentFailed({ error: e }).combined);
      } finally {
        window._isAssessing = false;
        // _isAssessing を false にした後、ワークフロー表示を即再描画して
        // 「搬入判定を実行中です...」のガイド/ヒントを確実に切り替える（完了後に残らないように）。
        try { renderWorkflowDock(store.getState()); } catch (_) {}
        setTimeout(() => {
          setDeliveryProgress({ step: 0, total: 1, label: '', active: false });
        }, 350);
      }
    },
    onApplyRoute: (result) => {
      if (result?.route?.length >= 2) {
        lastConfirmedRouteHash = '';
        {
          const stable = stabilizeRoutePoints(result.route);
          store.setRoutePlan({ selectionRoute: stable, trajectoryRoute: stable });
        }
        toast('提案ルートを適用しました');
      }
    },
    onSaveResult: (result) => {
      if (!result) return;
      const blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `delivery_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast('判定結果を保存しました');
    },
    onPrintReport: (result) => {
      if (!result) return;
      const state = store.getState();
      exportDeliveryReport(result, state.vehicleConfig, state.vehiclePresetName);
    }
  });

  // UI-G: 判定結果パネルの「次のアクション」ボタン受信ハンドラ
  // deliveryPanel.js が CustomEvent('delivery-next-action') を発火する。
  const VEHICLE_DOWNGRADE_MAP = {
    'trailer_15t': '10t_unic',
    '10t_unic': '4t_flat',
    '4t_flat': '3t_flat',
    '4t_unic': '3t_unic',
    '3t_flat': '2t_flat',
    '3t_unic': '2t_unic'
  };
  document.addEventListener('delivery-next-action', (ev) => {
    const action = ev?.detail?.action;
    if (!action) return;
    if (action === 'smaller-vehicle') {
      const cur = store.getState().vehiclePresetName;
      const next = VEHICLE_DOWNGRADE_MAP[cur];
      if (next) {
        try { store.applyVehiclePreset(next); } catch (e) { console.warn('downgrade preset failed', e); }
        toast(`車両を ${next} に切り替えました。上部の「搬入判定を実行」で再判定してください。`);
      } else {
        toast('これ以上小さい車両プリセットはありません。');
      }
    } else if (action === 'review-route') {
      toast('地図上で端点（出発点・目的地）をクリックし直して経路を引き直してください。');
    } else if (action === 'check-overhead') {
      toast('Street View で頭上の障害物（電線・看板・庇）を確認してください。');
    }
  });

  document.getElementById('nominatim-search')?.addEventListener('click', onSearch);
  document.getElementById('search-button')?.addEventListener('click', onSearch);
  document.getElementById('search-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') onSearch();
  });
  // サイドパネル「地番→住所」
  document.getElementById('bluemap-button')?.addEventListener('click', onBluemapConvert);
  document.getElementById('bluemap-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') onBluemapConvert();
  });
  // トップバー「地番→住所」
  document.getElementById('chiban-button')?.addEventListener('click', () => onChibanToAddress());
  document.getElementById('chiban-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') onChibanToAddress();
  });
  // パネル表示時にZIPS設定状態を表示する。
  {
    const hasZips = !!ZIPS_CONFIG.enabled;
    setChibanStatus(hasZips
      ? 'ZIPS API: 設定済み'
      : 'ZIPS API: 未設定（config/runtime.local.json または環境変数で設定）'
    );
  }
  document.getElementById('osrm-route')?.addEventListener('click', onOsrmRoute);
  document.getElementById('saveFeasibility')?.addEventListener('click', saveFeasibility);

  // 衛星YOLO道路幅推定。搬入判定からも呼び出せる。
  document.getElementById('satelliteYoloEstimate')?.addEventListener('click', () => runSatelliteYoloEstimate());

  // SVオーバーレイボタンの配線。
  document.getElementById('svScanOverlay')?.addEventListener('click', () => {
    document.getElementById('svScan')?.click();
  });
  document.getElementById('svDriveOverlay')?.addEventListener('click', () => {
    document.getElementById('svDrive')?.click();
  });
  document.getElementById('svStopOverlay')?.addEventListener('click', () => {
    document.getElementById('svStop')?.click();
  });

  document.getElementById('playbackSpeed')?.addEventListener('input', renderPlaybackSpeed);
  document.getElementById('driverSkill')?.addEventListener('input', renderDriverSkill);
  renderPlaybackSpeed();
  renderDriverSkill();
  renderBuildingsPrefs();
  renderObstacleControls();
  renderObstacleStatus(store.getState());
  syncPlateauUrlInputs();
  renderPlateauStatus();
  syncObstacles3D(store.getState());
  document.getElementById('obstacleRadius')?.addEventListener('input', renderObstacleControls);
  document.getElementById('obstacleHeight')?.addEventListener('input', renderObstacleControls);
  document.getElementById('toggleObstacleMode')?.addEventListener('click', () => {
    const btn = document.getElementById('toggleObstacleMode');
    const next = btn ? !btn.classList.contains('active') : true;
    if (btn) btn.classList.toggle('active', next);
    if (next) {
      const manualBtn = document.getElementById('toggleManualEndpointMode');
      if (manualBtn?.classList.contains('active')) setManualAddMode(false);
      store.setWidthEditMode(false);
    }
    setObstacleAddMode(next);
  });
  document.getElementById('toggleObstaclePolygonMode')?.addEventListener('click', () => {
    const btn = document.getElementById('toggleObstaclePolygonMode');
    const next = btn ? !btn.classList.contains('active') : true;
    if (next) {
      const manualBtn = document.getElementById('toggleManualEndpointMode');
      if (manualBtn?.classList.contains('active')) setManualAddMode(false);
      setObstacleAddMode(false);
      store.setWidthEditMode(false);
    }
    setObstaclePolygonDrawMode(next);
  });
  document.getElementById('clearObstacles')?.addEventListener('click', () => {
    if (!confirm('すべての障害物（通行不可）をクリアしますか？')) return;
    const state = store.getState();
    store.setMaskEdits({ allow: state.maskEdits?.allow || [], deny: [] }, { replace: true });
    toast('すべての障害物をクリアしました');
  });
  document.getElementById('loadPlateauBuildings')?.addEventListener('click', onLoadPlateauBuildings);
  document.getElementById('toggleBuildingsWireframe')?.addEventListener('click', () => {
    const next = getBuildingsModePref() === 'wire' ? 'solid' : 'wire';
    setBuildingsModePref(next);
    renderBuildingsPrefs();
    toast(next === 'wire' ? '建物表示: ワイヤーフレーム' : '建物表示: ソリッド');
  });
  document.getElementById('toggleGbaAutoLoad')?.addEventListener('click', () => {
    const next = !isGbaAutoLoadEnabled();
    setGbaAutoLoadEnabled(next);
    renderBuildingsPrefs();
    toast(next ? '建物自動読込 ON' : '建物自動読込 OFF');
    scheduleAutoGbaLoad('toggle');
  });

  document.getElementById('toggleManualEndpointMode')?.addEventListener('click', () => {
    const btn = document.getElementById('toggleManualEndpointMode');
    const next = !btn.classList.contains('active');
    if (next) {
      const obsBtn = document.getElementById('toggleObstacleMode');
      if (obsBtn?.classList.contains('active')) {
        obsBtn.classList.remove('active');
        setObstacleAddMode(false);
      }
      const state = store.getState();
      if (state.isWidthEditMode) {
        store.setWidthEditMode(false);
        toast('幅編集モード OFF');
      }
    }
    setManualAddMode(next);
  });

  const roadGraphBtn = document.getElementById('toggleRoadGraphMode');
  if (roadGraphBtn) roadGraphBtn.classList.toggle('active', !ignoreRoadNetwork);
  roadGraphBtn?.addEventListener('click', () => {
    const btn = document.getElementById('toggleRoadGraphMode');
    if (!btn) return;
    const nextUseGraph = !btn.classList.contains('active');
    btn.classList.toggle('active', nextUseGraph);
    ignoreRoadNetwork = !nextUseGraph;
    toast(nextUseGraph ? '道路ネットワークON: 道路形状に沿って経路を生成します' : '道路ネットワークOFF: 直線ベースで経路を生成します');
  });

  document.getElementById('clear-endpoints')?.addEventListener('click', () => {
    lastConfirmedRouteHash = '';
    store.clearEndpoints();
    store.setRoutePlan({ selectionRoute: [], trajectoryRoute: [] });
    store.setDeliveryAssessment(null);
    clearRegulationLayer();
    const list = document.getElementById('selected-roads-list');
    if (list) list.innerHTML = '';
  });

  document.getElementById('confirm-route')?.addEventListener('click', confirmRoute);
  document.getElementById('reset-route')?.addEventListener('click', () => {
    lastConfirmedRouteHash = '';
    store.setRoutePlan({ selectionRoute: [], trajectoryRoute: [] });
    store.setDeliveryAssessment(null);
    clearRegulationLayer();
    toast('経路をリセットしました');
  });

  document.getElementById('vehiclePreset')?.addEventListener('change', (e) => {
    handleVehiclePresetChange(e?.target?.value, '車両').catch((err) => {
      console.warn('[vehiclePreset] change failed', err);
      toast(`車両切替に失敗しました: ${err.message || err}`);
    });
  });

  document.getElementById('hudVehicleSelect')?.addEventListener('change', (e) => {
    handleVehiclePresetChange(e?.target?.value, 'HUD車両').catch((err) => {
      console.warn('[hudVehicleSelect] change failed', err);
      toast(`HUD車両切替に失敗しました: ${err.message || err}`);
    });
  });

  document.getElementById('drawSweep')?.addEventListener('click', drawSweep);
  document.getElementById('clearSweep')?.addEventListener('click', clearSweep);
  document.getElementById('runFeasibility')?.addEventListener('click', runFeasibility);
  document.getElementById('clearFeasibility')?.addEventListener('click', clearFeasibility);

  // 車両別スイープタブで表示中の軌跡と判定結果を切り替える。
  document.getElementById('vehicleSweepTabs')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.vst-btn');
    if (!btn || btn.disabled) return;
    const preset = btn.dataset.preset;
    if (!multiVehicleSweeps[preset] && !multiAssessmentResults[preset]) return;
    applyPresetResult(preset);
    document.querySelectorAll('#vehicleSweepTabs .vst-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.preset === preset);
    });
  });

  document.getElementById('toggleWidthEditMode')?.addEventListener('click', () => {
    const state = store.getState();
    const next = !state.isWidthEditMode;
    if (next) {
      const manualBtn = document.getElementById('toggleManualEndpointMode');
      if (manualBtn?.classList.contains('active')) setManualAddMode(false);
      const obsBtn = document.getElementById('toggleObstacleMode');
      if (obsBtn?.classList.contains('active')) {
        obsBtn.classList.remove('active');
        setObstacleAddMode(false);
      }
    }
    store.setWidthEditMode(next);
    toast(next ? '幅編集モード ON: 幅を編集する道路をクリックしてください' : '幅編集モード OFF');
  });

  document.getElementById('applyRoadWidth')?.addEventListener('click', () => {
    const state = store.getState();
    const id = state.selectedRoadFeatureId;
    const input = document.getElementById('roadWidthInput');
    const w = Number(input?.value);
    if (!id) return;
    if (!Number.isFinite(w) || w < 0) {
      toast('幅 (m) は0以上の数値で入力してください');
      return;
    }
    store.applyWidthOverride(id, w);
    toast(`道路幅を更新しました: ${w.toFixed(1)}m`);
  });

  document.getElementById('resetRoadWidth')?.addEventListener('click', () => {
    const state = store.getState();
    const id = state.selectedRoadFeatureId;
    if (!id) return;
    store.resetWidthOverride(id);
    toast('道路幅の上書きを解除しました');
  });

  document.getElementById('exportWidthOverrides')?.addEventListener('click', () => {
    const state = store.getState();
    const doc = buildOverridesExportDoc(state.widthOverrides || {});
    downloadText(`road_width_overrides_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`, JSON.stringify(doc, null, 2), 'application/json');
    toast('道路幅上書きをエクスポートしました (JSON)');
  });

  document.getElementById('importWidthOverridesBtn')?.addEventListener('click', () => document.getElementById('importWidthOverridesFile')?.click());
  document.getElementById('importWidthOverridesFile')?.addEventListener('change', async (e) => {
    const file = e.target?.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const json = JSON.parse(text);
      const overrides = parseOverridesImportDoc(json);
      store.setWidthOverrides(overrides, { replace: false });
      toast(`道路幅上書きをインポートしました: ${Object.keys(overrides).length}件`);
    } catch (err) {
      console.warn('import width overrides failed', err);
      toast(`インポートに失敗しました: ${err.message}`);
    } finally {
      try {
        e.target.value = '';
      } catch (ignore) { }
    }
  });

  document.getElementById('clearWidthOverrides')?.addEventListener('click', () => {
    if (!confirm('すべての道路幅上書きをクリアしますか？')) return;
    store.clearWidthOverrides();
    // Satellite YOLO で適用した AI幅(width_ai)も併せて消す（旧 override 仕様での挙動を維持）。
    if (satelliteYoloAppliedIds.length) {
      store.clearPerceptionWidthAi(satelliteYoloAppliedIds);
      satelliteYoloAppliedIds = [];
    }
    toast('すべての道路幅上書きをクリアしました');
  });
  document.getElementById('validateWidthFusion')?.addEventListener('click', () => {
    refreshWidthFusionValidation(store.getState());
  });

  if (!GBA_3D_REMOVED) {
    document.getElementById('open3D')?.addEventListener('click', open3DPreview);
    document.getElementById('close3D')?.addEventListener('click', async () => {
      close3DPreview();
      try { const three = await import('./map3dThree.js'); three.closeThree3D(); } catch (e) { }
    });
    document.getElementById('play3D')?.addEventListener('click', onPlay3D);
    document.getElementById('pause3D')?.addEventListener('click', () => stop3D());
    // トップバーの「🏙️ 3D確認」ボタン: 軽量3D(Three.js)を開閉。経路があれば走行も開始。
    document.getElementById('open3DTop')?.addEventListener('click', async () => {
      const three = await import('./map3dThree.js');
      if (three.isThree3DOpen()) {
        three.closeThree3D();
        return;
      }
      const opened = three.openThree3D();
      if (!opened) { toast('3Dビューを開けませんでした（Three.js 読み込み確認）'); return; }
      const st = store.getState();
      if (st.simRoute && st.simRoute.length >= 2) {
        setTimeout(() => { try { three.playThree3D(18); } catch (e) { console.warn('3D play failed', e); } }, 400);
      } else {
        toast('経路を作成してから「🏙️ 3D確認」を押すと搬入走行を再生します');
      }
    });

    document.getElementById('loadGbaUrl')?.addEventListener('click', onLoadGbaUrl);
    document.getElementById('autoGbaWfs')?.addEventListener('click', onAutoGbaWfs);
    document.getElementById('loadGbaFileBtn')?.addEventListener('click', () => document.getElementById('gbaFile')?.click());
    document.getElementById('gbaFile')?.addEventListener('change', onLoadGbaFile);
    document.getElementById('clearGbaBuildings')?.addEventListener('click', () => {
      clearBuildings3D();
      updateGbaStatus();
    });
    document.getElementById('corridorMeters')?.addEventListener('input', () => {
      if (is3DOpen()) {
        const state = store.getState();
        const stats = updateBuildingsForRoute(state.simRoute, { corridorMeters: getCorridorMeters() });
        updateGbaStatus(stats);
      } else {
        updateGbaStatus();
      }
    });
  }

  // ====== State subscription: re-render UI on every state change ======
  store.subscribe((state) => {
    renderStatusMessage(state);
    renderHud(state);
    renderWidthHud(state);
    renderWidthEditorPanel(state);
    renderRouteFlowButtons(state);
    renderWorkflowDock(state);
    renderEndpointList(state);
    renderRouteCandidatesPanel(state);
    renderObstacleStatus(state);
    renderAdvancedMeta(state);
    renderCollisionHud(state);
    renderVehicleHud(state);
    sync3D(state);
    syncObstacles3D(state);
    refreshGbaUrlInput(state);
    scheduleAutoRouteRebuild(state);
  });

  // ====== Initial render ======
  const s0 = store.getState();
  renderStatusMessage(s0);
  renderHud(s0);
  renderWidthHud(s0);
  renderWidthEditorPanel(s0);
  renderRouteFlowButtons(s0);
  renderWorkflowDock(s0);
  renderEndpointList(s0);
  renderRouteCandidatesPanel(s0);
  renderObstacleStatus(s0);
  renderAdvancedMeta(s0);
  renderCollisionHud(s0);
  renderVehicleHud(s0);
  updateGbaStatus();
  renderBuildingsPrefs();
  renderObstacleControls();
  renderPlaybackSpeed();
}

function flashInputError(el) {
  if (!el) return;
  el.style.borderColor = '#ef4444';
  el.style.outline = '0';
  setTimeout(() => { el.style.borderColor = ''; }, 2000);
}

async function onSearch() {
  const input = document.getElementById('search-input') || document.getElementById('nominatim-input');
  if (!input) return;
  const query = input.value?.trim();
  if (!query) {
    toast('検索ワードを入力してください');
    return;
  }
  console.log('[onSearch] query:', query);
  input.style.borderColor = '';
  try {
    const hit = await geocodeSearch(query, { googleKey: GOOGLE_3D_TILES_KEY });
    if (!hit) {
      flashInputError(input);
      toast('地点が見つかりませんでした');
      return;
    }
    console.log('[onSearch] hit found:', hit.lat, hit.lng, hit.name);
    focusTo(hit.lat, hit.lng, 17);
    setSearchMarker(hit.lat, hit.lng, hit.name);
    toast(`📍 ${hit.name}`);
    refreshGbaUrlInput();
  } catch (e) {
    console.warn('[onSearch] failed', e);
    flashInputError(input);
    toast('検索に失敗しました');
  }
}
// グローバル公開（onclick属性・コンソールから直接呼べるようにする）
window.__onSearch = onSearch;

function setChibanStatus(msg) {
  const el = document.getElementById('chibanStatus');
  if (el) el.textContent = msg;
}

async function onBluemapConvert() {
  const input = document.getElementById('bluemap-input');
  if (!input) return;
  const query = input.value?.trim() ?? '';
  if (!query) {
    toast('住所を入力してください');
    return;
  }
  const out = document.getElementById('bluemap-output');
  const btn = document.getElementById('bluemap-button');
  if (btn) btn.disabled = true;
  setChibanStatus('地番変換中...');
  if (out) out.value = '';

  const hasZips = !!ZIPS_CONFIG.enabled;
  try {
    if (hasZips) {
      // Use ZIPS API for proper parcel number lookup
      const bm = await addressToBluemap(query, ZIPS_CONFIG);
      if (bm?.bluemapAddress) {
        if (out) out.value = bm.bluemapAddress;
        setChibanStatus(`地番: ${bm.bluemapAddress}`);
        toast(`地番: ${bm.bluemapAddress}`);
      } else {
        setChibanStatus('地番を取得できませんでした');
        toast('地番変換に失敗しました');
      }
      if (bm?.position && Number.isFinite(bm.position.lat) && Number.isFinite(bm.position.lng)) {
        focusTo(bm.position.lat, bm.position.lng, 17);
        setSearchMarker(bm.position.lat, bm.position.lng, bm.bluemapAddress || query);
        refreshGbaUrlInput();
      }
    } else {
      // No ZIPS credentials: fall back to Google/Nominatim geocode for map focus.
      const hit = await geocodeSearch(query, { googleKey: GOOGLE_3D_TILES_KEY });
      if (hit) {
        focusTo(hit.lat, hit.lng, 17);
        setSearchMarker(hit.lat, hit.lng, hit.name);
        setChibanStatus(
          `住所候補: ${hit.name}\n- 地番の取得には ZIPS API 設定が必要です。\nconfig/runtime.local.json または環境変数で server.zips を設定してください。`
        );
        toast(`住所候補: ${hit.name} (ZIPS未設定)`);
      } else {
        setChibanStatus('住所が見つかりませんでした。\n- 地番取得には config/runtime.local.json または環境変数の ZIPS 設定が必要です。');
        toast('住所が見つかりませんでした');
      }
    }
  } catch (e) {
    console.warn('address_to_bluemap failed', e);
    setChibanStatus(`エラー: ${e.message}`);
    toast(`地番変換エラー: ${e.message}`);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function onChibanToAddress(sourceInputId = 'chiban-input', sourceBtnId = 'chiban-button', outputId = null) {
  const input = document.getElementById(sourceInputId);
  if (!input) return;
  const query = input.value?.trim() ?? '';
  if (!query) {
    toast('地番を入力してください');
    return;
  }
  const btn = document.getElementById(sourceBtnId);
  if (btn) btn.disabled = true;

  const hasZips = !!ZIPS_CONFIG.enabled;
  if (!hasZips) {
    toast('ZIPS API が未設定です。config/runtime.local.json または環境変数で server.zips を設定してください');
    if (btn) btn.disabled = false;
    return;
  }
  try {
    console.log('[onChibanToAddress] query:', query);
    toast('住所変換中...');
    const result = await bluemapToAddress(query, ZIPS_CONFIG);
    if (result?.address) {
      if (outputId) {
        const out = document.getElementById(outputId);
        if (out) out.value = result.address;
        setChibanStatus(`住所: ${result.address}`);
      } else {
        input.value = result.address;
      }
      toast(`住所: ${result.address}`);
    } else {
      toast('住所を取得できませんでした');
    }
    if (result?.position && Number.isFinite(result.position.lat) && Number.isFinite(result.position.lng)) {
      focusTo(result.position.lat, result.position.lng, 17);
      setSearchMarker(result.position.lat, result.position.lng, result.address || query);
      refreshGbaUrlInput();
    }
  } catch (e) {
    console.warn('bluemap_to_address failed', e);
    toast(`地番→住所 変換エラー: ${e.message}`);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function onOsrmRoute() {
  const state = store.getState();
  if (state.selectedEndpoints.length < 2) {
    toast('出発地と目的地を指定してください');
    return;
  }

  let plan = null;
  try {
    plan = await computeRouteFromEndpoints(state, { silent: true, prefer: 'osrm' });
  } catch (e) {
    console.warn('[osrm-route] failed', e);
  }
  if (!plan?.trajectoryRoute || plan.trajectoryRoute.length < 2) {
    toast('OSRM優先経路を計算できませんでした');
    return;
  }

  clearMultiVehicleCaches();
  applyRoutePlan(plan);
  focusToRoute(plan.trajectoryRoute);
  clearSweep();
  clearFeasibility();
  toast('経路を再計算しました（OSRM優先）');
  scheduleAutoGbaLoad('silent');
}

function renderEndpointList(state = store.getState()) {
  const ul = document.getElementById('selected-roads-list');
  if (!ul) return;
  ul.innerHTML = '';
  state.selectedEndpoints.forEach((p, i) => {
    const li = document.createElement('li');
    // XSS対策: p.id は内部生成だが念のためエスケープ。disabled 属性は条件文字列なので unsafeHtml で挿入。
    const upDisabled = i === 0 ? unsafeHtml('disabled') : '';
    const downDisabled = i === state.selectedEndpoints.length - 1 ? unsafeHtml('disabled') : '';
    li.innerHTML = html`
      <span class="chip">${i + 1}</span>
      <span class="coords">${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}</span>
      <span class="rowbtn">
        <button class="btn gray small" data-dir="up" data-idx="${i}" title="上へ移動" ${upDisabled}>↑</button>
        <button class="btn gray small" data-dir="down" data-idx="${i}" title="下へ移動" ${downDisabled}>↓</button>
        <button class="btn warn small" data-id="${p.id}" title="削除">×</button>
      </span>
    `;
    ul.appendChild(li);
  });
  ul.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const dir = e.target.dataset.dir;
      const idx = parseInt(e.target.dataset.idx, 10);
      const id = e.target.dataset.id;
      if (id) {
        store.removeEndpoint(id);
      } else if (!Number.isNaN(idx)) {
        moveEndpoint(idx, dir === 'up' ? idx - 1 : idx + 1);
      }
    });
  });
}

function moveEndpoint(from, to) {
  const state = store.getState();
  if (to < 0 || to >= state.selectedEndpoints.length) return;
  const arr = [...state.selectedEndpoints];
  const [elem] = arr.splice(from, 1);
  arr.splice(to, 0, elem);
  store.setSelectedEndpoints(arr);
}

function bboxIntersects(a, b) {
  return !(a[0] > b[2] || a[2] < b[0] || a[1] > b[3] || a[3] < b[1]);
}

function filterRoadsForRouting(roads, maskEdits) {
  const arr = Array.isArray(roads) ? roads : [];
  const denyRaw = maskEdits?.deny;
  const deny = Array.isArray(denyRaw) ? denyRaw : [];
  if (!deny.length) return arr;
  if (typeof turf?.bbox !== 'function' || typeof turf?.booleanIntersects !== 'function') return arr;

  const denyPolys = deny.filter((f) => {
    const g = f?.geometry;
    return !!g && (g.type === 'Polygon' || g.type === 'MultiPolygon');
  });
  if (!denyPolys.length) return arr;

  const denyBboxes = denyPolys
    .map((f) => {
      try {
        return turf.bbox(f);
      } catch (e) {
        return null;
      }
    })
    .filter((b) => Array.isArray(b) && b.length === 4);
  if (!denyBboxes.length) return arr;

  const out = [];
  for (const f of arr) {
    if (!f?.geometry) {
      out.push(f);
      continue;
    }
    let fb = null;
    try {
      fb = turf.bbox(f);
    } catch (e) {
      out.push(f);
      continue;
    }
    let blocked = false;
    for (let i = 0; i < denyPolys.length; i++) {
      const db = denyBboxes[i];
      if (!db || !bboxIntersects(fb, db)) continue;
      try {
        if (turf.booleanIntersects(f, denyPolys[i])) {
          blocked = true;
          break;
        }
      } catch (e) { }
    }
    if (!blocked) out.push(f);
  }
  return out;
}

async function computeRouteFromEndpoints(state, { silent = false, prefer = 'osrm', osrmGraphFallback = true } = {}) {
  if (!state?.selectedEndpoints || state.selectedEndpoints.length < 2) return null;

  coordinateSystem.setOrigin(state.selectedEndpoints[0].lat, state.selectedEndpoints[0].lng);
  const pts = state.selectedEndpoints.map((p) => ({ lat: p.lat, lng: p.lng }));
  const routePolicy = getRoutePolicySettings();
  const permitShortest = !!routePolicy.permitShortest;
  const osrmAlreadyTried = prefer === 'osrm';
  if (prefer === 'osrm') {
    try {
      const osrm = await fetchOsrmRoute(pts);
      const shortestPlan = buildShortestOsrmPlan(osrm, state);
      if (shortestPlan?.trajectoryRoute?.length >= 2) return shortestPlan;
    } catch (e) {
      console.warn('[route] osrm-shortest failed', e);
    }
    if (!osrmGraphFallback) return null;
  }
  const routingRoads = Array.isArray(state.geoJsonDataSets)
    ? filterRoadsForRouting(state.geoJsonDataSets, state.maskEdits)
    : [];
  const strict = getStrictRoadSettings();
  const widthMargin = getEffectiveWidthMargin(state.vehicleConfig, strict);
  const vc = state.vehicleConfig || {};
  const candidateState = { ...state, geoJsonDataSets: routingRoads };
  const candidates = [];
  // P3-3: 'osrm-first' モードは OSRM を先に試し、品質十分ならグラフ計算をスキップして高速化
  // 'osrm' は graph を完全スキップ、'graph' は OSRM を完全スキップ、'hybrid' は全パス試行
  const allowGraph = prefer !== 'osrm';
  const allowOsrm = prefer !== 'graph';
  const osrmFirst = prefer === 'osrm-first';

  const pushCandidate = (routeLL, label) => {
    const candidate = evaluateRouteCandidate(routeLL, candidateState, { label });
    if (candidate?.route?.length >= 2) candidates.push(candidate);
  };

  // P3-3: osrm-first モードでは先に OSRM を呼び、品質基準を満たせば graph 計算をスキップ
  let osrmGoodEnough = false;
  if (osrmFirst && allowOsrm) {
    try {
      const osrm = await fetchOsrmRoute(pts);
      if (osrm?.coordinates?.length >= 2) {
        pushCandidate(osrm.coordinates, 'osrm');
        const c = candidates[candidates.length - 1];
        // 接触率 < 5% かつ 旋回半径 > 4m なら graph 計算不要
        osrmGoodEnough = c
          && Number.isFinite(c.contactRatio) && c.contactRatio < 0.05
          && (!Number.isFinite(c.tightestRadius) || c.tightestRadius > 4);
      }
    } catch (e) {
      console.warn('[route] osrm-first failed, falling back to graph', e);
    }
  }

  if (!allowGraph || osrmGoodEnough) {
    // osrm-priority / osrm-first(品質OK) は graph 探索をスキップ
  } else if (ignoreRoadNetwork) {
    pushCandidate(pts, 'direct');
  } else if (!routingRoads.length) {
    if (!silent) toast('No road data: using provisional direct route');
    pushCandidate(pts, 'direct');
  } else {
    const vWidth = Number(vc.vehicleWidth) || 0;
    const vHeight = Number(vc.vehicleHeight) || 0;
    const vWeight = Number(vc.grossWeight) || 0;
    const vRmin = getRouteTrackingTurnRadius(vc);
    const turnCostBase = Math.max(0, (vRmin - 5.5) * 0.06);
    const minRoadWidthStrict = Math.max(0, vWidth + widthMargin + (strict.strictMode ? strict.extraMargin : 0));

    const strictOpts = {
      forbidUTurn: true,
      turnCostK: turnCostBase + 0.1,
      graphOptions: {
        ignoreOneway: false,
        ignoreOnewayOnMultiLane: false,
        vehicleWidth: vWidth,
        vehicleHeight: vHeight,
        vehicleWeight: vWeight,
        minRoadWidth: minRoadWidthStrict,
        narrowPenaltyFactor: 3.0
      }
    };
    const relaxedOpts = {
      forbidUTurn: false,
      turnCostK: Math.max(0, turnCostBase - 0.04),
      graphOptions: {
        ignoreOneway: false,
        ignoreOnewayOnMultiLane: false,
        vehicleWidth: vWidth,
        vehicleHeight: vHeight,
        vehicleWeight: vWeight,
        minRoadWidth: Math.max(0, vWidth + Math.max(0.05, widthMargin * 0.35)),
        narrowPenaltyFactor: 1.6
      }
    };

    try {
      const strictRoute = fullRoadRoute(pts, strictOpts, routingRoads);
      if (strictRoute?.length >= 2) pushCandidate(strictRoute, 'graph-strict');
    } catch (e) {
      console.warn('[route] graph-strict failed', e);
    }

    try {
      const relaxedRoute = fullRoadRoute(pts, relaxedOpts, routingRoads);
      if (relaxedRoute?.length >= 2) pushCandidate(relaxedRoute, 'graph-relaxed');
    } catch (e) {
      console.warn('[route] graph-relaxed failed', e);
    }

    if (permitShortest) {
      const permitOpts = {
        forbidUTurn: false,
        turnCostK: 0,
        graphOptions: {
          ignoreOneway: true,
          ignoreOnewayOnMultiLane: true,
          vehicleWidth: vWidth,
          vehicleHeight: vHeight,
          vehicleWeight: vWeight,
          minRoadWidth: Math.max(0, vWidth + Math.max(0.05, widthMargin * 0.25)),
          narrowPenaltyFactor: 1.2
        }
      };
      try {
        const permitRoute = fullRoadRoute(pts, permitOpts, routingRoads);
        if (permitRoute?.length >= 2) pushCandidate(permitRoute, 'permit-shortest');
      } catch (e) {
        console.warn('[route] permit-shortest failed', e);
      }
    }

    if (!candidates.length) pushCandidate(pts, 'direct');
  }

  // P3-3: osrm-first モードでは既に OSRM を呼んだので二重呼び出ししない
  const shouldTryOsrm = allowOsrm && !osrmFirst && !osrmAlreadyTried && (prefer === 'osrm' || prefer === 'hybrid' || !candidates.length);
  if (shouldTryOsrm) {
    try {
      // ③ OSRM alternatives で複数候補を取得し、各々を通行リスク込みで評価・ランクへ載せる。
      const osrmRoutes = await fetchOsrmRoutes(pts);
      if (osrmRoutes.length) {
        osrmRoutes.forEach((r, i) => {
          if (r?.coordinates?.length >= 2) pushCandidate(r.coordinates, i === 0 ? 'osrm' : `osrm-alt${i + 1}`);
        });
      } else {
        const osrm = await fetchOsrmRoute(pts);
        if (osrm?.coordinates?.length >= 2) pushCandidate(osrm.coordinates, 'osrm');
      }
    } catch (e) {
      console.warn('[route] osrm failed', e);
    }
  }

  // Fallback when osrm-priority fails: try one light graph candidate.
  if (osrmGraphFallback && !candidates.length && !allowGraph && routingRoads.length) {
    try {
      const vWidth = Number(vc.vehicleWidth) || 0;
      const vHeight = Number(vc.vehicleHeight) || 0;
      const vWeight = Number(vc.grossWeight) || 0;
      const fallbackGraph = fullRoadRoute(pts, {
        forbidUTurn: false,
        turnCostK: 0,
        graphOptions: {
          ignoreOneway: permitShortest,
          ignoreOnewayOnMultiLane: permitShortest,
          vehicleWidth: vWidth,
          vehicleHeight: vHeight,
          vehicleWeight: vWeight,
          minRoadWidth: Math.max(0, vWidth + Math.max(0.05, widthMargin * 0.35)),
          narrowPenaltyFactor: 1.2
        }
      }, routingRoads);
      if (fallbackGraph?.length >= 2) pushCandidate(fallbackGraph, permitShortest ? 'permit-fallback' : 'graph-fallback');
    } catch (e) {
      console.warn('[route] graph-fallback failed', e);
    }
  }

  if (!candidates.length) return null;

  const osrmCandidates = candidates.filter((c) => c.label === 'osrm' || c.label.startsWith('osrm-alt'));
  const graphCandidates = candidates.filter((c) => c.label.startsWith('graph'));
  const permitCandidates = candidates.filter((c) => c.label === 'permit-shortest' || c.label === 'permit-fallback');
  const pool =
    permitShortest && permitCandidates.length
      ? permitCandidates
      : prefer === 'osrm' && osrmCandidates.length
      ? osrmCandidates
      : (prefer === 'graph' && graphCandidates.length ? graphCandidates : candidates);

  const minLen = Math.max(
    1,
    Math.min(
      ...pool.map((c) => (Number.isFinite(c.lengthMeters) && c.lengthMeters > 0 ? c.lengthMeters : Infinity))
    )
  );
  const viable = pool.filter((c) => {
    if (!Number.isFinite(c.lengthMeters) || c.lengthMeters <= 0) return true;
    return (c.lengthMeters / minLen) <= 1.85;
  });
  const rankingPool = viable.length ? viable : pool;

  const ranked = rankingPool
    .map((c) => {
      const len = Number.isFinite(c.lengthMeters) && c.lengthMeters > 0 ? c.lengthMeters : minLen;
      const lenRatio = len / minLen;
      const detourPenalty = lenRatio > 1 ? (lenRatio - 1) * 1300 : 0;
      const heavyDetourPenalty = lenRatio > 1.35 ? (lenRatio - 1.35) * 2600 : 0;
      const cleanBonus = c.contactRatio <= 0.01 ? -30 : 0;
      const autonomyPenalty = Number.isFinite(Number(c.autonomyRiskScore)) ? Number(c.autonomyRiskScore) : 0;
      const regulationPenalty = Number.isFinite(Number(c.regulationRiskScore)) ? Number(c.regulationRiskScore) : 0;
      return { ...c, lenRatio, finalScore: c.score + detourPenalty + heavyDetourPenalty + autonomyPenalty + regulationPenalty + cleanBonus };
    })
    .sort((a, b) => a.finalScore - b.finalScore);
  const best = ranked[0];

  if (!silent && best) {
    const ratioText = Number.isFinite(best.contactRatio) ? `${(best.contactRatio * 100).toFixed(1)}%` : '-';
    const turnText = Number.isFinite(best.tightestRadius) ? `${best.tightestRadius.toFixed(1)}m` : '-';
    const lenText = Number.isFinite(best.lenRatio) ? `${best.lenRatio.toFixed(2)}x` : '-';
    toast(`Route candidate ${best.label}: contact ${ratioText}, minR ${turnText}, len ${lenText}`);
  }

  if (!best?.route || best.route.length < 2) return null;
  const bestHash = routeHash(best.route);
  const candidateSummaries = ranked
    .slice(0, 6)
    .map((c, i) => routeCandidateSummary(c, i, bestHash));
  const selectedSummary = candidateSummaries.find((c) => c.selected) || routeCandidateSummary(best, 0, bestHash);
  return {
    selectionRoute: (best.selectionRoute?.length >= 2 ? best.selectionRoute : best.route).map((p) => ({ ...p })),
    trajectoryRoute: best.route.map((p) => ({ ...p })),
    candidates: candidateSummaries,
    routeMeta: {
      label: selectedSummary.label,
      kind: selectedSummary.kind,
      displayName: selectedSummary.displayName,
      score: selectedSummary.score,
      finalScore: selectedSummary.finalScore,
      lengthMeters: selectedSummary.lengthMeters,
      lenRatio: selectedSummary.lenRatio,
      contactRatio: selectedSummary.contactRatio,
      contactCount: selectedSummary.contactCount,
      tightestRadius: selectedSummary.tightestRadius,
      autonomyRiskScore: selectedSummary.autonomyRiskScore,
      autonomyStatus: selectedSummary.autonomyStatus,
      autonomyStopEventCount: selectedSummary.autonomyStopEventCount,
      autonomySlowEventCount: selectedSummary.autonomySlowEventCount,
      autonomySteeringSaturationRatio: selectedSummary.autonomySteeringSaturationRatio,
      autonomyMinAllowedSpeedKmh: selectedSummary.autonomyMinAllowedSpeedKmh,
      autonomyMaxTurnRadiusDeficitM: selectedSummary.autonomyMaxTurnRadiusDeficitM,
      regulationRiskScore: selectedSummary.regulationRiskScore,
      regulationStatus: selectedSummary.regulationStatus,
      regulationBlockCount: selectedSummary.regulationBlockCount,
      regulationPermitRequiredCount: selectedSummary.regulationPermitRequiredCount,
      regulationWarningCount: selectedSummary.regulationWarningCount,
      regulationIssueCount: selectedSummary.regulationIssueCount,
      selectedRank: selectedSummary.rank,
      candidateCount: candidateSummaries.length
    }
  };
}

// Show the vehicle sweep tab bar; highlight the active preset
function showVehicleSweepTabs(activePreset) {
  const tabs = document.getElementById('vehicleSweepTabs');
  if (!tabs) return;
  tabs.style.display = 'flex';
  tabs.querySelectorAll('.vst-btn').forEach(btn => {
    const isActive = btn.dataset.preset === activePreset;
    btn.classList.toggle('active', isActive);
    const preset = btn.dataset.preset;
    const hasData = !!(multiVehicleSweeps[preset] || multiAssessmentResults[preset]);
    btn.disabled = !hasData;
  });
}

// Hide the vehicle sweep tab bar and clear stored sweeps
function hideVehicleSweepTabs() {
  const tabs = document.getElementById('vehicleSweepTabs');
  if (tabs) tabs.style.display = 'none';
}

function renderFeasibilityReportBlock(res) {
  const report = document.getElementById('feasibilityReport');
  const section = document.getElementById('feasibilitySection');
  const saveBtn = document.getElementById('saveFeasibility');
  if (report && section) {
    report.innerHTML = html`
      <p>状態: <span class="badge ${res.status === 'OK' ? 'ok' : 'ng'}">${res.status}</span></p>
      <p>カバー率: ${(res.coverage * 100).toFixed(1)} % / 閾値 ${(res.threshold * 100).toFixed(1)} %</p>
    `;
    section.style.display = 'block';
  }
  if (saveBtn) saveBtn.disabled = false;
}

async function confirmRoute() {
  let state = store.getState();
  if ((!state.simRoute || state.simRoute.length < 2) && state.selectedEndpoints?.length >= 2) {
    try {
      const computed = await computeRouteFromEndpoints(state, { silent: true, prefer: 'hybrid' });
      if (applyRoutePlan(computed)) {
        state = store.getState();
      }
    } catch (e) {
      console.warn('[confirm-route] recompute failed', e);
    }
  }
  if (!state.simRoute || state.simRoute.length < 2) {
    toast('経路が未設定です');
    return;
  }

  const selectedRoadRoute = (state.selectedRoadRoute?.length || 0) >= 2 ? state.selectedRoadRoute : state.simRoute;
  const stableSelection = stabilizeRoutePoints(selectedRoadRoute);
  const routeMetaBeforeConfirm = state.routeMeta ? { ...state.routeMeta } : null;
  const candidatesBeforeConfirm = Array.isArray(state.routeCandidates) ? state.routeCandidates : [];
  const strict = getStrictRoadSettings();
  const widthMargin = getEffectiveWidthMargin(state.vehicleConfig, strict);
  const keepShortestRoute = routeMetaBeforeConfirm?.label === 'osrm-shortest';
  const confirmedPlan = keepShortestRoute ? null : buildTrajectoryPlanFromSelection(stableSelection, {
    vehicleConfig: state.vehicleConfig,
    geoJsonDataSets: state.geoJsonDataSets,
    maskEdits: state.maskEdits,
    defaultRoadWidth: strict.defaultRoadWidth,
    clearanceMargin: strict.clearanceMargin,
    strictWidthMode: strict.strictMode,
    widthMargin
  });
  if (confirmedPlan?.trajectoryRoute?.length >= 2) {
    applyRoutePlan({
      ...confirmedPlan,
      candidates: candidatesBeforeConfirm,
      routeMeta: routeMetaBeforeConfirm
    });
    state = store.getState();
  }

  clearMultiVehicleCaches();
  clearSweep();
  lastConfirmedRouteHash = confirmedRouteSignature(state);

  const resetBtn = document.getElementById('reset-route');
  if (resetBtn) resetBtn.disabled = false;
  const confirmBtn = document.getElementById('confirm-route');
  if (confirmBtn) {
    confirmBtn.disabled = true;
    confirmBtn.textContent = '✅ 確定済み';
  }
  const routeName = state.routeMeta?.displayName ? ` / ${state.routeMeta.displayName}` : '';
  toast(`経路を確定しました (${state.simRoute.length}点${routeName})`);
}

function drawSweep() {
  const state = store.getState();
  if (!state.simRoute || state.simRoute.length < 2) {
    toast('先に経路を設定してください');
    return;
  }
  const sweep = generateSweepPolygon(state.simRoute, state.vehicleConfig, { smooth: false });
  if (!sweep?.sweepGeo) {
    toast('スイープポリゴンを生成できませんでした');
    return;
  }
  store.setSweepGeo({ geo: sweep.sweepGeo, outline: sweep.outline || null, trajectoriesGeo: sweep.trajectoriesGeo || null });
  showSweep(sweep.sweepGeo);
  showTrajectory(sweep.trajectoriesGeo || null, null);
  toast('スイープポリゴンを生成しました');
}

function clearSweep() {
  clearSweepLayers();
  store.setSweepGeo(null);
}

function runFeasibility() {
  const btn = document.getElementById('runFeasibility');
  if (btn) {
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = '実行中...';
    setTimeout(() => {
      btn.disabled = false;
      btn.textContent = old;
    }, 1500);
  }
  const state = store.getState();
  const strict = getStrictRoadSettings();
  const effectiveWidthMargin = getEffectiveWidthMargin(state.vehicleConfig, strict);
  const sweepGeo = state._lastSweepGeo?.geo;
  const outline = state._lastSweepGeo?.outline;
  if (!sweepGeo) {
    toast('先にスイープポリゴンを生成してください');
    return;
  }
  const res = analyzeFeasibility({
    sweepGeo,
    geoJsonDataSets: state.geoJsonDataSets,
    defaultRoadWidth: strict.defaultRoadWidth,
    clearanceMargin: strict.clearanceMargin,
    coverageThreshold: strict.coverageThreshold,
    vehicleWidth: state.vehicleConfig.vehicleWidth,
    widthMargin: effectiveWidthMargin,
    maskEdits: state.maskEdits,
    strictWidthMode: strict.strictMode
  });
  if (!res) {
    toast('通行可否解析に失敗しました');
    return;
  }
  store.setFeasibilityResult({
    generatedAt: new Date().toISOString(),
    status: res.status,
    coverage: res.coverage,
    threshold: res.threshold,
    vehicleConfig: state.vehicleConfig,
    selectedEndpoints: state.selectedEndpoints,
    simRoute: state.simRoute,
    sweep: state._lastSweepGeo,
    resultGeo: {
      roadUnion: res.roadUnion,
      intersect: res.intersect,
      overflow: res.overflow
    }
  });
  store.setFeasibilityLayers({ roadUnion: res.roadUnion, intersect: res.intersect, overflow: res.overflow, outline });
  showFeasibilityLayers({ roadUnion: res.roadUnion, intersect: res.intersect, overflow: res.overflow });
  renderFeasibilityReportBlock(res);
  toast(`通行可否: ${res.status}`);
}

function saveFeasibility() {
  const state = store.getState();
  const data = state._lastFeasibilityResult;
  if (!data) {
    toast('保存する通行可否結果がありません');
    return;
  }
  const ts = formatTimestamp(new Date());
  const status = data.status || 'NA';
  downloadText(`feasibility_${status}_${ts}.json`, JSON.stringify(data, null, 2), 'application/json');
  toast('通行可否結果を保存しました');
}

function clearFeasibility() {
  clearFeasibilityLayers();
  store.setFeasibilityLayers(null);
  store.setFeasibilityResult(null);
  const report = document.getElementById('feasibilityReport');
  const section = document.getElementById('feasibilitySection');
  if (report) report.innerHTML = '';
  if (section) section.style.display = 'none';
  const saveBtn = document.getElementById('saveFeasibility');
  if (saveBtn) saveBtn.disabled = true;
  toast('通行可否結果をクリアしました');
}

function fullReset() {
  stopAutoFollow();
  clearTrail();
  wipeAllLayers();
  lastConfirmedRouteHash = '';
  lastAutoRouteEndpointHash = '';
  if (searchMarker) {
    try {
      searchMarker.remove();
    } catch (e) { }
    searchMarker = null;
  }
  // 全リセット時は永続編集もクリアする。
  store.setWidthEditMode(false);
  store.clearWidthOverrides();
  satelliteYoloAppliedIds = [];
  store.clearMaskEdits();
  store.setGeoJsonDataSets([]);
  store.resetRoute({ keepEndpoints: false });
  store.setSweepGeo(null);
  store.setFeasibilityLayers(null);
  store.setFeasibilityResult(null);
  store.setCollisionResults(null);
  store.setDeliveryAssessment(null);
  clearDeliveryPanel();
  clearRegulationLayer();
  const obsBtn = document.getElementById('toggleObstacleMode');
  if (obsBtn) obsBtn.classList.remove('active');
  setObstacleAddMode(false);
  const report = document.getElementById('feasibilityReport');
  const section = document.getElementById('feasibilitySection');
  if (report) report.innerHTML = '';
  if (section) section.style.display = 'none';
  const saveBtn = document.getElementById('saveFeasibility');
  if (saveBtn) saveBtn.disabled = true;
  const list = document.getElementById('selected-roads-list');
  if (list) list.innerHTML = '';
  const bmOut = document.getElementById('bluemap-output');
  if (bmOut) bmOut.value = '';
  multiVehicleSweeps = {};
  multiAssessmentResults = {};
  Object.keys(sweepCache).forEach(k => delete sweepCache[k]);
  _sweepCacheRouteKey = '';
  hideVehicleSweepTabs();
  toast('すべてリセットしました');
}

export function setIgnoreRoadNetwork(flag) {
  ignoreRoadNetwork = flag;
}

// Expose to window for batch simulation
if (typeof window !== 'undefined') {
  window.runSingleVehicleAssessment = runSingleVehicleAssessment;
  window.onOsrmRoute = onOsrmRoute;
  window.fullReset = fullReset;
  window.validateWidthFusion = () => refreshWidthFusionValidation(store.getState());
  window.runSatelliteYoloEstimate = runSatelliteYoloEstimate;
  window.runSvYoloWidthPipeline = runSvYoloWidthPipeline;
  window.checkYoloServerStatus = checkYoloServerStatus;
  window.loadPlateauBuildings = onLoadPlateauBuildings;
  window.focusToRoute = focusToRoute;
  window.focusToGoalArea = focusToGoalArea; // バッチ用: ゴール付近ズーム
  window.findNearestRoad = findNearestRoadCoord; // {lat,lng} を返すラッパー
  window.loadRoadsWideArea = loadRoadsWideArea;  // バッチ用: ルート沿いの道路データを取得
}

