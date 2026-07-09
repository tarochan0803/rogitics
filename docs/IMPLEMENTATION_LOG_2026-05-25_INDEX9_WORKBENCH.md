# 2026-05-25 index9.0 Workbench UI

## 目的

既存の `index8.2.html` を壊さず残したまま、必須機能IDを維持した新しい入口を作る。
機能追加を重ねた既存画面を直接調整し続けるのではなく、今後のUI整理を `index9.0.html` 側で進める。

## 追加・変更

- `index9.0.html`
  - `index8.2.html` をベースにした新入口。
  - 既存JSが参照するDOM IDは維持。
  - `body.index9` を付与。
  - 専用CSS `index9.0.css` を追加読み込み。

- `index9.0.css`
  - Workbench向けのUI override。
  - サイドバー、トップバー、設定パネル、HUD、結果パネル、3Dパネルの視認性を調整。
  - 既存JSへの影響を避けるため、CSSは `body.index9` スコープに限定。

- `scripts/start_local.ps1`
  - 起動URLを `index9.0.html` に変更。

- `scripts/start_local.sh`
  - 起動URLを `index9.0.html` に変更。

- `起動.bat`
  - リモートアプリURLを `index9.0.html` に変更。

- `scripts/build_release.ps1`
  - `index9.0.html`
  - `index9.0.css`
  をリリース対象に追加。

- `docs/STARTUP.md`
  - 起動URLを `index9.0.html` に更新。
  - 旧画面 `index8.2.html` も残していることを明記。

## 確認

- `GET http://127.0.0.1:8080/index9.0.html`: HTTP 200
- `GET http://127.0.0.1:8080/index9.0.css`: HTTP 200
- `node --check src/main.js`
- `node --check src/ui/controls.js`
- `node --check src/ui/map2d.js`
- `node --check src/ui/map3dThree.js`

Puppeteer UI smoke:

- `window.store`: OK
- Leaflet map pane: OK
- Three.js: OK
- `runDeliveryAssessment`: OK
- `topRefreshData`: OK
- `osrm-route`: OK
- `sidePanel`: OK
- `map3dWrap`: OK
- `autoSatYoloBeforeRoute`: OK
- `plateauUrlInput`: OK
- `toggleObstaclePolygonMode`: OK
- console/page error: なし

Puppeteer 3D smoke:

- `open3DTop` click: OK
- `map3dWrap.className`: `open`
- visible canvas: 1
- console/page error: なし

Golden benchmark:

```powershell
cd src\batch
node run_golden_benchmark.js --target http://127.0.0.1:8080/index9.0.html --timeout 180000
```

- cases: 2
- completed: 2/2
- errors: 0
- failedExpectations: 0
- output: `runtime/benchmarks/20260525T025824Z`

## 運用

今後のUI改善は `index9.0.html` / `index9.0.css` 側で進める。
`index8.2.html` は互換確認・退避用として残す。
