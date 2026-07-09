# -*- coding: utf-8 -*-
"""弱教師データ(dataset_weak)で道路面モデルを学習 — マスク損失（無視領域=128は損失に含めない）。

無視領域を損失から外すのが肝: 「駐車場・私道」は無視なので、モデルがそこを道路と
判断してもペナルティが無い → アスファルトのテクスチャで道路と同一視して発火する。
（建物=負例で「非道路」を、rdcl=正例で「道路」を学ぶ）

出力は road_seg/models/road_unet.pt(+.json) で、infer.get_predict_fn / server backend=pretrained /
surface パイプラインがそのまま使う互換形式。

  python -m road_seg.train_weak --epochs 25 --img-size 384
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import sys
import random

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

import numpy as np

from .model_factory import arch_label, build_smp_model, normalize_arch

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "dataset_weak")
MODELS_DIR = os.path.join(HERE, "models")
OUT = os.path.join(MODELS_DIR, "road_unet.pt")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--arch", default="unet", help="unet | deeplabv3plus")
    ap.add_argument("--epochs", type=int, default=25)
    ap.add_argument("--img-size", type=int, default=384)
    ap.add_argument("--batch", type=int, default=4)
    ap.add_argument("--encoder", default="resnet34")
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--val-split", type=float, default=0.15)
    ap.add_argument("--out", default=OUT)
    a = ap.parse_args()
    arch = normalize_arch(a.arch)

    import torch
    from torch.utils.data import Dataset, DataLoader
    import segmentation_models_pytorch as smp
    from PIL import Image

    pairs = []
    for ip in sorted(glob.glob(os.path.join(DATA, "images", "*.png"))):
        lp = os.path.join(DATA, "labels", os.path.basename(ip))
        if os.path.exists(lp):
            pairs.append((ip, lp))
    if len(pairs) < 4:
        print(f"弱教師タイルが不足（{len(pairs)}）。先に gen_weak_dataset を実行。")
        return 2
    print(f"weak tiles: {len(pairs)}  img={a.img_size} model={arch_label(arch)} encoder={a.encoder}")
    S = a.img_size

    class WeakDS(Dataset):
        def __init__(self, items, aug):
            self.items = items
            self.aug = aug
        def __len__(self):
            return len(self.items)
        def __getitem__(self, i):
            ip, lp = self.items[i]
            img = Image.open(ip).convert("RGB").resize((S, S), Image.BILINEAR)
            lab = Image.open(lp).convert("L").resize((S, S), Image.NEAREST)
            x = np.asarray(img, np.float32) / 255.0
            L = np.asarray(lab)
            y = (L == 255).astype(np.float32)          # 道路正例
            valid = (L != 128).astype(np.float32)       # 無視でない領域だけ損失
            if self.aug:
                if random.random() < 0.5:
                    x = x[:, ::-1].copy(); y = y[:, ::-1].copy(); valid = valid[:, ::-1].copy()
                if random.random() < 0.5:
                    x = x[::-1, :].copy(); y = y[::-1, :].copy(); valid = valid[::-1, :].copy()
                k = random.randint(0, 3)
                if k:
                    x = np.rot90(x, k).copy(); y = np.rot90(y, k).copy(); valid = np.rot90(valid, k).copy()
            x = np.transpose(x, (2, 0, 1))
            return (torch.from_numpy(x),
                    torch.from_numpy(y[None]),
                    torch.from_numpy(valid[None]))

    random.Random(7).shuffle(pairs)
    nval = max(1, int(len(pairs) * a.val_split))
    val_items, train_items = pairs[:nval], pairs[nval:] or pairs
    dl_tr = DataLoader(WeakDS(train_items, True), batch_size=a.batch, shuffle=True)
    dl_va = DataLoader(WeakDS(val_items, False), batch_size=a.batch)

    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = build_smp_model(
        smp,
        arch=arch,
        encoder_name=a.encoder,
        encoder_weights="imagenet",
        in_channels=3,
        classes=1,
    ).to(device)
    opt = torch.optim.Adam(model.parameters(), lr=a.lr)

    def masked_loss(logits, y, valid):
        # マスク付き BCE + soft Dice（validな画素のみ）
        bce = torch.nn.functional.binary_cross_entropy_with_logits(logits, y, reduction="none")
        bce = (bce * valid).sum() / valid.sum().clamp(min=1)
        p = torch.sigmoid(logits) * valid
        yt = y * valid
        inter = (p * yt).sum()
        dice = 1 - (2 * inter + 1) / (p.sum() + yt.sum() + 1)
        return bce + dice

    os.makedirs(MODELS_DIR, exist_ok=True)
    best = 1e9
    for ep in range(1, a.epochs + 1):
        model.train(); tl = 0.0
        for x, y, v in dl_tr:
            x, y, v = x.to(device), y.to(device), v.to(device)
            opt.zero_grad()
            loss = masked_loss(model(x), y, v)
            loss.backward(); opt.step()
            tl += loss.item() * x.size(0)
        tl /= len(dl_tr.dataset)
        model.eval(); vl = 0.0
        with torch.no_grad():
            for x, y, v in dl_va:
                x, y, v = x.to(device), y.to(device), v.to(device)
                vl += masked_loss(model(x), y, v).item() * x.size(0)
        vl /= len(dl_va.dataset)
        flag = ""
        if vl < best:
            best = vl
            torch.save(model.state_dict(), a.out)
            with open(os.path.splitext(a.out)[0] + ".json", "w", encoding="utf-8") as f:
                json.dump({"encoder": a.encoder, "imgSize": S, "arch": arch,
                           "archLabel": arch_label(arch),
                           "weak": True, "valLoss": best, "tiles": len(pairs)}, f, ensure_ascii=False, indent=2)
            flag = "  << best"
        print(f"epoch {ep:3d}/{a.epochs}  train {tl:.4f}  val {vl:.4f}{flag}")
    print(f"\n完了。最良モデル: {os.path.abspath(a.out)} (val {best:.4f})")
    if os.path.abspath(a.out) == os.path.abspath(OUT):
        print("infer.available() が true になり、server backend=pretrained / surface が自動で使う。")
    else:
        print("比較用モデルとして保存しました。既定利用するには road_unet.pt へ昇格してください。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
