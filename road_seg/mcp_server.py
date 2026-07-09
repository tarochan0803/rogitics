# -*- coding: utf-8 -*-
"""Claude Code MCP bridge for road_seg workflows.

This server intentionally keeps heavy road_seg imports out of the MCP process.
Tools shell out to ROAD_SEG_PYTHON so the MCP SDK can live in its own venv
without fighting FastAPI/Starlette versions used by the app.
"""

from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
import time
import zipfile
from pathlib import Path

from mcp.server.fastmcp import FastMCP


ROOT = Path(__file__).resolve().parents[1]
ROAD_SEG = ROOT / "road_seg"
DATASET = ROAD_SEG / "dataset"
RUNTIME = ROOT / "runtime" / "road_seg_mcp"
PID_FILE = RUNTIME / "label_server.pid"
LOG_FILE = RUNTIME / "label_server.log"
DEFAULT_PYTHON = os.environ.get("ROAD_SEG_PYTHON") or "/home/ncnadmin/.pyenv/versions/fa-env/bin/python"

mcp = FastMCP("logistics-road-seg")


def _run(args: list[str], *, timeout: int = 300) -> dict:
    env = os.environ.copy()
    env.setdefault("PYENV_VERSION", "fa-env")
    proc = subprocess.run(
        [DEFAULT_PYTHON, *args],
        cwd=str(ROOT),
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
    )
    return {
        "ok": proc.returncode == 0,
        "returncode": proc.returncode,
        "stdout": proc.stdout[-12000:],
        "stderr": proc.stderr[-12000:],
    }


def _safe_member_path(base: Path, member: str) -> Path:
    path = (base / member).resolve()
    base_resolved = base.resolve()
    if base_resolved != path and base_resolved not in path.parents:
        raise ValueError(f"unsafe zip path: {member}")
    return path


@mcp.tool()
def road_seg_dataset_stats() -> dict:
    """Return manual/weak dataset counts and current model metadata."""

    code = (
        "from road_seg import dataset; import json; "
        "print(json.dumps(dataset.stats(), ensure_ascii=False, indent=2))"
    )
    out = _run(["-c", code], timeout=60)
    if not out["ok"]:
        return out
    try:
        out["stats"] = json.loads(out["stdout"])
    except Exception:
        pass
    return out


@mcp.tool()
def road_seg_selfcheck() -> dict:
    """Run the no-network road_seg geometry self-check."""

    return _run(["-m", "road_seg.selfcheck"], timeout=120)


@mcp.tool()
def road_seg_smoke() -> dict:
    """Run the in-process road_seg API smoke test."""

    return _run(["-m", "road_seg.smoke"], timeout=180)


@mcp.tool()
def road_seg_compare_models(sites: str = "site0008,site0019", no_threshold: bool = False) -> dict:
    """Compare configured road-surface models on teacher sites and write overlays."""

    args = ["-m", "road_seg.compare_models", "--sites", sites]
    if no_threshold:
        args.append("--no-threshold")
    return _run(args, timeout=600)


@mcp.tool()
def road_seg_train_mixed(
    arch: str = "unet",
    epochs: int = 30,
    manual_repeat: int = 8,
    weak_limit: int = 0,
    out: str = "",
) -> dict:
    """Train from manual labels plus weak labels. Use out for comparison models."""

    args = [
        "-m",
        "road_seg.train_mixed",
        "--arch",
        arch,
        "--epochs",
        str(int(epochs)),
        "--manual-repeat",
        str(int(manual_repeat)),
    ]
    if int(weak_limit) > 0:
        args += ["--weak-limit", str(int(weak_limit))]
    if out:
        args += ["--out", out]
    return _run(args, timeout=7200)


@mcp.tool()
def road_seg_start_label_server(port: int = 8012) -> dict:
    """Start the annotation/API server in the background and return the local URL."""

    RUNTIME.mkdir(parents=True, exist_ok=True)
    if PID_FILE.exists():
        try:
            old_pid = int(PID_FILE.read_text(encoding="utf-8").strip())
            os.kill(old_pid, 0)
            return {"ok": True, "alreadyRunning": True, "pid": old_pid, "url": f"http://127.0.0.1:{int(port)}/annotate/ui"}
        except Exception:
            PID_FILE.unlink(missing_ok=True)

    env = os.environ.copy()
    env.setdefault("PYENV_VERSION", "fa-env")
    log = open(LOG_FILE, "a", encoding="utf-8")
    proc = subprocess.Popen(
        [DEFAULT_PYTHON, "-m", "uvicorn", "road_seg.server:app", "--port", str(int(port))],
        cwd=str(ROOT),
        env=env,
        stdout=log,
        stderr=subprocess.STDOUT,
        text=True,
        start_new_session=True,
    )
    PID_FILE.write_text(str(proc.pid), encoding="utf-8")
    return {
        "ok": True,
        "pid": proc.pid,
        "url": f"http://127.0.0.1:{int(port)}/annotate/ui",
        "log": str(LOG_FILE),
    }


