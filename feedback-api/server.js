/* ============================================================
   Altar Cycles — trail conditions feedback service
   Zero-dependency Node server. Receives rider ratings from the
   trail conditions page and stores them as JSON lines on disk.

   Endpoints:
     POST /                → store ratings (body: JSON array, text/plain)
     GET  /export.csv?token=… → CSV of all ratings (EXPORT_TOKEN required)
     GET  /health          → { ok, count }

   Env vars:
     PORT          provided by Railway
     DATA_DIR      where ratings.jsonl lives — set to the volume
                   mount path (e.g. /data). Default: ./data
     EXPORT_TOKEN  required. Without a matching ?token= the export
                   returns 403. Generate something long and random.
     CREW          comma-separated reporter names Matt trusts,
                   case-insensitive ("Matt, Sarah C, Dave").
                   Sets the known_crew column in the export.
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
     CLOUDS_LOC   station selector, default "type=ECONET;state=NC".
   ============================================================ */

const CLOUDS_URL = "https://api.climate.ncsu.edu/data.php";
const CLOUDS_HASH = process.env.CLOUDS_HASH || "";

/* Soil sensors. USCRN is the US Climate Reference Network — research
   grade, and one of its sites sits 0.8 miles from Bent Creek, far
   closer than any ECONet station. Note the units differ between the
   two networks; normaliseMoisture() below handles that. */
const CLOUDS_LOC = process.env.CLOUDS_LOC || "type=ECONET,USCRN;state=NC";
const SOIL_VARS = ["soilmoist", "soilmoist20cm", "soiltemp"];

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
   networks, one query; a rain gauge is a rain gauge. */
const CLOUDS_WX_LOC = process.env.CLOUDS_WX_LOC ||
  "type=RAWS,USCRN,ECONET;county=Transylvania County,Henderson County,Buncombe County," +
  "Haywood County,Madison County,Burke County,Caldwell County,Yancey County,McDowell County," +
  "Polk County,Avery County,Watauga County,Mitchell County,Rutherford County";
const WX_VARS = ["precip", "evaptrans_pm"];

/* CoCoRaHS: volunteer daily rain gauges — a tube in somebody's garden,
   read each morning. Daily and manual, so it can never feed the hourly
   water balance; it rides along as a cross-check for trails with no
   hourly gauge close enough to score from. Ride Kanuga has an observer
   0.8 mi out where its nearest hourly gauge is 6 mi; Hatley's best is
   7.2 mi where hourly offers nothing under 10. Scoped to the counties
   holding (or about to hold) such trails, not the full mountain list —
   observers are dense and every one of these rows ships to the page. */
const CLOUDS_COCO_LOC = process.env.CLOUDS_COCO_LOC ||
  "type=COCORAHS;county=Henderson County,Madison County,Buncombe County," +
  "McDowell County,Yancey County,Caldwell County";

/* Both networks publish hourly, so polling faster than hourly buys
   nothing — and CLOUDS quota is the binding constraint: the public tier
   allows 2,000 requests/month and this service fires six per refresh.
   At the old 20-minute TTL that is ~13,000/month, which is the likely
   cause of the 5-6 Aug 2026 outage where every query dropped for hours.
   60 minutes = ~4,300/month. Still over if traffic is steady — the real
   fix is a higher CLOUDS tier (email NCSCO), but this triples headroom. */
const SOIL_TTL = 60 * 60 * 1000;
/* How long to sit on a FAILED harvest before trying upstream again.
   Long enough not to hammer a struggling API, short enough that the
   page is not stuck with a bad payload for a full hour. */
const SOIL_FAIL_TTL = 5 * 60 * 1000;

