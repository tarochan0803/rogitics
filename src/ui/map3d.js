import { coordinateSystem, turf } from '../utils/geo.js';

let map3d;
let isLoaded = false;
const onLoadQueue = [];
let animId;
let poses = [];

let buildingsAll = null;
let buildingsShownCount = 0;
let buildingsShownGeoJSON = { type: 'FeatureCollection', features: [] };

const ROUTE_SOURCE_ID = 'route3d-src';
const ROUTE_GLOW_LAYER_ID = 'route-3d-glow';
const ROUTE_LAYER_ID = 'route-3d-core';
const ROADS_SOURCE_ID = 'roads3d-src';
const ROADS_LAYER_ID = 'roads-3d-base';
const ROADS_CORRIDOR_SOURCE_ID = 'roads3d-corridor-src';
const ROADS_CORRIDOR_GLOW_LAYER_ID = 'roads-3d-corridor-glow';
const ROADS_CORRIDOR_LAYER_ID = 'roads-3d-corridor-core';
const ROAD_SURFACE_SOURCE_ID = 'road-surface-3d-src';
const ROAD_SURFACE_FILL_LAYER_ID = 'road-surface-3d-fill';
const ROAD_SURFACE_GLOW_LAYER_ID = 'road-surface-3d-glow';
const ROAD_SURFACE_OUTLINE_LAYER_ID = 'road-surface-3d-outline';
const TRUCK_SOURCE_ID = 'truck3d-src';
const TRUCK_LAYER_ID = 'truck-3d';
const TRUCK_OUTLINE_LAYER_ID = 'truck-3d-outline';
const BUILDINGS_SOURCE_ID = 'buildings3d-src';
const BUILDINGS_LAYER_ID = 'buildings-3d';
const BUILDINGS_WIREFRAME_LAYER_ID = 'buildings-3d-wireframe';
const OBSTACLES_SOURCE_ID = 'obstacles3d-src';
const OBSTACLES_LAYER_ID = 'obstacles-3d';
const OBSTACLES_GLOW_LAYER_ID = 'obstacles-3d-outline-glow';
const OBSTACLES_OUTLINE_LAYER_ID = 'obstacles-3d-outline';

const BUILDING_COLOR_EXPR = [
  'interpolate',
  ['linear'],
  ['get', 'h'],
  0,
  '#e3e7ef',
  20,
  '#d4dbe6',
  60,
  '#c1cad8',
  140,
  '#aeb8c8',
  250,
  '#9aa5b6'
];

let buildingsRenderMode = 'solid';

const STREET_SCENE = {
  background: '#cfe4f6',
  rasterOpacity: 0.42,
  rasterSaturation: 0.08,
  rasterContrast: 0.28,
  rasterBrightnessMin: 0.18,
  rasterBrightnessMax: 0.92,
  roadFill: '#38bdf8',
  roadFillOpacity: 0.30,
  roadGlow: '#ffffff',
  roadGlowOpacity: 0.08,
  roadGlowWidth: 6,
  roadGlowBlur: 2.5,
  roadOutline: '#e5e7eb',
  roadOutlineOpacity: 0.55,
  roadOutlineWidth: 1.6,
  roadOutlineBlur: 0.2,
  roadLine: '#475569',
  roadLineOpacity: 0.48,
  corridorGlow: '#fde68a',
  corridorGlowOpacity: 0.2,
  corridorGlowWidth: 8,
  corridorGlowBlur: 5,
  corridorLine: '#f59e0b',
  corridorLineOpacity: 0.9,
  corridorLineWidth: 2.6,
  routeGlow: '#fde68a',
  routeGlowOpacity: 0.18,
  routeGlowWidth: 9,
  routeGlowBlur: 4.5,
  routeLine: '#fbbf24',
  routeLineOpacity: 0.95,
  routeLineWidth: 3.2
};

const STREET_CAMERA = {
  pitch: 78,
  zoom: 18.6,
  backMeters: 8,
  sideMeters: 1.2
};

const TRUCK_COLOR_EXPR = ['case', ['==', ['get', 'danger'], 1], '#ef4444', '#5eead4'];
const TRUCK_OUTLINE_EXPR = ['case', ['==', ['get', 'danger'], 1], '#fecaca', '#2dd4bf'];

let buildingsWireframeVertices = new Float32Array(0);
let buildingsWireframeVertexCount = 0;
let buildingsWireframeVersion = 0;
const buildingsWireframeStyle = {
  enabled: false,
  coreColor: [0.647, 0.953, 0.988],
  glowColor: [0.133, 0.827, 0.933],
  coreWidthPx: 1.6,
  glowWidthPx: 8.0,
  coreOpacity: 0.72,
  glowOpacity: 0.16
};

function runWhenReady(fn) {
  if (map3d && isLoaded) {
    fn();
    return;
  }
  onLoadQueue.push(fn);
}

function flushQueue() {
  const queue = onLoadQueue.splice(0);
  for (const fn of queue) {
    try {
      fn();
    } catch (e) {
      console.warn('map3d queued op failed', e);
    }
  }
}

export function initMap3D(containerId = 'map3d') {
  map3d = new maplibregl.Map({
    container: containerId,
    canvasContextAttributes: { alpha: false, preserveDrawingBuffer: false },
    style: {
      version: 8,
      sources: {
        osm: {
          type: 'raster',
          tiles: ['https://a.tile.openstreetmap.org/{z}/{x}/{y}.png', 'https://b.tile.openstreetmap.org/{z}/{x}/{y}.png'],
          tileSize: 256,
          maxzoom: 19,
          attribution: '© OpenStreetMap contributors'
        }
      },
      layers: [
        { id: 'bg', type: 'background', paint: { 'background-color': STREET_SCENE.background } },
        {
          id: 'osm',
          type: 'raster',
          source: 'osm',
          paint: {
            'raster-opacity': STREET_SCENE.rasterOpacity,
            'raster-saturation': STREET_SCENE.rasterSaturation,
            'raster-contrast': STREET_SCENE.rasterContrast,
            'raster-brightness-min': STREET_SCENE.rasterBrightnessMin,
            'raster-brightness-max': STREET_SCENE.rasterBrightnessMax
          }
        }
      ]
    },
    center: [139.7671, 35.6812],
    zoom: 17,
    pitch: 60,
    bearing: 0,
    antialias: true,
    fadeDuration: 0
  });
  map3d.addControl(new maplibregl.NavigationControl({ visualizePitch: true }));
  map3d.on('load', () => {
    isLoaded = true;
    applySceneEffects();
    ensureBuildingsLayer();
    flushQueue();
  });
}

export function setRoute3D(simRoute) {
  if (!simRoute || simRoute.length < 2) return;
  runWhenReady(() => {
    ensureRoadsLayer();
    ensureRouteLayer();
    const routeLine = { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: simRoute.map((p) => [p.lng, p.lat]) } };
    map3d.getSource(ROUTE_SOURCE_ID).setData({ type: 'FeatureCollection', features: [routeLine] });
  });
}

export function setRoads3D(features = []) {
  runWhenReady(() => {
    ensureRoadsLayer();
    const fc = {
      type: 'FeatureCollection',
      features: Array.isArray(features) ? features.filter((f) => f && f.type === 'Feature' && f.geometry) : []
    };
    map3d.getSource(ROADS_SOURCE_ID).setData(fc);
  });
}

