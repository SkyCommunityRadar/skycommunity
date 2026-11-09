"""Messages waiting for the SkyCommunity Discord bot (outbox).

The site never talks to Discord itself: it drops ready-to-post French messages here, and the bot (run by the
community) fetches them with GET /api/bot/outbox, posts them, then confirms with POST /api/bot/outbox/{id}/done.
Targets: "annonces" (public channel), "responsables_pilotes", "responsables_atc" (staff channels),
"validation_atc" (same channel as planning mod requests), "membre" (DM). See docs/BOT.md.
"""

import os
import uuid
from typing import Literal

from lib.db import db
from lib.engine import utcnow

Target = Literal["annonces", "responsables_pilotes", "responsables_atc", "validation_atc", "membre"]


def link(path: str) -> str | None:
    """Direct link to a page of the site (APP_URL), added to the alerts so the responsable lands on the right page."""
    base = os.environ.get("APP_URL", "").rstrip("/")
    return f"{base}{path}" if base else None


async def notify(kind: str, target: Target, text: str, payload: dict | None = None,
                 discord_id: str | None = None, path: str | None = None) -> str | None:
    """Queues a message; returns its id (kept by the request so the bot can later mark the alert « traitée »)."""
    if target == "membre" and not discord_id:
        return None  # a member without Discord account cannot receive a private message
    url = link(path) if path else None
    mid = str(uuid.uuid4())
    await db.bot_outbox.insert_one({"id": mid, "type": kind, "target": target, "discord_id": discord_id,
                                    "text": text + (f"\n👉 {url}" if url else ""), "url": url,
                                    "payload": payload or {}, "created_at": utcnow(), "sent_at": None})
    return mid


async def handled(alert_id: str | None, target: Target, text: str) -> None:
    """The request announced by `alert_id` has been dealt with: the bot edits that alert (« ✅ Traitée par X »)."""
    if not alert_id:
        return
    await notify("traitee", target, text, {"replaces": alert_id})
