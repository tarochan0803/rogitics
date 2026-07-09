"""road_seg: 航空写真セグメンテーション -> 道路面マスク -> 幾何で道路幅。

判定への入口は既存知覚融合と同じ widthSamples {roadId, widthM, frameConfidence}。
モデルは差し替え式（segmenter.py）。精度の核は m/pixel換算(geo.py) と
垂線サンプリング(measure.py)で、モデル無しでも selfcheck で検証できる。
"""

from .geo import meters_per_pixel, tile_grid_for_bbox, TileGrid
from .measure import measure_road_width, RoadWidthResult
from .pipeline import run_pipeline, measure_roads_offline
from .surface import mask_to_surface_geojson, run_surface_pipeline
from .width_class import classify_width, WIDTH_TIERS

__all__ = [
    "meters_per_pixel", "tile_grid_for_bbox", "TileGrid",
    "measure_road_width", "RoadWidthResult",
    "run_pipeline", "measure_roads_offline",
    "mask_to_surface_geojson", "run_surface_pipeline",
    "classify_width", "WIDTH_TIERS",
]

__version__ = "0.1.0"
