import { COLLISION_CONFIG } from '../config.js';
import { getViewer, onViewerReady } from './map3dTiles.js';

let viewer = null;
let dataSource = null;
let pending = null;

function getCesium() {
  return typeof Cesium !== 'undefined' ? Cesium : (window.Cesium || null);
}

function asFeatureArray(points) {
  if (!points) return [];
  if (Array.isArray(points)) return points;
  if (points.type === 'FeatureCollection') return points.features || [];
  if (points.type === 'Feature') return [points];
  if (points.type === 'Point') return [{ type: 'Feature', properties: {}, geometry: points }];
  return [];
}

function ensureDataSource() {
  const Cesium = getCesium();
  if (!viewer || !Cesium) return null;
  if (!dataSource) {
    dataSource = new Cesium.CustomDataSource('collisionOverlay');
    viewer.dataSources.add(dataSource);
  }
  return dataSource;
}

function clear() {
  if (dataSource) dataSource.entities.removeAll();
}

function render(points, opts = {}) {
  const Cesium = getCesium();
  if (!viewer || !Cesium) return;
  const ds = ensureDataSource();
  if (!ds) return;
  ds.entities.removeAll();

  const features = asFeatureArray(points);
  if (!features.length) return;

  const maxPoints = Number.isFinite(opts.maxPoints) ? opts.maxPoints : COLLISION_CONFIG.maxContactMarkers;
  const dangerColor = opts.dangerColor || COLLISION_CONFIG.dangerColor;
  const warningColor = opts.warningColor || COLLISION_CONFIG.warningColor;
  const radius = Number.isFinite(opts.markerRadius) ? opts.markerRadius : COLLISION_CONFIG.markerRadius;
  const height = Number.isFinite(opts.height) ? opts.height : 2;
  const use = maxPoints > 0 ? features.slice(0, maxPoints) : features;

  use.forEach((f) => {
    const coords = f?.geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) return;
    const [lng, lat] = coords;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    const reason = String(f?.properties?.reason ?? '').toLowerCase();
    const color = reason === 'road' ? warningColor : dangerColor;
    ds.entities.add({
      position: Cesium.Cartesian3.fromDegrees(lng, lat, height),
      point: {
        pixelSize: Math.max(6, Math.min(18, radius * 4)),
        color: Cesium.Color.fromCssColorString(color).withAlpha(0.9),
        outlineColor: Cesium.Color.BLACK.withAlpha(0.6),
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY
      }
    });
  });
}

export function initCollisionOverlay() {
  onViewerReady(() => {
    viewer = getViewer();
    ensureDataSource();
    if (pending) {
      render(pending.points, pending.opts);
      pending = null;
    }
  });
}

export function setCollisionOverlay(points, opts = {}) {
  if (!viewer) {
    pending = { points, opts };
    return;
  }
  render(points, opts);
}

export function clearCollisionOverlay() {
  pending = null;
  clear();
}

export function getCollisionOverlayStats() {
  const count = dataSource?.entities?.values?.length ?? 0;
  return { count };
}
