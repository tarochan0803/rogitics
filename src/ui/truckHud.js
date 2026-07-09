const VEHICLES = {
  '2t_flat': { len: 4690, bed: 3100, unic: false, width: 1695, height: 1890 },
  '2t_unic': { len: 4690, bed: 2600, unic: true, width: 1695, height: 1890 },
  '3t_flat': { len: 6080, bed: 4360, unic: false, width: 2180, height: 2350 },
  '3t_unic': { len: 6140, bed: 4500, unic: true, width: 2180, height: 2350 },
  '4t_flat': { len: 8175, bed: 6165, unic: false, width: 2315, height: 2495 },
  '4t_unic': { len: 8175, bed: 5500, unic: true, width: 2315, height: 2495 },
  '10t_unic': { len: 11990, bed: 8585, unic: true, width: 2490, height: 3785 },
  'trailer_15t': { len: 11990, bed: 8700, unic: true, width: 2490, height: 3785, trailer: true }
};

const HUD_PRESET_BY_SHORT = {
  '2t': '2t_flat',
  '3t': '3t_flat',
  '4t': '4t_flat',
  '10t': '10t_unic'
};

const NS = 'http://www.w3.org/2000/svg';
const hudState = { vehKey: '4t_flat', mode: 'none', lumberLen: 6000, count: 1 };
const svgRefs = {};
let initialized = false;

function byId(id) {
  return document.getElementById(id);
}

