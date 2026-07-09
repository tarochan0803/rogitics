# -*- coding: utf-8 -*-
"""Compare road-surface segmenters on teacher-site access routes.

Example:
  python -m road_seg.compare_models --sites site0008,site0019
"""

from __future__ import annotations

import argparse
import json
import os
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


DEFAULT_ROUTES = os.path.join(
    os.path.dirname(os.path.dirname(__file__)),
    "runtime",
    "teacher_data",
    "teacher_site_routes_1783137212224.json",
)
DEFAULT_OUT = os.path.join(os.path.dirname(__file__), ".compare_deeplab")


def _route_line(route: dict) -> list[list[float]]:
    return [[float(p["lng"]), float(p["lat"])] for p in route.get("route", [])]


def _site_key(value: str) -> str:
    value = str(value).strip()
    if value.startswith("teacher-site-"):
        return "site" + value.rsplit("-", 1)[-1]
    if value.startswith("site"):
        return value
    if value.isdigit():
        return f"site{int(value):04d}"
    return value


def _parse_weights(values: list[str]) -> list[tuple[str, str]]:
    out = []
    for raw in values:
        if "=" not in raw:
            raise ValueError(f"--weights must be name=path: {raw}")
        name, path = raw.split("=", 1)
        name = name.strip()
        path = path.strip()
        if not name or not path:
            raise ValueError(f"--weights must be name=path: {raw}")
        out.append((name, path))
    return out


def _write_sheet(site_dir: str, site: str, model_names: list[str]) -> str:
    from PIL import Image, ImageDraw

    cells = []
    for model_name in model_names:
        path = os.path.join(site_dir, f"{model_name}_overlay.png")
        img = Image.open(path).convert("RGB").resize((384, 384))
        cell = Image.new("RGB", (384, 416), "white")
        cell.paste(img, (0, 32))
        ImageDraw.Draw(cell).text((8, 8), model_name, fill=(0, 0, 0))
        cells.append(cell)
    sheet = Image.new("RGB", (384 * len(cells), 416), "white")
    for idx, cell in enumerate(cells):
        sheet.paste(cell, (idx * 384, 0))
    out = os.path.join(os.path.dirname(site_dir), f"{site}_overlays_sheet.png")
    sheet.save(out)
    return out


def compare(*, routes_path: str, sites: list[str], weights: list[tuple[str, str]],
            out_dir: str, include_threshold: bool, road_buffer_m: float,
            zoom: int, layer: str) -> list[dict]:
    import numpy as np
    from PIL import Image

    from . import tiles as tiles_mod
    from .eval_real import _overlay
    from .infer import get_predict_fn
    from .measure import measure_road_width
    from .segmenter import PretrainedRoadSegmenter, ThresholdRoadSegmenter
    from .surface import bbox_for_lines, mask_to_surface_geojson

    with open(routes_path, encoding="utf-8") as f:
        route_doc = json.load(f)
    routes = route_doc.get("routes", route_doc if isinstance(route_doc, list) else [])

    requested = {_site_key(site) for site in sites}
    selected = {}
    for route in routes:
        point_id = route.get("pointId", "")
        key = _site_key(point_id)
        if key in requested and key not in selected:
            selected[key] = route
    missing = sorted(requested - set(selected))
    if missing:
        raise ValueError("routes not found for sites: " + ", ".join(missing))

    model_specs: list[tuple[str, object]] = []
    if include_threshold:
        model_specs.append(("threshold", ThresholdRoadSegmenter()))
    for name, path in weights:
        model_specs.append((name, PretrainedRoadSegmenter(predict_fn=get_predict_fn(path))))

    os.makedirs(out_dir, exist_ok=True)
    summary = []
    for site in sites:
        key = _site_key(site)
        route = selected[key]
        line = _route_line(route)
        if len(line) < 2:
            raise ValueError(f"route has too few points: {route.get('id')}")
        stitch = tiles_mod.fetch_for_centerline(line, int(zoom), layer=layer)
        rgb, grid = stitch.rgb, stitch.grid
        bbox = bbox_for_lines([line])
        site_dir = os.path.join(out_dir, key)
        os.makedirs(site_dir, exist_ok=True)
        model_names = []

        for model_name, segmenter in model_specs:
            mask = np.asarray(segmenter.segment(rgb)).astype(bool)
            fc = mask_to_surface_geojson(
                mask,
                grid,
                bbox=bbox,
                corridor_lines=[line],
                corridor_buffer_m=road_buffer_m,
                cell_px=6,
                fill_ratio=0.35,
                min_area_m2=12.0,
                max_polygons=400,
                confidence=0.55 if model_name == "threshold" else 0.75,
            )
            result = measure_road_width(
                route.get("id", key),
                line,
                mask,
                grid,
                spacing_m=8.0,
                max_half_width_m=12.0,
            )
            Image.fromarray((mask.astype(np.uint8) * 255)).save(
                os.path.join(site_dir, f"{model_name}_mask.png")
            )
            _overlay(rgb, mask, grid, line, result, os.path.join(site_dir, f"{model_name}_overlay.png"))
            meta = fc["meta"]
            summary.append({
                "site": key,
                "routeId": route.get("id"),
                "worldHash": route.get("worldHash"),
                "model": model_name,
                "missingTiles": int(stitch.missing_tiles),
                "imageSize": [int(grid.width_px), int(grid.height_px)],
                "rawMaskFrac": round(float(mask.mean()), 4),
                "effectiveMaskFrac": round(float(meta["effectiveMaskPixels"]) / float(mask.size), 4),
                "rawMaskPixels": int(meta["rawMaskPixels"]),
                "effectiveMaskPixels": int(meta["effectiveMaskPixels"]),
                "featureCount": int(meta["featureCount"]),
                "widthM": None if result.width_m is None else round(float(result.width_m), 2),
                "widthConfidence": round(float(result.confidence), 3),
                "nSamples": int(result.n_samples),
                "outDir": os.path.abspath(site_dir),
            })
            model_names.append(model_name)
        _write_sheet(site_dir, key, model_names)

    with open(os.path.join(out_dir, "summary.json"), "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)
    return summary


def main() -> int:
    ap = argparse.ArgumentParser(description="Compare U-Net/DeepLabV3+ road-surface models")
    ap.add_argument("--routes", default=DEFAULT_ROUTES)
    ap.add_argument("--sites", default="site0008,site0019")
    ap.add_argument("--weights", action="append", default=None, help="name=path; can be repeated")
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--no-threshold", action="store_true")
    ap.add_argument("--road-buffer-m", type=float, default=30.0)
    ap.add_argument("--zoom", type=int, default=18)
    ap.add_argument("--layer", default="seamlessphoto")
    args = ap.parse_args()

    sites = [s.strip() for s in args.sites.split(",") if s.strip()]
    weight_args = args.weights or [
        "unet_weak=road_seg/models/road_unet.pt",
        "deeplabv3plus_weak=road_seg/models/road_deeplabv3plus_weak.pt",
    ]
    summary = compare(
        routes_path=args.routes,
        sites=sites,
        weights=_parse_weights(weight_args),
        out_dir=args.out,
        include_threshold=not args.no_threshold,
        road_buffer_m=args.road_buffer_m,
        zoom=args.zoom,
        layer=args.layer,
    )
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    print(f"\nsummary: {os.path.abspath(os.path.join(args.out, 'summary.json'))}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
