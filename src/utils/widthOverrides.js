const STORAGE_KEY = 'road_width_overrides';

function clampWidthMeters(v) {
  if (!Number.isFinite(v)) return null;
  const clamped = Math.max(0, Math.min(100, v));
  return clamped;
}

export function normalizeOverrides(input) {
  const raw = input && typeof input === 'object' ? input : {};
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!key) continue;
    const num = typeof value === 'number' ? value : Number(value);
    const w = clampWidthMeters(num);
    if (w == null) continue;
    out[String(key)] = w;
  }
  return out;
}

export function loadOverrides() {
  if (typeof localStorage === 'undefined') return {};
  try {
    const text = localStorage.getItem(STORAGE_KEY);
    if (!text) return {};
    return normalizeOverrides(JSON.parse(text));
  } catch (e) {
    return {};
  }
}

export function saveOverrides(overrides) {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeOverrides(overrides)));
  } catch (e) {}
}

export function buildOverridesExportDoc(overrides, { description = 'User overrides for road widths' } = {}) {
  const normalized = normalizeOverrides(overrides);
  const payload = { version: 1, updatedAt: new Date().toISOString(), description, overrides: {} };
  for (const [id, width_m] of Object.entries(normalized)) {
    payload.overrides[id] = { width_m };
  }
  return payload;
}

export function parseOverridesImportDoc(json) {
  if (!json || typeof json !== 'object') return {};
  if (json.version === 1 && json.overrides && typeof json.overrides === 'object') {
    const out = {};
    for (const [id, entry] of Object.entries(json.overrides)) {
      const v = entry && typeof entry === 'object' ? entry.width_m : null;
      const num = typeof v === 'number' ? v : Number(v);
      const w = clampWidthMeters(num);
      if (w == null) continue;
      out[String(id)] = w;
    }
    return out;
  }
  return normalizeOverrides(json);
}

