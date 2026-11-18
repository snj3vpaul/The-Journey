/**
 * The Journey — journey storage, owner session and weather (Vercel Node.js function, zero dependencies).
 *
 *   GET    /api/journey[?user=<id>]                      -> { journey, mode, canEdit, authConfigured, sample?, migrated? }
 *   PUT    /api/journey[?user=<id>]  { journey, baseRevision }   -> { ok, persisted: true, journey }      (owner session required)
 *   POST   /api/journey?resource=session  { passphrase }  -> { ok, canEdit: true }   + HttpOnly cookie
 *   DELETE /api/journey?resource=session                  -> { ok }                  (signs out)
 *   GET    /api/journey?resource=weather&lat&lon&date     -> { weather, cached }     (date = YYYY-MM-DD | now)
 *
 * Storage is one versioned JSON document per journey in an Upstash Redis *string* (GET/SET only).
 * Without Upstash credentials the route reports mode "demo": it serves the bundled sample and refuses to pretend it saved anything.
 */
'use strict';

const seed = require('../journey.json');
const S = require('./_shared.js');
const { HttpError } = S;

const core = () => import('../lib/core.mjs');
const DAY_MS = 86400000;
const TTL_HISTORICAL = 60 * 60 * 24 * 30;   // reanalysis for a past day does not change
const TTL_LIVE = 60 * 10;                   // current conditions stay current
const FORECAST_URL = (S.env('OPEN_METEO_URL') || 'https://api.open-meteo.com/v1/forecast').replace(/\/+$/, '');
const ARCHIVE_URL = (S.env('OPEN_METEO_ARCHIVE_URL') || 'https://archive-api.open-meteo.com/v1/archive').replace(/\/+$/, '');

const keyOf = (id) => `journey:${id}`;

/* ------------------------------------------------------------------ journey */

async function sampleJourney(id) {
  const { migrateJourney } = await core();
  const { journey } = migrateJourney(JSON.parse(JSON.stringify(seed)), { journeyId: id });
  return { ...journey, journeyId: id };
}

async function handleGet(req, res) {
  const id = S.cleanJourneyId(req.query.user);
  const authConfigured = Boolean(S.EDIT_TOKEN);
  if (!S.HAS_REDIS) {
    return res.status(200).json({ journey: await sampleJourney(id), mode: 'demo', sample: true, canEdit: false, authConfigured: false });
  }
  let raw;
  try { raw = await S.redis(['GET', keyOf(id)]); }
  catch (err) {
    // Never fall back to the sample here: a client that mistook it for the real journey could save it over the real one.
    console.error('[journey] Redis read failed:', err.message);
    throw new HttpError(503, 'The journey store could not be reached. Nothing was changed — please try again.', { code: 'storage_unavailable' });
  }
  const canEdit = S.hasSession(req);
  if (!raw) return res.status(200).json({ journey: await sampleJourney(id), mode: 'cloud', sample: true, canEdit, authConfigured });
  let stored;
  try { stored = JSON.parse(raw); } catch { throw new HttpError(500, 'The stored journey is not valid JSON. It has not been modified.', { code: 'stored_invalid' }); }
  const { migrateJourney } = await core();
  const { journey, migrated } = migrateJourney(stored, { journeyId: id });
  if (journey.visibility !== 'public' && !canEdit) {
    throw new HttpError(401, 'This journey is private.', { code: 'private', authConfigured });
  }
  return res.status(200).json({ journey: { ...journey, journeyId: id }, mode: 'cloud', canEdit, authConfigured, ...(migrated ? { migrated: true } : {}) });
}

