# Implementation Log - index3D_V1.0 Phase 4

Date: 2026-05-26
Author: Codex

## Goal

Move the 3D simulator from simple kinematic playback toward an autonomy-style execution layer:

- Sample the route with a forward sensor model.
- Compute speed limits from upcoming blockers and steering demand.
- Stop when low-clearance overhead or ground blockers occupy the route corridor.
- Surface planner status in the 3D HUD and right panel.
- Add smoke validation that does not depend on external YOLO or Street View services.

## Key Design

New module: `src/sim/autonomy/behaviorPlanner.js`.

It builds an `AutonomyDriveReport` from:

- confirmed route
- vehicle config
- cargo height
- ground obstacle masks
- height-only overhead masks
- cruise speed

The report contains:

- `summary.status`: `CRUISE`, `SLOW`, or `STOP`
- route length and sample count
- sensor range
- blocker count
- minimum forward clearance
- stop and slow event counts
- steering saturation ratio
- min/max allowed speed
- blocker IDs
- per-sample planner rows

Buildings remain Phase 3 collision solids. They are not used as Phase 4 forward stop blockers because OSM building footprints near roads produce false front-sensor stops without lane-level segmentation.

## Changes

### New

- `src/sim/autonomy/behaviorPlanner.js`
  - Builds forward sensor samples along the route.
  - Consumes Phase 3 obstacle/overhead solids.
  - Calculates obstacle-based stop speed using braking distance.
  - Calculates curve/steering speed limits.
  - Produces UI and smoke-test-ready summary data.

### Modified

- `src/ui/map3dThree.js`
  - Imports the autonomy planner.
  - Builds an autonomy report when `playThree3D()` starts.
  - Draws sensor preview rays in the 3D scene.
  - Applies autonomy speed limits to playback time progression, so the truck slows or stops instead of always moving at fixed playback speed.
  - Exports `getAutonomyDriveMetrics()`.

- `src/index3dMain.js`
  - Adds Phase 4 report generation.
  - Adds the Phase 4 right-panel renderer.
  - Adds `window.index3DGetAutonomyReport()`.
  - Adds `window.index3DRunPhase4Validation()`.
  - Includes Phase 4 summary in `window.index3DStats()`.

- `index3D_V1.0.html` / `index3D_V1.0.css`
  - Adds 3D HUD autonomy and sensor lines.
  - Adds the `Autonomy / Phase 4` control section.
  - Adds status colors for cruise/slow/stop planner events.

- `src/batch/run_index3d_smoke.js`
  - Adds Phase 4 validation to world-loaded smoke paths.
  - Uses a synthetic low-clearance overhead fixture to assert stop planning.

- `src/batch/package.json`
  - Adds `index3d:smoke:phase4`.

## Verification

All checks passed:

- `node --check src\sim\autonomy\behaviorPlanner.js`
- `node --check src\ui\map3dThree.js`
- `node --check src\index3dMain.js`
- `node --check src\batch\run_index3d_smoke.js`
- `npm run golden:dry`
- `npm run index3d:smoke`
- `npm run index3d:smoke:existing-route`
- `npm run index3d:smoke:phase4`

Latest demo metrics:

- routePoints=65
- routeLengthM=96.0
- sampleCount=33
- sensorRangeM=34
- blockerCount=0
- stopEventCount=0
- slowEventCount=2
- steeringSaturationRatio=0.061
- minAllowedSpeedKmh=4.6
- fixtureStopEventCount=7
- fixtureDetected=true

Latest existing-route metrics:

- routePoints=70
- routeLengthM=103.2
- sampleCount=35
- blockerCount=0
- stopEventCount=0
- slowEventCount=11
- steeringSaturationRatio=0.257
- fixtureStopEventCount=7

Detailed verification: `docs/VERIFY_INDEX3D_PHASE_4.md`.

## Notes / Deferred

- The current autonomy layer is deterministic and lightweight enough for a normal laptop.
- It is still not a full self-driving stack. It is a simulator control layer that exposes speed/stop/steering decisions.
- Phase 5 should feed real YOLO / Street View obstacle observations into `maskEdits.deny` with `heightOnly`, `clearanceHeight`, confidence, stationing, and lateral offset.
- Phase 6 should add benchmark-grade runtime metrics and route comparison reports.
