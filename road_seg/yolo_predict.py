# -*- coding: utf-8 -*-
"""Prediction helper for trained YOLO aerial-element models."""

from __future__ import annotations

import glob
import json
import os
from typing import Any

from . import yolo_dataset

MODELS_YOLO_DIR = os.path.join(os.path.dirname(__file__), "models_yolo")


def _load_ultralytics():
    try:
        from ultralytics import YOLO
        return YOLO
    except Exception as exc:
        raise RuntimeError(f"Ultralytics YOLO is not available: {exc}") from exc


def find_latest_weights() -> str | None:
    candidates: list[str] = []
    meta = yolo_dataset.LAST_TRAIN_META
    if os.path.exists(meta):
        try:
            with open(meta, encoding="utf-8") as f:
                data = json.load(f)
            save_dir = data.get("saveDir")
            if save_dir:
                p = os.path.join(str(save_dir), "weights", "best.pt")
                if os.path.exists(p):
                    candidates.append(p)
        except Exception:
            pass
    candidates.extend(glob.glob(os.path.join(MODELS_YOLO_DIR, "**", "weights", "best.pt"), recursive=True))
    candidates = sorted(set(candidates), key=lambda p: os.path.getmtime(p), reverse=True)
    return candidates[0] if candidates else None


def available() -> bool:
    return bool(find_latest_weights())


def _box_dict(xyxy, class_id: int, confidence: float) -> dict:
    x1, y1, x2, y2 = [float(v) for v in xyxy]
    return {
        "classId": int(class_id),
        "x": x1,
        "y": y1,
        "w": max(0.0, x2 - x1),
        "h": max(0.0, y2 - y1),
        "confidence": float(confidence),
    }


def _polygon_dict(points: Any, class_id: int, confidence: float) -> dict | None:
    out = []
    for p in points or []:
        try:
            x = float(p[0])
            y = float(p[1])
        except Exception:
            continue
        out.append({"x": x, "y": y})
    if len(out) < 3:
        return None
    return {"classId": int(class_id), "points": out, "confidence": float(confidence)}


def predict_sample(sample_id: str, *, conf: float = 0.25, imgsz: int = 640) -> dict:
    image_path = yolo_dataset.image_path_for_id(sample_id)
    if not image_path:
        raise FileNotFoundError(f"sample image not found: {sample_id}")
    weights = find_latest_weights()
    if not weights:
        raise FileNotFoundError("trained YOLO weights not found. Train with menu 9 first.")

    YOLO = _load_ultralytics()
    model = YOLO(weights)
    results = model.predict(source=image_path, conf=float(conf), imgsz=int(imgsz), verbose=False)
    boxes: list[dict] = []
    polygons: list[dict] = []
    if not results:
        return {"id": sample_id, "weights": weights, "boxes": boxes, "polygons": polygons}

    result = results[0]
    cls_vals = []
    conf_vals = []
    xyxy_vals = []
    if getattr(result, "boxes", None) is not None and result.boxes is not None:
        try:
            cls_vals = result.boxes.cls.detach().cpu().numpy().tolist()
            conf_vals = result.boxes.conf.detach().cpu().numpy().tolist()
            xyxy_vals = result.boxes.xyxy.detach().cpu().numpy().tolist()
        except Exception:
            cls_vals = []
            conf_vals = []
            xyxy_vals = []
    for i, xyxy in enumerate(xyxy_vals):
        cid = int(cls_vals[i]) if i < len(cls_vals) else 0
        score = float(conf_vals[i]) if i < len(conf_vals) else 0.0
        if 0 <= cid < len(yolo_dataset.CLASS_DEFS):
            boxes.append(_box_dict(xyxy, cid, score))

    masks = getattr(result, "masks", None)
    if masks is not None and getattr(masks, "xy", None) is not None:
        for i, pts in enumerate(masks.xy):
            cid = int(cls_vals[i]) if i < len(cls_vals) else 0
            score = float(conf_vals[i]) if i < len(conf_vals) else 0.0
            if not (0 <= cid < len(yolo_dataset.CLASS_DEFS)):
                continue
            poly = _polygon_dict(pts, cid, score)
            if poly:
                polygons.append(poly)

    return {
        "id": sample_id,
        "weights": os.path.abspath(weights),
        "boxes": boxes,
        "polygons": polygons,
        "boxCount": len(boxes),
        "polygonCount": len(polygons),
    }


def main() -> int:
    weights = find_latest_weights()
    print(json.dumps({"available": bool(weights), "weights": weights}, ensure_ascii=False, indent=2))
    return 0 if weights else 1


if __name__ == "__main__":
    raise SystemExit(main())
