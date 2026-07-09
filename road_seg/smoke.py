"""サーバ(/segment_road_width)のスモーク。`python -m road_seg.smoke`

既定はネット不要の in-process 検証:
- /health を関数呼び出しで確認
- タイル取得をモックし「グレーの道路帯」を描いた合成画像を返す → 実 ThresholdRoadSegmenter →
  measure までエンドポイント関数をそのまま通し、widthSamples と階級が返ることを確認
  （HTTPサーバ・httpx・GSIアクセス無しで配管全体を検証）

`--http http://127.0.0.1:8012` を渡すと、起動済みサーバの /health を urllib で叩く。
"""

from __future__ import annotations

import math
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

import numpy as np

from . import tiles as tiles_mod
from .geo import tile_grid_for_bbox
from .segmenter import SyntheticRoadSegmenter
from .tiles import StitchResult


def _straight_line(lat, lng, length_m, bearing_deg):
    R = 6378137.0
    br = math.radians(bearing_deg)
    dlat = (length_m * math.cos(br)) / R
    dlon = (length_m * math.sin(br)) / (R * math.cos(math.radians(lat)))
    return [[lng, lat], [lng + math.degrees(dlon), lat + math.degrees(dlat)]]


def _fake_stitch_factory(width_m):
    """中心線まわりに『グレー道路帯＋緑地背景』のRGBを描いて返すモック。
    ThresholdRoadSegmenter は低彩度グレーを道路として拾うので end-to-end が通る。"""
    def fake_fetch(coords, zoom, **kwargs):
        lons = [c[0] for c in coords]; lats = [c[1] for c in coords]
        grid = tile_grid_for_bbox(min(lons), min(lats), max(lons), max(lats), zoom, 1)
        band = SyntheticRoadSegmenter(grid, coords, width_m).render_mask()
        rgb = np.zeros((grid.height_px, grid.width_px, 3), np.uint8)
        rgb[:] = (40, 140, 40)          # 緑地（高彩度）＝非道路
        rgb[band] = (130, 130, 130)     # アスファルト（低彩度グレー）＝道路
        return StitchResult(rgb=rgb, grid=grid, missing_tiles=0)
    return fake_fetch


def _fake_surface_stitch_factory(line, width_m):
    def fake_fetch(min_lon, min_lat, max_lon, max_lat, zoom, **kwargs):
        grid = tile_grid_for_bbox(min_lon, min_lat, max_lon, max_lat, zoom,
                                  int(kwargs.get("margin_tiles", 0)))
        band = SyntheticRoadSegmenter(grid, line, width_m).render_mask()
        rgb = np.zeros((grid.height_px, grid.width_px, 3), np.uint8)
        rgb[:] = (40, 140, 40)
        rgb[band] = (130, 130, 130)
        return StitchResult(rgb=rgb, grid=grid, missing_tiles=0)
    return fake_fetch


def run_inprocess():
    from .server import (health, segment_road_width, segment_road_surface,
                         SegmentRoadWidthRequest, SegmentRoadSurfaceRequest)

    ok = True
    h = health()
    cond = h.get("status") == "ok"
    print(f"[{'PASS' if cond else 'FAIL'}] /health -> {h}")
    ok &= cond

    # タイル取得をモック（既知幅4.0m）
    orig = tiles_mod.fetch_for_centerline
    tiles_mod.fetch_for_centerline = _fake_stitch_factory(4.0)
    try:
        line = _straight_line(35.6812, 139.7671, 100.0, 20.0)
        req = SegmentRoadWidthRequest(
            roads=[{"id": "r1", "geometry": {"type": "LineString", "coordinates": line}}],
            zoom=18, backend="threshold")
        out = segment_road_width(req)
    finally:
        tiles_mod.fetch_for_centerline = orig

    s = out["summaries"][0] if out["summaries"] else {}
    n = len(out["widthSamples"])
    cond = n > 0 and s.get("widthM") is not None and abs(s["widthM"] - 4.0) <= 0.8
    print(f"[{'PASS' if cond else 'FAIL'}] /segment_road_width threshold "
          f"-> widthM={s.get('widthM')} tier={s.get('tier')} samples={n}")
    ok &= cond

    orig = tiles_mod.fetch_stitched
    tiles_mod.fetch_stitched = _fake_surface_stitch_factory(line, 4.0)
    try:
        req = SegmentRoadSurfaceRequest(
            roads=[{"id": "r1", "geometry": {"type": "LineString", "coordinates": line}}],
            zoom=18,
            backend="threshold",
            roadBufferM=20.0,
            cellPx=6,
            fillRatio=0.25,
            maxPolygons=80,
        )
        fc = segment_road_surface(req)
    finally:
        tiles_mod.fetch_stitched = orig

    feats = fc.get("features") or []
    cond = fc.get("type") == "FeatureCollection" and len(feats) > 0 and fc.get("meta", {}).get("featureCount") == len(feats)
    print(f"[{'PASS' if cond else 'FAIL'}] /segment_road_surface threshold "
          f"-> features={len(feats)} cells={fc.get('meta', {}).get('cellCount')}")
    ok &= cond

    ok &= run_annotate_inprocess()
    return ok


