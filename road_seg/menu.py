# -*- coding: utf-8 -*-
"""Japanese console menu launched by 道路幅AI検証.bat."""

from __future__ import annotations

import json
import os
import subprocess
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def _pause() -> None:
    try:
        input("\nEnter でメニューに戻ります...")
    except EOFError:
        pass


def _ask(prompt: str, default):
    try:
        s = input(f"{prompt} [{default}]: ").strip()
    except EOFError:
        s = ""
    return s if s else str(default)


def do_check() -> None:
    print("\n----- 幾何エンジン検証 -----")
    from . import selfcheck

    selfcheck.main()
    print("\n----- サーバAPI検証 -----")
    from . import smoke

    smoke.run_inprocess()
    _pause()


def do_eval() -> None:
    from .eval_real import _straight_line, run

    print("\nGSI航空写真から、指定した直線道路の幅を試算します。")
    print("そのまま Enter なら東京駅周辺の既定値です。\n")
    lat = float(_ask("緯度", 35.6812))
    lng = float(_ask("経度", 139.7671))
    brg = float(_ask("方位角(度)", 30))
    length = float(_ask("長さ(m)", 120))
    line = _straight_line(lat, lng, length, brg)
    out_dir = os.path.join(os.path.dirname(__file__), ".eval_out")
    print("\n取得・解析中...")
    try:
        info = run(line, out_dir=out_dir)
    except Exception as exc:
        print(f"[ERROR] 解析に失敗しました: {exc}")
        _pause()
        return
    print(json.dumps(info, ensure_ascii=False, indent=2))
    overlay = os.path.join(out_dir, "overlay.png")
    if os.path.exists(overlay):
        print(f"\n確認画像: {overlay}")
        try:
            os.startfile(overlay)  # type: ignore[attr-defined]
        except Exception:
            pass
    _pause()


def do_serve() -> None:
    print("\nroad_seg サーバを起動します: http://127.0.0.1:8012/health")
    print("停止はこのウィンドウで Ctrl+C です。\n")
    try:
        subprocess.run([sys.executable, "-m", "uvicorn", "road_seg.server:app", "--port", "8012"])
    except KeyboardInterrupt:
        pass
    _pause()


def _wait_health(base_url: str, deadline: float = 25.0) -> bool:
    import time
    from urllib import request

    start = time.time()
    while time.time() - start < deadline:
        try:
            with request.urlopen(f"{base_url}/health", timeout=2) as res:
                if res.status == 200:
                    return True
        except Exception:
            time.sleep(0.6)
    return False


def do_annotate() -> None:
    """Open the manual road-surface correction UI."""

    import webbrowser

    url = "http://127.0.0.1:8012/annotate/ui"
    print("\n道路ラベル作成ツールを起動します。")
    print("流れ: 地図で範囲を選ぶ -> 下書きをブラシ修正 -> 保存 -> 5)で学習")
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "road_seg.server:app", "--port", "8012"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        if _wait_health("http://127.0.0.1:8012"):
            print(f"ブラウザを開きます: {url}")
            webbrowser.open(url)
        else:
            print("サーバ起動確認に失敗しました。手動で開いてください: " + url)
        try:
            input("\n作業が終わったら Enter を押してください...")
        except EOFError:
            pass
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=8)
        except Exception:
            proc.kill()


def do_train_mixed() -> None:
    print("\n手動修正データ + 弱教師データで道路面モデルを継続学習します。")
    arch = _ask("モデル(unet/deeplabv3plus)", "unet")
    ep = int(float(_ask("エポック数", 30)))
    repeat = int(float(_ask("手動データの重み(繰り返し数)", 8)))
    cmd = [
        sys.executable,
        "-m",
        "road_seg.train_mixed",
        "--arch",
        arch,
        "--epochs",
        str(ep),
        "--manual-repeat",
        str(repeat),
    ]
    subprocess.run(cmd)
    _pause()


def do_train_manual_only() -> None:
    print("\n手動修正データだけで道路面モデルを学習します。")
    arch = _ask("モデル(unet/deeplabv3plus)", "unet")
    ep = int(float(_ask("エポック数", 40)))
    subprocess.run([sys.executable, "-m", "road_seg.train", "--arch", arch, "--epochs", str(ep)])
    _pause()


def do_stats() -> None:
    from . import dataset

    print("\n----- 教師データ統計 -----")
    print(json.dumps(dataset.stats(), ensure_ascii=False, indent=2))
    _pause()


MENU = """
============================================================
  道路幅AI / 航空写真 道路面学習メニュー
============================================================

  1) 動作確認              selfcheck + smoke
  2) 航空写真で幅テスト    GSI航空写真 -> 道路幅 overlay
  3) APIサーバ起動         /segment_road_width, /segment_road_surface
  4) 道路ラベル作成        地図で範囲選択 -> 手動修正 -> 保存
  5) 学習                  手動修正 + 弱教師データで継続学習
  6) 手動データだけ学習    dataset/images + masks のみ
  7) 教師データ統計        件数・モデル情報を表示
  0) 終了
"""


def main() -> int:
    dispatch = {
        "1": do_check,
        "2": do_eval,
        "3": do_serve,
        "4": do_annotate,
        "5": do_train_mixed,
        "6": do_train_manual_only,
        "7": do_stats,
    }
    while True:
        print(MENU)
        try:
            sel = input("番号を入力して Enter: ").strip()
        except EOFError:
            break
        if sel == "0":
            break
        fn = dispatch.get(sel)
        if fn:
            fn()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
