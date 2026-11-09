"""Shared ATC strips: one strip per active flight. Every controller can read them; a strip is editable only by an ATC
whose positions concern the flight (departure / arrival airport or sector, or responsible for it now) — checked here."""

from fastapi import APIRouter, Depends, HTTPException

from lib.auth import require
from lib.control import Ctx, ctx_for
from lib.db import db
from lib.engine import ACTIVE, aware, utcnow
from lib.events import log_event
from models.schemas import Strip, StripIn
from routers.common import PLAN_FIELDS, apply_runway_change, load_flight, plan_info, save

router = APIRouter(prefix="/strips", tags=["strips"])

from lib.atis_letter import atis_letter as _atis_letter


FIELDS = ("squawk", "initial_alt", "initial_alt_unit", "cruise_fl", "approach_alt", "approach_alt_unit", "remarks",
          "sid", "star", "dep_rwy", "arr_rwy")


def _strip(f: dict, ctx: Ctx | None = None, atis_letter: str | None = None) -> Strip:
    s = f.get("strip") or {}
    prefilled = []
    cruise = s.get("cruise_fl")
    if cruise is None and f.get("cruise_alt_ft"):
        cruise = round(f["cruise_alt_ft"] / 100)  # pre-filled from the plan de vol SimBrief
        prefilled.append("cruise_fl")
    # legacy strips stored feet only
    init, init_u = s.get("initial_alt", s.get("initial_alt_ft")), s.get("initial_alt_unit", "FT")
    app, app_u = s.get("approach_alt", s.get("approach_alt_ft")), s.get("approach_alt_unit", "FT")
    plan = plan_info(f, with_strip=False)  # SID / STAR / runways pre-filled from SimBrief, editable by the ATC
    proc = {}
    for k in PLAN_FIELDS:
        proc[k] = s.get(k) or plan[k]
        if not s.get(k) and plan[k] and k not in str((f.get("plan_meta") or {}).get("atc_changed") or "").split(","):
            prefilled.append(k)  # « SB »: value from SimBrief, not from a controller
    return Strip(
        **proc,
        flight_id=f["id"], callsign=f["callsign"], aircraft_type=f["aircraft_type"], pilot_name=f["pilot_name"],
        departure=f["departure"], arrival=f["arrival"], phase=f["phase"],
        dep_gate=(f.get("dep_gate") or {}).get("ref"), arr_gate=(f.get("arr_gate") or {}).get("ref"),
        atis_letter=atis_letter,
        squawk=s.get("squawk"), initial_alt=init, initial_alt_unit=init_u, cruise_fl=cruise,
        approach_alt=app, approach_alt_unit=app_u, prefilled=prefilled, remarks=s.get("remarks"),
        updated_by=s.get("updated_by"), updated_at=aware(s.get("updated_at")),
        can_edit=bool(ctx and ctx.can_edit_strip(f)),
        controller_callsign=(r := ctx.responsible(f) if ctx else None) and r["callsign"],
    )


@router.get("", response_model=list[Strip])
async def list_strips(user: dict = Depends(require("strip:read"))):
    docs = await db.flights.find({"phase": {"$in": ACTIVE}}, {"_id": 0}).sort("created_at", 1).to_list(500)
    ctx = await ctx_for(user, utcnow())
    out = []
    for f in docs:
        letter = await _atis_letter(f.get("departure"))
        out.append(_strip(f, ctx, atis_letter=letter))
    return out


@router.put("/{flight_id}", response_model=Strip)
async def update_strip(flight_id: str, body: StripIn, user: dict = Depends(require("strip:write"))):
    f = await load_flight(flight_id)
    if f["phase"] not in ACTIVE:
        raise HTTPException(409, "Le vol est clôturé : strip en lecture seule.")
    ctx = await ctx_for(user, utcnow())
    if not ctx.can_edit_strip(f):
        raise HTTPException(403, f"Strip en lecture seule : {f['callsign']} ({f['departure']} → {f['arrival']}) ne "
                                 "relève d'aucune de vos positions.")
    new = {k: getattr(body, k) for k in FIELDS}
    if new["remarks"] is not None:
        new["remarks"] = new["remarks"].strip() or None
    for k in PLAN_FIELDS:  # SID / STAR / runways: upper-case; a value equal to the plan is not an override
        v = (new[k] or "").strip().upper() or None
        new[k] = None if v == plan_info(f, with_strip=False)[k] else v
    if new["squawk"] and await db.flights.find_one(
            {"id": {"$ne": flight_id}, "phase": {"$in": ACTIVE}, "strip.squawk": new["squawk"]}, {"_id": 1}):
        raise HTTPException(409, f"Le code transpondeur {new['squawk']} est déjà attribué à un autre vol actif.")
    old = f.get("strip") or {}
    # a runway typed on the strip is a real runway change: the route is re-planned (same as the Route tab)
    rwy_notes = apply_runway_change(f, new.pop("dep_rwy"), new.pop("arr_rwy"), utcnow())
    new["dep_rwy"] = new["arr_rwy"] = None
    strip = {**new, "updated_by": user["display_name"], "updated_at": utcnow()}
    if rwy_notes:
        f["strip"] = strip
        await save(f, f["version"])
        await log_event("controle", "Piste modifiée par le contrôle (strip)", user, f, " · ".join(rwy_notes))
    else:
        # other strip edits do not bump the flight version, so they never conflict with pilot/phase actions
        await db.flights.update_one({"id": flight_id}, {"$set": {"strip": strip}})
    changes = [f"{k}: {old.get(k) or '—'} → {new[k] or '—'}" for k in FIELDS if old.get(k) != new[k]]
    if changes:
        await log_event("strip", "Strip ATC mis à jour", user, f, " · ".join(changes))
    f["strip"] = strip
    letter = await _atis_letter(f.get("departure"))
    return _strip(f, ctx, atis_letter=letter)
