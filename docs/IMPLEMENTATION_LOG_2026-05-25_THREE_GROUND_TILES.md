# 2026-05-25 3D Ground Tile Implementation Log

## Goal

2D地図で見ている衛星写真タイルに近い見た目を、Three.js 3Dビューの地面にも使えるようにする。

## Implemented

- `src/ui/map3dThree.js`
  - 3D地面テクスチャの取得元を、Google APIキーがある場合は Google Map Tiles API の 2D Tiles `mapType=satellite` に変更。
  - Google 2D Tiles が失敗した場合は、従来どおり GSI `seamlessphoto` にフォールバック。
  - Google 2D Tiles の `createSession` レスポンスから `session` と `tileWidth/tileHeight` を保持。
  - 2D tile取得URLから無効だった `orientation=0` を削除。
  - 経路・建物が未ロードの状態で3Dを開いた場合、固定座標ではなく現在のLeaflet地図中心を3D原点として使うように変更。
  - 3Dパネルの `#tilesStatus` に使用タイル種別、ズーム、取得枚数を表示。

## Important Behavior

- 2DのDOM上にあるGoogleMutantタイルを直接コピーしているわけではない。
- CORSやタイルDOM構造の都合で直接再利用は不安定なため、3D側では同じGoogle衛星系の公式 2D Tiles APIから再取得してThree.js地面に貼る。
- Google APIキー、Map Tiles API、通信が使えない場合は `gsi-seamlessphoto` に自動フォールバックする。

## Verification

Commands:

```powershell
node --check src\ui\map3dThree.js
```

Result:

- Syntax check: OK
- `http://127.0.0.1:8080/index9.0.html`: HTTP 200

Puppeteer smoke:

- Page: `http://127.0.0.1:8080/index9.0.html`
- 3D open: OK
- Canvas visible: `538 x 558`
- Map center before/opened: `lat=35.68, lng=139.76, zoom=14`
- Tile status: `3D ground: google-2d-satellite z18 (49/49 tiles)`
- Browser page errors: none
- Console:
  - `[three3d] ready (lazy init on open)`
  - `[three3d] scene built: buildings=0, roads=0, routePts=0`
  - `[three3d] satellite ground loaded: google-2d-satellite z18 (49/49)`

Screenshot:

- `runtime/logs/index9_3d_current_tile_center_1440.png`

## Remaining Notes

- 2D Leafletはズーム14でも、3D地面は見た目の密度を確保するため `z18` 以上にクランプしている。
- 経路がある場合は経路始点を3D原点にする。経路がない場合は建物、建物もない場合は現在の2D地図中心を使う。
