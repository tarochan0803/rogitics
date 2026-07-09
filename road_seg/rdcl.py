"""GSI 道路中心線ベクトル（experimental_rdcl）を取得し、初期マスクの下書きを作る。

ラベル作成の出発点。しきい値ベースラインより遥かに良い『道路の形』を、GSIの実データ
（幅員ランク付き中心線）から生成する。ユーザーはこれを手で修正するだけで済む。

rnkWidth: 1=13m以上, 2=5.5-13m, 3=3-5.5m, 4=3m未満, 0=不明
（src/api/gsi.js の対応と一致させている）
"""

from __future__ import annotations

import math

import numpy as np

try:
    import requests
except Exception:
    requests = None

from .geo import TileGrid, meters_per_pixel
from .segmenter import _dist_to_segment

RDCL_URL = "https://cyberjapandata.gsi.go.jp/xyz/experimental_rdcl/{z}/{x}/{y}.geojson"
RDCL_ZOOM = 16
USER_AGENT = "LOGISTICS_OS-road_seg/0.1 (annotation)"

# 初期マスク用の代表全幅[m]（ランクの範囲の内側寄り。あくまで下書き）
RANK_FULL_WIDTH = {1: 13.0, 2: 8.0, 3: 4.0, 4: 2.5, 0: 4.0}


def _rank_of(props):
    v = props.get("rnkWidth")
    try:
        r = int(v)
    except (TypeError, ValueError):
        return 0
    return r if r in RANK_FULL_WIDTH else 0


def fetch_centerlines(min_lon, min_lat, max_lon, max_lat, *, timeout=12.0, max_tiles=64):
    """bbox の experimental_rdcl を取得し [{coords:[[lon,lat],...], fullWidthM, rank}] を返す。

    ネットワークが要る。requests 不在やタイル欠損時は空リスト（下書き無し＝手描き）。
    """
    if requests is None:
        return []
    z = RDCL_ZOOM
    n = 2 ** z
    def tx(lon):
        return int((lon + 180.0) / 360.0 * n)
    def ty(lat):
        r = math.radians(lat)
        return int((1.0 - math.log(math.tan(r) + 1.0 / math.cos(r)) / math.pi) / 2.0 * n)
    x0, x1 = tx(min_lon), tx(max_lon)
    y0, y1 = ty(max_lat), ty(min_lat)  # y は北で小さい
    x0, x1 = min(x0, x1), max(x0, x1)
    y0, y1 = min(y0, y1), max(y0, y1)
    if (x1 - x0 + 1) * (y1 - y0 + 1) > max_tiles:
        # 広すぎる。中心線下書きは諦める（画像取得側で範囲は別途制限）。
        return []

    out = []
    seen = set()
    for xt in range(x0, x1 + 1):
        for yt in range(y0, y1 + 1):
            url = RDCL_URL.format(z=z, x=xt, y=yt)
            try:
                resp = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=timeout)
                if resp.status_code != 200 or not resp.content:
                    continue
                data = resp.json()
            except Exception:
                continue
            for f in (data.get("features") or []):
                g = f.get("geometry") or {}
                gt = g.get("type")
                props = f.get("properties") or {}
                rid = props.get("rID")
                if rid is not None:
                    if rid in seen:
                        continue
                    seen.add(rid)
                rank = _rank_of(props)
                fw = RANK_FULL_WIDTH.get(rank, 4.0)
                if gt == "LineString":
                    out.append({"coords": g["coordinates"], "fullWidthM": fw, "rank": rank})
                elif gt == "MultiLineString":
                    for part in g["coordinates"]:
                        out.append({"coords": part, "fullWidthM": fw, "rank": rank})
    return out


def _paint_band(mask, x0, y0, x1, y1, half_px):
    """線分 (x0,y0)-(x1,y1) を太さ 2*half_px の帯で塗る（対象窓だけ計算＝高速）。"""
    h, w = mask.shape
    xmin = max(0, int(math.floor(min(x0, x1) - half_px)))
    xmax = min(w - 1, int(math.ceil(max(x0, x1) + half_px)))
    ymin = max(0, int(math.floor(min(y0, y1) - half_px)))
    ymax = min(h - 1, int(math.ceil(max(y0, y1) + half_px)))
    if xmax < xmin or ymax < ymin:
        return
    ys, xs = np.mgrid[ymin:ymax + 1, xmin:xmax + 1]
    d = _dist_to_segment(xs.astype(float), ys.astype(float), x0, y0, x1, y1)
    win = mask[ymin:ymax + 1, xmin:xmax + 1]
    win |= d <= half_px
    mask[ymin:ymax + 1, xmin:xmax + 1] = win


def rasterize_initial_mask(centerlines, grid: TileGrid) -> np.ndarray:
    """中心線群を grid 画素系の初期道路マスク(bool)へ。ランク別の幅で帯を塗る。"""
    h, w = grid.height_px, grid.width_px
    mask = np.zeros((h, w), dtype=bool)
    for cl in centerlines:
        coords = cl.get("coords") or []
        if len(coords) < 2:
            continue
        lat = sum(c[1] for c in coords) / len(coords)
        m_per_px = meters_per_pixel(lat, grid.zoom, grid.tile_size)
        half_px = (float(cl.get("fullWidthM", 4.0)) / m_per_px) / 2.0
        pts = [grid.lonlat_to_local(float(c[0]), float(c[1])) for c in coords]
        for i in range(len(pts) - 1):
            _paint_band(mask, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], half_px)
    return mask


def initial_mask_for_grid(grid: TileGrid, bbox) -> np.ndarray:
    """bbox の GSI 中心線を取得して初期マスクを返す（取得失敗時は空マスク）。"""
    min_lon, min_lat, max_lon, max_lat = bbox
    cls = fetch_centerlines(min_lon, min_lat, max_lon, max_lat)
    if not cls:
        return np.zeros((grid.height_px, grid.width_px), dtype=bool)
    return rasterize_initial_mask(cls, grid)
