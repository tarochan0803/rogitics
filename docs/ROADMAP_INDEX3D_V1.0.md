# index3D_V1.0 Roadmap

Date: 2026-05-26

## Goal

`index3D_V1.0` は、既存の LOGISTICS OS の経路確定、場所検索、地名変換、建物読み込み、道路幅調整、YOLO / Street View 解析を残したまま、主画面を「狭い範囲の詳細3D搬入シミュレーター」に寄せる。

目標は、広域の美麗3Dビューではなく、搬入可否判断に効く小範囲の3Dデジタルツインを作り、その中でトラックを実際に走らせること。

## Operating Constraint

普通のノートPCで動くことを優先する。

- 対象範囲は初期値で経路中心から半径 150-300m、最大でも 500m 程度に制限する。
- 3Dメッシュは事前生成またはキャッシュし、描画中に重いGIS処理を走らせない。
- 衝突判定用の世界は軽量なベクトル/ボクセルで持ち、写真測量やPhotorealistic 3D Tilesは見た目確認用に限定する。
- 目標FPSは 24-30fps。ロード時間は初回 30-120秒程度まで許容し、2回目以降はキャッシュで短縮する。
- GPUがなくてもCPUフォールバックで完走できる構成にする。

## Data Strategy

結論として、精密3D化は「良いデータセットだけ」「YOLOだけ」「Street Viewだけ」のどれか単独では成立しない。役割を分ける。

### Primary Geometry

搬入判定の主データ。

- 道路中心線: 既存の OSM / GSI / OSRM / Overpass 取得を継続。
- 道路幅: OSM `width`、`lanes`、道路種別既定値、既存の手動上書き、SV/YOLO推定を統合。
- 建物: PLATEAU がある場所はPLATEAUを優先。なければOSM建物押し出し。
- 全国/広域の補助: Overture Maps の buildings / transportation をオフライン候補にする。

### Visual Context

人が見て納得するための背景。

- 既存の Three.js 衛星地面タイルを継続。
- Google Photorealistic 3D Tiles はオプション扱い。視覚確認には強いが、衝突判定の真値にはしない。
- Cesium / 3D Tiles は将来の大規模データストリーミング用として維持する。

### Perception Correction

現場のズレを補正する層。

- YOLO / segmentation: 駐車車両、看板、ガードレール、歩道縁、路面境界、電柱、歩行者、工事物などの検出。
- Street View / Mapillary: 道幅、路肩、曲がり角の見通し、頭上障害物、標識、進入禁止の確認。
- 重要点: YOLOは推定値なので、幅員の最終値ではなく confidence 付きの補正候補として扱う。

### Human Override

搬入現場では最終的に人の補正を残す。

- 道路幅の局所上書き。
- 進入禁止ポリゴン。
- 一時障害物。
- 高さ制限、電線、庇、門扉、段差。

## Architecture

### New Entry

- `index3D_V1.0.html`
- `index3D_V1.0.css`
- `src/index3dMain.js`

既存の `index9.0.html` は維持し、`index3D_V1.0` は3D主体の別エントリにする。

### Core Modules

- `src/3d/localWorldBuilder.js`
  - 経路周辺の小範囲を取得し、3D世界の素材をまとめる。
- `src/3d/roadMeshBuilder.js`
  - 道路中心線と幅員から、走行面、路肩、歩道、縁石、交差点面を生成する。
- `src/3d/buildingMeshBuilder.js`
  - PLATEAU / OSM / Overture建物を軽量メッシュ化する。
- `src/3d/obstacleMeshBuilder.js`
  - YOLO / 手動ポリゴン / Street View 由来の障害物を3D化する。
- `src/3d/worldCache.js`
  - AOI単位で道路、建物、幅員補正、メッシュをキャッシュする。
- `src/sim/autonomy/behaviorPlanner.js`
  - 停止、徐行、切り返し、回避、再計画などの状態遷移。
- `src/sim/autonomy/motionPlanner.js`
  - Frenet/lattice候補を出し、衝突しない軌跡を選ぶ。
- `src/sim/autonomy/controller.js`
  - Pure Pursuit / Stanley / PID 系の制御でトラックを追従させる。
- `src/sim/autonomy/truckDynamics.js`
  - ホイールベース、オーバーハング、操舵速度、加減速、横加速度制限を扱う。
- `src/sim/autonomy/sensorModel.js`
  - 簡易LiDAR/raycast、前方距離、左右余裕、頭上余裕を計算する。

## Roadmap

### Phase 0: Current System Freeze

目的: 既存機能を壊さず3D版を作れる状態にする。

- `index9.0` の経路検索、道路取得、建物取得、幅員補正、YOLO、Street View、搬入判定を回帰確認する。
- `index3D_V1.0` 用の新エントリを作る。
- 既存の `map3dThree.js` を読み、3D主体画面に切り出す。
- 3D版でも既存 store / route / buildings / width overrides をそのまま読めるようにする。

