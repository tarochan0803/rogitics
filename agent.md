# 🤖 AI Agent Context & Handoff

## 🎯 1. プロジェクト概要と最終目標
- **プロジェクト名**: LOGISTICS OS v8.2 -> ファインチューニング用データパイプライン構築フェーズ
- **最終目標**: 
  - 住所リスト（ゴール地点）を入力とし、ゴール地点から約200m半径で自動的に出発点（スタート地点）を計算・設定してOSRMでルートを引き、**2t, 3t, 4t, 10tの全車種**について自動で搬入判定シミュレーションを行うバッチシステムの構築。
  - バッチシミュレーションの結果を保存し、人間がUI上で車種ごとに「通行可否（OK/NG）」を高速にアノテーション（デバッグ）できる環境の提供。
  - 上記のアノテーションデータを元に、トラック搬入専用のAI（VLM等）をファインチューニングする基盤の作成。
  - **※注意**: 現在アプリに組み込まれている「LLM推論機能(Ollamaによる所見生成)」は不要となったため、コード・UI・挙動から完全に削除する。
  - **※注意**: 現在の `index8.2.html` や `src/` などの主要コードは壊さず、自動バッチ機能は新規スクリプトとして作成すること。

## 🛠 2. 環境・コーディングルール
- **技術スタック**: HTML/CSS/JS (Leaflet, Turf.js), Python (FastAPI, YOLO), Node.js または Python (自動バッチ用ヘッドレス処理)
- **共通ルール**:
  - LLM（Ollama等）の推論呼び出しに関するコードはすべて削除する。
  - 既存のフロントエンド・バックエンドの動作を破壊しない。
  - 作業前後に状態を確認し、破壊的変更に注意すること。

## 📝 3. タスクリスト（ステータス）
- [x] Step 1: 【LLM機能の完全削除】 `index8.2.html`, `src/ui/controls.js`, `server/app.py`, `web_server.py` 等からLLM・Ollamaに関するUIおよびAPI通信処理を全削除する。
- [x] Step 2: 【データセット生成要件定義】 バッチ処理用ヘッドレススクリプトのディレクトリ構造・I/Oフォーマットを設計する。
- [x] Step 3: 【ヘッドレスシミュレータの実装】 CSV（ゴール住所）を読み込み、200m半径からスタートを算出し、OSRMルーティング＋フットプリント計算を行う新規スクリプト実装（既存JSロジックへの影響を避ける）。
- [x] Step 4: 【アノテーションUIの実装】 バッチの出力結果をブラウザで表示し、人間がサクサクと「OK/NG」をスワイプ/クリック仕分けできるシンプルなアノテーションUIツール `annotation_tool.html` の作成。
- [ ] Step 5: 【AIファインチューニングの実行】 生成されたアノテーションデータを元に、AIモデル（VLM等）を学習・検証するフローの構築。

## 🔄 4. 次のアクション（引き継ぎ指示）
- **次に起動するAI**: ユーザー / Claude Code
- **依頼内容**:
  1. ユーザーが `annotation_tool.html` の動作確認を行う（新規バッチ実行 → 出力フォルダ選択 → 経路マップが表示されるか確認）。
  2. 問題があれば Claude Code に追加修正を依頼。
  3. アノテーションが溜まったら Step 5（学習パイプライン）の検討を開始。
- **引き継ぎ時の懸念事項**:
  - バッチ処理はヘッドレスブラウザ（Puppeteer）を使用。`起動.bat` でポート8080と8001が起動していることを確認してから実行すること。
  - 既存の `result.jsonl`（route フィールドなし）を読み込んだ場合、経路マップは「経路データなし」と表示される（バッチ再実行で取得可）。
  - `annotation_tool.html` は出力フォルダにコピーされるが、最新版は `src/batch/` にある。

## 📜 5. 作業ログ（最新のものを下に追加）
### [2026-03-11] 担当: Antigravity
- **実施内容**:
  - `index8.2.html`, `src/ui/controls.js`, `src/ui/deliveryPanel.js`, `server/app.py` からOllama/LLM関連のUI・API連携・フロントエンドロジックをすべて削除しました。
  - Step 1のタスクを完了としました。
