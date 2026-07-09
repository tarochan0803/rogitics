# Fix log: assessment route display

Date: 2026-05-25

Issue:
- During delivery assessment, the UI could show "assessment completed" while detour trials were still running.
- If a detour route was adopted, the route plan changed but the delivery result panel, sweep trajectory, contact points, and feasibility layers were not always redrawn from the final adopted result.

Fix:
- `src/ui/controls.js`
  - Added `syncAssessmentResultToUi(result, strictSettings)`.
  - The final result is now synced after detour trials, so the adopted route, sweep trajectory, contact points, feasibility layers, HUD, and result panel all reflect the final assessment route.
- `src/ui/workflowController.js`
  - `deliveryAssessment` is no longer treated as complete while `window._isAssessing` is true.
  - The guide now stays in an assessing state until all detour trials and final UI sync are complete.

Verification:
- `node --check src\ui\controls.js`
- `node --check src\ui\workflowController.js`
- Browser load: `http://127.0.0.1:8080/index8.2.html`
- Result: v9.0 loaded, YOLO status visible, no page errors.
