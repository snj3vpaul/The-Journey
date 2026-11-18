/**
 * Test doubles for the three upstream services the server talks to. They replace globalThis.fetch for known hosts only.
 * IMPORTANT: the place data below is a hand-written FIXTURE in Photon's response format, used to exercise the app's
 * search, ranking and error handling offline. It is not a recording of the live Photon service.
 */
export const HOSTS = { redis: 'https://fake-upstash.test', photon: 'https://fake-photon.test/api', forecast: 'https://fake-meteo.test/v1/forecast', archive: 'https://fake-meteo.test/v1/archive' };

const feat = (name, lon, lat, props) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: { name, osm_type: 'N', osm_id: Math.abs(Math.round(lon * 1e4 + lat * 1e2)), osm_key: 'place', osm_value: 'city', type: 'city', ...props } });
const PLACES = [
  feat('Nawanshahr', 76.1162, 31.1256, { osm_value: 'town', county: 'Shaheed Bhagat Singh Nagar', state: 'Punjab', country: 'India', countrycode: 'IN', osm_id: 101 }),
  feat('Nawanshahr', 76.1170, 31.1250, { osm_type: 'R', osm_key: 'boundary', osm_value: 'administrative', type: 'city', county: 'Shaheed Bhagat Singh Nagar', state: 'Punjab', country: 'India', countrycode: 'IN', osm_id: 102 }),
  feat('Nawanshehr', 73.2640, 34.1690, { osm_value: 'town', county: 'Abbottabad', state: 'Khyber Pakhtunkhwa', country: 'Pakistan', countrycode: 'PK', osm_id: 103 }),
  feat('Shaheed Bhagat Singh Nagar', 76.1300, 31.0900, { osm_type: 'R', osm_key: 'boundary', osm_value: 'administrative', type: 'county', state: 'Punjab', country: 'India', countrycode: 'IN', osm_id: 104 }),
  feat('Khatkar Kalan', 76.0290, 31.1060, { osm_value: 'village', county: 'Shaheed Bhagat Singh Nagar', state: 'Punjab', country: 'India', countrycode: 'IN', osm_id: 105 }),
  feat('Nawanshahr Road', 75.9, 31.2, { osm_type: 'W', osm_key: 'highway', osm_value: 'residential', type: 'street', state: 'Punjab', country: 'India', countrycode: 'IN', osm_id: 106 }),
  feat('Tokyo', 139.6917, 35.6895, { state: 'Tokyo', country: 'Japan', countrycode: 'JP', osm_id: 201, alt: ['東京', '東京都'] }),
  feat('London', -0.1276, 51.5072, { state: 'England', country: 'United Kingdom', countrycode: 'GB', osm_id: 301 }),
  feat('London', -81.2497, 42.9834, { state: 'Ontario', country: 'Canada', countrycode: 'CA', osm_id: 302 }),
  feat('Lisbon', -9.1393, 38.7223, { country: 'Portugal', countrycode: 'PT', osm_id: 303 }),
  feat('Toronto', -79.3832, 43.6532, { state: 'Ontario', country: 'Canada', countrycode: 'CA', osm_id: 304 }),
  feat('Montreal', -73.5674, 45.5019, { state: 'Quebec', country: 'Canada', countrycode: 'CA', osm_id: 305 }),
];
const fold = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[\s\-]+/g, '');

