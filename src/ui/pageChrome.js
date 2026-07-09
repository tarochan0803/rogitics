const WORKFLOW_DOCK_STORAGE_KEY = 'truck_workflow_dock_collapsed_v1';
const STREETVIEW_HIDDEN_STORAGE_KEY = 'truck_streetview_hidden_v1';
const DRIVE_HUD_HIDDEN_STORAGE_KEY = 'truck_drive_hud_hidden_v1';

let initialized = false;

function byId(id) {
  return document.getElementById(id);
}

function safeLocalStorageGet(key) {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(key);
  } catch (e) {
    return null;
  }
}

function safeLocalStorageSet(key, value) {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(key, value);
  } catch (e) {
  }
}

function normalizeVehShort(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '2t';
  if (raw.startsWith('2t')) return '2t';
  if (raw.startsWith('3t')) return '3t';
  if (raw.startsWith('4t')) return '4t';
  if (raw.startsWith('10t')) return '10t';
  if (raw === 'custom') return 'custom';
  return raw;
}

function syncVehicleCards(nextValue) {
  const short = normalizeVehShort(nextValue);
  document.querySelectorAll('#vehCardRow .veh-card').forEach((button) => {
    const active = (button.dataset.veh || '') === short;
    button.classList.toggle('active', active);
    // UI-C: role="radio" の aria-checked を同期
    if (button.getAttribute('role') === 'radio') {
      button.setAttribute('aria-checked', active ? 'true' : 'false');
    }
  });
}

function initVehicleCards() {
  document.querySelectorAll('#vehCardRow .veh-card').forEach((button) => {
    button.addEventListener('click', () => {
      const select = byId('vehiclePreset');
      const next = String(button.dataset.veh || '');
      if (!select || !next) return;
      if (select.value !== next) select.value = next;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      syncVehicleCards(next);
    });
  });

  byId('vehiclePreset')?.addEventListener('change', (event) => {
    syncVehicleCards(event.target?.value);
  });

  syncVehicleCards(byId('vehiclePreset')?.value || '2t');
}

function initWorkflowDockToggle() {
  const dock = byId('workflowDock');
  if (!dock) return;

  if (safeLocalStorageGet(WORKFLOW_DOCK_STORAGE_KEY) === '1') {
    dock.classList.add('collapsed');
  }

  byId('wfDockToggle')?.addEventListener('click', () => {
    const collapsed = dock.classList.toggle('collapsed');
    safeLocalStorageSet(WORKFLOW_DOCK_STORAGE_KEY, collapsed ? '1' : '0');
  });
}

function initStreetViewExpandButton() {
  byId('svExpandBtn')?.addEventListener('click', () => {
    const viewport = byId('svViewport');
    if (!viewport) return;
    viewport.classList.toggle('sv-expanded');
    const button = byId('svExpandBtn');
    if (button) button.textContent = viewport.classList.contains('sv-expanded') ? '×' : '⛶';
  });
}

function bindPeekablePanel({
  panelId,
  hideButtonId,
  showButtonId,
  storageKey,
  isPanelVisible
} = {}) {
  const panel = byId(panelId);
  const hideButton = byId(hideButtonId);
  const showButton = byId(showButtonId);
  if (!panel || !hideButton || !showButton) return;

  if (safeLocalStorageGet(storageKey) === '1') {
    panel.classList.add('panel-hidden');
  }

  const sync = () => {
    const visible = typeof isPanelVisible === 'function' ? !!isPanelVisible(panel) : !panel.hidden;
    showButton.hidden = !(visible && panel.classList.contains('panel-hidden'));
  };

  hideButton.addEventListener('click', () => {
    panel.classList.add('panel-hidden');
    safeLocalStorageSet(storageKey, '1');
    sync();
  });

  showButton.addEventListener('click', () => {
    panel.classList.remove('panel-hidden');
    safeLocalStorageSet(storageKey, '0');
    sync();
  });

  const observer = new MutationObserver(sync);
  observer.observe(panel, {
    attributes: true,
    attributeFilter: ['class', 'hidden', 'style']
  });

  sync();
}

function initPeekPanels() {
  bindPeekablePanel({
    panelId: 'svViewport',
    hideButtonId: 'svHideBtn',
    showButtonId: 'svShowBtn',
    storageKey: STREETVIEW_HIDDEN_STORAGE_KEY,
    isPanelVisible(panel) {
      return panel.classList.contains('active') && panel.style.display !== 'none';
    }
  });

  bindPeekablePanel({
    panelId: 'driveHud',
    hideButtonId: 'driveHudHideBtn',
    showButtonId: 'driveHudShowBtn',
    storageKey: DRIVE_HUD_HIDDEN_STORAGE_KEY,
    isPanelVisible(panel) {
      return !panel.hidden;
    }
  });
}

