"""Absences of the pilots and controllers (the staff keeps the absence system of the Discord bot).

- The member declares an absence (dates + mandatory reason). Up to 7 days it is accepted at once; beyond, it is a
  request that the Responsable Pilotes / Responsable ATC (or an administrator) accepts or refuses.
- An accepted absence pauses the inactivity rule (lib/activity: activity_exempt) for the member's accesses; the clock
  restarts when it ends.
- Frequent absences (several in a short time) raise an alert to the responsables.
Every step is recorded in the logs and announced through the bot.
"""

import uuid
from datetime import date, datetime, time, timedelta, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field

from lib import activity
from lib.activity import KIND_FR, KINDS, LEAD_FR, can_manage, concerned
from lib.auth import current_user
from lib.bot import handled, notify
from lib.db import db
from lib.engine import aware, utcnow
from lib.events import log_event
from lib.security import guard_write
from routers.common import avatar_url

router = APIRouter(prefix="/absences", tags=["absences"])

AUTO_DAYS = 7  # up to 7 days: accepted without validation
MAX_DAYS = 90
MAX_AHEAD_DAYS = 180
FREQUENT_WINDOW = timedelta(days=90)
FREQUENT_COUNT = 3  # 3 absences or more within 90 days…
FREQUENT_TOTAL_DAYS = 30  # …or 30 days of absence or more within 90 days -> alert
LIVE = ("en_attente", "acceptee")


class AbsenceIn(BaseModel):
    start: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    end: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    reason: str = Field(min_length=3, max_length=300)


class DecisionIn(BaseModel):
    decision: Literal["accept", "refuse", "shorten"]
    comment: str | None = Field(default=None, max_length=300)
    end: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")  # new last day (shorten)


class Absence(BaseModel):
    id: str
    user_id: str
    display_name: str
    avatar_url: str | None = None
    kinds: list[str]
    start: str
    end: str
    days: int
    reason: str
    status: Literal["en_attente", "acceptee", "refusee", "annulee", "ecourtee"]
    auto: bool
    frequent: bool = False
    created_at: datetime
    decided_by: str | None = None
    decided_at: datetime | None = None
    comment: str | None = None
    ongoing: bool = False
    can_decide: bool = False
    can_end: bool = False


def _d(s: str) -> date:
    try:
        return date.fromisoformat(s)
    except ValueError:
        raise HTTPException(422, "Date invalide.")


def _fr(s: str) -> str:
    return date.fromisoformat(s).strftime("%d/%m/%Y")


def _bounds(a: dict) -> tuple[datetime, datetime]:
    """[first day 00:00 UTC, day after the last day 00:00 UTC)."""
    return (datetime.combine(_d(a["start"]), time(), timezone.utc),
            datetime.combine(_d(a["end"]) + timedelta(days=1), time(), timezone.utc))


def _out(a: dict, user: dict) -> Absence:
    now = utcnow()
    s, e = _bounds(a)
    lead = any(can_manage(user, k) for k in a["kinds"])
    return Absence(**{k: a.get(k) for k in Absence.model_fields
                      if k not in ("created_at", "decided_at", "ongoing", "can_decide", "can_end", "avatar_url")},
                   avatar_url=avatar_url(a), created_at=aware(a["created_at"]), decided_at=aware(a.get("decided_at")),
                   ongoing=a["status"] == "acceptee" and s <= now < e,
                   can_decide=lead and a["status"] in LIVE and a["user_id"] != user["id"],
                   can_end=a["user_id"] == user["id"] and a["status"] in LIVE and now < e)


def _lead_target(kinds: list[str]):
    """Bot channel(s) of the responsables concerned by these accesses."""
    return [("responsables_pilotes" if k == "pilote" else "responsables_atc") for k in kinds]


def _actor(user: dict, kinds: list[str]) -> dict:
    a = activity.access_of(user)
    k = next((k for k in kinds if a[activity.LEAD_FLAG[k]]), None)
    return {**user, "role": "admin" if a["admin"] else ("responsable_pilotes" if k == "pilote" else "responsable_atc")}


