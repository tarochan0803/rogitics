import { RUNTIME_CONFIG } from '../config.js';
import { getMapInstance } from './map2d.js';

let lastResult = null;

function byId(id) {
  return document.getElementById(id);
}

function setText(id, text) {
  const el = byId(id);
  if (el) el.textContent = text;
}

function setHTML(id, html) {
  const el = byId(id);
  if (el) el.innerHTML = html;
}

function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function setBadgeStatus(el, status) {
  if (!el) return;
  el.classList.remove('ok', 'warn', 'ng');
  if (status === 'PASS') el.classList.add('ok');
  else if (status === 'CONDITIONAL') el.classList.add('warn');
  else if (status === 'NG') el.classList.add('ng');
  el.textContent = status || 'N/A';
}

function formatPercent(value) {
  if (!Number.isFinite(value)) return '-';
  return `${(value * 100).toFixed(1)}%`;
}

function formatDistance(meters) {
  if (!Number.isFinite(meters)) return '-';
  if (meters >= 1000) return `${(meters / 1000).toFixed(2)} km`;
  return `${Math.round(meters)} m`;
}

function formatNumber(value, digits = 1) {
  if (!Number.isFinite(value)) return '-';
  return Number(value).toFixed(digits);
}

function summarizeRouteAdjustment(adj = {}) {
  if (!adj?.applied) return '補正なし';
  const tried = Number(adj.triedAlternatives || 0);
  const lastAdjustment = Array.isArray(adj.adjustments) && adj.adjustments.length
    ? adj.adjustments[adj.adjustments.length - 1]
    : null;
  const remaining = Number(lastAdjustment?.remainingContactCount);
  const remainingText = Number.isFinite(remaining) ? ` / 残接触 ${remaining} 点` : '';
  const triedText = tried > 0 ? ` / ${tried} 案試行` : '';
  const reasonText = adj.reason ? ` / ${esc(adj.reason)}` : '';
  return `${adj.ok ? '迂回補正で解消' : '迂回補正したが未解消'} / ${formatNumber(Number(adj.iterations), 0)} 回${triedText}${remainingText}${reasonText}`;
}

function summarizeKinematics(kinematics = null) {
  if (!kinematics) return '未評価';
  const m = kinematics.metrics || {};
  const parts = [
    `状態 ${kinematics.status || '-'}`,
    `最小R ${formatNumber(Number(m.minTurnRadiusObserved), 2)}m / 必要R ${formatNumber(Number(m.requiredTurnRadius), 2)}m`,
    `推奨最低速度 ${formatNumber(Number(m.minRecommendedSpeed), 2)}m/s`,
    `最大横G相当 ${formatNumber(Number(m.maxLateralAccel), 2)}m/s²`,
    `最大減速 ${formatNumber(Number(m.maxRequiredDecel), 2)}m/s²`
  ];
  const warnCount = Array.isArray(kinematics.warnings) ? kinematics.warnings.length : 0;
  const vioCount = Array.isArray(kinematics.violations) ? kinematics.violations.length : 0;
  if (vioCount > 0) parts.push(`運動学NG ${vioCount}件`);
  else if (warnCount > 0) parts.push(`速度調整警告 ${warnCount}件`);
  return esc(parts.join(' / '));
}

function regulationStatusLabel(status) {
  switch (status) {
    case 'pass': return 'OK';
    case 'warning': return '注意';
    case 'permit_required': return '要許可';
    case 'blocked': return '不可';
    case 'unknown': return '要確認';
    default: return '未評価';
  }
}

function regulationTypeLabel(type) {
  switch (type) {
    case 'oneway': return '一方通行';
    case 'access': return '通行権限';
    case 'no_truck': return '貨物車規制';
    case 'max_height': return '高さ制限';
    case 'max_width': return '幅制限';
    case 'max_weight': return '重量制限';
    case 'time_restriction': return '時間帯規制';
    case 'private_road': return '私道';
    case 'designated_road': return '指定道路';
    case 'ledger_width': return '道路台帳幅員';
    default: return type || '規制';
  }
}

function summarizeRegulationAssessment(assessment = null) {
  if (!assessment) return '未評価';
  const s = assessment.summary || {};
  const parts = [
    `状態 ${regulationStatusLabel(assessment.status)}`,
    `規制候補 ${formatNumber(Number(assessment.regulationsChecked), 0)} 件`,
    `経路該当 ${formatNumber(Number(assessment.matchedRegulationCount), 0)} 件`
  ];
  if (s.blockCount) parts.push(`不可 ${s.blockCount} 件`);
  if (s.permitRequiredCount) parts.push(`要許可 ${s.permitRequiredCount} 件`);
  if (s.warningCount) parts.push(`注意 ${s.warningCount} 件`);
  if (s.unknownCount) parts.push(`要確認 ${s.unknownCount} 件`);
  return esc(parts.join(' / '));
}

function buildRegulationSummaryHTML(assessment = null) {
  if (!assessment) return '';
  const issues = Array.isArray(assessment.issues) ? assessment.issues : [];
  const head = summarizeRegulationAssessment(assessment);
  if (!issues.length) return `<span style="color:#86efac;">${head}</span>`;
  const rows = issues.slice(0, 4).map((issue) => {
    const color = issue.severity === 'block' ? '#ef4444'
      : issue.severity === 'permit_required' ? '#fb923c'
        : '#facc15';
    const source = issue.source ? ` / ${esc(issue.source)}` : '';
    return `<div style="display:flex;justify-content:space-between;gap:10px;border-top:1px solid rgba(148,163,184,0.10);padding-top:4px;margin-top:4px;">
      <span style="color:${color};font-weight:700;">${esc(regulationTypeLabel(issue.type))}</span>
      <span style="text-align:right;color:#cbd5e1;">${esc(issue.reasonCode || issue.message || issue.severity)}${source}</span>
    </div>`;
  }).join('');
  const more = issues.length > 4
    ? `<div style="margin-top:4px;color:#94a3b8;">他 ${issues.length - 4} 件</div>`
    : '';
  return `<div>${head}${rows}${more}</div>`;
}

