import os
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field

from lib.auth import blocked_reason, clear_session, revoke_request_tokens, current_user, effective_role, set_session
from lib.db import db
from lib import discord_roles
from lib.discord_roles import NO_ACCESS_MSG, ROLE_ADMIN, ROLE_ATC, ROLE_ATC_LEAD, ROLE_PILOTE, access_of, has_any_access
from lib.engine import utcnow
from lib.events import log_event
from lib.handover import close_positions
from models.schemas import ModeIn, ProfileIn, UserOut
from routers.common import upsert_discord_user, user_out

router = APIRouter(prefix="/auth", tags=["auth"])

class TestLoginIn(BaseModel):
    discord_id: str = Field(pattern=r"^[0-9]{5,25}$")
    display_name: str = Field(min_length=2, max_length=40, pattern=r"^[^<>]+$")
    roles: list[Literal["pilote", "atc", "atc_lead", "pilot_lead", "admin"]] = []


def test_login_enabled() -> bool:
    """Local / automated tests only: never set ALLOW_TEST_LOGIN on the public site."""
    return os.environ.get("ALLOW_TEST_LOGIN", "false").lower() == "true"


@router.post("/test-login", response_model=UserOut)
async def test_login(body: TestLoginIn, response: Response, request: Request):
    """Simulates a Discord login with the given server roles (disabled unless ALLOW_TEST_LOGIN=true)."""
    host = (request.headers.get("host") or "").rsplit(":", 1)[0] if request is not None else ""
    if not test_login_enabled() or host not in ("localhost", "127.0.0.1", "[::1]", "testserver"):
        # local tests only: even if ALLOW_TEST_LOGIN were left on by mistake, the public site never accepts it
        raise HTTPException(404, "Not Found")
    role_ids = {"pilote": ROLE_PILOTE, "atc": ROLE_ATC, "atc_lead": ROLE_ATC_LEAD, "admin": ROLE_ADMIN,
                "pilot_lead": discord_roles.ROLE_PILOT_LEAD}
    user = await upsert_discord_user(body.discord_id, {"display_name": body.display_name,
                                                       "discord_username": body.display_name},
                                     [role_ids[r] for r in body.roles])
    if user.get("lockdown_refused"):
        raise HTTPException(403, "Mode anti-raid actif : aucun nouveau compte pour le moment.")
    reason = blocked_reason(user)
    if reason:
        raise HTTPException(403, reason)
    if not has_any_access(access_of(user)):
        raise HTTPException(403, NO_ACCESS_MSG)
    user["role"] = effective_role(user, None)
    set_session(response, user, request)
    return user_out(user)


@router.post("/mode", response_model=UserOut)
async def choose_mode(body: ModeIn, response: Response, request: Request, user: dict = Depends(current_user)):
    if effective_role(user, None) == "admin":
        raise HTTPException(400, "Le compte administrateur a déjà accès à tous les outils.")
    a = access_of(user)
    if body.mode == "atc" and not a["atc"]:
        raise HTTPException(403, "Le mode ATC nécessite le rôle ATC sur le serveur Discord SkyCommunity.")
    if body.mode == "pilote" and not a["pilote"]:
        raise HTTPException(403, "Le mode Pilote nécessite le rôle Pilote sur le serveur Discord SkyCommunity.")
    if body.mode in user.get("suspended", []):
        raise HTTPException(403, f"Votre accès {'ATC' if body.mode == 'atc' else 'Pilote'} est suspendu pour inactivité : "
                                 "demandez sa réactivation depuis la page de choix du mode.")
    user["role"] = effective_role(user, body.mode)
    set_session(response, user, request, body.mode)
    await log_event("mode", f"Connexion en mode {'ATC' if body.mode == 'atc' else 'Pilote'}", user)
    return user_out(user)


@router.post("/logout")
async def logout(response: Response, request: Request):
    try:
        u = await current_user(request)
        docs = await db.atc_positions.find({"user_id": u["id"]}, {"_id": 0}).to_list(10)
        await close_positions(docs, "fermeture", u)  # freed at once, handover to the position below
    except HTTPException:
        pass
    await revoke_request_tokens(request)
    clear_session(response, request)
    return {"ok": True}


