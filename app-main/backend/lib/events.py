"""Append-only activity log (flight history + admin journal). Server timestamps only."""

import uuid

from lib.db import db
from lib.engine import utcnow


async def log_event(type_: str, label: str, user: dict | None, flight: dict | None = None,
                    details: str | None = None, scope: str | None = None) -> None:
    """scope "pilote" / "atc": the event also appears in the history of the matching responsable (Suivi des membres)."""
    await db.events.insert_one({
        "id": str(uuid.uuid4()),
        "flight_id": flight["id"] if flight else None,
        "callsign": flight["callsign"] if flight else None,
        "at": utcnow(),
        "type": type_,
        "label": label,
        "actor_id": user["id"] if user else None,
        "actor_name": user["display_name"] if user else "Système (moteur)",
        "actor_role": user["role"] if user else "systeme",
        "details": details,
        "scope": scope,
    })