function createVehicleSvg(key, vehicle) {
  const scale = 0.08;
  const realCabW = 1680 * scale;
  const totalW = vehicle.len * scale;
  const bedW = vehicle.bed * scale;
  const viewW = Math.max(1100, totalW + 240);

  const groundY = 220;
  const wheelRadius = 22;
  const axleY = groundY - wheelRadius;
  const frameBodyY = axleY - wheelRadius + 12;
  const bedFloorY = frameBodyY - 10;
  const sideGateH = 26;
  const bedTopY = bedFloorY - sideGateH;
  const cabRoofY = bedFloorY - 95;
  const toriiTopY = bedFloorY - 115;

  const cabStartX = 10;
  const cabEndX = cabStartX + realCabW;
  const bedEndX = totalW;
  const bedStartX = bedEndX - bedW;
  const frontWheelX = cabStartX + 35;
  const rearWheelX = bedEndX - 55;

  const pid = key.replace(/[^a-zA-Z0-9_]/g, '_');
  const woodId = 'w_' + pid;
  const arrowId = 'a_' + pid;
  const arrowGlowId = 'ag_' + pid;
  const cargoGroupId = 'hudCargoGroup_' + pid;

  const fsTop = cabStartX + realCabW * 0.15;
  const cabPath = [
    `M${cabStartX},${bedFloorY}`,
    `L${cabStartX},${bedFloorY - 15}`,
    `L${cabStartX - 4},${bedFloorY - 15}`,
    `L${cabStartX - 4},${bedFloorY - 38}`,
    `L${cabStartX},${bedFloorY - 38}`,
    `L${cabStartX + 2},${bedFloorY - 55}`,
    `L${fsTop},${cabRoofY}`,
    `L${cabEndX},${cabRoofY}`,
    `L${cabEndX},${bedFloorY}`,
    'Z'
  ].join(' ');

  const winPath = [
    `M${cabStartX + 10},${bedFloorY - 58}`,
    `L${fsTop + 6},${cabRoofY + 8}`,
    `L${cabEndX - 8},${cabRoofY + 8}`,
    `L${cabEndX - 8},${bedFloorY - 58}`,
    'Z'
  ].join(' ');

  function tire(cx, dual) {
    const radius = wheelRadius;
    const rim = wheelRadius * 0.56;
    const hub = wheelRadius * 0.22;
    const boltRadius = wheelRadius * 0.38;
    let svg = dual
      ? `<circle cx="${cx + 5}" cy="${axleY}" r="${radius - 1}" fill="#0d1117" stroke="#1e293b" stroke-width="1.5" opacity="0.85"/>`
      : '';
    svg += `<circle cx="${cx}" cy="${axleY}" r="${radius}" fill="#111827" stroke="#374151" stroke-width="2"/>`;
    svg += `<circle cx="${cx}" cy="${axleY}" r="${radius - 3}" fill="none" stroke="#1e293b" stroke-width="2.5"/>`;
    svg += `<circle cx="${cx}" cy="${axleY}" r="${rim}" fill="#1e2d3d" stroke="#334155" stroke-width="1.5"/>`;
    for (let i = 0; i < 6; i += 1) {
      const angle = i * 60 * Math.PI / 180;
      const x0 = (cx + hub * Math.cos(angle)).toFixed(1);
      const y0 = (axleY + hub * Math.sin(angle)).toFixed(1);
      const x1 = (cx + boltRadius * Math.cos(angle)).toFixed(1);
      const y1 = (axleY + boltRadius * Math.sin(angle)).toFixed(1);
      svg += `<line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}" stroke="#475569" stroke-width="2" stroke-linecap="round"/>`;
    }
    svg += `<circle cx="${cx}" cy="${axleY}" r="${hub}" fill="#0f172a" stroke="#64748b" stroke-width="1"/>`;
    for (let i = 0; i < 6; i += 1) {
      const angle = (i * 60 + 30) * Math.PI / 180;
      const bx = (cx + boltRadius * Math.cos(angle)).toFixed(1);
      const by = (axleY + boltRadius * Math.sin(angle)).toFixed(1);
      svg += `<circle cx="${bx}" cy="${by}" r="1.5" fill="#0f172a" stroke="#475569" stroke-width="0.8"/>`;
    }
    return svg;
  }

  let unic = '';
  if (vehicle.unic) {
    const ux = bedStartX + bedW * 0.12;
    const baseY = bedFloorY - 6;
    const boomRad = -30 * Math.PI / 180;
    const outerLen = Math.min(bedW * 0.55, 110);
    const innerLen = outerLen * 0.65;
    const tipX = (ux + Math.cos(boomRad) * outerLen).toFixed(1);
    const tipY = (baseY + Math.sin(boomRad) * outerLen).toFixed(1);
    const midX = (ux + Math.cos(boomRad) * innerLen).toFixed(1);
    const midY = (baseY + Math.sin(boomRad) * innerLen).toFixed(1);
    const cylTX = (ux + Math.cos(boomRad) * outerLen * 0.38).toFixed(1);
    const cylTY = (baseY + Math.sin(boomRad) * outerLen * 0.38).toFixed(1);
    const hkX = tipX;
    const hkY1 = tipY;
    const hkY2 = (parseFloat(tipY) + 28).toFixed(1);
    unic = `
      <g class="unic-crane">
        <rect x="${ux - 22}" y="${bedFloorY - 2}" width="7" height="${groundY - bedFloorY + 2}" fill="#1e293b" stroke="#334155" stroke-width="1"/>
        <rect x="${ux - 18}" y="${baseY - 12}" width="36" height="12" rx="3" fill="#b91c1c" stroke="#7f1d1d" stroke-width="1"/>
        <rect x="${ux - 12}" y="${baseY - 18}" width="24" height="8" rx="2" fill="#dc2626" stroke="#991b1b" stroke-width="1"/>
        <line x1="${ux}" y1="${baseY - 12}" x2="${tipX}" y2="${tipY}" stroke="#b91c1c" stroke-width="9" stroke-linecap="round"/>
        <line x1="${ux}" y1="${baseY - 12}" x2="${tipX}" y2="${tipY}" stroke="#dc2626" stroke-width="7" stroke-linecap="round" opacity="0.6"/>
        <line x1="${ux}" y1="${baseY - 12}" x2="${midX}" y2="${midY}" stroke="#ef4444" stroke-width="5" stroke-linecap="round" opacity="0.7"/>
        <line x1="${ux - 4}" y1="${baseY - 6}" x2="${cylTX}" y2="${cylTY}" stroke="#94a3b8" stroke-width="3" stroke-linecap="round" opacity="0.8"/>
        <line x1="${ux - 4}" y1="${baseY - 6}" x2="${cylTX}" y2="${cylTY}" stroke="#cbd5e1" stroke-width="1.2" stroke-linecap="round" opacity="0.5"/>
        <line x1="${hkX}" y1="${hkY1}" x2="${hkX}" y2="${hkY2}" stroke="#94a3b8" stroke-width="1.5" stroke-dasharray="3,2.5"/>
        <path d="M${(parseFloat(hkX) - 4).toFixed(1)},${(parseFloat(hkY2) - 3).toFixed(1)} Q${(parseFloat(hkX) - 4).toFixed(1)},${hkY2} ${hkX},${hkY2} Q${(parseFloat(hkX) + 4).toFixed(1)},${hkY2} ${(parseFloat(hkX) + 4).toFixed(1)},${(parseFloat(hkY2) - 5).toFixed(1)}" stroke="#cbd5e1" fill="none" stroke-width="2.5" stroke-linecap="round"/>
      </g>
    `;
  }

  const dimY = groundY + 40;
  const bedDimY = bedTopY - 15;

  const tpl = document.createElement('template');
  tpl.innerHTML = `
<svg class="thud-veh-svg" data-veh="${key}" viewBox="-80 ${toriiTopY - 40} ${viewW} 320" width="100%" style="max-height:300px;">
  <defs>
    <pattern id="${woodId}" width="20" height="10" patternUnits="userSpaceOnUse">
      <rect width="20" height="10" fill="#d97706"/>
      <path d="M0 5 Q10 0 20 5" stroke="rgba(0,0,0,0.15)" fill="none" stroke-width="0.5"/>
    </pattern>
    <marker id="${arrowId}" markerWidth="8" markerHeight="8" refX="7" refY="2.5" orient="auto">
      <path d="M0,0 L0,5 L7,2.5 z" fill="#64748b"/>
    </marker>
    <marker id="${arrowGlowId}" markerWidth="8" markerHeight="8" refX="7" refY="2.5" orient="auto">
      <path d="M0,0 L0,5 L7,2.5 z" fill="rgba(245,158,11,0.9)"/>
    </marker>
    <linearGradient id="cabGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="100%" stop-color="#e2e8f0"/>
    </linearGradient>
  </defs>

  <line x1="-70" y1="${groundY}" x2="${bedEndX + 100}" y2="${groundY}" stroke="#475569" stroke-width="2" stroke-dasharray="8,8"/>
  <ellipse cx="${totalW / 2}" cy="${groundY + 6}" rx="${totalW * 0.45}" ry="5" fill="rgba(0,0,0,0.15)"/>
  <rect x="${cabStartX}" y="${frameBodyY}" width="${totalW - cabStartX}" height="8" fill="#1e293b" stroke="#0f172a"/>
  <rect x="${bedStartX}" y="${bedFloorY - 4}" width="${bedW}" height="6" fill="#2d3748"/>
  <rect x="${bedStartX}" y="${bedTopY}" width="${bedW}" height="${sideGateH}" fill="#f8fafc" stroke="#cbd5e1" stroke-width="1"/>
  <line x1="${bedStartX}" y1="${bedTopY + sideGateH * 0.38}" x2="${bedEndX}" y2="${bedTopY + sideGateH * 0.38}" stroke="#e2e8f0" stroke-width="0.8"/>
  <line x1="${bedStartX}" y1="${bedTopY + sideGateH * 0.68}" x2="${bedEndX}" y2="${bedTopY + sideGateH * 0.68}" stroke="#e2e8f0" stroke-width="0.8"/>
  ${Array.from({ length: Math.max(3, Math.floor(bedW / 40)) }, (_, i) => {
    const px = bedStartX + bedW * (i + 1) / (Math.max(3, Math.floor(bedW / 40)) + 1);
    return `<line x1="${px.toFixed(1)}" y1="${bedTopY}" x2="${px.toFixed(1)}" y2="${bedFloorY}" stroke="#e2e8f0" stroke-width="0.9"/>`;
  }).join('')}
  <rect x="${bedEndX - 5}" y="${bedTopY}" width="5" height="${bedFloorY - bedTopY}" fill="#e2e8f0" stroke="#cbd5e1" stroke-width="0.8"/>
  <rect x="${bedEndX}" y="${bedTopY + 3}" width="5" height="10" rx="1.5" fill="#ef4444" opacity="0.95"/>
  <rect x="${bedEndX}" y="${bedTopY + 15}" width="5" height="6" rx="1" fill="#f97316" opacity="0.8"/>
  <rect x="${bedStartX + 4}" y="${bedFloorY - 5}" width="${bedW - 8}" height="3" rx="1" fill="#fbbf24" opacity="0.5"/>
  <rect x="${bedStartX - 4}" y="${toriiTopY}" width="7" height="${bedFloorY - toriiTopY}" fill="#64748b" stroke="#475569" stroke-width="0.8"/>
  <rect x="${bedStartX - 14}" y="${toriiTopY}" width="25" height="7" fill="#334155" stroke="#475569" stroke-width="0.8" rx="1"/>
  ${unic}
  <path d="${cabPath}" fill="url(#cabGrad)" stroke="#94a3b8" stroke-width="1.2"/>
  <path d="${winPath}" fill="rgba(186,230,253,0.32)" stroke="rgba(125,211,252,0.55)" stroke-width="0.8"/>
  <path d="M${(cabStartX + 12).toFixed(1)},${(bedFloorY - 52).toFixed(1)} L${(cabStartX + 12).toFixed(1)},${(bedFloorY - 75).toFixed(1)} L${(fsTop + 10).toFixed(1)},${(cabRoofY + 12).toFixed(1)} L${(fsTop + 4).toFixed(1)},${(cabRoofY + 10).toFixed(1)} Z" fill="rgba(255,255,255,0.12)"/>
  <line x1="${(cabStartX + realCabW * 0.45).toFixed(1)}" y1="${(cabRoofY + 5).toFixed(1)}" x2="${(cabStartX + realCabW * 0.45).toFixed(1)}" y2="${bedFloorY}" stroke="rgba(148,163,184,0.5)" stroke-width="1"/>
  <rect x="${(cabStartX + realCabW * 0.38).toFixed(1)}" y="${(bedFloorY - 68).toFixed(1)}" width="14" height="4" rx="2" fill="#94a3b8" stroke="#64748b" stroke-width="0.8"/>
  <rect x="${(cabStartX - 20).toFixed(1)}" y="${(cabRoofY + 18).toFixed(1)}" width="16" height="11" rx="2" fill="#e2e8f0" stroke="#94a3b8" stroke-width="1"/>
  <line x1="${cabStartX}" y1="${(cabRoofY + 26).toFixed(1)}" x2="${(cabStartX - 4).toFixed(1)}" y2="${(cabRoofY + 23).toFixed(1)}" stroke="#94a3b8" stroke-width="1.5" stroke-linecap="round"/>
  <rect x="${cabStartX - 10}" y="${bedFloorY - 65}" width="9" height="22" rx="2" fill="#fef3c7" stroke="#eab308" stroke-width="0.8"/>
  <rect x="${cabStartX - 9}" y="${bedFloorY - 64}" width="7" height="10" rx="1" fill="rgba(255,255,255,0.45)"/>
  <rect x="${(cabStartX - 4).toFixed(1)}" y="${(bedFloorY - 32).toFixed(1)}" width="8" height="12" rx="1.5" fill="#fbbf24" stroke="#f59e0b" stroke-width="0.8"/>
  <circle cx="${(cabStartX + 8).toFixed(1)}" cy="${(cabRoofY + 4).toFixed(1)}" r="3.5" fill="#fbbf24" opacity="0.85"/>
  <rect x="${cabStartX}" y="${(bedFloorY - 40).toFixed(1)}" width="22" height="7" rx="1" fill="#e2e8f0" stroke="#94a3b8" stroke-width="0.8"/>
  <rect x="${cabStartX}" y="${(bedFloorY - 26).toFixed(1)}" width="22" height="7" rx="1" fill="#e2e8f0" stroke="#94a3b8" stroke-width="0.8"/>
  ${tire(frontWheelX, false)}
  ${tire(rearWheelX, true)}
  ${vehicle.trailer ? tire(rearWheelX - 55, true) : ''}
  <line x1="0" y1="${dimY}" x2="${bedEndX}" y2="${dimY}" stroke="#64748b" marker-start="url(#${arrowId})" marker-end="url(#${arrowId})"/>
  <text x="${totalW / 2}" y="${dimY + 14}" text-anchor="middle" font-size="11" fill="#64748b">L=${vehicle.len}</text>
  <line x1="${bedStartX}" y1="${bedDimY}" x2="${bedEndX}" y2="${bedDimY}" stroke="rgba(245,158,11,0.9)" marker-start="url(#${arrowGlowId})" marker-end="url(#${arrowGlowId})"/>
  <text x="${bedStartX + bedW * 0.5}" y="${bedDimY - 5}" text-anchor="middle" font-size="10" fill="rgba(245,158,11,1)">BED ${vehicle.bed}</text>
  <g id="${cargoGroupId}"></g>
</svg>`.trim();

  const svg = tpl.content.firstElementChild;
  return { svg, scale, toriiX: bedStartX, bedEnd: bedEndX, bedFloor: bedFloorY, bedTop: toriiTopY, woodPatternId: woodId, cargoGroupId };
}

