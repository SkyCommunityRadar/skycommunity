"""Activity follow-up of the members (Suivi des membres) and the inactivity rule — see lib/activity.

Responsable Pilotes -> pilots · Responsable ATC -> controllers · administrators -> both."""

from datetime import timedelta
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field

from lib import activity
from lib.activity import KIND_FR, KINDS, LEAD_FR, can_manage, settings, status_from
from lib.auth import current_user
from lib.bot import handled, notify
from lib.db import db
from lib.discord_roles import access_of
from lib.engine import aware, utcnow
from lib.events import log_event
from lib.security import guard_write
from models.schemas import FlightEvent, InactivityStatus
from routers.common import avatar_url

router = APIRouter(prefix="/activity", tags=["activity"])
Kind = Literal["pilote", "atc"]


class SettingsIn(BaseModel):
    enabled: bool
    days: int = Field(ge=7, le=30)
    warn_days: int = Field(ge=0, le=30)


class MemberActionIn(BaseModel):
    action: Literal["reactivate", "exempt", "end_exempt", "suspend", "refuse_request"]
    days: int | None = Field(default=None, ge=1, le=365)  # exemption length
    reason: str | None = Field(default=None, max_length=200)


class RequestIn(BaseModel):
    message: str | None = Field(default=None, max_length=300)


class MemberRow(BaseModel):
    id: str
    display_name: str
    avatar_url: str | None = None
    badges: list[str] = []
    status: InactivityStatus
    flights_total: int = 0
    flights_30d: int = 0
    atc_hours: float = 0
    request_message: str | None = None
    exempt_reason: str | None = None


def _who(user: dict, kind: str) -> None:
    if not can_manage(user, kind):
        raise HTTPException(403, f"Réservé aux administrateurs et au {LEAD_FR[kind]}.")


def _actor(user: dict, kind: str) -> dict:
    """The journal names the capacity in which the decision was taken (administrateur / responsable)."""
    a = access_of(user)
    role = "admin" if a["admin"] else ("responsable_pilotes" if kind == "pilote" else "responsable_atc")
    return {**user, "role": role}


def _date(d) -> str:
    return aware(d).strftime("%d/%m/%Y") if d else "?"


@router.get("/settings")
async def get_settings(user: dict = Depends(current_user)):
    if not any(can_manage(user, k) for k in KINDS):
        raise HTTPException(403, "Réservé aux administrateurs et aux responsables.")
    cfg = await settings(fresh=True)
    return {**cfg, "can_manage": {k: can_manage(user, k) for k in KINDS}}


@router.put("/settings/{kind}")
async def put_settings(kind: Kind, body: SettingsIn, request: Request, user: dict = Depends(current_user)):
    _who(user, kind)
    await guard_write(request, user)
    if body.warn_days >= body.days:
        raise HTTPException(422, "L'alerte doit arriver avant la suspension (moins de jours que le délai d'inactivité).")
    cfg = await activity.save_settings(kind, body.model_dump(), user)
    await log_event("activite", f"Règle d'inactivité {KIND_FR[kind]} modifiée", _actor(user, kind), None,
                    f"{'active' if body.enabled else 'désactivée'} · {body.days} j · alerte {body.warn_days} j avant", scope=kind)
    return {**cfg, "can_manage": {k: can_manage(user, k) for k in KINDS}}


async def _rows(kind: str) -> list[MemberRow]:
    cfg = await settings()
    now = utcnow()
    since30 = now - timedelta(days=30)
    users = await db.users.find({f"access.{kind}": True}, {"_id": 0, "password_hash": 0}).to_list(2000)
    stats: dict[str, dict] = {}
    if kind == "pilote":
        async for f in db.flights.find({"block_off_at": {"$ne": None}}, {"_id": 0, "pilot_id": 1, "updated_at": 1}):
            s = stats.setdefault(f["pilot_id"], {"last": None, "total": 0, "d30": 0})
            at = aware(f["updated_at"])
            s["total"] += 1
            s["d30"] += at >= since30
            s["last"] = max(s["last"], at) if s["last"] else at
    else:
        online = {d["user_id"] async for d in db.atc_positions.find({}, {"_id": 0, "user_id": 1})}
    out = []
    for u in users:
        if kind == "pilote":
            s = stats.get(u["id"], {})
            last = s.get("last")
        else:
            last = now if u["id"] in online else aware(u.get("atc_last_active"))
        st = status_from(u, kind, cfg, last, now)
        a = access_of(u)
        badges = [b for b, on in (("Créateur", a["creator"]), ("Administrateur", a["admin"] and not a["creator"]),
                                  (LEAD_FR[kind], a[activity.LEAD_FLAG[kind]])) if on]
        req = (u.get("reactivation_request") or {}).get(kind) or {}
        ex = (u.get("activity_exempt") or {}).get(kind) or {}
        out.append(MemberRow(id=u["id"], display_name=u["display_name"], avatar_url=avatar_url(u), badges=badges,
                             status=InactivityStatus(**st), flights_total=stats.get(u["id"], {}).get("total", 0),
                             flights_30d=stats.get(u["id"], {}).get("d30", 0),
                             atc_hours=round(u.get("atc_seconds", 0) / 3600, 1),
                             request_message=req.get("message"), exempt_reason=ex.get("reason")))
    order = {"suspendu": 0, "bientot": 1, "dispense": 2, "actif": 3, "non_concerne": 4}
    out.sort(key=lambda r: (r.status.request_at is None, order[r.status.state],
                            -(r.status.days_inactive if r.status.days_inactive is not None else 10_000),
                            r.display_name.lower()))
    return out