let soilCache = { at: 0, ttl: 0, payload: null };
let soilGood = null;       /* last harvest that actually carried data */
let soilInflight = null;   /* single-flight: concurrent misses share one harvest */
let metaCache = {};   // keyed by loc

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
  const r = await fetch(url, { headers: { "User-Agent": "AltarCycles-TrailConditions" } });
  const text = await r.text();
  if (!r.ok) throw new Error("CLOUDS " + r.status);
  try { return JSON.parse(text); }
  catch (e) { throw new Error("CLOUDS returned non-JSON (" + text.slice(0, 80) + ")"); }
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
   worth three cheap requests every twenty minutes. It is NOT a truncation
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
  if (hit && Date.now() - hit.at < 24 * 3600 * 1000) return hit.byId;
  const out = {};
  try {
    harvest(await cloudsJson(cloudsUrl({ type: "meta", loc: loc, var: vars })), null, out);
  } catch (e) {
    /* One failed metadata call used to cache an EMPTY coordinate map for
       24 hours, which dropped every gauge in the network as ":nocoords"
       for a day. Coordinates change ~never: on failure, serve the old
       map if we have one and leave the cache alone so the next call
       retries upstream. */
    if (hit) return hit.byId;
  }
  /* Same guard for a 200 that harvests nothing: never replace a
     populated map with an empty one. */
  if (!Object.keys(out).length && hit && Object.keys(hit.byId).length) return hit.byId;
  metaCache[loc] = { at: Date.now(), byId: out };
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
   Three days back is exactly what the page's water balance needs to
   rebuild its store from measured rather than forecast rain. */
async function wxSeries(dropped) {
  const out = [], seen = {};
  for (const loc of locVariants(CLOUDS_WX_LOC)) {
    let j;
    /* One network being down must not cost us the other two. */
    try {
      j = await cloudsJson(cloudsUrl({
        loc: loc, var: WX_VARS.join(","),
        start: "-3 days", end: "now", int: "1 hour", obtype: "H"
      }));
    } catch (e) { if (dropped) dropped.push("query:" + loc.split(";")[0] + ":" + String(e.message || e).slice(0, 44)); continue; }
    const data = j.data || {};
    const meta = await stationMeta(loc, WX_VARS.join(","));
    for (const id of Object.keys(data)) {
      if (seen[id]) continue;
      const byTime = data[id];
      if (!byTime || typeof byTime !== "object") continue;
      const hours = {};
      let n = 0;
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
        if (p === null && et === null) continue;
        /* key by local hour so it lines up with Open-Meteo's timestamps */
        const s = String(t);
        hours[s.slice(0, 10) + "T" + s.slice(11, 13)] = { p: p, et: et };
        n++;
      }
      if (!n) continue;
      const m = meta[id] || {};
      /* Readings but no coordinates: the station is real and we cannot
         place it, so it cannot be matched to a trail. Silently dropping
         it is how a missing gauge looks like no rain. Say so instead. */
      if (m.lat == null || m.lon == null) { if (dropped) dropped.push(id + ":nocoords"); continue; }
      seen[id] = 1;
      out.push({ id: id, name: m.name || id, lat: m.lat, lon: m.lon, elev: m.elev == null ? null : m.elev, hours: hours });
    }
  }
  return out;
}

/* CoCoRaHS ids look like NC-HN-38 — they fail the isId() regex the
   harvest() walker keys on, so this network gets its own small parser
   rather than a loosened regex that would let county names through. */
let cocoMetaCache = { at: 0, byId: null };
async function cocoMeta() {
  if (cocoMetaCache.byId && Date.now() - cocoMetaCache.at < 24 * 3600 * 1000) return cocoMetaCache.byId;
  const byId = {};
  try {
    const j = await cloudsJson(cloudsUrl({ type: "meta", loc: CLOUDS_COCO_LOC, var: "precip" }));
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
       empty map over a good one for 24 hours. */
    if (cocoMetaCache.byId && Object.keys(cocoMetaCache.byId).length) return cocoMetaCache.byId;
  }
  if (!Object.keys(byId).length && cocoMetaCache.byId && Object.keys(cocoMetaCache.byId).length) return cocoMetaCache.byId;
  cocoMetaCache = { at: Date.now(), byId: byId };
  return byId;
}

