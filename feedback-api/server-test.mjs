/* Unit checks for the pure helpers in server.js.

   server.js is a single zero-dependency script that calls listen() at the
   bottom, so importing it would start a server and bind a port. Rather
   than restructure it around module exports — the whole point of the file
   is that it is one plain script anybody can read top to bottom — the
   test lifts the function source out and evaluates it. Ugly, but honest:
   it tests the code that actually ships, not a copy.

   Run: node feedback-api/server-test.mjs                   (no deps) */

import { readFileSync } from "node:fs";

const src = readFileSync(new URL("./server.js", import.meta.url), "utf8");
const problems = [];

function lift(name) {
  const m = src.match(new RegExp("function " + name + "\\([\\s\\S]*?\\n\\}"));
  if (!m) throw new Error("could not find function " + name + " in server.js");
  return eval("(" + m[0] + ")");
}

/* ---------------------------------------------------------------
   locVariants — the guard against CLOUDS silently truncating a
   multi-network response. On 4 Aug 2026 one query across RAWS +
   USCRN + ECONet and fourteen counties came back as valid JSON that
   simply stopped after NCVN7, losing SMPN7 (1.6 mi from Pisgah).
   Every multi-network selector must come back split.
   --------------------------------------------------------------- */
const locVariants = lift("locVariants");

const eq = (label, got, want) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a !== b) problems.push(label + "\n  got  " + a + "\n  want " + b);
};

eq("three networks split into three queries, state and county list preserved",
  locVariants("type=RAWS,USCRN,ECONET;state=NC;county=Transylvania,Henderson"),
  ["type=RAWS;state=NC;county=Transylvania,Henderson",
   "type=USCRN;state=NC;county=Transylvania,Henderson",
   "type=ECONET;state=NC;county=Transylvania,Henderson"]);

/* The live selectors moved to this format 14 Aug 2026 (bare county
   names + a required state=NC, per the CLOUDS maintainer). The old
   "Transylvania County" long form still splits fine — locVariants
   copies every non-type segment opaquely — this fixture just mirrors
   what production actually sends now. */

eq("two networks, statewide",
  locVariants("type=ECONET,USCRN;state=NC"),
  ["type=ECONET;state=NC", "type=USCRN;state=NC"]);

eq("a single network is left alone — no extra request",
  locVariants("type=RAWS;state=NC"), ["type=RAWS;state=NC"]);

eq("no type= clause at all is left alone",
  locVariants("state=NC"), ["state=NC"]);

eq("type= not in first position still splits",
  locVariants("state=NC;type=RAWS,ECONET"),
  ["state=NC;type=RAWS", "state=NC;type=ECONET"]);

eq("stray whitespace in the type list does not leak into the query",
  locVariants("type=RAWS, USCRN ;state=NC"),
  ["type=RAWS;state=NC", "type=USCRN;state=NC"]);

/* A single station id must survive as its own selector, since that is
   what /soil/raw?loc=FLET passes through when shape-checking. */
eq("a bare station id is not mistaken for a type list",
  locVariants("FLET"), ["FLET"]);

/* ---------------------------------------------------------------
   normaliseMoisture — ECONet reports volumetric water content as a
   fraction (0.44), USCRN as a percentage (24.3). Mixing them puts a
   station that is soaked next to one that reads bone dry.
   --------------------------------------------------------------- */
const normaliseMoisture = lift("normaliseMoisture");

eq("ECONet fraction passes through", normaliseMoisture(0.44), 0.44);
eq("USCRN percentage is converted", normaliseMoisture(24.3), 0.243);
eq("null stays null", normaliseMoisture(null), null);
eq("a saturated fraction is not mistaken for a percentage", normaliseMoisture(0.6), 0.6);

/* ---------------------------------------------------------------
   parseTrails — the grader reads trail coordinates out of the live
   index.html so there is only one copy of the list. If this regex
   ever stops matching, the grader silently scores nothing; if it
   matches the WRONG numbers it scores the wrong places, which is
   worse. Checked against the real file, not a fixture.
   --------------------------------------------------------------- */
const parseTrails = lift("parseTrails");
const page = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const parsed = parseTrails(page);

