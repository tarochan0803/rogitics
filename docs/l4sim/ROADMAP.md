# L4SIM ロードマップ

各フェーズに**機械的に判定できる完了条件**を置く。前フェーズの完了条件が
回帰テストとして残り続ける（後戻り検知）。

## Phase 0 — 決定論化 ✅ 完了（2026-07-01）

| 項目 | 内容 | 状態 |
|---|---|---|
| 固定タイムステップ | `SIM_DT_S=0.05` アキュムレータ方式（truckDrive._autoLoop） | ✅ |
| 幾何の単一実装 | `src/sim/autoFollowCore.js`（ブラウザ/Node共有） | ✅ |
| seed付き乱数 | `createRng`（mulberry32） | ✅ |
| record/replay | `src/sim/trace.js`（JSONL + FNV-1aハッシュ + 1tick照合） | ✅ |
| ヘッドレス検証 | `src/batch/run_sim_repro.js` | ✅ |

**完了条件（達成済み・回帰として維持）**: 100回走行trace全一致 / リプレイ照合一致 /
フレーム揺らぎ吸収 / dt半減ドリフト<0.5m → 実測 0.000m

## Phase 1 — ワールドコンパイラ（データパス完了 2026-07-03）

AOI→全ソース取得→融合→**バージョン付きワールドファイル**へ焼き込み。シミュは焼き込み
ファイルのみを読む。
- [x] `compile_world.js`: rdcl道路+DEMプロファイルを world_<hash>.json へ焼き込み
      （正準直列化+FNV-1a、metaはhash対象外。selfcheck 全項目 ALL PASS を維持）
      ※道路の絞り込みは**bbox重なりフィルタ**（geometry clippingではない）:
      「AOI bboxと重なるfeatureを残す」（形状は切らない＝座標がAOI外に出る道路も残る）。
      境界跨ぎ道路を保持して経路連続性を優先する設計判断。厳密なAOI限定ワールドが
      必要になったらジオメトリクリップを別途実装する。
- [x] **GSI DEM5A/5B 追加**（`src/world/demTiles.js`。実データで30/30サンプル解決）
- [x] HTTPディスクキャッシュ + `--offline` 再コンパイル
      （現行実測: 通常コンパイルで hash `26c2e88f`、道路57本=bbox重なりフィルタ後。
      `--offline` 再コンパイルでも同hash）
- [x] 建物レイヤ（OSM, 実測35棟）・規制レイヤ（OSM maxheight等+oneway, 実測113件）焼き込み
- [x] 更新ポリシー: GSIタイル無期限 / Overpass TTL7日 / `--refresh` 強制再取得
- [x] ローダー配線: `window.index3DLoadCompiledWorld` → roads/buildings/規制
      （規制は setActiveExternalRegulations 経由で既存判定が無変更で読む）
- [x] ブラウザ実機での読込確認（Puppeteer: roads/buildings/規制ロード + worldLoaded=true）
- [x] E2E完走確認（Puppeteer実ブラウザ: 経路確定70点→compiled world差し替え
      hash`5b58dda1`検証済み→自動走行→Phase3=建物ソリッド65/Phase4=autonomy SLOW・
      stops=0・pageエラー0。実行はボタンと同一ハンドラのフック経由）
- [ ] 厳密フルオフライン起動（CDN(leaflet/three/turf)ローカル化+OSRM代替が必要。別課題）
- [ ] JARTIC/xROAD フェッチャ（**方針確定: 無料API・非リアルタイム・定期更新**。口は既存）
- [x] 道路ごとのDEM勾配付与（実測: 39/57道路。勾配サンプル2未満の短片は付与しない、
      最大30%キャップ+中央値併記。クリップ後の最大勾配2.02%=丸の内の平坦と整合）

**完了条件**: ①同一AOI再コンパイルで world hash 一致 → **達成**。
②compiled world で経路確定→自動走行→判定まで完走 → **達成（E2E ALL PASS, 2026-07-03）**。
※「ネット切断状態での起動」はデータ層(world file)は対応済みだが、アプリシェルが
CDN/OSRM に依存するため厳密フルオフラインは別課題として残す。
**Phase 1 はデータパスとして完了。** 残項目（JARTIC・フルオフライン）は独立タスク化。

