# LOGISTICS OS 技術要素 動作確認メモ

確認日: 2026-05-22

## 結論

「詰め込まれている技術がすべて問題なく動作する」という認識は不可。

現時点で確実に動作確認できたのは、ローカル起動、2D地図、OSRM/道路データ取得、幾何判定、運動学判定、ローカルYOLO API、ローカルvoxel API、ZIPSプロキシ、PLATEAU GeoJSON正規化まで。

リモートGPU、3D表示、Google 3D Tiles / Cesium / MapLibre 系、実経路上のYOLO幅推定適用は、未動作または未検証。

## 確認済み

| 技術 / 機能 | 状態 | 確認内容 |
|---|---:|---|
| ローカルWeb起動 | OK | `http://127.0.0.1:8080/index8.2.html` が HTTP 200 |
| UIバージョン | OK | ブラウザ上で `LOGISTICS OS v9.0` 表示 |
| JavaScript構文 | OK | `node --check` 全 `src/**/*.js` 成功 |
| Python構文 | OK | `web_server.py`, `server/app.py`, `server/runtime_settings.py`, `server/zips_proxy.py` の `py_compile` 成功 |
| Leaflet | OK | ブラウザで `window.L === true` |
| Leaflet.Draw | OK | ブラウザで `L.Draw.Polygon === true` |
| Turf.js | OK | ブラウザで `window.turf === true` |
| polygon-clipping | OK | ブラウザで `window.polygonClipping === true` |
| Google Maps JS | OK | ブラウザで `window.google.maps === true` |
| Google Satellite 2D | OK | ブラウザログで `[map2d] Google satellite tiles loaded` |
| Google Street View API クラス | OK | `StreetViewService`, `StreetViewPanorama` が存在 |
| Google DirectionsService | OK | クラス存在。ただし主経路はOSRM優先 |
| OSRM | OK | 直接HTTP 200、ブラウザベンチで `[auto-route] OSRM succeeded` |
| 自前Graph fallback | OK | ブラウザベンチで `[auto-route] graph succeeded` |
| OSM Overpass | OK | 実装同等のPOSTで HTTP 200 |
| osmtogeojson CDN | OK | HTTP 200 |
| GSI道路データ | OK | サンプルタイル HTTP 200 |
| Nominatim | OK | HTTP 200 |
| 搬入判定ベンチ | OK | `tokyo-station-short-4t` completed, errors 0 |
| 幾何判定 / sweep / collision | OK | ベンチ内で判定完了。ただし結果は `NG` |
| 運動学判定 | OK | ベンチで `kinematicStatus: OK` |
| 急カーブキャリブレーション | OK | ベンチ結果に `curveCalibration` 出力 |
| 走行シミュレーション | OK | ベンチ結果に `driveSimulation` 出力 |
| ローカルYOLO status | OK | `/status` HTTP 200、detect model / seg model loaded |
| YOLO detect API | OK | 既存サンプル画像で `/detect` HTTP 200 |
| YOLO segment API | OK | 既存サンプル画像で `/segment` HTTP 200、segment count 2 |
| ローカルvoxel API | OK | `/voxel-collision` HTTP 200、衝突テストで `NG`, backend `cpu-bbox` |
| PLATEAU GeoJSON正規化 | OK | data URL のサンプルFeatureで height/source 正規化を確認 |
| ZIPSプロキシ | OK | `/api/zips/address-to-bluemap` HTTP 200 |
| ゴールデンベンチ dry-run | OK | fixtures 2 cases 読み込み成功 |

## 部分的 / 未検証

| 技術 / 機能 | 状態 | 理由 |
|---|---:|---|
| 衛星YOLOによる道路幅推定 | 部分確認 | YOLO APIは動くが、ベンチ結果は `yoloCoverage: 0`。実経路の道路幅へ採用されたことは未確認 |
| Street View + YOLO 一括解析 | 部分確認 | Google Street View APIとYOLO APIは存在確認済み。実際のSV画像スキャンから幅適用までは未実行 |
| ポリゴン障害物ドローイング | 部分確認 | Leaflet.Drawとボタンは存在。手描き操作の自動E2Eは未実施 |
| 8方向 / 距離可変の迂回試行 | 部分確認 | コードは存在。採用経路が出る成功ケースのベンチは未作成 |
| WebGPU full voxel | 部分確認 | ブラウザで `navigator.gpu` は存在。ただし現実装の実判定は CPU raster / ローカルAPI fallback |
| PLATEAU 3D都市データ | 部分確認 | GeoJSONロードはOK。3D表示側は無効化されているため「3D統合」としては未完 |
| Google Static Maps 経由の衛星YOLO | 未検証 | 実APIキーでStatic Maps画像を大量取得する処理。単体API疎通は未確認 |
| Google 3D Tiles | 未検証 | 現行UIから3Dが無効化されているため未確認 |

## 動いていない / 現行では無効

| 技術 / 機能 | 状態 | 根拠 |
|---|---:|---|
| `192.168.2.116` リモートGPU / YOLO | NG | `8001`, `8787`, `8080`, `22` すべて到達不可 |
| CUDA GPU backend | NG | ローカル `/status` で `cuda: false` |
| 3D UI | 無効 | `src/ui/controls.js` で `GBA_3D_REMOVED = true` |
| Cesium / Google 3D Tiles 表示 | 無効 | `map3dWrap` がDOMから削除され、`open3D` も非表示 |
| MapLibre 3D | 無効 | `map3d.js` は存在するが `main.js` から初期化されていない |

## 実行した主な確認

```powershell
python -m py_compile web_server.py server\app.py server\runtime_settings.py server\zips_proxy.py
rg --files src -g "*.js" --glob '!src/batch/node_modules/**' --glob '!src/batch/output/**' | ForEach-Object { node --check $_ }
cd src\batch
npm run golden:dry
node run_golden_benchmark.js --case tokyo-station-short-4t --timeout 180000
```

ローカルAPI:

```text
GET  http://127.0.0.1:8080/runtime-config.js
GET  http://127.0.0.1:8001/status
POST http://127.0.0.1:8001/detect
POST http://127.0.0.1:8001/segment
POST http://127.0.0.1:8001/voxel-collision
POST http://127.0.0.1:8080/api/zips/address-to-bluemap
```

外部疎通:

```text
Leaflet / Leaflet.Draw / Turf / polygon-clipping CDN: OK
OSRM public demo: OK
Nominatim: OK
Overpass API: OK
GSI experimental_rdcl tile: OK
osmtogeojson CDN: OK
```

## 次に必要な確認

1. 衛星YOLO幅推定が実際に `width_ai` を道路Featureへ書き込み、`yoloCoverage > 0` になるケースを作る。
2. Street View スキャンから YOLO 検出、道路幅適用までのE2Eを1経路で確認する。
3. 迂回成功ケースのゴールデンルートを追加する。
4. 3Dを使うなら `GBA_3D_REMOVED = false` に戻すだけでなく、Cesium / MapLibre の読み込み、UI、描画、衝突同期を再統合する。
5. `192.168.2.116` を使うなら、まずSSHまたは `8001/status` が通る状態にしてからGPU/CUDAを確認する。