function summarizeVoxelCollision(voxel = null) {
  if (!voxel) return '未評価';
  const backend = voxel.backend || '-';
  const runtime = voxel.remote ? `remote ${voxel.remoteUrl || ''}`.trim() : 'local fallback';
  const gpu = voxel.gpu?.cuda ? `CUDA ${voxel.gpu?.device || ''}`.trim() : (voxel.webgpuAvailable ? 'browser WebGPU available' : 'CPU');
  const contacts = `${formatNumber(Number(voxel.contactCount), 0)} / ${formatNumber(Number(voxel.totalSamples), 0)}`;
  return esc(`status ${voxel.status || '-'} / ${runtime} / ${backend} / ${gpu} / contacts ${contacts}`);
}

function updateScore(score) {
  const scoreEl = byId('deliveryScoreValue');
  if (scoreEl) scoreEl.textContent = Number.isFinite(score) ? Math.round(score) : '-';
  const ring = byId('deliveryScoreRing');
  if (ring && Number.isFinite(score)) {
    ring.style.setProperty('--score', Math.max(0, Math.min(100, score)));
  }
}

function getStatusLabel(status) {
  const map = {
    PASS: '通行可',
    CONDITIONAL: '要確認',
    NG: '通行不可'
  };
  return map[status] || status || 'N/A';
}

function getActionHint(result) {
  if (result?.finalStatus === 'permit_required') return '物理条件は通過可能でも、通行許可や関係者確認が必要です。';
  if (result?.regulationStatus === 'blocked') return '物理条件とは別に、道路規制により通行不可の可能性があります。';
  if (result?.regulationStatus === 'warning') return '道路規制に注意事項があります。標識・時間帯・許可条件を確認してください。';
  if (result?.overallStatus === 'PASS') return 'このまま搬入判定を進められます。';
  if (result?.overallStatus === 'CONDITIONAL') return '現地確認か条件調整を行ってください。';
  return '経路または車両条件の見直しが必要です。';
}

// UI-B: 判定結果に応じた「次にすべきこと」アクション一覧。
// 戻り値の配列を rp-next-actions HTML に整形して結果パネルに表示する。
function getNextActions(result) {
  const status = result?.overallStatus;
  const violations = Array.isArray(result?.violations) ? result.violations : [];
  const hasRoadExcursion = violations.some((v) => v?.type === 'road_excursion' || v?.type === 'width');
  const hasOverhang = violations.some((v) => v?.type === 'overhang' || v?.type === 'building_contact');
  const hasTurning = violations.some((v) => v?.type === 'turning_radius');
  const hasRegulation = violations.some((v) => v?.type === 'regulation') || result?.regulationStatus === 'blocked' || result?.regulationStatus === 'permit_required';

  if (status === 'PASS') {
    return [
      { id: 'print', label: '📄 レポート出力', primary: true },
      { id: 'save', label: '結果保存 (JSON)', primary: false }
    ];
  }
  const actions = [];
  if (hasRoadExcursion || hasTurning) {
    actions.push({ id: 'smaller-vehicle', label: '小さい車両で再判定', primary: true });
  }
  if (hasOverhang) {
    actions.push({ id: 'check-overhead', label: '頭上クリアランス確認', primary: !actions.length });
  }
  if (hasRegulation) {
    actions.push({ id: 'review-regulation', label: '規制・許可条件を確認', primary: !actions.length });
  }
  actions.push({ id: 'review-route', label: '経路を引き直す', primary: !actions.length });
  if (status === 'CONDITIONAL') {
    actions.push({ id: 'print', label: '📄 条件付きレポート', primary: false });
  }
  return actions;
}

function buildNextActionsHTML(actions) {
  if (!Array.isArray(actions) || !actions.length) return '';
  const buttons = actions.map((a) => {
    const cls = a.primary ? 'next-btn primary' : 'next-btn';
    return `<button type="button" class="${cls}" data-action="${esc(a.id)}">${esc(a.label)}</button>`;
  }).join('');
  return `<div class="rp-next-actions" role="group" aria-label="次のアクション">${buttons}</div>`;
}

// UI-F: 違反バッジ「地図で見る」クリックを地図フォーカスに繋ぐ
function wireViolationFocus(container) {
  if (!container) return;
  container.querySelectorAll('.vio-focus').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      const lat = Number(btn.getAttribute('data-vio-lat'));
      const lng = Number(btn.getAttribute('data-vio-lng'));
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
      try {
        const map = getMapInstance() || window._leafletMap;
        if (map && typeof map.setView === 'function') {
          const targetZoom = Math.max(typeof map.getZoom === 'function' ? map.getZoom() : 17, 18);
          map.setView([lat, lng], targetZoom, { animate: true });
        }
      } catch (e) {
        console.warn('[violationFocus] map focus failed:', e?.message || e);
      }
    });
  });
}

// UI-B: 次アクションボタンをホストUI（controls.js）が解釈できるカスタムイベントで通知
function wireNextActions(container) {
  if (!container) return;
  container.querySelectorAll('.rp-next-actions [data-action]').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      const action = btn.getAttribute('data-action');
      // 既存の save/print ボタンと統一して同じハンドラに流す
      if (action === 'save') {
        document.getElementById('saveDeliveryResult')?.click();
        return;
      }
      if (action === 'print') {
        document.getElementById('printDeliveryReport')?.click();
        return;
      }
      // それ以外は CustomEvent で発火し、controls.js で受ける
      document.dispatchEvent(new CustomEvent('delivery-next-action', { detail: { action, result: lastResult } }));
    });
  });
}

