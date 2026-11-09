"""SimBrief official API (public fetcher, no key, never a password) + OFP parser.

Docs: https://developers.navigraph.com/docs/simbrief/fetching-ofp-data
"""

import os
from datetime import datetime, timezone

import json
import re
from pathlib import Path

import httpx

from lib.runways import apply_runway_geometry

from lib.engine import build_profile

FETCH_URL = "https://www.simbrief.com/api/xml.fetcher.php"


class SimbriefError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


TEST_FIXTURE = Path(__file__).resolve().parent.parent / "tests" / "fixture_simbrief_v2.json"


async def fetch_ofp(pilot_id: str) -> dict:
    # Automated tests only (ALLOW_TEST_LOGIN=true, never on the public site): Pilot ID "1" returns the saved
    # plan ACA317 CYUL->CYYC so the tests do not depend on whatever SimBrief user 1 is flying today.
    if pilot_id.strip() == "1" and os.environ.get("ALLOW_TEST_LOGIN", "false").lower() == "true" and TEST_FIXTURE.exists():
        return json.loads(TEST_FIXTURE.read_text())
    params = {"userid": pilot_id.strip(), "json": "v2", "client": os.environ.get("SIMBRIEF_CLIENT", "SkyCommunityRadar")}
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            r = await client.get(FETCH_URL, params=params)
    except httpx.HTTPError:
        raise SimbriefError(503, "Service SimBrief temporairement indisponible. Réessayez dans quelques instants.")
    try:
        data = r.json()
    except ValueError:
        raise SimbriefError(502, "Réponse SimBrief illisible (service indisponible ?).")
    status = str((data.get("fetch") or {}).get("status", ""))
    if r.status_code >= 500:
        raise SimbriefError(503, "Service SimBrief temporairement indisponible.")
    if status != "Success":
        if "no flight plan" in status.lower() or "not found" in status.lower():
            raise SimbriefError(404, "Aucun plan de vol enregistré pour ce Pilot ID. Générez d'abord un plan sur simbrief.com.")
        if "unknown" in status.lower() or "user" in status.lower():
            raise SimbriefError(404, "Pilot ID SimBrief inconnu. Vérifiez le numéro dans votre compte SimBrief (Account Settings).")
        raise SimbriefError(502, f"SimBrief a renvoyé une erreur : {status or 'inconnue'}")
    return data


def _f(v) -> float | None:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _i(v) -> int | None:
    x = _f(v)
    return int(x) if x is not None else None


def _dur(v) -> float | None:
    """SimBrief durations: seconds ("15863") in XML/JSON v1, "HH:MM:SS" in JSON v2."""
    if isinstance(v, str) and ":" in v:
        try:
            parts = [float(x) for x in v.split(":")]
        except ValueError:
            return None
        while len(parts) < 3:
            parts.insert(0, 0.0)
        return parts[0] * 3600 + parts[1] * 60 + parts[2]
    return _f(v)


def _epoch(v) -> str | None:
    """Timestamps: unix epoch (v1) or ISO 8601 "2026-10-26T12:30:00Z" (v2)."""
    if isinstance(v, str) and "T" in v:
        try:
            return datetime.fromisoformat(v.replace("Z", "+00:00")).isoformat()
        except ValueError:
            return None
    x = _i(v)
    return datetime.fromtimestamp(x, timezone.utc).isoformat() if x else None


PDF_HOST = "https://www.simbrief.com/ofp/flightplans/"


def pdf_url(data: dict) -> str | None:
    """Link of the OFP PDF published by SimBrief for this plan (only a simbrief.com flightplans URL is accepted)."""
    files = data.get("files") or {}
    pdf = files.get("pdf") or {}
    link = str(pdf.get("link") or "").strip() if isinstance(pdf, dict) else ""
    directory = str(files.get("directory") or PDF_HOST).strip()
    if not link or "/" in link or ".." in link or not link.lower().endswith(".pdf"):
        return None
    url = directory.rstrip("/") + "/" + link
    return url if url.startswith(PDF_HOST) else None


