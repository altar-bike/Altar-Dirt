"""
Gravelo Workshop â Service Department Dashboard
Flask app that pulls from Lightspeed R-Series and serves a live dashboard.
Uses Anthropic Claude API for intelligent line-item classification.
"""

import os
import csv
import hmac
import io
import json
import logging
import threading
from datetime import timedelta
import requests as http_requests
from datetime import datetime
from urllib.parse import urlencode

from flask import Flask, render_template, jsonify, request, redirect, session, Response
from apscheduler.schedulers.background import BackgroundScheduler

from collections import defaultdict
import time as _time

from lightspeed import (
    LightspeedClient,
    persist_token_pair,
    BROWSER_UA,
    TOKEN_URL as LS_TOKEN_ENDPOINT,
)
from data_processor import build_dashboard_data
from monthly_report import generate_monthly_report
from app_chat_upgrade import api_chat_with_tools
from catalog_import import (
    parse_uploaded_file, match_against_lightspeed, commit_updates,
    get_pending_session, get_import_status, _save_session,
    cleanup_old_sessions,
)
import needs as needs_store
import shop_use
import notify


# ---------------------------------------------------------------------------
# Simple in-memory rate limiter for chat endpoint
# ---------------------------------------------------------------------------

class RateLimiter:
    """Token-bucket rate limiter keyed by IP address."""

    def __init__(self, max_requests=10, window_seconds=60):
        self.max_requests = max_requests
        self.window = window_seconds
        self._hits = defaultdict(list)  # ip -> [timestamps]

    def is_allowed(self, key):
        now = _time.time()
        # Clean old entries
        self._hits[key] = [t for t in self._hits[key] if now - t < self.window]
        if len(self._hits[key]) >= self.max_requests:
            return False
        self._hits[key].append(now)
        return True

_chat_limiter = RateLimiter(max_requests=15, window_seconds=60)  # 15 req/min per IP
_login_limiter = RateLimiter(max_requests=5, window_seconds=60)   # PIN guesses
_needs_limiter = RateLimiter(max_requests=30, window_seconds=60)  # needs writes
_scan_limiter = RateLimiter(max_requests=30, window_seconds=60)   # shop-use lookups

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

app = Flask(__name__)
app.config["SECRET_KEY"] = os.getenv("SECRET_KEY", "change-me-in-production")
app.config["PERMANENT_SESSION_LIFETIME"] = timedelta(days=30)
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
if os.getenv("RAILWAY_ENVIRONMENT") or os.getenv("RAILWAY_ENVIRONMENT_NAME"):
    app.config["SESSION_COOKIE_SECURE"] = True  # Railway always serves HTTPS

DATA_FILE = "dashboard_cache.json"
REPORTS_DIR = "reports"
os.makedirs(REPORTS_DIR, exist_ok=True)
LOOKBACK_DAYS = int(os.getenv("LOOKBACK_DAYS", "90"))

# In-memory cache so the dashboard is instant
_cache: dict = {}

# Track active import commit threads to prevent double-commits
_active_imports: dict = {}  # session_id -> Thread


# ---------------------------------------------------------------------------
# Data refresh
# ---------------------------------------------------------------------------

def refresh_data():
    """Pull fresh data from Lightspeed, classify with Claude, and cache.

    Returns True on success, False on failure. Failures are logged rather than
    raised so the scheduler survives them, but callers can tell the difference.
    """
    global _cache
    logger.info("Starting data refresh â¦")
    try:
        client = LightspeedClient()
        employees = client.get_employees()
        workorders = client.get_workorders(since_days=LOOKBACK_DAYS)
        sales = client.get_sales(since_days=LOOKBACK_DAYS)

        logger.info(
            "Fetched %d work orders, %d sales, %d employees",
            len(workorders), len(sales), len(employees),
        )

        dashboard = build_dashboard_data(workorders, sales, employees)

        # Persist to disk so restarts don't lose data
        with open(DATA_FILE, "w") as f:
            json.dump(dashboard, f)

        _cache = dashboard
        logger.info("Data refresh complete â")
        return True
    except Exception:
        logger.exception("Data refresh failed")
        return False


def load_cache():
    """Load cached data from disk on startup."""
    global _cache
    if os.path.exists(DATA_FILE):
        with open(DATA_FILE) as f:
            _cache = json.load(f)
        logger.info("Loaded cached dashboard data from disk")
    else:
        logger.info("No cache file found â will fetch on first refresh")


