# -*- coding: utf-8 -*-
"""YOLO dataset utilities for aerial/map element labels.

The road-surface mask dataset remains separate. This module stores object
labels for map-readable elements. It writes both YOLO detect labels
(`class xc yc w h`) and YOLO segment labels (`class x1 y1 x2 y2 ...`) so the
same hand labels can train either a box detector or a polygon/segmentation
model.
"""

from __future__ import annotations

import glob
import json
import os
import random
import shutil
import time
from typing import Iterable

import numpy as np
from PIL import Image

from . import dataset as surface_dataset

YOLO_DATASET_DIR = os.path.join(os.path.dirname(__file__), "dataset_yolo")
SOURCE_DIR = os.path.join(YOLO_DATASET_DIR, "source")
IMAGES_DIR = os.path.join(SOURCE_DIR, "images")
LABELS_DIR = os.path.join(SOURCE_DIR, "labels")
SEG_LABELS_DIR = os.path.join(SOURCE_DIR, "labels_segment")
META_DIR = os.path.join(SOURCE_DIR, "meta")
PENDING_DIR = os.path.join(YOLO_DATASET_DIR, ".pending")
PREPARED_DIR = os.path.join(YOLO_DATASET_DIR, "prepared")
LAST_TRAIN_META = os.path.join(YOLO_DATASET_DIR, "last_train.json")

CLASS_DEFS = [
    {"id": 0, "name": "private_road_driveway", "label": "私道/構内通路", "color": "#00c853",
     "description": "rdclに出ない敷地内の走行通路や私道"},
    {"id": 1, "name": "parking_aisle", "label": "駐車場走行面", "color": "#35a7ff",
     "description": "駐車場内の車両通路、転回に使える舗装面"},
    {"id": 2, "name": "tree_canopy", "label": "樹木/植栽", "color": "#5cc96b",
     "description": "上空から見える樹冠、植栽帯、張り出し候補"},
    {"id": 3, "name": "utility_pole", "label": "電柱/支柱候補", "color": "#ffca3a",
     "description": "点状の柱、電柱影、支柱らしい候補"},
    {"id": 4, "name": "guardrail_fence", "label": "ガードレール/フェンス", "color": "#ff7a00",
     "description": "細長い柵、ガードレール、防護柵"},
    {"id": 5, "name": "wall_curb_step", "label": "壁/縁石/段差", "color": "#ef476f",
     "description": "車両が越えられない境界、縁石、段差、擁壁"},
    {"id": 6, "name": "gate_bollard", "label": "門/ボラード", "color": "#9b5de5",
     "description": "門扉、車止め、ボラード、チェーンポスト"},
    {"id": 7, "name": "loading_space", "label": "搬入口/荷捌き", "color": "#00bbf9",
     "description": "搬入口、荷捌きスペース、車寄せ"},
    {"id": 8, "name": "unknown_blocker", "label": "その他障害物", "color": "#adb5bd",
     "description": "分類しにくいが通行可否に効く障害物"},
    {"id": 9, "name": "public_road_surface", "label": "普通の車道", "color": "#7ae582",
     "description": "公道・一般車道の走行面"},
    {"id": 10, "name": "sidewalk", "label": "歩道", "color": "#f15bb5",
     "description": "歩道、歩行者空間、車道と分けたい舗装面"},
]


def ensure_dirs() -> None:
    for d in (IMAGES_DIR, LABELS_DIR, SEG_LABELS_DIR, META_DIR, PENDING_DIR, PREPARED_DIR):
        os.makedirs(d, exist_ok=True)


def new_id(prefix: str | None = None) -> str:
    base = time.strftime("%Y%m%d_%H%M%S") + f"_{random.randint(1000, 9999)}"
    return f"{prefix}_{base}" if prefix else base


def classes() -> list[dict]:
    return [dict(c) for c in CLASS_DEFS]


def class_names() -> list[str]:
    return [str(c["name"]) for c in CLASS_DEFS]


def b64_png(data_bytes: bytes) -> str:
    return surface_dataset.b64_png(data_bytes)


def save_pending(sample_id: str, rgb: np.ndarray) -> str:
    ensure_dirs()
    path = os.path.join(PENDING_DIR, f"{sample_id}.png")
    with open(path, "wb") as f:
        f.write(surface_dataset._png_bytes_from_rgb(rgb))
    return path


