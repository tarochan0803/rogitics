# 2026-05-25 Index 9.0 UI Redesign Log

## Goal

`index9.0.html` の既存機能配線を維持したまま、見た目を大きく変える。

## Scope

- HTMLの主要IDは変更しない。
- JSの経路探索、搬入判定、YOLO、3D表示、設定パネルの配線はそのまま維持。
- UI変更は `index9.0.css` に集約。

## Implemented

- `index9.0.css`
  - 既存の薄い上書きを全面置換。
  - 左サイドバーを運行管制ドック風に再構成。
  - 上部バーを2段のコマンドデッキ化。
  - 車両カード、運転技術、道路取得、搬入判定、3D/設定操作を明確に分離。
  - 設定パネルを右ドックとして再デザイン。
  - HUD、Workflow、Result、Toast、Progress、3Dパネルのトーンを統一。
  - 1280px幅でも主要操作が画面外に出ないよう補正。
  - 既存CSSの高い詳細度に負けていた上部ボタンサイズを個別補正。

## Verification

Target:

- `http://127.0.0.1:8080/index9.0.html`

Checks:

- HTTP 200: OK
- Initial browser load: OK
- Console/page errors: none
- 1440x900 layout:
  - Sidebar visible
  - Top command bar visible
  - Vehicle cards visible
  - Road data button visible
  - Delivery assessment button visible
  - Settings button visible
  - 3D button visible
- 1280x800 layout:
  - Main controls offscreen: none
- Settings panel:
  - `#sidePanel.open`: OK
  - Final position: on screen
- 3D:
  - `#map3dWrap.open`: OK
  - Canvas visible: OK
  - Tile status: `3D ground: google-2d-satellite z18 (49/49 tiles)`

Screenshots:

- `runtime/logs/index9_ui_command_workbench_1440.png`
- `runtime/logs/index9_ui_command_workbench_1280.png`
- `runtime/logs/index9_ui_command_workbench_3d.png`

## Notes

- This is a visual/workbench redesign only.
- Existing functional IDs and event listeners are intentionally preserved.
