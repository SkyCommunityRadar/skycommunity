"""ATC planning: controllers announce their availabilities in advance (UTC).

- An ATC publishes its own availabilities (date, airport or centre, position, frequency, start, end).
- Changing a published availability = a change REQUEST, sent to the administrators and the Responsable ATC; it is
  applied only once accepted, and the validator is recorded (status: pending / accepted / refused).
- Deleting an availability is reserved to the administrators and the Responsable ATC.
Every rule is checked here, server-side.
"""

import uuid
from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query

from lib import airspace
from lib.auth import is_atc_lead, require
from lib.bot import notify
from lib.db import db
from lib.engine import aware, utcnow
from lib.events import log_event
from lib.handover import preset_frequency
from models.schemas import PlanningChangeIn, PlanningDecisionIn, PlanningIn, PlanningRequest, PlanningSlot
from routers.airports import ref_lookup

router = APIRouter(prefix="/planning", tags=["planning"])
MAX_DAYS_AHEAD = 28
FIELDS = ("date", "kind", "icao", "position", "frequency", "start", "end")


def _req_out(r: dict) -> PlanningRequest:
    return PlanningRequest(**{**r, "requested_at": aware(r["requested_at"]), "decided_at": aware(r.get("decided_at"))})


def _slot_out(s: dict, user: dict, pending: dict | None) -> PlanningSlot:
    lead = is_atc_lead(user)
    return PlanningSlot(**{k: s.get(k) for k in PlanningSlot.model_fields if k not in ("created_at", "updated_at", "pending_request", "can_request_change", "can_delete")},
                        created_at=aware(s["created_at"]), updated_at=aware(s["updated_at"]),
                        pending_request=_req_out(pending) if pending else None,
                        can_request_change=s["user_id"] == user["id"] and not pending,
                        can_delete=lead)


async def _validate(body: PlanningIn, owner_id: str, ignore_id: str | None = None) -> dict:
    """Checks and normalises an availability; returns the fields to store."""
    icao = body.icao.strip().upper()
    try:
        d = date.fromisoformat(body.date)
    except ValueError:
        raise HTTPException(422, "Date invalide.")
    today = utcnow().date()
    if d < today:
        raise HTTPException(422, "Impossible d'annoncer une disponibilité dans le passé.")
    if d > today + timedelta(days=MAX_DAYS_AHEAD):
        raise HTTPException(422, f"Le planning est ouvert sur {MAX_DAYS_AHEAD} jours maximum.")
    if body.end <= body.start:
        raise HTTPException(422, "L'heure de fin doit être après l'heure de début (heures UTC, même journée).")
    if body.kind == "center":
        if body.position != "CTR":
            raise HTTPException(422, "Un centre s'annonce en position CTR.")
        c = airspace.match("fir", icao)
        if not c:
            raise HTTPException(422, f"Aucun centre connu pour {icao} (ex. LFFF, LFMM, EGTT).")
        name = c["properties"]["name"]
    else:
        if body.position == "CTR":
            raise HTTPException(422, "Sur un aéroport, choisissez APP, TWR ou GND.")
        ref = ref_lookup(icao) if len(icao) == 4 else None
        if not ref:
            raise HTTPException(422, f"Aéroport {icao} inconnu : utilisez son code OACI sur 4 lettres.")
        name = ref[0]
    callsign = f"{icao}_{body.position}"
    freq = body.frequency or (await preset_frequency(icao, body.position))[0]
    if not freq:
        raise HTTPException(422, f"Aucune fréquence enregistrée pour {callsign} : saisissez-la.")
    # the same position cannot be announced twice at the same time
    clash = await db.planning.find_one({"callsign": callsign, "date": body.date, "id": {"$ne": ignore_id},
                                        "start": {"$lt": body.end}, "end": {"$gt": body.start}}, {"_id": 0})
    if clash:
        raise HTTPException(409, f"{callsign} est déjà annoncé par {clash['controller']} le {body.date} de "
                                 f"{clash['start']} à {clash['end']} UTC.")
    mine = await db.planning.find_one({"user_id": owner_id, "date": body.date, "id": {"$ne": ignore_id},
                                       "start": {"$lt": body.end}, "end": {"$gt": body.start},
                                       "icao": {"$ne": icao}}, {"_id": 0})
    if mine:
        raise HTTPException(409, f"Vous avez déjà annoncé {mine['callsign']} sur ce créneau : on ne cumule des "
                                 "positions que sur un même aéroport.")
    return {"date": body.date, "kind": body.kind, "icao": icao, "position": body.position, "callsign": callsign,
            "frequency": freq, "start": body.start, "end": body.end, "name": name}


