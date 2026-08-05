/* Drives the real rating widget in a browser and checks the payload.

   The rating form is the only place ground truth enters this project, so
   a silent break here costs data that cannot be recovered later — you
   can't go back and re-ride last Tuesday. Worth its own test.

   Asserts: every v4 field is present, the surface chips multi-select,
   and picking "8h ago" actually snapshots the model at that hour rather
   than at page-open time.

   Run: node rating-test.mjs        (needs: npm i playwright) */
import { chromium } from "playwright";
const H = 24 * 9;
const start = new Date("2026-08-01T00:00:00Z");
const iso = i => new Date(start.getTime() + i*3600e3).toISOString().slice(0,16);
const day = n => new Date(start.getTime() + n*86400e3).toISOString().slice(0,10);
/* Scaled drier on 5 Aug 2026, when Bent Creek's soil went from `rocky`
   (wet 0.55) to `clay` (wet 1.30). The old fixture — 0.40 soil moisture
   and 1.76" of rain — drove both penalties into their min(58,…) caps on
   clay, so shown_score and rode_score both clipped to 0 and the snapshot
   assertion below could no longer tell them apart. It was the fixture
   that went out of range, not stateAt() that broke: the wetness here is
   divided by roughly the multiplier ratio so the score lands mid-band
   again and an 8-hour difference is still visible. Keep it off the floor
   and off the ceiling if these numbers ever move again.

   The drying curve now starts at hour 70 rather than 80. "Now" is hour 80
   and the ride being rated is hour 72, and the old curve was flat across
   that whole span — so the only thing separating the two snapshots was
   the tail of the rain, worth a single point. The assertion passed on a
   1-point margin that any change to the water term could erase. Soil
   moisture now falls through the rated window too, which is what the
   snapshot is actually supposed to capture. */
const precipitation = Array.from({length:H},(_,i)=> (i>=70&&i<78)?0.09:0);
const hourOf=i=>i%24, wet=i=>(i<70?0.18:Math.max(0.15,0.36-(i-70)*0.005));
const hourly={time:Array.from({length:H},(_,i)=>iso(i)),
 temperature_2m:Array.from({length:H},(_,i)=>60+18*Math.sin((hourOf(i)-8)/24*2*Math.PI)),
 relative_humidity_2m:Array.from({length:H},(_,i)=>55+30*Math.cos((hourOf(i)-8)/24*2*Math.PI)),
 precipitation, precipitation_probability:precipitation.map(p=>p>0?80:10),
 weather_code:precipitation.map(p=>p>0?63:1),
 wind_speed_10m:Array.from({length:H},()=>6), wind_gusts_10m:Array.from({length:H},()=>14),
 shortwave_radiation:Array.from({length:H},(_,i)=>{const h=hourOf(i);return h>6&&h<20?700*Math.sin((h-6)/14*Math.PI):0;}),
 soil_moisture_0_to_1cm:Array.from({length:H},(_,i)=>wet(i)),
 soil_moisture_3_to_9cm:Array.from({length:H},(_,i)=>wet(i)),
 soil_temperature_6cm:Array.from({length:H},()=>62)};
const daily={time:Array.from({length:9},(_,n)=>day(n)),sunrise:Array.from({length:9},(_,n)=>day(n)+"T06:30"),
 sunset:Array.from({length:9},(_,n)=>day(n)+"T20:30"),precipitation_sum:Array.from({length:9},(_,n)=>n===3?1.8:0),
 temperature_2m_max:Array.from({length:9},()=>78)};
const NOW=80;
const forecast={elevation:700,hourly,daily,current:{time:iso(NOW),temperature_2m:71,relative_humidity_2m:70,precipitation:0,weather_code:3,wind_speed_10m:6,wind_gusts_10m:12}};

const b=await chromium.launch({executablePath:"/opt/pw-browsers/chromium"});
const p=await b.newPage();
const problems=[]; p.on("pageerror",e=>problems.push("pageerror: "+e.message));
await p.route("**://api.open-meteo.com/**",r=>{const n=(new URL(r.request().url()).searchParams.get("latitude")||"").split(",").filter(Boolean).length;
 r.fulfill({status:200,contentType:"application/json",body:JSON.stringify(n>1?Array.from({length:n},()=>forecast):forecast)});});
await p.route("**://api.weather.gov/**",r=>r.fulfill({status:200,contentType:"application/json",body:JSON.stringify({features:[]})}));
await p.route("**://waterservices.usgs.gov/**",r=>r.fulfill({status:200,contentType:"application/json",body:JSON.stringify({value:{timeSeries:[]}})}));
let posted=null;
await p.route("**://altar-dirt-production.up.railway.app/**",r=>{
  if(r.request().method()==="POST"){ posted=JSON.parse(r.request().postData()||"{}"); return r.fulfill({status:200,contentType:"application/json",body:'{"ok":true}'}); }
  r.fulfill({status:200,contentType:"application/json",body:JSON.stringify({stations:[],wx:[],coco:[]})});});
await p.route("**fonts.googleapis.com**",r=>r.fulfill({status:200,body:""}));
await p.goto("file://"+process.cwd()+"/index.html",{waitUntil:"load"});
await p.waitForTimeout(3500);

const card = p.locator(".da-card").first();
await card.locator(".da-rate-open").click();
await card.locator('[data-g="verdict"] .da-chip[data-v="-1"]').click();
await card.locator('[data-g="ago"] .da-chip[data-h="8"]').click();
await card.locator('[data-g="surface"] .da-chip[data-s="greasy"]').click();
await card.locator('[data-g="surface"] .da-chip[data-s="rutting"]').click();
await card.locator('[data-g="others"] .da-chip[data-o="avoid"]').click();
await card.locator(".da-section").fill("Sidehill Ledford");
await card.locator(".da-note-in").fill("roots were a skating rink");
const nameBox = card.locator(".da-name");
if (await nameBox.count()) await nameBox.fill("Test Rider");
await card.locator(".da-rate-send").click();
await p.waitForTimeout(900);
await b.close();

if(!posted) problems.push("nothing was POSTed");
else {
  const r = Array.isArray(posted) ? posted[0] : (posted.items ? posted.items[0] : posted);
  const need = ["rode_hours_ago","rode_at","rode_score","surface","others_should","section"];
  need.forEach(k=>{ if(r[k]===undefined) problems.push("missing field: "+k); });
  if(r.rode_hours_ago!==8) problems.push("rode_hours_ago should be 8, got "+r.rode_hours_ago);
  if(r.surface!=="greasy|rutting") problems.push("surface multi-select wrong: "+r.surface);
  if(r.others_should!=="avoid") problems.push("others_should wrong: "+r.others_should);
  if(r.v!==4) problems.push("payload version should be 4, got "+r.v);
  if(r.rode_score===r.shown_score) problems.push("rode_score identical to shown_score — ride-time snapshot not applied");
  console.log("shown_score:",r.shown_score,"  rode_score(8h ago):",r.rode_score,"  rode_at:",r.rode_at);
  console.log("water_in:",r.water_in,"  rain_24h:",r.rain_24h,"  surface:",r.surface,"  others:",r.others_should);
  console.log("section:",r.section,"  note:",r.note);
}
if(problems.length){console.error("\nFAIL\n"+problems.join("\n"));process.exit(1);}
console.log("\nPASS — rating payload v4 carries ride time, surface, stewardship");
