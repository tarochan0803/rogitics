"""学習済み道路面モデルの推論ラッパ。train.py の重みを predict_fn(rgb)->mask にする。

torch/smp と重みが揃っていれば PretrainedRoadSegmenter にそのまま渡せる predict_fn を返す。
無ければ available()=False。server の backend=pretrained と eval_real がこれを使う。
"""

from __future__ import annotations

import json
import os

from .model_factory import build_smp_model, normalize_arch

MODELS_DIR = os.path.join(os.path.dirname(__file__), "models")
DEFAULT_WEIGHTS = os.path.join(MODELS_DIR, "road_unet.pt")

_cache = {}


def available(weights: str = DEFAULT_WEIGHTS) -> bool:
    if not os.path.exists(weights):
        return False
    try:
        import torch  # noqa: F401
        import segmentation_models_pytorch  # noqa: F401
    except Exception:
        return False
    return True


def get_predict_fn(weights: str = DEFAULT_WEIGHTS):
    """rgb(HxWx3 uint8) -> mask(HxW bool) を返す。未整備なら RuntimeError。"""
    if weights in _cache:
        return _cache[weights]
    if not os.path.exists(weights):
        raise RuntimeError(f"学習済みモデルがありません: {weights}（先に road_seg.train を実行）")
    try:
        import numpy as np
        import torch
        import segmentation_models_pytorch as smp
        from PIL import Image
    except Exception as e:
        raise RuntimeError(f"推論に必要なライブラリが未導入です: {e}")

    meta_path = os.path.splitext(weights)[0] + ".json"
    meta = {}
    if os.path.exists(meta_path):
        with open(meta_path, encoding="utf-8") as f:
            meta = json.load(f)
    arch = normalize_arch(meta.get("arch", "unet"))
    encoder = meta.get("encoder", "resnet34")
    size = int(meta.get("imgSize", 512))
    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = build_smp_model(
        smp,
        arch=arch,
        encoder_name=encoder,
        encoder_weights=None,
        in_channels=3,
        classes=1,
    )
    model.load_state_dict(torch.load(weights, map_location=device))
    model.to(device).eval()

    def predict_fn(rgb):
        arr = np.asarray(rgb)
        h, w = arr.shape[:2]
        img = Image.fromarray(arr[:, :, :3].astype(np.uint8)).resize((size, size), Image.BILINEAR)
        x = np.asarray(img, np.float32) / 255.0
        x = np.transpose(x, (2, 0, 1))[None, ...]
        with torch.no_grad():
            out = model(torch.from_numpy(x).to(device))
            prob = torch.sigmoid(out)[0, 0].cpu().numpy()
        m = Image.fromarray((prob * 255).astype(np.uint8)).resize((w, h), Image.BILINEAR)
        return (np.asarray(m) >= 128)

    _cache[weights] = predict_fn
    return predict_fn
