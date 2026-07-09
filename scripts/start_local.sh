#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="$ROOT_DIR/runtime"
LOG_DIR="$RUNTIME_DIR/logs"
PID_DIR="$RUNTIME_DIR/pids"

WEB_PORT="${WEB_PORT:-8080}"
YOLO_PORT="${YOLO_PORT:-8001}"
LOGISTICS_HOST="${LOGISTICS_HOST:-127.0.0.1}"
LOGISTICS_RUNTIME_CONFIG="${LOGISTICS_RUNTIME_CONFIG:-$ROOT_DIR/config/runtime.local.json}"

mkdir -p "$LOG_DIR" "$PID_DIR"

if [[ -x "$ROOT_DIR/.venv/bin/python" ]]; then
  PYTHON="$ROOT_DIR/.venv/bin/python"
else
  PYTHON="${PYTHON:-python3}"
fi

port_open() {
  python3 - "$1" "$2" <<'PY'
import socket, sys
host = sys.argv[1]
port = int(sys.argv[2])
s = socket.socket()
s.settimeout(0.7)
try:
    s.connect((host, port))
    sys.exit(0)
except OSError:
    sys.exit(1)
finally:
    s.close()
PY
}

wait_port() {
  local host="$1" port="$2" name="$3" tries=40
  for _ in $(seq 1 "$tries"); do
    if port_open "$host" "$port"; then
      return 0
    fi
    sleep 0.5
  done
  echo "[error] $name did not become ready on $host:$port" >&2
  exit 1
}

if ! port_open 127.0.0.1 "$YOLO_PORT"; then
  (
    cd "$ROOT_DIR/server"
    PORT="$YOLO_PORT" WEB_PORT="$WEB_PORT" nohup "$PYTHON" app.py >"$LOG_DIR/yolo.out.log" 2>"$LOG_DIR/yolo.err.log" &
    echo $! >"$PID_DIR/yolo.pid"
  )
  wait_port 127.0.0.1 "$YOLO_PORT" "YOLO server"
else
  echo "[skip] YOLO already listening on 127.0.0.1:$YOLO_PORT"
fi

if ! port_open "$LOGISTICS_HOST" "$WEB_PORT"; then
  (
    cd "$ROOT_DIR"
    LOGISTICS_HOST="$LOGISTICS_HOST" YOLO_PORT="$YOLO_PORT" WEB_PORT="$WEB_PORT" LOGISTICS_RUNTIME_CONFIG="$LOGISTICS_RUNTIME_CONFIG" \
      nohup "$PYTHON" web_server.py "$WEB_PORT" >"$LOG_DIR/web.out.log" 2>"$LOG_DIR/web.err.log" &
    echo $! >"$PID_DIR/web.pid"
  )
  wait_port "$LOGISTICS_HOST" "$WEB_PORT" "Web server"
else
  echo "[skip] Web already listening on $LOGISTICS_HOST:$WEB_PORT"
fi

echo "[ready] app  : http://$LOGISTICS_HOST:$WEB_PORT/index9.0.html"
echo "[ready] yolo : http://127.0.0.1:$YOLO_PORT/status"
echo "[ready] logs : $LOG_DIR"