# ---------------------------------------------------------------------------
# Manager PIN gate
#
# The shop PCs run /shop all day. Everything that shows money, changes prices
# in Lightspeed, or spends Anthropic credits sits behind MANAGER_PIN. If the
# variable is unset the gate is off (the old behaviour) and a warning is logged.
# ---------------------------------------------------------------------------

MANAGER_PIN = os.getenv("MANAGER_PIN", "").strip()

# Exact paths and path prefixes that need the manager PIN.
_PROTECTED_EXACT = {"/"}
_PROTECTED_PREFIXES = (
    "/api/data", "/api/chat", "/api/import", "/api/report",
    "/api/cache-export", "/api/needs/export", "/auth/start",
    "/shop-use/review", "/api/shop-use/review", "/api/shop-use/apply",
    "/api/shop-use/reject", "/api/shop-use/export", "/api/shop-use/take",
    "/api/shop-use/usage", "/api/notify",
)

if not MANAGER_PIN:
    logger.warning(
        "MANAGER_PIN is not set - the manager dashboard, catalog import and "
        "AI chat are open to anyone with the URL."
    )
elif app.config["SECRET_KEY"] == "change-me-in-production":
    logger.error(
        "MANAGER_PIN is set but SECRET_KEY is the default - session cookies "
        "can be forged. Set SECRET_KEY in Railway variables."
    )


def _is_protected(path):
    return path in _PROTECTED_EXACT or path.startswith(_PROTECTED_PREFIXES)


@app.before_request
def _manager_gate():
    if not MANAGER_PIN or session.get("manager"):
        return None
    if not _is_protected(request.path):
        return None
    if request.path.startswith("/api/"):
        return jsonify({"error": "Manager PIN required.", "login": "/login"}), 401
    return redirect(f"/login?next={request.path}")


def _safe_next(target):
    # Only allow local paths so /login can't bounce someone to another site.
    if target and target.startswith("/") and not target.startswith("//"):
        return target
    return "/"


@app.route("/login", methods=["GET", "POST"])
def login():
    if not MANAGER_PIN:
        return redirect("/")
    error = ""
    next_url = _safe_next(request.values.get("next"))
    if request.method == "POST":
        if not _login_limiter.is_allowed(request.remote_addr or "unknown"):
            error = "Too many tries. Wait a minute."
        elif hmac.compare_digest(request.form.get("pin", "").strip(), MANAGER_PIN):
            session.permanent = True
            session["manager"] = True
            return redirect(next_url)
        else:
            error = "Wrong PIN."
    return render_template("login.html", error=error, next_url=next_url)


@app.route("/logout")
def logout():
    session.pop("manager", None)
    return redirect("/shop")


# ---------------------------------------------------------------------------
# Shop floor - the page the shop PCs keep open
# ---------------------------------------------------------------------------

@app.route("/shop")
def shop_floor():
    return render_template("shop.html")


@app.route("/api/shop")
def api_shop():
    """Non-financial service summary for the shop floor. No dollar figures."""
    wo = _cache.get("workorders") or {}
    records = wo.get("records") or []
    open_by_tech = defaultdict(int)
    for r in records:
        if r.get("status") == "Open":
            open_by_tech[r.get("tech") or "Unassigned"] += 1
    trend = (_cache.get("trend") or [])[-7:]
    return jsonify({
        "generated_at": _cache.get("generated_at"),
        "open_total": sum(open_by_tech.values()),
        "open_by_tech": sorted(
            ({"tech": t, "open": n} for t, n in open_by_tech.items()),
            key=lambda x: -x["open"],
        ),
        "last7": [
            {"date": d.get("date"), "opened": d.get("opened", 0),
             "completed": d.get("completed", 0)}
            for d in trend
        ],
    })


@app.route("/api/needs", methods=["GET"])
def api_needs_list():
    return jsonify({"needs": needs_store.list_needs(
        category=request.args.get("category"),
        status=request.args.get("status"),
    )})