function fetchT(url, opts, timeoutMs) {
  if (typeof AbortSignal?.timeout === 'function') {
    return fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
  }
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), timeoutMs);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(id));
}

function setDot(id, state) {
  const el = byId(`srvDot${id}`);
  if (!el) return;
  el.className = `srv-dot ${state === 'unknown' ? '' : state}`.trim();
}

function setLabel(id, text) {
  const el = byId(`srvLabel${id}`);
  if (el) el.textContent = text;
}

function setButtonState(id, { running = false, starting = false, supported = true } = {}) {
  const button = byId(`srvStart${id}`);
  if (!button) return;
  if (!supported) {
    button.disabled = false;
    button.textContent = '利用不可';
    return;
  }
  button.disabled = running || starting;
  button.textContent = starting ? '起動中...' : (running ? '稼働中' : '起動');
}

function setAllOkVisible(visible) {
  const ok = byId('srvAllOk');
  if (ok) ok.style.display = visible ? '' : 'none';
}

function showUnsupportedServerApiMessage() {
  window.alert('この起動方法ではサーバー起動 API を使えません。\n`起動_ローカル.bat` または `scripts/start_local.ps1` で起動してください。');
}

function initServerPanel() {
  let yoloRunning = false;
  let serverApiSupported = window.location.protocol === 'http:' || window.location.protocol === 'https:';

  async function checkYolo() {
    if (!serverApiSupported) {
      setDot('Yolo', 'unknown');
      setLabel('Yolo', 'APIなし');
      setButtonState('Yolo', { supported: false });
      setAllOkVisible(false);
      return;
    }

    try {
      const response = await fetchT(new URL('/api/status', window.location.origin), {}, 2000);
      if (response.status === 404 || response.status === 405) {
        serverApiSupported = false;
        setDot('Yolo', 'unknown');
        setLabel('Yolo', 'APIなし');
        setButtonState('Yolo', { supported: false });
        setAllOkVisible(false);
        return;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      yoloRunning = payload?.yolo === 'running';
      setDot('Yolo', yoloRunning ? 'running' : 'stopped');
      setLabel('Yolo', yoloRunning ? '稼働中' : '停止');
      setButtonState('Yolo', { running: yoloRunning, supported: true });
      setAllOkVisible(yoloRunning);
    } catch (error) {
      yoloRunning = false;
      setDot('Yolo', 'stopped');
      setLabel('Yolo', '停止');
      setButtonState('Yolo', { supported: true });
      setAllOkVisible(false);
    }
  }

  byId('srvStartYolo')?.addEventListener('click', async () => {
    if (!serverApiSupported) {
      showUnsupportedServerApiMessage();
      return;
    }

    setDot('Yolo', 'starting');
    setLabel('Yolo', '起動中...');
    setButtonState('Yolo', { starting: true, supported: true });

    try {
      const response = await fetchT(new URL('/api/start-yolo', window.location.origin), { method: 'POST' }, 8000);
      if (response.status === 404 || response.status === 405) {
        serverApiSupported = false;
        setDot('Yolo', 'unknown');
        setLabel('Yolo', 'APIなし');
        setButtonState('Yolo', { supported: false });
        setAllOkVisible(false);
        showUnsupportedServerApiMessage();
        return;
      }
      if (!response.ok) {
        setDot('Yolo', 'stopped');
        setLabel('Yolo', `起動失敗 (HTTP ${response.status})`);
        setButtonState('Yolo', { supported: true });
        setAllOkVisible(false);
        return;
      }

      const payload = await response.json();
      if (payload?.status === 'already-running') {
        await checkYolo();
        return;
      }

      for (let i = 0; i < 15; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        await checkYolo();
        if (yoloRunning) return;
      }

      setDot('Yolo', 'stopped');
      setLabel('Yolo', '起動失敗');
      setButtonState('Yolo', { supported: true });
      setAllOkVisible(false);
    } catch (error) {
      setDot('Yolo', 'stopped');
      setLabel('Yolo', error?.message || '起動失敗');
      setButtonState('Yolo', { supported: true });
      setAllOkVisible(false);
    }
  });

  checkYolo();
  setInterval(checkYolo, 6000);
}

export function initPageChrome() {
  if (initialized) return;
  initialized = true;

  initVehicleCards();
  initWorkflowDockToggle();
  initStreetViewExpandButton();
  initPeekPanels();
  initServerPanel();
}
