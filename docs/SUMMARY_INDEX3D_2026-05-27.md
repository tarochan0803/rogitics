# index3D_V1.0 これまでの作業まとめ（〜2026-05-27）

3Dシミュレーター主体の新エントリ `index3D_V1.0.html` を、フェーズ単位で実装・検証してきた記録の総括。
各フェーズは「単体で起動・自動確認できる状態」にしてから次へ進む方針（`docs/VERIFY_INDEX3D_PHASE_N.md`）。

## エントリ / 構成
- 画面: `index3D_V1.0.html` / `index3D_V1.0.css` / `src/index3dMain.js`
- 2D地図(Leaflet)で経路を作り確定 → 経路周辺だけを3D化(Three.js) → トラック走行
- 経路確定までは index9.0 と同じフロー（`controls.js`）を流用
- 検証: `src/batch/run_index3d_smoke.js`（phase別フック）、`run_index3d_benchmark.js`（golden 3D）

## フェーズ実装
- **Phase 0/1**: 小範囲AOIの3Dサンドボックス。道路面・建物・経路・トラック表示、kinematic bicycle で走行。
- **Phase 2 (3D Road Quality)**: 道路ごとの採用幅と根拠（OSM実測/車線/種別/YOLO/手動）を `roadWidthReport.js` でUI表示。手動幅上書きで3D走行面が即時更新（キャッシュ署名に幅上書きを反映）。
- **Phase 3 (建物・障害物)**: `clearanceSolids.js`。建物ソリッド/地上障害物/頭上クリアランスを分離。車高・積荷高と照合。
- **Phase 4 (Autonomy v1)**: `behaviorPlanner.js`。前方センサー、許容速度、停止/減速、操舵飽和をレポート化し3D走行へ反映。
- **Phase 5 (Perception Fusion)**: `perceptionFusion.js`。Street View/YOLO（または合成）を「幅候補(width_ai)」「障害物(maskEdits.deny)」に変換。高信頼のみ自動採用、低信頼は確認待ち。実SV/YOLOブリッジ（`streetviewScan.js`）も追加。
- **Phase 6 (Benchmark)**: `index3d-golden-routes.json` + `run_index3d_benchmark.js`。load time/FPS/contact/clearance/stop/slow/steering saturation/reverse/yoloCoverage を出力。`CONFIRMED_PASS/FAIL/MEASURE` ケース。
- **Phase 7 (Recovery: reverse/replan)**: STOPゾーンで後退+切り返しを試行し、地上障害物は復旧（reverseCount実値化）、頭上クリアランス不足は復旧不可。ライブ走行で実際に後退→復帰再生。

## レビュー指摘対応（実バグ修正）
- 復旧再生が STOP 地点で**デッドロック**（drivePoseModeで progressM が巻き戻る）→ 速度ゲート開放+driveTimeS同期で解消。
- 「補正をクリア」が**幅補正(width_ai)を戻さない** → 適用道路IDを記録し一括クリア。
- YOLO障害物が消えない（コロン入りID）→ `removeMaskEdit` のID分離修正。
- 経路クリアで古い3D/autonomyが残る → `resetSimAfterRouteChange()` で再生停止・知覚クリア・再描画。
- 幅/障害物適用の毎回フル再計算 → `setWidthOverrides`/`setMaskEdits` で一括化。
- 実SV/YOLO成否がUIで不明 → パネルに source/key有無/frames/検出数/失敗理由を表示。
- PASSデモで接触1 → 衝突用建物を道路面でクリップし接触0、`maxContactCount:0` に厳格化。

## トラック挙動
- 横滑り（カニ歩き）を解消。**通常走行は物理モデル(後輪軸バイシクル)の向き**をそのまま使い、横回避・切り返しの逸脱時のみ実移動方向へ追従（操舵角速度上限つき）。後退時は前方を向いたまま下がる。

## UI/UX
- 右パネルをアコーディオン化（長いセクションは初期折りたたみ）。
- 3D化前は知覚スキャン系ボタンを無効化。
- Autonomyパネルを「静的判定」と「現在走行状態」に分離。

## PLATEAU 3D Tiles 統合（建物の見た目）
方針: PLATEAUの3D Tilesを低品質ストリーミングで建物表示、カバー外/失敗時はOSM押し出しにフォールバック。**衝突判定はOSMフットプリントのまま**（軽量・判定安定）。

解決した非互換（順に）:
1. 参考の `3d-tiles-renderer@0.22.0` は実在しない → 実在版へ。
2. `estimateBytesUsed` 未export → THREE版を上げる必要。
3. 参考の配信URLが全404 → **実行時解決**（GSI逆ジオコーダで自治体コード→PLATEAU datacatalog GraphQLで建物tileset URL。`assets.cms.plateau.reearth.io` の現行データ。日本中の対応自治体に自動対応。全CORS `*`）。
4. THREE多重インスタンス衝突 → **importmapで単一インスタンス化**（`three@0.167` をモジュール化し `window.THREE` に公開、tiles-rendererも `?external=three` で共有）。
5. モジュール名前空間が読み取り専用 → ミュータブルコピーで公開。
6. `three/examples/jsm` `three/addons` 解決 → importmapプレフィックス。
7. region型タイルセット解析エラー → region対応の **3d-tiles-renderer@0.4.27 + three@0.167** へ。
8. PLATEAUのDraco圧縮 → `GLTFExtensionsPlugin` + `DRACOLoader` を登録。
9. 建物が鉛直に浮く（ジオイド/地形標高オフセット）→ 読込タイルのbboxで**接地自動補正**（`window.PLATEAU_Y_OFFSET` で微調整可）。

最終構成: `three@0.167` + `3d-tiles-renderer@0.4.27`（単一インスタンス・importmap）、自治体自動解決、Draco対応、接地補正、OSMフォールバック。
スモークはPLATEAUを `window.PLATEAU_DISABLE` で無効化し、OSM経路の回帰を検証（PLATEAUはブラウザ実機で目視確認）。

## 検証コマンド
```
node --check <変更ファイル>
cd src/batch
npm run golden:dry
npm run index3d:smoke               # 基本起動
npm run index3d:smoke:phase7-playback  # 全phase + 実走行復旧
npm run index3d:benchmark           # 3D golden
```
直近: phase7-playback 全PASS、benchmark 3/3 failedExpectations=0、golden:dry OK。

## 既知の残課題 / 次の候補
- PLATEAU建物の**位置/高さ整合の実機確認**（Zずれ→接地補正済み、横ズレあれば ECEF→ローカル整合を微調整）。
- 実 Street View / YOLO サーバ接続の精度（路面/建物フィルタ、複数フレーム中央値）。
- 復旧判定を後退〜復帰の全pose掃引（フットプリント検査）へ高精度化。
- 2D地図にAOI/道路取得範囲の可視枠。
- `CONFIRMED_*` を現場実測ルートで固定（合成fixtureは SYNTHETIC_* へ）。
