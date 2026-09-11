/* ============================================================
   Altar Cycles — trail conditions feedback service
   Zero-dependency Node server. Receives rider ratings from the
   trail conditions page and stores them as JSON lines on disk.

   Endpoints:
     POST /                → store ratings (body: JSON array, text/plain)
     GET  /export.csv?token=… → CSV of all ratings (EXPORT_TOKEN required)
     GET  /health          → { ok, count }  (always 200 — liveness)
     GET  /status          → freshness of every CLOUDS feed, the month's
                             quota ledger, recent upstream errors.
                             503 when the measured data has gone stale,
                             so a free uptime pinger can raise the alarm.

   Env vars:
     PORT          provided by Railway
     DATA_DIR      where ratings.jsonl lives — set to the volume
                   mount path (e.g. /data). Default: ./data
     EXPORT_TOKEN  required. Without a matching ?token= the export
                   returns 403. Generate something long and random.
     CREW          comma-separated reporter names Matt trusts,
                   case-insensitive ("Matt, Sarah C, Dave").
                   Sets the known_crew column in the export.
     CLOUDS_REQ_BUDGET / CLOUDS_DP_BUDGET
                   monthly ceilings for CLOUDS requests and datapoints
                   (defaults 1700 / 250000 — under the public tier's
                   2,000 / 300,000). See "CLOUDS budget" below.
   ============================================================ */

"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = parseInt(process.env.PORT || "3000", 10);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "ratings.jsonl");
const EXPORT_TOKEN = process.env.EXPORT_TOKEN || "";
const CREW = (process.env.CREW || "")
  .split(",")
  .map(function (s) { return s.trim().toLowerCase(); })
  .filter(Boolean);

const MAX_BODY = 512 * 1024;      // bytes
const MAX_ITEMS = 50;             // ratings per request
const MAX_STR = 400;              // chars per string field

/* Fields we keep, in export order. Everything else is dropped. */
const FIELDS = [
  "sent_at", "trail", "place", "soil", "exposure",
  "shown_score", "shown_state", "verdict", "actual", "when", "note",
  "reporter_name", "reporter_id",
  "soil_moisture", "soil_temp_f", "air_temp_f",
  "rain_24h", "rain_72h", "hours_since_rain", "water_in", "dries_out",
  "wet_mult", "dry_mult", "model_time", "tz_offset_min",
  /* v3: which rain fed the water balance and how far off the forecast
     was — the columns the ET/decay calibration will fit against. Old
     rows read back as empty cells here, which is the truth of them. */
  "rain_source", "rain_source_mi", "rain_measured", "rain_forecast",
  "et_24h", "rain_watch_gap",
  /* 5 Aug 2026: which tier the scoring gauge came from. 1 = inside
     WX_MAX_MI, 2 = the six-mile fallback. Rows written before this date
     read back empty and were all tier 1, since tier 2 did not exist. */
  "rain_source_tier",
  /* v4: the hour they actually rode, and the model state at THAT hour.
     `shown_score` is still the number on screen when they tapped, so the
     verdict stays attached to what it was a verdict on; `rode_score` is
     what to fit against. `others_should` is deliberately separate from
     the score — a trail can ride well and still be one to stay off. */
  "rode_hours_ago", "rode_at", "rode_score", "rode_state",
  "surface", "others_should", "section",
  "lat", "lon", "v"
];
const CSV_HEADER = FIELDS.concat(["known_crew", "received_at"]);

fs.mkdirSync(DATA_DIR, { recursive: true });

/* ------------------------- helpers ------------------------- */

function clean(v) {
  if (v == null) return "";
  if (typeof v === "number") return isFinite(v) ? v : "";
  if (typeof v === "boolean") return v ? 1 : 0;
  return String(v).slice(0, MAX_STR);
}

function sanitize(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const out = {};
  for (const f of FIELDS) out[f] = clean(item[f]);
  if (!out.trail || out.verdict === "") return null;   // minimum viable rating
  out.received_at = new Date().toISOString();
  return out;
}