@app.route("/api/needs", methods=["POST"])
def api_needs_add():
    if not _needs_limiter.is_allowed(request.remote_addr or "unknown"):
        return jsonify({"error": "Slow down - too many entries in a minute."}), 429
    clean, error = needs_store.validate_new(request.get_json(silent=True))
    if error:
        return jsonify({"error": error}), 400
    need = needs_store.add_need(clean)
    if need["urgency"] == "immediate":
        notify.need_now(need)   # background thread; no-op if GCHAT_WEBHOOK_URL is unset
    return jsonify({"need": need, "chat": notify.enabled() and need["urgency"] == "immediate"}), 201


def coffee_morning_check():
    """9:00 AM Eastern: post open coffee-bar items to Google Chat."""
    if not notify.enabled():
        return
    try:
        notify.coffee_morning_check(needs_store.list_needs(category="coffee", status="open"))
    except Exception:
        logger.exception("Coffee morning check failed")


@app.route("/api/notify/test", methods=["POST"])
def api_notify_test():
    """Manager-only: send a test message to the Google Chat space."""
    if not notify.enabled():
        return jsonify({"error": "GCHAT_WEBHOOK_URL is not set in Railway."}), 400
    ok = notify.send("Test from the Altar shop dashboard. Notifications are working.", wait=True)
    return (jsonify({"status": "sent"}), 200) if ok else (jsonify({"error": "Google Chat rejected it. Check the webhook URL."}), 502)


@app.route("/api/needs/<int:need_id>", methods=["PATCH"])
def api_needs_update(need_id):
    if not _needs_limiter.is_allowed(request.remote_addr or "unknown"):
        return jsonify({"error": "Slow down - too many changes in a minute."}), 429
    data = request.get_json(silent=True) or {}
    need, error = needs_store.set_status(need_id, str(data.get("status", "")), data.get("by", ""))
    if error:
        return jsonify({"error": error}), 400 if "Status" in error else 404
    return jsonify({"need": need})


@app.route("/api/needs/<int:need_id>", methods=["DELETE"])
def api_needs_delete(need_id):
    if not _needs_limiter.is_allowed(request.remote_addr or "unknown"):
        return jsonify({"error": "Slow down - too many changes in a minute."}), 429
    if not needs_store.delete_need(need_id):
        return jsonify({"error": "That item isn't on the list anymore."}), 404
    return jsonify({"status": "deleted"})


@app.route("/api/needs/export")
def api_needs_export():
    """Full history as CSV (manager only)."""
    rows = needs_store.export_rows()
    buf = io.StringIO()
    fields = ["id", "item", "qty", "category", "urgency", "notes", "requested_by",
              "status", "created_at", "updated_at", "updated_by", "amazon_url"]
    w = csv.DictWriter(buf, fieldnames=fields, extrasaction="ignore")
    w.writeheader()
    for row in rows:
        w.writerow({k: _csv_safe(v) for k, v in row.items()})
    stamp = datetime.utcnow().strftime("%Y-%m-%d")
    return Response(buf.getvalue(), mimetype="text/csv", headers={
        "Content-Disposition": f"attachment; filename=altar_needs_{stamp}.csv"})


# ---------------------------------------------------------------------------
# Shop use - scan items taken for shop use; manager applies them to Lightspeed
# ---------------------------------------------------------------------------

def _lookup_code(code):
    """Returns (item, error_response)."""
    try:
        item = shop_use.lookup(LightspeedClient(), code)
    except Exception:
        logger.exception("Shop use lookup failed for %s", code)
        return None, (jsonify({"error": "Can't reach Lightspeed right now. Try again in a minute."}), 502)
    if not item:
        return None, (jsonify({"error": "That barcode isn't in Lightspeed. Tell a manager."}), 404)
    return item, None


@app.route("/api/shop-use/lookup")
def api_shop_use_lookup():
    if not _scan_limiter.is_allowed(request.remote_addr or "unknown"):
        return jsonify({"error": "Too many scans in a minute. Slow down."}), 429
    code = shop_use.clean_code(request.args.get("code"))
    if not code:
        return jsonify({"error": "That scan didn't read. Try again."}), 400
    item, err = _lookup_code(code)
    if err:
        return err
    return jsonify({"item": shop_use.public_item(item), "code": code})


@app.route("/api/shop-use", methods=["GET"])
def api_shop_use_recent():
    return jsonify({"entries": shop_use.recent()})


