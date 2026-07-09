# LOGISTICS_OS v8.2 — Agent Notes

## Project Overview
Japanese truck routing simulator. Checks if a delivery truck can physically navigate to a destination.
- Entry point: `index3D_V2.0.html` → loads `src/index3dMain.js` (ES modules). Legacy: `index8.2.html`/`index9.0.html` → `src/main.js` (Leaflet-only 2D auto-follow; not the current app).
- Map: Leaflet (2D default) + CesiumJS (3D/photorealistic optional)
- State: `src/state.js` (reactive store, subscribe/notify pattern)
- Key modules: `src/ui/controls.js`, `src/ui/map2d.js`, `src/ui/truckDrive.js`, `src/ui/streetviewScan.js`
- External: Turf.js, polygon-clipping, Google Maps Street View API, YOLO (road width detection)

## Architecture

### Vehicle Presets
Defined in `src/config.js` → `VEHICLE_PRESETS`. Each preset has `vehicleWidth`, `wheelBase`, `frontOverhang`, `rearOverhang`, etc.
`buildVehicleConfig(presetName)` expands a preset into full `vehicleConfig` including margins and speed params.
Selecting a preset calls `store.applyVehiclePreset()` → triggers subscriber in `main.js` → syncs `driveTruckW`/`driveWheelbase` inputs → calls `setDriveConfig()`.

### 通行リスクモデル (vehicleRiskModel.js) — NEW
道路幅の不確かさ(`confidence`)を判定・自律走行・車高クリアランスへ一元伝播させる共通モジュール。係数は `RISK_TUNING` に集約（単一の真実源）。
- `confidence` は `feasibility.js:fuseWidthForFeature()` が幅融合時に生成。
- `applyWidthRisk(raw, conf, {strictMode})`: 信頼度が低いほど有効幅を下振れ（保守化）。`estimateEffectiveRoadWidth` が経由 → `buildRoadUnion` 経由で判定全体に効く。非strictは 1.0〜0.92（高信頼ほぼ不変）、strictは 0.98〜0.85。
- `autonomousSpeedFactor(conf)`: 自律走行(`truckDrive.js:_autoLoop`)が最寄り道路の confidence で減速（1.0〜0.55）。`_detectOffRoad()` が `curRoadConfidence` を更新。
- `heightClearance({source})`: 車高クリアランス。`feasibility.js:heightClearanceFor` を統一。
- `curveSpeedLimitMS()`: ③旋回半径ベースのカーブ速度上限（v=√(a·R)）。**behaviorPlanner.js で配線済み**（サンプル毎に pathRadiusM から算出）。
- `gradeSpeedFactor()`/`roadGradeSpeedFactor()`: ワールドコンパイラ焼き込みの勾配（`demGradeMedianPct`優先/`demGradeMaxPct`フォールバック）→速度係数（3%まで1.0、12%で0.6頭打ち）。behaviorPlanner が confidence と独立の係数として乗算。勾配データ無し道路は1.0（従来挙動）。
- 推奨実装順: ①confidence伝播+共通マージン(済) → ②幅融合の保守化 → ③カーブ速度を旋回半径ベースへ → ④判定と自律走行で同じroad surface/envelopeを共有 → ⑤recovery横オフセットを車両寸法・旋回半径連動。

