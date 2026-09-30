"""
Shop Needs list - staff-entered inventory and supply requests.

Stored in SQLite on the Railway volume (/data) so the list survives redeploys
and is shared by every shop PC. Falls back to a local file for development.

Statuses: open -> ordered -> received. Anything can be removed (typos happen).
"""

import os
import re
import sqlite3
from urllib.parse import urlparse
import threading
from datetime import datetime, timezone

CATEGORIES = ("inventory", "supplies", "coffee")
# Categories that can carry an Amazon link and show in the Amazon view.
NON_BIKE = ("supplies", "coffee")
AMAZON_HOSTS = ("amazon.com", "a.co", "amzn.to", "amzn.com")
MAX_URL = 600
STATUSES = ("open", "ordered", "received")
URGENCIES = ("normal", "urgent", "immediate")

MAX_ITEM = 120
MAX_NOTES = 500
MAX_NAME = 40
MAX_QTY = 9999

_lock = threading.Lock()


def _db_path():
    explicit = os.getenv("NEEDS_DB_PATH")
    if explicit:
        return explicit
    if os.path.isdir("/data"):
        return "/data/needs.db"
    return "needs.db"


def _connect():
    conn = sqlite3.connect(_db_path(), timeout=10)
    conn.row_factory = sqlite3.Row
    return conn


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def init_db():
    with _lock, _connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS needs (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                item         TEXT    NOT NULL,
                qty          INTEGER NOT NULL DEFAULT 1,
                category     TEXT    NOT NULL DEFAULT 'inventory',
                urgency      TEXT    NOT NULL DEFAULT 'normal',
                notes        TEXT    NOT NULL DEFAULT '',
                requested_by TEXT    NOT NULL DEFAULT '',
                status       TEXT    NOT NULL DEFAULT 'open',
                created_at   TEXT    NOT NULL,
                updated_at   TEXT    NOT NULL,
                updated_by   TEXT    NOT NULL DEFAULT ''
            )
            """
        )
        cols = {r[1] for r in conn.execute("PRAGMA table_info(needs)")}
        if "amazon_url" not in cols:
            conn.execute("ALTER TABLE needs ADD COLUMN amazon_url TEXT NOT NULL DEFAULT ''")


def _row(r):
    return dict(r) if r else None


def _clean_text(value, limit):
    return " ".join(str(value or "").split())[:limit]


def clean_amazon_url(value):
    """Return (url, asin, error). Empty input is fine."""
    url = str(value or "").strip()[:MAX_URL]
    if not url:
        return "", "", None
    if not url.startswith(("http://", "https://")):
        url = "https://" + url
    host = (urlparse(url).hostname or "").lower()
    if not any(host == h or host.endswith("." + h) for h in AMAZON_HOSTS):
        return None, None, "That link isn't an Amazon link. Paste it from amazon.com or leave it blank."
    m = re.search(r"/(?:dp|gp/product|gp/aw/d|product)/([A-Z0-9]{10})(?:[/?]|$)", url)
    return url, (m.group(1) if m else ""), None


def with_asin(row):
    if row is not None:
        row["asin"] = clean_amazon_url(row.get("amazon_url"))[1] if row.get("amazon_url") else ""
    return row


def validate_new(data):
    """Return (clean_dict, error_message)."""
    if not isinstance(data, dict):
        return None, "Send the need as JSON."
    item = _clean_text(data.get("item"), MAX_ITEM)
    if not item:
        return None, "What's needed? The item can't be blank."
    try:
        raw_qty = data.get("qty")
        qty = 1 if raw_qty in (None, "") else int(raw_qty)
    except (TypeError, ValueError):
        return None, "Quantity has to be a whole number."
    if qty < 1 or qty > MAX_QTY:
        return None, f"Quantity has to be between 1 and {MAX_QTY}."
    category = str(data.get("category") or "inventory").lower()
    if category not in CATEGORIES:
        return None, "Pick Bike inventory, Shop supplies, or Coffee bar."
    urgency = str(data.get("urgency") or "normal").lower()
    if urgency not in URGENCIES:
        urgency = "normal"
    requested_by = _clean_text(data.get("requested_by"), MAX_NAME)
    if not requested_by:
        return None, "Add your name so we know who to ask."
    notes = str(data.get("notes") or "").strip()[:MAX_NOTES]
    amazon_url = ""
    if category in NON_BIKE:
        amazon_url, _, err = clean_amazon_url(data.get("amazon_url"))
        if err:
            return None, err
    return {
        "item": item, "qty": qty, "category": category, "urgency": urgency,
        "notes": notes, "requested_by": requested_by, "amazon_url": amazon_url,
    }, None


def list_needs(include_received_days=7, category=None, status=None):
    """Open and ordered items, plus anything received in the last N days.

    Optional category / status filters.
    """
    where, args = [], []
    if category in CATEGORIES:
        where.append("category = ?"); args.append(category)
    if status in STATUSES:
        where.append("status = ?"); args.append(status)
    extra = "".join(f" AND {w}" for w in where)
    with _connect() as conn:
        rows = conn.execute(
            f"""
            SELECT * FROM needs
            WHERE (status != 'received'
               OR julianday(updated_at) >= julianday('now', ?)){extra}
            ORDER BY
                CASE status WHEN 'open' THEN 0 WHEN 'ordered' THEN 1 ELSE 2 END,
                CASE urgency WHEN 'immediate' THEN 0 WHEN 'urgent' THEN 1 ELSE 2 END,
                created_at DESC
            """,
            (f"-{int(include_received_days)} days", *args),
        ).fetchall()
    return [with_asin(_row(r)) for r in rows]


def add_need(clean):
    now = _now()
    with _lock, _connect() as conn:
        cur = conn.execute(
            """
            INSERT INTO needs (item, qty, category, urgency, notes, requested_by,
                               status, created_at, updated_at, updated_by, amazon_url)
            VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)
            """,
            (clean["item"], clean["qty"], clean["category"], clean["urgency"],
             clean["notes"], clean["requested_by"], now, now, clean["requested_by"],
             clean["amazon_url"]),
        )
        row = conn.execute("SELECT * FROM needs WHERE id = ?", (cur.lastrowid,)).fetchone()
    return with_asin(_row(row))


def set_status(need_id, status, by=""):
    if status not in STATUSES:
        return None, "Status must be open, ordered, or received."
    with _lock, _connect() as conn:
        cur = conn.execute(
            "UPDATE needs SET status = ?, updated_at = ?, updated_by = ? WHERE id = ?",
            (status, _now(), _clean_text(by, MAX_NAME), int(need_id)),
        )
        if cur.rowcount == 0:
            return None, "That item isn't on the list anymore."
        row = conn.execute("SELECT * FROM needs WHERE id = ?", (int(need_id),)).fetchone()
    return with_asin(_row(row)), None


def delete_need(need_id):
    with _lock, _connect() as conn:
        cur = conn.execute("DELETE FROM needs WHERE id = ?", (int(need_id),))
    return cur.rowcount > 0


def export_rows():
    """Everything, oldest first - for the CSV export."""
    with _connect() as conn:
        rows = conn.execute("SELECT * FROM needs ORDER BY created_at").fetchall()
    return [_row(r) for r in rows]
