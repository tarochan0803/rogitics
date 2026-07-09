"""道路面セグメンテーションの差し替え式バックエンド。

RoadSegmenter.segment(rgb) -> 道路面マスク(0/1) という単一インターフェイスに統一し、
パイプライン以降（measure / pipeline / server）はモデル実装に依存しない。

実装:
- SyntheticRoadSegmenter : 既知幅の道路を描く。学習もネットワークも不要で
  幾何エンジン（measure.py）を即検証するための土台（selfcheck で使用）。
- ThresholdRoadSegmenter : 学習ゼロの素朴ベースライン。GSI画像に今すぐ当てて
  「どこまで取れるか」の感触を掴む用（手順1の最初の一歩）。
- PretrainedRoadSegmenter : DeepGlobe/SpaceNet/SAM-Road などの学習済み重み、
  および手順2で微調整した DeepLabV3+/U-Net を差し込むフック。

すべて numpy(+任意でPIL) のみ。重いMLライブラリは PretrainedRoadSegmenter に閉じ込め、
インポート時に落とさない（遅延 import）。
"""

from __future__ import annotations

from abc import ABC, abstractmethod

import numpy as np

from .geo import TileGrid, meters_per_pixel


class RoadSegmenter(ABC):
    name = "base"

    @abstractmethod
    def segment(self, rgb: np.ndarray) -> np.ndarray:
        """HxWx3 uint8 RGB -> HxW の道路面マスク(bool/uint8, 道路=1)。"""
        raise NotImplementedError


def _binary_close(mask: np.ndarray, iters: int = 1) -> np.ndarray:
    """3x3 の dilation->erosion（小穴埋め）。scipy 非依存の簡易版。"""
    m = mask.astype(bool)
    for _ in range(max(0, iters)):
        m = _dilate3(m)
    for _ in range(max(0, iters)):
        m = _erode3(m)
    return m


def _shift_or(acc, m, dy, dx):
    h, w = m.shape
    ys0, ys1 = max(0, dy), min(h, h + dy)
    xs0, xs1 = max(0, dx), min(w, w + dx)
    yt0, yt1 = max(0, -dy), min(h, h - dy)
    xt0, xt1 = max(0, -dx), min(w, w - dx)
    acc[ys0:ys1, xs0:xs1] |= m[yt0:yt1, xt0:xt1]
    return acc


def _dilate3(m):
    acc = m.copy()
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            _shift_or(acc, m, dy, dx)
    return acc


def _erode3(m):
    return ~_dilate3(~m)


class SyntheticRoadSegmenter(RoadSegmenter):
    """与えた中心線まわりに既知幅 width_m の道路帯を描く合成バックエンド。

    segment() は受け取った rgb の解像度を無視し、コンストラクタで束ねた grid/中心線/幅から
    マスクを生成する（幾何エンジン検証用）。実画像は要らない。
    """
    name = "synthetic"

    def __init__(self, grid: TileGrid, centerline_lonlat, width_m: float,
                 noise_px: float = 0.0, seed: int = 0):
        self.grid = grid
        self.centerline = [(float(c[0]), float(c[1])) for c in centerline_lonlat]
        self.width_m = float(width_m)
        self.noise_px = float(noise_px)
        self._rng = np.random.default_rng(seed)

    def render_mask(self) -> np.ndarray:
        grid = self.grid
        h, w = grid.height_px, grid.width_px
        mask = np.zeros((h, w), dtype=bool)
        lat = sum(p[1] for p in self.centerline) / len(self.centerline)
        m_per_px = meters_per_pixel(lat, grid.zoom, grid.tile_size)
        half_px = (self.width_m / m_per_px) / 2.0
        pts = [grid.lonlat_to_local(lon, la) for lon, la in self.centerline]
        # 各セグメントを太さ 2*half_px の帯として塗る（距離場で判定）
        yy, xx = np.mgrid[0:h, 0:w]
        for i in range(len(pts) - 1):
            x0, y0 = pts[i]
            x1, y1 = pts[i + 1]
            dist = _dist_to_segment(xx, yy, x0, y0, x1, y1)
            edge = half_px
            if self.noise_px > 0:
                edge = half_px + self._rng.normal(0.0, self.noise_px)
            mask |= dist <= edge
        return mask

    def segment(self, rgb: np.ndarray) -> np.ndarray:
        return self.render_mask()