export function setCorridorRoads3D(features = [], simRoute, { corridorMeters = 80 } = {}) {
  runWhenReady(() => {
    ensureRoadsLayer();
    if (!simRoute || simRoute.length < 2) {
      map3d.getSource(ROADS_CORRIDOR_SOURCE_ID).setData({ type: 'FeatureCollection', features: [] });
      return;
    }
    const line = turf.lineString(simRoute.map((p) => [p.lng, p.lat]));
    const corridor = turf.buffer(line, Math.max(1, Number(corridorMeters) || 80), { units: 'meters', steps: 8 });
    const corridorBbox = turf.bbox(corridor);

    const src = Array.isArray(features) ? features : [];
    const candidates = [];
    for (const f of src) {
      const bb = bboxOfAnyFeature(f);
      if (!bb || !bboxIntersects(bb, corridorBbox)) continue;
      candidates.push(f);
    }

    let filtered = candidates;
    const canPreciseFilter = candidates.length <= 2000 && typeof turf.booleanIntersects === 'function';
    if (canPreciseFilter) {
      filtered = candidates.filter((f) => {
        try {
          return turf.booleanIntersects(f, corridor);
        } catch (e) {
          return true;
        }
      });
    }

    map3d.getSource(ROADS_CORRIDOR_SOURCE_ID).setData({ type: 'FeatureCollection', features: filtered });
  });
}

export function setRoadSurface3D(roadUnionGeo) {
  runWhenReady(() => {
    ensureRoadsLayer();
    if (!map3d.getSource(ROAD_SURFACE_SOURCE_ID)) return;
    if (!roadUnionGeo) {
      map3d.getSource(ROAD_SURFACE_SOURCE_ID).setData({ type: 'FeatureCollection', features: [] });
      return;
    }
    try {
      const fc = asFeatureCollection(roadUnionGeo);
      map3d.getSource(ROAD_SURFACE_SOURCE_ID).setData(fc);
    } catch (e) {
      map3d.getSource(ROAD_SURFACE_SOURCE_ID).setData({ type: 'FeatureCollection', features: [] });
    }
  });
}

export function clearRoadSurface3D() {
  setRoadSurface3D(null);
}

function offsetLatLngMeters(ll, bearingDeg, meters) {
  if (!ll || !Number.isFinite(meters) || meters === 0) return ll;
  if (!turf?.destination) return ll;
  try {
    const dest = turf.destination([ll.lng, ll.lat], meters / 1000, bearingDeg, { units: 'kilometers' });
    const coords = dest?.geometry?.coordinates;
    if (!coords) return ll;
    return { lng: coords[0], lat: coords[1] };
  } catch (e) {
    return ll;
  }
}

function computeStreetCameraCenter(ll, bearingDeg, backMeters, sideMeters) {
  let out = offsetLatLngMeters(ll, normalizeBearingDeg(bearingDeg + 180), backMeters);
  if (Number.isFinite(sideMeters) && sideMeters !== 0) {
    out = offsetLatLngMeters(out, normalizeBearingDeg(bearingDeg + 90), sideMeters);
  }
  return out;
}

export function play3D(simPoses, vehicleConfig, opts = {}) {
  if (!map3d) return;
  if (animId) cancelAnimationFrame(animId);
  animId = null;
  poses = simPoses || [];
  let progress = 0;
  let lastTs = 0;
  let cameraAccumS = 0;

  const strideMeters = Math.max(0.05, Number(opts.strideMeters ?? 1.5));
  const speedMultiplierRaw = Number(opts.speedMultiplier ?? 1);
  const speedMultiplier = Number.isFinite(speedMultiplierRaw) ? Math.max(0.1, Math.min(5.0, speedMultiplierRaw)) : 1;
  const vehicleSpeed = Math.max(0.5, Number(vehicleConfig?.vehicleSpeed ?? 4.0));
  const secondsPerPose = strideMeters / vehicleSpeed / speedMultiplier;
  const followCamera = opts.followCamera !== false;
  const cameraMode = opts.cameraMode === 'street' ? 'street' : 'top';
  const cameraPitch = Number(opts.cameraPitch ?? STREET_CAMERA.pitch);
  const cameraZoom = Number(opts.cameraZoom ?? STREET_CAMERA.zoom);
  const cameraBackMeters = Number(opts.cameraBackMeters ?? STREET_CAMERA.backMeters);
  const cameraSideMeters = Number(opts.cameraSideMeters ?? STREET_CAMERA.sideMeters);
  const cameraFpsRaw = Number(opts.cameraFps ?? 60);
  const cameraFps = Number.isFinite(cameraFpsRaw) ? Math.max(5, Math.min(60, cameraFpsRaw)) : 60;
  const cameraIntervalS = 1 / cameraFps;
  const roadUnionGeo = opts.roadUnionGeo || null;
  const obstaclesGeo = opts.obstaclesGeo || null;
  const obstacleFeatures = Array.isArray(obstaclesGeo?.features) ? obstaclesGeo.features.filter((f) => f?.geometry) : [];
  const obstacleBboxes = obstacleFeatures.map((f) => bboxOfFeature(f));
  const hasRoadCheck = !!roadUnionGeo && typeof turf?.booleanWithin === 'function';
  const hasObstacleCheck = obstacleFeatures.length > 0 && typeof turf?.booleanIntersects === 'function';
  const allowCollisionCheck = hasRoadCheck || hasObstacleCheck;
  const collisionCheckFps = 12;
  const collisionCheckIntervalS = 1 / collisionCheckFps;
  let collisionAccumS = 0;
  let lastDanger = null;

  const renderPose = (p) => {
    if (!p) return;
    ensureTruckLayer();
    const ll = coordinateSystem.metersToLatLng(p.x, p.y);
    const ring = buildTruckRing(p, vehicleConfig);
    const danger = p.danger ? 1 : 0;
    const feat = {
      type: 'Feature',
      properties: { h: Math.max(1.5, vehicleConfig?.vehicleHeight || 2), danger },
      geometry: {
        type: 'Polygon',
        coordinates: [ring]
      }
    };
    map3d.getSource(TRUCK_SOURCE_ID).setData({ type: 'FeatureCollection', features: [feat] });
  };

  const step = (ts) => {
    if (!isLoaded) {
      animId = requestAnimationFrame(step);
      return;
    }
    if (!poses.length) {
      animId = null;
      return;
    }
    if (!lastTs) lastTs = ts;
    const dtS = Math.min(0.25, Math.max(0, (ts - lastTs) / 1000));
    lastTs = ts;
    if (secondsPerPose > 0) progress += dtS / secondsPerPose;
    if (progress >= poses.length - 1) progress = poses.length - 1;

    const baseIdx = Math.max(0, Math.min(poses.length - 1, Math.floor(progress)));
    const nextIdx = Math.min(poses.length - 1, baseIdx + 1);
    const t = Math.max(0, Math.min(1, progress - baseIdx));
    const a = poses[baseIdx];
    const b = poses[nextIdx];
    const p = interpolatePose(a, b, t);

    if (allowCollisionCheck) {
      collisionAccumS += dtS;
      if (collisionAccumS >= collisionCheckIntervalS || lastDanger === null) {
        collisionAccumS = 0;
        try {
          const ring = buildTruckRing(p, vehicleConfig);
          const footprint = turf.polygon([ring]);
          let danger = 0;
          if (hasRoadCheck) {
            const isOk = turf.booleanWithin(footprint, roadUnionGeo);
            if (!isOk) danger = 1;
          }
          if (!danger && hasObstacleCheck) {
            const fpBbox = bboxOfPolygon([ring]);
            for (let i = 0; i < obstacleFeatures.length; i++) {
              const ob = obstacleFeatures[i];
              const obBbox = obstacleBboxes[i];
              if (fpBbox && obBbox && !bboxIntersects(fpBbox, obBbox)) continue;
              if (turf.booleanIntersects(footprint, ob)) {
                danger = 1;
                break;
              }
            }
          }
          p.danger = danger;
        } catch (e) {
          p.danger = 0;
        }
        lastDanger = p.danger;
      } else if (lastDanger != null) {
        p.danger = lastDanger;
      }
    }

    renderPose(p);

    if (followCamera) {
      cameraAccumS += dtS;
      if (cameraAccumS >= cameraIntervalS || progress >= poses.length - 1) {
        cameraAccumS = 0;
        const ll = coordinateSystem.metersToLatLng(p.x, p.y);
        const bearing = normalizeBearingDeg(90 - (p.theta * 180) / Math.PI);
        if (cameraMode === 'street') {
          const center = computeStreetCameraCenter(ll, bearing, cameraBackMeters, cameraSideMeters);
          map3d.jumpTo({ center: [center.lng, center.lat], bearing, pitch: cameraPitch, zoom: cameraZoom });
        } else {
          map3d.jumpTo({ center: [ll.lng, ll.lat], bearing });
        }
      }
    }

    if (progress >= poses.length - 1) {
      animId = null;
      return;
    }
    animId = requestAnimationFrame(step);
  };
  if (!animId) animId = requestAnimationFrame(step);
}

