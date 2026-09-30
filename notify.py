"""
Google Chat notifications via a space's incoming webhook.

Set GCHAT_WEBHOOK_URL in Railway (Chat space -> Apps & integrations ->
Add webhooks). If it's unset, every send is a quiet no-op, so the app runs
fine without it. Sends happen on a background thread so a slow Google never
holds up a staff member's tap.

The webhook URL contains a secret token - never log it or show it in a page.
"""

import logging
import os
import threading
import time
from datetime import datetime
from zoneinfo import ZoneInfo

import requests

logger = logging.getLogger(__name__)

SHOP_TZ = ZoneInfo("America/New_York")
_send_lock = threading.Lock()
_last_send = [0.0]   # Google allows ~1 request/second per space


def webhook_url():
    return os.getenv("GCHAT_WEBHOOK_URL", "").strip()


def enabled():
    return bool(webhook_url())


def shop_url():
    base = os.getenv("SHOP_URL") or (
        "https://" + os.getenv("RAILWAY_PUBLIC_DOMAIN") if os.getenv("RAILWAY_PUBLIC_DOMAIN") else "")
    return (base.rstrip("/") + "/shop") if base else "/shop"


def send(text, wait=False):
    """Post a plain-text message. Returns True/False when wait=True."""
    url = webhook_url()
    if not url:
        return False

    def _post():
        with _send_lock:
            gap = time.time() - _last_send[0]
            if gap < 1.1:
                time.sleep(1.1 - gap)
            try:
                r = requests.post(url, json={"text": text[:4000]}, timeout=10)
                _last_send[0] = time.time()
                if r.status_code >= 300:
                    logger.warning("Google Chat post failed: HTTP %s %s", r.status_code, r.text[:200])
                    return False
                return True
            except Exception as e:
                logger.warning("Google Chat post failed: %s", type(e).__name__)
                return False

    if wait:
        return _post()
    threading.Thread(target=_post, daemon=True).start()
    return True


CAT_LABEL = {"inventory": "Bike inventory", "supplies": "Shop supplies", "coffee": "Coffee bar"}


def need_now(need):
    """Someone marked a need as immediate."""
    lines = [
        f"*NEED NOW* · {CAT_LABEL.get(need['category'], need['category'])}",
        f"{need['qty']} × {need['item']}",
        f"Asked by {need['requested_by']}",
    ]
    if need.get("notes"):
        lines.append(f"_{need['notes']}_")
    if need.get("amazon_url"):
        lines.append(f"Amazon: {need['amazon_url']}")
    lines.append(f"Mark it on the shop screen: {shop_url()}")
    send("\n".join(lines))


def coffee_morning_check(open_coffee):
    """9 AM: coffee items still Needed. Posts nothing if the list is empty."""
    if not open_coffee:
        logger.info("Coffee check: nothing open, no post")
        return False
    n = len(open_coffee)
    lines = [f"*Coffee bar: {n} item{'s' if n != 1 else ''} still needed this morning*",
             "Nobody marked these ordered or received:"]
    for x in open_coffee:
        flag = " (NEED NOW)" if x.get("urgency") == "immediate" else (" (urgent)" if x.get("urgency") == "urgent" else "")
        lines.append(f"• {x['qty']} × {x['item']}{flag} · asked by {x['requested_by']}")
    lines.append(f"Sort it before open, then mark each one: {shop_url()}")
    return send("\n".join(lines), wait=True)


def now_local():
    return datetime.now(SHOP_TZ)
