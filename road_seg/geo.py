"""Web Mercator / XYZ タイル幾何ユーティリティ。

道路幅推定の「精度の生命線」はモデルではなく m/pixel 換算。ここを単一の真実源として
切り出し、measure.py / tiles.py / pipeline.py から共有する。

座標系:
- 経度緯度 (lon, lat) [deg] <-> グローバルピクセル (px, py) at zoom z, tile_size=256 (GSI標準)
- グローバルピクセルはズーム z で世界全体を tile_size*2**z [px] に張った座標。タイル原点は左上。

参考: GSI は EPSG:3857 / 標準XYZ / 256px タイル。seamlessphoto は概ね z18 まで。
"""

from __future__ import annotations

import math
from dataclasses import dataclass

EARTH_RADIUS_M = 6378137.0
TILE_SIZE_DEFAULT = 256
# 2*pi*R / 256 ＝ ズーム0・赤道での 1px あたりメートル
EQUATOR_M_PER_PX_Z0 = 2.0 * math.pi * EARTH_RADIUS_M / TILE_SIZE_DEFAULT  # ≈ 156543.034


def map_size_px(zoom: int, tile_size: int = TILE_SIZE_DEFAULT) -> float:
    """ズーム z で世界全体を張ったときの一辺ピクセル数。"""
    return float(tile_size) * (2.0 ** int(zoom))


def meters_per_pixel(lat_deg: float, zoom: int, tile_size: int = TILE_SIZE_DEFAULT) -> float:
    """指定緯度・ズームでの 1px あたりメートル。

    Web Mercator は緯度で縮尺が変わるため、必ず対象道路の緯度を渡すこと。
    （これを赤道値で固定すると高緯度ほど幅を過大評価して 1m 級の誤差になる）
    """
    scale = EQUATOR_M_PER_PX_Z0 * (TILE_SIZE_DEFAULT / float(tile_size))
    return scale * math.cos(math.radians(lat_deg)) / (2.0 ** int(zoom))


def lonlat_to_global_px(lon_deg: float, lat_deg: float, zoom: int,
                        tile_size: int = TILE_SIZE_DEFAULT) -> tuple[float, float]:
    """経度緯度 -> グローバルピクセル (x, y)。"""
    size = map_size_px(zoom, tile_size)
    x = (lon_deg + 180.0) / 360.0 * size
    siny = math.sin(math.radians(lat_deg))
    # 極での発散を避けるためクランプ（Google/Bing と同じ手法）
    siny = min(max(siny, -0.9999), 0.9999)
    y = (0.5 - math.log((1.0 + siny) / (1.0 - siny)) / (4.0 * math.pi)) * size
    return x, y


def global_px_to_lonlat(px: float, py: float, zoom: int,
                        tile_size: int = TILE_SIZE_DEFAULT) -> tuple[float, float]:
    """グローバルピクセル (x, y) -> 経度緯度。"""
    size = map_size_px(zoom, tile_size)
    lon = px / size * 360.0 - 180.0
    n = math.pi - 2.0 * math.pi * py / size
    lat = math.degrees(math.atan(math.sinh(n)))
    return lon, lat


@dataclass(frozen=True)
class TileGrid:
    """bbox を覆うタイル範囲＋スティッチ画像のジオリファレンス。

    origin_px はスティッチ画像左上のグローバルピクセル座標。
    画像内ローカル座標 (lx, ly) = グローバル (gx, gy) - origin_px。
    """
    zoom: int
    tile_size: int
    x_min: int
    y_min: int
    x_max: int
    y_max: int

    @property
    def origin_px(self) -> tuple[float, float]:
        return (self.x_min * self.tile_size, self.y_min * self.tile_size)

    @property
    def width_px(self) -> int:
        return (self.x_max - self.x_min + 1) * self.tile_size

    @property
    def height_px(self) -> int:
        return (self.y_max - self.y_min + 1) * self.tile_size

    def global_to_local(self, gx: float, gy: float) -> tuple[float, float]:
        ox, oy = self.origin_px
        return gx - ox, gy - oy

    def lonlat_to_local(self, lon: float, lat: float) -> tuple[float, float]:
        gx, gy = lonlat_to_global_px(lon, lat, self.zoom, self.tile_size)
        return self.global_to_local(gx, gy)

    def tiles(self):
        for ty in range(self.y_min, self.y_max + 1):
            for tx in range(self.x_min, self.x_max + 1):
                yield tx, ty


def bbox_of_lonlats(coords) -> tuple[float, float, float, float]:
    """[[lon,lat],...] -> (min_lon, min_lat, max_lon, max_lat)。"""
    xs = [float(c[0]) for c in coords]
    ys = [float(c[1]) for c in coords]
    return min(xs), min(ys), max(xs), max(ys)


def tile_grid_for_bbox(min_lon: float, min_lat: float, max_lon: float, max_lat: float,
                       zoom: int, margin_tiles: int = 1,
                       tile_size: int = TILE_SIZE_DEFAULT) -> TileGrid:
    """bbox を覆うタイルグリッドを作る。margin_tiles で周囲に余白タイルを足す
    （道路幅ぶん端が画像外に出ないように、最低1タイルの余白を推奨）。"""
    gx0, gy0 = lonlat_to_global_px(min_lon, max_lat, zoom, tile_size)  # 左上
    gx1, gy1 = lonlat_to_global_px(max_lon, min_lat, zoom, tile_size)  # 右下
    x_min = int(math.floor(min(gx0, gx1) / tile_size)) - margin_tiles
    x_max = int(math.floor(max(gx0, gx1) / tile_size)) + margin_tiles
    y_min = int(math.floor(min(gy0, gy1) / tile_size)) - margin_tiles
    y_max = int(math.floor(max(gy0, gy1) / tile_size)) + margin_tiles
    max_idx = (2 ** int(zoom)) - 1
    x_min = max(0, x_min)
    y_min = max(0, y_min)
    x_max = min(max_idx, x_max)
    y_max = min(max_idx, y_max)
    return TileGrid(zoom=int(zoom), tile_size=int(tile_size),
                    x_min=x_min, y_min=y_min, x_max=x_max, y_max=y_max)
