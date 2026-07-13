# L4SIM 作業ログ（毎作業ごとに追記: やったこと / 次やること）

## 2026-07-10 (45) simulatePathPosesの停止テール修正 + puppeteer no-sandbox対応(batch2件)
### やったこと
- `src/core/physics.js:simulatePathPoses()` に停止テール対策を追加。`speedLimitAtM` が
  ハード停止(0)を返す区間でv=0のままwaypointsが残ると、従来はmaxSteps(=3000秒相当)まで
  空回りし「同位置・simTime≈3000s」の凍結ポーズを最後にpushしていた（再生側がその3000秒を
  再生し続け「止まったまま動かない」ように見える）。
- 直近5秒間(`noProgressWindowSteps`個のstep)でtraveledDistanceの増分が0.05m未満ならループを
  break するよう変更。break時は最終ポーズを必ずpushし、`halted: true` / `haltReason: 'no_progress'`
  を非破壊で付与（既存フィールド・poses配列の形は変えない。呼び出し側の後方互換を維持）。
  正常完走時（waypoints.length===0で通常break）は従来どおり変化なし。
- 検証中、実際の最終進入(目的地手前0.5〜1.0m・v<0.2で強制v=0になる既存ロジック)で本物のデッドロックが
  複数の合成ルート(直線・カーブ)で再現することを確認 — 今回の修正はこの既存の停止テール問題も
  正しく検出・打ち切りできている（副次的に有用）。
- `src/batch/run_l4_route_regression.js` / `src/batch/run_l4_scenario_matrix.js` の
  `puppeteer.launch({ headless: true })` に、`run_index3d_smoke.js` と同じ方式で
  `PUPPETEER_NO_SANDBOX === '1'` のとき `--no-sandbox --disable-setuid-sandbox` を渡すよう追加
  （AppArmor制限環境でChromeが起動できない問題への対応）。
### 検証
- `node --check src/core/physics.js src/batch/run_l4_route_regression.js src/batch/run_l4_scenario_matrix.js`: OK
- `node src/batch/run_sim_repro.js`: ALL PASS（determinism/replay/jitter/dt-halving 4項目）
- `node src/batch/run_safety_check.js`: ALL PASS
### 残り
- なし（今回の2件のスコープは完了）。停止テールの根本原因である目的地手前デッドロック自体
  （dist 0.5〜1.0mでv<0.2だと強制v=0固定になり進めなくなる既存ロジック）は未修正。今回は
  「打ち切って再生を止める」対策のみ。根治するなら目的地到達判定の距離閾値/速度閾値の見直しが必要。

## 2026-07-09 (44) 予測STOPの即MRM化をやめ、物理再生の二重減速を修正
### やったこと
- 接触0・Safety OKでも、plannerの `STOP` / `forwardClearanceM=0` だけでMRM停止していたため、
  地上物/幅不足の予測STOPは `MONITORED_CRAWL` / `ROAD_EDGE_CRAWL` として監視徐行に変更。
- 低クリアランスの頭上障害物はハード停止のまま維持。
- Safety Monitorにはハード停止時だけ `forwardClearanceM` を渡し、予測値だけでMRMにしないように変更。
- `simulatePathPoses()` で速度制限済みの物理時系列に、再生ループでも速度係数を掛けていた二重減速を修正。
- 下パネル/ライブメトリクスも、サンプルの `STOP` ではなく実際の再生制限モードを表示するように変更。
### 検証
- `node --check src/ui/map3dThree.js`: OK
- `node src/batch/run_safety_check.js`: ALL PASS
- `PUPPETEER_NO_SANDBOX=1 LOGISTICS_INDEX3D_URL=http://127.0.0.1:8080/index3D_V2.0.html npm --prefix src/batch run index3d:smoke:phase7`: OK
- ブラウザデモ再生: 6秒で `progressM=22.7m` / `currentMode=SLOW` / safety `OK`。
### 残り
- `phase7-playback` の人工地上障害物回避は、回避軌道中にfixtureへ接触してMRMになるケースが残る。
  ユーザー実地点の「接触0なのに止まる」問題とは別に、回避軌道生成を後続で改善する。

## 2026-07-09 (43) 3D再生軌道の斜め飛び修正
### やったこと
- (42) の再生用 `buildTrajectoryPlanFromSelection()` 接続で、`selectedRoadRoute` を優先したため、
  確定ルートではない粗い選択線を再解釈して斜めに飛ぶ経路が発生した。
- 3D再生では候補再採点をやめ、確定済み `state.simRoute` のみを
  `normalizeRouteForVehicle()` で丸める方式へ変更。
- ライブ診断の `drivePlaybackRouteSource` は `trajectory-planner` ではなく `route-normalizer` になる。
### 検証
- `node --check src/ui/map3dThree.js`: OK
- `node src/batch/run_safety_check.js`: ALL PASS
- `PUPPETEER_NO_SANDBOX=1 LOGISTICS_INDEX3D_URL=http://127.0.0.1:8080/index3D_V2.0.html npm --prefix src/batch run index3d:smoke:phase7`: OK
- ブラウザデモ再生: `drivePlaybackRouteSource=route-normalizer` / safety `OK`。
### 残り
- まだ個別地点でMRMになる場合は、斜め飛びではなく `forwardClearanceM` / 建物接触 / 幅余裕の問題として別途潰す。

## 2026-07-09 (42) 3D再生の中心線追従を車両軌道化
### やったこと
- 3D再生時だけ `state.simRoute` をそのまま物理追従していたため、交差点で中心線の折れ点に突っ込み
  「操舵限界/SLOWで止まりがち」に見える問題を修正。
- `map3dThree.playThree3D()` で再生直前に `buildTrajectoryPlanFromSelection()` を通し、
  既存の車両向けアーク/外振り候補を物理シミュレーションの入力に使うようにした。
- ライブ診断に `drivePlaybackRouteSource` / `drivePlaybackRouteMetrics` を追加し、
  `window.index3DGetAutonomyDriveMetrics()` から確認できるようにした。
- `simulatePathPoses()` の操舵角追従遅れで速度を固定 `0.3m/s` まで落とす処理をやめ、
  安全停止は上位の監視に任せつつ、操舵中は段階的減速へ変更。
### 検証
- `node --check src/ui/map3dThree.js`: OK
- `node --check src/core/physics.js`: OK
- `node --check src/index3dMain.js`: OK
- 合成直角ルートで、3点入力が53点のアーク付き経路へ変換されることを確認。
- ブラウザデモ再生:
  `drivePlaybackRouteSource=trajectory-planner` / `STOP=0` / `steeringSaturationCount=0`
  / safety `OK`。
- `node src/batch/run_safety_check.js`: ALL PASS
- `PUPPETEER_NO_SANDBOX=1 LOGISTICS_INDEX3D_URL=http://127.0.0.1:8080/index3D_V2.0.html npm --prefix src/batch run index3d:smoke:phase7`: OK
### 残り
- 個別地点でまだ低速が強い場合は、`window.index3DGetAutonomyDriveMetrics()` の
  `currentSample.widthMarginM` / `curveSwingM` / `forwardClearanceM` / `drivePlaybackRouteMetrics`
  を見て、幅推定・建物面・交差点キャップのどれが詰まっているかを分ける。

## 2026-07-09 (41) 交差点中心線折れによるSATURATED停止の緩和
### やったこと
- 実道路面には交差点キャップが足されているのに、plannerの旋回半径判定だけ中心線の直角折れを
  そのまま見て `SATURATED` 極低速になる問題を修正。
- 交差点キャップ圏内では `effectivePathRadiusM` を車両最小旋回半径/キャップ半径で補正し、
  `turnRadiusDeficitM` と `steeringRatio` の過剰判定を抑制。
- 直進サンプル（曲率∞）まで最小旋回半径へ丸めて偽 `curveSwingM=3m` を作るバグも修正。
- `getAutonomyDriveMetrics()` の currentSample に
  `effectivePathRadiusM` / `intersectionRelaxed` / `intersectionCapRadiusM` / `intersectionCapDistanceM` を追加。
### 検証
- `node --check src/sim/autonomy/behaviorPlanner.js`: OK
- `node --check src/ui/map3dThree.js`: OK
- `node src/batch/run_safety_check.js`: ALL PASS
- ブラウザデモ確認:
  `STOP=0` / `SATURATED=0` / `steeringSaturationRatio=0` / `intersectionRelaxed=9 samples`。
- `PUPPETEER_NO_SANDBOX=1 LOGISTICS_INDEX3D_URL=http://127.0.0.1:8080/index3D_V2.0.html npm --prefix src/batch run index3d:smoke:phase7`: OK
### 残り
- 個別地点でまだ低速が強い場合は、currentSampleの `widthMarginM` / `curveSwingM` / `intersectionRelaxed`
  を見て、幅推定側か道路面キャップ側を追加で詰める。

## 2026-07-09 (40) PLATEAU 3D Tiles 高さ自動接地
### やったこと
- PLATEAUの高さ補正を固定 `-3.5m` から、自動接地 + 手動微調整へ変更。
  `window.PLATEAU_GROUND_ALIGN=true` を既定にし、`PLATEAU_Y_OFFSET` は接地後の微調整値にした。
- `Box3.setFromObject()` のbbox角変換ではECEF軸bboxが過大になり、Y方向がキロメートル級に膨らむため、
  実頂点をワールド変換して `minY/maxY` を測る方式に変更。
- PLATEAU読み込み直後に短時間だけ `update/render` を回し、再生前の静止表示でも接地補正が入るようにした。
- PLATEAUメトリクスに `autoGroundAlign` / `baseMinY` / `autoShiftM` / `appliedYOffsetM`
  / `rawHeightM` / `vertexSampleCount` を追加。
### 検証
- `node --check src/3d/plateauTiles.js`: OK
- `node --check src/ui/map3dThree.js`: OK
- `node --check src/index3dMain.js`: OK
- ブラウザ静止状態のデモでPLATEAU接地を確認。
  `baseMinY=-3.53m` / `autoShiftM=+3.53m` / `appliedYOffsetM=+3.53m` / `sampled=true`。
- `PUPPETEER_NO_SANDBOX=1 LOGISTICS_INDEX3D_URL=http://127.0.0.1:8080/index3D_V2.0.html npm --prefix src/batch run index3d:smoke:phase7`: OK
### 残り
- 地域ごとに微妙な地盤差が残る場合は、画面の「PLATEAU高さ微調整」で±0.5m単位で合わせる。

## 2026-07-09 (39) 推定上空障害物による偽MRM停止の抑制
### やったこと
- YOLO/StreetView由来の `height` / `h` プロキシ値を、実測タグではなく `estimated` 高さとして扱うように変更。
  `clearanceHeight` / `maxheight` / 明示confirmed系だけを強制停止に使う。
- `buildCollisionSolidSet()` に `clearanceReliable` を追加し、推定だけの頭上障害物は
  autonomy planner の前方ブロッカー、3D衝突チェック、低クリアランスNGから除外。
- 事前 feasibility 側も同じ高さパーサと信頼度判定へ揃え、3D再生前だけNGになるズレを防止。
- クリアランスパネルに `ADVISORY` と推定警告数を追加。
  推定低クリアランスは黄色表示に残すが、MRM停止理由にはしない。