function csvCell(v) {
  let s = String(v == null ? "" : v);
  /* neutralise spreadsheet formula injection — but leave plain
     numbers (e.g. -82.6285, verdict -1) alone */
  if (/^[=+\-@\t]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
  if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function tokenOk(given) {
  if (!EXPORT_TOKEN || !given) return false;
  const a = Buffer.from(String(given));
  const b = Buffer.from(EXPORT_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readAll() {
  let raw;
  try { raw = fs.readFileSync(DATA_FILE, "utf8"); }
  catch (e) { return []; }
  const rows = [];
  const seen = new Set();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch (e) { continue; }
    /* dedupe: the page retries its offline queue, so the same rating
       can arrive twice */
    const key = r.reporter_id + "|" + r.sent_at + "|" + r.trail;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(r);
  }
  return rows;
}

/* very light per-IP rate limit: 60 posts per rolling hour */
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(function (t) { return now - t < 3600000; });
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 5000) hits.clear();   // memory backstop
  return arr.length > 60;
}

/* ============================================================
   CLOUDS proxy — measured soil moisture from NC State ECONet.

   The CLOUDS key ("hash") must never reach the browser, and the
   CLOUDS host sends no CORS headers, so the page cannot call it
   directly. This endpoint does both jobs: it keeps the key here
   and hands the browser a small, CORS-friendly JSON payload.

   Env:
     CLOUDS_HASH  the hash from api.climate.ncsu.edu. Without it
                  /soil returns an empty station list and the page
                  simply shows no station readings.
     CLOUDS_LOC   soil-station selector; CLOUDS_WX_LOC and
                  CLOUDS_COCO_LOC override the other two feeds the
                  same way. Selector format rules live at the
                  defaults below. A value set as a Railway variable
                  WINS over the code default — which is exactly how
                  a stale variable can silently undo an edit here,
                  so check Railway's variables before editing these.
     SOIL_TTL_MIN / SOIL_FAIL_TTL_MIN / COCO_TTL_MIN
                  cache lifetimes in minutes (defaults 60 / 5 / 360).
                  Env-tunable so a live delta-fetch check can shorten
                  the TTL for a few minutes without a code change.
   ============================================================ */

/* Env-overridable so the harvest path can be run against a stand-in
   upstream in a local check; production never sets it. */
const CLOUDS_URL = process.env.CLOUDS_URL || "https://api.climate.ncsu.edu/data.php";
const CLOUDS_HASH = process.env.CLOUDS_HASH || "";

/* Soil sensors. USCRN is the US Climate Reference Network — research
   grade, and one of its sites sits 0.8 miles from Bent Creek, far
   closer than any ECONet station. Note the units differ between the
   two networks; normaliseMoisture() below handles that.

   Scoped 14 Aug 2026 from all of NC down to the fourteen trail
   counties, on the CLOUDS maintainer's guidance (format note above
   CLOUDS_WX_LOC below). Checked against the live payload first:
   every station any trail actually matched was already inside these
   counties, so the ~35 statewide stations this drops were pure
   datapoint cost.

   soilmoist20cm came OUT of the var list the same day, same source:
   CLOUDS drops depth/height when serving a "standard or close to
   standard" value, so `soilmoist` already carries each network's one
   standard soil-moisture reading and the second name was the same
   number twice — byte-identical for all 45 reporting stations on the
   14 Aug payload, matching the 0246CA finding in CLAUDE.md. One var
   fewer is a third off the soil query's datapoint cost. */
const CLOUDS_LOC = process.env.CLOUDS_LOC ||
  "type=ECONET,USCRN;state=NC;county=Transylvania,Henderson,Buncombe," +
  "Haywood,Madison,Burke,Caldwell,Yancey,McDowell,Polk,Avery,Watauga," +
  "Mitchell,Rutherford";
const SOIL_VARS = ["soilmoist", "soiltemp"];

/* Measured weather. RAWS fire-weather stations carry no soil moisture
   but do carry a real rain gauge and Penman-Monteith evapotranspiration,
   and they sit inside the forests — 1.6 mi from Pisgah, 1.9 mi from
   DuPont. Scoped to the mountain counties so the payload stays small.

   USCRN is in here too, for its RAIN GAUGE rather than its soil probe.
   Asheville 8 SSW sits 0.8 mi from Bent Creek — closer than any RAWS —
   and on 3 Aug 2026 it caught 0.92 in over four hours that the forecast
   had as 0.00. Bent Creek had no gauge inside the threshold and showed
   hero dirt on a trail that had just taken an inch of rain. That is the
   reason this line includes USCRN.

   ECONet is in here for the same reason — it reports `precip` as well as
   soil, and on the afternoon of 4 Aug 2026 UNCA read 0.21 in while the
   gauges nearest Pisgah and Mills River read 0.01 and 0.00. Three
   networks, one query; a rain gauge is a rain gauge.

   Selector format, per the CLOUDS maintainer (14 Aug 2026): bare
   county names, and state=NC is REQUIRED beside them — county names
   collide across states, and this exact list without state=NC was
   live-confirmed pulling two Polk County TENNESSEE stations (BOCT1,
   DLOT1) that no trail ever used. Every value returned costs quota,
   so that was rent paid on dirt nobody rides. CLOUDS has no lat/lon
   bounding boxes; the scoping options are county, nws_cwa (GSP,RNK
   would cover this list, plus out-of-state edges) and climdiv
   (NC01,NC02). */
const CLOUDS_WX_LOC = process.env.CLOUDS_WX_LOC ||
  "type=RAWS,USCRN,ECONET;state=NC;county=Transylvania,Henderson,Buncombe," +
  "Haywood,Madison,Burke,Caldwell,Yancey,McDowell,Polk,Avery,Watauga," +
  "Mitchell,Rutherford";
const WX_VARS = ["precip", "evaptrans_pm"];

/* CoCoRaHS: volunteer daily rain gauges — a tube in somebody's garden,
   read each morning. Daily and manual, so it can never feed the hourly
   water balance; it rides along as a cross-check for trails with no
   hourly gauge close enough to score from. Ride Kanuga has an observer
   0.8 mi out where its nearest hourly gauge is 6 mi; Hatley's best is
   7.2 mi where hourly offers nothing under 10. Scoped to the counties
   holding (or about to hold) such trails, not the full mountain list —
   observers are dense and every one of these rows ships to the page.
   Same selector format rules as CLOUDS_WX_LOC above — CoCoRaHS is
   nationwide-dense, so an unqualified county name is the worst bleed
   risk of the three feeds. */
const CLOUDS_COCO_LOC = process.env.CLOUDS_COCO_LOC ||
  "type=COCORAHS;state=NC;county=Henderson,Madison,Buncombe," +
  "McDowell,Yancey,Caldwell";

/* Both networks publish hourly, so polling faster than hourly buys
   nothing — and CLOUDS quota is the binding constraint. The quota that
   actually bit is counted in DATAPOINTS (values returned), not
   requests: the public tier is 300,000/month, the 5-6 Aug 2026 outage
   was this account hitting 300,655, and on 10 Aug NCSU raised us to
   600,000 temporarily ("the next month or so") while the queries got
   slimmer. Budget against 300k so the bump's expiry is a non-event.
   (An earlier version of this comment budgeted against a 2,000
   requests/month figure; the error text that actually arrived counts
   datapoints, so that is the number that matters.)

   Where a refresh's datapoints go since 15 Aug 2026 (the delta-fetch):
   the wx series keeps its 3-day window IN MEMORY and asks CLOUDS only
   for the hours since the last successful fetch (+2h of overlap for
   late revisions), so a warm hourly refresh costs ~22 gauges x 2 vars
   x 3 hours ≈ 130 datapoints where the old full re-pull cost ~3,170.
   A cold boot still pays one full 72-hour pull per network. CoCoRaHS
   is cached for COCO_TTL (default 6h — hand-read morning gauges gain
   nothing from hourly refetching) over a -2 day window. Worst case at
   full traffic is now ~5k datapoints/day (~150k/month), inside the
   public tier with room to spare; before the delta it was ~87k/day.
   Degraded mode has its own bound: a soil-station outage retries on
   the 5-minute fail TTL, but WX_MIN_INTERVAL floors the wx rounds at
   20 minutes, so even that mode stays near ~10k/day rather than
   re-polling rain every retry. */

/* Minutes -> ms with a default, tolerant of unset/garbage env values.
   Pure so the tests can lift it. */
function minutesOr(raw, defMin) {
  const n = parseFloat(raw);
  return (isFinite(n) && n > 0 ? n : defMin) * 60 * 1000;
}
const SOIL_TTL = minutesOr(process.env.SOIL_TTL_MIN, 60);
/* How long to sit on a FAILED harvest before trying upstream again.
   Long enough not to hammer a struggling API, short enough that the
   page is not stuck with a bad payload for a full hour. */
const SOIL_FAIL_TTL = minutesOr(process.env.SOIL_FAIL_TTL_MIN, 5);
/* CoCoRaHS observers read a tube once each morning; refetching their
   daily totals every soil refresh was rent paid on data that changes
   once a day. */
const COCO_TTL = minutesOr(process.env.COCO_TTL_MIN, 360);

let soilCache = { at: 0, ttl: 0, payload: null };
let soilGood = null;       /* last harvest that actually carried data */
let soilInflight = null;   /* single-flight: concurrent misses share one harvest */
let metaCache = {};   // keyed by loc
/* Station coordinates change about never. This was 24h while the map
   lived in process memory; now that it survives restarts on disk a week
   is plenty, and each lookup is a REQUEST against the monthly cap. */
const META_TTL = 7 * 24 * 3600 * 1000;
/* A hung upstream call used to hang the single-flight harvest with it —
   every /soil after that waited on a promise that would never settle,
   until the next deploy. Give CLOUDS a generous minute and then move on. */
const CLOUDS_TIMEOUT_MS = Math.round(minutesOr(process.env.CLOUDS_TIMEOUT_MIN, 1));

/* ==================== CLOUDS budget ====================
   Two caps bind on the public tier (api.climate.ncsu.edu/usage, read
   10 Sep 2026): 300,000 DATAPOINTS a month and 2,000 REQUESTS a month,
   both reset at the start of the month. The datapoint cap is the one
   that bit on 5-6 Aug; the request cap is the one this service was
   quietly closest to — a round is one query per network (two soil,
   three wx) plus CoCoRaHS and the odd metadata lookup, so hourly
   visitor-driven refreshes would have run ~3,600 requests a month.

   The ledger counts what this process has spent this month; the pacer
   spaces rounds so the budget lasts the month: spacing = time left in
   the month / rounds the remaining requests can still buy. At the
   default budget that is one round every ~2.2 hours, visitors or not
   (the keep-warm tick below spends it evenly so the page never waits
   on a fetch). Budgets default to 1,700 requests and 250k datapoints —
   under the caps, so the datapoint count being an ESTIMATE (params x
   stations x intervals, the policy page's own formula) costs nothing.
   A CLOUDS reply that names the quota parks upstream fetching for a day
   at a time and the store keeps serving; the month rolling over clears
   it. Both budgets are env-tunable; raising CLOUDS_REQ_BUDGET is how
   to buy fresher measured rain if the tier ever grows.
   ======================================================= */
function intOr(raw, def) {
  const n = parseInt(raw, 10);
  return isFinite(n) && n > 0 ? n : def;
}
const REQ_BUDGET = intOr(process.env.CLOUDS_REQ_BUDGET, 1700);
const DP_BUDGET = intOr(process.env.CLOUDS_DP_BUDGET, 250000);
let ledger = { month: "", startedMs: 0, requests: 0, datapoints: 0, failures: 0, blockedUntil: 0, lastRoundMs: 0, lastRoundDp: 0 };
const lastErrors = [];   /* newest first, capped; /status shows them */
function noteError(where, msg) {
  lastErrors.unshift({ at: new Date().toISOString(), where: where, error: String(msg).slice(0, 240) });
  if (lastErrors.length > 8) lastErrors.length = 8;
}

/* CLOUDS resets "at the beginning of each month". NCSU is Eastern, so
   that lands at 04:00 or 05:00 UTC; roll our month at 05:00 UTC on the
   1st, after theirs has certainly happened. Pure — the tests lift it. */
function monthWindow(nowMs) {
  const d = new Date(nowMs);
  let y = d.getUTCFullYear(), m = d.getUTCMonth();
  if (nowMs < Date.UTC(y, m, 1, 5)) m -= 1;
  const startMs = Date.UTC(y, m, 1, 5), endMs = Date.UTC(y, m + 1, 1, 5);
  return { key: new Date(startMs).toISOString().slice(0, 7), startMs: startMs, endMs: endMs };
}

/* A ledger that starts mid-month (first deploy of this code, or a lost
   volume) cannot know what the month has already spent, so it assumes
   its share is gone and budgets only the fraction of the month that is
   left. A ledger that rolled over at the boundary gets the whole month.
   Pure. */
function proratedBudget(budget, startedMs, startMs, endMs) {
  if (!startedMs || startedMs <= startMs) return budget;
  if (startedMs >= endMs) return 0;
  return Math.floor(budget * (endMs - startedMs) / (endMs - startMs));
}

/* Milliseconds between rounds so the requests left in the budget last
   until the month ends. Infinity when another round no longer fits. Pure. */
function paceSpacingMs(requestsUsed, reqBudget, reqPerRound, nowMs, endMs) {
  const left = reqBudget - requestsUsed;
  if (reqPerRound <= 0 || left < reqPerRound) return Infinity;
  return Math.max(0, (endMs - nowMs) / Math.floor(left / reqPerRound));
}

/* A quota rejection reads differently from a timeout and must be
   treated differently: retrying it burns a failed call and learns
   nothing. Conservative on purpose — the 25k-per-request cap is not a
   month-long condition and must not park the feed. Pure. */
function isQuotaError(msg) {
  const s = String(msg || "");
  if (/per request/i.test(s)) return false;
  return /quota|exceed|(data ?points?|requests?)[^.]{0,40}limit|limit[^.]{0,40}(data ?points?|requests?)/i.test(s);
}

/* Back off after a failed wx round: 5, 10, 20, 40 minutes, capped at an
   hour. Until 10 Sep 2026 a failed round left the floor unset, so every
   visitor re-hit a broken upstream. Pure. */
function failFloorMs(streak) {
  return Math.min(60, 5 * Math.pow(2, Math.max(0, streak - 1))) * 60000;
}

function rollLedger(nowMs) {
  const w = monthWindow(nowMs);
  if (ledger.month !== w.key) {
    if (ledger.month) {
      console.log("clouds budget: " + ledger.month + " closed at " + ledger.requests +
        " requests, " + ledger.datapoints + " datapoints, " + ledger.failures + " failed calls");
    }
    /* Rolling over from a known month means nothing has been spent in
       the new one; a first-ever ledger only knows about now. */
    const startedMs = ledger.month ? w.startMs : nowMs;
    ledger = { month: w.key, startedMs: startedMs, requests: 0, datapoints: 0, failures: 0, blockedUntil: 0,
               lastRoundMs: ledger.lastRoundMs || 0, lastRoundDp: ledger.lastRoundDp || 0 };
  }
  return w;
}
function reqBudgetNow(w) { return proratedBudget(REQ_BUDGET, ledger.startedMs, w.startMs, w.endMs); }
function dpBudgetNow(w) { return proratedBudget(DP_BUDGET, ledger.startedMs, w.startMs, w.endMs); }

/* The one question asked before every round: may we go upstream now? */
function mayFetch(nowMs, reqPerRound) {
  const w = rollLedger(nowMs);
  if (ledger.blockedUntil > nowMs) {
    return { ok: false, why: "quota lockout until " + new Date(ledger.blockedUntil).toISOString() };
  }
  const reqBudget = reqBudgetNow(w), dpBudget = dpBudgetNow(w);
  if (ledger.requests + reqPerRound > reqBudget) {
    return { ok: false, why: "request budget spent (" + ledger.requests + "/" + reqBudget + ")" };
  }
  if (ledger.datapoints + ledger.lastRoundDp > dpBudget) {
    return { ok: false, why: "datapoint budget spent (" + ledger.datapoints + "/" + dpBudget + ")" };
  }
  const spacing = paceSpacingMs(ledger.requests, reqBudget, reqPerRound, nowMs, w.endMs);
  const waitMs = ledger.lastRoundMs + spacing - nowMs;
  if (waitMs > 0) return { ok: false, why: "pacing", waitMs: waitMs };
  return { ok: true };
}

function budgetLine() {
  const now = Date.now(), w = rollLedger(now);
  const pct = Math.round(100 * (now - w.startMs) / (w.endMs - w.startMs));
  const prorated = reqBudgetNow(w) !== REQ_BUDGET;
  return "clouds budget: " + ledger.month + " — " + ledger.requests + " of " + reqBudgetNow(w) +
    " requests, " + ledger.datapoints + " of " + dpBudgetNow(w) + " datapoints" +
    (prorated ? " (prorated: ledger began " + new Date(ledger.startedMs).toISOString().slice(0, 10) + ")" : "") +
    ", " + pct + "% of month elapsed" +
    (ledger.failures ? ", " + ledger.failures + " failed calls" : "") +
    (ledger.blockedUntil > now ? ", LOCKED OUT until " + new Date(ledger.blockedUntil).toISOString() : "");
}

function cloudsUrl(extra) {
  const u = new URL(CLOUDS_URL);
  const base = {
    hash: CLOUDS_HASH, loc: CLOUDS_LOC, output: "json",
    start: "-6 hours", end: "now", obtype: "H", int: "1 hour",
    missing: "", qcfail: "", na: ""
  };
  Object.entries(Object.assign(base, extra || {}))
    .forEach(function (kv) { u.searchParams.set(kv[0], kv[1]); });
  return u.toString();
}

function numOf(v) {
  if (v == null) return null;
  if (typeof v === "object") return numOf(v.value !== undefined ? v.value : null);
  if (typeof v === "number") return isFinite(v) ? v : null;
  const s = String(v).trim();
  if (!s || /^(MV|QCF|NA|NO_AGG_STAT|-9999(\.0+)?)$/i.test(s)) return null;
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

const isId = (k) => /^[A-Z0-9]{3,6}$/.test(k);

function milesBetween(a, b, c, d) {
  const R = 3959, rad = (x) => x * Math.PI / 180;
  const dLa = rad(c - a), dLo = rad(d - b);
  const h = Math.sin(dLa / 2) ** 2 +
            Math.cos(rad(a)) * Math.cos(rad(c)) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/* CLOUDS wraps every field as { name: "<human label>", value: <actual> },
   so almost nothing is a bare scalar. Unwrap before reading anything. */
function unwrap(v) {
  if (v && typeof v === "object" && !Array.isArray(v) && "value" in v) return v.value;
  return v;
}

/* Shape is metadata.location.<ID>.{lat,lon,name,…} for station details
   and data.<ID>.<datetime>.<var> for readings, but the nesting shifts
   with the order/type arguments — so walk the tree and key off station
   ids wherever they turn up rather than hard-coding a path. */
function harvest(node, ctxId, out) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) { node.forEach((n) => harvest(n, ctxId, out)); return; }

  let id = ctxId;
  const locv = unwrap(node.location !== undefined ? node.location : node.station);
  if (typeof locv === "string" && isId(locv)) id = locv;

  if (id) {
    const rec = () => (out[id] = out[id] || { id: id });

    /* Readings carry their own datetime. CLOUDS returns several hours
       per station, so keep the freshest rather than trusting key order. */
    for (const v of SOIL_VARS) {
      if (node[v] === undefined) continue;
      const n = numOf(unwrap(node[v]));
      if (n === null) continue;
      const raw = node[v];
      const when = (raw && typeof raw === "object" && raw.datetime)
        ? String(raw.datetime) : (unwrap(node.datetime) || null);
      const r = rec();
      if (when && r.at && when < r.at) continue;
      if (when) r.at = when;
      r[v] = n;
    }
    /* long form: one row per parameter */
    const vn = unwrap(node.var);
    if (typeof vn === "string" && SOIL_VARS.indexOf(vn) !== -1 && node.value !== undefined) {
      const n = numOf(node.value);
      if (n !== null) rec()[vn] = n;
    }
    const la = numOf(unwrap(node.lat !== undefined ? node.lat : node.latitude));
    const lo = numOf(unwrap(node.lon !== undefined ? node.lon : node.longitude));
    if (la !== null && lo !== null) { rec().lat = la; rec().lon = lo; }
    /* CLOUDS reports elevation in feet; the page uses it to avoid
       matching a mountain trail to a valley station. */
    const el = numOf(unwrap(node.elev !== undefined ? node.elev : node.elevation));
    if (el !== null) rec().elev = el;

    /* Only trust "name" inside a station description, never inside a
       variable object — those carry a name too ("Surface Soil Moisture"). */
    const nm = unwrap(node.name);
    if (typeof nm === "string" && (node.location !== undefined || node.city !== undefined)) {
      rec().name = nm.slice(0, 60);
    }
    const dt = unwrap(node.datetime);
    if (typeof dt === "string" && out[id]) out[id].at = dt;
  }

  for (const [k, v] of Object.entries(node)) {
    if (SOIL_VARS.indexOf(k) !== -1) continue;   /* already read; don't recurse in */
    if (v && typeof v === "object") harvest(v, isId(k) ? k : id, out);
  }
}

async function cloudsJson(url) {
  const r = await fetch(url, {
    headers: { "User-Agent": "AltarCycles-TrailConditions" },
    signal: AbortSignal.timeout(CLOUDS_TIMEOUT_MS)
  });
  const text = await r.text();
  if (!r.ok) {
    /* Surface WHY. CLOUDS 400s share one generic message ("Uh oh, there
       is a FATAL ERROR...") and put the actual reasons in a structured
       errors[] array — quota, bad parameter, disabled hash all read the
       same until that array is in the dropped string. The key never
       appears: any echo of it is replaced before logging. */
    let hint = "";
    try {
      const j = JSON.parse(text);
      const errs = j && j.status && j.status.errors;
      if (Array.isArray(errs) && errs.length) hint = errs.join(" | ");
    } catch (pe) { /* not JSON — fall through to the raw snippet */ }
    if (!hint) hint = String(text).replace(/\s+/g, " ").slice(0, 120);
    hint = hint.split(CLOUDS_HASH).join("<hash>").replace(/\s+/g, " ").slice(0, 220);
    throw new Error("CLOUDS " + r.status + (hint ? " — " + hint : ""));
  }
  try { return JSON.parse(text); }
  catch (e) { throw new Error("CLOUDS returned non-JSON (" + text.slice(0, 80) + ")"); }
}

/* Every upstream call goes through here so the ledger sees it.
   `dpPerLocation` is params x intervals for the request; the reply says
   how many locations answered. Metadata lookups pass 0 — the policy
   page's formula does not price them — but still count as a request. */
async function cloudsData(extra, dpPerLocation) {
  rollLedger(Date.now());
  /* Set mid-round by an earlier call: the rest of the round would only
     add failed calls to CLOUDS' count and noise to ours. */
  if (ledger.blockedUntil > Date.now()) {
    throw new Error("CLOUDS paused — quota lockout until " + new Date(ledger.blockedUntil).toISOString());
  }
  const isMeta = extra && extra.type === "meta";
  const where = (isMeta ? "meta:" : "data:") + String((extra && extra.loc) || CLOUDS_LOC).split(";")[0].replace("type=", "");
  let j;
  try { j = await cloudsJson(cloudsUrl(extra)); }
  catch (e) {
    ledger.failures++;
    noteError(where, e.message || e);
    if (isQuotaError(e.message)) {
      /* Park for a day at a time, not the rest of the month: if the
         limit was raised, or this was misread, one probe a day finds out. */
      ledger.blockedUntil = Math.min(monthWindow(Date.now()).endMs, Date.now() + 24 * 3600000);
      console.log("clouds quota rejection — upstream paused until " +
        new Date(ledger.blockedUntil).toISOString() + ": " + e.message);
    }
    saveStoreSoon();
    throw e;
  }
  const locs = isMeta
    ? Object.keys((j.metadata && j.metadata.location) || j.location || {}).length
    : Object.keys(j.data || {}).length;
  ledger.requests++;
  ledger.datapoints += Math.round(locs * (dpPerLocation || 0));
  return j;
}

/* Split `type=A,B,C` into one request per network and merge, keeping the
   rest of the selector as it is.

   Honest history: this was written to fix a CLOUDS response cap that does
   not exist. On 4 Aug 2026 the widened three-network rain query looked
   like it was being truncated after NCVN7, losing SMPN7 (1.6 mi from
   Pisgah). The payload was in fact complete — the tool being used to read
   it was cutting the JSON at ~40 KB. See CLAUDE.md.

   It is kept because it earns its place for a different reason: one
   network being down or slow no longer costs us the other two. That is
   worth three cheap requests per refresh. It is NOT a truncation
   guard, and nothing here should be taken as evidence CLOUDS truncates.
   `dropped` on the /soil payload is the actual guard, and as of writing
   it has never been non-empty. */
function locVariants(loc) {
  const parts = String(loc).split(";");
  const ix = parts.findIndex((p) => /^\s*type=/i.test(p));
  if (ix === -1) return [loc];
  const types = parts[ix].split("=").slice(1).join("=")
    .split(",").map((s) => s.trim()).filter(Boolean);
  if (types.length < 2) return [loc];
  return types.map(function (t) {
    const copy = parts.slice();
    copy[ix] = "type=" + t;
    return copy.join(";");
  });
}

/* Station coordinates change rarely; hold them for a day. */
async function stationMeta(loc, vars) {
  const hit = metaCache[loc];
  if (hit && Date.now() - hit.at < META_TTL) return hit.byId;
  const out = {};
  try {
    harvest(await cloudsData({ type: "meta", loc: loc, var: vars }, 0), null, out);
  } catch (e) {
    /* One failed metadata call used to cache an EMPTY coordinate map for
       24 hours, which dropped every gauge in the network as ":nocoords"
       for a day. Coordinates change ~never: on failure, serve the old
       map if we have one and leave the cache alone so the next call
       retries upstream. On a COLD failure — nothing cached yet, i.e.
       every process boot — cache nothing at all: the old fall-through
       banked an empty map stamped fresh, which would have blanked every
       rain gauge for 24 hours after any boot-time blip (found in review
       15 Aug 2026, latent since this cache existed). */
    return hit ? hit.byId : {};
  }
  /* Same guard for a 200 that harvests nothing: never bank an empty
     map, cold or warm. */
  if (!Object.keys(out).length) return hit ? hit.byId : out;
  metaCache[loc] = { at: Date.now(), byId: out };
  saveStoreSoon();
  return out;
}

/* ECONet reports volumetric water content as a fraction (0.44); USCRN
   reports the same quantity as a percentage (24.3). Soil never holds
   more than about 0.6 by volume, so anything above 1.5 is a percentage. */
function normaliseMoisture(v) {
  if (v == null) return null;
  return v > 1.5 ? v / 100 : v;
}

/* Hourly rain and evapotranspiration from the fire-weather stations.
   The page's water balance needs three days of measured rain — but the
   only NEW information each refresh is the last hour or two. Since
   15 Aug 2026 the 72-hour window lives in memory (wxStore) and each
   refresh asks CLOUDS only for the hours since the last successful
   fetch, +2h of overlap so late upstream revisions still land. That is
   the difference between ~3,170 datapoints per refresh and ~130.

   The store is process memory: a deploy or restart empties it and the
   next harvest pays one full 72-hour pull per network (the boot-time
   grading run does this within a minute of every deploy). The fetch
   cursor is PER NETWORK, so one network erroring keeps its own cursor
   parked and re-covers its gap on the next refresh without forcing the
   healthy networks to refetch anything. Side effect worth having: a
   gauge that skips a report or a network that drops out keeps serving
   its stored hours (honestly aged — the page already words rain as
   "ended Nh ago"), instead of vanishing from the payload for an hour
   the way the full re-pull made it. Stored hours age out against the
   FLEET'S newest reading, data time not wall clock, same reasoning as
   the staleness check below. */
const WX_WINDOW_H = 72;
const WX_OVERLAP_H = 2;
/* Floor between upstream wx rounds: the 5-minute fail-TTL retry loop
   exists to heal the soil queries, not to re-poll rain fetched minutes
   ago. Env-tunable (WX_MIN_INTERVAL_MIN) so a live check can shrink it. */
const WX_MIN_INTERVAL = minutesOr(process.env.WX_MIN_INTERVAL_MIN, 20);
let wxStore = {
  fetchedAt: {},    /* per loc variant: wall time its newest DATA hour last advanced */
  newestKey: {},    /* per loc variant: that newest hour key */
  seenIds: {},      /* every station id ever seen in a response (backfill trigger) */
  byId: {},         /* per station: { hours } */
  lastFetchMs: 0,   /* wall time of the last round that reached upstream */
  failStreak: 0,    /* consecutive rounds where NO network answered */
  failUntilMs: 0    /* back-off floor after such a round (failFloorMs) */
};

/* Hours to request for one network, given when IT last succeeded.
   Window/overlap ride in as parameters so the tests can lift this
   standalone; the call site below passes the constants. */
function wxFetchHours(fetchedAtMs, nowMs, windowH, overlapH) {
  if (!fetchedAtMs) return windowH;
  const gapH = Math.ceil((nowMs - fetchedAtMs) / 3600000);
  return Math.max(1 + overlapH, Math.min(windowH, gapH + overlapH));
}

/* "YYYY-MM-DDTHH" -> ms on a consistent axis. CLOUDS keys are local
   time with no zone, but every station shares the same zone, so
   treating components as UTC linearizes them consistently. */
function hourKeyMs(k) {
  const m = String(k).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})$/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4]) : null;
}

