# index3D_V1.0 Phase Verification

Phase: 3 - Building / Obstacle Solids and Overhead Clearance
Date: 2026-05-26

Tester: Codex

## Scope

Confirmed:

- Building meshes are separated from collision-purpose solids.
- Manual/YOLO obstacle masks are classified into ground obstacles and height-only overhead obstacles.
- Overhead obstacles with `heightOnly`, `clearanceHeight`, or `h` are compared with vehicle height plus cargo stack height and a clearance margin.
- The right panel exposes building solids, ground obstacles, overhead obstacle count, required height, route overhead count, and low-clearance count.
- Phase 3 road quality supplement renders independent road edge and centerline layers, and adds angle-based turn caps for sharp route corners.
- Smoke tests validate the Phase 3 path using a synthetic low-clearance overhead fixture.

Out of scope for Phase 3:

- Automatic Street View / YOLO collection pipeline for new overhead obstacles.
- High-fidelity building datasets such as PLATEAU mesh ingestion beyond the current footprint workflow.
- Full autonomous planning behavior; this phase only gives the simulator cleaner collision and clearance primitives.

## Environment

- OS: Windows / PowerShell
- Browser: Puppeteer controlled Chromium/Edge
- URL: `http://127.0.0.1:8080/index3D_V1.0.html`
- Web server: already running on `127.0.0.1:8080`
- YOLO server: not required for Phase 3 smoke
- Rendering: WebGL / Three.js

## Commands

```powershell
node --check src\3d\clearanceSolids.js
node --check src\ui\map3dThree.js
node --check src\index3dMain.js
node --check src\batch\run_index3d_smoke.js
cd src\batch
npm run golden:dry
npm run index3d:smoke
npm run index3d:smoke:existing-route
npm run index3d:smoke:phase3
```

## Manual Checks

| Check | Expected | Result | Notes |
|---|---|---|---|
| Solid panel | Building / obstacle / overhead summary appears after 3D load | PASS | Right panel section `建物・障害物` |
| Building solids | OSM buildings are counted as lateral collision solids | PASS | Demo route: 75 building solids |
| Ground obstacles | Non-heightOnly deny masks become lateral obstacle solids | PASS | Supported by `buildCollisionSolidSet()` |
| Overhead obstacles | heightOnly masks stay separate from lateral solids | PASS | Supported by `heightOnly` / `clearanceHeight` / `h` |
| Clearance judgment | Required height is vehicle height + cargo stack + margin | PASS | Demo required height: 2.75 m |
| Low clearance validation | Synthetic low-clearance fixture is detected | PASS | `fixtureLowClearanceCount=1` |
| Road supplement | Road edge and centerline layers render separately | PASS | Demo: roadEdges=19, centerlines=436 |
| Sharp turn caps | Angle-based caps are created on sharp route bends | PASS | Existing route smoke: intersectionCaps=2 |

## Automated Checks

| Check | Command | Result | Notes |
|---|---|---|---|
| JS syntax | `node --check src\3d\clearanceSolids.js` | PASS | |
| JS syntax | `node --check src\ui\map3dThree.js` | PASS | |
| JS syntax | `node --check src\index3dMain.js` | PASS | |
| JS syntax | `node --check src\batch\run_index3d_smoke.js` | PASS | |
| Startup smoke | `npm run index3d:smoke` | PASS | No route/world; phase3=null |
| Existing route smoke | `npm run index3d:smoke:existing-route` | PASS | Route UX compatibility + Phase 2/3 checks |
| Demo + Phase 3 | `npm run index3d:smoke:phase3` | PASS | Phase 2 regression + Phase 3 clearance fixture |
| Golden dry run | `npm run golden:dry` | PASS | Existing benchmark fixtures unchanged |

## Latest Phase 3 Smoke Metrics

Demo route:

| Metric | Value |
|---|---:|
| Route points | 65 |
| Road features | 436 |
| Building features | 75 |
| Building solids | 75 |
| Ground obstacle solids | 0 |
| Overhead solids | 0 |
| Low-clearance count | 0 |
| Fixture low-clearance count | 1 |
| Required height | 2.75 m |
| Road edges | 19 |
| Centerlines | 436 |
| Intersection caps | 0 |

Existing route:

| Metric | Value |
|---|---:|
| Route points | 70 |
| Road features | 436 |
| Building features | 75 |
| Building solids | 75 |
| Fixture low-clearance count | 1 |
| Road edges | 19 |
| Centerlines | 436 |
| Intersection caps | 2 |

## Artifacts

- Startup screenshot: `runtime/logs/index3d_smoke_1779784378739.png`
- Existing-route screenshot: `runtime/logs/index3d_smoke_1779784412239.png`
- Phase 3 demo screenshot: `runtime/logs/index3d_smoke_1779784434510.png`

## Result

Status: `PASS`

Decision:

- Phase 3 exit criteria are met for the current local simulator:
  - Collision-purpose solids are separated from visual building meshes.
  - Ground obstacle and overhead obstacle classes are kept separate.
  - Overhead clearance can be validated against vehicle/cargo height.
  - Phase 3 status is visible in the UI and exposed to smoke tests.
  - Road edge, centerline, and angle-based turn-cap supplements are active.

Follow-up:

- Phase 4 should use these solids for autonomy: speed limits from clearance/width, sensor rays, stop/yield behavior, and steering saturation metrics.
- Street View / YOLO ingestion should feed `heightOnly` masks with confidence, stationing, lateral offset, and measured or estimated `clearanceHeight`.