### 検証
- `node --check src/3d/clearanceSolids.js src/sim/autonomy/behaviorPlanner.js src/ui/map3dThree.js src/core/feasibility.js src/index3dMain.js src/batch/run_safety_check.js`: OK
- `node src/batch/run_safety_check.js`: ALL PASS
  - 推定上空物: `ADVISORY` / hard NGなし
  - 明示 `clearanceHeight`: `NG` 維持
- `PUPPETEER_NO_SANDBOX=1 LOGISTICS_INDEX3D_URL=http://127.0.0.1:8080/index3D_V2.0.html npm --prefix src/batch run index3d:smoke:phase7`: OK
- ブラウザ上の追加確認:
  - 経路上の `source:yolo heightOnly height:2.0` は `blockerCount=0` / `stopEventCount=0`
  - 同位置の `clearanceHeight:2.0` は `blockerCount=1` / `stopEventCount=7`
### 残り
- まだ残る偽停止は `widthMarginM` / `curveSwingM` 側の過剰保守か、物理障害物denyの位置ズレを個別ログで潰す。

## 2026-07-09 (38) YOLO要素学習環境の追加
### やったこと
- 道路面マスク学習とは別系統で、航空写真/標準地図から読める要素を箱/多角形ラベル化する
  `road_seg/dataset_yolo` 管理を追加。
  既存クラスは私道/構内通路、駐車場走行面、樹木/植栽、電柱/支柱候補、ガードレール/フェンス、
  壁/縁石/段差、門/ボラード、搬入口/荷捌き、その他障害物。
  既存ラベルIDを壊さないため、普通の車道と歩道は末尾クラスとして追加。
- `road_seg/yolo_annotate.html` と FastAPI `/yolo/ui` `/yolo/fetch` `/yolo/save`
  `/yolo/update` `/yolo/export_tiles` `/yolo/next_unreviewed` `/yolo/stats` `/yolo/classes` を追加。
  GSI航空写真/オルソ/標準地図を取得し、ブラウザで箱または多角形を描いてYOLO形式ラベルへ保存できる。
- 地図範囲のXYZタイルを最大100枚まで一括出力でき、未修正タイルを1枚ずつ開いてレビュー保存できる導線を追加。
  初期は20〜30タイル程度を人間が直して一度学習し、足りないクラスだけ追加する運用に合わせた。
- 手作業初期負荷を下げるため、UIのタイル出力は 10/20/30/50/100 枚選択式、既定20枚に変更。
- 一括出力しただけの未修正タイルは学習から除外し、reviewed保存されたタイルだけ train/val split に入れるよう変更。
- `dataset_yolo/source/labels` にYOLO detectラベル、`labels_segment` にYOLO-seg多角形ラベルを同時出力。
  箱だけ描いた場合もsegment側では矩形ポリゴンとして使える。
- 学習後の検出導線として `/yolo/model_status` `/yolo/predict` と UIの「学習済み検出」を追加。
  `road_seg/models_yolo/**/weights/best.pt` を使い、開いているタイルに推論結果を下書き追加できる。
- `road_seg/train_yolo.py` を追加。
  `dataset_yolo/source` を train/val split へ整形し、Ultralytics YOLOで detect/segment 学習する任意バックエンド。
  既定は `segment` / `yolo11n-seg.pt`。
  学習結果は `road_seg/models_yolo/` に隔離。
- `road_seg.menu` に 8) YOLOラベル作成、9) YOLO学習を追加。
  `PYENV_VERSION=fa-env python -m road_seg.menu` から起動できる。
- `road_seg/README.md` と `requirements-yolo.txt` にYOLO学習手順を追加。
### 検証
- `PYENV_VERSION=fa-env python -m py_compile road_seg/yolo_dataset.py road_seg/train_yolo.py road_seg/server.py road_seg/menu.py road_seg/smoke.py`: OK
- `PYENV_VERSION=fa-env python -m road_seg.yolo_dataset`: OK（空dataset統計表示）
- `PYENV_VERSION=fa-env python - <<'PY' ... _load_ultralytics() ...`: OK（Ultralytics 8.3.0検出）
- `PYENV_VERSION=fa-env python -m road_seg.smoke`: PASS
  `/yolo/fetch` `/yolo/save` `/yolo/export_tiles` `/yolo/next_unreviewed` `/yolo/update`
  `/yolo/model_status` `prepare_split(segment)` も in-process で検証。
- `printf '7\n\n0\n' | PYENV_VERSION=fa-env python -m road_seg.menu`: OK
  8) YOLOラベル作成 / 9) YOLO学習の表示と統計出力を確認。
- `node` で `road_seg/yolo_annotate.html` のインラインJS構文チェック: OK
- `curl http://127.0.0.1:8012/health`: OK
- `curl http://127.0.0.1:8012/yolo/ui`: OK（HTML取得）
### 残り
- 本体判定へYOLO結果を採用するか、どのYOLO実装/ライセンスで商用配布するかは別判断。
- 学習後に検出結果を `maskEdits.deny` / obstacle layer へ変換する推論アダプタを追加する。

## 2026-07-09 (37) 道路面逸脱の停止を警告化
### やったこと
- `src/sim/safetyMonitor.js` に `roadSurfaceMode: 'advisory'` を追加。
  既定は従来通り `mrm` のまま、index3D の実走だけ道路面逸脱を warning 記録に落とす。
- `src/ui/map3dThree.js` の Safety Monitor 呼び出しで
  `roadOutsideRatio=0.25` / `roadOutsideAreaM2=4.0` 超を記録するが、MRM停止にはしないよう変更。
- K-turn 事前検証も道路帯内チェックではなく、建物/障害物接触を不可条件に変更。
  読み込んだ道路面から外れるだけなら候補を棄却せず、衝突する候補だけ弾く。
- `sample.blockerId` の無い STOP（道幅/道路面由来）は `ROAD_EDGE_CRAWL` として徐行継続。
  建物/障害物 blocker がある STOP は従来通り復旧または MRM 対象。
- `run_safety_check.js` に road_surface advisory の回帰テストを追加。
### 検証
- `node --check src/sim/safetyMonitor.js`: OK
- `node --check src/ui/map3dThree.js`: OK
- `node --check src/batch/run_safety_check.js`: OK
- `node --check src/batch/run_index3d_smoke.js`: OK
- `node src/batch/run_safety_check.js`: ALL PASS
- `PUPPETEER_NO_SANDBOX=1 LOGISTICS_INDEX3D_URL=http://127.0.0.1:8080/index3D_V2.0.html npm --prefix src/batch run index3d:smoke`: OK
- `PUPPETEER_NO_SANDBOX=1 LOGISTICS_INDEX3D_URL=http://127.0.0.1:8080/index3D_V2.0.html npm --prefix src/batch run index3d:smoke:phase7`: OK
- K-turn 代表スポット（world `75cce456`, 2t_flat）:
  - `gsi-46752-11784-i-2764`: PASS / firstViolationなし / pageErrors 0
  - `gsi-46755-11784-i-6267`: PASS / firstViolationなし / pageErrors 0
### 残り
- 道路面外の警告は trace に残るだけなので、HUD上で「道路外警告」として見せるかは別途判断。

## 2026-07-09 (36) K-turn/切り返し再生の安定化
### やったこと
- `src/ui/map3dThree.js` の K-turn 再生を修正。
  - 切り返し済み判定を単一キーだけでなく、開始点〜復帰点+余白の zone として保持し、
    同一コーナー周辺での即時再発火を抑制。
  - K-turn pose 列の終端へ実際の復帰点を追加し、完了フレームの位置飛びを抑制。
  - K-turn 再生中は pose 側の heading/steer/reverse をそのままレンダーへ渡し、
    `lastTruckPos` 由来の移動ベクトル heading が混ざらないよう `forcePoseHeading` を追加。
  - 完了時は `resumeStationM` へ `progressM` / `driveTimeS` / `lastTruckPos` を同期し、
    通常走行への復帰直後に同じ切り返しへ戻らないようにした。
- `src/batch/run_index3d_smoke.js` に `PUPPETEER_NO_SANDBOX=1` の時だけ
  Chrome `--no-sandbox --disable-setuid-sandbox` を付ける検証用オプションを追加。
  Ubuntu/AppArmor 系環境で Puppeteer smoke を走らせるため。
- Claude Sonnet への委譲は実行したが、CLI が古い Windows 一時パス参照で停止したため、
  差分を監督側で確認しながら手実装した。
### 検証
- `node --check src/ui/map3dThree.js`: OK
- `node --check src/sim/autonomy/behaviorPlanner.js`: OK（Planner は未変更）
- `node --check src/batch/run_index3d_smoke.js`: OK
- `PUPPETEER_NO_SANDBOX=1 LOGISTICS_INDEX3D_URL=http://127.0.0.1:8080/index3D_V2.0.html npm --prefix src/batch run index3d:smoke`: OK
- `PUPPETEER_NO_SANDBOX=1 LOGISTICS_INDEX3D_URL=http://127.0.0.1:8080/index3D_V2.0.html npm --prefix src/batch run index3d:smoke:phase7`: OK
- K-turn 代表スポット（world `75cce456`, 2t_flat）:
  - `gsi-46752-11784-i-2764`: PASS / firstViolationなし / pageErrors 0
  - `gsi-46755-11784-i-6267`: MRM_OK `switchback_infeasible` / firstViolationなし / pageErrors 0
### 残り
- `index3DRunPhase7PlaybackValidation` は既存の22秒タイムアウト内に復旧地点まで到達せず timeout。
  計画検証は RESOLVED なので、今回の K-turn 修正とは別に playback smoke の速度/timeout を見直す。

## 2026-07-08 (35) road_seg DeepLabV3+差し替え口
### やったこと
- `road_seg/model_factory.py` を追加し、`segmentation_models_pytorch` の U-Net / DeepLabV3+ 生成を共通化。
- `train_mixed.py` / `train_weak.py` / `train.py` に `--arch unet|deeplabv3plus` を追加。
  既存 `road_unet.pt` パスは維持し、`road_unet.json` の `arch` を `infer.py` が読んで推論時に同じ構造を復元する。
- メニューの学習項目からモデルを選べるようにした。既定入力は現行優位の `unet` のままにし、
  DeepLabV3+ は明示選択で試す。
- `road_seg/compare_models.py` を追加。teacher route の site0008/site0019 で threshold / U-Net / DeepLabV3+ を同条件比較し、
  summary JSON と overlay sheet を出力できるようにした。
- README / PROCEDURES / requirements コメントを U-Net 固定表記から U-Net / DeepLabV3+ 対応へ更新。
### 検証
- `PYENV_VERSION=fa-env python -m pip install segmentation-models-pytorch==0.5.0`: OK（既存torchは変更なし）
- `PYENV_VERSION=fa-env python -m py_compile road_seg/model_factory.py road_seg/train.py road_seg/train_weak.py road_seg/train_mixed.py road_seg/infer.py road_seg/menu.py road_seg/segmenter.py road_seg/compare_models.py`: OK
- `PYENV_VERSION=fa-env python -m road_seg.train_mixed --help`: OK
- `PYENV_VERSION=fa-env python -m road_seg.train --help`: OK
- `PYENV_VERSION=fa-env python -m road_seg.train_weak --help`: OK
- DeepLabV3+ 煙突学習:
  `PYENV_VERSION=fa-env python -m road_seg.train_mixed --arch deeplabv3plus --epochs 1 --img-size 128 --batch 4 --manual-repeat 1 --weak-limit 8 --resume none --no-backup --out /tmp/road_deeplabv3plus_smoke.pt`: OK。
  `infer.get_predict_fn('/tmp/road_deeplabv3plus_smoke.pt')` で `(768,1024)` bool mask を返すことを確認。
