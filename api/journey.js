/**
 * The Journey — Vercel Serverless Function (Node.js runtime, zero dependencies).
 *
 *   GET  /api/journey?user=<id>                         -> { journey, mode, editProtected }
 *   GET  /api/journey?resource=weather&lat&lon&date     -> { weather, cached }   (date = YYYY-MM-DD | now)
 *   POST /api/journey?user=<id>   { journey }           -> { ok, persisted, journey }
 *
 * Upstash credentials are read here and ONLY here. They are never sent to the client.
 * If they are missing, the function serves the bundled journey.json seed ("local" mode).
 */
'use strict';

const crypto = require('crypto');
const seed = require('../journey.json');

const REDIS_URL = (process.env.UPSTASH_REDIS_REST_URL || '').trim().replace(/\/+$/, '');
const REDIS_TOKEN = (process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
const EDIT_TOKEN = (process.env.JOURNEY_EDIT_TOKEN || '').trim();
const HAS_REDIS = Boolean(REDIS_URL && REDIS_TOKEN);

const DAY_MS = 86400000;
const TTL_HISTORICAL = 60 * 60 * 24; // 24h — archive weather never changes
const TTL_LIVE = 60 * 10;            // 10 min — "NOW" weather stays live
const MAX_WAYPOINTS = 200;
const MAX_BODY_CHARS = 100000;

/* ------------------------------------------------------------------ helpers */

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function fetchJson(url, init = {}, timeoutMs = 8000) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const data = await r.json().catch(() => null);
  if (!r.ok || data === null) throw new Error(`Upstream HTTP ${r.status}`);
  return data;
}

/** Upstash REST: POST the command as a JSON array, e.g. ["SET","key","value","EX",60]. */
async function redis(command) {
  const data = await fetchJson(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  }, 5000);
  if (data.error) throw new Error(`Upstash: ${data.error}`);
  return data.result;
}

const cleanUserId = (v) =>
  String(v || 'default').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40) || 'default';

const str = (v, max) => (typeof v === 'string' ? v : v == null ? '' : String(v)).trim().slice(0, max);

function coord(v, limit) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && Math.abs(n) <= limit ? Math.round(n * 1e5) / 1e5 : null;
}

