# Gravelo Workshop - Service Department Dashboard

Live dashboard that pulls data from your Lightspeed R-Series POS and displays service department metrics including work orders, revenue, technician performance, and parts margins.

## What You'll See

- **KPI cards** - total work orders, service revenue, average turnaround time, parts margin, labor vs parts split
- **Daily trend chart** - jobs opened, completed, and revenue over time
- **Technician scoreboard** - revenue and job counts per tech
- **Work order status** - open vs completed vs archived
- **Monthly revenue** - month-over-month service revenue
- **Top service types** - most common job categories

Data refreshes automatically every day at 6 AM UTC (configurable).

## Shop Floor page (`/shop`)

The page the shop PCs keep open all day. No dollar figures.

- **Needs list** - staff add what's needed: Bike inventory, Shop supplies, or Coffee bar
  (item, qty, urgent or next order, notes, name, and an optional Amazon link for
  non-bike items). Anyone can mark items Ordered → Got it, undo, or
  remove. Received items drop off after 7 days. Stored in SQLite on the `/data` volume.
- **Service strip** - open work orders (total and by tech), checked in / finished in
  the last 7 days, from the daily refresh.
- **Amazon view** - the Amazon filter lists open non-bike items with their links, plus
  a one-click "add to Amazon cart" for items whose link has a product ID (beta: uses
  Amazon's old cart-add URL, which may stop working).
- **Google Chat alerts** - set `GCHAT_WEBHOOK_URL` (a Chat space incoming webhook) and
  the app posts: (1) instantly when a need is marked **Need now**, (2) at 9:00 AM Eastern
  if any Coffee bar items are still Needed. "Test Chat" on the dashboard sends a test.
- **Shop use** - staff switch to the Shop use tab, scan an item's barcode (UPC, EAN,
  custom SKU or the Lightspeed label's system SKU), set qty, and log it. Nothing changes
  in Lightspeed until a manager approves it at `/shop-use/review` (PIN), which lowers
  stock on shop 1 and reads it back to confirm. History and a CSV (with est. cost) for
  the bookkeeper are on the same page.
  The manager can also scan items they take themselves ("Taking something for the shop" on
  the same page); those come out of Lightspeed immediately. The **Usage** tab shows units
  per item per month, a 3-month average and a suggested minimum stock, plus a CSV.
- Kiosk setup for the Windows PCs: see `kiosk/README.md`.

## Manager PIN

Set `MANAGER_PIN` in Railway variables to lock the manager dashboard (`/`), catalog
import, reports, AI chat, `/api/data` and the Needs CSV export (`/api/needs/export`).
Unlock at `/login`; the unlock lasts 30 days per browser, "Lock" ends it. `/shop`,
`/api/shop`, `/api/needs`, `/health` and `/auth/callback` stay open. If `MANAGER_PIN`
is unset the gate is off.

## Deploy to Railway

### 1. Connect this repo in Railway
Go to [railway.app](https://railway.app), click **New Project > Deploy from GitHub Repo**, and select this repo.

### 2. Add environment variables
In Railway dashboard, go to your service > **Variables** and add:

| Variable | Value |
|---|---|
| LS_ACCOUNT_ID | Your Lightspeed account ID |
| LS_ACCESS_TOKEN | Your current access token |
| LS_REFRESH_TOKEN | Your refresh token |
| LS_CLIENT_ID | Your Lightspeed app client ID |
| LS_CLIENT_SECRET | Your Lightspeed app client secret |
| LOOKBACK_DAYS | 90 |
| REFRESH_HOUR | 6 |
| SECRET_KEY | Any random string |

### 3. Generate a domain
In Railway > Settings > Networking > **Generate Domain**

## API Endpoints

| Endpoint | Method | Description |
|---|---|---|
| / | GET | Dashboard UI |
| /api/data | GET | Raw JSON metrics |
| /api/refresh | POST | Trigger manual data refresh |
| /health | GET | Health check |
| /shop | GET | Shop floor page (Needs list) |
| /api/shop | GET | Non-financial service summary |
| /api/needs | GET / POST | List / add needs |
| /api/needs/&lt;id&gt; | PATCH / DELETE | Change status (open, ordered, received) / remove |
| /api/needs/export | GET | Full Needs history as CSV (manager) |
| /login, /logout | GET / POST | Manager PIN |
