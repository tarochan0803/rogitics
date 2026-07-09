# L4SIM 計画書 — 高精度3D世界生成 × レベル4自動運転シミュレーション

作成: 2026-07-01 ／ 対象: LOGISTICS_OS v8.2（index3D_V2.0系）

## 1. 目的

無料・合法の地理データ（GSI・OSM・PLATEAU）から高精度3D世界を生成し、その上で
トラックの**レベル4相当の自動走行シミュレーション**を実行、搬入可否判定の精度を
「感覚」ではなく「数値」で徹底的に向上させる。

### L4 の本プロジェクトでの定義
> ODD（=搬入コリドー内・静的世界＋既知障害物）の中で、人間の介入なしに出発から
> 搬入先まで走破し、続行できない場合は自ら安全に停止（MRM）する。

センサー（LiDAR等）シミュレーションは対象外。知覚は幅融合モデル（confidence付き）で
代替し、「不確実なら減速・停止」に倒す。既存 `autonomousSpeedFactor` の思想を継承する。

## 2. 中核となる2つの設計転換

### 転換A: ワールドコンパイラ（オンライン取得→オフライン焼き込み）
シミュレーションは**バージョン付きワールドファイルのみ**を読む。ネットの揺らぎを排除し、
データ改善の効果をワールドhash単位で比較可能にする。

### 転換B: 決定論的シミュレーション（Phase 0・**実装済み**）
- 物理・判定は固定タイムステップ SIM_DT_S=0.05s のみで進む（rAF揺らぎはアキュムレータで吸収）
- 乱数は seed 付き（`createRng`）、`Math.random` 禁止
- 毎tickの record/replay（`trace.js`）→ バグ報告 = {worldHash, seed, dt, tick} で完全再現
- 検証: `run_sim_repro.js` — **100回走行で trace ハッシュ全一致 / リプレイ1tick照合一致 /
  フレーム揺らぎ吸収 / dt半減ドリフト0.000m を確認済み**

## 3. データソースと精度上限（誤差バジェット）

| ソース | 精度 | 役割 | 状態 |
|---|---|---|---|
| GSI DEM5A/5B 標高タイル | 高さ±0.3m/5m格子 | 地形・勾配 | 使用中（Phase 1追加、道路別DEM勾配→速度へ配線済み） |
| 基盤地図情報 道路縁 | 水平±0.7m級 | 車道幅の最有力ソース | 使用中（Phase 2融合済み、東京AOI 18/57道路に付与） |
| GSI 航空写真 | ~0.5m/px (z18) | road_seg幅推定・地面 | 使用中 |
| GSI experimental_rdcl | 幅員4ランク | 幅の下限保証 | 使用中 |
| PLATEAU LOD1/2 | ±0.5m級 | 建物、（一部都市）車道面 | 建物のみ使用中 |
| OSM | 場所依存 | グラフ・属性・建物fallback | 使用中 |
| JARTIC/OSM規制 | — | 通行規制 | 使用中 |

**到達精度はコリドー内±0.3〜0.7mが上限。** 戦略は cm を追うことではなく、
誤差を confidence としてリスクモデルに伝播し、不確かな所ほど保守化すること。

## 4. アーキテクチャ（自動運転スタック）

```
① Route Planner    graph.js（既存）
② Behavior Planner src/sim/autonomy/behaviorPlanner.js（既存: STOP/allowedSpeedMS サンプル）
③ Motion Planner   trajectoryPlanner.js + kinematics.js（既存: 曲率→速度プロファイル）
④ Controller       autoFollowCore.js（Phase 0実装済み・決定論）→ pure pursuit拡張へ
⑤ Safety Monitor   実装済み（Phase 3コア）: 毎tick不変条件の独立検査 + MRM停止
```
⑤が二重系の要。②〜④がどう間違えても Monitor が違反検出→停止。違反ログがそのまま
回帰テストのアサーションになる。

## 5. デバッグ・精度向上の方法論（4層）

1. **単体（幾何）**: 既知の答えを持つ合成ケースで検証（road_seg selfcheck方式。
   `run_sim_repro.js` が第1号）。CIで許容誤差を固定。
2. **不変条件（毎tick）**: 「車体⊂道路面∪allow」「クリアランス>0」「v≤カーブ上限」。
   違反tickでtraceを自動保存。
3. **回帰（ゴールデンルート）**: `run_golden_benchmark.js` を拡張し**実搬入実績を正解**に。
   混同行列（通れるのに不可/通れないのに可）を自動集計。
4. **シナリオ行列**: 車種×幅帯×形状（直線/直角/クランク/切り返し）×勾配 を全走行。

精度向上ループ: ベンチ実行 → 最悪セル特定 → 誤差源切り分け（幅/形状/制御） → 修正 →
再実行。ワールドhashとtraceで前後比較が常に可能。

## 6. ライセンス
GSI=出典明記で商用可 / PLATEAU=CC BY 4.0相当 / OSM=ODbL（出典明記・社内利用可）/
Google系はコア判定から排除を継続。学習系は MIT/BSD のみ（Ultralytics AGPL不使用）。

## 7. 成果物・関連文書
- 手順書: [PROCEDURES.md](PROCEDURES.md) ／ ロードマップ: [ROADMAP.md](ROADMAP.md) ／
  ダイアグラム: [DIAGRAMS.md](DIAGRAMS.md)
- Phase 0 実装: `src/sim/autoFollowCore.js`, `src/sim/trace.js`,
  `src/batch/run_sim_repro.js`, `truckDrive.js`（固定dt化）
- 既存資産: road_seg（幅推定・教師データ作成・学習）, run_golden_benchmark, behaviorPlanner
