# Altar Cycles — Trail Conditions

Scores mountain bike trail rideability around western NC from Open-Meteo
weather and soil data. `index.html` is the entire page — no build step, no
dependencies. See `CLAUDE.md` for how this project is maintained.

## Hosting

- **Page:** GitHub Pages, from `main` / root of this repo. Linked from the
  Shopify nav at altar.bike.
- **Rider feedback:** a small service on Railway — see
  [`feedback-api/README.md`](feedback-api/README.md).

## Licensing

Weather data by [Open-Meteo.com](https://open-meteo.com/), CC BY 4.0. The
footer attribution in `index.html` (the link plus the note that rideability
scores are Altar's own model built on that data) is required by the licence
and must never be removed. No API key is used; if Altar moves to Open-Meteo's
paid commercial tier, the key must live in a server-side proxy, never in
`index.html`.
