// UI-D / UI-E: 設定パネル タブ切替とグローバル Esc ハンドラ。
// index8.2.html の inline script は disabled になっているため、アクティブな ES モジュールで配線する。

function $(id) { return document.getElementById(id); }

function initSettingsTabs() {
  const spTabs = Array.from(document.querySelectorAll('.sp-tabs .sp-tab'));
  const spPanels = Array.from(document.querySelectorAll('.sp-tabpanel'));
  if (!spTabs.length || !spPanels.length) return;

  function activateSpTab(targetId) {
    spTabs.forEach((t) => {
      const active = t.id === targetId;
      t.setAttribute('aria-selected', active ? 'true' : 'false');
      t.setAttribute('tabindex', active ? '0' : '-1');
    });
    spPanels.forEach((p) => {
      const linkedId = p.getAttribute('aria-labelledby') || '';
      p.hidden = linkedId !== targetId;
    });
  }

  spTabs.forEach((tab) => {
    tab.addEventListener('click', () => activateSpTab(tab.id));
    tab.addEventListener('keydown', (ev) => {
      if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
      ev.preventDefault();
      const idx = spTabs.indexOf(tab);
      const next = ev.key === 'ArrowRight'
        ? spTabs[(idx + 1) % spTabs.length]
        : spTabs[(idx - 1 + spTabs.length) % spTabs.length];
      activateSpTab(next.id);
      next.focus();
    });
  });
}

function initGlobalEscHandler() {
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT')) return;
    const sidePanel = $('sidePanel');
    if (sidePanel && sidePanel.classList.contains('open')) {
      $('closeSettingsPanel')?.click();
      ev.preventDefault();
      return;
    }
    const resultPanel = $('resultPanel');
    if (resultPanel && resultPanel.style.display && resultPanel.style.display !== 'none') {
      $('resultPanelClose')?.click();
      ev.preventDefault();
      return;
    }
    const svp = $('svViewport');
    if (svp && svp.classList.contains('sv-expanded')) {
      $('svExpandBtn')?.click();
      ev.preventDefault();
    }
  });
}

// V9-C3: スマートウィザード — ワークフロー状態を見て、次に押すべきボタンに .ui-pulse-hint を付ける
function initSmartWizard() {
  const PULSE_CLASS = 'ui-pulse-hint';
  let currentTargetId = null;

  function setTarget(nextId) {
    if (nextId === currentTargetId) return;
    if (currentTargetId) {
      const old = $(currentTargetId);
      if (old) old.classList.remove(PULSE_CLASS);
    }
    currentTargetId = nextId;
    if (nextId) {
      const el = $(nextId);
      if (el) el.classList.add(PULSE_CLASS);
    }
  }

  function evaluate() {
    const store = window.store;
    if (!store || typeof store.getState !== 'function') return;
    const state = store.getState();
    const roadsReady = Array.isArray(state.geoJsonDataSets) && state.geoJsonDataSets.length > 0;
    const endpointsReady = Array.isArray(state.selectedEndpoints) && state.selectedEndpoints.length >= 2;
    const routeReady = Array.isArray(state.simRoute) && state.simRoute.length >= 2;
    const hasResult = !!state.deliveryAssessment;
    const assessing = !!window._isAssessing;

    if (assessing || hasResult) {
      setTarget(null);
      return;
    }
    if (!roadsReady) {
      setTarget('topRefreshData');
      return;
    }
    if (!endpointsReady || !routeReady) {
      // 経路設定中はボタンよりも地図クリックが必要 — Pulse 対象なし
      setTarget(null);
      return;
    }
    setTarget('runDeliveryAssessment');
  }

  // 初期評価 + 定期評価（store の subscribe が無い場合の保険）
  evaluate();
  setInterval(evaluate, 800);
  if (window.store?.subscribe) {
    window.store.subscribe(() => evaluate());
  }
}

export function initUIEnhancements() {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      initSettingsTabs();
      initGlobalEscHandler();
      initSmartWizard();
    }, { once: true });
  } else {
    initSettingsTabs();
    initGlobalEscHandler();
    initSmartWizard();
  }
}
