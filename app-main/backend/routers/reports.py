"""Signalements dans les deux sens : un contrôleur signale un pilote (HRP, phraséologie, vitesse de roulage…), un pilote
signale un contrôleur (non-respect des procédures, phraséologie…).

Qui voit et traite quoi :
  - le Responsable Pilotes : tous les signalements visant des pilotes ;
  - le Responsable ATC : tous les signalements visant des contrôleurs ;
  - les administrateurs (et le Créateur) : tous ;
  - chaque membre : ceux qu'il a déposés et ceux qui le visent.
Clôturer = marquer comme traité, avec un mot facultatif transmis à l'auteur et à la personne visée (notifications)."""

from __future__ import annotations

import uuid
from datetime import timedelta
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from lib.activity import can_manage
from lib.auth import require
from lib.db import db
from lib.engine import aware, utcnow
from lib.events import log_event

router = APIRouter(prefix="/reports", tags=["reports"])

# kind = who is reported
CATEGORIES: dict[str, dict[str, str]] = {
    "pilote": {"hrp": "HRP", "phraseologie": "Phraséologie", "vitesse_roulage": "Vitesse de roulage",
               "non_respect_clairance": "Non-respect clairance", "autre": "Autre"},
    "atc": {"non_respect_procedures": "Non-respect des procédures", "phraseologie": "Phraséologie",
            "instructions": "Instructions erronées ou dangereuses", "comportement": "Comportement / HRP", "autre": "Autre"},
}
KIND_FR = {"pilote": "pilote", "atc": "contrôleur"}


class ReportIn(BaseModel):
    flight_id: str = Field(min_length=1, max_length=64)
    target_id: str = Field(min_length=1, max_length=64)
    kind: Literal["pilote", "atc"] = "pilote"
    category: str = Field(min_length=2, max_length=40)
    comment: str = Field(default="", max_length=1000)


class CloseIn(BaseModel):
    comment: str = Field(default="", max_length=500)


def _kind(d: dict) -> str:
    return d.get("kind") or "pilote"  # older reports: always a controller reporting a pilot


def _managed(user: dict) -> list[str]:
    return [k for k in ("pilote", "atc") if can_manage(user, k)]


def _kind_query(kinds: list[str]) -> list[dict]:
    out: list[dict] = []
    for k in kinds:
        out.append({"kind": k})
        if k == "pilote":
            out.append({"kind": {"$exists": False}})
    return out


async def flight_controllers(flight_id: str) -> dict[str, str]:
    """Controllers who really acted on the flight (journal entries written in ATC role)."""
    out: dict[str, str] = {}
    async for e in db.events.find({"flight_id": flight_id, "actor_role": "atc", "actor_id": {"$ne": None}},
                                  {"_id": 0, "actor_id": 1, "actor_name": 1}):
        out[e["actor_id"]] = e["actor_name"]
    return out


def _out(d: dict, user: dict) -> dict:
    kind = _kind(d)
    return {**d, "kind": kind, "category_label": CATEGORIES[kind].get(d.get("category"), d.get("category")),
            "created_at": aware(d.get("created_at")), "closed_at": aware(d.get("closed_at")),
            "can_close": d.get("status") == "open" and can_manage(user, kind)}


@router.get("/targets")
async def report_targets(flight_id: str = Query(min_length=1, max_length=64), user: dict = Depends(require("flight:read"))):
    """The pilot of a flight can report the controllers who handled it."""
    f = await db.flights.find_one({"id": flight_id}, {"_id": 0, "pilot_id": 1})
    if not f:
        raise HTTPException(404, "Vol introuvable.")
    if f["pilot_id"] != user["id"]:
        return []
    return [{"id": i, "name": n} for i, n in (await flight_controllers(flight_id)).items() if i != user["id"]]