- DeepLabV3+ 弱教師25epoch:
  `PYENV_VERSION=fa-env python -m road_seg.train_weak --arch deeplabv3plus --epochs 25 --img-size 384 --batch 4 --out road_seg/models/road_deeplabv3plus_weak.pt`: best val **0.3966**。
  既存U-Netは `road_seg/models/road_unet.json` 上 **0.3094** なので、lossだけではU-Net優位。
- 実画像比較:
  `PYENV_VERSION=fa-env python -m road_seg.compare_models --sites site0008,site0019`: OK。
  `road_seg/.compare_deeplab/summary.json` と overlay sheet を生成。
  - site0008: U-Net raw 0.1760 / eff 0.0042 / width 5.75m、DeepLab raw 0.1872 / eff 0.0025 / width 3.42m。
  - site0019: U-Net raw 0.4941 / eff 0.0115 / width 10.22m、DeepLab raw 0.4596 / eff 0.0077 / width 9.73m。
  目視では DeepLabV3+ は site0019 の過検出を少し削るが、草地発火はまだ大きく、site0008 は道路が痩せる傾向。
### 次やること
- 現時点では `road_deeplabv3plus_weak.pt` を既定 `road_unet.pt` に昇格しない。
  先に施設/駐車場/私道の手動ラベルを増やし、`train_mixed --arch deeplabv3plus` と `--arch unet` を同条件で比較する。

## 2026-07-07 (34) road_seg ラベルUI操作性改善
### やったこと
- `annotate.html` に直線ツールを追加。ドラッグした2点間へブラシ太さの道路面を一発で追加できる。
- 既存道幅編集を追加。`/annotate/fetch` がRDCL中心線をピクセル座標付きで返し、
  UIで中心線をクリック→道幅m入力→古い帯を消して指定幅で塗り直す。
- 編集キャンバスの拡大/縮小/100%ボタンと Ctrl+ホイールズームを追加。
- 保存metaに `roadWidthEdits` を入れ、どの既存道路幅を何mに直したか追跡できるようにした。
### 検証
- `python -m py_compile road_seg/server.py road_seg/rdcl.py`: OK
- `python -m road_seg.smoke`: PASS
- `python -m road_seg.selfcheck`: 11/11 PASS
- Puppeteerで `/annotate/ui` を開き、直線/幅編集/ズーム操作を実行。page error 0。

## 2026-07-07 (33) road_seg 手動修正→混合学習ループ
### やったこと
- `道路幅AI検証.bat` の実体である `road_seg.menu` を整理し、メニューを
  動作確認 / GSI幅テスト / APIサーバ / 道路ラベル作成 / 混合学習 / 手動のみ学習 / 統計に再構成。
- `road_seg/annotate.html` を実用UIに差し替え。国土地理院 `seamlessphoto` を表示し、
  既定下書きは `experimental_rdcl` の道路中心線+幅員ランク。ブラシで道路面を塗る/消す、
  保存で `road_seg/dataset/images` + `masks` へ強教師データ化する。
- `road_seg/train_mixed.py` を追加。手動修正マスクを強教師、`dataset_weak` を補助弱教師として
  混合学習する。既定は手動データ8倍重み、既存 `road_unet.pt` があればバックアップして継続学習。
- `dataset.stats()` を拡張し、手動件数・弱教師件数・モデルmetaを `/annotate/stats` とメニューから確認可能にした。
- selfcheck に混合学習マニフェスト検証を追加。
### 次やること
- 実際に施設/駐車場/私道ラベルを数十〜数百件保存し、`train_mixed --epochs 30 --manual-repeat 8` で再学習。
- 再学習後、site0019の道路面allow注入E2EでFNが消えるか確認。

## 2026-07-07 (32) 航空写真→走行面 学習済みモデル完成（手動ラベルゼロ）+ 端到端実証
### やったこと（ユーザー要望「衛星から道を生成」を実装・実証）
- **FN真因を実画像で確定**: site0008(密集市街)=rdclは細街路まで取得済→FNはスナップ問題。
  site0019(施設)=実車進入は駐車場/私道でrdcl(公道)に無い→**航空写真でしか取れない走行面**。
- **弱教師学習を実装**（`road_seg/gen_weak_dataset.py` + `train_weak.py`）:
  rdcl道路=正 / OSM建物+植生(色検出)=負 / その他=無視 の3値ラベルを世界から自動生成。
  **マスク損失**(無視領域は損失外)で駐車場をテクスチャ発火させる設計。8 world→103タイル。
  smp U-Net(resnet34) を学習: val 1.13→**0.31**。models/road_unet.pt(infer/surface互換)。
- **実画像で実証**: threshold maskFrac 0.90(全面ゴミ)→ **site0008 0.18 / site0019 0.49**。
  密集市街は道路グリッド+幅を的確に捕捉し建物除外。施設は駐車場/道路を捕捉、
  濃い樹木除外(薄い草地は残過検出=弱ラベル限界)。
- **端到端実証**: `run_surface_pipeline(backend=pretrained)` で site0019 から
  **走行面ポリゴン311個**を生成。roadBufferM=30クリップで生117万px→有効37万px
  （遠方の草地過検出は除去、道路近傍の駐車場/私道のみ残る）。
  = 「航空写真→学習モデル→走行面GeoJSON→maskEdits.allow→世界」の全連鎖が稼働。
- segmentation-models-pytorch 0.5.0 導入（torch 2.11既存）。
### 次やること
- [ ] site0019 world に走行面allowを注入→FN実走で消えるかブラウザ確認（最終E2E）
- [ ] 精度上げ: annotate ツールで施設/駐車場の検証ラベルを数百追加 or 推論threshold調整
- [ ] スナップ由来FN(site0008型)は較正②車格対応スナップで別途対処

## 2026-07-07 (31) road_seg道路面補強 — 航空写真マスクをallowへ注入
### やったこと
- `road_seg/surface.py` を追加。航空写真セグメンテーションマスクを、入力道路中心線近傍だけに制限し、
  小さなGeoJSON Polygon群へ変換する処理を実装。過剰な遠方誤検出を避けるため `roadBufferM` で corridor 制限する。
- `road_seg.server` に `/segment_road_surface` を追加。`/segment_road_width` は既存のまま、道路面補強用の
  `FeatureCollection` を別APIとして返す。
- `src/3d/roadSegClient.js` に `fetchAerialRoadSurface` / `applyAerialRoadSurface` /
  `clearAerialRoadSurface` を追加。`maskEdits.allow` に `source=road_seg_surface` として入れ、
  手修正allow/denyとは分離。
- `index3D_V2.0.html` の道路幅セクションに「航空写真で道路面補強」「補強を解除」ボタンを追加。
  `window.roadSegSurfaceApply()` / `window.roadSegSurfaceClear()` でも実行可能。
- 学習済み `road_seg/models/road_unet.pt` が存在する運用に合わせ、道路面補強の既定backendを
  `pretrained` 優先に変更。幅推定 `/segment_road_width` は従来どおり `threshold` 既定のまま。
- 経路変更時は `road_seg_surface` 由来のallowだけクリアし、古い補強が別ルートへ残らないようにした。

### 検証
- `python -m road_seg.selfcheck`: 10/10 PASS（surface mask -> GeoJSON allow polygons 追加）。
- `python -m road_seg.smoke`: PASS（`/segment_road_surface threshold -> features=12 cells=64`）。
- `infer.available()`: True。`/segment_road_surface backend=pretrained` の合成確認で
  `segmenter=pretrained`、FeatureCollection返却を確認。
- `node --check src/3d/roadSegClient.js src/index3dMain.js`: OK。

### 次やること
- road_segサーバ起動状態で実ワールドを読み込み、ボタン操作→道路面/判定/Safetyの変化をブラウザE2Eで確認する。
- annotateで貯めた道路面教師データを使い、thresholdではなくpretrained backendで道路面補強精度を比較する。

## 2026-07-05 (30) 3D表示の整理 — 道路/建物の見え方改善
### やったこと
- 道路面の初期表示を、検証レイヤ風の薄い青から衛星画像上で読みやすい暗めの道路帯へ変更。
  標準表示では生道路線・歩道・交差点拡幅リングをOFFにし、道路面/道路端/中心線/経路を主表示に整理。
- OSM建物の表示を改善: `EdgesGeometry` による三角分割ワイヤー表示を廃止し、
  屋根外周・底面外周・縦エッジだけを描く独自アウトラインへ変更。建物は半透明すぎない
  ソリッド寄りの塗り/屋根に調整。
- 変更は表示レイヤのみ。道路面 `roadUnion`、建物GeoJSON、Safety Monitor、衝突判定の入力は変更なし。
- 検証: `node --check` OK。Puppeteer+SwiftShaderで `world_b610332c` を読み込み、
  page error 0、roads=57/buildings=35/worldLoaded=true、スクリーンショット
  `runtime/l4_regression/visual_3d_roads_buildings.png` を保存。PNG非空確認済み。
- 追加検証: desktop標準/デバッグ/基本 × 東京`b610332c`・長崎`d169ef7c`、mobile標準 × 東京を
  Puppeteerで確認。page error 0、標準プリセットでは road/sidewalk/intersectionCap が非表示、
  debugでは全表示に切替わることをシーン内tag数で確認。スクリーンショットは
  `runtime/l4_regression/visual_checks/` に保存。
- 走行スモーク: 東京`b610332c`の広幅代表 `gsi-50313-12843-i-1294` を2tでブラウザ実走し
  **PASS**（159/159m、ticks=2038、firstViolation=null、pageErrors 0）。表示変更でSafety/再生が
  退行していないことを確認。
- 追加深掘り検証:
  - プリセット操作: 標準→debug→basic→標準をブラウザで切替。標準は raw road line非表示、
    debugは表示、basicは centerline/roadEdge 非表示をシーンtag数で確認。
  - スライダー操作: 道路面0.42、建物塗り0.90、屋根0.86、輪郭0.20へ変更し、
    Three.js materialへ即時反映されることを確認。
  - 再描画リーク: `renderSceneThree` 5回、プリセット6回切替、東京→長崎→東京world切替で
    road/building/truck/ground等のオブジェクト数が重複増加しないことを確認。長崎では建物0へクリア、
    東京へ戻すと建物105オブジェクトへ一度だけ復帰。
  - 追加実走3本: 東京広幅`i-1294` PASS、長崎狭急折れ`i-6267` MRM_OK
    (`switchback_infeasible`)、長崎広幅直線`i-6674` PASS。全て firstViolation=null/pageErrors 0。
  - 成果物: `visual_interaction_check.json`、`visual_leak_check.json`、
    `visual_drive_multi.json`、スクショ `runtime/l4_regression/visual_checks/`。
