import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../lib/core.mjs';
import { LEGACY_V1 } from './fakes.mjs';

const NOW = Date.UTC(2026, 10, 16);
const wp = (over = {}) => ({ id: over.id || core.newId(), placeId: null, placeName: 'X', region: '', country: 'India', countryCode: 'IN', latitude: 31.1256, longitude: 76.1162, geocodeSource: 'photon', locationPrecision: 'town', startDate: '1990', endDate: null, isCurrent: false, stayType: 'home', chapter: 'childhood', note: '', sortIndex: 0, ...over });
const journey = (waypoints, over = {}) => core.validateJourney({ ...core.emptyJourney('t'), waypoints, ...over }, { nowMs: NOW });

test('partial dates keep exactly the precision entered', () => {
  assert.deepEqual(core.parsePartialDate('1996'), { y: 1996, m: null, d: null, precision: 'year' });
  assert.equal(core.parsePartialDate('1996-09').precision, 'month');
  assert.equal(core.parsePartialDate('1996-09-02').precision, 'day');
  assert.equal(core.parsePartialDate('1996-02-30'), null);
  assert.equal(core.parsePartialDate('2024-02-29').d, 29);
  assert.equal(core.parsePartialDate('NOW'), null);
  assert.equal(core.makePartialDate('1996', null, null), '1996');
  assert.equal(core.makePartialDate('1996', '9', null), '1996-09');
  assert.equal(core.formatPartialDate('1996'), '1996');
  assert.equal(core.formatPartialDate('1996-09'), 'Sep 1996');
  assert.equal(core.formatPartialDate('1996-09-02'), '2 Sep 1996');
  assert.equal(core.dateStartMs('1996'), Date.UTC(1996, 0, 1));
  assert.equal(core.dateEndMs('1996'), Date.UTC(1997, 0, 1) - 1);
});

test('a year-only place is stored with year precision, never an invented day', () => {
  const j = journey([wp({ startDate: '1990' })]);
  assert.equal(j.waypoints[0].startDate, '1990');
  assert.equal(j.waypoints[0].startDatePrecision, 'year');
  assert.equal(core.weatherPlan(j.waypoints[0], { nowMs: NOW }).kind, 'none');
});

test('migration v1 → v2 converts "NOW", keeps every legacy field and is idempotent', () => {
  const { journey: j, migrated, fromVersion } = core.migrateJourney(structuredClone(LEGACY_V1), { journeyId: 'default' });
  assert.equal(migrated, true); assert.equal(fromVersion, 1);
  const v = core.validateJourney(j, { nowMs: NOW });
  assert.equal(v.schemaVersion, 2); assert.equal(v.displayName, 'Alex Rivera'); assert.equal(v.waypoints.length, LEGACY_V1.waypoints.length);
  assert.equal(JSON.stringify(v).includes('"NOW"') && !v.waypoints.some((w) => w.startDate === 'NOW'), true, 'NOW survives only as a legacy note');
  const lisbon = v.waypoints.find((w) => w.placeName === 'Lisbon');
  assert.equal(lisbon.isCurrent, true); assert.equal(lisbon.endDate, null); assert.equal(lisbon.startDate, null); assert.deepEqual(lisbon.legacy, { year: 'NOW' });
  const montreal = v.waypoints.find((w) => w.placeName === 'Montreal');
  assert.equal(montreal.latitude, null); assert.equal(montreal.geocodeSource, 'unresolved', 'missing coordinates are flagged, not invented');
  assert.equal(v.waypoints.find((w) => w.placeName === 'Denpasar').legacy.photo, 'bali.jpg', 'unknown waypoint fields are preserved');
  assert.equal(v.legacy.theme, 'midnight', 'unknown journey fields are preserved');
  assert.equal(v.waypoints.find((w) => w.placeName === 'New York').stayType, 'birthplace');
  assert.equal(v.waypoints.find((w) => w.placeName === 'Denpasar').stayType, 'visit');
  assert.equal(v.waypoints.find((w) => w.placeName === 'Nadi').stayType, 'visit', 'v1 "under two months = visit" rule is frozen in');
  assert.equal(v.birthDate, '1990-06-15'); assert.equal(v.visibility, 'public');
  const again = core.migrateJourney(v);
  assert.equal(again.migrated, false); assert.deepEqual(again.journey, v);
  const twice = core.migrateJourney(structuredClone(LEGACY_V1), { journeyId: 'default' }).journey;
  assert.deepEqual(twice.waypoints.map((w) => w.id), j.waypoints.map((w) => w.id), 'ids are stable across repeated migrations');
  assert.throws(() => core.migrateJourney({ schemaVersion: 99, waypoints: [] }), /newer version/);
});

