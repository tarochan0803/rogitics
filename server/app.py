import os
import base64
import json
import logging
from contextlib import asynccontextmanager
from io import BytesIO
from typing import List, Optional, Dict, Any

import requests
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from PIL import Image
from ultralytics import YOLO

try:
    import torch
except Exception:
    torch = None

try:
    from runtime_settings import get_allowed_origins
except ImportError:
    from server.runtime_settings import get_allowed_origins



APP_TITLE = 'Truck YOLO Server'
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.abspath(os.path.join(BASE_DIR, '..'))


def parse_allowed_origins(raw: str) -> List[str]:
    text = (raw or '').strip()
    if not text:
        return [
            'http://127.0.0.1:8080',
            'http://localhost:8080',
            'http://127.0.0.1:8000',
            'http://localhost:8000',
        ]
    if text == '*':
        return ['*']
    return [item.strip() for item in text.split(',') if item.strip()]


def resolve_model_path(name: str) -> str:
    if not name:
        return name
    if os.path.isabs(name) and os.path.exists(name):
        return name
    candidates = [
        BASE_DIR,
        PROJECT_ROOT,
    ]
    for base in candidates:
        candidate = os.path.join(base, name)
        if os.path.exists(candidate):
            return candidate
    # Keep unresolved files under server/ rather than arbitrary CWD.
    return os.path.join(BASE_DIR, name)


MODEL_NAME = resolve_model_path(os.getenv('YOLO_MODEL', 'yolov8n.pt'))
CONF_DEFAULT = float(os.getenv('YOLO_CONF', '0.25'))
IOU_DEFAULT = float(os.getenv('YOLO_IOU', '0.45'))
MAX_BATCH = int(os.getenv('YOLO_MAX_BATCH', '48'))
FETCH_TIMEOUT = float(os.getenv('YOLO_FETCH_TIMEOUT', '12'))

SEG_MODEL_NAME = resolve_model_path(os.getenv('YOLO_SEG_MODEL', 'yolov8n-seg.pt'))
SEG_CONF_DEFAULT = float(os.getenv('YOLO_SEG_CONF', '0.25'))
SEG_IOU_DEFAULT = float(os.getenv('YOLO_SEG_IOU', '0.45'))
SEG_MAX_BATCH = int(os.getenv('YOLO_SEG_MAX_BATCH', '24'))
SEG_MAX_POINTS = int(os.getenv('YOLO_SEG_MAX_POINTS', '120'))
SEG_CLASS_FILTER = os.getenv('YOLO_SEG_CLASSES', '')
OLLAMA_BASE_URL = os.getenv('OLLAMA_BASE_URL', 'http://127.0.0.1:11434').rstrip('/')
OLLAMA_MODEL_DEFAULT = os.getenv('OLLAMA_MODEL', 'llava')
OLLAMA_TIMEOUT = float(os.getenv('OLLAMA_TIMEOUT', '60'))
_allowed_origins_raw = os.getenv('LOGISTICS_ALLOWED_ORIGINS', '')
ALLOWED_ORIGINS = parse_allowed_origins(_allowed_origins_raw) if _allowed_origins_raw.strip() else get_allowed_origins()

# Sprint1 P0-4: X-Api-Key 認証。
# YOLO_API_KEY が設定されているとき、/health 以外のすべてのリクエストで
# `X-Api-Key` ヘッダの照合を要求する。未設定（空文字）の場合は認証を無効化する
# が、起動時に警告ログを出して気付けるようにする。
YOLO_API_KEY = os.getenv('YOLO_API_KEY', '').strip()
# 認証を必須にしないパス（プローブ用途）。
AUTH_EXEMPT_PATHS = {'/health'}

model = None
model_error = None
seg_model = None
seg_model_error = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global model, model_error, seg_model, seg_model_error
    try:
        model = YOLO(MODEL_NAME)
    except Exception as exc:
        model_error = str(exc)
    try:
        seg_model = YOLO(SEG_MODEL_NAME)
    except Exception as exc:
        seg_model_error = str(exc)
    yield


