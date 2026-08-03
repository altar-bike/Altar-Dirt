# Altar Cycles — Trail Conditions

Instructions for Claude working in this folder via Cowork or Claude Code.

Put this file in the project folder root as `CLAUDE.md` and it loads automatically every session. The owner is **Matt** (Altar Cycles, River Arts District, Asheville NC).

---

## What this project is

A single static HTML page that scores mountain bike trail rideability from weather data. It reads Open-Meteo (soil moisture at 0–1cm and 3–9cm, soil temperature at 6cm, hourly rain, sun, wind, humidity — three days back, four forward), runs a scoring model in the browser, and shows a per-hour condition strip for nine riding areas around western NC.

**`index.html` is the entire application.** No build step, no package manager, no dependencies except Google Fonts over CDN. Do not introduce any. If you find yourself wanting npm, stop and ask.

Hosted on **GitHub Pages** from this repo. Linked from the Shopify nav at altar.bike.

## Deployed state (as of 2026-08-03)

- **Repo:** `altar-bike/Altar-Dirt` (public — Pages requires it). A `.nojekyll`
  file at root is required; Jekyll chokes on the Liquid examples in this file.
- **Live page:** https://altar-bike.github.io/Altar-Dirt/
- **Feedback service:** `feedback-api/` in this repo, deployed on Railway
  (project "pleasant-compassion", service "Altar-Dirt") at
  https://altar-dirt-production.up.railway.app/ — volume at `/data`, env vars
  `DATA_DIR`, `EXPORT_TOKEN`, `CREW`. See `feedback-api/README.md`. This
  replaces the old Google Apps Script / Google Sheet route everywhere it's
  mentioned below; the ratings CSV now comes from the service's
  `/export.csv?token=…` endpoint (Matt has the token; it's also in the
  Railway service variables).
- **Railway deploys from a mirror** of the public repo (the Railway GitHub
  app is not installed on the altar-bike org). Pushing to GitHub does NOT
  auto-redeploy the feedback service. To ship a server change: Railway →
  service → **Settings → Upstream Repo → Check for updates**, wait for
  "New version of the upstream repo available!" to appear (it lags the
  push by a minute or two and the first click often reports nothing),
  then **Update → Yes**. Verify with `/health` afterwards. Page-only
  changes (`index.html`) never need a Railway redeploy.
  Installing the Railway GitHub app on the altar-bike org would remove
  this step entirely — worth doing if server changes get frequent.
  Needs Matt; it's a permission grant on his org.
- **Weekly calibration check-in** runs as a scheduled Claude task, Mondays
  ~7:23am ET, reading the export CSV and reporting trends to Matt. It only
  recommends multiplier changes past the 30–50-obs-per-class threshold.
- The ratings data contains two rows with trail `TEST — delete me`
  (deploy verification). Always exclude them from analysis.

---

## First thing, every session

Establish actual state before changing anything. Don't assume the repo, remote, or Pages deployment exists.

```bash
ls -la
git status 2>/dev/null || echo "not a git repo"
git remote -v 2>/dev/null
gh auth status 2>/dev/null || echo "gh cli unavailable"
```

If `gh` is available and authenticated, use it. If not, use the GitHub web UI through the browser and tell Matt what you're clicking. Do not install tooling without asking.

There may also be a **parallel Shopify deployment** — an earlier route pasted the app into a theme section. If `trail-conditions.liquid` is present and Matt is running that too, either keep both in sync (regenerate the liquid from `index.html`, see below) or ask him to pick one. Two diverging copies is the failure mode to avoid.

---

## Task: first-time deploy

1. `git init`, commit `index.html`.
2. Create a **public** repo. Free GitHub Pages requires public; the file is served publicly anyway, so nothing is gained by private.
3. Push to `main`.
4. Enable Pages: Settings → Pages → Deploy from a branch → `main` → `/ (root)`. With `gh`:
   `gh api -X POST repos/{owner}/{repo}/pages -f source.branch=main -f source.path=/`
5. Wait for the deploy, then **actually fetch the URL and confirm the page returns 200 and contains `id="da-grid"`.** Don't report success off the API response alone.
6. Give Matt the URL and tell him to add it to Shopify nav himself (Online Store → Navigation → Main menu).

---

## Task: routine update and deploy

Any change to `index.html` follows this sequence. Run the checks *before* pushing.

