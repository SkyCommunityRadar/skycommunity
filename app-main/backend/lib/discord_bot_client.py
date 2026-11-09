"""Client HTTP vers l'API Flask du bot Discord (SkyBot).

Le site appelle le bot pour synchroniser les fréquences / salons Discord
lorsqu'un contrôleur ouvre ou ferme une position ATC sur le radar.

Variables d'environnement :
  DISCORD_BOT_API_URL   ex. http://127.0.0.1:8080
  DISCORD_BOT_API_SECRET  (même valeur que BOT_API_SECRET côté bot)
"""

from __future__ import annotations

import logging
import os
from typing import Any

import httpx

log = logging.getLogger(__name__)

BOT_API_URL = os.environ.get("DISCORD_BOT_API_URL", "").rstrip("/")
BOT_API_SECRET = os.environ.get("DISCORD_BOT_API_SECRET", "").strip() or os.environ.get("BOT_API_SECRET", "").strip()


def _enabled() -> bool:
    return bool(BOT_API_URL and BOT_API_SECRET)


def _headers() -> dict[str, str]:
    return {
        "Content-Type": "application/json",
        "X-Bot-Secret": BOT_API_SECRET,
        "Authorization": f"Bearer {BOT_API_SECRET}",
        "User-Agent": "SkyCommunityRadar/1.0",
    }


async def open_frequency(
    *,
    atc_discord_id: str | int,
    icao: str,
    position: str,
    frequency_mhz: str,
    languages: str = "FR",
) -> dict[str, Any] | None:
    """Demande au bot d'ouvrir une fréquence (crée les salons Discord).

    Retourne le dict frequency du bot (avec id) ou None si désactivé / erreur.
    """
    if not _enabled():
        return None
    payload = {
        "atc_user_id": str(atc_discord_id),
        "position": position.upper(),
        "location": icao.upper(),
        "icao": icao.upper(),
        "frequency_mhz": str(frequency_mhz),
        "languages": languages or "FR",
    }
    url = f"{BOT_API_URL}/api/frequencies/open"
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            r = await client.post(url, json=payload, headers=_headers())
            if r.status_code in (200, 201):
                body = r.json()
                freq = body.get("frequency") or body
                log.info("Bot: fréquence ouverte %s_%s → id=%s", icao, position, freq.get("id"))
                return freq
            log.warning("Bot open_frequency HTTP %s: %s", r.status_code, r.text[:300])
            return None
    except Exception as e:
        log.exception("Bot open_frequency failed: %s", e)
        return None


async def close_frequency(freq_id: int | str, by_discord_id: str | int | None = None) -> bool:
    """Demande au bot de fermer une fréquence (supprime les salons)."""
    if not _enabled() or not freq_id:
        return False
    payload = {}
    if by_discord_id:
        payload["by_user_id"] = str(by_discord_id)
    url = f"{BOT_API_URL}/api/frequencies/{freq_id}/close"
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            r = await client.post(url, json=payload, headers=_headers())
            if r.status_code in (200, 201):
                log.info("Bot: fréquence %s fermée", freq_id)
                return True
            log.warning("Bot close_frequency HTTP %s: %s", r.status_code, r.text[:300])
            return False
    except Exception as e:
        log.exception("Bot close_frequency failed: %s", e)
        return False


async def list_frequencies(guild_id: int | None = None) -> list[dict]:
    if not _enabled():
        return []
    params = {}
    if guild_id:
        params["guild_id"] = guild_id
    url = f"{BOT_API_URL}/api/frequencies"
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.get(url, params=params, headers=_headers())
            if r.status_code == 200:
                return r.json().get("frequencies") or []
            return []
    except Exception as e:
        log.warning("Bot list_frequencies: %s", e)
        return []