def _valid_class_id(raw) -> int | None:
    try:
        class_id = int(raw)
    except Exception:
        return None
    if 0 <= class_id < len(CLASS_DEFS):
        return class_id
    return None


def _clip_box(box: dict, width: int, height: int) -> dict | None:
    class_id = _valid_class_id(box.get("classId", box.get("class_id", -1)))
    if class_id is None:
        return None
    try:
        x = float(box.get("x")); y = float(box.get("y"))
        w = float(box.get("w")); h = float(box.get("h"))
    except Exception:
        return None
    if not all(np.isfinite(v) for v in (x, y, w, h)) or w <= 1.0 or h <= 1.0:
        return None
    x1 = max(0.0, min(float(width), x))
    y1 = max(0.0, min(float(height), y))
    x2 = max(0.0, min(float(width), x + w))
    y2 = max(0.0, min(float(height), y + h))
    if x2 - x1 <= 1.0 or y2 - y1 <= 1.0:
        return None
    return {"classId": class_id, "x": x1, "y": y1, "w": x2 - x1, "h": y2 - y1}


def normalize_boxes(boxes: Iterable[dict], width: int, height: int) -> list[dict]:
    return [b for b in (_clip_box(box, width, height) for box in boxes or []) if b is not None]


def _polygon_area(points: list[list[float]]) -> float:
    if len(points) < 3:
        return 0.0
    s = 0.0
    for i, p in enumerate(points):
        q = points[(i + 1) % len(points)]
        s += p[0] * q[1] - q[0] * p[1]
    return abs(s) * 0.5


def _clip_polygon(poly: dict, width: int, height: int) -> dict | None:
    class_id = _valid_class_id(poly.get("classId", poly.get("class_id", -1)))
    if class_id is None:
        return None
    raw_points = poly.get("points") or []
    points: list[list[float]] = []
    for raw in raw_points:
        try:
            if isinstance(raw, dict):
                x = float(raw.get("x"))
                y = float(raw.get("y"))
            else:
                x = float(raw[0])
                y = float(raw[1])
        except Exception:
            continue
        if not np.isfinite(x) or not np.isfinite(y):
            continue
        p = [max(0.0, min(float(width), x)), max(0.0, min(float(height), y))]
        if not points or abs(points[-1][0] - p[0]) > 0.5 or abs(points[-1][1] - p[1]) > 0.5:
            points.append(p)
    if len(points) >= 2 and abs(points[0][0] - points[-1][0]) <= 0.5 and abs(points[0][1] - points[-1][1]) <= 0.5:
        points.pop()
    if len(points) < 3 or _polygon_area(points) < 4.0:
        return None
    return {"classId": class_id, "points": points}


def normalize_polygons(polygons: Iterable[dict], width: int, height: int) -> list[dict]:
    return [p for p in (_clip_polygon(poly, width, height) for poly in polygons or []) if p is not None]


def _box_from_polygon(poly: dict) -> dict:
    xs = [p[0] for p in poly["points"]]
    ys = [p[1] for p in poly["points"]]
    x1, x2 = min(xs), max(xs)
    y1, y2 = min(ys), max(ys)
    return {"classId": poly["classId"], "x": x1, "y": y1, "w": x2 - x1, "h": y2 - y1}


def _polygon_from_box(box: dict) -> dict:
    x, y, w, h = box["x"], box["y"], box["w"], box["h"]
    return {
        "classId": box["classId"],
        "points": [[x, y], [x + w, y], [x + w, y + h], [x, y + h]],
    }


def _detect_label_line(box: dict, width: int, height: int) -> str:
    xc = (box["x"] + box["w"] / 2.0) / float(width)
    yc = (box["y"] + box["h"] / 2.0) / float(height)
    bw = box["w"] / float(width)
    bh = box["h"] / float(height)
    return f"{int(box['classId'])} {xc:.6f} {yc:.6f} {bw:.6f} {bh:.6f}"


def _segment_label_line(poly: dict, width: int, height: int) -> str:
    vals = [str(int(poly["classId"]))]
    for x, y in poly["points"]:
        vals.append(f"{x / float(width):.6f}")
        vals.append(f"{y / float(height):.6f}")
    return " ".join(vals)


