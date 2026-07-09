const STORAGE_KEY = 'road_mask_edits_v1';

function isFeatureLike(x) {
  return !!x && typeof x === 'object' && x.type === 'Feature' && x.geometry && typeof x.geometry === 'object';
}

function isPolygonGeometry(g) {
  return !!g && (g.type === 'Polygon' || g.type === 'MultiPolygon');
}

function normalizeFeature(feature) {
  if (!isFeatureLike(feature)) return null;
  if (!isPolygonGeometry(feature.geometry)) return null;
  const props = feature.properties && typeof feature.properties === 'object' ? feature.properties : {};
  const id = props.id ?? feature.id ?? null;
  const fid = id != null ? String(id) : null;
  return {
    type: 'Feature',
    id: fid ?? undefined,
    properties: { ...props, id: fid ?? props.id },
    geometry: feature.geometry
  };
}

function normalizeFeatureArray(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const f of arr) {
    const nf = normalizeFeature(f);
    if (nf) out.push(nf);
  }
  return out;
}

export function normalizeMaskEdits(input) {
  const obj = input && typeof input === 'object' ? input : {};
  return {
    allow: normalizeFeatureArray(obj.allow),
    deny: normalizeFeatureArray(obj.deny)
  };
}

export function loadMaskEdits() {
  if (typeof localStorage === 'undefined') return { allow: [], deny: [] };
  try {
    const text = localStorage.getItem(STORAGE_KEY);
    if (!text) return { allow: [], deny: [] };
    const json = JSON.parse(text);
    if (json && typeof json === 'object' && json.version === 1) {
      return normalizeMaskEdits({ allow: json.allow, deny: json.deny });
    }
    return normalizeMaskEdits(json);
  } catch (e) {
    return { allow: [], deny: [] };
  }
}

export function saveMaskEdits(maskEdits) {
  if (typeof localStorage === 'undefined') return;
  try {
    const normalized = normalizeMaskEdits(maskEdits);
    const payload = { version: 1, updatedAt: new Date().toISOString(), allow: normalized.allow, deny: normalized.deny };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch (e) {}
}

export function buildMaskEditsExportDoc(maskEdits, { description = 'User mask edits for drivable area' } = {}) {
  const normalized = normalizeMaskEdits(maskEdits);
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    description,
    allow: normalized.allow,
    deny: normalized.deny
  };
}

export function parseMaskEditsImportDoc(json) {
  if (!json || typeof json !== 'object') return { allow: [], deny: [] };
  if (json.version === 1 && (json.allow || json.deny)) {
    return normalizeMaskEdits({ allow: json.allow, deny: json.deny });
  }
  return normalizeMaskEdits(json);
}

