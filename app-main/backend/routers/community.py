"""Community: public profiles, moderated reviews (pilot <-> controller after a real interaction), flight history."""

import re
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from pymongo.errors import DuplicateKeyError

from lib.auth import require
from lib.db import db
from lib.discord_roles import access_of
from lib.engine import aware, utcnow
from lib.hours import PROJECTION as HOURS_PROJECTION, counted_hours
from lib.events import log_event
from models.schemas import (HistoryEntry, Interaction, PublicProfile, PublicReview, Review, ReviewDecisionIn,
                            ReviewIn)
from routers.common import avatar_url

router = APIRouter(tags=["community"])
REVIEW_WINDOW = timedelta(hours=24)  # after the end of the flight, while it is still fresh in mind
CLOSED = ["termine", "annule"]


async def _controllers_of(flight_id: str) -> dict[str, str]:
    """Controllers who really acted on the flight (journal entries written in ATC role)."""
    out: dict[str, str] = {}
    async for e in db.events.find({"flight_id": flight_id, "actor_role": "atc", "actor_id": {"$ne": None}},
                                  {"_id": 0, "actor_id": 1, "actor_name": 1}):
        out[e["actor_id"]] = e["actor_name"]
    return out


async def _interactions(user: dict) -> list[Interaction]:
    """Opinions still to give: one per pilot <-> controller pair of a flight that has ENDED (« Terminer le vol »),
    during the 24 h that follow. Opinions given or declined (« Ne pas laisser d'avis ») are gone for good."""
    since = utcnow() - REVIEW_WINDOW
    out: list[Interaction] = []
    # as a pilot: every controller who acted on my finished flights
    async for f in db.flights.find({"pilot_id": user["id"], "phase": "termine", "updated_at": {"$gte": since}}, {"_id": 0}):
        for cid, cname in (await _controllers_of(f["id"])).items():
            if cid != user["id"]:
                out.append(Interaction(flight_id=f["id"], callsign=f["callsign"], departure=f["departure"],
                                       arrival=f["arrival"], target_id=cid, target_name=cname, target_role="atc",
                                       at=aware(f["updated_at"])))
    # as a controller: pilots of the finished flights I acted on
    ids = await db.events.distinct("flight_id", {"actor_id": user["id"], "actor_role": "atc",
                                                 "at": {"$gte": since - timedelta(days=2)}})  # long flights included
    async for f in db.flights.find({"id": {"$in": [i for i in ids if i]}, "phase": "termine", "updated_at": {"$gte": since}},
                                   {"_id": 0}):
        if f["pilot_id"] != user["id"]:
            out.append(Interaction(flight_id=f["id"], callsign=f["callsign"], departure=f["departure"],
                                   arrival=f["arrival"], target_id=f["pilot_id"], target_name=f["pilot_name"],
                                   target_role="pilote", at=aware(f["updated_at"])))
    done = {(r["flight_id"], r["target_id"]) async for r in
            db.reviews.find({"author_id": user["id"]}, {"_id": 0, "flight_id": 1, "target_id": 1})}
    done |= {(d["flight_id"], d["target_id"]) async for d in
             db.review_dismissals.find({"user_id": user["id"]}, {"_id": 0, "flight_id": 1, "target_id": 1})}
    # « Plus tard » (controllers only): the end-of-flight window closes, the bell keeps the reminder until the deadline
    snoozed = {(s["flight_id"], s["target_id"]) async for s in
               db.review_snoozes.find({"user_id": user["id"]}, {"_id": 0, "flight_id": 1, "target_id": 1})}
    for i in out:
        i.snoozed = (i.flight_id, i.target_id) in snoozed
        i.deadline = i.at + REVIEW_WINDOW
    return sorted([i for i in out if (i.flight_id, i.target_id) not in done], key=lambda i: i.at, reverse=True)