async function cocoSeries(dropped) {
  let j;
  try {
    j = await cloudsJson(cloudsUrl({
      loc: CLOUDS_COCO_LOC, var: "precip",
      /* Four days, not two. These are people reading a tube by hand: a
         window barely wider than the reporting lag leaves the whole
         network looking silent whenever anyone is a day behind, and the
         freshest-numeric-value pick below already discards the staleness
         we don't want. Widening costs one row per observer. */
      start: "-4 days", end: "now", int: "1 day", obtype: "D", metadata: "no"
    }));
  } catch (e) {
    if (dropped) dropped.push("coco:" + String(e.message || e).slice(0, 60));
    return [];
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
  if (!out.length && dropped) {
    const ids = Object.keys(data).length;
    if (!ids) dropped.push("coco:upstream returned no observers for the selector");
    else if (noNumber >= ids) dropped.push("coco:" + ids + " observers, none with a numeric daily total");
    else dropped.push("coco:" + ids + " observers returned, none usable (" +
                      noNumber + " without a number, " + unplaced + " without coordinates)");
  }
  return out;
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
  if (soilCache.payload && Date.now() - soilCache.at < soilCache.ttl) return soilCache.payload;
  if (!CLOUDS_HASH) return { stations: [], wx: [], coco: [], note: "CLOUDS_HASH not set" };
  /* Single flight. Without this, every request that lands on an expired
     cache fires its own six-query CLOUDS burst — under load that
     multiplies quota burn by the number of concurrent visitors, at the
     exact moment (TTL boundary) they pile up. */
  if (soilInflight) return soilInflight;
  soilInflight = soilHarvest().finally(function () { soilInflight = null; });
  return soilInflight;
}

async function soilHarvest() {

  /* One network per query, same as the rain feed: USCRN being slow
     should not take ECONet's readings down with it. */
  const data = {}, meta = {}, dropped = [];
  for (const loc of locVariants(CLOUDS_LOC)) {
    try {
      harvest(await cloudsJson(cloudsUrl({ loc: loc, var: SOIL_VARS.join(","), data_limit: "last" })), null, data);
      Object.assign(meta, await stationMeta(loc, SOIL_VARS.join(",")));
    } catch (e) {
      /* Keep the upstream reason. "query:type=ECONET" alone cannot tell
         a quota rejection from a timeout, and the 5-6 Aug outage was
         undiagnosable from the payload for exactly that reason. */
      dropped.push("query:" + loc.split(";")[0] + ":" + String(e.message || e).slice(0, 44));
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
      soilmoist20cm: dead ? null : normaliseMoisture(d.soilmoist20cm),
      soiltemp: dead || d.soiltemp == null ? null : d.soiltemp,
      at: d.at || null,
      /* hours behind the freshest station in this payload, not wall-clock age */
      behindHours: age
    };
  }).filter(function (s) {
    return s.lat != null && s.lon != null &&
      (s.soilmoist != null || s.soilmoist20cm != null || s.soiltemp != null);
  });

  /* Measured weather is a bonus — never fail the soil payload over it. */
  let wx = [];
  try { wx = await wxSeries(dropped); } catch (e) { dropped.push("wx:" + String(e.message || e).slice(0, 60)); }
  let coco = [];
  try { coco = await cocoSeries(dropped); } catch (e) { dropped.push("coco:" + String(e.message || e).slice(0, 60)); }

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
    soilGood = payload;
    soilCache = { at: Date.now(), ttl: SOIL_TTL, payload: payload };
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
    (CLOUDS_HASH ? cloudsJson(cloudsUrl(which)) : Promise.reject(new Error("CLOUDS_HASH not set")))
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

server.listen(PORT, function () {
  console.log("feedback service on :" + PORT + ", data at " + DATA_FILE +
    (EXPORT_TOKEN ? "" : "  [WARN: EXPORT_TOKEN not set — export disabled]"));
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
if (CLOUDS_HASH) scheduleGrading();
else console.log("forecast grading off — CLOUDS_HASH not set, no gauges to grade against");
