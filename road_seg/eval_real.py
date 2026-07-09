"""手順1の本体: 実GSI航空写真に当てて道路幅を出し、結果を目視できる形で保存。

`python -m road_seg.eval_real --lat 35.6812 --lng 139.7671 --bearing 30 --len 120`
あるいは中心線JSON: `--line "[[139.767,35.681],[139.768,35.682]]"`

やること:
1) 中心線の bbox から GSI seamlessphoto を取得（tiles.py）
2) 指定バックエンドでセグメンテーション（threshold ベースライン or pretrained）
3) measure.py で幅サンプル → 中央値・信頼度・階級
4) 元画像／マスク／中心線・断面の重畳PNG を out_dir に保存（マスク品質を目視）

pretrained を使うときは predict_fn を渡すため eval_real をスクリプトから import して
run() を呼ぶ（CLI からは threshold のみ）。これが「日本の狭小道路でどこまで取れるか」
を投資前に確かめるための道具。
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

from .geo import meters_per_pixel
from .measure import measure_road_width
from .segmenter import ThresholdRoadSegmenter, RoadSegmenter
from .tiles import fetch_for_centerline
from .width_class import classify_width


def _straight_line(lat, lng, length_m, bearing_deg):
    R = 6378137.0
    br = math.radians(bearing_deg)
    dlat = (length_m * math.cos(br)) / R
    dlon = (length_m * math.sin(br)) / (R * math.cos(math.radians(lat)))
    return [[lng, lat], [lng + math.degrees(dlon), lat + math.degrees(dlat)]]


def _overlay(rgb, mask, grid, line, result, out_path):
    img = np.asarray(rgb, np.uint8).copy()
    # 道路マスクを半透明グリーンで重畳
    m = mask.astype(bool)
    green = np.zeros_like(img)
    green[..., 1] = 255
    alpha = 0.35
    img[m] = (img[m] * (1 - alpha) + green[m] * alpha).astype(np.uint8)
    pic = Image.fromarray(img)
    # 中心線（赤）と各断面の幅注記はざっくり点で
    from PIL import ImageDraw
    d = ImageDraw.Draw(pic)
    pts = [grid.lonlat_to_local(c[0], c[1]) for c in line]
    for i in range(len(pts) - 1):
        d.line([pts[i], pts[i + 1]], fill=(255, 40, 40), width=2)
    for cs in result.cross_sections:
        if cs.on_road and not cs.clipped:
            x, y = grid.lonlat_to_local(cs.lon, cs.lat)
            d.ellipse([x - 2, y - 2, x + 2, y + 2], fill=(0, 120, 255))
    pic.save(out_path)


def run(line, *, zoom=18, layer="seamlessphoto", segmenter: RoadSegmenter = None,
        out_dir=None, spacing_m=8.0, max_half_width_m=12.0, save_overlay=True):
    if segmenter is None:
        segmenter = ThresholdRoadSegmenter()
    stitch = fetch_for_centerline(line, zoom, layer=layer)
    rgb, grid = stitch.rgb, stitch.grid
    mask = segmenter.segment(rgb)
    res = measure_road_width("eval", line, mask, grid,
                             spacing_m=spacing_m, max_half_width_m=max_half_width_m)
    lat = sum(c[1] for c in line) / len(line)
    tier = classify_width(res.width_m, res.confidence)
    info = {
        "widthM": res.width_m,
        "confidence": res.confidence,
        "tier": tier["key"],
        "tierLabel": tier["label"],
        "nSamples": res.n_samples,
        "nTotal": res.n_total,
        "mPerPx": round(meters_per_pixel(lat, zoom, grid.tile_size), 4),
        "zoom": zoom,
        "segmenter": getattr(segmenter, "name", "?"),
        "missingTiles": stitch.missing_tiles,
        "imageSize": [grid.width_px, grid.height_px],
    }
    if save_overlay and out_dir:
        os.makedirs(out_dir, exist_ok=True)
        Image.fromarray(rgb).save(os.path.join(out_dir, "image.png"))
        Image.fromarray((mask.astype(np.uint8) * 255)).save(os.path.join(out_dir, "mask.png"))
        _overlay(rgb, mask, grid, line, res, os.path.join(out_dir, "overlay.png"))
        info["outDir"] = os.path.abspath(out_dir)
    return info


def main():
    ap = argparse.ArgumentParser(description="GSI航空写真で道路幅を試算（手順1）")
    ap.add_argument("--line", help='中心線JSON [[lon,lat],...]')
    ap.add_argument("--lat", type=float, help="中心線始点 緯度")
    ap.add_argument("--lng", type=float, help="中心線始点 経度")
    ap.add_argument("--bearing", type=float, default=0.0, help="方位[deg]（--lat/--lng時）")
    ap.add_argument("--len", type=float, default=120.0, help="長さ[m]（--lat/--lng時）")
    ap.add_argument("--zoom", type=int, default=18)
    ap.add_argument("--layer", default="seamlessphoto")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), ".eval_out"))
    args = ap.parse_args()

    if args.line:
        line = json.loads(args.line)
    elif args.lat is not None and args.lng is not None:
        line = _straight_line(args.lat, args.lng, args.len, args.bearing)
    else:
        ap.error("--line か (--lat と --lng) を指定してください")

    info = run(line, zoom=args.zoom, layer=args.layer, out_dir=args.out)
    print(json.dumps(info, ensure_ascii=False, indent=2))
    if info.get("missingTiles"):
        print(f"[warn] タイル欠損 {info['missingTiles']} 枚（ネット不通 or 範囲外の可能性）", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