async def _pending(user: dict, flight_id: str, target_id: str) -> Interaction:
    i = next((x for x in await _interactions(user) if x.flight_id == flight_id and x.target_id == target_id), None)
    if not i:
        raise HTTPException(404, "Aucun avis en attente pour ce vol (délai de 24 h dépassé, ou déjà traité).")
    return i


@router.get("/reviews/interactions", response_model=list[Interaction])
async def my_interactions(user: dict = Depends(require("review:write"))):
    return await _interactions(user)


@router.post("/reviews", response_model=Review)
async def create_review(body: ReviewIn, user: dict = Depends(require("review:write"))):
    match = next((i for i in await _interactions(user)
                  if i.flight_id == body.flight_id and i.target_id == body.target_id), None)
    if not match:
        raise HTTPException(403, "Avis possible uniquement après une interaction réelle sur un vol, et une seule fois.")
    doc = {"id": str(uuid.uuid4()), "flight_id": match.flight_id, "callsign": match.callsign,
           "author_id": user["id"], "author_name": user["display_name"], "target_id": match.target_id,
           "target_name": match.target_name, "target_role": match.target_role, "rating": body.rating,
           "comment": body.comment.strip(), "status": "pending", "created_at": utcnow(),
           "decided_at": None, "decided_by": None}
    try:
        await db.reviews.insert_one(dict(doc))
    except DuplicateKeyError:
        raise HTTPException(409, "Vous avez déjà laissé un avis pour cette interaction.")
    await log_event("avis", "Avis soumis (en attente de modération)", user, None,
                    f"{match.callsign} → {match.target_name} : {body.rating}/5")
    return Review(**doc)


@router.get("/admin/reviews", response_model=list[Review])
async def list_reviews(status: str = Query("pending", pattern="^(pending|accepted|rejected)$"),
                       user: dict = Depends(require("admin:reviews"))):
    docs = await db.reviews.find({"status": status}, {"_id": 0}).sort("created_at", -1).to_list(300)
    return [Review(**{**d, "created_at": aware(d["created_at"]), "decided_at": aware(d.get("decided_at"))}) for d in docs]


@router.patch("/admin/reviews/{review_id}", response_model=Review)
async def decide_review(review_id: str, body: ReviewDecisionIn, user: dict = Depends(require("admin:reviews"))):
    status = "accepted" if body.decision == "accept" else "rejected"
    d = await db.reviews.find_one_and_update(
        {"id": review_id}, {"$set": {"status": status, "decided_at": utcnow(), "decided_by": user["display_name"]}},
        projection={"_id": 0}, return_document=True)
    if not d:
        raise HTTPException(404, "Avis introuvable.")
    await log_event("admin", f"Avis {'accepté' if status == 'accepted' else 'rejeté'}", user, None,
                    f"{d['author_name']} → {d['target_name']} ({d['callsign']}, {d['rating']}/5)")
    return Review(**{**d, "created_at": aware(d["created_at"]), "decided_at": aware(d.get("decided_at"))})


async def rating_of(user_id: str) -> tuple[float | None, int]:
    rows = [r["rating"] async for r in db.reviews.find({"target_id": user_id, "status": "accepted"}, {"_id": 0, "rating": 1})]
    return (round(sum(rows) / len(rows), 2) if rows else None), len(rows)


def block_hours(f: dict) -> float:
    return counted_hours(f)  # capped to the planned flight + margin (lib/hours)