@app.route("/api/shop-use", methods=["POST"])
def api_shop_use_add():
    if not _needs_limiter.is_allowed(request.remote_addr or "unknown"):
        return jsonify({"error": "Slow down - too many entries in a minute."}), 429
    data = request.get_json(silent=True) or {}
    code = shop_use.clean_code(data.get("code"))
    if not code:
        return jsonify({"error": "Scan the item first."}), 400
    item, err = _lookup_code(code)
    if err:
        return err
    entry, error = shop_use.add(item, code, data.get("qty", 1), data.get("used_by"), data.get("note"))
    if error:
        return jsonify({"error": error}), 400
    return jsonify({"entry": entry}), 201


@app.route("/api/shop-use/<int:entry_id>", methods=["DELETE"])
def api_shop_use_cancel(entry_id):
    if not shop_use.cancel(entry_id):
        return jsonify({"error": "Already applied or gone - ask a manager."}), 404
    return jsonify({"status": "deleted"})


@app.route("/shop-use/review")
def shop_use_review():
    return render_template("shop_use_review.html")


@app.route("/api/shop-use/review")
def api_shop_use_review():
    status = request.args.get("status")
    if status not in ("pending", "applied", "rejected", "failed"):
        status = None
    return jsonify({"entries": shop_use.list_for_review(status)})


@app.route("/api/shop-use/apply", methods=["POST"])
def api_shop_use_apply():
    ids = (request.get_json(silent=True) or {}).get("ids") or []
    try:
        client = LightspeedClient()
    except Exception:
        logger.exception("Shop use apply: Lightspeed client failed")
        return jsonify({"error": "Can't reach Lightspeed right now."}), 502
    result = shop_use.apply(client, ids, by="manager")
    if "error" in result:
        return jsonify(result), 409
    return jsonify(result)


@app.route("/api/shop-use/reject", methods=["POST"])
def api_shop_use_reject():
    ids = (request.get_json(silent=True) or {}).get("ids") or []
    return jsonify({"rejected": shop_use.reject(ids, "manager")})


@app.route("/api/shop-use/take", methods=["POST"])
def api_shop_use_take():
    """Manager scans an item they're taking and it comes out of Lightspeed now."""
    data = request.get_json(silent=True) or {}
    code = shop_use.clean_code(data.get("code"))
    if not code:
        return jsonify({"error": "Scan the item first."}), 400
    item, err = _lookup_code(code)
    if err:
        return err
    try:
        client = LightspeedClient()
    except Exception:
        logger.exception("Shop use take: Lightspeed client failed")
        return jsonify({"error": "Can't reach Lightspeed right now."}), 502
    result, error = shop_use.take_now(client, item, code, data.get("qty", 1),
                                      data.get("used_by") or "Manager", data.get("note"))
    if error:
        return jsonify({"error": error}), 400
    if "error" in result:
        return jsonify(result), 409
    return jsonify(result)


@app.route("/api/shop-use/usage")
def api_shop_use_usage():
    months = request.args.get("months", 12, type=int)
    return jsonify(shop_use.usage(months))


@app.route("/api/shop-use/usage.csv")
def api_shop_use_usage_csv():
    months = request.args.get("months", 12, type=int)
    u = shop_use.usage(months)
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["item", "system_sku", *u["months"], "total", "avg_per_month_last_3",
                "suggested_min_stock", "times_used", "last_used", "unit_cost", "est_cost"])
    for it in u["items"]:
        w.writerow([_csv_safe(it["description"]), it["system_sku"],
                    *[it["by_month"][m] for m in u["months"]], it["total"], it["avg_3mo"],
                    it["suggested_min"], it["uses"], it["last_used"], it["unit_cost"],
                    "" if it["est_cost"] is None else it["est_cost"]])
    stamp = datetime.utcnow().strftime("%Y-%m-%d")
    return Response(buf.getvalue(), mimetype="text/csv", headers={
        "Content-Disposition": f"attachment; filename=altar_shop_use_usage_{stamp}.csv"})


@app.route("/api/shop-use/export")
def api_shop_use_export():
    rows = shop_use.export_rows()
    buf = io.StringIO()
    fields = ["id", "created_at", "used_by", "description", "system_sku", "code", "qty",
              "unit_cost", "note", "status", "applied_at", "qoh_before", "qoh_after", "error"]
    w = csv.DictWriter(buf, fieldnames=fields, extrasaction="ignore")
    w.writeheader()
    for row in rows:
        w.writerow({k: _csv_safe(v) for k, v in row.items()})
    stamp = datetime.utcnow().strftime("%Y-%m-%d")
    return Response(buf.getvalue(), mimetype="text/csv", headers={
        "Content-Disposition": f"attachment; filename=altar_shop_use_{stamp}.csv"})


