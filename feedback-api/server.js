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
  "rain_24h", "rain_72h", "hours_since_rain",
  "wet_mult", "dry_mult", "model_time", "tz_offset_min",
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