/* Fresh rows win on collision — upstream revisions are the truth. A
   fresh row of `null` is a RETRACTION marker from parseWxHours (CLOUDS
   QC nulled a value it had published): delete the stored hour rather
   than keep serving rain the network has withdrawn. */
function mergeHours(oldHours, newHours) {
  const out = {};
  for (const k of Object.keys(oldHours || {})) out[k] = oldHours[k];
  for (const k of Object.keys(newHours || {})) {
    if (newHours[k] === null) delete out[k];
    else out[k] = newHours[k];
  }
  return out;
}

/* Keep only hour keys at or after the cutoff; malformed keys go. */
function pruneHoursBefore(hours, cutoffMs) {
  const out = {};
  for (const k of Object.keys(hours || {})) {
    const ms = hourKeyMs(k);
    if (ms !== null && ms >= cutoffMs) out[k] = hours[k];
  }
  return out;
}

/* One station's CLOUDS rows -> {"YYYY-MM-DDTHH": {p, et}}. Unchanged
   parsing since 4 Aug, just liftable now. */
function parseWxHours(byTime) {
  const hours = {};
  if (!byTime || typeof byTime !== "object") return hours;
  for (const t of Object.keys(byTime)) {
    const rec = byTime[t];
    if (!rec || typeof rec !== "object") continue;
    const p = numOf(unwrap(rec.precip));
    /* CLOUDS serves Penman-Monteith ET in MILLIMETERS while precip
       on the same feed is inches (verified against forecasts and a
       hand-read gauge on 5 Aug 2026). Unconverted, FLET showed
       "4.15 in evaporated in 24h" — impossible in inches, ordinary
       in mm. Convert here so the card and the ratings CSV both get
       inches. If a station ever really does report inches this
       makes it read 25x low, which is visible; the reverse error
       read 25x high for a month and looked like a broken sensor. */
    const etRaw = numOf(unwrap(rec.evaptrans_pm));
    const et = etRaw === null ? null : etRaw / 25.4;
    /* key by local hour so it lines up with Open-Meteo's timestamps */
    const s = String(t);
    const key = s.slice(0, 10) + "T" + s.slice(11, 13);
    if (p === null && et === null) {
      /* The fields are PRESENT but carry no value: that is a row CLOUDS
         has nulled after publishing (QC retraction). Mark it so
         mergeHours deletes the stored hour. A row without the fields at
         all stays a plain skip — absence is not a retraction. */
      if ("precip" in rec || "evaptrans_pm" in rec) hours[key] = null;
      continue;
    }
    hours[key] = { p: p, et: et };
  }
  return hours;
}

