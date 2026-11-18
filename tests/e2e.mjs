/**
 * End-to-end checks in a real browser (headless Chrome, WebGL via SwiftShader) against the real route code.
 * Upstream services are replaced by tests/fakes.mjs — place search results are FIXTURES, not live Photon data.
 *
 *   npm run test:e2e            CHROME_PATH=/path/to/chrome   SHOTS=dir-for-screenshots   EARTH_TEXTURE=local.jpg (optional)
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { installFakes, setEnv, LEGACY_V1 } from './fakes.mjs';
import { createApp } from '../scripts/dev-server.mjs';

const require = createRequire(import.meta.url);
const THREE_DIR = path.resolve(path.dirname(require.resolve('three')), '..');
const SHOTS = process.env.SHOTS || ''; if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
let browser, fakes, server, base;

async function startServer(env) { if (server) await new Promise((r) => server.close(r)); setEnv(env); server = createApp().listen(0); base = `http://localhost:${server.address().port}`; }
async function newPage({ width = 1440, height = 860, mobile = false, reducedMotion = false } = {}) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width, height, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1 });
  if (reducedMotion) await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.setRequestInterception(true);
  page.net = [];
  page.on('request', (r) => {
    const u = r.url();
    if (u.includes('cdn.jsdelivr.net/npm/three@0.160.0/')) return r.respond({ status: 200, contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' }, body: fs.readFileSync(path.join(THREE_DIR, u.split('three@0.160.0/')[1])) });
    if (u.includes('earth-day.jpg')) return process.env.EARTH_TEXTURE ? r.respond({ status: 200, contentType: 'image/jpeg', headers: { 'access-control-allow-origin': '*' }, body: fs.readFileSync(process.env.EARTH_TEXTURE) }) : r.abort();
    if (u.startsWith(base)) { page.net.push(`${r.method()} ${u.slice(base.length)}`); return r.continue(); }
    if (u.startsWith('data:') || u.startsWith('blob:')) return r.continue();
    r.abort();
  });
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  return page;
}
async function open(page, url = '/') {
  await page.goto(base + url, { waitUntil: 'load' });
  await page.waitForFunction(() => document.querySelector('#loader').classList.contains('done'), { timeout: 30000 });
  await sleep(300);
}
const state = (page) => page.evaluate(() => window.__journey.state());
const text = (page, sel) => page.$eval(sel, (el) => el.textContent.trim());
const visible = (page, sel) => page.$eval(sel, (el) => { const r = el.getBoundingClientRect(); return !el.hidden && !el.closest('[hidden]') && !el.closest('[inert]') && r.width > 0 && r.height > 0; }).catch(() => false);
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); };
const waitText = (page, sel, re, timeout = 8000) => page.waitForFunction((s, src) => new RegExp(src, 'i').test(document.querySelector(s)?.textContent || ''), { timeout }, sel, re.source);
/** Wait until nothing is mid-transition: no timeline tween, every halo fully on or fully off. */
const settled = (page, timeout = 15000) => page.waitForFunction(() => { const s = window.__journey.state(); return s.places.every((p) => p.lit === 0 || p.lit === 1); }, { timeout, polling: 100 });
const setT = async (page, t, wait = 900) => { await page.$eval('#scrub', (el, v) => { el.value = String(Math.min(100000, Math.ceil(v * 100000))); el.dispatchEvent(new Event('input', { bubbles: true })); }, t); await sleep(wait); await settled(page); };
const clickItem = (page, name, what) => page.evaluate((n, w) => { const li = [...document.querySelectorAll('#edList .item')].find((el) => el.querySelector('b').textContent === n); li.querySelector(`[data-${w}]`).click(); }, name, what);
const setValue = (page, sel, v) => page.$eval(sel, (el, val) => { el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }, v);
const typeSearch = async (page, q) => { await page.click('#fPlace', { clickCount: 3 }); await page.keyboard.press('Backspace'); await page.type('#fPlace', q, { delay: 15 }); };
const waitResults = (page) => page.waitForFunction(() => !document.querySelector('#locList').hidden && document.querySelectorAll('#locList li').length > 0, { timeout: 8000 });
const listResults = (page) => page.$$eval('#locList li', (els) => els.map((li) => ({ name: li.querySelector('b').textContent, sub: li.querySelector('small').textContent, kind: li.querySelector('.kind').textContent })));
const stored = (key = 'journey:default') => { const raw = fakes.state.store.get(key); return raw ? JSON.parse(raw) : null; };
async function unlock(page) { await page.type('#unlockPass', 'correct horse'); await page.click('#unlockForm button[type=submit]'); await page.waitForFunction(() => !document.querySelector('#unlockForm')); }
async function openEditor(page) { if (!(await visible(page, '#journeyPanel'))) await page.click('#editBtn'); await page.waitForSelector('#journeyPanel.open'); await sleep(350); }
/** Fill the place form using the search flow and save. Returns once the save has been confirmed in the UI. */
async function addPlace(page, { query, pick = 0, y, m, d, type, current, expectToast = /added to your journey/ }) {
  if (!(await visible(page, '#detailPanel'))) { await page.click('#addPlace'); await page.waitForSelector('#detailPanel.open'); await sleep(450); }   // let the panel finish sliding in before clicking into it
  await typeSearch(page, query); await waitResults(page);
  await page.click(`#locList li[data-i="${pick}"]`);
  await page.waitForFunction(() => !document.querySelector('#locCard').hidden);
  await setValue(page, '#fY', String(y)); if (m) await page.select('#fM', String(m)); if (d) await page.select('#fD', String(d));
  if (type) await page.select('#fType', type);
  if (current) await page.click('#fCurrent');
  await page.click('#fSubmit');
  await waitText(page, '#toast', expectToast);
  await page.waitForFunction(() => !document.querySelector('#detailPanel').classList.contains('open'));
  await sleep(1800); await settled(page);              // camera flight + halo
}
async function check(name, fn) {
  const t0 = Date.now();
  try { await fn(); results.push({ name, ok: true }); console.log(`  ✓ ${name} (${Date.now() - t0} ms)`); }
  catch (err) { results.push({ name, ok: false, err: err.message }); if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `FAIL-${results.length}.png`) }).catch(() => {}); console.log(`  ✗ ${name}\n      ${String(err.message).split('\n').slice(0, 6).join('\n      ')}`); }
}

browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
fakes = installFakes();

/* ============================================================ A. cloud storage, owner flow */
console.log('\nA. Cloud mode (fake Upstash), signed-out visitor → owner');
await startServer({ redis: true });
let page = await newPage();

await check('loads the sample without writing anything; visitor cannot edit', async () => {
  await open(page);
  const s = await state(page);
  assert.equal(s.apiMode, 'cloud'); assert.equal(s.canEdit, false); assert.equal(s.places.length, 10);
  assert.ok(![...fakes.state.store.keys()].some((k) => k.startsWith('journey:')), 'no journey write on load (only weather cache entries)'); assert.ok(!page.net.some((n) => /^(PUT|POST)/.test(n)), 'no state-changing request on load');
  await openEditor(page);
  assert.equal(await page.$eval('#addPlace', (b) => b.disabled), true);
  assert.equal(await text(page, '#saveState'), 'View only');
  assert.deepEqual(page.errors, []);
});
await check('26 · unauthenticated save attempt is refused by the server (401) and nothing is stored', async () => {
  const r = await page.evaluate(async () => { const j = window.__journey.state().journey; const res = await fetch('/api/journey', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ journey: j, baseRevision: 0 }) }); return { status: res.status, body: await res.json() }; });
  assert.equal(r.status, 401); assert.equal(r.body.persisted, undefined); assert.equal(stored(), null);
});
await check('wrong passphrase is rejected; the right one unlocks editing (HttpOnly session cookie, not readable by scripts)', async () => {
  await page.type('#unlockPass', 'wrong'); await page.click('#unlockForm button[type=submit]');
  await waitText(page, '#unlockStatus', /not correct/);
  await page.$eval('#unlockPass', (el) => { el.value = ''; });
  await unlock(page);
  assert.equal((await state(page)).canEdit, true);
  assert.equal(await page.evaluate(() => document.cookie.includes('journey_edit')), false);
  assert.equal(await page.evaluate(() => Object.keys(sessionStorage).length + Object.keys(localStorage).filter((k) => /token|pass/i.test(k)).length), 0, 'no secret in web storage');
});
await check('empty state after "Start my own": guidance text and one clear action', async () => {
  await page.click('[data-act="fresh"]'); await page.waitForSelector('#detailPanel.open');
  assert.equal(await page.$eval('#fType', (el) => el.value), 'birthplace');
  await page.click('#fCancel'); await page.click('#editorClose'); await sleep(400);
  assert.equal(await text(page, '#gateTitle'), 'Every journey begins somewhere.');
  assert.match(await text(page, '#gateText'), /Add your birthplace to illuminate your first corner of the world/);
  assert.equal(await text(page, '#gateAction'), 'Add first place');
  const leftover = await page.evaluate(() => [[40.71, -74.0], [43.65, -79.38], [51.5, -0.12], [0, 0]].map(([la, lo]) => window.__journey.maskAt(la, lo, 2)));
  assert.ok(leftover.every((v) => v === 0), `no light survives from the sample journey (${leftover})`);
  await shot(page, '01-empty-state');
  await page.click('#gateAction'); await page.waitForSelector('#detailPanel.open'); await sleep(400);
});
await check('1–2 · typing "Nawanshahr" shows the Punjab, India result first, with hierarchy and type; non-places filtered; duplicates merged', async () => {
  fakes.state.photonSlow.Nawanshahr = 900;                    // hold the reply long enough to observe the loading state
  await typeSearch(page, 'Nawanshahr');
  await waitText(page, '#locState', /Searching/); assert.equal(await page.$eval('#locState .spin', (el) => Boolean(el)), true);
  await waitResults(page); delete fakes.state.photonSlow.Nawanshahr;
  const list = await listResults(page);
  assert.deepEqual(list[0], { name: 'Nawanshahr', sub: 'Shaheed Bhagat Singh Nagar, Punjab, India', kind: 'Town' });
  assert.equal(list.filter((r) => r.name === 'Nawanshahr').length, 1, 'node + boundary duplicate merged');
  assert.ok(!list.some((r) => /Road/.test(r.name)), 'streets are not offered');
  assert.equal(list[1].sub.includes('Pakistan'), true, 'the similarly named town elsewhere is distinguishable');
  assert.equal(await page.$eval('#fPlace', (el) => el.getAttribute('aria-expanded')), 'true');
  await shot(page, '02-search-results');
});
await check('typing alone is not a location: saving without choosing a result is blocked', async () => {
  await setValue(page, '#fY', '1990'); await page.click('#fSubmit');
  await waitText(page, '#edStatus', /Choose the location first/);
  assert.equal(stored(), null);
});
await check('3 · keyboard selection (↓, Enter) confirms name, region, country and coordinates; Escape closes the list first', async () => {
  await page.focus('#fPlace'); await page.keyboard.press('Escape');
  assert.equal(await page.$eval('#locList', (el) => el.hidden), true); assert.equal(await visible(page, '#detailPanel'), true, 'Escape closed the list, not the editor');
  await typeSearch(page, 'Nawanshahr'); await waitResults(page);
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.$eval('#fPlace', (el) => el.getAttribute('aria-activedescendant')), 'loc-opt-0');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !document.querySelector('#locCard').hidden);
  assert.equal(await text(page, '#lcName'), 'Nawanshahr');
  assert.equal(await text(page, '#lcRegion'), 'Shaheed Bhagat Singh Nagar, Punjab, India');
  assert.equal(await text(page, '#lcCoords'), '31.1256° N, 76.1162° E');
  assert.equal(await text(page, '#lcSource'), 'Verified by place search');
  await sleep(1600);
  const cam = (await state(page)).camera;
  assert.ok(Math.abs(cam.lon - 76.1) < 6 && Math.abs(cam.lat - 31.1) < 22, `globe turned to the previewed place (camera ${cam.lat}, ${cam.lon})`);
  await shot(page, '03-location-confirmed');
});
await check('"Change location" invalidates the selection until a result is chosen again', async () => {
  await page.click('#locChange');
  await page.click('#fSubmit'); await waitText(page, '#edStatus', /Choose the location first/);
  await waitResults(page); await page.click('#locList li[data-i="0"]');
  await page.waitForFunction(() => !document.querySelector('#locCard').hidden);
});
await check('4, 21 · save with a year only → confirmed by the backend, toast names the place, globe + timeline show it; year precision stored', async () => {
  await setValue(page, '#fY', '1990'); await page.click('#fSubmit');
  await waitText(page, '#toast', /Nawanshahr, Punjab added to your journey\./);
  const doc = stored();
  assert.equal(doc.revision, 1); assert.equal(doc.waypoints.length, 1);
  const w = doc.waypoints[0];
  assert.deepEqual([w.latitude, w.longitude, w.geocodeSource, w.placeId], [31.1256, 76.1162, 'photon', 'osm:N101']);
  assert.deepEqual([w.startDate, w.startDatePrecision, w.endDate, w.isCurrent], ['1990', 'year', null, false]);
  assert.equal(doc.birthDate, '1990'); assert.equal(doc.birthDatePrecision, 'year');
  await sleep(2000); await settled(page);
  const s = await state(page), p = s.places[0];
  assert.deepEqual([p.lat, p.lon], [31.1256, 76.1162]); assert.equal(p.reached, true); assert.equal(p.markerVisible, true); assert.ok(p.lit > 0.9);
  assert.ok(p.screen && Math.abs(p.screen.x - (1440 + 384) / 2) < 140, `marker sits in the free area of the screen (${JSON.stringify(p.screen)})`);
  assert.ok(await page.evaluate(() => window.__journey.maskAt(31.1256, 76.1162)) > 150, 'Discovery light is on at the saved coordinates');
  assert.equal(await page.$$eval('#pins .pin', (els) => els.length), 1);
  assert.match(await text(page, '#edList'), /Nawanshahr/); assert.match(await text(page, '#edList'), /1990 · Birthplace · India/);
  assert.match(await text(page, '#hudWhen'), /Age ≈ 0/, 'age from a year-only birth date is marked approximate');
  assert.equal(await page.$eval('#weatherChip', (el) => el.hidden), true, 'no daily weather for a year-only date');
  assert.equal(await page.$eval('#seasonChip', (el) => el.hidden), true, 'no season for a year-only date');
  assert.equal(await text(page, '#saveState'), 'Saved ✓');
  await shot(page, '04-saved-first-place');
});
await check('7 · reload: the place persists (loaded from the store, owner session intact)', async () => {
  await open(page);
  const s = await state(page);
  assert.equal(s.places.length, 1); assert.equal(s.places[0].name, 'Nawanshahr'); assert.equal(s.revision, 1); assert.equal(s.canEdit, true);
});
await check('spelling variant "Nawan Shahr" and the wider "Shaheed Bhagat Singh Nagar" district are found — without inventing matches', async () => {
  await openEditor(page); await page.click('#addPlace'); await page.waitForSelector('#detailPanel.open');
  await typeSearch(page, 'Nawan Shahr'); await waitResults(page);
  assert.equal((await listResults(page))[0].name, 'Nawanshahr');
  await sleep(700); await typeSearch(page, 'Shaheed Bhagat Singh Nagar'); await waitResults(page);
  assert.deepEqual((await listResults(page))[0], { name: 'Shaheed Bhagat Singh Nagar', sub: 'Punjab, India', kind: 'County / district' });
  await sleep(700); await typeSearch(page, 'zzzznowhere');
  await waitText(page, '#locState', /No place found for “zzzznowhere”/);
  assert.equal(await page.$eval('#locList', (el) => el.hidden), true);
});
await check('stale replies cannot overwrite newer ones (slow "lond…" answer arrives after "Lisbon")', async () => {
  await sleep(700); fakes.state.photonSlow.lond = 1800;
  await typeSearch(page, 'lond'); await sleep(500);
  await typeSearch(page, 'Lisbon'); await waitResults(page);
  await sleep(2200);
  assert.deepEqual((await listResults(page)).map((r) => r.name), ['Lisbon']);
  assert.equal(await page.$eval('#fPlace', (el) => el.value), 'Lisbon');
});
await check('5 · a village (month precision) and a non-Latin query (東京, exact day, currently here) can be added', async () => {
  await sleep(700);
  await addPlace(page, { query: 'Khatkar Kalan', y: 1996, m: 9, type: 'home' });
  await addPlace(page, { query: '東京', y: 2015, m: 3, d: 28, type: 'work', current: true });
  const doc = stored();
  assert.deepEqual(doc.waypoints.map((w) => [w.placeName, w.locationPrecision, w.startDate, w.startDatePrecision]), [['Nawanshahr', 'town', '1990', 'year'], ['Khatkar Kalan', 'village', '1996-09', 'month'], ['Tokyo', 'city', '2015-03-28', 'day']]);
  const tokyo = doc.waypoints[2];
  assert.deepEqual([tokyo.isCurrent, tokyo.endDate, tokyo.latitude, tokyo.longitude], [true, null, 35.6895, 139.6917], '22 · ongoing stay stored with endDate null, not "NOW"');
  assert.ok(!JSON.stringify(doc).includes('NOW'));
  const s = await state(page);
  assert.equal(s.idx, 2, 'timeline focused the newly added place'); assert.ok(Math.abs(s.T - s.places[2].t) < 1e-3);
  assert.match(await text(page, '#weatherChip'), /12–21°C · Rain · historical estimate/, 'exact past day → labelled historical estimate');
  await shot(page, '05-three-places');
});

