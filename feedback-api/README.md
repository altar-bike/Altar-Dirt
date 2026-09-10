# Feedback service

Tiny zero-dependency Node server that collects rider ratings from the trail
conditions page. Runs on Railway. `server.js` is the whole thing.

## How the pieces connect

1. The page (`index.html`, hosted on GitHub Pages) shows a "Rate this call"
   widget when `feedbackEndpoint` in its settings block points here **and**
   the visitor's URL contains `?crew=1`.
2. Ratings arrive as `POST /` and are appended to `ratings.jsonl` on the
   Railway volume. Each row carries the exact model inputs behind the score
   the rider saw.
3. `GET /export.csv?token=…` returns everything as CSV — this is what Claude
   reads for the weekly calibration check-in.

## Railway configuration

- **Root directory:** `feedback-api`
- **Volume:** mount at `/data`. Holds `ratings.jsonl` (the ratings),
  `forecast-grade.jsonl` (the daily forecast grades) and, since 10 Sep
  2026, `clouds-store.json` — everything fetched from CLOUDS plus the
  month's quota ledger, so a deploy boots warm instead of re-pulling
  three days of rain and starting the month's count from zero.
- **Environment variables:**
  - `DATA_DIR=/data`
  - `EXPORT_TOKEN` — long random string; protects the CSV export and
    the diagnostic endpoints (`/soil/raw`, `/grade`)
  - `CREW` — comma-separated names to trust, case-insensitive
    (e.g. `Matt, Sarah`). Sets the `known_crew` column; the calibration
    workflow only uses `known_crew = yes` rows.
  - `CLOUDS_HASH` — the NC State CLOUDS API key. Without it `/soil`
    returns empty lists and the page scores from forecast alone.
  - `CLOUDS_REQ_BUDGET` / `CLOUDS_DP_BUDGET` — monthly ceilings for
    CLOUDS requests and datapoints (defaults 1700 / 250000; the public
    tier allows 2,000 / 300,000). The service paces itself to these —
    see below. Never set the request budget above 2,000.
  - `CLOUDS_LOC`, `CLOUDS_WX_LOC`, `CLOUDS_COCO_LOC` — station selectors
    for the soil, rain-gauge and CoCoRaHS feeds. A value here WINS over
    the default in `server.js`; the boot log says which are set.
  - `SOIL_TTL_MIN`, `SOIL_FAIL_TTL_MIN`, `COCO_TTL_MIN`,
    `WX_MIN_INTERVAL_MIN` — cache lifetimes in minutes (defaults 60 /
    5 / 360 / 20). The pacer floors all of them.

## Endpoints

| Method & path | What it does |
|---|---|
| `POST /` | Store ratings. Body is a JSON array (the page sends `text/plain`). Returns 204. |
| `GET /export.csv?token=…` | Full CSV export, deduplicated. 403 without the right token. |
| `GET /health` | `{ ok: true, ratings: N }` — always 200 while the process is up. |
| `GET /status` | Is the data any good? 200 when the soil payload is under 6h old and the rain gauges were reached inside 12h, otherwise 503 with `problems`. Also `warnings` (CoCoRaHS quiet, budget pause, failed-round streak), the month's `budget` ledger, `nextRound`, the last eight upstream errors. Point a free uptime monitor here. |
| `GET /soil` | Measured data for the page: `stations` (soil), `wx` (hourly rain gauges, 72h), `coco` (CoCoRaHS daily), plus `dropped` / `stale` / `degraded` diagnostics. Served from the store; the store refreshes on the budget's cadence. |
| `GET /soil/raw?token=…` | Token-gated view of a raw CLOUDS response, for shape-checking. Counts against the budget. |
| `GET /grade?token=…` | Forecast-vs-gauge rollup per trail (`&run=1` grades now). `/grade.csv` for every run. |

## Staying under the CLOUDS caps

The public CLOUDS tier allows **2,000 requests and 300,000 datapoints a
month**, reset on the 1st. One refresh round is five requests (two soil
networks, three rain networks) plus CoCoRaHS every six hours and a
metadata lookup about weekly, so an hourly refresh would blow the
request cap. The service therefore keeps a **ledger** of the month's
spend in `clouds-store.json` and **paces** rounds so the remaining
budget lasts until the month ends — one round every ~2.2 hours at the
default budget, run by a keep-warm tick whether or not anyone is
visiting. A ledger that starts mid-month budgets only the fraction of
the month that is left, since it cannot know what was spent before it. A CLOUDS reply that names the quota pauses upstream for a
day at a time; the stored data keeps serving throughout. Watch the
`clouds round:` and `clouds budget:` lines in the Railway deploy log,
or `GET /status`.

Light abuse protection: 512KB body cap, 50 ratings per request, 60 requests
per IP per hour, unknown fields dropped, string fields capped, CSV cells
neutralised against formula injection. The endpoint is public by design —
trust comes from the `known_crew` filter, not from hiding the URL.