async function wxSeries(dropped) {
  const nowMs = Date.now();
  /* Within the floor of the last round that reached upstream, serve the
     store untouched — a station-outage retry loop should not turn into
     a rain-polling loop. */
  if (wxStore.lastFetchMs && nowMs - wxStore.lastFetchMs < WX_MIN_INTERVAL) {
    return wxPayload(dropped);
  }
  /* After a round where every network failed, wait before asking again.
     Without this the failed round left lastFetchMs alone, so every
     visitor during an outage re-hit upstream three times (5-10 Sep 2026
     ran five days that way). The store keeps serving meanwhile. */
  if (wxStore.failUntilMs && nowMs < wxStore.failUntilMs) {
    if (dropped) {
      dropped.push("wx:backing off after " + wxStore.failStreak + " failed round" +
        (wxStore.failStreak === 1 ? "" : "s") + ", retry " + new Date(wxStore.failUntilMs).toISOString());
    }
    return wxPayload(dropped);
  }
  const askLog = [];
  let reachedUpstream = false;
  for (const loc of locVariants(CLOUDS_WX_LOC)) {
    const label = loc.split(";")[0].replace("type=", "");
    let askH = wxFetchHours(wxStore.fetchedAt[loc], nowMs, WX_WINDOW_H, WX_OVERLAP_H);
    let j;
    /* One network being down must not cost us the other two — and its
       own cursor stays parked so its gap is re-covered next time. */
    try {
      j = await cloudsData({
        loc: loc, var: WX_VARS.join(","),
        start: "-" + askH + " hours", end: "now", int: "1 hour", obtype: "H"
      }, WX_VARS.length * askH);
    } catch (e) {
      if (dropped) dropped.push("query:" + label + ":" + String(e.message || e).slice(0, 240));
      /* The reason goes in the log line too. Five days of "RAWS failed"
         in Sep 2026 were undiagnosable afterwards because the reason
         lived only in a payload nobody fetched. */
      askLog.push(label + " failed (" + String(e.message || e).replace(/\s+/g, " ").slice(0, 140) + ")");
      continue;
    }
    reachedUpstream = true;
    let data = j.data || {};
    /* A station id this process has never seen in ANY response gets one
       full-window backfill for its network, so a brand-new gauge starts
       with real history rather than a sliver. If the backfill throws,
       the new ids are set aside untouched — nothing is banked that
       would mask the retry on the next refresh. (Keyed on ids SEEN, not
       ids stored: a station that appears but never parses a row must
       not re-trigger this forever.) */
    if (askH < WX_WINDOW_H) {
      const news = Object.keys(data).filter(function (id) { return !wxStore.seenIds[id]; });
      if (news.length) {
        try {
          j = await cloudsData({
            loc: loc, var: WX_VARS.join(","),
            start: "-" + WX_WINDOW_H + " hours", end: "now", int: "1 hour", obtype: "H"
          }, WX_VARS.length * WX_WINDOW_H);
          data = j.data || {};
          askH = WX_WINDOW_H;
        } catch (e) {
          for (const id of news) delete data[id];
          if (dropped) dropped.push("wxbackfill deferred:" + news.slice(0, 6).join(","));
        }
      }
    }
    let newestKey = wxStore.newestKey[loc] || "";
    for (const id of Object.keys(data)) {
      wxStore.seenIds[id] = 1;
      const fresh = parseWxHours(data[id]);
      const keys = Object.keys(fresh);
      if (!keys.length) continue;
      const had = wxStore.byId[id];
      const merged = mergeHours(had && had.hours, fresh);
      if (Object.keys(merged).length) wxStore.byId[id] = { hours: merged };
      else delete wxStore.byId[id];   /* retractions can empty a gauge */
      for (const k of keys) if (fresh[k] !== null && k > newestKey) newestKey = k;
    }
    /* The cursor is the wall time this network's newest DATA hour last
       moved forward — not the time we last asked. If upstream stalls
       (empty 200s, or rows that stop advancing while ingest lags), the
       cursor parks and the ask window widens refresh by refresh until
       it spans the whole stall — which is exactly how the old full
       re-pull healed the same cases, minus the standing cost. The
       accepted loss: a SINGLE gauge uploading a backlog deeper than
       the overlap while its network's newest kept advancing — those
       hours are simply never fetched (there is no periodic full
       re-pull anymore); the page scores them from forecast, honestly,
       until they age past the window. */
    if (newestKey && newestKey !== (wxStore.newestKey[loc] || "")) {
      wxStore.newestKey[loc] = newestKey;
      wxStore.fetchedAt[loc] = nowMs;
    }
    askLog.push(label + " " + askH + "h");
  }
  if (reachedUpstream) {
    wxStore.lastFetchMs = nowMs;
    wxStore.failStreak = 0;
    wxStore.failUntilMs = 0;
  } else {
    wxStore.failStreak = (wxStore.failStreak || 0) + 1;
    wxStore.failUntilMs = nowMs + failFloorMs(wxStore.failStreak);
  }

  /* Age the whole store against the fleet's newest reading, then let
     anything with no hours left fall away. The newest is clamped to a
     few hours past the wall clock so one future-dated row cannot wipe
     the fleet (data time normally trails wall time here, so the clamp
     never binds on healthy data). */
  let newestMs = null;
  for (const id of Object.keys(wxStore.byId)) {
    for (const k of Object.keys(wxStore.byId[id].hours)) {
      const ms = hourKeyMs(k);
      if (ms !== null && (newestMs === null || ms > newestMs)) newestMs = ms;
    }
  }
  const capMs = nowMs + 3 * 3600000;
  if (newestMs !== null && newestMs > capMs) newestMs = capMs;
  if (newestMs !== null) {
    const cutoffMs = newestMs - WX_WINDOW_H * 3600000;
    for (const id of Object.keys(wxStore.byId)) {
      const kept = pruneHoursBefore(wxStore.byId[id].hours, cutoffMs);
      if (Object.keys(kept).length) wxStore.byId[id].hours = kept;
      else delete wxStore.byId[id];
    }
  }
  console.log("wx delta: " + (askLog.join(", ") || "no networks") + "; " +
    Object.keys(wxStore.byId).length + " gauges in store" +
    (reachedUpstream ? "" : "; backing off " + Math.round(failFloorMs(wxStore.failStreak) / 60000) + " min"));
  saveStoreSoon();

  return wxPayload(dropped);
}

/* Build the payload from the store — same shape as it has always been,
   so the page and the grader see nothing new. Metadata merged across
   every network first (ids are network-unique), then one pass. */
async function wxPayload(dropped) {
  const meta = {};
  for (const loc of locVariants(CLOUDS_WX_LOC)) {
    Object.assign(meta, await stationMeta(loc, WX_VARS.join(",")));
  }
  const out = [];
  for (const id of Object.keys(wxStore.byId)) {
    const m = meta[id] || {};
    /* Readings but no coordinates: the station is real and we cannot
       place it, so it cannot be matched to a trail. Silently dropping
       it is how a missing gauge looks like no rain. Say so instead. */
    if (m.lat == null || m.lon == null) { if (dropped) dropped.push(id + ":nocoords"); continue; }
    out.push({ id: id, name: m.name || id, lat: m.lat, lon: m.lon,
               elev: m.elev == null ? null : m.elev, hours: wxStore.byId[id].hours });
  }
  return out;
}

/* CoCoRaHS ids look like NC-HN-38 — they fail the isId() regex the
   harvest() walker keys on, so this network gets its own small parser
   rather than a loosened regex that would let county names through. */
