"""Road-surface extraction from aerial road masks.

This module turns a binary road mask into small GeoJSON Polygon features that
can be injected into LOGISTICS_OS maskEdits.allow.  It intentionally avoids
heavy GIS dependencies: the mask is quantized to meter-scale cells, merged into
rectangles, and converted back through the existing Web Mercator tile grid.
"""

from __future__ import annotations

import math
from typing import Iterable, Optional

import numpy as np

from . import tiles as tiles_mod
from .geo import global_px_to_lonlat, meters_per_pixel, tile_grid_for_bbox
from .segmenter import RoadSegmenter


def _iter_lines(geometry):
    if not geometry:
        return
    gtype = geometry.get("type")
    coords = geometry.get("coordinates")
    if gtype == "LineString":
        yield coords
    elif gtype == "MultiLineString":
        for part in coords or []:
            yield part


def _coerce_line(line):
    out = []
    for c in line or []:
        if not isinstance(c, (list, tuple)) or len(c) < 2:
            continue
        try:
            lon = float(c[0])
            lat = float(c[1])
        except Exception:
            continue
        if math.isfinite(lon) and math.isfinite(lat):
            out.append((lon, lat))
    return out


def road_lines(roads) -> list[list[tuple[float, float]]]:
    lines = []
    for road in roads or []:
        for raw in _iter_lines((road or {}).get("geometry")):
            line = _coerce_line(raw)
            if len(line) >= 2:
                lines.append(line)
    return lines


def bbox_for_lines(lines) -> Optional[tuple[float, float, float, float]]:
    pts = [p for line in (lines or []) for p in line]
    if not pts:
        return None
    lons = [p[0] for p in pts]
    lats = [p[1] for p in pts]
    return min(lons), min(lats), max(lons), max(lats)


def _local_to_lonlat(grid, x: float, y: float) -> tuple[float, float]:
    ox, oy = grid.origin_px
    return global_px_to_lonlat(ox + float(x), oy + float(y), grid.zoom, grid.tile_size)


def _pixel_rect_to_polygon(grid, left: float, top: float, right: float, bottom: float):
    nw = _local_to_lonlat(grid, left, top)
    ne = _local_to_lonlat(grid, right, top)
    se = _local_to_lonlat(grid, right, bottom)
    sw = _local_to_lonlat(grid, left, bottom)
    return [[list(nw), list(ne), list(se), list(sw), list(nw)]]


def _dist_to_segment(px, py, x0, y0, x1, y1):
    vx, vy = x1 - x0, y1 - y0
    length2 = vx * vx + vy * vy
    if length2 <= 1e-9:
        return np.hypot(px - x0, py - y0)
    t = ((px - x0) * vx + (py - y0) * vy) / length2
    t = np.clip(t, 0.0, 1.0)
    return np.hypot(px - (x0 + t * vx), py - (y0 + t * vy))


def _bbox_mask(grid, bbox) -> np.ndarray:
    h, w = grid.height_px, grid.width_px
    min_lon, min_lat, max_lon, max_lat = [float(v) for v in bbox]
    x0, y0 = grid.lonlat_to_local(min_lon, max_lat)
    x1, y1 = grid.lonlat_to_local(max_lon, min_lat)
    left = max(0, int(math.floor(min(x0, x1))))
    right = min(w, int(math.ceil(max(x0, x1))))
    top = max(0, int(math.floor(min(y0, y1))))
    bottom = min(h, int(math.ceil(max(y0, y1))))
    out = np.zeros((h, w), dtype=bool)
    if right > left and bottom > top:
        out[top:bottom, left:right] = True
    return out


def _corridor_mask(grid, lines, buffer_m: float) -> Optional[np.ndarray]:
    if not lines or buffer_m is None or float(buffer_m) <= 0:
        return None
    h, w = grid.height_px, grid.width_px
    out = np.zeros((h, w), dtype=bool)
    for line in lines:
        for i in range(len(line) - 1):
            lon0, lat0 = line[i]
            lon1, lat1 = line[i + 1]
            x0, y0 = grid.lonlat_to_local(lon0, lat0)
            x1, y1 = grid.lonlat_to_local(lon1, lat1)
            mpp = max(0.05, meters_per_pixel((lat0 + lat1) * 0.5, grid.zoom, grid.tile_size))
            bpx = float(buffer_m) / mpp
            left = max(0, int(math.floor(min(x0, x1) - bpx - 2)))
            right = min(w, int(math.ceil(max(x0, x1) + bpx + 2)))
            top = max(0, int(math.floor(min(y0, y1) - bpx - 2)))
            bottom = min(h, int(math.ceil(max(y0, y1) + bpx + 2)))
            if right <= left or bottom <= top:
                continue
            yy, xx = np.mgrid[top:bottom, left:right]
            out[top:bottom, left:right] |= _dist_to_segment(xx, yy, x0, y0, x1, y1) <= bpx
    return out


