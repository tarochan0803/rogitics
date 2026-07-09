import { API_ENDPOINTS } from '../config.js';
import { fetchWithTimeout } from '../utils/fetchTimeout.js';

export async function searchPlace(query, { limit = 5, language = 'ja', countrycodes = 'jp' } = {}) {
  if (!query || !query.trim()) {
    throw new Error('query is empty');
  }
  const url = new URL(API_ENDPOINTS.NOMINATIM_SEARCH);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('addressdetails', '0');
  url.searchParams.set('accept-language', language);
  if (countrycodes) url.searchParams.set('countrycodes', countrycodes);
  url.searchParams.set('q', query.trim());

  const res = await fetchWithTimeout(url.toString(), { headers: { Accept: 'application/json' } }, 8000);
  if (!res.ok) {
    throw new Error(`Nominatim error: ${res.status}`);
  }
  const list = await res.json();
  if (!Array.isArray(list) || list.length === 0) {
    return null;
  }
  const hit = list[0];
  return {
    lat: parseFloat(hit.lat),
    lng: parseFloat(hit.lon),
    name: hit.display_name || query,
    raw: hit
  };
}

export async function geocodeSearch(query, { googleKey = '' } = {}) {
  if (!query || !query.trim()) throw new Error('query is empty');

  if (googleKey) {
    try {
      const url =
        `https://maps.googleapis.com/maps/api/geocode/json` +
        `?address=${encodeURIComponent(query.trim())}` +
        `&key=${encodeURIComponent(googleKey)}` +
        `&language=ja&region=jp`;
      const res = await fetchWithTimeout(url, {}, 5000);
      if (res.ok) {
        const json = await res.json();
        if (json.status === 'OK' && json.results?.length) {
          const r = json.results[0];
          return {
            lat: r.geometry.location.lat,
            lng: r.geometry.location.lng,
            name: r.formatted_address || query,
            raw: r,
          };
        }
      }
    } catch (e) {
      console.warn('[Geocode] Google Geocoding failed, falling back to Nominatim:', e);
    }
  }

  // Nominatim fallback
  return searchPlace(query);
}
