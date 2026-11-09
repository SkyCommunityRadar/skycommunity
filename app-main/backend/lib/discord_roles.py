"""Discord decides who may use the site and with which rights.

Access flags are computed ONLY here, on the server, from the member's roles on the SkyCommunity Discord
server (read with the member's OAuth token at login, then re-read with the bot token every few minutes).
Nothing sent by the browser is ever trusted.

Mapping:  Pilote -> pilote · ATC -> atc · Responsable ATC -> atc + atc_lead (planning, suivi des contrôleurs)
          Responsable Pilotes -> pilote + pilot_lead (suivi des pilotes)
          Administrateur -> admin · KRD67 (fixed Discord user id) -> creator (+ every right).
"""

import logging
import os
from datetime import timedelta

import httpx

from lib.db import db
from lib.engine import aware, utcnow

log = logging.getLogger(__name__)
API = "https://discord.com/api/v10"

# The one and only Créateur: KRD67, identified by the immutable Discord account id (never by a role or a name).
CREATOR_DISCORD_ID = "1433916473629212865"

# Public ids (not secrets) — overridable per environment.
GUILD_ID = os.environ.get("DISCORD_GUILD_ID", "1476243664098558114")
ROLE_PILOTE = os.environ.get("DISCORD_ROLE_PILOTE", "1476255496410235091")
ROLE_ATC = os.environ.get("DISCORD_ROLE_ATC", "1476255548885307432")
ROLE_ATC_LEAD = os.environ.get("DISCORD_ROLE_ATC_LEAD", "1541513803500355594")
ROLE_PILOT_LEAD = os.environ.get("DISCORD_ROLE_PILOT_LEAD", "1566939537320575156")
ROLE_ADMIN = os.environ.get("DISCORD_ROLE_ADMIN", "1476255705500487871")

SYNC_EVERY = timedelta(minutes=5)
NO_ACCESS_MSG = ("Accès refusé : il faut le rôle Pilote ou ATC sur le serveur Discord SkyCommunity "
                 "pour utiliser SkyCommunity Radar.")

EMPTY = {"pilote": False, "atc": False, "atc_lead": False, "pilot_lead": False, "admin": False, "creator": False}


def compute_access(discord_id: str | None, roles: list[str] | None) -> dict:
    roles = set(roles or [])
    creator = bool(discord_id) and str(discord_id) == CREATOR_DISCORD_ID
    admin = creator or ROLE_ADMIN in roles
    lead = ROLE_ATC_LEAD in roles
    plead = ROLE_PILOT_LEAD in roles
    return {"pilote": ROLE_PILOTE in roles or plead, "atc": ROLE_ATC in roles or lead, "atc_lead": lead,
            "pilot_lead": plead, "admin": admin, "creator": creator}


def access_of(user: dict) -> dict:
    a = user.get("access")
    return {**EMPTY, **a} if isinstance(a, dict) else dict(EMPTY)


def has_any_access(access: dict) -> bool:
    return access["pilote"] or access["atc"] or access["admin"]


def access_fields(discord_id: str | None, roles: list[str] | None) -> dict:
    """Fields to $set on the user document after reading the Discord roles."""
    a = compute_access(discord_id, roles)
    # atc_allowed is kept as a derived value for the older code paths (profiles, leaderboard)
    return {"discord_roles": sorted(set(roles or [])), "access": a, "atc_allowed": a["atc"] or a["admin"],
            "roles_synced_at": utcnow()}


async def roles_with_user_token(client: httpx.AsyncClient, access_token: str) -> list[str] | None:
    """Member roles read with the member's own OAuth token (scope guilds.members.read). None = not a member."""
    r = await client.get(f"{API}/users/@me/guilds/{GUILD_ID}/member", headers={"Authorization": f"Bearer {access_token}"})
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return [str(x) for x in r.json().get("roles", [])]


async def roles_with_bot(discord_id: str) -> list[str] | None | bool:
    """Roles read by the bot. None = not a member any more; False = could not check (no token / Discord down)."""
    token = os.environ.get("DISCORD_BOT_TOKEN", "")
    if not token:
        return False
    try:
        async with httpx.AsyncClient(timeout=5) as c:
            r = await c.get(f"{API}/guilds/{GUILD_ID}/members/{discord_id}", headers={"Authorization": f"Bot {token}"})
        if r.status_code == 404:
            return None
        if r.is_error:
            log.warning("Discord role sync %s: HTTP %s", discord_id, r.status_code)
            return False
        return [str(x) for x in r.json().get("roles", [])]
    except httpx.HTTPError as exc:
        log.warning("Discord role sync %s: %s", discord_id, exc)
        return False


async def resync_if_due(user: dict) -> dict:
    """Re-reads the roles through the bot every SYNC_EVERY. A lost right takes effect at once; a Discord outage
    keeps the last known roles (the member is not locked out because Discord is unreachable)."""
    did = user.get("discord_id")
    last = aware(user.get("roles_synced_at"))
    if not did or (last and utcnow() - last < SYNC_EVERY):
        return user
    roles = await roles_with_bot(did)
    if roles is False:
        await db.users.update_one({"id": user["id"]}, {"$set": {"roles_synced_at": utcnow()}})
        return user
    upd = access_fields(did, roles or [])
    before = access_of(user)
    lost = any(before[k] and not upd["access"][k] for k in before)
    q: dict = {"$set": upd}
    if lost:  # every open session is cut; the member logs in again with the rights they still have
        q["$inc"] = {"token_version": 1}
    await db.users.update_one({"id": user["id"]}, q)
    user = {**user, **upd}
    if lost:
        user["token_version"] = int(user.get("token_version", 0)) + 1
    return user