def _cell_mask(mask: np.ndarray, cell_px: int, fill_ratio: float) -> np.ndarray:
    m = np.asarray(mask).astype(bool)
    h, w = m.shape
    cell = max(1, int(cell_px))
    rows = int(math.ceil(h / cell))
    cols = int(math.ceil(w / cell))
    integ = np.pad(m.astype(np.uint8).cumsum(axis=0).cumsum(axis=1), ((1, 0), (1, 0)))
    out = np.zeros((rows, cols), dtype=bool)
    threshold = max(0.0, min(1.0, float(fill_ratio)))
    for cy in range(rows):
        y0 = cy * cell
        y1 = min(h, y0 + cell)
        for cx in range(cols):
            x0 = cx * cell
            x1 = min(w, x0 + cell)
            total = (y1 - y0) * (x1 - x0)
            if total <= 0:
                continue
            s = (int(integ[y1, x1]) - int(integ[y0, x1])
                 - int(integ[y1, x0]) + int(integ[y0, x0]))
            out[cy, cx] = (float(s) / float(total)) >= threshold
    return out


def _components(cells: np.ndarray):
    h, w = cells.shape
    seen = np.zeros((h, w), dtype=bool)
    comps = []
    for sy in range(h):
        for sx in range(w):
            if not cells[sy, sx] or seen[sy, sx]:
                continue
            stack = [(sy, sx)]
            seen[sy, sx] = True
            comp = []
            while stack:
                y, x = stack.pop()
                comp.append((y, x))
                for dy in (-1, 0, 1):
                    for dx in (-1, 0, 1):
                        if dy == 0 and dx == 0:
                            continue
                        ny, nx = y + dy, x + dx
                        if 0 <= ny < h and 0 <= nx < w and cells[ny, nx] and not seen[ny, nx]:
                            seen[ny, nx] = True
                            stack.append((ny, nx))
            comps.append(comp)
    comps.sort(key=len, reverse=True)
    return comps


def _runs(xs: Iterable[int]):
    vals = sorted(set(int(x) for x in xs))
    if not vals:
        return []
    out = []
    start = prev = vals[0]
    for x in vals[1:]:
        if x == prev + 1:
            prev = x
        else:
            out.append((start, prev + 1))
            start = prev = x
    out.append((start, prev + 1))
    return out


def _rects_from_component(comp):
    rows = {}
    for y, x in comp:
        rows.setdefault(y, []).append(x)

    active = {}
    rects = []
    for y in sorted(rows):
        next_active = {}
        for x0, x1 in _runs(rows[y]):
            key = (x0, x1)
            rect = active.get(key)
            if rect is not None and rect[3] == y:
                rect[3] = y + 1
            else:
                rect = [x0, x1, y, y + 1]
            next_active[key] = rect
        for key, rect in active.items():
            if key not in next_active:
                rects.append(rect)
        active = next_active
    rects.extend(active.values())
    return rects