@router.get("/users/{user_id}/profile", response_model=PublicProfile)
async def public_profile(user_id: str, user: dict = Depends(require("flight:read"))):
    u = await db.users.find_one({"id": user_id}, {"_id": 0, "password_hash": 0})
    if not u:
        raise HTTPException(404, "Profil introuvable.")
    flights = await db.flights.find({"pilot_id": user_id}, {"_id": 0, "phase": 1, "block_off_at": 1, "block_on_at": 1, **HOURS_PROJECTION}).to_list(5000)
    hours = sum(block_hours(f) for f in flights)
    rating, count = await rating_of(user_id)
    from routers.leaderboard import level_for  # local import: avoids a cycle
    reviews = await db.reviews.find({"target_id": user_id, "status": "accepted"}, {"_id": 0}).sort("created_at", -1).to_list(50)
    # flights this member controlled: responsible position recorded by the engine, plus (older flights) flights on
    # which they acted as a controller
    controlled = set(await db.flights.distinct("id", {"controllers": user_id}))
    controlled |= set(await db.events.distinct("flight_id", {"actor_id": user_id, "actor_role": "atc", "flight_id": {"$ne": None}}))
    controlled &= set(await db.flights.distinct("id", {"id": {"$in": list(controlled)}}))  # deleted flights no longer count
    # never exposes email, SimBrief Pilot ID, ban details, tokens or password data
    return PublicProfile(
        id=u["id"], display_name=u["display_name"], avatar_url=avatar_url(u), discord_username=u.get("discord_username"),
        atc_allowed=bool(u.get("atc_allowed")), atc_flights=len(controlled), level=level_for(hours),
        stars=min(5, int(hours // 10)), pilot_hours=round(hours, 1), atc_hours=round(u.get("atc_seconds", 0) / 3600, 1),
        flights=sum(1 for f in flights if f["phase"] == "termine" or f.get("block_on_at")),
        flights_cancelled=sum(1 for f in flights if f["phase"] == "annule"), rating=rating, reviews_count=count,
        reviews=[PublicReview(id=r["id"], author_name=r["author_name"], callsign=r["callsign"], target_role=r["target_role"],
                              rating=r["rating"], comment=r["comment"], created_at=aware(r["created_at"])) for r in reviews],
        member_since=aware(u["created_at"]),
        is_creator=(acc := access_of(u))["creator"], is_admin=acc["admin"], is_atc_lead=acc["atc_lead"],
        is_pilot=acc["pilote"] or not u.get("discord_id"),
        can_delete=user.get("role") == "admin" and u["id"] != user["id"] and not acc["creator"]
                   and (not acc["admin"] or access_of(user)["creator"]),
    )


@router.get("/history", response_model=list[HistoryEntry])
async def history(q: str = Query("", max_length=40), status: str = Query("all", pattern="^(all|termine|annule)$"),
                  airport: str = Query("", max_length=4), user: dict = Depends(require("history:read"))):
    flt: dict = {"phase": {"$in": CLOSED} if status == "all" else status}
    if q.strip():
        rx = {"$regex": re.escape(q.strip()), "$options": "i"}
        flt["$or"] = [{"callsign": rx}, {"pilot_name": rx}, {"aircraft_type": rx}]
    if airport.strip():
        ap = airport.strip().upper()
        flt.setdefault("$and", []).append({"$or": [{"departure": ap}, {"arrival": ap}]})
    docs = await db.flights.find(flt, {"_id": 0, "route": 0, "taxi_out": 0, "taxi_in": 0}).sort("updated_at", -1).to_list(500)
    out = []
    for f in docs:
        off, on = aware(f.get("block_off_at")), aware(f.get("block_on_at"))
        out.append(HistoryEntry(id=f["id"], callsign=f["callsign"], pilot_id=f["pilot_id"], pilot_name=f["pilot_name"],
                                aircraft_type=f["aircraft_type"], departure=f["departure"], arrival=f["arrival"],
                                phase=f["phase"], departed_at=off, arrived_at=on,
                                duration_min=int((on - off).total_seconds() // 60) if off and on else None,
                                created_at=aware(f["created_at"])))
    return out


class ReviewChoiceIn(BaseModel):
    flight_id: str = Field(min_length=1, max_length=60)
    target_id: str = Field(min_length=1, max_length=60)


@router.post("/reviews/snooze")
async def snooze_review(body: ReviewChoiceIn, user: dict = Depends(require("review:write"))):
    """« Plus tard » — controllers only: the end-of-flight window closes, the reminder stays in the bell (24 h)."""
    i = await _pending(user, body.flight_id, body.target_id)
    if i.target_role != "pilote":
        raise HTTPException(403, "Le pilote donne son avis tout de suite, ou choisit de ne pas en laisser.")
    await db.review_snoozes.update_one(
        {"user_id": user["id"], "flight_id": i.flight_id, "target_id": i.target_id},
        {"$set": {"user_id": user["id"], "flight_id": i.flight_id, "target_id": i.target_id, "at": utcnow()}},
        upsert=True,
    )
    return {"ok": True, "deadline": i.deadline}


@router.post("/reviews/dismiss")
async def dismiss_review(body: ReviewChoiceIn, user: dict = Depends(require("review:write"))):
    """« Ne pas laisser d'avis »: the form and the reminder are gone for good."""
    i = await _pending(user, body.flight_id, body.target_id)
    await db.review_dismissals.update_one(
        {"user_id": user["id"], "flight_id": i.flight_id, "target_id": i.target_id},
        {"$set": {"user_id": user["id"], "flight_id": i.flight_id, "target_id": i.target_id, "at": utcnow()}},
        upsert=True,
    )
    return {"ok": True}


@router.get("/notifications")
async def my_notifications(user: dict = Depends(require("flight:read"))):
    """Cloche : avis à laisser, signalements, etc."""
    items = []
    try:
        for i in await _interactions(user):
            items.append({
                "id": f"review-{i.flight_id}-{i.target_id}",
                "kind": "review",
                "title": f"Avis à laisser — {i.callsign}",
                "body": f"{i.target_name} ({'contrôleur' if i.target_role == 'atc' else 'pilote'}) · avant le "
                        f"{i.deadline.strftime('%d/%m à %H:%M')} UTC",
                "at": i.at,
                "href": "/profile",
                "flight_id": i.flight_id,
                "target_id": i.target_id,
            })
    except Exception:
        pass
    # signalements : reçus, clôturés (avec le mot de clôture), à traiter pour les responsables
    from routers.reports import report_notifications
    items += await report_notifications(user)
    # Fréquences ouvertes (info communauté)
    try:
        async for pos in db.atc_positions.find({"closed_at": None}, {"_id": 0}).limit(30):
            items.append({
                "id": f"freq-{pos.get('id') or pos.get('callsign')}",
                "kind": "frequency",
                "title": f"Fréquence ouverte — {pos.get('callsign') or pos.get('airport')}",
                "body": f"{pos.get('airport', '')} · {pos.get('frequency', '')} · {pos.get('type', '')}",
                "at": pos.get("opened_at") or pos.get("updated_at"),
                "href": "/",
            })
    except Exception:
        pass
    # annonces du Créateur à tous les membres (30 derniers jours)
    since = utcnow() - timedelta(days=30)
    async for a in db.announcements.find({"at": {"$gte": since}}, {"_id": 0}).sort("at", -1).limit(10):
        items.append({"id": f"announcement-{a['id']}", "kind": "announcement", "title": a["title"], "body": a["body"],
                      "at": a["at"], "href": None})
    for it in items:
        it["at"] = aware(it["at"]) if isinstance(it.get("at"), datetime) else None
    items.sort(key=lambda x: x["at"] or datetime.min.replace(tzinfo=timezone.utc), reverse=True)
    items = items[:40]
    seen = aware(user.get("notif_seen_at"))
    for it in items:  # « nouveau » : arrivé depuis la dernière ouverture de la cloche
        it["unread"] = bool(it["at"] and (not seen or it["at"] > seen))
    return {"items": items, "count": len(items), "unread": sum(it["unread"] for it in items)}


@router.post("/notifications/seen")
async def notifications_seen(user: dict = Depends(require("flight:read"))):
    """The bell was opened: everything shown so far is no longer new."""
    await db.users.update_one({"id": user["id"]}, {"$set": {"notif_seen_at": utcnow()}})
    return {"ok": True}
