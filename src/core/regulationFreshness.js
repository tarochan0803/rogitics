const FRESH_SECONDS = 6 * 60 * 60;
const EXPIRED_SECONDS = 72 * 60 * 60;
const STATES = new Set(['fresh', 'stale', 'expired', 'error']);

function asFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function ageSeconds(source, nowMs) {
  const reported = asFiniteNumber(source?.ageSeconds);
  if (reported != null && reported >= 0) return reported;
  const timestamp = Date.parse(source?.fetchedAt || source?.checkedAt || '');
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, (nowMs - timestamp) / 1000);
}

export function classifyAge(age, error = null) {
  if (error) return 'error';
  if (!Number.isFinite(age) || age < 0) return 'error';
  if (age <= FRESH_SECONDS) return 'fresh';
  if (age <= EXPIRED_SECONDS) return 'stale';
  return 'expired';
}

function normalizeSourceState(source, fallback) {
  const state = String(source?.state || source?.status || '').toLowerCase();
  if (STATES.has(state)) return state;
  if (state === 'current' || state === 'ok') return 'fresh';
  if (state === 'changed' || state === 'pending-review' || state === 'pending_review') return 'stale';
  if (state === 'unavailable' || state === 'not_configured') return 'error';
  return fallback;
}

function normalizeReferenceSource(source = {}) {
  const error = source.error ? String(source.error) : null;
  const changed = source.reviewRequired === true || source.changeDetected === true;
  const fallback = error ? 'error' : (changed ? 'stale' : 'fresh');
  return {
    state: normalizeSourceState(source, fallback),
    checkedAt: source.checkedAt || null,
    publishedAt: source.publishedAt || source.releaseDay || source.effectiveDataDate || null,
    targetMonth: source.targetMonth || null,
    reviewRequired: changed,
    configured: source.configured !== false
      && source.notConfigured !== true
      && String(source.dataStatus || '').toLowerCase() !== 'notconfigured'
      && String(source.state || '') !== 'not_configured',
    error
  };
}

export function normalizeStatus(payload, now = Date.now()) {
  const sources = payload?.sources || {};
  const osm = sources.osm || {};
  const npa = sources.npaSpec || {};
  const jartic = sources.jarticOpenData || {};
  const jSystem = sources.jarticJSystem || {};
  const osmError = osm.error ? String(osm.error) : null;
  const osmAge = ageSeconds(osm, now);
  const normalizedOsm = {
    state: normalizeSourceState(osm, classifyAge(osmAge, osmError)),
    fetchedAt: osm.fetchedAt || null,
    ageSeconds: osmAge,
    featureCount: asFiniteNumber(osm.featureCount),
    error: osmError
  };
  const normalizedNpa = normalizeReferenceSource(npa);
  const normalizedJartic = normalizeReferenceSource(jartic);
  const normalizedJSystem = normalizeReferenceSource(jSystem);
  const overall = STATES.has(String(payload?.overall || '').toLowerCase())
    ? String(payload.overall).toLowerCase()
    : normalizedOsm.state;
  return {
    schemaVersion: payload?.schemaVersion || null,
    overall,
    checkedAt: payload?.checkedAt || null,
    sources: {
      osm: normalizedOsm,
      npaSpec: normalizedNpa,
      jarticOpenData: normalizedJartic,
      jarticJSystem: normalizedJSystem
    }
  };
}

function validateBbox(bbox) {
  if (!Array.isArray(bbox) || bbox.length !== 4) throw new Error('bbox must be [west, south, east, north]');
  const values = bbox.map(Number);
  if (!values.every(Number.isFinite) || values[0] > values[2] || values[1] > values[3]) {
    throw new Error('bbox must contain ordered finite coordinates');
  }
  return values;
}

function formatTime(value) {
  const timestamp = Date.parse(value || '');
  if (!Number.isFinite(timestamp)) return '未取得';
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit'
  }).format(timestamp);
}

function stateLabel(state) {
  return { fresh: '最新', stale: '要確認', expired: '期限切れ', error: '取得エラー' }[state] || '未確認';
}

function createIcon() {
  const icon = document.createElement('i');
  icon.dataset.lucide = 'refresh-cw';
  icon.setAttribute('aria-hidden', 'true');
  return icon;
}