async def _apply(a: dict) -> None:
    """Accepted absence -> the inactivity rule is paused on the member's accesses for these dates."""
    s, e = _bounds(a)
    await db.users.update_one({"id": a["user_id"]}, {"$set": {
        f"activity_exempt.{k}": {"from": s, "until": e, "by": "absence", "reason": a["reason"], "absence_id": a["id"]}
        for k in a["kinds"]}})


async def _unapply(a: dict, until: datetime) -> None:
    """Absence shortened / ended early: the pause stops at `until` (only if it is still this absence's)."""
    for k in a["kinds"]:
        await db.users.update_one({"id": a["user_id"], f"activity_exempt.{k}.absence_id": a["id"]},
                                  {"$set": {f"activity_exempt.{k}.until": until}})


async def _frequent(user_id: str, now: datetime) -> tuple[bool, int, int]:
    """(frequent?, number of absences, total days) over the last 90 days (requests still pending included)."""
    docs = await db.absences.find({"user_id": user_id, "status": {"$in": ["en_attente", "acceptee", "ecourtee"]},
                                   "created_at": {"$gte": now - FREQUENT_WINDOW}}, {"_id": 0, "days": 1}).to_list(100)
    total = sum(d["days"] for d in docs)
    return len(docs) >= FREQUENT_COUNT or total >= FREQUENT_TOTAL_DAYS, len(docs), total


@router.get("/me", response_model=list[Absence])
async def my_absences(user: dict = Depends(current_user)):
    docs = await db.absences.find({"user_id": user["id"]}, {"_id": 0}).sort("start", -1).to_list(50)
    return [_out(d, user) for d in docs]


@router.post("/me", response_model=Absence)
async def declare(body: AbsenceIn, request: Request, user: dict = Depends(current_user)):
    await guard_write(request, user)
    kinds = [k for k in KINDS if concerned(user, k)]
    if not kinds:
        raise HTTPException(400, "Les administrateurs et les responsables ne sont pas concernés par la règle d'inactivité : "
                                 "pas besoin de déclarer d'absence ici.")
    start, end = _d(body.start), _d(body.end)
    today = utcnow().date()
    if start < today:
        raise HTTPException(422, "Une absence se déclare à partir d'aujourd'hui (pas dans le passé).")
    if end < start:
        raise HTTPException(422, "La date de fin doit être après la date de début.")
    if start > today + timedelta(days=MAX_AHEAD_DAYS):
        raise HTTPException(422, "Une absence se déclare 6 mois à l'avance au maximum.")
    days = (end - start).days + 1
    if days > MAX_DAYS:
        raise HTTPException(422, f"Une absence dure {MAX_DAYS} jours au maximum.")
    reason = body.reason.strip()
    if len(reason) < 3:
        raise HTTPException(422, "Indiquez le motif de l'absence (obligatoire).")
    clash = await db.absences.find_one({"user_id": user["id"], "status": {"$in": list(LIVE)},
                                        "start": {"$lte": body.end}, "end": {"$gte": body.start}}, {"_id": 0})
    if clash:
        raise HTTPException(409, f"Vous avez déjà une absence du {_fr(clash['start'])} au {_fr(clash['end'])} sur ces dates.")
    now = utcnow()
    auto = days <= AUTO_DAYS
    a = {"id": str(uuid.uuid4()), "user_id": user["id"], "display_name": user["display_name"],
         "discord_id": user.get("discord_id"), "avatar": user.get("avatar"), "kinds": kinds,
         "start": body.start, "end": body.end, "days": days, "reason": reason,
         "status": "acceptee" if auto else "en_attente", "auto": auto, "created_at": now,
         "decided_by": "automatique" if auto else None, "decided_at": now if auto else None, "comment": None,
         "alerts": []}
    _, count, total = await _frequent(user["id"], now)
    count, total = count + 1, total + days
    a["frequent"] = count >= FREQUENT_COUNT or total >= FREQUENT_TOTAL_DAYS
    who = f"{user['display_name']} ({' / '.join(KIND_FR[k] for k in kinds)})"
    # Toujours informer les 2 salons responsables ; le bot pinge Admin + Resp. ATC + Resp. Pilotes
    targets = list(dict.fromkeys(_lead_target(kinds) + ["responsables_atc", "responsables_pilotes"]))
    ping_payload = {"absence_id": a["id"], "kinds": kinds, "ping_roles": ["admin", "responsable_atc", "responsable_pilotes"]}
    for target in targets:
        kind_for_path = kinds[0]
        if auto:
            mid = await notify(
                "absence",
                target,
                f"🏖️ {who} est absent(e) du {_fr(body.start)} au {_fr(body.end)} ({days} j) — motif : {reason}.",
                {**ping_payload, "kind": kind_for_path},
                path=f"/suivi?tab={kind_for_path}",
            )
        else:
            mid = await notify(
                "absence_demande",
                target,
                f"📝 Demande d'absence de {who} : du {_fr(body.start)} au {_fr(body.end)} ({days} jours, "
                f"plus de {AUTO_DAYS} jours donc à valider) — motif : {reason}.",
                {**ping_payload, "kind": kind_for_path},
                path=f"/suivi?tab={kind_for_path}",
            )
        a["alerts"].append({"target": target, "id": mid})
    await db.absences.insert_one(dict(a))
    if auto:
        await _apply(a)
    for k in kinds:  # one line in each concerned responsable's history
        await log_event("absence", "Absence déclarée (acceptée automatiquement)" if auto else "Demande d'absence (plus de 7 jours)",
                        user, None, f"du {_fr(body.start)} au {_fr(body.end)} ({days} j) — motif : {reason}", scope=k)
    if a["frequent"]:
        for k, target in zip(kinds, _lead_target(kinds)):
            await notify("absence_frequente", target,
                         f"⚠️ Absences fréquentes : {user['display_name']} a déclaré {count} absence(s) pour {total} jours "
                         f"sur les 90 derniers jours.", {"user_id": user["id"], "kind": k}, path=f"/suivi?tab={k}")
            await log_event("absence", "Alerte : absences fréquentes", None, None,
                            f"{user['display_name']} — {count} absence(s), {total} jours sur 90 jours", scope=k)
    return _out(a, user)