### [2026-03-11 10:55] 担当: Antigravity
- **実施内容**:
  - `src/batch/` ディレクトリを作成し、Puppeteerを利用したバックグラウンドシミュレーションバッチの開発を行いました。
  - Step 2, Step 3 を完了としました。
### [2026-03-11 11:30] 担当: Antigravity
- **実施内容**:
  - `run_batch_sim.js` の動作テストを行い、3件の住所に対して正常に判定結果（JSONL）と画像が生成されることを確認しました。
  - `controls.js` に `window.runSingleVehicleAssessment` などのAPIを外部公開し、バッチから呼び出せるようにしました。
  - 軽量・高速なアノテーションツール `annotation_tool.html` を作成しました。
- **結果・気づき**:
  - バッチ実行時に地図の読み込みが間に合わない場合を考慮し、ポーリングと待機時間を長めに設定しました。
  - アノテーションツールは出力フォルダ内の `result.jsonl` をロードして使用します。

### [2026-03-11 11:45] 担当: Antigravity
- **実施内容**:
  - バッチシミュレータを改良し、1つの目的地に対して **2t, 3t, 4t, 10t** の4車種すべてで自動判定を行うように変更しました。
  - アノテーションツールを刷新し、車種ごとのAI判定結果を表示しつつ、人間が車種ごとにOK/NGを個別にアノテーションできるようにしました。
  - キーボードショートカット `1`, `2`, `3`, `4` で「○t車まで通行可能」という一括設定も可能にしました。
- **結果・気づき**:
  - 車種別の通行不可判断を学習データに含めることで、より実用的な「搬入可否判断AI」のベースが整いました。

### [2026-03-11] 担当: Codex - デバッグ修正
- **発見したバグと修正内容**:

  **Bug 1: `annotation_tool.html` — CSS クラスが大量に未定義**
  - `.stat-card`, `.stat-label`, `.stat-val`, `.progress-bar`, `.progress-fill`, `.list-container`, `.task-item`, `.done`, `.active`, `.hint`, `.btn`, `.btn-sec`, `.badge`, `.badge-ok`, `.badge-ng` が全て未定義だった（`/* ... existing styles ... */` というプレースホルダが残っていた）。
  - 上記CSS定義をすべて `annotation_tool.html` に追加済み。

  **Bug 2: `annotation_tool.html` — `<input type="file">` が表示されていた**
  - `<label>` でラップしているのに `<input>` 自体も表示されていた。
  - `style="display:none"` を追加して修正済み。

  **Bug 3: `run_batch_sim.js` — Google API Key なしでジオコーディングが全件失敗**
  - `USER_CONFIG.googleMapsApiKey` が未設定の場合、Google Maps スクリプト自体がロードされず、全タスクで `geocode()` がエラーで落ちていた。
  - Google API Key がある場合は優先使用、失敗 or 未設定時は **Nominatim (OSM)** にフォールバックするよう修正済み。

  **Bug 4: `window.findNearestRoad` が未公開 + 返り値の型不整合**
  - `findNearestRoad` は `map2d.js` に定義されていたが `window` に公開されていなかった。
  - さらに元の関数は `{feature, dist}` を返すが、バッチスクリプトは `{lat, lng}` を期待していた。
  - `map2d.js` に `findNearestRoadCoord(lat, lng)` ラッパーを `export` として追加（`turf.nearestPointOnLine` で実座標を取得し `{lat, lng}` を返す）。
  - `controls.js` で import し `window.findNearestRoad` として公開済み。

  **Bug 5: `annotation_tool.html` — 画像が 404 で表示されない**
  - ツールを localhost 経由で開くと、`img.src = "task_001_xxx.jpg"` がサーバールートからの相対パスに解釈され 404 になっていた。
  - `<input type="file">` 方式を廃止し、**File System Access API `showDirectoryPicker`** に切り替え。
  - ボタン「📂 出力フォルダを選択」を1クリックするだけで `result.jsonl` の読み込み＋全画像の Blob URL への変換が自動実行される。
  - Chrome/Edge のみ対応（非対応ブラウザにはアラートで案内）。