let cocoMetaCache = { at: 0, byId: null };
async function cocoMeta() {
  if (cocoMetaCache.byId && Date.now() - cocoMetaCache.at < META_TTL) return cocoMetaCache.byId;
  const byId = {};
  try {
    const j = await cloudsData({ type: "meta", loc: CLOUDS_COCO_LOC, var: "precip" }, 0);
    const loc = (j.metadata && j.metadata.location) || j.location || {};
    for (const id of Object.keys(loc)) {
      const s = loc[id] || {};
      const g = (k) => (s[k] && s[k].value !== undefined ? s[k].value : (typeof s[k] === "string" ? s[k] : null));
      const lat = numOf(g("lat")), lon = numOf(g("lon"));
      if (lat == null || lon == null) continue;
      byId[id] = { name: g("name"), lat: lat, lon: lon, elev: numOf(g("elev")) };
    }
  } catch (e) {
    /* Same rule as stationMeta: a failed meta call must not cache an
       empty map — not over a good one, and not on a cold boot either
       (same 24h-blank hazard fixed there 15 Aug 2026). */
    return (cocoMetaCache.byId && Object.keys(cocoMetaCache.byId).length) ? cocoMetaCache.byId : {};
  }
  if (!Object.keys(byId).length) return cocoMetaCache.byId || byId;
  cocoMetaCache = { at: Date.now(), byId: byId };
  saveStoreSoon();
  return byId;
}

let cocoCache = { at: 0, rows: null, emptyAt: 0 };
async function cocoSeries(dropped) {
  /* Morning-read tubes change once a day; serving the cached rows for
     COCO_TTL (default 6h) costs nothing in freshness and cuts this
     query from every refresh to ~4 a day. */
  if (cocoCache.rows && Date.now() - cocoCache.at < COCO_TTL) return cocoCache.rows;
  /* An EMPTY answer parks the retry for the same TTL. Until 10 Sep 2026
     it left the clock alone, so while CLOUDS's CoCoRaHS feed was blank
     (4 Sep onward) every round re-asked and got nothing — one request
     in six, spent on a feed that changes once a day at best. */
  if (cocoCache.emptyAt && Date.now() - cocoCache.emptyAt < COCO_TTL) return cocoCache.rows || [];
  let j;
  try {
    j = await cloudsData({
      loc: CLOUDS_COCO_LOC, var: "precip",
      /* Two days of daily rows: tolerant of an observer who is a day
         behind (the freshest-numeric pick below handles that). This was
         -4 days until 15 Aug 2026 — but the page's own freshness cutoff
         already hides readings older than two days, so days three and
         four were rows nobody could ever see: pure row cost. */
      start: "-2 days", end: "now", int: "1 day", obtype: "D", metadata: "no"
    }, 1 * 2);
  } catch (e) {
    if (dropped) dropped.push("coco:" + String(e.message || e).slice(0, 60));
    console.log("coco refetch failed: " + String(e.message || e).replace(/\s+/g, " ").slice(0, 160));
    /* Serve yesterday's volunteers over none — their rows are dated, so
       the page's wording stays honest even when this cache is old. */
    return cocoCache.rows || [];
  }
  const data = j.data || {};
  const meta = await cocoMeta();
  const out = [];
  let unplaced = 0, noNumber = 0;
  for (const id of Object.keys(data)) {
    const byDate = data[id];
    if (!byDate || typeof byDate !== "object") continue;
    /* Keep the freshest date that carries an actual number. An empty
       value is an observer who has a row for today but hasn't read the
       tube yet — fall back to yesterday rather than showing a blank. */
    let best = null;
    for (const d of Object.keys(byDate)) {
      const raw = unwrap((byDate[d] || {}).precip);
      /* CoCoRaHS reports trace rain as "T" — call it 0.005 rather than
         dropping it, since "a trace fell" and "nothing fell" are
         different answers to the question the page is asking. */
      const p = (typeof raw === "string" && raw.trim().toUpperCase() === "T") ? 0.005 : numOf(raw);
      if (p === null) continue;
      if (!best || d > best.date) best = { date: d, precip: p };
    }
    if (!best) { noNumber++; continue; }
    const m = meta[id];
    if (!m) { unplaced++; continue; }
    out.push({ id: id, name: m.name || id, lat: m.lat, lon: m.lon,
               elev: m.elev == null ? null : m.elev, date: best.date, precip: best.precip });
  }
  /* One line, not one per observer — there can be dozens. */
  if (unplaced && dropped) dropped.push("coco:" + unplaced + " observers without coordinates");

  /* An empty CoCoRaHS list used to be indistinguishable from a healthy
     one: every failure path here either threw (caught above) or fell
     through the loop leaving out=[] and dropped untouched, so the payload
     said `coco: []` and the page drew nothing, forever, silently. On
     5 Aug 2026 it had been returning zero rows with no diagnostic at all
     — and this is the designated cross-check for exactly the trails with
     no hourly gauge, so its silence was load-bearing.

     Name which zero this is. The three cases have different fixes: no
     ids means the selector or the key is wrong, ids-without-numbers means
     the window or obtype is wrong, all-unplaced means the metadata call
     is failing. */
  if (!out.length) {
    const ids = Object.keys(data).length;
    let why;
    if (!ids) why = "coco:upstream returned no observers for the selector";
    else if (noNumber >= ids) why = "coco:" + ids + " observers, none with a numeric daily total";
    else why = "coco:" + ids + " observers returned, none usable (" +
               noNumber + " without a number, " + unplaced + " without coordinates)";
    if (dropped) dropped.push(why);
    /* Log what actually came back — the first few ids with their dated
       raw values — so "none with a number" can be told apart from
       "upstream has published nothing since <date>" without a key. On
       10 Sep 2026 the live payload said exactly this for six days and
       the rows it was masking were dated 2 Sep; nobody could tell why. */
    const peek = Object.keys(data).slice(0, 3).map(function (id) {
      const byDate = data[id] || {};
      return id + "{" + Object.keys(byDate).sort().map(function (d) {
        return d + "=" + JSON.stringify(unwrap((byDate[d] || {}).precip));
      }).join(",") + "}";
    }).join(" ");
    console.log("coco refetch: " + why.slice(5) + (peek ? "; sample " + peek.slice(0, 300) : "") +
      (cocoCache.rows ? "; serving " + cocoCache.rows.length + " cached rows from " +
        new Date(cocoCache.at).toISOString().slice(0, 10) : "") + "; next try in " + Math.round(COCO_TTL / 60000) + " min");
    cocoCache.emptyAt = Date.now();
    saveStoreSoon();
  }
  /* Same rule as every other cache here: never bank an empty result
     over a populated one. An empty fetch keeps the old rows serving and
     leaves the cache clock alone so the next refresh retries upstream. */
  if (out.length) {
    cocoCache = { at: Date.now(), rows: out, emptyAt: 0 };
    console.log("coco refetch: " + out.length + " observers");
    saveStoreSoon();
    return out;
  }
  return cocoCache.rows || out;
}

/* ==================== forecast grading ====================
   Every day, ask a plain question with a measurable answer: how much
   rain did Open-Meteo say fell on each trail, and how much did the
   nearest gauge actually catch?

   This exists because the model's whole wetness story runs on forecast
   rain, and on 3 Aug 2026 Open-Meteo reported 0.00 in for a Bent Creek
   storm that a gauge 0.8 mi away measured at 0.92. That was found by
   hand, after Matt noticed a card looked wrong. Nobody should have to
   notice. Two weeks of this turns "the forecast seems off" into a
   number per trail, and it needs no riders to produce.
   ========================================================== */

const GRADE_FILE = path.join(DATA_DIR, "forecast-grade.jsonl");
const GRADE_MAX_MI = 6;            // a gauge further out grades nothing useful
const GRADE_EVERY_MS = 24 * 3600 * 1000;
const PAGE_URL = process.env.PAGE_URL || "https://altar-bike.github.io/Altar-Dirt/";

/* The trail list lives in index.html and that stays the single source of
   truth — a second copy here would drift the first time Matt adds a spot,
   and a grader silently scoring the wrong coordinates is worse than no
   grader. Parsed from the live page once a day, with the last good list
   cached in memory so a fetch failure costs nothing. */
let trailCache = { at: 0, list: null };
function parseTrails(html) {
  const block = html.match(/var TRAILS = \[([\s\S]*?)\n\s*\];/);
  if (!block) return null;
  const out = [];
  const re = /name:\s*"([^"]+)"[^{}]*?lat:\s*(-?[\d.]+),\s*lon:\s*(-?[\d.]+)/g;
  let x;
  while ((x = re.exec(block[1])) !== null) {
    const lat = parseFloat(x[2]), lon = parseFloat(x[3]);
    if (isFinite(lat) && isFinite(lon)) out.push({ name: x[1], lat: lat, lon: lon });
  }
  return out.length ? out : null;
}
async function trailPoints() {
  if (trailCache.list && Date.now() - trailCache.at < GRADE_EVERY_MS) return trailCache.list;
  try {
    const r = await fetch(PAGE_URL, { headers: { "User-Agent": "AltarCycles-TrailConditions" } });
    const list = parseTrails(await r.text());
    if (list) trailCache = { at: Date.now(), list: list };
  } catch (e) { /* keep whatever we had */ }
  return trailCache.list;
}

const OM_HOURLY = "precipitation";
async function openMeteo(t) {
  const u = new URL("https://api.open-meteo.com/v1/forecast");
  Object.entries({
    latitude: t.lat, longitude: t.lon, hourly: OM_HOURLY,
    daily: "precipitation_sum", past_days: 2, forecast_days: 6,
    precipitation_unit: "inch", timezone: "auto"
  }).forEach(([k, v]) => u.searchParams.set(k, v));
  const r = await fetch(u.toString());
  if (!r.ok) throw new Error("open-meteo " + r.status);
  return r.json();
}

function nearestGauge(t, wx) {
  let best = null;
  for (const s of wx || []) {
    if (s.lat == null || s.lon == null || !s.hours) continue;
    const mi = milesBetween(t.lat, t.lon, s.lat, s.lon);
    if (mi > GRADE_MAX_MI) continue;
    if (!best || mi < best.mi) best = { s: s, mi: mi };
  }
  return best;
}

