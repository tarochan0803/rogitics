"""道路幅の階級判定（手順5の表示層と整合）。

「4.213m」のような細かい値ではなく、業務で使える階級で返すための単一定義。
JS 側（src/core/widthClass.js）と同じ閾値・同じキーに揃えること。
"""

from __future__ import annotations

# 上限は含まない区間（min <= w < max）。広い順。
WIDTH_TIERS = [
    {"key": "ge6",      "label": "6m以上",      "min": 6.0,  "max": None},
    {"key": "w45_6",    "label": "4.5〜6m",     "min": 4.5,  "max": 6.0},
    {"key": "w35_45",   "label": "3.5〜4.5m",   "min": 3.5,  "max": 4.5},
    {"key": "lt35",     "label": "3.5m未満",    "min": 0.0,  "max": 3.5},
]
UNKNOWN_TIER = {"key": "unknown", "label": "不明", "min": None, "max": None}

# この信頼度を下回ったら値があっても「不明」に倒す
DEFAULT_MIN_CONFIDENCE = 0.45


def classify_width(width_m, confidence=1.0, min_confidence=DEFAULT_MIN_CONFIDENCE):
    """幅[m]と信頼度から階級dictを返す。値が無い/低信頼なら unknown。"""
    if width_m is None:
        return dict(UNKNOWN_TIER)
    try:
        w = float(width_m)
    except (TypeError, ValueError):
        return dict(UNKNOWN_TIER)
    if confidence is not None and float(confidence) < min_confidence:
        return dict(UNKNOWN_TIER)
    for tier in WIDTH_TIERS:
        lo = tier["min"]
        hi = tier["max"]
        if (lo is None or w >= lo) and (hi is None or w < hi):
            return dict(tier)
    return dict(UNKNOWN_TIER)