// P1-4 / UI-A: 構造化 violation の表示メタデータ
// type ごとに重要度・色・短いラベル・症状文を返す。
function getViolationMeta(type) {
  switch (type) {
    case 'road_excursion':
      return { severity: 'critical', color: '#ef4444', light: 'rgba(239,68,68,0.16)', label: '道路外', mark: '!' };
    case 'building_contact':
      return { severity: 'critical', color: '#dc2626', light: 'rgba(220,38,38,0.16)', label: '建物接触', mark: 'X' };
    case 'overhang':
      return { severity: 'critical', color: '#f59e0b', light: 'rgba(245,158,11,0.18)', label: '頭上', mark: '↑' };
    case 'coverage':
      return { severity: 'warn', color: '#f59e0b', light: 'rgba(245,158,11,0.18)', label: 'カバー率', mark: '%' };
    case 'width':
      return { severity: 'critical', color: '#ef4444', light: 'rgba(239,68,68,0.16)', label: '幅員', mark: '|' };
    case 'turning_radius':
      return { severity: 'warn', color: '#f59e0b', light: 'rgba(245,158,11,0.18)', label: '旋回', mark: '↺' };
    case 'sharp_curve':
      return { severity: 'warn', color: '#fbbf24', light: 'rgba(251,191,36,0.20)', label: '急旋回', mark: '⟲' };
    case 'regulation':
      return { severity: 'warn', color: '#fb923c', light: 'rgba(251,146,60,0.18)', label: '規制', mark: '!' };
    default:
      return { severity: 'warn', color: '#94a3b8', light: 'rgba(148,163,184,0.18)', label: 'その他', mark: '?' };
  }
}

function formatViolation(v) {
  if (!v || typeof v !== 'object') return '';
  switch (v.type) {
    case 'road_excursion': {
      const pct = Number.isFinite(v.outsideRatio) ? (v.outsideRatio * 100).toFixed(1) : '?';
      const tol = Number.isFinite(v.tolerance) ? (v.tolerance * 100).toFixed(1) : '5.0';
      return `フットプリント ${pct}% が道路外 (許容 ${tol}%)`;
    }
    case 'coverage': {
      const ac = Number.isFinite(v.actual) ? (v.actual * 100).toFixed(1) : '?';
      const rq = Number.isFinite(v.required) ? (v.required * 100).toFixed(1) : '?';
      return `スイープが道路を ${ac}% しかカバーできず（基準 ${rq}%）`;
    }
    case 'overhang': {
      const obH = Number.isFinite(v.actual) ? `${v.actual}m` : '?';
      const need = Number.isFinite(v.required) ? `${v.required}m` : '?';
      return `障害物高 ${obH} が車両天端＋クリアランス ${need} より低い`;
    }
    case 'building_contact': {
      return `フットプリントが建物・障害物と交差`;
    }
    case 'width': {
      const def = Number.isFinite(v.deficit) ? `${v.deficit.toFixed(2)}m` : '?';
      return `必要幅員に対して ${def} 不足`;
    }
    case 'turning_radius': {
      return `旋回半径が車両の最小回転半径を下回る`;
    }
    case 'sharp_curve': {
      const r = Number.isFinite(v.actual) ? `R=${v.actual}m` : 'R=?';
      const vr = Number.isFinite(v.vehicleMinR) ? `車両最小R ${v.vehicleMinR}m` : '';
      const def = Number.isFinite(v.deficit) && v.deficit > 0 ? ` / 物理的に${v.deficit}m不足` : '';
      return `急旋回 ${r}${vr ? `（${vr}）` : ''}${def}`;
    }
    case 'regulation': {
      const kind = regulationTypeLabel(v.regulationType);
      const src = v.source ? ` / ${v.source}` : '';
      const raw = v.rawValue ? ` / ${v.rawValue}` : '';
      const msg = v.message || v.reasonCode || '規制条件に該当';
      return `${kind}: ${msg}${raw}${src}`;
    }
    default:
      return esc(v.type || '違反');
  }
}

function buildViolationsHTML(violations) {
  if (!Array.isArray(violations) || !violations.length) return '';
  const MAX = 5;
  const items = violations.slice(0, MAX).map((v, idx) => {
    const text = formatViolation(v);
    if (!text) return '';
    const baseMeta = getViolationMeta(v?.type);
    const meta = v?.type === 'regulation' && v?.severity === 'block'
      ? { ...baseMeta, severity: 'critical', color: '#ef4444', light: 'rgba(239,68,68,0.16)' }
      : v?.type === 'regulation' && v?.severity === 'permit_required'
        ? { ...baseMeta, severity: 'warn', color: '#fb923c', light: 'rgba(251,146,60,0.18)' }
        : baseMeta;
    const at = Number.isFinite(v?.atKm) ? `${Number(v.atKm).toFixed(2)} km地点` : '位置不明';
    const lat = Number(v?.latLng?.lat);
    const lng = Number(v?.latLng?.lng);
    const hasPos = Number.isFinite(lat) && Number.isFinite(lng);
    const dataAttr = hasPos ? ` data-vio-lat="${lat}" data-vio-lng="${lng}"` : '';
    const focusBtn = hasPos
      ? `<button class="vio-focus" type="button" aria-label="この違反位置に地図をフォーカス"${dataAttr}>地図で見る</button>`
      : '';
    return `<li class="vio-row" data-severity="${meta.severity}" style="border-left:3px solid ${meta.color};background:${meta.light};">
      <div class="vio-icon" aria-hidden="true" style="background:${meta.color};">${esc(meta.mark)}</div>
      <div class="vio-body">
        <div class="vio-head">
          <span class="vio-label" style="color:${meta.color};">${esc(meta.label)}</span>
          <span class="vio-at">${esc(at)}</span>
        </div>
        <div class="vio-text">${esc(text)}</div>
      </div>
      ${focusBtn}
    </li>`;
  }).join('');
  const more = violations.length > MAX
    ? `<li class="vio-more">他 ${violations.length - MAX} 件</li>`
    : '';
  return `<ul class="vio-list" role="list">${items}${more}</ul>`;
}