def _write_labels(sample_id: str, width: int, height: int,
                  boxes: list[dict], polygons: list[dict]) -> tuple[str, str]:
    detect_boxes = list(boxes) + [_box_from_polygon(p) for p in polygons]
    segment_polygons = list(polygons) + [_polygon_from_box(b) for b in boxes]
    label_path = os.path.join(LABELS_DIR, f"{sample_id}.txt")
    seg_label_path = os.path.join(SEG_LABELS_DIR, f"{sample_id}.txt")
    with open(label_path, "w", encoding="utf-8", newline="\n") as f:
        for box in detect_boxes:
            f.write(_detect_label_line(box, width, height) + "\n")
    with open(seg_label_path, "w", encoding="utf-8", newline="\n") as f:
        for poly in segment_polygons:
            f.write(_segment_label_line(poly, width, height) + "\n")
    return label_path, seg_label_path


def _write_meta(sample_id: str, width: int, height: int, boxes: list[dict],
                polygons: list[dict], meta: dict | None = None) -> str:
    full_meta = {
        **(meta or {}),
        "id": sample_id,
        "width": width,
        "height": height,
        "classes": class_names(),
        "boxesPx": boxes,
        "polygonsPx": polygons,
        "boxCount": len(boxes),
        "polygonCount": len(polygons),
        "detectLabelCount": len(boxes) + len(polygons),
        "segmentLabelCount": len(polygons) + len(boxes),
        "savedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    meta_path = os.path.join(META_DIR, f"{sample_id}.json")
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(full_meta, f, ensure_ascii=False, indent=2)
    return meta_path


def commit(sample_id: str, boxes: Iterable[dict], width: int, height: int,
           meta: dict | None = None, polygons: Iterable[dict] | None = None) -> dict:
    """Commit a pending image and YOLO detect/segment labels.

    Empty labels are allowed and become negative samples.
    """
    ensure_dirs()
    width = int(width); height = int(height)
    if width <= 0 or height <= 0:
        raise ValueError("width/height must be positive")
    pending = os.path.join(PENDING_DIR, f"{sample_id}.png")
    if not os.path.exists(pending):
        raise FileNotFoundError(f"pending image not found: {sample_id}")

    clean_boxes = normalize_boxes(boxes or [], width, height)
    clean_polygons = normalize_polygons(polygons or [], width, height)
    clean_meta = dict(meta or {})
    clean_meta.setdefault("reviewedAt", time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
    img_path = os.path.join(IMAGES_DIR, f"{sample_id}.png")
    os.replace(pending, img_path)
    _write_labels(sample_id, width, height, clean_boxes, clean_polygons)
    _write_meta(sample_id, width, height, clean_boxes, clean_polygons, clean_meta)
    write_source_yaml("detect")
    write_source_yaml("segment")
    return {
        "id": sample_id,
        "boxCount": len(clean_boxes),
        "polygonCount": len(clean_polygons),
        "detectLabelCount": len(clean_boxes) + len(clean_polygons),
        "segmentLabelCount": len(clean_polygons) + len(clean_boxes),
        "stats": stats(),
    }


def commit_image(sample_id: str, rgb: np.ndarray, width: int, height: int,
                 meta: dict | None = None) -> dict:
    """Save an already-fetched image as a negative/unlabeled sample."""
    ensure_dirs()
    img_path = os.path.join(IMAGES_DIR, f"{sample_id}.png")
    Image.fromarray(np.asarray(rgb, np.uint8)).save(img_path)
    _write_labels(sample_id, int(width), int(height), [], [])
    _write_meta(sample_id, int(width), int(height), [], [], meta)
    write_source_yaml("detect")
    write_source_yaml("segment")
    return {"id": sample_id, "boxCount": 0, "polygonCount": 0}


def _sample_image_path(sample_id: str) -> str:
    return os.path.join(IMAGES_DIR, f"{sample_id}.png")


def image_path_for_id(sample_id: str) -> str | None:
    pending = os.path.join(PENDING_DIR, f"{sample_id}.png")
    if os.path.exists(pending):
        return pending
    image = _sample_image_path(sample_id)
    if os.path.exists(image):
        return image
    return None


def _sample_meta_path(sample_id: str) -> str:
    return os.path.join(META_DIR, f"{sample_id}.json")


def sample_ids() -> list[str]:
    if not os.path.isdir(IMAGES_DIR):
        return []
    return sorted(os.path.splitext(os.path.basename(p))[0] for p in glob.glob(os.path.join(IMAGES_DIR, "*.png")))


def _read_meta(sample_id: str) -> dict:
    path = _sample_meta_path(sample_id)
    if not os.path.exists(path):
        return {}
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def load_sample(sample_id: str) -> dict:
    ensure_dirs()
    img_path = _sample_image_path(sample_id)
    if not os.path.exists(img_path):
        raise FileNotFoundError(f"sample image not found: {sample_id}")
    meta = _read_meta(sample_id)
    with Image.open(img_path).convert("RGB") as img:
        width, height = img.size
        with open(img_path, "rb") as f:
            image = b64_png(f.read())
    return {
        "id": sample_id,
        "width": int(width),
        "height": int(height),
        "zoom": meta.get("zoom"),
        "layer": meta.get("layer"),
        "bbox": meta.get("bbox"),
        "existing": True,
        "reviewed": bool(meta.get("reviewedAt")),
        "classes": classes(),
        "boxes": meta.get("boxesPx") or [],
        "polygons": meta.get("polygonsPx") or [],
        "meta": meta,
        "image": image,
    }


def next_unreviewed_sample() -> dict | None:
    for sample_id in sample_ids():
        meta = _read_meta(sample_id)
        if meta.get("reviewedAt"):
            continue
        return load_sample(sample_id)
    return None


def update_sample(sample_id: str, boxes: Iterable[dict], width: int, height: int,
                  meta: dict | None = None, polygons: Iterable[dict] | None = None) -> dict:
    ensure_dirs()
    img_path = _sample_image_path(sample_id)
    if not os.path.exists(img_path):
        raise FileNotFoundError(f"sample image not found: {sample_id}")
    width = int(width); height = int(height)
    if width <= 0 or height <= 0:
        raise ValueError("width/height must be positive")
    clean_boxes = normalize_boxes(boxes or [], width, height)
    clean_polygons = normalize_polygons(polygons or [], width, height)
    old_meta = _read_meta(sample_id)
    new_meta = {**old_meta, **(meta or {})}
    new_meta.setdefault("reviewedAt", time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
    _write_labels(sample_id, width, height, clean_boxes, clean_polygons)
    _write_meta(sample_id, width, height, clean_boxes, clean_polygons, new_meta)
    write_source_yaml("detect")
    write_source_yaml("segment")
    return {
        "id": sample_id,
        "boxCount": len(clean_boxes),
        "polygonCount": len(clean_polygons),
        "detectLabelCount": len(clean_boxes) + len(clean_polygons),
        "segmentLabelCount": len(clean_polygons) + len(clean_boxes),
        "stats": stats(),
    }


def _task_label_dir(task: str = "detect") -> str:
    t = (task or "detect").lower()
    if t in ("segment", "seg", "segmentation"):
        return SEG_LABELS_DIR
    return LABELS_DIR


def _normalize_task(task: str = "detect") -> str:
    return "segment" if (task or "").lower() in ("segment", "seg", "segmentation") else "detect"


def list_samples(task: str = "detect", reviewed_only: bool = False) -> list[tuple[str, str]]:
    label_dir = _task_label_dir(task)
    if not (os.path.isdir(IMAGES_DIR) and os.path.isdir(label_dir)):
        return []
    images = {os.path.splitext(os.path.basename(p))[0]: p
              for p in glob.glob(os.path.join(IMAGES_DIR, "*.png"))}
    labels = {os.path.splitext(os.path.basename(p))[0]: p
              for p in glob.glob(os.path.join(label_dir, "*.txt"))}
    ids = sorted(set(images) & set(labels))
    if reviewed_only:
        ids = [sid for sid in ids if _read_meta(sid).get("reviewedAt")]
    return [(images[sid], labels[sid]) for sid in ids]


def _count_label_file(path: str) -> tuple[int, dict[int, int]]:
    total = 0
    per_class: dict[int, int] = {}
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                parts = line.strip().split()
                if not parts:
                    continue
                try:
                    cid = int(parts[0])
                except Exception:
                    continue
                total += 1
                per_class[cid] = per_class.get(cid, 0) + 1
    except FileNotFoundError:
        pass
    return total, per_class


def _label_stats(task: str, reviewed_only: bool = False) -> dict:
    samples = list_samples(task, reviewed_only=reviewed_only)
    total = 0
    negative = 0
    per_class = {c["name"]: 0 for c in CLASS_DEFS}
    for _img, label in samples:
        n, counts = _count_label_file(label)
        total += n
        if n == 0:
            negative += 1
        for cid, count in counts.items():
            if 0 <= cid < len(CLASS_DEFS):
                per_class[CLASS_DEFS[cid]["name"]] += count
    return {"samples": len(samples), "labels": total, "negative": negative, "perClass": per_class}


def stats() -> dict:
    ensure_dirs()
    det = _label_stats("detect")
    seg = _label_stats("segment")
    det_reviewed = _label_stats("detect", reviewed_only=True)
    seg_reviewed = _label_stats("segment", reviewed_only=True)
    pending = len(glob.glob(os.path.join(PENDING_DIR, "*.png")))
    ids = sample_ids()
    reviewed = 0
    for sample_id in ids:
        if _read_meta(sample_id).get("reviewedAt"):
            reviewed += 1
    last_train = None
    if os.path.exists(LAST_TRAIN_META):
        try:
            with open(LAST_TRAIN_META, encoding="utf-8") as f:
                last_train = json.load(f)
        except Exception:
            last_train = None
    return {
        "samples": det["samples"],
        "boxes": det["labels"],
        "negativeSamples": det["negative"],
        "perClass": det["perClass"],
        "segmentSamples": seg["samples"],
        "segments": seg["labels"],
        "negativeSegmentSamples": seg["negative"],
        "perClassSegments": seg["perClass"],
        "trainableSamples": det_reviewed["samples"],
        "trainableBoxes": det_reviewed["labels"],
        "trainableSegmentSamples": seg_reviewed["samples"],
        "trainableSegments": seg_reviewed["labels"],
        "perClassTrainableSegments": seg_reviewed["perClass"],
        "pending": pending,
        "reviewedSamples": reviewed,
        "unreviewedSamples": max(0, len(ids) - reviewed),
        "datasetDir": os.path.abspath(YOLO_DATASET_DIR),
        "sourceDir": os.path.abspath(SOURCE_DIR),
        "preparedDir": os.path.abspath(PREPARED_DIR),
        "sourceYaml": os.path.abspath(os.path.join(SOURCE_DIR, "dataset_detect.yaml")),
        "sourceYamlSegment": os.path.abspath(os.path.join(SOURCE_DIR, "dataset_segment.yaml")),
        "preparedYaml": os.path.abspath(os.path.join(PREPARED_DIR, "detect", "dataset.yaml")),
        "preparedYamlSegment": os.path.abspath(os.path.join(PREPARED_DIR, "segment", "dataset.yaml")),
        "lastTrain": last_train,
    }


def _yaml_text(path_dir: str, train: str, val: str) -> str:
    lines = [
        f"path: {os.path.abspath(path_dir)}",
        f"train: {train}",
        f"val: {val}",
        f"nc: {len(CLASS_DEFS)}",
        "names:",
    ]
    for c in CLASS_DEFS:
        lines.append(f"  {c['id']}: {c['name']}")
    return "\n".join(lines) + "\n"


def write_source_yaml(task: str = "detect") -> str:
    ensure_dirs()
    task = _normalize_task(task)
    path = os.path.join(SOURCE_DIR, f"dataset_{task}.yaml")
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(_yaml_text(SOURCE_DIR, "images", "images"))
    return path


def _link_or_copy(src: str, dst: str) -> None:
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    if os.path.exists(dst):
        os.unlink(dst)
    try:
        os.link(src, dst)
    except Exception:
        shutil.copy2(src, dst)


def prepare_split(val_ratio: float = 0.2, seed: int = 42, task: str = "detect") -> dict:
    ensure_dirs()
    task = _normalize_task(task)
    samples = list_samples(task, reviewed_only=True)
    if not samples:
        raise ValueError(f"YOLO {task} 教師データがありません。先に未修正タイルを開いて保存してください。")

    out_dir = os.path.join(PREPARED_DIR, task)
    if os.path.isdir(out_dir):
        shutil.rmtree(out_dir)
    for d in (
        os.path.join(out_dir, "images", "train"),
        os.path.join(out_dir, "images", "val"),
        os.path.join(out_dir, "labels", "train"),
        os.path.join(out_dir, "labels", "val"),
    ):
        os.makedirs(d, exist_ok=True)

    rng = random.Random(int(seed))
    items = list(samples)
    rng.shuffle(items)
    if len(items) >= 2 and val_ratio > 0:
        n_val = max(1, int(round(len(items) * float(val_ratio))))
        n_val = min(n_val, len(items) - 1)
    else:
        n_val = 0
    val_items = items[:n_val]
    train_items = items[n_val:] or items

    for split, split_items in (("train", train_items), ("val", val_items)):
        for img_path, label_path in split_items:
            sid = os.path.splitext(os.path.basename(img_path))[0]
            _link_or_copy(img_path, os.path.join(out_dir, "images", split, sid + ".png"))
            _link_or_copy(label_path, os.path.join(out_dir, "labels", split, sid + ".txt"))

    yaml_path = os.path.join(out_dir, "dataset.yaml")
    val_rel = "images/val" if val_items else "images/train"
    with open(yaml_path, "w", encoding="utf-8", newline="\n") as f:
        f.write(_yaml_text(out_dir, "images/train", val_rel))
    return {
        "task": task,
        "samples": len(items),
        "train": len(train_items),
        "val": len(val_items),
        "yaml": os.path.abspath(yaml_path),
    }


def export_tiles_for_bbox(min_lon: float, min_lat: float, max_lon: float, max_lat: float,
                          zoom: int = 18, layer: str = "seamlessphoto",
                          max_tiles: int = 100) -> dict:
    """Export individual XYZ tiles as negative/unlabeled samples."""
    from .geo import global_px_to_lonlat, tile_grid_for_bbox
    from . import tiles as tiles_mod

    ensure_dirs()
    layer = (layer or "seamlessphoto").lower()
    if layer not in tiles_mod.GSI_LAYERS:
        raise ValueError(f"unknown GSI layer: {layer}")
    zoom = max(1, min(int(zoom), tiles_mod.GSI_LAYERS[layer][1]))
    grid = tile_grid_for_bbox(min_lon, min_lat, max_lon, max_lat, zoom, margin_tiles=0)
    tiles = list(grid.tiles())
    cx = (grid.x_min + grid.x_max) / 2.0
    cy = (grid.y_min + grid.y_max) / 2.0
    tiles.sort(key=lambda xy: (xy[0] - cx) ** 2 + (xy[1] - cy) ** 2)
    max_tiles = max(1, int(max_tiles))
    selected = tiles[:max_tiles]

    exported = []
    missing = 0
    for tx, ty in selected:
        img = tiles_mod._fetch_tile(layer, zoom, tx, ty, tiles_mod.DEFAULT_CACHE_DIR)
        if img is None:
            missing += 1
            continue
        rgb = np.asarray(img.convert("RGB"), dtype=np.uint8)
        west, north = global_px_to_lonlat(tx * 256, ty * 256, zoom)
        east, south = global_px_to_lonlat((tx + 1) * 256, (ty + 1) * 256, zoom)
        sample_id = new_id(f"tile_z{zoom}_x{tx}_y{ty}")
        commit_image(sample_id, rgb, rgb.shape[1], rgb.shape[0], {
            "source": "tile_batch_export",
            "layer": layer,
            "zoom": zoom,
            "tile": {"z": zoom, "x": tx, "y": ty},
            "bbox": [west, south, east, north],
            "attribution": "国土地理院",
        })
        exported.append(sample_id)
    return {
        "requestedTiles": len(tiles),
        "selectedTiles": len(selected),
        "exported": len(exported),
        "missingTiles": missing,
        "ids": exported,
        "stats": stats(),
    }


def write_last_train(meta: dict) -> str:
    ensure_dirs()
    payload = {
        **meta,
        "classes": class_names(),
        "stats": stats(),
        "writtenAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    with open(LAST_TRAIN_META, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    return LAST_TRAIN_META


def main() -> int:
    print(json.dumps(stats(), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
