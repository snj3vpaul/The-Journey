/**
 * The Journey — shared core (pure, dependency-free, runs in the browser and in Node).
 *
 * Everything that must mean the same thing on both sides of the wire lives here:
 * the versioned data model, the legacy migration, validation, partial-date handling,
 * the event-paced timeline, age, Discovery halo sizing, statistics, weather planning
 * and geocoder-result normalisation. The server treats validateJourney() as authoritative.
 */

export const SCHEMA_VERSION = 2;
export const DAY = 864e5;
export const YEAR = 365.2425 * DAY;
export const EARTH_KM = 6371;
export const STAY_TYPES = ['birthplace', 'home', 'education', 'work', 'visit'];
export const DEFAULT_CHAPTERS = ['childhood', 'education', 'career', 'personal'];
export const GEO_SOURCES = ['photon', 'manual', 'globe', 'legacy', 'unresolved'];
export const LOCATION_PRECISIONS = ['city', 'town', 'village', 'hamlet', 'suburb', 'district', 'locality', 'county', 'region', 'country', 'island', 'point', 'unknown'];
export const LIMITS = { waypoints: 300, name: 80, place: 120, note: 600, chapter: 40, bodyChars: 400000 };
export const WEATHER_ARCHIVE_START = '1940-01-01';

export class ValidationError extends Error {
  constructor(message, path = '') { super(message); this.name = 'ValidationError'; this.path = path; }
}

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v, max) => (typeof v === 'string' ? v : v == null ? '' : String(v)).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
const round5 = (n) => Math.round(n * 1e5) / 1e5;

/* ------------------------------------------------------------------ partial dates */

const pad = (n, w = 2) => String(n).padStart(w, '0');
const utc = (y, m = 1, d = 1) => { const t = new Date(Date.UTC(2000, m - 1, d)); t.setUTCFullYear(y); return t.getTime(); };
const daysInMonth = (y, m) => new Date(utc(y, m + 1, 1) - DAY).getUTCDate();

