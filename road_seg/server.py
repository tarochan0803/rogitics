"""手順3: POST /segment_road_width。

入力は道路ジオメトリ（OSM中心線）＋ズーム。サーバ内で GSI タイル取得→
セグメンテーション→垂線サンプリングまで完結し、JS側は触らずに済むよう
既存知覚融合と同じ widthSamples を返す。

AGPL の YOLO サーバ(server/app.py)とは別プロセス・別依存で動く独立アプリ。
起動:  uvicorn road_seg.server:app --port 8012
（プロジェクトルートから。road_seg がパッケージとして見える場所で実行する）
"""

from __future__ import annotations

import base64
import io
import os
from typing import Any, List, Optional

import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from .pipeline import run_pipeline
from .segmenter import get_segmenter
from .surface import run_surface_pipeline
from .width_class import classify_width

app = FastAPI(title="Road Segmentation Width Server")

_HERE = os.path.dirname(os.path.abspath(__file__))

_origins = os.getenv("LOGISTICS_ALLOWED_ORIGINS", "").strip()
allow = [o.strip() for o in _origins.split(",") if o.strip()] or ["*"]
app.add_middleware(
    CORSMiddleware,
    allow_origins=allow,
    allow_methods=["*"],
    allow_headers=["*"],
)


class Geometry(BaseModel):
    type: str
    coordinates: Any


class Road(BaseModel):
    id: Optional[str] = None
    geometry: Geometry
    properties: Optional[dict] = None


class SegmentRoadWidthRequest(BaseModel):
    roads: List[Road]
    zoom: int = 18
    layer: str = "seamlessphoto"
    backend: str = Field(default="threshold",
                         description="threshold | pretrained | synthetic")
    spacingM: float = 8.0
    maxHalfWidthM: float = 12.0
    minConfidence: float = 0.45


class SegmentRoadSurfaceRequest(BaseModel):
    roads: List[Road] = Field(default_factory=list)
    bbox: Optional[List[float]] = Field(default=None, description="[minLon, minLat, maxLon, maxLat]")
    zoom: int = 18
    layer: str = "seamlessphoto"
    backend: str = Field(default="threshold",
                         description="threshold | pretrained")
    marginTiles: int = 0
    maxTiles: int = 64
    roadBufferM: float = 28.0
    cellPx: int = 6
    fillRatio: float = 0.35
    minAreaM2: float = 12.0
    maxPolygons: int = 400


def _road_surface_segmenter(backend: str):
    backend = (backend or "threshold").lower()
    if backend == "pretrained":
        from . import infer
        from .segmenter import PretrainedRoadSegmenter
        if not infer.available():
            raise HTTPException(
                status_code=501,
                detail="pretrained model is not available. Run road_seg.train first or use backend=threshold.")
        try:
            return PretrainedRoadSegmenter(predict_fn=infer.get_predict_fn())
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"model load failed: {e}")
    if backend == "synthetic":
        raise HTTPException(status_code=400, detail="backend=synthetic is only for offline tests")
    try:
        return get_segmenter(backend)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


def _centerlines_for_ui(centerlines, grid):
    """Convert RDCL lon/lat centerlines to compact pixel geometry for annotate UI."""
    out = []
    for idx, cl in enumerate(centerlines or []):
        coords = cl.get("coords") or []
        if len(coords) < 2:
            continue
        pixels = []
        lonlats = []
        for coord in coords:
            try:
                lon = float(coord[0])
                lat = float(coord[1])
            except Exception:
                continue
            x, y = grid.lonlat_to_local(lon, lat)
            pixels.append([round(float(x), 2), round(float(y), 2)])
            lonlats.append([lon, lat])
        if len(pixels) < 2:
            continue
        out.append({
            "id": cl.get("id") or f"rdcl-{idx}",
            "rank": cl.get("rank"),
            "fullWidthM": float(cl.get("fullWidthM") or 4.0),
            "pixels": pixels,
            "coords": lonlats,
        })
    return out


@app.get("/health")
def health():
    return {
        "status": "ok",
        "service": "road_seg",
        "backends": ["threshold", "pretrained", "synthetic"],
        "endpoints": [
            "/segment_road_width",
            "/segment_road_surface",
            "/annotate/ui",
            "/annotate/fetch",
            "/annotate/save",
            "/annotate/stats",
        ],
    }


