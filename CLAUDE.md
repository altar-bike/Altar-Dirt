# Altar Cycles — Trail Conditions

Instructions for Claude working in this folder via Cowork or Claude Code.

Put this file in the project folder root as `CLAUDE.md` and it loads automatically every session. The owner is **Matt** (Altar Cycles, River Arts District, Asheville NC).

---

## What this project is

A single static HTML page that scores mountain bike trail rideability from weather data. It reads Open-Meteo (soil moisture at 0–1cm and 3–9cm, soil temperature at 6cm, hourly rain, sun, wind, humidity — three days back, four forward), runs a scoring model in the browser, and shows a per-hour condition strip for nine riding areas around western NC.

**`index.html` is the entire application.** No build step, no package manager, no dependencies except Google Fonts over CDN. Do not introduce any. If you find yourself wanting npm, stop and ask.

Hosted on **GitHub Pages** from this repo. Linked from the Shopify nav at altar.bike.

## Deployed state (as of 2026-08-05)

Ten cards: eight local (Pisgah split Lower/Upper) + two `away`. The
whole local list loads in ONE Open-Meteo request. `/soil` carries
`stations` (soil), `wx` (hourly rain gauges) and `coco` (volunteer daily
rain, cross-check only, `rain·d` row on trails with no scoring gauge),
plus `stale`/`dropped` diagnostics. Rain rows lead with **when** a
soaking fell, not a three-day total. Ratings payload is **v4** — ride
time, per-hour model snapshot, surface multi-select, stewardship call.
Forecast grading runs daily in-process; see its section below. The first
three CSV rows predate v3: two are deploy-test rows named "TEST — delete
me" (filter them), one is real (Matt, Bent Creek, 4 Aug).

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
- **Railway deploys on push (since 4 Aug 2026, late evening).** Matt
  installed the Railway GitHub app on the altar-bike org and the service
  source is connected to `altar-bike/Altar-Dirt`, branch `main`, root
  `feedback-api`. Push to GitHub and the feedback service rebuilds
  itself; verify with the Railway MCP's `list-deployments` that the
  newest deployment's `commitHash` is your commit, then verify by
  `/soil` payload as always. Page-only changes (`index.html`) ship via
  Pages on the same push.

  **The Eject trap, learned the hard way.** While converting from the
  old template-mirror setup, clicking **Eject** did not simply detach —
  it CREATED a brand-new GitHub repo (`altar-bike/Altar-Dirt-PtoK`, one
  squashed "Initial commit") and pointed the service source at it. Two
  deploys briefly ran from that stale copy before the source was
  repointed via the Railway MCP's `railway-agent`. If the deploy list
  ever shows `commitHash` = something not in `git log`, check
  `get-service-config` → `source.repo` FIRST. The PtoK repo is orphaned
  and should be deleted — that's Matt's call to make on GitHub, not
  ours to script.

  **Staged changes can be lost to a racing deploy.** Railway stages
  config edits until something applies them; a variable-triggered
  deploy that starts in between applies the OLD config and silently
  discards the staged source change (it happened here — the first
  repoint vanished). When changing service config, apply it in the same
  breath (`railway-agent` can `commitStagedChanges`), and read the
  config back AFTER the next deploy, not before.

  **Railway MCP tools** (connected, authenticated as `gravelomatt`):
  `list-deployments` / `get-service-config` / `get-logs` for the truth,
  `set-variables` to change env vars (note: triggers a deploy unless
  `skipDeploys`), `railway-agent` for anything the direct tools can't
  do (source changes, staged-change commits). `redeploy` reuses the
  existing snapshot — it is NOT a way to ship a commit. `DEPLOY_NUDGE`
  is a leftover from the pre-app era; it's read by nothing and can be
  deleted whenever.

  The old browser procedure, kept ONLY for archaeology (it applied to
  the template-mirror setup that no longer exists):
  1. Push to GitHub first, and confirm it landed:
     `git -c http.proxy= -c https.proxy= ls-remote origin main`
     (the sandbox proxy blocks `api.github.com`, hence the `-c` flags).
  2. Railway → service → **Settings → Upstream Repo → Check for
     updates**. The first click almost always reports "You're on the
     latest version of this repository" even when it is not — that
     message is stale, not an answer. Ignore it.
  3. Go to the **Deployments** tab. Within a couple of minutes an
     **"Update available"** badge appears at the top left of the canvas.
     Click it → **Yes**. The build starts ~2–5 minutes later.
  4. Verify by reading the deployment title on the Deployments tab and
     matching it against the commit subject. Then verify by *payload* —
     `/soil` in the browser, not `/health`, which returns ok on any
     version. A click appearing to succeed proves nothing; a stale
     accessibility ref once made an Update click silently miss.

  A **service variable change also pulls the latest commit.** Editing any
  variable and hitting **Deploy** rebuilds from GitHub HEAD, so it is both
  a working fallback when the Update badge will not appear and a trap:
  a variable tweak can quietly ship every unshipped commit with it. On
  4 Aug 2026 setting `CLOUDS_WX_LOC` shipped the ECONet commit as a side
  effect. Never assume a variable change is isolated — check what commit
  went out with it.

