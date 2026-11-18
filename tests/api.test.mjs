import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakes, setEnv, LEGACY_V1, HOSTS } from './fakes.mjs';
import { loadHandlers } from '../scripts/dev-server.mjs';
import * as core from '../lib/core.mjs';

const HOST = 'journey.test';
function call(handler, { method = 'GET', query = {}, body, cookie, origin = `https://${HOST}`, ip = '203.0.113.9', contentType = 'application/json' } = {}) {
  return new Promise((resolve) => {
    const headers = { host: HOST, 'x-forwarded-for': ip, ...(origin ? { origin } : {}), ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': contentType } : {}) };
    const out = { status: 200, headers: {} };
    const res = { setHeader: (k, v) => { out.headers[k.toLowerCase()] = v; }, status(c) { out.status = c; return res; }, json(o) { out.body = o; resolve(out); return res; } };
    handler({ method, query, body, headers }, res);
  });
}
const boot = (env) => { setEnv(env); const fakes = installFakes(); return { ...loadHandlers(), fakes }; };
const login = async (h, ip) => (await call(h.journey, { method: 'POST', query: { resource: 'session' }, body: { passphrase: 'correct horse' }, ip })).headers['set-cookie'].split(';')[0];
const place = (over = {}) => ({ id: 'wp_a', placeId: 'osm:N101', placeName: 'Nawanshahr', region: 'Shaheed Bhagat Singh Nagar, Punjab', country: 'India', countryCode: 'IN', latitude: 31.1256, longitude: 76.1162, geocodeSource: 'photon', locationPrecision: 'town', startDate: '1990', endDate: null, isCurrent: false, stayType: 'birthplace', chapter: 'childhood', note: '', sortIndex: 0, ...over });
const pause = (ms = 600) => new Promise((r) => setTimeout(r, ms));     // lets the proxy's outbound token bucket refill
const doc = (waypoints, over = {}) => ({ ...core.emptyJourney('default'), waypoints, ...over });

test('demo mode: no Upstash → sample is served and a write is refused, never reported as saved', async () => {
  const h = boot({ redis: false, token: '' });
  const get = await call(h.journey);
  assert.equal(get.body.mode, 'demo'); assert.equal(get.body.sample, true); assert.equal(get.body.journey.schemaVersion, 2);
  const put = await call(h.journey, { method: 'PUT', body: { journey: doc([place()]), baseRevision: 0 } });
  assert.equal(put.status, 501); assert.equal(put.body.persisted, undefined); assert.equal(put.body.code, 'no_storage');
  h.fakes.restore();
});

test('unauthenticated and cross-site writes are refused', async () => {
  const h = boot();
  const body = { journey: doc([place()]), baseRevision: 0 };
  assert.equal((await call(h.journey, { method: 'PUT', body })).status, 401);
  assert.equal((await call(h.journey, { method: 'PUT', body, cookie: 'journey_edit=9999999999999.forged' })).status, 401);
  const cookie = await login(h);
  assert.equal((await call(h.journey, { method: 'PUT', body, cookie, origin: 'https://evil.example' })).status, 403);
  assert.equal((await call(h.journey, { method: 'PUT', body, cookie, origin: '' })).status, 403);
  assert.equal((await call(h.journey, { method: 'PUT', body: JSON.stringify(body), cookie, contentType: 'text/plain' })).status, 415);
  assert.equal(h.fakes.state.store.has('journey:default'), false, 'nothing was written');
  h.fakes.restore();
});

test('session: wrong passphrase fails, attempts are rate limited, cookie is HttpOnly + SameSite=Strict + Secure', async () => {
  const h = boot();
  const bad = await call(h.journey, { method: 'POST', query: { resource: 'session' }, body: { passphrase: 'nope' }, ip: '198.51.100.1' });
  assert.equal(bad.status, 401); assert.equal(bad.headers['set-cookie'], undefined);
  const ok = await call(h.journey, { method: 'POST', query: { resource: 'session' }, body: { passphrase: 'correct horse' }, ip: '198.51.100.1' });
  assert.equal(ok.status, 200);
  for (const flag of ['HttpOnly', 'SameSite=Strict', 'Secure', 'Path=/api']) assert.ok(ok.headers['set-cookie'].includes(flag), flag);
  assert.ok(!JSON.stringify(ok.body).includes('correct horse'));
  let last; for (let i = 0; i < 9; i++) last = await call(h.journey, { method: 'POST', query: { resource: 'session' }, body: { passphrase: `guess${i}` }, ip: '198.51.100.77' });
  assert.equal(last.status, 429); assert.ok(last.headers['retry-after']);
  const locked = await call(h.journey, { method: 'POST', query: { resource: 'session' }, body: { passphrase: 'correct horse' }, ip: '198.51.100.77' });
  assert.equal(locked.status, 429, 'even the right passphrase waits out the window');
  h.fakes.restore();
});

test('no JOURNEY_EDIT_TOKEN → nobody can write', async () => {
  const h = boot({ token: '' });
  assert.equal((await call(h.journey, { method: 'POST', query: { resource: 'session' }, body: { passphrase: '' } })).status, 403);
  assert.equal((await call(h.journey, { method: 'PUT', body: { journey: doc([place()]), baseRevision: 0 } })).status, 403);
  h.fakes.restore();
});

test('create → read → update → delete round-trips through Redis with revisions and a previous-version copy', async () => {
  const h = boot(); const cookie = await login(h); const s = h.fakes.state.store;
  const r1 = await call(h.journey, { method: 'PUT', cookie, body: { journey: doc([place()], { displayName: 'Test' }), baseRevision: 0 } });
  assert.equal(r1.status, 200); assert.equal(r1.body.persisted, true); assert.equal(r1.body.journey.revision, 1);
  assert.equal(JSON.parse(s.get('journey:default')).waypoints[0].placeName, 'Nawanshahr');
  const g1 = await call(h.journey, { cookie });
  assert.equal(g1.body.mode, 'cloud'); assert.equal(g1.body.canEdit, true); assert.equal(g1.body.sample, undefined); assert.equal(g1.body.journey.waypoints[0].startDatePrecision, 'year');
  const r2 = await call(h.journey, { method: 'PUT', cookie, body: { journey: { ...g1.body.journey, waypoints: [place({ note: 'edited' }), place({ id: 'wp_b', placeName: 'Tokyo', stayType: 'work', startDate: '2015-03-28', isCurrent: true })] }, baseRevision: 1 } });
  assert.equal(r2.body.journey.revision, 2); assert.equal(JSON.parse(s.get('journey:default:prev')).revision, 1);
  const r3 = await call(h.journey, { method: 'PUT', cookie, body: { journey: { ...r2.body.journey, waypoints: [place({ note: 'edited' })] }, baseRevision: 2 } });
  assert.equal(r3.body.journey.waypoints.length, 1);
  assert.equal((await call(h.journey, { cookie })).body.journey.waypoints.length, 1);
  const stale = await call(h.journey, { method: 'PUT', cookie, body: { journey: doc([place()]), baseRevision: 1 } });
  assert.equal(stale.status, 409); assert.equal(stale.body.code, 'conflict'); assert.equal(stale.body.current.revision, 3);
  assert.equal(JSON.parse(s.get('journey:default')).revision, 3, 'a stale edit does not overwrite');
  h.fakes.restore();
});

test('server-side validation: invalid records never reach storage', async () => {
  const h = boot(); const cookie = await login(h);
  for (const over of [{ latitude: 123 }, { startDate: 'NOW' }, { latitude: null, longitude: null }, { stayType: 'x' }, { startDate: null }]) {
    const r = await call(h.journey, { method: 'PUT', cookie, body: { journey: doc([place(over)]), baseRevision: 0 } });
    assert.equal(r.status, 400, JSON.stringify(over)); assert.ok(r.body.error);
  }
  assert.equal((await call(h.journey, { method: 'PUT', cookie, body: { journey: { waypoints: 'no' }, baseRevision: 0 } })).status, 400);
  assert.equal((await call(h.journey, { method: 'PUT', cookie, body: { journey: doc([place({ note: 'x'.repeat(500000) })]), baseRevision: 0 } })).status, 413);
  assert.equal(h.fakes.state.store.has('journey:default'), false);
  h.fakes.restore();
});

test('storage failure: writes report failure, reads never fall back to sample data', async () => {
  const h = boot(); const cookie = await login(h);
  await call(h.journey, { method: 'PUT', cookie, body: { journey: doc([place()]), baseRevision: 0 } });
  h.fakes.state.failWrites = true;
  const w = await call(h.journey, { method: 'PUT', cookie, body: { journey: doc([place({ note: 'lost?' })]), baseRevision: 1 } });
  assert.equal(w.status, 500); assert.equal(w.body.persisted, undefined); assert.equal(w.body.ok, undefined);
  assert.equal(JSON.parse(h.fakes.state.store.get('journey:default')).waypoints[0].note, '');
  h.fakes.state.failWrites = false; h.fakes.state.redisDown = true;
  const g = await call(h.journey, { cookie });
  assert.equal(g.status, 503); assert.equal(g.body.journey, undefined); assert.equal(g.body.code, 'storage_unavailable');
  h.fakes.restore();
});

test('legacy v1 document: served migrated, original backed up once on first save, nothing dropped', async () => {
  const h = boot(); const s = h.fakes.state.store; const raw = JSON.stringify(LEGACY_V1);
  s.set('journey:default', raw);
  const g = await call(h.journey);
  assert.equal(g.status, 200); assert.equal(g.body.migrated, true); assert.equal(g.body.journey.schemaVersion, 2); assert.equal(g.body.journey.waypoints.length, 8);
  assert.equal(s.get('journey:default'), raw, 'reading does not rewrite the stored document');
  const cookie = await login(h);
  const r = await call(h.journey, { method: 'PUT', cookie, body: { journey: g.body.journey, baseRevision: 0 } });
  assert.equal(r.status, 200); assert.equal(s.get('journey:default:backup:v1'), raw);
  const saved = JSON.parse(s.get('journey:default'));
  assert.equal(saved.schemaVersion, 2); assert.equal(saved.legacy.theme, 'midnight'); assert.equal(saved.waypoints.find((w) => w.placeName === 'Lisbon').isCurrent, true);
  await call(h.journey, { method: 'PUT', cookie, body: { journey: { ...r.body.journey, displayName: 'Changed' }, baseRevision: 1 } });
  assert.equal(s.get('journey:default:backup:v1'), raw, 'the v1 backup is never overwritten');
  h.fakes.restore();
});

test('privacy: a private journey is not readable without the owner session', async () => {
  const h = boot(); const cookie = await login(h);
  await call(h.journey, { method: 'PUT', cookie, body: { journey: doc([place()], { visibility: 'private' }), baseRevision: 0 } });
  const anon = await call(h.journey);
  assert.equal(anon.status, 401); assert.equal(anon.body.code, 'private'); assert.equal(anon.body.journey, undefined);
  assert.equal((await call(h.journey, { cookie })).status, 200);
  const out = await call(h.journey, { method: 'DELETE', query: { resource: 'session' }, body: {}, cookie });
  assert.ok(out.headers['set-cookie'].includes('Max-Age=0'));
  h.fakes.restore();
});

test('geocode proxy: ranks, caches, validates, requires the owner, and degrades cleanly', async () => {
  const h = boot(); const st = h.fakes.state;
  assert.equal((await call(h.geocode, { query: { q: 'Nawanshahr' } })).status, 401);
  const cookie = await login(h);
  assert.equal((await call(h.geocode, { query: { q: 'N' }, cookie })).status, 400);
  const r = await call(h.geocode, { query: { q: 'Nawanshahr' }, cookie });
  assert.equal(r.status, 200); assert.equal(r.body.cached, false);
  assert.deepEqual(r.body.results.map((p) => `${p.name}|${p.countryCode}|${p.kind}`), ['Nawanshahr|IN|town', 'Nawanshehr|PK|town']);
  assert.equal(r.body.results[0].latitude, 31.1256); assert.equal(r.body.results[0].region, 'Shaheed Bhagat Singh Nagar, Punjab');
  const again = await call(h.geocode, { query: { q: 'nawanshahr' }, cookie });
  assert.equal(again.body.cached, true); assert.equal(st.photonCalls.length, 1, 'the repeat was served from cache');
  await pause();
  assert.equal((await call(h.geocode, { query: { q: 'Nawan Shahr' }, cookie })).body.results[0].name, 'Nawanshahr');
  await pause();
  assert.equal((await call(h.geocode, { query: { q: 'Shaheed Bhagat Singh Nagar' }, cookie })).body.results[0].kind, 'county');
  await pause();
  assert.equal((await call(h.geocode, { query: { q: 'Khatkar Kalan' }, cookie })).body.results[0].kind, 'village');
  await pause();
  assert.equal((await call(h.geocode, { query: { q: '東京' }, cookie })).body.results[0].name, 'Tokyo');
  await pause();
  assert.deepEqual((await call(h.geocode, { query: { q: 'zzzznowhere' }, cookie })).body.results, []);
  await pause(); st.photonDown = true;
  const down = await call(h.geocode, { query: { q: 'Lisbon' }, cookie });
  assert.equal(down.status, 502); assert.equal(down.body.code, 'provider_unavailable'); assert.equal(down.body.results, undefined);
  await pause(1200); st.photonDown = false; st.rejectFilters = true;
  assert.equal((await call(h.geocode, { query: { q: 'Toronto' }, cookie })).body.results[0].name, 'Toronto', 'falls back to an unfiltered query when the provider rejects filters');
  h.fakes.restore();
});

test('geocode proxy: bursts are throttled before they reach the provider', async () => {
  const h = boot(); const cookie = await login(h);
  const codes = [];
  for (let i = 0; i < 8; i++) codes.push((await call(h.geocode, { query: { q: `Toront${'o'.repeat(i + 1)}` }, cookie })).status);
  assert.ok(codes.includes(429), codes.join(','));
  assert.ok(h.fakes.state.photonCalls.length <= 5);
  h.fakes.restore();
});

test('weather: exact dates only, labelled as an estimate, cached', async () => {
  const h = boot();
  assert.equal((await call(h.journey, { query: { resource: 'weather', lat: '31.13', lon: '76.12', date: '1990' } })).status, 400, 'a year alone gets no daily weather');
  assert.equal((await call(h.journey, { query: { resource: 'weather', lat: '91', lon: '0', date: 'now' } })).status, 400);
  const w = await call(h.journey, { query: { resource: 'weather', lat: '35.69', lon: '139.69', date: '2015-03-28' } });
  assert.equal(w.body.weather.kind, 'historical'); assert.match(w.body.weather.provenance, /Historical estimate/); assert.equal(w.body.weather.tmax, 21.3);
  assert.ok(h.fakes.state.weatherCalls[0].startsWith(HOSTS.archive));
  assert.equal((await call(h.journey, { query: { resource: 'weather', lat: '35.69', lon: '139.69', date: '2015-03-28' } })).body.cached, true);
  const live = await call(h.journey, { query: { resource: 'weather', lat: '35.69', lon: '139.69', date: 'now' } });
  assert.equal(live.body.weather.kind, 'live'); assert.ok(h.fakes.state.weatherCalls[1].startsWith(HOSTS.forecast));
  h.fakes.restore();
});