@app.post("/segment_road_width")
def segment_road_width(req: SegmentRoadWidthRequest):
    """道路群 -> widthSamples（+ 階級つき summaries）。"""
    roads = [r.model_dump() for r in req.roads]
    if not roads:
        raise HTTPException(status_code=400, detail="roads is empty")

    backend = (req.backend or "threshold").lower()
    if backend == "pretrained":
        # 学習済みモデル（road_seg.train の重み）があれば自動で使う。
        from . import infer
        from .segmenter import PretrainedRoadSegmenter
        if not infer.available():
            raise HTTPException(
                status_code=501,
                detail="学習済みモデルが未整備です。先に annotate で教師データを貯め、"
                       "road_seg.train を実行してください（または backend=threshold）。")
        try:
            segmenter = PretrainedRoadSegmenter(predict_fn=infer.get_predict_fn())
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"モデル読み込み失敗: {e}")
    else:
        try:
            segmenter = get_segmenter(backend)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))

    try:
        result = run_pipeline(
            roads, zoom=req.zoom, segmenter=segmenter, layer=req.layer,
            spacing_m=req.spacingM, max_half_width_m=req.maxHalfWidthM,
            min_confidence=req.minConfidence,
        )
    except Exception as e:  # ネット不通・タイル欠損などはここで 502
        raise HTTPException(status_code=502, detail=f"pipeline error: {e}")

    return result


@app.post("/segment_road_surface")
def segment_road_surface(req: SegmentRoadSurfaceRequest):
    """Roads/bbox -> GeoJSON polygons for maskEdits.allow road-surface reinforcement."""
    roads = [r.model_dump() for r in (req.roads or [])]
    if not roads and not req.bbox:
        raise HTTPException(status_code=400, detail="roads or bbox is required")

    segmenter = _road_surface_segmenter(req.backend)
    try:
        return run_surface_pipeline(
            roads,
            bbox=req.bbox,
            zoom=req.zoom,
            segmenter=segmenter,
            layer=req.layer,
            margin_tiles=req.marginTiles,
            max_tiles=req.maxTiles,
            road_buffer_m=req.roadBufferM,
            cell_px=req.cellPx,
            fill_ratio=req.fillRatio,
            min_area_m2=req.minAreaM2,
            max_polygons=req.maxPolygons,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"surface pipeline error: {e}")


@app.post("/classify")
def classify(width_m: float, confidence: float = 1.0):
    """幅[m]→階級。表示層の確認用。"""
    return classify_width(width_m, confidence)


# ============================================================
# 教師データ作成（アノテーション）: 地図で範囲選択→下書き→修正→保存
# ============================================================

class AnnotateFetchRequest(BaseModel):
    bbox: List[float] = Field(..., description="[minLon, minLat, maxLon, maxLat]")
    zoom: int = 18
    initMask: str = Field(default="rdcl", description="rdcl | pretrained | threshold | blank")
    maxTiles: int = 64


class AnnotateSaveRequest(BaseModel):
    id: str
    maskPng: str = Field(..., description="data:image/png;base64,... または base64本体")
    meta: Optional[dict] = None


def _decode_data_url(s: str) -> bytes:
    if "," in s and s.strip().lower().startswith("data:"):
        s = s.split(",", 1)[1]
    return base64.b64decode(s)


@app.get("/annotate/ui")
def annotate_ui():
    """ラベル作成ページ(annotate.html)を返す。"""
    path = os.path.join(_HERE, "annotate.html")
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="annotate.html not found")
    return FileResponse(path, media_type="text/html")


@app.get("/annotate/stats")
def annotate_stats():
    from . import dataset
    return dataset.stats()


def _annotate_fetch_v2(req: AnnotateFetchRequest):
    """Fetch an aerial image, initial mask, and editable RDCL centerlines."""
    from . import dataset
    from . import rdcl as rdcl_mod
    from .geo import tile_grid_for_bbox
    from .tiles import fetch_stitched

    if len(req.bbox) != 4:
        raise HTTPException(status_code=400, detail="bbox must be [minLon,minLat,maxLon,maxLat]")
    min_lon, min_lat, max_lon, max_lat = req.bbox
    zoom = max(1, min(int(req.zoom), 18))

    grid = tile_grid_for_bbox(min_lon, min_lat, max_lon, max_lat, zoom, margin_tiles=0)
    n_tiles = (grid.x_max - grid.x_min + 1) * (grid.y_max - grid.y_min + 1)
    if n_tiles > req.maxTiles:
        raise HTTPException(status_code=400, detail=f"bbox is too large ({n_tiles} tiles). Zoom in and retry.")

    try:
        stitch = fetch_stitched(min_lon, min_lat, max_lon, max_lat, zoom, margin_tiles=0)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"aerial image fetch failed: {e}")
    rgb, grid = stitch.rgb, stitch.grid

    centerlines = []
    mode = (req.initMask or "rdcl").lower()
    if mode == "blank":
        mask = np.zeros((grid.height_px, grid.width_px), dtype=bool)
    elif mode == "threshold":
        from .segmenter import ThresholdRoadSegmenter
        mask = ThresholdRoadSegmenter().segment(rgb)
    elif mode == "pretrained":
        from . import infer
        if not infer.available():
            raise HTTPException(status_code=501, detail="pretrained model is not available. Train a model first.")
        mask = infer.get_predict_fn()(rgb)
    else:
        mode = "rdcl"
        centerlines = rdcl_mod.fetch_centerlines(min_lon, min_lat, max_lon, max_lat)
        mask = rdcl_mod.rasterize_initial_mask(centerlines, grid) if centerlines else np.zeros((grid.height_px, grid.width_px), dtype=bool)

    if not centerlines and mode != "blank":
        try:
            centerlines = rdcl_mod.fetch_centerlines(min_lon, min_lat, max_lon, max_lat)
        except Exception:
            centerlines = []

    sample_id = dataset.new_id()
    dataset.save_pending(sample_id, rgb)
    return {
        "id": sample_id,
        "width": int(grid.width_px),
        "height": int(grid.height_px),
        "zoom": zoom,
        "bbox": [min_lon, min_lat, max_lon, max_lat],
        "tiles": n_tiles,
        "missingTiles": stitch.missing_tiles,
        "initMask": mode,
        "image": dataset.b64_png(dataset._png_bytes_from_rgb(rgb)),
        "mask": dataset.b64_png(dataset._png_bytes_from_mask(mask)),
        "centerlines": _centerlines_for_ui(centerlines, grid),
    }