async def _pending_by_slot(ids: list[str]) -> dict[str, dict]:
    docs = await db.planning_requests.find({"slot_id": {"$in": ids}, "status": "pending"}, {"_id": 0}).to_list(500)
    return {d["slot_id"]: d for d in docs}


@router.get("", response_model=list[PlanningSlot])
async def list_slots(start: str = Query(pattern=r"^\d{4}-\d{2}-\d{2}$"), days: int = Query(7, ge=1, le=35),
                     user: dict = Depends(require("planning:read"))):
    try:
        d0 = date.fromisoformat(start)
    except ValueError:
        raise HTTPException(422, "Date invalide.")
    end = (d0 + timedelta(days=days - 1)).isoformat()
    docs = await db.planning.find({"date": {"$gte": start, "$lte": end}}, {"_id": 0}).sort([("date", 1), ("start", 1)]).to_list(1000)
    pending = await _pending_by_slot([d["id"] for d in docs])
    return [_slot_out(d, user, pending.get(d["id"])) for d in docs]


@router.post("", response_model=PlanningSlot)
async def create_slot(body: PlanningIn, user: dict = Depends(require("planning:write"))):
    fields = await _validate(body, user["id"])
    now = utcnow()
    doc = {"id": str(uuid.uuid4()), "user_id": user["id"], "controller": user["display_name"], **fields,
           "created_at": now, "updated_at": now, "last_change_by": None}
    await db.planning.insert_one(dict(doc))
    await log_event("planning", "Disponibilité ATC publiée", user, None,
                    f"{doc['callsign']} {doc['date']} {doc['start']}–{doc['end']} UTC")
    return _slot_out(doc, user, None)


@router.post("/{slot_id}/requests", response_model=PlanningRequest)
async def request_change(slot_id: str, body: PlanningChangeIn, user: dict = Depends(require("planning:write"))):
    """The owner asks for a change; it is applied only after validation by an administrator / Responsable ATC."""
    slot = await db.planning.find_one({"id": slot_id}, {"_id": 0})
    if not slot:
        raise HTTPException(404, "Disponibilité introuvable.")
    if slot["user_id"] != user["id"]:
        raise HTTPException(403, "Vous ne pouvez demander la modification que de vos propres disponibilités.")
    if await db.planning_requests.find_one({"slot_id": slot_id, "status": "pending"}, {"_id": 1}):
        raise HTTPException(409, "Une demande de modification est déjà en attente pour cette disponibilité.")
    changes = await _validate(body, user["id"], ignore_id=slot_id)
    if all(changes[k] == slot.get(k) for k in FIELDS):
        raise HTTPException(422, "Aucune modification par rapport à la disponibilité publiée.")
    req = {"id": str(uuid.uuid4()), "slot_id": slot_id, "callsign": slot["callsign"], "requested_by": user["display_name"],
           "requested_by_id": user["id"], "requested_at": utcnow(), "reason": (body.reason or "").strip() or None,
           "before": {k: slot.get(k) for k in (*FIELDS, "callsign")}, "changes": changes, "status": "pending",
           "decided_by": None, "decided_at": None, "comment": None}
    await db.planning_requests.insert_one(dict(req))
    await log_event("planning", "Demande de modification de disponibilité", user, None,
                    f"{slot['callsign']} {slot['date']} → {changes['callsign']} {changes['date']} {changes['start']}–{changes['end']}")
    chg = changes
    await notify(
        "planning_demande_modification",
        "validation_atc",
        f"📋 **Demande de modification planning** par {user['display_name']}\n"
        f"Avant : {slot['callsign']} {slot['date']} {slot['start']}–{slot['end']} UTC\n"
        f"Après : {chg['callsign']} {chg['date']} {chg['start']}–{chg['end']} UTC\n"
        f"Motif : {(body.reason or '—').strip() or '—'}",
        {"id": req["id"], "slot_id": slot_id, "callsign": slot["callsign"], "requested_by": user["display_name"]},
        path="/planning",
    )
    return _req_out(req)


