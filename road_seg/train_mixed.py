# -*- coding: utf-8 -*-
"""Train an aerial road-surface model from manual corrections plus weak labels.

Manual samples live in road_seg/dataset/images + masks and are treated as
authoritative binary labels. Weak samples live in road_seg/dataset_weak/images
and labels, where label value 128 is ignored by the loss.
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import random
import shutil
import sys
import time
from dataclasses import dataclass

from .model_factory import arch_label, build_smp_model, normalize_arch

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
MANUAL_DIR = os.path.join(HERE, "dataset")
WEAK_DIR = os.path.join(HERE, "dataset_weak")
MODELS_DIR = os.path.join(HERE, "models")
DEFAULT_OUT = os.path.join(MODELS_DIR, "road_unet.pt")


@dataclass(frozen=True)
class TrainingItem:
    image: str
    label: str
    kind: str  # manual | weak


def _pairs(image_dir: str, label_dir: str) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    for image_path in sorted(glob.glob(os.path.join(image_dir, "*.png"))):
        label_path = os.path.join(label_dir, os.path.basename(image_path))
        if os.path.exists(label_path):
            out.append((image_path, label_path))
    return out


def manual_pairs(manual_dir: str = MANUAL_DIR) -> list[tuple[str, str]]:
    return _pairs(os.path.join(manual_dir, "images"), os.path.join(manual_dir, "masks"))


def weak_pairs(weak_dir: str = WEAK_DIR) -> list[tuple[str, str]]:
    return _pairs(os.path.join(weak_dir, "images"), os.path.join(weak_dir, "labels"))


def collect_training_items(
    manual_dir: str = MANUAL_DIR,
    weak_dir: str = WEAK_DIR,
    *,
    use_weak: bool = True,
    manual_repeat: int = 8,
    weak_limit: int = 0,
    seed: int = 7,
) -> tuple[list[TrainingItem], dict]:
    """Return the effective training list and a summary without importing torch."""

    rng = random.Random(seed)
    mp = manual_pairs(manual_dir)
    wp = weak_pairs(weak_dir) if use_weak else []
    if weak_limit and weak_limit > 0 and len(wp) > weak_limit:
        wp = list(wp)
        rng.shuffle(wp)
        wp = sorted(wp[:weak_limit])

    repeat = max(1, int(manual_repeat))
    items: list[TrainingItem] = []
    for _ in range(repeat):
        items.extend(TrainingItem(i, m, "manual") for i, m in mp)
    items.extend(TrainingItem(i, l, "weak") for i, l in wp)
    summary = {
        "manualSamples": len(mp),
        "weakTiles": len(wp),
        "manualRepeat": repeat,
        "effectiveItems": len(items),
        "useWeak": bool(use_weak),
    }
    return items, summary


def split_training_items(
    *,
    manual_dir: str = MANUAL_DIR,
    weak_dir: str = WEAK_DIR,
    use_weak: bool = True,
    manual_repeat: int = 8,
    weak_limit: int = 0,
    val_split: float = 0.15,
    seed: int = 7,
) -> tuple[list[TrainingItem], list[TrainingItem], dict]:
    """Split unique samples first, then repeat manual train samples.

    This avoids the same manually corrected tile leaking into both train and
    validation through repetition.
    """

    rng = random.Random(seed)
    mp = manual_pairs(manual_dir)
    wp = weak_pairs(weak_dir) if use_weak else []
    if weak_limit and weak_limit > 0 and len(wp) > weak_limit:
        rng.shuffle(wp)
        wp = sorted(wp[:weak_limit])

    rng.shuffle(mp)
    rng.shuffle(wp)

    def split(pairs: list[tuple[str, str]], kind: str):
        if len(pairs) < 2:
            return [TrainingItem(i, l, kind) for i, l in pairs], []
        n_val = max(1, int(round(len(pairs) * val_split)))
        n_val = min(n_val, len(pairs) - 1)
        val = [TrainingItem(i, l, kind) for i, l in pairs[:n_val]]
        train = [TrainingItem(i, l, kind) for i, l in pairs[n_val:]]
        return train, val

    train_m, val_m = split(mp, "manual")
    train_w, val_w = split(wp, "weak")

    repeat = max(1, int(manual_repeat))
    train_items = train_m * repeat + train_w
    val_items = val_m + val_w
    if not val_items and train_items:
        val_items = train_items[:1]

    rng.shuffle(train_items)
    rng.shuffle(val_items)
    summary = {
        "manualSamples": len(mp),
        "weakTiles": len(wp),
        "manualRepeat": repeat,
        "trainItems": len(train_items),
        "valItems": len(val_items),
        "useWeak": bool(use_weak),
    }
    return train_items, val_items, summary


def _require_deps() -> bool:
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
        print("学習に必要なライブラリがありません: " + ", ".join(missing))
        print("例:")
        print(r"  .\.venv\Scripts\python.exe -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu")
        print(r"  .\.venv\Scripts\python.exe -m pip install segmentation-models-pytorch albumentations")
        return False
    return True


def _backup_existing(path: str) -> None:
    if not os.path.exists(path):
        return
    stamp = time.strftime("%Y%m%d_%H%M%S")
    base, ext = os.path.splitext(path)
    backup = f"{base}.bak-{stamp}{ext}"
    shutil.copy2(path, backup)
    meta = base + ".json"
    if os.path.exists(meta):
        shutil.copy2(meta, f"{base}.bak-{stamp}.json")
    print(f"既存モデルをバックアップしました: {backup}")


def main() -> int:
    ap = argparse.ArgumentParser(description="Manual + weak road-surface segmentation training")
    ap.add_argument("--arch", default="unet", help="unet | deeplabv3plus")
    ap.add_argument("--epochs", type=int, default=30)
    ap.add_argument("--img-size", type=int, default=384)
    ap.add_argument("--batch", type=int, default=4)
    ap.add_argument("--encoder", default="resnet34")
    ap.add_argument("--encoder-weights", default="none", help="imagenet | none")
    ap.add_argument("--lr", type=float, default=5e-4)
    ap.add_argument("--val-split", type=float, default=0.15)
    ap.add_argument("--manual-repeat", type=int, default=8)
    ap.add_argument("--weak-limit", type=int, default=0, help="0 means no limit")
    ap.add_argument("--no-weak", action="store_true")
    ap.add_argument("--resume", default="auto", help="auto | none | path")
    ap.add_argument("--no-backup", action="store_true")
    ap.add_argument("--out", default=DEFAULT_OUT)
    args = ap.parse_args()
    arch = normalize_arch(args.arch)

    if not _require_deps():
        return 2

    import numpy as np
    import torch
    import segmentation_models_pytorch as smp
    from PIL import Image
    from torch.utils.data import DataLoader, Dataset

    train_items, val_items, summary = split_training_items(
        use_weak=not args.no_weak,
        manual_repeat=args.manual_repeat,
        weak_limit=args.weak_limit,
        val_split=args.val_split,
    )
    unique_total = summary["manualSamples"] + summary["weakTiles"]
    if unique_total < 4:
        print(
            "教師データが少なすぎます。手動修正を追加するか、"
            "gen_weak_dataset で弱教師データを作ってください。"
        )
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        return 2
    if summary["manualSamples"] == 0:
        print("[注意] 手動修正データはまだ0件です。弱教師データだけで学習します。")

    print("学習データ:")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    print(f"model={arch_label(arch)} encoder={args.encoder} encoder_weights={args.encoder_weights}")

    size = int(args.img_size)

    class MixedRoadDataset(Dataset):
        def __init__(self, items: list[TrainingItem], augment: bool):
            self.items = items
            self.augment = augment

        def __len__(self):
            return len(self.items)

        def __getitem__(self, index: int):
            item = self.items[index]
            img = Image.open(item.image).convert("RGB").resize((size, size), Image.BILINEAR)
            lab = Image.open(item.label).convert("L").resize((size, size), Image.NEAREST)
            x = np.asarray(img, np.float32) / 255.0
            label = np.asarray(lab)
            if item.kind == "weak":
                y = (label == 255).astype(np.float32)
                valid = (label != 128).astype(np.float32)
            else:
                y = (label >= 128).astype(np.float32)
                valid = np.ones_like(y, dtype=np.float32)

            if self.augment:
                if random.random() < 0.5:
                    x = x[:, ::-1].copy()
                    y = y[:, ::-1].copy()
                    valid = valid[:, ::-1].copy()
                if random.random() < 0.5:
                    x = x[::-1, :].copy()
                    y = y[::-1, :].copy()
                    valid = valid[::-1, :].copy()
                k = random.randint(0, 3)
                if k:
                    x = np.rot90(x, k).copy()
                    y = np.rot90(y, k).copy()
                    valid = np.rot90(valid, k).copy()

            x = np.transpose(x, (2, 0, 1))
            return (
                torch.from_numpy(x),
                torch.from_numpy(y[None]),
                torch.from_numpy(valid[None]),
            )

    train_loader = DataLoader(MixedRoadDataset(train_items, True), batch_size=args.batch, shuffle=True)
    val_loader = DataLoader(MixedRoadDataset(val_items, False), batch_size=args.batch, shuffle=False)

    device = "cuda" if torch.cuda.is_available() else "cpu"
    encoder_weights = None if str(args.encoder_weights).lower() == "none" else args.encoder_weights
    model = build_smp_model(
        smp,
        arch=arch,
        encoder_name=args.encoder,
        encoder_weights=encoder_weights,
        in_channels=3,
        classes=1,
    ).to(device)

    resume_path = None
    if args.resume != "none":
        resume_path = args.out if args.resume == "auto" else args.resume
    if resume_path and os.path.exists(resume_path):
        try:
            model.load_state_dict(torch.load(resume_path, map_location=device))
            print(f"既存モデルから継続学習します: {resume_path}")
        except Exception as exc:
            print(f"[注意] 既存モデルを読み込めませんでした。新規学習します: {exc}")

    optimizer = torch.optim.Adam(model.parameters(), lr=args.lr)

    def masked_loss(logits, y, valid):
        bce = torch.nn.functional.binary_cross_entropy_with_logits(logits, y, reduction="none")
        bce = (bce * valid).sum() / valid.sum().clamp(min=1)
        pred = torch.sigmoid(logits) * valid
        target = y * valid
        inter = (pred * target).sum()
        dice = 1 - (2 * inter + 1) / (pred.sum() + target.sum() + 1)
        return bce + dice

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    if not args.no_backup:
        _backup_existing(args.out)

    best = 1e9
    for epoch in range(1, args.epochs + 1):
        model.train()
        train_loss = 0.0
        for x, y, valid in train_loader:
            x, y, valid = x.to(device), y.to(device), valid.to(device)
            optimizer.zero_grad()
            loss = masked_loss(model(x), y, valid)
            loss.backward()
            optimizer.step()
            train_loss += loss.item() * x.size(0)
        train_loss /= max(1, len(train_loader.dataset))

        model.eval()
        val_loss = 0.0
        with torch.no_grad():
            for x, y, valid in val_loader:
                x, y, valid = x.to(device), y.to(device), valid.to(device)
                val_loss += masked_loss(model(x), y, valid).item() * x.size(0)
        val_loss /= max(1, len(val_loader.dataset))

        flag = ""
        if val_loss < best:
            best = val_loss
            torch.save(model.state_dict(), args.out)
            with open(os.path.splitext(args.out)[0] + ".json", "w", encoding="utf-8") as f:
                json.dump(
                    {
                        "encoder": args.encoder,
                        "imgSize": size,
                        "arch": arch,
                        "archLabel": arch_label(arch),
                        "mixed": True,
                        "weak": summary["weakTiles"] > 0,
                        "manualSamples": summary["manualSamples"],
                        "weakTiles": summary["weakTiles"],
                        "manualRepeat": summary["manualRepeat"],
                        "trainItems": summary["trainItems"],
                        "valItems": summary["valItems"],
                        "valLoss": best,
                        "trainedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                    },
                    f,
                    ensure_ascii=False,
                    indent=2,
                )
            flag = "  << best"
        print(f"epoch {epoch:3d}/{args.epochs}  train {train_loss:.4f}  val {val_loss:.4f}{flag}")

    print(f"\n完了: {os.path.abspath(args.out)}  best val={best:.4f}")
    if os.path.abspath(args.out) == os.path.abspath(DEFAULT_OUT):
        print("サーバを再起動すると backend=pretrained と道路面補強に新モデルが使われます。")
    else:
        print("比較用モデルとして保存しました。既定利用するには road_unet.pt へ昇格してください。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
