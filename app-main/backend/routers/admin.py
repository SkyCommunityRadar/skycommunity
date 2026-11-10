from fastapi import APIRouter, Depends, HTTPException, Query

import os

from lib.auth import is_creator, require
from lib.discord_roles import access_of, resync_if_due
from lib.db import db
from datetime import timedelta

from lib.engine import aware, utcnow
from lib.events import log_event
from lib.handover import close_positions
from lib.security import NEW_ACCOUNT_HOURS, security_settings, set_lockdown
from pydantic import BaseModel, Field
from models.schemas import AdminUserPatch, FlightEvent, UserOut
from routers.common import delete_flights_data, user_out

router = APIRouter(prefix="/admin", tags=["admin"])


def _out(d: dict) -> UserOut:
    a = access_of(d)
    return user_out({**d, "role": "admin" if a["admin"] else ("atc" if a["atc"] else ("pilote" if a["pilote"] else "aucun"))})


@router.get("/users", response_model=list[UserOut])
async def users(user: dict = Depends(require("admin:users"))):
    docs = await db.users.find({}, {"_id": 0, "password_hash": 0}).sort("created_at", 1).to_list(1000)
    return [_out(d) for d in docs]


@router.patch("/users/{user_id}", response_model=UserOut)
async def patch_user(user_id: str, body: AdminUserPatch, user: dict = Depends(require("admin:users"))):
    target = await db.users.find_one({"id": user_id}, {"_id": 0, "password_hash": 0})
    if not target:
        raise HTTPException(404, "Utilisateur introuvable.")
    if target["id"] == user["id"]:
        raise HTTPException(400, "Vous ne pouvez pas sanctionner votre propre compte.")
    if is_creator(target):
        raise HTTPException(403, "Le compte du Créateur ne peut pas être sanctionné.")
    if access_of(target)["admin"] and not is_creator(user):
        raise HTTPException(403, "Seul le Créateur peut sanctionner un administrateur.")
    upd: dict = {}
    labels = []
    revoke = False
    if body.disabled is not None:
        upd["disabled"] = body.disabled
        labels.append("bloqué définitivement" if body.disabled else "débloqué")
        revoke = revoke or body.disabled
        if not body.disabled:
            upd["banned_until"] = None
    if body.ban_hours is not None:
        upd["banned_until"] = utcnow() + timedelta(hours=body.ban_hours) if body.ban_hours > 0 else None
        labels.append(f"suspendu {body.ban_hours} h" if body.ban_hours > 0 else "suspension levée")
        revoke = revoke or body.ban_hours > 0
    if body.ban_reason is not None:
        upd["ban_reason"] = body.ban_reason.strip() or None
    if not upd:
        raise HTTPException(400, "Aucune modification.")
    if revoke:
        upd["token_version"] = int(target.get("token_version", 0)) + 1  # takes effect immediately
    await db.users.update_one({"id": user_id}, {"$set": upd})
    await log_event("admin", "Modification d'un utilisateur", user, None,
                    f"{target['display_name']} : " + ", ".join(labels) + (f" — {upd['ban_reason']}" if upd.get("ban_reason") else ""))
    return _out({**target, **upd})


@router.post("/users/{user_id}/sync", response_model=UserOut)
async def sync_user(user_id: str, user: dict = Depends(require("admin:users"))):
    """Re-reads the member's Discord roles now (needs DISCORD_BOT_TOKEN)."""
    target = await db.users.find_one({"id": user_id}, {"_id": 0, "password_hash": 0})
    if not target:
        raise HTTPException(404, "Utilisateur introuvable.")
    if not target.get("discord_id"):
        raise HTTPException(400, "Ce compte n'est pas relié à Discord.")
    if not os.environ.get("DISCORD_BOT_TOKEN"):
        raise HTTPException(503, "Le bot Discord n'est pas configuré (DISCORD_BOT_TOKEN) : synchronisation impossible.")
    target = await resync_if_due({**target, "roles_synced_at": None})
    return _out(target)


@router.get("/events", response_model=list[FlightEvent])
async def events(limit: int = Query(200, ge=1, le=1000), type: str | None = Query(None, pattern=r"^[a-z_]{2,20}$"),
                 user: dict = Depends(require("admin:log"))):
    docs = await db.events.find({"type": type} if type else {}, {"_id": 0}).sort("at", -1).to_list(limit)
    return [FlightEvent(**{**d, "at": aware(d["at"])}) for d in docs]


# ---------- deletion (administrators and the creator only) ----------

async def _delete_flights(ids: list[str]) -> None:
    await delete_flights_data(ids)



def _why_not_deletable(u: dict, me: dict) -> str | None:
    if u["id"] == me["id"]:
        return "Vous ne pouvez pas supprimer votre propre profil."
    if is_creator(u):
        return "Le profil du créateur ne peut pas être supprimé."
    if access_of(u)["admin"] and not is_creator(me):
        return "Seul le créateur peut supprimer le profil d'un administrateur."
    return None


async def _delete_user(u: dict) -> int:
    ids = await db.flights.distinct("id", {"pilot_id": u["id"]})
    await _delete_flights(ids)
    await db.reviews.delete_many({"$or": [{"author_id": u["id"]}, {"target_id": u["id"]}]})
    await db.atc_positions.delete_many({"user_id": u["id"]})
    await db.users.delete_one({"id": u["id"]})
    return len(ids)


