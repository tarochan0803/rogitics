# index3D_V1.0 Phase Verification

Phase: 4 - Autonomy v1 Sensor / Speed / Stop Planner
Date: 2026-05-26

Tester: Codex

## Scope

Confirmed:

- Phase 4 adds a route-local autonomy report for the 3D simulator.
- The planner samples the confirmed route and calculates:
  - forward sensor range
  - drivable-lane blocker count
  - minimum forward clearance
  - allowed speed
  - stop events
  - slow/yield events
  - steering saturation ratio
- The 3D playback uses the autonomy speed limit to slow or stop visual truck motion.
- The 3D HUD shows autonomy mode and sensor clearance/speed.
- The right panel exposes Phase 4 summary and non-cruise planner events.
- Smoke tests validate a synthetic low-clearance overhead fixture that produces stop events.

Important role split:

- Phase 3 keeps building collision solids for contact judgment.
- Phase 4 forward stopping uses lane blockers: ground obstacle masks and low overhead masks.
- OSM building footprints are intentionally not treated as forward stop blockers, because road-side building polygons are too noisy for a front sensor without lane-level segmentation.

Out of scope for Phase 4:

- Full autonomous driving stack such as lane graph behavior, reversing, dynamic re-planning, traffic rules, or real-time obstacle tracking.
- Street View / YOLO ingestion. Phase 4 consumes structured masks once Phase 5 produces them.
- High-fidelity vehicle control validation against a real truck platform.

## Environment

- OS: Windows / PowerShell
- Browser: Puppeteer controlled Chromium/Edge
- URL: `http://127.0.0.1:8080/index3D_V1.0.html`
- Web server: already running on `127.0.0.1:8080`
- YOLO server: not required for Phase 4 smoke
- Rendering: WebGL / Three.js

## Commands

```powershell
node --check src\sim\autonomy\behaviorPlanner.js
node --check src\ui\map3dThree.js
node --check src\index3dMain.js
node --check src\batch\run_index3d_smoke.js
cd src\batch
npm run golden:dry
npm run index3d:smoke
npm run index3d:smoke:existing-route
npm run index3d:smoke:phase4
```

## Manual Checks

| Check | Expected | Result | Notes |
|---|---|---|---|
| Phase 4 panel | Autonomy summary appears after 3D load | PASS | Right panel `Autonomy / Phase 4` |
| HUD telemetry | Autonomy mode and sensor status appear in 3D HUD | PASS | `map3dAutonomyStatus`, `map3dSensorStatus` |
| Normal route behavior | No fake stop when no lane blocker exists | PASS | Demo and existing route have `stopEventCount=0` |
| Curve speed behavior | Tight geometry produces slow/saturation events | PASS | Demo `slowEventCount=2`; existing route `slowEventCount=11` |
| Low overhead stop | Synthetic low-clearance fixture causes stop events | PASS | Fixture stop events: 7 |
| Visual sensor preview | Sensor rays render in 3D with status coloring | PASS | Green/yellow/red preview lines |

## Automated Checks

| Check | Command | Result | Notes |
|---|---|---|---|
| JS syntax | `node --check src\sim\autonomy\behaviorPlanner.js` | PASS | |
| JS syntax | `node --check src\ui\map3dThree.js` | PASS | |
| JS syntax | `node --check src\index3dMain.js` | PASS | |
| JS syntax | `node --check src\batch\run_index3d_smoke.js` | PASS | |
| Startup smoke | `npm run index3d:smoke` | PASS | No route/world; phase4=null |
| Existing route smoke | `npm run index3d:smoke:existing-route` | PASS | Phase 2/3/4 checks |
| Demo + Phase 4 | `npm run index3d:smoke:phase4` | PASS | Fixture low-clearance stop validation |
| Golden dry run | `npm run golden:dry` | PASS | Existing benchmark fixtures unchanged |

## Latest Phase 4 Smoke Metrics

Demo route:

| Metric | Value |
|---|---:|
| Route points | 65 |
| Route length | 96.0 m |
| Sample count | 33 |
| Sensor range | 34 m |
| Lane blocker count | 0 |
| Stop events | 0 |
| Slow events | 2 |
| Steering saturation ratio | 0.061 |
| Min allowed speed | 4.6 km/h |
| Max allowed speed | 18.0 km/h |
| Fixture detected | true |
| Fixture stop events | 7 |
| Fixture min allowed speed | 0.0 km/h |

Existing route:

| Metric | Value |
|---|---:|
| Route points | 70 |
| Route length | 103.2 m |
| Sample count | 35 |
| Sensor range | 34 m |
| Lane blocker count | 0 |
| Stop events | 0 |
| Slow events | 11 |
| Steering saturation ratio | 0.257 |
| Min allowed speed | 4.6 km/h |
| Fixture stop events | 7 |

## Artifacts

- Startup screenshot: `runtime/logs/index3d_smoke_1779785345910.png`
- Existing-route screenshot: `runtime/logs/index3d_smoke_1779785356781.png`
- Phase 4 demo screenshot: `runtime/logs/index3d_smoke_1779785318746.png`

## Result

Status: `PASS`

Decision:

- Phase 4 exit criteria are met for the current local simulator:
  - The truck now has an autonomy v1 speed layer, not only fixed playback.
  - The planner reports why the truck slows or stops.
  - A low-clearance overhead fixture causes deterministic stop events.
  - Normal demo routes do not stop just because of nearby OSM building footprints.

Follow-up:

- Phase 5 should connect Street View / YOLO outputs to structured lane blockers: parked vehicles, cones, signs, wires, awnings, trees, and construction zones.
- Phase 6 should add benchmark reporting for FPS, runtime contact count, min clearance, stop count, steering saturation, and reverse/replan count.