test('validation rejects bad input on the server side', () => {
  const bad = (over, re) => assert.throws(() => journey([wp(over)]), re);
  bad({ latitude: 95 }, /Latitude/); bad({ longitude: -181 }, /Latitude/); bad({ latitude: 'abc' }, /Latitude/);
  bad({ latitude: null, longitude: null }, /no verified location/);
  bad({ startDate: null }, /date is required/); bad({ startDate: '1996-13' }, /Dates must be/);
  bad({ startDate: '2090' }, /future/); bad({ startDate: '2001', endDate: '1999' }, /before the arrival/);
  bad({ isCurrent: true, endDate: '2020' }, /current stay/); bad({ stayType: 'holiday' }, /Type must be/);
  bad({ placeName: '   ' }, /needs a name/); bad({ id: 'has space' }, /stable id/);
  assert.throws(() => journey([wp({ id: 'a' }), wp({ id: 'a' })]), /Duplicate/);
  assert.throws(() => core.validateJourney({ waypoints: [] }), /schemaVersion/);
  assert.throws(() => journey(Array.from({ length: 301 }, (_, i) => wp({ id: `w${i}` }))), /At most/);
  const ok = journey([wp({ note: 'x'.repeat(5000), placeName: `<b>${'y'.repeat(300)}` })]);
  assert.equal(ok.waypoints[0].note.length, 600); assert.equal(ok.waypoints[0].placeName.length, 120);
  assert.equal(journey([wp({ startDate: '2001', endDate: '2001' })]).waypoints[0].endDatePrecision, 'year');
});

test('timeline: chronological, event-paced, with an exact inverse', () => {
  const j = journey([wp({ id: 'c', startDate: '2015-03-28', latitude: 35.68, longitude: 139.69 }), wp({ id: 'a', startDate: '1960', stayType: 'birthplace' }), wp({ id: 'b', startDate: '1996-09', latitude: 43.65, longitude: -79.38 })]);
  const tl = core.buildTimeline(j, NOW);
  assert.deepEqual(tl.events.map((e) => e.wp.id), ['a', 'b', 'c']);
  assert.equal(tl.events[0].t, 0); assert.ok(tl.events[2].t < 1);
  const linearB = (core.dateStartMs('1996-09') - tl.t0) / (tl.t1 - tl.t0);
  assert.ok(tl.events[1].t < linearB - 0.1, `a 36-year gap is compressed (paced ${tl.events[1].t.toFixed(2)} vs linear ${linearB.toFixed(2)})`);
  for (const e of tl.events) assert.ok(Math.abs(tl.tOfTime(tl.timeOfT(e.t)) - e.t) < 1e-9);
  for (let t = 0; t <= 1; t += 0.05) assert.ok(tl.timeOfT(t + 0.01) >= tl.timeOfT(t), 'time never runs backwards as t advances');
  assert.equal(tl.timeOfT(1), NOW); assert.ok(tl.playSeconds >= 12 && tl.playSeconds <= 120);
});