/** 'YYYY' | 'YYYY-MM' | 'YYYY-MM-DD' → { y, m, d, precision } or null. Never invents missing parts. */
export function parsePartialDate(str) {
  const m = typeof str === 'string' && /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(str.trim());
  if (!m) return null;
  const y = +m[1], mo = m[2] ? +m[2] : null, d = m[3] ? +m[3] : null;
  if (y < 1000 || (mo !== null && (mo < 1 || mo > 12)) || (d !== null && (d < 1 || d > daysInMonth(y, mo)))) return null;
  return { y, m: mo, d, precision: d !== null ? 'day' : mo !== null ? 'month' : 'year' };
}
export function makePartialDate(y, m, d) {
  if (y == null || y === '' || !Number.isFinite(+y)) return null;
  const s = pad(Math.trunc(+y), 4) + (m ? `-${pad(+m)}` + (d ? `-${pad(+d)}` : '') : '');
  return parsePartialDate(s) ? s : null;
}
/** Earliest instant the partial date can mean (used for ordering and timeline placement). */
export function dateStartMs(str) { const p = parsePartialDate(str); return p ? utc(p.y, p.m || 1, p.d || 1) : NaN; }
/** Latest instant the partial date can mean. */
export function dateEndMs(str) {
  const p = parsePartialDate(str); if (!p) return NaN;
  if (p.precision === 'day') return utc(p.y, p.m, p.d) + DAY - 1;
  if (p.precision === 'month') return utc(p.y, p.m, daysInMonth(p.y, p.m)) + DAY - 1;
  return utc(p.y, 12, 31) + DAY - 1;
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** Human date at exactly the stored precision: '1996', 'Sep 1996', '2 Sep 1996'. */
export function formatPartialDate(str) {
  const p = parsePartialDate(str); if (!p) return '';
  return p.precision === 'day' ? `${p.d} ${MONTHS[p.m - 1]} ${p.y}` : p.precision === 'month' ? `${MONTHS[p.m - 1]} ${p.y}` : String(p.y);
}
export const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/* ------------------------------------------------------------------ ids */

function fnv(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }
export function newId() {
  const c = globalThis.crypto;
  if (c?.randomUUID) return `wp_${c.randomUUID().replace(/-/g, '').slice(0, 20)}`;
  return `wp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/* ------------------------------------------------------------------ migration (v1 → v2) */

const REGION_NAMES = (() => { try { return new Intl.DisplayNames(['en'], { type: 'region' }); } catch { return null; } })();
export function countryName(code) {
  if (!/^[A-Za-z]{2}$/.test(code || '')) return '';
  try { const n = REGION_NAMES?.of(code.toUpperCase()); return n && n !== code.toUpperCase() ? n : ''; } catch { return ''; }
}
const LEGACY_STAGE_TYPE = { birth: 'birthplace', education: 'education', career: 'work' };

/**
 * Convert any stored journey to the current schema. Idempotent; never drops a legacy field:
 * anything that has no home in the new model is kept under `legacy`.
 * v1 shape: { userId, name, updatedAt, waypoints: [{ year|'NOW', month, day, place, country, lat, lon, stage, note, kind }] }
 */
export function migrateJourney(raw, { journeyId = 'default', nowIso = new Date().toISOString() } = {}) {
  if (!isObj(raw)) throw new ValidationError('Journey must be an object');
  const from = Number.isInteger(raw.schemaVersion) ? raw.schemaVersion : 1;
  if (from > SCHEMA_VERSION) throw new ValidationError(`This journey was saved by a newer version (schema ${from}).`);
  if (from === SCHEMA_VERSION) return { journey: raw, migrated: false, fromVersion: from };
  if (!Array.isArray(raw.waypoints)) throw new ValidationError('Journey has no waypoints list');

  const stamp = typeof raw.updatedAt === 'string' && !Number.isNaN(Date.parse(raw.updatedAt)) ? raw.updatedAt : nowIso;
  const isNow = (w) => String(w.year).toUpperCase() === 'NOW';
  const startOf = (w) => (isNow(w) ? null : makePartialDate(w.year, w.month || 1, w.day || 1));
  // v1 decided "short visit" from the gap to the next waypoint; keep that picture by fixing it at migration time.
  const order = raw.waypoints.map((w, i) => ({ w, i, ms: isObj(w) && !isNow(w) ? dateStartMs(startOf(w)) : Infinity }))
    .filter((o) => isObj(o.w)).sort((a, b) => (a.ms - b.ms) || (a.i - b.i));
  const nextMs = new Map(order.map((o, k) => [o.i, order[k + 1] ? order[k + 1].ms : Infinity]));

  const waypoints = order.map(({ w, i, ms }, rank) => {
    const known = new Set(['year', 'month', 'day', 'place', 'country', 'lat', 'lon', 'stage', 'note', 'kind']);
    const extra = Object.fromEntries(Object.entries(w).filter(([k]) => !known.has(k)));
    const now = isNow(w), start = startOf(w);
    const hasLL = typeof w.lat === 'number' && typeof w.lon === 'number' && Number.isFinite(w.lat) && Number.isFinite(w.lon);
    const stage = text(w.stage, LIMITS.chapter).toLowerCase() || 'personal';
    const cc = /^[A-Za-z]{2}$/.test(w.country || '') ? w.country.toUpperCase() : '';
    const gap = nextMs.get(i) - ms;
    const autoVisit = !w.kind && !now && rank > 0 && Number.isFinite(gap) && gap > 0 && gap < 60 * DAY;
    const legacy = { ...extra, ...(now ? { year: 'NOW' } : {}), ...(start === null && !now ? { year: w.year, month: w.month, day: w.day } : {}) };
    return {
      id: `wp_${fnv(`${i}|${w.place}|${w.year}|${w.month}|${w.day}`)}${i.toString(36)}`,
      placeId: null,
      placeName: text(w.place, LIMITS.place) || 'Unnamed place',
      region: '',
      country: cc ? countryName(cc) || cc : text(w.country, 80),
      countryCode: cc,
      latitude: hasLL ? round5(w.lat) : null,
      longitude: hasLL ? round5(w.lon) : null,
      geocodeSource: hasLL ? 'legacy' : 'unresolved',
      locationPrecision: 'unknown',
      startDate: start,
      startDatePrecision: start ? 'day' : null,
      endDate: null,
      endDatePrecision: null,
      isCurrent: now,
      stayType: w.kind === 'visit' || autoVisit ? 'visit' : LEGACY_STAGE_TYPE[stage] || 'home',
      chapter: stage,
      note: text(w.note, LIMITS.note),
      sortIndex: rank,
      createdAt: stamp,
      updatedAt: stamp,
      ...(Object.keys(legacy).length ? { legacy } : {}),
    };
  });
  const birth = waypoints.find((w) => w.stayType === 'birthplace' && w.startDate);
  const topKnown = new Set(['userId', 'name', 'updatedAt', 'waypoints']);
  const topExtra = Object.fromEntries(Object.entries(raw).filter(([k]) => !topKnown.has(k)));
  return {
    migrated: true, fromVersion: from,
    journey: {
      schemaVersion: SCHEMA_VERSION,
      journeyId: text(raw.userId, 40) || journeyId,
      displayName: text(raw.name, LIMITS.name),
      birthDate: birth ? birth.startDate : null,
      birthDatePrecision: birth ? birth.startDatePrecision : null,
      visibility: 'public',           // v1 journeys were already served publicly; the owner can switch this off
      createdAt: stamp, updatedAt: stamp, revision: 0,
      waypoints,
      ...(Object.keys(topExtra).length ? { legacy: topExtra } : {}),
    },
  };
}

/* ------------------------------------------------------------------ validation (authoritative on the server) */

function cleanDate(v, path, required) {
  if (v == null || v === '') { if (required) throw new ValidationError('A date is required', path); return [null, null]; }
  const p = parsePartialDate(v);
  if (!p) throw new ValidationError('Dates must be YYYY, YYYY-MM or YYYY-MM-DD and exist in the calendar', path);
  return [String(v).trim(), p.precision];
}
function cleanLegacy(v) {
  if (!isObj(v)) return null;
  try { const s = JSON.stringify(v); return s.length <= 2000 ? JSON.parse(s) : null; } catch { return null; }
}
const cleanIso = (v, fallback) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : fallback);

export function validateWaypoint(w, { nowMs = Date.now(), path = 'waypoint' } = {}) {
  if (!isObj(w)) throw new ValidationError('Each place must be an object', path);
  const nowIso = new Date(nowMs).toISOString();
  const id = text(w.id, 64);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new ValidationError('Each place needs a stable id', `${path}.id`);
  const placeName = text(w.placeName, LIMITS.place);
  if (!placeName) throw new ValidationError('Each place needs a name', `${path}.placeName`);

  let geocodeSource = GEO_SOURCES.includes(w.geocodeSource) ? w.geocodeSource : null;
  let latitude = null, longitude = null;
  const noLL = (w.latitude == null || w.latitude === '') && (w.longitude == null || w.longitude === '');
  if (noLL) {
    if (geocodeSource !== 'unresolved') throw new ValidationError(`“${placeName}” has no verified location`, `${path}.latitude`);
  } else {
    latitude = Number(w.latitude); longitude = Number(w.longitude);
    if (typeof w.latitude === 'boolean' || typeof w.longitude === 'boolean' || !Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
      throw new ValidationError('Latitude must be −90…90 and longitude −180…180', `${path}.latitude`);
    }
    latitude = round5(latitude); longitude = round5(longitude);
    if (!geocodeSource || geocodeSource === 'unresolved') throw new ValidationError('A located place needs a geocodeSource', `${path}.geocodeSource`);
  }

  const isCurrent = w.isCurrent === true;
  const [startDate, startDatePrecision] = cleanDate(w.startDate, `${path}.startDate`, !isCurrent);
  let [endDate, endDatePrecision] = cleanDate(w.endDate, `${path}.endDate`, false);
  if (isCurrent && endDate) throw new ValidationError('A current stay cannot have a departure date', `${path}.endDate`);
  if (startDate && dateStartMs(startDate) > nowMs + 2 * DAY) throw new ValidationError('The arrival date is in the future', `${path}.startDate`);
  if (startDate && endDate && dateEndMs(endDate) < dateStartMs(startDate)) throw new ValidationError('The departure date is before the arrival date', `${path}.endDate`);
  if (endDate && dateStartMs(endDate) > nowMs + 2 * DAY) throw new ValidationError('The departure date is in the future — use “Currently here” instead', `${path}.endDate`);

  if (!STAY_TYPES.includes(w.stayType)) throw new ValidationError(`Type must be one of: ${STAY_TYPES.join(', ')}`, `${path}.stayType`);
  const cc = text(w.countryCode, 2).toUpperCase();
  const legacy = cleanLegacy(w.legacy);
  return {
    id,
    placeId: w.placeId == null ? null : text(w.placeId, 120) || null,
    placeName,
    region: text(w.region, 160),
    country: text(w.country, 80),
    countryCode: /^[A-Z]{2}$/.test(cc) ? cc : '',
    latitude, longitude, geocodeSource,
    locationPrecision: LOCATION_PRECISIONS.includes(w.locationPrecision) ? w.locationPrecision : 'unknown',
    startDate, startDatePrecision, endDate, endDatePrecision, isCurrent,
    stayType: w.stayType,
    chapter: text(w.chapter, LIMITS.chapter).toLowerCase() || 'personal',
    note: text(w.note, LIMITS.note),
    sortIndex: Number.isFinite(Number(w.sortIndex)) ? Number(w.sortIndex) : 0,
    createdAt: cleanIso(w.createdAt, nowIso),
    updatedAt: cleanIso(w.updatedAt, nowIso),
    ...(legacy ? { legacy } : {}),
  };
}

export function validateJourney(input, { nowMs = Date.now(), journeyId } = {}) {
  if (!isObj(input)) throw new ValidationError('Journey must be an object');
  if (input.schemaVersion !== SCHEMA_VERSION) throw new ValidationError(`Unsupported schemaVersion (expected ${SCHEMA_VERSION})`, 'schemaVersion');
  if (!Array.isArray(input.waypoints)) throw new ValidationError('waypoints must be a list', 'waypoints');
  if (input.waypoints.length > LIMITS.waypoints) throw new ValidationError(`At most ${LIMITS.waypoints} places`, 'waypoints');
  const nowIso = new Date(nowMs).toISOString();
  const waypoints = input.waypoints.map((w, i) => validateWaypoint(w, { nowMs, path: `waypoints[${i}]` }));
  const seen = new Set();
  for (const w of waypoints) { if (seen.has(w.id)) throw new ValidationError(`Duplicate place id ${w.id}`, 'waypoints'); seen.add(w.id); }
  const [birthDate, birthDatePrecision] = cleanDate(input.birthDate, 'birthDate', false);
  if (birthDate && dateStartMs(birthDate) > nowMs + 2 * DAY) throw new ValidationError('The birth date is in the future', 'birthDate');
  const legacy = cleanLegacy(input.legacy);
  return {
    schemaVersion: SCHEMA_VERSION,
    journeyId: (journeyId || text(input.journeyId, 40) || 'default'),
    displayName: text(input.displayName, LIMITS.name),
    birthDate, birthDatePrecision,
    visibility: input.visibility === 'public' ? 'public' : 'private',
    createdAt: cleanIso(input.createdAt, nowIso),
    updatedAt: cleanIso(input.updatedAt, nowIso),
    revision: Number.isInteger(input.revision) && input.revision >= 0 ? input.revision : 0,
    waypoints,
    ...(legacy ? { legacy } : {}),
  };
}

export function emptyJourney(journeyId = 'default', nowIso = new Date().toISOString()) {
  return { schemaVersion: SCHEMA_VERSION, journeyId, displayName: '', birthDate: null, birthDatePrecision: null, visibility: 'private', createdAt: nowIso, updatedAt: nowIso, revision: 0, waypoints: [] };
}

/* ------------------------------------------------------------------ geometry */

export const hasLocation = (w) => typeof w.latitude === 'number' && typeof w.longitude === 'number' && Number.isFinite(w.latitude) && Number.isFinite(w.longitude);
export const wrapLon = (lon) => ((((lon + 180) % 360) + 360) % 360) - 180;
export function greatCircleRad(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180, dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}
/** Equirectangular texture x-positions for a halo of half-width rx: the true spot plus any copy that wraps the ±180° seam. */
export function maskCopies(lon, W, rx) {
  const x = (wrapLon(lon) + 180) / 360 * W;
  return [x - W, x, x + W].filter((c) => c + rx > 0 && c - rx < W);
}

/* ------------------------------------------------------------------ the timeline (single source of truth) */

/** Screen-time weight of the gap between two events: grows with the gap, but only logarithmically, so empty decades do not drag. */
export const gapWeight = (gapMs) => 0.45 + 1.1 * Math.log1p(1.5 * Math.max(0, gapMs) / YEAR);

/**
 * Build the event-paced timeline. `t` (0…1) is the scrubber position — "journeyTime"; every visual derives from it.
 * Events are ordered by start date, then explicit sortIndex, then insertion order. A stay never implicitly ends the previous one.
 */
export function buildTimeline(journey, nowMs = Date.now()) {
  const located = journey.waypoints.map((wp, src) => ({ wp, src })).filter((e) => hasLocation(e.wp));
  const events = located.map(({ wp, src }) => {
    const time = wp.startDate ? dateStartMs(wp.startDate) : nowMs;         // only a legacy "NOW" entry has no start date
    const endMs = wp.endDate ? dateEndMs(wp.endDate) : wp.isCurrent ? nowMs : null;
    const durMs = endMs !== null && wp.startDate ? Math.max(0, endMs - time) : null;   // null = duration honestly unknown
    return { wp, src, time: Math.min(time, Math.max(nowMs, time)), endMs, durMs, t: 0 };
  }).sort((a, b) => (a.time - b.time) || (a.wp.sortIndex - b.wp.sortIndex) || (a.src - b.src));

  const out = { events, t0: nowMs - YEAR, t1: nowMs, knots: [], playSeconds: 12, unlocated: journey.waypoints.filter((w) => !hasLocation(w)) };
  if (!events.length) { out.knots = [{ ms: out.t0, t: 0 }, { ms: out.t1, t: 1 }]; return finish(out); }
  out.t0 = events[0].time;
  out.t1 = Math.max(nowMs, events[events.length - 1].time);
  const weights = [];
  for (let i = 1; i < events.length; i++) weights.push(gapWeight(events[i].time - events[i - 1].time));
  const tail = out.t1 - events[events.length - 1].time;
  if (tail > DAY) weights.push(Math.max(0.3, 0.6 * gapWeight(tail)));
  const total = weights.reduce((s, w) => s + w, 0);
  let acc = 0;
  events.forEach((e, i) => { e.t = total > 0 ? acc / total : 0; out.knots.push({ ms: e.time, t: e.t }); acc += weights[i] ?? 0; });
  if (tail > DAY) out.knots.push({ ms: out.t1, t: 1 });
  if (out.knots.length === 1) out.knots.push({ ms: out.t1 + 1, t: 1 });
  out.playSeconds = clamp(total * 3.2, 12, 120);
  return finish(out);
}
function finish(tl) {
  const k = tl.knots;
  tl.timeOfT = (t) => {
    t = clamp(t);
    for (let i = 1; i < k.length; i++) {
      if (t <= k[i].t) { const span = k[i].t - k[i - 1].t; return span <= 0 ? k[i].ms : k[i - 1].ms + (k[i].ms - k[i - 1].ms) * (t - k[i - 1].t) / span; }
    }
    return k[k.length - 1].ms;
  };
  tl.tOfTime = (ms) => {
    if (ms <= k[0].ms) return k[0].t;
    for (let i = 1; i < k.length; i++) {
      if (ms <= k[i].ms) { const span = k[i].ms - k[i - 1].ms; return span <= 0 ? k[i - 1].t : k[i - 1].t + (k[i].t - k[i - 1].t) * (ms - k[i - 1].ms) / span; }
    }
    return 1;
  };
  return tl;
}
/** Index of the active event at scrubber position t (the latest event already reached), or -1. */
export function activeIndex(events, t) { let idx = -1; for (let i = 0; i < events.length; i++) { if (events[i].t <= t + 1e-9) idx = i; else break; } return idx; }
/** Ids of every place the timeline has reached at t — the only places Discovery may illuminate. */
export const reachedIds = (events, t) => events.filter((e) => e.t <= t + 1e-9).map((e) => e.wp.id);

/* ------------------------------------------------------------------ age */

export function resolveBirth(journey) {
  if (journey.birthDate && parsePartialDate(journey.birthDate)) return { date: journey.birthDate, precision: parsePartialDate(journey.birthDate).precision };
  const b = journey.waypoints.find((w) => w.stayType === 'birthplace' && w.startDate);
  return b ? { date: b.startDate, precision: parsePartialDate(b.startDate).precision } : null;
}
/** Age at an instant. `approx` is true whenever the birth date's precision cannot support an exact whole-year age. */
export function ageAt(birth, ms) {
  if (!birth) return null;
  const p = parsePartialDate(birth.date); if (!p) return null;
  const b0 = dateStartMs(birth.date); if (ms < b0) return null;
  const d = new Date(ms), bm = p.m || 1, bd = p.d || 1;
  let years = d.getUTCFullYear() - p.y;
  if (d.getUTCMonth() + 1 < bm || (d.getUTCMonth() + 1 === bm && d.getUTCDate() < bd)) years--;
  const approx = p.precision === 'year' || (p.precision === 'month' && d.getUTCMonth() + 1 === p.m);
  return { years: Math.max(0, years), approx, frac: Math.max(0, (ms - b0) / YEAR) };
}

/* ------------------------------------------------------------------ Discovery halo + statistics */

const HALO = { visit: [1.4, 3.6, 0], education: [2.1, 5.5, 0.4], work: [2.1, 5.5, 0.4], home: [2.6, 7, 0.8], birthplace: [2.8, 7.5, 1] };
/** Halo radii in degrees of arc. Local by design: even a lifelong home lights a region, never a country. Duration only counts when it is known. */
export function haloFor(stayType, durMs = null) {
  const [rc, rs, warm] = HALO[stayType] || HALO.home;
  const k = durMs === null || stayType === 'visit' ? 1 : 0.85 + 0.35 * clamp(Math.sqrt(durMs / (15 * YEAR)));
  return { rc: rc * k, rs: rs * k, warm };
}
export const placeKey = (w) => w.placeId || `${w.latitude.toFixed(2)},${w.longitude.toFixed(2)}`;
/** Verifiable counts for everything reached at t. Distance is the straight-line (great-circle) sum between consecutive recorded places — an estimate. */
export function statsAt(events, t = 1) {
  const idx = activeIndex(events, t), seen = events.slice(0, idx + 1);
  const chapters = [];
  for (const e of seen) if (chapters[chapters.length - 1] !== e.wp.chapter) chapters.push(e.wp.chapter);
  let rad = 0;
  for (let i = 1; i < seen.length; i++) rad += greatCircleRad(seen[i - 1].wp.latitude, seen[i - 1].wp.longitude, seen[i].wp.latitude, seen[i].wp.longitude);
  return {
    places: new Set(seen.map((e) => placeKey(e.wp))).size,
    countries: new Set(seen.map((e) => (e.wp.countryCode || e.wp.country).toLowerCase()).filter(Boolean)).size,
    chaptersCompleted: Math.max(0, new Set(chapters).size - 1),   // every chapter seen so far except the one being lived
    km: rad * EARTH_KM,
  };
}

/* ------------------------------------------------------------------ weather planning (precision-honest) */

/**
 * What weather may truthfully be shown for a place.
 *   live        current conditions (only for an ongoing stay viewed at "today", or an undated current place)
 *   historical  a reanalysis estimate for one exact past day (needs day precision, archive coverage)
 *   season      month known → season only, no temperatures
 *   none        year-only or unlocated → nothing
 */
export function weatherPlan(wp, { nowMs = Date.now(), atToday = false } = {}) {
  if (!hasLocation(wp)) return { kind: 'none' };
  if (wp.isCurrent && (atToday || !wp.startDate)) return { kind: 'live' };
  const p = parsePartialDate(wp.startDate);
  if (!p || p.precision === 'year') return { kind: 'none' };
  if (p.precision === 'month') return { kind: 'season' };
  if (wp.startDate < WEATHER_ARCHIVE_START || dateStartMs(wp.startDate) > nowMs) return { kind: 'season' };
  return { kind: 'historical', date: wp.startDate };
}

/* ------------------------------------------------------------------ geocoder results (Photon GeoJSON → app shape) */

export const foldText = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[\s\-'’.,]+/g, '');
const PLACE_KIND = { city: 'city', town: 'town', village: 'village', hamlet: 'hamlet', isolated_dwelling: 'hamlet', suburb: 'suburb', neighbourhood: 'suburb', quarter: 'suburb', borough: 'district', municipality: 'city', county: 'county', district: 'district', state: 'region', province: 'region', region: 'region', country: 'country', island: 'island', islet: 'island', locality: 'locality' };
const LAYER_KIND = { city: 'city', district: 'district', locality: 'locality', county: 'county', state: 'region', country: 'country' };
export const KIND_LABEL = { city: 'City', town: 'Town', village: 'Village', hamlet: 'Hamlet', suburb: 'Suburb', district: 'District', locality: 'Locality', county: 'County / district', region: 'State / region', country: 'Country', island: 'Island', point: 'Map point', unknown: 'Place' };
const KIND_RANK = { city: 5, town: 5, village: 5, hamlet: 4, suburb: 3, island: 3, district: 3, locality: 2, county: 2, region: 2, country: 2 };

export function normalizePhotonFeature(f) {
  const p = f?.properties, c = f?.geometry?.coordinates;
  if (!isObj(p) || !Array.isArray(c) || !Number.isFinite(c[0]) || !Number.isFinite(c[1]) || Math.abs(c[1]) > 90) return null;
  const name = text(p.name, LIMITS.place);
  if (!name) return null;
  const kind = (p.osm_key === 'place' && PLACE_KIND[p.osm_value]) || LAYER_KIND[p.type] || null;
  if (!kind) return null;                                                  // streets, shops, buildings… are not life places here
  const parts = [];
  for (const v of [p.district, p.city, p.county, p.state]) { const s = text(v, 80); if (s && s !== name && !parts.includes(s)) parts.push(s); }
  const country = text(p.country, 80);
  return {
    placeId: p.osm_type && p.osm_id != null ? `osm:${String(p.osm_type)[0].toUpperCase()}${p.osm_id}` : null,
    name, region: kind === 'country' ? '' : parts.join(', '), country: kind === 'country' ? name : country,
    countryCode: /^[A-Za-z]{2}$/.test(p.countrycode || '') ? p.countrycode.toUpperCase() : '',
    latitude: round5(c[1]), longitude: round5(wrapLon(c[0])), kind,
    ...(p.osm_key === 'place' ? {} : { _area: true }),          // an administrative outline rather than the settlement itself (internal ranking hint)
  };
}
/** Order results: exact name matches first (ignoring spaces, hyphens, accents and case), settlements before administrative areas, provider order as tiebreak. */
export function rankPlaces(query, places, limit = 6) {
  const q = foldText(String(query).split(',')[0]);
  const out = [];
  places.forEach((p, i) => {
    if (!p) return;
    const dup = out.find((o) => foldText(o.p.name) === foldText(p.name) && o.p.countryCode === p.countryCode && Math.abs(o.p.latitude - p.latitude) < 0.15 && Math.abs(o.p.longitude - p.longitude) < 0.15);
    const n = foldText(p.name);
    const score = (n === q ? 30 : n.startsWith(q) ? 20 : n.includes(q) ? 10 : 0) + (KIND_RANK[p.kind] || 1) - (p._area ? 0.5 : 0);
    if (dup) { if (score > dup.score) { dup.p = p; dup.score = score; } return; }
    out.push({ p, score, i });
  });
  return out.sort((a, b) => (b.score - a.score) || (a.i - b.i)).slice(0, limit).map(({ p }) => { const { _area, ...rest } = p; return rest; });
}
export const placeLabel = (p) => [p.name ?? p.placeName, p.region, p.country].filter(Boolean).join(', ');
