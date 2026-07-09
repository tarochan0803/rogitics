function toFeatureArray(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data.filter((f) => f?.geometry);
  if (data.type === 'FeatureCollection' && Array.isArray(data.features)) return data.features.filter((f) => f?.geometry);
  if (data.type === 'Feature' && data.geometry) return [data];
  return [];
}

function finiteNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function firstFinite(props, keys) {
  for (const key of keys) {
    const value = finiteNumber(props?.[key], null);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function normalizePlateauFeature(feature, index = 0) {
  const props = feature.properties || {};
  const measuredHeight = firstFinite(props, [
    'measuredHeight',
    'bldg:measuredHeight',
    'height',
    'h',
    '建物高さ',
    '高さ'
  ]);
  const levels = firstFinite(props, ['building:levels', 'levels', 'storeys', '階数']);
  const height = Number.isFinite(measuredHeight)
    ? measuredHeight
    : (Number.isFinite(levels) ? levels * 3.0 : null);
  const minHeight = firstFinite(props, ['minHeight', 'bldg:minHeight', 'min_height', 'h_min']) || 0;
  const id = feature.id || props.id || props.gml_id || props['gml:id'] || `plateau-${index}`;

  return {
    ...feature,
    id,
    properties: {
      ...props,
      id,
      source: props.source || 'plateau',
      height: Number.isFinite(height) ? height : props.height,
      minHeight,
      heightSource: Number.isFinite(measuredHeight)
        ? 'plateau_measured'
        : (Number.isFinite(levels) ? 'plateau_levels' : 'plateau_unknown')
    }
  };
}

export function normalizePlateauBuildings(data) {
  return toFeatureArray(data)
    .filter((feature) => {
      const type = feature.geometry?.type;
      return type === 'Polygon' || type === 'MultiPolygon';
    })
    .map(normalizePlateauFeature);
}

export async function fetchPlateauBuildings(url, { signal } = {}) {
  if (!url || typeof url !== 'string') {
    throw new Error('PLATEAU buildings URL is not configured.');
  }
  const resp = await fetch(url, { signal });
  if (!resp.ok) throw new Error(`PLATEAU fetch failed: HTTP ${resp.status}`);
  const data = await resp.json();
  return normalizePlateauBuildings(data);
}

export function mergeFeaturesById(existing = [], incoming = []) {
  const out = [];
  const seen = new Set();
  for (const feature of [...existing, ...incoming]) {
    if (!feature?.geometry) continue;
    const id = String(feature.id || feature.properties?.id || `${feature.geometry.type}:${out.length}`);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(feature);
  }
  return out;
}
