#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

MCP_PY="$ROOT/.mcp-venv/bin/python"
if [[ ! -x "$MCP_PY" ]]; then
  python3 -m venv "$ROOT/.mcp-venv"
  "$MCP_PY" -m pip install --upgrade pip
  "$MCP_PY" -m pip install 'mcp>=1.0'
fi

if [[ -z "${ROAD_SEG_PYTHON:-}" ]]; then
  if command -v pyenv >/dev/null 2>&1 && pyenv prefix fa-env >/dev/null 2>&1; then
    export ROAD_SEG_PYTHON="$(pyenv prefix fa-env)/bin/python"
  else
    export ROAD_SEG_PYTHON="python3"
  fi
fi

exec "$MCP_PY" "$ROOT/road_seg/mcp_server.py"