### 道路幅モデルのフィールド規約 (roadWidthModel.js)
幅ソースは信頼度順に融合（`fuseWidthForFeature`）。判定・ルーティング・2D/3D表示すべてこの単一モデルを使う。
- `userOverrideWidth`（信頼度1.0・manual policy）= **手動上書き＝authoritative**。保守融合・applyWidthRisk・OSM width に負けない。人が衛星画像を見て車道幅を確定する用途。`store.applyWidthOverride()` → `state.js:withUserOverride` がこのフィールドに書く。
- `width_ai`（0.75）= **YOLO等のAI推定のみ**。`store.updateGeoJsonFeature({width_ai})` / 知覚融合 `runPerceptionFusion`→`store.applyPerceptionWidthAi(map)` が書く（経路コリドーの道だけ・バッチ適用、`clearPerceptionWidthAi`で除去）。手動上書きとは別フィールド（混同しない）。AIは推定なのでOSM width/手動上書きには譲り、未タグ道だけ実寸へ寄せる。
- `fgd_edge`（0.88・priority92）= **基盤地図 道路縁からの実測級全幅**。ワールドコンパイラ(compile_world.js)が `fgdWidthM/fgdWidthConfidence` として道路に付与。実測グループでOSM widthより優先、ただし**全体幅なので歩道控除(TOTAL_WIDTH_SOURCES)対象**。手動上書きには負ける。
- OSM width(0.85) / GSI(0.72) / lanes×width(0.70) / highway既定(0.60)。上書き無しは低パーセンタイルで保守的に融合。
- **表示=判定**: `map2d.js:showRoadWidths` と判定 `buildRoadUnion` は同じ `estimateEffectiveRoadWidth`（=融合 + `applyWidthRisk`）を見る。帯が細い＝実際の判定幅。タグ無し道は highway 既定で帯が出る。
- 未タグの広い道を実寸に合わせるには「幅エディタで上書き（authoritative）」か「YOLO幅検出（width_ai）」。コードだけで実幅は出せない。
- **経路確定時の自動知覚**: `loadWorldForRoute()` 成功後に `runRealPerceptionFusion()`（実SV/YOLO）を自動実行し、経路コリドーの道へ width_ai を適用。非ブロッキング + `state.autoPerceptionRunning` ガード。`window.INDEX3D_AUTO_PERCEPTION=false` で無効化。実SV/YOLO は Google API + YOLOサーバを使う。

### Drive Mode (truckDrive.js)
Bicycle steering model: `turnRate = speed * tan(STEER_DEG) / wheelbaseM * (180/π)`
- `STEER_DEG = 38` (max steering angle)
- Default `wheelbaseM = 4.0` (2t truck default)
- Config updated via `setDriveConfig({ widthM, wbM, maxSpeedKmh })`
- Input fields: `#driveTruckW`, `#driveWheelbase`, `#driveMaxSpeed` (in settings panel)

### 決定論シミュレーション規約 (src/sim/autoFollowCore.js) — L4SIM Phase 0
自動走行の物理・判定は固定タイムステップ(SIM_DT_S=0.05s)のみで進める。rAF揺らぎはアキュムレータで吸収（truckDrive._autoLoop実装済み）。
- 幾何(bearing/buildCumulative/sampleRouteAt)は `autoFollowCore.js` が単一実装。**再実装禁止**（ブラウザ/Node検証で数学が食い違うと再現性が壊れる）。
- 物理・判定での `Math.random`・壁時計(Date.now/rAF ts)は禁止 → `createRng(seed)` / `simTimeS` を使う。
- record/replay: `src/sim/trace.js`。検証: `node src/batch/run_sim_repro.js`（100回trace全一致・リプレイ照合・揺らぎ吸収・dt収束の4項目 ALL PASS を維持）。
- ワールドコンパイラ(Phase1): `node src/batch/compile_world.js --selfcheck` / `--bbox ... [--offline]`。rdcl道路+DEM5A標高→`runtime/worlds/world_<hash>.json`。オンライン/オフラインで hash 一致が正常。DEM: `src/world/demTiles.js`、焼き込み: `src/world/worldFile.js`。
- 計画書・手順書・ロードマップ・図: `docs/l4sim/`。道路幅AI(航空写真)一式: `road_seg/` + `道路幅AI検証.bat`。
- **作業ログ必須**: 作業のたびに `docs/l4sim/WORKLOG.md` の先頭へ「やったこと/次やること」を追記すること（ユーザー指示・恒久運用）。

### Delivery Assessment (controls.js)
`initDeliveryPanel({ onRun })` wires the main "搬入判定を実行" button.
- Sets `window._isAssessing = true` at start, `false` in `finally` block
- Calls `setDeliveryProgress()` for progress bar
- Result stored in `store.deliveryAssessment`

