"""手順2の足場: 基盤地図情報「道路縁」-> 道路面マスク（弱ラベル）を自動生成。

手描きを最小化するための核。基盤地図情報（FGD）の道路縁は全国整備されているので、
道路縁ポリゴン（または閉じた縁線）をタイル画素系にラスタライズすれば、GSI航空写真と
ピクセル単位で対応した教師マスクを大量に自動生成できる。

入力ポリゴンの取得・GMLパースはここでは扱わない（環境依存のため）。本モジュールは
「経度緯度ポリゴン列 + TileGrid -> マスク」の確定した変換だけを提供し、これを
DeepLabV3+/U-Net の学習ターゲットに使う。

使い方の流れ:
  1) 対象エリアの GSI seamlessphoto を tiles.fetch_stitched で取得（=画像）。
  2) 同エリアの基盤地図 道路縁ポリゴンを用意（GMLやGeoJSONからlon/lat列に変換）。
  3) rasterize_polygons(polys, grid) でマスク生成（=ラベル）。
  4) (画像, マスク) を 512/1024 タイルに切って学習データ化。
道路縁が無い/古いエリアだけ手描きで補正する。
"""

from __future__ import annotations

import numpy as np

from .geo import TileGrid


def rasterize_polygons(polygons_lonlat, grid: TileGrid) -> np.ndarray:
    """[[ [lon,lat],... ], ...] のポリゴン群を grid 画素系の道路面マスク(bool)へ。

    偶奇規則の scanline 塗り。穴（島）は逆順リングを足せば偶奇で抜ける。
    """
    h, w = grid.height_px, grid.width_px
    mask = np.zeros((h, w), dtype=bool)
    for poly in polygons_lonlat or []:
        pts = [grid.lonlat_to_local(float(c[0]), float(c[1])) for c in poly
               if c is not None and len(c) >= 2]
        if len(pts) >= 3:
            _fill_polygon(mask, pts)
    return mask


def _fill_polygon(mask, pts):
    h, w = mask.shape
    n = len(pts)
    ys = [p[1] for p in pts]
    y_min = max(0, int(np.floor(min(ys))))
    y_max = min(h - 1, int(np.ceil(max(ys))))
    for y in range(y_min, y_max + 1):
        yc = y + 0.5
        xs = []
        for i in range(n):
            x0, y0 = pts[i]
            x1, y1 = pts[(i + 1) % n]
            if (y0 <= yc < y1) or (y1 <= yc < y0):
                t = (yc - y0) / (y1 - y0)
                xs.append(x0 + t * (x1 - x0))
        xs.sort()
        for k in range(0, len(xs) - 1, 2):
            xa = max(0, int(np.ceil(xs[k] - 0.5)))
            xb = min(w - 1, int(np.floor(xs[k + 1] - 0.5)))
            if xb >= xa:
                mask[y, xa:xb + 1] = True


def buffer_centerlines(lines_lonlat, grid: TileGrid, half_width_m=2.5) -> np.ndarray:
    """道路縁が無い場合の代替: OSM中心線を一定幅でバッファして弱ラベルにする。
    精度は道路縁より落ちるが、ラベルゼロ地域のブートストラップに使える。"""
    from .geo import meters_per_pixel
    h, w = grid.height_px, grid.width_px
    mask = np.zeros((h, w), dtype=bool)
    yy, xx = np.mgrid[0:h, 0:w]
    for line in lines_lonlat or []:
        pts = [grid.lonlat_to_local(float(c[0]), float(c[1])) for c in line
               if c is not None and len(c) >= 2]
        if len(pts) < 2:
            continue
        lat = sum(c[1] for c in line) / len(line)
        half_px = half_width_m / meters_per_pixel(lat, grid.zoom, grid.tile_size)
        from .segmenter import _dist_to_segment
        for i in range(len(pts) - 1):
            x0, y0 = pts[i]
            x1, y1 = pts[i + 1]
            mask |= _dist_to_segment(xx, yy, x0, y0, x1, y1) <= half_px
    return mask


def export_training_tile(rgb, mask, out_dir, name, tile=512):
    """(画像, マスク) を tile×tile に切り出して保存（学習データ化の最小実装）。
    PNG: 画像は RGB, マスクは 0/255 の 1ch。"""
    import os
    from PIL import Image
    os.makedirs(os.path.join(out_dir, "images"), exist_ok=True)
    os.makedirs(os.path.join(out_dir, "masks"), exist_ok=True)
    h, w = mask.shape[:2]
    saved = 0
    for y in range(0, h - tile + 1, tile):
        for x in range(0, w - tile + 1, tile):
            sub_m = mask[y:y + tile, x:x + tile]
            if not sub_m.any():
                continue  # 道路ゼロのタイルは捨てる（学習効率のため）
            sub_i = rgb[y:y + tile, x:x + tile]
            tag = f"{name}_{x}_{y}"
            Image.fromarray(np.asarray(sub_i, np.uint8)).save(
                os.path.join(out_dir, "images", tag + ".png"))
            Image.fromarray((sub_m.astype(np.uint8) * 255)).save(
                os.path.join(out_dir, "masks", tag + ".png"))
            saved += 1
    return saved