app = FastAPI(title=APP_TITLE, lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=['GET', 'POST', 'OPTIONS'],
    # Sprint1 P0-4: クライアントから X-Api-Key を送れるようにヘッダ許可に追加。
    allow_headers=['Content-Type', 'X-Api-Key'],
)


@app.middleware('http')
async def _require_api_key(request: Request, call_next):
    """Sprint1 P0-4: X-Api-Key 認証ミドルウェア。

    - YOLO_API_KEY 未設定: 無認証で動作（起動時に警告は別途出る）。
    - 設定済み: AUTH_EXEMPT_PATHS と CORS プリフライト（OPTIONS）以外は照合。
    - キー不一致または欠落は 401 を返す。タイミング攻撃は本用途の脅威モデル上
      重要でないが、定数時間比較を用いる。
    """
    if not YOLO_API_KEY:
        return await call_next(request)
    if request.method == 'OPTIONS':
        return await call_next(request)
    if request.url.path in AUTH_EXEMPT_PATHS:
        return await call_next(request)
    provided = request.headers.get('x-api-key') or ''
    import hmac
    if not hmac.compare_digest(provided, YOLO_API_KEY):
        return JSONResponse(
            status_code=401,
            content={'error': 'invalid_api_key', 'detail': 'X-Api-Key required'},
        )
    return await call_next(request)


if not YOLO_API_KEY:
    logging.getLogger('uvicorn.error').warning(
        'YOLO_API_KEY is not set. The YOLO server is running WITHOUT authentication. '
        'This is acceptable for trusted localhost-only use; set YOLO_API_KEY for any other deployment.'
    )


class DetectRequest(BaseModel):
    image_url: str = Field(..., description='Image URL to fetch')
    conf: Optional[float] = None
    iou: Optional[float] = None
    max_det: Optional[int] = None


class BatchItem(BaseModel):
    id: Optional[str] = None
    image_url: str
    lat: Optional[float] = None
    lng: Optional[float] = None
    heading: Optional[float] = None


class BatchRequest(BaseModel):
    items: List[BatchItem]
    conf: Optional[float] = None
    iou: Optional[float] = None
    max_det: Optional[int] = None


class SegmentRequest(BaseModel):
    image_url: str = Field(..., description='Image URL to fetch')
    conf: Optional[float] = None
    iou: Optional[float] = None
    max_det: Optional[int] = None
    classes: Optional[List[str]] = None


class SegmentBatchRequest(BaseModel):
    items: List[BatchItem]
    conf: Optional[float] = None
    iou: Optional[float] = None
    max_det: Optional[int] = None
    classes: Optional[List[str]] = None


class VoxelFeature(BaseModel):
    id: Optional[str] = None
    geometry: Dict[str, Any]
    properties: Optional[Dict[str, Any]] = None


class VoxelCollisionRequest(BaseModel):
    footprints: List[VoxelFeature]
    obstacles: List[VoxelFeature]
    vehicleHeight: Optional[float] = 0
    clearance: Optional[float] = 0.25
    voxelSizeMeters: Optional[float] = 0.5
    maxContactPoints: Optional[int] = 240


def gpu_info() -> Dict[str, Any]:
    if torch is None:
        return {'torch': False, 'cuda': False, 'device': None}
    cuda = bool(torch.cuda.is_available())
    return {
        'torch': True,
        'cuda': cuda,
        'device': torch.cuda.get_device_name(0) if cuda else None,
        'device_count': torch.cuda.device_count() if cuda else 0,
    }


def fetch_image(url: str) -> Image.Image:
    try:
        res = requests.get(url, timeout=FETCH_TIMEOUT)
    except requests.RequestException as exc:
        raise HTTPException(status_code=502, detail=f'fetch failed: {exc}') from exc
    if res.status_code != 200:
        raise HTTPException(status_code=502, detail=f'fetch failed: {res.status_code}')
    try:
        return Image.open(BytesIO(res.content)).convert('RGB')
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f'decode failed: {exc}') from exc


