# 道路規制データ更新運用

## 更新構成

`web_server.py` の起動中は `RegulationRefreshService` がバックグラウンドで動作する。
画面で新しい範囲を読むとAOIが登録され、以後はサーバー側で定期更新される。

| ソース | 既定間隔 | 用途 | 期限切れ時 |
|---|---:|---|---|
| OSM / Overpass | 15分 | 道路タグ、標識、barrier、stop、restriction relation | 6時間でstale、72時間でexpired |
| 警察庁交通規制基準 | 24時間 | 基準ページの改訂検知 | 変更時は要レビュー。意味を自動変更しない |
| JARTIC月次カタログ | 24時間 | typeD対象月、公開日、都道府県ZIP一覧の更新検知 | ZIP/CSV未取込なら公的データ未設定扱い |
| JARTIC Jシステム | 未設定 | 事故・工事等の動的規制 | 商用契約と接続設定が必要 |

公開Overpassだけで「規制なし」を確定しない。JARTIC月次データまたは契約済み動的規制が
未設定の場合、画面と搬入判定は `要確認` / `注意` を返す。

## API

```text
GET  /api/regulations/status?bbox=west,south,east,north
POST /api/regulations/refresh
```

強制更新:

```json
{"bbox":[139.762,35.679,139.766,35.683],"force":true}
```

レスポンスの `sources` には取得時刻、ソース基準時刻、age、state、件数、hash、endpoint、
改訂要確認状態を含む。`refresh` は実際に判定へ投入する `overpass` snapshotも返す。

## 保存と障害時動作

- 保存先: `runtime/regulations/`
- インデックス: `index.json`
- OSMスナップショット: `osm-<aoi>-<sha256>.json`（AOIごとに直近3版）
- 監査ログ: `audit.jsonl`
- 書込みは一時ファイルをfsyncしてから `os.replace` する。
- 更新失敗時はlast-known-goodを保持し、空配列で上書きしない。
- stale/expired/errorは規制判定へ渡し、取得失敗をPASSにしない。

## 環境変数

```text
REGULATION_OSM_REFRESH_SECONDS=900
REGULATION_OSM_STALE_SECONDS=21600
REGULATION_OSM_EXPIRED_SECONDS=259200
REGULATION_NPA_REFRESH_SECONDS=86400
REGULATION_JARTIC_REFRESH_SECONDS=86400
REGULATION_BACKGROUND_POLL_SECONDS=60
REGULATION_FETCH_TIMEOUT_SECONDS=30
REGULATION_MAX_RESPONSE_BYTES=8388608
REGULATION_MAX_BBOX_AREA_KM2=250
```

`start.sh`、`scripts/start_local.sh`、systemdのいずれでも `web_server.py` が起動すれば更新スレッドも起動する。
SSHホストでは `logistics-os-live.service` をユーザーsystemdへ登録済みで、8080番を自動起動する。

```bash
systemctl --user status logistics-os-live.service
systemctl --user restart logistics-os-live.service
```

## コンパイル済みワールド

- `compile_world.js` の規制Overpassキャッシュは15分、建物は6時間。
- `--refresh` で強制再取得できる。
- コンパイル済みworldを画面へ読む際も、保存規制をLKGとして保持した上で、管理APIから最新規制をmergeする。

```bash
node src/batch/compile_world.js --bbox west,south,east,north --refresh
```

## 公的データの境界

- 警察庁ページは規制設定基準であり、地点別規制DBではない。
- JARTIC月次カタログは自動監視するが、都道府県ZIPは大容量であり、対象県・保存容量・利用条件を
  確定するまでは自動取込しない。未取込状態はUIに表示する。
- 現在発生中の規制を継続取得するにはJARTIC Jシステム等の契約が必要。
- OSM利用時は画面に `© OpenStreetMap contributors` とODbLリンクを常時表示する。

参考:

- https://www.npa.go.jp/bureau/traffic/seibi2/kisei/mokuteki/mokuteki.html
- https://www.jartic.or.jp/service/opendata/
- https://www.jartic.or.jp/s/service/forcorporation/forcorporation01/
- https://wiki.openstreetmap.org/wiki/Overpass_API

## 検証

```bash
python3 -m unittest discover -s server -p 'test_*.py' -v
npm --prefix src/batch run regulation:detail
node src/batch/compile_world.js --selfcheck
```