async function handlePut(req, res) {
  S.assertSameOrigin(req);
  const { validateJourney, migrateJourney, LIMITS } = await core();
  const body = S.readBody(req, LIMITS.bodyChars);
  if (!S.HAS_REDIS) throw new HttpError(501, 'No cloud storage is configured, so nothing was saved on the server.', { code: 'no_storage' });
  if (!S.EDIT_TOKEN) throw new HttpError(403, 'Editing is disabled until JOURNEY_EDIT_TOKEN is set on the server.', { code: 'auth_not_configured' });
  if (!S.hasSession(req)) throw new HttpError(401, 'Sign in with the edit passphrase to save.', { code: 'signed_out' });

  const id = S.cleanJourneyId(req.query.user);
  const incoming = validateJourney(body.journey, { journeyId: id });
  const baseRevision = Number.isInteger(body.baseRevision) ? body.baseRevision : -1;

  const raw = await S.redis(['GET', keyOf(id)]);
  let current = null, currentIsLegacy = false;
  if (raw) {
    let stored; try { stored = JSON.parse(raw); } catch { throw new HttpError(500, 'The stored journey is not valid JSON. It has not been modified.', { code: 'stored_invalid' }); }
    const m = migrateJourney(stored, { journeyId: id });
    current = m.journey; currentIsLegacy = m.migrated;
  }
  const currentRevision = current ? current.revision || 0 : 0;
  if (baseRevision !== currentRevision) {
    throw new HttpError(409, 'This journey was changed somewhere else since you loaded it.', { code: 'conflict', current: current ? { ...current, journeyId: id } : null });
  }
  const nowIso = new Date().toISOString();
  const journey = { ...incoming, journeyId: id, revision: currentRevision + 1, createdAt: current ? current.createdAt : incoming.createdAt, updatedAt: nowIso };
  const commands = [];
  if (raw) {
    if (currentIsLegacy) commands.push(['SET', `${keyOf(id)}:backup:v1`, raw, 'NX']);   // one-time copy of the pre-migration document
    commands.push(['SET', `${keyOf(id)}:prev`, raw]);                                   // always keep the previous revision
  }
  commands.push(['SET', keyOf(id), JSON.stringify(journey)]);
  const results = await S.redisPipeline(commands);
  if (results[results.length - 1] !== 'OK') throw new Error('Upstash did not confirm the write');
  return res.status(200).json({ ok: true, persisted: true, journey });
}

/* ------------------------------------------------------------------ owner session */

async function handleSession(req, res) {
  S.assertSameOrigin(req);
  if (req.method === 'DELETE') { res.setHeader('Set-Cookie', S.sessionCookie(req, true)); return res.status(200).json({ ok: true, canEdit: false }); }
  if (!S.EDIT_TOKEN) throw new HttpError(403, 'Editing is disabled until JOURNEY_EDIT_TOKEN is set on the server.', { code: 'auth_not_configured' });
  const body = S.readBody(req, 2000);
  const limit = await S.rateLimit(`auth:${S.hashIp(S.clientIp(req))}`, 8, 15 * 60, { shared: true });
  if (!limit.ok) throw new HttpError(429, 'Too many attempts. Please wait a few minutes and try again.', { code: 'rate_limited', retryAfter: limit.retryAfter });
  if (typeof body.passphrase !== 'string' || body.passphrase.length > 256 || !S.passphraseMatches(body.passphrase)) {
    throw new HttpError(401, 'That passphrase is not correct.', { code: 'bad_passphrase' });
  }
  res.setHeader('Set-Cookie', S.sessionCookie(req));
  return res.status(200).json({ ok: true, canEdit: true });
}

/* ------------------------------------------------------------------ weather (Open-Meteo) */

