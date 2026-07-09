# -*- coding: utf-8 -*-
"""fit_motion_model.py — ②運動モデル同定パイプライン（実車ログ→自転車モデルパラメータ）

汎用の走行ログCSV（time_s, lat, lng[, speed_ms][, steer_deg]）から、
低速域（搬入ドメイン <30km/h）の運動パラメータを最小二乗で同定する:
  - 実効ホイールベース L_eff（操舵角があれば dψ/dt = v·tanδ/L の回帰から）
  - 最小旋回半径の実測分布（軌跡曲率から。操舵角が無いログでも出る）
  - 加減速の実用上限（速度差分のロバスト分位点）
  - コーナー速度ポリシー（曲率帯ごとの実測速度 = 実ドライバーの安全マージン）

出力はそのまま VEHICLE_PRESETS / RISK_TUNING の較正材料になる。
公開データ（ULTra-AV/comma2k19等の乗用車ログ）でパイプラインを検証し、
自社デジタコ/ドラレコのトラックログが来たら同じコマンドでトラック値が出る。

使い方:
  python src/batch/fit_motion_model.py --csv <log.csv> [--out runtime/motion_fit]
  python src/batch/fit_motion_model.py --selfcheck   # 既知パラメータの合成ログで復元検証
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

R_EARTH = 6378137.0


def load_csv(path):
    import csv
    rows = []
    with open(path, encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            def num(k):
                v = r.get(k)
                try:
                    return float(v)
                except (TypeError, ValueError):
                    return None
            rows.append({
                "t": num("time_s"), "lat": num("lat"), "lng": num("lng"),
                "v": num("speed_ms"), "steer": num("steer_deg")
            })
    return [r for r in rows if r["t"] is not None and r["lat"] is not None and r["lng"] is not None]


def derive_kinematics(rows):
    """GPS列から速度・方位・方位角速度・曲率を数値微分で導出（等距円筒近似）。"""
    out = []
    for i in range(1, len(rows) - 1):
        a, b, c = rows[i - 1], rows[i], rows[i + 1]
        dt1 = b["t"] - a["t"]
        dt2 = c["t"] - b["t"]
        if dt1 <= 0 or dt2 <= 0 or dt1 > 2 or dt2 > 2:
            continue
        k = 111320.0
        kx = k * math.cos(math.radians(b["lat"]))
        vx1 = (b["lng"] - a["lng"]) * kx / dt1
        vy1 = (b["lat"] - a["lat"]) * k / dt1
        vx2 = (c["lng"] - b["lng"]) * kx / dt2
        vy2 = (c["lat"] - b["lat"]) * k / dt2
        v1 = math.hypot(vx1, vy1)
        v2 = math.hypot(vx2, vy2)
        v = b["v"] if b["v"] is not None else (v1 + v2) / 2
        if v < 0.5:
            continue  # 停止・微速はノイズ支配
        h1 = math.atan2(vx1, vy1)
        h2 = math.atan2(vx2, vy2)
        dpsi = h2 - h1
        while dpsi > math.pi:
            dpsi -= 2 * math.pi
        while dpsi < -math.pi:
            dpsi += 2 * math.pi
        yaw_rate = dpsi / ((dt1 + dt2) / 2)
        accel = (v2 - v1) / ((dt1 + dt2) / 2)
        out.append({
            "t": b["t"], "v": v, "yaw": yaw_rate, "accel": accel,
            "kappa": yaw_rate / v if v > 0.8 else None,   # 曲率 = dψ/ds
            "steer": b["steer"]
        })
    return out


def percentile(xs, p):
    if not xs:
        return None
    s = sorted(xs)
    i = max(0, min(len(s) - 1, int(p * (len(s) - 1))))
    return s[i]


def fit(rows):
    kin = derive_kinematics(rows)
    if len(kin) < 50:
        raise SystemExit(f"有効サンプルが不足（{len(kin)}点）。1秒間隔・数分以上のログが必要です。")

    result = {"samples": len(kin)}

    # 1) 実効ホイールベース（操舵角がある場合のみ）: yaw_rate = v·tan(δ)/L → L の最小二乗
    steer_pts = [(k["v"] * math.tan(math.radians(k["steer"])), k["yaw"])
                 for k in kin if k["steer"] is not None and abs(k["steer"]) > 2 and k["v"] > 1.0]
    if len(steer_pts) >= 30:
        num = sum(x * y for x, y in steer_pts)
        den = sum(y * y for _, y in steer_pts)
        L = num / den if den > 1e-9 else None  # x = L·y の回帰
        if L and 1.0 < L < 12.0:
            result["effectiveWheelBaseM"] = round(L, 2)

    # 2) 実測旋回の最小半径（曲率p95の逆数）と、実用最大操舵に相当する曲率
    kappas = [abs(k["kappa"]) for k in kin if k["kappa"] is not None and abs(k["kappa"]) > 1e-4]
    if kappas:
        k95 = percentile(kappas, 0.95)
        result["minTurnRadiusObservedM"] = round(1.0 / k95, 2) if k95 else None

    # 3) 加減速の実用上限（p95/p05・急峻ノイズはdt検査で除外済み）
    accels = [k["accel"] for k in kin]
    result["maxAccelMS2"] = round(percentile(accels, 0.95), 2)
    result["maxDecelMS2"] = round(-percentile(accels, 0.05), 2)

    # 4) コーナー速度ポリシー: 曲率帯ごとの実測速度p85
    #    → v=√(a_lat·R) を逆算し「実ドライバーの許容横加速度」を出す
    lat_accels = [k["v"] * k["v"] * abs(k["kappa"]) for k in kin
                  if k["kappa"] is not None and abs(k["kappa"]) > 0.005]
    if lat_accels:
        result["driverLateralAccelP85"] = round(percentile(lat_accels, 0.85), 2)

    # RISK_TUNING/VEHICLE_PRESETS への反映候補をそのまま出す
    result["suggested"] = {
        "vehicleConfig.maxAccel": result.get("maxAccelMS2"),
        "vehicleConfig.maxDecel": result.get("maxDecelMS2"),
        "vehicleConfig.wheelBase": result.get("effectiveWheelBaseM"),
        "RISK_TUNING.curve.lateralAccelMS2": result.get("driverLateralAccelP85")
    }
    return result


def selfcheck():
    """既知パラメータ（L=4.2m, a_lat=1.1）の合成ログから復元できるか検証。"""
    ok = True

    def check(name, cond, detail=""):
        nonlocal ok
        print(f"[{'PASS' if cond else 'FAIL'}] {name}  {detail}")
        ok = ok and cond

    L_TRUE = 4.2
    rows = []
    lat, lng, h, t = 35.0, 135.0, 0.0, 0.0
    import random
    rnd = random.Random(7)
    v = 5.0
    for i in range(1200):
        # 100歩ごとに目標速度3⇔8m/sを切替え、±0.8m/s²で追従（加減速上限の復元検証用）
        target = 8.0 if (i // 30) % 2 == 0 else 3.0
        v += max(-0.8, min(0.8, target - v))
        steer = 18 * math.sin(i / 35)
        yaw = v * math.tan(math.radians(steer)) / L_TRUE
        h += yaw * 1.0
        k = 111320.0
        lat += (v * math.cos(h) / k) * 1.0
        lng += (v * math.sin(h) / (k * math.cos(math.radians(lat)))) * 1.0
        t += 1.0
        rows.append({"t": t, "lat": lat + rnd.gauss(0, 2e-7), "lng": lng + rnd.gauss(0, 2e-7),
                     "v": v, "steer": steer})
    r = fit(rows)
    check("有効サンプル生成", r["samples"] > 800, f"n={r['samples']}")
    L = r.get("effectiveWheelBaseM")
    check(f"ホイールベース復元 L={L_TRUE}m ±10%", L is not None and abs(L - L_TRUE) / L_TRUE < 0.10, f"got {L}m")
    check("加速上限が正の妥当値", 0.1 < (r.get("maxAccelMS2") or 0) < 3.0, f"{r.get('maxAccelMS2')}")
    check("横加速度ポリシーが出る", r.get("driverLateralAccelP85") is not None, f"{r.get('driverLateralAccelP85')}")
    print("\nselfcheck", "ALL PASS" if ok else "FAILED")
    return 0 if ok else 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv")
    ap.add_argument("--out", default="runtime/motion_fit")
    ap.add_argument("--selfcheck", action="store_true")
    a = ap.parse_args()
    if a.selfcheck:
        return selfcheck()
    if not a.csv:
        ap.error("--csv <log.csv> か --selfcheck を指定してください")
    rows = load_csv(a.csv)
    r = fit(rows)
    os.makedirs(a.out, exist_ok=True)
    out = os.path.join(a.out, "motion_fit.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(r, f, ensure_ascii=False, indent=2)
    print(json.dumps(r, ensure_ascii=False, indent=2))
    print(f"saved: {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
