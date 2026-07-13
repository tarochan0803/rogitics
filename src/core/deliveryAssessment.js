import { DEFAULTS_HIDDEN } from '../config.js';
import { generateSweepPolygon, analyzeContactFeasibility, analyzeFeasibility } from './feasibility.js';
import { buildCollisionIndex, batchCollisionCheck } from './collision.js';
import { analyzeVehicleKinematics } from '../sim/kinematics.js';
import { runFullVoxelCollision } from './webgpuVoxelCollision.js';
import { buildOsmRegulationLayer } from './osmRegulationAdapter.js';
import { mergeRegulationLayers } from './jarticRegulationAdapter.js';
import {
  assessRegulationsForRoute,
  legacyOverallStatus,
  mergePhysicalAndRegulationStatus,
  regulationScorePenalty
} from './regulationModel.js';

function toFeatureArray(geo) {
  if (!geo) return [];
  if (Array.isArray(geo)) return geo;
  if (geo.type === 'FeatureCollection') return Array.isArray(geo.features) ? geo.features : [];
  if (geo.type === 'Feature') return [geo];
  if (geo.type) return [{ type: 'Feature', properties: {}, geometry: geo }];
  return [];
}

function flattenFeatureArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap((item) => toFeatureArray(item));
  return toFeatureArray(value);
}

function combineObstacles({ maskEdits, obstaclesGeo, buildingsGeo } = {}) {
  const out = [];
  const deny = Array.isArray(maskEdits?.deny) ? maskEdits.deny : [];
  out.push(...deny);
  out.push(...toFeatureArray(obstaclesGeo));
  out.push(...toFeatureArray(buildingsGeo));
  return out;
}

