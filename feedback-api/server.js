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

const SOIL_TTL = 20 * 60 * 1000;   // both networks publish hourly

let soilCache = { at: 0, payload: null };
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
  } catch (e) { /* coordinates are optional */ }
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
    } catch (e) { if (dropped) dropped.push("query:" + loc.split(";")[0]); continue; }
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
        const et = numOf(unwrap(rec.evaptrans_pm));
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
  } catch (e) { /* metadata is optional; observers without coords are counted below */ }
  cocoMetaCache = { at: Date.now(), byId: byId };
  return byId;
}

async function cocoSeries(dropped) {
  let j;
  try {
    j = await cloudsJson(cloudsUrl({
      loc: CLOUDS_COCO_LOC, var: "precip",
      start: "-2 days", end: "now", int: "1 day", obtype: "D", metadata: "no"
    }));
  } catch (e) {
    if (dropped) dropped.push("coco:" + String(e.message || e).slice(0, 60));
    return [];
  }
  const data = j.data || {};
  const meta = await cocoMeta();
  const out = [];
  let unplaced = 0;
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
    if (!best) continue;
    const m = meta[id];
    if (!m) { unplaced++; continue; }
    out.push({ id: id, name: m.name || id, lat: m.lat, lon: m.lon,
               elev: m.elev == null ? null : m.elev, date: best.date, precip: best.precip });
  }
  /* One line, not one per observer — there can be dozens. */
  if (unplaced && dropped) dropped.push("coco:" + unplaced + " observers without coordinates");
  return out;
}

async function soilPayload() {
  if (soilCache.payload && Date.now() - soilCache.at < SOIL_TTL) return soilCache.payload;
  if (!CLOUDS_HASH) return { stations: [], wx: [], coco: [], note: "CLOUDS_HASH not set" };

  /* One network per query, same as the rain feed: USCRN being slow
     should not take ECONet's readings down with it. */
  const data = {}, meta = {}, dropped = [];
  for (const loc of locVariants(CLOUDS_LOC)) {
    try {
      harvest(await cloudsJson(cloudsUrl({ loc: loc, var: SOIL_VARS.join(","), data_limit: "last" })), null, data);
      Object.assign(meta, await stationMeta(loc, SOIL_VARS.join(",")));
    } catch (e) { dropped.push("query:" + loc.split(";")[0]); }
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
  const STALE_HOURS = 6;
  const stale = [];
  const nowMs = Date.now();
  function ageHours(at) {
    if (!at) return null;
    /* CLOUDS timestamps are local Eastern with no zone marker. Treating
       them as UTC would make everything look 4-5 hours old, so parse the
       wall clock and compare against the same wall clock here. */
    const m2 = String(at).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
    if (!m2) return null;
    const asUtc = Date.UTC(+m2[1], +m2[2] - 1, +m2[3], +m2[4], +m2[5]);
    const nowLocalAsUtc = nowMs + new Date().getTimezoneOffset() * -60000;
    return (nowLocalAsUtc - asUtc) / 3600000;
  }

  const stations = Object.keys(data).map(function (id) {
    const d = data[id], m = meta[id] || {};
    const age = ageHours(d.at);
    const dead = age != null && age > STALE_HOURS;
    if (dead) stale.push(id + ":" + Math.round(age) + "h old");
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
      ageHours: age == null ? null : Math.round(age * 10) / 10
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
  soilCache = { at: Date.now(), payload: payload };
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
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "public, max-age=600" });
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

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

server.listen(PORT, function () {
  console.log("feedback service on :" + PORT + ", data at " + DATA_FILE +
    (EXPORT_TOKEN ? "" : "  [WARN: EXPORT_TOKEN not set — export disabled]"));
});