async function gradeOnce() {
  const trails = await trailPoints();
  if (!trails) return { error: "could not read the trail list from the page" };
  const soil = await soilPayload();
  const stampedAt = new Date().toISOString();
  const rows = [];
  /* Each run looks three days back, so consecutive runs overlap heavily.
     Summing them would count the same storm three times and report
     `missed_in` of 5.43" for a day that saw 2". Grade only hours past
     the last one already graded for this trail; the first run backfills
     the window and every run after it adds only what is new. */
  const mark = watermarks();

  for (const t of trails) {
    const g = nearestGauge(t, soil.wx);
    if (!g) continue;                       /* nothing to grade against */
    let om;
    try { om = await openMeteo(t); } catch (e) { continue; }
    const times = (om.hourly && om.hourly.time) || [];
    const fc = (om.hourly && om.hourly.precipitation) || [];
    const since = mark[t.name] || "";

    /* Only hours that are genuinely past AND that the gauge reported,
       so a gauge outage reads as fewer hours rather than as fake zeroes. */
    let n = 0, fSum = 0, mSum = 0, maxErr = 0, missed = 0, phantom = 0, missedIn = 0;
    let firstHour = null, lastHour = null;
    for (let i = 0; i < times.length; i++) {
      const hr = times[i].slice(0, 13);
      if (since && hr <= since) continue;   /* already counted */
      const rec = g.s.hours[hr];
      if (!rec || rec.p == null) continue;
      const f = fc[i] || 0, m = rec.p || 0;
      n++; fSum += f; mSum += m;
      if (firstHour === null) firstHour = hr;
      lastHour = hr;
      const err = Math.abs(f - m);
      if (err > maxErr) maxErr = err;
      /* the two failures that matter, kept apart: rain the forecast did
         not see at all, and rain it invented */
      if (m >= 0.05 && f < 0.01) { missed++; missedIn += m; }
      if (f >= 0.05 && m < 0.01) phantom++;
    }
    if (n < 6) continue;

    /* Archive the forward forecast so lead-time accuracy can be graded
       later against gauges that haven't reported yet. */
    const ahead = [];
    if (om.daily && om.daily.time) {
      for (let d = 0; d < om.daily.time.length; d++) {
        ahead.push({ d: om.daily.time[d], p: om.daily.precipitation_sum[d] });
      }
    }

    rows.push({
      at: stampedAt, trail: t.name, gauge: g.s.id, gauge_mi: Math.round(g.mi * 10) / 10,
      first_hour: firstHour, last_hour: lastHour,
      hours: n,
      forecast_in: Math.round(fSum * 100) / 100,
      measured_in: Math.round(mSum * 100) / 100,
      bias_in: Math.round((fSum - mSum) * 100) / 100,
      max_hour_err_in: Math.round(maxErr * 100) / 100,
      missed_hours: missed, missed_in: Math.round(missedIn * 100) / 100,
      phantom_hours: phantom,
      ahead: ahead
    });
  }

  if (rows.length) {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.appendFileSync(GRADE_FILE, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    } catch (e) { /* grading must never take the service down */ }
  }
  return { at: stampedAt, graded: rows.length, rows: rows };
}

function gradeHistory() {
  let raw;
  try { raw = fs.readFileSync(GRADE_FILE, "utf8"); } catch (e) { return []; }
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch (e) { /* skip */ }
  }
  return out;
}

/* Latest hour already graded, per trail. Rows written before the
   watermark existed have no `last_hour`; they are ignored here, which
   means the first run after this change re-grades their window once and
   then stops. A single overlap beats carrying a permanent triple-count. */
function watermarks() {
  const out = {};
  for (const r of gradeHistory()) {
    if (!r.last_hour) continue;
    if (!out[r.trail] || r.last_hour > out[r.trail]) out[r.trail] = r.last_hour;
  }
  return out;
}

/* Per-trail rollup: the answer to "how much should I trust the forecast
   here", which is the whole point of collecting this. */
function gradeSummary() {
  const by = {};
  for (const r of gradeHistory()) {
    /* Legacy overlapping rows would inflate every total. */
    if (!r.last_hour) continue;
    const k = r.trail;
    const b = (by[k] = by[k] || {
      trail: k, gauge: r.gauge, gauge_mi: r.gauge_mi, runs: 0,
      hours: 0, forecast_in: 0, measured_in: 0, missed_hours: 0,
      missed_in: 0, phantom_hours: 0, worst_hour_in: 0
    });
    b.runs++; b.hours += r.hours;
    b.forecast_in += r.forecast_in; b.measured_in += r.measured_in;
    b.missed_hours += r.missed_hours; b.missed_in += r.missed_in;
    b.phantom_hours += r.phantom_hours;
    if (r.max_hour_err_in > b.worst_hour_in) b.worst_hour_in = r.max_hour_err_in;
  }
  return Object.values(by).map(function (b) {
    const round = (x) => Math.round(x * 100) / 100;
    return {
      trail: b.trail, gauge: b.gauge, gauge_mi: b.gauge_mi,
      runs: b.runs, hours: b.hours,
      forecast_in: round(b.forecast_in), measured_in: round(b.measured_in),
      /* >1 means the forecast runs wet here, <1 means it runs dry */
      ratio: b.measured_in > 0.05 ? round(b.forecast_in / b.measured_in) : null,
      missed_hours: b.missed_hours, missed_in: round(b.missed_in),
      phantom_hours: b.phantom_hours, worst_hour_in: round(b.worst_hour_in)
    };
  }).sort((a, b) => (a.ratio == null ? 9 : a.ratio) - (b.ratio == null ? 9 : b.ratio));
}

async function soilPayload() {
  const now = Date.now();
  if (soilCache.payload && now - soilCache.at < soilCache.ttl) return soilCache.payload;
  if (!CLOUDS_HASH) return { stations: [], wx: [], coco: [], note: "CLOUDS_HASH not set" };
  /* Single flight. Without this, every request that lands on an expired
     cache fires its own six-query CLOUDS burst — under load that
     multiplies quota burn by the number of concurrent visitors, at the
     exact moment (TTL boundary) they pile up. */
  if (soilInflight) return soilInflight;
  /* The pacer decides whether a round fits the month's budget. When it
     says no, the cache serves: stale is honest here — the page words
     rain by the data's own timestamps — and /status says why and for
     how long. This is the whole quota guarantee; nothing reaches
     upstream around it except /soil/raw, which is token-gated. */
  const gate = mayFetch(now, roundRequests());
  if (!gate.ok) {
    if (soilCache.payload) return soilCache.payload;
    if (soilGood) return soilGood;
    return { stations: [], wx: [], coco: [], note: "clouds paused: " + gate.why };
  }
  ledger.lastRoundMs = now;
  soilInflight = soilHarvest()
    .then(function (p) { saveStoreSoon(); return p; })
    .finally(function () { soilInflight = null; });
  return soilInflight;
}

async function soilHarvest() {

  /* One network per query, same as the rain feed: USCRN being slow
     should not take ECONet's readings down with it. */
  const data = {}, meta = {}, dropped = [];
  const reqBefore = ledger.requests, dpBefore = ledger.datapoints;
  for (const loc of locVariants(CLOUDS_LOC)) {
    try {
      harvest(await cloudsData({ loc: loc, var: SOIL_VARS.join(","), data_limit: "last" }, SOIL_VARS.length * 6), null, data);
      Object.assign(meta, await stationMeta(loc, SOIL_VARS.join(",")));
    } catch (e) {
      /* Keep the upstream reason. "query:type=ECONET" alone cannot tell
         a quota rejection from a timeout, and the 5-6 Aug outage was
         undiagnosable from the payload for exactly that reason. */
      dropped.push("query:" + loc.split(";")[0] + ":" + String(e.message || e).slice(0, 240));
    }
  }

  /* Staleness is a question about the CLOCK, not about the value.
     An earlier version of this flagged any probe whose value hadn't
     moved across twelve hourly readings and nulled it — which dropped
     good data from fourteen stations, because ECONet publishes soil
     moisture to two decimal places. FLET genuinely sat at 0.44 for
     thirty hours and then moved to 0.45; over six days it reports two
     distinct values and FRYI reports two. That is coarse precision on a
     slow-moving quantity, not a dead sensor. Compare the reading's own
     timestamp instead: that catches a station that has actually stopped
     and cannot be fooled by precision. */
  /* Measure each station against the FRESHEST station in the same
     payload, never against our own wall clock. CLOUDS sends timestamps
     with no zone marker, this container runs in UTC, and the first
     version of this compared the two directly — which made every
     station look four hours old and dropped all three USCRN sites,
     including the one 0.8 mi from Bent Creek. Relative freshness needs
     no timezone assumption at all: whatever zone CLOUDS is using, it
     is using the same one for every station, so the offset cancels. */
  const STALE_HOURS = 8;
  const stale = [];
  function stamp(at) {
    const m2 = String(at || "").match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
    return m2 ? Date.UTC(+m2[1], +m2[2] - 1, +m2[3], +m2[4], +m2[5]) : null;
  }
  let newest = null;
  for (const id of Object.keys(data)) {
    const s = stamp(data[id].at);
    if (s !== null && (newest === null || s > newest)) newest = s;
  }

  const stations = Object.keys(data).map(function (id) {
    const d = data[id], m = meta[id] || {};
    const s = stamp(d.at);
    const age = (s === null || newest === null) ? null
      : Math.round((newest - s) / 360000) / 10;   /* hours behind the freshest */
    const dead = age != null && age > STALE_HOURS;
    if (dead) stale.push(id + ":" + Math.round(age) + "h behind");
    return {
      id: id,
      name: d.name || m.name || id,
      lat: d.lat != null ? d.lat : (m.lat != null ? m.lat : null),
      lon: d.lon != null ? d.lon : (m.lon != null ? m.lon : null),
      elev: d.elev != null ? d.elev : (m.elev != null ? m.elev : null),
      soilmoist: dead ? null : normaliseMoisture(d.soilmoist),
      soiltemp: dead || d.soiltemp == null ? null : d.soiltemp,
      at: d.at || null,
      /* hours behind the freshest station in this payload, not wall-clock age */
      behindHours: age
    };
  }).filter(function (s) {
    return s.lat != null && s.lon != null &&
      (s.soilmoist != null || s.soiltemp != null);
  });

  /* Measured weather is a bonus — never fail the soil payload over it. */
  let wx = [];
  try { wx = await wxSeries(dropped); } catch (e) { dropped.push("wx:" + String(e.message || e).slice(0, 60)); }
  let coco = [];
  try { coco = await cocoSeries(dropped); } catch (e) { dropped.push("coco:" + String(e.message || e).slice(0, 60)); }

  /* One line per round with what it cost. The `wx delta` and `coco
     refetch` lines above say what each feed did; this one says what the
     round did to the month. `dropped` rides along so a bad round names
     its reasons in the log, not only in a payload nobody fetched. */
  const reqUsed = ledger.requests - reqBefore, dpUsed = ledger.datapoints - dpBefore;
  if (reqUsed > 0) ledger.lastRoundDp = dpUsed;
  console.log("clouds round: " + stations.length + " stations, " + wx.length + " gauges, " +
    coco.length + " coco; +" + reqUsed + " req, +" + dpUsed + " dp; month " +
    ledger.requests + "/" + reqBudgetNow(monthWindow(Date.now())) + " req, " +
    ledger.datapoints + "/" + dpBudgetNow(monthWindow(Date.now())) + " dp" +
    (dropped.length ? "; dropped: " + dropped.join(" | ").replace(/\s+/g, " ").slice(0, 600) : ""));

  /* `dropped` is the tell for a truncated upstream response. It is in the
     payload rather than only in the logs so a bad day is one fetch away
     from being visible, not a log search. */
  const payload = { stations: stations, wx: wx, coco: coco, fetched: new Date().toISOString() };
  if (dropped.length) payload.dropped = dropped;
  /* Named, not silent: a stuck probe is a thing to go fix or report to
     the network, not just something to hide from the page. */
  if (stale.length) payload.stale = stale;

  /* Cache policy. On 5 Aug 2026 a harvest where every query dropped
     produced {stations:0, wx:0, coco:0} — and it was cached over the
     last good payload and served to every visitor for 20 minutes.
     An empty harvest is a fact about UPSTREAM, not about the weather:
     keep serving the last good data, say it is degraded, and retry
     upstream on the short TTL rather than the long one. */
  const empty = !stations.length && !wx.length && !coco.length;
  if (!empty) {
    /* Since the wx and coco stores self-heal across an outage (15 Aug
       2026), "some list is non-empty" no longer proves upstream is
       healthy — the soil-station queries are the part still fetched
       fresh every harvest. A station-less payload with store-served
       rain is worth serving, but on the short TTL so upstream gets
       retried in minutes, and it is never banked as the last GOOD
       payload (that would evict real station rows from the fallback). */
    if (stations.length) soilGood = payload;
    soilCache = { at: Date.now(), ttl: stations.length ? SOIL_TTL : SOIL_FAIL_TTL, payload: payload };
    return payload;
  }
  if (soilGood) {
    const out = {
      stations: soilGood.stations, wx: soilGood.wx, coco: soilGood.coco,
      fetched: soilGood.fetched,
      /* the page footer keys on `dropped`, so a stale serve is visibly
         degraded rather than silently old */
      dropped: (dropped.length ? dropped : []).concat(
        ["serving last good payload from " + soilGood.fetched]),
      degraded: true, refetched: payload.fetched
    };
    if (soilGood.stale) out.stale = soilGood.stale;
    soilCache = { at: Date.now(), ttl: SOIL_FAIL_TTL, payload: out };
    return out;
  }
  /* Nothing good to fall back on (cold start into a broken upstream):
     serve the empty payload but only briefly. */
  soilCache = { at: Date.now(), ttl: SOIL_FAIL_TTL, payload: payload };
  return payload;
}

