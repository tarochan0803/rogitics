"""教師データ（画像＋マスク）の保存・件数・pending管理。

構成:
  road_seg/dataset/
    images/<id>.png   … GSI航空写真の切り出し（RGB）
    masks/<id>.png    … 道路面マスク（0/255, 1ch）
    meta/<id>.json    … bbox/zoom などの由来
    .pending/<id>.png … 取得済みで未保存の航空写真（保存時に images/ へ移す）

annotate サーバと train.py が共有する。
"""

from __future__ import annotations

import base64
import io
import glob
import json
import os
import random
import time

import numpy as np
from PIL import Image

DATASET_DIR = os.path.join(os.path.dirname(__file__), "dataset")
IMAGES_DIR = os.path.join(DATASET_DIR, "images")
MASKS_DIR = os.path.join(DATASET_DIR, "masks")
META_DIR = os.path.join(DATASET_DIR, "meta")
PENDING_DIR = os.path.join(DATASET_DIR, ".pending")


def _ensure_dirs():
    for d in (IMAGES_DIR, MASKS_DIR, META_DIR, PENDING_DIR):
        os.makedirs(d, exist_ok=True)


def new_id() -> str:
    return time.strftime("%Y%m%d_%H%M%S") + f"_{random.randint(1000, 9999)}"


def _png_bytes_from_rgb(rgb: np.ndarray) -> bytes:
    buf = io.BytesIO()
    Image.fromarray(np.asarray(rgb, np.uint8)).save(buf, format="PNG")
    return buf.getvalue()


def _png_bytes_from_mask(mask: np.ndarray) -> bytes:
    buf = io.BytesIO()
    Image.fromarray((np.asarray(mask).astype(bool).astype(np.uint8) * 255)).save(buf, format="PNG")
    return buf.getvalue()


def b64_png(data_bytes: bytes) -> str:
    return "data:image/png;base64," + base64.b64encode(data_bytes).decode("ascii")


def save_pending(sample_id: str, rgb: np.ndarray) -> str:
    _ensure_dirs()
    path = os.path.join(PENDING_DIR, f"{sample_id}.png")
    with open(path, "wb") as f:
        f.write(_png_bytes_from_rgb(rgb))
    return path


def pending_image_b64(sample_id: str) -> str | None:
    path = os.path.join(PENDING_DIR, f"{sample_id}.png")
    if not os.path.exists(path):
        return None
    with open(path, "rb") as f:
        return b64_png(f.read())


def commit(sample_id: str, mask_png_bytes: bytes, meta: dict | None = None) -> dict:
    """pending の画像を images/ へ確定し、マスクとメタを保存する。"""
    _ensure_dirs()
    pending = os.path.join(PENDING_DIR, f"{sample_id}.png")
    if not os.path.exists(pending):
        raise FileNotFoundError(f"pending image not found: {sample_id}")
    # 画像を確定
    img_path = os.path.join(IMAGES_DIR, f"{sample_id}.png")
    os.replace(pending, img_path)
    # マスクを正規化して保存（受信PNGを 0/255 1ch に）
    m = Image.open(io.BytesIO(mask_png_bytes)).convert("L")
    arr = (np.asarray(m) >= 128).astype(np.uint8) * 255
    Image.fromarray(arr).save(os.path.join(MASKS_DIR, f"{sample_id}.png"))
    # メタ
    with open(os.path.join(META_DIR, f"{sample_id}.json"), "w", encoding="utf-8") as f:
        json.dump(meta or {}, f, ensure_ascii=False, indent=2)
    return {"id": sample_id, "count": count()}


def count() -> int:
    if not os.path.isdir(MASKS_DIR):
        return 0
    imgs = {os.path.splitext(f)[0] for f in os.listdir(IMAGES_DIR)} if os.path.isdir(IMAGES_DIR) else set()
    masks = {os.path.splitext(f)[0] for f in os.listdir(MASKS_DIR)}
    return len(imgs & masks)


def list_pairs():
    """学習用: [(image_path, mask_path), ...] を返す。"""
    if not (os.path.isdir(IMAGES_DIR) and os.path.isdir(MASKS_DIR)):
        return []
    imgs = {os.path.splitext(f)[0]: os.path.join(IMAGES_DIR, f) for f in os.listdir(IMAGES_DIR)}
    pairs = []
    for f in os.listdir(MASKS_DIR):
        sid = os.path.splitext(f)[0]
        if sid in imgs:
            pairs.append((imgs[sid], os.path.join(MASKS_DIR, f)))
    return sorted(pairs)


def stats() -> dict:
    _ensure_dirs()
    pend = len([f for f in os.listdir(PENDING_DIR) if f.endswith(".png")]) if os.path.isdir(PENDING_DIR) else 0
    weak_dir = os.path.join(os.path.dirname(__file__), "dataset_weak")
    weak_images = glob.glob(os.path.join(weak_dir, "images", "*.png"))
    weak_labels = glob.glob(os.path.join(weak_dir, "labels", "*.png"))
    weak_names = {os.path.basename(p) for p in weak_images} & {os.path.basename(p) for p in weak_labels}
    model_path = os.path.join(os.path.dirname(__file__), "models", "road_unet.pt")
    meta_path = os.path.splitext(model_path)[0] + ".json"
    model_meta = None
    if os.path.exists(meta_path):
        try:
            with open(meta_path, encoding="utf-8") as f:
                model_meta = json.load(f)
        except Exception:
            model_meta = None
    return {
        "count": count(),
        "manualSamples": count(),
        "pending": pend,
        "weakTiles": len(weak_names),
        "datasetDir": os.path.abspath(DATASET_DIR),
        "weakDatasetDir": os.path.abspath(weak_dir),
        "modelExists": os.path.exists(model_path),
        "modelPath": os.path.abspath(model_path),
        "modelMeta": model_meta,
    }