@router.post("/me/{absence_id}/end", response_model=Absence)
async def end_mine(absence_id: str, request: Request, user: dict = Depends(current_user)):
    """« Je reviens plus tôt » (ongoing absence) or « Annuler » (not started yet / still pending)."""
    await guard_write(request, user)
    a = await db.absences.find_one({"id": absence_id, "user_id": user["id"]}, {"_id": 0})
    if not a or a["status"] not in LIVE:
        raise HTTPException(404, "Absence introuvable ou déjà terminée.")
    now = utcnow()
    s, e = _bounds(a)
    if now >= e:
        raise HTTPException(409, "Cette absence est déjà terminée.")
    started = a["status"] == "acceptee" and s <= now
    upd = {"status": "ecourtee" if started else "annulee", "ended_at": now}
    if started:
        upd["end"] = (now.date() - timedelta(days=1)).isoformat() if now.date() > _d(a["start"]) else a["start"]
        upd["days"] = (_d(upd["end"]) - _d(a["start"])).days + 1
    await db.absences.update_one({"id": absence_id}, {"$set": upd})
    if a["status"] == "acceptee":
        await _unapply(a, now)
    label = "Retour anticipé d'absence" if started else "Absence annulée par le membre"
    for k in a["kinds"]:
        await log_event("absence", label, user, None, f"absence prévue du {_fr(a['start'])} au {_fr(a['end'])}", scope=k)
    for al in a.get("alerts", []):
        if a["status"] == "en_attente":
            await handled(al["id"], al["target"], f"✅ Demande d'absence de {user['display_name']} retirée par le membre.")
    return _out({**a, **upd}, user)


