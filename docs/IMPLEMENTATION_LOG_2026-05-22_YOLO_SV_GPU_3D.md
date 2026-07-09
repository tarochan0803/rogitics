# LOGISTICS OS v9.0 implementation log

Date: 2026-05-22

Scope:
- YOLO road-width estimation
- Street View real-image analysis
- remote/local voxel GPU path
- 3D city display

## Implemented

### YOLO road-width estimation
- `src/ui/controls.js`
  - Sets `#yoloApiBase` from `runtime-config.js` on startup.
  - `checkYoloServerStatus()` now displays model, segmentation, CUDA/CPU, and voxel endpoint state.
  - Exposes these browser-test hooks:
    - `window.runSatelliteYoloEstimate`
    - `window.runSvYoloWidthPipeline`
    - `window.checkYoloServerStatus`

Verified:
- Browser label: `YOLO: running / CPU torch / model OK / seg OK / voxel OK`
- `/status` returns model loaded, segmentation model loaded, and `/voxel-collision` endpoint.

### Street View real-image analysis
- `src/ui/streetviewScan.js`
  - No longer aborts when road-surface mask samples are empty.
  - Falls back to route samples and still builds Google Static Street View image URLs.
  - If Google Maps key is missing, it fails with a clear status.

Verified:
- Browser pipeline called local `/detect-batch`.
- Street View frames were produced and detections were returned.
- Width application can still return `no_estimates` when detections do not pass width-estimation filters; that is a data/result condition, not a dead pipeline.

### 3D city display
- `index8.2.html`
  - Adds Cesium CSS/JS.
  - Restores `#map3dWrap`, `#map3d`, `#map3dPanel`, 3D controls, PLATEAU/GBA controls.
- `src/main.js`
  - Imports and initializes `initMap3D('map3d')`.
- `src/ui/controls.js`
  - Enables 3D UI (`GBA_3D_REMOVED = false`).
  - Restores open/close/play/pause/load handlers.
  - Keeps `aria-hidden` synchronized.
- `index8.2.css`
  - Adds stable 3D panel sizing and responsive layout.
- `src/ui/map3dTiles.js`
  - Catches Cesium/WebGL initialization failure and reports `3D Tiles: WebGL unavailable` instead of leaving an uncaught exception.

Verified:
- Browser title and brand show v9.0.
- `window.Cesium === true`.
- 3D panel opens, `#map3dWrap.open === true`, display is `flex`.
- With WebGL enabled in headless Chromium flags, Cesium canvas is created and status is `3D Tiles: off (schema mode)`.

### Remote/local voxel GPU path
- `src/ui/deliveryPanel.js`
  - Adds visible `3D voxel` detail in the判定 panel:
    - status
    - remote/local fallback
    - backend
    - GPU/WebGPU/CPU state
    - contact counts

Verified:
- Local voxel API:
  - `POST http://127.0.0.1:8001/voxel-collision`
  - Result: HTTP 200, `status=NG`, `backend=cpu-bbox`, `cuda=false`, `contacts=1`
- Remote GPU host `192.168.2.116`:
  - Ports `8001`, `8787`, `8080`, `22` all timed out.
  - `http://192.168.2.116:8001/status` timed out.

Conclusion:
- Local voxel fallback is working.
- `192.168.2.116` is not reachable from this PC right now, so remote GPU cannot be verified or used until the service/network is restored.

## Syntax checks

Passed:

```powershell
node --check src\ui\controls.js
node --check src\ui\streetviewScan.js
node --check src\ui\deliveryPanel.js
node --check src\main.js
node --check src\ui\map3dTiles.js
node --check src\core\webgpuVoxelCollision.js
```

## Remaining hard blockers

- CUDA is not available on the local YOLO server (`cuda=false`).
- Remote GPU host `192.168.2.116` is unreachable.
- Width estimation can execute and analyze images, but road-width overrides depend on detections passing the geometric width filters.
- Google 3D Tiles photoreal mode still requires a valid Google Map Tiles API setup; schema-mode Cesium display is active.