@router.get("/requests", response_model=list[PlanningRequest])
async def list_requests(status: str = Query("pending", pattern="^(pending|decided|all)$"),
                        user: dict = Depends(require("planning:read"))):
    """Administrators and the Responsable ATC see every request; a controller sees his own."""
    q: dict = {}
    if status == "pending":
        q["status"] = "pending"
    elif status == "decided":
        q["status"] = {"$in": ["accepted", "refused"]}
    if not is_atc_lead(user):
        q["requested_by_id"] = user["id"]
    docs = await db.planning_requests.find(q, {"_id": 0}).sort("requested_at", -1).to_list(200)
    return [_req_out(d) for d in docs]


@router.patch("/requests/{request_id}", response_model=PlanningRequest)
async def decide_request(request_id: str, body: PlanningDecisionIn, user: dict = Depends(require("planning:read"))):
    if not is_atc_lead(user):
        raise HTTPException(403, "Seuls les administrateurs et le Responsable ATC valident les modifications du planning.")
    req = await db.planning_requests.find_one({"id": request_id}, {"_id": 0})
    if not req:
        raise HTTPException(404, "Demande introuvable.")
    if req["status"] != "pending":
        raise HTTPException(409, "Cette demande a déjà été traitée.")
    slot = await db.planning.find_one({"id": req["slot_id"]}, {"_id": 0})
    if not slot:
        raise HTTPException(409, "La disponibilité concernée n'existe plus.")
    now = utcnow()
    if body.decision == "accept":
        # re-checked at validation time: the planning may have changed since the request
        changes = await _validate(PlanningIn(**{k: req["changes"][k] for k in FIELDS}), slot["user_id"], ignore_id=slot["id"])
        await db.planning.update_one({"id": slot["id"]}, {"$set": {**changes, "updated_at": now,
                                                                   "last_change_by": user["display_name"]}})
    upd = {"status": "accepted" if body.decision == "accept" else "refused", "decided_by": user["display_name"],
           "decided_at": now, "comment": (body.comment or "").strip() or None}
    res = await db.planning_requests.update_one({"id": request_id, "status": "pending"}, {"$set": upd})
    if not res.modified_count:
        raise HTTPException(409, "Cette demande a déjà été traitée.")
    await log_event("planning", "Modification de disponibilité " + ("acceptée" if body.decision == "accept" else "refusée"),
                    user, None, f"{req['callsign']} — demande de {req['requested_by']}")
    return _req_out({**req, **upd})


@router.delete("/{slot_id}")
async def delete_slot(slot_id: str, user: dict = Depends(require("planning:read"))):
    if not is_atc_lead(user):
        raise HTTPException(403, "La suppression d'une disponibilité est réservée aux administrateurs et au Responsable ATC.")
    slot = await db.planning.find_one_and_delete({"id": slot_id}, {"_id": 0})
    if not slot:
        raise HTTPException(404, "Disponibilité introuvable.")
    await db.planning_requests.update_many({"slot_id": slot_id, "status": "pending"},
                                           {"$set": {"status": "refused", "decided_by": user["display_name"],
                                                     "decided_at": utcnow(), "comment": "Disponibilité supprimée"}})
    await log_event("planning", "Disponibilité ATC supprimée", user, None,
                    f"{slot['callsign']} {slot['date']} {slot['start']}–{slot['end']} ({slot['controller']})")
    return {"ok": True}