- **修正ファイル**:
  - `src/batch/annotation_tool.html`
  - `src/batch/run_batch_sim.js`
  - `src/ui/map2d.js`
  - `src/ui/controls.js`

### [2026-03-11] 担当: Codex - バッチ判定ロジック修正
- **発見したバグと修正内容**:

  **Bug 6: `run_batch_sim.js` — 道路データを取得せずに判定していた（最重要バグ）**
  - バッチはOSRMルート取得後、直接 `runSingleVehicleAssessment` を呼んでいた。
  - しかし衝突判定は `state.geoJsonDataSets`（Overpassから取得した道路ポリゴン）に依存しており、これが空の場合は全て無意味な判定（"SAFE/全OK"）になる。
  - スクリーンショット上も「道路データ取得 未送信」のまま判定が走っていることを確認。
  - 修正: OSRM ルート確定後に `window.loadRoadsWideArea(state.simRoute)` を呼び、道路データ件数が 0 の場合はエラーで中断するよう変更。
  - `controls.js` に `window.loadRoadsWideArea = loadRoadsWideArea` を追加。

  **Bug 7: バッチの正しい実行フロー（確認済み）**
  - 正しい順序: `endpoints セット` → `onOsrmRoute()` → `loadRoadsWideArea(route)` → `runSingleVehicleAssessment(vp) × 4車種`
  - 各車種のログ出力 (`${vp} -> ${status}`) も追加。

- **修正ファイル**:
  - `src/batch/run_batch_sim.js`
  - `src/ui/controls.js`

### [2026-03-11] 担当: Codex - バッチ高速化 & 住所失敗時の即中断 & Nominatim専用化
- **変更内容**:

  **住所ジオコーディング失敗 → 即中断**
  - `Geocoding failed` エラーが発生した場合、残りのタスクをスキップしてバッチを即座に中断するよう変更。
  - エラーメッセージを出力して終了（`input.csv` の住所を確認するよう案内）。

  **ジオコーディングを Nominatim (OSM) 専用に変更**
  - バッチで Google Maps Geocoding API を使うとクォータを大量消費するため、Nominatim 専用に変更。
  - タスク間2秒クールダウンがあるため Nominatim のレート制限（1req/s）に引っかからない。

  **バッチ高速化（各待機時間を短縮）**
  | 変更箇所 | 変更前 | 変更後 |
  |---|---|---|
  | タスク間クールダウン | 6000ms | 2000ms |
  | 地図初期ロード待機 | 5000ms | 3000ms |
  | fullReset後の待機 | 1000ms | 500ms |
  | OSRMルートポーリング間隔 | 500ms × 40回 | 300ms × 30回 |
  | 道路データ反映待機 | 2000ms | 1000ms |
  | 車種切替UI反映待機 | 500ms | 200ms |
  | スクリーンショット前待機 | 3000ms | 1500ms |
  | スタート距離 | 200m | 100m |

- **修正ファイル**:
  - `src/batch/run_batch_sim.js`

### [2026-03-12] 担当: Codex - アノテーションツールの互換性改善
- **背景**: `File System Access API (showDirectoryPicker)` が使えない環境で `annotation_tool.html` が読み込み不可だった。
- **対応内容**:
  - フォルダ選択が使えない場合に、`result.jsonl` と画像フォルダを個別に選べるフォールバックUIを追加。
  - 画像参照時に `task.imageFile` の basename でも探索するようにし、`webkitRelativePath` で選ばれた画像にも対応。
  - フォルダ選択が使えない場合は自動でフォールバック表示＆案内。
- **修正ファイル**:
  - `src/batch/annotation_tool.html`

### [2026-03-12] 担当: Codex - ジオコーディングの信頼性改善
- **背景**: Nominatim が日本の住所（例: 東京都港区赤坂9-7-1）で空配列を返し、バッチが即中断した。
- **対応内容**:
  - ジオコーディングをブラウザ内からNode側に移動し、CORS/ヘッダ制限の影響を排除。
  - 日本向けに **GSI住所検索API** を優先使用し、Nominatim/Google をフォールバック可能にした。
  - `geocodeOrder`, `nominatimEmail`, `googleApiKey` を `CONFIG` に追加。
