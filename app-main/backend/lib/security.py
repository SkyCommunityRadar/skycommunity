"""Protections against abuse: request rate limits (spam / flood / brute force), maximum request size, and the
« mode anti-raid » an administrator can switch on when the Discord server is being raided.

Rate limits are kept in memory: the site runs as ONE instance (see docs/DEPLOIEMENT.md), so this is exact.
"""
import ipaddress
import os
import time
from collections import deque
from datetime import timedelta

from fastapi import HTTPException, Request

from lib.db import db
from lib.engine import aware, utcnow

MAX_BODY_BYTES = 256 * 1024  # largest legitimate request (taxi route, strip, review…) is a few kB

# (name, method filter, path test, max requests, window in seconds). Every matching rule applies, per client IP.
RULES: list[tuple[str, str | None, callable, int, int]] = [
    ("global", None, lambda p: True, 900, 60),                       # ~15 req/s: radar polling of several tabs
    ("writes", "write", lambda p: True, 90, 60),                      # any change (actions, notes, strips…)
    ("login", None, lambda p: p.startswith("/api/auth/discord/") or p == "/api/auth/test-login", 20, 60),
    ("simbrief", "write", lambda p: p == "/api/simbrief/fetch", 10, 60),
    ("ground", "GET", lambda p: p.startswith("/api/airports/") and p.endswith("/ground"), 40, 60),
    ("reviews", "write", lambda p: p == "/api/reviews", 15, 3600),
    ("notes", "write", lambda p: p.startswith("/api/flights/") and p.endswith("/notes"), 20, 600),
    ("planning", "write", lambda p: p.startswith("/api/planning"), 30, 600),
]

_hits: dict[tuple[str, str], deque] = {}
_last_sweep = 0.0


_PRIVATE_NETS = [ipaddress.ip_network(n) for n in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7")]


def _private(addr: str) -> bool:
    try:
        ip = ipaddress.ip_address(addr)
    except ValueError:
        return False
    # loopback or a real private network (RFC 1918 / IPv6 ULA) — where the host's reverse proxy lives
    return ip.is_loopback or any(ip in n for n in _PRIVATE_NETS)


def is_local_ip(addr: str) -> bool:
    try:
        ip = ipaddress.ip_address(addr)
    except ValueError:
        return False
    return ip.is_loopback or bool(getattr(ip, "ipv4_mapped", None) and ip.ipv4_mapped.is_loopback)


def client_ip(request: Request) -> str:
    """Real client address. When the request comes through the host's reverse proxy (the direct peer is a local /
    private address, or TRUST_PROXY=true), the proxy appends the client to X-Forwarded-For: the right-most entry is
    the one it wrote, so a visitor cannot forge it. Without this, every visitor would share the proxy's address."""
    peer = request.client.host if request.client else "inconnu"
    if _private(peer) or os.environ.get("TRUST_PROXY", "false").lower() == "true":
        xff = request.headers.get("x-forwarded-for", "")
        if xff.strip():
            return xff.split(",")[-1].strip()
        if request.headers.get("x-real-ip"):
            return request.headers["x-real-ip"].strip()
    return peer


def _sweep(now: float) -> None:
    global _last_sweep
    if now - _last_sweep < 60:
        return
    _last_sweep = now
    longest = max(r[4] for r in RULES)
    for k in [k for k, q in _hits.items() if not q or now - q[-1] > longest]:
        del _hits[k]


def check_rate(request: Request) -> tuple[str, int] | None:
    """(rule name, seconds to wait) when the client exceeded a limit, else None (and the hit is recorded)."""
    path, method = request.url.path, request.method
    if not path.startswith("/api/") or method == "OPTIONS":
        return None
    is_write = method in ("POST", "PUT", "PATCH", "DELETE")
    ip, now = client_ip(request), time.monotonic()
    if is_local_ip(ip) and os.environ.get("ALLOW_TEST_LOGIN", "false").lower() == "true":
        return None  # local automated tests only (they fire hundreds of requests from this machine)
    _sweep(now)
    matching = [r for r in RULES if (r[1] is None or (r[1] == "write" and is_write) or r[1] == method) and r[2](path)]
    for name, _, _, limit, window in matching:
        q = _hits.setdefault((name, ip), deque())
        while q and now - q[0] > window:
            q.popleft()
        if len(q) >= limit:
            return name, max(1, int(window - (now - q[0])) + 1)
    for name, *_ in matching:
        _hits[(name, ip)].append(now)
    return None


def reset_rate_limits() -> None:
    _hits.clear()


# ---------- mode anti-raid ----------

NEW_ACCOUNT_HOURS = 24
_cache: dict = {"at": 0.0, "value": None}


async def security_settings(fresh: bool = False) -> dict:
    """{"lockdown": bool, "by": name, "at": datetime} — cached 5 s (read on every write request)."""
    if fresh or time.monotonic() - _cache["at"] > 5 or _cache["value"] is None:
        doc = await db.settings.find_one({"_id": "security"}) or {}
        _cache["value"] = {"lockdown": bool(doc.get("lockdown")), "by": doc.get("by"), "at": aware(doc.get("at"))}
        _cache["at"] = time.monotonic()
    return _cache["value"]


async def set_lockdown(on: bool, user: dict) -> dict:
    await db.settings.update_one({"_id": "security"}, {"$set": {"lockdown": on, "by": user["display_name"], "at": utcnow()}},
                                 upsert=True)
    return await security_settings(fresh=True)


def is_new_account(user: dict) -> bool:
    created = aware(user.get("created_at"))
    return bool(created) and utcnow() - created < timedelta(hours=NEW_ACCOUNT_HOURS)


async def guard_write(request: Request, user: dict) -> None:
    """During a raid, accounts created less than 24 h ago can only read (administrators are never limited)."""
    if request.method in ("GET", "HEAD", "OPTIONS") or user.get("role") == "admin":
        return
    if request.url.path.startswith("/api/auth/"):
        return  # choosing a mode / logging out stays possible
    if (await security_settings())["lockdown"] and is_new_account(user):
        raise HTTPException(403, "Mode anti-raid actif : les comptes créés il y a moins de 24 h sont en lecture seule "
                                 "pour le moment.")