export function stop3D() {
  if (animId) cancelAnimationFrame(animId);
  animId = null;
}

export function resizeMap3D() {
  if (!map3d) return;
  try {
    map3d.resize();
  } catch (e) {}
}

export function fitRoute3D(simRoute, { padding = 60 } = {}) {
  if (!map3d || !simRoute || simRoute.length < 2) return;
  runWhenReady(() => {
    const bounds = new maplibregl.LngLatBounds([simRoute[0].lng, simRoute[0].lat], [simRoute[0].lng, simRoute[0].lat]);
    for (const p of simRoute) bounds.extend([p.lng, p.lat]);
    map3d.fitBounds(bounds, { padding, duration: 0, maxZoom: 18 });
  });
}

export function setBuildingsAllGeoJSON(geojson, { defaultHeight = 10 } = {}) {
  buildingsAll = normalizeBuildingsGeoJSON(geojson, { defaultHeight });
  buildingsShownCount = 0;
}

export function clearBuildings3D() {
  buildingsAll = null;
  buildingsShownCount = 0;
  setBuildingsWireframeData({ type: 'FeatureCollection', features: [] });
  runWhenReady(() => {
    ensureBuildingsLayer();
    map3d.getSource(BUILDINGS_SOURCE_ID).setData({ type: 'FeatureCollection', features: [] });
  });
}

export function setObstaclesGeoJSON(geojson, { defaultHeight = 3 } = {}) {
  const fc = normalizeObstacleGeoJSON(geojson, { defaultHeight });
  runWhenReady(() => {
    ensureObstaclesLayer();
    map3d.getSource(OBSTACLES_SOURCE_ID).setData(fc);
  });
}

export function clearObstacles3D() {
  runWhenReady(() => {
    ensureObstaclesLayer();
    map3d.getSource(OBSTACLES_SOURCE_ID).setData({ type: 'FeatureCollection', features: [] });
  });
}

export function updateBuildingsForRoute(simRoute, { corridorMeters = 150 } = {}) {
  if (!buildingsAll?.features?.length || !simRoute || simRoute.length < 2) {
    buildingsShownCount = 0;
    setBuildingsWireframeData({ type: 'FeatureCollection', features: [] });
    runWhenReady(() => {
      ensureBuildingsLayer();
      map3d.getSource(BUILDINGS_SOURCE_ID).setData({ type: 'FeatureCollection', features: [] });
    });
    return { total: buildingsAll?.features?.length ?? 0, shown: 0 };
  }

  const distance = Math.max(0, Number(corridorMeters) || 0);
  const line = turf.lineString(simRoute.map((p) => [p.lng, p.lat]));
  const corridor = distance > 0 ? turf.buffer(line, distance, { units: 'meters', steps: 8 }) : turf.buffer(line, 1, { units: 'meters', steps: 4 });
  const corridorBbox = turf.bbox(corridor);

  const candidates = [];
  for (const f of buildingsAll.features) {
    const bb = bboxOfFeature(f);
    if (!bb || !bboxIntersects(bb, corridorBbox)) continue;
    candidates.push(f);
  }

  let filtered = candidates;
  const canPreciseFilter = candidates.length <= 2500 && typeof turf.booleanIntersects === 'function';
  if (canPreciseFilter) {
    filtered = candidates.filter((f) => {
      try {
        return turf.booleanIntersects(f, corridor);
      } catch (e) {
        return true;
      }
    });
  }

  buildingsShownCount = filtered.length;
  const fc = { type: 'FeatureCollection', features: filtered };
  setBuildingsWireframeData(fc);
  runWhenReady(() => {
    ensureBuildingsLayer();
    map3d.getSource(BUILDINGS_SOURCE_ID).setData(fc);
  });
  return { total: buildingsAll.features.length, shown: buildingsShownCount };
}

export function getBuildings3DStats() {
  return { total: buildingsAll?.features?.length ?? 0, shown: buildingsShownCount };
}

export function getBuildingsShownGeoJSON() {
  return buildingsShownGeoJSON;
}

export function setBuildingsRenderMode(mode) {
  const next = mode === 'wire' ? 'wire' : 'solid';
  buildingsRenderMode = next;
  runWhenReady(() => {
    ensureBuildingsLayer();
    applyBuildingsRenderMode();
  });
}

function ensureRouteLayer() {
  if (!map3d) return;
  if (!map3d.getSource(ROUTE_SOURCE_ID)) {
    map3d.addSource(ROUTE_SOURCE_ID, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  }

  if (!map3d.getLayer(ROUTE_GLOW_LAYER_ID)) {
    map3d.addLayer({
      id: ROUTE_GLOW_LAYER_ID,
      type: 'line',
      source: ROUTE_SOURCE_ID,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': STREET_SCENE.routeGlow,
        'line-width': STREET_SCENE.routeGlowWidth,
        'line-opacity': STREET_SCENE.routeGlowOpacity,
        'line-blur': STREET_SCENE.routeGlowBlur
      }
    });
  }

  if (!map3d.getLayer(ROUTE_LAYER_ID)) {
    map3d.addLayer({
      id: ROUTE_LAYER_ID,
      type: 'line',
      source: ROUTE_SOURCE_ID,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': STREET_SCENE.routeLine,
        'line-width': STREET_SCENE.routeLineWidth,
        'line-opacity': STREET_SCENE.routeLineOpacity,
        'line-blur': 0.25
      }
    });
  }
}