def _csv_safe(v):
    """Stop Excel treating staff-typed text as a formula; leave numbers alone."""
    if not isinstance(v, str) or not v or v[0] not in "=+-@":
        return v
    try:
        float(v)
        return v
    except ValueError:
        return "'" + v


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.route("/")
def dashboard():
    return render_template("dashboard.html")


@app.route("/api/data")
def api_data():
    """JSON endpoint consumed by the dashboard JS."""
    if not _cache:
        return jsonify({"error": "No data yet. Trigger a refresh or wait for the daily job."}), 503
    return jsonify(_cache)


@app.route("/api/refresh", methods=["POST"])
def api_refresh():
    """Manual refresh trigger (useful for testing or webhooks)."""
    secret = os.getenv("REFRESH_SECRET", "")
    from flask import request
    if secret and request.headers.get("X-Refresh-Secret") != secret:
        return jsonify({"error": "unauthorized"}), 401
    if not refresh_data():
        # Don't report success for a refresh that actually failed - that is how
        # a dead token chain went unnoticed for two hours on 18 Aug.
        return jsonify({
            "status": "error",
            "error": "Refresh failed. Check the service logs for the cause.",
        }), 502
    return jsonify({"status": "ok", "generated_at": _cache.get("generated_at")})


@app.route("/api/chat", methods=["POST"])
def api_chat():
    """AI chat endpoint â uses Claude Sonnet 4.6 with real-time Lightspeed tool use."""
    # Rate limit by IP
    client_ip = request.remote_addr or "unknown"
    if not _chat_limiter.is_allowed(client_ip):
        return jsonify({"error": "Too many requests. Please wait a moment before asking another question."}), 429

    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        return jsonify({"error": "ANTHROPIC_API_KEY not configured. Add it in Railway Variables."}), 503

    try:
        ls_client = LightspeedClient()
        result = api_chat_with_tools(ls_client, cache_data=_cache)
        return result
    except Exception as e:
        logger.exception("Chat API error")
        return jsonify({"error": f"AI request failed: {str(e)}"}), 500


# ---------------------------------------------------------------------------
# Catalog Import endpoints
# ---------------------------------------------------------------------------

@app.route("/api/import/upload", methods=["POST"])
def api_import_upload():
    """Upload a supplier catalog file and get a preview of changes.

    Accepts CSV or Excel file with UPC, description, price, mfr SKU, custom SKU columns.
    Matches against current Lightspeed inventory by UPC and returns a diff preview.
    """
    if "file" not in request.files:
        return jsonify({"error": "No file provided. Please select a CSV or Excel file."}), 400

    file = request.files["file"]
    if not file.filename:
        return jsonify({"error": "No file selected."}), 400

    # Parse the uploaded file
    rows, headers, error = parse_uploaded_file(file)
    if error:
        return jsonify({"error": error}), 400

    # Extract UPCs from the file, then look up only those specific UPCs
    # in Lightspeed (instead of fetching the entire inventory).
    try:
        from catalog_import import _detect_columns, _normalize_upc
        col_map = _detect_columns(headers)
        upc_col = col_map.get("upc")
        if upc_col is None:
            return jsonify({"error": "Could not find a UPC column in the file."}), 400
        upc_list = list(set(
            _normalize_upc(row[upc_col])
            for row in rows
            if upc_col < len(row) and _normalize_upc(row[upc_col])
        ))
        ls_client = LightspeedClient()
        upc_map = ls_client.get_items_by_upcs_batch(upc_list)
    except Exception as e:
        logger.exception("Failed to fetch Lightspeed items for import matching")
        return jsonify({"error": f"Failed to connect to Lightspeed: {str(e)}"}), 500

    # Match and generate preview
    result = match_against_lightspeed(rows, headers, upc_map)

    if "error" in result:
        return jsonify(result), 400

    return jsonify(result)