test('discovery rule: reached places are a pure function of journeyTime, forwards and backwards', () => {
  const j = journey([wp({ id: 'a', startDate: '1990' }), wp({ id: 'b', startDate: '2000', latitude: 51.5, longitude: -0.12 }), wp({ id: 'c', startDate: '2010', latitude: 35.68, longitude: 139.69 })]);
  const { events } = core.buildTimeline(j, NOW);
  assert.deepEqual(core.reachedIds(events, 0), ['a']);
  assert.deepEqual(core.reachedIds(events, events[1].t - 1e-6), ['a']);
  assert.deepEqual(core.reachedIds(events, events[1].t), ['a', 'b']);
  assert.deepEqual(core.reachedIds(events, 1), ['a', 'b', 'c']);
  assert.deepEqual(core.reachedIds(events, events[2].t - 1e-6), ['a', 'b'], 'scrubbing back un-reaches the later place');
  assert.deepEqual(core.reachedIds(events, 0), ['a']);
  assert.equal(core.activeIndex(events, 0.999), 2);
});

test('edge cases: same city twice, same date, overlapping stays, ongoing stay', () => {
  const j = journey([
    wp({ id: 'home', startDate: '1996-09', isCurrent: true }),
    wp({ id: 'school', startDate: '2008', endDate: '2012', stayType: 'education', latitude: 43.65, longitude: -79.38 }),
    wp({ id: 'tie2', startDate: '2019', sortIndex: 2, latitude: 51.5, longitude: -0.12 }),
    wp({ id: 'tie1', startDate: '2019', sortIndex: 1, latitude: -16.85, longitude: 179.97 }),
    wp({ id: 'again', startDate: '2022', stayType: 'visit' }),
  ]);
  const tl = core.buildTimeline(j, NOW);
  assert.deepEqual(tl.events.map((e) => e.wp.id), ['home', 'school', 'tie1', 'tie2', 'again'], 'same-date entries follow explicit sortIndex');
  assert.ok(tl.events[3].t > tl.events[2].t, 'same-date entries still get distinct timeline stops');
  const home = tl.events[0];
  assert.equal(home.wp.endDate, null); assert.equal(home.endMs, NOW, 'an ongoing stay runs to today and is not ended by later entries');
  assert.equal(tl.events[4].durMs, null, 'unknown duration stays unknown');
  assert.equal(j.waypoints.filter((w) => w.latitude === 31.1256).length, 2, 'two stays in one city remain two records');
  assert.equal(core.statsAt(tl.events, 1).places, 4, 'but count as one place');
});

test('age is only as exact as the birth date', () => {
  const day = { date: '1990-06-15', precision: 'day' };
  assert.deepEqual({ ...core.ageAt(day, Date.UTC(1996, 5, 14)), frac: 0 }, { years: 5, approx: false, frac: 0 });
  assert.equal(core.ageAt(day, Date.UTC(1996, 5, 15)).years, 6);
  assert.equal(core.ageAt({ date: '1990', precision: 'year' }, Date.UTC(1996, 5, 15)).approx, true);
  assert.equal(core.ageAt({ date: '1990-06', precision: 'month' }, Date.UTC(1996, 5, 20)).approx, true);
  assert.equal(core.ageAt({ date: '1990-06', precision: 'month' }, Date.UTC(1996, 8, 1)).approx, false);
  assert.equal(core.ageAt(null, NOW), null); assert.equal(core.ageAt(day, Date.UTC(1980, 0, 1)), null);
  assert.equal(core.resolveBirth(journey([wp({ stayType: 'birthplace', startDate: '1988-02' })])).precision, 'month');
  assert.equal(core.resolveBirth(journey([wp()])), null, 'no birthplace and no birth date → no age at all');
});

test('halo stays local and only uses duration when it is known', () => {
  const visit = core.haloFor('visit', 40 * core.YEAR), home = core.haloFor('home', null), long = core.haloFor('home', 30 * core.YEAR);
  assert.ok(visit.rs < home.rs && home.rs < long.rs);
  assert.ok(long.rs <= 9, `even a lifelong home lights a region of ≤ 9° (${long.rs.toFixed(1)}°), not a country`);
  assert.equal(core.haloFor('visit', 40 * core.YEAR).rs, core.haloFor('visit', null).rs);
});

