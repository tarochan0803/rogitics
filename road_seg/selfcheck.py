"""モデルもネットも不要の自己検証。

精度の核（m/pixel換算 + 垂線サンプリング）が機能しているかを、既知幅の合成道路で
確かめる。`python -m road_seg.selfcheck` で実行。pytest 不要。

合成道路（既知幅 W）→ SyntheticRoadSegmenter でマスク化 → measure_road_width で逆算 →
W に十分近いか、を検証する。これが通れば「マスクさえ正しく出れば幅は出せる」配管が
動いていることの証明になる。
"""

from __future__ import annotations

import math
import sys

try:  # Windows コンソール(cp932)でも UTF-8 で出す
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

from .geo import meters_per_pixel, tile_grid_for_bbox
from .measure import measure_road_width
from .pipeline import run_pipeline, measure_roads_offline
from .segmenter import SyntheticRoadSegmenter
from .surface import mask_to_surface_geojson
from .width_class import classify_width

PASS = "[PASS]"
FAIL = "[FAIL]"


def _check(name, cond, detail=""):
    mark = PASS if cond else FAIL
    print(f"{mark} {name}{('  ' + detail) if detail else ''}")
    return bool(cond)


def check_meters_per_pixel():
    # z18, lat35 の理論値 ≈ 0.4892 m/px（156543.034*cos35/2^18）
    mpp = meters_per_pixel(35.0, 18)
    ref = 156543.03392 * math.cos(math.radians(35.0)) / (2 ** 18)
    ok = abs(mpp - ref) < 1e-6 and abs(mpp - 0.4892) < 0.01
    return _check("meters_per_pixel(35,18)≈0.489", ok, f"got {mpp:.4f}")


def _straight_road(lon0, lat0, length_m, bearing_deg):
    """指定方位・長さの2点中心線を作る（簡易・小距離近似）。"""
    R = 6378137.0
    br = math.radians(bearing_deg)
    dlat = (length_m * math.cos(br)) / R
    dlon = (length_m * math.sin(br)) / (R * math.cos(math.radians(lat0)))
    lat1 = lat0 + math.degrees(dlat)
    lon1 = lon0 + math.degrees(dlon)
    return [[lon0, lat0], [lon1, lat1]]


def check_known_width(width_m, zoom=18, bearing=0.0, noise_px=0.0, tol=0.5):
    lon0, lat0 = 139.7671, 35.6812  # 東京駅付近
    line = _straight_road(lon0, lat0, 80.0, bearing)
    lons = [c[0] for c in line]; lats = [c[1] for c in line]
    grid = tile_grid_for_bbox(min(lons), min(lats), max(lons), max(lats),
                              zoom, margin_tiles=1)
    seg = SyntheticRoadSegmenter(grid, line, width_m, noise_px=noise_px)
    mask = seg.render_mask()
    res = measure_road_width("synthetic", line, mask, grid, spacing_m=5.0)
    got = res.width_m
    ok = got is not None and abs(got - width_m) <= tol
    return _check(
        f"width recover W={width_m}m bearing={bearing:.0f} noise={noise_px}px",
        ok, f"got {got}m conf={res.confidence} n={res.n_samples}/{res.n_total}")


def check_pipeline_offline():
    """run_pipeline を合成セグメンタ + ダミーfetcher で end-to-end。"""
    lon0, lat0 = 139.7671, 35.6812
    line = _straight_road(lon0, lat0, 80.0, 30.0)
    lons = [c[0] for c in line]; lats = [c[1] for c in line]
    grid = tile_grid_for_bbox(min(lons), min(lats), max(lons), max(lats), 18, 1)
    seg = SyntheticRoadSegmenter(grid, line, 4.0)

    def fetcher(coords):
        import numpy as np
        return np.zeros((grid.height_px, grid.width_px, 3), np.uint8), grid

    roads = [{"id": "r1", "geometry": {"type": "LineString", "coordinates": line}}]
    out = run_pipeline(roads, zoom=18, segmenter=seg, fetcher=fetcher)
    s = out["summaries"][0]
    ok = (len(out["widthSamples"]) > 0 and s["widthM"] is not None
          and abs(s["widthM"] - 4.0) <= 0.6 and s["tier"] == "w35_45")
    return _check("pipeline offline (W=4.0 -> tier 3.5〜4.5)", ok,
                  f"widthM={s['widthM']} tier={s['tier']} samples={len(out['widthSamples'])}")


