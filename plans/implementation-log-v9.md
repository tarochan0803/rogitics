# LOGISTICS_OS v9 Implementation Log

## 2026-05-22

### Preflight

1. Checked current active JavaScript syntax in `src/**/*.js`.
2. Checked active inline scripts in `index8.2.html`.
3. Result: no current syntax error was found in checked active sources. If the browser still shows `Unexpected token ')'`, the most likely cause is stale cached JavaScript or an older served file.

### A-1 Golden Route Benchmark

1. Added `benchmarks/golden-routes.json` as the first fixed benchmark fixture file.
2. Added `src/batch/run_golden_benchmark.js` to execute browser-based route generation and delivery assessment with Puppeteer.
3. Added npm scripts in `src/batch/package.json`.
4. The initial fixture statuses are intentionally non-strict seed cases. A route becomes a real KPI golden only after its expected status/passable result is locked from a confirmed route.

Validation:

1. `node --check src\batch\run_golden_benchmark.js` passed.
2. `npm run golden:dry` passed and validated 2 fixture cases.
3. `rg --files src -g "*.js" | ForEach-Object { node --check $_ }` passed for all source JavaScript.
4. `http://127.0.0.1:8080/index8.2.html` returned HTTP 200.
5. Full browser benchmark completed with 2/2 cases, 0 runtime errors, output at `runtime/benchmarks/20260522T001248Z`.

Observed seed-case result:

1. `tokyo-station-short-4t`: `NG`, score `0`, route points `687`, road features `941`.
2. `nihonbashi-local-10t`: `NG`, score `0`, route points `455`.
3. These are still `MEASURE` rows, not KPI pass/fail rows, because no real accepted golden route expectation has been locked yet.

Additional integration fix:

1. Added `store.setVehiclePresetName` as a compatibility alias to `applyVehiclePreset`.
2. Reason: `src/ui/controls.js` already calls `store.setVehiclePresetName(preset)` from vehicle result cards, but `src/state.js` did not expose that method.
3. `node --check src\state.js` passed.

### A-4 / A-5 / A-11 / A-9 / B-1 / B-2 / B-11 Feature Pass

Implemented:

1. A-4: Added `buildWidthFusionValidationReport()` and exposed `window.validateWidthFusion()`.
2. A-5: Added sharp-curve calibration output to the kinematics result.
3. A-11: Replaced fixed 4-direction detour trials with generated 8-direction, variable-distance waypoint trials (`45m`, `75m`, `115m`) and ranked all candidates instead of stopping at the first pass.
4. A-9: Added Leaflet.Draw polygon obstacle drawing. Polygon obstacles are stored in `maskEdits.deny` and participate in collision/road-union checks.
5. B-1: Added PLATEAU GeoJSON building loader entry point. Loaded features are normalized with height metadata and merged into `buildingsGeoJSON`.
6. B-2: Added full-voxel collision entry point with WebGPU capability detection and CPU voxel-raster fallback. The result is included in `deliveryAssessment.voxelCollision`.
7. B-11: Expanded vehicle kinematics with a drive-simulation timeline preview, brake demand, steering angle, and stop-and-go metrics.

Validation:

1. `node --check` passed for the touched modules.
2. Full `src/**/*.js` syntax check passed.
3. `npm run golden:dry` passed.
4. Browser golden benchmark `tokyo-station-short-4t` completed with no runtime error at `runtime/benchmarks/20260522T004129Z`.
5. The benchmark result now includes `widthFusion`, `voxelBackend`, `voxelStatus`, `curveCalibration`, and `driveSimulation`.

Observed benchmark data:

1. `widthFusion.averageConfidence`: `0.814`.
2. `widthFusion.yoloCoverage`: `0` for the seed route because no YOLO width data was present in that run.
3. `voxelBackend`: `webgpu-ready-cpu-raster`; WebGPU capability was detected, with the current implementation using the CPU voxel-raster fallback path.
4. `curveCalibration.currentThreshold`: `6m`, `recommendedThreshold`: `6m`.
5. `driveSimulation.timeSeconds`: `67s`, `sampleCount`: `666`.

### Remote GPU Voxel Collision for 192.168.2.116

Implemented:

1. Added `remoteVoxelServerUrl` to runtime configuration. If it is blank, the app uses `yoloServerUrl` as the voxel server URL.
2. Added `/voxel-collision` to `server/app.py`.
3. The server endpoint uses `torch.cuda` when CUDA is available for footprint/obstacle bbox candidate filtering.
4. Exact polygon intersection is still verified server-side after GPU candidate filtering, so GPU acceleration does not replace the final geometric truth check.
5. Frontend voxel collision now tries `remoteVoxelServerUrl` or `yoloServerUrl` first, then falls back to local CPU voxel raster after a 4.5s timeout.
6. Delivery assessment and benchmark output now expose `voxelCollision.remote`, `remoteUrl`, and `gpu`.

Validation:

1. `python -m py_compile server\app.py server\runtime_settings.py` passed.
2. `node --check` passed for the touched frontend modules.
3. Direct Python call to `voxel_collision()` returned `NG cpu-bbox 1`; local machine has `torch` but no CUDA.
4. Runtime config resolves both `yoloServerUrl` and `remoteVoxelServerUrl` to `http://192.168.2.116:8001`.
5. `192.168.2.116:8001` was not reachable from this machine during this work, so the actual remote CUDA path could not be exercised yet.