function haversineM(a, b) {
  const R = 6371000;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h = sinLat * sinLat +
    Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * sinLng * sinLng;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function computeRouteDistance(route) {
  if (!Array.isArray(route) || route.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < route.length; i++) {
    const prev = route[i - 1];
    const curr = route[i];
    const pLat = typeof prev.lat === 'number' ? prev.lat : (prev[0] ?? 0);
    const pLng = typeof prev.lng === 'number' ? prev.lng : (prev[1] ?? 0);
    const cLat = typeof curr.lat === 'number' ? curr.lat : (curr[0] ?? 0);
    const cLng = typeof curr.lng === 'number' ? curr.lng : (curr[1] ?? 0);
    total += haversineM({ lat: pLat, lng: pLng }, { lat: cLat, lng: cLng });
  }
  return Math.round(total);
}

function clamp01(v) {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

function buildAssessmentCriteria({ coverageThreshold, totalSamples }) {
  const passCoverage = Number.isFinite(coverageThreshold)
    ? Math.max(0.75, Math.min(0.995, coverageThreshold))
    : 0.98;
  const conditionalCoverage = Math.max(0.72, passCoverage - 0.10);
  const samples = Math.max(1, Number(totalSamples) || 1);
  const passMaxRatio = Math.min(0.01, Math.max(0.003, 1 / samples));
  const passMaxCount = Math.max(1, Math.ceil(samples * passMaxRatio));
  const conditionalMaxRatio = Math.min(0.08, Math.max(0.02, 4 / samples));
  const conditionalMaxCount = Math.max(passMaxCount + 2, Math.ceil(samples * conditionalMaxRatio));
  return {
    pass: {
      minCoverage: passCoverage,
      maxContactCount: passMaxCount,
      maxContactRatio: passMaxRatio
    },
    conditional: {
      minCoverage: conditionalCoverage,
      maxContactCount: conditionalMaxCount,
      maxContactRatio: conditionalMaxRatio
    }
  };
}

function buildDecisionMetrics({ feasibility, collision, contact, kinematics, coverageThreshold }) {
  const coverage = Number(feasibility?.coverage ?? 0);
  const contactCount = Math.max(
    0,
    Number(collision?.contactCount ?? contact?.contactCount ?? 0) || 0
  );
  const totalSamples = Math.max(
    1,
    Number(collision?.totalSamples ?? contact?.totalSamples ?? 1) || 1
  );
  const contactRatioRaw = Number(collision?.contactRatio ?? contact?.contactRatio);
  const contactRatio = Number.isFinite(contactRatioRaw)
    ? Math.max(0, Math.min(1, contactRatioRaw))
    : (contactCount > 0 ? Math.min(1, contactCount / totalSamples) : 0);

  const criteria = buildAssessmentCriteria({ coverageThreshold, totalSamples });
  const checks = {
    passCoverageOk: coverage >= criteria.pass.minCoverage,
    passContactOk: contactCount <= criteria.pass.maxContactCount && contactRatio <= criteria.pass.maxContactRatio,
    conditionalCoverageOk: coverage >= criteria.conditional.minCoverage,
    conditionalContactOk:
      contactCount <= criteria.conditional.maxContactCount &&
      contactRatio <= criteria.conditional.maxContactRatio,
    kinematicsOk: !kinematics || kinematics.status !== 'NG'
  };
  const pass = checks.passCoverageOk && checks.passContactOk && checks.kinematicsOk;
  const conditional = !pass && checks.conditionalCoverageOk && checks.conditionalContactOk && checks.kinematicsOk;

  const reasons = [];
  if (!checks.conditionalCoverageOk) reasons.push('coverage_below_conditional_threshold');
  if (!checks.conditionalContactOk) reasons.push('contacts_above_conditional_threshold');
  if (!checks.kinematicsOk) reasons.push(kinematics?.reason || 'kinematic_limit_exceeded');
  if (checks.conditionalCoverageOk && !checks.passCoverageOk) reasons.push('coverage_below_pass_threshold');
  if (checks.conditionalContactOk && !checks.passContactOk) reasons.push('contacts_above_pass_threshold');

  return {
    coverage,
    contactCount,
    contactRatio,
    totalSamples,
    criteria,
    checks,
    pass,
    conditional,
    reasons
  };
}

function computeOverallStatus(decision) {
  if (decision?.pass) return 'PASS';
  if (decision?.conditional) return 'CONDITIONAL';
  return 'NG';
}

function physicalStatusFromOverall(overallStatus) {
  if (overallStatus === 'PASS') return 'pass';
  if (overallStatus === 'CONDITIONAL') return 'caution';
  return 'blocked';
}

function clampScoreForStatus(score, overallStatus) {
  const value = Number.isFinite(score) ? score : 0;
  if (overallStatus === 'PASS') return Math.max(85, Math.min(100, value));
  if (overallStatus === 'CONDITIONAL') return Math.max(60, Math.min(84, value));
  return Math.max(0, Math.min(59, value));
}

function regulationIssueToViolation(issue) {
  if (!issue) return null;
  return {
    type: 'regulation',
    regulationType: issue.type,
    severity: issue.severity,
    reasonCode: issue.reasonCode,
    message: issue.message,
    source: issue.source,
    confidence: issue.confidence,
    rawValue: issue.rawValue,
    actual: issue.actual,
    required: issue.required,
    deficit: issue.deficit,
    atKm: Number.isFinite(issue.atM) ? issue.atM / 1000 : null,
    latLng: issue.latLng || null
  };
}

function calculateRouteScore({ status, decision, routeAdjustment }) {
  const coverageSpan = Math.max(1e-6, 1 - decision.criteria.conditional.minCoverage);
  const coverageNorm = clamp01((decision.coverage - decision.criteria.conditional.minCoverage) / coverageSpan);
  const collisionNorm = decision.criteria.conditional.maxContactRatio > 0
    ? clamp01(1 - (decision.contactRatio / decision.criteria.conditional.maxContactRatio))
    : (decision.contactCount === 0 ? 1 : 0);

  const coverageScore = coverageNorm * 65;
  const collisionScore = collisionNorm * 35;
  const adjustmentPenalty = routeAdjustment?.applied && !routeAdjustment?.ok ? 10 : 0;
  const kinematicPenalty = decision.checks?.kinematicsOk ? 0 : 25;
  const rawScore = coverageScore + collisionScore - adjustmentPenalty - kinematicPenalty;

  let boundedScore = rawScore;
  if (status === 'PASS') boundedScore = Math.max(85, Math.min(100, rawScore));
  else if (status === 'CONDITIONAL') boundedScore = Math.max(60, Math.min(84, rawScore));
  else boundedScore = Math.max(0, Math.min(59, rawScore));

  return {
    total: Number(boundedScore.toFixed(1)),
    breakdown: {
      coverageScore: Number(coverageScore.toFixed(1)),
      collisionScore: Number(collisionScore.toFixed(1)),
      adjustmentPenalty,
      kinematicPenalty,
      rawScore: Number(rawScore.toFixed(1)),
      boundedScore: Number(boundedScore.toFixed(1))
    }
  };
}

async function evaluateRoute(routeLL, params) {
  const {
    vehicleConfig,
    geoJsonDataSets,
    maskEdits,
    defaultRoadWidth = 6,
    clearanceMargin = 0.3,
    coverageThreshold = 0.98,
    strictWidthMode = false,
    widthMargin,
    obstaclesGeo,
    buildingsGeo,
    driverSkill = 1.0
  } = params;

  // P1-3: driverSkill を 0.7〜1.3 倍クランプの乗数化（旧 0.5〜2.0 倍率での÷演算は振れ過大）
  // 入力範囲 driverSkill 0.5(未熟)〜2.0(熟練) を skillMarginMul 1.3〜0.7 にマッピング:
  //   0.5→1.3 (margin拡大=厳しい安全側) / 1.0→1.0 (標準) / 2.0→0.7 (margin縮小=熟練に緩和)
  const rawSkill = Number(driverSkill) || 1.0;
  const skillMarginMul = Math.max(0.7, Math.min(1.3, 2.0 - rawSkill));
  const vehicleWithSkill = {
    ...vehicleConfig,
    driverSkill: rawSkill,
    widthMargin: Math.max(0, (vehicleConfig.widthMargin ?? 0.3) * skillMarginMul)
  };

  // P2-1: precision='high' (pseudo-Dubins) を呼び出し側から伝播
  const sweepPrecision = params.precision === 'high' ? 'high' : 'normal';
  const sweep = generateSweepPolygon(routeLL, vehicleWithSkill, { step: DEFAULTS_HIDDEN.sweepStep, smooth: false, precision: sweepPrecision });
  const kinematics = analyzeVehicleKinematics(routeLL, vehicleWithSkill, {
    strideMeters: DEFAULTS_HIDDEN.contactStep
  });
  const sweepGeo = sweep.sweepGeo;
  if (!sweepGeo && routeLL.length >= 2) {
    console.warn('[evaluateRoute] スイープポリゴン生成失敗 — 車両設定確認:', {
      wheelBase: vehicleWithSkill.wheelBase,
      vehicleWidth: vehicleWithSkill.vehicleWidth,
      frontOverhang: vehicleWithSkill.frontOverhang,
      rearOverhang: vehicleWithSkill.rearOverhang
    });
  }
  const contact = analyzeContactFeasibility({
    simRoute: routeLL,
    vehicleConfig: vehicleWithSkill,
    geoJsonDataSets,
    defaultRoadWidth,
    clearanceMargin,
    widthMargin: widthMargin ?? vehicleConfig?.widthMargin,
    maskEdits,
    strictWidthMode
  });

  const feasibility = sweepGeo
    ? analyzeFeasibility({
      sweepGeo,
      geoJsonDataSets,
      defaultRoadWidth,
      clearanceMargin,
      coverageThreshold: Number.isFinite(coverageThreshold) ? coverageThreshold : 0.98,
      vehicleWidth: vehicleConfig?.vehicleWidth,
      widthMargin: widthMargin ?? vehicleConfig?.widthMargin,
      maskEdits,
      strictWidthMode
    })
    : null;

  const obstacles = combineObstacles({ maskEdits, obstaclesGeo, buildingsGeo });
  const index = buildCollisionIndex({
    roadUnion: contact?.roadUnion || feasibility?.roadUnion || null,
    obstacles,
    obstacleDefaultHeight: 3
  });

  let collision = null;
  let voxelCollision = null;
  if (Array.isArray(sweep.poses) && sweep.poses.length) {
    collision = batchCollisionCheck(sweep.poses, vehicleConfig, index, {
      origin: routeLL[0],
      maxContactPoints: 240,
      heightClearance: 0.25
    });
  }
  if (Array.isArray(sweep.footprints) && sweep.footprints.length) {
    voxelCollision = await runFullVoxelCollision({
      footprints: sweep.footprints,
      obstacles,
      vehicleHeight: vehicleConfig?.vehicleHeight,
      clearance: 0.25,
      voxelSizeMeters: params.voxelSizeMeters ?? 0.5,
      maxContactPoints: 240
    });
    if (voxelCollision?.status === 'NG' && (!collision || collision.status !== 'NG')) {
      collision = { ...voxelCollision, source: 'voxel' };
    } else if (collision && voxelCollision) {
      collision.voxel = voxelCollision;
    }
  }

  return { sweep, contact, feasibility, collision, voxelCollision, collisionIndex: index, kinematics };
}

export async function runDeliveryAssessment(params = {}) {
  const startedAt = new Date().toISOString();
  const {
    simRoute,
    vehicleConfig
  } = params;

  if (!simRoute || simRoute.length < 2 || !vehicleConfig) {
    return {
      overallStatus: 'NG',
      score: 0,
      error: 'route_or_vehicle_missing',
      startedAt,
      completedAt: new Date().toISOString()
    };
  }

  const initial = await evaluateRoute(simRoute, params);
  const routeLL = simRoute;
  const contact = initial.contact;
  const feasibility = initial.feasibility;
  const collision = initial.collision;
  const voxelCollision = initial.voxelCollision;
  const kinematics = initial.kinematics;
  const sweep = initial.sweep;
  const routeAdjustment = { applied: false, ok: true, iterations: 0, adjustments: [] };

  const thresholdForDecision = Number.isFinite(params.coverageThreshold)
    ? params.coverageThreshold
    : Number(feasibility?.threshold ?? 0.98);
  const decision = buildDecisionMetrics({
    feasibility,
    collision,
    contact,
    kinematics,
    coverageThreshold: thresholdForDecision
  });

  // P1-4: violations を contact / feasibility / collision から集約
  const violationsAgg = [];
  if (Array.isArray(contact?.violations) && contact.violations.length) {
    violationsAgg.push(...contact.violations);
  }
  if (feasibility && Number.isFinite(feasibility.coverage) && Number.isFinite(feasibility.threshold)) {
    if (feasibility.coverage < feasibility.threshold) {
      violationsAgg.push({
        type: 'coverage',
        actual: Number(feasibility.coverage.toFixed(3)),
        required: Number(feasibility.threshold.toFixed(3)),
        deficit: Number((feasibility.threshold - feasibility.coverage).toFixed(3)),
        atKm: null,
        latLng: null
      });
    }
  }
  if (collision && Number(collision.contactCount) > 0 && (!Array.isArray(contact?.violations) || !contact.violations.length)) {
    // contact 詳細違反が無い場合のフォールバック（collision 由来の接触のみ）
    const fc = collision.firstContact;
    violationsAgg.push({
      type: 'building_contact',
      actual: null,
      required: null,
      deficit: null,
      atKm: null,
      latLng: fc ? { lat: fc.lat, lng: fc.lng } : null
    });
  }
  if (Array.isArray(kinematics?.violations) && kinematics.violations.length) {
    violationsAgg.push(...kinematics.violations);
  }
  const physicalOverallStatus = computeOverallStatus(decision);
  const physicalStatus = physicalStatusFromOverall(physicalOverallStatus);
  const roadFeatures = flattenFeatureArray(params.geoJsonDataSets);
  const regulationAssessment = assessRegulationsForRoute({
    routeLL,
    regulations: mergeRegulationLayers(
      buildOsmRegulationLayer(roadFeatures),
      params.externalRegulations || []
    ),
    vehicleConfig,
    options: {
      permitMode: !!params.permitMode,
      cargoLoadType: params.cargoLoadType,
      cargoCount: params.cargoCount,
      clearanceMargin: params.clearanceMargin,
      corridorM: params.regulationCorridorM,
      assessmentTime: params.assessmentTime,
      timeZone: params.regulationTimeZone || 'Asia/Tokyo',
      isHazmat: !!params.isHazmat,
      snowChainsFitted: params.snowChainsFitted,
      dataFreshness: params.regulationDataFreshness || null
    }
  });
  const regulationStatus = regulationAssessment?.status || 'pass';
  const finalStatus = mergePhysicalAndRegulationStatus(physicalStatus, regulationStatus);
  const overallStatus = legacyOverallStatus(finalStatus);
  const scoreInfo = calculateRouteScore({
    status: physicalOverallStatus,
    decision,
    routeAdjustment
  });
  const regPenalty = regulationScorePenalty(regulationAssessment);
  const finalScore = clampScoreForStatus(scoreInfo.total - regPenalty, overallStatus);
  const distance = computeRouteDistance(routeLL);
  const regulationViolations = (regulationAssessment?.issues || [])
    .map(regulationIssueToViolation)
    .filter(Boolean);
  if (regulationViolations.length) {
    violationsAgg.push(...regulationViolations);
  }
  const regulationReason = regulationAssessment?.issues?.[0]?.reasonCode || null;

  return {
    overallStatus,
    physicalStatus,
    regulationStatus,
    finalStatus,
    physicalOverallStatus,
    overallStatusReason: decision.reasons[0] || regulationReason || null,
    score: finalScore,
    scoreBreakdown: {
      ...scoreInfo.breakdown,
      regulationPenalty: regPenalty,
      physicalScore: scoreInfo.total,
      finalScore
    },
    regulationAssessment,
    feasibility: feasibility
      ? {
        status: feasibility.status,
        coverage: feasibility.coverage,
        threshold: feasibility.threshold,
        roadUnion: feasibility.roadUnion,
        intersect: feasibility.intersect,
        overflow: feasibility.overflow
      }
      : null,
    contactFeasibility: contact
      ? {
        status: contact.status,
        contactCount: contact.contactCount,
        totalSamples: contact.totalSamples,
        contactRatio: contact.contactRatio,
        contactPoints: contact.contactPoints,
        firstContact: contact.firstContact,
        roadUnion: contact.roadUnion
      }
      : null,
    collisionReport: collision
      ? {
        status: collision.status,
        contactCount: collision.contactCount,
        totalSamples: collision.totalSamples,
        contactRatio: collision.contactRatio,
        contactPoints: collision.contactPoints,
        firstContact: collision.firstContact
      }
      : null,
    voxelCollision: voxelCollision
      ? {
        status: voxelCollision.status,
        backend: voxelCollision.backend,
        remote: !!voxelCollision.remote,
        remoteUrl: voxelCollision.remoteUrl || null,
        gpu: voxelCollision.gpu || null,
        webgpuAvailable: voxelCollision.webgpuAvailable,
        voxelSizeMeters: voxelCollision.voxelSizeMeters,
        contactCount: voxelCollision.contactCount,
        totalSamples: voxelCollision.totalSamples,
        contactRatio: voxelCollision.contactRatio,
        firstContact: voxelCollision.firstContact
      }
      : null,
    kinematics: kinematics
      ? {
        status: kinematics.status,
        reason: kinematics.reason,
        metrics: kinematics.metrics,
        driveSimulation: kinematics.driveSimulation,
        curveCalibration: kinematics.curveCalibration,
        violations: kinematics.violations,
        warnings: kinematics.warnings
      }
      : null,
    criteria: {
      coverage: {
        actual: decision.coverage,
        passMin: decision.criteria.pass.minCoverage,
        conditionalMin: decision.criteria.conditional.minCoverage
      },
      contact: {
        actualCount: decision.contactCount,
        actualRatio: decision.contactRatio,
        passMaxCount: decision.criteria.pass.maxContactCount,
        passMaxRatio: decision.criteria.pass.maxContactRatio,
        conditionalMaxCount: decision.criteria.conditional.maxContactCount,
        conditionalMaxRatio: decision.criteria.conditional.maxContactRatio
      },
      checks: decision.checks,
      reasons: decision.reasons
    },
    routeAdjustment,
    routeMode: 'confirmed_route_only',
    route: routeLL,
    sweep: sweep ? { sweepGeo: sweep.sweepGeo, outline: sweep.outline, trajectoriesGeo: sweep.trajectoriesGeo } : null,
    distanceMeters: distance,
    violations: violationsAgg,
    startedAt,
    completedAt: new Date().toISOString()
  };
}