def get_detect_model() -> YOLO:
    global model, model_error
    if model is not None:
        return model
    if model_error:
        raise HTTPException(status_code=500, detail=f'model load failed: {model_error}')
    try:
        model = YOLO(MODEL_NAME)
        return model
    except Exception as exc:
        model_error = str(exc)
        raise HTTPException(status_code=500, detail=f'model load failed: {model_error}') from exc


def get_seg_model() -> YOLO:
    global seg_model, seg_model_error
    if seg_model is not None:
        return seg_model
    if seg_model_error:
        raise HTTPException(status_code=500, detail=f'seg model load failed: {seg_model_error}')
    try:
        seg_model = YOLO(SEG_MODEL_NAME)
        return seg_model
    except Exception as exc:
        seg_model_error = str(exc)
        raise HTTPException(status_code=500, detail=f'seg model load failed: {seg_model_error}') from exc


def normalize_class_filter(classes: Optional[List[str]]) -> Optional[set]:
    if classes:
        return {str(c).strip().lower() for c in classes if str(c).strip()}
    if SEG_CLASS_FILTER:
        return {c.strip().lower() for c in SEG_CLASS_FILTER.split(',') if c.strip()}
    return None


def get_seg_class_names() -> List[str]:
    model = get_seg_model()
    names = model.names if hasattr(model, 'names') else {}
    if isinstance(names, dict):
        return [names[k] for k in sorted(names)]
    if isinstance(names, list):
        return names
    return []


def simplify_mask(points, max_points: int):
    if points is None:
        return []
    pts = points.tolist() if hasattr(points, 'tolist') else list(points)
    if not pts:
        return []
    if max_points <= 0 or len(pts) <= max_points:
        return [[round(float(x), 1), round(float(y), 1)] for x, y in pts]
    step = max(1, len(pts) // max_points)
    simplified = pts[::step]
    return [[round(float(x), 1), round(float(y), 1)] for x, y in simplified]


def run_detect(image: Image.Image, conf: float, iou: float, max_det: Optional[int]):
    detect_model = get_detect_model()
    try:
        results = detect_model.predict(image, conf=conf, iou=iou, max_det=max_det, verbose=False)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f'inference failed: {exc}') from exc

    if not results:
        return [], image.size

    result = results[0]
    names = result.names or {}
    detections = []
    for box in result.boxes:
        cls_id = int(box.cls[0])
        conf_val = float(box.conf[0])
        x1, y1, x2, y2 = [float(v) for v in box.xyxy[0].tolist()]
        detections.append(
            {
                'cls': cls_id,
                'name': names.get(cls_id, str(cls_id)),
                'conf': conf_val,
                'bbox': [x1, y1, x2, y2],
            }
        )
    return detections, image.size


def run_segment(image: Image.Image, conf: float, iou: float, max_det: Optional[int], classes: Optional[set]):
    model = get_seg_model()
    try:
        results = model.predict(image, conf=conf, iou=iou, max_det=max_det, verbose=False)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f'seg inference failed: {exc}') from exc

    if not results:
        return [], image.size

    result = results[0]
    names = result.names or {}
    detections = []
    masks = result.masks
    if masks is None or not getattr(masks, 'xy', None):
        return [], image.size
    for idx, box in enumerate(result.boxes):
        cls_id = int(box.cls[0])
        name = str(names.get(cls_id, cls_id))
        if classes and name.lower() not in classes:
            continue
        conf_val = float(box.conf[0])
        x1, y1, x2, y2 = [float(v) for v in box.xyxy[0].tolist()]
        poly = masks.xy[idx] if idx < len(masks.xy) else []
        detections.append(
            {
                'cls': cls_id,
                'name': name,
                'conf': conf_val,
                'bbox': [x1, y1, x2, y2],
                'mask': simplify_mask(poly, SEG_MAX_POINTS),
            }
        )
    return detections, image.size