- **修正ファイル**:
  - `src/batch/run_batch_sim.js`

### [2026-03-12] 担当: Claude Code - アノテーションツール2パネル化 & バグ修正
- **修正内容**:

  **Bug修正: `task.results` が undefined のタスク（エラー行）で TypeError クラッシュ**
  - 失敗タスクは `{ task_id, input, status, error }` 形式で保存されており `results` フィールドが存在しない。
  - `parseTasks` でJSONL解析失敗行をスキップ＋`results`を空オブジェクトで正規化する処理を追加。

  **新機能: 2パネルレイアウト（スクショ + 経路キャンバス）**
  - コンテンツエリアを左右2分割: 左＝スクリーンショット、右＝Canvas経路マップ（300px）
  - route データなし（旧バッチ出力）の場合は「経路データなし」を表示

  **`run_batch_sim.js` 変更: route データを出力に追加**
  - `outData` に `route`, `startLoc`, `goalLoc` フィールドを追加

- **修正ファイル**: `src/batch/annotation_tool.html`, `src/batch/run_batch_sim.js`

### [2026-03-12] 担当: Claude Code - 道路幅データ出力 & スクショズーム & Canvas道路幅ライン
- **変更内容**:

  **スクショをゴール付近にズーム**
  - `map2d.js` に `focusToGoalArea(simRoute, maxZoom=18)` を追加（ルート後半60%にfitBounds）
  - `controls.js` でimport・`window.focusToGoalArea` として公開
  - バッチのスクショ前に `focusToGoalArea` 呼び出しに変更

  **道路幅データをバッチ出力に追加**
  - `geoJsonDataSets` から幅（`width_ai`, `width`, `lanes×3m`）を抽出
  - `roadSegments: [{width, coords}]` として `result.jsonl` に保存（最大400件）

  **Canvasに道路幅ライン描画**
  - 幅色分け: ≥5.5m=緑 / ≥4.0m=黄緑 / ≥3.0m=黄 / ≥2.5m=橙 / <2.5m=赤 / 不明=グレー
  - ラインのピクセル幅は実スケール（1m = 1/scale px）
  - 右上に道路幅凡例を表示

- **修正ファイル**: `src/ui/map2d.js`, `src/ui/controls.js`, `src/batch/run_batch_sim.js`, `src/batch/annotation_tool.html`

### [2026-03-12] 担当: Claude Code - アノテーションUI刷新（最大通行車種ボタン）
- **変更内容**:
  - 車種ごとの個別OK/NGボタンを廃止し、「通行可能最大車種」を1タップで設定するボタン行に変更
  - ボタン: [全NG] [2t] [3t] [4t] [10t] — 選択すると「それ以下=OK / それ以上=NG」を自動設定
  - キーボード: 0=全NG, 1=2t, 2=3t, 3=4t, 4=全OK。設定後は自動で次タスクへ移動
  - AI判定は右端に小さく表示（読み取り専用）
- **修正ファイル**: `src/batch/annotation_tool.html`

### [2026-03-18] 担当: Codex - 全体レビューと経路責務の整理
- **変更内容**:
  - `経路選定` と `走行軌跡` の分離を前提に、`state` の無効化ルールを整理
  - 端点追加・更新・削除時に `selectedRoadRoute` / `simRoute` / sweep / feasibility / assessment / collision をまとめて破棄するよう修正
  - `setRoutePlan()` / `setSimRoute()` / `setRouteSelection()` でも古い評価結果が残らないように修正
  - 車両変更 (`setVehicleConfig`, `applyVehiclePreset`) と `driverSkill` 変更時にも古い sweep・判定結果を破棄するよう修正
  - `map2d.js` に残っていた自動 OSRM 経路生成を撤去し、自動経路生成の責務を `controls.js` 側へ一本化
  - `computeRouteFromEndpoints()` の返り値を「配列にプロパティを生やす暫定形式」から `{ selectionRoute, trajectoryRoute }` の明示オブジェクトへ整理
  - `geo.js` の remote ESM import をやめ、HTML 側で先に読み込んだ global Turf を使う構成へ変更
