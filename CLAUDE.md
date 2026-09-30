# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Python Flask web application serving as a live service department dashboard for bike shops using Lightspeed R-Series POS. Deployed on Railway. No test suite.

## Commands

```bash
# Local development
python app.py                    # runs Flask dev server (set FLASK_DEBUG=1 for reload)

# Production (Railway)
gunicorn app:app --bind 0.0.0.0:$PORT --workers 2 --timeout 600

# Install dependencies
pip install -r requirements.txt

# Generate Lightspeed OAuth tokens
python get_tokens.py
```

## Architecture

### Module Responsibilities

- **app.py** - Flask routes, scheduler setup, cache management, OAuth flow. Entry point.
- **lightspeed.py** - Lightspeed R-Series REST API client with OAuth token refresh and rate-limit retry logic. All API calls go through this.
- **data_processor.py** - Transforms raw Lightspeed work orders/sales into dashboard metrics. Uses Claude API to classify line items as labor vs parts (with heuristic fallback). Maintains a classification cache (`classification_cache.json`).
- **catalog_import.py** - Supplier catalog upload (Excel/CSV), matching against Lightspeed inventory, and batch price/cost updates via API. Uses file-based sessions (`import_sessions/`) to survive gunicorn worker restarts.
- **app_chat_upgrade.py** - AI chat endpoint using Claude with tool calling. Defines 20+ tools that query Lightspeed in real time (lookup customers, work orders, inventory, etc.).
- **monthly_report.py** - Generates CSV reports of technician performance metrics.
- **needs.py** - Shop Needs list (staff inventory/supply requests). SQLite at `/data/needs.db` (or `NEEDS_DB_PATH`). Served by `/api/needs*` and `templates/shop.html`. Categories: inventory (bike), supplies, coffee; supplies/coffee may carry an Amazon link. Urgency: normal / urgent / immediate. `/api/needs?category=&status=` filters are used by the coffee check.
- **shop_use.py** - Shop-use scans (same SQLite file). Kiosk logs `pending` entries; manager applies them at `/shop-use/review`: GET Item+ItemShops -> PUT qoh on shopID 1 only -> GET read-back. Max 40 per apply, 2s pacing, one apply at a time. Kiosk endpoints must never return cost. Manager can also scan + apply in one step (`/api/shop-use/take`). `usage()` powers the Usage tab / `usage.csv`: per-item units by month (all statuses except rejected), 3-month average, and a suggested minimum stock of about 6 weeks of recent use.
- **notify.py** - Google Chat posts via incoming webhook (`GCHAT_WEBHOOK_URL`; no-op if unset). Sent on a background thread, paced to ~1/sec. Triggers: need added with urgency `immediate` ("Need now"), and the `coffee_morning_check` scheduler job at 09:00 America/New_York. Never log the webhook URL (it contains a token).
- **lightspeed_expanded.py** - Reference/extended API implementation (not imported by main app).

### Data Flow

1. APScheduler triggers daily refresh (configurable via `REFRESH_HOUR`)
2. `lightspeed.py` fetches work orders, sales, employees from Lightspeed API
3. `data_processor.py` classifies line items (heuristics first at >=80% confidence, then Claude for ambiguous items in 50-item batches)
4. Results cached in-memory (`_cache` dict) and on disk (`dashboard_cache.json`)
5. Dashboard UI reads from `/api/data` which returns cached metrics instantly

### Key Patterns

- **Two-tier classification**: Fast heuristic check, Claude API only for ambiguous items. Classification results cached by itemID+description+price hash.
- **File-based sessions**: Catalog import state stored as JSON files in `import_sessions/` rather than Flask sessions, for multi-worker compatibility.
- **OAuth token lifecycle**: Tokens refresh on app init and automatically on 400/401 responses from Lightspeed.
- **Lightspeed pagination**: Cursor-based via `next` URL in `@attributes`. The client handles the `or` operator with manual URL encoding.
- **Rate limiting**: Lightspeed API retry on 429 (respects `Retry-After`). Chat endpoint limited to 15 req/min per IP via in-memory token bucket.

### Environment Variables

Required: `LS_ACCOUNT_ID`, `LS_ACCESS_TOKEN`, `LS_REFRESH_TOKEN`, `LS_CLIENT_ID`, `LS_CLIENT_SECRET`, `SECRET_KEY`

Optional: `MANAGER_PIN` (locks manager routes - see `_PROTECTED_PREFIXES` in app.py; `/shop` must stay open for the shop PCs), `NEEDS_DB_PATH`, `LOOKBACK_DAYS` (default 90), `REFRESH_HOUR` (default 6 UTC), `REFRESH_ON_START` (default true), `ANTHROPIC_API_KEY`, `REFRESH_SECRET`, `FLASK_DEBUG`

### Frontend

Altar brand throughout (Forge Black #111, Ash #CCC, Rust #B85C2A; Big Shoulders Display + Space Mono). Logo PNGs in `static/` (`altar-logo-dark.png` for dark backgrounds, `altar-logo-light.png` original black/white), cut from the designer concept sheet - replace with the designer's final files when available. Chart series colors C1/C2/C3 in dashboard.html are validated for the dark surface; status colors (green/amber/red vars) are reserved for good/warn/bad. Jinja2 templates with embedded JavaScript: `dashboard.html` (manager), `shop.html` (shop floor kiosk, Altar brand colors, must never show dollar figures), `login.html`. No build step, no frontend framework.