@app.route("/api/import/commit", methods=["POST"])
def api_import_commit():
    """Start a background commit of a previously previewed import to Lightspeed.

    Expects JSON body: {"session_id": "...", "include_new_items": false}
    Returns 202 Accepted immediately. Poll /api/import/status/<session_id> for progress.
    """
    data = request.get_json()
    if not data or "session_id" not in data:
        return jsonify({"error": "Missing session_id."}), 400

    session_id = data["session_id"]
    include_new = data.get("include_new_items", False)

    # Guard: already running
    if session_id in _active_imports and _active_imports[session_id].is_alive():
        return jsonify({"error": "Import is already running.", "session_id": session_id}), 409

    pending = get_pending_session(session_id)
    if not pending and "session_data" in data:
        # Fallback: use session data sent from the frontend (covers Railway redeploys)
        logger.info("Server-side session %s not found, using inline session_data from client", session_id)
        pending = data["session_data"]
        _save_session(session_id, pending)
    if not pending:
        return jsonify({"error": "Import session not found or expired. Please re-upload the file."}), 404

    # Guard: already complete
    if pending.get("commit_status") == "complete":
        return jsonify(pending.get("commit_result", {}))

    def run_commit():
        try:
            # Each thread gets its own LightspeedClient (separate requests.Session)
            client = LightspeedClient()
            commit_updates(session_id, client, include_new_items=include_new)
        except Exception:
            logger.exception("Background commit failed for session %s", session_id)
        finally:
            _active_imports.pop(session_id, None)

    t = threading.Thread(target=run_commit, daemon=True)
    _active_imports[session_id] = t
    t.start()

    return jsonify({"status": "started", "session_id": session_id}), 202


@app.route("/api/import/status/<session_id>")
def api_import_status(session_id):
    """Poll endpoint for import commit progress.

    Returns commit_status (pending, running, complete, failed, stalled)
    along with progress counters and result when done.
    """
    status = get_import_status(session_id)
    if not status:
        return jsonify({"error": "Import session not found."}), 404
    return jsonify(status)


@app.route("/health")
def health():
    """Health check with optional deep connectivity checks."""
    status = {
        "status": "healthy",
        "has_data": bool(_cache),
        "generated_at": _cache.get("generated_at"),
        "services": {}
    }

    # Check Lightspeed connectivity.
    #
    # The LS_ACCESS_TOKEN / LS_REFRESH_TOKEN env seeds are deliberately blank -
    # a stale seed reachable by normal code is what poisoned the chain for ten
    # days. The live pair lives in the token state file on the /data volume,
    # written by /auth/callback and by each lazy rotation. Checking only the env
    # vars therefore reported "missing_token" forever, which makes this endpoint
    # useless as a canary. Check the state file first, env seeds second.
    #
    # Presence only - no token value is ever read into the response.
    status["services"]["lightspeed"] = "missing_token"
    try:
        from lightspeed import _default_state_path
        state_path = os.getenv("TOKEN_STATE_PATH") or _default_state_path()
        if os.path.exists(state_path):
            with open(state_path) as f:
                token_state = json.load(f)
            if token_state.get("access_token") and token_state.get("refresh_token"):
                status["services"]["lightspeed"] = "configured"
    except Exception:
        # Never let the health check itself fail - Railway gates deploys on it.
        logger.exception("Health check could not read token state")

    if status["services"]["lightspeed"] == "missing_token" and (
        os.getenv("LIGHTSPEED_REFRESH_TOKEN") or os.getenv("LS_REFRESH_TOKEN")
    ):
        status["services"]["lightspeed"] = "configured"

    # Check Anthropic API key
    anthropic_key = os.getenv("ANTHROPIC_API_KEY")
    status["services"]["anthropic"] = "configured" if anthropic_key else "missing_key"

    # Deep check if requested (?deep=1)
    if request.args.get("deep") == "1":
        # Test Lightspeed connection
        try:
            ls_client = LightspeedClient()
            account = ls_client.get_account()
            status["services"]["lightspeed"] = "connected"
            status["lightspeed_account"] = account.get("name", "unknown") if account else "unknown"
        except Exception as e:
            status["services"]["lightspeed"] = f"error: {str(e)[:100]}"
            status["status"] = "degraded"

        # Test Anthropic connection
        if anthropic_key:
            try:
                from anthropic import Anthropic
                from langsmith.wrappers import wrap_anthropic
                client = wrap_anthropic(Anthropic())
                # Minimal API call to verify key works
                resp = client.messages.create(
                    model="claude-sonnet-4-6",
                    max_tokens=10,
                    messages=[{"role": "user", "content": "ping"}]
                )
                status["services"]["anthropic"] = "connected"
            except Exception as e:
                status["services"]["anthropic"] = f"error: {str(e)[:100]}"
                status["status"] = "degraded"

    return jsonify(status)