- **修正ファイル**:
  - `src/state.js`
  - `src/ui/map2d.js`
  - `src/ui/controls.js`
  - `src/utils/geo.js`
- **確認**:
  - `node --check src/utils/geo.js`
  - `node --check src/state.js`
  - `node --check src/ui/map2d.js`
  - `node --check src/ui/controls.js`
  - `node --input-type=module` で `state.js` の route invalidation を簡易確認
- **全体レビュー所見**:
  - `src/ui/controls.js` は 3341 行あり、UI描画・ワークフロー制御・経路生成・配達判定・3D同期を抱え込みすぎている
  - `src/ui/map2d.js` は 1084 行あり、描画専用層に寄せるべき責務がまだ多い
  - `index8.2.html` は 2396 行あり、画面ごとの style と widget 定義が HTML に集まりすぎている
  - リポジトリ全体で文字コードが混在しており、コメント・ボタン文言・ログの一部に文字化けが残っている
  - ブラウザ global (`turf`, `L`, `polygonClipping`, Google Maps) 依存が強く、Node/Batch からの再利用性はまだ低い
  - `server/app.py` と `web_server.py` はローカル用途前提の設計で、CORS や外部 API 依存の扱いは本番公開向きではない
- **次に分割すべき単位**:
  - `controls.js` → `routeController`, `assessmentController`, `workflowDock`, `searchPanel`
  - `map2d.js` → `mapRenderer`, `endpointInteraction`, `routeOverlay`
  - `index8.2.html` の inline style → `style6.css` / `style_patch.css` 側へ移管

### [2026-03-18] 担当: Codex - 追加是正（UI / 構造 / ローカル実行）
- **変更内容**:
  - `workflowController.js` を新設し、ワークフロー表示と次アクション制御を `controls.js` から分離
  - `controls.js` は 3341 行 → 3250 行まで圧縮
  - `index8.2.html` の巨大 inline CSS を `index8.2.css` へ抽出し、HTML は 2396 行 → 1240 行へ縮小
  - `server/app.py` の CORS をデフォルトで localhost / 127.0.0.1 系のみに制限し、`LOGISTICS_ALLOWED_ORIGINS` で上書き可能に変更
  - `web_server.py` をデフォルトで `127.0.0.1` bind に変更し、`LOGISTICS_HOST` で上書き可能に変更
- **修正ファイル**:
  - `src/ui/workflowController.js`
  - `src/ui/controls.js`
  - `index8.2.html`

### [2026-03-18] 担当: Codex - 交差点軌跡の膨れ補正
- **修正内容**:
  - `trajectoryPlanner.js` に「外振り -> 頂点で内寄せ -> 立ち上がりで戻す」局所候補生成を追加し、直角コーナーで広く回る centerline 追従を選びにくくした
  - 候補採点に `insideGain` を追加し、頂点でしっかり内側へ寄れている軌跡を優先するようにした
  - `graph.js` の `applyTurnTemplates()` は端点近傍のスキップ幅が大きすぎ、短い都市交差点では turn template 自体が無効化されていたため、端点ガードを縮小した
  - 簡易 90 度右折ケースで、修正前は実質 L 字のままだった正規化ルートが、修正後はコーナー円弧を持つ軌跡になることを確認した
- **修正ファイル**:
  - `src/core/trajectoryPlanner.js`
  - `src/core/graph.js`
- **確認**:
  - `node --check src/core/trajectoryPlanner.js`
  - `node --check src/core/graph.js`
  - `node --input-type=module` + Turf CDN 読み込みで、4t の 90 度右折サンプルに対して `normalizeRouteForVehicle()` と `buildTrajectoryPlanFromSelection()` の出力形状を確認

### [2026-03-18] 担当: Codex - 衛星 YOLO 幅推定の過大補正是正
- **修正内容**:
  - `controls.js` の衛星 YOLO 幅推定を、bbox の横幅合計ベースから「道路方位に対する法線方向の車両偏差」ベースへ変更
  - 近傍道路への feature 紐付け時に距離上限を厳しくし、交差点や隣接道路の車両を拾って幅が膨らむケースを抑制
  - OSM/車線数/道路種別から得られる既存幅を prior として使い、YOLO 推定値をそこから大きく外れない範囲に制限
  - `width_ai` への直接代入をやめ、feature ごとに median 集約して `applyWidthOverride()` で反映するよう整理