def _rings_from_geometry(geometry: Dict[str, Any]) -> List[List[List[float]]]:
    if not geometry:
        return []
    gtype = geometry.get('type')
    coords = geometry.get('coordinates') or []
    rings: List[List[List[float]]] = []
    if gtype == 'Polygon':
        if coords and coords[0]:
            rings.append([[float(x), float(y)] for x, y in coords[0]])
    elif gtype == 'MultiPolygon':
        for poly in coords:
            if poly and poly[0]:
                rings.append([[float(x), float(y)] for x, y in poly[0]])
    return rings


def _bbox_of_rings(rings: List[List[List[float]]]) -> Optional[List[float]]:
    xs: List[float] = []
    ys: List[float] = []
    for ring in rings:
        for x, y in ring:
            xs.append(x)
            ys.append(y)
    if not xs:
        return None
    return [min(xs), min(ys), max(xs), max(ys)]


def _bbox_intersects(a: List[float], b: List[float]) -> bool:
    return not (a[0] > b[2] or a[2] < b[0] or a[1] > b[3] or a[3] < b[1])


def _orientation(a, b, c) -> float:
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def _on_segment(a, b, c) -> bool:
    return (
        min(a[0], c[0]) - 1e-12 <= b[0] <= max(a[0], c[0]) + 1e-12
        and min(a[1], c[1]) - 1e-12 <= b[1] <= max(a[1], c[1]) + 1e-12
    )


def _segments_intersect(a, b, c, d) -> bool:
    o1 = _orientation(a, b, c)
    o2 = _orientation(a, b, d)
    o3 = _orientation(c, d, a)
    o4 = _orientation(c, d, b)
    if ((o1 > 0 and o2 < 0) or (o1 < 0 and o2 > 0)) and ((o3 > 0 and o4 < 0) or (o3 < 0 and o4 > 0)):
        return True
    if abs(o1) < 1e-12 and _on_segment(a, c, b):
        return True
    if abs(o2) < 1e-12 and _on_segment(a, d, b):
        return True
    if abs(o3) < 1e-12 and _on_segment(c, a, d):
        return True
    if abs(o4) < 1e-12 and _on_segment(c, b, d):
        return True
    return False


def _point_in_ring(pt, ring) -> bool:
    x, y = pt
    inside = False
    n = len(ring)
    if n < 3:
        return False
    j = n - 1
    for i in range(n):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / ((yj - yi) or 1e-12) + xi):
            inside = not inside
        j = i
    return inside


def _ring_edges(ring):
    if len(ring) < 2:
        return []
    return list(zip(ring[:-1], ring[1:]))


def _rings_intersect(a_rings, b_rings) -> bool:
    for ar in a_rings:
        for br in b_rings:
            if not ar or not br:
                continue
            if _point_in_ring(ar[0], br) or _point_in_ring(br[0], ar):
                return True
            for e1a, e1b in _ring_edges(ar):
                for e2a, e2b in _ring_edges(br):
                    if _segments_intersect(e1a, e1b, e2a, e2b):
                        return True
    return False


def _feature_record(feature: VoxelFeature, idx: int) -> Dict[str, Any]:
    rings = _rings_from_geometry(feature.geometry)
    return {
        'id': feature.id or (feature.properties or {}).get('id') or str(idx),
        'properties': feature.properties or {},
        'rings': rings,
        'bbox': _bbox_of_rings(rings),
    }


def _height_range(props: Dict[str, Any]) -> Optional[Dict[str, float]]:
    high_raw = props.get('h', props.get('height', props.get('H', None)))
    try:
        high = float(high_raw)
    except Exception:
        return None
    if high < 0.05:
        return None
    low_raw = props.get('minHeight', props.get('h_min', props.get('min_height', 0)))
    try:
        low = max(0.0, float(low_raw))
    except Exception:
        low = 0.0
    return {'low': low, 'high': high}


def _height_relevant(props: Dict[str, Any], vehicle_height: float, clearance: float) -> bool:
    rng = _height_range(props)
    if not rng:
        return True
    return rng['low'] <= vehicle_height + clearance + 0.01