function detailItem(label, body) {
  return `
    <div class="detail-item" style="padding:10px 12px;border:1px solid rgba(148,163,184,0.12);border-radius:12px;background:rgba(15,23,42,0.42);">
      <div style="font-size:10px;font-weight:700;letter-spacing:0.06em;color:#94a3b8;text-transform:uppercase;">${esc(label)}</div>
      <div style="margin-top:4px;font-size:12px;line-height:1.6;color:#e2e8f0;">${body}</div>
    </div>
  `;
}

function getRoutePoints(result) {
  if (Array.isArray(result?.route) && result.route.length >= 2) {
    return result.route
      .map((point) => ({ lat: Number(point?.lat), lng: Number(point?.lng) }))
      .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng));
  }
  const route = window.store?.getState?.()?.simRoute;
  if (Array.isArray(route) && route.length >= 2) {
    return route
      .map((point) => ({ lat: Number(point?.lat), lng: Number(point?.lng) }))
      .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng));
  }
  return [];
}

function getContactPoints(result) {
  const fc = result?.collisionReport?.contactPoints || result?.contactFeasibility?.contactPoints;
  const features = Array.isArray(fc?.features) ? fc.features : [];
  return features
    .map((feature) => ({
      lng: Number(feature?.geometry?.coordinates?.[0]),
      lat: Number(feature?.geometry?.coordinates?.[1])
    }))
    .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng));
}

function projectRoute(points, width = 760, height = 250, padding = 18) {
  if (!Array.isArray(points) || points.length < 2) return null;

  let minLng = points[0].lng;
  let maxLng = points[0].lng;
  let minLat = points[0].lat;
  let maxLat = points[0].lat;

  points.forEach((point) => {
    minLng = Math.min(minLng, point.lng);
    maxLng = Math.max(maxLng, point.lng);
    minLat = Math.min(minLat, point.lat);
    maxLat = Math.max(maxLat, point.lat);
  });

  const spanLng = Math.max(maxLng - minLng, 1e-6);
  const spanLat = Math.max(maxLat - minLat, 1e-6);
  const scale = Math.min((width - padding * 2) / spanLng, (height - padding * 2) / spanLat);
  const usedWidth = spanLng * scale;
  const usedHeight = spanLat * scale;
  const offsetX = (width - usedWidth) / 2;
  const offsetY = (height - usedHeight) / 2;

  const project = (point) => ({
    x: offsetX + (point.lng - minLng) * scale,
    y: offsetY + (maxLat - point.lat) * scale
  });

  return {
    width,
    height,
    route: points.map(project),
    project
  };
}

function buildRouteSnapshotMarkup(result) {
  const routePoints = getRoutePoints(result);
  if (routePoints.length < 2) {
    return '<div class="route-empty">軌跡データはありません。</div>';
  }

  const W = 760;
  const H = 310;
  const LEGEND_H = 38;
  const projected = projectRoute(routePoints, W, H - LEGEND_H, 28);
  if (!projected) {
    return '<div class="route-empty">軌跡データはありません。</div>';
  }

  const contactPoints = getContactPoints(result).map(projected.project);
  const pts = projected.route;
  const polyline = pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const start = pts[0];
  const end = pts[pts.length - 1];

  // Direction chevrons every ~10% of route length
  const step = Math.max(2, Math.floor(pts.length / 10));
  const arrows = [];
  for (let i = step; i < pts.length - 1; i += step) {
    const a = pts[i - 1];
    const b = pts[i];
    const angle = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
    const mx = ((a.x + b.x) / 2).toFixed(1);
    const my = ((a.y + b.y) / 2).toFixed(1);
    arrows.push(
      `<polygon points="-8,-4.5 8,0 -8,4.5" fill="#22d3ee" fill-opacity="0.75" transform="translate(${mx},${my}) rotate(${angle.toFixed(1)})" />`
    );
  }

  // Contact point warning triangles with sequence numbers
  const contactMarkers = contactPoints
    .map((p, i) => {
      const cx = p.x.toFixed(1);
      const cy = p.y.toFixed(1);
      const label = i + 1;
      return `<g transform="translate(${cx},${cy})">
        <polygon points="0,-12 11,7 -11,7" fill="#fb7185" fill-opacity="0.95" stroke="#fff" stroke-width="1.5"/>
        <text x="0" y="6" text-anchor="middle" fill="#fff" font-size="8" font-weight="800">${label}</text>
      </g>`;
    })
    .join('');

  // Start pin (S in green circle)
  const sx = start.x.toFixed(1);
  const sy = start.y.toFixed(1);
  const startPin = `<g transform="translate(${sx},${sy})">
    <circle r="13" fill="#16a34a" stroke="#dcfce7" stroke-width="2.5"/>
    <text x="0" y="5" text-anchor="middle" fill="#fff" font-size="12" font-weight="900">S</text>
  </g>`;

  // Goal pin (G in amber circle)
  const gx = end.x.toFixed(1);
  const gy = end.y.toFixed(1);
  const goalPin = `<g transform="translate(${gx},${gy})">
    <circle r="13" fill="#d97706" stroke="#fef3c7" stroke-width="2.5"/>
    <text x="0" y="5" text-anchor="middle" fill="#fff" font-size="12" font-weight="900">G</text>
  </g>`;

  // Legend strip at the bottom
  const ly = H - LEGEND_H + 10;
  const hasContact = contactPoints.length > 0;
  const legend = `<g>
    <rect x="0" y="${H - LEGEND_H}" width="${W}" height="${LEGEND_H}" rx="0" fill="rgba(15,23,42,0.85)"/>
    <line x1="0" y1="${H - LEGEND_H}" x2="${W}" y2="${H - LEGEND_H}" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>
    <circle cx="28" cy="${ly + 9}" r="9" fill="#16a34a" stroke="#dcfce7" stroke-width="1.5"/>
    <text x="37" y="${ly + 13}" fill="#bbf7d0" font-size="12" font-weight="700">出発 (S)</text>
    <circle cx="130" cy="${ly + 9}" r="9" fill="#d97706" stroke="#fef3c7" stroke-width="1.5"/>
    <text x="139" y="${ly + 13}" fill="#fde68a" font-size="12" font-weight="700">目的地 (G)</text>
    <line x1="238" y1="${ly + 4}" x2="264" y2="${ly + 4}" stroke="#22d3ee" stroke-width="4" stroke-linecap="round"/>
    <polygon points="0,-4 8,0 0,4" fill="#22d3ee" fill-opacity="0.8" transform="translate(256,${ly + 4})"/>
    <text x="272" y="${ly + 8}" fill="#a5f3fc" font-size="12" font-weight="700">経路・進行方向</text>
    ${hasContact
      ? `<polygon points="0,-9 10,6 -10,6" fill="#fb7185" transform="translate(412,${ly + 10})"/>
         <text x="424" y="${ly + 13}" fill="#fecdd3" font-size="12" font-weight="700">接触候補 ${contactPoints.length}件</text>`
      : `<text x="400" y="${ly + 13}" fill="#4ade80" font-size="12" font-weight="700">✓ 接触候補なし</text>`
    }
  </g>`;

  return `
    <div class="route-card">
      <svg class="route-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="搬入軌跡">
        <defs>
          <linearGradient id="routeLineGradient" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stop-color="#0ea5e9"/>
            <stop offset="100%" stop-color="#22d3ee"/>
          </linearGradient>
        </defs>
        <!-- background -->
        <rect x="0" y="0" width="${W}" height="${H}" rx="16" fill="#08101d"/>
        <!-- road band -->
        <polyline points="${polyline}" fill="none" stroke="#1e3a52" stroke-width="28" stroke-linecap="round" stroke-linejoin="round"/>
        <polyline points="${polyline}" fill="none" stroke="#0f2438" stroke-width="22" stroke-linecap="round" stroke-linejoin="round"/>
        <!-- road center dashes -->
        <polyline points="${polyline}" fill="none" stroke="rgba(148,163,184,0.18)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="10 8"/>
        <!-- route line -->
        <polyline points="${polyline}" fill="none" stroke="url(#routeLineGradient)" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
        <!-- direction arrows -->
        ${arrows.join('')}
        <!-- contact warning markers -->
        ${contactMarkers}
        <!-- start / goal pins -->
        ${startPin}
        ${goalPin}
        <!-- legend -->
        ${legend}
      </svg>
    </div>
  `;
}