@router.get("/members", response_model=list[MemberRow])
async def members(kind: Kind = Query(...), user: dict = Depends(current_user)):
    _who(user, kind)
    return await _rows(kind)


@router.get("/summary")
async def summary(user: dict = Depends(current_user)):
    """Counters for the menu badge: pending reactivation requests + suspended + warned, per managed side."""
    out = {}
    for k in KINDS:
        if can_manage(user, k):
            rows = await _rows(k)
            out[k] = {"requests": sum(r.status.request_at is not None for r in rows)
                      + (await db.preopenings.count_documents({"status": "prevue", "cancel_request": {"$exists": True}})
                         if k == "atc" else 0)
                      + await db.absences.count_documents({"kinds": k, "status": "en_attente"}),
                      "suspendu": sum(r.status.state == "suspendu" for r in rows),
                      "bientot": sum(r.status.state == "bientot" for r in rows)}
    return out


@router.post("/members/{user_id}/{kind}", response_model=MemberRow)
async def act_on_member(user_id: str, kind: Kind, body: MemberActionIn, request: Request,
                        user: dict = Depends(current_user)):
    _who(user, kind)
    await guard_write(request, user)
    target = await db.users.find_one({"id": user_id}, {"_id": 0, "password_hash": 0})
    if not target or not access_of(target)[kind]:
        raise HTTPException(404, f"Membre {KIND_FR[kind]} introuvable.")
    if not activity.concerned(target, kind):
        raise HTTPException(400, "Ce membre n'est pas concerné par la règle d'inactivité (administrateur ou responsable).")
    now = utcnow()
    who = user["display_name"]
    reason = (body.reason or "").strip() or None
    q: dict = {}
    if body.action == "reactivate":
        q = {"$set": {f"reactivated.{kind}": {"at": now, "by": who}},
             "$unset": {f"activity_block.{kind}": "", f"reactivation_request.{kind}": "", f"activity_notified.{kind}": ""}}
        label, dm = "Accès réactivé", f"✅ Ton accès {KIND_FR[kind]} sur SkyCommunity Radar a été réactivé par {who}. Bon retour !"
    elif body.action == "exempt":
        if not body.days:
            raise HTTPException(422, "Indiquez la durée de la dispense (en jours).")
        if not reason or len(reason) < 3:
            raise HTTPException(422, "Indiquez le motif de la dispense (obligatoire).")
        until = now + timedelta(days=body.days)
        q = {"$set": {f"activity_exempt.{kind}": {"from": now, "until": until, "by": who, "reason": reason}},
             "$unset": {f"activity_block.{kind}": "", f"reactivation_request.{kind}": ""}}
        label = f"Dispense d'activité jusqu'au {_date(until)}"
        dm = f"🏖️ Tu es dispensé(e) d'activité {KIND_FR[kind]} jusqu'au {_date(until)} (par {who})."
    elif body.action == "end_exempt":  # ends now: the inactivity clock restarts from today
        q = {"$set": {f"activity_exempt.{kind}.until": now}}
        label, dm = "Dispense d'activité levée", None
    elif body.action == "suspend":
        q = {"$set": {f"activity_block.{kind}": {"at": now, "by": who, "reason": reason}},
             "$unset": {f"activity_exempt.{kind}": ""}}
        label = "Accès suspendu par un responsable"
        dm = (f"⛔ Ton accès {KIND_FR[kind]} sur SkyCommunity Radar a été suspendu par {who}"
              + (f" : {reason}" if reason else ".") + " Tu peux demander sa réactivation sur le site.")
    else:  # refuse_request
        if not (target.get("reactivation_request") or {}).get(kind):
            raise HTTPException(409, "Aucune demande de réactivation en attente.")
        q = {"$unset": {f"reactivation_request.{kind}": ""}}
        label = "Demande de réactivation refusée"
        dm = f"Ta demande de réactivation {KIND_FR[kind]} a été refusée par {who}" + (f" : {reason}" if reason else ".")
    await db.users.update_one({"id": user_id}, q)
    pending = (target.get("reactivation_request") or {}).get(kind) or {}
    if pending.get("alert_id") and body.action in ("reactivate", "refuse_request", "exempt"):
        verdict = {"reactivate": "accès réactivé", "refuse_request": "demande refusée", "exempt": "membre dispensé"}[body.action]
        await handled(pending["alert_id"], "responsables_pilotes" if kind == "pilote" else "responsables_atc",
                      f"✅ Traitée par {who} : {target['display_name']} — {verdict}.")
    await log_event("activite", f"{label} ({KIND_FR[kind]})", _actor(user, kind), None,
                    target["display_name"] + (f" — {reason}" if reason else ""), scope=kind)
    if dm:
        await notify(f"activite_{body.action}", "membre", dm, {"kind": kind, "user_id": user_id}, target.get("discord_id"))
    return next(r for r in await _rows(kind) if r.id == user_id)