export function createRegulationFreshness({ root, getBbox, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  if (!root) throw new Error('regulation freshness root is required');
  const statusEl = root.querySelector('[data-freshness-status]');
  const detailEl = root.querySelector('[data-freshness-detail]');
  const reviewEl = root.querySelector('[data-freshness-review]');
  const button = root.querySelector('[data-freshness-refresh]');
  let bbox = null;
  let current = null;
  let loading = false;

  function render(status) {
    current = status;
    const state = status?.overall || 'error';
    root.dataset.state = state;
    if (statusEl) statusEl.textContent = stateLabel(state);
    const osm = status?.sources?.osm;
    const jartic = status?.sources?.jarticOpenData;
    if (detailEl) {
      detailEl.textContent = `OSM ${formatTime(osm?.fetchedAt)} / JARTIC ${jartic?.targetMonth || formatTime(jartic?.checkedAt)} / NPA ${formatTime(status?.sources?.npaSpec?.checkedAt)}`;
    }
    if (reviewEl) {
      const review = [];
      if (status?.sources?.npaSpec?.reviewRequired) review.push('NPA改訂');
      if (jartic?.reviewRequired) review.push('JARTIC更新');
      if (jartic?.configured === false) review.push('JARTIC月次未取込');
      if (status?.sources?.jarticJSystem?.configured === false) review.push('公式リアルタイム未設定');
      reviewEl.hidden = review.length === 0;
      reviewEl.textContent = review.length ? `${review.join(' / ')} 要確認` : '';
    }
  }

  async function request(url, options) {
    const response = await fetchImpl(url, options);
    if (!response?.ok) throw new Error(`HTTP ${response?.status || 0}`);
    return response.json();
  }

  async function refresh(nextBbox = bbox, force = false) {
    try {
      bbox = validateBbox(nextBbox);
      if (loading) return current;
      loading = true;
      root.dataset.loading = 'true';
      if (button) button.disabled = true;
      const query = encodeURIComponent(bbox.join(','));
      const payload = force
        ? await request('/api/regulations/refresh', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bbox, force: true })
        })
        : await request(`/api/regulations/status?bbox=${query}`);
      render(normalizeStatus(payload, now()));
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('regulation-data-refreshed', {
          detail: { bbox: bbox.slice(), force: !!force, status: current, payload }
        }));
      }
      return current;
    } catch (error) {
      render(normalizeStatus({ overall: 'error', sources: { osm: { error: error.message }, npaSpec: {} } }, now()));
      return current;
    } finally {
      loading = false;
      root.dataset.loading = 'false';
      if (button) button.disabled = false;
    }
  }

  function setBbox(nextBbox, options = {}) {
    bbox = validateBbox(nextBbox);
    if (options.refresh) return refresh(bbox, !!options.force);
    return bbox.slice();
  }

  button?.append(createIcon());
  if (typeof window !== 'undefined' && window.lucide?.createIcons) window.lucide.createIcons({ attrs: { 'stroke-width': 1.8 } });
  button?.addEventListener('click', () => refresh((typeof getBbox === 'function' ? getBbox() : null) || bbox, true));
  render(null);
  return {
    refresh,
    setBbox,
    renderPayload: (payload) => {
      render(normalizeStatus(payload, now()));
      return current;
    },
    getBbox: () => bbox?.slice() || null,
    getStatus: () => current
  };
}

export function initRegulationFreshness(options = {}) {
  const root = options.root || document.querySelector('[data-regulation-freshness]');
  if (!root) return null;
  const handle = createRegulationFreshness({ ...options, root });
  if (typeof window !== 'undefined') {
    window.regulationFreshness = handle;
    if (window.REGULATION_FRESHNESS_PAYLOAD) {
      handle.renderPayload(window.REGULATION_FRESHNESS_PAYLOAD);
    }
    if (Array.isArray(window.REGULATION_BBOX)) {
      handle.setBbox(window.REGULATION_BBOX, { refresh: !window.REGULATION_FRESHNESS_PAYLOAD });
    }
  }
  return handle;
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  const start = () => initRegulationFreshness({ getBbox: () => window.REGULATION_BBOX || null });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}
