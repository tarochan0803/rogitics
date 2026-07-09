# Implementation Log — index3D_V1.0 Phase 7 (Recovery: reverse / replan)

Date: 2026-05-27
Author: Claude

## Goal

ユーザー選択により Phase 7 = 「reverse/replan（切り返し・再計画）」。Phase 4 で保留した Recovery を実装し、
ベンチマークの `reverseCount`（それまで固定値 0）を実値にする。

## Design

- 自律判断は `buildAutonomyDriveReport`（behaviorPlanner.js）が経路サンプルごとに mode（CRUISE/SLOW/YIELD/SATURATED/STOP）を出す。
- STOP は前方 blocker が safe-stop 距離内、または許容速度0で発生していたが、復旧手段が無かった。
- Recovery 層を追加:
  - 連続 STOP サンプルを「行き詰まりゾーン」に集約（= 1 replan 試行）。
  - 頭上障害物（role=overhead）: 後退しても高さ不足は解消しないため復旧不可。
  - 地上/側方障害物: blocker 近傍で側方オフセット点（後退して横へ寄る切り返し）が blocker を避けられるか判定。
    - `turf.destination` で進行方向の垂直に offset 点を作り、`turf.buffer` プローブが blocker と交差しなければ回避可能。
    - 回避できれば復旧成功（reverseCount++）、できなければ未復旧。
- 既存の `status` / `stopEventCount` は変えず（非劣化のため）、recovery 系を summary に追加:
  `reverseCount` / `replanCount` / `recoveredStopCount` / `unresolvedStopCount` / `recoveryStatus`。

## Changes

- `src/sim/autonomy/behaviorPlanner.js`
  - `lateralOffsetClears()` … 側方オフセット点が blocker を避けられるか。
  - `evaluateRecovery()` … 頭上は復旧不可、地上は後退+側方オフセットで回避を試す。
  - `planRecoveries()` … STOP ゾーンを集約し各ゾーンで復旧試行、reverse/replan/recovered/unresolved を集計。
  - `DEFAULT_RECOVERY` パラメータ、`buildAutonomyDriveReport` に `recovery` 引数と summary フィールド追加。
- `src/3d/clearanceSolids.js`
  - `makeRouteLateralObstacleFixture()` … 復旧可能な地上障害物（経路中央の片側オフセット）。
- `src/index3dMain.js`
  - Autonomy パネルに「復旧 / 切り返し回数 / 再計画 / 復旧済 / 未復旧」を表示。
  - `runPhase7Validation()` … 地上 fixture（復旧する）と頭上 fixture（復旧しない）を比較。
  - テストフック `index3DRunPhase7Validation`。
- `src/batch/run_index3d_benchmark.js`
  - `reverseCount` を autonomy summary 実値に配線（`recoveredStopCount`/`unresolvedStopCount`/`recoveryStatus` も記録）。
- `src/batch/run_index3d_smoke.js` / `package.json`
  - Phase 7 検証ブロックと `index3d:smoke:phase7`。

## Verification

すべて PASS。

- `node --check`: behaviorPlanner / clearanceSolids / index3dMain / run_index3d_smoke / run_index3d_benchmark → OK
- `npm run golden:dry` / `npm run index3d:benchmark:dry` → OK
- `npm run index3d:smoke:phase7` → phase2/3/4/5/7 すべて ok:true
  - phase7: groundReverseCount=1 / groundRecoveredStopCount=1 / overheadReverseCount=0 / overhead=UNRESOLVED
- `npm run index3d:benchmark`（full 3 cases）→ completed=3/3, failedExpectations=0, errors=0
  - reverseCount: PASS_CLEAR=0 / FAIL_LOW_CLEARANCE=0(頭上) / PERCEPTION_FUSION=1(地上, 切り返し復旧)

出力: `runtime/benchmarks3d/20260527T005510Z`。詳細は `docs/VERIFY_INDEX3D_PHASE_7.md`。

## Notes / Deferred

- 本Phaseは「判断レイヤーの復旧解析と指標化」。実走行中の後退アニメーション/実切り返し軌跡再生は後続。
- 実 Street View / YOLO 接続は Phase 5 の `acquirePerceptionScan` TODO のまま。
- スモークでは Phase 5 が先に頭上障害物を注入するため ground 検証の集計 recoveryStatus は UNRESOLVED になるが、
  per-機構の判定（地上 reverse>0 / 頭上 reverse=0）は成立。必要なら検証前に perception 障害物をクリアする運用も可。
