#!/usr/bin/env node
// Regression checks for the local PLATEAU ground estimator.
// The browser module is loaded as a data URL so this check remains dependency-free.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function loadPlateauModule() {
  const file = path.join(__dirname, '..', '3d', 'plateauTiles.js');
  const source = fs.readFileSync(file, 'utf8');
  return import(`data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`);
}

function check(name, condition) {
  assert.equal(Boolean(condition), true, name);
  process.stdout.write(`PASS ${name}\n`);
}

async function main() {
  const plateau = await loadPlateauModule();

  check('display ground target matches road surface Y', plateau.plateauGroundTargetY() === 0.04);

  const initial = [
    { distanceM: 18, minY: 4.02 },
    { distanceM: 26, minY: 4.10 },
    { distanceM: 34, minY: 31.0, groundEligible: false }, // roof-only/high LOD outlier
    { distanceM: 900, minY: -80.0 } // distant tile must not affect local ground
  ];
  const firstEstimate = plateau.estimatePlateauGroundY(initial, { radiusM: 120 });
  check('local candidates are estimated', firstEstimate && firstEstimate.candidates === 2);
  check('roof outlier is excluded from ground candidates', Math.abs(firstEstimate.groundEstimateY - 4.06) < 1e-9);
  check('distant tile is ignored', firstEstimate.maxY === 4.10);

  const streamedSameCount = [
    { distanceM: 18, minY: 4.04 },
    { distanceM: 26, minY: 4.11 },
    { distanceM: 34, minY: 31.0, groundEligible: false },
    { distanceM: 900, minY: -120.0 }
  ];
  const streamedEstimate = plateau.estimatePlateauGroundY(streamedSameCount, { radiusM: 120 });
  check('same-count LOD replacement keeps local result', Math.abs(streamedEstimate.groundEstimateY - 4.075) < 1e-9);
  check('same-count LOD replacement triggers a resample', plateau.shouldResamplePlateauGround({
    sampleAttempted: true,
    meshCount: 3,
    now: 2000,
    lastSampleMs: 0,
    signature: 'lod-b',
    lastSignature: 'lod-a',
    lastMeshCount: 3,
    groundStable: true
  }));
  check('stable unchanged stream does not resample early', !plateau.shouldResamplePlateauGround({
    sampleAttempted: true,
    meshCount: 3,
    now: 1000,
    lastSampleMs: 0,
    signature: 'lod-a',
    lastSignature: 'lod-a',
    lastMeshCount: 3,
    groundStable: true
  }));
  check('no global fallback when local candidates are absent',
    plateau.estimatePlateauGroundY([{ distanceM: 900, minY: -80 }], { radiusM: 120 }) === null);
  check('explicitly rejected candidate is ignored',
    plateau.estimatePlateauGroundY([{ distanceM: 10, minY: -80, groundEligible: false }], { radiusM: 120 }) === null);

  global.window = { PLATEAU_GROUND_TARGET_Y: 1.25 };
  check('ground target override remains explicit', plateau.plateauGroundTargetY() === 1.25);
  delete global.window;

  process.stdout.write('PLATEAU ground regression: PASS\n');
}

main().catch((error) => {
  console.error(`PLATEAU ground regression: FAIL\n${error.stack || error}`);
  process.exitCode = 1;
});
