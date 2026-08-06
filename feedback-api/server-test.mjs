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

eq("three networks split into three queries, county list preserved",
  locVariants("type=RAWS,USCRN,ECONET;county=Transylvania County,Henderson County"),
  ["type=RAWS;county=Transylvania County,Henderson County",
   "type=USCRN;county=Transylvania County,Henderson County",
   "type=ECONET;county=Transylvania County,Henderson County"]);

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
   milesBetween — every gauge threshold in the page depends on it.
   --------------------------------------------------------------- */
const milesBetween = lift("milesBetween");
const asheville = [35.5951, -82.5515], flet = [35.42721, -82.55888];
const d = milesBetween(asheville[0], asheville[1], flet[0], flet[1]);
if (!(d > 11 && d < 12.5)) problems.push("milesBetween: Asheville to FLET should be ~11.6 mi, got " + d.toFixed(2));
if (milesBetween(35, -82, 35, -82) !== 0) problems.push("milesBetween: a point is not zero miles from itself");

if (problems.length) {
  console.error("FAIL\n\n" + problems.join("\n\n"));
  process.exit(1);
}
console.log("parsed " + (parsed ? parsed.length : 0) + " trails from index.html: " +
  (parsed || []).map((t) => t.name).join(", "));
console.log("PASS — locVariants, parseTrails, normaliseMoisture, milesBetween");
