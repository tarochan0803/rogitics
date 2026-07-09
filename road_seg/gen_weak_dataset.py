# -*- coding: utf-8 -*-
"""弱教師データ生成 — 手動ラベルゼロで道路面セグメンテーションの学習データを作る。

コンパイル済みワールド(world_<hash>.json)の rdcl道路 + OSM建物 を弱ラベルにして、
GSI航空写真タイルと対で 512px タイルへ切り出す。

3値ラベル(PNG 1ch):
  255 = 道路（rdcl中心線を幅員ランクでバッファ / FGD実測幅があれば優先）… 正例
    0 = 非道路（OSM建物フットプリント）                                … 負例
  128 = 無視（それ以外の地面・駐車場・植生）                            … 損失に含めない

狙い: 「駐車場・私道」は無視領域に落ち、モデルはアスファルトのテクスチャで道路と
同一視して発火する（＝rdclに無い走行面を航空写真から拾う）。学習は train_weak.py。

使い方:
  python -m road_seg.gen_weak_dataset --worlds a44c46c9,fb172e2f,b610332c [--tile 512]
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

import numpy as np
from PIL import Image

from .tiles import fetch_stitched
from .geo import meters_per_pixel
from .segmenter import _dist_to_segment
from .weak_labels import rasterize_polygons

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORLDS_DIR = os.path.join(ROOT, "runtime", "worlds")
OUT_DIR = os.path.join(os.path.dirname(__file__), "dataset_weak")

IGNORE = 128
ROAD = 255
NOTROAD = 0


def _paint_band(mask, pts, half_px):
    """折れ線 pts を太さ 2*half_px の帯で塗る（対象窓のみ計算＝高速）。"""
    h, w = mask.shape
    for i in range(len(pts) - 1):
        x0, y0 = pts[i]
        x1, y1 = pts[i + 1]
        xmin = max(0, int(math.floor(min(x0, x1) - half_px)))
        xmax = min(w - 1, int(math.ceil(max(x0, x1) + half_px)))
        ymin = max(0, int(math.floor(min(y0, y1) - half_px)))
        ymax = min(h - 1, int(math.ceil(max(y0, y1) + half_px)))
        if xmax < xmin or ymax < ymin:
            continue
        ys, xs = np.mgrid[ymin:ymax + 1, xmin:xmax + 1]
        d = _dist_to_segment(xs.astype(float), ys.astype(float), x0, y0, x1, y1)
        win = mask[ymin:ymax + 1, xmin:xmax + 1]
        win |= d <= half_px
        mask[ymin:ymax + 1, xmin:xmax + 1] = win


def _lines_of(geometry):
    if geometry.get("type") == "LineString":
        return [geometry["coordinates"]]
    if geometry.get("type") == "MultiLineString":
        return geometry["coordinates"]
    return []


def vegetation_mask(rgb):
    """植生（芝生・樹木）を色で検出して負例にする。緑が赤・青より優位＝植物。
    道路(灰)・駐車場(灰)は無彩色なので当たらない。学習が『緑地≠道路』を学ぶ。"""
    r = rgb[:, :, 0].astype(np.int16)
    g = rgb[:, :, 1].astype(np.int16)
    b = rgb[:, :, 2].astype(np.int16)
    return (g > r + 12) & (g > b + 12)


def build_weak_label(world, grid, rgb=None):
    """3値ラベル(H,W uint8)を返す。"""
    h, w = grid.height_px, grid.width_px
    road = np.zeros((h, w), dtype=bool)
    # 道路: 各道路を FGD実測幅 or gsiWidthEstimate の半幅でバッファ（車道幅、下限1.5m）
    for f in world["layers"]["roads"]:
        p = f.get("properties", {})
        wm = p.get("fgdWidthM") or p.get("gsiWidthEstimate") or 4.0
        half_m = max(1.5, float(wm) / 2.0)
        for line in _lines_of(f.get("geometry", {})):
            if len(line) < 2:
                continue
            lat = sum(c[1] for c in line) / len(line)
            half_px = half_m / meters_per_pixel(lat, grid.zoom, grid.tile_size)
            pts = [grid.lonlat_to_local(float(c[0]), float(c[1])) for c in line]
            _paint_band(road, pts, half_px)

    # 建物: 外周リングをラスタライズ
    rings = []
    for b in world["layers"].get("buildings", []):
        g = b.get("geometry", {})
        if g.get("type") == "Polygon" and g.get("coordinates"):
            rings.append(g["coordinates"][0])
        elif g.get("type") == "MultiPolygon":
            for poly in g["coordinates"]:
                if poly:
                    rings.append(poly[0])
    building = rasterize_polygons(rings, grid) if rings else np.zeros((h, w), dtype=bool)

    veg = vegetation_mask(rgb) if rgb is not None else np.zeros((h, w), dtype=bool)

    label = np.full((h, w), IGNORE, dtype=np.uint8)
    label[(building | veg) & ~road] = NOTROAD   # 建物＋植生は非道路
    label[road] = ROAD
    return label, road, (building | veg)


def export_tiles(rgb, label, out_dir, name, tile=512, stride=None):
    stride = stride or tile
    os.makedirs(os.path.join(out_dir, "images"), exist_ok=True)
    os.makedirs(os.path.join(out_dir, "labels"), exist_ok=True)
    h, w = label.shape
    saved = 0
    for y in range(0, max(1, h - tile + 1), stride):
        for x in range(0, max(1, w - tile + 1), stride):
            sub_l = label[y:y + tile, x:x + tile]
            if sub_l.shape != (tile, tile):
                continue
            # 学習に意味のあるタイルだけ: 道路正例が一定以上あるもの
            if (sub_l == ROAD).mean() < 0.02:
                continue
            sub_i = rgb[y:y + tile, x:x + tile]
            tag = f"{name}_{x}_{y}"
            Image.fromarray(np.asarray(sub_i, np.uint8)).save(os.path.join(out_dir, "images", tag + ".png"))
            Image.fromarray(sub_l).save(os.path.join(out_dir, "labels", tag + ".png"))
            saved += 1
    return saved


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--worlds", required=True, help="カンマ区切りの world hash")
    ap.add_argument("--tile", type=int, default=512)
    ap.add_argument("--out", default=OUT_DIR)
    args = ap.parse_args()

    total = 0
    for h in [x.strip() for x in args.worlds.split(",") if x.strip()]:
        wf = os.path.join(WORLDS_DIR, f"world_{h}.json")
        if not os.path.exists(wf):
            print(f"[skip] world_{h}.json なし")
            continue
        world = json.load(open(wf, encoding="utf-8"))
        bbox = world["aoi"]["bbox"] if isinstance(world["aoi"], dict) else world["aoi"]
        st = fetch_stitched(bbox[0], bbox[1], bbox[2], bbox[3], 18, margin_tiles=0)
        label, road, building = build_weak_label(world, st.grid, rgb=st.rgb)
        n = export_tiles(st.rgb, label, args.out, h, tile=args.tile)
        total += n
        print(f"{h}: {st.grid.width_px}x{st.grid.height_px} road={road.mean():.2f} "
              f"bld={building.mean():.2f} ignore={(label==IGNORE).mean():.2f} tiles={n}")
    print(f"\n合計 {total} タイル → {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