Exit criteria:

- 既存の `index9.0.html` が今まで通り動く。
- `index3D_V1.0.html` が同じ経路データを読み、空の3Dシーンを開ける。

### Phase 1: Local 3D Sandbox MVP

目的: 狭い範囲を3D化してトラックを走らせる最小版。

- 経路中心または地図中心から半径 150-300m のAOIを作る。
- 既存の道路GeoJSONを道路幅でポリゴン化し、Three.jsの走行面メッシュにする。
- 建物を高さ付きで押し出す。PLATEAU高さがあれば優先、なければOSM levels、なければ既定値。
- 衛星地面タイルを現在の `map3dThree.js` から流用する。
- 既存の `simulatePathPoses()` でトラックを走らせる。
- 3D画面に「走行面」「建物」「経路」「トラック」「接触点」を表示する。

Exit criteria:

- 東京駅周辺など既存ベンチ経路で3D読み込みが完了する。
- 建物0件でも道路メッシュとトラック走行は成立する。
- 30fps近辺で表示できる。

### Phase 2: 3D Road Quality

目的: 「道路らしい平面」ではなく、搬入判断に使える道路モデルへ近づける。

- 道路中心線ごとに `sourceWidth`, `tagWidth`, `laneWidth`, `manualWidth`, `yoloWidth`, `finalWidth`, `confidence` を持つ。
- 道幅の採用理由を道路ごとに表示する。
- 交差点を単純な線バッファではなく、進入/退出角を見て面として補正する。
- 歩道、縁石、路肩、中央線を簡易3Dレイヤー化する。
- 急カーブや狭隘路ではメッシュ解像度を上げ、直線部では粗くする。
- 手動幅調整は3D上で即時反映する。

Exit criteria:

- 幅員の根拠がUI上で追える。
- 道路幅上書き後、3D走行面と衝突判定が同時に更新される。
- 交差点で不要な接触が減る。

### Phase 3: Building and Obstacle Precision

目的: 建物・壁・障害物を判定用の3D障害物として使う。

- PLATEAU GeoJSONだけでなく、CityGML/3D Tiles/事前変換済みデータを受けられる設計にする。
- 建物は描画用メッシュと判定用簡易ソリッドを分ける。
- 低い塀、門、庇、看板、電柱、街路樹、駐車車両を障害物レイヤーとして追加する。
- Street View / YOLO 由来の障害物は route stationing、左右オフセット、推定高さ、confidence を持つ。
- 頭上障害物は `clearanceHeight` として扱い、車高/積荷高と照合する。

Exit criteria:

- 建物衝突、路外逸脱、頭上障害物を別々に表示できる。
- YOLO検出物は真値扱いせず、confidence付き候補として3Dに載る。
- 搬入判定レポートに3D接触根拠が出る。

### Phase 4: Autonomy Stack v1

目的: 経路をなぞるだけではなく、自動運転らしく走る。

- Behavior planner:
  - 通常走行、徐行、停止、切り返し、回避、失敗、再計画の状態を持つ。
- Motion planner:
  - 経路中心線の左右に複数候補を生成する。
  - 先読み距離内の候補軌跡を評価し、接触、余裕、曲率、切り返し回数でスコアリングする。
- Controller:
  - 目標軌跡をPure Pursuit/Stanley系で追従する。
  - 速度は曲率、残り幅、障害物距離、停止距離で制限する。
- Truck dynamics:
  - 操舵角、操舵速度、加減速、横加速度、ジャークを制限する。
  - 前後オーバーハング、積荷は掃引体積に含める。
- Recovery:
  - 狭角ターンで失敗したら一時停止、後退、切り返し候補を試す。

Exit criteria:

- 同じ経路で単純追従より接触回数が減る。
- 自動停止、徐行、再計画が3D上で見える。
- 走行ログに速度、操舵角、余裕、接触候補、planner状態が残る。

### Phase 5: Perception Fusion

目的: Street View / YOLO を本当に道路補正に使う。

- 経路上のサンプル点を stationing で管理する。
- Street View画像、YOLO検出、セグメンテーション、道路候補を同じ station に紐づける。
- 幅員推定は1枚画像で決めず、複数フレームの中央値/信頼度で決める。
- Mapillary APIはGoogle Street Viewが薄い場所の補助候補にする。
- YOLO結果は `suggestedWidth` として出し、既存幅から大きく外れる場合は手動確認に回す。

Exit criteria:

- `yoloCoverage > 0` の実経路ケースを作る。
- SV/YOLOによる道路幅更新が3Dメッシュへ反映される。
- 信頼度が低い補正は自動採用されない。

### Phase 6: Benchmark and Calibration

