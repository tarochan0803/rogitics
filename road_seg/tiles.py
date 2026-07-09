"""GSI（国土地理院）航空写真タイルの取得・スティッチ・キャッシュ。

既定は seamlessphoto（シームレス空中写真, 概ね z18 まで）。
ネットワークが要るのはこのモジュールだけ。selfcheck / 合成テストは tiles を使わず動く。

返すのは (stitched_rgb: HxWx3 uint8, grid: TileGrid)。grid と画素系は完全に一致する
（measure.py がローカル座標変換に grid を使うため）。
"""

from __future__ import annotations

import io
import os
import time
from dataclasses import dataclass

import numpy as np

try:
    import requests
except Exception:  # requests が無くても import 時には落とさない
    requests = None

from PIL import Image

from .geo import TileGrid, bbox_of_lonlats, tile_grid_for_bbox

# {z}/{x}/{y} を埋める。seamlessphoto は jpg。
GSI_LAYERS = {
    "seamlessphoto": ("https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg", 18),
    # 標準地図（道路抽出には不向きだがデバッグ用）
    "std": ("https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png", 18),
    # オルソ（高解像度・一部地域のみ）
    "ort": ("https://cyberjapandata.gsi.go.jp/xyz/ort/{z}/{x}/{y}.jpg", 18),
}

DEFAULT_CACHE_DIR = os.path.join(os.path.dirname(__file__), ".tile_cache")
USER_AGENT = "LOGISTICS_OS-road_seg/0.1 (feasibility PoC)"
# GSI 利用ガイドラインに沿い、過度な連続取得を避けるための間隔
MIN_REQUEST_INTERVAL_S = 0.1
_last_request_t = 0.0


@dataclass
class StitchResult:
    rgb: np.ndarray
    grid: TileGrid
    missing_tiles: int


def _cache_path(layer: str, z: int, x: int, y: int, ext: str, cache_dir: str) -> str:
    d = os.path.join(cache_dir, layer, str(z), str(x))
    os.makedirs(d, exist_ok=True)
    return os.path.join(d, f"{y}.{ext}")


def _fetch_tile(layer: str, z: int, x: int, y: int, cache_dir: str,
                timeout: float = 12.0):
    global _last_request_t
    url_tpl, _maxz = GSI_LAYERS[layer]
    ext = url_tpl.rsplit(".", 1)[-1]
    cp = _cache_path(layer, z, x, y, ext, cache_dir)
    if os.path.exists(cp) and os.path.getsize(cp) > 0:
        try:
            return Image.open(cp).convert("RGB")
        except Exception:
            pass
    if requests is None:
        return None
    dt = time.time() - _last_request_t
    if dt < MIN_REQUEST_INTERVAL_S:
        time.sleep(MIN_REQUEST_INTERVAL_S - dt)
    url = url_tpl.format(z=z, x=x, y=y)
    try:
        resp = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=timeout)
        _last_request_t = time.time()
        if resp.status_code != 200 or not resp.content:
            return None
        img = Image.open(io.BytesIO(resp.content)).convert("RGB")
        try:
            with open(cp, "wb") as f:
                f.write(resp.content)
        except Exception:
            pass
        return img
    except Exception:
        return None


def fetch_stitched(min_lon, min_lat, max_lon, max_lat, zoom, *,
                   layer: str = "seamlessphoto", margin_tiles: int = 1,
                   cache_dir: str = DEFAULT_CACHE_DIR) -> StitchResult:
    """bbox を覆う GSI タイルを取得しスティッチ。欠けタイルは黒で埋める。"""
    if layer not in GSI_LAYERS:
        raise ValueError(f"unknown GSI layer: {layer}")
    _, max_zoom = GSI_LAYERS[layer]
    zoom = min(int(zoom), max_zoom)
    grid = tile_grid_for_bbox(min_lon, min_lat, max_lon, max_lat, zoom,
                              margin_tiles=margin_tiles)
    canvas = Image.new("RGB", (grid.width_px, grid.height_px), (0, 0, 0))
    missing = 0
    for tx, ty in grid.tiles():
        img = _fetch_tile(layer, grid.zoom, tx, ty, cache_dir)
        if img is None:
            missing += 1
            continue
        ox = (tx - grid.x_min) * grid.tile_size
        oy = (ty - grid.y_min) * grid.tile_size
        canvas.paste(img, (ox, oy))
    return StitchResult(rgb=np.asarray(canvas, dtype=np.uint8), grid=grid,
                        missing_tiles=missing)


def fetch_for_centerline(centerline_lonlat, zoom, **kwargs) -> StitchResult:
    """中心線 [[lon,lat],...] の bbox からスティッチ画像を取る。"""
    min_lon, min_lat, max_lon, max_lat = bbox_of_lonlats(centerline_lonlat)
    return fetch_stitched(min_lon, min_lat, max_lon, max_lat, zoom, **kwargs)