PROC_RE = re.compile(r"^[A-Z]{2,6}\d[A-Z]?$")  # e.g. KESKA5, BIRKO6, OGBE1F


def sid_star(general: dict) -> tuple[str | None, str | None]:
    """SID / STAR of the plan: SimBrief's own fields first, else the first / last element of the route string
    when it is a procedure name. None = the plan has no SID (or no STAR) — shown as « Aucune »."""
    sid = str(general.get("sid_ident") or "").strip().upper() or None
    star = str(general.get("star_ident") or "").strip().upper() or None
    tokens = [t for t in str(general.get("route") or "").upper().split() if t]
    if not sid and tokens and PROC_RE.match(tokens[0]):
        sid = tokens[0]
    if not star and tokens and PROC_RE.match(tokens[-1]):
        star = tokens[-1]
    return sid, star


def _repair_times(points: list[dict], times: list[float | None]) -> bool:
    """SimBrief gives the time at every fix (time_total): that is what the radar follows, so climb, cruise and
    descent take the real time of the plan. A few fixes may have no time, or the same second as the previous one
    (close SID points): those are filled in proportionally to the distance instead of dropping ALL the timings
    (which used to fly the whole route at the cruise speed). False only when there is nearly nothing to rely on."""
    known = [i for i, t in enumerate(times) if t is not None]
    if len(known) < max(2, len(times) // 2) or times[-1] is None or times[0] is None:
        return False
    for i in range(1, len(times) - 1):
        if times[i] is not None and not (times[i - 1] is None or times[i] > times[i - 1]):
            times[i] = None  # same second as the previous fix (or going back): recomputed below
    known = [i for i, t in enumerate(times) if t is not None]
    for a, b in zip(known, known[1:]):
        if b - a > 1:
            d0, d1 = points[a]["cum_nm"], points[b]["cum_nm"]
            for i in range(a + 1, b):
                k = (points[i]["cum_nm"] - d0) / (d1 - d0) if d1 > d0 else (i - a) / (b - a)
                times[i] = times[a] + (times[b] - times[a]) * k
    for i in range(1, len(times)):  # strictly increasing (the engine interpolates on them)
        if times[i] <= times[i - 1]:
            times[i] = times[i - 1] + 1.0
    return True


def parse_ofp(data: dict) -> dict:
    """Builds a route from the STRUCTURED navlog (never from the route string)."""
    general = data.get("general") or {}
    origin = data.get("origin") or {}
    dest = data.get("destination") or {}
    aircraft = data.get("aircraft") or {}
    atc = data.get("atc") or {}
    times = data.get("times") or {}
    navlog = data.get("navlog") or []
    fixes = navlog.get("fix") or [] if isinstance(navlog, dict) else navlog  # v1: {"fix": [...]}, v2: [...]
    if isinstance(fixes, dict):
        fixes = [fixes]
    alternate = data.get("alternate")
    if isinstance(alternate, list):
        alternate = alternate[0] if alternate else None
    warnings: list[str] = []

    dep, arr = str(origin.get("icao_code") or "").upper(), str(dest.get("icao_code") or "").upper()
    o_lat, o_lon, d_lat, d_lon = (_f(origin.get("pos_lat")), _f(origin.get("pos_long")),
                                  _f(dest.get("pos_lat")), _f(dest.get("pos_long")))
    if not dep or not arr:
        raise ValueError("Plan incomplet : aéroport de départ ou de destination manquant.")
    if None in (o_lat, o_lon, d_lat, d_lon):
        raise ValueError("Échec de conversion des coordonnées des aéroports.")

    points = [dict(ident=dep, name=origin.get("name"), lat=o_lat, lon=o_lon,
                   alt_ft=_i(origin.get("elevation")), ias_kt=None, kind="apt")]
    times_s: list[float | None] = [0.0]
    bad = 0
    for fx in fixes:
        ident = str(fx.get("ident") or "").upper()
        lat, lon = _f(fx.get("pos_lat")), _f(fx.get("pos_long"))
        if lat is None or lon is None or not (-90 <= lat <= 90 and -180 <= lon <= 180):
            bad += 1
            continue
        if ident in (dep, arr) and fx.get("type") == "apt":
            continue
        if points and abs(points[-1]["lat"] - lat) < 1e-6 and abs(points[-1]["lon"] - lon) < 1e-6:
            continue
        points.append(dict(ident=ident or "WPT", name=fx.get("name"), lat=lat, lon=lon,
                           alt_ft=_i(fx.get("altitude_feet")), ias_kt=_i(fx.get("ind_airspeed")),
                           kind=fx.get("type"), via=(str(fx.get("via_airway") or "").upper() or None),
                           sid_star=str(fx.get("is_sid_star") or "0") == "1"))
        times_s.append(_dur(fx.get("time_total")))
    points.append(dict(ident=arr, name=dest.get("name"), lat=d_lat, lon=d_lon,
                       alt_ft=_i(dest.get("elevation")), ias_kt=None, kind="apt"))
    times_s.append(_dur(times.get("est_time_enroute")))
    if bad:
        warnings.append(f"{bad} point(s) ignoré(s) : coordonnées invalides.")
    if len(points) < 3:
        warnings.append("Le navlog ne contient pas de point intermédiaire exploitable : route directe départ → destination.")

    cruise_tas = _f(general.get("cruise_tas")) or 420.0
    build_profile(points, None, cruise_tas)
    times_ok = _repair_times(points, times_s)
    if times_ok:
        for p, t in zip(points, times_s):
            p["cum_s"] = float(t)
    else:
        warnings.append(f"Durées SimBrief absentes : vitesse simulée de {int(cruise_tas)} kt utilisée.")
    # take-off / landing on the real runway axis (planned runway from SimBrief, else the best aligned one)
    dep_rwy_plan = str(origin.get("plan_rwy") or "").strip().upper() or None
    arr_rwy_plan = str(dest.get("plan_rwy") or "").strip().upper() or None
    warnings += apply_runway_geometry(points, dep, arr, dep_rwy_plan, arr_rwy_plan)
    dep_rwy = (points[0].get("rwy") or {}).get("ident")
    arr_rwy = (points[-1].get("rwy") or {}).get("ident")

    callsign = str(atc.get("callsign") or f"{general.get('icao_airline') or ''}{general.get('flight_number') or ''}").upper()
    if not callsign:
        raise ValueError("Plan incomplet : indicatif absent.")
    return dict(
        callsign=callsign[:8],
        aircraft_type=str(aircraft.get("icaocode") or aircraft.get("icao_code") or "ZZZZ").upper()[:4],
        departure=dep, departure_name=origin.get("name"), arrival=arr, arrival_name=dest.get("name"),
        route_string=general.get("route"), cruise_alt_ft=_i(general.get("initial_altitude")),
        total_nm=points[-1]["cum_nm"], est_time_s=points[-1]["cum_s"], times_from_plan=times_ok,
        waypoints=points, warnings=warnings, dep_rwy=dep_rwy, arr_rwy=arr_rwy,
        plan_meta={
            "ofp_id": (data.get("params") or {}).get("request_id"),
            "airac": (data.get("params") or {}).get("airac"),
            "cruise_tas_kt": _i(general.get("cruise_tas")),
            "air_distance_nm": _i(general.get("air_distance")),
            "sched_out": _epoch(times.get("sched_out")),
            "sched_off": _epoch(times.get("sched_off")),
            "sched_on": _epoch(times.get("sched_on")),
            "sched_in": _epoch(times.get("sched_in")),
            "est_time_enroute_s": _i(_dur(times.get("est_time_enroute"))),
            "alternate": alternate.get("icao_code") if isinstance(alternate, dict) else None,
            "dep_rwy": dep_rwy,
            "arr_rwy": arr_rwy,
            "sid": sid_star(general)[0],
            "star": sid_star(general)[1],
            "dep_name": origin.get("name"),
            "arr_name": dest.get("name"),
            "pdf_url": pdf_url(data),
        },
    )