/* ==================== the store on disk ====================
   Everything fetched from CLOUDS lived only in process memory — the
   72-hour wx window, the CoCoRaHS rows, station coordinates, the last
   soil payload. A deploy threw all of it away: every boot re-pulled 72
   hours for three networks (~9,500 datapoints, six requests), the first
   visitor after a deploy waited on that pull (79 seconds on 10 Sep
   2026), and the budget ledger above would have restarted from zero on
   every restart, which is the one thing a monthly ledger must not do.
   The volume at DATA_DIR already holds the ratings; it holds this too.
   Written atomically (tmp, then rename) a couple of seconds after any
   round that changed something, and on SIGTERM. A missing or unreadable
   file is a cold boot — the old behaviour, nothing worse.
   ======================================================= */
const STORE_FILE = path.join(DATA_DIR, "clouds-store.json");
const STORE_V = 1;
let storeTimer = null;

function packStore() {
  return {
    v: STORE_V, savedAt: new Date().toISOString(),
    wxStore: wxStore, cocoCache: cocoCache, cocoMetaCache: cocoMetaCache, metaCache: metaCache,
    soilGood: soilGood, soilCache: soilCache, ledger: ledger, trailCache: trailCache
  };
}

/* Shape-check each section on its own: one bad section costs that
   section a cold start, not the whole store. Pure — the tests lift it. */
function unpackStore(raw) {
  if (!raw || typeof raw !== "object" || raw.v !== 1) return null;
  const obj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
  return {
    wxStore: obj(raw.wxStore) && obj(raw.wxStore.byId) ? raw.wxStore : null,
    cocoCache: obj(raw.cocoCache) && Array.isArray(raw.cocoCache.rows) ? raw.cocoCache : null,
    cocoMetaCache: obj(raw.cocoMetaCache) && obj(raw.cocoMetaCache.byId) ? raw.cocoMetaCache : null,
    metaCache: obj(raw.metaCache) ? raw.metaCache : null,
    soilGood: obj(raw.soilGood) && Array.isArray(raw.soilGood.stations) ? raw.soilGood : null,
    soilCache: obj(raw.soilCache) && obj(raw.soilCache.payload) && typeof raw.soilCache.at === "number" ? raw.soilCache : null,
    ledger: obj(raw.ledger) && typeof raw.ledger.requests === "number" && typeof raw.ledger.month === "string" ? raw.ledger : null,
    trailCache: obj(raw.trailCache) && Array.isArray(raw.trailCache.list) ? raw.trailCache : null
  };
}

function loadStore() {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(STORE_FILE, "utf8")); }
  catch (e) { return "cold: no readable store at " + STORE_FILE; }
  const s = unpackStore(raw);
  if (!s) return "cold: store at " + STORE_FILE + " is v" + (raw && raw.v) + ", wanted v" + STORE_V;
  if (s.wxStore) {
    wxStore = Object.assign({ fetchedAt: {}, newestKey: {}, seenIds: {}, byId: {},
                              lastFetchMs: 0, failStreak: 0, failUntilMs: 0 }, s.wxStore);
  }
  if (s.cocoCache) cocoCache = s.cocoCache;
  if (s.cocoMetaCache) cocoMetaCache = s.cocoMetaCache;
  if (s.metaCache) metaCache = s.metaCache;
  if (s.soilGood) soilGood = s.soilGood;
  if (s.soilCache) soilCache = s.soilCache;
  if (s.ledger) ledger = Object.assign({ startedMs: 0, failures: 0, blockedUntil: 0, lastRoundMs: 0, lastRoundDp: 0 }, s.ledger);
  if (s.trailCache) trailCache = s.trailCache;
  return "warm: saved " + raw.savedAt + ", " + Object.keys(wxStore.byId).length + " gauges, " +
    (cocoCache.rows || []).length + " coco rows, soil payload " +
    (soilCache.payload ? "from " + soilCache.payload.fetched : "none") +
    ", ledger " + ledger.month + " at " + ledger.requests + " req / " + ledger.datapoints + " dp";
}

function saveStoreNow() {
  if (storeTimer) { clearTimeout(storeTimer); storeTimer = null; }
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STORE_FILE + ".tmp", JSON.stringify(packStore()));
    fs.renameSync(STORE_FILE + ".tmp", STORE_FILE);
  } catch (e) { console.log("store save failed: " + (e && e.message)); }
}
function saveStoreSoon() {
  if (storeTimer) return;
  storeTimer = setTimeout(function () { storeTimer = null; saveStoreNow(); }, 2000);
  if (storeTimer.unref) storeTimer.unref();
}

/* Requests one round will make: one per network for soil and wx, plus
   CoCoRaHS when its cache has expired. Metadata lookups are rare (a
   week apart) and left out of the spacing; the ledger still counts them. */
function roundRequests() {
  const now = Date.now();
  const cocoDue = !(cocoCache.rows && now - cocoCache.at < COCO_TTL) &&
                  !(cocoCache.emptyAt && now - cocoCache.emptyAt < COCO_TTL);
  return locVariants(CLOUDS_LOC).length + locVariants(CLOUDS_WX_LOC).length + (cocoDue ? 1 : 0);
}

/* What /status says. `ok` is about OUR data being current — soil
   payload under 6h old, rain gauges reached inside 12h — because those
   are the conditions a pinger should wake someone for. CoCoRaHS going
   quiet and a budget pause are warnings: real, worth reading, not worth
   an alarm (CoCoRaHS went quiet for a week in Sep 2026 through no fault
   of ours). Ages are wall-clock ages of OUR fetches, never CLOUDS
   timestamps against our clock — see the timezone note in soilHarvest. */
function statusReport() {
  const now = Date.now();
  const w = rollLedger(now);
  let newestHour = "";
  for (const id of Object.keys(wxStore.byId)) {
    for (const k of Object.keys(wxStore.byId[id].hours || {})) if (k > newestHour) newestHour = k;
  }
  const minsAgo = (ms) => (ms ? Math.round((now - ms) / 60000) : null);
  /* Freshness is the age of the last payload that CARRIED STATIONS
     (soilGood), not of the last round: a round that fails upstream still
     caches a station-less payload on the short TTL, and judging by that
     stamp made a dead upstream look fresh in the 10 Sep local check. */
  const goodMs = soilGood && soilGood.fetched ? Date.parse(soilGood.fetched) : 0;
  const soilAge = minsAgo(goodMs), wxAge = minsAgo(wxStore.lastFetchMs), cocoAge = minsAgo(cocoCache.at);
  const stationsNow = soilCache.payload ? (soilCache.payload.stations || []).length : 0;
  const cocoDates = (cocoCache.rows || []).map((r) => r.date).filter(Boolean).sort();
  const cocoNewest = cocoDates.length ? cocoDates[cocoDates.length - 1] : null;
  const gate = mayFetch(now, roundRequests());
  const problems = [], warnings = [];
  if (!CLOUDS_HASH) problems.push("CLOUDS_HASH not set — no measured data at all");
  else {
    if (soilAge === null) problems.push("no soil stations yet");
    else if (soilAge > 6 * 60) problems.push("last soil stations are " + soilAge + " min old");
    if (wxAge === null) problems.push("rain gauges never reached");
    else if (wxAge > 12 * 60) problems.push("rain gauges last reached " + wxAge + " min ago");
    if (soilCache.payload && soilCache.payload.degraded) warnings.push("serving last good soil payload");
    else if (soilCache.payload && !stationsNow && soilAge !== null) warnings.push("latest round returned no soil stations; page shows none");
    const cutoff = new Date(now - 3 * 86400000).toISOString().slice(0, 10);
    if (!cocoNewest) warnings.push("no CoCoRaHS rows");
    else if (cocoNewest < cutoff) {
      warnings.push("CoCoRaHS newest row is " + cocoNewest +
        " — the page hides rows over two days old, so the cross-check is off");
    }
    if (ledger.blockedUntil > now) warnings.push("CLOUDS quota lockout until " + new Date(ledger.blockedUntil).toISOString());
    else if (!gate.ok && gate.why !== "pacing") warnings.push("upstream paused: " + gate.why);
    if (wxStore.failStreak) warnings.push(wxStore.failStreak + " consecutive failed rain rounds");
  }
  return {
    ok: !problems.length, problems: problems, warnings: warnings,
    soil: {
      fetched: soilCache.payload ? soilCache.payload.fetched : null,
      lastStationsAt: goodMs ? soilGood.fetched : null, lastStationsAgeMin: soilAge,
      stations: stationsNow,
      degraded: !!(soilCache.payload && soilCache.payload.degraded),
      dropped: (soilCache.payload && soilCache.payload.dropped) || []
    },
    wx: {
      gauges: Object.keys(wxStore.byId).length, newestHour: newestHour || null,
      lastReachedMin: wxAge, failStreak: wxStore.failStreak || 0
    },
    coco: { observers: (cocoCache.rows || []).length, newestDate: cocoNewest, fetchedMin: cocoAge,
            lastEmptyMin: minsAgo(cocoCache.emptyAt) },
    budget: {
      month: ledger.month, requests: ledger.requests, requestBudget: reqBudgetNow(w),
      datapoints: ledger.datapoints, datapointBudget: dpBudgetNow(w), failedCalls: ledger.failures,
      configured: { requests: REQ_BUDGET, datapoints: DP_BUDGET },
      ledgerBegan: ledger.startedMs ? new Date(ledger.startedMs).toISOString() : null,
      monthElapsedPct: Math.round(100 * (now - w.startMs) / (w.endMs - w.startMs)),
      lockedUntil: ledger.blockedUntil > now ? new Date(ledger.blockedUntil).toISOString() : null
    },
    nextRound: gate.ok ? "allowed now" : (gate.why + (gate.waitMs ? " — " + Math.ceil(gate.waitMs / 60000) + " min" : "")),
    lastErrors: lastErrors, ratings: readAll().length, uptimeMin: Math.round(process.uptime() / 60)
  };
}

