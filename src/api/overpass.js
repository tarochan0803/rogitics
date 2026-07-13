import { API_ENDPOINTS } from '../config.js';
import { fetchGsiRoads } from './gsi.js';
import { turf } from '../utils/geo.js';

const OSMTOGEOJSON_CDN = 'https://unpkg.com/osmtogeojson@3.0.0-beta.2/osmtogeojson.js';
const DEFAULT_TIMEOUT_MS = 25000;
const ENDPOINT_COOLDOWN_MS = 120000;
const endpointCooldownUntil = new Map();

async function ensureOsmToGeoJSON() {
  if (typeof globalThis.osmtogeojson === 'function') {
    return { osmtogeojson: globalThis.osmtogeojson };
  }
  await import(OSMTOGEOJSON_CDN);
  if (typeof globalThis.osmtogeojson !== 'function') {
    throw new Error('osmtogeojson failed to load');
  }
  return { osmtogeojson: globalThis.osmtogeojson };
}

function buildOverpassPayload(query) {
  const params = new URLSearchParams();
  params.set('data', query);
  return params.toString();
}

async function parseOverpassResponse(res) {
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`Overpass invalid JSON (${res.status})`);
  }
  if (data?.remark && /error|runtime|encoding/i.test(data.remark)) {
    throw new Error(`Overpass error: ${data.remark}`);
  }
  return data;
}

