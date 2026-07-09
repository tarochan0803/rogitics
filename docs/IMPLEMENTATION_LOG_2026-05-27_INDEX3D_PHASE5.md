# Implementation Log — index3D_V1.0 Phase 5 (Perception Fusion)

Date: 2026-05-27
Author: Claude

## Goal

ロードマップ Phase 5「Perception Fusion」。Street View / YOLO の検出を、Phase 4 で確立した
障害物入力と Phase 2 の道路幅融合に流し込む層を作る。フェーズ単体で起動・自動確認できる状態にする。

## Approach（既存資産の活用）

- 道路幅の融合（`fuseWidthForFeature` / `estimateEffectiveRoadWidth`）と `width_ai` は Phase 2 で確立済み。
  - → 幅候補は `store.applyWidthOverride(roadId, w)`（= width_ai 付与）で適用すれば、3D走行面（Phase2のキャッシュ署名修正で即時反映）と yoloCoverage に反映される。
- 障害物入力は Phase 3/4 で `maskEdits.deny` のポリゴンが obstacle / overhead ソリッド化される構造。
  - → YOLO障害物は `store.addMaskEdit('deny', feature)` で注入すれば、Phase3 ソリッド表示と Phase4 前方センサー/停止判断に反映される。
- よって Phase 5 は「知覚 → これら2チャネルへの変換 + 信頼度ゲート + 確認待ち + 検証」を作ることが本質。

## Changes

### New
- `src/3d/perceptionFusion.js`
  - `buildRouteStations(route, {spacingM})` … 経路上の station 点。
  - `aggregateWidthSuggestions(roads, widthSamples, {autoApplyConfidence,minDeltaM,defaultRoadWidth})`
    … 道路ごとに幅サンプルを中央値集約、フレーム数で信頼度算出、自動採用/確認待ち（low-confidence / small-delta）を判定。
  - `buildObstacleFeatures(detections)` … 点検出→ポリゴン障害物 feature（`source:'yolo'`, `heightOnly` で頭上判定）。
  - `makeSyntheticPerceptionScan(roads, route)` … SV/YOLO未接続時のフォールバック。高信頼/低信頼の幅候補と地上/頭上障害物を決定論的に生成。

### Modified
- `src/index3dMain.js`
  - `acquirePerceptionScan()` … 実 SV/YOLO への差し替え口（現状は合成フォールバック + skipReason）。
  - `runPerceptionFusion()` … 幅候補の自動採用（高信頼のみ width_ai）、YOLO障害物を `maskEdits.deny` に注入（再実行時は前回分を `removeMaskEdit` でクリア）、再描画と各パネル更新。
  - `clearPerceptionFusion()` / `renderPerceptionPanel()`。
  - `runPhase5Validation()` … before/after で yoloCoverage>0・走行面変化・pending維持・障害物ソリッド増加を判定。
  - テストフック: `index3DRunPerceptionFixture`, `index3DGetPerceptionReport`, `index3DRunPhase5Validation`。
  - `window.index3DStats.phase5` を追加、worldLoaded 時に `renderPerceptionPanel()` を呼ぶ。
- `index3D_V1.0.html` / `index3D_V1.0.css`
  - 「知覚補正(Phase 5)」パネル（実行/クリアボタン、採用・確認待ち・障害物リスト、YOLO幅カバレッジ）。
- `src/batch/run_index3d_smoke.js`
  - Phase 5 検証ブロックを追加（worldLoaded 時、phase4 の後に実行）。
- `src/batch/package.json`
  - `index3d:smoke:phase5`（`--demo` エイリアス）。

## Verification

すべて PASS。

- `node --check`: perceptionFusion / index3dMain / run_index3d_smoke → OK
- `npm run golden:dry` → OK（退行なし）
- `npm run index3d:smoke`（基本起動）→ OK（コンソールエラーなし）
- `npm run index3d:smoke:phase5`（demo）→ phase2/3/4/5 すべて ok:true
  - phase5: source=synthetic, yoloCoverage 0.002→0.005, 走行面 37144→37132（変化）,
    障害物ソリッド 0→2, 幅自動採用=1, 確認待ち=1（pendingKept=true）

詳細は `docs/VERIFY_INDEX3D_PHASE_5.md`。

## Notes / Deferred

- 実 Street View / YOLO スキャンは `acquirePerceptionScan()` の TODO（現状は合成フォールバック）。
  既存 `streetviewScan.js` / YOLO サーバを接続する際は、この関数が `{ stations, widthSamples, detections }` を
  返す形に合わせれば、下流（幅適用・障害物注入・検証）はそのまま動く。
- Mapillary 補助ソースは未実装。
- Phase 6 で 3D golden benchmark に Phase 5 指標（yolo coverage 等）を統合予定。