function ensureVehicleSvgs() {
  if (Object.keys(svgRefs).length) return;
  const deck = byId('truckSvgDeck');
  if (!deck) return;
  Object.entries(VEHICLES).forEach(([key, vehicle]) => {
    const ref = createVehicleSvg(key, vehicle);
    deck.appendChild(ref.svg);
    ref.cargoGroup = ref.svg.querySelector('#' + ref.cargoGroupId);
    svgRefs[key] = ref;
  });
}

function showActiveSvg(key) {
  Object.entries(svgRefs).forEach(([currentKey, ref]) => {
    ref.svg.classList.toggle('active', currentKey === key);
  });
}

function mkRect(parent, x, y, w, h, patternId) {
  const rect = document.createElementNS(NS, 'rect');
  rect.setAttribute('x', x);
  rect.setAttribute('y', y);
  rect.setAttribute('width', w);
  rect.setAttribute('height', h);
  rect.setAttribute('class', 'thud-lumber');
  rect.setAttribute('fill', 'url(#' + patternId + ')');
  parent.appendChild(rect);
}

function mkRotRect(parent, x, y, w, h, deg, patternId) {
  const rect = document.createElementNS(NS, 'rect');
  rect.setAttribute('x', x - w);
  rect.setAttribute('y', y - h);
  rect.setAttribute('width', w);
  rect.setAttribute('height', h);
  rect.setAttribute('class', 'thud-lumber');
  rect.setAttribute('fill', 'url(#' + patternId + ')');
  rect.setAttribute('transform', `rotate(${deg},${x},${y})`);
  parent.appendChild(rect);
}

