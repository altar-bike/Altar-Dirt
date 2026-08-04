/* Loads index.html in a real browser against a synthetic Open-Meteo
   response and fails loudly on any JS error or unrendered card.
   Catches things `node --check` cannot — the score model runs under
   "use strict", so an undeclared variable only blows up at runtime.

   Run: node smoke-test.mjs      (needs: npm i playwright)  */

import { chromium } from "playwright";

const H = 24 * 9;                       // 3 past days + 6 forecast
const start = new Date("2026-08-01T00:00:00Z");
const iso = (i) => new Date(start.getTime() + i * 3600e3).toISOString().slice(0, 16);
const day = (n) => new Date(start.getTime() + n * 86400e3).toISOString().slice(0, 10);

/* A wet spell that clears: heavy rain on day 3, then drying. This is the
   case that exercises the recovery ("Dries out ...") branch. */
const precipitation = Array.from({ length: H }, (_, i) => {
  if (i >= 70 && i < 78) return 0.22;
  if (i === 96 || i === 97) return 0.02;      // trace, must not reset drying
  return 0;
});
const hourOf = (i) => i % 24;
const wet = (i) => (i < 70 ? 0.20 : i < 80 ? 0.40 : Math.max(0.16, 0.40 - (i - 80) * 0.004));

const hourly = {
  time: Array.from({ length: H }, (_, i) => iso(i)),
  temperature_2m:       Array.from({ length: H }, (_, i) => 60 + 18 * Math.sin((hourOf(i) - 8) / 24 * 2 * Math.PI)),
  relative_humidity_2m: Array.from({ length: H }, (_, i) => 55 + 30 * Math.cos((hourOf(i) - 8) / 24 * 2 * Math.PI)),
  precipitation,
  precipitation_probability: precipitation.map((p) => (p > 0 ? 80 : 10)),
  weather_code:  precipitation.map((p) => (p > 0 ? 63 : 1)),
  wind_speed_10m: Array.from({ length: H }, () => 6),
  wind_gusts_10m: Array.from({ length: H }, () => 14),
  shortwave_radiation: Array.from({ length: H }, (_, i) => {
    const h = hourOf(i); return h > 6 && h < 20 ? 700 * Math.sin((h - 6) / 14 * Math.PI) : 0;
  }),
  soil_moisture_0_to_1cm: Array.from({ length: H }, (_, i) => wet(i)),
  soil_moisture_3_to_9cm: Array.from({ length: H }, (_, i) => wet(i)),
  soil_temperature_6cm:   Array.from({ length: H }, () => 62)
};

const daily = {
  time:               Array.from({ length: 9 }, (_, n) => day(n)),
  sunrise:            Array.from({ length: 9 }, (_, n) => day(n) + "T06:30"),
  sunset:             Array.from({ length: 9 }, (_, n) => day(n) + "T20:30"),
  precipitation_sum:  Array.from({ length: 9 }, (_, n) => (n === 3 ? 1.8 : 0)),
  temperature_2m_max: Array.from({ length: 9 }, () => 78)
};

/* "Now" is a few hours after the rain stopped, so the trail is still
   wet and the model has to say when it comes back. Override with
   NOW_HOUR to land at a different point in the drying curve — hour 78
   leaves no good window today and exercises the recovery branch. */
const NOW = Number(process.env.NOW_HOUR || 80);
const forecast = {
  elevation: 700, hourly, daily,
  current: { time: iso(NOW), temperature_2m: 71, relative_humidity_2m: 70,
             precipitation: 0, weather_code: 3, wind_speed_10m: 6, wind_gusts_10m: 12 }
};

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const page = await browser.newPage();
const problems = [];
page.on("pageerror", (e) => problems.push("pageerror: " + e.message));
page.on("console", (m) => { if (m.type() === "error" && !/ERR_|Failed to load resource/.test(m.text())) problems.push("console: " + m.text()); });

/* The page now sends every trail in ONE request (comma-separated
   coordinates) and Open-Meteo answers with an array in the same order —
   or a bare object for a single coordinate (the retry path). The stub
   mirrors both shapes, so a regression back to per-trail calls shows up
   here as a card count mismatch. */
await page.route("**://api.open-meteo.com/**", (r) => {
  const u = new URL(r.request().url());
  const n = (u.searchParams.get("latitude") || "").split(",").filter(Boolean).length;
  const body = n > 1
    ? JSON.stringify(Array.from({ length: n }, () => forecast))
    : JSON.stringify(forecast);
  r.fulfill({ status: 200, contentType: "application/json", body });
});
await page.route("**://api.weather.gov/**", (r) =>
  r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ features: [] }) }));
await page.route("**://waterservices.usgs.gov/**", (r) =>
  r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ value: { timeSeries: [] } }) }));
/* A soil station and a rain gauge, both parked next to Bent Creek. The
   gauge deliberately reports MORE rain than the synthetic forecast, so
   the measured-rain path and the disagreement copy both get exercised. */