function ensureRoadsLayer() {
  if (!map3d) return;
  if (!map3d.getSource(ROADS_SOURCE_ID)) {
    map3d.addSource(ROADS_SOURCE_ID, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  }
  if (!map3d.getSource(ROADS_CORRIDOR_SOURCE_ID)) {
    map3d.addSource(ROADS_CORRIDOR_SOURCE_ID, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  }

  const beforeId = map3d.getLayer(BUILDINGS_LAYER_ID) ? BUILDINGS_LAYER_ID : undefined;
  ensureRoadSurfaceLayer(beforeId);

  if (!map3d.getLayer(ROADS_LAYER_ID)) {
    map3d.addLayer(
      {
        id: ROADS_LAYER_ID,
        type: 'line',
        source: ROADS_SOURCE_ID,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': STREET_SCENE.roadLine,
          'line-width': 1.2,
          'line-opacity': STREET_SCENE.roadLineOpacity,
          'line-blur': 0.4
        }
      },
      beforeId
    );
  }

  if (!map3d.getLayer(ROADS_CORRIDOR_GLOW_LAYER_ID)) {
    map3d.addLayer(
      {
        id: ROADS_CORRIDOR_GLOW_LAYER_ID,
        type: 'line',
        source: ROADS_CORRIDOR_SOURCE_ID,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': STREET_SCENE.corridorGlow,
          'line-width': STREET_SCENE.corridorGlowWidth,
          'line-opacity': STREET_SCENE.corridorGlowOpacity,
          'line-blur': STREET_SCENE.corridorGlowBlur
        }
      },
      beforeId
    );
  }

  if (!map3d.getLayer(ROADS_CORRIDOR_LAYER_ID)) {
    map3d.addLayer(
      {
        id: ROADS_CORRIDOR_LAYER_ID,
        type: 'line',
        source: ROADS_CORRIDOR_SOURCE_ID,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': STREET_SCENE.corridorLine,
          'line-width': STREET_SCENE.corridorLineWidth,
          'line-opacity': STREET_SCENE.corridorLineOpacity,
          'line-blur': 0.25
        }
      },
      beforeId
    );
  }
}

function ensureRoadSurfaceLayer(beforeId) {
  if (!map3d) return;
  if (!map3d.getSource(ROAD_SURFACE_SOURCE_ID)) {
    map3d.addSource(ROAD_SURFACE_SOURCE_ID, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  }

  const before = beforeId ?? (map3d.getLayer(BUILDINGS_LAYER_ID) ? BUILDINGS_LAYER_ID : undefined);

  if (!map3d.getLayer(ROAD_SURFACE_FILL_LAYER_ID)) {
    map3d.addLayer(
      {
        id: ROAD_SURFACE_FILL_LAYER_ID,
        type: 'fill',
        source: ROAD_SURFACE_SOURCE_ID,
        paint: {
          'fill-color': STREET_SCENE.roadFill,
          'fill-opacity': STREET_SCENE.roadFillOpacity
        }
      },
      before
    );
  }

  if (!map3d.getLayer(ROAD_SURFACE_GLOW_LAYER_ID)) {
    map3d.addLayer(
      {
        id: ROAD_SURFACE_GLOW_LAYER_ID,
        type: 'line',
        source: ROAD_SURFACE_SOURCE_ID,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': STREET_SCENE.roadGlow,
          'line-width': STREET_SCENE.roadGlowWidth,
          'line-opacity': STREET_SCENE.roadGlowOpacity,
          'line-blur': STREET_SCENE.roadGlowBlur
        }
      },
      before
    );
  }

  if (!map3d.getLayer(ROAD_SURFACE_OUTLINE_LAYER_ID)) {
    map3d.addLayer(
      {
        id: ROAD_SURFACE_OUTLINE_LAYER_ID,
        type: 'line',
        source: ROAD_SURFACE_SOURCE_ID,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': STREET_SCENE.roadOutline,
          'line-width': STREET_SCENE.roadOutlineWidth,
          'line-opacity': STREET_SCENE.roadOutlineOpacity,
          'line-blur': STREET_SCENE.roadOutlineBlur
        }
      },
      before
    );
  }
}

function ensureTruckLayer() {
  if (!map3d) return;
  if (!map3d.getSource(TRUCK_SOURCE_ID)) {
    map3d.addSource(TRUCK_SOURCE_ID, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  }

  if (!map3d.getLayer(TRUCK_LAYER_ID)) {
    map3d.addLayer({
      id: TRUCK_LAYER_ID,
      type: 'fill-extrusion',
      source: TRUCK_SOURCE_ID,
      paint: {
        'fill-extrusion-color': TRUCK_COLOR_EXPR,
        'fill-extrusion-opacity': 0.94,
        'fill-extrusion-base': 0,
        'fill-extrusion-height': ['get', 'h'],
        'fill-extrusion-vertical-gradient': true
      }
    });
  }

  if (!map3d.getLayer(TRUCK_OUTLINE_LAYER_ID)) {
    map3d.addLayer({
      id: TRUCK_OUTLINE_LAYER_ID,
      type: 'line',
      source: TRUCK_SOURCE_ID,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': TRUCK_OUTLINE_EXPR,
        'line-width': 1.6,
        'line-opacity': 0.9,
        'line-blur': 0.15
      }
    });
  }
}

function ensureBuildingsLayer() {
  if (!map3d) return;
  if (!map3d.getSource(BUILDINGS_SOURCE_ID)) {
    map3d.addSource(BUILDINGS_SOURCE_ID, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  }

  if (!map3d.getLayer(BUILDINGS_LAYER_ID)) {
    map3d.addLayer({
      id: BUILDINGS_LAYER_ID,
      type: 'fill-extrusion',
      source: BUILDINGS_SOURCE_ID,
      paint: {
        'fill-extrusion-color': BUILDING_COLOR_EXPR,
        'fill-extrusion-opacity': 0.88,
        'fill-extrusion-base': 0,
        'fill-extrusion-height': ['get', 'h'],
        'fill-extrusion-vertical-gradient': true
      }
    });
  }

  ensureBuildingsWireframeLayer();
  applyBuildingsRenderMode();
}

function ensureObstaclesLayer() {
  if (!map3d) return;
  if (!map3d.getSource(OBSTACLES_SOURCE_ID)) {
    map3d.addSource(OBSTACLES_SOURCE_ID, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  }

  if (!map3d.getLayer(OBSTACLES_LAYER_ID)) {
    map3d.addLayer({
      id: OBSTACLES_LAYER_ID,
      type: 'fill-extrusion',
      source: OBSTACLES_SOURCE_ID,
      paint: {
        'fill-extrusion-color': '#f472b6',
        'fill-extrusion-opacity': 0.88,
        'fill-extrusion-base': 0,
        'fill-extrusion-height': ['get', 'h'],
        'fill-extrusion-vertical-gradient': true
      }
    });
  }

  if (!map3d.getLayer(OBSTACLES_GLOW_LAYER_ID)) {
    map3d.addLayer({
      id: OBSTACLES_GLOW_LAYER_ID,
      type: 'line',
      source: OBSTACLES_SOURCE_ID,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#f472b6',
        'line-width': 6,
        'line-opacity': 0.55,
        'line-blur': 5.5
      }
    });
  }

  if (!map3d.getLayer(OBSTACLES_OUTLINE_LAYER_ID)) {
    map3d.addLayer({
      id: OBSTACLES_OUTLINE_LAYER_ID,
      type: 'line',
      source: OBSTACLES_SOURCE_ID,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#fecdd3',
        'line-width': 2.2,
        'line-opacity': 0.9,
        'line-blur': 0.08
      }
    });
  }
}

function applyBuildingsRenderMode() {
  if (!map3d) return;
  if (!map3d.getLayer(BUILDINGS_LAYER_ID)) return;

  buildingsWireframeStyle.enabled = false;
  try {
    map3d.setPaintProperty(BUILDINGS_LAYER_ID, 'fill-extrusion-color', BUILDING_COLOR_EXPR);
    map3d.setPaintProperty(BUILDINGS_LAYER_ID, 'fill-extrusion-opacity', 0.88);
  } catch (e) {}
}

