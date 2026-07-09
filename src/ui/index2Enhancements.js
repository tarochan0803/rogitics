import { store } from '../state.js';

function byId(id) {
  return document.getElementById(id);
}

function setTogglePressed(btn, pressed) {
  if (!btn) return;
  btn.setAttribute('aria-pressed', pressed ? 'true' : 'false');
  btn.classList.toggle('active', !!pressed);
}

function updateNeonIndicators(state) {
  const plannerBtn = byId('togglePlannerWidget');
  const editorBtn = byId('toggleEditorWidget');
  const open3dBtn = byId('open3D');

  const endpoints = state.selectedEndpoints?.length || 0;
  const routeOk = (state.simRoute?.length || 0) > 1;
  if (plannerBtn) plannerBtn.classList.toggle('neon', endpoints > 0 || routeOk);

  if (editorBtn) editorBtn.classList.toggle('neon', !!state.isWidthEditMode);
  if (open3dBtn) open3dBtn.classList.toggle('neon', routeOk);
}

function closeAll(toggles) {
  toggles.forEach((t) => {
    if (!t?.widget) return;
    t.widget.hidden = true;
    setTogglePressed(t.btn, false);
  });
}

function wireClickThrough(btnId, targetId) {
  const btn = byId(btnId);
  const target = byId(targetId);
  if (!btn || !target) return;
  btn.addEventListener('click', () => target.click());
}

function mirrorToggleState(sourceId, mirrorId) {
  const source = byId(sourceId);
  const mirror = byId(mirrorId);
  if (!source || !mirror) return;

  const sync = () => {
    const on = source.classList.contains('active');
    mirror.classList.toggle('active', on);
    mirror.setAttribute('aria-pressed', on ? 'true' : 'false');
  };

  mirror.addEventListener('click', () => {
    source.click();
    sync();
  });

  const observer = new MutationObserver(sync);
  observer.observe(source, { attributes: true, attributeFilter: ['class'] });
  sync();
}

document.addEventListener('DOMContentLoaded', () => {
  const toggles = [
    { btn: byId('togglePlannerWidget'), widget: byId('widget-planner'), close: ['widget-editor', 'widget-system'] },
    { btn: byId('toggleEditorWidget'), widget: byId('widget-editor'), close: ['widget-planner', 'widget-system'] },
    { btn: byId('toggleSystemWidget'), widget: byId('widget-system'), close: ['widget-planner', 'widget-editor'] }
  ].filter((t) => t.btn && t.widget);

  const sync = () => {
    toggles.forEach((t) => setTogglePressed(t.btn, !t.widget.hidden));
  };

  toggles.forEach((t) => {
    t.btn.addEventListener('click', () => {
      const willOpen = t.widget.hidden;
      t.close.forEach((id) => {
        const w = byId(id);
        if (w) w.hidden = true;
      });
      t.widget.hidden = !willOpen;
      sync();
    });
  });

  sync();

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    closeAll(toggles);
  });

  mirrorToggleState('toggleManualEndpointMode', 'toggleManualEndpointModeQuick');
  wireClickThrough('osrm-route-quick', 'osrm-route');
  wireClickThrough('open3DAnalysis', 'open3D');

  // 3D/2D toggle is handled in controls.js; no fallback layout changes needed here.

  store.subscribe(updateNeonIndicators);
  updateNeonIndicators(store.getState());
});
