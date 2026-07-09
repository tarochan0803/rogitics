function byId(id) {
  return document.getElementById(id);
}

function setWfStepState(stepId, done, active, text) {
  const item = byId(stepId);
  if (!item) return;
  item.classList.toggle('done', !!done);
  item.classList.toggle('active', !!active);
  const stateEl = item.querySelector('.wf-state');
  if (stateEl && typeof text === 'string') stateEl.textContent = text;
}

function setVisible(el, visible) {
  if (!el) return;
  el.hidden = !visible;
  el.classList.toggle('is-hidden', !visible);
}

function setButtonLabel(id, text, { disabled = false } = {}) {
  const el = byId(id);
  if (!el) return;
  el.textContent = text;
  el.disabled = !!disabled;
}

export function shortPresetKey(raw, { toFullVehiclePresetKey, fullToShortMap }) {
  const full = toFullVehiclePresetKey(raw);
  if (!full) return '';
  return fullToShortMap[full] || full;
}

export function renderRouteFlowButtons(state) {
  const endpointCount = state?.selectedEndpoints?.length || 0;
  const hasRoute = (state?.simRoute?.length || 0) >= 2;

  const resetBtn = byId('reset-route');
  if (resetBtn) resetBtn.disabled = !hasRoute;

  const clearBtn = byId('clear-endpoints');
  if (clearBtn) clearBtn.disabled = endpointCount === 0;
}

