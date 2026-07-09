 index3D_V1.0 Phase Verification

Phase: 0 - Current system freeze and new entry startup

Date: 2026-05-26

Tester: Codex

## Scope

確認した実装範囲:

- `index3D_V1.0.html` の新規追加
- `index3D_V1.0.css` の新規追加
- `src/index3dMain.js` の新規追加
- `src/3d/localWorldBuilder.js` の新規追加
- `src/ui/map3dThree.js` の index3D 全画面対応
- `src/batch/run_index3d_smoke.js` の新規追加

対象外:

- YOLO / Street View 幅員補正のE2E
- PLATEAU実URLでの建物取得
- 自動運転 planner v1

## Environment

- OS: Windows / PowerShell
- Browser: Puppeteer controlled Chromium/Edge
- URL: `http://127.0.0.1:8080/index3D_V1.0.html`
- Web server: already running on `127.0.0.1:8080`
- YOLO server: not required for Phase 0
- GPU/WebGPU: WebGL canvas smoke only
- Google Maps / Street View key: runtime config dependent
- Google 3D Tiles key: not required

## Commands

```powershell
node --check src\index3dMain.js
node --check src\3d\localWorldBuilder.js
node --check src\ui\map3dThree.js
node --check src\batch\run_index3d_smoke.js
rg --files src -g "*.js" --glob "!src/batch/node_modules/**" --glob "!src/batch/output/**" | ForEach-Object { node --check $_ }
cd src\batch
npm run golden:dry
npm run index3d:smoke
```

## Manual Checks

| Check | Expected | Result | Notes |
|---|---|---|---|
| index9.0 regression | Existing route/data/assessment flow still parses | PASS | Full JS syntax and golden dry run passed |
| index3D startup | Page opens without console/page error | PASS | Puppeteer smoke passed |
| 3D scene | Canvas visible and nonblank | PASS | Canvas `1050 x 920` |
| Route | Route is visible in 3D | N/A | Phase 0 startup only |
| Truck | Truck is visible and can run/reset | N/A | Covered in Phase 1 |
| Contacts | Contact/clearance state is visible | PASS | Panel exists with contact count |

## Automated Checks

| Check | Command | Result | Notes |
|---|---|---|---|
| JS syntax | `node --check ...` | PASS | All source JS passed |
| Python syntax | N/A | N/A | No Python changes |
| Golden dry run | `npm run golden:dry` | PASS | 2 fixtures validated |
| 3D smoke | `npm run index3d:smoke` | PASS | Canvas and startup hooks verified |

## Metrics

| Metric | Value |
|---|---:|
| Load time ms | Not measured |
| Average FPS | Not measured |
| AOI radius m | N/A |
| Road features | 0 |
| Road mesh count | 0 |
| Building features | 0 |
| Building mesh count | 0 |
| Truck pose count | 0 |
| Contact count | 0 |
| Minimum clearance m | N/A |
| YOLO coverage | 0 |

## Artifacts

- Screenshot: `runtime/logs/index3d_smoke_1779766486968.png`
- Browser log: Puppeteer stdout
- Simulation log: N/A
- Benchmark output: `npm run golden:dry`

## Result

Status: `PASS`

Decision:

- Phase 1 implementation and verification can proceed.

Follow-up:

- Keep the Phase 0 smoke as the cheap startup regression check for future changes.