def check_surface_geojson():
    lon0, lat0 = 139.7671, 35.6812
    line = _straight_road(lon0, lat0, 80.0, 20.0)
    lons = [c[0] for c in line]; lats = [c[1] for c in line]
    bbox = (min(lons), min(lats), max(lons), max(lats))
    grid = tile_grid_for_bbox(*bbox, 18, margin_tiles=1)
    mask = SyntheticRoadSegmenter(grid, line, 5.0).render_mask()
    fc = mask_to_surface_geojson(
        mask, grid,
        bbox=bbox,
        corridor_lines=[[(float(c[0]), float(c[1])) for c in line]],
        corridor_buffer_m=20.0,
        cell_px=6,
        fill_ratio=0.25,
        min_area_m2=8.0,
        max_polygons=80,
    )
    feats = fc.get("features") or []
    first = feats[0] if feats else {}
    coords = first.get("geometry", {}).get("coordinates", [])
    ok = (fc.get("type") == "FeatureCollection"
          and len(feats) > 0
          and first.get("geometry", {}).get("type") == "Polygon"
          and coords and len(coords[0]) >= 5
          and fc.get("meta", {}).get("featureCount") == len(feats))
    return _check("surface mask -> GeoJSON allow polygons", ok,
                  f"features={len(feats)} pixels={fc.get('meta', {}).get('effectiveMaskPixels')}")


def check_tiers():
    cases = [(7.0, "ge6"), (5.0, "w45_6"), (4.0, "w35_45"), (3.0, "lt35")]
    ok = all(classify_width(w)["key"] == k for w, k in cases)
    ok = ok and classify_width(4.0, confidence=0.2)["key"] == "unknown"
    return _check("width tiers + low-confidence->unknown", ok)


def check_mixed_training_manifest():
    import os
    import shutil
    import tempfile

    from .train_mixed import collect_training_items

    tmp = tempfile.mkdtemp(prefix="road_seg_train_manifest_")
    weak = tempfile.mkdtemp(prefix="road_seg_weak_manifest_")
    try:
        for d in (
            os.path.join(tmp, "images"),
            os.path.join(tmp, "masks"),
            os.path.join(weak, "images"),
            os.path.join(weak, "labels"),
        ):
            os.makedirs(d, exist_ok=True)
        for name in ("m1.png", "m2.png"):
            open(os.path.join(tmp, "images", name), "wb").close()
            open(os.path.join(tmp, "masks", name), "wb").close()
        open(os.path.join(weak, "images", "w1.png"), "wb").close()
        open(os.path.join(weak, "labels", "w1.png"), "wb").close()

        items, summary = collect_training_items(
            manual_dir=tmp,
            weak_dir=weak,
            manual_repeat=3,
            use_weak=True,
        )
        ok = (
            summary["manualSamples"] == 2
            and summary["weakTiles"] == 1
            and summary["effectiveItems"] == 7
            and sum(1 for item in items if item.kind == "manual") == 6
            and sum(1 for item in items if item.kind == "weak") == 1
        )
        return _check("mixed training manifest manual-repeat + weak", ok, f"summary={summary}")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
        shutil.rmtree(weak, ignore_errors=True)


def main():
    print("=== road_seg self-check (no model / no network) ===")
    results = [
        check_meters_per_pixel(),
        check_tiers(),
        check_known_width(3.0),
        check_known_width(4.0),
        check_known_width(6.0),
        check_known_width(4.0, bearing=45.0),
        check_known_width(4.0, bearing=90.0),
        check_known_width(4.0, noise_px=0.6, tol=0.7),
        check_pipeline_offline(),
        check_surface_geojson(),
        check_mixed_training_manifest(),
    ]
    n_ok = sum(1 for r in results if r)
    n = len(results)
    print(f"\n{n_ok}/{n} checks passed")
    return 0 if n_ok == n else 1


if __name__ == "__main__":
    sys.exit(main())