@router.get("/journal", response_model=list[FlightEvent])
async def journal(kind: Kind = Query(...), limit: int = Query(200, ge=1, le=1000), user: dict = Depends(current_user)):
    """Who decided what and when, for this side (requests, reactivations, exemptions, suspensions, rule, pré-ouvertures)."""
    _who(user, kind)
    docs = await db.events.find({"scope": kind}, {"_id": 0}).sort("at", -1).to_list(limit)
    return [FlightEvent(**{**d, "at": aware(d["at"])}) for d in docs]


@router.post("/me/{kind}/request")
async def request_reactivation(kind: Kind, body: RequestIn, request: Request, user: dict = Depends(current_user)):
    """A member whose access is suspended for inactivity asks the responsables to reactivate it."""
    await guard_write(request, user)
    st = (user.get("inactivity") or {}).get(kind) or {}
    if st.get("state") != "suspendu":
        raise HTTPException(409, f"Votre accès {KIND_FR[kind]} n'est pas suspendu.")
    if st.get("request_at"):
        raise HTTPException(409, "Votre demande est déjà envoyée : un responsable va la traiter.")
    msg = (body.message or "").strip() or None
    days = st.get("days_inactive")
    mid = await notify("activite_demande", "responsables_pilotes" if kind == "pilote" else "responsables_atc",
                       f"🔔 {user['display_name']} demande la réactivation de son accès {KIND_FR[kind]}"
                       + (f" (inactif depuis {days} jours)" if days is not None else "") + (f" : « {msg} »" if msg else ".")
                       + " À traiter sur SkyCommunity Radar → Suivi des membres.",
                       {"kind": kind, "user_id": user["id"]}, path=f"/suivi?tab={kind}")
    await db.users.update_one({"id": user["id"]}, {"$set": {f"reactivation_request.{kind}": {"at": utcnow(), "message": msg,
                                                                                            "alert_id": mid}}})
    await log_event("activite", f"Demande de réactivation ({KIND_FR[kind]})", user, None, msg, scope=kind)
    return {"ok": True}


# ---------- periodic sweep (engine loop): warnings and suspensions are announced once ----------

async def sweep() -> None:
    cfg = await settings(fresh=True)
    for kind in KINDS:
        for row in await _rows(kind):
            st = row.status
            if st.state == "non_concerne":
                continue
            u = await db.users.find_one({"id": row.id}, {"_id": 0, "discord_id": 1, "activity_notified": 1, "display_name": 1})
            if not u:
                continue
            before = (u.get("activity_notified") or {}).get(kind)
            now_state = st.state if st.state in ("bientot", "suspendu") else None
            if now_state == before:
                continue
            await db.users.update_one({"id": row.id}, {"$set": {f"activity_notified.{kind}": now_state}})
            if now_state == "bientot":
                await log_event("activite", f"Alerte d'inactivité envoyée ({KIND_FR[kind]})", None, None,
                                f"{row.display_name} — suspension prévue le {_date(st.deadline)}", scope=kind)
                await notify("activite_alerte", "membre",
                             f"⚠️ Tu n'as pas eu d'activité {KIND_FR[kind]} sur SkyCommunity Radar depuis un moment. "
                             f"Sans {'vol' if kind == 'pilote' else 'ouverture de position'} d'ici le {_date(st.deadline)}, "
                             f"ton accès {KIND_FR[kind]} sera suspendu.", {"kind": kind, "user_id": row.id}, u.get("discord_id"))
            elif now_state == "suspendu" and not st.manual:
                await log_event("activite", f"Accès suspendu pour inactivité ({KIND_FR[kind]})", None, None,
                                f"{row.display_name} — {cfg[kind]['days']} jours sans activité", scope=kind)
                await notify("activite_suspension", "membre",
                             f"⛔ Ton accès {KIND_FR[kind]} sur SkyCommunity Radar est suspendu : aucune activité depuis "
                             f"plus de {cfg[kind]['days']} jours. Tu peux demander sa réactivation sur le site.",
                             {"kind": kind, "user_id": row.id}, u.get("discord_id"))
                await notify("activite_suspension", "responsables_pilotes" if kind == "pilote" else "responsables_atc",
                             f"📉 {row.display_name} : accès {KIND_FR[kind]} suspendu pour inactivité "
                             f"({cfg[kind]['days']} jours sans activité).", {"kind": kind, "user_id": row.id},
                             path=f"/suivi?tab={kind}")