// P2-5: setDeliveryProgress にサブステップ表示を追加
// sub: { current: number, total: number, label?: string, etaSec?: number }
// 表示例: "Street View 解析中... (15/24 残り約12秒)"
export function setDeliveryProgress({ step = 0, total = 1, label = '', active = true, sub = null } = {}) {
  const bar = byId('progressFill') || byId('deliveryProgressBar');
  const wrap = byId('deliveryProgress');
  const text = byId('progressText') || byId('deliveryProgressLabel');
  if (wrap) wrap.classList.toggle('active', !!active);
  if (text) {
    let displayText = label || '';
    if (sub && Number.isFinite(sub.current) && Number.isFinite(sub.total) && sub.total > 0) {
      const subLabel = sub.label ? ` ${sub.label}` : '';
      const eta = Number.isFinite(sub.etaSec) && sub.etaSec >= 1
        ? ` 残り約${Math.round(sub.etaSec)}秒`
        : '';
      displayText += ` (${sub.current}/${sub.total}${subLabel}${eta})`;
    }
    text.textContent = displayText;
  }
  if (bar) {
    // メインステップと サブステップで合成された進捗率を表示
    let ratio = total > 0 ? Math.max(0, Math.min(1, step / total)) : 0;
    if (sub && Number.isFinite(sub.current) && Number.isFinite(sub.total) && sub.total > 0 && total > 0) {
      const subRatio = Math.max(0, Math.min(1, sub.current / sub.total));
      // 現在のメインステップ枠内をサブ進捗で埋める
      ratio = Math.max(0, Math.min(1, (step + subRatio) / total));
    }
    bar.style.width = `${Math.round(ratio * 100)}%`;
  }
}

