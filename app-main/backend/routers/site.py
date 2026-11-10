"""Apparence du site (thème saisonnier) et annonces du Créateur à tous les membres.

Seul le Créateur (compte Discord fixé dans lib/discord_roles) change le thème et publie des annonces ; le thème est
lu par tout le monde, page de connexion comprise."""

import uuid
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from lib.auth import current_user, is_creator
from lib.db import db
from lib.engine import aware, utcnow
from lib.events import log_event

router = APIRouter(prefix="/site", tags=["site"])

THEMES = {"standard": "Standard", "noel": "Noël", "halloween": "Halloween", "paques": "Pâques"}


class ThemeIn(BaseModel):
    theme: Literal["standard", "noel", "halloween", "paques"]


class AnnouncementIn(BaseModel):
    title: str = Field(min_length=2, max_length=80)
    body: str = Field(min_length=2, max_length=600)


def _creator_only(user: dict) -> None:
    if not is_creator(user):
        raise HTTPException(403, "Réservé au Créateur du site.")


def _ann(d: dict) -> dict:
    return {"id": d["id"], "title": d["title"], "body": d["body"], "by": d.get("by"), "at": aware(d["at"])}


@router.get("/theme")
async def get_theme():
    """Public: the login page wears the theme too."""
    d = await db.settings.find_one({"_id": "theme"}) or {}
    theme = d.get("theme") if d.get("theme") in THEMES else "standard"
    return {"theme": theme, "by": d.get("by"), "at": aware(d.get("at"))}


@router.put("/theme")
async def set_theme(body: ThemeIn, user: dict = Depends(current_user)):
    _creator_only(user)
    now = utcnow()
    await db.settings.update_one({"_id": "theme"}, {"$set": {"theme": body.theme, "by": user["display_name"], "at": now}},
                                 upsert=True)
    await log_event("admin", "Thème du site changé", user, None, THEMES[body.theme])
    return {"theme": body.theme, "by": user["display_name"], "at": now}


@router.get("/announcements")
async def list_announcements(user: dict = Depends(current_user)):
    _creator_only(user)
    return [_ann(d) async for d in db.announcements.find({}, {"_id": 0}).sort("at", -1).limit(50)]


@router.post("/announcements")
async def create_announcement(body: AnnouncementIn, user: dict = Depends(current_user)):
    _creator_only(user)
    d = {"id": str(uuid.uuid4()), "title": body.title.strip(), "body": body.body.strip(), "by": user["display_name"],
         "at": utcnow()}
    await db.announcements.insert_one(dict(d))
    await log_event("admin", "Annonce envoyée à tous les membres", user, None, d["title"])
    return _ann(d)


@router.delete("/announcements/{announcement_id}")
async def delete_announcement(announcement_id: str, user: dict = Depends(current_user)):
    _creator_only(user)
    d = await db.announcements.find_one_and_delete({"id": announcement_id}, {"_id": 0})
    if not d:
        raise HTTPException(404, "Annonce introuvable.")
    await log_event("admin", "Annonce retirée", user, None, d["title"])
    return {"ok": True}