- **Daily morning update** runs as a scheduled Claude task, ~6:47am ET
  every day (`trig_012nabCYGc56b1bwQwcjKUxg`). Push only, no email —
  Matt's call: he does not want a notification per rating, this note
  replaces that. Two parts, feedback first:
  1. **Rider feedback** — new ratings in the last 24h quoted verbatim
     (the `note` field carries the most signal), running totals per soil
     class, and how far each class is from the 30–50 observation bar. It
     recommends nothing below that bar and says so plainly. Untrusted
     `known_crew = no` rows are reported separately, never analysed.
  2. **Rain cross-check** — CoCoRaHS vs RAWS vs forecast per trail,
     flagging only disagreements over 0.25 in and gauges that have gone
     quiet. CoCoRaHS is used here and nowhere else; it is the
     independent check on the sources that do feed the score.
  It replaced a weekly Monday check-in — calibration thresholds move too
  slowly to need their own task, and one morning note beats two pings.
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

# 3. actually load the page (needs: npm i playwright)
node smoke-test.mjs
```

**`node --check` is not enough.** The score model runs under
`"use strict"`, so an undeclared variable is a clean parse and a
runtime explosion. That exact bug shipped once: removing the old
drying loop took its `var k` with it, the freeze/thaw check below
still used `k`, and every card on the live site read "Couldn't load
conditions. k is not defined". `smoke-test.mjs` loads `index.html` in
a headless browser against a synthetic Open-Meteo response and fails
on any page error or unrendered card. Set `NOW_HOUR` to move around
the drying curve — 92 lands in a wet spell and exercises the recovery
branch that a dry forecast never reaches.

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
| Rain gauge scoring radius | `var WX_MAX_MI` (tier 1), `var WX_TIER2_MI` (fallback) |
| Rain gauge warning radius | `var WX_WATCH_MI` |
| Soil probes we don't believe | `var SOIL_PROBE_BLOCK` |
| Degraded-source line in the footer | `showDegraded` / `id="da-degraded"` |

---

## Task: edit the trail list

```js
{ name: "Bent Creek", place: "Pisgah NF, NC", lat: 35.4919, lon: -82.6285, soil: "clay", exposure: "shaded" }
```

- `soil`: `clay` | `clayrock` | `loam` | `blend` | `sandy` | `rocky` —
  listed wettest-holding to best-draining. `clayrock` is clay with heavy
  rock through it, `blend` is brown dirt, clay and rock together. Both
  were added 5 Aug 2026 when Matt corrected the labels; don't collapse
  them back into `rocky`.
- `exposure`: `shaded` | `mixed` | `exposed`
- `away: true`: out of state. Not fetched on page load — sits behind the
  **Worth the drive** button, and excluded from the best-bet verdict,
  which answers "where do I ride today" rather than "where could I
  drive". Once asked for it joins the Refresh cycle, and if it's in the
  cache from a previous visit it shows without asking again.
  This exists to keep the page honest about trips nobody is taking.
  Since 4 Aug 2026 the whole local list is ONE Open-Meteo request
  (comma-separated coordinates; the answer is an array in trail order,
  or a bare object for a single coordinate — `loadBatch()` handles
  both). Adding a trail no longer adds a request, but `away: true`
  still applies to anything out of state unless Matt says otherwise.
- Coordinates should point at **where people actually ride**, not the parking lot at the bottom. A trailhead 500ft up gives materially different numbers than the valley floor.

**Resolved 4 Aug 2026:** Pisgah is split into `Pisgah — Lower` (Ranger
Station, 35.2848,-82.7270 from OSM, pinned FLET, Matt's call on the
valley) and `Pisgah — Upper` (Pisgah Inn, 35.4029,-82.7538 from OSM,
BRP mp 408.6). Upper's exposure is `mixed` — **my ridgeline guess, not
Matt's; ask him.** FRYI (5,320ft) sits 1.3 mi from the Inn and carries
an hourly rain gauge, so Upper scores from measured high-country rain
naturally, no pin needed.

Never guess a coordinate. Look it up and say where you got it.

### New spots waiting on Matt (soil + exposure), gauges pre-scouted

Matt named ~15 additions on 4 Aug and said he'd give soil/exposure per
spot; none are in `TRAILS` until he does. Creek gauges surveyed 4 Aug
2026 from the USGS active-IV site inventory (browser query, bBox per
spot) so each trail lands with its gauge already known:

| Spot | Best gauge | Dist | Note |
|---|---|---|---|
| Jarrod's Place (GA) | 02398000 Chattooga R at Summerville | 1.1 mi | excellent; away:true |
| Berm Park (Canton) | 03456991 Pigeon R nr Canton | 1.7 mi | |
| Beech Mountain | 0347927162 Buckeye Cr abv Buckeye Lk | 1.2 mi | below-lake twin 0347927164 exists; use above-lake, unregulated |
| Ride Rock Creek (Zirconia) | 021623957 Big Falls Cr nr Tigerville SC | 3.9 mi | over the state line, same escarpment |
| Stony Fork (Candler) | 0344878100 Hominy Cr | 6.0 mi | already in GAUGES — Stony Fork drains to Hominy, right watershed |
| Mt Mitchell | 03463300 South Toe R nr Celo | 6.5 mi | right side of the mountain |
| Sugar Mountain | 0347927162 Buckeye Cr | 6.4 mi | marginal |
| WildSide (Pigeon Forge) | 03469251 W Prong Little Pigeon nr Gatlinburg | 6.3 mi | away:true |
| Old Fort | 02137727 Catawba R nr Pleasant Gardens | 7.8 mi | marginal; town coords — riding is ~2,700ft, needs a better point from Matt |
| Big Ivy (Barnardsville) | 03453000 Ivy R nr Marshall | 9.2 mi | Beetree Cr is closer at 8.2 but drains the WRONG side of the ridge; Big Ivy drains via Dillingham Cr to the Ivy. Watershed beats distance. |

Green River Game Lands, Bent Creek Gap, Mills River Valley Overlook,
Beacon Park: run the same bBox query when their coordinates are settled
(GRGL's is presumably the Green River itself — verify there's an active
IV gauge). Monthly `med` tables need computing from USGS day-of-year
medians per the existing GAUGES pattern before any of these show
"% of normal".

---

## The water balance

The wetness side of the score is a running store of how much rain is
still in the top of the trail. Each hour: rain adds to it, then it
decays exponentially against the same drying rate the aspect already
uses. `var DECAY` (0.06) sets the speed — roughly two thirds of the
water gone in a day of average drying.

It replaced `hoursSinceRain × drying energy`, which had **no memory**:
the counter reset to zero on any trace, so 0.02" of drizzle wiped a
full day of accumulated drying and cost the score 43 points in a single
hour. Scores sawtoothed — rideable at 4pm, not at 6pm, rideable again
by midnight. On the same forecast the store holds the swing to 26
points, and what remains is the active-rain penalty, which is honest
because it *is* raining that hour.

The soil and exposure multipliers now drive both sides: `wet` scales
how hard the water hurts, `dry` scales how fast the store empties. So
recalibrating those still works exactly as described below.

**`DECAY` is a guess, like the rest of the multipliers** — and as of
4 Aug 2026 there is **no measured quantity available to validate it**.
The plan was to plot the ECONet/USCRN station decay against the store's,
but those sensors do not respond to rain at all (see "The soil sensors
do not measure what the cards imply"). Rider ratings are the only route
left, with creek response as a coarse watershed-scale sanity check.

**Worked example of how the wetness terms actually add up** — Bent Creek
at 19:00 on 4 Aug, 22 hours after 0.92 in fell in four hours:

| term | maths | points |
|---|---|---|
| subsoil 30% (above the 0.27 ceiling) | `(0.30−0.27) × 430 × 0.55` | −8 |
| 0.40 in still in the store | `0.40 × 46 × 0.55` | −10 |
| | | **82 = "good"** |

Both terms are halved by rocky's `wet: 0.55`. With `wet: 1.0` the same
hour reads **69, "soft"** — the constant, not the physics, is deciding
whether the page says go ride. That is the single highest-leverage
number in the model and it has never been checked against anything.
Matt's read (4 Aug) is that half an inch inside a day should not leave a
trail in "good", and his one rating so far agrees in direction: shown
94, verdict −1, "maybe a 90ish."

### Drying time

Because the store only falls between rain, "when does it dry" is a
crossing rather than a threshold the score flickers across. Cards with
no good window today say when the model brings it back —
`GOOD = 72`, held for `HOLD = 3` hours, and the reported hour must be
in daylight, since the crossing often happens overnight and "dries out
2am" is true and useless. `water_in` and `dries_out` ride along in the
ratings payload so a rider's verdict can be matched against both.

## Forecast grading — the loop that needs no riders

Running in-process on the feedback service since 5 Aug 2026: once a day
it asks a question with a measurable answer. *How much rain did
Open-Meteo say fell on each trail, and how much did the nearest gauge
actually catch?*

This exists because the Bent Creek miss on 3 Aug — 0.00 in forecast
against 0.92 in measured 0.8 mi away — was found by hand, after Matt
noticed a card looked wrong. Nobody should have to notice.

- `GET /grade?token=…` — per-trail rollup. `ratio` is the headline:
  forecast inches ÷ measured inches. Above 1 the forecast runs wet here,
  below 1 it runs dry. Sorted driest-first, so the trail the forecast is
  most dangerously optimistic about is the top row.
- `GET /grade?token=…&run=1` — grade immediately instead of waiting.
- `GET /grade.csv?token=…` — every run, for working outside the service.
- Stored at `DATA_DIR/forecast-grade.jsonl`, one line per trail per run.

`missed_hours` / `missed_in` count hours where the gauge caught rain and
the forecast had essentially none — the Bent Creek failure mode, and the
one that hurts, because the score reads dry on a wet trail.
`phantom_hours` is the opposite and matters much less. They are kept
apart deliberately; a single mean error would average the dangerous
failure into the harmless one.

Each row also archives the forward daily forecast (`ahead`), so lead-time
accuracy can be graded later against gauges that have not reported yet.
Nothing consumes that yet — it is there so the data exists when someone
wants to ask whether day 4 of the outlook is worth showing.

**The trail list is read from the live `index.html`**, parsed once a day
by `parseTrails()`. A second copy in the server would drift the first
time Matt adds a spot, and a grader silently scoring the wrong
coordinates is worse than no grader. `server-test.mjs` checks the parser
against the real file, including a bounds check that every coordinate
lands in the region — a regex sliding across entries would otherwise
produce plausible numbers for the wrong trail.

**First reading (5 Aug 2026, ~68 hours, one convective spell).** Small
sample and an unrepresentative pattern, so treat the direction as the
finding and not the magnitudes:

| Trail | Gauge | Forecast | Measured | ratio | missed |
|---|---|---|---|---|---|
| DuPont | GUIN7 1.9 mi | 0.08" | 0.94" | **0.09** | 3h / 0.75" |
| Pisgah — Lower | SMPN7 1.6 mi | 0.47" | 2.12" | **0.22** | 7h / 1.77" |
| Bent Creek | 0246CA 0.8 mi | 0.39" | 0.98" | **0.40** | 4h / 0.92" |
| North Mills River | FLET 5.5 mi | 0.33" | 0.28" | 1.18 | 2h / 0.14" |
| Pisgah — Upper | FRYI 1.3 mi | 1.70" | 0.91" | **1.87** | 1h / 0.13" |

Four of five run dry, two of them by four to ten times. Open-Meteo saw
**9%** of the rain that fell at DuPont. It is not a bias that can be
corrected with a constant either — at Pisgah Upper, 1.3 miles from a
gauge, it forecast nearly double. That is what a ~10 km grid does with
2-mile convective cells: it puts roughly the right regional total in
roughly the wrong places.

The consequence worth acting on: the four trails with a gauge inside
`WX_MAX_MI` are protected, because measured rain replaces the forecast.
**Ride Kanuga, Wilson Creek and Hatley Pointe are not** — they score
from a forecast that, in this weather, saw a fraction of the real rain.
Widening `WX_MAX_MI`, or promoting the tier-2 watch gauge to a scoring
input when it disagrees this hard, is now a change with evidence behind
it. Wait for a fortnight and a drier spell before deciding how far.

**What to do with it after ~2 weeks:** trails with a `ratio` well under 1
need either a wider `WX_MAX_MI`, a closer gauge, or less trust in the
forecast component. That is the first model change with evidence behind
it rather than judgment.

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

### What a rating carries (v4, 5 Aug 2026)

The form is clickable end to end with one free-text field kept for
whatever the chips do not cover.

- **`rode_hours_ago`** and **`rode_at`** — ride time in hours, not
  "earlier today". Everything model-side in the row is snapshotted at
  *that* hour via `m.stateAt()`, so a rating logged at 8pm about a 9am
  ride is filed against 9am conditions. Before v4 it was filed against
  8pm, which labelled the wrong weather and made the row worse than
  useless. `shown_score` is still the number that was on screen when they
  tapped, because that is what the verdict was a verdict on;
  **`rode_score` is the one to fit against.**
- **`surface`** — multi-select, pipe-joined: tacky, dusty, greasy,
  puddles, soft, rutting, hardpack. Carries what a single number cannot:
  "wet and grippy" and "wet and rutting" score identically and mean
  opposite things.
- **`others_should`** — go / light / avoid. Deliberately separate from
  the score. Matt rated Bent Creek "90ish" on a morning it had taken
  0.92 in overnight, and also said half an inch means a trail is not in
  shape to ride. Both can be true: it rode well *and* people should have
  stayed off. The score cannot hold both, so this field holds the second.
- **`section`** — optional free text. Big areas ride differently end to
  end and one score per area is the model's coarsest assumption.

`rating-test.mjs` drives the real widget in a browser and asserts the
payload. The rating form is the only place ground truth enters this
project; a silent break costs data nobody can recover, because you
cannot go back and re-ride last Tuesday.

### Working from a ratings CSV

Matt exports the `reports` tab from the calibration sheet. Columns include `verdict`, `actual`, `when`, `shown_score`, `shown_state`, `soil`, `exposure`, `soil_moisture`, `soil_temp_f`, `rain_24h`, `rain_72h`, `hours_since_rain`, `wet_mult`, `dry_mult`, `known_crew`.

- **`verdict` is the direction the score should move.** `+1` = the page scored it too low, it rode better. `-1` = scored too high, it rode worse. `0` = about right.
- **Filter to `known_crew = yes`.** The endpoint is public; unlisted names are untrusted.
- **Respect `when`.** A `yesterday` rating must be matched against yesterday's model state, not the snapshot in the row. Either drop those or handle them explicitly — don't silently treat them as current.
- **Group by soil class, not by trail.** Of the ten areas: four `clay`
  (Bent Creek, DuPont, Kanuga, Windrock), two `blend` (North Mills,
  Pisgah Upper), two `loam` (Hatley Pointe, Snowshoe), one `clayrock`
  (Pisgah Lower), one `rocky` (Wilson Creek).
- **Ratings from before 5 Aug 2026 carry the OLD soil label.** The CSV
  stores the class as it stood when the rating was filed, and seven of
  the ten areas were mislabelled `rocky` until that date. Group historic
  rows by trail and re-map to the current class before pooling by soil,
  or the pools mix two different meanings of `rocky`.
- **Need roughly 30–50 observations per soil class** before moving a multiplier. Below that, report the trend and change nothing. Note that the 5 Aug 2026 relabel split the pool across six classes instead of three, so each class now fills more slowly — `clayrock` and `rocky` have one area each feeding them.

Method: plot verdict against `soil_moisture` and `rain_24h` per soil class, find where the model reads consistently high or low, adjust. **This is a scatter plot and an afternoon. Do not reach for machine learning.** With this sample size a fitted model would be noise with a confidence interval.

Always show Matt the before/after numbers and the reasoning. He has ground truth you don't — he's ridden these in every condition they get into.

---

## Data sources

Open-Meteo drives the score. Everything else is **observed** data shown
next to the score, and deliberately does **not** feed into it.

| Source | Key? | Called from | What it gives |
|---|---|---|---|
| Open-Meteo | no | the page | forecast weather + modelled soil moisture — the score's backbone |
| NWS `api.weather.gov` | no | the page | watches/warnings/advisories per trail |
| USGS Water Services | no | the page | creek discharge/stage + 7-day trend |
| CLOUDS — ECONet + USCRN | **yes** | Railway `/soil` → `stations` | measured soil moisture and temperature |
| CLOUDS — RAWS | **yes** | Railway `/soil` → `wx` | **measured hourly rain** + evapotranspiration |

### Measured rain feeds the score

Rain is the one input where forecast error really hurts — whether it
fell *here* is the whole question — so where a RAWS gauge is within
`WX_MAX_MI` (3.5 miles) the model uses its measured hourly rain instead
of the forecast. Forecast fills any hour the gauge missed, and every
future hour, because you cannot measure the future. If a station drops
out the page reverts to forecast with no visible failure.

This is the one measured source that **does** change the score, and it
changes it by improving an input rather than by retuning a constant —
no recalibration needed. Consequences to know about:

- `p24`, `p72`, `hsr` and the water-balance store are all computed from
  the blended series, so the facts row and the ratings payload reflect
  measured rain too.
- The gauges arrive after the first render, so trails already built from
  forecast rain get **rebuilt** when `/soil` lands (see the
  `Promise.all` in `loadAll`). Expect one re-render on load.
- The card names the gauge, the hours used, and the forecast figure
  beside the measured one, so a disagreement is visible rather than
  silently baked in.

**Evapotranspiration is shown but does not drive the decay yet.** RAWS
carries Penman-Monteith ET, which is the physically correct sink term
for a water balance in inches and would be better than the hand-rolled
`dryingRate()`. It is not wired in because swapping it would introduce
a new unknown scaling constant with nothing to fit it against, right
after replacing the drying heuristic. Fit it first: ET is on the card
and in the payload, so compare it against the store's decay over a few
storms before letting it drive anything.

**Units differ between networks.** ECONet reports volumetric water as a
fraction (0.44), USCRN as a percentage (24.3). `normaliseMoisture()` in
`server.js` divides anything above 1.5 by 100 — soil never holds more
than about 0.6 by volume, so the test is safe. Any new soil network
needs checking against this.

Station selection is unchanged: closest wins, ties inside 2 miles break
downhill. With USCRN in the pool, **Bent Creek now reads from Asheville
8 SSW at 0.8 miles** instead of FLET at 6.

`CLOUDS_LOC` and `CLOUDS_WX_LOC` env vars control which networks and
counties are queried, if the sensor set needs widening.

**The Bent Creek miss, 4 Aug 2026 — read this before trusting a score.**
Matt said it looked like it had rained at Bent Creek. It had: the USCRN
station 0.8 mi away measured 0.92" over four hours the previous evening
(0.39 / 0.08 / 0.13 / 0.32 hourly) and **Open-Meteo had 0.00" for the
entire day** — not underestimated, missed. Hominy Creek confirmed it
independently, 39 → 77 cfs in three hours. The card read 94 and hero
dirt because Bent Creek had no gauge inside `WX_MAX_MI` and the water
balance was running on a forecast that said it never rained.

Two fixes went in, and two lessons worth keeping:

1. **USCRN now feeds the rain series, not just the soil series.** Its
   rain gauge was being pulled past and ignored while the same station
   supplied soil moisture. After the fix Bent Creek reads 82 / Good,
   0.92" in 24h, dry for 18h. *When a station is already in hand, check
   every variable it carries before reaching for another source.*
2. **Creek trend comes from instantaneous readings against 12 hours
   back, not daily means.** A daily mean averaged a near-doubling into
   "steady". The card now prints the 12-hour change and says outright,
   above 40%, that rain fell in the watershed whether the forecast
   caught it or not — the only warning a rider gets when the forecast
   misses. *An aggregate that hides the event is worse than no
   aggregate.*

The general lesson: a trail with no gauge inside the threshold has
**no defence against a forecast miss**. Ride Kanuga and Hatley Pointe
are still in that position. The daily cross-check exists to catch this,
but it ran a day behind Matt's own eyes.

**Verified live, 4 Aug 2026.** Bent Creek reads USCRN Asheville 8 SSW at
1 mi (24% water, against FLET's 44% six miles out). Pisgah Proper's
gauge measured 0.98" over 72h where the forecast had 0.50"; DuPont's
measured 0.73" against 0.28" forecast. The forecast was under-reporting
rain by roughly half at both — that gap is the justification for the
whole exercise, and it is worth re-checking after each storm. Eight
RAWS gauges are in range statewide but only Pisgah and DuPont fall
inside `WX_MAX_MI`; Ride Kanuga's nearest is Guion Farm at 6.1 mi and
correctly gets none.

**Why measured data doesn't change the score.** Creek level and station
soil moisture are better signals than the model in principle, but
weighting them is a calibration decision — it needs rider ratings and
Matt's ground truth, not a guess. Wiring them into the score without
that would be exactly the mistake the ratings system exists to prevent.
Revisit once a soil class clears the 30–50 observation threshold.

**Not every probe is telling the truth.** `SOIL_PROBE_BLOCK` in
`index.html` drops a station's moisture sensor while keeping its rain
gauge. FLET is in there: on 5 Aug 2026 it read 44% volumetric water at
both depths having caught 0.26" of rain in 72 hours, while 0246CA — which
caught 0.93" — read 24%, and every forest or fire station in range sat at
24–29%. It is an irrigated horticultural research farm. WAYN (40%) and
UNCA (49%) fit the same pattern and are named in the comment but not
blocked, because nothing is currently pinned near enough for them to
matter. Check a probe against its own rain gauge before trusting it: a
station reading near saturation on a quarter inch of August rain is
measuring somebody's sprinkler.

The cost of blocking FLET is that Pisgah — Lower lost its only
valley-elevation station and now falls to FRYI at 8 mi and 5,320 ft,
against a trailhead near 2,200. Its soil row is regional, not local. Its
rain is unaffected — SMPN7 is 1.6 mi out and scores tier 1.

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

**Never inspect `/soil` through `WebFetch`.** It is ~70 KB and WebFetch
silently truncates it, so what comes back is a well-formed-looking
*prefix* of the payload. Read it in the browser instead, on the live page
tab, and compute the summary in the page:

```js
const j = await (await fetch(ENDPOINT + "/soil?probe=" + Math.random())).json();
({ wxCount: j.wx.length, wxIds: j.wx.map(w => w.id).sort(),
   stationCount: j.stations.length, dropped: j.dropped || null })
