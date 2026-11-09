"""Real runways (OurAirports, public domain: both thresholds of every runway, displaced thresholds, length).

Used so that take-off and landing trajectories follow the axis of the runway actually used — the one planned
in SimBrief (origin/destination `plan_rwy`), or the best aligned one when SimBrief gives none — and never
start or end in the middle of the airport.
"""

import json
import math
from functools import lru_cache
from pathlib import Path

from lib.geo import haversine_nm

DATA = Path(__file__).resolve().parent.parent / "data" / "runways.json"
FT_PER_NM = 6076.12


@lru_cache(maxsize=1)
def _all() -> dict[str, list[list]]:
    try:
        return json.loads(DATA.read_text())
    except FileNotFoundError:
        return {}


def bearing(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2, dl = math.radians(lat1), math.radians(lat2), math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def offset(lat: float, lon: float, hdg: float, nm: float) -> tuple[float, float]:
    """Point at `nm` nautical miles from (lat, lon) on true heading `hdg` (flat-earth, fine below ~20 NM)."""
    dlat = nm * math.cos(math.radians(hdg)) / 60.0
    dlon = nm * math.sin(math.radians(hdg)) / (60.0 * max(0.05, math.cos(math.radians(lat))))
    return lat + dlat, lon + dlon


def _norm(ident: str) -> str:
    s = ident.strip().upper().removeprefix("RW").removeprefix("RWY")
    return s.zfill(3) if s[-1:] in "LRC" and len(s) == 2 else s.zfill(2) if s.isdigit() else s


def runway_ends(icao: str) -> list[dict]:
    """Every usable runway end of `icao`: threshold (displaced if any), heading of use, far end, length."""
    out = []
    for le, la, lo, ldisp, he, ha, ho, hdisp, length_ft, elev in _all().get(icao.upper(), []):
        for ident, (alat, alon, disp), (blat, blon) in ((le, (la, lo, ldisp), (ha, ho)), (he, (ha, ho, hdisp), (la, lo))):
            hdg = bearing(alat, alon, blat, blon)
            length_nm = (length_ft / FT_PER_NM) if length_ft else haversine_nm(alat, alon, blat, blon)
            tlat, tlon = offset(alat, alon, hdg, (disp or 0) / FT_PER_NM)
            out.append({"ident": ident, "lat": tlat, "lon": tlon, "hdg": round(hdg, 1), "end_lat": blat, "end_lon": blon,
                        "length_nm": round(length_nm, 3), "elev_ft": elev})
    return out


def find(icao: str, ident: str | None) -> dict | None:
    if not ident:
        return None
    want = _norm(ident)
    return next((r for r in runway_ends(icao) if _norm(r["ident"]) == want), None)


def best_aligned(icao: str, wanted_hdg: float) -> dict | None:
    """Fallback when SimBrief has no planned runway: the end whose heading is closest to `wanted_hdg`."""
    ends = [r for r in runway_ends(icao) if r["length_nm"] >= 0.4]  # ignore tiny strips / helipads
    if not ends:
        return None
    return min(ends, key=lambda r: (abs((r["hdg"] - wanted_hdg + 540) % 360 - 180), -r["length_nm"]))


def project_on_runway(rwy: dict, lat: float, lon: float) -> tuple[float, float]:
    """Closest point of the runway centreline to (lat, lon). The centreline runs from the PHYSICAL start of the runway
    (before a displaced threshold, e.g. LFML 31R: ~600 m) to the far end: an aircraft entering at the very
    beginning lines up there instead of crossing the grass to the displaced threshold."""
    k = math.cos(math.radians(rwy["lat"]))
    ax, ay = rwy["lon"] * k, rwy["lat"]
    bx, by = rwy["end_lon"] * k, rwy["end_lat"]
    px, py = lon * k, lat
    dx, dy = bx - ax, by - ay
    L2 = dx * dx + dy * dy or 1e-12
    thr_to_end = haversine_nm(rwy["lat"], rwy["lon"], rwy["end_lat"], rwy["end_lon"])
    t_min = min(0.0, 1.0 - float(rwy.get("length_nm") or 0) / thr_to_end) if thr_to_end > 0 else 0.0
    t = max(t_min, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L2))
    return ay + t * dy, (ax + t * dx) / k


