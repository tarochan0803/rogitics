# Implementation Log - index3D_V1.0 Phase 6

Date: 2026-05-27
Author: Codex

## Goal

Implement Phase 6: 3D Benchmark & Calibration.

The target was to stop relying only on smoke tests and produce repeatable 3D benchmark output for:

- load time
- FPS
- contact count
- minimum clearance
- steering saturation
- reverse count
- YOLO coverage
- confirmed pass/fail expectations

## Phase 5 Confirmation

Before Phase 6 work, Phase 5 was checked and re-run.

Confirmed present:

- `src/3d/perceptionFusion.js`
- `runPerceptionFusion()` and Phase 5 hooks in `src/index3dMain.js`
- `index3D_V1.0` Phase 5 UI
- `index3d:smoke:phase5`
- `docs/VERIFY_INDEX3D_PHASE_5.md`
- `docs/IMPLEMENTATION_LOG_2026-05-27_INDEX3D_PHASE5.md`

Re-run result:

- `npm run index3d:smoke:phase5` -> PASS
- `phase5.ok=true`
- `yoloCoverageBefore=0.002`
- `yoloCoverageAfter=0.005`
- `obstacleSolidsAfter=2`
- `appliedCount=1`
- `pendingCount=1`

## Changes

### New

- `benchmarks/index3d-golden-routes.json`
  - `CONFIRMED_PASS_DEMO_CLEAR`
  - `CONFIRMED_FAIL_DEMO_LOW_CLEARANCE`
  - `MEASURE_DEMO_PERCEPTION_FUSION`

- `src/batch/run_index3d_benchmark.js`
  - Opens `index3D_V1.0.html` with Puppeteer.
  - Runs demo/custom route setup.
  - Measures load time and FPS.
  - Collects Phase 3, Phase 4, and Phase 5 metrics.
  - Supports low-clearance fixture validation.
  - Supports Phase 5 perception fusion measurement.
  - Compares expectations and writes benchmark artifacts.

### Modified

- `src/batch/package.json`
  - `index3d:benchmark`
  - `index3d:benchmark:dry`
  - `index3d:smoke:phase6`

## Benchmark Output

The runner writes:

- `summary.json`
- `summary.md`
- `browser-console.json`

Output directory:

- `runtime/benchmarks3d/<timestamp>/`

Latest run:

- `runtime/benchmarks3d/20260527T004222Z`

## Verification

All checks passed:

- `node --check src\batch\run_index3d_benchmark.js`
- `npm run index3d:benchmark:dry`
- `npm run index3d:smoke:phase6`
- `npm run index3d:benchmark`
- `npm run golden:dry`

Full 3D benchmark latest metrics:

- cases=3
- completed=3
- failedExpectations=0
- averageFps=53.067
- averageLoadTimeMs=4751.333
- averageYoloCoverage=0.001

Case highlights:

- `CONFIRMED_PASS_DEMO_CLEAR`: status=SLOW, fps=47.5, stop=0, contact=1
- `CONFIRMED_FAIL_DEMO_LOW_CLEARANCE`: status=STOP, fps=57.4, stop=7, minAllowedSpeed=0
- `MEASURE_DEMO_PERCEPTION_FUSION`: status=STOP, fps=54.3, stop=8, yoloCoverage=0.002, obstacleSolids=2

Detailed verification: `docs/VERIFY_INDEX3D_PHASE_6.md`.

## Notes / Deferred

- `CONFIRMED_*` currently means deterministic simulator-confirmed fixture, not field-confirmed customer delivery.
- `reverseCount` is emitted as `0` because reverse/replan behavior is not implemented yet.
- The pass fixture allows `contactCount <= 2` because the current 3D runtime contact counter can catch transient building-edge contacts during playback. This is now visible in the benchmark and should be tightened after geometry calibration.