export function renderDeliveryResult(result) {
  lastResult = result || null;

  const chip = byId('resultChip');
  const panel = byId('resultPanel');
  const saveBtn = byId('saveDeliveryResult');
  const printBtn = byId('printDeliveryReport');

  if (!result) {
    if (chip) chip.style.display = 'none';
    if (panel) panel.style.display = 'none';
    setText('deliverySummary', '判定待ち');
    setHTML('deliveryDetails', '');
    if (saveBtn) saveBtn.disabled = true;
    if (printBtn) printBtn.disabled = true;
    updateScore(null);
    return;
  }

  const statusLabel = getStatusLabel(result.overallStatus);
  const coverage = result.feasibility?.coverage;
  const threshold = result.feasibility?.threshold;
  const contactCount = Number(result.collisionReport?.contactCount ?? result.contactFeasibility?.contactCount ?? 0);
  const totalSamples = Number(result.collisionReport?.totalSamples ?? result.contactFeasibility?.totalSamples ?? 0);
  const score = result.scoreBreakdown || {};
  const adj = result.routeAdjustment || {};
  const criteria = result.criteria || {};
  const reasons = Array.isArray(criteria.reasons) ? criteria.reasons : [];

  if (chip) {
    chip.style.display = 'flex';
    setText('chipScoreNum', Math.round(result.score || 0));
    setText('chipStatusText', statusLabel);
    setText('chipDetail', `${formatDistance(result.distanceMeters)} / Coverage ${formatPercent(coverage)}`);

    const chipBadge = byId('chipStatusBadge');
    if (chipBadge) {
      chipBadge.textContent = result.overallStatus || 'N/A';
      chipBadge.className = `chip-badge ${result.overallStatus || ''}`;
    }

    const ringFg = byId('chipRingFg');
    if (ringFg) {
      const circumference = 2 * Math.PI * 16;
      const chipScore = Number.isFinite(result.score) ? Math.max(0, Math.min(100, result.score)) : 0;
      const offset = circumference - (circumference * (chipScore / 100));
      ringFg.style.strokeDashoffset = offset;
    }
  }

  // 判定結果は既定では小チップのみ表示。大パネルはチップの展開ボタンで開く
  // （経路と重なって見にくいのを防ぐ）。中身は下で更新しておく。
  if (panel && panel.style.display !== 'flex') panel.style.display = 'none';

  setBadgeStatus(byId('deliveryStatusBadge'), result.overallStatus || '');
  updateScore(result.score);
  setText(
    'deliverySummary',
    `${statusLabel} / 距離 ${formatDistance(result.distanceMeters)} / スコア ${Number.isFinite(result.score) ? Math.round(result.score) : '-'}`
  );

  // ── 重要情報（常時表示）: 違反理由 / 次のアクション のみ ──────────────
  const violations = Array.isArray(result.violations) ? result.violations : [];
  const primaryCards = [];
  if (result.regulationAssessment) {
    primaryCards.push(detailItem('規制チェック', buildRegulationSummaryHTML(result.regulationAssessment)));
  }
  if (violations.length) {
    primaryCards.push(detailItem(`違反/注意理由 (${violations.length}件)`, buildViolationsHTML(violations)));
  } else if (result.overallStatus === 'PASS') {
    primaryCards.push(detailItem('判定根拠', `<span style="color:#86efac;">すべての判定項目で基準値を満たしています</span>`));
  }
  const nextActionsHtml = buildNextActionsHTML(getNextActions(result));
  if (nextActionsHtml) {
    primaryCards.push(detailItem('次のアクション', nextActionsHtml));
  }

  // ── 詳細情報（折りたたみ）: メトリクス類はデフォルト非表示にして情報量を抑える ──
  const detailInner = [
    detailItem('判定メモ', `${esc(getActionHint(result))}`),
    detailItem('カバー率', `実測 ${formatPercent(coverage)} / 基準 ${formatPercent(threshold)}`),
    detailItem('接触判定', `${formatNumber(contactCount, 0)} 点 / サンプル ${formatNumber(totalSamples, 0)}`),
    detailItem('規制チェック', buildRegulationSummaryHTML(result.regulationAssessment)),
    detailItem('3D voxel', summarizeVoxelCollision(result.voxelCollision)),
    detailItem('運動学チェック', summarizeKinematics(result.kinematics)),
    detailItem(
      'スコア内訳',
      `coverage ${formatNumber(score.coverageScore)} / collision ${formatNumber(score.collisionScore)} / route penalty ${formatNumber(score.adjustmentPenalty, 0)} / kinematic penalty ${formatNumber(score.kinematicPenalty, 0)} / regulation penalty ${formatNumber(score.regulationPenalty, 0)} / raw ${formatNumber(score.rawScore)}`
    ),
    detailItem('経路補正', summarizeRouteAdjustment(adj))
  ];

  // 迂回試行履歴
  if (Array.isArray(result.detourTrials) && result.detourTrials.length) {
    const adopted = result.detourAdopted;
    const rows = result.detourTrials.map((t, i) => {
      const isAdopted = adopted && t.name === adopted;
      const statusColor = t.status === 'PASS' ? '#22c55e' : t.status === 'CONDITIONAL' ? '#f59e0b' : '#ef4444';
      const adoptedMark = isAdopted ? ' <span style="color:#22d3ee;font-weight:800;">← 採用</span>' : '';
      return `<div style="display:flex;justify-content:space-between;gap:8px;padding:3px 0;border-bottom:1px solid rgba(148,163,184,0.08);font-size:11.5px;">
        <span style="color:#cbd5e1;">${i === 0 ? '🅾 ' : '🔀 '}${esc(t.name)}</span>
        <span style="color:${statusColor};font-weight:700;">${esc(t.status || '?')}${t.violations ? ` (違反${t.violations})` : ''}${adoptedMark}</span>
      </div>`;
    }).join('');
    detailInner.push(detailItem(
      `迂回試行 (${result.detourTrials.length}案)`,
      `<div>${rows}</div>${adopted ? '' : '<div style="margin-top:4px;font-size:10.5px;color:#fca5a5;">すべての試行で通過不可。経路または車両条件を見直してください。</div>'}`
    ));
  }
  if (reasons.length) {
    detailInner.push(detailItem('内部メトリクス', esc(reasons.join(' / '))));
  }

  const detailsBlock = `<details class="rp-details-toggle">
    <summary>詳細情報を表示 (${detailInner.length}項目)</summary>
    <div style="display:flex;flex-direction:column;gap:8px;margin-top:8px;">${detailInner.join('')}</div>
  </details>`;

  setHTML('deliveryDetails', primaryCards.join('') + detailsBlock);

  // UI-F / UI-B: 描画後にハンドラ配線（renderの度に新規DOMなので重複しない）
  const detailContainer = byId('deliveryDetails');
  wireViolationFocus(detailContainer);
  wireNextActions(detailContainer);

  // UI-F: aria-live 領域に統合サマリを書き込み、スクリーンリーダーに読み上げさせる
  const live = byId('deliveryLiveRegion');
  if (live) {
    const vioSummary = violations.length
      ? `違反 ${violations.length} 件: ${violations.slice(0, 2).map((v) => formatViolation(v)).join('、 ')}`
      : '違反なし';
    live.textContent = `判定 ${statusLabel}。スコア ${Number.isFinite(result.score) ? Math.round(result.score) : '不明'}。${vioSummary}`;
  }

  if (saveBtn) saveBtn.disabled = false;
  if (printBtn) printBtn.disabled = false;
}