export function renderWorkflowDock(state, { shortPresetKey, getRouteTrackingTurnRadius }) {
  const dock = byId('workflowDock');
  if (!dock) return;

  const roadsReady = (state.geoJsonDataSets?.length || 0) > 0;
  const endpointCount = state.selectedEndpoints?.length || 0;
  const endpointsReady = endpointCount >= 2;
  const routeReady = (state.simRoute?.length || 0) >= 2;
  const routeDone = routeReady;
  const vehicleKey = shortPresetKey(state.vehiclePresetName || '');
  const vehicleReady = !!vehicleKey;
  const isAssessing = !!window._isAssessing;
  const resultReady = !isAssessing && !!state.deliveryAssessment;
  const currentStep = !roadsReady ? 0 : (!vehicleReady ? 1 : (!routeDone ? 2 : (!resultReady ? 3 : 4)));

  const vehicleLabelMap = {
    '2t': '2t トラック',
    '3t': '3t トラック',
    '4t': '4t トラック',
    '10t': '10t トラック',
    'custom': 'カスタム'
  };

  setWfStepState('wfStep1', roadsReady, currentStep === 0, roadsReady ? '読み込み済み' : '未取得');
  setWfStepState('wfStep2', vehicleReady, currentStep === 1, vehicleLabelMap[vehicleKey] || vehicleKey || '未選択');
  setWfStepState(
    'wfStep3',
    routeDone,
    currentStep === 2,
    !endpointsReady ? `${Math.min(endpointCount, 2)}/2` : (!routeReady ? '経路生成待ち' : '生成済み')
  );
  setWfStepState('wfStep4', resultReady, currentStep === 3, resultReady ? '判定済み' : (isAssessing ? '判定中' : '待機'));
  setWfStepState('wfStep5', resultReady, currentStep === 4, resultReady ? '確認可能' : '-');

  const stepLabel = byId('wfStepLabel');
  if (stepLabel) stepLabel.textContent = `ステップ ${currentStep + 1} / 5`;

  const hint = byId('wfHint');
  if (hint) {
    if (!roadsReady) hint.textContent = '上部の「道路取得」で道路データを読み込んでください。';
    else if (!vehicleReady) hint.textContent = '上部の車両カードからトラックを選択してください。';
    else if (!endpointsReady) hint.textContent = '地図をクリックして始点と終点を設定してください。';
    else if (!routeReady) hint.textContent = '🛰️ 経路を自動生成中... 道路グラフと迂回候補を確認しています';
    else if (!resultReady) hint.textContent = isAssessing ? '搬入判定を実行中です。完了まで待ってください。' : '上部の「搬入判定を実行」で判定を開始してください。';
    else hint.textContent = '判定済みです。左下のトラック切替と結果パネルで比較できます。';
  }

  const mapGuide = byId('mapGuideText');
  if (mapGuide) {
    if (!roadsReady) mapGuide.textContent = '上部の「道路取得」で道路データを読み込んでください。';
    else if (!endpointsReady) mapGuide.textContent = '地図をクリックして始点と終点を設定してください。';
    else if (!routeReady) mapGuide.textContent = '🛰️ 経路を自動生成中... 複数候補を確認しています';
    else if (!resultReady) mapGuide.textContent = isAssessing ? '搬入判定を実行中です...' : '上部の「搬入判定を実行」で結果を作成します。';
    else mapGuide.textContent = '判定済みです。結果パネルとトラックタブで確認してください。';
  }

  const actions = byId('wfStepActions');
  const secondary = byId('wfSecondaryActions');
  const vehicleActions = byId('wfVehicleActions');
  const clearEndpoints = byId('wfClearEndpoints');
  setVisible(actions, true);
  setVisible(secondary, true);
  setVisible(vehicleActions, currentStep === 1 || (!routeDone && roadsReady));
  setVisible(byId('wfOpenSettings'), currentStep !== 0);
  setVisible(byId('wfToggleManual'), roadsReady && !routeDone);
  setVisible(clearEndpoints, endpointCount > 0 && !resultReady);

  if (!roadsReady) {
    setButtonLabel('wfNextAction', '1. 道路データを取得');
  } else if (!vehicleReady) {
    setButtonLabel('wfNextAction', '2. 車両を選択して次へ');
  } else if (!endpointsReady) {
    const nextPoint = endpointCount <= 0 ? '始点を追加' : '終点を追加';
    setButtonLabel('wfNextAction', `3. ${nextPoint}`);
    setButtonLabel('wfToggleManual', '端点追加モード');
    setButtonLabel('wfOpenSettings', '経路設定');
  } else if (!routeReady) {
    setButtonLabel('wfNextAction', '3. 経路を生成');
    setButtonLabel('wfToggleManual', '端点を追加');
    setButtonLabel('wfOpenSettings', '経路設定');
  } else if (!resultReady) {
    setButtonLabel('wfNextAction', isAssessing ? '4. 判定中...' : '4. 搬入判定を実行', { disabled: isAssessing });
    setButtonLabel('wfOpenSettings', '判定設定');
  } else {
    setButtonLabel('wfNextAction', '5. 結果パネルを開く');
    setButtonLabel('wfOpenSettings', '条件を見直す');
  }

  document.querySelectorAll('#wfVehicleActions [data-vehicle-short]').forEach((button) => {
    const short = String(button.dataset.vehicleShort || '');
    button.classList.toggle('active', short === vehicleKey);
  });

  const meta = byId('vehiclePresetMeta');
  if (meta) {
    const vc = state.vehicleConfig || {};
    const totalLength = Number(vc.wheelBase || 0) + Number(vc.frontOverhang || 0) + Number(vc.rearOverhang || 0);
    const width = Number(vc.vehicleWidth || 0);
    const rmin = getRouteTrackingTurnRadius(vc);
    const label = vc.label || state.vehiclePresetName || '-';
    const lenText = Number.isFinite(totalLength) && totalLength > 0 ? `${totalLength.toFixed(1)}m` : '-';
    const widthText = Number.isFinite(width) && width > 0 ? `${width.toFixed(1)}m` : '-';
    const rText = Number.isFinite(rmin) && rmin > 0 ? `${rmin.toFixed(1)}m` : '-';
    meta.textContent = `車両: ${label} / 全長 ${lenText} / 幅 ${widthText} / 最小回転半径 ${rText}`;
  }

  document.querySelectorAll('#vehCardRow .veh-card').forEach((button) => {
    const short = String(button.dataset.veh || '');
    button.classList.toggle('active', short === vehicleKey);
  });
}

export async function runWorkflowNextAction({
  state,
  loadRoadsForView,
  openSettingsPanel,
  setManualAddMode,
  toast,
  computeRouteFromEndpoints,
  applyRoutePlan,
  showResultPanel
}) {
  const roadsReady = (state.geoJsonDataSets?.length || 0) > 0;
  const endpointsReady = (state.selectedEndpoints?.length || 0) >= 2;
  const routeReady = (state.simRoute?.length || 0) >= 2;
  const resultReady = !!state.deliveryAssessment;

  if (!roadsReady) {
    await loadRoadsForView();
    return;
  }
  if (!endpointsReady) {
    openSettingsPanel(true);
    const manualBtn = byId('toggleManualEndpointMode');
    if (manualBtn && !manualBtn.classList.contains('active')) manualBtn.click();
    else setManualAddMode(true);
    toast('地図クリックで始点と終点を設定してください');
    return;
  }
  if (!routeReady) {
    const computed = await computeRouteFromEndpoints(state, { silent: true, prefer: 'hybrid' });
    if (applyRoutePlan(computed)) {
      toast('経路を生成しました');
    } else {
      toast('経路生成に失敗しました。道路取得と端点を見直してください');
    }
    return;
  }
  if (window._isAssessing) return;
  if (!resultReady) {
    byId('runDeliveryAssessment')?.click();
    return;
  }
  showResultPanel();
}