/* Keep the store warm on the budget's own cadence, visitors or not.
   Ticks every minute; a round only actually happens when the cache is
   past its TTL AND the pacer says it fits — so with nobody looking the
   data is still never more than ~2 hours behind, and the first visitor
   after a quiet week gets a warm payload in milliseconds instead of a
   72-hour re-pull. CLAUDE.md asked for exactly this: "warm the cache on
   boot rather than making the first visitor pay." Also prints the
   budget line once a day so the month's spend is in the deploy log. */
let budgetLoggedMs = 0;
function scheduleKeepWarm() {
  const tick = function () {
    const now = Date.now();
    if (now - budgetLoggedMs > 24 * 3600000) { budgetLoggedMs = now; console.log(budgetLine()); }
    if (soilCache.payload && now - soilCache.at < soilCache.ttl) return;
    soilPayload().catch(function (e) { console.log("keep-warm round failed: " + (e && e.message)); });
  };
  setTimeout(tick, 15 * 1000).unref?.();
  setInterval(tick, 60 * 1000).unref?.();
}

/* ------------------------- server ------------------------- */

const server = http.createServer(function (req, res) {
  const url = new URL(req.url, "http://x");
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    return res.end();
  }

  if (req.method === "GET" && url.pathname === "/health") {
    const n = readAll().length;
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, ratings: n }));
  }

  /* Liveness is /health (always 200 — the process is up). THIS is
     whether the data is any good: 503 when the measured feeds have gone
     stale, so a free uptime pinger pointed here raises the alarm that
     five silent days in Sep 2026 never did. */
  if (req.method === "GET" && url.pathname === "/status") {
    const st = statusReport();
    res.writeHead(st.ok ? 200 : 503, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    return res.end(JSON.stringify(st));
  }

  if (req.method === "GET" && url.pathname === "/export.csv") {
    if (!tokenOk(url.searchParams.get("token"))) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      return res.end("Forbidden");
    }
    const rows = readAll();
    let out = CSV_HEADER.join(",") + "\n";
    for (const r of rows) {
      const known = CREW.indexOf(String(r.reporter_name || "").trim().toLowerCase()) !== -1 ? "yes" : "no";
      out += FIELDS.map(function (f) { return csvCell(r[f]); })
        .concat([known, csvCell(r.received_at)]).join(",") + "\n";
    }
    res.writeHead(200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="altar-ratings.csv"'
    });
    return res.end(out);
  }

  if (req.method === "GET" && url.pathname === "/soil") {
    soilPayload()
      .then(function (p) {
        /* max-age was 600: the page's Refresh button could not actually
           re-fetch for 10 minutes because the browser served its own
           copy. 60s still absorbs reload-spam without hiding a recovery. */
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "public, max-age=60" });
        res.end(JSON.stringify(p));
      })
      .catch(function (e) {
        /* Never fail the page over this — it is supplementary data. */
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ stations: [], wx: [], coco: [], error: String(e.message || e).slice(0, 160) }));
      });
    return;
  }

  /* Shape-check the upstream response while wiring CLOUDS up. Token
     protected, and the hash is scrubbed in case it ever echoes back. */
  if (req.method === "GET" && url.pathname === "/soil/raw") {
    if (!tokenOk(url.searchParams.get("token"))) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      return res.end("Forbidden");
    }
    const which = url.searchParams.get("type") === "meta"
      ? { type: "meta", var: SOIL_VARS.join(",") }
      : { var: SOIL_VARS.join(","), data_limit: "last" };
    /* narrow the response while debugging: ?loc=FLET&metadata=no&section=data
       `var` matters as much as the rest — without it every query silently
       asked for soil moisture, which made other networks look empty when
       they were only being asked the wrong question. */
    ["loc", "var", "metadata", "start", "end", "int", "obtype", "qclimit"].forEach(function (k) {
      const v = url.searchParams.get(k);
      if (v) which[k] = v;
    });
    const section = url.searchParams.get("section");
    (CLOUDS_HASH ? cloudsData(which, 0) : Promise.reject(new Error("CLOUDS_HASH not set")))
      .then(function (j) {
        /* compact=1 flattens a station-metadata response to one small
           row per station. CLOUDS wraps every field in a {name,value}
           envelope, so a single county of CoCoRaHS metadata runs past
           100KB raw — far too big to eyeball. Add near=lat,lon to sort
           by distance and the answer fits in a couple of lines. */
        if (url.searchParams.get("compact")) {
          const loc = (j.metadata && j.metadata.location) || j.location || {};
          const g = (s, k) => (s[k] && s[k].value !== undefined ? s[k].value : null);
          let rows = Object.keys(loc).map(function (id) {
            const s = loc[id] || {};
            return {
              id: id, name: g(s, "name"), county: g(s, "county"),
              active: g(s, "data_active"), end: g(s, "data_end") || g(s, "date_end"),
              lat: numOf(g(s, "lat")), lon: numOf(g(s, "lon")), elev: numOf(g(s, "elev"))
            };
          }).filter((r) => r.lat != null && r.lon != null);

          if (url.searchParams.get("activeonly") !== "0") {
            rows = rows.filter((r) => String(r.active).toLowerCase() !== "no");
          }
          const near = url.searchParams.get("near");
          if (near) {
            const parts = String(near).split(",").map(Number);
            if (parts.length === 2 && parts.every((n) => !isNaN(n))) {
              rows.forEach(function (r) {
                r.mi = Math.round(milesBetween(parts[0], parts[1], r.lat, r.lon) * 10) / 10;
              });
              rows.sort((a, b) => a.mi - b.mi);
            }
          }
          const limit = Math.min(parseInt(url.searchParams.get("limit") || "20", 10) || 20, 300);
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ total: rows.length, stations: rows.slice(0, limit) }));
        }

        let s = JSON.stringify(section && j[section] !== undefined ? j[section] : j).slice(0, 200000);
        if (CLOUDS_HASH) s = s.split(CLOUDS_HASH).join("[redacted]");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(s);
      })
      .catch(function (e) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(e.message || e).slice(0, 300) }));
      });
    return;
  }

  if (req.method === "POST") {
    const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "?")
      .toString().split(",")[0].trim();
    if (rateLimited(ip)) {
      res.writeHead(429, { "Content-Type": "text/plain" });
      return res.end("Slow down");
    }
    let body = "", dead = false;
    req.on("data", function (chunk) {
      body += chunk;
      if (body.length > MAX_BODY) { dead = true; req.destroy(); }
    });
    req.on("end", function () {
      if (dead) return;
      let items;
      try { items = JSON.parse(body); } catch (e) { items = null; }
      if (!Array.isArray(items)) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        return res.end("Expected a JSON array");
      }
      const kept = [];
      for (const it of items.slice(0, MAX_ITEMS)) {
        const s = sanitize(it);
        if (s) kept.push(s);
      }
      if (kept.length) {
        const lines = kept.map(function (r) { return JSON.stringify(r); }).join("\n") + "\n";
        fs.appendFileSync(DATA_FILE, lines);
      }
      res.writeHead(204);
      res.end();
    });
    return;
  }

  /* How wrong has the forecast been, per trail. Token-gated because it
     is diagnostic rather than something a rider needs. */
  if (req.method === "GET" && url.pathname === "/grade") {
    if (!tokenOk(url.searchParams.get("token"))) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      return res.end("Forbidden");
    }
    const run = url.searchParams.get("run");
    const finish = function (extra) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(Object.assign({
        summary: gradeSummary(), runs: gradeHistory().length
      }, extra || {})));
    };
    if (run) gradeOnce().then((r) => finish({ ran: r })).catch((e) => finish({ ran: { error: String(e.message || e) } }));
    else finish();
    return;
  }

  if (req.method === "GET" && url.pathname === "/grade.csv") {
    if (!tokenOk(url.searchParams.get("token"))) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      return res.end("Forbidden");
    }
    const cols = ["at", "trail", "gauge", "gauge_mi", "hours", "forecast_in",
      "measured_in", "bias_in", "max_hour_err_in", "missed_hours", "missed_in", "phantom_hours"];
    let out = cols.join(",") + "\n";
    for (const r of gradeHistory()) out += cols.map((c) => csvCell(r[c])).join(",") + "\n";
    res.writeHead(200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="altar-forecast-grade.csv"'
    });
    return res.end(out);
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

const storeState = loadStore();
server.listen(PORT, function () {
  console.log("feedback service on :" + PORT + ", data at " + DATA_FILE +
    (EXPORT_TOKEN ? "" : "  [WARN: EXPORT_TOKEN not set — export disabled]"));
  console.log("clouds store " + storeState);
  /* The effective knobs, because a Railway variable silently wins over
     every default in this file and nobody can read the variables back
     through the MCP. */
  const mins = (ms) => Math.round(ms / 60000) + "m";
  console.log("clouds config: soil TTL " + mins(SOIL_TTL) + " (fail " + mins(SOIL_FAIL_TTL) + "), wx floor " +
    mins(WX_MIN_INTERVAL) + ", coco TTL " + mins(COCO_TTL) + ", meta TTL 7d, upstream timeout " +
    mins(CLOUDS_TIMEOUT_MS) + ", budget " + REQ_BUDGET + " req / " + DP_BUDGET + " dp per month" +
    (CLOUDS_HASH ? "" : ", CLOUDS_HASH NOT SET") +
    ["CLOUDS_LOC", "CLOUDS_WX_LOC", "CLOUDS_COCO_LOC"].filter((k) => process.env[k]).map((k) => ", " + k + " set in env").join(""));
  console.log("clouds selectors: soil [" + CLOUDS_LOC + "] wx [" + CLOUDS_WX_LOC + "] coco [" + CLOUDS_COCO_LOC + "]");
  console.log(budgetLine());
  budgetLoggedMs = Date.now();
});

/* Railway sends SIGTERM before it swaps a deploy in. Flush the store so
   the next process boots warm, then go. */
process.on("SIGTERM", function () {
  saveStoreNow();
  server.close(function () { process.exit(0); });
  setTimeout(function () { process.exit(0); }, 3000).unref?.();
});

/* Grade the forecast daily, in-process. A minute after boot rather than
   immediately, so a redeploy never has the grader competing with the
   first visitor for the CLOUDS cache. Wrapped so a failure here can
   never take the service down — the ratings endpoint matters more than
   the diagnostics do. Deploys are frequent enough that this will
   sometimes run twice in a day; duplicate rows are harmless because the
   summary averages over runs. */
function scheduleGrading() {
  const run = function () {
    gradeOnce()
      .then(function (r) { console.log("forecast grade: " + JSON.stringify(r.graded !== undefined ? { graded: r.graded } : r)); })
      .catch(function (e) { console.log("forecast grade failed: " + (e && e.message)); });
  };
  setTimeout(run, 60 * 1000).unref?.();
  setInterval(run, GRADE_EVERY_MS).unref?.();
}
if (CLOUDS_HASH) { scheduleGrading(); scheduleKeepWarm(); }
else console.log("forecast grading off — CLOUDS_HASH not set, no gauges to grade against");
