"""ATIS letter A–Z: advances only when weather changes significantly."""

from __future__ import annotations

import logging
import time

import httpx

from lib.db import db
from lib.engine import utcnow

log = logging.getLogger(__name__)
_ATIS_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
_metar_cache: dict[str, tuple[float, dict]] = {}


def weather_sig(metar: dict) -> tuple:
    wind = metar.get("wind") or {}
    wind_deg = int(wind.get("degrees") or wind.get("dir") or 0)
    wind_speed = int(wind.get("speed_kts") or wind.get("speed") or 0)
    vis_raw = (metar.get("visibility") or {}).get("meters") if isinstance(metar.get("visibility"), dict) else metar.get("visib")
    try:
        vis_m = int(float(str(vis_raw or 9999).replace("+", "")))
    except Exception:
        vis_m = 9999
    qnh = 0
    bar = metar.get("barometer") or metar.get("altim_in_hg")
    if isinstance(bar, dict):
        qnh = round(float(bar.get("hpa") or 0))
    elif bar:
        try:
            qnh = round(float(bar) * 33.8639)
        except Exception:
            qnh = 0
    raw = str(metar.get("rawOb") or metar.get("raw_text") or "")
    vis_cat = 0 if vis_m < 1000 else 1 if vis_m < 5000 else 2 if vis_m < 10000 else 3
    return (
        (wind_deg // 10) * 10,
        (wind_speed // 5) * 5,
        qnh,
        vis_cat,
        any(x in raw for x in ("TS", "RA", "SN", "FG", "BR")),
    )


async def fetch_metar(icao: str) -> dict:
    """METAR **uniquement** via CheckWX (même source que le bot Discord)."""
    import os

    code = icao.upper().strip()[:4]
    now = time.monotonic()
    cached = _metar_cache.get(code)
    if cached and now - cached[0] < 120:
        return cached[1]

    empty = {
        "raw_text": "N/A",
        "wind": {"degrees": 0, "speed_kts": 0},
        "visibility": {"meters": 0},
        "temperature": {"celsius": None},
        "barometer": {"hpa": 0},
    }
    key = (os.getenv("CHECKWX_API_KEY") or "").strip()
    if not key:
        log.warning("CHECKWX_API_KEY manquant — météo ATIS indisponible pour %s", code)
        _metar_cache[code] = (now, empty)
        return empty

    url = f"https://api.checkwx.com/metar/{code}/decoded"
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            r = await client.get(url, headers={"X-API-Key": key, "User-Agent": "SkyCommunityRadar/1.0"})
            if r.status_code != 200:
                log.warning("CheckWX %s → HTTP %s", code, r.status_code)
                _metar_cache[code] = (now, empty)
                return empty
            data = (r.json() or {}).get("data") or []
            if not data:
                log.warning("CheckWX %s : réponse vide", code)
                _metar_cache[code] = (now, empty)
                return empty
            metar = data[0] if isinstance(data[0], dict) else empty
            _metar_cache[code] = (now, metar)
            return metar
    except Exception as e:
        log.warning("CheckWX METAR %s: %s", code, e)
        _metar_cache[code] = (now, empty)
        return empty


async def atis_letter(icao: str | None) -> str | None:
    if not icao:
        return None
    code = icao.upper().strip()[:4]
    if len(code) < 4:
        return None
    metar = await fetch_metar(code)
    sig = weather_sig(metar) if metar else None
    doc = await db.atis_letters.find_one({"icao": code}, {"_id": 0}) or {}
    letter_index = doc.get("letter_index")
    if letter_index is None:
        letter_index = sum(ord(c) for c in code) % 26
        await db.atis_letters.update_one(
            {"icao": code},
            {
                "$set": {
                    "icao": code,
                    "letter_index": letter_index,
                    "weather_sig": list(sig) if sig else None,
                    "updated_at": utcnow(),
                }
            },
            upsert=True,
        )
    elif sig is not None and doc.get("weather_sig") is not None and tuple(doc.get("weather_sig") or ()) != sig:
        letter_index = (int(letter_index) + 1) % 26
        await db.atis_letters.update_one(
            {"icao": code},
            {"$set": {"letter_index": letter_index, "weather_sig": list(sig), "updated_at": utcnow()}},
            upsert=True,
        )
    elif sig is not None and doc.get("weather_sig") is None:
        await db.atis_letters.update_one(
            {"icao": code},
            {"$set": {"weather_sig": list(sig), "updated_at": utcnow()}},
            upsert=True,
        )
    return _ATIS_LETTERS[int(letter_index) % 26]


def metar_summary(metar: dict) -> dict:
    """Short fields for the SkyRadar banner."""
    wind = metar.get("wind") or {}
    wind_deg = int(wind.get("degrees") or wind.get("dir") or 0)
    wind_speed = int(wind.get("speed_kts") or wind.get("speed") or 0)
    vis_raw = (metar.get("visibility") or {}).get("meters") if isinstance(metar.get("visibility"), dict) else metar.get("visib")
    try:
        vis_m = int(float(str(vis_raw or 0).replace("+", "")))
    except Exception:
        vis_m = 0
    qnh = 0
    bar = metar.get("barometer") or metar.get("altim_in_hg")
    if isinstance(bar, dict):
        qnh = round(float(bar.get("hpa") or 0))
    elif bar:
        try:
            qnh = round(float(bar) * 33.8639)
        except Exception:
            qnh = 0
    temp = (metar.get("temperature") or {}).get("celsius") if isinstance(metar.get("temperature"), dict) else metar.get("temp")
    try:
        temp_c = int(float(temp)) if temp is not None else None
    except Exception:
        temp_c = None
    raw = str(metar.get("rawOb") or metar.get("raw_text") or "")
    return {
        "wind_deg": wind_deg,
        "wind_speed_kt": wind_speed,
        "visibility_m": vis_m,
        "qnh": qnh,
        "temp_c": temp_c,
        "raw": raw[:120] if raw else None,
    }


async def build_atis(icao: str) -> dict | None:
    """Assemble ATIS : METAR live (météo) + AirportDB (terrain / pistes / fréquences)."""
    from lib import airportdb

    code = icao.upper().strip()[:4]
    if len(code) < 4:
        return None
    letter = await atis_letter(code)
    metar = await fetch_metar(code)
    summary = metar_summary(metar) if metar else {}

    airport = await airportdb.fetch_airport(code)
    terrain: dict = {}
    runways = {"departures": [], "arrivals": []}
    freqs: dict = {}
    if airport:
        terrain = airportdb.terrain_summary(airport)
        freqs = terrain.get("frequencies") or {}
        runways = airportdb.best_runways(
            airport,
            float(summary.get("wind_deg") or 0),
            float(summary.get("wind_speed_kt") or 0),
        )

    name = terrain.get("name") or code
    elev = terrain.get("elevation_ft")
    dep = ", ".join(runways.get("departures") or []) or "—"
    arr = ", ".join(runways.get("arrivals") or []) or "—"
    atis_freq = freqs.get("ATIS") or freqs.get("INFO")

    lines = [
        f"{code} Information {letter or '—'}",
        name + (f" · élév. {elev} ft" if elev is not None else ""),
    ]
    if atis_freq:
        lines.append(f"Fréquence ATIS {atis_freq} MHz")
    lines.append(f"Vent {summary.get('wind_deg', 0)}° {summary.get('wind_speed_kt', 0)} kt")
    lines.append(f"Visibilité {max(0, int((summary.get('visibility_m') or 0) / 1000))} km")
    lines.append(f"Piste départ: {dep}")
    lines.append(f"Piste arrivée: {arr}")
    if summary.get("temp_c") is not None:
        lines.append(f"Température {summary['temp_c']}°C")
    lines.append(f"QNH {summary.get('qnh') or '—'} hPa")
    for typ in ("GND", "TWR", "APP"):
        if freqs.get(typ):
            lines.append(f"{typ} {freqs[typ]} MHz")
    lines.append(f"Confirmez information {letter or '—'} au premier contact")
    text = chr(10).join(lines)

    return {
        "icao": code,
        "letter": letter,
        "text": text,
        "name": name,
        "elevation_ft": elev,
        "iata": terrain.get("iata"),
        "runways_dep": runways.get("departures") or [],
        "runways_arr": runways.get("arrivals") or [],
        "frequencies": freqs,
        "airport_db": bool(airport),
        **summary,
    }
