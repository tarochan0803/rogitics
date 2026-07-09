# index3D_V1.0 Phase Verification

Phase: 5 - Perception Fusion（Street View / YOLO → 道路幅候補 + 障害物入力）

Date: 2026-05-27

Tester: Claude

## Scope

Confirmed:

- 経路上を stationing（一定間隔サンプル）で管理し、知覚由来の幅候補・障害物を経路に紐づける。
- 道路幅候補は1枚で決めず、同一道路の複数フレーム中央値＋フレーム数で信頼度を算出。
  - 高信頼（≥0.7）かつ既存幅から十分外れる候補のみ `width_ai` として自動採用（Phase2 の幅融合・3D走行面に反映）。
  - 低信頼/差分小は「確認待ち」に残し、自動採用しない。
- YOLO 障害物（地上=駐車車両 / 頭上=低い庇）を `maskEdits.deny` に注入し、Phase3 ソリッドと Phase4 自律判断（前方センサー/停止）へ反映。
- Street View / YOLO サーバ未接続でも落ちず、合成スキャンにフォールバックしてスキップ理由を表示。
- 右パネル「知覚補正」に、採用/確認待ちの幅候補と障害物、YOLO幅カバレッジを表示。

新規/変更:

- 新規: `src/3d/perceptionFusion.js`
  - `buildRouteStations` / `aggregateWidthSuggestions`（中央値＋フレーム信頼度、自動採用判定）/ `buildObstacleFeatures`（点→ポリゴン障害物、頭上フラグ）/ `makeSyntheticPerceptionScan`（SV/YOLO未接続時のフォールバック・fixture）。
- 変更: `src/index3dMain.js`
  - `runPerceptionFusion` … 幅候補の自動採用（`store.applyWidthOverride` で width_ai）/ YOLO障害物の `store.addMaskEdit('deny', ...)` 注入 / 再描画。
  - `renderPerceptionPanel` / `clearPerceptionFusion` / テストフック（`index3DRunPerceptionFixture`, `index3DGetPerceptionReport`, `index3DRunPhase5Validation`）。
- 変更: `index3D_V1.0.html` / `index3D_V1.0.css`（知覚補正パネルUI）。
- 変更: `src/batch/run_index3d_smoke.js`（Phase 5 検証ブロック）/ `src/batch/package.json`（`index3d:smoke:phase5`）。

Out of scope for Phase 5（後続/将来）:

- Google Street View / YOLO サーバの実E2E接続（本Phaseは入力経路と融合層を確立。実スキャン差し替えは `acquirePerceptionScan()` のTODO）。
- Mapillary 補助ソース。
- 複数経路の大規模ベンチ（Phase 6）。

## Environment

- OS: Windows / PowerShell
- Browser: Puppeteer controlled Chromium/Edge
- URL: `http://127.0.0.1:8080/index3D_V1.0.html`
- Web server: 127.0.0.1:8080（稼働中）
- YOLO / Street View server: 未接続（合成スキャンにフォールバック）

## Commands

```powershell
node --check src\3d\perceptionFusion.js
node --check src\index3dMain.js
node --check src\batch\run_index3d_smoke.js
cd src\batch
npm run golden:dry
npm run index3d:smoke
npm run index3d:smoke:phase5
```

## Manual Checks

| Check | Expected | Result | Notes |
|---|---|---|---|
| 知覚スキャン実行 | 幅候補と障害物が反映される | PASS | パネルに採用/確認待ち/障害物が表示 |
| 幅候補の3D反映 | 高信頼候補で走行面が更新 | PASS | surface area 37144→37132（変化） |
| 低信頼の確認待ち | 低信頼候補は自動採用されない | PASS | pendingCount=1 を維持 |
| YOLO幅カバレッジ | yoloCoverage>0 | PASS | 0.002→0.005 |
| 障害物→判定反映 | 障害物ソリッドが増える | PASS | obstacle/overhead solids 0→2 |
| SV/YOLO未接続 | 落ちずにスキップ理由表示 | PASS | source=synthetic, skipReason表示 |
| Legacy regression | phase2/3/4 と golden に退行なし | PASS | 全phase ok、golden:dry OK |

## Automated Checks

| Check | Command | Result | Notes |
|---|---|---|---|
| JS syntax | `node --check src\3d\perceptionFusion.js` | PASS | |
| JS syntax | `node --check src\index3dMain.js` | PASS | |
| JS syntax | `node --check src\batch\run_index3d_smoke.js` | PASS | |
| Golden dry run | `npm run golden:dry` | PASS | 退行なし |
| Startup smoke | `npm run index3d:smoke` | PASS | コンソールエラーなし |
| Phase5 smoke | `npm run index3d:smoke:phase5` | PASS | phase2/3/4/5 すべて ok:true |

## Latest Phase 5 Smoke Metrics（demo, synthetic scan）

| Metric | Value |
|---|---:|
| source | synthetic |
| yoloCoverage before | 0.002 |
| yoloCoverage after | 0.005 |
| road surface area before | 37,144 m² |
| road surface area after | 37,132 m² |
| surfaceChanged | true |
| obstacle solids before | 0 |
| obstacle solids after | 2 |
| width auto-applied | 1 |
| width pending (low-confidence) | 1 |
| pendingKept | true |

参考（同時実行の他Phase）: phase4 fixture stopEventCount=7 / fixtureDetected=true, phase3 fixtureLowClearanceCount=1。

## Artifacts

- Phase5 screenshot: `runtime/logs/index3d_smoke_1779841565962.png`
- Browser log: Puppeteer stdout（phase5 ブロック）

## Result

Status: `PASS`

Decision:

- Phase 5 exit criteria を満たす。
  - `yoloCoverage > 0` を実経路（demo）で達成。
  - SV/YOLO（合成）由来の幅補正が3Dメッシュへ反映。
  - 低信頼の補正は自動採用されず確認待ちに残る。
  - confidence と採用/保留がレポートに残る。
  - 障害物が Phase3 ソリッド / Phase4 自律判断へ流れる。

Follow-up:

- `acquirePerceptionScan()` を実 Street View / YOLO スキャンへ差し替え（現状は合成フォールバック）。
- Phase 6: 3D golden benchmark（load time / FPS / contact / clearance / steering saturation / reverse / yolo coverage）へ Phase 5 指標を統合。