if (!parsed) {
  problems.push("parseTrails found no trails in the real index.html");
} else {
  const names = parsed.map((t) => t.name);
  ["Bent Creek", "Pisgah — Lower", "Pisgah — Upper", "Hatley Pointe", "Snowshoe"]
    .forEach((n) => { if (!names.includes(n)) problems.push("parseTrails missed " + n); });

  const bent = parsed.find((t) => t.name === "Bent Creek");
  if (bent && (Math.abs(bent.lat - 35.4919) > 1e-4 || Math.abs(bent.lon + 82.6285) > 1e-4)) {
    problems.push("Bent Creek coords wrong: " + JSON.stringify(bent));
  }
  /* Every trail must land in western NC / east TN / WV — a regex that
     slid across entries would produce a plausible-looking number from
     the wrong trail, and only a bounds check catches that. */
  parsed.forEach((t) => {
    /* Widened 6 Aug 2026: Jarrod's Place (Summerville GA) sits at
       -85.16, just past the old -85 western fence. */
    if (!(t.lat > 34 && t.lat < 39.5 && t.lon > -85.5 && t.lon < -79)) {
      problems.push("coordinate out of region for " + t.name + ": " + t.lat + "," + t.lon);
    }
  });
  /* Sanity: the count should track the real list, not silently halve. */
  const declared = (page.match(/\n    \{ name: "/g) || []).length;
  if (declared && parsed.length !== declared) {
    problems.push("parsed " + parsed.length + " trails but index.html declares " + declared);
  }
}

/* ---------------------------------------------------------------
   The wx delta-fetch helpers (15 Aug 2026). The store logic is what
   keeps a 72-hour rain window honest while fetching only new hours —
   every mistake here either loses measured rain or refetches the
   world. All pure, all lifted from the shipping file.
   --------------------------------------------------------------- */
const wxFetchHours = lift("wxFetchHours");
{
  const H = 3600000, now = 1755300000000;

  eq("cold store fetches the full window", wxFetchHours(0, now, 72, 2), 72);
  eq("fresh store fetches the minimum overlap window",
    wxFetchHours(now - 30 * 60000, now, 72, 2), 3);
  eq("an 8-hour quiet gap is re-covered with overlap",
    wxFetchHours(now - 8 * H, now, 72, 2), 10);
  eq("a gap wider than the window is capped at the window",
    wxFetchHours(now - 100 * H, now, 72, 2), 72);
}

const hourKeyMs = lift("hourKeyMs");
eq("hour key parses to a stable axis", hourKeyMs("2026-08-15T13"), Date.UTC(2026, 7, 15, 13));
eq("malformed key is rejected, not guessed", hourKeyMs("2026-08-15 13:00"), null);

const mergeHours = lift("mergeHours");
eq("merge keeps old rows and lets fresh rows win",
  mergeHours({ a: { p: 0.1, et: 0.01 }, b: { p: 0, et: 0 } },
             { b: { p: 0.2, et: 0.01 }, c: { p: 0.3, et: null } }),
  { a: { p: 0.1, et: 0.01 }, b: { p: 0.2, et: 0.01 }, c: { p: 0.3, et: null } });
eq("merge tolerates an absent old side", mergeHours(null, { a: { p: 1, et: null } }), { a: { p: 1, et: null } });
eq("a null marker retracts the stored hour instead of preserving it",
  mergeHours({ a: { p: 1.22, et: 0.01 }, b: { p: 0, et: 0 } }, { a: null }),
  { b: { p: 0, et: 0 } });

const pruneHoursBefore = lift("pruneHoursBefore");
{
  const cutoff = Date.UTC(2026, 7, 12, 14);   /* 72h before 15 Aug 14:00 */
  const kept = pruneHoursBefore({
    "2026-08-12T13": { p: 0.5, et: null },    /* one hour too old — goes */
    "2026-08-12T14": { p: 0.2, et: null },    /* exactly at the cutoff — stays */
    "2026-08-15T14": { p: 0, et: 0.01 },      /* newest — stays */
    "garbage": { p: 9, et: 9 }                /* malformed — goes */
  }, cutoff);
  eq("prune drops old and malformed keys, keeps the boundary",
    Object.keys(kept).sort(), ["2026-08-12T14", "2026-08-15T14"]);
}

/* parseWxHours reads through numOf/unwrap; lift them first so the
   eval'd function finds them on this module's scope chain. */
const numOf = lift("numOf");
const unwrap = lift("unwrap");
const parseWxHours = lift("parseWxHours");
{
  const rows = parseWxHours({
    "2026-08-15 13:00:00": { precip: { value: "0.12" }, evaptrans_pm: { value: "0.254" } },
    "2026-08-15 14:00:00": { precip: { value: "MV" }, evaptrans_pm: { value: "" } },
    "2026-08-15 15:00:00": "not-an-object",
    "2026-08-15 16:00:00": {}
  });
  eq("wx rows parse to local-hour keys, ET mm->in, valueless rows become retraction markers",
    rows, { "2026-08-15T13": { p: 0.12, et: 0.01 }, "2026-08-15T14": null });
  /* a retraction marker must actually retract */
  eq("a parsed retraction deletes the stored hour end to end",
    mergeHours({ "2026-08-15T14": { p: 1.22, et: null } }, rows)["2026-08-15T14"], undefined);
}

const minutesOr = lift("minutesOr");
eq("unset TTL env falls back to the default", minutesOr(undefined, 60), 3600000);
eq("garbage TTL env falls back to the default", minutesOr("soon", 5), 300000);
eq("a real TTL override is honored", minutesOr("2", 60), 120000);
eq("zero and negatives are refused, not obeyed", minutesOr("0", 5), 300000);

/* ---------------------------------------------------------------
   milesBetween — every gauge threshold in the page depends on it.
   --------------------------------------------------------------- */
const milesBetween = lift("milesBetween");
const asheville = [35.5951, -82.5515], flet = [35.42721, -82.55888];
const d = milesBetween(asheville[0], asheville[1], flet[0], flet[1]);
if (!(d > 11 && d < 12.5)) problems.push("milesBetween: Asheville to FLET should be ~11.6 mi, got " + d.toFixed(2));
if (milesBetween(35, -82, 35, -82) !== 0) problems.push("milesBetween: a point is not zero miles from itself");

/* ---------------------------------------------------------------
   The CLOUDS budget (10 Sep 2026). Two monthly caps on the public
   tier — 2,000 requests, 300,000 datapoints — and a five-day outage
   nobody saw. The pacer, the month roll and the quota classifier are
   what keep the service inside the caps and honest about it; each is
   pure and lifted from the shipping file.
   --------------------------------------------------------------- */
const monthWindow = lift("monthWindow");
{
  const w = monthWindow(Date.UTC(2026, 8, 10, 12));           /* 10 Sep 12:00Z */
  eq("mid-month lands in that month", w.key, "2026-09");
  eq("month starts at 05:00Z on the 1st", w.startMs, Date.UTC(2026, 8, 1, 5));
  eq("month ends at 05:00Z on the next 1st", w.endMs, Date.UTC(2026, 9, 1, 5));
  eq("03:00Z on the 1st still belongs to the OLD month — NCSU has not reset yet",
    monthWindow(Date.UTC(2026, 8, 1, 3)).key, "2026-08");
  eq("06:00Z on the 1st is the new month", monthWindow(Date.UTC(2026, 8, 1, 6)).key, "2026-09");
  eq("January rolls the year", monthWindow(Date.UTC(2027, 0, 1, 3)).key, "2026-12");
}

const paceSpacingMs = lift("paceSpacingMs");
{
  const H = 3600000, now = Date.UTC(2026, 8, 1, 5), end = Date.UTC(2026, 9, 1, 5);   /* 30 days */
  const sp = paceSpacingMs(0, 1700, 5, now, end);
  if (!(sp > 2.1 * H && sp < 2.2 * H)) {
    problems.push("a fresh month at 5 req/round should space ~2.1h, got " + (sp / H).toFixed(2) + "h");
  }
  eq("a spent budget means no more rounds", paceSpacingMs(1698, 1700, 5, now, end), Infinity);
  eq("the last round that fits is allowed", paceSpacingMs(1695, 1700, 5, now, end) > 0, true);
  eq("a zero-request round never divides by zero", paceSpacingMs(0, 1700, 0, now, end), Infinity);
  eq("budget to spare at month end spaces at zero", paceSpacingMs(100, 1700, 5, end, end), 0);
  /* half the month gone, half the budget gone: same cadence as day one */
  const half = paceSpacingMs(850, 1700, 5, now + 15 * 24 * H, end);
  if (Math.abs(half - sp) > 60000) {
    problems.push("on pace mid-month should keep day-one spacing, got " + (half / H).toFixed(2) + "h vs " + (sp / H).toFixed(2) + "h");
  }
  /* half the budget gone by day 5: stretch to ~3.5h rather than blow the cap */
  const hot = paceSpacingMs(850, 1700, 5, now + 5 * 24 * H, end);
  if (!(hot > 3.4 * H && hot < 3.6 * H)) {
    problems.push("an overspent month should stretch to ~3.5h, got " + (hot / H).toFixed(2) + "h");
  }
}

const proratedBudget = lift("proratedBudget");
{
  const start = Date.UTC(2026, 8, 1, 5), end = Date.UTC(2026, 9, 1, 5);      /* 30 days */
  eq("a ledger that began at the boundary gets the whole budget", proratedBudget(1700, start, start, end), 1700);
  eq("no start recorded also gets the whole budget", proratedBudget(1700, 0, start, end), 1700);
  eq("a ledger begun with 20 days left gets two thirds", proratedBudget(1700, end - 20 * 86400000, start, end), 1133);
  eq("begun at the very end gets nothing", proratedBudget(1700, end, start, end), 0);
}

const isQuotaError = lift("isQuotaError");
eq("the 5-6 Aug 2026 text is a quota error",
  isQuotaError("CLOUDS 400 — You have exceeded your monthly data point limit of 300000 (300655 used)"), true);
eq("a request-count limit is a quota error", isQuotaError("CLOUDS 400 — Monthly request limit reached"), true);
eq("the per-request cap is NOT a month-long condition",
  isQuotaError("CLOUDS 400 — request exceeds 25000 data points per request"), false);
eq("a timeout is not a quota error", isQuotaError("The operation was aborted due to timeout"), false);
eq("a 502 is not a quota error", isQuotaError("CLOUDS 502 — Bad Gateway"), false);
eq("non-JSON is not a quota error", isQuotaError("CLOUDS returned non-JSON (<html>)"), false);
eq("empty is not a quota error", isQuotaError(""), false);

const failFloorMs = lift("failFloorMs");
eq("the first failed round waits 5 min", failFloorMs(1), 5 * 60000);
eq("doubling: 5, 10, 20, 40", [1, 2, 3, 4].map(failFloorMs), [5, 10, 20, 40].map((m) => m * 60000));
eq("capped at an hour", failFloorMs(9), 60 * 60000);
eq("a zero streak still waits the base", failFloorMs(0), 5 * 60000);

const intOr = lift("intOr");
eq("unset budget env falls back", intOr(undefined, 1700), 1700);
eq("a real budget override is honored", intOr("1900", 1700), 1900);
eq("zero and garbage are refused", [intOr("0", 5), intOr("lots", 5)], [5, 5]);

/* The store on disk: one bad section must cost only that section. */
const unpackStore = lift("unpackStore");
{
  const good = {
    v: 1, savedAt: "2026-09-10T12:00:00Z",
    wxStore: { byId: { BSKN7: { hours: {} } }, fetchedAt: {}, newestKey: {}, seenIds: {}, lastFetchMs: 1 },
    cocoCache: { at: 1, rows: [] }, cocoMetaCache: { at: 1, byId: {} }, metaCache: {},
    soilGood: { stations: [], wx: [], coco: [] }, soilCache: { at: 1, ttl: 1, payload: { stations: [] } },
    ledger: { month: "2026-09", requests: 3, datapoints: 40 }, trailCache: { at: 1, list: [] }
  };
  const u = unpackStore(good);
  eq("a good store unpacks every section", Object.values(u).every((v) => v !== null), true);
  eq("the ledger comes back intact", u.ledger, good.ledger);
  eq("a foreign version is refused whole", unpackStore(Object.assign({}, good, { v: 2 })), null);
  eq("garbage is refused whole", [unpackStore(null), unpackStore("x"), unpackStore([])], [null, null, null]);
  const partial = unpackStore(Object.assign({}, good, { wxStore: { byId: "nope" }, ledger: { month: 9, requests: "3" } }));
  eq("a broken wx section is dropped alone", partial.wxStore, null);
  eq("a broken ledger is dropped alone", partial.ledger, null);
  eq("the healthy sections beside them survive", partial.cocoCache, good.cocoCache);
}

if (problems.length) {
  console.error("FAIL\n\n" + problems.join("\n\n"));
  process.exit(1);
}
console.log("parsed " + (parsed ? parsed.length : 0) + " trails from index.html: " +
  (parsed || []).map((t) => t.name).join(", "));
console.log("PASS — locVariants, parseTrails, normaliseMoisture, milesBetween, " +
  "wxFetchHours, hourKeyMs, mergeHours, pruneHoursBefore, parseWxHours, minutesOr, " +
  "monthWindow, paceSpacingMs, proratedBudget, isQuotaError, failFloorMs, intOr, unpackStore");