def mask_to_surface_geojson(mask, grid, *,
                            bbox=None,
                            corridor_lines=None,
                            corridor_buffer_m: float = 28.0,
                            cell_px: int = 6,
                            fill_ratio: float = 0.35,
                            min_area_m2: float = 12.0,
                            max_polygons: int = 400,
                            source: str = "road_seg_surface",
                            method: str = "aerial_mask_rects",
                            confidence: float = 0.55):
    """Convert a binary road mask to a GeoJSON FeatureCollection."""
    raw = np.asarray(mask).astype(bool)
    if raw.ndim != 2:
        raise ValueError("mask must be HxW")
    effective = raw.copy()
    if bbox is not None:
        effective &= _bbox_mask(grid, bbox)
    corridor = _corridor_mask(grid, corridor_lines, corridor_buffer_m)
    if corridor is not None:
        effective &= corridor

    cell = max(1, int(cell_px))
    cells = _cell_mask(effective, cell, fill_ratio)
    comps = _components(cells)
    features = []

    cy = grid.height_px * 0.5
    cx = grid.width_px * 0.5
    _lon, lat = _local_to_lonlat(grid, cx, cy)
    mpp = meters_per_pixel(lat, grid.zoom, grid.tile_size)
    cell_area_m2 = (cell * mpp) ** 2
    min_cells = max(1, int(math.ceil(float(min_area_m2) / max(cell_area_m2, 1e-9))))
    max_features = max(1, int(max_polygons))

    for comp_idx, comp in enumerate(comps):
        if len(comp) < min_cells:
            continue
        for rect_idx, (x0, x1, y0, y1) in enumerate(_rects_from_component(comp)):
            if len(features) >= max_features:
                break
            left = x0 * cell
            right = min(grid.width_px, x1 * cell)
            top = y0 * cell
            bottom = min(grid.height_px, y1 * cell)
            if right <= left or bottom <= top:
                continue
            area_m2 = (right - left) * (bottom - top) * (mpp ** 2)
            fid = f"{source}:{grid.zoom}:{grid.x_min}-{grid.y_min}:{len(features)}"
            features.append({
                "type": "Feature",
                "id": fid,
                "properties": {
                    "id": fid,
                    "source": source,
                    "method": method,
                    "confidence": float(confidence),
                    "component": int(comp_idx),
                    "rect": int(rect_idx),
                    "cellPx": int(cell),
                    "fillRatio": float(fill_ratio),
                    "areaM2": round(float(area_m2), 2),
                },
                "geometry": {
                    "type": "Polygon",
                    "coordinates": _pixel_rect_to_polygon(grid, left, top, right, bottom),
                },
            })
        if len(features) >= max_features:
            break

    return {
        "type": "FeatureCollection",
        "features": features,
        "meta": {
            "source": source,
            "method": method,
            "zoom": int(grid.zoom),
            "cellPx": int(cell),
            "fillRatio": float(fill_ratio),
            "minAreaM2": float(min_area_m2),
            "maxPolygons": int(max_features),
            "rawMaskPixels": int(raw.sum()),
            "effectiveMaskPixels": int(effective.sum()),
            "cellCount": int(cells.sum()),
            "componentCount": int(len(comps)),
            "featureCount": int(len(features)),
        },
    }


def run_surface_pipeline(roads=None, *, bbox=None, zoom=18, segmenter: RoadSegmenter = None,
                         layer="seamlessphoto", margin_tiles=0, max_tiles=64,
                         road_buffer_m=28.0, cell_px=6, fill_ratio=0.35,
                         min_area_m2=12.0, max_polygons=400, fetcher=None):
    """Fetch imagery, segment road surface, and return GeoJSON rectangles."""
    lines = road_lines(roads or [])
    req_bbox = bbox
    if req_bbox is None:
        req_bbox = bbox_for_lines(lines)
    if req_bbox is None:
        raise ValueError("roads or bbox is required")
    if len(req_bbox) != 4:
        raise ValueError("bbox must be [minLon,minLat,maxLon,maxLat]")

    min_lon, min_lat, max_lon, max_lat = [float(v) for v in req_bbox]
    grid = tile_grid_for_bbox(min_lon, min_lat, max_lon, max_lat, int(zoom),
                              margin_tiles=int(margin_tiles))
    n_tiles = (grid.x_max - grid.x_min + 1) * (grid.y_max - grid.y_min + 1)
    if n_tiles > int(max_tiles):
        raise ValueError(f"tile count too large: {n_tiles} > {int(max_tiles)}")

    if segmenter is None:
        from .segmenter import ThresholdRoadSegmenter
        segmenter = ThresholdRoadSegmenter()

    if fetcher is None:
        stitch = tiles_mod.fetch_stitched(min_lon, min_lat, max_lon, max_lat,
                                          int(zoom), layer=layer,
                                          margin_tiles=int(margin_tiles))
        rgb, grid, missing_tiles = stitch.rgb, stitch.grid, stitch.missing_tiles
    else:
        rgb, grid, missing_tiles = fetcher((min_lon, min_lat, max_lon, max_lat))

    mask = segmenter.segment(rgb)
    fc = mask_to_surface_geojson(
        mask, grid,
        bbox=(min_lon, min_lat, max_lon, max_lat),
        corridor_lines=lines,
        corridor_buffer_m=road_buffer_m,
        cell_px=cell_px,
        fill_ratio=fill_ratio,
        min_area_m2=min_area_m2,
        max_polygons=max_polygons,
        source="road_seg_surface",
        confidence=0.55 if getattr(segmenter, "name", "") == "threshold" else 0.75,
    )
    fc["meta"].update({
        "layer": layer,
        "segmenter": getattr(segmenter, "name", "?"),
        "roadCount": len(roads or []),
        "lineCount": len(lines),
        "tiles": int(n_tiles),
        "missingTiles": int(missing_tiles),
        "roadBufferM": float(road_buffer_m),
        "bbox": [min_lon, min_lat, max_lon, max_lat],
    })
    return fc