def _candidate_pairs_gpu(fp_boxes: List[List[float]], ob_boxes: List[List[float]]) -> tuple[List[tuple[int, int]], str]:
    if torch is None or not torch.cuda.is_available():
        pairs = [
            (i, j)
            for i, a in enumerate(fp_boxes)
            for j, b in enumerate(ob_boxes)
            if _bbox_intersects(a, b)
        ]
        return pairs, 'cpu-bbox'
    try:
        device = torch.device('cuda')
        fp = torch.tensor(fp_boxes, dtype=torch.float32, device=device)
        ob = torch.tensor(ob_boxes, dtype=torch.float32, device=device)
        mask = (
            (fp[:, None, 0] <= ob[None, :, 2])
            & (fp[:, None, 2] >= ob[None, :, 0])
            & (fp[:, None, 1] <= ob[None, :, 3])
            & (fp[:, None, 3] >= ob[None, :, 1])
        )
        idx = mask.nonzero(as_tuple=False).detach().cpu().tolist()
        return [(int(i), int(j)) for i, j in idx], 'torch-cuda-bbox'
    except Exception:
        pairs = [
            (i, j)
            for i, a in enumerate(fp_boxes)
            for j, b in enumerate(ob_boxes)
            if _bbox_intersects(a, b)
        ]
        return pairs, 'cpu-bbox-fallback'


# ──────────────────────────────────────────────────────────────
#  地図スナップショット取得プロキシ
#  ブラウザからは CORS の都合で Google Static Maps を直接 fetch できないため
#  サーバー経由で取得し base64 で返す
# ──────────────────────────────────────────────────────────────

def try_parse_json_text(text: str) -> Dict[str, Any]:
    raw = (text or '').strip()
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else {}
    except json.JSONDecodeError:
        pass
    start = raw.find('{')
    end = raw.rfind('}')
    if start >= 0 and end > start:
        try:
            parsed = json.loads(raw[start:end + 1])
            return parsed if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            return {}
    return {}



class MapSnapshotRequest(BaseModel):
    route: List[Dict[str, Any]] = Field(default_factory=list)    # [{"lat": ..., "lng": ...}]
    center: Dict[str, Any] = Field(default_factory=dict)         # {"lat": ..., "lng": ...}
    zoom: int = 16
    google_api_key: str = ''


