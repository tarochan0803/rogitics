# road_seg — 航空写真セグメンテーションによる道路幅推定（PoC環境）

「YOLOに幅を覚えさせる」のではなく、**航空写真から道路面を抽出 → 幅は幾何計算**で出す。
モデルが無くても幾何エンジンは動き、モデルは差し替え式。出力は既存の判定パイプラインが
食う `widthSamples {roadId, widthM, frameConfidence}` に揃えてあり、Street View+YOLO と
同じ口（`aggregateWidthSuggestions` → `applyPerceptionWidthAi` = `width_ai`）に流れる。

```
航空写真(GSI) → 道路面マスク(AI) → OSM中心線に垂線 → 端まで測る → 幅m → 階級判定
   tiles.py      segmenter.py        measure.py(幾何の核)         width_class.py
                         └──────── pipeline.py / server.py がオーケストレーション ────────┘
```

精度の生命線は**モデルではなく m/pixel 換算と多断面の中央値**。z18 で約 0.49 m/px なので
1断面では ±1px≒±0.5m の誤差が出る。道に沿って多数の垂線を飛ばし中央値で均す設計。

---

## いちばん簡単な使い方（ダブルクリック）

プロジェクトルートの **`道路幅AI検証.bat`** をダブルクリック → メニューを番号で選ぶだけ。

```
1) 動作確認        … モデル・ネット不要・数秒（まずこれ）
2) 航空写真でテスト … 実GSI航空写真→道路幅→重畳画像を自動で開く
3) APIサーバ起動     … /segment_road_width と /segment_road_surface を :8012 で起動
4) 道路ラベル作成   … 地図で範囲選択→下書き修正→保存（教師データ作り）
5) 学習            … 手動修正 + 弱教師データで道路面モデルを継続学習
6) 手動データだけ学習 … dataset/images + masks のみで学習
7) 教師データ統計   … 手動件数・弱教師件数・モデル情報を確認
0) 終了
```

初回は依存パッケージを自動インストール。日本語メニューは `road_seg/menu.py`（Python）に
寄せてあり、cmd.exe の日本語バッチパーサ問題を避けている。CLIで個別に叩く場合は以下。

## 教師データを作って学習する（4 → 5 のループ）

「地図を動かして範囲を選び、道路の下書きを直して保存、貯まったら学習」の流れ。

1. メニュー **4) 道路ラベル作成** → ブラウザでラベル作成ツールが開く（`/annotate/ui`）。
2. 地図をパン/ズームして道路が見える範囲にする → **「この範囲を取得」**。
   - 航空写真＋**初期下書き**が出る。下書きは既定で **国土地理院RDCL道路中心線**（`experimental_rdcl` の
     幅員ランクから帯を生成）。他に 学習済みモデル / 色しきい値 / なし（手描き）。
3. 緑の下書きを **ブラシで修正**（道路を塗る / 消す、太さ調整）→ **保存**。
   - `road_seg/dataset/images/<id>.png`（航空写真）と `masks/<id>.png`（道路面 0/255）が対で貯まる。
   - 直線ツール: ドラッグ開始点→終了点に、ブラシ太さの道路面を直線で追加する。
   - 幅編集ツール: RDCL下書きの既存道路中心線をクリックして選択し、道幅mを入力して
     **幅を適用**。古い帯を消して指定幅で塗り直す。
   - 編集ズーム: 拡大/縮小/100%ボタン、または編集面上で Ctrl+ホイール。
4. ある程度（数十〜数百件）貯めたら メニュー **5) 学習**（U-Net / DeepLabV3+, MIT）。
   - **手動修正マスクは強教師**として扱い、既存の `dataset_weak` は補助の弱教師として混ぜる。
   - 既定では手動データを8倍重みにして、少数の手修正でもモデルへ強く反映する。
   - `road_seg/models/road_unet.pt` が出力され、以後 backend/初期下書きの
     **「学習済みモデル」** が自動でこの重みを使う（`road_seg/infer.py`）。
   - 学習には `torch` と `segmentation-models-pytorch` が必要（未導入なら導入手順を表示）。

精度が上がってきたら、初期下書きを「GSI中心線」→「学習済みモデル」に切り替えると、
修正量が減って**ラベル作成が加速**する（モデルが育つほど楽になるループ）。

エンドポイント: `POST /annotate/fetch`（範囲→航空写真＋下書き）, `POST /annotate/save`
（修正マスク保存）, `GET /annotate/stats`（件数）, `GET /annotate/ui`（ページ）。

CLIで直接回す場合:

```powershell
# 手修正 + 弱教師の混合学習。既存road_unet.ptがあればバックアップして継続学習。
.\.venv\Scripts\python.exe -m road_seg.train_mixed --epochs 30 --manual-repeat 8

# 草地などの過検出を抑える候補として DeepLabV3+ を試す場合。
.\.venv\Scripts\python.exe -m road_seg.train_mixed --arch deeplabv3plus --epochs 30 --manual-repeat 8

# 比較用に別ファイルへ弱教師DeepLabV3+を作る場合（現行road_unet.ptは上書きしない）。
.\.venv\Scripts\python.exe -m road_seg.train_weak --arch deeplabv3plus --epochs 25 --img-size 384 --batch 4 --out road_seg\models\road_deeplabv3plus_weak.pt

# teacher site 0008/0019 で既存U-NetとDeepLabV3+を比較（summary.jsonとoverlay sheetを出力）。
.\.venv\Scripts\python.exe -m road_seg.compare_models --sites site0008,site0019

# 教師データ数・モデル情報
.\.venv\Scripts\python.exe -c "from road_seg import dataset; import json; print(json.dumps(dataset.stats(), ensure_ascii=False, indent=2))"
```

## まず動かす（モデル・ネット不要 / CLI）

幾何エンジンが正しいかを既知幅の合成道路で検証する。これが通れば「マスクさえ出れば幅は
出せる」配管が動いている証明になる。

```powershell
# プロジェクトルートで（.venv のpython）
.\.venv\Scripts\python.exe -m road_seg.selfcheck
```

期待出力: `11/11 checks passed`（既知幅 3/4/6m を ±0.5m で復元、階級・低信頼→不明、道路面GeoJSON化、混合学習マニフェストを検証）。

---

## あなたが書いた5手順 ↔ このコードの対応

### 手順1: 学習ゼロのフィージビリティ確認（実GSIに当てる）
実航空写真で「日本の狭小道路でどこまで取れるか」を投資前に見る道具。

```powershell
# 例: ある地点から方位30°・120mの直線道路を試算し、マスク重畳PNGを保存
.\.venv\Scripts\python.exe -m road_seg.eval_real --lat 35.6812 --lng 139.7671 --bearing 30 --len 120
# 中心線を直接渡す場合:
.\.venv\Scripts\python.exe -m road_seg.eval_real --line "[[139.767,35.681],[139.768,35.682]]"
```

- `road_seg/.eval_out/overlay.png` で**マスク品質を目視**（緑=道路面, 赤=中心線, 青点=採用断面）。
- CLI 既定は `ThresholdRoadSegmenter`（学習ゼロの素朴ベースライン。精度は出ない前提＝配管確認用）。
- **公開学習済みモデル（DeepGlobe/SpaceNet/SAM-Road）で本気の手順1**をやるときは
  `PretrainedRoadSegmenter(predict_fn=...)` を作って `eval_real.run(line, segmenter=...)` を
  スクリプトから呼ぶ（`segmenter.py` のフック参照）。ここがダメなら投資しない、の判断点。

### 手順2: 基盤地図 道路縁で弱ラベル量産 → DeepLabV3+/U-Net 微調整
手描きを最小化する核。`weak_labels.py`:
- `rasterize_polygons(道路縁ポリゴン[lon,lat], grid)` → 教師マスク（GSI画像と画素一致）。
- `export_training_tile(rgb, mask, out_dir, name, tile=512)` → 学習用に 512px 切り出し。
- 道路縁が無い地域は `buffer_centerlines(OSM中心線, grid, half_width_m)` で暫定ラベル。

学習は `road_seg.train_mixed --arch deeplabv3plus` または `--arch unet` で切り替える。
保存される `road_unet.json` の `arch` を `infer.py` が読んで同じモデルを復元するため、
`backend=pretrained` / 道路面補強の呼び口は変わらない。
ライセンス: smp U-Net / DeepLabV3+ は MIT。SegFormer重みは要確認。

### 手順3: サーバ `/segment_road_width` / `/segment_road_surface`
道路ジオメトリ＋ズームを受け、サーバ内でタイル取得→セグメンテーション→垂線サンプリングまで
完結し、`widthSamples` を返す（JS側を汚さない）。AGPL の YOLO サーバとは別プロセス。

```powershell
.\.venv\Scripts\python.exe -m uvicorn road_seg.server:app --port 8012
# 動作確認:
.\.venv\Scripts\python.exe -m road_seg.smoke   # /health と /segment_road_width(合成) を叩く
```

リクエスト例:
```json
POST /segment_road_width
{ "roads": [ { "id": "r1", "geometry": { "type": "LineString",
  "coordinates": [[139.767,35.681],[139.768,35.682]] } } ],
  "zoom": 18, "backend": "threshold" }
```