export function getLastDeliveryResult() {
  return lastResult;
}

function formatDateTime(date = new Date()) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

export function exportDeliveryReport(result, vehicleConfig, vehiclePresetName) {
  if (!result) return;

  const now = new Date();
  const dateStr = formatDateTime(now);
  const statusText = getStatusLabel(result.overallStatus);
  const statusClass = result.overallStatus === 'PASS' ? 'pass' : result.overallStatus === 'CONDITIONAL' ? 'warn' : 'ng';
  const feas = result.feasibility || {};
  const coll = result.collisionReport || result.contactFeasibility || {};
  const adj = result.routeAdjustment || {};
  const adjustmentSummary = summarizeRouteAdjustment(adj);
  const kinematicSummary = summarizeKinematics(result.kinematics);
  const scoreValue = Number.isFinite(result.score) ? Math.round(result.score) : '-';
  const distance = formatDistance(result.distanceMeters);
  const coverage = formatPercent(feas.coverage);
  const threshold = formatPercent(feas.threshold);
  const vc = vehicleConfig || {};
  const totalLength = Number(vc.wheelBase || 0) + Number(vc.frontOverhang || 0) + Number(vc.rearOverhang || 0);
  const presetLabel = vc.label || vehiclePresetName || '-';
  const bodyType = vc.bodyType || '-';
  const companyLine = RUNTIME_CONFIG.companyName ? `<div>会社: ${esc(RUNTIME_CONFIG.companyName)}</div>` : '';
  const reporterLine = RUNTIME_CONFIG.reporterName ? `<div>記録者: ${esc(RUNTIME_CONFIG.reporterName)}</div>` : '';
  const routeMarkup = buildRouteSnapshotMarkup(result);
  const reasons = Array.isArray(result.criteria?.reasons) ? result.criteria.reasons : [];

  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>搬入確認レポート</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Noto Sans JP','Hiragino Sans','Yu Gothic',sans-serif; background: #f1f5f9; color: #0f172a; font-size: 14px; }
    .page { width: 210mm; min-height: 297mm; margin: 0 auto; background: #fff; padding: 18mm 16mm; }
    .header { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 3px solid #0ea5e9; padding-bottom: 12px; margin-bottom: 18px; }
    .header-title { font-size: 22px; font-weight: 900; letter-spacing: 0.04em; }
    .header-sub { font-size: 11px; color: #64748b; margin-top: 4px; }
    .header-meta { text-align: right; font-size: 12px; color: #64748b; line-height: 1.7; }
    .result-block { text-align: center; padding: 18px 20px; border-radius: 14px; margin-bottom: 18px; border: 2px solid; }
    .result-block.pass { background: #f0fdf4; border-color: #4ade80; }
    .result-block.warn { background: #fffbeb; border-color: #fde68a; }
    .result-block.ng { background: #fff1f2; border-color: #fda4af; }
    .result-status { font-size: 34px; font-weight: 900; letter-spacing: 0.05em; }
    .pass .result-status { color: #16a34a; }
    .warn .result-status { color: #d97706; }
    .ng .result-status { color: #dc2626; }
    .result-meta { display: flex; justify-content: center; gap: 26px; margin-top: 12px; font-size: 13px; color: #475569; }
    .result-meta strong { display: block; margin-top: 4px; font-size: 20px; color: #0f172a; }
    .section { margin-bottom: 18px; }
    .section-title { font-size: 13px; font-weight: 800; color: #0f172a; border-left: 4px solid #0ea5e9; padding-left: 8px; margin-bottom: 10px; letter-spacing: 0.03em; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { padding: 8px 10px; border: 1px solid #e2e8f0; vertical-align: middle; }
    th { width: 130px; background: #f8fafc; color: #334155; font-weight: 700; white-space: nowrap; }
    .ok { color: #16a34a; font-weight: 700; }
    .ng { color: #dc2626; font-weight: 700; }
    .warn { color: #d97706; font-weight: 700; }
    .route-card { border: 1px solid #cbd5e1; border-radius: 16px; overflow: hidden; background: #0f172a; }
    .route-svg { width: 100%; height: auto; display: block; }
    .route-caption { padding: 8px 12px; font-size: 12px; color: #475569; background: #f8fafc; }
    .route-empty { border: 1px dashed #cbd5e1; border-radius: 12px; padding: 16px; color: #64748b; background: #f8fafc; }
    .notes-box { border: 1px solid #e2e8f0; border-radius: 8px; min-height: 92px; padding: 10px 12px; line-height: 1.7; white-space: pre-wrap; }
    .footer { margin-top: 24px; text-align: right; font-size: 10px; color: #94a3b8; border-top: 1px solid #e2e8f0; padding-top: 8px; }
    .print-btn { position: fixed; right: 24px; bottom: 24px; padding: 12px 22px; border: none; border-radius: 10px; background: #0ea5e9; color: #fff; font-size: 14px; font-weight: 700; cursor: pointer; box-shadow: 0 8px 22px rgba(15, 23, 42, 0.18); }
    .print-btn:hover { background: #0284c7; }
    @media print {
      body { background: #fff; }
      .page { box-shadow: none; padding: 10mm 12mm; }
      .print-btn { display: none; }
    }
  </style>
</head>
<body>
  <div class="page">
    <div class="header">
      <div>
        <div class="header-title">搬入確認レポート</div>
        <div class="header-sub">LOGISTICS OS / 搬入判定と軌跡スナップショット</div>
      </div>
      <div class="header-meta">
        <div>作成日時: ${esc(dateStr)}</div>
        ${companyLine}
        ${reporterLine}
      </div>
    </div>

    <div class="result-block ${statusClass}">
      <div class="result-status">${esc(statusText)}</div>
      <div class="result-meta">
        <span>スコア<strong>${esc(scoreValue)}</strong></span>
        <span>距離<strong>${esc(distance)}</strong></span>
        <span>カバー率<strong>${esc(coverage)}</strong></span>
      </div>
    </div>

    <div class="section">
      <div class="section-title">軌跡スナップショット</div>
      ${routeMarkup}
    </div>

    <div class="section">
      <div class="section-title">車両情報</div>
      <table>
        <tr>
          <th>車両</th><td>${esc(presetLabel)}</td>
          <th>ボディ</th><td>${esc(bodyType)}</td>
        </tr>
        <tr>
          <th>全長</th><td>${Number.isFinite(totalLength) ? `${totalLength.toFixed(2)} m` : '-'}</td>
          <th>車幅</th><td>${Number.isFinite(vc.vehicleWidth) ? `${vc.vehicleWidth} m` : '-'}</td>
        </tr>
        <tr>
          <th>車高</th><td>${Number.isFinite(vc.vehicleHeight) ? `${vc.vehicleHeight} m` : '-'}</td>
          <th>ホイールベース</th><td>${Number.isFinite(vc.wheelBase) ? `${vc.wheelBase} m` : '-'}</td>
        </tr>
      </table>
    </div>

    <div class="section">
      <div class="section-title">判定詳細</div>
      <table>
        <tr>
          <th>項目</th>
          <th>状態</th>
          <th>数値</th>
          <th>補足</th>
        </tr>
        <tr>
          <td>カバー率</td>
          <td class="${feas.status === 'OK' ? 'ok' : 'ng'}">${esc(feas.status || '-')}</td>
          <td>${esc(coverage)}</td>
          <td>基準 ${esc(threshold)}</td>
        </tr>
        <tr>
          <td>接触候補</td>
          <td class="${!coll.contactCount ? 'ok' : 'ng'}">${!coll.contactCount ? 'OK' : 'NG'}</td>
          <td>${esc(coll.contactCount ?? 0)} 点</td>
          <td>サンプル ${esc(coll.totalSamples ?? '-')}</td>
        </tr>
        <tr>
          <td>経路補正</td>
          <td class="${adj.applied ? (adj.ok ? 'ok' : 'warn') : ''}">${adj.applied ? (adj.ok ? '解消' : '要再確認') : 'なし'}</td>
          <td>${adj.applied ? `${esc(adj.iterations ?? '-')} 回` : '-'}</td>
          <td>${esc(getActionHint(result))}</td>
        </tr>
      </table>
    </div>

    ${(() => {
      // V9-B4: 違反理由を構造化して表に出力
      const vios = Array.isArray(result.violations) ? result.violations : [];
      if (!vios.length) {
        return `<div class="section">
          <div class="section-title">違反・警告</div>
          <div class="notes-box" style="color:#16a34a;font-weight:600;">違反・警告はありません。すべての判定項目で基準値を満たしています。</div>
        </div>`;
      }
      const rows = vios.slice(0, 12).map((v) => {
        const meta = getViolationMeta(v?.type);
        const at = Number.isFinite(v?.atKm) ? `${Number(v.atKm).toFixed(2)} km` : '-';
        const text = esc(formatViolation(v));
        return `<tr>
          <td style="text-align:center;font-weight:800;color:${meta.color};">${esc(meta.label)}</td>
          <td>${text}</td>
          <td style="text-align:right;font-variant-numeric:tabular-nums;">${esc(at)}</td>
        </tr>`;
      }).join('');
      const more = vios.length > 12 ? `<tr><td colspan="3" style="font-size:11px;color:#64748b;text-align:center;">他 ${vios.length - 12} 件</td></tr>` : '';
      return `<div class="section">
        <div class="section-title">違反・警告 (${vios.length}件)</div>
        <table>
          <tr>
            <th style="width:90px;">種別</th>
            <th>内容</th>
            <th style="width:80px;text-align:right;">位置</th>
          </tr>
          ${rows}${more}
        </table>
      </div>`;
    })()}

    <div class="section">
      <div class="section-title">備考</div>
      <div class="notes-box">${esc(`経路補正: ${adjustmentSummary}\n運動学チェック: ${kinematicSummary}\n内部メトリクス: ${reasons.length ? reasons.join(' / ') : 'なし'}\n出力時刻: ${dateStr}`)}</div>
    </div>

    <div class="footer">
      LOGISTICS OS v9.0 / 自動生成レポート / ${esc(dateStr)}
    </div>
  </div>

  <button class="print-btn" onclick="window.print()">印刷 / PDF 保存</button>
</body>
</html>`;

  const win = window.open('', '_blank');
  if (!win) {
    window.alert('ポップアップがブロックされました。ブラウザの設定で許可してください。');
    return;
  }
  win.document.write(html);
  win.document.close();
}

export function initDeliveryPanel({ onRun, onSaveResult, onPrintReport } = {}) {
  const runBtn = byId('runDeliveryAssessment');
  if (runBtn && typeof onRun === 'function') {
    runBtn.addEventListener('click', () => onRun());
  }

  const saveBtn = byId('saveDeliveryResult');
  if (saveBtn && typeof onSaveResult === 'function') {
    saveBtn.addEventListener('click', () => onSaveResult(lastResult));
  }

  const printBtn = byId('printDeliveryReport');
  if (printBtn && typeof onPrintReport === 'function') {
    printBtn.addEventListener('click', () => onPrintReport(lastResult));
  }

  const expandBtn = byId('chipExpandBtn');
  const resultPanel = byId('resultPanel');
  const closeBtn = byId('resultPanelClose');

  if (expandBtn && resultPanel) {
    expandBtn.addEventListener('click', () => {
      const isHidden = resultPanel.style.display === 'none';
      resultPanel.style.display = isHidden ? 'flex' : 'none';
    });
  }

  if (closeBtn && resultPanel) {
    closeBtn.addEventListener('click', () => {
      resultPanel.style.display = 'none';
    });
  }
}

export function clearDeliveryPanel() {
  renderDeliveryResult(null);
  setDeliveryProgress({ step: 0, total: 1, label: '', active: false });
}