def _dist_to_segment(px, py, x0, y0, x1, y1):
    vx, vy = x1 - x0, y1 - y0
    L2 = vx * vx + vy * vy
    if L2 <= 1e-9:
        return np.hypot(px - x0, py - y0)
    t = ((px - x0) * vx + (py - y0) * vy) / L2
    t = np.clip(t, 0.0, 1.0)
    projx = x0 + t * vx
    projy = y0 + t * vy
    return np.hypot(px - projx, py - projy)


class ThresholdRoadSegmenter(RoadSegmenter):
    """学習ゼロの素朴ベースライン。舗装路の「低彩度・中明度のグレー」を拾う。

    精度は出ない前提。手順1で「公開学習済みモデルを入れる前に、配管とm/pixel換算が
    機能するか」を実画像で素早く確かめる用途。実運用には使わない。
    """
    name = "threshold"

    def __init__(self, sat_max: float = 0.22, val_lo: int = 55, val_hi: int = 205,
                 close_iters: int = 2):
        self.sat_max = sat_max
        self.val_lo = val_lo
        self.val_hi = val_hi
        self.close_iters = close_iters

    def segment(self, rgb: np.ndarray) -> np.ndarray:
        arr = np.asarray(rgb)
        if arr.ndim == 2:
            arr = np.stack([arr] * 3, axis=-1)
        arr = arr[:, :, :3].astype(np.float32)
        mx = arr.max(axis=2)
        mn = arr.min(axis=2)
        val = mx
        sat = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1.0), 0.0)
        mask = (sat <= self.sat_max) & (val >= self.val_lo) & (val <= self.val_hi)
        return _binary_close(mask, self.close_iters)


class PretrainedRoadSegmenter(RoadSegmenter):
    """学習済み道路抽出モデルを差し込むフック（手順1の本命 / 手順2の微調整後モデル）。

    predict_fn(rgb_uint8_HxWx3) -> mask(HxW, 0..1 or bool) を渡せばそのまま使える。
    DeepGlobe/SpaceNet 学習済み U-Net、SAM-Road、あるいは手順2で fine-tune した
    DeepLabV3+/segmentation_models_pytorch のU-Net をここに包む。

    ライセンス注意（商用クローズド前提）:
    - segmentation_models_pytorch の U-Net / DeepLabV3+ (MIT) は安全。
    - SegFormer 公式重みは商用に引っかかりやすいので確認すること。
    - Ultralytics(YOLO, AGPL) は本パイプラインでは使わない。
    """
    name = "pretrained"

    def __init__(self, predict_fn=None, threshold: float = 0.5):
        self.predict_fn = predict_fn
        self.threshold = threshold

    def segment(self, rgb: np.ndarray) -> np.ndarray:
        if self.predict_fn is None:
            raise NotImplementedError(
                "PretrainedRoadSegmenter に predict_fn が未設定です。\n"
                "DeepGlobe/SpaceNet 学習済み重み（手順1）や微調整モデル（手順2）の推論関数 "
                "predict_fn(rgb)->mask を渡してください。\n"
                "例: PretrainedRoadSegmenter(predict_fn=lambda rgb: model(preprocess(rgb)))"
            )
        out = np.asarray(self.predict_fn(rgb))
        if out.dtype == bool:
            return out
        return out >= self.threshold


def get_segmenter(name: str, **kwargs) -> RoadSegmenter:
    key = (name or "threshold").lower()
    if key == "threshold":
        return ThresholdRoadSegmenter(**kwargs)
    if key == "pretrained":
        return PretrainedRoadSegmenter(**kwargs)
    if key == "synthetic":
        return SyntheticRoadSegmenter(**kwargs)
    raise ValueError(f"unknown segmenter backend: {name}")
