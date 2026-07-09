# index3D_V1.0 Phase Verification

Phase: 2 - 3D Road Quality（道路幅の根拠化・手動上書きの3D即時反映・歩道レイヤー）

Date: 2026-05-26

Tester: Claude

## Scope

Confirmed:

- 道路ごとの幅員根拠を `index3D_V1.0` の右パネル「道路幅」に表示する。
  - 各道路: 採用幅 `finalWidth` / 根拠 `sources`（OSM実測幅 / 車線 / 道路種別 / YOLO / 手動）/ 信頼度 `confidence`。
  - サマリ: 本数、OSM実測幅 coverage、YOLO coverage、平均信頼度、信頼度バケット（高/中/低/なし）。
- 道路を選んで幅を手動入力 → `store.applyWidthOverride()` → 3D走行面と接触判定が即時更新される。
  - 既存の幅融合（`fuseWidthForFeature` / `estimateEffectiveRoadWidth`）と `widthOverrides` を再利用。
  - `map3dThree.js` の道路面キャッシュ署名に `widthOverridesSig3D` を追加し、幅変更でキャッシュが無効化されるよう修正（従来は本数/先頭末尾idのみで幅変更を検知できなかった）。
- 歩道（sidewalk）を簡易ラインレイヤーとして3Dに描画する。
- スモークテストに Phase 2 検証ブロックを追加（幅根拠の取得 + 幅上書き前後の走行面面積比較）。

新規/変更:

- 新規: `src/3d/roadWidthReport.js`（`buildRoadWidthRows` / `summarizeRoadWidths`）
- 変更: `src/ui/map3dThree.js`（キャッシュ署名に幅上書き反映 / 歩道レイヤー `addSidewalks` / `getRoadSurfaceMetrics` エクスポート / 走行面メトリクス記録）
- 変更: `src/index3dMain.js`（道路幅パネル描画・選択・幅上書きUI・テストフック）
- 変更: `index3D_V1.0.html` / `index3D_V1.0.css`（道路幅パネルUI）
- 変更: `src/batch/run_index3d_smoke.js`（Phase 2 検証）

Out of scope for Phase 2（Phase 3以降に送る）:

- 交差点の進入/退出角を考慮した面補正（現状はバッファunionによる自然な交差点充填まで。多車線はフル幅バッファ済み）。
- 縁石/中央線の独立3Dメッシュ化（歩道は描画。縁石・中央線は道路中心線表示で代替）。
- 建物・障害物の判定用ソリッド分離（Phase 3）。
- YOLO/Street View の実E2E補正（Phase 5）。

## Environment

- OS: Windows / PowerShell
- Browser: Puppeteer controlled Chromium/Edge
- URL: `http://127.0.0.1:8080/index3D_V1.0.html`
- Web server: already running on `127.0.0.1:8080`（HTTP 200確認済み）
- YOLO server: not required for Phase 2
- Rendering: WebGL / Three.js

## Commands

```powershell
node --check src\index3dMain.js
node --check src\ui\map3dThree.js
node --check src\3d\roadWidthReport.js
node --check src\batch\run_index3d_smoke.js
node --check src\core\feasibility.js
cd src\batch
npm run golden:dry
npm run index3d:smoke
npm run index3d:smoke:demo
```

## Manual Checks

| Check | Expected | Result | Notes |
|---|---|---|---|
| 幅根拠の表示 | 道路ごとの finalWidth/sources/confidence が一覧表示 | PASS | 右パネル「道路幅」に表示。スモークでも `index3DGetRoadWidthReport()` が rows を返す |
| サマリ | coverage / 平均信頼度 / バケットが見える | PASS | OSM実測幅 80.3% / 平均信頼度 0.811 |
| 手動幅上書き | 道路選択→幅入力→適用で3D走行面が即更新 | PASS | 面積 36,411→37,144 m² に増加 |
| 上書き戻す | reset で元の幅に戻る | PASS | `resetWidthOverride` 経由で再描画 |
| 歩道レイヤー | 歩道が3Dに描画される | PASS | sidewalk 13本を描画 |
| Legacy regression | golden dry run / 基本起動が壊れない | PASS | golden:dry OK、基本smokeでコンソールエラーなし |

## Automated Checks

| Check | Command | Result | Notes |
|---|---|---|---|
| JS syntax | `node --check src\index3dMain.js` | PASS | |
| JS syntax | `node --check src\ui\map3dThree.js` | PASS | |
| JS syntax | `node --check src\3d\roadWidthReport.js` | PASS | |
| JS syntax | `node --check src\batch\run_index3d_smoke.js` | PASS | |
| JS syntax | `node --check src\core\feasibility.js` | PASS | |
| Startup smoke | `npm run index3d:smoke` | PASS | phase2=null（worldなし）、コンソールエラーなし |
| Demo + Phase2 | `npm run index3d:smoke:demo` | PASS | 幅根拠取得 + 幅上書きで走行面面積が増加 |
| Golden dry run | `npm run golden:dry` | PASS | 既存ベンチfixtureに退行なし |

## Latest Phase 2 Smoke Metrics（demo）

| Metric | Value |
|---|---:|
| Road features | 436 |
| Sidewalk features | 13 |
| OSM measured width coverage | 0.803 |
| YOLO coverage | 0 |
| Average confidence | 0.811 |
| Override target road | way/342271465 |
| Width before | 5 m |
| Width applied | 24 m |
| Road surface area before | 36,411 m² |
| Road surface area after | 37,144 m² |
| Surface area increased | true |

## Artifacts

- Demo screenshot: `runtime/logs/index3d_smoke_1779782006635.png`
- Startup screenshot: `runtime/logs/index3d_smoke_1779781956112.png`
- Browser log: Puppeteer stdout（phase2 ブロック）

## Result

Status: `PASS`

Decision:

- Phase 2 exit criteria を満たす。
  - 幅員の根拠（sources/confidence/finalWidth）がUIとレポートで追える。
  - 道路幅の手動上書きで3D走行面が即時更新される（キャッシュ署名修正により担保）。
  - 交差点は多車線フル幅バッファ + union で接触の悪化なし（既存挙動を維持）。

Follow-up:

- Phase 3: 建物・障害物の判定用ソリッド分離、頭上障害物（clearanceHeight）と車高/積荷高の照合。
- 交差点の角度ベース面補正と縁石/中央線の独立レイヤー化は Phase 3 の道路品質追補で扱う。
- FPS/load-time 計測は Phase 4 のautonomy前に smoke 出力へ追加予定。