```bash
# 1. extract the app script and syntax-check it
python3 - <<'EOF'
import re
s=open('index.html').read()
blocks=re.findall(r'<script>(.*?)</script>', s, re.S)
open('/tmp/app.js','w').write("(function(){"+blocks[-1]+"})")
EOF
node --check /tmp/app.js

# 2. structural checks
grep -c 'open-meteo.com' index.html      # must be >= 1 (licence requires attribution)
grep -c 'id="da-grid"' index.html        # must be 1
grep -o 'name: "[^"]*"' index.html | head -20   # trail list sanity
```

Then commit with a message saying what changed and why, push, wait for Pages, and **fetch the live URL to confirm** before telling Matt it's done.

If `node --check` fails, do not push. Fix it.

---

## Where things live

Search by string, never by line number — line numbers move.

| What | Anchor string |
|---|---|
| Settings block (top of file) | `window.ALTAR_SETTINGS` |
| Request-form email | `requestEmail:` |
| Rating endpoint | `feedbackEndpoint:` |
| Trail list | `var TRAILS` |
| Soil multipliers | `var SOILS = {` |
| Condition states and colours | `var STATES` |
| Wetness thresholds | `sm > 0.27` and `sm < 0.11` |
| Cache duration | `CACHE_MINUTES` |

---

## Task: edit the trail list

```js
{ name: "Bent Creek", place: "Pisgah NF, NC", lat: 35.4919, lon: -82.6285, soil: "rocky", exposure: "shaded" }
```

- `soil`: `clay` | `loam` | `rocky` | `sandy`
- `exposure`: `shaded` | `mixed` | `exposed`
- Coordinates should point at **where people actually ride**, not the parking lot at the bottom. A trailhead 500ft up gives materially different numbers than the valley floor.

**Known weak point:** `Pisgah Proper` is pinned at the Davidson River ranger station (~2,200ft) while the riding — Black Mountain, Clawhammer, Bennett Gap — sits well above it. That card runs optimistic for the high country. If Matt raises it, the fix is splitting into two entries at different elevations.

Never guess a coordinate. Look it up and say where you got it.

---

## Task: recalibrate the model

This is the highest-value recurring work. Riders rate the **score** the page showed them, not the trail in the abstract, and each rating is stored beside the exact model inputs that produced it.

Current values, all of which are **my original guesses and unvalidated**:

| Soil | `wet` (penalty multiplier) | `dry` (drying rate) |
|---|---|---|
| clay | 1.30 | 0.75 |
| loam | 1.00 | 1.00 |
| rocky | 0.55 | 1.40 |
| sandy | 0.70 | 1.30 |

Tacky band: wetness between **0.11 and 0.27** m³/m³. Above 0.27 takes a penalty, below 0.11 reads as blown out. Also generic loam, also a guess.

**Exposure** multipliers stack on `dry`: shaded 0.70, mixed 1.00, exposed 1.35.

### Working from a ratings CSV

Matt exports the `reports` tab from the calibration sheet. Columns include `verdict`, `actual`, `when`, `shown_score`, `shown_state`, `soil`, `exposure`, `soil_moisture`, `soil_temp_f`, `rain_24h`, `rain_72h`, `hours_since_rain`, `wet_mult`, `dry_mult`, `known_crew`.

- **`verdict` is the direction the score should move.** `+1` = the page scored it too low, it rode better. `-1` = scored too high, it rode worse. `0` = about right.
- **Filter to `known_crew = yes`.** The endpoint is public; unlisted names are untrusted.
- **Respect `when`.** A `yesterday` rating must be matched against yesterday's model state, not the snapshot in the row. Either drop those or handle them explicitly — don't silently treat them as current.
- **Group by soil class, not by trail.** Five of nine areas are `rocky`, two are `clay`.
- **Need roughly 30–50 observations per soil class** before moving a multiplier. Below that, report the trend and change nothing.

Method: plot verdict against `soil_moisture` and `rain_24h` per soil class, find where the model reads consistently high or low, adjust. **This is a scatter plot and an afternoon. Do not reach for machine learning.** With this sample size a fitted model would be noise with a confidence interval.

Always show Matt the before/after numbers and the reasoning. He has ground truth you don't — he's ridden these in every condition they get into.

---

## Data sources

Open-Meteo drives the score. Everything else is **observed** data shown
next to the score, and deliberately does **not** feed into it.

| Source | Key? | Called from | What it gives |
|---|---|---|---|
| Open-Meteo | no | the page | forecast + modelled soil moisture — the score |
| NWS `api.weather.gov` | no | the page | watches/warnings/advisories per trail |
| USGS Water Services | no | the page | creek discharge/stage + 7-day trend |
| NC State CLOUDS | **yes** | Railway `/soil` | measured ECONet soil moisture and temperature |