目的: 見た目だけでなく、搬入判断の品質を測る。

- 既存の golden route benchmark を3D版へ拡張する。
- 指標:
  - load time
  - FPS
  - route success/fail
  - minimum clearance
  - contact count
  - steering saturation time
  - reverse maneuver count
  - yolo coverage
  - manual override count
- 実際に搬入可否が分かっているルートを `CONFIRMED_PASS` / `CONFIRMED_FAIL` として固定する。
- 3Dスクリーンショットと走行ログを保存する。

Exit criteria:

- 3Dシーン、走行ログ、判定結果が同じベンチ出力にまとまる。
- 変更後に既存ケースの劣化が分かる。

### Phase 7: Optional Advanced Layer

目的: 高度化。ただし初期版の必須にはしない。

- Google Photorealistic 3D Tiles:
  - 視覚確認モードとして追加。
  - 判定用ジオメトリとは分離。
- Cesium 3D Tiles:
  - PLATEAUや大規模3D都市データのストリーミング候補。
- SUMO連携:
  - 他車両や交通流を扱う場合に採用。
  - 搬入1台の幾何判定だけなら必須ではない。
- CARLA級シミュレーター:
  - 自動運転研究には強いが、普通のノートPC条件では初期採用しない。

## Dataset Choice

推奨順。

1. PLATEAU
   - 日本国内の3D建物では最優先。
   - カバーがある都市では高さや属性の信頼度が高い。
2. OSM + GSI
   - 道路ネットワークと広域の基本。
   - 幅や現場詳細は不足するため補正前提。
3. Overture Maps
   - 建物/交通データの広域補助。
   - オフライン取得、PMTiles/Parquet変換のパイプライン向き。
4. Google Photorealistic 3D Tiles
   - 見た目の説得力は高い。
   - APIキー、課金、利用規約、判定用途の扱いに注意。
5. Street View / Mapillary / YOLO
   - 現場補正と障害物候補に有効。
   - メイン地図データの代替にはしない。

## Implementation Order

最初の実装で作る順番。

1. `index3D_V1.0.html` を作る。
2. 既存 route/store/buildings/width overrides を3D版で読む。
3. AOI制限付きの `localWorldBuilder` を作る。
4. 道路メッシュと建物メッシュを生成する。
5. 既存 `simulatePathPoses()` でトラック走行を3D表示する。
6. 3D接触点と余裕を表示する。
7. 既存 YOLO/SV 幅補正を3Dメッシュに接続する。
8. Autonomy Stack v1 を入れる。
9. 3Dベンチを追加する。

## Phase Verification Protocol

各フェーズは、実装だけで完了にしない。必ずそのフェーズ単体で起動・確認できる状態にしてから次へ進む。

共通ルール:

- 各フェーズ完了時に `docs/VERIFY_INDEX3D_PHASE_N.md` を残す。
- 確認対象URL、操作手順、期待結果、実結果、スクリーンショット/ログパスを書く。
- 自動確認できるものは `node --check`、Python compile、既存 golden benchmark、3D smoke test に入れる。
- 失敗していても、失敗内容と次フェーズへ進める/止める判断を明記する。
- `index9.0.html` の既存機能は各フェーズで最低1回は壊れていないことを確認する。

### Phase 0 Verification

目的: 既存機能の凍結確認と、3D版エントリの空起動。

Manual:

- `index9.0.html` を開き、場所検索、経路生成、道路取得、建物取得、搬入判定が起動すること。
- `index3D_V1.0.html` を開き、3D画面が空シーンとして表示されること。

Automated:

- `node --check` を新規/変更JSに実行。
- `python -m py_compile` をサーバー変更がある場合に実行。
- `src/batch` の golden dry run を実行。

Pass:

- 既存 `index9.0` に退行なし。
- `index3D_V1.0` がコンソールエラーなしで起動。

### Phase 1 Verification

目的: 小範囲3DサンドボックスMVP。

Manual:

- 既存ベンチ経路を1つ選び、AOI内の道路面、建物、経路、トラックが表示されること。
- 建物0件でも道路面とトラック走行が成立すること。
- 3D再生/停止/リセットが使えること。

Automated:

- 3D smoke test を追加し、`index3D_V1.0.html` を開いて canvas 表示、route mesh count、truck pose count を確認。
- 走行後に contact count が取得できること。

Pass:

- 150-300m AOIでロード完了。
- 24fps以上を目安に操作可能。
- 走行ログが保存される。

### Phase 2 Verification

目的: 道路幅と交差点の3D品質確認。

Manual:

- 道路幅の根拠 `sourceWidth/tagWidth/laneWidth/manualWidth/yoloWidth/finalWidth/confidence` がUIで見えること。
- 手動で道路幅を変更すると、3D道路面と判定結果が更新されること。
- 交差点で線バッファ由来の不自然な穴や過剰接触が減っていること。

