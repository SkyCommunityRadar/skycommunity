"""Client AirportDB.io — données terrain stables (pistes, fréquences, nom, élévation).

Variable d'environnement : AIRPORT_DB_TOKEN
Doc : https://airportdb.io/api/v1/airport/{ICAO}?apiToken=...
"""

from __future__ import annotations

import logging
import os
import time
from typing import Any

import httpx

log = logging.getLogger(__name__)

AIRPORT_DB_TOKEN = (os.getenv("AIRPORT_DB_TOKEN") or "").strip()
_BASE = "https://airportdb.io/api/v1/airport"
_cache: dict[str, tuple[float, dict[str, Any]]] = {}
_TTL = 6 * 3600  # 6 h — données terrain stables


def configured() -> bool:
    return bool(AIRPORT_DB_TOKEN)


async def fetch_airport(icao: str) -> dict[str, Any] | None:
    code = (icao or "").upper().strip()[:4]
    if len(code) < 4:
        return None
    now = time.monotonic()
    hit = _cache.get(code)
    if hit and now - hit[0] < _TTL:
        return hit[1]
    if not AIRPORT_DB_TOKEN:
        log.debug("AIRPORT_DB_TOKEN absent — AirportDB ignoré pour %s", code)
        return None
    url = f"{_BASE}/{code}"
    try:
        async with httpx.AsyncClient(timeout=12.0) as client:
            r = await client.get(url, params={"apiToken": AIRPORT_DB_TOKEN})
            if r.status_code != 200:
                log.warning("AirportDB %s → HTTP %s", code, r.status_code)
                return None
            data = r.json()
            if not isinstance(data, dict) or not data.get("ident"):
                return None
            _cache[code] = (now, data)
            return data
    except Exception as e:
        log.warning("AirportDB %s: %s", code, e)
        return None


def runway_ends(airport: dict[str, Any]) -> list[dict[str, Any]]:
    """Liste des extrémités de piste utilisables (ident + heading)."""
    out: list[dict[str, Any]] = []
    for rw in airport.get("runways") or []:
        if str(rw.get("closed") or "0") in ("1", "true", "True"):
            continue
        for side, hdg_key, ident_key in (
            ("le", "le_heading_degT", "le_ident"),
            ("he", "he_heading_degT", "he_ident"),
        ):
            ident = (rw.get(ident_key) or "").strip()
            if not ident:
                continue
            try:
                hdg = float(rw.get(hdg_key) or 0)
            except (TypeError, ValueError):
                hdg = 0.0
            try:
                length = int(float(rw.get("length_ft") or 0))
            except (TypeError, ValueError):
                length = 0
            out.append(
                {
                    "ident": ident.upper(),
                    "heading": hdg,
                    "length_ft": length,
                    "surface": rw.get("surface"),
                }
            )
    return out


def best_runways(airport: dict[str, Any], wind_deg: float, wind_kt: float = 0) -> dict[str, list[str]]:
    """Pistes au vent (max composante face au vent). Vent calme → toutes les pistes longues."""
    ends = runway_ends(airport)
    if not ends:
        return {"departures": [], "arrivals": []}
    if wind_kt < 3:
        # vent faible : pistes les plus longues (une par axe)
        by_len = sorted(ends, key=lambda e: e["length_ft"], reverse=True)
        seen = set()
        picks = []
        for e in by_len:
            axis = e["ident"].rstrip("LCR")
            if axis in seen:
                continue
            seen.add(axis)
            picks.append(e["ident"])
            if len(picks) >= 2:
                break
        return {"departures": picks, "arrivals": picks}

    def headwind(e: dict) -> float:
        # composante face au vent : cos(wind - runway_hdg)
        import math
        diff = math.radians((wind_deg - e["heading"] + 180) % 360 - 180)
        return wind_kt * math.cos(diff)

    ranked = sorted(ends, key=headwind, reverse=True)
    best = headwind(ranked[0])
    # garder celles proches du max (même sens global)
    chosen = [e["ident"] for e in ranked if headwind(e) >= best - 2 and headwind(e) > 0][:3]
    if not chosen:
        chosen = [ranked[0]["ident"]]
    return {"departures": chosen, "arrivals": chosen}


def frequencies(airport: dict[str, Any]) -> dict[str, str]:
    """type (ATIS/TWR/GND/APP/…) → fréquence MHz."""
    out: dict[str, str] = {}
    for f in airport.get("freqs") or []:
        typ = (f.get("type") or "").strip().upper()
        mhz = f.get("frequency_mhz")
        if not typ or mhz is None:
            continue
        try:
            val = f"{float(mhz):g}"
        except (TypeError, ValueError):
            val = str(mhz)
        # première occurrence par type
        if typ not in out:
            out[typ] = val
    return out


def terrain_summary(airport: dict[str, Any]) -> dict[str, Any]:
    return {
        "name": airport.get("name"),
        "iata": airport.get("iata_code"),
        "municipality": airport.get("municipality"),
        "country": airport.get("iso_country"),
        "elevation_ft": _to_int(airport.get("elevation_ft")),
        "lat": airport.get("latitude_deg"),
        "lon": airport.get("longitude_deg"),
        "frequencies": frequencies(airport),
        "runway_count": len(airport.get("runways") or []),
    }


def _to_int(v) -> int | None:
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return None