@router.delete("/users/{user_id}")
async def delete_user(user_id: str, user: dict = Depends(require("admin:users"))):
    """Removes a member's profile, their flights and the reviews they wrote or received. The creator's account can
    never be deleted, and only the creator may delete another administrator. A member still on the Discord server
    gets a fresh, empty profile if they sign in again."""
    u = await db.users.find_one({"id": user_id}, {"_id": 0})
    if not u:
        raise HTTPException(404, "Profil introuvable.")
    if (why := _why_not_deletable(u, user)):
        raise HTTPException(400 if u["id"] == user["id"] else 403, why)
    n = await _delete_user(u)
    await log_event("admin", "Profil supprimé", user, None, f"{u['display_name']} — {n} vol(s) supprimé(s)")
    return {"ok": True}


class IdsIn(BaseModel):
    ids: list[str] = Field(min_length=1, max_length=500)


@router.post("/users/delete")
async def delete_users(body: IdsIn, user: dict = Depends(require("admin:users"))):
    """Several profiles at once (same rules as one by one; protected profiles are skipped and listed)."""
    deleted, skipped = [], []
    async for u in db.users.find({"id": {"$in": list(set(body.ids))}}, {"_id": 0}):
        if (why := _why_not_deletable(u, user)):
            skipped.append(f"{u['display_name']} : {why}")
            continue
        n = await _delete_user(u)
        deleted.append(f"{u['display_name']} ({n} vol(s))")
    if deleted:
        await log_event("admin", f"{len(deleted)} profil(s) supprimé(s)", user, None, ", ".join(deleted))
    return {"deleted": len(deleted), "skipped": skipped}


@router.post("/flights/delete")
async def delete_flights(body: IdsIn, user: dict = Depends(require("admin:flights"))):
    """Several flights at once, removed for good (with their reviews and pending handovers)."""
    docs = await db.flights.find({"id": {"$in": list(set(body.ids))}}, {"_id": 0, "id": 1, "callsign": 1}).to_list(500)
    await _delete_flights([d["id"] for d in docs])
    if docs:
        await log_event("admin", f"{len(docs)} vol(s) supprimé(s)", user, None, ", ".join(d["callsign"] for d in docs))
    return {"deleted": len(docs), "skipped": []}


# ---------- remise à zéro (créateur seulement) ----------

RESET_PHRASE = "REMISE A ZERO"
# Everything members, flights and controllers leave behind. Kept: the configuration of the site (db.settings: theme,
# anti-raid, inactivity rules), the airport data, the frequencies and the bot outbox (the link with the bot).
RESET_COLLECTIONS = ("flights", "reviews", "review_snoozes", "review_dismissals", "atc_handovers", "reports",
                     "planning", "planning_requests", "absences", "preopenings", "announcements", "simbrief_drafts",
                     "events")


class ResetIn(BaseModel):
    confirm: str = Field(max_length=40)


@router.post("/reset")
async def reset_site(body: ResetIn, user: dict = Depends(require("admin:users"))):
    """Créateur only, for the launch of the site: deletes every other account (blocked and suspended ones included)
    and all the activity, so that hours, flights and counters start again from zero. Members still on the Discord
    server get a new, empty account when they sign in again."""
    if not is_creator(user):
        raise HTTPException(403, "Réservé au créateur.")
    if body.confirm.strip().upper() != RESET_PHRASE:
        raise HTTPException(400, f"Tapez {RESET_PHRASE} pour confirmer.")
    # open positions are closed the usual way (as if each controller closed it) so the bot also closes their channels
    await close_positions(await db.atc_positions.find({}, {"_id": 0}).to_list(None), "fermeture", None)
    counts = {"comptes": (await db.users.delete_many({"id": {"$ne": user["id"]}})).deleted_count}
    for name in RESET_COLLECTIONS:
        counts[name] = (await db[name].delete_many({})).deleted_count
    await db.atc_positions.delete_many({})
    await db.users.update_one({"id": user["id"]}, {"$set": {"atc_seconds": 0}, "$unset": {"inactivity": ""}})
    await log_event("admin", "Remise à zéro du site", user, None,
                    f"{counts['comptes']} compte(s), {counts['flights']} vol(s) supprimé(s)")
    return counts


# ---------- mode anti-raid ----------

class SecurityIn(BaseModel):
    lockdown: bool


@router.get("/security")
async def get_security(user: dict = Depends(require("admin:users"))):
    s = await security_settings(fresh=True)
    return {**s, "new_account_hours": NEW_ACCOUNT_HOURS}


@router.put("/security")
async def put_security(body: SecurityIn, user: dict = Depends(require("admin:users"))):
    """Mode anti-raid: while on, nobody can create an account and accounts created in the last 24 h are read-only."""
    s = await set_lockdown(body.lockdown, user)
    await log_event("admin", "Mode anti-raid activé" if body.lockdown else "Mode anti-raid désactivé", user)
    return {**s, "new_account_hours": NEW_ACCOUNT_HOURS}
