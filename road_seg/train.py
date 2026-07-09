"""貯めた教師データ（dataset/images + dataset/masks）で道路面セグメンテーションを学習。

商用クリーンな U-Net / DeepLabV3+（segmentation_models_pytorch, MIT）を使う。
torch / segmentation-models-pytorch が未導入なら、導入手順を表示して終了する
（学習は重い任意ステップなので依存を強制しない）。

  学習:   python -m road_seg.train --epochs 40
  出力:   road_seg/models/road_unet.pt (+ road_unet.json)
  以後:   annotate サーバの backend=pretrained や eval_real が自動でこの重みを使う
          （road_seg/infer.py 経由）。
"""

from __future__ import annotations

import argparse
import json
import os
import sys

from .model_factory import arch_label, build_smp_model, normalize_arch

MODELS_DIR = os.path.join(os.path.dirname(__file__), "models")
DEFAULT_WEIGHTS = os.path.join(MODELS_DIR, "road_unet.pt")


def _require_deps():
    missing = []
    try:
        import torch  # noqa: F401
    except Exception:
        missing.append("torch")
    try:
        import segmentation_models_pytorch  # noqa: F401
    except Exception:
        missing.append("segmentation-models-pytorch")
    if missing:
        print("学習には追加ライブラリが必要です（未導入）:", ", ".join(missing))
        print("\n導入例（GPUが無ければCPU版でも動きます）:")
        print("  .\\.venv\\Scripts\\python.exe -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu")
        print("  .\\.venv\\Scripts\\python.exe -m pip install segmentation-models-pytorch albumentations")
        print("\n※ U-Net/DeepLabV3+(smp)=MIT / torchvision=BSD で商用クリーン。")
        return False
    return True


def main():
    ap = argparse.ArgumentParser(description="道路面セグメンテーション学習")
    ap.add_argument("--arch", default="unet", help="unet | deeplabv3plus")
    ap.add_argument("--epochs", type=int, default=40)
    ap.add_argument("--img-size", type=int, default=512)
    ap.add_argument("--batch", type=int, default=4)
    ap.add_argument("--encoder", default="resnet34")
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--val-split", type=float, default=0.15)
    ap.add_argument("--out", default=DEFAULT_WEIGHTS)
    args = ap.parse_args()
    arch = normalize_arch(args.arch)

    if not _require_deps():
        return 2

    import numpy as np
    import torch
    from torch.utils.data import Dataset, DataLoader
    import segmentation_models_pytorch as smp
    from PIL import Image
    from . import dataset as ds

    pairs = ds.list_pairs()
    if len(pairs) < 4:
        print(f"教師データが少なすぎます（{len(pairs)}件）。まず annotate で貯めてください（推奨: 数百件〜）。")
        return 2
    print(f"学習データ: {len(pairs)} 件  img_size={args.img_size} model={arch_label(arch)} encoder={args.encoder}")

    S = args.img_size

    class RoadDS(Dataset):
        def __init__(self, items):
            self.items = items
        def __len__(self):
            return len(self.items)
        def __getitem__(self, i):
            ip, mp = self.items[i]
            img = Image.open(ip).convert("RGB").resize((S, S), Image.BILINEAR)
            msk = Image.open(mp).convert("L").resize((S, S), Image.NEAREST)
            x = np.asarray(img, np.float32) / 255.0
            x = np.transpose(x, (2, 0, 1))
            y = (np.asarray(msk, np.float32) >= 128).astype(np.float32)[None, ...]
            return torch.from_numpy(x), torch.from_numpy(y)

    n_val = max(1, int(len(pairs) * args.val_split))
    val_items = pairs[:n_val]
    train_items = pairs[n_val:] or pairs
    dl_tr = DataLoader(RoadDS(train_items), batch_size=args.batch, shuffle=True)
    dl_va = DataLoader(RoadDS(val_items), batch_size=args.batch)

    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = build_smp_model(
        smp,
        arch=arch,
        encoder_name=args.encoder,
        encoder_weights="imagenet",
        in_channels=3,
        classes=1,
    ).to(device)
    bce = torch.nn.BCEWithLogitsLoss()
    dice = smp.losses.DiceLoss(mode="binary")
    opt = torch.optim.Adam(model.parameters(), lr=args.lr)
    print(f"device={device}")

    best = 1e9
    os.makedirs(MODELS_DIR, exist_ok=True)
    for ep in range(1, args.epochs + 1):
        model.train(); tl = 0.0
        for x, y in dl_tr:
            x, y = x.to(device), y.to(device)
            opt.zero_grad()
            out = model(x)
            loss = bce(out, y) + dice(out, y)
            loss.backward(); opt.step()
            tl += loss.item() * x.size(0)
        tl /= len(dl_tr.dataset)

        model.eval(); vl = 0.0
        with torch.no_grad():
            for x, y in dl_va:
                x, y = x.to(device), y.to(device)
                out = model(x)
                vl += (bce(out, y) + dice(out, y)).item() * x.size(0)
        vl /= len(dl_va.dataset)
        print(f"epoch {ep:3d}/{args.epochs}  train {tl:.4f}  val {vl:.4f}")
        if vl < best:
            best = vl
            torch.save(model.state_dict(), args.out)
            with open(os.path.splitext(args.out)[0] + ".json", "w", encoding="utf-8") as f:
                json.dump({"encoder": args.encoder, "imgSize": S, "arch": arch,
                           "archLabel": arch_label(arch),
                           "valLoss": best, "samples": len(pairs)}, f, ensure_ascii=False, indent=2)
    print(f"\n完了。最良モデルを保存: {os.path.abspath(args.out)} (val {best:.4f})")
    if os.path.abspath(args.out) == os.path.abspath(DEFAULT_WEIGHTS):
        print("annotate の初期下書きに使うには initMask=pretrained 相当の配線 or eval_real で backend を pretrained に。")
    else:
        print("比較用モデルとして保存しました。既定利用するには road_unet.pt へ昇格してください。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
