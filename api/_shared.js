/**
 * Server-only helpers shared by the API routes (the leading underscore keeps Vercel from exposing this file as a route).
 * Secrets are read here and never leave the server.
 */
'use strict';

const crypto = require('crypto');

const env = (k) => (process.env[k] || '').trim();
const REDIS_URL = env('UPSTASH_REDIS_REST_URL').replace(/\/+$/, '');
const REDIS_TOKEN = env('UPSTASH_REDIS_REST_TOKEN');
const EDIT_TOKEN = env('JOURNEY_EDIT_TOKEN');
const HAS_REDIS = Boolean(REDIS_URL && REDIS_TOKEN);
const SESSION_COOKIE = 'journey_edit';
const SESSION_DAYS = 7;

class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

async function fetchJson(url, init = {}, timeoutMs = 8000) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const data = await r.json().catch(() => null);
  if (!r.ok || data === null) { const e = new Error(`Upstream HTTP ${r.status}`); e.upstreamStatus = r.status; throw e; }
  return data;
}

/** Upstash REST: one command as a JSON array, e.g. ["SET","key","value","EX",60]. Plain strings only — no RedisJSON. */
async function redis(command) {
  const data = await fetchJson(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  }, 5000);
  if (data.error) throw new Error(`Upstash: ${data.error}`);
  return data.result;
}
/** Several commands in one HTTP round trip (saves latency, not atomic). Throws if any command failed. */
async function redisPipeline(commands) {
  const data = await fetchJson(`${REDIS_URL}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
  }, 6000);
  if (!Array.isArray(data)) throw new Error('Upstash: bad pipeline reply');
  const bad = data.find((d) => d && d.error);
  if (bad) throw new Error(`Upstash: ${bad.error}`);
  return data.map((d) => d.result);
}

const cleanJourneyId = (v) => String(v || 'default').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40) || 'default';

function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || String(req.headers['x-real-ip'] || '') || (req.socket && req.socket.remoteAddress) || 'unknown';
}
const hashIp = (ip) => crypto.createHash('sha256').update(`journey-ip|${ip}`).digest('hex').slice(0, 24);

/* ---- rate limiting: Redis fixed window when available (shared across instances), in-memory otherwise */
const memWindows = new Map();
function memLimit(key, limit, windowSec) {
  const now = Date.now(), w = memWindows.get(key);
  if (!w || now > w.reset) { memWindows.set(key, { n: 1, reset: now + windowSec * 1000 }); if (memWindows.size > 5000) memWindows.clear(); return { ok: true, retryAfter: 0 }; }
  w.n++;
  return { ok: w.n <= limit, retryAfter: Math.ceil((w.reset - now) / 1000) };
}
async function rateLimit(key, limit, windowSec, { shared = false } = {}) {
  if (shared && HAS_REDIS) {
    try {
      const [n, , ttl] = await redisPipeline([['INCR', `rl:${key}`], ['EXPIRE', `rl:${key}`, windowSec, 'NX'], ['TTL', `rl:${key}`]]);
      return { ok: Number(n) <= limit, retryAfter: Math.max(1, Number(ttl) || windowSec) };
    } catch { /* fall through to the in-memory window rather than failing open */ }
  }
  return memLimit(key, limit, windowSec);
}

/* ---- owner session: HMAC-signed, HttpOnly cookie. The passphrase itself is only ever sent once, to open the session. */
const sessionKey = () => crypto.createHash('sha256').update(`journey-session|${EDIT_TOKEN}|${env('JOURNEY_SESSION_SECRET')}`).digest();
const sign = (payload) => crypto.createHmac('sha256', sessionKey()).update(payload).digest('base64url');
function passphraseMatches(given) {
  if (!EDIT_TOKEN) return false;
  const a = crypto.createHash('sha256').update(String(given || '')).digest();
  const b = crypto.createHash('sha256').update(EDIT_TOKEN).digest();
  return crypto.timingSafeEqual(a, b);
}
function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach((part) => { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim(); });
  return out;
}
function hasSession(req) {
  if (!EDIT_TOKEN) return false;
  const raw = parseCookies(req)[SESSION_COOKIE] || '';
  const [exp, mac] = raw.split('.');
  if (!exp || !mac || !/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  const good = Buffer.from(sign(`v1.${exp}`)), got = Buffer.from(mac);
  return good.length === got.length && crypto.timingSafeEqual(good, got);
}
const isLocalHost = (req) => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(String(req.headers.host || ''));
function sessionCookie(req, clear = false) {
  const exp = Date.now() + SESSION_DAYS * 864e5;
  const value = clear ? '' : `${exp}.${sign(`v1.${exp}`)}`;
  return [`${SESSION_COOKIE}=${value}`, 'Path=/api', 'HttpOnly', 'SameSite=Strict', `Max-Age=${clear ? 0 : SESSION_DAYS * 86400}`, ...(isLocalHost(req) ? [] : ['Secure'])].join('; ');
}

/** State-changing requests must come from this site's own pages (CSRF defence on top of SameSite=Strict). */
function assertSameOrigin(req) {
  const origin = String(req.headers.origin || '');
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '');
  let ok = false;
  try { ok = Boolean(origin) && new URL(origin).host === host; } catch { ok = false; }
  if (!ok) throw new HttpError(403, 'Cross-site request refused');
  if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) throw new HttpError(415, 'Content-Type must be application/json');
}

function readBody(req, maxChars) {
  let body = req.body;
  if (typeof body === 'string') {
    if (body.length > maxChars) throw new HttpError(413, 'Payload too large');
    try { body = JSON.parse(body); } catch { throw new HttpError(400, 'Body must be JSON'); }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Body must be a JSON object');
  if (JSON.stringify(body).length > maxChars) throw new HttpError(413, 'Payload too large');
  return body;
}

/** Wrap a route: uniform JSON errors, no stack traces or secrets in responses. */
function route(handler) {
  return async function wrapped(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    try {
      req.query = req.query || {};
      return await handler(req, res);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : err && err.name === 'ValidationError' ? 400 : 500;
      if (status === 500) console.error('[journey]', err);
      res.setHeader('Cache-Control', 'no-store');
      if (err && err.extra && err.extra.retryAfter) res.setHeader('Retry-After', String(err.extra.retryAfter));
      return res.status(status).json({ error: status === 500 ? 'Internal error' : err.message, ...(err.path ? { path: err.path } : {}), ...(err.extra || {}) });
    }
  };
}

module.exports = {
  HAS_REDIS, EDIT_TOKEN, HttpError, env, fetchJson, redis, redisPipeline, cleanJourneyId, clientIp, hashIp,
  rateLimit, passphraseMatches, hasSession, sessionCookie, assertSameOrigin, readBody, route,
};
