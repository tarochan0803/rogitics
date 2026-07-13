#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

globalThis.turf = require('@turf/turf');

const ROOT = path.resolve(__dirname, '..', '..');

async function importModule(relativePath) {
  return import(pathToFileURL(path.join(ROOT, relativePath)).href);
}

function check(name, condition) {
  assert.equal(Boolean(condition), true, name);
  process.stdout.write(`PASS ${name}\n`);
}

function feature(id, tags, geometry = null) {
  return {
    type: 'Feature',
    id,
    properties: { tags },
    geometry: geometry || {
      type: 'LineString',
      coordinates: [[139.0, 35.0], [139.001, 35.0]]
    }
  };
}

async function main() {
  const config = await importModule('src/config.js');
  const model = await importModule('src/core/regulationModel.js');
  const osm = await importModule('src/core/osmRegulationAdapter.js');
  const external = await importModule('src/core/jarticRegulationAdapter.js');
  const graph = await importModule('src/core/graph.js');
  const routeLL = [{ lat: 35.0, lng: 139.0 }, { lat: 35.0, lng: 139.001 }];
  const vehicle2t = config.VEHICLE_PRESETS['2t_flat'];

  function assess(tags, options = {}, vehicleConfig = vehicle2t, geometry = null) {
    const regulations = osm.regulationsFromOsmFeature(feature('test', tags, geometry));
    return {
      regulations,
      result: model.assessRegulationsForRoute({ routeLL, regulations, vehicleConfig, options })
    };
  }

  function assessFeature(osmFeature, route = routeLL, options = {}, vehicleConfig = vehicle2t) {
    const regulations = osm.regulationsFromOsmFeature(osmFeature);
    return model.assessRegulationsForRoute({ routeLL: route, regulations, vehicleConfig, options });
  }

  const payload = assess({ traffic_sign: 'JP:305-2;JP:503-C[2t]' });
  check('JP 305-2 is a payload-rating class, not gross weight',
    payload.regulations.length === 1
      && payload.regulations[0].type === model.REGULATION_TYPES.PAYLOAD_CLASS
      && payload.result.issues[0]?.reasonCode === 'payload_class_prohibited'
      && payload.result.issues[0]?.actual === 2);

  const lighterPayload = assess(
    { traffic_sign: 'JP:305-2;JP:503-C[2t]' },
    {},
    { ...vehicle2t, ratedPayloadT: 1.5 }
  );
  check('payload class below the signed threshold passes', lighterPayload.result.status === 'pass');

  const signPoint = assess(
    { traffic_sign: 'JP:305-2;JP:503-C[2t]' },
    {},
    vehicle2t,
    { type: 'Point', coordinates: [139.0005, 35.0] }
  );
  check('unmatched sign point warns instead of false blocking',
    signPoint.result.status === 'warning'
      && signPoint.result.issues[0]?.reasonCode === 'traffic_sign_road_match_required');

  const school = assess({ school_zone: 'yes', maxspeed: '30' });
  check('school zone is captured as operational caution',
    school.result.status === 'warning'
      && school.result.issues.some((i) => i.reasonCode === 'school_zone_caution')
      && school.result.issues.some((i) => i.reasonCode === 'speed_limit'));
  check('school POI alone is not invented into a legal road restriction',
    assess({ amenity: 'school' }).regulations.length === 0);
  check('generic hazard=yes is not misclassified as a school zone',
    assess({ hazard: 'yes' }).regulations.length === 0);

  const activeTime = assess(
    { 'motor_vehicle:conditional': 'no @ (Mo-Fr 07:00-09:00)' },
    { assessmentTime: '2026-07-10T08:00:00+09:00' }
  );
  const inactiveTime = assess(
    { 'motor_vehicle:conditional': 'no @ (Mo-Fr 07:00-09:00)' },
    { assessmentTime: '2026-07-10T10:00:00+09:00' }
  );
  const unknownTime = assess({ 'motor_vehicle:conditional': 'no @ (Mo-Fr 07:00-09:00)' });
  check('scheduled access restriction blocks only inside its time window',
    activeTime.result.status === 'blocked' && inactiveTime.result.status === 'pass');
  check('missing departure time produces an explicit warning',
    unknownTime.result.issues[0]?.reasonCode === 'conditional_time_required');

  const vehicleCondition = assess({ 'hgv:conditional': 'no @ (weight>4)' });
  check('vehicle-property conditional restriction is evaluated without wall-clock time',
    vehicleCondition.result.issues[0]?.reasonCode === 'truck_forbidden');
  check('conditional truck permission does not invert into a prohibition',
    assess({ 'hgv:conditional': 'yes @ (weight>4)' }).result.status === 'pass');

  const multiClause = assess(
    { 'maxweight:conditional': '6 @ (Mo-Fr 07:00-09:00); 4 @ (Mo-Fr 09:00-11:00)' },
    { assessmentTime: '2026-07-10T10:00:00+09:00' }
  );
  check('active numeric conditional clause supplies its own limit',
    multiClause.result.issues[0]?.reasonCode === 'max_weight_exceeded'
      && multiClause.result.issues[0]?.required === 4);

  const rating = assess({ 'maxweightrating:hgv': '4' });
  check('maximum authorized mass is distinct and enforced',
    rating.result.issues[0]?.reasonCode === 'max_weight_rating_exceeded');
  check('actual laden weight and authorized mass remain distinct',
    assess({ maxweight: '4' }, { actualGrossWeightT: 3.5 }).result.status === 'pass'
      && rating.result.status === 'blocked');

  const axle = assess({ maxaxleload: '2' });
  check('unknown axle load never fabricates a pass or block',
    axle.result.status === 'unknown'
      && axle.result.issues[0]?.reasonCode === 'vehicle_axle_load_unknown');

  const publicRecord = external.regulationFromExternalRecord({
    id: 'police-305-2',
    source: 'xroad',
    kind: '特定の最大積載量2トン以上の貨物自動車等通行止め',
    geometry: feature('g', {}).geometry
  });
  check('public Japanese record maps to payload-class restriction',
    publicRecord?.type === model.REGULATION_TYPES.PAYLOAD_CLASS
      && publicRecord?.value?.minimumT === 2);

  const restrictedRoad = feature('road', {
    highway: 'residential',
    traffic_sign: 'JP:305-2;JP:503-C[2t]'
  });
  const blockedGraph = graph.buildRoadGraph([restrictedRoad], {
    vehiclePayloadRating: 2,
    vehicleWeight: 4.5
  });
  const allowedGraph = graph.buildRoadGraph([restrictedRoad], {
    vehiclePayloadRating: 1.5,
    vehicleWeight: 3.0
  });
  check('strict road graph excludes prohibited 2t payload class',
    blockedGraph.segments.length === 0 && allowedGraph.segments.length === 1);

  const hazmatRoad = assess({ hazmat: 'no' }, { isHazmat: true });
  check('hazardous-goods prohibition applies only to declared hazmat cargo',
    hazmatRoad.result.issues[0]?.reasonCode === 'hazmat_forbidden'
      && assess({ hazmat: 'no' }, { isHazmat: false }).result.status === 'pass');
  check('class-specific hazmat restriction requires matching cargo class',
    assess({ 'hazmat:water': 'no' }, { isHazmat: true }).result.issues[0]?.reasonCode === 'hazmat_class_unknown'
      && assess({ 'hazmat:water': 'no' }, { isHazmat: true, hazmatClasses: ['explosive'] }).result.status === 'pass'
      && assess({ 'hazmat:water': 'no' }, { isHazmat: true, hazmatClasses: ['water'] }).result.status === 'blocked');

  const chainRoadNo = assess({ snow_chains: 'required' }, { snowChainsFitted: false });
  const chainRoadYes = assess({ snow_chains: 'required' }, { snowChainsFitted: true });
  check('snow-chain restriction respects fitted-chain state',
    chainRoadNo.result.issues[0]?.reasonCode === 'snow_chains_required'
      && chainRoadYes.result.status === 'pass');

  const fixedBarrier = assess({ barrier: 'bollard' }, {}, vehicle2t,
    { type: 'Point', coordinates: [139.0005, 35.0] });
  const adjacentBarrier = assess({ barrier: 'bollard' }, {}, vehicle2t,
    { type: 'Point', coordinates: [139.0005, 35.00005] });
  const controlledGate = assess({ barrier: 'lift_gate' }, {}, vehicle2t,
    { type: 'Point', coordinates: [139.0005, 35.0] });
  check('fixed barrier blocks only when it lies on the route',
    fixedBarrier.result.issues[0]?.reasonCode === 'fixed_barrier'
      && adjacentBarrier.result.status === 'pass');
  check('controlled gate requires confirmation instead of hard block',
    controlledGate.result.status === 'permit_required'
      && controlledGate.result.issues[0]?.reasonCode === 'controlled_barrier');

  check('construction closure is blocked and winter service is caution',
    assess({ construction: 'resurfacing' }).result.issues[0]?.reasonCode === 'road_under_construction'
      && assess({ winter_service: 'no' }).result.issues[0]?.reasonCode === 'seasonal_or_winter_restriction');
  check('toll and minimum speed are retained as operational information',
    assess({ toll: 'yes', minspeed: '30' }).result.issues.some((i) => i.reasonCode === 'toll_road')
      && assess({ toll: 'yes', minspeed: '30' }).result.issues.some((i) => i.reasonCode === 'minimum_speed'));
  check('mandatory stop is captured without making the road impassable',
    assess({ highway: 'stop' }, {}, vehicle2t,
      { type: 'Point', coordinates: [139.0005, 35.0] }).result.issues[0]?.reasonCode === 'mandatory_stop');

  const parkingNearGoal = assess({ traffic_sign: 'JP:316' }, {}, vehicle2t,
    { type: 'Point', coordinates: [139.00095, 35.0] });
  const parkingMidRoute = assess({ traffic_sign: 'JP:316' }, {}, vehicle2t,
    { type: 'Point', coordinates: [139.0003, 35.0] });
  check('parking restriction warns only near the delivery destination',
    parkingNearGoal.result.issues[0]?.reasonCode === 'destination_no_parking'
      && parkingMidRoute.result.status === 'pass');

  const fromGeometry = { type: 'LineString', coordinates: [[139.0, 35.0], [139.001, 35.0]] };
  const toGeometry = { type: 'LineString', coordinates: [[139.001, 35.0], [139.001, 35.001]] };
  const viaGeometry = { type: 'Point', coordinates: [139.001, 35.0] };
  const turnFeature = (restriction) => ({
    type: 'Feature',
    id: `relation/${restriction}`,
    properties: {
      tags: { type: 'restriction', restriction },
      restrictionRelation: { restriction, fromGeometry, toGeometry, viaGeometry }
    },
    geometry: { type: 'MultiLineString', coordinates: [fromGeometry.coordinates, toGeometry.coordinates] }
  });
  const leftRoute = [
    { lat: 35.0, lng: 139.0 }, { lat: 35.0, lng: 139.001 }, { lat: 35.001, lng: 139.001 }
  ];
  const straightRoute = [
    { lat: 35.0, lng: 139.0 }, { lat: 35.0, lng: 139.001 }, { lat: 35.0, lng: 139.002 }
  ];
  check('no-turn relation blocks only the prohibited from-via-to sequence',
    assessFeature(turnFeature('no_left_turn'), leftRoute).status === 'blocked'
      && assessFeature(turnFeature('no_left_turn'), straightRoute).status === 'pass');
  check('only-turn relation blocks departure to a different way',
    assessFeature(turnFeature('only_left_turn'), leftRoute).status === 'pass'
      && assessFeature(turnFeature('only_left_turn'), straightRoute).status === 'blocked');

  const hazmatGraphBlocked = graph.buildRoadGraph([feature('hazmat-road', { highway: 'residential', hazmat: 'no' })], { isHazmat: true });
  const hazmatGraphNormal = graph.buildRoadGraph([feature('hazmat-road', { highway: 'residential', hazmat: 'no' })], { isHazmat: false });
  check('road graph removes hazmat-prohibited edges only for hazmat cargo',
    hazmatGraphBlocked.segments.length === 0 && hazmatGraphNormal.segments.length === 1);

  external.clearActiveExternalRegulations();
  external.setActiveExternalRegulations(external.buildExternalRegulationLayer([{
    id: 'last-known-good',
    source: 'jartic',
    kind: '大型貨物通行止',
    geometry: { type: 'LineString', coordinates: [[139.7, 35.6], [139.701, 35.6]] }
  }], { source: 'jartic' }));
  external.registerExternalRegulationFetcher('jartic', async () => {
    throw new Error('temporary upstream failure');
  });
  const afterExternalFailure = await external.fetchExternalRegulations({ sources: ['jartic'] });
  check('external fetch failure retains last-known-good regulations instead of failing open',
    afterExternalFailure.some((regulation) => regulation.sourceFeatureId === 'last-known-good'));
  external.clearActiveExternalRegulations();

  const staleData = model.assessRegulationsForRoute({
    routeLL,
    regulations: [],
    vehicleConfig: vehicle2t,
    options: { dataFreshness: { overall: 'stale', sources: { osm: { state: 'fresh' } } } }
  });
  const unavailableData = model.assessRegulationsForRoute({
    routeLL,
    regulations: [],
    vehicleConfig: vehicle2t,
    options: { dataFreshness: { overall: 'expired' } }
  });
  check('stale or unavailable regulation sources cannot silently become PASS',
    staleData.status === 'warning'
      && staleData.issues[0]?.reasonCode === 'official_regulation_data_incomplete'
      && unavailableData.status === 'unknown'
      && unavailableData.issues[0]?.reasonCode === 'regulation_data_unavailable');

  process.stdout.write('Detailed regulation regression: PASS\n');
}

main().catch((error) => {
  console.error(`Detailed regulation regression: FAIL\n${error.stack || error}`);
  process.exitCode = 1;
});