async function runOverpass(body) {
  const payload = buildOverpassPayload(body);
  const now = Date.now();
  const active = API_ENDPOINTS.OVERPASS.filter((url) => (endpointCooldownUntil.get(url) || 0) <= now);
  const urls = active.length ? active : API_ENDPOINTS.OVERPASS;
  const errors = [];

  for (const url of urls) {
    let timer = null;
    try {
      const controller = new AbortController();
      timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
      const res = await fetch(url, {
        method: 'POST',
        body: payload,
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
        }
      });
      if (!res.ok) {
        errors.push(`${url}: HTTP ${res.status}`);
        if (res.status === 429 || res.status >= 500) {
          endpointCooldownUntil.set(url, Date.now() + ENDPOINT_COOLDOWN_MS);
          console.warn(`[Overpass] skipped ${url}: HTTP ${res.status}`);
          continue;
        }
        throw new Error(`Overpass error: ${res.status}`);
      }
      return await parseOverpassResponse(res);
    } catch (err) {
      if (err.name === 'AbortError') {
        errors.push(`${url}: timeout`);
        endpointCooldownUntil.set(url, Date.now() + ENDPOINT_COOLDOWN_MS);
        console.warn(`[Overpass] timeout: ${url}`);
      } else {
        errors.push(`${url}: ${err.message}`);
        console.warn(`[Overpass] error: ${url}`, err.message);
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  throw new Error(`Road data fetch failed: Overpass did not respond. ${errors.slice(0, 3).join(' / ')}`);
}

function formatBBox(bounds) {
  const { south, west, north, east } = bounds;
  if ([south, west, north, east].some((v) => typeof v !== 'number' || Number.isNaN(v))) {
    throw new Error('Invalid bounds');
  }
  return `${south},${west},${north},${east}`;
}

function roadAndRegulationQuery(bounds) {
  const bbox = formatBBox(bounds);
  return `[out:json][timeout:20];
(
way["highway"~"^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|residential|living_street|service|track)$"]["area"!~"yes"](${bbox});
node["traffic_sign"~"^JP:3"](${bbox});
node["barrier"](${bbox});
node["highway"~"^(stop|give_way)$"](${bbox});
relation["type"~"^restriction"](${bbox});
);
out meta geom;`;
}

export async function fetchRoadGeoJSON(bounds) {
  const { roads } = await fetchRoadsAndSidewalks(bounds);
  return roads;
}

export async function fetchLatestRegulations(bounds, { force = false, managedOnly = false } = {}) {
  const query = roadAndRegulationQuery(bounds);
  let osmJson;
  try {
    osmJson = await runManagedRegulationRefresh(bounds, force);
  } catch (managedError) {
    if (managedOnly) throw managedError;
    console.warn('[regulation] managed snapshot unavailable, using direct Overpass:', managedError.message);
    osmJson = await runOverpass(query);
  }
  const { osmtogeojson } = await ensureOsmToGeoJSON();
  const geojson = osmtogeojson(osmJson);
  const lines = (geojson?.features || []).filter((feature) =>
    (feature?.geometry?.type === 'LineString' || feature?.geometry?.type === 'MultiLineString')
      && hasRegulationTags(feature)
  );
  return toFeatureCollection([...lines, ...rawRegulationFeatures(osmJson)]);
}

export { runOverpass };

function getTags(feature) {
  const props = feature?.properties;
  if (props && typeof props === 'object') return props.tags && typeof props.tags === 'object' ? props.tags : props;
  return {};
}

function hasRegulationTags(feature) {
  const tags = getTags(feature);
  return Object.keys(tags).some((key) =>
    /^(access|vehicle|motor_vehicle|motorcar|truck|hgv|goods|hazmat|oneway|maxheight|maxwidth|maxweight|maxweightrating|maxaxleload|maxlength|maxspeed|minspeed|school_zone|restriction|traffic_sign|toll|charge|construction|seasonal|winter_service|snowplowing|snow_chains|winter_equipment|parking|stopping)(:|$)/.test(key)
  );
}

function isFootPathHighway(highway) {
  return highway === 'footway' || highway === 'pedestrian' || highway === 'path' || highway === 'steps';
}

function isSidewalkFeature(feature) {
  const tags = getTags(feature);
  const highway = String(tags.highway ?? '');
  if (tags.footway === 'sidewalk') return true;
  if (isFootPathHighway(highway)) {
    if (highway === 'path') {
      const foot = String(tags.foot ?? '').toLowerCase();
      if (foot && foot !== 'no' && foot !== 'private') return true;
      return tags.footway === 'sidewalk';
    }
    return true;
  }
  return false;
}

function hasSidewalkTag(feature) {
  const tags = getTags(feature);
  const raw = tags.sidewalk ?? tags['sidewalk:left'] ?? tags['sidewalk:right'];
  if (!raw) return false;
  const v = String(raw).toLowerCase();
  return v !== 'no' && v !== 'none' && v !== 'false';
}

function isDrivableRoad(feature) {
  const tags = getTags(feature);
  const highway = String(tags.highway ?? '');
  if (!highway) return false;
  if (isFootPathHighway(highway)) return false;
  if (highway === 'cycleway') return false;
  return true;
}

function toFeatureCollection(features) {
  return { type: 'FeatureCollection', features };
}

async function runManagedRegulationRefresh(bounds, force = false) {
  const bbox = [bounds?.west, bounds?.south, bounds?.east, bounds?.north].map(Number);
  if (!bbox.every(Number.isFinite)) throw new Error('invalid regulation bbox');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS + 10000);
  try {
    const response = await fetch('/api/regulations/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bbox, force: !!force }),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`managed regulation refresh HTTP ${response.status}`);
    const payload = await response.json();
    if (!payload?.overpass || !Array.isArray(payload.overpass.elements)) {
      throw new Error('managed regulation snapshot is unavailable');
    }
    if (typeof window !== 'undefined') {
      window.REGULATION_BBOX = bbox.slice();
      window.REGULATION_FRESHNESS_PAYLOAD = payload;
      window.regulationFreshness?.setBbox?.(bbox);
      window.regulationFreshness?.renderPayload?.(payload);
    }
    return payload.overpass;
  } finally {
    clearTimeout(timer);
  }
}

function memberLineGeometry(member) {
  const coordinates = (member?.geometry || [])
    .map((point) => [Number(point.lon), Number(point.lat)])
    .filter((point) => point.every(Number.isFinite));
  return coordinates.length >= 2 ? { type: 'LineString', coordinates } : null;
}

function restrictionRelationFeature(element) {
  if (element?.type !== 'relation' || !String(element.tags?.type || '').startsWith('restriction')) return null;
  const fromMember = (element.members || []).find((member) => member.role === 'from');
  const toMember = (element.members || []).find((member) => member.role === 'to');
  const viaMember = (element.members || []).find((member) => member.role === 'via');
  const fromGeometry = memberLineGeometry(fromMember);
  const toGeometry = memberLineGeometry(toMember);
  let viaGeometry = memberLineGeometry(viaMember);
  if (!viaGeometry && Number.isFinite(Number(viaMember?.lon)) && Number.isFinite(Number(viaMember?.lat))) {
    viaGeometry = { type: 'Point', coordinates: [Number(viaMember.lon), Number(viaMember.lat)] };
  }
  const lines = [fromGeometry, toGeometry, viaGeometry]
    .filter((geometry) => geometry?.type === 'LineString')
    .map((geometry) => geometry.coordinates);
  if (!fromGeometry || !toGeometry || !lines.length) return null;
  return {
    type: 'Feature',
    id: `relation/${element.id}`,
    properties: {
      id: `relation/${element.id}`,
      tags: element.tags || {},
      source: 'OSM',
      updatedAt: element.timestamp || null,
      osmVersion: element.version ?? null,
      restrictionRelation: {
        restriction: element.tags?.['restriction:hgv'] || element.tags?.restriction || null,
        fromWayId: fromMember?.ref != null ? String(fromMember.ref) : null,
        toWayId: toMember?.ref != null ? String(toMember.ref) : null,
        viaId: viaMember?.ref != null ? String(viaMember.ref) : null,
        fromGeometry,
        toGeometry,
        viaGeometry
      }
    },
    geometry: { type: 'MultiLineString', coordinates: lines }
  };
}

function rawRegulationFeatures(overpassJson) {
  const features = [];
  for (const element of overpassJson?.elements || []) {
    const tags = element.tags || {};
    if (element.type === 'node') {
      const barrier = String(tags.barrier || '').toLowerCase();
      const relevantBarrier = [
        'bollard', 'block', 'bar', 'chain', 'jersey_barrier', 'barrier_board',
        'gate', 'lift_gate', 'swing_gate', 'sliding_gate', 'rising_bollard', 'toll_booth'
      ].includes(barrier) || ['no', 'private', 'destination'].includes(
        String(tags.motor_vehicle ?? tags.vehicle ?? tags.access ?? '').toLowerCase()
      );
      const isRegulationNode = /^JP:3/i.test(String(tags.traffic_sign || ''))
        || relevantBarrier
        || ['stop', 'give_way'].includes(String(tags.highway || '').toLowerCase());
      if (!isRegulationNode || !Number.isFinite(Number(element.lon)) || !Number.isFinite(Number(element.lat))) continue;
      features.push({
        type: 'Feature',
        id: `node/${element.id}`,
        properties: {
          id: `node/${element.id}`,
          tags,
          source: 'OSM',
          updatedAt: element.timestamp || null,
          osmVersion: element.version ?? null
        },
        geometry: { type: 'Point', coordinates: [Number(element.lon), Number(element.lat)] }
      });
    } else if (element.type === 'relation') {
      const feature = restrictionRelationFeature(element);
      if (feature) features.push(feature);
    }
  }
  return features;
}

function asLineStrings(feature) {
  const geom = feature?.geometry;
  if (!geom) return [];
  if (geom.type === 'LineString') return [geom.coordinates || []];
  if (geom.type === 'MultiLineString') return geom.coordinates || [];
  return [];
}

function featureBbox(feature) {
  try {
    return turf.bbox(feature);
  } catch (_e) {
    const coords = asLineStrings(feature).flat();
    if (!coords.length) return null;
    let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
    for (const c of coords) {
      const lng = Number(c?.[0]);
      const lat = Number(c?.[1]);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      west = Math.min(west, lng);
      south = Math.min(south, lat);
      east = Math.max(east, lng);
      north = Math.max(north, lat);
    }
    return Number.isFinite(west) ? [west, south, east, north] : null;
  }
}

function expandBboxMeters(bbox, meters = 12) {
  if (!bbox) return null;
  const midLat = (bbox[1] + bbox[3]) / 2;
  const dLat = meters / 111320;
  const dLng = meters / Math.max(1, 111320 * Math.cos(midLat * Math.PI / 180));
  return [bbox[0] - dLng, bbox[1] - dLat, bbox[2] + dLng, bbox[3] + dLat];
}

function bboxIntersects(a, b) {
  if (!a || !b) return true;
  return !(a[0] > b[2] || a[2] < b[0] || a[1] > b[3] || a[3] < b[1]);
}

function lineBearing(coords) {
  if (!coords || coords.length < 2) return null;
  const first = coords[0];
  const last = coords[coords.length - 1];
  try {
    const b = turf.bearing(turf.point(first), turf.point(last));
    return Number.isFinite(b) ? ((b + 360) % 360) : null;
  } catch (_e) {
    return null;
  }
}

function angleDelta(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  const d = Math.abs(a - b) % 180;
  return d > 90 ? 180 - d : d;
}

function sampleCoords(coords) {
  if (!coords || coords.length < 2) return [];
  return [
    coords[0],
    coords[Math.floor(coords.length / 2)],
    coords[coords.length - 1]
  ].filter(Boolean);
}

function distanceToFeatureMeters(coord, feature) {
  try {
    return turf.pointToLineDistance(turf.point(coord), feature, { units: 'meters' });
  } catch (_e) {
    return Infinity;
  }
}

function bestHybridMatch(gsiFeature, osmEntries) {
  const gsiLines = asLineStrings(gsiFeature).filter((line) => line.length >= 2);
  if (!gsiLines.length) return null;
  const gsiLine = gsiLines.sort((a, b) => b.length - a.length)[0];
  const gsiBbox = expandBboxMeters(featureBbox(gsiFeature), 14);
  const gsiBearing = lineBearing(gsiLine);
  const samples = sampleCoords(gsiLine);
  let best = null;

  for (const entry of osmEntries) {
    if (!bboxIntersects(gsiBbox, entry.bboxExpanded)) continue;
    const bearingDiff = angleDelta(gsiBearing, entry.bearing);
    if (bearingDiff > 28) continue;
    const distances = samples.map((coord) => distanceToFeatureMeters(coord, entry.feature));
    const avgDist = distances.reduce((sum, v) => sum + v, 0) / Math.max(1, distances.length);
    const maxDist = Math.max(...distances);
    if (!Number.isFinite(avgDist) || avgDist > 9 || maxDist > 18) continue;
    const score = avgDist + bearingDiff * 0.12;
    if (!best || score < best.score) best = { entry, score, avgDist, bearingDiff };
  }

  return best;
}

function mergeGsiWidthIntoOsm(osmFeature, gsiFeature, matchInfo) {
  const g = gsiFeature?.properties || {};
  const patch = {
    source: 'OSM+GSI',
    dataSources: ['osm', 'gsi'],
    gsiId: g.id || g.rID || null,
    gsiRnkWidth: g.gsiRnkWidth ?? g.rnkWidth ?? null,
    gsiWidthMin: g.gsiWidthMin ?? null,
    gsiWidthMax: g.gsiWidthMax ?? null,
    gsiWidthEstimate: g.gsiWidthEstimate ?? null,
    gsiWidthConfidence: g.gsiWidthConfidence ?? null,
    gsiWidthLabel: g.gsiWidthLabel ?? null,
    gsiMatchAvgDistM: Number(matchInfo?.avgDist?.toFixed?.(2) ?? matchInfo?.avgDist ?? 0),
    gsiMatchBearingDiffDeg: Number(matchInfo?.bearingDiff?.toFixed?.(1) ?? matchInfo?.bearingDiff ?? 0)
  };
  const props = osmFeature.properties || {};
  const nextProps = { ...props, ...patch };
  if (props.tags && typeof props.tags === 'object') {
    nextProps.tags = { ...props.tags, ...patch };
  }
  return { ...osmFeature, properties: nextProps };
}

function mergeHybridRoads(osmRoads = [], gsiRoads = []) {
  if (!osmRoads.length) return gsiRoads;
  if (!gsiRoads.length) return osmRoads;

  const merged = [...osmRoads];
  const entries = merged.map((feature, index) => {
    const lines = asLineStrings(feature).filter((line) => line.length >= 2);
    const line = lines.sort((a, b) => b.length - a.length)[0] || [];
    return {
      feature,
      index,
      bboxExpanded: expandBboxMeters(featureBbox(feature), 16),
      bearing: lineBearing(line)
    };
  });

  let matched = 0;
  for (const gsi of gsiRoads) {
    const match = bestHybridMatch(gsi, entries);
    if (match?.entry) {
      const idx = match.entry.index;
      merged[idx] = mergeGsiWidthIntoOsm(merged[idx], gsi, match);
      entries[idx].feature = merged[idx];
      matched++;
    } else {
      merged.push(gsi);
    }
  }

  if (matched) console.log(`[roads] hybrid merged GSI width into OSM: ${matched}/${gsiRoads.length}`);
  return merged;
}

export async function fetchRoadsAndSidewalks(bounds, dataSource = 'hybrid') {
  let osmRoads = [];
  let sidewalksArr = [];
  let regulationFeatures = [];

  // OSM繝・・繧ｿ縺ｮ蜿門ｾ・(osm 縺ｾ縺溘・ hybrid 縺ｮ蝣ｴ蜷・
  if (dataSource === 'osm' || dataSource === 'hybrid') {
    const body = roadAndRegulationQuery(bounds);
    try {
      let osmJson;
      try {
        osmJson = await runManagedRegulationRefresh(bounds);
      } catch (managedError) {
        console.warn('[regulation] managed refresh unavailable, using direct Overpass:', managedError.message);
        osmJson = await runOverpass(body);
      }
      const { osmtogeojson } = await ensureOsmToGeoJSON();
      const geojson = osmtogeojson(osmJson);
      const lineFeatures = (geojson?.features || []).filter(
        (f) => f.geometry && (f.geometry.type === 'LineString' || f.geometry.type === 'MultiLineString')
      );
      regulationFeatures = [...lineFeatures.filter(hasRegulationTags), ...rawRegulationFeatures(osmJson)];
      for (const f of lineFeatures) {
        if (isSidewalkFeature(f)) {
          sidewalksArr.push({ ...f, properties: { ...(f.properties || {}), kind: 'sidewalk' } });
          continue;
        }
        if (!isDrivableRoad(f)) continue;
        osmRoads.push(f);
        if (hasSidewalkTag(f)) {
          sidewalksArr.push({ ...f, properties: { ...(f.properties || {}), kind: 'sidewalk_hint' } });
        }
      }
    } catch (err) {
      console.warn('[fetchRoadsAndSidewalks] OSM fetch error:', err.message);
      if (dataSource === 'osm') throw err;
    }
  }

  // GSI繝・・繧ｿ縺ｮ蜿門ｾ・(gsi 縺ｾ縺溘・ hybrid 縺ｮ蝣ｴ蜷・
  let gsiRoads = [];
  if (dataSource === 'gsi' || dataSource === 'hybrid') {
    try {
      gsiRoads = await fetchGsiRoads(bounds);
    } catch (err) {
      console.warn('[fetchRoadsAndSidewalks] GSI fetch error:', err.message);
      if (dataSource === 'gsi') throw err;
    }
  }

  const mergedRoads = dataSource === 'hybrid'
    ? mergeHybridRoads(osmRoads, gsiRoads)
    : [...osmRoads, ...gsiRoads];
  
  if (mergedRoads.length === 0) {
    throw new Error('No road data was found in the selected area.');
  }

  return {
    roads: toFeatureCollection(mergedRoads),
    sidewalks: toFeatureCollection(sidewalksArr),
    regulations: toFeatureCollection(regulationFeatures)
  };
}

export async function fetchBuildings(bounds) {
  const bbox = formatBBox(bounds);
  const body = `[out:json][timeout:25];
(
  way["building"](${bbox});
  relation["building"](${bbox});
);
out body geom;`;
  const osmJson = await runOverpass(body);
  const { osmtogeojson } = await ensureOsmToGeoJSON();
  let geojson;
  try {
    geojson = osmtogeojson(osmJson);
  } catch (err) {
    console.error('[fetchBuildings] osmtogeojson 螟画鋤繧ｨ繝ｩ繝ｼ:', err.message);
    throw new Error(`蟒ｺ迚ｩ繝・・繧ｿ螟画鋤繧ｨ繝ｩ繝ｼ: ${err.message}`);
  }
  const rawFeatures = (geojson?.features || []).filter(f => 
    f.geometry && (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon')
  );
  
  const buildings = [];
  for (const f of rawFeatures) {
    try {
      const buffered = turf.buffer(f, 0.5, { units: 'meters', steps: 4 });
      if (buffered) {
        buildings.push({
          ...buffered,
          properties: {
            ...f.properties,
            type: 'building',
            height: f.properties['building:levels'] ? parseInt(f.properties['building:levels']) * 3 : 10
          }
        });
      }
    } catch(e) {
      buildings.push({
        ...f,
        properties: {
          ...f.properties,
          type: 'building',
          height: f.properties['building:levels'] ? parseInt(f.properties['building:levels']) * 3 : 10
        }
      });
    }
  }
  return { type: 'FeatureCollection', features: buildings };
}
