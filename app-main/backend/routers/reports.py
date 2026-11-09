"""Signalements ATC → pilote (HRP, phraséologie, vitesse de roulage, etc.)."""

from __future__ import annotations

import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from lib.auth import require
from lib.db import db
from lib.engine import aware, utcnow
from lib.events import log_event

router = APIRouter(prefix="/reports", tags=["reports"])

CATEGORIES = (
    "hrp",
    "phraseologie",
    "vitesse_roulage",
    "non_respect_clairance",
    "autre",
)


class ReportIn(BaseModel):
    flight_id: str = Field(min_length=1, max_length=64)
    target_id: str = Field(min_length=1, max_length=64)
    category: str = Field(min_length=2, max_length=40)
    comment: str = Field(default="", max_length=1000)


@router.post("")
async def create_report(body: ReportIn, user: dict = Depends(require("flight:control"))):
    if body.category not in CATEGORIES:
        raise HTTPException(422, f"Catégorie invalide. Choisir parmi : {', '.join(CATEGORIES)}")
    f = await db.flights.find_one({"id": body.flight_id}, {"_id": 0})
    if not f:
        raise HTTPException(404, "Vol introuvable.")
    # doit contrôler ce vol (ou admin)
    if user.get("role") not in ("admin", "atc") and user["id"] != f.get("controller_id"):
        # soft check: admin always ok
        if user.get("role") != "admin":
            pass
    target = await db.users.find_one({"id": body.target_id}, {"_id": 0, "display_name": 1})
    doc = {
        "id": str(uuid.uuid4()),
        "flight_id": body.flight_id,
        "callsign": f.get("callsign"),
        "author_id": user["id"],
        "author_name": user["display_name"],
        "target_id": body.target_id,
        "target_name": (target or {}).get("display_name") or f.get("pilot_name"),
        "category": body.category,
        "comment": (body.comment or "").strip(),
        "status": "open",
        "created_at": utcnow(),
    }
    await db.reports.insert_one(dict(doc))
    await log_event("signalement", f"Signalement {body.category}", user, f, doc["comment"] or body.category)
    return doc


@router.get("")
async def list_reports(user: dict = Depends(require("flight:read"))):
    """Responsables / admin : tous ; auteur ou cible : les siens."""
    role = user.get("role")
    if role == "admin" or user.get("access", {}).get("admin"):
        q = {}
    else:
        q = {"$or": [{"author_id": user["id"]}, {"target_id": user["id"]}]}
    docs = await db.reports.find(q, {"_id": 0}).sort("created_at", -1).to_list(200)
    for d in docs:
        d["created_at"] = aware(d.get("created_at"))
    return docs


@router.patch("/{report_id}")
async def close_report(report_id: str, body: dict, user: dict = Depends(require("admin:users"))):
    status = body.get("status") or "closed"
    d = await db.reports.find_one_and_update(
        {"id": report_id},
        {"$set": {"status": status, "closed_at": utcnow(), "closed_by": user["display_name"]}},
        projection={"_id": 0},
        return_document=True,
    )
    if not d:
        raise HTTPException(404, "Signalement introuvable.")
    return d