function sanitizeWaypoint(w) {
  if (!w || typeof w !== 'object') throw new HttpError(400, 'Invalid waypoint');
  const place = str(w.place, 120);
  if (!place) throw new HttpError(400, 'Every waypoint needs a place');
  const out = {};
  if (String(w.year).toUpperCase() === 'NOW') {
    out.year = 'NOW';
  } else {
    const year = Math.trunc(Number(w.year));
    const month = Math.trunc(Number(w.month ?? 1));
    const day = Math.trunc(Number(w.day ?? 1));
    if (!(year >= 1 && year <= 9999) || !(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) {
      throw new HttpError(400, `Invalid date for "${place}"`);
    }
    out.year = year; out.month = month; out.day = day;
  }
  out.place = place;
  out.country = str(w.country, 56);
  out.lat = coord(w.lat, 90);
  out.lon = coord(w.lon, 180);
  if (out.lat === null || out.lon === null) { out.lat = null; out.lon = null; }
  out.stage = str(w.stage, 40).toLowerCase() || 'adult';
  out.note = str(w.note, 400);
  if (w.kind === 'home' || w.kind === 'visit') out.kind = w.kind;   // optional: overrides the automatic home/visit guess
  return out;
}

function sanitizeJourney(input, userId) {
  if (!input || typeof input !== 'object' || !Array.isArray(input.waypoints)) {
    throw new HttpError(400, 'Body must be { journey: { name, waypoints: [...] } }');
  }
  if (input.waypoints.length > MAX_WAYPOINTS) throw new HttpError(400, `At most ${MAX_WAYPOINTS} waypoints`);
  return {
    userId,
    name: str(input.name, 80) || 'Unnamed traveller',
    updatedAt: new Date().toISOString(),
    waypoints: input.waypoints.map(sanitizeWaypoint),
  };
}

function tokenMatches(given) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(EDIT_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ---------------------------------------------------------------- geocoding */

async function geocode(place, country) {
  const name = place.split(',')[0].trim();
  const data = await fetchJson(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=10&language=en&format=json`
  );
  const results = Array.isArray(data.results) ? data.results : [];
  if (!results.length) return null;
  const c = country.trim().toLowerCase();
  const hit =
    (c && results.find((r) => String(r.country_code || '').toLowerCase() === c ||
                              String(r.country || '').toLowerCase() === c)) || results[0];
  return { lat: Math.round(hit.latitude * 1e5) / 1e5, lon: Math.round(hit.longitude * 1e5) / 1e5 };
}

/** Safety net: the client normally geocodes, but resolve anything still null before persisting. */
async function fillMissingCoords(journey) {
  for (const w of journey.waypoints) {
    if (w.lat !== null && w.lon !== null) continue;
    try {
      const hit = await geocode(w.place, w.country);
      if (hit) { w.lat = hit.lat; w.lon = hit.lon; }
    } catch { /* leave null — the client will retry on next load */ }
  }
}

/* ------------------------------------------------------------------ weather */

async function fetchWeather(lat, lon, date) {
  const base = `latitude=${lat}&longitude=${lon}&timezone=auto`;
  if (date === 'now') {
    const d = await fetchJson(`https://api.open-meteo.com/v1/forecast?${base}&current=temperature_2m,weather_code,is_day`);
    const c = d.current || {};
    if (typeof c.temperature_2m !== 'number') throw new Error('No current weather');
    return { kind: 'live', code: c.weather_code ?? null, temp: c.temperature_2m, isDay: c.is_day !== 0 };
  }
  // The archive lags a few days behind; very recent dates are served by the forecast API.
  const recent = Date.now() - Date.parse(`${date}T00:00:00Z`) < 7 * DAY_MS;
  const url = recent
    ? `https://api.open-meteo.com/v1/forecast?${base}&start_date=${date}&end_date=${date}&daily=weather_code,temperature_2m_max,temperature_2m_min`
    : `https://archive-api.open-meteo.com/v1/archive?${base}&start_date=${date}&end_date=${date}&daily=weather_code,temperature_2m_max,temperature_2m_min,temperature_2m_mean`;
  const d = await fetchJson(url);
  const daily = d.daily || {};
  const pick = (k) => (Array.isArray(daily[k]) && typeof daily[k][0] === 'number' ? daily[k][0] : null);
  const tmax = pick('temperature_2m_max');
  const tmin = pick('temperature_2m_min');
  let temp = pick('temperature_2m_mean');
  if (temp === null && tmax !== null && tmin !== null) temp = (tmax + tmin) / 2;
  if (temp === null) throw new Error('No archive weather');
  return { kind: 'archive', code: pick('weather_code') ?? pick('weathercode'), temp, tmax, tmin, isDay: true };
}

async function handleWeather(req, res) {
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  const date = String(req.query.date || '');
  if (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lon) || Math.abs(lon) > 180) {
    throw new HttpError(400, 'Invalid lat/lon');
  }
  if (date !== 'now') {
    const ms = /^\d{4}-\d{2}-\d{2}$/.test(date) ? Date.parse(`${date}T00:00:00Z`) : NaN;
    if (!Number.isFinite(ms) || date < '1940-01-01' || ms > Date.now()) {
      throw new HttpError(400, 'date must be "now" or YYYY-MM-DD between 1940-01-01 and today');
    }
  }
  const la = lat.toFixed(2);
  const lo = lon.toFixed(2);
  const ttl = date === 'now' ? TTL_LIVE : TTL_HISTORICAL;
  const key = `weather:v1:${la}:${lo}:${date}`;

  if (HAS_REDIS) {
    try {
      const hit = await redis(['GET', key]);
      if (hit) {
        res.setHeader('Cache-Control', `public, s-maxage=${ttl}`);
        return res.status(200).json({ weather: JSON.parse(hit), cached: true });
      }
    } catch { /* cache miss on Redis trouble — fall through to Open-Meteo */ }
  }

  let weather;
  try {
    weather = await fetchWeather(la, lo, date);
  } catch {
    throw new HttpError(502, 'Weather provider unavailable');
  }
  if (HAS_REDIS) {
    try { await redis(['SET', key, JSON.stringify(weather), 'EX', ttl]); } catch { /* non-fatal */ }
  }
  // Vercel's edge cache gives a second, free caching layer (and the only one in local mode).
  res.setHeader('Cache-Control', `public, s-maxage=${ttl}`);
  return res.status(200).json({ weather, cached: false });
}

/* ------------------------------------------------------------------ journey */

async function handleGet(req, res) {
  const userId = cleanUserId(req.query.user);
  const local = { journey: { ...seed, userId }, mode: 'local', editProtected: false };
  if (!HAS_REDIS) return res.status(200).json(local);
  try {
    const raw = await redis(['GET', `journey:${userId}`]);
    const journey = raw ? JSON.parse(raw) : { ...seed, userId };
    return res.status(200).json({ journey, mode: 'redis', seeded: !raw, editProtected: Boolean(EDIT_TOKEN) });
  } catch (err) {
    console.error('[journey] Redis read failed, serving seed:', err.message);
    return res.status(200).json(local);
  }
}

async function handlePost(req, res) {
  let body = req.body;
  if (typeof body === 'string') {
    if (body.length > MAX_BODY_CHARS) throw new HttpError(413, 'Payload too large');
    try { body = JSON.parse(body); } catch { throw new HttpError(400, 'Body must be JSON'); }
  }
  if (!body || typeof body !== 'object') throw new HttpError(400, 'Body must be JSON');
  if (JSON.stringify(body).length > MAX_BODY_CHARS) throw new HttpError(413, 'Payload too large');

  const userId = cleanUserId(req.query.user || (body.journey && body.journey.userId));
  const journey = sanitizeJourney(body.journey, userId);

  if (!HAS_REDIS) {
    // Nothing to persist to: the client keeps the edit in its own browser storage.
    return res.status(200).json({ ok: true, persisted: false, mode: 'local', journey });
  }
  if (EDIT_TOKEN && !tokenMatches(req.headers['x-edit-token'])) {
    throw new HttpError(401, 'Edit passphrase required');
  }
  await fillMissingCoords(journey);
  await redis(['SET', `journey:${userId}`, JSON.stringify(journey)]);
  return res.status(200).json({ ok: true, persisted: true, mode: 'redis', journey });
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    req.query = req.query || {};
    if (req.method === 'GET') {
      return req.query.resource === 'weather' ? await handleWeather(req, res) : await handleGet(req, res);
    }
    if (req.method === 'POST') return await handlePost(req, res);
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error('[journey]', err);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(status).json({ error: status === 500 ? 'Internal error' : err.message });
  }
};