**Why measured data doesn't change the score.** Creek level and station
soil moisture are better signals than the model in principle, but
weighting them is a calibration decision — it needs rider ratings and
Matt's ground truth, not a guess. Wiring them into the score without
that would be exactly the mistake the ratings system exists to prevent.
Revisit once a soil class clears the 30–50 observation threshold.

### NWS alerts

One call for all nine areas, using each trail's `zone` (forecast zone)
and `czone` (county zone) — flood products often go out by county, so
both are queried. Zones came from `api.weather.gov/points/<lat>,<lon>`;
if a trail moves, re-look-up the zone, don't guess it. Events named
"Test Message" are filtered out.

### USGS creek gauges

`gauge` and `gaugeMi` on each trail; names and normals in `GAUGES`.
The `med` tables are month-by-month median discharge in cfs, computed
from USGS published day-of-year medians over each site's period of
record, and **baked in** so the "% of normal" comparison costs no extra
request. If you add a gauge, pull its real medians the same way — do
not estimate them.

- Same-river matches: Pisgah Proper → Davidson River (1.4 mi),
  North Mills River → Mills River (3.8 mi), Wilson Creek → Wilson Creek
  at Adako (4.9 mi).
- **DuPont is a judgment call.** There is no active realtime gauge on
  the Little River. It currently borrows Davidson River (7.1 mi) as the
  nearest small mountain stream of similar character; the alternative
  is French Broad at Blantyre (6.9 mi), a much bigger river that
  integrates several watersheds. Ask Matt which he'd trust.
- **Hatley Pointe and Windrock show no creek line at all** — nearest
  gauges are 14.2 mi and 11.3 mi and not representative. Showing
  nothing beats showing something misleading. Same rule for new trails.
- Wilson Creek and Greenbrier report stage only, no discharge, so they
  show feet and a trend but no comparison to normal.

### CLOUDS / ECONet

`CLOUDS_HASH` lives in the Railway service variables and must never
appear in `index.html` — the page calls our `/soil` proxy instead.
CLOUDS also sends no CORS headers, so a proxy is required regardless.

- `GET /soil` — cached 20 min, returns `{stations:[…]}`; the page picks
  the nearest station within 45 miles that actually reported. Returns
  an empty list rather than an error when the key is missing or CLOUDS
  is down, so the page degrades to nothing.
- `GET /soil/raw?token=…&type=meta` — token-gated view of the raw
  upstream response, for checking the JSON shape. The parser in
  `server.js` (`harvest`) is deliberately shape-tolerant because CLOUDS
  varies its nesting; if station readings stop appearing, compare
  `/soil/raw` against the parser before assuming the API broke.
- Endpoint is `api.climate.ncsu.edu/data.php`; variables are
  `soilmoist`, `soilmoist20cm` (m³/m³) and `soiltemp` (°F).
**Station matching is elevation-aware, and biased low.** Matt's call
(3 Aug 2026) is to read from the lower stations everywhere, so a station
*above* the trail is penalised about three times harder than one below
it — a summit sensor never wins on distance alone. Elevation comes from
Open-Meteo for the trail and CLOUDS for the station, both in feet.
Two reasons elevation matters at all:

1. Without it, DuPont sat exactly 16.1 mi from both FLET (2,067ft,
   0.44 m³/m³, 88°F) and FRYI (5,320ft, 0.25, 65°F) and picked between
   wildly different numbers on iteration order alone.
2. The station reading exists to sanity-check the model's soil moisture
   *at the same point*. Comparing a 5,320ft station against a score
   computed at 2,100ft would be apples to oranges.

Set `station: "FRYI"` on a trail to pin one explicitly and bypass the
scoring.

**This makes the Pisgah pin problem visible rather than hiding it.**
Because Pisgah Proper is pinned at the ranger station, elevation
matching sends it to a *valley* station (FLET) rather than Frying Pan
Mountain. That is faithful to the pin and consistent with the score,
but the pin is the thing that's wrong — see the known weak point below.
The station line prints its elevation for exactly this reason: a reader
can see "2,067 ft" and judge whether it speaks for where they ride.
Splitting Pisgah into a low and a high entry fixes the pin, the station
match, and the score in one move. Needs Matt.

**Caveat on FLET, and it now matters more.** Mountain Horticultural
Crops Research Station is a working agricultural research station and
reads much wetter than nearby sites (0.44 m³/m³ against 0.25–0.30 at
Frying Pan and Green River). Some of that is likely irrigation, not
weather. With the low bias in place **all five NC trails now resolve to
FLET**, so one possibly-irrigated sensor is speaking for Bent Creek,
North Mills River, Pisgah, DuPont and Kanuga at once — and every card
reports the same "~16–20 points wetter than the model" line, which is
suspicious precisely because it is identical everywhere.

