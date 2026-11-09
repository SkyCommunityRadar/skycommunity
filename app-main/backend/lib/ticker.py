"""Background engine tick: logs estimated waypoint passages and performs automatic transitions.

Positions themselves are computed from timestamps on every read, so the state stays coherent
even if this loop is late or the server restarts — the tick only adds history + auto phase.
"""

import asyncio
import logging
import os

from lib import handover
from lib.control import record_controllers
from lib.db import db
from lib.engine import end_holding, hold_entered_at, hold_lap_s, leave_holding_at, LINEUP_HOLD_S, PHASES, TRACK_OF, approach_target, compute_position, enter_phase, lined_up_since, utcnow
from lib.events import log_event

logger = logging.getLogger(__name__)


async def _auto(f: dict, to: str, label: str, now, extra: str = "") -> None:
    """Automatic phase change, written only if nobody changed the flight meanwhile (version check)."""
    v, before = f["version"], f["phase"]
    enter_phase(f, to, now)
    f["version"], f["updated_at"] = v + 1, now
    res = await db.flights.replace_one({"id": f["id"], "version": v}, f)
    if res.matched_count:
        note = f" — {f['approach_note']}" if to == "approche" and f.get("approach_note") else extra
        await log_event("phase", label, None, f, f"{PHASES[before]} → {PHASES[f['phase']]}{note}")


async def _holding_tick(f: dict, now) -> None:
    """Holding pattern: entry recorded, planned turns flown (it goes on holding until told), exit at the fix."""
    h = f["holding"]
    v = f["version"]
    entered = hold_entered_at(f, now)
    label = None
    if entered and not h.get("entered_at"):
        h["entered_at"] = entered
        label = (f"Entrée en hold sur {h['ident']}", f"{h['turns']} tour(s) prévu(s)" if h.get("turns") else "jusqu'à nouvel ordre")
    elif entered and h.get("turns") and not h.get("turns_done_logged") and \
            (now - entered).total_seconds() >= h["turns"] * hold_lap_s(h) and not h.get("exit"):
        h["turns_done_logged"] = True
        label = (f"Tours de hold prévus effectués sur {h['ident']}",
                 "pas d'instruction de sortie : l'avion continue le hold")
    at = leave_holding_at(f, now)
    if at and at <= now:
        end_holding(f, at)
        label = (f"Sortie du hold sur {h['ident']}", "reprise de la route")
    if not label:
        return
    f["version"], f["updated_at"] = v + 1, now
    res = await db.flights.replace_one({"id": f["id"], "version": v}, f)
    if res.matched_count:
        await log_event("hold", label[0], None, f, label[1])


def _arrived(pos: dict) -> bool:
    return pos["total_nm"] > 0 and not pos["paused"] and pos["distance_nm"] >= pos["total_nm"] - 0.001


async def tick_once() -> None:
    now = utcnow()
    moving = [p for p in TRACK_OF]
    async for f in db.flights.find({"phase": {"$in": moving}}, {"_id": 0}):
        if f.get("holding"):
            await _holding_tick(f, now)
        pos = compute_position(f, now)
        if pos["track"] == "air":
            last = int(f.get("last_wp_index", 0))
            idx = pos["wp_index"]
            if idx > last:
                res = await db.flights.update_one({"id": f["id"], "last_wp_index": last}, {"$set": {"last_wp_index": idx}})
                if res.modified_count:
                    f["last_wp_index"] = idx
                    for i in range(last + 1, idx + 1):
                        await log_event("passage", f"Passage estimé du point {f['route'][i]['ident']}", None, f)
            if f["phase"] == "decollage" and pos["distance_nm"] >= min(5.0, pos["total_nm"] * 0.05):
                await _auto(f, "en_route", "Montée initiale terminée (automatique)", now)
            elif f["phase"] == "en_route" and not pos["paused"]:
                # first fix of the arrival STAR reached (or the top of descent when the plan has no STAR)
                target, _ = approach_target(f)
                if 0 < target <= pos["distance_nm"]:
                    await _auto(f, "approche", "Entrée en approche (automatique)", now)
        elif f["phase"] == "alignement" and f.get("takeoff_cleared"):
            since = lined_up_since(f, now)
            if since is not None and since >= LINEUP_HOLD_S:
                await _auto(f, "decollage", "Aligné, début du roulement au décollage (automatique)", now)
        elif f["phase"] == "roulage" and pos["track"] == "taxi_out" and _arrived(pos):
            await _auto(f, "point_attente", "Arrivé au point d'attente (automatique)", now)
        elif f["phase"] == "roulage_arrivee" and pos["track"] == "taxi_in" and _arrived(pos):
            await _auto(f, "parking", "Arrivé au parking (automatique)", now)
        elif f["phase"] == "retour_parking" and pos["track"] == "taxi_back" and _arrived(pos):
            await _auto(f, "preparation", "Retour au poste de stationnement (automatique)", now)


SWEEP_S = float(os.environ.get("ACTIVITY_SWEEP_SECONDS", "600"))


async def slow_sweep() -> None:
    """Every 10 min: inactivity warnings / suspensions announced once, past pre-openings expired."""
    from routers.activity import sweep
    from routers.atc import expire_preopenings
    await expire_preopenings()
    await sweep()


async def run_forever() -> None:
    interval = float(os.environ.get("ENGINE_TICK_SECONDS", "3"))
    last_sweep = 0.0
    loop = asyncio.get_running_loop()
    while True:
        if loop.time() - last_sweep >= SWEEP_S:
            last_sweep = loop.time()
            try:
                await slow_sweep()
            except Exception as exc:
                logger.exception("activity sweep failed: %s", exc)
        try:
            await tick_once()
        except Exception as exc:  # never let the loop die
            logger.exception("engine tick failed: %s", exc)
        try:
            await handover.process()  # lost connections freed + automatic handover after 2 min
            await record_controllers(utcnow())  # « vols contrôlés » of each controller
        except Exception as exc:
            logger.exception("ATC handover tick failed: %s", exc)
        await asyncio.sleep(interval)