## Phase 2 — 幾何精度（誤差バジェット駆動）

- [x] **基盤地図情報 道路縁**を幅融合の正式ソースへ（`fgd_edge` 0.88/priority92、
      全体幅→歩道控除。roadMetrics.js 垂線レイキャスト。探索マージン25m→40mで
      実測: 東京駅前 **18/57道路=32%** に付与、hash `26c2e88f`）
- [x] DEM勾配を速度へ反映（`gradeSpeedFactor`: 3%まで1.0→12%で0.6頭打ち。
      behaviorPlanner で confidence と独立係数として乗算、サンプルに gradePct 記録。
      急坂AOI（長崎 hash `321548d4`）で30%勾配→`gradeSpeedFactor=0.6`、
      ブラウザ実測 Phase4 `SLOW` / pageエラー0）
- [x] `curveSpeedLimitMS` 配線 — **調査の結果、behaviorPlanner.js:399 で既に配線済みだった**
      （CLAUDE.md の「未配線」記述が古かった。記述を修正済み）
- [x] road_seg道路面補強の入口 — `/segment_road_surface` で航空写真マスクを
      `maskEdits.allow` 用GeoJSONに変換し、3D画面の「航空写真で道路面補強」と
      `window.roadSegSurfaceApply()` から適用可能。手修正allow/denyとは分離。
- [x] road_seg学習ループ — 国土地理院 `seamlessphoto` + `experimental_rdcl` 下書きを
      手動修正し、`dataset/images` + `masks` を強教師として保存。`train_mixed.py` で
      弱教師 `dataset_weak` と混合し、既存 `road_unet.pt` から継続学習できる。
- [ ] road_seg学習モデル（数百ラベル後）を幅ソースに追加、SV/YOLOと相互チェック
- [ ] FGD未付与の改善（東京AOI分類済み 2026-07-03: A=全点bbox外15本〈縁タイルはbbox内のみ
      取得のため対象外・仕様〉／B=RdEdgデータ欠損0本／C=縁近傍なのに計測不成立24本。
      Cの主因仮説: 丸の内級の広幅員で探索上限 maxHalfWidthM=15m が対側縁に届かない＋
      交差点ギャップで coverage<0.3。対策候補: gsiWidthEstimate連動の上限拡大。ただし
      過大幅→道路帯過大→判定が甘くなる副作用があるため、検証つきで慎重に）

**完了条件**: ゴールデン混同行列が計測可能（実績ルート30本以上）。道路縁がある区間で
幅誤差の中央値 ≤ 0.5m。

## Phase 3 — L4スタック ✅ 完了（2026-07-03）

- [x] Safety Monitor: 毎tick不変条件（車体⊂道路面∪allow / クリアランス>0 / v≤カーブ上限）
      独立検査 + 違反時trace自動保存（`src/sim/safetyMonitor.js`、3D再生tickへ配線）
- [x] MRM: 続行不能時の安全停止（Safety違反または behaviorPlanner の未解決STOPで停止。
      `index3DGetSafetyMetrics()` / `index3DGetSafetyTrace()` で理由コードとtrace取得）
- [x] 回帰ハーネス `run_l4_route_regression.js`（実道路から代表ルート自動選定→
      PASS/MRM_OK/FAIL_MONITOR/FAIL_INCOMPLETE 機械判定。経路注入 `index3DSetRoute`、
      始終点±12m猶予、狭幅ゲート narrowWidthSpeedFactor、進捗メトリクス込み。
      routeMeta.source==='test' の自動再構築上書き防止とルート単位ページ隔離込み）
      実測: 東京AOI 5/5 PASS、長崎急坂AOI 5/5 PASS、Monitor違反0/pageエラー0。
      旧4/5および長崎FAILは、注入経路が端点直線へ潰れる/連続実行状態が混入する
      ハーネス側の偽陽性として修正済み。
- [ ] 切り返し（後退含む）の behavior 追加、pure pursuit 制御へ拡張
      （autoFollowCore に steer 付き自転車モデル step を追加。本当に必要なルートが出た段階で着手）

