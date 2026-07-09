# Operations

## Local setup

Windows:

```powershell
.\初回セットアップ.bat
```

Linux:

```bash
python3 -m venv .venv
. .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r server/requirements.txt
```

## Runtime config

1. Copy `config/runtime.example.json` to `config/runtime.local.json`
2. Fill `public` values for browser-visible settings
3. Fill `server.zips` only on hosts that should use ZIPS

Supported environment variables override file values:

- `LOGISTICS_RUNTIME_CONFIG`
- `LOGISTICS_HOST`
- `WEB_PORT`
- `YOLO_PORT`
- `LOGISTICS_ALLOWED_ORIGINS`
- `LOGISTICS_PUBLIC_GOOGLE_MAPS_API_KEY`
- `LOGISTICS_PUBLIC_YOLO_URL`
- `LOGISTICS_PUBLIC_COMPANY_NAME`
- `LOGISTICS_PUBLIC_REPORTER_NAME`
- `LOGISTICS_DEFAULT_DRIVER_SKILL`
- `ZIPS_USER_ID`
- `ZIPS_PASSWORD`
- `ZIPS_SERVICE_ID`
- `ZIPS_DEVICE_FLAG`

## Local run

Windows:

```powershell
.\起動_ローカル.bat
.\停止_ローカル.bat
```

Linux:

```bash
./start.sh
./stop.sh
```

## Security — YOLO server authentication (Sprint1 P0-4)

The YOLO server (`server/app.py`) supports an optional `X-Api-Key`
header check controlled by the `YOLO_API_KEY` environment variable.

- When `YOLO_API_KEY` is **empty/unset**, the server runs without auth
  and prints a warning at startup. Acceptable only for trusted localhost
  use on a single workstation.
- When `YOLO_API_KEY` is **set**, every request except `GET /health`
  (and CORS pre-flights) must include `X-Api-Key: <value>`. Mismatch
  returns `401 invalid_api_key`.

Frontend wiring: `src/config.js` exposes `RUNTIME_CONFIG.yoloApiKey` and
the helper `yoloAuthHeaders()`. All YOLO calls
(`/detect-batch`, `/segment`, `/segment-batch`, `/voxel-collision`)
inject the header through this helper.

To enable auth on a workstation:

1. Generate a 32-byte random key:

   ```powershell
   [Convert]::ToBase64String((1..32 | %{ Get-Random -Maximum 256 }))
   ```

2. Set `YOLO_API_KEY` for the FastAPI process (recommended via
   `runtime.local.json` env-bag if your bootstrap supports it, else
   export inline in `起動_ローカル.bat`).

3. Set the same value as `yoloApiKey` in the per-PC `runtime-config.js`.

## Security — API keys (Sprint1 P0-3)

Client-side runtime configuration is loaded by browser-facing pages
(`index3D_V1.0.html` 等) from `runtime-config.js`.
This file is **Git ignored** and must never be committed.

Operational rules:

1. Use `runtime-config.sample.js` as the template. Each end-user PC keeps
   its own `runtime-config.js`.
2. The Google Maps API key embedded there is exposed to the browser. Apply
   **HTTP referrer restrictions** in Google Cloud Console (allow
   `http://localhost:8080/*` and any approved internal host) so a leaked
   key cannot be reused from other origins.
3. Never paste the key in Git, chat or email. Distribute via the company
   file share only.
4. When rotating the key, update both Google Cloud Console and the
   per-PC `runtime-config.js`. Record the change in the bottom comment
   block (`updatedAt` / `updatedBy`).
5. The YOLO server URL embedded there points at the per-PC FastAPI
   instance. If pointed at a shared host, ensure the server has
   `YOLO_API_KEY` set (Sprint1 P0-4) and that `yoloApiKey` here matches.

## Logs and PIDs

- Logs: `runtime/logs/`
- PID files: `runtime/pids/`

## Release

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build_release.ps1
```

## Remote deploy

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\deploy_remote.ps1 `
  -Host 192.168.2.116 `
  -User ncnadmin `
  -RemoteDir /home/ncnadmin/LOGISTICS_OS_v8.0 `
  -RestartServices
```