```

This cost an hour on 4 Aug 2026 and produced a confidently wrong
diagnosis. After widening the rain query to `type=RAWS,USCRN,ECONET`
across fourteen counties, WebFetch showed 17 stations ending at `NCVN7`,
with `SMPN7` — the gauge 1.6 miles from Pisgah, the most valuable one in
the set — missing. The alphabetical cutoff made it look exactly like an
upstream response cap, and it was written up as one. The payload was
complete: 24 rain gauges, 48 soil stations, `SMPN7` present the whole
time. **CLOUDS was not truncating anything. There is no known CLOUDS
response cap.** Do not repeat that claim without evidence from a full
payload read.

The transferable version: **when a reading is missing, rule out the
instrument before concluding something about the thing measured.** The
CoCoRaHS survey failed this way too — but there the cap was real and
upstream, which is exactly why the same shape of evidence pointed the
wrong way the second time. A truncated view and a truncated source look
identical from the truncated end.

`locVariants()` in `server.js` splits any `type=A,B,C` selector into one
request per network and merges, for both feeds. It was written for the
imaginary cap and is kept for a real reason: one network being down or
slow no longer takes the others with it. It is not a truncation guard.

`/soil` carries a `dropped` array when a station has readings but no
coordinates (so it cannot be matched to a trail) or when a whole network
query throws. Absent or empty `dropped` plus a plausible `wx.length` is
the check to run after any change to `CLOUDS_LOC` or `CLOUDS_WX_LOC`. As
of 4 Aug 2026 it has never been non-empty.

**Cold `/soil` is slow; warm `/soil` is not.** The payload now costs five
upstream CLOUDS calls (three soil networks split by `locVariants`, the
rain feed, plus CoCoRaHS) so the first request after a deploy can take
long enough to time out a client — it did twice on 4 Aug. Once
`soilCache` fills it serves in ~10ms and the page paints measured scores
about a second after load, with no visible forecast-only flash. So don't
diagnose a slow `/soil` right after shipping: request it once to warm
it, then measure. If it ever needs fixing properly, warm the cache on
boot rather than making the first visitor pay.
**Station matching: closest wins, ties break downhill.** Matt's call
(3 Aug 2026). Distance decides it; where two stations are within
`STATION_TIE_MI` (2 miles) of each other they count as equally near and
the lower-elevation one takes it. Station elevation comes from CLOUDS,
in feet. Set `station: "GRGL"` on a trail to pin one and bypass the
choosing entirely.

The tiebreak exists because DuPont sits 16.1 miles from *both* FLET
(2,067ft, 0.44 m³/m³) and FRYI (5,320ft, 0.25) — without a rule, which
of two wildly different numbers it showed came down to iteration order.
Current picks: Bent Creek, North Mills River, DuPont and Ride Kanuga →
FLET; Wilson Creek → MORG; Hatley Pointe → BURN.

**Pisgah Proper is pinned to FLET** via `station: "FLET"`. Distance
alone would give it Frying Pan Mountain (8 mi, 5,320ft) over FLET
(13.7 mi, 2,067ft), but Matt's read is that most of the riding —
Black Mountain, Clawhammer, Bennett Gap — sits nearer the valley than
the summit, so the lower sensor speaks for more of it. This is the
kind of call to take from him rather than the map.

### The soil sensors do not measure what the cards imply (4 Aug 2026)

Investigated after Matt questioned Bent Creek's 82. Three findings —
**two hold, one was my error and is retracted below.** The two that hold
still weaken the measured-soil story considerably. **Do not treat station
soil moisture as ground truth until they are resolved.**

**1. `soilmoist` and `soilmoist20cm` are the same sensor.** Queried
separately for `0246CA`, CLOUDS returns byte-identical values under both
names (24.9, 25.6 at the same timestamps). It aliases one probe to both
variable names. So we have ONE depth, we do not know which, and the
card's "at 20cm" label is inferred from which key came back non-null —
it is not a claim CLOUDS supports. `normaliseMoisture` and the
surface/20cm branch in `measuredHtml` are both built on this assumption.

**2. ~~FLET is flatlined.~~ WRONG — retracted the same evening.** I saw
FLET hold exactly `0.44` for thirty hours, concluded the probe was stuck,
shipped a detector that nulled any value not moving across twelve hourly
readings, and it flagged **fourteen** ECONet stations at once — including
FRYI, which Pisgah — Upper depends on. Fourteen simultaneous failures is
not a plausible reading of the evidence, and checking a six-day window
settled it: FLET reports two distinct values (0.44, 0.45), FRYI two
(0.25, 0.26), BURN seven (0.26–0.31). **ECONet publishes soil moisture
to two decimal places, and soil moisture is slow.** Coarse precision on
a slowly-drifting quantity looks exactly like a dead sensor over a short
window. The sensors are fine and the irrigated-research-farm explanation
for FLET's wetness stands.

Reverted. Staleness is now judged on the reading's own **timestamp**
(`STALE_HOURS = 6`), which is the question actually being asked and
cannot be fooled by precision. `/soil` reports `ageHours` per station
and lists genuinely stale ones in `stale`.

The lesson, which is the same one as the WebFetch truncation earlier the
same evening: **when a detector fires on many subjects at once, suspect
the detector.** Both mistakes had the identical shape — a confident
causal story built on a window too small to distinguish two explanations,
written up as fact before being checked against a wider one.

**3. The sensor cannot see the rain that decides a trail.** 0.92 in
fell at `0246CA` between 18:00 and 21:00 on 3 Aug. The station's soil
moisture went 26.1 → 25.3 → 24.8 straight through it and kept falling.
It never rose at all. It also oscillates daily — ~23.9 before dawn to
~26.5 mid-afternoon, every day, rain or not — which is the signature of
a temperature-sensitive dielectric reading, not moisture. Whatever
depth it sits at, it is deep enough that an inch of rain in the top
couple of inches is invisible to it.

Consequence: **the calibration check promised above — "plot the
station's decay against the store's and see whether they fall at the
same rate" — cannot be done with these sensors.** They do not respond
to storms. `DECAY` remains unvalidated and there is currently no
measured quantity available that can validate it. The honest paths are
rider ratings, or creek response as a coarse watershed-scale proxy.

**Caveat on FLET (superseded in part by the flatline finding above).**
Mountain Horticultural Crops Research Station is a
working agricultural research station and reads much wetter than nearby
sites (0.44 m³/m³ against 0.25–0.30 at Frying Pan and Green River).
Some of that is likely irrigation, not weather. Trust its trend more
than its absolute number. GRGL (Green River Game Land, 2,080ft) is
unirrigated woodland at effectively the same elevation and loses to
FLET by half a mile on the southern trails — pinning it on DuPont and
Ride Kanuga is the fallback if FLET's numbers look wrong in practice.

The station line prints its elevation so a reader can judge whether it
speaks for where they ride. Splitting Pisgah into a low and a high
entry would still be the cleaner fix — it would let the high country
use Frying Pan Mountain and the valley use FLET, instead of one pin
standing in for a 3,000ft spread. Needs Matt.

### Interpreting the numbers

`creekMeaning()` and `stationMeaning()` turn the readings into plain
English under **Measured nearby**. Creek flow is read against the
seasonal normal (ground full vs shedding water), station soil against
the model's 0.11–0.27 tacky band, and when the two disagree by 8 points
or more the card says so outright — that gap is the reason for
measuring anything. Soil temperature calls out freeze, slow drying and
fast drying. Keep the copy in the brand voice: short sentences, plain,
dry, no marketing words.

## Sensor inventory (surveyed 4 Aug 2026)

The CLOUDS key already reaches **16 networks**, not just ECONet. Change
`loc` and the same key returns far closer sensors. All of the below was
verified live through `/soil/raw`, not inferred.

### Verified, no new access needed

| Sensor | Network | Distance | Elev | What it has |
|---|---|---|---|---|
| **Asheville 8 SSW** `0246CA` | USCRN | **0.82 mi from Bent Creek** | 2,151ft | soil moisture + temp, research grade |
| Asheville 13 S `0255BC` | USCRN | 5.6 mi from N Mills River | 2,103ft | soil temp; moisture sensor looked down |
| **Guion Farm** `GUIN7` | RAWS | **1.86 mi from DuPont** | 2,730ft | measured precip, RH, temp, solar, **Penman-Monteith ET** |
| **NC Fire #2** `SMPN7` | RAWS | **1.63 mi from Pisgah Proper** | 2,671ft | same as above |
| Davidson River `DARN7` | RAWS | 5.2 mi from Pisgah | 3,350ft | same as above |
| 7 Mile Ridge `MAHN7` | RAWS | 13.1 mi from Hatley Pointe | 2,146ft | same as above |
| `TR-066` Pisgah Forest alluvium | USGS GW | **0.1 mi from Pisgah Proper** | — | water-table depth, keyless |

Three things this changes, in order of value:

1. **USCRN Asheville 8 SSW is 0.8 miles from Bent Creek** and reads
   24–26% soil moisture. FLET, six miles off, reads 44%. USCRN is a
   climate-reference site with triplicate sensors and no irrigation —
   this is strong evidence the FLET number is wrong for trail purposes,
   not just different. Bent Creek should use USCRN.
2. **RAWS gives measured rain and measured drying energy** ~2 miles
   from Pisgah and DuPont. The water balance currently runs on
   *forecast* precipitation and a hand-rolled `dryingRate()`. RAWS
   carries `precip` and `evaptrans_pm` (Penman-Monteith
   evapotranspiration) hourly — the physically correct drying term,
   measured. Swapping those two inputs is probably a bigger accuracy
   win than any multiplier retune.
3. RAWS has **no soil moisture**, so it complements ECONet/USCRN rather
   than replacing them. Units differ across networks: ECONet reports
   m³/m³ (0.44), USCRN reports percent (24.3). **Normalise on ingest**
   or the numbers are off by 100×.

### Would need new access

- **Bent Creek Experimental Forest** (USFS Southern Research Station) —
  a long-term research forest *at* Bent Creek. Most promising ask; would
  need an email.
- **Coweeta Hydrologic Laboratory** (USFS, Otto NC) — decades of soil
  moisture and streamflow, ~60 mi southwest. Public but not an API.
- **Synoptic Data / MesoWest** — aggregates RAWS plus CWOP personal
  stations. **Checked 4 Aug 2026: no usable free tier.** Their Open
  Access programme is restricted to students and faculty at accredited
  US institutions with a .edu address and explicitly excludes commercial
  entities, so Altar does not qualify. Remaining options are a 14-day
  trial and then commercial pricing, which is quote-only. Tokens are
  managed at customer.synopticdata.com/credentials. Deprioritise.
- **CoCoRaHS — WIRED IN 4 Aug 2026** (`cocoSeries()` in server.js →
  `coco` block on `/soil` → `rain·d` row via `nearestCoco()`; freshest
  reporter wins, then nearest; "T" = trace = 0.005; display-only,
  never scores). The survey below is what justified it. — `type=COCORAHS`. Volunteer
  rain-gauge network. Surveyed 4 Aug 2026 using
  `/soil/raw?...&compact=1&near=LAT,LON`. Nearest **currently-reporting**
  observer per trail:

  | Trail | Nearest reporting | Verdict |
  |---|---|---|
  | Ride Kanuga | NC-HN-33 Hendersonville 5.1 WSW — **0.8 mi**, 2,184ft, to 08-02 | **best case on the list** — Kanuga has no gauge inside the page's 3.5 mi threshold |
  | Pisgah Proper | NC-TR-23 Pisgah Forest 2.5 N — 1.8 mi, 2,528ft, to 08-03 | no gain; RAWS SMPN7 is 1.6 mi and hourly |
  | Bent Creek | NC-BC-145 Avery Creek 0.9 ESE — 4.6 mi, 2,123ft, to 08-02 | usable; two closer observers have lapsed |
  | DuPont | NC-TR-16 Brevard 0.6 SSE — 6.4 mi, to 08-02 | no gain; Guion Farm is 1.9 mi and hourly |
  | Hatley Pointe | NC-MS-19 Marshall 15.1 NNE — **7.2 mi**, 3,105ft, to 08-03 | best that exists near it, and the elevation suits the bike park |
  | N Mills River | NC-HN-38 Etowah 1.1 WNW — 7.3 mi, to 08-03 | marginal |
  | Wilson Creek | NC-CD-32 Patterson 1.6 SW — 10.2 mi, 1,371ft, to 08-03 | marginal |

  **Always pick the most recent reporter, never the nearest.** These are
  volunteers with a tube in the garden and they lapse. Kanuga's *closest*
  observer, NC-HN-14 at 0.4 mi, is flagged `data_active = Yes` but has not
  reported since 28 June. Bent Creek's closest two, at 2.9 and 4.1 mi,
  stopped on 30 and 27 July. Selecting on distance alone would put
  five-week-old rain on a card as though it were current.

  Also **daily and manual**, so it cannot feed the hourly water balance —
  use it as a daily total to cross-check, which is what the morning task
  below does.

  **Never read CoCoRaHS metadata without `compact=1`.** One county exceeds
  the response cap, and a truncated body fails `JSON.parse`. An earlier
  survey here scoped queries by city to dodge the cap, hit it anyway, and
  the catch block silently returned an empty list — so the results looked
  complete but were built on partial data, and reported Kanuga's nearest
  observer as 5.3 mi when it is 0.8 mi. If a station query comes back
  empty or thin, check the response length before believing it.
- **Crew-owned stations** — Tempest and Ambient Weather both have APIs.
  No soil moisture, but on-trail rain gauges from riders would beat
  forecast rain. Worth asking the crew.
- NC DOT RWIS road-weather (subsurface temp), NC DEQ groundwater network.

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
- **Whether a close gauge should be trusted to speak for a trail during
  convective season.** Resolved the "is it real" half on 4 Aug 2026; the
  design question that replaced it is sharper and still Matt's.

  SMPN7 reported 1.22 inches in the 17:00 hour and took Pisgah from the
  high 80s to 38 (Lower, after the split). **The rain was real.** The
  hourly shape is a textbook storm — 0.01, 0.09, **1.22**, 0.13 — and a
  stuck tipping bucket dumping its backlog would be an isolated spike
  with nothing after it, not a ramp and a tail. RUTN7 independently ran
  0.03, 0.03, **0.43**, 0.07: same profile, same hour, different network
  county. Two stations, two storm shapes. Not an artifact.

  **But the creek never moved.** Davidson River, 1.4 mi from the trail
  anchor and draining the ground SMPN7 sits on, ran 44.4 → 43.0 → 44.4
  across the two hours after the burst: 3%, which is rounding noise at
  that flow. Hominy Creek declined steadily through the same window.
  Compare Bent Creek on 3 Aug, where 0.92 inches sent Hominy 39 → 77 cfs
  in three hours.

  Two things explain the gap and both matter. The watershed is genuinely
  dry — 62% of the August normal — and dry soil swallows the first inch
  rather than shedding it, which is the same physics the score already
  encodes when it says "the watershed is dry, so trails shed what falls
  on them." And the cell was tiny: DARN7 at 4.6 mi caught 0.00, FRYI at
  7 mi caught 0.00 in that hour. A cell a couple of miles across can sit
  on the gauge and miss the trail, or sit on the trail and miss the
  gauge, and nothing in the data distinguishes those.

  So the real question is not "cap the hour" — capping a correct
  measurement is the wrong fix. It is: **in convective season, should an
  extreme localised reading from a single gauge inside `WX_MAX_MI` be
  scored as fact, or flagged as uncertain?** Options, roughly ascending
  in ambition: leave it (current behaviour, errs wet, defensible); say
  so on the card when one gauge inside the threshold disagrees sharply
  with every other gauge within ~10 mi, letting the rider judge; or let
  a flat creek downgrade confidence in a gauge spike, which is the
  physically honest version and also the one that needs calibration data
  before it can be trusted. **Matt's call.** Note that Bent Creek was
  trustworthy precisely *because* Hominy confirmed it — the asymmetry is
  that a creek rise corroborates rain, while a flat creek during drought
  proves very little.

## Report honestly

If a deploy fails, say what failed and what you saw. If a calibration sample is too small to justify a change, say so and change nothing. If you're unsure whether something worked, fetch the live URL and look — don't infer success from an exit code.
