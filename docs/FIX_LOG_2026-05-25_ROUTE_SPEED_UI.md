# 2026-05-25 経路生成待ち時間とUI表示の調整

## 目的

端点を2点置いたあと、経路決定までの待ち時間が長く見える問題を改善する。
同時に、道路データ取得時の OSM/PLATEAU 建物UIが混乱しないように確認・調整する。

## 実装内容

### 経路生成

- `src/ui/controls.js`
  - 経路確認開始時に `経路確認中... OSRM と道路グラフを確認しています` のステータスとトーストを即表示。
  - OSRM と道路グラフを並列で起動する前に `requestAnimationFrame` で1フレーム返し、重い計算前にUIが描画されるようにした。
  - 最初に有効な候補を返した経路を即 `applyRoutePlan()` で表示。
  - 残り候補は最大約2.6秒だけ確認し、最終的に良い候補があれば採用。
  - 経路生成前の衛星YOLO幅員推定はデフォルト無効にした。必要な場合だけUIの `経路生成前に衛星YOLOで幅員確認（遅い）` をONにする。

### UI

- `index8.2.html`
  - 経路設定に `経路生成前に衛星YOLOで幅員確認（遅い）` チェックボックスを追加。

- `src/ui/map2d.js`
  - 建物取得開始時に `建物: OSM/PLATEAU 取得中...` を表示。
  - 道路データ欄の `plateauUrlInput` と、3D/PLATEAU欄の `plateauBuildingsUrl` の両方をPLATEAU URL候補として読むようにした。

- `src/ui/controls.js`
  - `plateauUrlInput` と `plateauBuildingsUrl` を同期。どちらに入力してももう片方へ反映される。

## 確認

- `node --check src/ui/controls.js`
- `node --check src/ui/map2d.js`
- `node --check src/ui/workflowController.js`
- `node --check src/api/plateau.js`
- `http://127.0.0.1:8080/index8.2.html` HTTP 200
- `http://127.0.0.1:8001/status` 応答あり、YOLO model loaded

## 注意

ブラウザ自動操作確認用の Puppeteer はこの環境に未導入だったため、今回は構文検証とHTTP応答確認まで実施。
ブラウザ側は Ctrl+Shift+R でハードリロードして確認する。
