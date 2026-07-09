# index3D_V1.0 Phase Verification

Phase: 1 - 3D-first local simulator MVP

Date: 2026-05-26

Tester: Codex

## Scope

Confirmed:

- `index3D_V1.0.html` starts as the primary 3D simulator entry.
- Route confirmation can reuse the existing `index9.0` flow through `initControls()`:
  - road data refresh
  - map endpoint selection
  - route confirmation
  - selected route stored in `store.simRoute`
- After route confirmation, index3D loads the local 3D world from the confirmed route.
- Three.js renders road surfaces, sidewalks, buildings, route line, and truck model in the primary viewport.
- Truck playback controls run, pause, and reset.
- Puppeteer smoke checks cover startup, demo route, and the existing-route confirmation flow.

Out of scope for Phase 1:

- YOLO / Street View correction.
- Real PLATEAU dataset selection beyond optional GeoJSON merge hook.
- Autonomous-driving behavior planner v1.
- FPS/load-time benchmarking.

## Environment

- OS: Windows / PowerShell
- Browser: Puppeteer controlled Chromium/Edge
- URL: `http://127.0.0.1:8080/index3D_V1.0.html`
- Web server: already running on `127.0.0.1:8080`
- YOLO server: not required for Phase 1
- Rendering: WebGL / Three.js
- Google Maps / Street View key: runtime config dependent
- Google 3D Tiles key: not required

## Commands

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

## Manual Checks

| Check | Expected | Result | Notes |
|---|---|---|---|
| index3D startup | Page opens without console/page error | PASS | Puppeteer smoke passed |
| Existing route flow | Road refresh, endpoint clicks, route confirm work | PASS | Uses `index9.0` control wiring |
| Post-confirm 3D load | Confirmed route triggers local 3D world load | PASS | `routeLoaded=true`, `worldLoaded=true` |
| 3D scene | Canvas visible and sized | PASS | 1050 x 920 in smoke viewport |
| Route | Route is visible in 3D | PASS | Existing-route and demo route drawn |
| Truck | Truck is visible and can run/reset | PASS | Demo starts 3D simulation |
| Legacy regression | Golden dry run still passes | PASS | Browser execution skipped by dry run |

## Automated Checks

| Check | Command | Result | Notes |
|---|---|---|---|
| JS syntax | `node --check src\index3dMain.js` | PASS | |
| JS syntax | `node --check src\batch\run_index3d_smoke.js` | PASS | |
| JS syntax | `node --check src\ui\controls.js` | PASS | |
| Startup smoke | `npm run index3d:smoke` | PASS | Canvas only, no route |
| Existing route smoke | `npm run index3d:smoke:existing-route` | PASS | index9-style road/endpoints/confirm flow |
| Demo route smoke | `npm run index3d:smoke:demo` | PASS | Network-backed short demo route/world load |
| Golden dry run | `npm run golden:dry` | PASS | Existing benchmark fixture check |

## Latest Smoke Metrics

Existing-route smoke:

| Metric | Value |
|---|---:|
| Canvas width | 1050 |
| Canvas height | 920 |
| Route points | 70 |
| AOI area ha | 31.58 |
| Road features | 436 |
| Sidewalk features | 13 |
| Building features | 75 |
| OSM building features | 75 |
| PLATEAU building features | 0 |
| worldLoaded | true |
| routeLoaded | true |

Demo route smoke:

| Metric | Value |
|---|---:|
| Route points | 65 |
| AOI area ha | 30.99 |
| Road features | 436 |
| Sidewalk features | 13 |
| Building features | 75 |
| PLATEAU building features | 0 |

## Artifacts

- Startup screenshot: `runtime/logs/index3d_smoke_1779776645158.png`
- Existing-route screenshot: `runtime/logs/index3d_smoke_1779776683787.png`
- Demo screenshot: `runtime/logs/index3d_smoke_1779776710984.png`
- Browser log: Puppeteer stdout
- Simulation log: in-app log panel

## Result

Status: `PASS`

Decision:

- Phase 1 is usable as a 3D-first simulator shell.
- Route confirmation remains aligned with `index9.0`; index3D now consumes the confirmed route and builds the local 3D world around it.

Follow-up:

- Phase 2 should improve road width attribution and road surface detail.
- Add FPS/load-time measurement to smoke output before heavier autonomy work.