### 次やること
- [ ] 実機タブでCtrl+F5後、必要なら標準/デバッグプリセットの好みを微調整。

## 2026-07-05 (29) クリーンチェーン3結果の分析＋cap-aware退行の根治
### やったこと（3つの結果を確定・分析）
- **教師320走行（クリーン, pageErrors 0）**: 強正例 site FN 11/20=**55%**
  （cap-aware前60%→微改善）。理由内訳: safety_invariant_violation 32 /
  switchback_infeasible 14 / planner_stop 10。
- **行列38走行: FAIL 4 に退行**（従来FAIL 0）。全て狭/急コーナーの road_surface_excursion。
- **本番較正（ヘッドレス32候補+refine8）**: baseline plannerFN **10%** → best **10%**。
  narrowWidth系パラメータをどう振っても改善せず＝**plannerゲートは既にほぼ最適**。
- **退行の根治**: cap-aware(26)が隅切りキャップ幅を**swingゲートにも**適用し、狭急コーナーで
  切り返し推奨を抑制→突っ込んでMonitor違反、が原因と特定。修正: **キャップは静的収まり
  (staticNarrow)だけに効かせ、swing保護は真の幅で守る**。ヘッドレス確認: 4 FAILセル中3つで
  切り返し推奨が復活（i-6267:4/i-2868:2/i-2595:4サンプル）。safety単体・repro ALL PASS維持。
- 追加修正: cap幅を「半径内なら一定加算」ではなく、道路面と同じ円キャップの**断面幅**
  `2*sqrt(r^2-d^2)`として評価。ノードから離れた地点でplannerだけが過大な幅を見る不整合を除去。
- 追加ブラウザ実測: 最新matrixの旧FAIL4件をスポット再実行し、全て **MRM_OK / firstViolationなし /
  pageErrors 0** へ復帰（i-2595/i-6267=`switchback_infeasible`、i-2868/i-6380=`planner_stop_unresolved`）。
  i-6267単体も `FAIL_MONITOR road_surface_excursion` → `MRM_OK switchback_infeasible` を確認。
- **戦略的発見（今回の最重要）**: 「plannerFN 10% vs ブラウザFN 55%」の**45pt差は
  planner由来ではない**。=較正でplannerを幾ら磨いてもFNは下がらない。真因は
  ①**世界モデルのコーナー幾何**（実車が使う隅切り・敷地余白を帯が持たない）
  ②**スナップ品質**（FN18サイト中8=44%がsnap>15m＝ジオコーディング/アプローチ疑い）。
  → **FN削減のレバーはplanner較正ではなく「世界モデル＋スナップQC」**と数値で確定。
### 次やること
- [ ] 行列ブラウザ再走で FAIL 4→0 復帰を確認（退行修正の確定）
- [ ] 較正②: 車格対応スナップ+snap>15m QCフラグ（false-FNの機械的除去）
- [ ] 世界モデル: 交差点隅切りキャップの拡充（planner/Monitor共有で整合を保ったまま）

## 2026-07-05 (28) チェーン結果無効化→クリーン一括再実行（教師+行列+本番較正）
### やったこと
- (26)起動のチェーン結果は**無効と判定**: pageErrors 95・runErrors 27・matrix FAIL 4は、
  チェーン実行中に(27)のRISK_TUNINGリファクタでブラウザ読込ファイルを編集した
  **新旧コード混在**によるアーティファクト（同種ミス3回目）。
- **恒久ルール化**: 「ブラウザ検証チェーン実行中は src/ を編集しない。必要なら
  TaskStopしてから」をメモリ（feedback_no_edit_during_chain）に登録。
- コード安定後のサニティ: 回帰2ルート 2/2 PASS・pageErrors 0 → 現行コードは健全。
- **クリーン一括チェーン起動**: 教師320走行 → 行列38走行 → 本番較正
  （--samples 32 --refine 8, ヘッドレス）を1本で実行中。完走まで src/ 凍結。
### 次やること
- [ ] チェーン完走: 教師FN率（隅切り対応の真の効果）/ 行列FAIL0維持 /
      較正ベスト候補 → ブラウザ二段確認 → 採用判断

## 2026-07-05 (27) フィジカルAI基盤 — ①自動較正 / ③RL環境（ヘッドレス化）
### やったこと
- **ヘッドレス実行基盤**（①③共通の前提工事）: `@turf/turf`+`polygon-clipping` を
  src/batch へ導入し globalThis 注入 → **behaviorPlanner がブラウザ無しで動作**。
  `src/batch/headlessPlanner.js`（world読込・planner評価・608ms/評価＝ブラウザ比~50倍）。
- **RISK_TUNING可変層**: 既定は凍結のまま `applyRiskTuning/getRiskTuning/resetRiskTuning`
  を追加（behaviorPlanner は getRiskTuning() 経由に変更・挙動不変）。
  ブラウザコンソールからの実験も可能に。
- **①自動較正ランナー** `src/batch/run_calibration.js`: 教師ルート×車種を
  ヘッドレス評価し、損失=強正例FN率+0.3×推定矛盾率+0.15×弱負例通過率で
  seed付きランダム探索+近傍refine。ベースライン実測: **plannerレベルFN 14%**
  （ブラウザ60%との差＝Monitor/K-turn由来と定量的に切り分けできた）。
  採用候補はブラウザ二段確認へ、の運用。
- **③RL環境** `src/sim/gymEnv.js`: gym互換 reset/step/reward/done/info。
  観測=進捗/速度/計画速度/モード/折れ角/勾配/スイング/幅余裕/前方距離/切り返し推奨、
  行動=離散4段（停止/徐行/計画/全速）、報酬=進捗−時間−計画超過、
  終了理由コード（GOAL/MRM_STOP_ZONE/MRM_SWITCHBACK_ZONE/TIMEOUT）+挙動trace付き。
  デモ `run_gym_demo.js` **4項目 ALL PASS**（計画追従で完走・同seed決定論・
  無謀方策の劣後・trace取得）。
- **②実車データ調査**: ULTra-AV（14ソース統合縦断軌跡・CAN）、nuScenes CAN bus
  expansion、comma2k19（33時間CAN/GPS）、OpenACC等を候補として記録
  （トラック特化の公開CANは希少→自社ドラレコ/デジタコが本命）。
- 較正ラベルバグ1件検出・修正（observedTruckClassesは数値型→builderの
  プリセット別ラベルリストを直接使用）。
- **②運動モデル同定パイプライン** : 汎用走行ログCSV
  (time/lat/lng[/speed/steer])から 実効ホイールベース(dψ/dt=v·tanδ/L回帰)・
  実測最小旋回半径・加減速実用上限(p95/p05)・ドライバー許容横加速度(p85) を同定。
  selfcheck: 既知パラメータの合成ログから L=4.19m(真値4.2)・加速0.79(真値0.8)を復元
  **ALL PASS**。公開データ(乗用車)で手法検証→自社デジタコ/ドラレコで即トラック化の器。

### 次やること
- [ ] 教師チェーン(cap-aware)完走→FN率推移確認 → 本番較正
      `node src/batch/run_calibration.js --samples 32` 実行 → ベスト候補をブラウザ二段確認
- [ ] 較正②車格対応スナップ／gymEnvの行動空間拡張（K-turn試行の選択など）
- [ ] 実車ログ（自社デジタコ/ドラレコ）確保の相談 → 運動モデル同定へ

## 2026-07-05 (26) 較正①実装 — plannerの幅ゲートを隅切りキャップ対応に
### やったこと
- FN分析の深掘りで真因を特定: **交差点隅切り（intersectionWidening）は既に実装済みで
  道路面(roadUnion)にも入っていた**。しかし planner の幅/スイングゲートは
  道路スカラー幅しか見ておらず、「面としては通れる旋回」を STOP/K-turn 推奨していた
  （面と判定の不整合）。
- **修正**: behaviorPlanner が `buildIntersectionWidening` のノードを参照し、
  キャップ圏内のサンプルは有効幅に `2×(capRadius−半車幅)` を加算して
  narrow/swing ゲートを評価（Monitor が検証する面と同じ前提で判断する）。
- 検証: 構文OK・safety単体8 ALL PASS・repro ALL PASS。
- 教師20サイト×4車種の再計測 + 行列回帰チェックをチェーン実行中
  （FN率60%からの改善幅と、行列FAIL 0維持を同時計測）。
### 次やること
- [ ] チェーン結果: FN率推移・行列悪化なしの確認
- [ ] 較正②: 車格対応スナップ（rank<3m路地への誤snap 3件の解消）
- [ ] 弱負例見直し12サイトの業務確認リスト化

## 2026-07-05 (25) 教師データ320走行・真の成績と較正方針
### やったこと
- 修正済みコードで全320走行完走（pageエラー0・実行エラー0）:
  - **強正例: OK 8 / FN 12サイト（FN率60%）**。ルート単位 FN59本。
  - 推定passable: OK14/矛盾10。**弱負例の見直し候補12サイト**（記録より大きい車格でも
    シミュ上通れた→業務確認で「実は入れる」なら正例昇格の価値）。
- FN原因分類: **switchback_infeasible 66% / planner停止 22% / 実逸脱 12%**。
- 幅ソース分析: FNサイトとOKサイトの行き先道路幅分布は**ほぼ同一**
  （FGD実測4〜6.5m級が両群に出現）→ 幅データ自体は概ね健全。
  **差はアプローチ途中のコーナー通過可否**＝現行ワールドは「道路帯のみ」で、
  実世界の交差点隅切り・敷地余白を持たないため、実車が使う旋回空間が足りない。
- 較正方針（優先順・次セッションの実装対象）:
  1. **交差点隅切りモデル**: グラフ交差点ノードに実在の隅切り相当の小ディスクを
     roadUnionへ追加（世界モデルの現実化。K-turn成功率が直接上がる）
  2. **車格対応スナップ**: 記録車格が通れない幅の道路へはsnapしない
     （FN 3件は rank<3m の路地にsnap→4t正例と矛盾。snap>15mはQCフラグ）
  3. K-turn探索の細分化（f/r/サイクル数の刻みを狭コーナー向けに追加）
### 次やること
- [ ] 上記1→2→3を実装し、同じ20サイトで再計測（FN率の推移で効果を定量化）
- [ ] 弱負例見直し12サイトのリストを業務確認へ（確定NG/実は可の振り分け）
- [ ] 残り375地点へ拡大（`--limit`解除）は較正が落ち着いてから

## 2026-07-04 (24) 教師データ320走行の「100%FN」はパイプラインバグと特定 → 根治・再実行
### やったこと
- 初回320走行の結果が **強正例FN率100%・FAIL_MONITOR 170件** という異常値
  → 「モデルが保守的」ではなく系統欠陥と判断してデバッグ:
  1. 実走JSONで `total=14,361m`（ビルダー出力は132.8m）という矛盾を発見。
  2. 単体再現: setRoute直後は132.8mで正常 → **play後に14,360mへ化ける**。
  3. `__index3d_lastState__` でsimRoute実座標をダンプ → simRouteは正しい、
     かつ**先頭点が重複**（builder出力 pts[0]==pts[1]）していると発見。
  4. 原因確定: **ゼロ長セグメントが物理ポーズ生成(simulatePathPoses)を発散**させ、
     132mのルートが14kmのポーズ経路になり、100m地点で道路帯逸脱→全滅していた。