await check('11–14 · Discovery: from the first place, future places are dark, unmarked and off the timeline; each lights up when reached', async () => {
  await page.click('#editorClose'); await sleep(500);
  await setT(page, 0, 1800);
  let s = await state(page);
  assert.equal(s.mode, 'dark');
  assert.deepEqual(s.places.map((p) => p.reached), [true, false, false]);
  assert.deepEqual(s.places.map((p) => p.markerVisible), [true, false, false]);
  assert.deepEqual(s.places.map((p) => p.lit > 0), [true, false, false]);
  assert.deepEqual(s.arcs.map((a) => a.drawn), [false, false]);
  const m = await page.evaluate(() => [[31.1256, 76.1162], [31.106, 76.029], [35.6895, 139.6917], [48.85, 2.35], [40.7, -74]].map(([a, b]) => window.__journey.maskAt(a, b)));
  assert.ok(m[0] > 150, `birthplace lit (${m[0]})`); assert.equal(m[2], 0, 'Tokyo dark'); assert.equal(m[3], 0, 'Paris (never visited) dark'); assert.equal(m[4], 0, 'New York (never visited) dark');
  assert.deepEqual(await page.$$eval('#pins .pin', (els) => els.map((el) => getComputedStyle(el).visibility)), ['visible', 'hidden', 'hidden']);
  await shot(page, '06-discovery-start');
  const total0 = await page.evaluate(() => window.__journey.maskTotal());
  await setT(page, s.places[1].t, 1800); s = await state(page);
  assert.deepEqual(s.places.map((p) => p.reached), [true, true, false]); assert.equal(s.places[1].lit, 1); assert.equal(s.places[2].lit, 0);
  await setT(page, s.places[2].t, 1800); s = await state(page);
  assert.deepEqual(s.places.map((p) => p.lit), [1, 1, 1]); assert.deepEqual(s.arcs.map((a) => a.drawn), [true, true]);
  assert.ok(await page.evaluate(() => window.__journey.maskAt(35.6895, 139.6917)) > 150);
  const total2 = await page.evaluate(() => window.__journey.maskTotal());
  assert.ok(total2 > total0);
  const share = total2 / (255 * 2048 * 1024);
  assert.ok(share < 0.004, `three places light ${(share * 100).toFixed(3)}% of the map texture — local glows, not countries`);
  await shot(page, '07-discovery-all-reached');
});
await check('15 · scrubbing backward returns the later places to darkness', async () => {
  const before = await state(page);
  await setT(page, before.places[1].t - 0.01, 1500);
  let s = await state(page);
  assert.deepEqual(s.places.map((p) => p.reached), [true, false, false]); assert.deepEqual(s.places.map((p) => p.lit), [1, 0, 0]);
  assert.equal(await page.evaluate(() => window.__journey.maskAt(35.6895, 139.6917)), 0);
  assert.deepEqual(s.places.map((p) => p.markerVisible), [true, false, false]);
  await setT(page, 0, 1200); s = await state(page);
  assert.deepEqual(s.places.map((p) => p.lit), [1, 0, 0]);
});
await check('12 · playback advances journeyTime; pause holds it; 4× runs about four times faster than 1×', async () => {
  const rate = () => page.evaluate(async () => { const a = window.__journey.state().T, t0 = performance.now(); await new Promise((r) => setTimeout(r, 1200)); return (window.__journey.state().T - a) / (performance.now() - t0); });
  await page.click('#play'); const r1 = await rate(); await page.click('#play');
  const a = (await state(page)).T; await sleep(500);
  assert.equal((await state(page)).T, a, 'paused'); assert.ok(a > 0);
  await page.click('[data-speed="4"]'); await page.click('#play'); const r4 = await rate(); await page.click('#play');
  assert.ok(r4 / r1 > 3 && r4 / r1 < 5, `speed ratio ${(r4 / r1).toFixed(2)}`);
  await page.click('[data-speed="1"]');
});
await check('16 · switching Discovery ↔ Full Map keeps time, and Full Map shows every place', async () => {
  const before = await state(page);
  await page.click('[data-mode="full"]'); await sleep(1200);
  let s = await state(page);
  assert.equal(s.mode, 'full'); assert.equal(s.T, before.T); assert.deepEqual(s.places.map((p) => p.markerVisible), [true, true, true]);
  await shot(page, '08-full-map');
  await page.click('[data-mode="dark"]'); await sleep(1200); s = await state(page);
  assert.equal(s.mode, 'dark'); assert.equal(s.T, before.T); assert.deepEqual(s.places.map((p) => p.markerVisible), s.places.map((p) => p.reached));
});
await check('17 · camera and active place stay in sync; dragging the globe pauses follow until re-enabled', async () => {
  await page.click('#pins .pin:nth-child(1)'); await sleep(2000);
  await setT(page, (await state(page)).places[2].t, 1600);
  let s = await state(page);
  assert.equal(s.idx, 2); assert.equal(s.follow, true);
  assert.ok(Math.abs(s.camera.lon - 139.7) < 3, `camera over Tokyo (${s.camera.lon})`);
  await page.mouse.move(720, 380); await page.mouse.down(); await page.mouse.move(520, 380, { steps: 8 }); await page.mouse.up();
  for (let prev = null, i = 0; i < 60; i++) { await sleep(400); const c = (await state(page)).camera.lon; if (prev !== null && Math.abs(c - prev) < 0.02) break; prev = c; }   // let the drag's inertia die down
  s = await state(page); assert.equal(s.follow, false);
  const parked = s.camera.lon;
  await setT(page, s.places[0].t, 1200); s = await state(page);
  assert.equal(s.idx, 0, 'time still moves'); assert.ok(Math.abs(s.camera.lon - parked) < 1, 'camera stays where the user left it');
  assert.equal(await page.$eval('#followBtn', (b) => b.getAttribute('aria-pressed')), 'false');
  await page.click('#followBtn'); await sleep(1500); s = await state(page);
  assert.equal(s.follow, true); assert.ok(Math.abs(s.camera.lon - 76.1) < 3);
  await page.click('#todayBtn'); await sleep(2600); s = await state(page);
  assert.equal(s.T, 1); assert.match(await text(page, '#dateOut'), /Today/);
  assert.match(await text(page, '#weatherChip'), /17°C .* now/, 'ongoing stay at "today" shows current conditions');
});