# ---------------------------------------------------------------------------
# Monthly report generation
# ---------------------------------------------------------------------------

_report_cache = {}  # month_label â {"csv": str, "metadata": dict}



@app.route("/api/cache-export")
def cache_export():
    """Export the classification cache so it can be committed as a seed file."""
    from data_processor import _classification_cache
    return jsonify(_classification_cache)


def run_monthly_report(year=None, month=None):
    """Generate the monthly report and save CSV to disk."""
    try:
        csv_string, metadata = generate_monthly_report(year, month)
        month_label = metadata["month"]
        filename = f"employee_report_{month_label}.csv"
        filepath = os.path.join(REPORTS_DIR, filename)
        with open(filepath, "w", newline="") as f:
            f.write(csv_string)
        _report_cache[month_label] = {"csv": csv_string, "metadata": metadata, "file": filepath}
        logger.info("Monthly report saved: %s", filepath)
    except Exception:
        logger.exception("Monthly report generation failed")


@app.route("/api/report/generate", methods=["POST"])
def api_generate_report():
    """Manually trigger report generation. Optional query params: year, month."""
    year = request.args.get("year", type=int)
    month = request.args.get("month", type=int)
    run_monthly_report(year, month)
    # Find the latest report
    if year and month:
        label = f"{year}-{month:02d}"
    else:
        from datetime import timedelta as td
        last = (datetime.utcnow().replace(day=1) - td(days=1))
        label = last.strftime("%Y-%m")
    report = _report_cache.get(label)
    if report:
        return jsonify({"status": "ok", **report["metadata"],
                        "download_url": f"/api/report/download/{label}"})
    return jsonify({"status": "error", "message": "Report generation failed"}), 500


@app.route("/api/report/download/<month_label>")
def api_download_report(month_label):
    """Download a generated report CSV."""
    report = _report_cache.get(month_label)
    if not report:
        # Try loading from disk
        filepath = os.path.join(REPORTS_DIR, f"employee_report_{month_label}.csv")
        if os.path.exists(filepath):
            with open(filepath) as f:
                csv_data = f.read()
            report = {"csv": csv_data}
        else:
            return jsonify({"error": f"No report found for {month_label}"}), 404

    from flask import Response
    return Response(
        report["csv"],
        mimetype="text/csv",
        headers={"Content-Disposition": f"attachment; filename=employee_report_{month_label}.csv"},
    )


@app.route("/api/report/list")
def api_list_reports():
    """List available reports."""
    files = []
    if os.path.exists(REPORTS_DIR):
        for f in sorted(os.listdir(REPORTS_DIR), reverse=True):
            if f.endswith(".csv"):
                label = f.replace("employee_report_", "").replace(".csv", "")
                files.append({"month": label, "download_url": f"/api/report/download/{label}"})
    return jsonify({"reports": files})


# ---------------------------------------------------------------------------
# OAuth flow â get tokens directly via Railway (HTTPS)
# ---------------------------------------------------------------------------

# Modern OAuth endpoints. The legacy /oauth/authorize.php + /oauth/access_token.php
# pair returns 400 for modern tokens (see lightspeed.py's module docstring), so the
# code exchange must target the same TOKEN_URL the rotator uses - importing it keeps
# the two from drifting apart again.
LS_AUTH_URL = "https://us.merchantos.com/auth/oauth/authorize"
LS_TOKEN_URL = LS_TOKEN_ENDPOINT


@app.route("/auth/start")
def auth_start():
    """Step 1: Redirect user to Lightspeed to authorize the app."""
    client_id = os.getenv("LS_CLIENT_ID", "")
    if not client_id:
        return "Error: LS_CLIENT_ID not set in environment variables.", 500

    base = request.url_root.rstrip("/")
    if base.startswith("http://"):
        base = "https://" + base[7:]
    redirect_uri = base + "/auth/callback"

    params = urlencode({
        "response_type": "code",
        "client_id": client_id,
        "scope": "employee:all",
        "state": "altar",
        "redirect_uri": redirect_uri,
    })
    return redirect(f"{LS_AUTH_URL}?{params}")


