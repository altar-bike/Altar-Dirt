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
- **Volume:** mount at `/data`
- **Environment variables:**
  - `DATA_DIR=/data`
  - `EXPORT_TOKEN` — long random string; protects the CSV export
  - `CREW` — comma-separated names to trust, case-insensitive
    (e.g. `Matt, Sarah`). Sets the `known_crew` column; the calibration
    workflow only uses `known_crew = yes` rows.

## Endpoints

| Method & path | What it does |
|---|---|
| `POST /` | Store ratings. Body is a JSON array (the page sends `text/plain`). Returns 204. |
| `GET /export.csv?token=…` | Full CSV export, deduplicated. 403 without the right token. |
| `GET /health` | `{ ok: true, ratings: N }` |

Light abuse protection: 512KB body cap, 50 ratings per request, 60 requests
per IP per hour, unknown fields dropped, string fields capped, CSV cells
neutralised against formula injection. The endpoint is public by design —
trust comes from the `known_crew` filter, not from hiding the URL.