await check('8 · edit a place (note + departure), reload, and the update is there', async () => {
  await openEditor(page);
  await clickItem(page, 'Khatkar Kalan', 'edit'); await page.waitForSelector('#detailPanel.open');
  assert.equal(await text(page, '#lcName'), 'Khatkar Kalan');
  await page.type('#fNote', 'Grandparents’ house'); await setValue(page, '#fEY', '2008');
  await page.click('#fSubmit'); await waitText(page, '#toast', /Khatkar Kalan, Punjab updated\./);
  await open(page);
  const w = (await state(page)).journey.waypoints.find((x) => x.placeName === 'Khatkar Kalan');
  assert.deepEqual([w.note, w.endDate, w.endDatePrecision], ['Grandparents’ house', '2008', 'year']);
  assert.equal(stored().revision, 4);
});
await check('10 · storage failure: no success message, form stays filled, Retry works once storage recovers', async () => {
  await openEditor(page);
  await clickItem(page, 'Khatkar Kalan', 'edit'); await page.waitForSelector('#detailPanel.open');
  await page.$eval('#fNote', (el) => { el.value = 'This must not be lost'; });
  fakes.state.failWrites = true; const rev = stored().revision;
  await page.click('#fSubmit');
  await waitText(page, '#edStatus', /Not saved/);
  assert.equal(await text(page, '#fSubmit'), 'Retry save'); assert.equal(await text(page, '#saveState'), 'Not saved');
  assert.equal(await page.$eval('#fNote', (el) => el.value), 'This must not be lost'); assert.equal(await visible(page, '#detailPanel'), true);
  assert.ok(!/added|updated/.test(await text(page, '#toast')) || !(await page.$eval('#toast', (el) => el.classList.contains('show'))), 'no success toast');
  assert.equal(stored().revision, rev); assert.equal((await state(page)).journey.waypoints.find((x) => x.placeName === 'Khatkar Kalan').note, 'Grandparents’ house', 'the app still shows what is really stored');
  await shot(page, '09-save-failed');
  fakes.state.failWrites = false;
  await page.click('#fSubmit'); await waitText(page, '#toast', /updated/);
  assert.equal(stored().waypoints.find((x) => x.placeName === 'Khatkar Kalan').note, 'This must not be lost');
});
await check('stale-edit conflict is detected instead of silently overwriting', async () => {
  const doc = stored(); doc.revision += 1; doc.displayName = 'Changed elsewhere'; fakes.state.store.set('journey:default', JSON.stringify(doc));
  await sleep(600); await setValue(page, '#edName', 'My name');
  await waitText(page, '#listStatus', /not saved/); await waitText(page, '#edNotice', /changed somewhere else/);
  assert.equal(stored().displayName, 'Changed elsewhere');
  await page.click('[data-act="latest"]'); await sleep(300);
  assert.equal((await state(page)).journey.displayName, 'Changed elsewhere');
});
await check('24, 6 · geocoder down → clear error + retry; fallback "Enter coordinates" validates ranges and is labelled manual', async () => {
  await page.click('#addPlace'); await page.waitForSelector('#detailPanel.open');
  fakes.state.photonDown = true;
  await typeSearch(page, 'Taveuni'); await waitText(page, '#locState', /could not be reached/);
  assert.equal(await visible(page, '#locRetry'), true); assert.equal(await page.$eval('#locList', (el) => el.hidden), true);
  fakes.state.photonDown = false;
  await page.click('#locCoords');
  assert.equal(await page.$eval('#mName', (el) => el.value), 'Taveuni');
  await setValue(page, '#mLat', '95'); await setValue(page, '#mLon', '179.97'); await page.click('#mUse');
  await waitText(page, '#edStatus', /Latitude must be a number between −90 and 90/);
  await setValue(page, '#mLat', '-16.85'); await setValue(page, '#mLon', '200'); await page.click('#mUse');
  await waitText(page, '#edStatus', /Longitude must be a number between −180 and 180/);
  await setValue(page, '#mLon', '179.97'); await page.click('#mUse');
  await page.waitForFunction(() => !document.querySelector('#locCard').hidden);
  assert.equal(await text(page, '#lcSource'), 'Set manually'); assert.equal(await text(page, '#lcCoords'), '16.8500° S, 179.9700° E');
  await setValue(page, '#fY', '2019'); await page.select('#fType', 'visit'); await page.click('#fSubmit');
  await waitText(page, '#toast', /Taveuni added to your journey/);
  assert.equal(stored().waypoints.find((w) => w.placeName === 'Taveuni').geocodeSource, 'manual');
});
await check('23 · a place next to ±180° lights both edges of the mask texture (no seam) and is drawn at the right spot', async () => {
  await sleep(2000); await settled(page);
  const m = await page.evaluate(() => {
    const J = window.__journey, mean = (from, to) => { let t = 0, n = 0; for (let d = from; d <= to + 1e-9; d += 0.125) { const lon = 179.97 + d; t += J.maskAt(-16.85, lon > 180 ? lon - 360 : lon, 0); n++; } return t / n; };
    return { centre: J.maskAt(-16.85, 179.97, 1), east: mean(0.5, 3), west: mean(-3, -0.5), across: J.maskAt(-16.85, -179.03, 1), far: J.maskAt(-16.85, 170, 1) };
  });
  assert.ok(m.centre > 200, `lit at 179.97°E (${m.centre})`); assert.ok(m.across > 20, `the glow continues 1° past the seam, at 179.03°W (${m.across.toFixed(1)})`);
  assert.ok(Math.abs(m.east - m.west) / m.west < 0.12, `same brightness east (across the seam) and west of the place: ${m.east.toFixed(1)} vs ${m.west.toFixed(1)}`); assert.equal(m.far, 0);
  const p = (await state(page)).places.find((x) => x.name === 'Taveuni');
  assert.ok(p.screen && p.markerVisible);
  await shot(page, '10-antimeridian');
});
await check('6 · no search result → "Choose on globe": click sets coordinates, labelled "Placed on the globe"', async () => {
  await page.click('#addPlace'); await page.waitForSelector('#detailPanel.open'); await sleep(700);
  await typeSearch(page, 'zzzznowhere'); await waitText(page, '#locState', /No place found/);
  await page.click('#locGlobe');
  assert.equal(await visible(page, '#pickBar'), true);
  const target = (await state(page)).places.find((x) => x.name === 'Taveuni').screen;
  await page.mouse.click(target.x - 60, target.y - 40); await sleep(300);
  const lat = Number(await page.$eval('#mLat', (el) => el.value)), lon = Number(await page.$eval('#mLon', (el) => el.value));
  assert.ok(Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat + 16.85) < 25, `picked ${lat}, ${lon}`);
  assert.equal(await visible(page, '#pickBar'), false);
  await page.$eval('#mName', (el) => { el.value = 'Somewhere at sea'; }); await page.click('#mUse');
  await page.waitForFunction(() => !document.querySelector('#locCard').hidden);
  assert.equal(await text(page, '#lcSource'), 'Placed on the globe');
  await setValue(page, '#fY', '2020'); await page.select('#fType', 'visit'); await page.click('#fSubmit');
  await waitText(page, '#toast', /Somewhere at sea added/);
  assert.equal(stored().waypoints.find((w) => w.placeName === 'Somewhere at sea').geocodeSource, 'globe');
});
await check('18 · two stays in the same city stay two records (and share one lit place)', async () => {
  await sleep(2400); await addPlace(page, { query: 'Tokyo', y: 2022, type: 'visit' });
  const tk = stored().waypoints.filter((w) => w.placeName === 'Tokyo');
  assert.equal(tk.length, 2); assert.notEqual(tk[0].id, tk[1].id); assert.deepEqual(tk.map((w) => w.stayType).sort(), ['visit', 'work']);
});
await check('19 · two entries sharing a date get explicit ↑/↓ ordering, which persists', async () => {
  await addPlace(page, { query: 'London', y: 2019, type: 'visit' });
  const order = () => page.$$eval('#edList .item b', (els) => els.map((e) => e.textContent));
  let names = await order(); const i = names.indexOf('Taveuni');
  assert.equal(names[i + 1], 'London', `2019 pair in entry order: ${names.join(', ')}`);
  assert.equal(await page.$$eval('#edList [data-up], #edList [data-down]', (els) => els.length), 2, 'only the tied pair gets move buttons');
  await page.click('#edList [data-down]'); await page.waitForFunction(() => { const n = [...document.querySelectorAll('#edList .item b')].map((e) => e.textContent); return n.indexOf('London') < n.indexOf('Taveuni'); }, { timeout: 6000 });
  await open(page); await openEditor(page); names = await order();
  assert.ok(names.indexOf('London') < names.indexOf('Taveuni'));
  const s = await state(page); const a = s.places.find((p) => p.name === 'London'), b = s.places.find((p) => p.name === 'Taveuni');
  assert.ok(a.t < b.t, 'tied entries still get separate, ordered timeline stops');
});
await check('20 · an overlapping education period does not end the home stay', async () => {
  await page.click('#addPlace'); await page.waitForSelector('#detailPanel.open');
  await typeSearch(page, 'Toronto'); await waitResults(page); await page.click('#locList li[data-i="0"]');
  await setValue(page, '#fY', '2000'); await setValue(page, '#fEY', '2004'); await page.select('#fType', 'education');
  assert.equal(await page.$eval('#fChapter', (el) => el.value), 'education', 'chapter follows the type by default');
  await page.click('#fSubmit'); await waitText(page, '#toast', /Toronto, Ontario added/);
  const doc = stored(), home = doc.waypoints.find((w) => w.placeName === 'Khatkar Kalan'), school = doc.waypoints.find((w) => w.placeName === 'Toronto');
  assert.deepEqual([home.startDate, home.endDate], ['1996-09', '2008']); assert.deepEqual([school.startDate, school.endDate], ['2000', '2004']);
  assert.ok(school.startDate > home.startDate && school.endDate < home.endDate, 'the two periods overlap and both are kept as entered');
});
await check('validation in the form: departure before arrival, future year, second birthplace', async () => {
  await sleep(2400); await page.click('#addPlace'); await page.waitForSelector('#detailPanel.open');
  await typeSearch(page, 'Montreal'); await waitResults(page); await page.click('#locList li[data-i="0"]');
  await setValue(page, '#fY', '2010'); await setValue(page, '#fEY', '2005'); await page.click('#fSubmit');
  await waitText(page, '#edStatus', /departure date is before the arrival/);
  await setValue(page, '#fEY', ''); await setValue(page, '#fY', '2999'); await page.click('#fSubmit');
  await waitText(page, '#edStatus', /in the future/);
  await setValue(page, '#fY', '2010'); await page.select('#fType', 'birthplace'); await page.click('#fSubmit');
  await waitText(page, '#edStatus', /Nawanshahr is already the birthplace/);
  await page.click('#fCancel');
});
await check('9 · delete (two-step) a place, reload, and it is gone', async () => {
  const sel = '#edList .item:last-of-type [data-del]';
  const before = stored().waypoints.length;
  const name = await page.$eval('#edList .item:last-of-type b', (e) => e.textContent);
  await page.click(sel); assert.equal(stored().waypoints.length, before, 'first click only arms');
  await page.click(sel); await waitText(page, '#toast', /removed from your journey/);
  await open(page);
  const names = (await state(page)).places.map((p) => p.name);
  assert.equal(names.length, before - 1); assert.ok(name === 'Tokyo' ? names.filter((n) => n === 'Tokyo').length === 1 : !names.includes(name));
});
await check('export produces a complete JSON backup; import of a legacy v1 file is offered with a confirmation', async () => {
  await openEditor(page);
  const exported = await page.evaluate(() => JSON.stringify(window.__journey.state().journey));
  assert.equal(JSON.parse(exported).schemaVersion, 2);
  const tmp = path.join(fs.mkdtempSync('/tmp/journey-'), 'legacy.json'); fs.writeFileSync(tmp, JSON.stringify(LEGACY_V1));
  const input = await page.$('#importFile'); await input.uploadFile(tmp);
  await waitText(page, '#listStatus', /Replace the current \d+ places with 8 places/);
  const rev = stored().revision; await page.click('[data-act="import-no"]');
  assert.equal(stored().revision, rev, 'cancelling the import changes nothing');
});
await check('privacy: owner un-shares → signed-out visitors get a locked screen and the API withholds the data', async () => {
  assert.equal(stored().visibility, 'private', 'a journey you start yourself is private until you choose to share it');
  assert.equal(await page.$eval('#shareToggle', (el) => el.checked), false);
  await page.click('#shareToggle'); await waitText(page, '#toast', /Anyone with the link can now view/); assert.equal(stored().visibility, 'public');
  const anon = await browser.createBrowserContext(); const ap = await anon.newPage();
  const pub = await ap.goto(`${base}/api/journey`); assert.equal(pub.status(), 200, 'shared → readable without a session'); await anon.close();
  await page.click('#shareToggle'); await waitText(page, '#toast', /now private/); assert.equal(stored().visibility, 'private');
  await page.click('#signOut'); await sleep(900);
  assert.equal(await text(page, '#gateTitle'), 'This journey is private');
  assert.equal((await state(page)).places.length, 0);
  const r = await page.evaluate(async () => { const res = await fetch('/api/journey'); return { status: res.status, body: await res.json() }; });
  assert.equal(r.status, 401); assert.equal(r.body.journey, undefined);
  await shot(page, '11-private');
  await page.type('#gatePass', 'correct horse'); await page.click('#gateForm button'); await sleep(1200);
  assert.ok((await state(page)).places.length > 0);
  assert.deepEqual(page.errors, []);
});
await check('performance smoke: frames keep rendering during playback and the light mask is not redrawn on idle frames', async () => {
  const r = await page.evaluate(async () => {
    let frames = 0; const tick = () => { frames++; requestAnimationFrame(tick); }; requestAnimationFrame(tick);
    const ctx = document.createElement('canvas').getContext('2d').constructor.prototype; let draws = 0; const orig = ctx.drawImage; ctx.drawImage = function (...a) { draws++; return orig.apply(this, a); };
    await new Promise((res) => setTimeout(res, 2000)); ctx.drawImage = orig;
    return { fps: frames / 2, idleMaskDraws: draws };
  });
  console.log(`      (software-rendered headless Chrome: ${r.fps.toFixed(0)} fps — not representative of real GPUs)`);
  assert.ok(r.fps >= 2); assert.equal(r.idleMaskDraws, 0);
});
await page.browserContext().close();