function applyBuildingsWireframeStyle(mode) {
  buildingsWireframeStyle.enabled = true;
  if (mode === 'wire') {
    buildingsWireframeStyle.coreWidthPx = 2.2;
    buildingsWireframeStyle.glowWidthPx = 11.0;
    buildingsWireframeStyle.coreOpacity = 0.92;
    buildingsWireframeStyle.glowOpacity = 0.22;
    return;
  }
  buildingsWireframeStyle.coreWidthPx = 1.6;
  buildingsWireframeStyle.glowWidthPx = 8.0;
  buildingsWireframeStyle.coreOpacity = 0.72;
  buildingsWireframeStyle.glowOpacity = 0.16;
}

function setBuildingsWireframeData(fc) {
  buildingsShownGeoJSON = fc && fc.type === 'FeatureCollection' ? fc : { type: 'FeatureCollection', features: [] };
  buildingsWireframeVertices = buildBuildingsWireframeVertexData(buildingsShownGeoJSON);
  buildingsWireframeVertexCount = buildingsWireframeVertices.length / 8;
  buildingsWireframeVersion = (buildingsWireframeVersion + 1) % Number.MAX_SAFE_INTEGER;
}

function buildBuildingsWireframeVertexData(fc) {
  const features = fc?.features;
  if (!Array.isArray(features) || features.length === 0) return new Float32Array(0);
  if (!maplibregl?.MercatorCoordinate?.fromLngLat) return new Float32Array(0);

  const out = [];
  for (const f of features) {
    const g = f?.geometry;
    if (!g) continue;
    const h = Number(f?.properties?.h);
    if (!Number.isFinite(h) || h <= 0) continue;
    const topAlt = h + 0.05;

    if (g.type === 'Polygon') {
      appendWireframeForPolygonCoords(out, g.coordinates, topAlt);
      continue;
    }
    if (g.type === 'MultiPolygon') {
      for (const poly of g.coordinates || []) appendWireframeForPolygonCoords(out, poly, topAlt);
    }
  }
  return new Float32Array(out);
}

function appendWireframeForPolygonCoords(out, polygonCoords, topAltMeters) {
  const ring = polygonCoords?.[0];
  const pts = normalizeRingLngLat(ring);
  const n = pts.length;
  if (n < 3) return;

  const base = new Array(n);
  const top = new Array(n);
  for (let i = 0; i < n; i++) {
    const [lng, lat] = pts[i];
    base[i] = maplibregl.MercatorCoordinate.fromLngLat({ lng, lat }, 0);
    top[i] = maplibregl.MercatorCoordinate.fromLngLat({ lng, lat }, topAltMeters);
  }

  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    appendSegmentQuad(out, top[i], top[j]);
  }

  for (let i = 0; i < n; i++) {
    appendSegmentQuad(out, base[i], top[i]);
  }
}

function normalizeRingLngLat(ringCoords) {
  if (!Array.isArray(ringCoords) || ringCoords.length < 3) return [];
  const pts = [];
  for (const pt of ringCoords) {
    const lng = Number(pt?.[0]);
    const lat = Number(pt?.[1]);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
    pts.push([lng, lat]);
  }
  if (pts.length >= 2) {
    const a = pts[0];
    const b = pts[pts.length - 1];
    if (a[0] === b[0] && a[1] === b[1]) pts.pop();
  }
  return pts;
}

function appendSegmentQuad(out, a, b) {
  if (!a || !b) return;
  const ax = a.x;
  const ay = a.y;
  const az = a.z;
  const bx = b.x;
  const by = b.y;
  const bz = b.z;
  if (![ax, ay, az, bx, by, bz].every(Number.isFinite)) return;
  const dx = ax - bx;
  const dy = ay - by;
  const dz = az - bz;
  if (dx * dx + dy * dy + dz * dz < 1e-18) return;

  out.push(ax, ay, az, bx, by, bz, -1, 0);
  out.push(ax, ay, az, bx, by, bz, 1, 0);
  out.push(ax, ay, az, bx, by, bz, 1, 1);
  out.push(ax, ay, az, bx, by, bz, -1, 0);
  out.push(ax, ay, az, bx, by, bz, 1, 1);
  out.push(ax, ay, az, bx, by, bz, -1, 1);
}

function ensureBuildingsWireframeLayer() {
  if (!map3d) return;
  if (map3d.getLayer(BUILDINGS_WIREFRAME_LAYER_ID)) return;
  try {
    map3d.addLayer(createBuildingsWireframeLayer());
  } catch (e) {}
}