def run_annotate_inprocess():
    """/annotate/fetch → /annotate/save をネット無し・一時datasetで検証。"""
    import base64
    import io
    import os
    import shutil
    import tempfile

    import numpy as np
    from PIL import Image

    from . import dataset as ds
    from . import tiles as tiles_mod
    from .geo import tile_grid_for_bbox
    from .segmenter import SyntheticRoadSegmenter
    from .tiles import StitchResult
    from .server import (annotate_fetch, annotate_save,
                         AnnotateFetchRequest, AnnotateSaveRequest)

    ok = True
    tmp = tempfile.mkdtemp(prefix="road_seg_ds_")
    keys = ["DATASET_DIR", "IMAGES_DIR", "MASKS_DIR", "META_DIR", "PENDING_DIR"]
    saved = {k: getattr(ds, k) for k in keys}
    ds.DATASET_DIR = tmp
    ds.IMAGES_DIR = os.path.join(tmp, "images")
    ds.MASKS_DIR = os.path.join(tmp, "masks")
    ds.META_DIR = os.path.join(tmp, "meta")
    ds.PENDING_DIR = os.path.join(tmp, ".pending")

    line = _straight_line(35.68, 139.767, 80.0, 20.0)
    lons = [c[0] for c in line]; lats = [c[1] for c in line]
    grid = tile_grid_for_bbox(min(lons), min(lats), max(lons), max(lats), 18, 0)
    band = SyntheticRoadSegmenter(grid, line, 4.0).render_mask()
    rgb = np.zeros((grid.height_px, grid.width_px, 3), np.uint8)
    rgb[:] = (40, 140, 40); rgb[band] = (130, 130, 130)
    orig = tiles_mod.fetch_stitched
    tiles_mod.fetch_stitched = lambda *a, **k: StitchResult(rgb=rgb, grid=grid, missing_tiles=0)
    try:
        bbox = [min(lons), min(lats), max(lons), max(lats)]
        out = annotate_fetch(AnnotateFetchRequest(bbox=bbox, zoom=18, initMask="blank"))
        cond = bool(out.get("id")) and str(out.get("image", "")).startswith("data:image/png")
        print(f"[{'PASS' if cond else 'FAIL'}] /annotate/fetch -> id={out.get('id')} "
              f"{out.get('width')}x{out.get('height')} tiles={out.get('tiles')}")
        ok &= cond

        buf = io.BytesIO(); Image.fromarray((band.astype(np.uint8) * 255)).save(buf, format="PNG")
        durl = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")
        res = annotate_save(AnnotateSaveRequest(id=out["id"], maskPng=durl, meta={"t": 1}))
        cond2 = (res.get("count", 0) >= 1
                 and os.path.exists(os.path.join(ds.IMAGES_DIR, out["id"] + ".png"))
                 and os.path.exists(os.path.join(ds.MASKS_DIR, out["id"] + ".png")))
        print(f"[{'PASS' if cond2 else 'FAIL'}] /annotate/save -> count={res.get('count')} "
              f"(dataset保存＋画像/マスク確認)")
        ok &= cond2
    finally:
        tiles_mod.fetch_stitched = orig
        for k, v in saved.items():
            setattr(ds, k, v)
        shutil.rmtree(tmp, ignore_errors=True)
    return ok


def ping_http(base_url):
    import json
    from urllib import request
    url = f"{base_url.rstrip('/')}/health"
    with request.urlopen(url, timeout=5) as res:
        body = json.loads(res.read().decode("utf-8", "replace"))
    cond = res.status == 200 and body.get("status") == "ok"
    print(f"[{'PASS' if cond else 'FAIL'}] HTTP {url} -> {body}")
    return cond


def main():
    args = sys.argv[1:]
    if args and args[0] == "--http":
        ok = ping_http(args[1] if len(args) > 1 else "http://127.0.0.1:8012")
    else:
        print("=== road_seg server smoke (in-process, no network) ===")
        ok = run_inprocess()
    print("\nsmoke", "PASSED" if ok else "FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
