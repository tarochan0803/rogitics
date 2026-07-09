# L4SIM 手順書 — 検証・デバッグ・運用の実行方法

前提: プロジェクトルート `LOGISTICS_OS_v8.0` で実行。Node は同梱 `src/batch` 環境、
Python は `.venv`。

## 1. 決定論検証（Phase 0・毎コミット推奨）

```powershell
node src/batch/run_sim_repro.js --runs 100
```
期待: 4項目 ALL PASS
- `determinism: 100 runs identical` … 同一入力100回で trace ハッシュ全一致
- `replay: tick-by-tick exact match` … 記録リプレイの1tick照合一致
- `fixed-dt accumulator absorbs frame jitter` … rAF揺らぎ模擬でもハッシュ不変
- `dt-halving consistency` … dt半減で最終位置ドリフト < 0.5m

成果物: `runtime/sim_repro/trace_baseline.jsonl`（バグ報告の添付形式）

**FAILしたら**: 直近の変更が (a) `Math.random`/壁時計を物理に混入、(b) 反復順序が不定の
`Set/Map/Object` 走査を判定に使用、(c) autoFollowCore 以外での幾何再実装 —— のどれかを疑う。

## 1b. ワールドコンパイル（Phase 1）

```powershell
node src/batch/compile_world.js --selfcheck          # ネット不要のCI検証（全項目 ALL PASS 必須・項目は増えていく）
node src/batch/compile_world.js --bbox 139.765,35.679,139.769,35.683
node src/batch/compile_world.js --bbox <同じ> --offline   # キャッシュのみで再現
```
- 出力: `runtime/worlds/world_<hash>.json`（道路=rdcl、DEM5A/5B標高プロファイル）
- HTTPキャッシュ: `runtime/world_cache/`。**オンラインとオフラインで hash が一致すること**
  が正常（不一致=非決定論の混入。ソート順・浮動小数点・metaのhash混入を疑う）。
- AOIは rdcl 120タイル以内（約1.5km四方）。広域は分割コンパイル。

ブラウザでの読込（index3D_V2.0.html のコンソール）:
```js
fetch('runtime/worlds/world_<hash>.json').then(r=>r.json()).then(window.index3DLoadCompiledWorld)
```
読込後は `window.index3DStats.worldLoaded === true`・3D再描画・各パネル更新まで行われる。
規制は外部規制キャッシュに載る（規制0件のワールドは前回分をクリアする）。
歩道・PLATEAUタイルセットもワールド内容で差し替え（未収録なら空/None にクリア）。

**順序に注意**: 経路の適用（ルート確定）は `worldLoaded=false` に戻す
（index3dMain.js の経路適用処理）。そのため実運用は必ず
**「①経路確定 → ②compiled world 読込 → ③判定実行」** の順で行うこと。

## 1c. Safety Monitor / MRM確認（Phase 3）

3D自動走行中は Safety Monitor が毎tickで不変条件を検査する。
ブラウザコンソールまたはPlaywrightから以下のhookで確認する。

```js
window.index3DGetSafetyMetrics()
window.index3DGetSafetyTrace()
```

- 通常走行の期待: `status === "OK"`、`firstViolation === null`、`mrmStop === null`
- 続行不能時の期待: `status === "MRM_STOP"`、`mrmStop.reason` に理由コード、
  `window.INDEX3D_SAFETY_LAST_TRACE.traceJSONL` にtrace本文
- traceは `localStorage["index3d:safety:lastTrace"]` にも保存される。
  バグ報告では world hash / route / vehicle / `traceJSONL` を添付する。
- 単体検証（ネット/ブラウザ不要）: `node src/batch/run_safety_check.js`（全項目 ALL PASS 必須）
- **注意**: Monitor の道路逸脱判定はワールドの道路幅（gsiWidth*）に依存する。
  幅焼き込み対応（2026-07-03）より前にコンパイルした world_*.json は
  大通りでも逸脱誤検知するため、**必ず再コンパイル**してから使うこと。

