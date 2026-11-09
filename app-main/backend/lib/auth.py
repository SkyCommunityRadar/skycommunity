"""Session auth (httpOnly JWT cookie) + the single authorization decision function.

The principal is always re-read from Mongo on each request, so a role change or a
disabled account takes effect immediately (never trust baked token claims or the browser).
"""

import os
import uuid
from datetime import datetime, timedelta, timezone

import jwt
from fastapi import Depends, HTTPException, Request, Response

from lib.activity import all_status
from lib.db import db
from lib.discord_roles import access_of, has_any_access, resync_if_due
from lib.engine import utcnow
from lib.security import guard_write

COOKIE = "skyradar_session"
ROLES = ("pilote", "atc", "admin")
SESSION_DAYS = 7

PERMS: dict[str, set[str]] = {
    "aucun": set(),  # logged in but no mode chosen yet -> only /auth endpoints
    "pilote": {"flight:read", "flight:create", "flight:act", "flight:taxi", "flight:gates", "flight:note", "review:write", "planning:read"},
    "atc": {"flight:read", "flight:act", "flight:taxi", "flight:gates", "flight:note", "flight:control", "strip:read", "strip:write", "atc:position", "review:write", "history:read", "planning:read", "planning:write"},
    "admin": {"flight:read", "flight:create", "flight:act", "flight:taxi", "flight:gates", "flight:note",
              "flight:control", "strip:read", "strip:write", "atc:position", "review:write", "history:read", "admin:reviews", "admin:users", "admin:flights", "admin:airports", "admin:log", "planning:read", "planning:write"},
}
# For these permissions a pilot may only act on flights they own.
OWNER_SCOPED = {"flight:act", "flight:gates", "flight:note"}


def blocked_reason(user: dict) -> str | None:
    """French message when the account is blocked (permanently or until a date), else None."""
    if user.get("disabled"):
        return "Ce compte a été bloqué définitivement par un administrateur."
    until = user.get("banned_until")
    if until:
        until = until if until.tzinfo else until.replace(tzinfo=timezone.utc)
        if until > utcnow():
            return f"Ce compte est suspendu jusqu'au {until.strftime('%d/%m/%Y %H:%M')} UTC."
    return None


def effective_role(user: dict, mode: str | None) -> str:
    """The single source of truth for a request's role, derived from the Discord roles stored server-side
    (lib/discord_roles). Administrateur / Créateur -> "admin"; otherwise the chosen mode, if Discord allows it."""
    a = access_of(user)
    if a["admin"]:
        return "admin"
    suspended = user.get("suspended") or ()  # access suspended for inactivity (lib/activity), set by current_user
    if mode == "pilote" and a["pilote"] and "pilote" not in suspended:
        return "pilote"
    if mode == "atc" and a["atc"] and "atc" not in suspended:
        return "atc"
    return "aucun"


def is_creator(user: dict) -> bool:
    return access_of(user)["creator"]


def is_atc_lead(user: dict) -> bool:
    """Responsable ATC (planning validation) — administrators and the Créateur have the same power."""
    a = access_of(user)
    return a["atc_lead"] or a["admin"]


def _is_https(request: Request) -> bool:
    proto = request.headers.get("x-forwarded-proto", request.url.scheme).split(",")[0].strip()
    return proto == "https" or os.environ.get("COOKIE_SECURE", "false").lower() == "true"


def _cookie_header(request: Request, value: str, max_age: int) -> str:
    # httpOnly (unreadable by scripts) + SameSite=Lax (never sent by another website's forms or scripts: CSRF)
    # + Secure over HTTPS. The site is no longer embedded in a preview iframe, so the cross-site
    # SameSite=None mode it needed under Emergent is gone.
    attrs = f"{COOKIE}={value}; Max-Age={max_age}; Path=/; HttpOnly; SameSite=Lax"
    return attrs + "; Secure" if _is_https(request) else attrs


def set_session(response: Response, user: dict, request: Request, mode: str | None = None) -> None:
    # "tv" (token version) lets a password change / logout-everywhere revoke all older tokens.
    claims = {"sub": user["id"], "mode": mode, "tv": int(user.get("token_version", 0)),
              "jti": uuid.uuid4().hex, "exp": utcnow() + timedelta(days=SESSION_DAYS)}
    token = jwt.encode(claims, os.environ["JWT_SECRET"], "HS256")
    response.headers.append("set-cookie", _cookie_header(request, token, SESSION_DAYS * 86400))


def clear_session(response: Response, request: Request) -> None:
    response.headers.append("set-cookie", _cookie_header(request, '""', 0))


def _request_tokens(request: Request) -> list[str]:
    tokens = [request.cookies.get(COOKIE)]
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        tokens.append(auth[7:].strip())
    return [t for t in tokens if t]


async def revoke_request_tokens(request: Request) -> None:
    """Logout: the presented token(s) become unusable server-side immediately (not only the cookie)."""
    for token in _request_tokens(request):
        try:
            c = jwt.decode(token, os.environ["JWT_SECRET"], algorithms=["HS256"])
        except jwt.PyJWTError:
            continue
        key = c.get("jti") or token[-43:]
        await db.revoked_tokens.update_one({"jti": key}, {"$set": {"jti": key, "exp": datetime.fromtimestamp(c["exp"], timezone.utc)}}, upsert=True)


async def current_user(request: Request) -> dict:
    """Cookie first, then the Bearer fallback; a stale cookie must not mask a valid bearer token."""
    candidates = _request_tokens(request)
    if not candidates:
        raise HTTPException(401, "Authentification requise.")
    for token in candidates:
        try:
            claims = jwt.decode(token, os.environ["JWT_SECRET"], algorithms=["HS256"], options={"require": ["exp", "sub"]})
        except jwt.PyJWTError:
            continue
        if await db.revoked_tokens.find_one({"jti": claims.get("jti") or token[-43:]}, {"_id": 1}):
            continue
        user = await db.users.find_one({"id": claims["sub"]}, {"_id": 0})
        if not user or blocked_reason(user) or int(claims.get("tv", 0)) != int(user.get("token_version", 0)):
            continue
        user = await resync_if_due(user)  # Discord roles re-read every few minutes (bot)
        if int(claims.get("tv", 0)) != int(user.get("token_version", 0)) or not has_any_access(access_of(user)):
            continue
        user["mode"] = claims.get("mode")
        user["inactivity"] = await all_status(user)
        user["suspended"] = [k for k, st in user["inactivity"].items() if st["state"] == "suspendu"]
        user["role"] = effective_role(user, user["mode"])
        return user
    raise HTTPException(401, "Session invalide ou expirée.")


def authorize(user: dict, perm: str, flight: dict | None = None) -> None:
    """Deny-by-default. Raises 403 when the role lacks the permission or the pilot doesn't own the flight."""
    if user.get("role") == "aucun":
        raise HTTPException(403, "Choisissez d'abord votre mode (Pilote ou ATC).")
    if perm not in PERMS.get(user.get("role", ""), set()):
        raise HTTPException(403, "Action non autorisée pour votre rôle.")
    if flight is not None and user["role"] == "pilote" and perm in OWNER_SCOPED and flight["pilot_id"] != user["id"]:
        raise HTTPException(403, "Ce vol appartient à un autre pilote.")


def require(perm: str):
    async def dep(request: Request, user: dict = Depends(current_user)) -> dict:
        authorize(user, perm)
        await guard_write(request, user)  # mode anti-raid: brand-new accounts are read-only
        return user
    return dep
