"""Member activity on the network and the inactivity rule (inspired by IVAO).

- A pilot is active when he flies (last flight that left its stand); a controller when he holds an ATC position.
- After `days` without activity the matching access (Pilote or ATC) is suspended — only that one: a member with both
  roles can still use the other mode. `warn_days` before, the member is warned (banner + Discord message via the bot).
- The Responsable Pilotes (pilots), the Responsable ATC (controllers) and the administrators see everybody's activity
  and keep the hand on it: reactivate, exempt until a date (holidays…), or suspend at once.
- The suspended member can ask for a reactivation from the site; the request reaches the responsables.
Everything is decided here, server-side. Administrators and the responsable of a side are never suspended on that side.
"""

import time
from datetime import datetime, timedelta

from lib.db import db
from lib.discord_roles import access_of
from lib.engine import aware, utcnow

KINDS = ("pilote", "atc")
KIND_FR = {"pilote": "Pilote", "atc": "ATC"}
LEAD_FLAG = {"pilote": "pilot_lead", "atc": "atc_lead"}
LEAD_FR = {"pilote": "Responsable Pilotes", "atc": "Responsable ATC"}
DEFAULTS = {"enabled": True, "days": 30, "warn_days": 7}
MAX_DAYS = 30  # the community wants no more than 30 days without activity

_cache: dict = {"at": 0.0, "value": None}


async def settings(fresh: bool = False) -> dict:
    """{"since": datetime, "pilote": {...}, "atc": {...}} — cached 5 s (read on every request).

    `since` = the day the rule was switched on: nobody can be counted inactive for the time before it."""
    if fresh or time.monotonic() - _cache["at"] > 5 or _cache["value"] is None:
        doc = await db.settings.find_one({"_id": "activity"})
        if not doc:
            doc = {"_id": "activity", "since": utcnow(), **{k: dict(DEFAULTS) for k in KINDS}}
            await db.settings.update_one({"_id": "activity"}, {"$setOnInsert": doc}, upsert=True)
            doc = await db.settings.find_one({"_id": "activity"}) or doc
        rules = {k: {**DEFAULTS, **(doc.get(k) or {})} for k in KINDS}
        for r in rules.values():  # an older, longer setting is brought back to the maximum
            r["days"] = min(int(r["days"]), MAX_DAYS)
            r["warn_days"] = min(int(r["warn_days"]), r["days"] - 1)
        _cache["value"] = {"since": aware(doc["since"]), **rules}
        _cache["at"] = time.monotonic()
    return _cache["value"]


async def save_settings(kind: str, values: dict, user: dict) -> dict:
    await db.settings.update_one({"_id": "activity"}, {"$set": {**{f"{kind}.{k}": v for k, v in values.items()},
                                                                f"{kind}.by": user["display_name"],
                                                                f"{kind}.at": utcnow()}})
    return await settings(fresh=True)


def can_manage(user: dict, kind: str) -> bool:
    a = access_of(user)
    return a["admin"] or a[LEAD_FLAG[kind]]


def concerned(user: dict, kind: str) -> bool:
    """The rule applies to members holding that access who are neither administrator nor its responsable."""
    a = access_of(user)
    return a[kind] and not a["admin"] and not a[LEAD_FLAG[kind]]


async def last_flight_at(user_id: str) -> datetime | None:
    f = await db.flights.find_one({"pilot_id": user_id, "block_off_at": {"$ne": None}},
                                  {"_id": 0, "updated_at": 1}, sort=[("updated_at", -1)])
    return aware(f["updated_at"]) if f else None


async def last_atc_at(user: dict) -> datetime | None:
    if await db.atc_positions.find_one({"user_id": user["id"]}, {"_id": 1}):
        return utcnow()  # holding a position right now
    return aware(user.get("atc_last_active"))


async def last_activity(user: dict, kind: str) -> datetime | None:
    """Real activity only (flights / ATC positions), used for display."""
    return await (last_flight_at(user["id"]) if kind == "pilote" else last_atc_at(user))


def _sub(user: dict, field: str, kind: str) -> dict:
    v = (user.get(field) or {}).get(kind)
    return v if isinstance(v, dict) else {}


def status_from(user: dict, kind: str, cfg: dict, last: datetime | None, now: datetime | None = None) -> dict:
    """Pure computation of the inactivity state of one access.

    state: non_concerne · actif · bientot (warning period) · dispense (exempted) · suspendu"""
    now = now or utcnow()
    c = cfg[kind]
    out = {"kind": kind, "state": "non_concerne", "last_activity": last, "days_inactive": None, "deadline": None,
           "exempt_until": None, "manual": False, "reason": None,
           "request_at": aware(_sub(user, "reactivation_request", kind).get("at"))}
    if not concerned(user, kind):
        return out
    reactivated = aware(_sub(user, "reactivated", kind).get("at"))
    ex = _sub(user, "activity_exempt", kind)
    ex_from, exempt = aware(ex.get("from")), aware(ex.get("until"))
    # the clock starts at the latest of: real activity, last reactivation, end of the last exemption / absence,
    # account creation, rule switched on
    ended = exempt if exempt and exempt <= now else None
    ref = max(d for d in (last, reactivated, ended, aware(user.get("created_at")), cfg["since"]) if d)
    out["days_inactive"] = (now - last).days if last else None
    out["deadline"] = ref + timedelta(days=int(c["days"]))
    block = _sub(user, "activity_block", kind)
    if block and (not reactivated or aware(block.get("at")) > reactivated):
        return {**out, "state": "suspendu", "manual": True, "reason": block.get("reason") or "Suspension par un responsable."}
    if exempt and exempt > now and (not ex_from or ex_from <= now):
        return {**out, "state": "dispense", "exempt_until": exempt}
    if not c["enabled"]:
        return {**out, "state": "actif"}
    if now >= out["deadline"]:
        return {**out, "state": "suspendu",
                "reason": f"Aucune activité {'de vol' if kind == 'pilote' else 'ATC'} depuis plus de {c['days']} jours."}
    if now >= out["deadline"] - timedelta(days=int(c["warn_days"])):
        return {**out, "state": "bientot"}
    return {**out, "state": "actif"}


async def status(user: dict, kind: str, cfg: dict | None = None) -> dict:
    cfg = cfg or await settings()
    if not concerned(user, kind):
        return status_from(user, kind, cfg, None)
    return status_from(user, kind, cfg, await last_activity(user, kind))


async def all_status(user: dict) -> dict:
    cfg = await settings()
    return {k: await status(user, k, cfg) for k in KINDS}


async def suspended_kinds(user: dict) -> set[str]:
    st = await all_status(user)
    return {k for k, s in st.items() if s["state"] == "suspendu"}
