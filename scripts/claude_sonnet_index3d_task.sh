#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ $# -lt 1 ]]; then
  cat >&2 <<'USAGE'
Usage:
  scripts/claude_sonnet_index3d_task.sh "実装してほしい内容"
  scripts/claude_sonnet_index3d_task.sh --prompt-file task.txt

This delegates an index3D_V2.0 task to Claude Code Sonnet.
The supervising agent must review the result afterward.
USAGE
  exit 2
fi

if [[ "${1:-}" == "--prompt-file" ]]; then
  if [[ $# -ne 2 || ! -f "$2" ]]; then
    echo "--prompt-file requires an existing file" >&2
    exit 2
  fi
  TASK_TEXT="$(cat "$2")"
else
  TASK_TEXT="$*"
fi

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
RUN_DIR="$ROOT/runtime/claude_delegate/$RUN_ID"
mkdir -p "$RUN_DIR"

cat >"$RUN_DIR/task.txt" <<EOF_TASK
$TASK_TEXT
EOF_TASK

cat >"$RUN_DIR/prompt.txt" <<'EOF_PROMPT'
You are coding inside LOGISTICS_OS_v8.0.

Primary target:
- index3D_V2.0.html is the current app entry.
- It loads src/index3dMain.js and ES modules under src/.

Rules:
- Implement only the requested change.
- Keep edits narrowly scoped to index3D_V2.0.html and directly relevant src/ modules.
- Do not rewrite unrelated UI, road_seg training code, package metadata, generated outputs, or datasets.
- Preserve existing Japanese UI tone.
- Avoid destructive git commands.
- After editing, run the smallest relevant checks you can:
  - node --check for changed JS files
  - Python py_compile only if Python files are changed
  - existing smoke scripts if the change touches their path
- In the final response, list changed files, checks run, and residual risks.

Requested change:
EOF_PROMPT
cat "$RUN_DIR/task.txt" >>"$RUN_DIR/prompt.txt"

claude \
  --print \
  --model sonnet \
  --permission-mode acceptEdits \
  --mcp-config "$ROOT/.mcp.json" \
  --output-format text \
  "$(cat "$RUN_DIR/prompt.txt")" \
  | tee "$RUN_DIR/claude_output.txt"

echo
echo "Claude delegate run saved to: $RUN_DIR"