- **修正ファイル**:
  - `src/ui/controls.js`
- **確認**:
  - `node --check src/ui/controls.js`
  - `python -m py_compile web_server.py server/app.py`
  - `index8.2.css`
  - `server/app.py`
  - `web_server.py`
- **確認**:
  - `node --check src/ui/workflowController.js`
  - `node --check src/ui/controls.js`
  - `python -m py_compile server/app.py web_server.py`

### [2026-03-24] 担当: Claude Code - UI不具合9件の修正

- **修正内容**:

  **Fix 1: 設定パネルが表示されない（最重要バグ）**
  - 根本原因: `index8.2.html` の約297行目に `<div id="floatSearch">` の開きタグが重複していた。Chrome では `backdrop-filter: blur()` を持つ要素が `position:fixed` の子要素の containing block になるため、`#sidePanel`（fixed, right:20px）が画面左外（約-84px）に配置されていた。
  - 修正: 重複している `<div id="floatSearch">` の開きタグを削除。

  **Fix 2: ストリートビューがドライブHUDと重なる + 拡大ボタン追加**
  - `#svViewport` と HUD が両方 `bottom:30px; right:20px` だった。
  - `style6.css` で `#svViewport` を `bottom:270px` に移動。
  - `#svViewport` 内に `#svExpandBtn`（⛶ボタン）を追加し、クリックで `.sv-expanded`（約42vw×38vh）をトグル。

  **Fix 3: 地図上にストリートビュー視点マーカーを表示**
  - `streetviewScan.js` に `_svViewpointMarker`、`_svViewpointArrowSvg(heading)`、`_updateSvViewpointMarker(lat, lng, heading)`、`_removeSvViewpointMarker()` を追加。
  - `getMapInstance` を `map2d.js` からインポート。
  - ドライブティック・`showStreetViewAt`・`clearStreetView` にマーカー更新処理をフック。

  **Fix 4: ワークフロードック ステップ4の判定ボタンを削除**
  - `updateWizard()` のステップ4ケースで `wfActionBtn` を `display:none` に設定。上部の「搬入判定を実行」ボタンのみを使うよう案内文に変更。

  **Fix 5: 再判定中にステップ4が「完了」と表示される問題**
  - `window._isAssessing` フラグを導入。
  - `controls.js` の `onRun` 開始時に `true`、`finally` ブロックで `false` に設定。
  - `updateWizard()` がこのフラグをポーリングし、実行中は「⏳ 実行中...」を表示。

  **Fix 6: プログレスバーが表示されない**
  - `style6.css` の `.thud-progress-bar` が `position:absolute` だったため、親要素に閉じ込められていた。
  - `position:fixed` に変更。

  **Fix 7: YOLO道路幅が過大（3m道路が8mと出る）**
  - `streetviewScan.js` の `WIDTH_ESTIMATE` 定数を修正:
    - `maxRouteOffset: 18 → 5`（道路中心線から5m超の物体を除外）
    - `percentile: 0.75 → 0.4`（保守的な下位推定を使用）
    - `baseMargin: 1.2 → 0.5`
    - `maxWidth: 12 → 8`

  **Fix 8: トラック操作時にハンドルが切れない**
  - `truckDrive.js` の自転車ステアリングモデルを調整:
    - `STEER_DEG: 28 → 38`（最大舵角拡大）
    - `wheelbaseM: 7.0 → 4.0`（デフォルトを2tトラック相当に変更）
  - `index8.2.html` の `#driveWheelbase` 初期値を `7.0 → 4.0` に変更。

  **Fix 9: 車両カード選択がドライブ設定に反映されない**
  - `main.js` にストア購読を追加。
  - 車両プリセット変更時に `vehicleConfig.vehicleWidth`/`wheelBase` を `#driveTruckW`/`#driveWheelbase` 入力欄へ自動反映し、`setDriveConfig()` を呼び出す。