- **修正**: `index3DSetRoute` に連続重複点(<5cm)の除去を実装（API境界での防御=
  今後どのルートソースから来ても効く）。実測: 13→9点・play後 total **127m** に正常化、
  site-0001 2t は status=OK で走行継続（violationなし）。
- 初回320走行の結果は**全て無効**として破棄。修正済みコードで全320走行を再実行中。
### 次やること
- [ ] 再実行完走 → 真のFN率と原因分布を集計 → 較正方針
- [ ] build_teacher_site_routes.js 側でも重複点を出さないよう修正（多重防御・任意）

## 2026-07-04 (23) 実搬入教師データ取込 — 地点→接続道路アプローチ→実走照合
### やったこと
- `教師データ.xlsx`（列: トラック結果/緯度/経度）を読み込む
  `src/batch/import_teacher_points.py` を追加。401行を検証し、重複地点統合後
  **395地点**へ変換（invalid 0）。内訳: 2t=67 / 3t=52 / 4t=276、10t正例は現Excelには無し。
- ラベル方針を明確化: 記録車格は強い正例、最大記録車格以下は推定passable、
  より大きい未記録車格は**弱い負例**（業務上の不可確認までは hard NG にしない）。
- `src/batch/build_teacher_site_routes.js` を追加。地点周辺worldを探す/必要ならcompileし、
  地点を最寄り道路へsnap、接続道路グラフから複数の進入アプローチを生成する。
- `src/batch/run_teacher_site_routes.js` を追加。生成ルートを `index3D_V2.0.html` で実走し、
  車種別に OBSERVED_POSITIVE / INFERRED_PASSABLE / WEAK_NEGATIVE と照合する。
  複数アプローチは地点×車種で「どれか1本PASSしたか」を集計。
- 実測 smoke: `teacher-site-0001` はworld `6c7c1c7b`、snap 10.51m、
  進入アプローチ4本を生成。2t正例は現モデルで false negative（FAIL_MONITOR）として
  レポート保存済み。これは教師データから検出された要レビューケース。
### 次やること
- [ ] まず20地点だけ `--compile --alternatives 4` で生成し、false negativeの原因を分類
      （実進入方向違い / world道路面不足 / planner停止漏れ / 幅データ誤差）。
- [ ] 業務上「大きい車格を配車しなかった理由」が不可で確定できる行だけ hard NG 化する。

## 2026-07-04 (22) 総仕上げ — 全検証グリーン（行列38 FAIL0・回帰16 FAIL0）
### やったこと
- **K-turn v2 コードでの総合検証を完走**:
  - シナリオ行列（新world・2t/10t×19セル=38走行）: **FAIL 0**
    （PASS 25 / 理由コード付きMRM_OK 13 / pageエラー0）。前回比 **悪化0**。
  - 代表16ルート回帰: **FAIL 0**（PASS 15 / MRM_OK 1=幅3m路への
    デフォルト車planner停止=正当）。
- チェーン中に1件だけ出た i-1281 の FAIL_INCOMPLETE は単発再現で **PASS(106/106m)**
  → 長時間チェーンでヘッドレスのrAFが4秒超飢餓になり「tick停滞=完了」判定が
  誤発火するハーネス問題と特定。**停滞即断はゴール圏内(進捗70%+)のみ、
  途中停滞は20秒猶予**に修正（l4RegressionLib）。
- オフライン系も全PASS維持: repro100回・安全単体8・compile selfcheck16・
  golden取込6・road_seg幾何9/9。
- 本日の成果一覧（ユーザー要望「徹底デバッグ・精度・UI/UX」への回答）:
  ①ソフト徐行の適格条件（10t退行解消） ②FGD広幅員30m級計測+サニティガード
  ③K-turn v2（帯内事前検証つき軌道生成・違反前の理由付き停止）
  ④走行インテリジェンスHUD ⑤ハーネス頑健化（飢餓耐性）
### 次やること
- [ ] 実搬入実績の収集開始（benchmarks/実績ルート入力.csv → 混同行列の計測へ）
- [ ] road_seg 教師データ収集（annotateツール）→ U-Net学習 → 幅ソース追加
- [ ] JARTIC/xROAD 無料API／厳密フルオフライン起動（後日）

## 2026-07-03 (21) K-turn v2 — 帯内事前検証つき軌道生成（「後退中に帯を割る」の根治）
### やったこと
- ユーザー実測レビュー確認: 停止は接触でなく道路帯逸脱（collision=0のまま
  road_surface_excursion/planner_stop_unresolved）。K-turn v1は発火するが
  **後退中に帯を割る**（10t i-6267: roadOutsideRatio=0.081, mode=RECOVER中にMRM）。
- **K-turn v2 実装**（map3dThree）: スクリプト補間を廃止し、
  - 自転車モデルでロック一杯の前進/後退アーク列を生成（f×r×サイクル数nの決定論探索）
  - **各ポーズの車体フットプリントを Safety Monitor と同一判定
    （evaluateSafetyInvariants）で事前検証** — 帯内に収まる軌道だけ実行
  - 収まる軌道が存在しないコーナーは**違反する前に** `switchback_infeasible` で安全停止
  - 出口整列は比例操舵の前進アーク（誤差15°以内・復帰点1.8m以内で完了判定）
  - 再生はポーズ列を低速1.6m/sで順送り（後退フラグ・操舵角付き、HUDにも反映）
- 実測: i-6267 → 探索の結果「帯内軌道なし」を事前判定し、
  **violationゼロのまま MRM_OK(switchback_infeasible)**（幾何解析どおり:
  3.66m帯で5.7m車の53°回頭は対角4.05m必要=不可能）。
- レビュー中にv2の復帰直後バグを検出・修正:
  - K-turn完了フレームで stale な `truckRenderHeading` が残り、復帰後に車体方位だけ斜めに
    なる問題を修正（完了フレームは経路方位へ同期）。
  - 終点12m猶予内のK-turn推奨は、Safety Monitorの始終点猶予と同じ設計判断で抑制。
  - 単体ブラウザ実測: `i-2764` は **PASS** 復帰、`i-6267` は
    **MRM_OK(switchback_infeasible)** 維持。両方 firstViolationなし / pageErrors 0。
- ユーザー追加の `window.index3DGetAutonomyReport()`（plannerサンプル閲覧）を確認・維持。
- 総合検証チェーン（新world行列32本+代表20ルート回帰）をv2コードで再実行中。
### 次やること
- [ ] チェーン完走 → 集計・report_l4_regression → 最終サマリ
- [x] K-turn可能なコーナー（i-2764等）がv2でもPASSを維持するか確認

## 2026-07-03 (20) 最後のFAILを原理的に解決 + HUD適用 + 一斉検証開始
### やったこと
- **行列結果（適格条件+K-turn込み）**: 32走行 PASS25/MRM_OK6/FAIL1/pageエラー0。
  2tは幅3m・勾配18%の坂も走破、10tの徐行退行は全てMRM_OKへ復帰。
- **最後のFAIL i-6267 を計測駆動で解決**（3段階のデバッグ）:
  1. plannerサンプルをブラウザ内で直接ダンプ → **turn53.2°/動的余裕1.15m**という
     「どのゲートにも掛からない完璧な隙間」と判明（60°未満・0.9m超）。
  2. 較正: スイング乗数下限1.0→1.5（実掃引の過小評価を補正）、K-turn条件②を50°へ
     → K-turn発火。しかし**旋回中に違反**: 3.66m帯で5.7m車を53°回す対角=4.05m>帯幅
     ＝幾何的に不可能（実世界はコーナー内側余白を使うが、ワールドは帯しか保証しない）。
  3. **原理的解決**: 切り返し試行中のMonitor違反は `switchback_infeasible` の
     理由コード付きMRMへ（「試みる→安全層が不可能を検出→安全停止」はL4として正しい）。
     実測: i-6267 → **MRM_OK(switchback_infeasible)**。
- **K-turn改良**: 復帰点を「曲がりが終わる地点」まで動的スキャン（複合ベンド対応）。
- **UI/UX: 走行インテリジェンスHUD適用**（map3dThree）: 3Dビュー右上に
  モード（巡航/徐行/停止/●色分け）・**↩切り返し中**・幅余裕・勾配・旋回振出・
  前方距離・Safety監視状態・進捗を常時表示（8Hz・遅延生成）。
- **一斉検証（オフライン系）全PASS**: repro100回・安全単体8・compile selfcheck全項目・
  golden取込6・road_seg幾何9/9。ブラウザ系（新world行列32＋代表20ルート回帰）を
  チェーン実行中 → 完走待ち。
### 次やること
- [ ] チェーン完走→report_l4_regression（悪化0の確認）→ 最終サマリ
- [x] PROCEDURESの実行例hashを新world（b610332c/d169ef7c/fb172e2f）へ更新

## 2026-07-03 (19) 精度強化週間① — ソフト徐行の適格条件 + FGD広幅員/サニティガード
### やったこと
- **(18)行列の部分結果分析**: 2tは切り返しで全PASS化（旧FAILの急折れ含む）。一方
  10tはソフト徐行が退行を生んだ（旧MRM_OK の狭幅カーブ6件へ徐行進入→逸脱violation）。
- **ソフト徐行の適格条件**（behaviorPlanner）: ①急折れ≥45°（K-turnで解決可能）
  ②スイング不足-0.4m以内（僅差） のみ徐行可。それ以外（10tの狭幅カーブ等）は
  従来どおり進入不可STOP=MRM_OK。→ 適格条件込みで行列クリーン再実行中。
- **FGD広幅員対応（精度②-C群24本）**: 探索上限をランク連動化
  `maxHalf=clamp(est×1.25,15,25)` → **全幅30m級の大通りが初めて計測可能に**
  （東京/丸の内でmax30.19m。旧上限15m半幅では物理的に不可能だった）。
- **FGDサニティガード新設**: rdclランクと矛盾する実測を棄却
  （上限=ランク×1.5+5m歩道許容／下限=車道2.0m・min×0.7）。途中2つの実装バグを
  selfcheckが検出→修正: ①Number(null)=0でランク上限なしがupper=0になる罠
  ②乗算1.7は狭路の正当な全幅(車道+両歩道)を誤棄却→加算許容へ。
  実測: 東京15本+棄却8／長崎151本+棄却43／丸の内27本+棄却11。
  **量は微減だが「19.5m+の大通りに8m」級の毒データ（誤NGの温床）を排除**＝判定品質は向上。
- 新world: 東京`b610332c`／長崎`d169ef7c`／丸の内`fb172e2f`（オフライン再現hash一致確認済み）。
- selfcheck 16項目 ALL PASS（広幅員計測・サニティガード7ケース追加）。
### 次やること
- [ ] 行列完走→report（2t全PASS維持・10t MRM_OK復帰・切り返しセルの確認）
- [ ] UI/UX: 走行インテリジェンスHUD適用（パッチ準備済み・行列完了後）
- [ ] 全ハーネス一斉検証→WORKLOG/ROADMAP最終更新