def apply_runway_geometry(points: list[dict], dep: str, arr: str, dep_rwy: str | None, arr_rwy: str | None) -> list[str]:
    """Rewrites the ends of a parsed SimBrief route in place so that it follows the real runways:
    departure = threshold -> lift-off on the axis -> 3 NM straight out; arrival = 8 NM final on the extended
    centreline -> threshold -> roll-out. cum_nm / cum_s are recomputed. Returns French warnings."""
    warnings: list[str] = []
    if len(points) < 2:
        return warnings
    first, last = points[0], points[-1]
    nxt, prv = points[1], points[-2]
    d = find(dep, dep_rwy)
    if dep_rwy and not d:
        warnings.append(f"Piste de départ {dep_rwy} introuvable pour {dep} : piste la mieux orientée utilisée.")
    d = d or best_aligned(dep, bearing(first["lat"], first["lon"], nxt["lat"], nxt["lon"]))
    a = find(arr, arr_rwy)
    if arr_rwy and not a:
        warnings.append(f"Piste d'arrivée {arr_rwy} introuvable pour {arr} : piste la mieux orientée utilisée.")
    a = a or best_aligned(arr, bearing(prv["lat"], prv["lon"], last["lat"], last["lon"]))
    old_s = [p["cum_s"] for p in points]
    new_pts: list[dict] = []
    t_dep = 0.0
    if d:
        elev = d["elev_ft"] if d["elev_ft"] is not None else first.get("alt_ft")
        first.update(lat=d["lat"], lon=d["lon"], alt_ft=elev, rwy={**d, "use": "dep"})
        lo = offset(d["lat"], d["lon"], d["hdg"], d["length_nm"] * 0.55)
        co = offset(d["lat"], d["lon"], d["hdg"], d["length_nm"] + 3.0)
        new_pts += [first,
                    dict(ident=f"RW{d['ident']}", name="Rotation (axe de piste)", lat=lo[0], lon=lo[1], alt_ft=elev,
                         ias_kt=None, kind="rwy", synthetic=True),
                    dict(ident=f"{d['ident']}+3", name="Montée initiale dans l'axe", lat=co[0], lon=co[1],
                         alt_ft=(elev or 0) + 1000, ias_kt=None, kind="rwy", synthetic=True)]
        t_dep = TAKEOFF_S  # roll + initial climb, added before the SimBrief times
    else:
        warnings.append(f"Aucune piste connue pour {dep} : départ depuis le point de référence de l'aéroport.")
        new_pts.append(first)
    new_pts += points[1:-1]
    if a:
        elev = a["elev_ft"] if a["elev_ft"] is not None else last.get("alt_ft")
        faf = offset(a["lat"], a["lon"], (a["hdg"] + 180) % 360, 8.0)
        ro = offset(a["lat"], a["lon"], a["hdg"], a["length_nm"] * 0.5)
        new_pts += [dict(ident=f"FINAL{a['ident']}", name="Finale 8 NM (axe de piste)", lat=faf[0], lon=faf[1],
                         alt_ft=(elev or 0) + 2500, ias_kt=None, kind="rwy", synthetic=True),
                    dict(ident=f"RW{a['ident']}", name="Seuil de piste", lat=a["lat"], lon=a["lon"], alt_ft=elev,
                         ias_kt=None, kind="rwy", synthetic=True)]
        last.update(lat=ro[0], lon=ro[1], alt_ft=elev, rwy={**a, "use": "arr"})
    else:
        warnings.append(f"Aucune piste connue pour {arr} : arrivée sur le point de référence de l'aéroport.")
    new_pts.append(last)

    # distances along the new geometry; times: SimBrief times kept for the original fixes (+ take-off),
    # inserted points interpolated between their neighbours
    cum = 0.0
    new_pts[0]["cum_nm"] = 0.0
    for p, q in zip(new_pts, new_pts[1:]):
        cum += haversine_nm(p["lat"], p["lon"], q["lat"], q["lon"])
        q["cum_nm"] = round(cum, 3)
    orig_index = {id(p): i for i, p in enumerate(points)}
    known = [(j, old_s[orig_index[id(p)]] + (t_dep if j else 0.0)) for j, p in enumerate(new_pts) if id(p) in orig_index]
    for j, p in enumerate(new_pts):
        if id(p) in orig_index:
            p["cum_s"] = round(old_s[orig_index[id(p)]] + (t_dep if j else 0.0), 1)
            continue
        before = max((k for k in known if k[0] < j), key=lambda k: k[0])
        after = min((k for k in known if k[0] > j), key=lambda k: k[0])
        span = new_pts[after[0]]["cum_nm"] - new_pts[before[0]]["cum_nm"] or 1.0
        frac = (p["cum_nm"] - new_pts[before[0]]["cum_nm"]) / span
        if before[0] == 0 and t_dep:  # take-off segment: its own duration
            p["cum_s"] = round(t_dep * min(1.0, p["cum_nm"] / max(new_pts[2]["cum_nm"], 0.1)), 1)
        else:
            p["cum_s"] = round(before[1] + frac * (after[1] - before[1]), 1)
    # times must strictly increase (the engine interpolates on them)
    for p, q in zip(new_pts, new_pts[1:]):
        if q["cum_s"] <= p["cum_s"]:
            q["cum_s"] = round(p["cum_s"] + 1.0, 1)
    points[:] = new_pts
    return warnings


TAKEOFF_S = 90.0  # roll + initial climb added by apply_runway_geometry before the SimBrief times


def runway_idents(icao: str) -> list[str]:
    """Usable runway ends of an airport (helipads / tiny strips left out), for the runway pickers."""
    return sorted({r["ident"] for r in runway_ends(icao) if r["length_nm"] >= 0.4},
                  key=lambda s: (s.rstrip("LRC").zfill(2), s))


def change_runways(points: list[dict], dep: str, arr: str, dep_rwy: str | None, arr_rwy: str | None) -> list[str]:
    """Re-plans the ends of an already-built route for other runways (controller correction): the synthetic
    take-off / final points of the old runways are removed, then apply_runway_geometry builds the new ones."""
    if len(points) < 2:
        return []
    had_dep = bool(points[0].get("rwy"))
    pts = [dict(p) for p in points]
    while len(pts) > 2 and pts[1].get("synthetic"):
        del pts[1]
    while len(pts) > 2 and pts[-2].get("synthetic"):
        del pts[-2]
    pts[0].pop("rwy", None)
    pts[-1].pop("rwy", None)
    if had_dep:  # undo the take-off time added last time, it is added again below
        for p in pts[1:]:
            p["cum_s"] = max(0.0, p["cum_s"] - TAKEOFF_S)
    warnings = apply_runway_geometry(pts, dep, arr, dep_rwy, arr_rwy)
    points[:] = pts
    return warnings