@router.post("")
async def create_report(body: ReportIn, user: dict = Depends(require("flight:read"))):
    cats = CATEGORIES[body.kind]
    if body.category not in cats:
        raise HTTPException(422, f"Catégorie invalide. Choisir parmi : {', '.join(cats.values())}")
    f = await db.flights.find_one({"id": body.flight_id}, {"_id": 0})
    if not f:
        raise HTTPException(404, "Vol introuvable.")
    if body.target_id == user["id"]:
        raise HTTPException(422, "Impossible de se signaler soi-même.")
    if body.kind == "pilote":  # a controller reports the pilot of the flight
        if user.get("role") not in ("atc", "admin"):
            raise HTTPException(403, "Seuls les contrôleurs signalent un pilote.")
        if body.target_id != f["pilot_id"]:
            raise HTTPException(422, "La personne signalée doit être le pilote de ce vol.")
        target_name = f.get("pilot_name")
    else:  # the pilot reports a controller who handled the flight
        if f["pilot_id"] != user["id"] and user.get("role") != "admin":
            raise HTTPException(403, "Seul le pilote du vol peut signaler un contrôleur de ce vol.")
        controllers = await flight_controllers(f["id"])
        if body.target_id not in controllers:
            raise HTTPException(422, "Ce contrôleur n'a pas géré ce vol.")
        target_name = controllers[body.target_id]
    doc = {
        "id": str(uuid.uuid4()), "kind": body.kind, "flight_id": body.flight_id, "callsign": f.get("callsign"),
        "author_id": user["id"], "author_name": user["display_name"], "target_id": body.target_id,
        "target_name": target_name, "category": body.category, "comment": (body.comment or "").strip(),
        "status": "open", "created_at": utcnow(), "closed_at": None, "closed_by": None, "close_comment": None,
    }
    await db.reports.insert_one(dict(doc))
    await log_event("signalement", f"Signalement d'un {KIND_FR[body.kind]} : {cats[body.category]}", user, f,
                    f"{target_name} — {doc['comment'] or 'sans commentaire'}")
    return _out(doc, user)


@router.get("")
async def list_reports(status: Literal["open", "closed", "all"] = "all", user: dict = Depends(require("flight:read"))):
    """What this member may see: the ones they wrote or that concern them, plus every report of the kind they manage."""
    visible = [{"author_id": user["id"]}, {"target_id": user["id"]}] + _kind_query(_managed(user))
    q: dict = {"$or": visible}
    if status != "all":
        q["status"] = status
    docs = await db.reports.find(q, {"_id": 0}).sort("created_at", -1).to_list(300)
    return [_out(d, user) for d in docs]


@router.patch("/{report_id}")
async def close_report(report_id: str, body: CloseIn, user: dict = Depends(require("flight:read"))):
    d = await db.reports.find_one({"id": report_id}, {"_id": 0})
    if not d:
        raise HTTPException(404, "Signalement introuvable.")
    kind = _kind(d)
    if not can_manage(user, kind):
        raise HTTPException(403, "Réservé au Responsable Pilotes (signalements de pilotes), au Responsable ATC "
                                 "(signalements de contrôleurs) et aux administrateurs.")
    if d.get("status") != "open":
        raise HTTPException(409, "Ce signalement est déjà clôturé.")
    upd = {"status": "closed", "closed_at": utcnow(), "closed_by": user["display_name"], "closed_by_id": user["id"],
           "close_comment": (body.comment or "").strip() or None}
    await db.reports.update_one({"id": report_id}, {"$set": upd})
    await log_event("signalement", "Signalement clôturé", user, None,
                    f"{d.get('author_name')} → {d.get('target_name')} ({d.get('callsign') or '—'})"
                    + (f" — {upd['close_comment']}" if upd["close_comment"] else ""))
    return _out({**d, **upd}, user)


async def report_notifications(user: dict) -> list[dict]:
    """Bell: reports received, reports closed (with the closing note) and, for responsables, reports to handle."""
    items: list[dict] = []
    async for s in db.reports.find({"status": "open", "target_id": user["id"]}, {"_id": 0}).sort("created_at", -1).limit(20):
        k = _kind(s)
        items.append({"id": f"report-{s['id']}", "kind": "report", "title": "Signalement reçu",
                      "body": f"{CATEGORIES[k].get(s.get('category'), s.get('category'))} · {s.get('callsign') or ''}",
                      "at": s.get("created_at"), "href": "/signalements"})
    since = utcnow() - timedelta(days=7)
    async for s in db.reports.find({"status": "closed", "closed_at": {"$gte": since},
                                    "$or": [{"author_id": user["id"]}, {"target_id": user["id"]}]},
                                   {"_id": 0}).sort("closed_at", -1).limit(10):
        note = s.get("close_comment")
        items.append({"id": f"report-closed-{s['id']}", "kind": "report", "title": "Signalement clôturé",
                      "body": f"{s.get('callsign') or ''} · par {s.get('closed_by')}" + (f" — « {note} »" if note else ""),
                      "at": s.get("closed_at"), "href": "/signalements"})
    managed = _managed(user)
    if managed:
        async for s in db.reports.find({"status": "open", "$or": _kind_query(managed), "target_id": {"$ne": user["id"]}},
                                       {"_id": 0}).sort("created_at", -1).limit(10):
            items.append({"id": f"report-todo-{s['id']}", "kind": "report", "title": "Signalement à traiter",
                          "body": f"{s.get('author_name')} → {s.get('target_name')} · {s.get('callsign') or ''}",
                          "at": s.get("created_at"), "href": "/signalements"})
    return items
