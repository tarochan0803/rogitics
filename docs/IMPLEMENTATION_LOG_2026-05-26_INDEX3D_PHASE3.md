# Implementation Log - index3D_V1.0 Phase 3

Date: 2026-05-26
Author: Codex

## Goal

Implement Phase 3 as a usable simulator layer, not only visual decoration:

- Separate visual buildings from collision-purpose solids.
- Treat buildings, ground obstacles, and overhead obstacles as different classes.
- Compare overhead clearance against vehicle height plus cargo stack height.
- Expose the result in the `index3D_V1.0` UI.
- Add Phase 3 smoke validation that can run without external YOLO or Street View services.
- Add road quality follow-up layers: road edges, centerlines, and angle-based turn surface correction.

## Key Design

`src/3d/clearanceSolids.js` is the Phase 3 data boundary.

- `buildCollisionSolidSet()` converts loaded buildings and mask edits into:
  - `buildingSolids`
  - `obstacleSolids`
  - `overheadSolids`
  - `lateralSolids`
- `buildClearanceSolidReport()` produces UI/smoke-ready counts and route-near overhead clearance rows.
- `getVehicleEnvelope()` derives physical and required height from vehicle config and cargo.
- `makeRouteOverheadFixture()` creates an in-memory low-clearance obstacle for deterministic smoke validation.

Overhead obstacles are only treated as lateral blockers when the vehicle envelope exceeds their clearance height. This keeps a passable wire/sign/awning different from a wall or parked object.

## Changes

### New

- `src/3d/clearanceSolids.js`
  - Solid classification.
  - Height extraction from `clearanceHeight`, `clearance_height`, `h`, `height`, `min_height`, and related properties.
  - Vehicle/cargo envelope calculation.
  - Route corridor clearance reporting.
  - Synthetic low-clearance fixture for smoke tests.

### Modified

- `src/ui/map3dThree.js`
  - Replaced building-only collision arrays with lateral and overhead collision sets.
  - Rendered ground obstacle solids and overhead slabs separately from visual buildings.
  - Added height-aware truck collision checks for overhead objects.
  - Exported `getCollisionSolidMetrics()`.
  - Added road edge and centerline layers.
  - Added angle-based turn caps to road-surface generation for sharp route bends.

- `src/index3dMain.js`
  - Added Phase 3 report generation and UI rendering.
  - Added `window.index3DGetClearanceSolidReport()`.
  - Added `window.index3DRunPhase3Validation()`.
  - Included Phase 3 summary in `window.index3DStats()`.

- `index3D_V1.0.html` / `index3D_V1.0.css`
  - Added the right-panel `建物・障害物` Phase 3 section.
  - Displays solid counts, required height, overhead route count, low-clearance count, and road supplement metrics.

- `src/batch/run_index3d_smoke.js`
  - Added Phase 3 smoke checks.
  - Demo/existing-route smoke now asserts that synthetic low-clearance overhead detection works.

- `src/batch/package.json`
  - Added `index3d:smoke:phase3`.

## Verification

All checks passed:

- `node --check src\3d\clearanceSolids.js`
- `node --check src\ui\map3dThree.js`
- `node --check src\index3dMain.js`
- `node --check src\batch\run_index3d_smoke.js`
- `npm run golden:dry`
- `npm run index3d:smoke`
- `npm run index3d:smoke:existing-route`
- `npm run index3d:smoke:phase3`

Latest demo metrics:

- routePoints=65
- roads=436
- buildings=75
- buildingSolids=75
- groundObstacles=0
- overheadSolids=0
- lowClearance=0
- fixtureLowClearanceCount=1
- requiredHeightM=2.75
- roadEdges=19
- centerlines=436
- intersectionCaps=0

Latest existing-route metrics:

- routePoints=70
- roads=436
- buildings=75
- buildingSolids=75
- fixtureLowClearanceCount=1
- roadEdges=19
- centerlines=436
- intersectionCaps=2

Detailed verification: `docs/VERIFY_INDEX3D_PHASE_3.md`.

## Notes / Deferred

- The Marunouchi demo area currently has no real overhead obstacle masks, so `overheadSolidCount=0` in the live dataset. The synthetic fixture proves the clearance path is wired correctly.
- Street View / YOLO should now output structured mask edits with `heightOnly`, `clearanceHeight`, confidence, and route stationing so Phase 3 can consume them directly.
- Phase 4 should build autonomous driving behavior on top of these primitives: sensor rays, speed selection, stop decisions, steering saturation, and clearance-aware route execution.