@app.post('/map-snapshot')
def map_snapshot(req: MapSnapshotRequest):
    api_key = req.google_api_key
    if not api_key or not req.route:
        raise HTTPException(status_code=400, detail='route and google_api_key are required')

    pts = req.route
    # Keep URL short for Static Maps.
    if len(pts) > 60:
        step = max(1, len(pts) // 60)
        pts = pts[::step]
        if pts[-1] != req.route[-1]:
            pts.append(req.route[-1])

    path_str = '|'.join(f"{p['lat']:.5f},{p['lng']:.5f}" for p in pts)
    cx = req.center.get('lat', pts[len(pts) // 2]['lat'])
    cy = req.center.get('lng', pts[len(pts) // 2]['lng'])

    s = req.route[0]
    g = req.route[-1]
    markers = (
        f"&markers=color:green%7Clabel:S%7C{s['lat']:.5f},{s['lng']:.5f}"
        f"&markers=color:red%7Clabel:G%7C{g['lat']:.5f},{g['lng']:.5f}"
    )

    url = (
        f"https://maps.googleapis.com/maps/api/staticmap"
        f"?center={cx},{cy}&zoom={req.zoom}&size=640x480&maptype=roadmap"
        f"&path=color:0xff2222ff%7Cweight:5%7C{path_str}"
        f"{markers}"
        f"&key={api_key}"
    )

    try:
        resp = requests.get(url, timeout=15)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f'Static Maps fetch failed: {e}')

    if not resp.ok:
        raise HTTPException(status_code=502, detail=f'Static Maps API error: {resp.status_code}')

    img_b64 = base64.b64encode(resp.content).decode()
    return {'image_base64': img_b64, 'media_type': 'image/png'}


@app.get('/health')
def health():
    return {
        'status': 'ok',
        'model': MODEL_NAME,
        'model_loaded': model is not None,
        'model_error': model_error,
        'seg_model': SEG_MODEL_NAME,
        'seg_model_loaded': seg_model is not None,
        'seg_model_error': seg_model_error,
        'gpu': gpu_info(),
        'voxel_endpoint': '/voxel-collision'
    }


@app.get('/status')
def status():
    return {
        'status': 'ok',
        'model': MODEL_NAME,
        'model_loaded': model is not None,
        'model_error': model_error,
        'seg_model': SEG_MODEL_NAME,
        'seg_model_loaded': seg_model is not None,
        'seg_model_error': seg_model_error,
        'gpu': gpu_info(),
        'voxel_endpoint': '/voxel-collision'
    }


@app.post('/detect')
def detect(req: DetectRequest):
    conf = float(req.conf if req.conf is not None else CONF_DEFAULT)
    iou = float(req.iou if req.iou is not None else IOU_DEFAULT)
    image = fetch_image(req.image_url)
    detections, size = run_detect(image, conf, iou, req.max_det)
    return {
        'model': MODEL_NAME,
        'count': len(detections),
        'image_size': {'width': size[0], 'height': size[1]},
        'detections': detections,
    }


@app.post('/detect-batch')
def detect_batch(req: BatchRequest):
    if len(req.items) > MAX_BATCH:
        raise HTTPException(status_code=400, detail=f'too many items (max {MAX_BATCH})')

    conf = float(req.conf if req.conf is not None else CONF_DEFAULT)
    iou = float(req.iou if req.iou is not None else IOU_DEFAULT)
    out_items = []
    for item in req.items:
        try:
            image = fetch_image(item.image_url)
            detections, size = run_detect(image, conf, iou, req.max_det)
            out_items.append(
                {
                    'id': item.id,
                    'count': len(detections),
                    'image_size': {'width': size[0], 'height': size[1]},
                    'detections': detections,
                    'lat': item.lat,
                    'lng': item.lng,
                    'heading': item.heading,
                }
            )
        except HTTPException as exc:
            out_items.append(
                {
                    'id': item.id,
                    'error': exc.detail,
                    'lat': item.lat,
                    'lng': item.lng,
                    'heading': item.heading,
                }
            )
    return {'model': MODEL_NAME, 'items': out_items}


@app.post('/segment')
def segment(req: SegmentRequest):
    classes = normalize_class_filter(req.classes)
    conf = float(req.conf if req.conf is not None else SEG_CONF_DEFAULT)
    iou = float(req.iou if req.iou is not None else SEG_IOU_DEFAULT)
    image = fetch_image(req.image_url)
    detections, size = run_segment(image, conf, iou, req.max_det, classes)
    return {
        'model': SEG_MODEL_NAME,
        'class_names': get_seg_class_names(),
        'count': len(detections),
        'image_size': {'width': size[0], 'height': size[1]},
        'segments': detections,
    }


@app.post('/segment-batch')
def segment_batch(req: SegmentBatchRequest):
    if len(req.items) > SEG_MAX_BATCH:
        raise HTTPException(status_code=400, detail=f'too many items (max {SEG_MAX_BATCH})')
    classes = normalize_class_filter(req.classes)
    conf = float(req.conf if req.conf is not None else SEG_CONF_DEFAULT)
    iou = float(req.iou if req.iou is not None else SEG_IOU_DEFAULT)
    out_items = []
    for item in req.items:
        try:
            image = fetch_image(item.image_url)
            detections, size = run_segment(image, conf, iou, req.max_det, classes)
            out_items.append(
                {
                    'id': item.id,
                    'count': len(detections),
                    'image_size': {'width': size[0], 'height': size[1]},
                    'segments': detections,
                    'lat': item.lat,
                    'lng': item.lng,
                    'heading': item.heading,
                }
            )
        except HTTPException as exc:
            out_items.append(
                {
                    'id': item.id,
                    'error': exc.detail,
                    'lat': item.lat,
                    'lng': item.lng,
                    'heading': item.heading,
                }
            )
    return {'model': SEG_MODEL_NAME, 'class_names': get_seg_class_names(), 'items': out_items}




# ──────────────────────────────────────────────
# /control/* — server management endpoints
# ──────────────────────────────────────────────
@app.post('/voxel-collision')
def voxel_collision(req: VoxelCollisionRequest):
    footprints = [_feature_record(f, i) for i, f in enumerate(req.footprints)]
    obstacles = [_feature_record(f, i) for i, f in enumerate(req.obstacles)]
    footprints = [f for f in footprints if f['bbox'] and f['rings']]
    obstacles = [f for f in obstacles if f['bbox'] and f['rings']]
    vehicle_height = float(req.vehicleHeight or 0)
    clearance = float(req.clearance if req.clearance is not None else 0.25)
    max_points = max(20, int(req.maxContactPoints or 240))

    if not footprints or not obstacles:
        return {
            'status': 'OK',
            'backend': 'remote-gpu-empty',
            'gpu': gpu_info(),
            'contactCount': 0,
            'totalSamples': len(footprints),
            'contactRatio': 0,
            'firstContact': None,
            'violations': [],
            'contactPoints': {'type': 'FeatureCollection', 'features': []},
        }

    fp_boxes = [f['bbox'] for f in footprints]
    ob_boxes = [o['bbox'] for o in obstacles]
    pairs, backend = _candidate_pairs_gpu(fp_boxes, ob_boxes)
    point_stride = max(1, len(footprints) // max_points)
    contact_count = 0
    first_contact = None
    point_features = []
    violations = []
    seen_pose = set()

    for i, j in pairs:
        if i in seen_pose:
            continue
        fp = footprints[i]
        ob = obstacles[j]
        props = ob['properties']
        if not _height_relevant(props, vehicle_height, clearance):
            continue
        if not _rings_intersect(fp['rings'], ob['rings']):
            continue
        seen_pose.add(i)
        contact_count += 1
        bb = fp['bbox']
        center = {'lng': (bb[0] + bb[2]) * 0.5, 'lat': (bb[1] + bb[3]) * 0.5}
        height_only = props.get('heightOnly') in (True, 1, '1', 'true', 'yes')
        reason = 'overhang' if height_only else 'building_contact'
        if first_contact is None:
            first_contact = {'lat': center['lat'], 'lng': center['lng'], 'reason': reason}
        rng = _height_range(props)
        if i % point_stride == 0:
            point_features.append({
                'type': 'Feature',
                'geometry': {'type': 'Point', 'coordinates': [center['lng'], center['lat']]},
                'properties': {
                    'reason': reason,
                    'obstacleId': ob['id'],
                    'backend': backend,
                    'remoteGpu': True,
                    'obstacleHeight': rng['high'] if rng else None,
                },
            })
        violations.append({
            'type': reason,
            'poseIndex': i,
            'obstacleId': ob['id'],
            'obstacleHeight': rng['high'] if rng else None,
            'required': round(vehicle_height + clearance, 2),
        })

    total = len(footprints)
    return {
        'status': 'OK' if contact_count == 0 else 'NG',
        'backend': backend,
        'gpu': gpu_info(),
        'voxelSizeMeters': req.voxelSizeMeters,
        'contactCount': contact_count,
        'totalSamples': total,
        'contactRatio': contact_count / total if total else 0,
        'firstContact': first_contact,
        'violations': violations,
        'contactPoints': {'type': 'FeatureCollection', 'features': point_features},
    }


@app.get('/control/status')
async def control_status():
    """Returns running status of YOLO (self)."""
    return {
        'yolo': 'running',
    }


if __name__ == '__main__':
    import uvicorn

    port = int(os.getenv('PORT', '8001'))
    uvicorn.run(app, host='0.0.0.0', port=port)