- **修正ファイル**:
  - `index8.2.html`
  - `style6.css`
  - `src/ui/streetviewScan.js`
  - `src/ui/controls.js`
  - `src/ui/truckDrive.js`
  - `src/main.js`

- **CLAUDE.md 作成**:
  - プロジェクト構成・アーキテクチャ・既知バグと修正内容・ファイル一覧を記載した `CLAUDE.md` を新規作成。

### [2026-03-18] 担当: Codex - YOLO ローカル起動導線の追加
- **変更内容**:
  - `起動_ローカル.bat` を追加し、Windows ローカル環境で `web_server.py:8080` と `server/app.py:8001` をまとめて起動できるようにした
  - UI の YOLO 自動起動案内文を `起動.bat` ではなく `起動_ローカル.bat` 基準へ修正
  - `SV + YOLO 一括解析` ボタンで `analyzeStreetView()` の後に `applyDetectionsToWidths()` まで実行するように修正
- **修正ファイル**:
  - `起動_ローカル.bat`
  - `src/ui/streetviewScan.js`
  - `src/ui/controls.js`
  - `index8.2.html`
# 2026-03-24 Codex 運用改善計画

## 目的
- LOGISTICS OS v8.0 を実運用に耐える構成へ改善する
- 保守性を上げるために設定、起動、配布、フォルダ構成、UI/UX を整理する
- 修正内容と完了履歴をこの `agent.md` に集約する

## 修正要件
- 秘密情報と環境依存設定をコードから切り離し、運用時の設定手順を明確にする
- 起動、停止、配布、デプロイの方法を整理し、手順書とスクリプトを揃える
- 不要生成物や肥大化しやすい成果物の扱いを見直し、リポジトリを整理する
- フロントエンドの責務分離を進め、巨大ファイル依存を減らす
- UI/UX を改善し、主要導線、状態表示、レスポンシブ性を強化する
- 最低限の検証手順とスモークテストを整備する

## 実施予定
- [x] Task 1: `agent.md` に今回の修正要件、優先順位、完了ログの管理枠を追加する
- [x] Task 2: ランタイム設定と秘密情報の取り扱いを整理し、実運用向け設定構成へ移行する
- [x] Task 3: 起動、停止、配布、デプロイ用スクリプトとドキュメントを整理する
- [x] Task 4: フォルダ構成、生成物、ログ、出力物の扱いを整理する
- [x] Task 5: フロントエンドの責務分離を進め、保守性を改善する
- [x] Task 6: UI/UX を改善する
- [x] Task 7: 検証、最終確認、運用メモを整備する