Automated:

- 幅員上書き前後の road mesh bbox / area / clearance を比較するテストを追加。
- 既存 golden route に `finalWidth` coverage を出す。

Pass:

- 幅員変更が即時反映。
- 幅員根拠がレポートに残る。
- 交差点の代表ケースで接触数が悪化しない。

### Phase 3 Verification

目的: 建物・障害物の3D判定確認。

Manual:

- PLATEAUあり/なしの両ケースで建物が表示されること。
- 手動障害物、YOLO由来障害物、頭上障害物が別レイヤーで表示されること。
- 車高/積荷高を変えると頭上障害物判定が変わること。

Automated:

- 建物メッシュ数、判定用ソリッド数、障害物数を smoke test に出す。
- 既知の障害物fixtureで接触/非接触を確認。

Pass:

- 建物接触、路外逸脱、頭上障害物が別々に判定される。
- 判定根拠が搬入レポートへ出る。

### Phase 4 Verification

目的: 自動運転風の走行スタック確認。

Manual:

- 通常走行、徐行、停止、回避、再計画、失敗の状態が3D HUDに表示されること。
- 狭い箇所で速度が落ちること。
- 接触しそうな場面で停止または回避候補を試すこと。

Automated:

- planner状態、速度、操舵角、横余裕、停止距離をログ出力。
- 単純追従とAutonomy v1で接触数/最小余裕/走行時間を比較。

Pass:

- 単純追従より接触数または最小余裕が改善。
- plannerログで判断理由を追える。

### Phase 5 Verification

目的: YOLO / Street View 補正のE2E確認。

Manual:

- Street ViewスキャンからYOLO解析、幅員候補、3D道路面更新までを1経路で実行。
- 信頼度が低い補正は自動採用されず、確認待ちになること。
- Google Street Viewが使えない場合でも、処理が落ちずにスキップ理由を出すこと。

Automated:

- `yoloCoverage > 0` のfixtureを1つ作る。
- YOLOあり/なしで `finalWidth` と判定結果の差分を保存。

Pass:

- SV/YOLO補正が3Dメッシュに反映。
- confidenceがレポートに残る。

### Phase 6 Verification

目的: ベンチマークと品質管理。

Manual:

- 3D実行結果からスクリーンショット、走行ログ、判定レポートを確認できること。
- `CONFIRMED_PASS` / `CONFIRMED_FAIL` ケースの期待結果が固定されていること。

Automated:

- 3D golden benchmark を追加。
- 指標として load time、FPS、contact count、minimum clearance、steering saturation、reverse count、yolo coverage を出す。

Pass:

- 変更前後の差分が見える。
- 代表ケースがCI相当の一括コマンドで確認できる。

### Phase 7 Verification

目的: 高度化レイヤーの任意確認。

Manual:

- Photorealistic 3D Tiles / Cesium / SUMO連携は、個別トグルでON/OFFできること。
- OFFの状態で基本3Dシミュレーターが軽く動くこと。

Automated:

- オプション機能が無効でも smoke test が通る。
- APIキーがない場合は明示的にスキップされる。

Pass:

- 高度化機能が基本機能を壊さない。
- ノートPC向け軽量モードを維持できる。

## First Deliverable

`index3D_V1.0` の最初の完成条件。

- 2D地図ではなく3Dビューが主画面。
- 場所検索、地名変換、経路確定、道路取得は既存機能を使える。
- 経路周辺だけを3D化する。
- 道路面、建物、経路、トラック、接触/余裕を表示する。
- トラックが自動で走行し、狭い箇所では徐行/停止する。
- YOLO / Street View 結果がある場合は道路幅や障害物候補として反映される。
- ノートPCで重すぎる場合は、建物詳細、衛星テクスチャ、Photorealistic 3Dを段階的にOFFにできる。

## Non-Goals for v1.0

- 全国全域を高精度3Dで常時表示する。
- Google Photorealistic 3D Tilesを衝突判定の真値にする。
- YOLOだけで道路幅を確定する。
- CARLAのような高負荷な完全自動運転研究環境を標準にする。
- 実車制御に使える安全保証を主張する。

## Risk Register

- PLATEAUカバー外では建物高さの信頼度が落ちる。
- OSM道路幅は未入力が多く、YOLO/SV/手動補正が必要。
- Google系APIはキー、課金、利用規約、リファラ制限に依存する。
- Street View画像は撮影時期が古い場合がある。
- YOLO検出は道路幅の直接測量ではないため、誤採用を防ぐconfidence管理が必要。
- ノートPCではPhotorealistic 3Dとリアルタイム解析の同時実行は重い。
- 交差点、私道、工事中、駐車車両、電線はデータセットだけでは拾いきれない。