## 2026-07-03 (18) コーナー切り返し（K-turn v1）実装 — 「徐行しすぎ」への回答
### やったこと
- ユーザー指摘「徐行しすぎ／切り返して角度変えられないの？」に対応:
  - **物理的な整理**: 徐行しても掃引幅（スイング）は縮まない＝狭幅急コーナーの正解は
    「ゆっくり通す」ではなく「切り返しで角度を変える」or「進入しない」。
  - **K-turn v1 実装**: planner が `switchbackRecommended`（スイング超過∧折れ角45°以上）を
    サンプルに付与 → 3D再生が「手前で停止→後退しつつヘディングを出口方向へ補間→前進再進入」。
    既存recovery再生（停止→後退→復帰）を拡張（headingFrom/Mid/To の最短弧補間、
    lerpAngleRad追加、同一コーナー多重発火は10m量子化キーで抑止）。
    妥当性は従来どおり Safety Monitor が毎tick検証（無理なコーナーは正直にMRM）。
  - **徐行しすぎ是正**: curveSwingSoftCrawlFactor 0.18→0.35（切り返しが入ったので
    「徐行で無理に通す」前提が不要になった）。
- ソフト徐行のみの行列実走は、実行中にコード編集を跨ぎ新旧混在になったため停止し、
  切り返し込みでクリーン再実行中。
- 検証: 構文3/3 OK・run_safety_check 8項目 ALL PASS・run_sim_repro ALL PASS。
- 補足（ユーザー質問への回答）: index3D_V2.0.html は `src/index3dMain.js` をESMで
  読むため、**編集は同ページの再読み込みで反映される**（開きっぱなしタブはハードリロード推奨）。
### 次やること
- [ ] クリーン行列の結果確認: 切り返しが発火するセルの verdict（PASS化 or 正直MRM）、
      徐行0.35の体感、前回比 report
- [ ] 2t sharp i-6267 の再判定（切り返しで通るようになったか）
- [ ] K-turn v2 候補: 後退経路の帯内チェック（現在はMonitor事後検証のみ）、多段切り返し

## 2026-07-03 (17) Phase 4 行列 re-run — スイングゲート収束
### やったこと
- `behaviorPlanner.js` の終端方位計算を修正。終点付近で前方点が終点にクランプされ、直線終端が急カーブ扱いになる誤STOPを解消。
- 狭幅カーブのスイング係数を `RISK_TUNING.narrowWidth` へ集約。`Lf=WB+frontOverhang` に応じて係数を補間し、2tは過剰保守を避け、10tは狭幅カーブで先にMRM_OKへ落とす。
- `run_l4_scenario_matrix.js` は1ルート例外を `FAIL_UNKNOWN` として記録し、行列JSON保存まで継続するよう堅牢化。
- `l4RegressionLib.js` の勾配帯を速度側と同じ絶対値基準に修正（下り急坂も steep/mid）。

### 実測
- 最終行列: `runtime/l4_regression/matrix_1783070154362.json`
  - 32走行 = 16セル × 2車種
  - PASS 24 / MRM_OK 7 / FAIL 1 / pageErrors 0
- 最新2件比較: `report_latest.md` は悪化0・改善1。
  - 改善: `10t_unic w45_6|flat|curve` が `FAIL_MONITOR → MRM_OK`
- 初回比では `10t_unic lt35|flat|straight` が `PASS → MRM_OK` だが、幅3m未満級に大型車が進入しない設計判断として正常扱い。
- 残FAIL: `2t_flat w35_45|flat|sharp / gsi-46755-11784-i-6267` が `road_surface_excursion`。trace保存済み:
  `runtime/l4_regression/matrix_traces_1783070154362/75cce456_gsi-46755-11784-i-6267_FAIL_MONITOR.jsonl`

### 次やること
- [ ] 残FAIL 1件のtrace解析（2t・幅3.7m・急折れ）: route pose生成/道路面/始終点猶予のどこで帯を割るか切り分け。
- [ ] report_l4_regression の「大型車×狭幅MRM_OKは正常」扱いを必要なら明文化/機械化。
- [ ] Phase 4 残: 実績データ取り込みフロー（搬入できた/できなかった→golden-routes）

## 2026-07-03 (16) Phase 4 着手 — シナリオ行列（オンデマンド）+ 前回比レポート + 曲率連動ゲート
### やったこと
- **方針確定: 夜間/定期の自動実行はなし**。シナリオ行列・レポートはすべて手動コマンド。
- `src/batch/l4RegressionLib.js` 新規（共有部品: 形状分類=方位折れ角、幅帯=widthClass階級、
  勾配帯、セル選定、runRoute）。
  勾配帯は速度側と同じく絶対値基準（下り急坂も steep/mid）に修正。
- `src/batch/run_l4_scenario_matrix.js` 新規: 幅帯4×勾配帯3×形状3のセル代表ルート×車種。
  1ルート例外時は `FAIL_UNKNOWN` として記録し、行列JSON保存まで継続するよう堅牢化。
  初回実測（2t_flat/10t_unic × 16セル=32走行）で**設計どおり本物のギャップを検出**:
  - 10t_unic が狭幅路(3〜5m)のカーブで6件の逸脱MRM。**同じ幅でも直線はPASS**
    → 静的幅ゲートに「カーブの車体スイング」が抜けていることが実測で確定。
  - 2t の直線 FAIL_INCOMPLETE 1件 → 単一ページ再利用の状態混入疑い
    （ユーザーが route回帰側で発見した危険点と同種）→ 行列側もルート毎ページ隔離へ修正。
- **曲率連動の狭幅ゲート**（behaviorPlanner）: swing≈Lf²/(2R)（Lf=WB+前OH）を
  実効車幅に加算し narrowWidthSpeedFactor へ。直線はswing=0で従来どおり。
  最終的に係数は `RISK_TUNING.narrowWidth` の Lf補間へ集約し、
  サンプルに curveSwingM / curveSwingWidthMultiplier を記録。run_sim_repro ALL PASS（決定論維持）。
- `src/batch/report_l4_regression.js` 新規: 最新2件（matrix優先）をルート単位で比較、
  **悪化=赤字+exit 1**・改善=緑字、`report_latest.md` 出力。動作確認済み。
- ユーザー側修正の確認: route回帰のルート毎ページ隔離・trace回収・20/20 PASS再実測
  （regression_1783063364486.json）→ 妥当、Phase 3完了宣言は維持。
### 次やること
- [x] スイングゲート込みの行列 re-run 結果確認（10t狭幅カーブ→MRM_OK、広い道PASS維持）
- [x] RISK_TUNING.narrowWidth / swing係数のチューニング（Lf補間で収束）
- [ ] Phase 4 残: 実績データ取り込みフロー（搬入できた/できなかった→golden-routes）
- [ ] JARTIC/xROAD 無料API／FGD計測不成立24本の改善（後日）

## 2026-07-03 (15) 22ルート本番回帰 全PASS → **Phase 3 完了宣言**
### やったこと
- **本番回帰**: 東京AOI 6ルート + 長崎急坂AOI 10ルート + 丸の内AOI 6ルート =
  **計22ルート 全PASS**（全ルート進捗100%無介入走破・Monitor違反0・MRM 0・pageエラー0）。
  幅5m/勾配7.16%の坂、幅27mの大通り、L字クランク含む。
  レポート: `runtime/l4_regression/regression_1783062354714.json` / `_1783063227914.json`
- **Phase 3 完了条件（代表20ルート・Monitor違反=0）達成 → ROADMAPで完了宣言**。
  切り返しbehaviorは完了条件外のオプション拡張として据え置き。
- FGD未付与39本の分類（待ち時間の並行作業）: A=全点bbox外15本（仕様）／
  B=RdEdgデータ欠損0本／C=計測不成立24本（主因: 広幅員でmaxHalfWidthM=15mが対側縁に
  届かない+交差点ギャップ）。ROADMAPのPhase 2に対策候補と副作用の注意を記録。
### 次やること
- [ ] **Phase 4 着手**: シナリオ行列（指定車種×幅帯4×形状×勾配）の自動生成とオンデマンド実行、
      前回比の悪化を赤字表示するレポート
- [ ] Phase 2 残: ゴールデン実績ルート30本収集（混同行列の計測開始）、
      FGD計測不成立24本の改善（gsiWidth連動の探索上限・検証つき）
- [ ] JARTIC/xROAD 無料APIフェッチャ／厳密フルオフライン起動（後日）

## 2026-07-03 (14) 回帰FAILの根本原因1つに収束 → 東京5/5・長崎5/5 全PASS
### やったこと
- **i-1294 の trace デバッグ**（バグ報告標準形式が初めて実戦投入）:
  違反点が自経路の中心線から21.3m離れている→「面欠損」でなく**経路乖離**と判定。
  trace の軌跡が始点から方位34.91°の直線＝端点間直線と一致→経路が2点に潰れていると特定。
  フック実測で確定: setRoute直後 21点/165.1m → **ワールド読込後 2点/116.9m**。
- **根本原因**: controls.js の `scheduleAutoRouteRebuild`（endpoints変更を購読して経路を
  自動再構築）が、`index3DSetRoute` の注入経路をデバウンス後に**端点間直線で上書き**。
  長崎の「switchbackはみ出しFAIL」「ticks=2の見せかけPASS」も全て同一原因だった
  （＝狭幅ゲート/切り返し問題と誤読していたものが実は1つのバグ）。
- **修正**: routeMeta.source==='test' の確定経路は自動再構築で上書きしない
  （購読時+タイマー発火時の二重ガード。通知順の罠: endpoints通知時点では
  routeMeta未設定のため発火時の再チェックが必須だった）。
- **回帰結果**: 東京AOI **5/5 PASS**（i-1294はL字165mを完全走破・3856tick）、
  長崎急坂AOI **5/5 PASS**（幅3m・勾配8.96%の坂も完走、勾配減速 minV=10.2km/h 動作確認）。
  Monitor違反=0・pageエラー=0。ハーネスはFAIL時trace自動保存に対応済み。
### 次やること
- [ ] **20ルート本番回帰**: `node src/batch/run_l4_route_regression.js
      --worlds c6c4f2e9,75cce456 --routes 10` → 通れば **Phase 3 完了宣言**
- [ ] 切り返しbehavior/pure pursuit拡張は「本当に必要になるルート」が出てから
      （今回のswitchback FAILは経路潰れが原因で、物理側は健全だった）
- [ ] FGD未付与39本の分類／JARTIC無料API（後日）

## 2026-07-03 (13) Phase 3 回帰ハーネス稼働 — 代表ルート自動回帰と2つの本物の検出
### やったこと
- **経路注入フック** `window.index3DSetRoute(points)` 追加（OSRM不使用・決定論。
  buildDirectRouteResult+applyRoute 経由＝ボタンと同一コード路）。
- **Phase 3完了条件の回帰ハーネス** `src/batch/run_l4_route_regression.js` 新規:
  world内の実道路中心線から代表ルートを自動選定（長さ/幅/`--steep`勾配優先）→
  ①経路→②world→③走行 → PASS(進捗70%以上で走破) / MRM_OK(理由コード付き停止) /
  FAIL_MONITOR(Monitor違反=バグ) / FAIL_INCOMPLETE(見せかけ完走) を機械判定、JSON保存。