### Workflow Dock (workflowController.js + index8.2.html inline)
5-step wizard: 道路取得 → 端点設定 → 経路生成確定 → 車両選択 → 判定実行
- `updateWizard()` runs on `setInterval(600ms)` in index8.2.html inline script
- Polls `window._isAssessing` to show "⏳ 実行中..." during assessment
- Step 4 action button (`wfActionBtn`) is hidden (`display:none`) — use only the top "搬入判定を実行" button

### Street View (streetviewScan.js)
- Viewpoint marker: cyan circle + direction arrow (`L.divIcon` SVG), updated each drive tick
- Position: `#svViewport` at `bottom:270px; right:20px` (avoids drive HUD overlap)
- Expand button: `#svExpandBtn` toggles `.sv-expanded` class (~42vw × 38vh)

### YOLO Road Width Detection
`WIDTH_ESTIMATE` constants in `streetviewScan.js`:
```js
maxRouteOffset: 5,   // max lateral distance from road centerline (was 18 — too permissive)
percentile: 0.4,     // use lower percentile for conservative estimate (was 0.75)
baseMargin: 0.5,     // edge margin added to detection offset (was 1.2)
maxWidth: 8          // clamp max width estimate (was 12)
```

## Known Issues & Fixes Applied (v8.2 session)

### Settings Panel Invisible
**Root cause**: Duplicate `<div id="floatSearch">` in index8.2.html (line ~297). Chrome's `backdrop-filter: blur()` creates a new containing block for `position:fixed` children. `#sidePanel` (fixed, right:20px) was positioned relative to the unclosed floatSearch box → placed off-screen left (~-84px).
**Fix**: Removed the extra opening `<div id="floatSearch">` tag.

### SV/HUD Overlap
Both `#svViewport` and drive HUD were at `bottom:30px; right:20px`.
**Fix**: Moved `#svViewport` to `bottom:270px` in `style6.css`.

### Progress Bar Not Showing
`.thud-progress-bar` had `position:absolute` — trapped inside a parent element.
**Fix**: Changed to `position:fixed` in `style6.css`.

### Workflow Shows "完了" During Re-assessment
Step 4 checks `hasResult()` which is truthy from prior assessment → shows done immediately.
**Fix**: `window._isAssessing` flag + `updateWizard()` step 4 case hides action button and shows "⏳ 実行中..." when `window._isAssessing` is true.

### Vehicle Card → Drive Config Not Syncing
Vehicle card clicks updated the routing preset but not the drive mode inputs.
**Fix**: Store subscriber in `main.js` syncs `vehicleConfig.vehicleWidth/wheelBase` to `#driveTruckW/#driveWheelbase` on preset change.

## CSS / Encoding Notes
- Japanese strings: always verify after edits — encoding bugs cause `?` mojibake
- `style6.css` had duplicate `#hud` rules (one `display:none`, one `display:flex`) — second wins
- `backdrop-filter` on any ancestor breaks `position:fixed` descendants in Chrome (positions them relative to the filter element, not viewport)

## File Reference
| File | Role |
|------|------|
| `index8.2.html` | Main HTML, inline updateWizard() script |
| `style6.css` | Main CSS |
| `src/main.js` | Bootstrap, drive config wiring |
| `src/config.js` | VEHICLE_PRESETS |
| `src/core/vehicleRiskModel.js` | 通行リスクモデル（confidence伝播の単一真実源、RISK_TUNING） |
| `src/core/feasibility.js` | 幅融合/接触判定（fuseWidthForFeature, buildRoadUnion） |
| `src/state.js` | Reactive store |
| `src/ui/controls.js` | Main controller (~2500 lines) |
| `src/ui/truckDrive.js` | Arrow-key driving mode |
| `src/ui/streetviewScan.js` | Street View + YOLO width detection |
| `src/ui/workflowController.js` | Workflow dock render helpers |
| `src/ui/map2d.js` | Leaflet map init, `getMapInstance()` |
| `src/ui/map3dTiles.js` | Cesium 3D/photorealistic view |
