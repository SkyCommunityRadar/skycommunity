"""Discord OAuth2 (authorization-code flow, scopes `identify guilds.members.read`).

Everyone signs in with Discord only; the account is keyed by the immutable Discord id (unique index),
so one Discord account can never create two SkyCommunity accounts. The member's roles on the SkyCommunity
Discord server decide the access (lib/discord_roles): no Pilote / ATC / Administrateur role -> no access."""

import os
import secrets
from datetime import timedelta
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import RedirectResponse

from lib.auth import blocked_reason, effective_role, set_session
from lib.db import db
from lib.discord_roles import access_of, has_any_access, roles_with_user_token
from lib.engine import utcnow
from routers.common import upsert_discord_user

router = APIRouter(prefix="/auth/discord", tags=["auth"])
API = "https://discord.com/api/v10"
STATE_COOKIE = "sc_discord_state"


def _cfg() -> tuple[str, str]:
    cid, sec = os.environ.get("DISCORD_CLIENT_ID", ""), os.environ.get("DISCORD_CLIENT_SECRET", "")
    if not cid or not sec:
        raise HTTPException(503, "La connexion Discord n'est pas encore configurée (identifiants manquants).")
    return cid, sec


def _base(request: Request) -> str:
    """Public base URL: APP_URL when set, otherwise the host the request reached (preview / production)."""
    app_url = os.environ.get("APP_URL", "").rstrip("/")
    if app_url:
        return app_url
    proto = request.headers.get("x-forwarded-proto", request.url.scheme).split(",")[0].strip()
    host = (request.headers.get("x-forwarded-host") or request.headers.get("host") or "").split(",")[0].strip()
    return f"{proto}://{host}"


def _redirect_uri(request: Request) -> str:
    return f"{_base(request)}/api/auth/discord/callback"


def _fail(request: Request, code: str) -> RedirectResponse:
    return RedirectResponse(f"{_base(request)}/login?discord_error={code}", status_code=302)


@router.get("/status")
async def status(request: Request):
    """Lets the login page know whether Discord is configured, and which redirect URI to register."""
    return {"enabled": bool(os.environ.get("DISCORD_CLIENT_ID") and os.environ.get("DISCORD_CLIENT_SECRET")),
            "redirect_uri": _redirect_uri(request)}


@router.get("/login")
async def discord_login(request: Request):
    cid, _ = _cfg()
    state = secrets.token_urlsafe(32)
    await db.oauth_states.insert_one({"state": state, "expires_at": utcnow() + timedelta(minutes=10)})
    q = urlencode({"response_type": "code", "client_id": cid, "scope": "identify guilds.members.read", "state": state,
                   "redirect_uri": _redirect_uri(request), "prompt": "none"})
    resp = RedirectResponse(f"https://discord.com/oauth2/authorize?{q}", status_code=302)
    resp.set_cookie(STATE_COOKIE, state, max_age=600, httponly=True, secure=_base(request).startswith("https"),
                    samesite="lax", path="/api/auth/discord")
    return resp


@router.get("/callback")
async def discord_callback(request: Request, code: str | None = None, state: str | None = None,
                           error: str | None = None):
    if error:
        return _fail(request, "refus")
    expected = request.cookies.get(STATE_COOKIE)
    if not state or not expected or not secrets.compare_digest(state, expected):
        return _fail(request, "etat")
    # one-time state: prevents replay of a callback URL
    if (await db.oauth_states.delete_one({"state": state, "expires_at": {"$gt": utcnow()}})).deleted_count != 1:
        return _fail(request, "expire")
    if not code:
        return _fail(request, "code")
    cid, sec = _cfg()
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            tok = await client.post(f"{API}/oauth2/token", auth=(cid, sec), data={
                "grant_type": "authorization_code", "code": code, "redirect_uri": _redirect_uri(request)})
            if tok.is_error or not tok.json().get("access_token"):
                return _fail(request, "jeton")
            me = await client.get(f"{API}/users/@me", headers={"Authorization": f"Bearer {tok.json()['access_token']}"})
            if me.is_error:
                return _fail(request, "profil")
            d = me.json()
            roles = await roles_with_user_token(client, tok.json()["access_token"])
    except httpx.HTTPError:
        return _fail(request, "reseau")

    discord_id = str(d["id"])
    name = (d.get("global_name") or d.get("username") or "Membre")[:40]
    user = await upsert_discord_user(discord_id, {"discord_username": d.get("username"), "avatar": d.get("avatar"),
                                                  "display_name": name}, roles or [])
    if user.get("lockdown_refused"):
        return _fail(request, "anti_raid")
    if not has_any_access(access_of(user)):
        return _fail(request, "hors_serveur" if roles is None else "sans_role")
    reason = blocked_reason(user)
    if reason:
        return _fail(request, "bloque")
    user["role"] = effective_role(user, None)
    resp = RedirectResponse(f"{_base(request)}/auth/discord", status_code=302)
    set_session(resp, user, request)  # httpOnly cookie only: the session never appears in a URL or in scripts
    resp.delete_cookie(STATE_COOKIE, path="/api/auth/discord")
    return resp
