# 2026-05-25 LOGISTICS_OS 機能スモーク検証

## 対象

`http://127.0.0.1:8080/index8.2.html`

## 結果サマリ

- アプリ起動: OK
- YOLOサーバ起動: OK
- JS構文: OK
- Pythonサーバ構文: OK
- ブラウザUI初期化: OK
- OSRM/道路グラフ経路生成: OK
- 搬入判定ベンチ実行: OK
- YOLO detect/segment 実推論: OK
- voxel衝突API: OK
- 3Dビュー起動: OK
- 3D外部タイル: 条件付き。ヘッドレス検証でHTTP 400が出たため、APIキー/外部配信条件に依存。

## 実行した確認

### 1. サーバ応答

- `GET http://127.0.0.1:8080/index8.2.html`
  - HTTP 200

- `GET http://127.0.0.1:8001/status`
  - HTTP 200
  - `status: ok`
  - `model_loaded: true`
  - `seg_model_loaded: true`
  - `voxel_endpoint: /voxel-collision`
  - `cuda: false` のためローカルGPUは未使用、CPU動作。

### 2. 構文検証

- JS: `node --check`
  - 対象: `src/batch/node_modules` と `src/batch/output` を除く 51ファイル
  - 結果: OK

- Python:
  - `server/app.py`
  - `server/runtime_settings.py`
  - `web_server.py`
  - 結果: OK

### 3. 既存ゴールデンベンチ

コマンド:

```powershell
cd src\batch
npm run golden:dry
node run_golden_benchmark.js --timeout 180000
```

結果:

- dry-run: OK
- 実行ケース: 2件
- completed: 2/2
- errors: 0
- failedExpectations: 0

出力:

`runtime/benchmarks/20260525T023421Z`

実行時ログ上、2ケースとも OSRM と graph の経路生成が成功。

### 4. ブラウザUIロード

Puppeteerで確認:

- `window.store`: OK
- Leaflet: OK
- Turf: OK
- Three.js: OK
- Leaflet map pane: OK
- 主要UI:
  - `runDeliveryAssessment`: OK
  - `osrm-route`: OK
  - `autoSatYoloBeforeRoute`: OK
  - `plateauUrlInput`: OK
  - `plateauBuildingsUrl`: OK
  - `svScan`, `svAnalyze`, `svScanAndAnalyze`: OK
  - `toggleObstaclePolygonMode`: OK
  - `validateWidthFusion`: OK
- 初期ロード時の pageerror/console error: なし

### 5. PLATEAU URL同期

- `plateauUrlInput` へ入力 → `plateauBuildingsUrl` に反映: OK
- `plateauBuildingsUrl` へ入力 → `plateauUrlInput` に反映: OK

### 6. YOLO実推論

`runtime/logs/yolo_smoke.png` を生成してWebサーバ経由で読み込み、YOLOサーバへ送信。

- `POST /detect`: HTTP 200
- `POST /segment`: HTTP 200

### 7. voxel衝突API

簡易footprintとobstacleの交差データを送信。

- `POST /voxel-collision`: HTTP 200
- 結果: `status: NG`
- backend: `cpu-bbox`
- contactCount: 1

### 8. 3Dビュー

Puppeteerから `open3D` を実行。

- `map3dWrap.className`: `open`
- `display`: `flex`
- canvas生成: 1
- visible canvas: 1

注意:

- 外部リソースでHTTP 400が2件発生。
- 3Dビューの枠とWebGL描画は起動したが、衛星テクスチャ/Google系タイルはAPIキーや外部配信条件に依存する。

## 判定

現時点で、通常操作に必要な主要機能はスモークテスト上は動作している。

ただし、以下は「確実に常時動く」とは言えない条件付き機能:

- Google Maps / Street View / 衛星タイル: APIキー・課金・HTTP制限に依存
- PLATEAU: URL入力と配信元GeoJSONに依存
- リモートGPU: `192.168.2.116` など外部サーバ疎通に依存
- OSRM/Overpass: 外部公開APIの混雑・制限に依存
- 3D衛星地面テクスチャ: 外部タイル取得に依存

次に必要なのは、実案件の搬入経路を fixture 化して、PASS/CONDITIONAL/NG の期待値を固定すること。
現在の `golden-routes.json` は測定用シードであり、合否期待値が未固定。