道路面補強:
```json
POST /segment_road_surface
{ "roads": [ { "id": "r1", "geometry": { "type": "LineString",
  "coordinates": [[139.767,35.681],[139.768,35.682]] } } ],
  "zoom": 18, "backend": "threshold", "roadBufferM": 28, "cellPx": 6 }
```
返り値は `FeatureCollection`。航空写真マスクを道路中心線近傍だけに制限し、
小さな Polygon 群へ変換する。ブラウザ側では `maskEdits.allow` に
`source=road_seg_surface` として入る。
`backend: "pretrained"` は推論関数の注入が必要（501を返す）。微調整モデルを載せる時は
`run_pipeline(roads, segmenter=PretrainedRoadSegmenter(predict_fn=...))` でデプロイする。

### 手順4: `aggregateWidthSuggestions` → `applyPerceptionWidthAi` に流す
配線済み。`src/3d/roadSegClient.js`:
- `fetchAerialWidthSamples(features, opts)` → サーバから widthSamples。
- `applyAerialWidthFusion(opts)` → 既存集約→`store.applyPerceptionWidthAi`（= `width_ai`）。
  これは `index3dMain.js: runPerceptionFusion` の**航空写真版ドロップイン**。
- `fetchAerialRoadSurface(features, opts)` → サーバから道路面 GeoJSON。
- `applyAerialRoadSurface(opts)` → `maskEdits.allow` に道路面補強を適用。

ブラウザ確認（コンソール）:
```js
import('./src/3d/roadSegClient.js').then(m => m.applyAerialWidthFusion()).then(console.log)
// または exposeRoadSegDebug() 後に window.roadSegApply()
window.roadSegSurfaceApply()
```
`window.ROAD_SEG_URL` で接続先を変更可（既定 http://127.0.0.1:8012）。

### 手順5: 階級表示（6m以上 / 4.5〜6 / 3.5〜4.5 / 3.5未満 / 不明）
`road_seg/width_class.py`（サーバ側）と `src/core/widthClass.js`（表示側）が**同一閾値**。
`classifyWidth(widthM, confidence)` で階級＋色。低信頼は「不明」に倒す。
サーバの summaries や `applyAerialWidthFusion` の戻り値に階級が入る。

---

## 差し替え1点で本番化
モデルは `RoadSegmenter.segment(rgb)->mask` だけ満たせば良い。
PoC(threshold) → 公開学習済み(手順1) → 微調整DeepLabV3+/U-Net(手順2) を、
`PretrainedRoadSegmenter(predict_fn=...)` の差し替えだけで段階移行できる。
幾何・タイル・エンドポイント・JS配線・階級表示はそのまま流用。

## ファイル
| ファイル | 役割 |
|---|---|
| `geo.py` | Web Mercatorタイル数学・**m/pixel換算**（精度の土台） |
| `measure.py` | OSM中心線へ垂線→マスク端まで測る**幾何の核** |
| `segmenter.py` | 差し替え式バックエンド（Synthetic/Threshold/Pretrained） |
| `tiles.py` | GSI seamlessphoto 取得・スティッチ・キャッシュ |
| `pipeline.py` | 道路群→widthSamples オーケストレーション |
| `width_class.py` | 5階級判定（JS版と同一閾値） |
| `weak_labels.py` | 基盤地図 道路縁→教師マスク（手順2） |
| `server.py` | `/segment_road_width` / `/segment_road_surface`（手順3, 独立FastAPI） |
| `surface.py` | 航空写真マスク→道路面補強GeoJSON（`maskEdits.allow`用） |
| `eval_real.py` | 実GSIで試算＋重畳PNG（手順1） |
| `selfcheck.py` | モデル無し幾何検証 |
| `smoke.py` | サーバAPIスモーク |
| `menu.py` | 日本語の対話メニュー（.bat から呼ばれる本体） |
| `../道路幅AI検証.bat` | ダブルクリック起動（ASCIIのみ、Python menu を呼ぶ） |
| `annotate.html` | 教師データ作成UI（地図→範囲取得→ブラシ修正→保存） |
| `rdcl.py` | GSI中心線→初期マスク下書き（幅員ランク別） |
| `dataset.py` | 教師データ(画像/マスク)の保存・件数・pending管理 |
| `train.py` | 貯めたペアで U-Net / DeepLabV3+ 学習（torch/smp、任意） |
| `infer.py` | 学習済みモデルの推論ラッパ（arch付きpredict_fn化） |
| `mcp_server.py` | Claude Code MCP 連携（統計・学習・比較・ZIP取込） |
| `MCP_CLAUDE_CODE.md` | Claude Code MCP の使い方 |
| `src/3d/roadSegClient.js` | 手順4 クライアント（幅融合 + 道路面allow補強） |
| `src/core/widthClass.js` | 手順5 表示側階級ヘルパー |
