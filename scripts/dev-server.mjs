/**
 * Minimal local server: static files + the /api routes, shaped like Vercel's Node runtime (req.query, req.body, res.status().json()).
 * No dependencies and no Vercel login needed:  npm run dev   → http://localhost:3000
 * Reads .env.local if present. Without Upstash variables the app runs in clearly-labelled demo mode.
 * The end-to-end tests import createApp() from here so they exercise the real route code.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.png': 'image/png' };
const PUBLIC = [/^\/index\.html$/, /^\/journey\.json$/, /^\/lib\/[\w.-]+\.mjs$/];

/** Load the API handlers fresh, so each call sees the current process.env (they read configuration at load time). */
export function loadHandlers() {
  const require = createRequire(import.meta.url);
  for (const k of Object.keys(require.cache)) if (k.startsWith(path.join(ROOT, 'api'))) delete require.cache[k];
  return { journey: require(path.join(ROOT, 'api/journey.js')), geocode: require(path.join(ROOT, 'api/geocode.js')) };
}

export function createApp() {
  const handlers = loadHandlers();
  // Send the same site-wide headers production sends (vercel.json), so the Content-Security-Policy is exercised locally and in tests.
  const siteHeaders = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8')).headers.find((h) => h.source === '/(.*)').headers;
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    for (const h of siteHeaders) res.setHeader(h.key, h.value);
    const route = { '/api/journey': handlers.journey, '/api/geocode': handlers.geocode }[url.pathname];
    if (route) {
      const chunks = []; for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString('utf8');
      req.query = Object.fromEntries(url.searchParams);
      if (raw && /json/i.test(req.headers['content-type'] || '')) { try { req.body = JSON.parse(raw); } catch { req.body = raw; } } else if (raw) req.body = raw;
      res.status = (code) => { res.statusCode = code; return res; };
      res.json = (obj) => { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(obj)); return res; };
      return route(req, res);
    }
    const p = url.pathname === '/' ? '/index.html' : url.pathname;
    if (!PUBLIC.some((re) => re.test(p))) { res.statusCode = 404; return res.end('Not found'); }
    fs.readFile(path.join(ROOT, p), (err, buf) => {
      if (err) { res.statusCode = 404; return res.end('Not found'); }
      res.setHeader('Content-Type', MIME[path.extname(p)] || 'application/octet-stream'); res.setHeader('Cache-Control', 'no-store'); res.end(buf);
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const envFile = path.join(ROOT, '.env.local');
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  const port = Number(process.env.PORT) || 3000;
  createApp().listen(port, () => console.log(`The Journey → http://localhost:${port}  (${process.env.UPSTASH_REDIS_REST_URL ? 'cloud storage configured' : 'demo mode: no Upstash variables'})`));
}