function createBuildingsWireframeLayer() {
  const vert = `
precision highp float;
uniform mat4 u_matrix;
uniform vec2 u_viewport;
uniform float u_halfWidth;
attribute vec3 a_start;
attribute vec3 a_end;
attribute float a_side;
attribute float a_t;
varying float v_u;
void main() {
  vec4 clipStart = u_matrix * vec4(a_start, 1.0);
  vec4 clipEnd = u_matrix * vec4(a_end, 1.0);

  // Avoid streaks when segments cross behind the camera / near plane.
  float eps = 0.001;
  if (clipStart.w < eps && clipEnd.w < eps) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    v_u = 0.0;
    return;
  }
  if (clipStart.w < eps) {
    float t = (eps - clipStart.w) / (clipEnd.w - clipStart.w);
    t = clamp(t, 0.0, 1.0);
    clipStart = mix(clipStart, clipEnd, t);
  }
  if (clipEnd.w < eps) {
    float t = (eps - clipEnd.w) / (clipStart.w - clipEnd.w);
    t = clamp(t, 0.0, 1.0);
    clipEnd = mix(clipEnd, clipStart, t);
  }
  vec2 ndcStart = clipStart.xy / clipStart.w;
  vec2 ndcEnd = clipEnd.xy / clipEnd.w;

  vec2 screenStart = (ndcStart * 0.5 + 0.5) * u_viewport;
  vec2 screenEnd = (ndcEnd * 0.5 + 0.5) * u_viewport;
  vec2 dir = screenEnd - screenStart;
  float len = length(dir);
  vec2 dirNorm = len > 0.0001 ? (dir / len) : vec2(0.0, 1.0);
  vec2 perp = vec2(-dirNorm.y, dirNorm.x);

  vec2 offsetScreen = perp * a_side * u_halfWidth;
  vec2 offsetNdc = (offsetScreen / u_viewport) * 2.0;

  vec4 clipPos = mix(clipStart, clipEnd, a_t);
  clipPos.xy += offsetNdc * clipPos.w;
  gl_Position = clipPos;
  v_u = a_side;
}
`;

  const frag = `
precision mediump float;
uniform vec4 u_color;
varying float v_u;
void main() {
  float d = abs(v_u);
  float fade = 1.0 - smoothstep(0.0, 1.0, d);
  float a = u_color.a * fade;
  gl_FragColor = vec4(u_color.rgb * a, a);
}
`;

  return {
    id: BUILDINGS_WIREFRAME_LAYER_ID,
    type: 'custom',
    renderingMode: '3d',
    _map: null,
    _gl: null,
    _program: null,
    _buffer: null,
    _vao: null,
    _vaoExt: null,
    _version: -1,
    _vertexCount: 0,
    _aStart: -1,
    _aEnd: -1,
    _aSide: -1,
    _aT: -1,
    _uMatrix: null,
    _uViewport: null,
    _uHalfWidth: null,
    _uColor: null,
    onAdd(map, gl) {
      this._map = map;
      this._gl = gl;
      this._program = createProgram(gl, vert, frag);
      if (!this._program) return;
      this._buffer = gl.createBuffer();
      this._aStart = gl.getAttribLocation(this._program, 'a_start');
      this._aEnd = gl.getAttribLocation(this._program, 'a_end');
      this._aSide = gl.getAttribLocation(this._program, 'a_side');
      this._aT = gl.getAttribLocation(this._program, 'a_t');
      this._uMatrix = gl.getUniformLocation(this._program, 'u_matrix');
      this._uViewport = gl.getUniformLocation(this._program, 'u_viewport');
      this._uHalfWidth = gl.getUniformLocation(this._program, 'u_halfWidth');
      this._uColor = gl.getUniformLocation(this._program, 'u_color');

      try {
        const stride = 8 * 4;
        const canVao = typeof gl.createVertexArray === 'function' && typeof gl.bindVertexArray === 'function';
        const vaoExt = !canVao ? gl.getExtension('OES_vertex_array_object') : null;

        const prevArrayBuffer = gl.getParameter(gl.ARRAY_BUFFER_BINDING);
        let prevVao = null;
        if (canVao && typeof gl.VERTEX_ARRAY_BINDING !== 'undefined') prevVao = gl.getParameter(gl.VERTEX_ARRAY_BINDING);
        if (vaoExt && typeof vaoExt.VERTEX_ARRAY_BINDING_OES !== 'undefined') prevVao = gl.getParameter(vaoExt.VERTEX_ARRAY_BINDING_OES);

        if (canVao) {
          this._vao = gl.createVertexArray();
          gl.bindVertexArray(this._vao);
        } else if (vaoExt) {
          this._vaoExt = vaoExt;
          this._vao = vaoExt.createVertexArrayOES();
          vaoExt.bindVertexArrayOES(this._vao);
        }

        if (this._vao) {
          gl.bindBuffer(gl.ARRAY_BUFFER, this._buffer);
          if (this._aStart >= 0) {
            gl.enableVertexAttribArray(this._aStart);
            gl.vertexAttribPointer(this._aStart, 3, gl.FLOAT, false, stride, 0);
          }
          if (this._aEnd >= 0) {
            gl.enableVertexAttribArray(this._aEnd);
            gl.vertexAttribPointer(this._aEnd, 3, gl.FLOAT, false, stride, 3 * 4);
          }
          if (this._aSide >= 0) {
            gl.enableVertexAttribArray(this._aSide);
            gl.vertexAttribPointer(this._aSide, 1, gl.FLOAT, false, stride, 6 * 4);
          }
          if (this._aT >= 0) {
            gl.enableVertexAttribArray(this._aT);
            gl.vertexAttribPointer(this._aT, 1, gl.FLOAT, false, stride, 7 * 4);
          }
        }

        if (canVao) gl.bindVertexArray(prevVao);
        if (vaoExt) vaoExt.bindVertexArrayOES(prevVao);
        gl.bindBuffer(gl.ARRAY_BUFFER, prevArrayBuffer);
      } catch (e) {}
    },
    render(gl, matrix) {
      if (!buildingsWireframeStyle.enabled) return;
      if (!this._program || !this._buffer) return;

      const canVao = typeof gl.bindVertexArray === 'function' && typeof gl.VERTEX_ARRAY_BINDING !== 'undefined';
      const prev = {
        program: gl.getParameter(gl.CURRENT_PROGRAM),
        arrayBuffer: gl.getParameter(gl.ARRAY_BUFFER_BINDING),
        elementArrayBuffer: gl.getParameter(gl.ELEMENT_ARRAY_BUFFER_BINDING),
        blendEnabled: gl.isEnabled(gl.BLEND),
        depthTestEnabled: gl.isEnabled(gl.DEPTH_TEST),
        depthMask: gl.getParameter(gl.DEPTH_WRITEMASK),
        depthFunc: gl.getParameter(gl.DEPTH_FUNC),
        stencilTestEnabled: gl.isEnabled(gl.STENCIL_TEST),
        scissorTestEnabled: gl.isEnabled(gl.SCISSOR_TEST),
        cullFaceEnabled: gl.isEnabled(gl.CULL_FACE),
        blendSrcRGB: gl.getParameter(gl.BLEND_SRC_RGB),
        blendDstRGB: gl.getParameter(gl.BLEND_DST_RGB),
        blendSrcAlpha: gl.getParameter(gl.BLEND_SRC_ALPHA),
        blendDstAlpha: gl.getParameter(gl.BLEND_DST_ALPHA),
        colorMask: gl.getParameter(gl.COLOR_WRITEMASK),
        viewport: gl.getParameter(gl.VIEWPORT),
        scissorBox: gl.getParameter(gl.SCISSOR_BOX),
        stencilWriteMask: gl.getParameter(gl.STENCIL_WRITEMASK),
        stencilBackWriteMask: gl.getParameter(gl.STENCIL_BACK_WRITEMASK),
        vao: null
      };
      if (this._vaoExt && typeof this._vaoExt.VERTEX_ARRAY_BINDING_OES !== 'undefined') {
        prev.vao = gl.getParameter(this._vaoExt.VERTEX_ARRAY_BINDING_OES);
      } else if (canVao) {
        prev.vao = gl.getParameter(gl.VERTEX_ARRAY_BINDING);
      }

      try {
        if (this._version !== buildingsWireframeVersion) {
          this._version = buildingsWireframeVersion;
          this._vertexCount = buildingsWireframeVertexCount;
          gl.bindBuffer(gl.ARRAY_BUFFER, this._buffer);
          gl.bufferData(gl.ARRAY_BUFFER, buildingsWireframeVertices, gl.STATIC_DRAW);
        }

        if (!this._vertexCount) return;

        const canvas = this._map?.getCanvas?.();
        const cssW = Math.max(1, Number(canvas?.clientWidth ?? 0) || gl.drawingBufferWidth);
        const pxRatio = gl.drawingBufferWidth / cssW;

        // Avoid tile/clip state bleeding (stencil/scissor) causing partial redraw "ghosting".
        try {
          gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
        } catch (e) {}
        try {
          gl.disable(gl.SCISSOR_TEST);
        } catch (e) {}
        try {
          gl.disable(gl.STENCIL_TEST);
          if (typeof gl.stencilMaskSeparate === 'function') {
            gl.stencilMaskSeparate(gl.FRONT, 0);
            gl.stencilMaskSeparate(gl.BACK, 0);
          } else {
            gl.stencilMask(0);
          }
        } catch (e) {}
        try {
          gl.colorMask(true, true, true, true);
        } catch (e) {}

        gl.useProgram(this._program);
        gl.uniformMatrix4fv(this._uMatrix, false, matrix);
        gl.uniform2f(this._uViewport, gl.drawingBufferWidth, gl.drawingBufferHeight);

        if (this._vao) {
          if (this._vaoExt) this._vaoExt.bindVertexArrayOES(this._vao);
          else gl.bindVertexArray(this._vao);
        } else {
          gl.bindBuffer(gl.ARRAY_BUFFER, this._buffer);
          const stride = 8 * 4;
          if (this._aStart >= 0) gl.enableVertexAttribArray(this._aStart);
          if (this._aEnd >= 0) gl.enableVertexAttribArray(this._aEnd);
          if (this._aSide >= 0) gl.enableVertexAttribArray(this._aSide);
          if (this._aT >= 0) gl.enableVertexAttribArray(this._aT);
          if (this._aStart >= 0) gl.vertexAttribPointer(this._aStart, 3, gl.FLOAT, false, stride, 0);
          if (this._aEnd >= 0) gl.vertexAttribPointer(this._aEnd, 3, gl.FLOAT, false, stride, 3 * 4);
          if (this._aSide >= 0) gl.vertexAttribPointer(this._aSide, 1, gl.FLOAT, false, stride, 6 * 4);
          if (this._aT >= 0) gl.vertexAttribPointer(this._aT, 1, gl.FLOAT, false, stride, 7 * 4);
        }

        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LEQUAL);
        gl.depthMask(false);
        gl.enable(gl.BLEND);
        gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        try {
          gl.disable(gl.CULL_FACE);
        } catch (e) {}

        const glowHalf = (Math.max(0.1, buildingsWireframeStyle.glowWidthPx) * pxRatio) / 2;
        gl.uniform1f(this._uHalfWidth, glowHalf);
        gl.uniform4f(
          this._uColor,
          buildingsWireframeStyle.glowColor[0],
          buildingsWireframeStyle.glowColor[1],
          buildingsWireframeStyle.glowColor[2],
          buildingsWireframeStyle.glowOpacity
        );
        gl.drawArrays(gl.TRIANGLES, 0, this._vertexCount);

        const coreHalf = (Math.max(0.1, buildingsWireframeStyle.coreWidthPx) * pxRatio) / 2;
        gl.uniform1f(this._uHalfWidth, coreHalf);
        gl.uniform4f(
          this._uColor,
          buildingsWireframeStyle.coreColor[0],
          buildingsWireframeStyle.coreColor[1],
          buildingsWireframeStyle.coreColor[2],
          buildingsWireframeStyle.coreOpacity
        );
        gl.drawArrays(gl.TRIANGLES, 0, this._vertexCount);
      } finally {
        try {
          if (this._vao) {
            if (this._vaoExt) this._vaoExt.bindVertexArrayOES(prev.vao);
            else gl.bindVertexArray(prev.vao);
          } else {
            if (this._aStart >= 0) gl.disableVertexAttribArray(this._aStart);
            if (this._aEnd >= 0) gl.disableVertexAttribArray(this._aEnd);
            if (this._aSide >= 0) gl.disableVertexAttribArray(this._aSide);
            if (this._aT >= 0) gl.disableVertexAttribArray(this._aT);
          }
        } catch (e) {}

        try {
          gl.useProgram(prev.program);
          gl.bindBuffer(gl.ARRAY_BUFFER, prev.arrayBuffer);
          gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, prev.elementArrayBuffer);
        } catch (e) {}

        try {
          gl.depthMask(prev.depthMask);
          gl.depthFunc(prev.depthFunc);
          if (prev.depthTestEnabled) gl.enable(gl.DEPTH_TEST);
          else gl.disable(gl.DEPTH_TEST);
        } catch (e) {}

        try {
          gl.blendFuncSeparate(prev.blendSrcRGB, prev.blendDstRGB, prev.blendSrcAlpha, prev.blendDstAlpha);
          if (prev.blendEnabled) gl.enable(gl.BLEND);
          else gl.disable(gl.BLEND);
        } catch (e) {}

        try {
          gl.colorMask(!!prev.colorMask?.[0], !!prev.colorMask?.[1], !!prev.colorMask?.[2], !!prev.colorMask?.[3]);
        } catch (e) {}
        try {
          gl.viewport(prev.viewport?.[0] ?? 0, prev.viewport?.[1] ?? 0, prev.viewport?.[2] ?? gl.drawingBufferWidth, prev.viewport?.[3] ?? gl.drawingBufferHeight);
        } catch (e) {}
        try {
          gl.scissor(prev.scissorBox?.[0] ?? 0, prev.scissorBox?.[1] ?? 0, prev.scissorBox?.[2] ?? gl.drawingBufferWidth, prev.scissorBox?.[3] ?? gl.drawingBufferHeight);
          if (prev.scissorTestEnabled) gl.enable(gl.SCISSOR_TEST);
          else gl.disable(gl.SCISSOR_TEST);
        } catch (e) {}
        try {
          if (typeof gl.stencilMaskSeparate === 'function') {
            gl.stencilMaskSeparate(gl.FRONT, prev.stencilWriteMask);
            gl.stencilMaskSeparate(gl.BACK, prev.stencilBackWriteMask);
          } else {
            gl.stencilMask(prev.stencilWriteMask);
          }
          if (prev.stencilTestEnabled) gl.enable(gl.STENCIL_TEST);
          else gl.disable(gl.STENCIL_TEST);
        } catch (e) {}
        try {
          if (prev.cullFaceEnabled) gl.enable(gl.CULL_FACE);
          else gl.disable(gl.CULL_FACE);
        } catch (e) {}
      }
    },
    onRemove(map, gl) {
      try {
        if (this._vao) {
          if (this._vaoExt) this._vaoExt.deleteVertexArrayOES(this._vao);
          else if (typeof gl.deleteVertexArray === 'function') gl.deleteVertexArray(this._vao);
        }
      } catch (e) {}
      try {
        if (this._buffer) gl.deleteBuffer(this._buffer);
      } catch (e) {}
      try {
        if (this._program) gl.deleteProgram(this._program);
      } catch (e) {}
      this._buffer = null;
      this._vao = null;
      this._vaoExt = null;
      this._program = null;
      this._map = null;
      this._gl = null;
    }
  };
}