/* ============================================================ B. legacy data + storage outage */
console.log('\nB. Existing v1 data in the store');
fakes.state.store.clear(); fakes.state.store.set('journey:default', JSON.stringify(LEGACY_V1));
page = await newPage();
await check('27 · a stored v1 journey loads migrated: "NOW" becomes an ongoing stay, the never-located place is flagged, nothing is rewritten on read', async () => {
  await open(page);
  const s = await state(page);
  assert.equal(s.places.length, 7); assert.deepEqual(s.unlocated, ['Montreal']);
  assert.equal(s.places.at(-1).name, 'Lisbon'); assert.equal(s.places.at(-1).t, 1);
  assert.equal(fakes.state.store.get('journey:default'), JSON.stringify(LEGACY_V1));
  await openEditor(page);
  assert.match(await text(page, '#edList'), /Needs a location[\s\S]*Montreal[\s\S]*never verified/);
  await shot(page, '12-legacy-migrated');
});
await check('27 · first save after migration keeps a one-time backup of the original and preserves unknown legacy fields', async () => {
  await unlock(page);
  await setValue(page, '#edName', 'Alex R.'); await waitText(page, '#saveState', /Saved/);
  assert.equal(fakes.state.store.get('journey:default:backup:v1'), JSON.stringify(LEGACY_V1));
  const doc = stored();
  assert.equal(doc.schemaVersion, 2); assert.equal(doc.displayName, 'Alex R.'); assert.equal(doc.legacy.theme, 'midnight');
  assert.equal(doc.waypoints.find((w) => w.placeName === 'Denpasar').legacy.photo, 'bali.jpg'); assert.equal(doc.waypoints.length, 8);
});
await check('27 · the flagged place can be located through search and then appears on the globe', async () => {
  await page.click('#edList .item:last-of-type [data-edit]'); await page.waitForSelector('#detailPanel.open');
  await waitResults(page); await page.click('#locList li[data-i="0"]');
  await page.click('#fSubmit'); await waitText(page, '#toast', /Montreal, Quebec updated/);
  const s = await state(page); assert.deepEqual(s.unlocated, []); assert.equal(s.places.length, 8);
  assert.equal(stored().waypoints.find((w) => w.placeName === 'Montreal').geocodeSource, 'photon');
});
await check('10 · store unreachable on load → explicit error, no sample data shown as if it were the journey, no writes', async () => {
  fakes.state.redisDown = true; const p2 = await newPage();
  await open(p2);
  assert.equal(await text(p2, '#gateTitle'), 'This journey couldn’t be loaded');
  const s = await state(p2); assert.equal(s.places.length, 0); assert.equal(s.canEdit, false);
  assert.ok(!p2.net.some((n) => /^(PUT|POST)/.test(n)));
  await shot(p2, '13-load-error');
  fakes.state.redisDown = false; await p2.browserContext().close();
});
await page.browserContext().close();