代表ルート回帰:
```powershell
node src/batch/run_l4_route_regression.js --worlds b610332c,d169ef7c --routes 10
```
- 出力: `runtime/l4_regression/regression_<runId>.json`
- FAIL/MRM時のtrace本文: `runtime/l4_regression/traces_<runId>/*.jsonl`

## 1d. シナリオ行列 + 前回比レポート（Phase 4・オンデマンド実行）

**定期/夜間実行はしない方針**。回したいときに手動で実行する。

```powershell
# 幅帯(4)×勾配帯(3)×形状(3)のセル代表ルート × 車種
node src/batch/run_l4_scenario_matrix.js --worlds b610332c,d169ef7c,fb172e2f --vehicles 2t_flat,4t_flat,10t_unic

# 最新2件（matrix優先）の前回比。悪化(PASS→MRM/FAIL等)は赤字+exit 1
node src/batch/report_l4_regression.js
node src/batch/report_l4_regression.js --a <前回.json> --b <今回.json>
```
- 大型車が狭幅路で `MRM_OK`（理由コード付き停止）になるのは**正常**。
  要修正は `FAIL_MONITOR`（Monitor違反）と `FAIL_INCOMPLETE`（原因不明の未走破）のみ。
- 出力: `matrix_<runId>.json` / `report_latest.md`（`runtime/l4_regression/`）。

## 2. バグ再現の標準形式

バグ報告 = `{ trace.jsonl, 入力(ルート/車両プリセット), dtS }`。
再現は trace の `createReplayChecker` で1tickずつ照合し、**最初に食い違ったtick**を特定する。
そのtickの `sM`（経路上位置）が現地、`v` が判断結果。以降のデバッグはそのtick前後だけ見る。

## 3. ゴールデンルート回帰（既存基盤）

```powershell
# ローカル配信（別ターミナル）
python web_server.py    # または scripts/start_local.ps1
node src/batch/run_golden_benchmark.js --fixtures benchmarks/golden-routes.json
```
- ケース追加（推奨フロー）: `benchmarks/実績ルート入力.csv` に実績を1行ずつ記入
  （id, 名称, 車種preset, 出発/到着の緯度経度, 実績=OK/NG/COND, メモ）→
  `node src/batch/import_golden_results.js [--dry-run]` で golden-routes.json へマージ。
  OK/COND→passable:true、NG→passable:false に自動変換。同一idは上書き。
- 手書きでの直接追記も可: `benchmarks/golden-routes.json`。
- 出力: `runtime/benchmarks/`。**混同行列で見る**: 通れるのにNG=機会損失 / 通れないのにOK=リスク。
  後者を優先して潰す。

### 3b. 教師データxlsx（地点実績）から搬入ルートを作る

`教師データ.xlsx` のように「入れた車格 + 緯度経度」だけがある場合は、地点を最寄り道路へ
snapし、接続道路から短い進入アプローチを複数生成して実走照合する。

```powershell
# 1) Excel → 地点教師データ（重複統合・弱い負例ラベル付け）
python src/batch/import_teacher_points.py --xlsx .\教師データ.xlsx

# 2) まず少数だけworld生成 + 進入アプローチ作成
node src/batch/build_teacher_site_routes.js --limit 20 --compile --radius-m 450 --approach-m 120 --alternatives 4

# 3) ローカル配信（別ターミナル）
python web_server.py

# 4) 生成済みルートを車種別に実走照合
node src/batch/run_teacher_site_routes.js --vehicles 2t_flat,3t_flat,4t_flat,10t_unic
```

ラベル方針:
- 記録された車格: 強い正例（入った事実）
- 記録最大車格以下: 推定passable
- より大きい未記録車格: 弱い負例。配車しなかっただけの可能性があるため、
  業務上「入れないから配車していない」と確認できるまで hard NG にはしない。
- 複数アプローチのうち1本でもPASSすれば、その地点×車種は通行可能候補として扱う。

## 4. 道路幅の精度改善（road_seg）

