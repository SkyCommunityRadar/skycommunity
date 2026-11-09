import uuid

from fastapi import APIRouter, Depends, HTTPException

from lib.auth import require
from lib.db import db
from lib.engine import utcnow
from lib.events import log_event
from lib.osm import gate_ref, get_graph
from lib.simbrief import SimbriefError, fetch_ofp, parse_ofp
from models.schemas import FlightDetail, SimbriefConfirmIn, SimbriefFetchIn, SimbriefPreview
from routers.common import detail_for, new_flight_doc, one_active_flight, unique_callsign

router = APIRouter(prefix="/simbrief", tags=["simbrief"])


@router.post("/fetch", response_model=SimbriefPreview)
async def fetch(body: SimbriefFetchIn, user: dict = Depends(require("flight:create"))):
    await one_active_flight(user)
    try:
        plan = parse_ofp(await fetch_ofp(body.pilot_id.strip()))
    except SimbriefError as e:
        raise HTTPException(e.status, e.message)
    except ValueError as e:
        raise HTTPException(422, str(e))
    draft_id = str(uuid.uuid4())
    # The plan is kept server-side: confirmation can't be tampered with by the browser.
    await db.simbrief_drafts.insert_one({"id": draft_id, "user_id": user["id"], "plan": plan, "created_at": utcnow()})
    # Enregistre durablement le Pilot ID SimBrief sur le profil
    pid = body.pilot_id.strip()
    if pid and user.get("simbrief_id") != pid:
        await db.users.update_one({"id": user["id"]}, {"$set": {"simbrief_id": pid}})
    return SimbriefPreview(draft_id=draft_id, **plan)


@router.post("/confirm/{draft_id}", response_model=FlightDetail)
async def confirm(draft_id: str, body: SimbriefConfirmIn, user: dict = Depends(require("flight:create"))):
    draft = await db.simbrief_drafts.find_one({"id": draft_id, "user_id": user["id"]}, {"_id": 0})
    if not draft:
        raise HTTPException(404, "Aperçu introuvable ou expiré. Relancez l'importation.")
    plan = draft["plan"]
    await one_active_flight(user)
    await unique_callsign(plan["callsign"])
    wps = plan["waypoints"]
    dep = gate_ref(await get_graph(wps[0]["ident"]), body.dep_gate)
    arr = gate_ref(await get_graph(wps[-1]["ident"]), body.arr_gate) if body.arr_gate else None
    f = new_flight_doc(user, callsign=plan["callsign"], aircraft_type=plan["aircraft_type"], route=wps,
                       route_string=plan["route_string"], cruise_alt_ft=plan["cruise_alt_ft"],
                       plan_meta=plan["plan_meta"], dep_gate=dep, arr_gate=arr)
    await db.flights.insert_one(dict(f))
    await db.simbrief_drafts.delete_one({"id": draft_id})
    await log_event("creation", "Création du vol", user, f,
                    f"Plan de vol SimBrief · porte de départ {dep['ref'] if dep else '—'}")
    await log_event("import", "Importation du plan de vol SimBrief", user, f,
                    f"{len(wps)} points, {plan['total_nm']:.0f} NM, OFP {plan['plan_meta'].get('ofp_id')}")
    return await detail_for(f, user)