function createProgram(gl, vertSource, fragSource) {
  const vert = compileShader(gl, gl.VERTEX_SHADER, vertSource);
  const frag = compileShader(gl, gl.FRAGMENT_SHADER, fragSource);
  if (!vert || !frag) return null;
  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vert);
  gl.attachShader(program, frag);
  gl.linkProgram(program);
  gl.deleteShader(vert);
  gl.deleteShader(frag);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    try {
      gl.deleteProgram(program);
    } catch (e) {}
    return null;
  }
  return program;
}

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    try {
      gl.deleteShader(shader);
    } catch (e) {}
    return null;
  }
  return shader;
}

function applySceneEffects() {
  if (!map3d) return;
  try {
    if (typeof map3d.setMaxPitch === 'function') map3d.setMaxPitch(80);
  } catch (e) {}

  try {
    if (typeof map3d.setLight === 'function') {
      map3d.setLight({
        anchor: 'map',
        color: '#f8fbff',
        intensity: 0.6,
        position: [1.2, 160, 65]
      });
    }
  } catch (e) {}

  try {
    if (typeof map3d.setFog === 'function') {
      map3d.setFog({
        range: [0.6, 8.5],
        color: 'rgba(195, 213, 232, 0.65)',
        'high-color': 'rgba(245, 249, 255, 0.9)',
        'horizon-blend': 0.28,
        'space-color': 'rgba(190, 205, 223, 0.9)',
        'star-intensity': 0
      });
    }
  } catch (e) {}

  try {
    if (typeof map3d.setSky === 'function') {
      map3d.setSky({
        'sky-type': 'gradient',
        'sky-gradient': ['interpolate', ['linear'], ['sky-radial-progress'], 0.8, '#b9d6f1', 1, '#ffffff'],
        'sky-gradient-center': [0, 0],
        'sky-gradient-radius': 1.05,
        'sky-opacity': 0.85
      });
    }
  } catch (e) {}
}