`道路幅AI検証.bat` をダブルクリック → メニュー:
- `1` 動作確認（幾何エンジン selfcheck 11項目 + サーバsmoke、ネット不要）
- `2` 航空写真でテスト（実GSI→幅推定→overlay.png目視）
- `3` APIサーバ起動（`/segment_road_width` / `/segment_road_surface` / `/annotate/*`）
- `4` 道路ラベル作成（地図で範囲選択→下書き修正→保存）
- `5` 学習（手動修正を強教師、弱教師データを補助にした混合 U-Net / DeepLabV3+）
- `6` 手動データだけ学習
- `7` 教師データ統計

地図/画像ソースは国土地理院。画面表示は `seamlessphoto`、初期下書きは既定で
`experimental_rdcl` の道路中心線+幅員ランクから生成する。保存した手修正マスクは
`road_seg/dataset/images` + `masks` に入り、`road_seg.train_mixed` では強教師として扱う。
ラベルUIでは、ブラシのほかに直線ツール、RDCL既存道路の幅m編集、編集キャンバスの
拡大/縮小（Ctrl+ホイール可）が使える。
学習後は annotate の初期下書き・backend=pretrained が新モデルを使う。
**育つほどラベル作成が楽になるループ**を回す。

CLI:
```powershell
.\.venv\Scripts\python.exe -m road_seg.train_mixed --epochs 30 --manual-repeat 8
.\.venv\Scripts\python.exe -m road_seg.train_mixed --arch deeplabv3plus --epochs 30 --manual-repeat 8
.\.venv\Scripts\python.exe -m road_seg.compare_models --sites site0008,site0019
.\.venv\Scripts\python.exe -c "from road_seg import dataset; import json; print(json.dumps(dataset.stats(), ensure_ascii=False, indent=2))"
```

道路面そのものの補強:
- `python -m uvicorn road_seg.server:app --port 8012` で road_seg サーバを起動。
- 3Dワールド読込後、`index3D_V2.0.html` の「航空写真で道路面補強」を押す。
- 内部では `/segment_road_surface` が航空写真マスクを GeoJSON Polygon に変換し、
  `maskEdits.allow` に `source=road_seg_surface` として追加する。手修正 allow/deny は保持する。
- `road_seg/models/road_unet.pt` がある環境では `backend=pretrained` を既定で使う。
  切り替える場合は `window.ROAD_SEG_SURFACE_BACKEND = 'threshold'` などで指定する。
- コンソールからは `window.roadSegSurfaceApply()` / `window.roadSegSurfaceClear()` でも実行できる。

## 5. アプリでの手動確認

```powershell
起動.bat   # → index3D_V2.0.html
```
経路確定 → 自動走行（`startAutoFollow`）。走行物理は固定dt化済みのため、
**同じルート・同じ車両なら軌跡は毎回同一**（PCの重さ・fpsに依存しない）。
挙動が実行ごとに変わる場合は決定論の破れ＝バグとして手順1の観点で調査する。

## 6. 開発規約（決定論を守るための禁止事項）

| 禁止 | 代わりに |
|---|---|
| 物理・判定での `Math.random` | `autoFollowCore.createRng(seed)` |
| 物理・判定での壁時計 (`Date.now`, rAF ts) | `simTimeS`（固定dtの積算） |
| truckDrive等での経路幾何の再実装 | `autoFollowCore` の `bearing/buildCumulative/sampleRouteAt` |
| 可変dtで状態を進める | アキュムレータ + `SIM_DT_S` 固定ステップ |
| 判定ロジックへのDOM/描画依存 | 純関数に切り出し、描画は状態を読むだけ |

## 7. 定期運用（推奨サイクル）

- 毎コミット: 手順1（数秒）+ `node --check` 変更ファイル
- 毎日/毎週: 手順3 ゴールデン回帰 → 混同行列の悪化セルを Issue 化
- 随時: 手順4 でラベル追加 → 数百件ごとに再学習 → 手順3 で効果を数値確認