export function installFakes() {
  const state = { store: new Map(), redisDown: false, failWrites: false, photonDown: false, photonSlow: {}, photonCalls: [], redisCalls: [], weatherCalls: [], rejectFilters: false };
  const real = globalThis.fetch;
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

  function redisCmd(cmd) {
    const [op, key, ...rest] = cmd; const s = state.store;
    state.redisCalls.push(op);
    switch (String(op).toUpperCase()) {
      case 'GET': return { result: s.has(key) ? s.get(key) : null };
      case 'SET': {
        if (state.failWrites) return { error: 'ERR simulated write failure' };
        if (rest.includes('NX') && s.has(key)) return { result: null };
        s.set(key, String(rest[0])); return { result: 'OK' };
      }
      case 'INCR': { const n = Number(s.get(key) || 0) + 1; s.set(key, String(n)); return { result: n }; }
      case 'EXPIRE': return { result: 1 };
      case 'TTL': return { result: 600 };
      case 'DEL': return { result: s.delete(key) ? 1 : 0 };
      default: return { error: `ERR unknown command ${op}` };
    }
  }

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(HOSTS.redis)) {
      if (state.redisDown) return json({ error: 'down' }, 503);
      const body = JSON.parse(init.body);
      return url.endsWith('/pipeline') ? json(body.map(redisCmd)) : json(redisCmd(body));
    }
    if (url.startsWith(HOSTS.photon)) {
      const u = new URL(url), q = u.searchParams.get('q') || '';
      state.photonCalls.push(q);
      if (state.photonDown) return json({ message: 'unavailable' }, 503);
      if (state.rejectFilters && u.searchParams.has('layer')) return json({ message: 'unknown parameter' }, 400);
      if (state.photonSlow[q]) await new Promise((r) => setTimeout(r, state.photonSlow[q]));
      const f = fold(q.split(',')[0]);
      const features = PLACES.filter((p) => [p.properties.name, ...(p.properties.alt || [])].some((n) => fold(n).startsWith(f) || (f.length > 5 && fold(n).replace(/e/g, 'a').startsWith(f.replace(/e/g, 'a')))));
      return json({ type: 'FeatureCollection', features });
    }
    if (url.startsWith(HOSTS.forecast) || url.startsWith(HOSTS.archive)) {
      state.weatherCalls.push(url);
      if (url.includes('current=')) return json({ current: { temperature_2m: 17.4, weather_code: 2, is_day: 1 } });
      return json({ daily: { weather_code: [61], temperature_2m_max: [21.3], temperature_2m_min: [12.1], temperature_2m_mean: [16.8] } });
    }
    if (/^https?:\/\/(localhost|127\.0\.0\.1)/.test(url)) return real(input, init);
    throw new Error(`Unexpected outbound request in tests: ${url}`);
  };
  return { state, restore: () => { globalThis.fetch = real; } };
}

export function setEnv({ redis = true, token = 'correct horse', } = {}) {
  for (const k of ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'JOURNEY_EDIT_TOKEN']) delete process.env[k];
  if (redis) { process.env.UPSTASH_REDIS_REST_URL = HOSTS.redis; process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token'; }
  if (token) process.env.JOURNEY_EDIT_TOKEN = token;
  process.env.GEOCODER_URL = HOSTS.photon; process.env.OPEN_METEO_URL = HOSTS.forecast; process.env.OPEN_METEO_ARCHIVE_URL = HOSTS.archive;
}

/** The exact v1 document shape the previous version of the app stored (with a "NOW" year and a null-coordinate place). */
export const LEGACY_V1 = {
  userId: 'default', name: 'Alex Rivera', updatedAt: '2026-11-15T00:00:00Z', theme: 'midnight',
  waypoints: [
    { year: 1990, month: 6, day: 15, place: 'New York', country: 'US', lat: 40.7128, lon: -74.006, stage: 'birth', note: 'Born on a summer morning' },
    { year: 1996, month: 9, day: 2, place: 'Toronto', country: 'CA', lat: 43.6532, lon: -79.3832, stage: 'childhood', note: 'First snow day' },
    { year: 2008, month: 8, day: 20, place: 'Montreal', country: 'CA', lat: null, lon: null, stage: 'education', note: '' },
    { year: 2017, month: 12, day: 20, place: 'Denpasar', country: 'ID', lat: -8.65, lon: 115.2167, stage: 'adventure', kind: 'visit', note: 'Surf', photo: 'bali.jpg' },
    { year: 2018, month: 1, day: 10, place: 'Sydney', country: 'AU', lat: -33.8688, lon: 151.2093, stage: 'career', note: '' },
    { year: 2021, month: 6, day: 14, place: 'Nadi', country: 'FJ', lat: -17.8, lon: 177.4167, stage: 'adventure', note: '' },
    { year: 2021, month: 7, day: 5, place: 'Vancouver', country: 'CA', lat: 49.2827, lon: -123.1207, stage: 'family', note: '' },
    { year: 'NOW', place: 'Lisbon', country: 'PT', lat: 38.7223, lon: -9.1393, stage: 'adult', note: 'Today' },
  ],
};