function renderHud() {
  ensureVehicleSvgs();
  const vehicle = VEHICLES[hudState.vehKey];
  const ref = svgRefs[hudState.vehKey];
  if (!vehicle || !ref || !ref.cargoGroup) return;

  showActiveSvg(hudState.vehKey);

  if (byId('thudValVl')) byId('thudValVl').textContent = vehicle.len.toLocaleString();
  if (byId('thudValBl')) byId('thudValBl').textContent = vehicle.bed.toLocaleString();

  const cargoGroup = ref.cargoGroup;
  cargoGroup.innerHTML = '';

  const overhangEl = byId('thudStatOh');
  const legalEl = byId('thudStatLegal');
  if (overhangEl) overhangEl.className = 'thud-stat';
  if (legalEl) legalEl.className = 'thud-stat';

  let overhang = 0;
  const limitLen = vehicle.len * 1.2;
  if (byId('thudValLimit')) byId('thudValLimit').textContent = Math.floor(limitLen).toLocaleString();

  const toriiX = ref.toriiX;
  const bedEnd = ref.bedEnd;
  const bedFloor = ref.bedFloor;
  const bedTop = ref.bedTop;
  const scale = ref.scale;

  if (hudState.mode !== 'none') {
    let lumberMm = hudState.lumberLen;
    if (hudState.mode === 'max') {
      lumberMm = limitLen;
      if (byId('hudLumberLen')) byId('hudLumberLen').value = lumberMm / 1000;
      if (byId('hudLumberLenVal')) byId('hudLumberLenVal').textContent = (lumberMm / 1000).toFixed(1);
    }

    const lumberPx = lumberMm * scale;
    const lumberH = 11;

    if (hudState.mode === 'flat' || hudState.mode === 'max') {
      const startX = hudState.mode === 'max' ? toriiX - 25 : toriiX + 15;
      const endX = startX + lumberPx;
      overhang = Math.max(0, (endX - bedEnd) / scale);
      for (let i = 0; i < hudState.count; i += 1) {
        mkRect(cargoGroup, startX, bedFloor - 4 - 8 - i * (lumberH + 2), lumberPx, lumberH, ref.woodPatternId);
      }
    } else if (hudState.mode === 'diagonal') {
      const sx = bedEnd - 50;
      const sy = bedFloor - 12;
      const ty = bedTop + 5;
      const tx = toriiX;
      const angleRad = Math.atan2(sy - ty, sx - tx);
      const angleDeg = angleRad * 180 / Math.PI;

      for (let i = 0; i < hudState.count; i += 1) {
        mkRotRect(cargoGroup, sx, sy - i * 6, lumberPx, lumberH, angleDeg, ref.woodPatternId);
      }

      const tipX = sx - Math.cos(angleRad) * lumberPx;
      if (tipX < 0) overhang = -tipX / scale;

      const rope = document.createElementNS(NS, 'line');
      rope.setAttribute('x1', tx);
      rope.setAttribute('y1', sy);
      rope.setAttribute('x2', tx);
      rope.setAttribute('y2', ty - 10);
      rope.setAttribute('stroke', 'rgba(251,191,36,0.6)');
      rope.setAttribute('stroke-width', '1');
      cargoGroup.appendChild(rope);
    }
  }

  if (byId('thudValOh')) byId('thudValOh').textContent = Math.floor(overhang).toLocaleString();
  const currentTotal = vehicle.len + (hudState.mode !== 'none' ? overhang : 0);
  if (currentTotal > limitLen) {
    overhangEl?.classList.add('danger');
    legalEl?.classList.add('danger');
  } else if (overhang > 0) {
    overhangEl?.classList.add('warning');
  }
}

