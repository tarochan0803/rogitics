import { DEFAULT_VEHICLE_PRESET, RUNTIME_CONFIG } from './config.js';
import { store } from './state.js';
import { initMap2D } from './ui/map2d.js';
import { initThree3D } from './ui/map3dThree.js';
import { initControls } from './ui/controls.js';
import { initPageChrome } from './ui/pageChrome.js';
import { initStreetViewScan } from './ui/streetviewScan.js';
import { initTheme } from './ui/theme.js';
import { initTruckHud } from './ui/truckHud.js';
import { setDriveConfig, clearTrail, startAutoFollow, stopAutoFollow, isAutoFollowActive } from './ui/truckDrive.js';
import { initUIEnhancements } from './ui/uiEnhancements.js';

function toast(msg) {
  const box = document.getElementById('toast');
  if (!box) return;
  const div = document.createElement('div');
  div.className = 'toast-item';
  div.textContent = msg;
  box.appendChild(div);
  setTimeout(() => div.remove(), 2000);
}

async function bootstrap() {
  console.log('[TruckOS] bootstrap start');
  initTheme();
  initMap2D('map');
  console.log('[TruckOS] map2d initialized (Leaflet)');
  initThree3D();
  console.log('[TruckOS] map3d initialized (Three.js lightweight)');
  initControls();
  console.log('[TruckOS] controls initialized');
  initStreetViewScan();
  initTruckHud();
  initPageChrome();
  initUIEnhancements();
  window.store = store; // Expose for HUD integration
  const driverSkill = Math.max(0.5, Math.min(2.0, Number(RUNTIME_CONFIG.defaultDriverSkill) || 1.0));
  const driverSkillInput = document.getElementById('driverSkill');
  const driverSkillValue = document.getElementById('driverSkillValue');
  if (driverSkillInput) driverSkillInput.value = driverSkill.toFixed(1);
  if (driverSkillValue) driverSkillValue.textContent = driverSkill.toFixed(1);
  store.setDriverSkill(driverSkill);
  store.applyVehiclePreset(DEFAULT_VEHICLE_PRESET);

  // ── Drive mode toggle ────────────────────────────────────────────────────

  // ── Auto-follow route simulation ─────────────────────────────────────────
  document.getElementById('autoFollowBtn')?.addEventListener('click', () => {
    if (isAutoFollowActive()) {
      stopAutoFollow();
      document.getElementById('autoFollowBtn').textContent = '▶ 自動走行';
    } else {
      startAutoFollow(18); // 18 km/h
      document.getElementById('autoFollowBtn').textContent = '⏹ 停止';
    }
  });

  // ── Drive config inputs ───────────────────────────────────────────────────
  function _applyDriveConfig() {
    setDriveConfig({
      widthM:      parseFloat(document.getElementById('driveTruckW')?.value)    || undefined,
      wbM:         parseFloat(document.getElementById('driveWheelbase')?.value) || undefined,
      maxSpeedKmh: parseFloat(document.getElementById('driveMaxSpeed')?.value)  || undefined,
    });
  }
  document.getElementById('driveTruckW')?.addEventListener('change',   _applyDriveConfig);
  document.getElementById('driveWheelbase')?.addEventListener('change', _applyDriveConfig);
  document.getElementById('driveMaxSpeed')?.addEventListener('change',  _applyDriveConfig);
  document.getElementById('driveTrailClear')?.addEventListener('click', clearTrail);

  // ── 木材積載設定 ─────────────────────────────────────────────────────────
  function _applyCargoConfig() {
    const enabled = !!document.getElementById('cargoEnabled')?.checked;
    const lengthM = parseFloat(document.getElementById('cargoLength')?.value) || 4.0;
    const widthM  = parseFloat(document.getElementById('cargoWidth')?.value)  || 1.0;
    const count   = parseInt(document.getElementById('cargoCount')?.value, 10) || 1;
    store.setCargoConfig({
      loadType: enabled ? 'lumber' : 'none',
      length: lengthM * 1000,
      widthMm: widthM * 1000,
      count
    });
    const statusEl = document.getElementById('cargoStatus');
    if (statusEl) {
      const placement = store.getState().cargoPlacement || 'center';
      const placeLabel = { left: '左寄り', center: '中央', right: '右寄り' }[placement];
      statusEl.textContent = enabled
        ? `積載中: ${lengthM.toFixed(1)}m × 幅${widthM.toFixed(1)}m / ${count}本 / ${placeLabel}`
        : '未積載 — 自動走行/操作モードで荷台上に外形を描画します';
    }
  }
  ['cargoEnabled', 'cargoLength', 'cargoWidth', 'cargoCount'].forEach((id) => {
    document.getElementById(id)?.addEventListener('change', _applyCargoConfig);
  });
  document.querySelectorAll('.cargo-place-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const place = btn.dataset.place;
      document.querySelectorAll('.cargo-place-btn').forEach((b) => b.classList.toggle('active', b === btn));
      store.setCargoConfig({ placement: place });
      _applyCargoConfig();
    });
  });

  // ── Sync vehicle preset → drive config inputs ────────────────────────────
  let _lastSyncedPreset = '';
  store.subscribe((state) => {
    const vc = state.vehicleConfig;
    const presetName = state.vehiclePresetName || '';
    if (!vc || presetName === _lastSyncedPreset) return;
    _lastSyncedPreset = presetName;
    const wEl = document.getElementById('driveTruckW');
    const wbEl = document.getElementById('driveWheelbase');
    if (wEl && vc.vehicleWidth > 0)  wEl.value  = Number(vc.vehicleWidth).toFixed(1);
    if (wbEl && vc.wheelBase   > 0)  wbEl.value = Number(vc.wheelBase).toFixed(1);
    _applyDriveConfig();
  });

  toast('OS initialized');
}

bootstrap().catch((e) => {
  console.error('[TruckOS] bootstrap failed:', e);
  const box = document.getElementById('toast');
  if (box) {
    const div = document.createElement('div');
    div.className = 'toast-item';
    div.textContent = 'ERROR: ' + e.message;
    box.appendChild(div);
  }
});
