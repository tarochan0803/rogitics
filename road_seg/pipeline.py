"""オーケストレーション: 道路ジオメトリ + ズーム + セグメンタ -> widthSamples。

手順3（/segment_road_width）と手順1/2の検証スクリプトが共有する1本の処理線。
JS側を汚さないため、垂線サンプリング（measure）までサーバ内で完結し、出力は
既存知覚融合が食う widthSamples 形式に揃える。

道路の入力は GeoJSON ライクな dict:
  {"id": "...", "geometry": {"type": "LineString", "coordinates": [[lon,lat],...]}}
MultiLineString も可（各パートを別サンプル群として測る）。
"""

from __future__ import annotations

from dataclasses import asdict

from .measure import measure_road_width
from .segmenter import RoadSegmenter, SyntheticRoadSegmenter
from .width_class import classify_width


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


def _road_id(road, idx):
    return str(road.get("id") if road.get("id") is not None
               else road.get("properties", {}).get("id", idx))


def measure_roads_offline(roads, mask, grid, *,
                          spacing_m=8.0, max_half_width_m=12.0):
    """既に用意したマスク1枚（全道路を覆う）で複数道路を測る（手順1の評価用）。"""
    results = []
    for idx, road in enumerate(roads):
        rid = _road_id(road, idx)
        for line in _iter_lines(road.get("geometry")):
            res = measure_road_width(rid, line, mask, grid,
                                     spacing_m=spacing_m,
                                     max_half_width_m=max_half_width_m)
            results.append(res)
    return results


def run_pipeline(roads, *, zoom=18, segmenter: RoadSegmenter = None,
                 layer="seamlessphoto", spacing_m=8.0, max_half_width_m=12.0,
                 min_confidence=0.45, fetcher=None):
    """道路ごとに GSI タイル取得 -> セグメンテーション -> 幅計測 -> 集約。

    segmenter: RoadSegmenter（未指定は threshold ベースライン）
    fetcher:   テスト差し替え用。None なら tiles.fetch_for_centerline を使う（ネット必要）。
    返り値: {"widthSamples":[...], "summaries":[...], "meta":{...}}
    """
    if segmenter is None:
        from .segmenter import ThresholdRoadSegmenter
        segmenter = ThresholdRoadSegmenter()
    if fetcher is None:
        from .tiles import fetch_for_centerline
        def fetcher(coords):
            r = fetch_for_centerline(coords, zoom, layer=layer)
            return r.rgb, r.grid

    width_samples = []
    summaries = []
    missing = 0
    for idx, road in enumerate(roads):
        rid = _road_id(road, idx)
        for line in _iter_lines(road.get("geometry")):
            if not line or len(line) < 2:
                continue
            rgb, grid = fetcher(line)
            # SyntheticRoadSegmenter は grid と中心線を内部に束ねている場合がある
            mask = segmenter.segment(rgb)
            res = measure_road_width(rid, line, mask, grid,
                                     spacing_m=spacing_m,
                                     max_half_width_m=max_half_width_m)
            samples = res.to_width_samples()
            width_samples.extend(samples)
            tier = classify_width(res.width_m, res.confidence, min_confidence)
            summaries.append({
                "roadId": rid,
                "widthM": res.width_m,
                "confidence": res.confidence,
                "tier": tier["key"],
                "tierLabel": tier["label"],
                "nSamples": res.n_samples,
                "nTotal": res.n_total,
                "segmenter": getattr(segmenter, "name", "?"),
            })
    return {
        "widthSamples": width_samples,
        "summaries": summaries,
        "meta": {
            "zoom": zoom,
            "layer": layer,
            "segmenter": getattr(segmenter, "name", "?"),
            "roadCount": len(roads),
            "sampleCount": len(width_samples),
        },
    }