function syncWithVehiclePreset(shortKey) {
  const mapped = HUD_PRESET_BY_SHORT[String(shortKey || '').trim()];
  if (!mapped || !VEHICLES[mapped]) return;
  const select = byId('hudVehicleSelect');
  if (select && select.value !== mapped) select.value = mapped;
  hudState.vehKey = mapped;
  renderHud();
}

export function initTruckHud() {
  if (initialized) return;
  initialized = true;

  byId('truckHudToggle')?.addEventListener('click', () => {
    byId('truckHud')?.classList.toggle('collapsed');
  });

  byId('hudVehicleSelect')?.addEventListener('change', (event) => {
    hudState.vehKey = event.target.value;
    renderHud();
  });

  document.querySelectorAll('input[name="cargoMode"]').forEach((radio) => {
    radio.addEventListener('change', (event) => {
      hudState.mode = event.target.value;
      renderHud();
    });
  });

  document.querySelectorAll('input[name="cargoCount"]').forEach((radio) => {
    radio.addEventListener('change', (event) => {
      hudState.count = parseInt(event.target.value, 10);
      renderHud();
    });
  });

  byId('hudLumberLen')?.addEventListener('input', (event) => {
    hudState.lumberLen = parseFloat(event.target.value) * 1000;
    if (byId('hudLumberLenVal')) byId('hudLumberLenVal').textContent = event.target.value;
    renderHud();
  });

  byId('vehiclePreset')?.addEventListener('change', (event) => {
    syncWithVehiclePreset(event.target?.value);
  });

  syncWithVehiclePreset(byId('vehiclePreset')?.value || '4t');
  renderHud();
}