/* ============================================================ C. demo mode */
console.log('\nC. Demo mode (no cloud storage configured)');
await startServer({ redis: false, token: '' });
page = await newPage();
await check('demo mode is labelled everywhere and a local save is never presented as a cloud save', async () => {
  await open(page);
  assert.equal(await visible(page, '#badgeLocal'), true);
  await openEditor(page);
  assert.match(await text(page, '#edNotice'), /Demo mode\. No cloud storage is connected/); assert.equal(await text(page, '#saveState'), 'Demo · this device only');
  await page.click('[data-act="fresh"]'); await page.waitForSelector('#detailPanel.open');
  await addPlace(page, { query: 'Lisbon', y: 2001, expectToast: /Lisbon, Portugal added to your journey\. Kept on this device only \(demo mode\)\./ });
  assert.equal(await text(page, '#saveState'), 'On this device only');
  assert.ok(!page.net.some((n) => /^PUT/.test(n)), 'no server write was attempted or implied');
  await open(page);
  const s = await state(page); assert.equal(s.apiMode, 'demo'); assert.deepEqual(s.places.map((p) => p.name), ['Lisbon']);
});
await page.browserContext().close();

/* ============================================================ D. phone */
console.log('\nD. Phone viewport (390 × 780, touch)');
page = await newPage({ width: 390, height: 780, mobile: true });
await check('25 · phone: editor is a bottom sheet; with the keyboard up (visual viewport 390 × 440) results and Save stay on screen', async () => {
  await open(page);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no horizontal overflow');
  await shot(page, '14-phone-home');
  await page.tap('#editBtn'); await page.waitForSelector('#journeyPanel.open'); await sleep(400);
  await page.tap('[data-act="fresh"]'); await page.waitForSelector('#detailPanel.open'); await sleep(500);
  await shot(page, '15-phone-form');
  await page.setViewport({ width: 390, height: 440, isMobile: true, hasTouch: true });      // what the page sees when a software keyboard opens
  await sleep(400);
  await page.tap('#fPlace'); await page.type('#fPlace', 'Nawanshahr', { delay: 10 }); await waitResults(page); await sleep(500);
  const box = await page.evaluate(() => { const r = (s) => { const b = document.querySelector(s).getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), h: Math.round(b.height) }; }; return { vh: innerHeight, input: r('#fPlace'), first: r('#locList li'), save: r('#fSubmit'), panel: r('#detailPanel') }; });
  assert.ok(box.first.top >= 0 && box.first.bottom <= box.vh, `first result on screen ${JSON.stringify(box)}`);
  assert.ok(box.save.bottom <= box.vh && box.save.top > 0, `Save reachable ${JSON.stringify(box.save)}`);
  assert.ok(box.first.h >= 48 && box.save.h >= 40, 'touch-sized targets');
  await shot(page, '16-phone-keyboard');
  await page.tap('#locList li[data-i="0"]'); await page.waitForFunction(() => !document.querySelector('#locCard').hidden);
  await page.setViewport({ width: 390, height: 780, isMobile: true, hasTouch: true }); await sleep(300);
  await setValue(page, '#fY', '1990'); await page.tap('#fSubmit'); await waitText(page, '#toast', /Nawanshahr, Punjab added/);
  await sleep(2000); await settled(page);
  assert.equal(await visible(page, '#journeyPanel'), false, 'sheets close so the new place can be seen');
  const p = (await state(page)).places[0]; assert.ok(p.screen && p.screen.y > 60 && p.screen.y < 560 && p.lit > 0.9, JSON.stringify(p.screen));
  assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'editBtn', 'focus returned to the control that opened the editor');
  await shot(page, '17-phone-saved');
  assert.deepEqual(page.errors, []);
});
await page.browserContext().close();

