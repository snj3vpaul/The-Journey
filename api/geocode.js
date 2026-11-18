/**
 * The Journey — place search proxy (autocomplete).
 *
 *   GET /api/geocode?q=<text>[&lang=en|de|fr]  -> { results: [{ placeId, name, region, country, countryCode, latitude, longitude, kind }], provider, cached }
 *
 * Provider: Photon (https://photon.komoot.io), which is built for search-as-you-type. The public instance asks for fair use,
 * so this proxy caches every query, throttles outbound calls and rate-limits callers. Point GEOCODER_URL at your own
 * Photon instance to lift those limits. Nominatim's public endpoint is deliberately NOT used: its policy forbids autocomplete.
 */
'use strict';

const S = require('./_shared.js');
const { HttpError } = S;

const GEOCODER_URL = (S.env('GEOCODER_URL') || 'https://photon.komoot.io/api').replace(/\/+$/, '');
const USER_AGENT = S.env('GEOCODER_USER_AGENT') || 'TheJourney/2.0 (personal life-map; place autocomplete proxy)';
const LAYERS = ['city', 'district', 'locality', 'county', 'state', 'country'];
const TTL_HIT = 60 * 60 * 24 * 30, TTL_EMPTY = 60 * 60 * 24;
const MIN_CHARS = 2, MAX_CHARS = 80;

// Outbound throttle (per warm instance): a small token bucket so a burst of typing cannot hammer the provider.
const bucket = { tokens: 4, at: Date.now() };
function takeToken() {
  const now = Date.now();
  bucket.tokens = Math.min(4, bucket.tokens + (now - bucket.at) / 1000 * 2);   // refill 2/s, burst 4
  bucket.at = now;
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1; return true;
}

async function searchPhoton(q, lang) {
  const build = (filtered) => {
    const u = new URL(GEOCODER_URL);
    u.searchParams.set('q', q); u.searchParams.set('limit', '12');
    if (filtered) { u.searchParams.set('lang', lang); LAYERS.forEach((l) => u.searchParams.append('layer', l)); }
    return u;
  };
  const headers = { Accept: 'application/json', 'User-Agent': USER_AGENT };
  try { return await S.fetchJson(build(true), { headers }, 6000); }
  catch (err) {
    if (err.upstreamStatus !== 400) throw err;                // some Photon builds reject layer/lang filters — retry plain once
    return S.fetchJson(build(false), { headers }, 6000);
  }
}

module.exports = S.route(async (req, res) => {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); throw new HttpError(405, 'Method not allowed'); }
  const q = String(req.query.q || '').replace(/\s+/g, ' ').trim();
  if (q.length < MIN_CHARS) throw new HttpError(400, `Type at least ${MIN_CHARS} characters`);
  if (q.length > MAX_CHARS) throw new HttpError(400, 'Query too long');
  const lang = ['en', 'de', 'fr'].includes(req.query.lang) ? req.query.lang : 'en';

  // Only the signed-in owner may search once an owner exists; open demo deployments get a per-visitor limit instead.
  if (S.EDIT_TOKEN && !S.hasSession(req)) throw new HttpError(401, 'Sign in to search for places.', { code: 'signed_out' });
  const limit = await S.rateLimit(`geo:${S.hashIp(S.clientIp(req))}`, 40, 60);
  if (!limit.ok) throw new HttpError(429, 'Searching too fast — one moment.', { code: 'rate_limited', retryAfter: limit.retryAfter });

  const { normalizePhotonFeature, rankPlaces } = await import('../lib/core.mjs');
  const key = `geo:v1:${lang}:${q.toLowerCase()}`;
  if (S.HAS_REDIS) {
    try {
      const hit = await S.redis(['GET', key]);
      if (hit) { res.setHeader('Cache-Control', 'private, max-age=3600'); return res.status(200).json({ results: JSON.parse(hit), provider: 'photon', cached: true }); }
    } catch { /* cache trouble — ask the provider */ }
  }
  if (!takeToken()) throw new HttpError(429, 'Search is busy — one moment.', { code: 'throttled', retryAfter: 1 });

  let data;
  try { data = await searchPhoton(q, lang); }
  catch (err) {
    const throttled = err.upstreamStatus === 429 || err.upstreamStatus === 403;
    throw new HttpError(throttled ? 429 : 502, throttled ? 'The place search service is limiting requests right now.' : 'The place search service could not be reached.',
      { code: throttled ? 'provider_throttled' : 'provider_unavailable', ...(throttled ? { retryAfter: 5 } : {}) });
  }
  const features = Array.isArray(data.features) ? data.features : [];
  const results = rankPlaces(q, features.map(normalizePhotonFeature).filter(Boolean), 6);
  if (S.HAS_REDIS) { try { await S.redis(['SET', key, JSON.stringify(results), 'EX', results.length ? TTL_HIT : TTL_EMPTY]); } catch { /* non-fatal */ } }
  res.setHeader('Cache-Control', 'private, max-age=3600');
  return res.status(200).json({ results, provider: 'photon', cached: false });
});