- [x] 正常系ブラウザ実走（誤検知なし）: デモAOI `773f1fb4` 実道路経路で
      232tick監視 status=OK / firstViolation=null / MRMなし（2026-07-03）。
      ※これに伴い compile_world へ rdcl幅ランク→gsiWidth* 焼き込みを追加
      （無いと道路面が既定幅帯になり大通りでも逸脱誤検知）。gsi.js の
      「13-19.5m/19.5m以上」テキストランク未解析バグも修正。
      **幅焼き込み前の旧 world_*.json は Safety Monitor 用途に非推奨 → 要再コンパイル**
      （現行: 東京`c6c4f2e9` / 長崎`75cce456` / デモ`773f1fb4`）。

**完了条件**: 代表20ルートを無介入走破 or 正当な理由コード付きMRM停止。
Monitor違反=0（違反があれば planner のバグとして修正）。
→ **達成（2026-07-03）**: 3ワールド（東京6・長崎急坂10・丸の内6）**計22ルート 全PASS**
（全ルート進捗100%走破・Monitor違反0・MRM 0・pageエラー0。幅5m/勾配7.2%の坂道含む）。
レポート: `runtime/l4_regression/regression_1783062354714.json` / `_1783063227914.json`
※未実装の「切り返しbehavior」は完了条件外のオプション拡張（必要なルートが出た段階で着手）。

## Phase 4 — 回帰農場（**方針: 夜間/定期実行なし・すべてオンデマンド**）

- [x] シナリオ行列（幅帯4×勾配帯3×形状3 × 車種）`run_l4_scenario_matrix.js`。
      初回実測32走行で「10tの狭幅カーブ逸脱（直線は通る）」という本物のギャップを検出
      → behaviorPlanner にスイング連動狭幅ゲート（swing≈Lf²/2R、Lf補間係数）を実装。
- [x] 前回比レポート `report_l4_regression.js`（悪化=赤字+exit 1、report_latest.md）
- [x] 実績データ取り込みフロー（地点実績）:
      `教師データ.xlsx` → `teacher_points.json` → 接続道路アプローチ生成 →
      `run_teacher_site_routes.js` で車種別実走照合。401行を395地点へ取込済み。
- [ ] 実績データの hard NG 化:
      大きい車格を配車しなかった理由が「入れないため」と業務上確認できる行だけ、
      weak negative から hard NG/golden-routes へ昇格する。
- [x] スイングゲートのチューニング収束（最新2件比較で悪化0。
      実測 `matrix_1783095780190`: PASS 25 / MRM_OK 13 / FAIL 0 / pageErrors 0）
- [x] 残FAIL 1件の解析: `2t_flat w35_45|flat|sharp / gsi-46755-11784-i-6267`
      はK-turn v2の帯内事前検証で解決。帯内軌道なしを違反前に検出し、
      `switchback_infeasible` の理由コード付きMRMへ落とす。
      単体ブラウザ実測（2026-07-04）: i-6267 は MRM_OK / firstViolationなし / pageErrors 0。
      併せて、K-turn可能側の i-2764 は PASS / firstViolationなし / pageErrors 0 を確認。
- [x] K-turn v2コードでの全シナリオ行列・代表ルート回帰 完走（2026-07-04）:
      行列38走行 **FAIL 0**（PASS25/MRM_OK13/pageエラー0・前回比悪化0）、
      代表16ルート **FAIL 0**（PASS15/MRM_OK1=幅3m路の理由付き停止）。
      ハーネス頑健化: rAF飢餓による偽FAIL_INCOMPLETE対策
      （tick停滞の完了即断はゴール圏内のみ、途中は20秒猶予）。

**完了条件（改訂: 夜間なし）**: 変更後に手動で `行列 → report` を回せば、
「何が悪化したか」が1コマンドで赤字表示される状態。

## 実施順の理由
0→1 が全ての土台（再現性なしに精度改善の効果測定は不可能）。2 は判定品質に直結する
最大の誤差源（幅）から。3 は 2 の精度が乗って初めて意味を持つ。4 は 1〜3 の資産を
自動で回す仕組み。