/* ============================================================ E. reduced motion + keyboard */
console.log('\nE. Accessibility');
page = await newPage({ reducedMotion: true });
await check('reduced motion: state changes are immediate (no fly-through, no fade) and still correct', async () => {
  await open(page);
  const s0 = await state(page);
  await setT(page, s0.places[4].t, 250); let s = await state(page);
  assert.deepEqual(s.places.map((p) => p.lit), s.places.map((p, i) => (i <= 4 ? 1 : 0)));
  await setT(page, 0, 250); s = await state(page);
  assert.deepEqual(s.places.map((p) => p.lit), s.places.map((p, i) => (i === 0 ? 1 : 0)));
});
await check('keyboard: editor opens from the keyboard, focus moves in, Escape closes panels in order and restores focus', async () => {
  await page.focus('#editBtn'); await page.keyboard.press('Enter'); await page.waitForSelector('#journeyPanel.open');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'editorClose');
  await page.focus('#addPlace'); await page.keyboard.press('Enter'); await page.waitForSelector('#detailPanel.open');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'fPlace');
  assert.equal(await page.$eval('#fPlace', (el) => el.getAttribute('role')), 'combobox');
  await page.keyboard.press('Escape'); await sleep(200);
  assert.equal(await visible(page, '#detailPanel'), false); assert.equal(await page.evaluate(() => document.activeElement.id), 'addPlace');
  await page.keyboard.press('Escape'); await sleep(200);
  assert.equal(await visible(page, '#journeyPanel'), false); assert.equal(await page.evaluate(() => document.activeElement.id), 'editBtn');
  assert.deepEqual(page.errors, []);
});
await page.browserContext().close();

await browser.close(); await new Promise((r) => server.close(r)); fakes.restore();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
