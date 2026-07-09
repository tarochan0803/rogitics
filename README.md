# LOGISTICS OS v8.0

LOGISTICS OS は、配送経路評価用の静的フロントエンド、YOLO/FastAPI 推論サーバー、バッチ補助ツールで構成された運用用アプリです。

## すぐ使う

1. `初回セットアップ.bat`
2. `config/runtime.example.json` を `config/runtime.local.json` にコピーして必要値を設定
3. `起動_ローカル.bat`
4. 停止時は `停止_ローカル.bat`

## 設定の優先順位

1. 環境変数
2. `config/runtime.local.json`
3. 旧 `user_config.js` の値

`user_config.js` は互換用の読み取り元としてのみ扱います。ブラウザ側の主設定は `runtime-config.js` と `web_server.py` から供給されます。

## 主なスクリプト

- `scripts/setup_local.ps1`: Windows ローカルセットアップ
- `scripts/start_local.ps1`: Windows ローカル起動
- `scripts/stop_local.ps1`: Windows ローカル停止
- `scripts/start_local.sh`: Linux ローカル起動
- `scripts/stop_local.sh`: Linux ローカル停止
- `scripts/build_release.ps1`: 配布用 ZIP 作成
- `scripts/deploy_remote.ps1`: SSH/SCP でリモート配布

## 配布

PowerShell から実行:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build_release.ps1
```

生成物は `dist/` に出力されます。

## リモート配布

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\deploy_remote.ps1 `
  -Host 192.168.2.116 `
  -User ncnadmin `
  -RemoteDir /home/ncnadmin/LOGISTICS_OS_v8.0 `
  -RestartServices
```

## ログ

- Windows: `runtime/logs/`
- Linux: `runtime/logs/`

## 補足

- ZIPS 資格情報はブラウザ側ではなくサーバー側で保持します
- `web_server.py` は `runtime-config.js` と ZIPS プロキシも提供します
