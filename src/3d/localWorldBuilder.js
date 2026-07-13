import { fetchRoadsAndSidewalks, fetchBuildings } from '../api/overpass.js';
import { fetchPlateauBuildings, mergeFeaturesById } from '../api/plateau.js';
import { resolvePlateauBuildingTilesetForBounds } from '../api/plateauCatalog.js';

const DEFAULT_RADIUS_M = 250;
const MIN_RADIUS_M = 80;
const MAX_RADIUS_M = 500;
const MAX_ROUTE_POINTS = 900;

function finiteNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function clampAoiRadius(value, fallback = DEFAULT_RADIUS_M) {
  const n = finiteNumber(value, fallback);
  return Math.max(MIN_RADIUS_M, Math.min(MAX_RADIUS_M, n));
}

export function thinRoute(route, maxPoints = MAX_ROUTE_POINTS) {
  if (!Array.isArray(route) || route.length <= maxPoints) return Array.isArray(route) ? route : [];
  const out = [];
  const last = route.length - 1;
  for (let i = 0; i < maxPoints; i++) {
    const idx = Math.round((i / (maxPoints - 1)) * last);
    out.push(route[idx]);
  }
  return out;
}

export function buildRouteBounds(route, radiusMeters = DEFAULT_RADIUS_M) {
  const pts = (Array.isArray(route) ? route : [])
    .filter((p) => Number.isFinite(Number(p?.lat)) && Number.isFinite(Number(p?.lng)));
  if (!pts.length) return null;

  let south = Infinity;
  let west = Infinity;
  let north = -Infinity;
  let east = -Infinity;
  for (const p of pts) {
    const lat = Number(p.lat);
    const lng = Number(p.lng);
    south = Math.min(south, lat);
    west = Math.min(west, lng);
    north = Math.max(north, lat);
    east = Math.max(east, lng);
  }

  const centerLat = (south + north) / 2;
  const latPad = radiusMeters / 111320;
  const lngPad = radiusMeters / Math.max(1, 111320 * Math.cos(centerLat * Math.PI / 180));
  return {
    south: south - latPad,
    west: west - lngPad,
    north: north + latPad,
    east: east + lngPad
  };
}

export function estimateBoundsSize(bounds) {
  if (!bounds) return { widthM: 0, heightM: 0, areaHa: 0 };
  const centerLat = (bounds.south + bounds.north) / 2;
  const heightM = Math.max(0, (bounds.north - bounds.south) * 111320);
  const widthM = Math.max(0, (bounds.east - bounds.west) * 111320 * Math.cos(centerLat * Math.PI / 180));
  return {
    widthM,
    heightM,
    areaHa: (widthM * heightM) / 10000
  };
}

async function loadBuildings(bounds, plateauUrl) {
  let buildings = [];
  let osmCount = 0;
  let plateauCount = 0;

  try {
    const fc = await fetchBuildings(bounds);
    buildings = Array.isArray(fc?.features) ? fc.features : [];
    osmCount = buildings.length;
  } catch (e) {
    console.warn('[index3d] OSM building fetch failed:', e?.message || e);
  }

  if (plateauUrl) {
    try {
      const plateau = await fetchPlateauBuildings(plateauUrl);
      plateauCount = plateau.length;
      buildings = mergeFeaturesById(plateau, buildings);
    } catch (e) {
      console.warn('[index3d] PLATEAU building fetch failed:', e?.message || e);
    }
  }

  return {
    features: buildings,
    osmCount,
    plateauCount
  };
}

async function resolvePlateauTileset(bounds, signal) {
  if (typeof window !== 'undefined' && window.PLATEAU_AUTO_DISABLE === true) return null;
  const preferLod = String((typeof window !== 'undefined' && window.PLATEAU_PREFER_LOD) || 'lod1').toLowerCase();
  try {
    return await resolvePlateauBuildingTilesetForBounds(bounds, { preferLod, signal });
  } catch (e) {
    console.warn('[index3d] PLATEAU tileset lookup failed:', e?.message || e);
    return null;
  }
}

export async function buildLocalWorld(route, {
  radiusMeters = DEFAULT_RADIUS_M,
  plateauUrl = '',
  roadDataSource = 'hybrid',
  signal
} = {}) {
  const routeForAoi = thinRoute(route);
  if (routeForAoi.length < 2) throw new Error('Route is required before loading the 3D world.');

  const radius = clampAoiRadius(radiusMeters);
  const bounds = buildRouteBounds(routeForAoi, radius);
  if (!bounds) throw new Error('Failed to build AOI bounds.');

  const size = estimateBoundsSize(bounds);
  if (size.areaHa > 120) {
    throw new Error(`AOI is too large for notebook mode (${size.areaHa.toFixed(1)}ha). Reduce route length or radius.`);
  }

  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const { roads, sidewalks, regulations } = await fetchRoadsAndSidewalks(bounds, roadDataSource);
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const buildingResult = await loadBuildings(bounds, plateauUrl);
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const plateauTileset = await resolvePlateauTileset(bounds, signal);

  const roadFeatures = Array.isArray(roads?.features) ? roads.features : [];
  const sidewalkFeatures = Array.isArray(sidewalks?.features) ? sidewalks.features : [];
  const regulationFeatures = Array.isArray(regulations?.features) ? regulations.features : [];

  return {
    bounds,
    radiusMeters: radius,
    roads: roadFeatures,
    sidewalks: sidewalkFeatures,
    regulations: regulationFeatures,
    buildings: buildingResult.features,
    plateauTileset,
    metrics: {
      boundsWidthM: Math.round(size.widthM),
      boundsHeightM: Math.round(size.heightM),
      boundsAreaHa: Number(size.areaHa.toFixed(2)),
      roadFeatures: roadFeatures.length,
      sidewalkFeatures: sidewalkFeatures.length,
      regulationFeatures: regulationFeatures.length,
      buildingFeatures: buildingResult.features.length,
      osmBuildingFeatures: buildingResult.osmCount,
      plateauBuildingFeatures: buildingResult.plateauCount,
      plateauTilesetName: plateauTileset?.name || '',
      plateauTilesetItem: plateauTileset?.itemName || '',
      plateauTilesetUrl: plateauTileset?.url || ''
    }
  };
}
