"""Closing positions and the mandatory handover (relève).

A position that is closed, or whose controller lost the connection, is freed at once — the controller is never
blocked. On an airport the next position below must take it over (GND takes TWR, TWR takes APP): its controller
gets a blocking notice « Reprendre maintenant »; without an answer the takeover is automatic after 2 minutes.
"""

import json
import uuid
from datetime import timedelta
from functools import lru_cache
from pathlib import Path

from lib.control import AIRPORT_ORDER, ONLINE_S
from lib.db import db
from lib.engine import aware, utcnow
from lib.events import log_event
from lib import discord_bot_client

HANDOVER_S = 120
FREQ_FILE = Path(__file__).resolve().parent.parent / "data" / "frequencies.json"


@lru_cache(maxsize=1)
def _freqs() -> dict[str, dict[str, str]]:
    try:
        return json.loads(FREQ_FILE.read_text())
    except FileNotFoundError:
        return {}


async def preset_frequency(icao: str, position: str) -> tuple[str | None, str | None]:
    """(frequency, source): OurAirports data first, then a frequency already entered by a controller."""
    f = _freqs().get(icao.upper(), {}).get(position)
    if f:
        return f, "ourairports"
    d = await db.frequencies.find_one({"key": f"{icao.upper()}_{position}"}, {"_id": 0})
    return (d["frequency"], "communaute") if d else (None, None)


async def remember_frequency(icao: str, position: str, frequency: str, user: dict) -> None:
    """A manually entered frequency is kept for the next openings (only when no published one exists)."""
    if _freqs().get(icao.upper(), {}).get(position):
        return
    await db.frequencies.update_one({"key": f"{icao.upper()}_{position}"},
                                    {"$set": {"key": f"{icao.upper()}_{position}", "frequency": frequency,
                                              "set_by": user["display_name"], "set_at": utcnow()}}, upsert=True)


def _below(kind: str) -> tuple[str, ...]:
    return AIRPORT_ORDER[AIRPORT_ORDER.index(kind) + 1:] if kind in AIRPORT_ORDER else ()


async def close_positions(docs: list[dict], reason: str, actor: dict | None) -> None:
    """Frees the given positions immediately and opens the handovers they require."""
    now = utcnow()
    closing = {d["id"] for d in docs}
    # highest first (APP, TWR, GND, then CTR) so the positions below are still there to receive the handover
    docs = sorted(docs, key=lambda d: AIRPORT_ORDER.index(d["type"]) if d["type"] in AIRPORT_ORDER else 9)
    for d in docs:
        res = await db.atc_positions.delete_one({"id": d["id"]})
        if not res.deleted_count:
            continue  # already closed by a concurrent request
        # activity on the network (lib/activity): the controller was on position until now
        await db.users.update_one({"id": d["user_id"]}, {"$set": {"atc_last_active": min(now, aware(d["last_seen"]) or now)}})
        who = actor or {"id": d["user_id"], "display_name": d["controller"], "role": "atc"}
        label = "Fermeture de position ATC" if reason == "fermeture" else "Position ATC libérée (connexion perdue)"
        await log_event("atc", label, who, None, d["callsign"])
        await db.atc_handovers.delete_many({"to_position_id": d["id"]})  # it can no longer take anything over

        # Synchronise fermeture côté bot Discord (suppression des salons)
        freq_id = d.get("discord_freq_id")
        if freq_id is not None:
            by_id = None
            if actor and actor.get("discord_id"):
                by_id = actor["discord_id"]
            else:
                # récupère le discord_id du contrôleur si possible
                u = await db.users.find_one({"id": d["user_id"]}, {"discord_id": 1})
                if u:
                    by_id = u.get("discord_id")
            await discord_bot_client.close_frequency(freq_id, by_discord_id=by_id)

        if not d.get("airport") or d["type"] not in AIRPORT_ORDER:
            continue
        # the next open position below, held by another controller, must take over
        since = now - timedelta(seconds=ONLINE_S)
        for t in _below(d["type"]):
            q = await db.atc_positions.find_one({"airport": d["airport"], "type": t, "last_seen": {"$gte": since},
                                                 "id": {"$nin": list(closing)}}, {"_id": 0})
            if not q:
                continue  # not open (or closing in the same batch): look further below
            if q["user_id"] != d["user_id"]:
                await db.atc_handovers.update_one(
                    {"airport": d["airport"], "position": d["type"]},
                    {"$set": {"id": str(uuid.uuid4()), "airport": d["airport"], "position": d["type"],
                              "callsign": d["callsign"], "frequency": d["frequency"],
                              "from_controller": d["controller"], "to_user_id": q["user_id"],
                              "to_position_id": q["id"],
                              "reason": "fermeture" if reason == "fermeture" else "connexion perdue",
                              "created_at": now, "deadline": now + timedelta(seconds=HANDOVER_S)}},
                    upsert=True)
            break


async def accept_handover(h: dict, automatic: bool) -> dict | None:
    """The receiving controller now also holds the position (cumul on the same airport)."""
    if not await db.atc_handovers.find_one_and_delete({"id": h["id"]}):
        return None
    now = utcnow()
    since = now - timedelta(seconds=ONLINE_S)
    if await db.atc_positions.find_one({"callsign": h["callsign"], "last_seen": {"$gte": since}}, {"_id": 1}):
        return None  # someone reopened it meanwhile
    holder = await db.atc_positions.find_one({"id": h["to_position_id"], "last_seen": {"$gte": since}}, {"_id": 0})
    if not holder:
        return None
    doc = {**{k: holder[k] for k in ("user_id", "controller", "airport", "lat", "lon")},
           "id": str(uuid.uuid4()), "callsign": h["callsign"], "type": h["position"], "frequency": h["frequency"],
           "radius_nm": {"APP": 30.0, "TWR": 8.0, "GND": 3.0}.get(h["position"], 0.0), "fir_id": None,
           "tracon_id": None, "opened_at": now, "last_seen": now}
    await db.atc_positions.insert_one(dict(doc))
    await log_event("atc", "Relève automatique (2 min)" if automatic else "Relève : position reprise",
                    {"id": holder["user_id"], "display_name": holder["controller"], "role": "atc"}, None,
                    f"{holder['callsign']} reprend {h['callsign']}")
    return doc


async def process(now=None) -> None:
    """Background (engine tick): positions without heartbeat are freed, expired handovers are applied."""
    now = now or utcnow()
    stale = await db.atc_positions.find({"last_seen": {"$lt": now - timedelta(seconds=ONLINE_S)}},
                                        {"_id": 0}).to_list(200)
    if stale:
        await close_positions(stale, "connexion", None)
    async for h in db.atc_handovers.find({"deadline": {"$lte": now}}, {"_id": 0}):
        await accept_handover(h, automatic=True)
    # handovers whose position was reopened by someone else are pointless
    async for h in db.atc_handovers.find({}, {"_id": 0}):
        if await db.atc_positions.find_one({"callsign": h["callsign"]}, {"_id": 1}):
            await db.atc_handovers.delete_one({"id": h["id"]})


def handover_out(h: dict) -> dict:
    return {**{k: h[k] for k in ("id", "airport", "position", "callsign", "frequency", "from_controller", "reason")},
            "created_at": aware(h["created_at"]), "deadline": aware(h["deadline"])}