# -*- coding: utf-8 -*-
"""Train an optional YOLO detector/segmenter on road_seg/dataset_yolo.

The training backend is intentionally optional. The current environment has
Ultralytics available, but the produced weights and use of the framework are
subject to that framework's license. Keep these weights isolated from the
main routing pipeline until the deployment license decision is made.
"""

from __future__ import annotations

import argparse
import json
import os
import sys

from . import yolo_dataset

MODELS_YOLO_DIR = os.path.join(os.path.dirname(__file__), "models_yolo")


try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def _load_ultralytics():
    try:
        from ultralytics import YOLO
        import ultralytics
        return YOLO, getattr(ultralytics, "__version__", "unknown")
    except Exception as exc:
        print("Ultralytics YOLO が未導入です。")
        print("導入例:")
        print("  PYENV_VERSION=fa-env python -m pip install ultralytics")
        print(f"import error: {exc}")
        return None, None


def main() -> int:
    ap = argparse.ArgumentParser(description="航空写真/地図要素のYOLO detect/segment 学習")
    ap.add_argument("--task", default="segment", choices=["detect", "segment"],
                    help="detect=箱検出 / segment=多角形セグメンテーション")
    ap.add_argument("--model", default="",
                    help="初期モデル。空なら task に応じて yolo11n.pt / yolo11n-seg.pt")
    ap.add_argument("--epochs", type=int, default=80)
    ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--batch", default="auto",
                    help="auto または整数。GPUメモリ不足時は 4/8 などへ下げる。")
    ap.add_argument("--device", default="auto", help="auto | cpu | 0 | 0,1 など")
    ap.add_argument("--val-ratio", type=float, default=0.2)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--project", default=MODELS_YOLO_DIR)
    ap.add_argument("--name", default="aerial_elements")
    ap.add_argument("--patience", type=int, default=30)
    ap.add_argument("--workers", type=int, default=2)
    args = ap.parse_args()
    if not args.model:
        args.model = "yolo11n-seg.pt" if args.task == "segment" else "yolo11n.pt"

    YOLO, version = _load_ultralytics()
    if YOLO is None:
        return 2

    st = yolo_dataset.stats()
    sample_key = "trainableSegmentSamples" if args.task == "segment" else "trainableSamples"
    label_key = "trainableSegments" if args.task == "segment" else "trainableBoxes"
    samples = int(st.get(sample_key, 0))
    labels = int(st.get(label_key, 0))
    if samples < 2:
        print(f"YOLO {args.task} 教師データが少なすぎます（reviewed {samples}件）。")
        print("先にメニュー8で『未修正タイルを開く』→ ラベル修正 → 保存してください。未修正タイルは学習から除外します。")
        return 2
    if labels < 1:
        print(f"YOLO {args.task} ラベルが0件です。空ラベルだけではモデルを学習できません。")
        return 2
    if samples < 50:
        print(f"注意: まだ {samples} 件です。動作確認はできますが、実用精度には数百件以上が目安です。")

    split = yolo_dataset.prepare_split(val_ratio=args.val_ratio, seed=args.seed, task=args.task)
    print(json.dumps({"dataset": split, "stats": st}, ensure_ascii=False, indent=2))
    print("YOLO学習を開始します。商用投入前にYOLO実装/重みのライセンスを必ず確認してください。")

    os.makedirs(args.project, exist_ok=True)
    model = YOLO(args.model)
    batch = -1 if str(args.batch).strip().lower() == "auto" else int(args.batch)
    train_kwargs = {
        "data": split["yaml"],
        "epochs": int(args.epochs),
        "imgsz": int(args.imgsz),
        "batch": batch,
        "project": args.project,
        "name": args.name,
        "patience": int(args.patience),
        "workers": int(args.workers),
        "seed": int(args.seed),
        "task": args.task,
    }
    if str(args.device).strip().lower() != "auto":
        train_kwargs["device"] = args.device
    result = model.train(**train_kwargs)
    save_dir = str(getattr(result, "save_dir", "") or "")
    meta = {
        "backend": "ultralytics",
        "ultralyticsVersion": version,
        "task": args.task,
        "model": args.model,
        "epochs": args.epochs,
        "imgsz": args.imgsz,
        "batch": args.batch,
        "device": args.device,
        "split": split,
        "saveDir": save_dir,
    }
    yolo_dataset.write_last_train(meta)
    print("\n完了。YOLO学習結果:")
    print(save_dir or os.path.abspath(args.project))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
