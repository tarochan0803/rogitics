# index3D_V1.0 Phase Verification

Phase: 6 - 3D Benchmark & Calibration
Date: 2026-05-27

Tester: Codex

## Scope

Confirmed:

- Added a dedicated index3D benchmark runner for `index3D_V1.0.html`.
- Added deterministic 3D benchmark fixtures with `CONFIRMED_PASS`, `CONFIRMED_FAIL`, and Phase 5 measurement cases.
- Benchmark output includes:
  - load time
  - FPS
  - contact count
  - minimum clearance
  - stop/slow events
  - steering saturation ratio
  - reverse count
  - YOLO coverage
  - obstacle solid count
- Benchmark writes JSON, Markdown, and browser console artifacts under `runtime/benchmarks3d/<timestamp>/`.
- Phase 6 smoke runs a single confirmed pass case.
- Full 3D benchmark runs all current cases and checks expectations.

Out of scope for Phase 6:

- Field-confirmed customer delivery routes. Current `CONFIRMED_*` cases are deterministic simulator fixtures.
- Real Street View / YOLO service integration. Phase 5 synthetic perception remains the measurable fallback.
- Reverse/replan maneuver implementation. `reverseCount` is emitted as `0` until a reverse planner exists.

## Environment

- OS: Windows / PowerShell
- Browser: Puppeteer controlled Chromium/Edge
- URL: `http://127.0.0.1:8080/index3D_V1.0.html`
- Web server: already running on `127.0.0.1:8080`
- Rendering: WebGL / Three.js

## Commands

```powershell
node --check src\batch\run_index3d_benchmark.js
cd src\batch
npm run index3d:benchmark:dry
npm run index3d:smoke:phase6
npm run index3d:benchmark
npm run golden:dry
```

Phase 5 was also re-verified before Phase 6:

```powershell
node --check src\3d\perceptionFusion.js
node --check src\index3dMain.js
node --check src\batch\run_index3d_smoke.js
cd src\batch
npm run index3d:smoke:phase5
```

## Automated Checks

| Check | Command | Result | Notes |
|---|---|---|---|
| Phase 5 syntax | `node --check src\3d\perceptionFusion.js` | PASS | Existing Phase 5 verified first |
| Main syntax | `node --check src\index3dMain.js` | PASS | |
| Smoke syntax | `node --check src\batch\run_index3d_smoke.js` | PASS | |
| Phase 6 syntax | `node --check src\batch\run_index3d_benchmark.js` | PASS | |
| Phase 5 smoke | `npm run index3d:smoke:phase5` | PASS | phase5.ok=true |
| 3D benchmark dry run | `npm run index3d:benchmark:dry` | PASS | 3 cases validated |
| Phase 6 smoke | `npm run index3d:smoke:phase6` | PASS | `CONFIRMED_PASS_DEMO_CLEAR` |
| Full 3D benchmark | `npm run index3d:benchmark` | PASS | 3/3 cases, failedExpectations=0 |
| Legacy golden dry run | `npm run golden:dry` | PASS | Existing benchmark fixture unchanged |

## Latest Full 3D Benchmark

Output:

- `runtime/benchmarks3d/20260527T004222Z/summary.json`
- `runtime/benchmarks3d/20260527T004222Z/summary.md`
- `runtime/benchmarks3d/20260527T004222Z/browser-console.json`

Summary:

| Metric | Value |
|---|---:|
| Cases | 3 |
| Completed | 3 |
| Failed expectations | 0 |
| Average FPS | 53.067 |
| Average load time | 4,751 ms |
| Average YOLO coverage | 0.001 |

Case results:

| Case | Class | Status | FPS | Load ms | Stop | Contact | Min clearance | Steering saturation | Reverse | YOLO coverage | Check |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| `CONFIRMED_PASS_DEMO_CLEAR` | CONFIRMED_PASS | SLOW | 47.5 | 5,399 | 0 | 1 | - | 0.061 | 0 | 0 | PASS |
| `CONFIRMED_FAIL_DEMO_LOW_CLEARANCE` | CONFIRMED_FAIL | STOP | 57.4 | 4,635 | 7 | 1 | 0 | 0.061 | 0 | 0 | PASS |
| `MEASURE_DEMO_PERCEPTION_FUSION` | MEASURE | STOP | 54.3 | 4,220 | 8 | 1 | -0.15 | 0.061 | 0 | 0.002 | PASS |

## Result

Status: `PASS`

Decision:

- Phase 6 exit criteria are met for the current simulator:
  - 3D benchmark runner exists.
  - Deterministic `CONFIRMED_PASS` and `CONFIRMED_FAIL` cases are fixed.
  - Required benchmark metrics are emitted.
  - Phase 5 YOLO coverage and obstacle channel are included in benchmark output.
  - Current benchmark results are stored as JSON and Markdown artifacts.

Follow-up:

- Replace deterministic simulator fixtures with field-confirmed delivery routes as they become available.
- Add reverse/replan behavior, then make `reverseCount` a real measured value.
- Add stricter contact thresholds after road/building alignment is calibrated against confirmed routes.