@app.post("/annotate/fetch")
def annotate_fetch(req: AnnotateFetchRequest):
    return _annotate_fetch_v2(req)
    """地図範囲の航空写真を取得し、初期道路マスク（下書き）とともに返す。"""
    from . import dataset
    from .geo import tile_grid_for_bbox
    from .tiles import fetch_stitched
    if len(req.bbox) != 4:
        raise HTTPException(status_code=400, detail="bbox は [minLon,minLat,maxLon,maxLat]")
    min_lon, min_lat, max_lon, max_lat = req.bbox
    zoom = max(1, min(int(req.zoom), 18))

    grid = tile_grid_for_bbox(min_lon, min_lat, max_lon, max_lat, zoom, margin_tiles=0)
    n_tiles = (grid.x_max - grid.x_min + 1) * (grid.y_max - grid.y_min + 1)
    if n_tiles > req.maxTiles:
        raise HTTPException(status_code=400,
                            detail=f"範囲が広すぎます（{n_tiles}タイル）。地図をズームインしてください。")

    try:
        stitch = fetch_stitched(min_lon, min_lat, max_lon, max_lat, zoom, margin_tiles=0)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"航空写真の取得に失敗: {e}")
    rgb, grid = stitch.rgb, stitch.grid

    mode = (req.initMask or "rdcl").lower()
    if mode == "blank":
        mask = np.zeros((grid.height_px, grid.width_px), dtype=bool)
    elif mode == "threshold":
        from .segmenter import ThresholdRoadSegmenter
        mask = ThresholdRoadSegmenter().segment(rgb)
    elif mode == "pretrained":
        from . import infer
        if not infer.available():
            raise HTTPException(status_code=501,
                                detail="学習済みモデルが未整備です（先に road_seg.train）。")
        mask = infer.get_predict_fn()(rgb)
    else:  # rdcl（既定）: GSI中心線から下書き
        mode = "rdcl"
        from . import rdcl as rdcl_mod
        mask = rdcl_mod.initial_mask_for_grid(grid, (min_lon, min_lat, max_lon, max_lat))

    sample_id = dataset.new_id()
    dataset.save_pending(sample_id, rgb)
    return {
        "id": sample_id,
        "width": int(grid.width_px),
        "height": int(grid.height_px),
        "zoom": zoom,
        "bbox": [min_lon, min_lat, max_lon, max_lat],
        "tiles": n_tiles,
        "missingTiles": stitch.missing_tiles,
        "initMask": mode,
        "image": dataset.b64_png(dataset._png_bytes_from_rgb(rgb)),
        "mask": dataset.b64_png(dataset._png_bytes_from_mask(mask)),
    }


@app.post("/annotate/save")
def annotate_save(req: AnnotateSaveRequest):
    """修正済みマスクを保存し、pending画像を教師データへ確定する。"""
    from . import dataset
    try:
        mask_bytes = _decode_data_url(req.maskPng)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"maskPng を復号できません: {e}")
    try:
        result = dataset.commit(req.id, mask_bytes, req.meta or {})
    except FileNotFoundError:
        raise HTTPException(status_code=404,
                            detail="対象の取得画像が見つかりません（先に『この範囲で道路取得』してください）。")
    return result


if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", "8012"))
    uvicorn.run("road_seg.server:app", host="0.0.0.0", port=port, reload=False)