- **Safety Monitor 始終点猶予**: 搬入始終点では車体張り出しが道路帯端キャップを
  構造的に割るため、経路始終点±12mは道路逸脱チェックのみ猶予（接触・カーブは猶予せず）。
  → 狭幅路の tick1 即MRM が解消（i-2868: tick1→286まで前進）。
- **狭幅ゲート**（planner側）: `narrowWidthSpeedFactor`（余裕≤0.3m=STOP／≤0.9m=徐行0.45、
  RISK_TUNING.narrowWidth）を behaviorPlanner に配線。サンプルに widthMarginM 記録。
- **進捗メトリクス**: `getSafetyMonitorMetrics()` に progressM/routeTotalM 追加。
  ticks=2 で「完走」に見える劣化ケースを FAIL_INCOMPLETE として検出可能に。
- **実測**: 東京AOI(c6c4f2e9) **4/5 真PASS**（全ルート進捗100%）。
  検出した本物の課題2つ:
  1. 東京 i-1294: 幅19.5m道路なのに進捗23mで逸脱MRM → **道路面生成のバグ疑い**
     （trace保存済み。バグ報告形式で調査可能）
  2. 長崎切り返し路(w=3〜4.3m): カーブで車体角が帯を割る＋物理ポーズ生成が短絡
     → ROADMAPの未実装項目「**切り返しbehavior/pure pursuit拡張**」に該当する既知ギャップ
### 次やること
- [ ] i-1294 の trace を再生して道路面生成（buildRoadUnion/レンダ側surface）のバグ特定
- [ ] 山道切り返し: pose生成失敗の原因（simulatePathPoses）と、狭幅路のswept-path考慮
- [ ] 上記2件を潰してから **20ルート本番回帰**（東京10+長崎10）→ Phase 3 完了判定
- [ ] FGD未付与39本の分類／JARTIC無料API（後日）

## 2026-07-03 (12) (11)の検証と根本修正 — Safety Monitor正常系E2E完走
### やったこと
- **(11)の成果を検証**: 構文4/4 OK／compile selfcheck ALL PASS／run_sim_repro ALL PASS。
  消失していた単体テストを恒久ファイル `src/batch/run_safety_check.js` として再作成
  （**8項目 ALL PASS**: 正常系/道路逸脱/接触/clearance≤0/null非違反回帰/カーブ許容差/
  firstViolation捕捉/traceハッシュ決定論）。
- **中断していた正常系ブラウザ確認を再現→根本原因を特定・修正**:
  - 症状: compiled world + デモ実道路経路でも tick1 で `road_surface_excursion` → 即MRM。
  - 原因: **compile_world が rdcl 幅ランク→幅情報(gsiWidth*)の変換を焼いていなかった**
    （オンライン経路の gsi.js だけが実装）。道路面が既定幅の細帯になり、
    幅ランク「19.5m以上」の大通り（最寄り1.83m）ですら逸脱扱いになっていた。
  - 修正1: compile_world に `rdclWidthRange`/`rdclHighwayClass` を実装し
    gsiWidthMin/Max/Estimate/Confidence/highway を全道路へ焼き込み（selfcheck検証追加）。
  - 修正2: **gsi.js 側の実バグ**も発見・修正 — テキスト形式ランク
    「13m-19.5m」「19.5m以上」が未解析で unknown 落ちしていた（オンライン判定も
    大通りを幅不明扱いにしていた）。両ファイルに解析を追加。
- **正常系E2E ALL PASS**: デモAOI再コンパイル hash `773f1fb4`（93道路・gsiWidth 93/93）で
  ①経路確定→②world読込→③3D自動走行 **232tick監視・status=OK・firstViolation=null・
  MRMなし・pageエラー0**。
- **幅修正前の旧ワールドは Safety Monitor 用途に非推奨**（gsiWidth 0本）→ 再コンパイル済み:
  東京駅前 `c6c4f2e9`（57本/fgd18/grade39）・長崎坂 `75cce456`（388本/fgd186/grade265）・
  デモ丸の内 `773f1fb4`。
### 次やること
- [ ] 急坂AOI（75cce456）で勾配減速＋Safety正常系のE2E（(11)のPlaywright確認を新worldで再実行）
- [ ] Phase 3 完了条件: 代表20ルートの無介入走破 or 理由コード付きMRM回帰
- [ ] FGD未付与39本（東京AOI）の原因分類（欠損タイル/道路種別/閾値）
- [ ] JARTIC/xROAD 無料APIフェッチャ／厳密フルオフライン起動（後日）

## 2026-07-03 (11) Phase 2幅改善 + Phase 3 Safety Monitor/MRM + 急坂実測
### やったこと
- **FGD幅カバレッジ向上**: FGD道路縁の探索マージンを25m→40mへ拡張。
  東京駅前AOIの現行ワールドは hash `26c2e88f`（道路57/建物35/規制113）。
  FGD幅付与は **14/57→18/57道路（32%）**、幅分布は min 5.91m / p50 7.30m /
  p90 14.97m / max 24.18m。過大幅が出る緩和案は採用せず、探索範囲だけ広げた。
- **勾配キャップの整合**: `demGradeMaxPct` だけでなく `demGradeMedianPct` も30%上限に揃えた。
  東京AOIはDEM 39/57道路、median max 1.19% / max grade 2.02%で平坦性を維持。
- **急坂AOI実測**: 長崎坂AOIをコンパイル（hash `321548d4`、道路388/規制88、
  FGD 186/388、DEM 265/388）。gradeMedian p90 16.5% / max 30%、12%以上の
  `gradeSpeedFactor=0.6` 道路は39本。
- **ブラウザ実機で勾配減速確認**: Chrome+Playwrightで `world_321548d4` を読込。
  30%勾配・幅22.9mの道路で Phase4 `SLOW`、`gradeSpeedFactor=0.6`、
  許容速度は最大10.2km/h（cruise 18km/h）、page/consoleエラー0。
- **Safety Monitor実装**: `src/sim/safetyMonitor.js` を追加し、毎tickで
  車体道路外逸脱・クリアランス接触・前方clearance<=0・カーブ上限超過を独立検査。
  `map3dThree.js` の3D再生tickへ配線し、trace hash/最初の違反をhookから取得可能にした。
- **MRM停止実装**: Safety違反またはplannerの未解決STOPで再生を停止し、
  `window.INDEX3D_SAFETY_LAST_TRACE` と `localStorage['index3d:safety:lastTrace']` へ
  traceを自動保存。`index3DGetSafetyMetrics()` / `index3DGetSafetyTrace()` を追加。
- **ブラウザ実機でMonitor/MRM確認**: 東京AOI hash `26c2e88f` の幅23.08m道路で通常走行
  124tick `status=OK` / firstViolationなし。低クリアランスoverhead障害物では
  `planner_stop_unresolved` でMRM停止、Phase4 `STOP`、blocker=`mrm-test-overhead`。
- 検証: `node --check`（変更6ファイル）OK、`compile_world --selfcheck` ALL PASS、
  `gradeSpeedFactor`単体9項目 PASS、Safety Monitor単体6項目 PASS、
  `run_sim_repro --runs 100` ALL PASS、golden dry-run OK、road_seg selfcheck 9/9 PASS。

### 次やること
- [ ] Phase 3を完了条件まで進める: 代表20ルートを無介入走破 or 理由コード付きMRM停止で回す。
- [ ] Safety Monitor違反が出たルートはplanner/road surface側のバグとして潰す。
- [ ] FGD幅カバレッジの残り未付与39本を、欠損タイル/道路種別/閾値のどれが原因か分類する。
- [ ] JARTIC/xROAD 無料APIフェッチャ（定期更新・後日）／ 厳密フルオフライン起動（後日）

## 2026-07-03 (10) レビュー反映 + E2E完走 → Phase 1 完了
### やったこと
- ROADMAPの古い実測値を現行値（hash`3b8695a1`/道路57/FGD14/DEM39）へ更新。
  「bboxクリップ」表記を**bbox重なりフィルタ**（geometry clippingではない・
  座標がAOI外に出る道路も残る）へ正確化。
- **規制IDの非決定fallback廃止**: `regulationModel.normalizeRegulation` と
  `jarticRegulationAdapter` の `Math.random()` を、source/type/value/geometry の
  正準直列化+FNV-1a による `stableRegulationId` へ置換。単体5項目 ALL PASS
  （同一入力→同一ID・キー順非依存・明示IDは温存）。規制モジュールから Math.random 全廃。
- デモ経路(丸の内仲通り)を覆うワールドをコンパイル（hash `5b58dda1`,
  roads=93/buildings=65/regulations=124）。
- **E2E完走（Puppeteer実ブラウザ）ALL PASS**: ①経路確定(70点) → ②compiled world
  差し替え(hash検証・worldLoaded維持) → ③自動走行 → Phase3(建物ソリッド65)/
  Phase4(autonomy SLOW・stops=0) 生成・pageエラー0。
  ※実行はボタンと同一ハンドラのフック（index3DRunDemo/index3DPlay）経由。
- **Phase 1 をデータパスとして完了宣言**。厳密フルオフライン起動（CDN/OSRMローカル化）
  と JARTIC無料APIは独立タスクへ分離。
### 次やること
- [ ] Phase 2 続き: fgd幅カバレッジ向上（縁データ欠損の把握・coverage閾値調整）
- [ ] Phase 3 着手: Safety Monitor（毎tick不変条件+違反trace自動保存）+ MRM停止
- [ ] 勾配減速の実機確認（急坂AOIでSLOW化するか。例: 横浜・長崎の坂）
- [ ] JARTIC/xROAD 無料APIフェッチャ（定期更新・後日）／ 厳密フルオフライン起動（後日）

## 2026-07-03 (9) Phase 2 — 勾配→速度配線（+レビュー残2点の反映）
### やったこと
- レビュー残対応: ROADMAP の「selfcheck 6項目」固定数表記を撤廃。
  クリップ方針（bbox重なりfeature保持・形状は切らない=境界跨ぎ道路で経路連続性優先）を
  ROADMAP に設計判断として明文化。
- **勾配→速度配線（Phase 2）**: `vehicleRiskModel` に `RISK_TUNING.grade` +
  `gradeSpeedFactor()`（3%まで1.0 → 12%で0.6頭打ち）+ `roadGradeSpeedFactor()`
  （demGradeMedianPct優先/MaxPctフォールバック/無データ=1.0）を追加。
  behaviorPlanner が confidence と**独立の係数**として乗算し、サンプルに
  gradePct/gradeSpeedFactor を記録。勾配データ無し道路は従来挙動のまま（非破壊）。
- **発見**: `curveSpeedLimitMS` は behaviorPlanner.js:399 で既に配線済みだった。
  CLAUDE.md の「未配線」が古い記述 → 修正。
- 検証: gradeSpeedFactor 単体 **10項目 ALL PASS**／構文チェックOK／
  run_sim_repro 回帰 ALL PASS（決定論维持）。
### 次やること
- [ ] E2E完走の最終確認（①経路確定→②compiled world読込→③判定）→ Phase 1 完了宣言
- [ ] ブラウザで勾配減速の実機確認（急坂AOIでworldコンパイル→自動走行でSLOW化するか）
- [ ] fgd幅カバレッジさらに向上
- [ ] JARTIC/xROAD 無料APIフェッチャ（定期更新・後日）

