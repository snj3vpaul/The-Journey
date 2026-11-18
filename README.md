# The Journey

A life story on an interactive 3D globe. The world begins dark; the places you have lived and visited bring it to life as the timeline plays.

No build step. A static front end (`index.html`, Three.js from jsDelivr) plus two Vercel Node functions, with one Upstash Redis database for storage. Runs on Vercel's Hobby plan and Upstash's free tier, within their published limits (which can change).

```
index.html            the whole front end: globe, timeline, editor
lib/core.mjs          shared, dependency-free logic used by browser AND server:
                      data model, v1→v2 migration, validation, partial dates, timeline pacing,
                      Discovery halo sizing, statistics, weather planning, geocoder normalisation
api/journey.js        GET/PUT the journey · owner session (sign in/out) · cached weather
api/geocode.js        place search proxy (Photon autocomplete), cached and rate-limited
api/_shared.js        server-only helpers: Upstash REST, sessions, rate limiting, CSRF checks
journey.json          the sample journey (v1 format; migrated on the fly)
scripts/dev-server.mjs  zero-dependency local server that runs the real API code
tests/                unit + API tests (node --test) and browser end-to-end tests (puppeteer-core)
```

## Environment variables

Set these in Vercel → Project → Settings → Environment Variables (and in `.env.local` for local work). They are read only by the `/api` functions and never sent to the browser. See `.env.example`.

| Variable | Required | Purpose |
|---|---|---|
| `UPSTASH_REDIS_REST_URL` | for cloud saving | Upstash database → REST API URL |
| `UPSTASH_REDIS_REST_TOKEN` | for cloud saving | Upstash REST token |
| `JOURNEY_EDIT_TOKEN` | to edit | Owner passphrase. Empty = nobody can save to the cloud. Use a long random phrase. |
| `JOURNEY_SESSION_SECRET` | optional | Extra key material for session signing. Rotate to sign every device out. |
| `GEOCODER_URL` | optional | Any Photon-compatible endpoint. Default: public `https://photon.komoot.io/api` (fair use). |
| `GEOCODER_USER_AGENT` | optional | User-Agent sent to the geocoder. |
| `OPEN_METEO_URL`, `OPEN_METEO_ARCHIVE_URL` | optional | Weather endpoints (Open-Meteo by default). |

Without the two Upstash variables the app runs in **demo mode**: it is labelled as such, edits stay in that browser's local storage, and nothing is ever reported as saved to the cloud.

## Deploy

1. Create a free Redis database at <https://console.upstash.com> and copy the REST URL and token.
2. Import the repository at <https://vercel.com/new>. Framework preset **Other**, no build command, no output directory.
3. Add the environment variables above, then redeploy.
4. Open the site, choose **Edit Journey**, enter the passphrase. The session is an HttpOnly, signed cookie valid for 7 days.

## Local development

```
npm install            # dev-only: three (served to the browser in tests) and puppeteer-core
npm run dev            # http://localhost:3000 — static files + the real /api routes, reads .env.local
npm test               # unit + API tests
CHROME_PATH=/path/to/chrome npm run test:e2e     # browser tests; optional SHOTS=dir EARTH_TEXTURE=file.jpg
```

The end-to-end tests replace Upstash, Photon and Open-Meteo with in-process fakes (`tests/fakes.mjs`). Their place-search results are fixtures, not live provider data.

## Data model (schema v2)

One JSON document per journey, stored as a Redis string under `journey:<id>` (plain `GET`/`SET`, no RedisJSON).

- **Journey:** `schemaVersion`, `journeyId`, `displayName`, `birthDate` (+ precision), `visibility` (`public` | `private`), `createdAt`, `updatedAt`, `revision`, `waypoints`.
- **Waypoint:** `id`, `placeId`, `placeName`, `region`, `country`, `countryCode`, `latitude`, `longitude`, `geocodeSource` (`photon` | `manual` | `globe` | `legacy` | `unresolved`), `locationPrecision`, `startDate` / `endDate` as `YYYY`, `YYYY-MM` or `YYYY-MM-DD` with a matching `…Precision`, `isCurrent`, `stayType` (`birthplace` | `home` | `education` | `work` | `visit`), `chapter`, `note`, `sortIndex` (tie order for same-date entries), `createdAt`, `updatedAt`.

