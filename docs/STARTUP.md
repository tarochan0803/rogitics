# LOGISTICS OS 起動方法と確認手順

最終確認日: 2026-05-22

## 対象アプリ

- ルート: `C:\Users\t.kawaguchi\Desktop\つくったもの\truck\LOGISTICS_OS_v8.0`
- 画面: `index9.0.html`
- ローカルURL: `http://127.0.0.1:8080/index9.0.html`
- 旧画面: `http://127.0.0.1:8080/index8.2.html`
- YOLO / GPU補助API: `http://127.0.0.1:8001` または `http://192.168.2.116:8001`
- ローカル起動時の上書き設定: `config\runtime.local.json`

## 今回の起動確認結果

ローカル起動は確認済みです。

- `python -m py_compile web_server.py server\app.py server\runtime_settings.py server\zips_proxy.py`: PASS
- `node --check` 全 `src/**/*.js`: PASS
- `npm run golden:dry`: PASS
- `http://127.0.0.1:8080/index9.0.html`: HTTP 200
- `http://127.0.0.1:8080/runtime-config.js`: HTTP 200
- `http://127.0.0.1:8001/status`: HTTP 200, YOLO model loaded, segmentation model loaded
- `http://127.0.0.1:8001/voxel-collision`: HTTP 200
- ブラウザベンチ `tokyo-station-short-4t`: completed 1/1, errors 0, failedExpectations 0

補足: ベンチの判定ステータスは `NG` でしたが、これはルート判定結果です。アプリ起動、経路生成、判定処理そのものはエラーなく完了しています。

## リモートGPU確認結果

`192.168.2.116` は今回の確認時点では到達できませんでした。

- `192.168.2.116:8001`: unreachable
- `192.168.2.116:8787`: unreachable
- `192.168.2.116:8080`: unreachable
- `192.168.2.116:22`: unreachable

そのため、ローカルアプリの起動は確認済みですが、`192.168.2.116` 側のGPU / YOLO / voxel APIが実際に動作しているかは、ホストがネットワーク上で見える状態になってから再確認が必要です。

ローカル起動では `config\runtime.local.json` により、ブラウザ側の `yoloServerUrl` / `remoteVoxelServerUrl` を `http://127.0.0.1:8001` に上書きします。これにより、`user_config.js` にリモートIPが残っていてもローカルYOLOを使います。

## 初回セットアップ

Windowsでは、以下のどちらかを実行します。

```powershell
.\初回セットアップ.bat
```

または:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup_local.ps1
```

## ローカル起動

通常は以下を実行します。

```powershell
.\起動_ローカル.bat
```

直接PowerShellから起動する場合:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start_local.ps1 -BindHost 127.0.0.1 -WebPort 8080 -YoloPort 8001
```

起動後、ブラウザで開きます。

```text
http://127.0.0.1:8080/index9.0.html
```

既にブラウザで開いていた場合は、`Ctrl+F5` でハードリロードします。タイトルと左上ブランド表示が `LOGISTICS OS v9.0` になっていれば新しいHTMLです。

## ローカル停止

```powershell
.\停止_ローカル.bat
```

または:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\stop_local.ps1
```

## ローカル起動確認

```powershell
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8080/index9.0.html
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8080/runtime-config.js
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8001/health
```

コードの構文確認:

```powershell
python -m py_compile web_server.py server\app.py server\runtime_settings.py server\zips_proxy.py
rg --files src -g "*.js" | ForEach-Object { node --check $_ }
```

ブラウザを使わないベンチ確認:

```powershell
cd src\batch
npm run golden:dry
```

ブラウザ込みのスモーク確認:

```powershell
cd src\batch
node run_golden_benchmark.js --case tokyo-station-short-4t --timeout 180000
```

## リモート起動とデプロイ

`192.168.2.116` を使う場合は、まずこのPCから到達できる必要があります。

```powershell
Test-NetConnection 192.168.2.116 -Port 22
Test-NetConnection 192.168.2.116 -Port 8001
Test-NetConnection 192.168.2.116 -Port 8080
```

メニューから操作する場合:

```powershell
.\起動.bat
```

直接デプロイする場合:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\deploy_remote.ps1 `
  -Host 192.168.2.116 `
  -User ncnadmin `
  -RemoteDir /home/ncnadmin/LOGISTICS_OS_v8.0 `
  -RestartServices
```

リモート側の確認URL:

```text
http://192.168.2.116:8080/index9.0.html
http://192.168.2.116:8001/status
```

`/status` で `gpu.cuda: true` と `voxel_endpoint: /voxel-collision` が見えれば、GPU補助のvoxel APIが使える状態です。

## ログ

ローカル起動時のログは以下に出ます。

```text
runtime\logs\web.out.log
runtime\logs\web.err.log
runtime\logs\yolo.out.log
runtime\logs\yolo.err.log
```

起動できない場合は、まず `web.err.log` と `yolo.err.log` を確認します。

## 注意点

- 既にポート `8080` または `8001` が使われている場合、`start_local.ps1` は既存プロセスを検出してスキップします。
- ローカル起動時の `runtime-config.js` は `yoloServerUrl` と `remoteVoxelServerUrl` を `http://127.0.0.1:8001` に向けます。
- `192.168.2.116` を使う場合は、`config\runtime.local.json` または環境変数 `LOGISTICS_PUBLIC_YOLO_URL` / `LOGISTICS_PUBLIC_REMOTE_VOXEL_URL` をリモートURLへ変更し、Webサーバを再起動します。
- WebGPU / リモートvoxelは失敗時にCPU側へフォールバックします。ただしYOLOによる道路幅推定は、YOLOサーバが見えないと実機確認できません。
