# The Journey

A life story on an interactive 3D globe: glowing waypoints, great-circle flight arcs, seasons, real weather, and an avatar that grows up as you scrub through time.

Zero build step. Runs on Vercel's free Hobby plan with a free Upstash Redis database.

```
.env.example      environment variables (copy to .env.local for local dev)
api/journey.js    serverless function: load / save the journey, cached weather
journey.json      seed data, used until Redis has a saved journey
index.html        the whole front end (Three.js + Tailwind via CDN)
```

## 1. Create the free Upstash Redis database

1. Sign in at <https://console.upstash.com> and choose **Create Database** (Redis).
2. Give it a name, pick the region closest to you, and keep the **Free** plan.
3. Open the database and find the **REST API** section. Copy:
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`

## 2. Deploy to Vercel

1. Put these files in a Git repository (keep the `api/` folder as is) and push it to GitHub.
2. At <https://vercel.com/new>, import the repository. Framework preset: **Other**. No build command, no output directory.
3. Under **Settings → Environment Variables**, add:
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`
   - `JOURNEY_EDIT_TOKEN` (optional, recommended): a passphrase that must be entered in the editor before edits are saved. Without it, anyone with the link can change the journey.
4. Redeploy so the function picks up the variables.

Prefer the command line? `npm i -g vercel`, then `vercel` (preview) or `vercel --prod`. For local development, copy `.env.example` to `.env.local` and run `vercel dev`.

**No Redis yet?** The site still works. It serves `journey.json`, shows a small "Local Data Mode" badge, and keeps your edits in that browser only.

## 3. Editing the journey

**In-app editor (once Redis is connected).** Click **Edit Journey**. Add, edit or delete waypoints in the slide-out panel. Leave latitude/longitude blank and the place is located automatically through Open-Meteo. Every change is saved straight away with `POST /api/journey` under the key `journey:<user-id>`. Tick "This is where I am today" for the one waypoint whose `year` is `"NOW"`.

**Seed file.** Edit `journey.json` and redeploy. Use this for the starting state, or if you never connect Redis. Set `lat`/`lon` to `null` to have them resolved on first load. Note that once a journey has been saved to Redis, Redis wins and the seed file is ignored; delete the `journey:default` key in the Upstash console to return to the seed.

**More than one person.** Add `?user=some-name` to the URL. Each name gets its own Redis key and starts from the seed.

Life chapters (`stage`) with built-in colours: `birth`, `childhood`, `education`, `career`, `adventure`, `family`, `adult`. Any other value works and gets a neutral colour.

Optional `kind` per waypoint: `"home"` or `"visit"`. If you leave it out, a stay under two months counts as a short visit. Homes are round markers, visits are diamonds.

## Two map modes

- **Discovery** (default): the planet starts dark. Each place lights up when the timeline reaches it, with a halo sized by how long you stayed. Scrubbing backward darkens it again, down to the birthplace. The HUD shows "World discovered %" and milestone flashes, and at the end a **Finish orbit** button plays a slow lap around the lit journey.
- **Full Map**: the sunlit globe with every waypoint visible from the start.

Both modes share one timeline; switching keeps the scrubber position and playback. **Chapters** colours the arcs by life chapter and adds the chapter legend.

## Why raw Three.js rather than Globe.gl

Discovery mode needs a custom globe shader (day texture × light mask, with a per-frame pulse), partial arc drawing tied to the scrubber, and a strict performance budget. Globe.gl hides the material and animates arcs on its own clock, which fights "everything is driven by the scrubber".

## Swapping the weather provider

Weather is fetched in two places, both returning `{ kind, code, temp, tmax, tmin, isDay }` where `code` is a WMO weather code:

- `fetchWeather()` in `api/journey.js` (the cached server route).
- `openMeteoDirect()` in `index.html` (browser fallback when the API route is unavailable).

Replace those two functions and keep the return shape; the emoji mapping is the `WMO` table in `index.html`. Geocoding is `geocode()` in both files.

## How it behaves

- **Clicking a place** flies the camera to it and opens its detail card (a bottom sheet on phones). In Discovery mode only visited places respond, and only the active one has a card and weather.
- **Time.** The scrubber value (0 to 1) is the only clock. Arcs, comet, avatar, camera and seasons are computed from it, so scrubbing backward and forward always lands on the same picture. Space or K toggles play.
- **Weather.** Historical dates use Open-Meteo's archive; the "NOW" waypoint uses the live forecast. Requests go through `/api/journey?resource=weather`, which caches in Redis (24 hours for historical days, 10 minutes for live weather so "now" stays current). If Open-Meteo can't be reached, the page estimates weather from latitude and season and shows a "Simulated Weather" badge. The archive starts in 1940; earlier dates are always simulated.
- **Reduced motion.** With the system setting on, idle rotation, particles and confetti are off, and camera moves become instant cuts.
- **Secrets.** The Upstash URL and token are read only inside `api/journey.js`.
- **Globe texture.** Loaded from jsDelivr (`three-globe` example image). If that fails, a procedural globe is drawn instead.