@app.route("/auth/callback")
def auth_callback():
    """Step 2: Lightspeed redirects here with a code. Exchange it for tokens."""
    code = request.args.get("code")
    error = request.args.get("error")

    if error:
        return f"""
        <html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#1a1a2e;color:#eee">
        <h1>Authorization Error</h1>
        <p style="color:#ff6b6b">{error}: {request.args.get('error_description','')}</p>
        </body></html>
        """

    if not code:
        return "Error: No authorization code received.", 400

    client_id = os.getenv("LS_CLIENT_ID", "")
    client_secret = os.getenv("LS_CLIENT_SECRET", "")
    base = request.url_root.rstrip("/")
    if base.startswith("http://"):
        base = "https://" + base[7:]
    redirect_uri = base + "/auth/callback"

    try:
        resp = http_requests.post(
            LS_TOKEN_URL,
            data={
                "client_id": client_id,
                "client_secret": client_secret,
                "code": code,
                "grant_type": "authorization_code",
                "redirect_uri": redirect_uri,
            },
            # Cloudflare fronts the token endpoint and rejects the default
            # python-requests User-Agent with error 1010.
            headers={"User-Agent": BROWSER_UA},
            timeout=30,
        )
        result = resp.json()
    except Exception as e:
        return f"Error exchanging code: {e}", 500

    access_token = result.get("access_token", "")
    refresh_token = result.get("refresh_token", "")

    if not access_token:
        return f"""
        <html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#1a1a2e;color:#eee">
        <h1>Token Exchange Failed</h1>
        <pre style="color:#ff6b6b;text-align:left;max-width:600px;margin:auto">{json.dumps(result, indent=2)}</pre>
        </body></html>
        """

    # Persist server-side. This is the entire point of routing the callback
    # through the app: the pair must reach the state file on the /data volume
    # before this response is rendered. The previous version displayed the two
    # tokens for manual copying into Railway variables and persisted nothing,
    # so every re-auth was silently thrown away - which is why the chain was
    # dead all of 18 Aug despite this route returning 200.
    #
    # Tokens are never rendered into the page and never logged.
    if not persist_token_pair(access_token, refresh_token):
        return """
        <html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#1a1a2e;color:#eee">
        <h1 style="color:#ff6b6b">Authorized, but Saving Failed</h1>
        <p>The grant succeeded and was then lost: the token state file could not be written.</p>
        <p style="color:#888">Check the service logs for "Could not persist new token pair".</p>
        </body></html>
        """, 500

    logger.info("OAuth callback stored a new token pair (pid %s)", os.getpid())

    return """
    <html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#1a1a2e;color:#eee">
    <h1 style="color:#00d4aa">Authorization Successful</h1>
    <p>The token pair was saved to the service's token state file.</p>
    <p style="color:#888">Nothing to copy - you can close this tab.</p>
    <p style="margin-top:24px"><a href="/" style="color:#00d4aa">Back to the dashboard</a></p>
    </body></html>
    """


# ---------------------------------------------------------------------------
# Scheduler â daily refresh
# ---------------------------------------------------------------------------

scheduler = BackgroundScheduler()
refresh_hour = int(os.getenv("REFRESH_HOUR", "6"))   # default 6 AM UTC
scheduler.add_job(refresh_data, "cron", hour=refresh_hour, minute=0)
# Monthly report on the 1st at 7 AM UTC
scheduler.add_job(run_monthly_report, "cron", day=1, hour=7, minute=0, id="monthly_report")
# Clean up expired import sessions every hour
scheduler.add_job(cleanup_old_sessions, "interval", hours=1, id="cleanup_import_sessions")
# Coffee bar check at 9:00 AM shop time -> Google Chat
scheduler.add_job(coffee_morning_check, "cron", hour=9, minute=0,
                  timezone=notify.SHOP_TZ, id="coffee_morning_check")
scheduler.start()


# ---------------------------------------------------------------------------
# Startup
# ---------------------------------------------------------------------------

load_cache()
needs_store.init_db()
shop_use.init_db()

if os.getenv("REFRESH_ON_START", "true").lower() == "true":
    # Kick off first refresh in background so the app starts quickly
    threading.Thread(target=refresh_data, daemon=True).start()

if __name__ == "__main__":
    port = int(os.getenv("PORT", "8080"))
    app.run(host="0.0.0.0", port=port, debug=os.getenv("FLASK_DEBUG", "0") == "1")