@mcp.tool()
def road_seg_stop_label_server() -> dict:
    """Stop the annotation/API server started by road_seg_start_label_server."""

    if not PID_FILE.exists():
        return {"ok": True, "stopped": False, "reason": "pid file not found"}
    pid = int(PID_FILE.read_text(encoding="utf-8").strip())
    try:
        os.killpg(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    except Exception:
        try:
            os.kill(pid, signal.SIGTERM)
        except Exception as exc:
            return {"ok": False, "error": str(exc), "pid": pid}
    time.sleep(0.5)
    PID_FILE.unlink(missing_ok=True)
    return {"ok": True, "stopped": True, "pid": pid}


@mcp.tool()
def road_seg_import_label_dataset_zip(zip_path: str, dry_run: bool = True, overwrite: bool = False) -> dict:
    """Merge a returned labeler ZIP into road_seg/dataset safely.

    The ZIP may contain road_seg/dataset/images|masks|meta or dataset/images|masks|meta.
    dry_run defaults to true; set false to actually copy files.
    """

    zp = Path(zip_path).expanduser().resolve()
    if not zp.exists():
        return {"ok": False, "error": f"zip not found: {zp}"}
    wanted = {"images", "masks", "meta"}
    planned: list[dict] = []
    skipped: list[dict] = []
    with zipfile.ZipFile(zp) as zf:
        for info in zf.infolist():
            if info.is_dir():
                continue
            parts = Path(info.filename).parts
            target_kind = None
            rel_name = None
            for idx, part in enumerate(parts):
                if part in wanted and idx + 1 < len(parts):
                    if idx > 0 and parts[idx - 1] == "dataset" or "dataset" in parts[:idx]:
                        target_kind = part
                        rel_name = "/".join(parts[idx + 1:])
                        break
            if not target_kind or not rel_name:
                continue
            dest = _safe_member_path(DATASET / target_kind, rel_name)
            exists = dest.exists()
            item = {"kind": target_kind, "name": rel_name, "dest": str(dest), "exists": exists}
            if exists and not overwrite:
                skipped.append(item)
            else:
                planned.append(item)
                if not dry_run:
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    with zf.open(info) as src, open(dest, "wb") as dst:
                        shutil.copyfileobj(src, dst)
    return {
        "ok": True,
        "dryRun": bool(dry_run),
        "overwrite": bool(overwrite),
        "plannedCount": len(planned),
        "skippedCount": len(skipped),
        "planned": planned[:100],
        "skipped": skipped[:100],
    }


@mcp.tool()
def road_seg_make_labeling_handoff(out_path: str = "dist/road_seg_labeling_handoff_latest.zip") -> dict:
    """Build a minimal ZIP that can be sent to labelers."""

    out = (ROOT / out_path).resolve() if not os.path.isabs(out_path) else Path(out_path).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    include_files = [
        ROOT / "道路幅AIラベル作成.bat",
        ROOT / "道路幅AI検証.bat",
        ROAD_SEG / "HANDOFF_FOR_LABELERS.md",
        ROAD_SEG / "README.md",
        ROAD_SEG / "annotate.html",
        ROAD_SEG / "requirements.txt",
    ]
    include_files.extend(sorted(ROAD_SEG.glob("*.py")))

    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("LOGISTICS_OS_road_labeling/README_協力者向け.txt", (ROAD_SEG / "HANDOFF_FOR_LABELERS.md").read_text(encoding="utf-8"))
        for src in include_files:
            if not src.exists():
                continue
            rel = Path("LOGISTICS_OS_road_labeling") / src.relative_to(ROOT)
            zf.write(src, rel)
        for sub in ["images", "masks", "meta", ".pending"]:
            zf.writestr(f"LOGISTICS_OS_road_labeling/road_seg/dataset/{sub}/", "")
    return {"ok": True, "zip": str(out), "sizeBytes": out.stat().st_size}


if __name__ == "__main__":
    mcp.run()