@router.get("", response_model=list[Absence])
async def list_absences(kind: Literal["pilote", "atc"] = Query(...),
                        scope: Literal["a_traiter", "en_cours", "historique"] = Query("a_traiter"),
                        user: dict = Depends(current_user)):
    if not can_manage(user, kind):
        raise HTTPException(403, f"Réservé aux administrateurs et au {LEAD_FR[kind]}.")
    today = utcnow().date().isoformat()
    q: dict = {"kinds": kind}
    if scope == "a_traiter":
        q["status"] = "en_attente"
    elif scope == "en_cours":
        q.update({"status": "acceptee", "end": {"$gte": today}})
    docs = await db.absences.find(q, {"_id": 0}).sort("start", -1 if scope == "historique" else 1).to_list(300)
    return [_out(d, user) for d in docs]


@router.post("/{absence_id}/decision", response_model=Absence)
async def decide(absence_id: str, body: DecisionIn, request: Request, user: dict = Depends(current_user)):
    await guard_write(request, user)
    a = await db.absences.find_one({"id": absence_id}, {"_id": 0})
    if not a:
        raise HTTPException(404, "Absence introuvable.")
    if not any(can_manage(user, k) for k in a["kinds"]):
        raise HTTPException(403, "Réservé aux administrateurs et aux responsables concernés.")
    if a["user_id"] == user["id"]:
        raise HTTPException(400, "Vous ne pouvez pas traiter votre propre absence.")
    now = utcnow()
    comment = (body.comment or "").strip() or None
    actor = _actor(user, a["kinds"])
    period = f"du {_fr(a['start'])} au {_fr(a['end'])}"
    if body.decision in ("accept", "refuse"):
        if a["status"] != "en_attente":
            raise HTTPException(409, "Cette demande a déjà été traitée.")
        if body.decision == "refuse" and not comment:
            raise HTTPException(422, "Indiquez au membre pourquoi l'absence est refusée.")
        upd = {"status": "acceptee" if body.decision == "accept" else "refusee", "decided_by": user["display_name"],
               "decided_at": now, "comment": comment}
        res = await db.absences.update_one({"id": absence_id, "status": "en_attente"}, {"$set": upd})
        if not res.modified_count:
            raise HTTPException(409, "Cette demande a déjà été traitée.")
        a = {**a, **upd}
        ok = body.decision == "accept"
        if ok:
            await _apply(a)
        label = "Absence acceptée" if ok else "Absence refusée"
        dm = (f"{'✅' if ok else '⛔'} Ta demande d'absence {period} a été {'acceptée' if ok else 'refusée'} par "
              f"{user['display_name']}" + (f" : {comment}" if comment else "."))
        done = f"{'✅' if ok else '⛔'} Traitée par {user['display_name']} : absence de {a['display_name']} {period} " \
               f"{'acceptée' if ok else 'refusée'}."
    else:  # shorten an accepted absence
        if a["status"] != "acceptee":
            raise HTTPException(409, "Seule une absence acceptée peut être raccourcie.")
        if not body.end:
            raise HTTPException(422, "Indiquez le nouveau dernier jour d'absence.")
        new_end = _d(body.end)
        if new_end < _d(a["start"]) or new_end >= _d(a["end"]):
            raise HTTPException(422, "Le nouveau dernier jour doit être entre le début et la fin actuelle de l'absence.")
        if not comment:
            raise HTTPException(422, "Indiquez au membre pourquoi l'absence est raccourcie.")
        upd = {"end": body.end, "days": (new_end - _d(a["start"])).days + 1, "comment": comment,
               "shortened_by": user["display_name"], "shortened_at": now}
        await db.absences.update_one({"id": absence_id}, {"$set": upd})
        a = {**a, **upd}
        await _unapply(a, _bounds(a)[1])
        label = f"Absence raccourcie (jusqu'au {_fr(body.end)})"
        dm = f"✂️ Ton absence a été raccourcie par {user['display_name']} : elle se termine le {_fr(body.end)}. Motif : {comment}"
        done = None
    for k in a["kinds"]:
        await log_event("absence", label, actor, None, f"{a['display_name']} — {period} — motif : {a['reason']}"
                        + (f" — réponse : {comment}" if comment else ""), scope=k)
    await notify(f"absence_{body.decision}", "membre", dm, {"absence_id": absence_id}, a.get("discord_id"))
    if done:
        for al in a.get("alerts", []):
            await handled(al["id"], al["target"], done)
    return _out(a, user)
