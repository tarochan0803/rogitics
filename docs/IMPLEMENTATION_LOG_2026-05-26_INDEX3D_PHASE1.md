# index3D_V1.0 Phase 0/1 Implementation Log

Date: 2026-05-26

## Implemented

- Added `index3D_V1.0.html` as a 3D-first simulator entry point.
- Added `index3D_V1.0.css` for the 3D simulator layout.
- Added `src/index3dMain.js` to wire:
  - existing `index9.0` route confirmation controls through `initControls()`
  - place route creation
  - fixed short demo route
  - AOI-based 3D world loading after confirmed route creation
  - truck playback controls
  - smoke-test hooks
- Added `src/3d/localWorldBuilder.js` to load a notebook-sized local world around the route:
  - roads and sidewalks via the existing Overpass/GSI hybrid path
  - OSM buildings
  - optional PLATEAU GeoJSON merge
  - AOI guardrails
- Updated `src/ui/map3dThree.js` so the same Three.js renderer opens as a full primary viewport when the body has `index3d`.
- Updated `src/ui/controls.js` so legacy 3D-preview synchronization does not interfere with the index3D primary viewport.
- Added `src/batch/run_index3d_smoke.js` and npm scripts:
  - `npm run index3d:smoke`
  - `npm run index3d:smoke:demo`
  - `npm run index3d:smoke:existing-route`
- Added verification docs:
  - `docs/VERIFY_INDEX3D_PHASE_0.md`
  - `docs/VERIFY_INDEX3D_PHASE_1.md`

## Verification

Passed:

```powershell
node --check src\index3dMain.js
node --check src\batch\run_index3d_smoke.js
node --check src\ui\controls.js
cd src\batch
npm run index3d:smoke
npm run index3d:smoke:existing-route
npm run index3d:smoke:demo
npm run golden:dry
```

HTTP checks from the running local server:

```text
http://127.0.0.1:8080/index9.0.html -> available
http://127.0.0.1:8080/index3D_V1.0.html -> available
```

Startup smoke result:

```text
canvas: 1050 x 920
routePoints: 0
worldLoaded: false
```

Existing-route smoke result:

```text
routePoints: 70
roadFeatures: 436
sidewalkFeatures: 13
buildingFeatures: 75
AOI: 31.58ha
worldLoaded: true
routeLoaded: true
```

Demo smoke result:

```text
routePoints: 65
roadFeatures: 436
sidewalkFeatures: 13
buildingFeatures: 75
AOI: 30.99ha
worldLoaded: true
routeLoaded: true
```

Screenshots:

```text
runtime/logs/index3d_smoke_1779776645158.png
runtime/logs/index3d_smoke_1779776683787.png
runtime/logs/index3d_smoke_1779776710984.png
```

## Notes

- Route confirmation now follows the existing `index9.0` behavior through the shared `controls.js` wiring.
- index3D consumes the confirmed `store.simRoute` and then loads the local 3D world.
- The 3D truck playback now uses the kinematic bicycle pose timeline from `src/core/physics.js`, including speed and steering telemetry in the 3D panel.
- This is still not a full autonomous-driving simulator. It does not yet model sensors, perception, lane-level control, tire dynamics, suspension, traffic, or a formal planner/controller stack.
- The demo route is intentionally short and coordinate-backed so Phase 1 verification stays inside notebook AOI limits.
- `index9.0.html` remains the existing workbench entry.
- `index3D_V1.0.html` is now the 3D-first simulator entry.
- YOLO / Street View fusion and advanced autonomy are left for later phases.