test('anti-meridian: longitude wraps and the light mask draws across the seam', () => {
  assert.equal(core.wrapLon(181), -179); assert.equal(core.wrapLon(-181), 179); assert.equal(core.wrapLon(180), -180);
  const W = 2048, near = core.maskCopies(179.97, W, 40);
  assert.equal(near.length, 2); assert.ok(near.some((x) => x < 40) && near.some((x) => x > W - 40), 'drawn on both edges of the texture');
  assert.equal(core.maskCopies(0, W, 40).length, 1);
  assert.equal(core.maskCopies(-179.9, W, 40).length, 2);
  const d = core.greatCircleRad(-16.85, 179.97, -16.85, -179.97) * core.EARTH_KM;
  assert.ok(d < 10, `±180° neighbours are ${d.toFixed(1)} km apart, not half a world`);
});

test('weather plan never claims more precision than the date has', () => {
  const base = wp({ startDate: '2015-03-28' });
  assert.deepEqual(core.weatherPlan(base, { nowMs: NOW }), { kind: 'historical', date: '2015-03-28' });
  assert.equal(core.weatherPlan(wp({ startDate: '2015-03' }), { nowMs: NOW }).kind, 'season');
  assert.equal(core.weatherPlan(wp({ startDate: '2015' }), { nowMs: NOW }).kind, 'none');
  assert.equal(core.weatherPlan(wp({ startDate: '1935-05-01' }), { nowMs: NOW }).kind, 'season', 'before the archive starts');
  assert.equal(core.weatherPlan(wp({ startDate: '2015-03-28', isCurrent: true }), { nowMs: NOW, atToday: true }).kind, 'live');
  assert.equal(core.weatherPlan(wp({ startDate: '2015-03-28', isCurrent: true }), { nowMs: NOW }).kind, 'historical');
  assert.equal(core.weatherPlan({ ...base, latitude: null, longitude: null }).kind, 'none');
});

test('geocoder results: normalised, filtered, de-duplicated and ranked', () => {
  const f = (name, lon, lat, p) => ({ geometry: { coordinates: [lon, lat] }, properties: { name, osm_key: 'place', osm_value: 'town', type: 'city', osm_type: 'N', osm_id: 1, ...p } });
  const n = core.normalizePhotonFeature(f('Nawanshahr', 76.1162, 31.1256, { county: 'Shaheed Bhagat Singh Nagar', state: 'Punjab', country: 'India', countrycode: 'in' }));
  assert.deepEqual(n, { placeId: 'osm:N1', name: 'Nawanshahr', region: 'Shaheed Bhagat Singh Nagar, Punjab', country: 'India', countryCode: 'IN', latitude: 31.1256, longitude: 76.1162, kind: 'town' });
  assert.equal(core.normalizePhotonFeature(f('High Street', 0, 0, { osm_key: 'highway', osm_value: 'residential', type: 'street' })), null);
  assert.equal(core.normalizePhotonFeature({ properties: { name: 'x' } }), null);
  assert.equal(core.normalizePhotonFeature(f('Nowhere', 0, 95, {})), null);
  assert.equal(core.foldText('Nawan Shahr'), core.foldText('nawanshahr'));
  const list = [f('Nawanshahr Colony', 75, 30, { osm_value: 'suburb' }), f('Nawanshehr', 73.26, 34.17, { country: 'Pakistan', countrycode: 'PK' }), f('Nawanshahr', 76.117, 31.125, { osm_key: 'boundary', osm_value: 'administrative', countrycode: 'IN' }), f('Nawanshahr', 76.1162, 31.1256, { countrycode: 'IN' })].map(core.normalizePhotonFeature);
  const ranked = core.rankPlaces('Nawan Shahr', list, 6);
  assert.equal(ranked[0].name, 'Nawanshahr'); assert.equal(ranked[0].kind, 'town', 'the settlement wins over its administrative duplicate');
  assert.equal(ranked.filter((p) => p.name === 'Nawanshahr').length, 1);
  assert.equal(core.rankPlaces('x', Array.from({ length: 20 }, (_, i) => core.normalizePhotonFeature(f(`X${i}`, i, i, {}))), 6).length, 6);
});