GRGL (Green River Game Land, 2,080ft) is unirrigated woodland at
effectively the same elevation and loses to FLET by a fraction of a
mile on the southern trails. Pinning `station: "GRGL"` on DuPont and
Ride Kanuga would spread the load and probably read truer. Matt's call.

### Interpreting the numbers

`creekMeaning()` and `stationMeaning()` turn the readings into plain
English under **Measured nearby**. Creek flow is read against the
seasonal normal (ground full vs shedding water), station soil against
the model's 0.11–0.27 tacky band, and when the two disagree by 8 points
or more the card says so outright — that gap is the reason for
measuring anything. Soil temperature calls out freeze, slow drying and
fast drying. Keep the copy in the brand voice: short sentences, plain,
dry, no marketing words.

## Hard constraints

**Never remove the Open-Meteo attribution.** The footer link plus the note that scores are Altar's modification of their data are both required by CC BY 4.0. Non-negotiable.

**Keep the other credits too.** NWS and USGS are US Government works and
public domain, so their credit is courtesy rather than licence — but NC
State's ECONet is a university-operated network providing data under an
account, and crediting the NC State Climate Office is expected. Leave all
four footer credits in place.

**Never put an API key in `index.html`.** It's client-side; anyone can read it. Open-Meteo's free tier is non-commercial only and a bike shop site is arguably commercial — if Matt moves to their paid plan, the key needs a server-side proxy (a Cloudflare Worker is about fifteen lines). Flag this rather than shipping a key.

**Open licence question:** whether Matt has heard back from info@open-meteo.com about commercial use. If he hasn't, remind him once. Don't nag.

**Keep it self-contained.** One file, no build, no npm, no framework. This is a deliberate constraint so a bike shop owner can maintain it.

**Don't add browser-storage-dependent features that need to work for the crew.** `localStorage` is per-device. It's fine for caching and the offline rating queue; it is not fine for anything that must be shared.

---

## Brand rules

From Altar's guide. Owner: **Sarah Cearley** (Brand & Marketing).

| Name | Hex | Role |
|---|---|---|
| Forge Black | `#111111` | background |
| Ash White | `#CCCCCC` | body text — never pure white |
| Altar Rust | `#B85C2A` | accent only, never a flood colour |
| Trail Earth | `#4A3728` | secondary surface |
| Pisgah Shadow | `#2C4A5A` | tertiary, sparing |

Type: **Big Shoulders Display 900**, always all-caps, headings only. **Lora** body, sentence case, 1.65–1.75 line height. **Space Mono** for all numbers and data labels. Three faces maximum. Never a white background on a digital asset. No neon, no flat corporate grey.

**Open item:** the condition ramp adds two olive greens (`#7A8A3E`, `#6B7A38`) and a bone tone (`#A9998A`) that are not in the palette — the guide has no green. Flagged for Sarah's sign-off and **not yet approved**. If she declines, the fallback is a single-hue rust ramp from pale to deep. Don't add further off-palette colours without asking.

**Voice for any copy:** plain-spoken, short sentences, dry. Say ride, build, tune, loam, chunk, Pisgah, Bent Creek, crew. Never say curated, seamless, world-class, passion, one-stop shop. If it could run as bank-ad copy, rewrite it.

---

## Regenerating the Shopify section (only if that deployment is still live)

`trail-conditions.liquid` is generated from `index.html` — never hand-edit it. It extracts the `<style>`, the `<div id="dirt-app">` markup, and the `<script>`, prepends an `@import` for the fonts, and appends a `{% schema %}` block. Skip the `<!DOCTYPE>`/`<html>`/`<head>`/`<body>` wrapper.

After regenerating, verify the file contains **zero** `{{` and no `%}` outside the schema tags, or Liquid will try to parse the JavaScript.

---

## Ask Matt, don't guess

- Whether Sarah approved the off-palette condition colours
- Whether Open-Meteo answered on commercial use
- Which gauge DuPont should borrow (Davidson River vs French Broad)
- Whether creek level or station soil moisture should start affecting
  the score — only once there's calibration data to justify it
- Any soil or exposure correction — he's ridden them, you haven't
- Anything that spends money or changes a live customer-facing page

## Report honestly

If a deploy fails, say what failed and what you saw. If a calibration sample is too small to justify a change, say so and change nothing. If you're unsure whether something worked, fetch the live URL and look — don't infer success from an exit code.
