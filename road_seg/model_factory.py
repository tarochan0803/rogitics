"""Small factory for smp road-surface segmentation models."""

from __future__ import annotations


def normalize_arch(arch: str | None) -> str:
    key = (arch or "unet").strip().lower().replace("-", "").replace("_", "")
    if key in {"unet", "u net"}:
        return "unet"
    if key in {"deeplabv3plus", "deeplabv3+", "deeplabplus"}:
        return "deeplabv3plus"
    raise ValueError(f"unknown segmentation arch: {arch!r} (expected: unet or deeplabv3plus)")


def build_smp_model(
    smp,
    *,
    arch: str | None = "unet",
    encoder_name: str = "resnet34",
    encoder_weights=None,
    in_channels: int = 3,
    classes: int = 1,
):
    """Build an smp binary segmentation model using the repo's stable defaults."""

    normalized = normalize_arch(arch)
    common = {
        "encoder_name": encoder_name,
        "encoder_weights": encoder_weights,
        "in_channels": in_channels,
        "classes": classes,
    }
    if normalized == "unet":
        return smp.Unet(**common)
    if not hasattr(smp, "DeepLabV3Plus"):
        raise RuntimeError(
            "installed segmentation_models_pytorch has no DeepLabV3Plus; "
            "upgrade segmentation-models-pytorch"
        )
    return smp.DeepLabV3Plus(**common)


def arch_label(arch: str | None) -> str:
    normalized = normalize_arch(arch)
    if normalized == "deeplabv3plus":
        return "DeepLabV3+"
    return "U-Net"
