# index3D_V1.0 Phase Verification

Phase: 7 - Recovery (reverse / replan)（ベンチ指標 reverseCount の本物化）

Date: 2026-05-27

Tester: Claude

## Scope

Phase 4 で保留していた Recovery（停止→後退→切り返し→再計画）を実装し、ベンチマークの
`reverseCount` を固定値 0 から実値に切り替える。

Confirmed:

- 自律判断（`buildAutonomyDriveReport`）に Recovery 層を追加。
  - 連続する STOP サンプルを「行き詰まりゾーン」にまとめ、ゾーンごとに復旧を試行（= replan）。
  - 地上/側方障害物: 後退 + 側方オフセット候補で blocker を避けられれば復旧成功（`reverseCount++`）。
  - 頭上障害物（高さ不足）: 後退しても通れないため復旧不可（`reverseCount` は増えない）。
  - summary に `reverseCount` / `replanCount` / `recoveredStopCount` / `unresolvedStopCount` / `recoveryStatus` を追加。
- 復旧可能な地上障害物 fixture（`makeRouteLateralObstacleFixture`）を追加（経路中央の片側にオフセット＝中心線は塞ぐが反対側に逃げ場あり）。
- 3D パネル（Autonomy）に復旧状態・切り返し回数・再計画回数を表示。
- ベンチマークの `reverseCount` を autonomy summary 実値に配線（`recoveredStopCount` / `unresolvedStopCount` / `recoveryStatus` も記録）。
- スモークに Phase 7 検証ブロックを追加。

新規/変更:

- 変更: `src/sim/autonomy/behaviorPlanner.js`（`lateralOffsetClears` / `evaluateRecovery` / `planRecoveries`、summary に recovery 系フィールド、`recovery` パラメータ）。
- 変更: `src/3d/clearanceSolids.js`（`makeRouteLateralObstacleFixture`）。
- 変更: `src/index3dMain.js`（Autonomy パネルに復旧表示、`runPhase7Validation`、テストフック `index3DRunPhase7Validation`）。
- 変更: `src/batch/run_index3d_benchmark.js`（`reverseCount` を実値配線 + recovery 指標）。
- 変更: `src/batch/run_index3d_smoke.js`（Phase 7 検証）/ `src/batch/package.json`（`index3d:smoke:phase7`）。

Out of scope（後続）:

- 実走行（playThree3D）中のリアルタイム後退アニメーション・実切り返し軌跡の再生（現状は判断レイヤーの解析と指標化）。
- 実 Street View / YOLO 接続（Phase 5 の `acquirePerceptionScan` TODO のまま）。

## Environment

- OS: Windows / PowerShell
- Browser: Puppeteer controlled Chromium/Edge
- URL: `http://127.0.0.1:8080/index3D_V1.0.html`
- Web server: 127.0.0.1:8080（稼働中）

## Commands

```powershell
node --check src\sim\autonomy\behaviorPlanner.js
node --check src\3d\clearanceSolids.js
node --check src\index3dMain.js
node --check src\batch\run_index3d_smoke.js
node --check src\batch\run_index3d_benchmark.js
cd src\batch
npm run golden:dry
npm run index3d:benchmark:dry
npm run index3d:smoke:phase7
npm run index3d:benchmark
```

## Manual / Automated Checks

| Check | Expected | Result | Notes |
|---|---|---|---|
| 地上障害物の復旧 | 停止するが後退+切り返しで復旧（reverse>0） | PASS | groundReverseCount=1, recoveredStopCount=1 |
| 頭上障害物の未復旧 | 後退しても通れず reverse=0 / UNRESOLVED | PASS | overheadReverseCount=0, UNRESOLVED |
| reverseCount 実値化 | ベンチで固定0でなく実値が出る | PASS | PASS=0 / FAIL(overhead)=0 / MEASURE(ground)=1 |
| 非劣化 | fixture 期待値・他Phaseに退行なし | PASS | failedExpectations=0、phase2/3/4/5 ok |
| JS syntax | 5ファイル node --check | PASS | |
| golden:dry / benchmark:dry | OK | PASS | |
| index3d:smoke:phase7 | phase2/3/4/5/7 すべて ok:true | PASS | |

## Latest Benchmark（full, 3 cases）

出力: `runtime/benchmarks3d/20260527T005510Z`、completed=3/3、failedExpectations=0、errors=0。

| Case | status | stop | reverse | recovered | recoveryStatus |
|---|---|---:|---:|---:|---|
| CONFIRMED_PASS_DEMO_CLEAR | SLOW | 0 | 0 | 0 | NONE |
| CONFIRMED_FAIL_DEMO_LOW_CLEARANCE | STOP | 7 | 0 | 0 | UNRESOLVED |
| MEASURE_DEMO_PERCEPTION_FUSION | STOP | 8 | 1 | 1 | UNRESOLVED |

reverseCount が「頭上=0（本当に復旧不可）」「地上障害物=1（切り返しで回避）」と弁別できている。

## Phase 7 Smoke Metrics

| Metric | Value |
|---|---:|
| groundStopEvents | 9 |
| groundReverseCount | 1 |
| groundRecoveredStopCount | 1 |
| overheadStopEvents | 11 |
| overheadReverseCount | 0 |
| overheadRecoveryStatus | UNRESOLVED |

注: スモークでは Phase 5 が先に注入した頭上障害物（低い庇）が同一セッションに残るため、ground 検証の
集計 `recoveryStatus` は UNRESOLVED になる。per-機構の判定（地上=reverse>0, 頭上=reverse=0）は正しく成立。

## Result

Status: `PASS`

Decision:

- Phase 7（reverse/replan）の exit を満たす。
  - 単純追従では STOP のままだった地上障害物が、後退+切り返しで復旧できるようになった。
  - 頭上クリアランス不足は復旧不可として正しく区別され、reverseCount=0 を維持。
  - ベンチ指標 `reverseCount` が固定値ではなく実値になり、ケース間で弁別できる。

Follow-up:

- 実走行（playThree3D）中の後退アニメーション/実切り返し軌跡の再生。
- 実 Street View / YOLO 接続（Phase 5 `acquirePerceptionScan` の差し替え）。
- 現場実測ルートを `CONFIRMED_PASS` / `CONFIRMED_FAIL` に追加し、決定論 fixture から実データへ。