async function fetchWeather(lat, lon, date) {
  const base = `latitude=${lat}&longitude=${lon}&timezone=auto`;
  if (date === 'now') {
    const d = await S.fetchJson(`${FORECAST_URL}?${base}&current=temperature_2m,weather_code,is_day`);
    const c = d.current || {};
    if (typeof c.temperature_2m !== 'number') throw new Error('No current weather');
    return { kind: 'live', provenance: 'Current conditions · Open-Meteo', code: c.weather_code ?? null, temp: c.temperature_2m, isDay: c.is_day !== 0 };
  }
  // The reanalysis archive lags a few days behind; very recent dates are served by the forecast API.
  const recent = Date.now() - Date.parse(`${date}T00:00:00Z`) < 7 * DAY_MS;
  const url = recent
    ? `${FORECAST_URL}?${base}&start_date=${date}&end_date=${date}&daily=weather_code,temperature_2m_max,temperature_2m_min`
    : `${ARCHIVE_URL}?${base}&start_date=${date}&end_date=${date}&daily=weather_code,temperature_2m_max,temperature_2m_min,temperature_2m_mean`;
  const d = await S.fetchJson(url);
  const daily = d.daily || {};
  const pick = (k) => (Array.isArray(daily[k]) && typeof daily[k][0] === 'number' ? daily[k][0] : null);
  const tmax = pick('temperature_2m_max'), tmin = pick('temperature_2m_min');
  let temp = pick('temperature_2m_mean');
  if (temp === null && tmax !== null && tmin !== null) temp = (tmax + tmin) / 2;
  if (temp === null) throw new Error('No archive weather');
  return {
    kind: 'historical', date,
    provenance: recent ? 'Recent model data · Open-Meteo' : 'Historical estimate · Open-Meteo reanalysis (modelled for the area, not a station reading)',
    code: pick('weather_code') ?? pick('weathercode'), temp, tmax, tmin, isDay: true,
  };
}

async function handleWeather(req, res) {
  const lat = Number(req.query.lat), lon = Number(req.query.lon), date = String(req.query.date || '');
  if (req.query.lat === undefined || req.query.lon === undefined || !Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lon) || Math.abs(lon) > 180) {
    throw new HttpError(400, 'Invalid lat/lon');
  }
  if (date !== 'now') {
    const ms = /^\d{4}-\d{2}-\d{2}$/.test(date) ? Date.parse(`${date}T00:00:00Z`) : NaN;
    if (!Number.isFinite(ms) || date < '1940-01-01' || ms > Date.now()) throw new HttpError(400, 'date must be "now" or an exact YYYY-MM-DD between 1940-01-01 and today');
  }
  const limit = await S.rateLimit(`wx:${S.hashIp(S.clientIp(req))}`, 90, 60);
  if (!limit.ok) throw new HttpError(429, 'Too many weather requests', { retryAfter: limit.retryAfter });
  const la = lat.toFixed(2), lo = lon.toFixed(2);
  const ttl = date === 'now' ? TTL_LIVE : TTL_HISTORICAL;
  const key = `weather:v2:${la}:${lo}:${date}`;
  if (S.HAS_REDIS) {
    try {
      const hit = await S.redis(['GET', key]);
      if (hit) { res.setHeader('Cache-Control', `public, s-maxage=${ttl}`); return res.status(200).json({ weather: JSON.parse(hit), cached: true }); }
    } catch { /* cache trouble — go to the provider */ }
  }
  let weather;
  try { weather = await fetchWeather(la, lo, date); }
  catch { throw new HttpError(502, 'Weather provider unavailable'); }
  if (S.HAS_REDIS) { try { await S.redis(['SET', key, JSON.stringify(weather), 'EX', ttl]); } catch { /* non-fatal */ } }
  res.setHeader('Cache-Control', `public, s-maxage=${ttl}`);   // Vercel's edge cache is a second, free layer
  return res.status(200).json({ weather, cached: false });
}

module.exports = S.route(async (req, res) => {
  const resource = String(req.query.resource || '');
  if (resource === 'session') {
    if (req.method === 'POST' || req.method === 'DELETE') return handleSession(req, res);
    res.setHeader('Allow', 'POST, DELETE'); throw new HttpError(405, 'Method not allowed');
  }
  if (req.method === 'GET') return resource === 'weather' ? handleWeather(req, res) : handleGet(req, res);
  if (req.method === 'PUT' || req.method === 'POST') return handlePut(req, res);
  res.setHeader('Allow', 'GET, PUT, POST, DELETE');
  throw new HttpError(405, 'Method not allowed');
});