function normalizeBuildingsGeoJSON(geojson, { defaultHeight = 10 } = {}) {
  if (!geojson) return { type: 'FeatureCollection', features: [] };
  const fc = asFeatureCollection(geojson);
  const out = [];
  for (const f of fc.features || []) {
    const nf = normalizeBuildingFeature(f, { defaultHeight });
    if (nf) out.push(nf);
  }
  return { type: 'FeatureCollection', features: out };
}

function normalizeObstacleGeoJSON(geojson, { defaultHeight = 3 } = {}) {
  if (!geojson) return { type: 'FeatureCollection', features: [] };
  const fc = asFeatureCollection(geojson);
  const out = [];
  for (const f of fc.features || []) {
    const nf = normalizeObstacleFeature(f, { defaultHeight });
    if (nf) out.push(nf);
  }
  return { type: 'FeatureCollection', features: out };
}

function asFeatureCollection(geojson) {
  if (geojson.type === 'FeatureCollection') return geojson;
  if (geojson.type === 'Feature') return { type: 'FeatureCollection', features: [geojson] };
  if (geojson.type === 'Polygon' || geojson.type === 'MultiPolygon') {
    return { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: geojson }] };
  }
  throw new Error(`Unsupported GeoJSON type: ${geojson.type}`);
}

function normalizeBuildingFeature(feature, { defaultHeight = 10 } = {}) {
  if (!feature || feature.type !== 'Feature' || !feature.geometry) return null;
  const g = feature.geometry;
  if (g.type !== 'Polygon' && g.type !== 'MultiPolygon') return null;
  const props = feature.properties && typeof feature.properties === 'object' ? feature.properties : {};
  const h = coerceHeightMeters(props, defaultHeight);
  return { ...feature, properties: { ...props, h } };
}

function normalizeObstacleFeature(feature, { defaultHeight = 3 } = {}) {
  if (!feature || feature.type !== 'Feature' || !feature.geometry) return null;
  const g = feature.geometry;
  if (g.type !== 'Polygon' && g.type !== 'MultiPolygon') return null;
  const props = feature.properties && typeof feature.properties === 'object' ? feature.properties : {};
  const raw = props.h ?? props.height ?? props.Height;
  const h = Number.isFinite(Number(raw)) ? Number(raw) : defaultHeight;
  return { ...feature, properties: { ...props, h: clampHeight(h) } };
}

function coerceHeightMeters(props, fallback) {
  const tryNumber = (v) => {
    if (v == null) return null;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') {
      const m = v.match(/-?\d+(\.\d+)?/);
      if (!m) return null;
      const n = Number(m[0]);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  };

  const keys = ['height', 'Height', 'building:height', 'h', 'H', 'height_m', 'height_meters', 'HEIGHT'];
  for (const k of keys) {
    const n = tryNumber(props[k]);
    if (n != null) return clampHeight(n);
  }

  const levels = tryNumber(props.levels ?? props['building:levels'] ?? props.floors ?? props.storeys);
  if (levels != null) return clampHeight(levels * 3.0);

  return clampHeight(fallback);
}

function clampHeight(h) {
  const v = Number(h);
  if (!Number.isFinite(v)) return 10;
  return Math.max(1.0, Math.min(350.0, v));
}

function normalizeBearingDeg(b) {
  let v = b % 360;
  if (v < 0) v += 360;
  return v;
}

function normalizeAngleRad(a) {
  let v = a % (Math.PI * 2);
  if (v > Math.PI) v -= Math.PI * 2;
  if (v < -Math.PI) v += Math.PI * 2;
  return v;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function lerpAngleRad(a, b, t) {
  const d = normalizeAngleRad(b - a);
  return normalizeAngleRad(a + d * t);
}

function interpolatePose(a, b, t) {
  if (!a && !b) return null;
  if (!a) return b;
  if (!b) return a;
  return {
    x: lerp(a.x, b.x, t),
    y: lerp(a.y, b.y, t),
    theta: lerpAngleRad(a.theta, b.theta, t)
  };
}

function buildTruckRing(pose, vehicleConfig) {
  const wheelBase = Number(vehicleConfig?.wheelBase ?? 3.4);
  const vehicleWidth = Number(vehicleConfig?.vehicleWidth ?? 2.0);
  const frontOverhang = Number(vehicleConfig?.frontOverhang ?? 1.1);
  const rearOverhang = Number(vehicleConfig?.rearOverhang ?? 1.7);
  const theta = Number(pose?.theta ?? 0);

  const corners = [
    { dx: wheelBase + frontOverhang, dy: vehicleWidth / 2 },
    { dx: wheelBase + frontOverhang, dy: -vehicleWidth / 2 },
    { dx: -rearOverhang, dy: -vehicleWidth / 2 },
    { dx: -rearOverhang, dy: vehicleWidth / 2 }
  ];
  const ring = corners.map((c) => {
    const x = pose.x + c.dx * Math.cos(theta) - c.dy * Math.sin(theta);
    const y = pose.y + c.dx * Math.sin(theta) + c.dy * Math.cos(theta);
    const ll = coordinateSystem.metersToLatLng(x, y);
    return [ll.lng, ll.lat];
  });
  ring.push(ring[0]);
  return ring;
}

function bboxIntersects(a, b) {
  return !(a[0] > b[2] || a[2] < b[0] || a[1] > b[3] || a[3] < b[1]);
}

function bboxOfFeature(feature) {
  const g = feature?.geometry;
  if (!g) return null;
  if (g.type === 'Polygon') return bboxOfPolygon(g.coordinates);
  if (g.type === 'MultiPolygon') return bboxOfMultiPolygon(g.coordinates);
  return null;
}

function bboxOfAnyFeature(feature) {
  const g = feature?.geometry;
  if (!g) return null;
  if (g.type === 'Polygon') return bboxOfPolygon(g.coordinates);
  if (g.type === 'MultiPolygon') return bboxOfMultiPolygon(g.coordinates);
  if (g.type === 'LineString') return bboxOfLineString(g.coordinates);
  if (g.type === 'MultiLineString') return bboxOfMultiLineString(g.coordinates);
  return null;
}

function bboxOfMultiLineString(coords) {
  let bb = null;
  for (const line of coords || []) {
    const cur = bboxOfLineString(line);
    bb = mergeBbox(bb, cur);
  }
  return bb;
}

function bboxOfLineString(coords) {
  let bb = null;
  for (const pt of coords || []) {
    const x = pt?.[0];
    const y = pt?.[1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (!bb) bb = [x, y, x, y];
    else {
      if (x < bb[0]) bb[0] = x;
      if (y < bb[1]) bb[1] = y;
      if (x > bb[2]) bb[2] = x;
      if (y > bb[3]) bb[3] = y;
    }
  }
  return bb;
}

function bboxOfMultiPolygon(coords) {
  let bb = null;
  for (const poly of coords || []) {
    const cur = bboxOfPolygon(poly);
    bb = mergeBbox(bb, cur);
  }
  return bb;
}

function bboxOfPolygon(coords) {
  let bb = null;
  for (const ring of coords || []) {
    for (const pt of ring || []) {
      const x = pt?.[0];
      const y = pt?.[1];
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (!bb) bb = [x, y, x, y];
      else {
        if (x < bb[0]) bb[0] = x;
        if (y < bb[1]) bb[1] = y;
        if (x > bb[2]) bb[2] = x;
        if (y > bb[3]) bb[3] = y;
      }
    }
  }
  return bb;
}

function mergeBbox(a, b) {
  if (!a) return b;
  if (!b) return a;
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}