const gaugeHours = {};
for (let i = 0; i <= NOW; i++) {
  const k = iso(i).slice(0, 13);
  gaugeHours[k] = { p: precipitation[i] > 0 ? precipitation[i] + 0.05 : 0, et: 0.012 };
}
const soilPayload = {
  stations: [{ id: "TEST", name: "Test Soil Station", lat: 35.4950, lon: -82.6300,
               elev: 2100, soilmoist: 0.31, soilmoist20cm: 0.31, soiltemp: 68, at: iso(NOW) }],
  wx: [{ id: "TESTG", name: "Test Rain Gauge", lat: 35.4950, lon: -82.6300,
         elev: 2100, hours: gaugeHours }],
  /* A volunteer daily observer 1 mi from Ride Kanuga, dated with the
     REAL clock — the page's freshness cutoff runs on Date.now(), not
     the synthetic timeline. Kanuga has no hourly gauge in this stub,
     so the daily row is its only measured rain. */
  coco: [{ id: "NC-HN-33", name: "Hendersonville 5.1 WSW", lat: 35.2810, lon: -82.5450,
           elev: 2184, date: new Date().toISOString().slice(0, 10), precip: 0.31 }]
};
await page.route("**://altar-dirt-production.up.railway.app/**", (r) =>
  r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(soilPayload) }));
await page.route("**fonts.googleapis.com**", (r) => r.fulfill({ status: 200, body: "" }));

await page.goto("file://" + process.cwd() + "/index.html", { waitUntil: "load" });
await page.waitForTimeout(4000);
await page.evaluate(() => document.querySelectorAll(".da-toggle").forEach((b) => b.click()));

/* Out-of-state areas sit behind a button and must NOT have loaded yet. */
const before = await page.evaluate(() => ({
  awayHidden: document.getElementById("da-away-grid")?.hidden,
  awayBtn: !!document.getElementById("da-away-btn"),
  awayScored: [...document.querySelectorAll("#da-away-grid .da-score")].length,
  localScored: [...document.querySelectorAll("#da-grid .da-score")].length
}));
if (before.awayHidden !== true) problems.push("away grid should start hidden");
if (!before.awayBtn) problems.push("away load button missing");
if (before.awayScored !== 0) problems.push("away trails fetched before being asked for");

/* ...and must load on click. */
await page.click("#da-away-btn");
await page.waitForTimeout(3000);
const after = await page.evaluate(() => ({
  awayHidden: document.getElementById("da-away-grid")?.hidden,
  awayBtn: !!document.getElementById("da-away-btn"),
  awayScored: [...document.querySelectorAll("#da-away-grid .da-score")].length
}));
if (after.awayHidden !== false) problems.push("away grid still hidden after click");
if (after.awayBtn) problems.push("away button should be gone after loading");
if (after.awayScored === 0) problems.push("away trails did not load on click");

const r = await page.evaluate(() => {
  const cards = [...document.querySelectorAll(".da-card")];
  const rowsOf = (c) => [...(c?.querySelectorAll(".da-measured-in li") || [])]
    .map((l) => l.textContent.replace(/\s+/g, " ").trim());
  return {
    cards: cards.length,
    errors: [...document.querySelectorAll(".da-err")].map((e) => e.textContent),
    verdict: document.getElementById("da-verdict")?.textContent.replace(/\s+/g, " ").trim(),
    scores: cards.map((c) => c.querySelector(".da-score")?.textContent ?? null),
    windows: cards.map((c) => c.querySelector(".da-window")?.textContent.trim()),
    drivers: [...(cards[0]?.querySelectorAll(".da-why li") || [])].map((l) => l.textContent.replace(/\s+/g, " ").trim()),
    measured: rowsOf(cards[0]),
    meaning: cards[0]?.querySelector(".da-meaning")?.textContent.replace(/\s+/g, " ").trim() || null,
    outlookRows: cards[0]?.querySelectorAll(".da-orow").length ?? 0,
    millsRows: rowsOf(cards[1]),     /* North Mills River — tier-2 territory */
    kanugaRows: rowsOf(cards[5])     /* Ride Kanuga — volunteer daily gauge */
  };
});
await browser.close();

/* Bent Creek has a gauge 0.25 mi away in the stub, so the rain row and
   the disagreement sentence must both be present. */
if (!r.measured.some((l) => l.startsWith("rain"))) problems.push("measured rain row missing on Bent Creek");
if (!/gauge caught/.test(r.meaning || "")) problems.push("gauge-vs-forecast sentence missing");

/* The same stub gauge sits 5.4 mi from North Mills River — outside the
   scoring threshold, inside the watch tier. The rain? warning is the
   only defence a gauge-less trail has against a forecast miss, so its
   absence is a failure, not a cosmetic difference. */
if (!r.millsRows.some((l) => /rain\?/.test(l) && /Too far off to score from/.test(l)))
  problems.push("tier-2 rain? warning missing on North Mills River");

/* Kanuga's only measured rain is the volunteer daily observer. */
if (!r.kanugaRows.some((l) => /rain·d/.test(l) && /volunteer daily gauge/.test(l)))
  problems.push("CoCoRaHS daily row missing on Ride Kanuga");

/* Five-day outlook, one row per day. */
if (r.outlookRows !== 5) problems.push("expected 5 outlook rows, got " + r.outlookRows);

if (r.errors.length) problems.push("cards showing an error: " + r.errors[0]);
if (r.cards !== 10) problems.push("expected 10 cards, got " + r.cards);
if (r.scores.some((s) => s === null)) problems.push("a card rendered no score");

console.log("local   :", before.localScored, "scored on load; away:", before.awayScored,
            "-> after click:", after.awayScored);
console.log("verdict :", r.verdict);
console.log("scores  :", r.scores.join(" "));
console.log("window  :", r.windows[0]);
console.log("drivers :", r.drivers.join("  |  "));
console.log("measured:", r.measured.join("  |  "));
console.log("meaning :", r.meaning);

if (problems.length) { console.error("\nFAIL\n" + problems.join("\n")); process.exit(1); }
console.log("\nPASS — " + r.cards + " cards, no JS errors");