## 完了ログ
- 2026-03-24 10: 管理開始。現状調査を踏まえ、今回の修正要件と実施予定を定義した。
- 2026-03-24 11: Task 1 完了。今回の大規模改修用の進捗管理セクションを追加した。
- 2026-03-24 12: Task 2 完了。`runtime-config.js` と `config/runtime.example.json` を導入し、`web_server.py` に公開ランタイム設定配信と ZIPS サーバープロキシを追加した。フロント側は公開設定参照へ切り替え、ZIPS 資格情報のブラウザ露出経路を外した。
- 2026-03-24 13: Task 3 完了。`scripts/` 配下に setup/start/stop/build/deploy スクリプトを整理し、ルートの `.bat` / `.sh` を薄いラッパへ置き換えた。`README.md` と `docs/OPERATIONS.md` で起動・停止・配布手順を明文化した。
- 2026-03-24 14: Task 4 完了。旧 UI / 旧資料 / 実験ファイルを `archive/legacy/` へ移し、systemd unit を `deploy/systemd/` へ整理した。不要巨大ファイル `nul` を削除し、生成物用の `.gitignore` と配布 ZIP の収録対象を更新した。
- 2026-03-24 15: Task 5 完了。`src/ui/pageChrome.js` と `src/ui/truckHud.js` を追加し、`main.js` を単一の有効な起動点へ寄せた。ワークフロードックは `workflowController.js` と `controls.js` 側の実DOMに接続し直し、`index8.2.html` に残っていた Street View / Truck HUD / UX helper の inline 実行を無効化した。
- 2026-03-24 16: Task 6 完了。`index8.2.css` と `index8.2.html` を調整し、Space Grotesk 読み込み、トップバーの視認性、車両カード、ワークフロードック、サーバーパネル、Street View ビューポート、モバイル時レイアウトをまとめて改善した。`pageChrome.js` 側のサーバー状態表示も日本語化し、非対応サーバー時の案内を明示した。
- 2026-03-24 17: Task 7 完了。`node --check` で `src/main.js`、`src/ui/pageChrome.js`、`src/ui/truckHud.js`、`src/ui/workflowController.js`、`src/ui/controls.js` を確認し、`python -m py_compile` で `web_server.py`、`server/app.py`、`server/runtime_settings.py`、`server/zips_proxy.py` を確認した。`scripts/build_release.ps1 -Quiet` を再実行し、`dist/LOGISTICS_OS_v8.0_20260324_124236.zip` の生成まで確認した。なお、ブラウザ実機E2Eと `server/smoke_test.py` の実行は今回未実施。
- 2026-03-24 18: 追加実動検証。`python server/smoke_test.py` を実行し、`/health`、`/status`、`/detect`、`/segment`、`/detect-batch`、`/segment-batch` の疎通を確認した。あわせて `scripts/start_local.ps1` の `Host` 引数が PowerShell の予約変数と衝突していた不具合を `BindHost` へ改修した。
- 2026-03-24 19: 追加E2E確認。`scripts/start_local.ps1 -NoBrowser` で 8080/8001 を起動し、`http://127.0.0.1:8080/api/status`、`http://127.0.0.1:8001/health`、`http://127.0.0.1:8080/index8.2.html` の応答を確認した。さらに Edge ヘッドレス + Puppeteer で `index8.2.html` を開き、`window.store`・公開ランタイム設定・ワークフローボタン・YOLO状態表示を確認し、console error / page error / requestfailed が 0 件であることを確認した。最後に `scripts/build_release.ps1 -Quiet` を再実行し、`dist/LOGISTICS_OS_v8.0_20260324_125131.zip` を作成した。
- 2026-03-24 20: 起動安定化。`scripts/start_local.ps1` の YOLO 起動待機を 120 秒へ延長し、失敗時にログ末尾を表示するようにした。`scripts/stop_local.ps1` は PID ファイルだけでなく、このリポジトリ配下の `web_server.py` / `server/app.py` プロセスも掃除するように強化した。あわせて `scripts/setup_local.ps1` の案内文を ASCII ベースへ寄せ、Windows PowerShell での文字化けを抑えた。
- [x] Task 8: 搬入レポートに軌跡スナップショットを追加し、Street View / HUD の収納 UI と上部ボタン導線を整理する
- 2026-03-24 21: Task 8 完了。`src/ui/deliveryPanel.js` を再構成し、搬入確認レポートへ軌跡スナップショットを追加した。`index8.2.html` / `index8.2.css` / `src/ui/pageChrome.js` で Street View と Drive HUD を収納・復帰できるようにし、結果パネル見出しを整理した。`src/ui/workflowController.js` と `src/ui/controls.js` ではワークフロー実行ボタン依存を外し、上部に `道路取得` ボタンを追加して判定導線を一本化した。
- [x] Task 9: 変更後の UI とレポート出力をローカル起動で検証する
- 2026-03-24 22: Task 9 完了。`node --check` で `src/ui/deliveryPanel.js` / `src/ui/pageChrome.js` / `src/ui/workflowController.js` / `src/ui/controls.js` / `src/main.js` を確認した。`scripts/start_local.ps1 -NoBrowser` で 8080/8001 を起動し、`/health` と `/api/status` を確認した。Edge ヘッドレス + Puppeteer で `topRefreshData` の存在、`wfActionBtn` の撤去、Street View / Drive HUD の収納復帰、トラック切替タブ維持、レポート HTML 内の軌跡 SVG 生成を確認した。Leaflet の `transparent.png` は 1 件 `ERR_ABORTED` が出たが、UI 操作には影響しない軽微なアセット中断だった。