@router.get("/me", response_model=UserOut)
async def me(user: dict = Depends(current_user)):
    return user_out(user)


@router.patch("/me", response_model=UserOut)
async def update_me(body: ProfileIn, user: dict = Depends(current_user)):
    upd = {"display_name": body.display_name.strip(), "simbrief_id": (body.simbrief_id or "").strip() or None}
    await db.users.update_one({"id": user["id"]}, {"$set": upd})
    return user_out({**user, **upd})


# ---------------------------------------------------------------------------
# Endpoint appelé par le bot Discord (/site-compte-atc)
# Authentifié par header X-Site-Secret == SITE_API_SECRET (ou BOT_API_SECRET)
# ---------------------------------------------------------------------------

class BotProvisionIn(BaseModel):
    email: str | None = None
    password: str | None = None
    display_name: str = Field(min_length=2, max_length=40)
    discord_user_id: str = Field(pattern=r"^[0-9]{5,25}$")
    atc_allowed: bool = True


@router.post("/bot-provision-atc")
async def bot_provision_atc(body: BotProvisionIn, request: Request):
    """
    Créé ou met à jour un compte lié à un Discord ID (appelé par le bot).
    Sur le nouveau site l'accès ATC vient des rôles Discord ; cet endpoint
    sert surtout de compatibilité et force un resync des rôles si possible.
    """
    import hmac
    secret = (os.environ.get("SITE_API_SECRET") or os.environ.get("BOT_API_SECRET") or "").strip()
    provided = request.headers.get("X-Site-Secret") or ""
    if len(secret) < 8 or not hmac.compare_digest(provided, secret):
        raise HTTPException(401, "Non autorisé")

    discord_id = body.discord_user_id.strip()
    display = body.display_name.strip()[:40]
    email = (body.email or f"atc.{discord_id}@skycommunity.fr").strip().lower()

    existing = await db.users.find_one({"discord_id": discord_id}, {"_id": 0})
    now = utcnow()

    if existing:
        # Met à jour le nom / email si fourni, incrémente token_version si mot de passe changé
        upd = {"display_name": display, "email": email, "last_login_at": now}
        if body.password:
            from passlib.context import CryptContext
            pwd_ctx = CryptContext(schemes=["bcrypt"], deprecated="auto")
            upd["password_hash"] = pwd_ctx.hash(body.password)
            upd["token_version"] = int(existing.get("token_version") or 0) + 1
        await db.users.update_one({"id": existing["id"]}, {"$set": upd})
        return {
            "id": existing["id"],
            "email": email,
            "created": False,
            "reset": bool(body.password),
            "message": "Compte existant mis à jour. L'accès ATC dépend des rôles Discord du membre.",
        }

    # Création minimale (accès réel viendra des rôles Discord au prochain login)
    import uuid
    user = {
        "id": str(uuid.uuid4()),
        "discord_id": discord_id,
        "email": email,
        "display_name": display,
        "simbrief_id": None,
        "disabled": False,
        "token_version": 0,
        "password_hash": None,
        "created_at": now,
        "last_login_at": now,
        "access": {"pilote": False, "atc": True, "atc_lead": False, "admin": False, "creator": False, "pilot_lead": False},
    }
    if body.password:
        from passlib.context import CryptContext
        pwd_ctx = CryptContext(schemes=["bcrypt"], deprecated="auto")
        user["password_hash"] = pwd_ctx.hash(body.password)

    await db.users.insert_one(dict(user))
    await log_event("compte_cree", "Création de compte (bot provision ATC)", {**user, "role": "aucun"})
    return {
        "id": user["id"],
        "email": email,
        "password": body.password,  # renvoyé une seule fois au bot pour le MP
        "created": True,
        "message": "Compte créé. Le membre doit se connecter via Discord ; l'accès ATC dépend de son rôle sur le serveur.",
    }