Dates keep the precision you entered: a year-only arrival is stored as `"1996"`, never as 1 January. An ongoing stay is `isCurrent: true` with `endDate: null`. Overlapping stays are allowed and nothing ends another implicitly.

**Migration.** Version-1 documents (`year: "NOW"`, `stage`, `kind`, `lat`/`lon`) are migrated on read by `migrateJourney()` and are not rewritten until the owner saves. Fields with no place in v2 are kept under `legacy`. On the first save after migration the original document is copied once to `journey:<id>:backup:v1`; every save also keeps the previous revision at `journey:<id>:prev`. Places that never had coordinates are flagged in the editor ("needs a location") instead of being guessed.

**Saving** is a whole-document `PUT` with the `revision` it was based on. The server validates everything again, rejects stale revisions with `409` (the editor offers to reload), and only reports success after Upstash confirms the write. **Export backup / Import** in the editor round-trips the full JSON.

## Security and privacy

- Writes need the owner session; the passphrase is sent once to open it, compared in constant time, and attempts are rate-limited (8 per 15 minutes per IP, shared through Redis).
- State-changing requests must be same-origin JSON (`Origin` check + `SameSite=Strict` cookie).
- Place search is available to the signed-in owner only once a passphrase is configured, and is rate-limited per IP.
- **Visibility.** "Anyone with the link can view this journey" controls public reads. When it is off, signed-out visitors get a locked screen and the API returns `401` without the data. Migrated v1 journeys start as public because they were already public.

## How it behaves

- **Adding a place:** type at least 3 letters (2 for CJK and other dense scripts). Results come from Photon through `/api/geocode` — debounced, stale replies discarded, settlements ranked before administrative areas, streets and shops filtered out. Choosing a result shows a confirmation card (name, region, country, coordinates, type, "Verified by place search") and previews the spot on the globe. Editing the text afterwards invalidates the choice. If search has no answer: **Enter coordinates** (range-checked, labelled manual) or **Choose on globe**. Saving waits for the server, then the place joins the timeline, the camera turns to it and its light blooms in.
- **Timeline:** one clock (`journeyTime`, the scrubber) drives visible places, arcs, lighting, age, chapter, season and weather. Pacing is event-based: long gaps are compressed logarithmically so empty decades don't drag. Play/pause, 1×/2×/4×, Today, and Follow (dragging the globe turns Follow off until you turn it back on).
- **Discovery:** only places the timeline has reached are lit, each with a soft local halo (visits small, long-term homes wider and warmer; duration counts only when both dates are known). Scrubbing back darkens them again. The light mask is an equirectangular canvas redrawn only while a halo is fading, with copies across the ±180° seam. Statistics are counts of places, countries and chapters, plus a straight-line distance labelled as an estimate. There is no "% of the world discovered" figure, because no defined area metric backs it.
- **Routes:** great-circle arcs between consecutive located events. They are narrative connections: no transport mode or real flight path is implied, and two records in the same place get no arc.
- **Weather:** depends on date precision. An exact day from 1940 on gets an Open-Meteo reanalysis value labelled *historical estimate*. A month gets the season only. A year gets nothing. A current stay viewed at "Today" gets live conditions. Weather is cached server-side (30 days historical, 10 minutes live) and never blocks the globe or saving.
- **Figure:** a small original figure grows from infant to adult with the computed age, and is hidden when age is unknown. Toggle with **Figure**. Ages derived from a year-only or month-only birth date are shown as "≈".
- **Accessibility:** keyboard-operable editor, ARIA combobox for place search, focus restored when panels close, reduced-motion support (cuts instead of fly-throughs), and a text-only fallback when WebGL is unavailable.