## 2026-07-03 (8) レビュー指摘4件の修正 — bboxクリップ・勾配ロバスト化・レイヤ残留・手順
### やったこと
- **rdcl道路のbboxクリップ**: z16タイル丸ごと焼いていた559本 → AOI重なり判定で**57本**へ。
  aoi.bbox と道路範囲のズレを解消（境界跨ぎ道路は経路連続性のため保持）。
- **勾配ロバスト化**: 勾配サンプル<2の短片は付与しない／最大値を MAX_GRADE_CAP_PCT=30 で
  クリップ／`demGradeMedianPct` 併記。実測: 最大66.19%（bbox外の堀・高架由来）→
  クリップ後 **最大2.02%・15%超え0本**（丸の内=平坦と整合）。
- **worldLoaderのレイヤ残留**: 歩道(sidewalkGeoJSON)・plateauTileset・
  window.PLATEAU_AUTO_TILESET をワールド内容で必ず差し替え/クリア。
- **PROCEDURES.md**: 経路適用が worldLoaded=false に戻すため
  「①経路確定→②compiled world読込→③判定実行」の順序を明記。
- 検証: selfcheck **11項目 ALL PASS**（クリップ・ロバスト勾配の検証追加）／
  実データ: fgd幅カバレッジ 3%→**25%**（14/57本）／オフライン再コンパイル hash `3b8695a1` 一致。
### 次やること
- [ ] E2E完走の最終確認（①→②→③の順で判定まで。ユーザーPhase3/4検証はエラーなし報告済み）
      → 通れば **Phase 1 完了宣言**
- [ ] demGradeMedianPct/MaxPct → 速度プロファイル配線 + curveSpeedLimitMS 正式配線（Phase 2）
- [ ] fgd幅カバレッジさらに向上（縁データ欠損タイルの把握、coverage閾値の調整）
- [ ] JARTIC/xROAD 無料APIフェッチャ（定期更新・後日）

## 2026-07-03 (7) ブラウザ実機検証 — 修正1の確認とPhase 1読込経路の完了
### やったこと
- Puppeteer（headless実ブラウザ）で index3D_V2.0.html を起動し、
  `world_b82cfecd.json`（fgd幅・勾配・規制入り）を `index3DLoadCompiledWorld` で読込:
  - [PASS] roads=559 / buildings=35 / regulations=129 / hash検証OK
  - [PASS] **`index3DStats.worldLoaded === true`**（前回指摘の修正1が実機で解消確認）
- 検証用 http.server(8099) は検証後に該当PIDのみ停止（既存プロセス無傷を確認）。
### 次やること
- [ ] E2E完走: 経路確定→自動走行→搬入判定まで（読込は済。判定実行のUI操作込み）
      → 通れば Phase 1 完了宣言
- [ ] fgd幅のカバレッジ向上
- [ ] demGradeMaxPct → 速度プロファイル配線 + curveSpeedLimitMS 正式配線（Phase 2）
- [ ] JARTIC/xROAD 無料APIフェッチャ（定期更新・後日）

## 2026-07-03 (6) レビュー指摘2件の修正（ユーザーPuppeteer検証より）
### やったこと
- **修正1**: `window.index3DLoadCompiledWorld` が store 投入のみで `state.worldLoaded`・
  再描画・パネル・メトリクス更新をしていなかった → `loadWorldForRoute` と同じ読込後処理
  （worldLoaded=true / renderSceneThree / 各パネル / updateMetrics / status・log）を追加。
- **修正2**: 規制0件ワールド読込時に前回の外部規制が残留
  （world_2b7c163d→dad34cc7 で129件残る）→ `setActiveExternalRegulations` を常に通すよう修正。
- 回帰テスト（Node・実ワールドファイル2つ）: 規制あり129件ロード→規制なしで**0件にクリア** ALL PASS。
- PROCEDURES.md: selfcheck「6項目」→固定数をやめ「全項目 ALL PASS 必須」表記に。
  ブラウザでのコンパイル済みワールド読込手順を追記。
### 次やること
- [ ] ブラウザ実機（Puppeteer可）で再確認: worldLoaded=true になり判定まで完走するか
- [ ] fgd幅のカバレッジ向上（bbox外道路への付与 or bboxクリップ）
- [ ] demGradeMaxPct → 速度プロファイル/判定へ配線 + curveSpeedLimitMS 正式配線（Phase 2）
- [ ] JARTIC/xROAD 無料APIフェッチャ（定期更新・後日）

## 2026-07-03 (5) Phase 1完了分+Phase 2着手 — 道路別勾配 + 基盤地図道路縁→幅融合
### やったこと
- 方針確定: JARTIC/xROADは**無料API・非リアルタイム（定期更新で可）**で後日実装。
- `src/world/roadMetrics.js` 新規: 中心線→FGD道路縁への垂線レイキャストで実測級全幅
  （多断面中央値・coverage付き・依存ゼロ純関数）。
- `compile_world.js`: experimental_fgd(RdEdg, **z18のみ配信**と判明)取得 + 道路ごとに
  `fgdWidthM/fgdWidthConfidence` と `demGradeMaxPct`（DEM勾配）を付与。
- `roadWidthModel.js`: 新ソース **fgd_edge（信頼度0.88・priority92）** 追加。
  実測級グループ（OSM widthより優先）+ 全体幅扱い（歩道控除対象）。
- 検証: selfcheck 10項目 ALL PASS ／ 幅融合単体4項目 ALL PASS
  （fgd優先・歩道控除8→4m・手動上書き不変）／ 実データ: 道路縁87本→**19道路に実測幅付与**
  （丸の内の大通りで23m前後＝妥当）、**勾配は559/559全道路付与**、
  オフライン再コンパイル hash `b82cfecd` 一致。
### 次やること
- [ ] ブラウザ実機: `window.index3DLoadCompiledWorld` → 判定完走（fgd幅・規制の反映確認）
- [ ] fgd幅のカバレッジ向上（現状bbox内のみ。rdclタイル全域にbbox拡張 or 道路側でbboxクリップ）
- [ ] demGradeMaxPct を速度プロファイル/判定へ配線（kinematics.buildSpeedProfile連携）
- [ ] curveSpeedLimitMS の正式配線（Phase 2続き）
- [ ] JARTIC/xROAD 無料APIフェッチャ（定期更新・後日）

## 2026-07-01 (4) Phase 1 — 規制レイヤ + 更新ポリシー(TTL)
### やったこと
- `compile_world.js` に OSM規制way取得を追加（maxheight/maxwidth/maxweight/maxlength/
  oneway=yes、生タグのまま焼き込み）。selfcheck 8項目 ALL PASS。
- **更新ポリシー実装**: GSIタイル=無期限キャッシュ、Overpass(建物・規制)=TTL 7日、
  `--refresh` で強制再取得。規制の鮮度は「再コンパイル時に自動更新」される設計。
- `worldLoader.js`: 焼き込み規制→`buildOsmRegulationLayer`で正規化→
  `setActiveExternalRegulations`（既存の搬入判定 controls.js:2583 が無変更で読む）。
- 実測: 東京駅近傍400m四方 → 規制113件焼き込み、オンライン=オフラインで hash `2b7c163d` 一致。
- 規制の現状整理: OSM規制=道路タグ由来（取得時点のスナップショット）。
  JARTIC/xROADは**アダプタの口のみ実装済み・実API取得は未配線**
  （`registerExternalRegulationFetcher` に取得関数を差せば判定へ流れる）。
### 次やること
- [ ] ブラウザ実機: `window.index3DLoadCompiledWorld` → 経路確定→自動走行→判定の完走
      （規制が判定に出るかも同時に確認。Phase 1完了条件の残り）
- [ ] JARTIC/xROAD 実APIの fetcher 実装（リアルタイム規制。APIキー/形式の調査から）
- [ ] 道路ごとのDEM勾配付与 → Phase 2 速度連携と同時
- [ ] Phase 2: 基盤地図 道路縁を幅融合へ（信頼度~0.88）

## 2026-07-01 (3) Phase 1 後半 — 建物レイヤ + アプリローダー
### やったこと
- `compile_world.js` に OSM建物取得（Overpass, GET+キャッシュ→`--offline`対応）を追加。
  id昇順ソートで決定論焼き込み。selfcheck 7項目 ALL PASS。
- 実コンパイル: 東京駅近傍 400m四方 → 道路559 / 建物35 / DEM5A 30/30、
  オンライン=オフラインで hash `dad34cc7` 一致。
- `src/world/worldLoader.js` 新規（hash検証→`setGeoJsonDataSets`/`setBuildingsGeoJSON`）。
- `index3dMain.js` に `window.index3DLoadCompiledWorld(json)` フック追加。
### 次やること
- [ ] ブラウザ実機で `index3DLoadCompiledWorld` → 経路確定→自動走行→判定の完走確認
      （Phase 1完了条件の残り）
- [ ] 規制レイヤ（JARTIC/OSM maxheight等）の焼き込み
- [ ] 道路ごとのDEM勾配付与（現状AOI対角の代表断面のみ）→ Phase 2 の速度連携と同時
- [ ] Phase 2: 基盤地図 道路縁を幅融合へ（信頼度~0.88）

## 2026-07-01 (2) Phase 1 前半 — ワールドコンパイラコア
### やったこと
- `src/world/demTiles.js` 新規: GSI標高タイル dem5a→5b→10b（テキスト形式・依存ゼロ）、
  双一次補間、ルート沿い標高プロファイル+勾配%。**プロジェクト初のDEM対応**。
- `src/world/worldFile.js` 新規: 正準直列化+FNV-1aのコンテンツhash（metaはhash対象外）。
- `src/batch/compile_world.js` 新規: rdcl道路+DEM → `runtime/worlds/world_<hash>.json`、
  HTTPディスクキャッシュ(`runtime/world_cache/`)+`--offline`。
- 検証: selfcheck ALL PASS ／ 実ネット→オフライン再コンパイルで hash `81ac1d5a` 一致
  （ロードマップ完了条件の片方を達成）。
### 次やること → (3) で着手済み

## 2026-07-01 (1) Phase 0 — 決定論化（完了）
### やったこと
- `src/sim/autoFollowCore.js`（幾何単一実装+seed RNG+固定dtシム）、`src/sim/trace.js`
  （record/replay）、`src/batch/run_sim_repro.js`（検証ハーネス）新規。
- `truckDrive._autoLoop` を固定dt(0.05s)アキュムレータ化、幾何をコアと共有。
- 検証: 100回trace全一致 / リプレイ1tick照合一致 / rAF揺らぎ吸収 / dt半減ドリフト0.000m。
- ドキュメント4点作成: `docs/l4sim/{PLAN,PROCEDURES,ROADMAP,DIAGRAMS}.md`。
### 次やること → Phase 1 へ（(2)で着手済み）

## それ以前（要約）
- road_seg 一式: 航空写真セグメンテーション幅推定（幾何エンジン+GSIタイル+API+JS配線+階級表示）、
  教師データ作成ツール（地図→範囲取得→ブラシ修正→保存）、U-Net学習/推論、
  `道路幅AI検証.bat` メニュー(1〜5)。検証: selfcheck 9項目 / smoke 4項目 ALL PASS。
