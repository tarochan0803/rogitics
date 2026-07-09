# 2026-05-25 Workflow Step Buttons Log

## Goal

Workflowドックに、現在のステップに応じた操作ボタンを表示する。

## Implemented

- `index9.0.html`
  - `#workflowDock` 内に `#wfStepActions` を追加。
  - 主操作ボタン `#wfNextAction` を追加。
  - 補助操作 `#wfOpenSettings`, `#wfToggleManual`, `#wfClearEndpoints` を追加。
  - 車両クイック選択 `#wfVehicleActions` を追加。

- `src/ui/workflowController.js`
  - Workflow状態に応じてボタン表示、文言、disabled状態を切替。
  - ステップ別の主操作:
    - Step 1: `1. 道路データを取得`
    - Step 3 before endpoints: `3. 始点を追加` / `3. 終点を追加`
    - Step 3 after endpoints: `3. 経路を生成`
    - Step 4: `4. 搬入判定を実行`
    - Step 5: `5. 結果パネルを開く`
  - 車両クイック選択のactive状態を同期。

- `src/ui/controls.js`
  - `#wfClearEndpoints` から既存の `#clear-endpoints` を呼ぶ配線を追加。

- `index9.0.css`
  - Workflowステップボタン群のレイアウトを追加。
  - 折りたたみ時はステップボタンも非表示。
  - 車両クイック選択のactive表示を追加。

## Verification

Commands:

```powershell
node --check src\ui\workflowController.js
node --check src\ui\controls.js
```

Result:

- Syntax check: OK
- `http://127.0.0.1:8080/index9.0.html`: HTTP 200
- Browser page errors: none

Puppeteer state transitions:

- Initial:
  - Primary: `1. 道路データを取得`
  - Vehicle quick buttons: hidden
- Roads ready:
  - Primary: `3. 始点を追加`
  - Vehicle quick buttons: visible
- One endpoint:
  - Primary: `3. 終点を追加`
  - Clear endpoints: visible
- Two endpoints:
  - Primary: `3. 経路を生成`
- Route ready:
  - Primary: `4. 搬入判定を実行`
- Result ready:
  - Primary: `5. 結果パネルを開く`

Interaction checks:

- Workflow settings button opens settings panel: OK
- Workflow vehicle quick select `3t` updates hidden select, workflow active button, and top vehicle card: OK

Screenshot:

- `runtime/logs/index9_workflow_step_buttons.png`
