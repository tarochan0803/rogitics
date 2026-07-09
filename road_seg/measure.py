"""道路面マスク + OSM中心線 -> 道路幅サンプル（幾何計算）。

設計上いちばん重要なのがこのモジュール。AI（セグメンテーション）には「道路の形」を
出させ、幅は幾何で測る。中心線はマスクから細線化せず、既にある OSM 中心線を使う
（交差点・曲がりでのノイズを避けるため）。

精度対策:
- 1断面で決めず、道に沿って多数の垂線を飛ばし中央値を取る（誤差が ~1/√N に平均化）。
- m/pixel 換算は対象道路の緯度で計算（geo.meters_per_pixel）。
- 端まで届かず最大幅でクリップした断面は信頼度を落とすか破棄。

出力は既存の知覚融合（perceptionFusion.js: aggregateWidthSuggestions）が食う
widthSamples 形式 {roadId, widthM, frameConfidence} に揃える。1断面=1サンプル、
1道路に複数サンプルが乗り、JS側の median 集約にそのまま渡せる。
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np

from .geo import TileGrid, meters_per_pixel


@dataclass
class CrossSection:
    """1断面の測定結果。"""
    s_m: float                 # 始点からの距離 [m]
    lon: float
    lat: float
    width_m: float
    left_m: float
    right_m: float
    confidence: float
    clipped: bool              # 片側でも最大幅に達して端が見つからなかった
    on_road: bool              # 中心線位置がマスク上で道路だった


@dataclass
class RoadWidthResult:
    road_id: str
    width_m: float | None      # 採用幅（有効断面の中央値）
    confidence: float
    n_samples: int             # 採用した断面数
    n_total: int               # 試行した断面数
    cross_sections: list[CrossSection] = field(default_factory=list)

    def to_width_samples(self) -> list[dict]:
        """JS aggregateWidthSuggestions が食う形 {roadId, widthM, frameConfidence}。
        有効断面を1サンプルずつ展開する（median集約はJS側に任せる）。"""
        out = []
        for cs in self.cross_sections:
            if cs.width_m is None or not cs.on_road or cs.clipped:
                continue
            out.append({
                "roadId": self.road_id,
                "widthM": round(float(cs.width_m), 2),
                "frameConfidence": round(float(cs.confidence), 3),
                "lat": round(cs.lat, 7),
                "lng": round(cs.lon, 7),
                "sM": round(cs.s_m, 1),
                "source": "aerial_seg",
            })
        return out


def _resample_polyline_px(pts_px, spacing_px):
    """ピクセル空間の折れ線を等間隔リサンプル。各点で (x, y, tangent_unit) を返す。"""
    pts = np.asarray(pts_px, dtype=float)
    if len(pts) < 2:
        return []
    seg = np.diff(pts, axis=0)
    seg_len = np.hypot(seg[:, 0], seg[:, 1])
    total = float(seg_len.sum())
    if total <= 0:
        return []
    out = []
    n = max(1, int(math.floor(total / spacing_px)))
    targets = [i * spacing_px for i in range(n + 1)]
    cum = np.concatenate([[0.0], np.cumsum(seg_len)])
    for t in targets:
        t = min(t, total)
        # t が乗るセグメントを探す
        k = int(np.searchsorted(cum, t, side="right") - 1)
        k = min(max(k, 0), len(seg) - 1)
        denom = seg_len[k] if seg_len[k] > 1e-9 else 1e-9
        f = (t - cum[k]) / denom
        x = pts[k, 0] + seg[k, 0] * f
        y = pts[k, 1] + seg[k, 1] * f
        tx, ty = seg[k, 0] / denom, seg[k, 1] / denom
        out.append((x, y, tx, ty))
    return out


def _sample_mask(mask, x, y):
    """最近傍サンプル。範囲外は 0（非道路）扱い。"""
    h, w = mask.shape[:2]
    xi = int(round(x))
    yi = int(round(y))
    if xi < 0 or yi < 0 or xi >= w or yi >= h:
        return 0
    return 1 if mask[yi, xi] else 0


def _march_edge(mask, x0, y0, nx, ny, max_px, step=0.5):
    """(x0,y0) から法線 (nx,ny) 方向へ進み、道路→非道路の境界までの距離[px]を返す。
    端が見つからず max_px に達したら (max_px, clipped=True)。"""
    d = 0.0
    last_on = _sample_mask(mask, x0, y0) == 1
    while d < max_px:
        d += step
        on = _sample_mask(mask, x0 + nx * d, y0 + ny * d) == 1
        if last_on and not on:
            # 半歩戻したところを端とみなす
            return d - step * 0.5, False
        last_on = on
    return max_px, True


def measure_road_width(road_id, centerline_lonlat, mask, grid: TileGrid, *,
                       spacing_m=8.0,
                       max_half_width_m=12.0,
                       lat_for_scale=None,
                       min_valid_ratio=0.25):
    """1本の道路について幅サンプルを計算する。

    centerline_lonlat: [[lon,lat],...] OSM中心線
    mask: HxW の 0/1（または bool）numpy配列（道路面=1）。grid と同じ画素系。
    grid: tiles の TileGrid（ローカル座標変換に使う）
    spacing_m: 断面間隔 [m]
    max_half_width_m: 片側の探索上限 [m]（これを超える幅はクリップ）
    """
    pts = [(float(c[0]), float(c[1])) for c in centerline_lonlat
           if c is not None and len(c) >= 2]
    if len(pts) < 2:
        return RoadWidthResult(road_id=str(road_id), width_m=None, confidence=0.0,
                               n_samples=0, n_total=0)

    if lat_for_scale is None:
        lat_for_scale = sum(p[1] for p in pts) / len(pts)
    m_per_px = meters_per_pixel(lat_for_scale, grid.zoom, grid.tile_size)
    if m_per_px <= 0:
        return RoadWidthResult(road_id=str(road_id), width_m=None, confidence=0.0,
                               n_samples=0, n_total=0)

    pts_px = [grid.lonlat_to_local(lon, lat) for lon, lat in pts]
    spacing_px = max(1.0, spacing_m / m_per_px)
    max_half_px = max_half_width_m / m_per_px

    stations = _resample_polyline_px(pts_px, spacing_px)
    mask_bool = mask.astype(bool) if mask.dtype != bool else mask

    cross = []
    cum_m = 0.0
    prev = None
    for (x, y, tx, ty) in stations:
        if prev is not None:
            cum_m += math.hypot(x - prev[0], y - prev[1]) * m_per_px
        prev = (x, y)

        nx, ny = -ty, tx  # 進行方向に対する左法線
        on_road = _sample_mask(mask_bool, x, y) == 1
        if not on_road:
            # 中心線がマスク上で道路でない（モデル欠損 or ズレ）。近傍に道路があれば寄せる。
            x, y, on_road = _snap_to_road(mask_bool, x, y, nx, ny, max_half_px)

        if not on_road:
            lon, lat = _local_to_lonlat(grid, x, y)
            cross.append(CrossSection(cum_m, lon, lat, None, 0, 0, 0.0, True, False))
            continue

        left_px, left_clip = _march_edge(mask_bool, x, y, nx, ny, max_half_px)
        right_px, right_clip = _march_edge(mask_bool, x, y, -nx, -ny, max_half_px)
        width_m = (left_px + right_px) * m_per_px
        clipped = left_clip or right_clip
        conf = _section_confidence(left_px, right_px, max_half_px, clipped)
        lon, lat = _local_to_lonlat(grid, x, y)
        cross.append(CrossSection(cum_m, lon, lat, width_m,
                                  left_px * m_per_px, right_px * m_per_px,
                                  conf, clipped, True))

    valid = [c for c in cross if c.on_road and not c.clipped and c.width_m]
    n_total = len(cross)
    if not valid or (n_total and len(valid) / n_total < min_valid_ratio):
        return RoadWidthResult(road_id=str(road_id), width_m=None,
                               confidence=0.0, n_samples=len(valid), n_total=n_total,
                               cross_sections=cross)

    widths = sorted(c.width_m for c in valid)
    median_w = widths[len(widths) // 2] if len(widths) % 2 else \
        (widths[len(widths) // 2 - 1] + widths[len(widths) // 2]) / 2.0
    road_conf = _road_confidence(valid)
    return RoadWidthResult(road_id=str(road_id), width_m=round(median_w, 2),
                           confidence=round(road_conf, 3), n_samples=len(valid),
                           n_total=n_total, cross_sections=cross)


def _snap_to_road(mask, x, y, nx, ny, max_px, step=1.0):
    """中心線位置が非道路のとき、法線±方向に少し探して最寄りの道路画素へ寄せる。"""
    d = 0.0
    while d <= max_px:
        for sgn in (1.0, -1.0):
            px, py = x + nx * d * sgn, y + ny * d * sgn
            if _sample_mask(mask, px, py) == 1:
                return px, py, True
        d += step
    return x, y, False


def _local_to_lonlat(grid: TileGrid, x, y):
    from .geo import global_px_to_lonlat
    ox, oy = grid.origin_px
    return global_px_to_lonlat(ox + x, oy + y, grid.zoom, grid.tile_size)


def _section_confidence(left_px, right_px, max_half_px, clipped):
    """断面ごとの信頼度。端が両側くっきり見つかり・左右対称なほど高い。"""
    if clipped:
        return 0.25
    # 左右対称性（路駐などで片側が欠けると非対称になる）
    total = left_px + right_px
    if total <= 0:
        return 0.0
    asym = abs(left_px - right_px) / total            # 0=完全対称
    sym_score = max(0.0, 1.0 - asym)                  # 0..1
    # 探索上限に近いほど不確か
    margin_score = 1.0 - min(1.0, max(left_px, right_px) / max_half_px)
    base = 0.55
    return float(max(0.2, min(0.95, base + 0.30 * sym_score + 0.10 * margin_score)))


def _road_confidence(valid_sections):
    """道路レベルの信頼度。断面数が多くばらつきが小さいほど高い（JS集約と整合）。"""
    confs = [c.confidence for c in valid_sections]
    widths = [c.width_m for c in valid_sections]
    avg_conf = sum(confs) / len(confs)
    n = len(valid_sections)
    support = min(0.14, max(0, n - 1) * 0.02)
    mean_w = sum(widths) / len(widths)
    if mean_w > 0 and n > 1:
        var = sum((w - mean_w) ** 2 for w in widths) / n
        spread_ratio = math.sqrt(var) / mean_w
    else:
        spread_ratio = 0.0
    conflict = min(0.28, max(0.0, spread_ratio - 0.06) * 0.9)
    return max(0.2, min(0.97, avg_conf + support - conflict))
