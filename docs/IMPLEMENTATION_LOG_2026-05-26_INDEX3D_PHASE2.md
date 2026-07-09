# Implementation Log — index3D_V1.0 Phase 2 (3D Road Quality)

Date: 2026-05-26
Author: Claude

## Goal

ロードマップ Phase 2「3D Road Quality」を、既存の幅融合システムを活かして達成する。

- 道路ごとの採用幅 `finalWidth` と根拠（sources/confidence）をUIで追えるようにする。
- 手動の道路幅上書きが3D走行面と判定に即時反映されるようにする。
- 歩道などの文脈レイヤーを3Dに足す。
- フェーズ単体で起動・自動確認できる状態にする。

## Key Finding（着手前の調査）

- 道路幅の道路ごと推定は既に存在: `src/core/feasibility.js`
  - `fuseWidthForFeature()` … OSM実測幅 / 車線 / 道路種別 / AI(YOLO) を融合し `value/sources/confidence/samples` を返す。
  - `estimateEffectiveRoadWidth()` … 上記をラップし fallback 込みで `finalWidth` を返す。
  - `buildWidthFusionValidationReport()` … coverage・信頼度バケット・source内訳・不一致を集計。
- `buildRoadUnion()` は内部で道路ごとに `estimateEffectiveRoadWidth` を呼んでおり、3D走行面は既に道路ごとの実幅になっていた。
- よって Phase 2 の不足は「データ層」ではなく「UI露出・手動上書きの即時反映・歩道レイヤー・検証」だった。

## Bug fixed（即時反映の要）

`src/ui/map3dThree.js` の `getRoadSurfaceGeo()` のキャッシュ署名 `roadsSig3D` が
`本数:先頭id:末尾id` のみで、`width_ai`（幅上書き）変更を検知できなかった。
→ 幅を変えても道路面が再生成されない。

対応: 署名に `widthOverridesSig3D(state.widthOverrides)` を追加し、上書き変更でキャッシュ無効化。

## Changes

### New
- `src/3d/roadWidthReport.js`
  - `buildRoadWidthRows(roads, { defaultRoadWidth, overrides, limit })` → 道路ごとの `{id,name,highway,finalWidth,rawWidth,confidence,sources,hasOverride}`（信頼度昇順で要確認を上位に）。
  - `summarizeRoadWidths(roads)` → `buildWidthFusionValidationReport` を再利用したサマリ。

### Modified
- `src/ui/map3dThree.js`
  - `widthOverridesSig3D()` 追加、道路面キャッシュ署名に反映（即時反映）。
  - `addSidewalks()` 追加（歩道を水色ラインで描画）、`renderSceneThree` で呼び出し。
  - `getRoadSurfaceMetrics()` エクスポート（直近の走行面の `areaM2/vertices/polygons` を返す。検証用）。
  - `addRoadSurface()` で走行面メトリクスを記録。
- `src/index3dMain.js`
  - `renderRoadWidthPanel()` … サマリ + 道路一覧を描画、行クリックで道路選択。
  - `selectRoadForWidth()` / `applyWidthOverrideFromUi()` / `resetWidthOverrideFromUi()`。
  - ワールド読込後に `renderRoadWidthPanel()` を呼ぶ。
  - テストフック: `index3DGetRoadWidthReport()`, `index3DGetRoadSurfaceMetrics()`, `index3DApplyWidthOverride(id,w)`。
- `index3D_V1.0.html` / `index3D_V1.0.css`
  - 「道路幅」パネル（サマリ / 幅上書きエディタ / 道路一覧）。
- `src/batch/run_index3d_smoke.js`
  - Phase 2 検証ブロック: 幅根拠の取得 + 代表道路へ幅上書き → 走行面面積が増えることを assert。

## Verification

すべて PASS。

- `node --check`: index3dMain / map3dThree / roadWidthReport / run_index3d_smoke / feasibility → OK
- `npm run golden:dry` → OK（既存ベンチ退行なし）
- `npm run index3d:smoke`（基本起動）→ OK（コンソールエラーなし、phase2=null）
- `npm run index3d:smoke:demo`（Phase2）→ OK
  - roads=436, sidewalks=13, OSM実測幅 coverage=0.803, 平均信頼度=0.811
  - 幅上書き way/342271465: 5m→24m, 走行面 36,411→37,144 m²（増加）

詳細は `docs/VERIFY_INDEX3D_PHASE_2.md`。

## Notes / Deferred

- 交差点の角度ベース面補正と縁石/中央線の独立3Dメッシュは Phase 3 の道路品質追補へ。現状は多車線フル幅バッファ + union による交差点充填で接触悪化なし。
- 建物/障害物の判定用ソリッド分離、頭上障害物の clearanceHeight 照合は Phase 3。
- FPS/load-time 計測は Phase 4（autonomy）前に smoke 出力へ追加予定。
