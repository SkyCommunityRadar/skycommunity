"""Server-authoritative flight state machine + simulated progression engine.

Positions are NEVER measured: they are estimated from server timestamps, the flight plan
and a simulated speed profile. Browsers never advance aircraft; they only read this state.
"""

import math
import re
from datetime import datetime, timedelta, timezone

from lib.geo import cumulative, interp, locate, project, haversine_nm
from lib.runways import project_on_runway

TAXI_SPEED_KT = 12.0  # nov. 2026: slowed down a little, 15 kt looked too fast on the map
DEFAULT_CRUISE_KT = 420.0

PHASES: dict[str, str] = {
    "preparation": "Préparation",
    "repoussage": "Repoussage",
    "roulage": "Roulage",
    "point_attente": "Point d'attente",
    "alignement": "Alignement",  # lined up on the runway (« aligner et maintenir ») or lining up before take-off
    "decollage": "Décollage",
    "en_route": "En route",
    "approche": "En approche",
    "atterrissage": "Atterrissage",
    "roulage_arrivee": "Roulage à l'arrivée",
    "retour_parking": "Retour au parking",  # take-off abandoned: taxiing back to the stand
    "parking": "Au parking",
    "termine": "Terminé",
    "suspendu": "Suspendu",
    "annule": "Annulé",
}
CLOSED = {"termine", "annule"}
ACTIVE = [p for p in PHASES if p not in CLOSED]
GROUND = {"preparation", "repoussage", "roulage", "point_attente", "alignement", "atterrissage",
          "roulage_arrivee", "retour_parking", "parking", "termine", "annule"}
AIR_PHASES = {"decollage", "en_route", "approche"}
TRACK_OF = {"roulage": "taxi_out", "alignement": "lineup", "decollage": "air", "en_route": "air", "approche": "air",
            "roulage_arrivee": "taxi_in", "retour_parking": "taxi_back"}
TAXI_TRACKS = ("taxi_out", "taxi_in", "taxi_back", "lineup")
LINEUP_KT = 8.0  # entering the runway and turning onto the centreline
LINEUP_HOLD_S = 0.0  # pas d'arrêt entre alignement et décollage (roulement continu)
TAKEOFF_ROLL_KT = 45.0  # roulis au décollage (plus lent que la croisière)
TAKEOFF_ROLL_NM = 1.2  # distance en NM pendant laquelle on reste à TAKEOFF_ROLL_KT
TAXI_PHASES = ("roulage", "roulage_arrivee", "retour_parking")  # where the « Stop / Reprendre » button exists

P = ("pilote", "atc", "admin")
C = ("atc", "admin")
ACTIONS: dict[str, dict] = {
    # « Prêt au départ » was removed (nov. 2026): from Préparation the pilot pushes back or taxis directly.
    "repoussage": dict(label="Début du repoussage", frm=["preparation"], to="repoussage", roles=P),
    "roulage": dict(label="Début du roulage", frm=["preparation", "repoussage"], to="roulage", roles=P),
    "point_attente": dict(label="Arrivé au point d'attente", frm=["roulage"], to="point_attente", roles=P),
    # « Aligner et maintenir »: the aircraft enters the runway and waits there for its take-off clearance
    "alignement": dict(label="Aligner et maintenir", frm=["point_attente"], to="alignement", roles=P),
    # from the holding point the aircraft first lines up (shown on the map), then rolls by itself
    "decollage": dict(label="Décollage", frm=["point_attente", "alignement"], to="decollage", roles=P, confirm=True),
    "approche": dict(label="Entrée en approche", frm=["en_route"], to="approche", roles=P),
    # take-off abandoned on the runway: back to the holding point to try again, or back to the stand
    "interrompre_decollage": dict(label="Interrompre : retour au point d'attente", frm=["decollage"], to="point_attente",
                                  roles=P, confirm=True),
    "retour_parking": dict(label="Retour au parking", frm=["decollage"], to="retour_parking", roles=P,
                           confirm=True),
    "atterrissage": dict(label="Atterrissage", frm=["approche"], to="atterrissage", roles=P, confirm=True),
    "go_around": dict(label="Remise de gaz", frm=["approche", "atterrissage"], to="approche", roles=P, confirm=True),
    "roulage_arrivee": dict(label="Début du roulage à l'arrivée", frm=["atterrissage"], to="roulage_arrivee", roles=P),
    "parking": dict(label="Arrivée au parking", frm=["roulage_arrivee"], to="parking", roles=P),
    # Le vol se termine au parking : par le pilote, ou par l'ATC quand le vol est contrôlé (ensure_control).
    "terminer": dict(label="Terminer le vol", frm=["parking"], to="termine", roles=P, confirm=True),
    "suspendre": dict(label="Suspendre le vol", frm=[p for p in ACTIVE if p != "suspendu"], to="suspendu",
                      roles=C, confirm=True),
    "reprendre": dict(label="Reprendre le vol", frm=["suspendu"], to=None, roles=C),
    # A pilot may cancel at any active phase as long as no ATC is responsible (checked by ensure_control); the flight
    # is never deleted, it stays in the history as « Annulé ».
    "annuler": dict(label="Annuler le vol", frm=list(ACTIVE), to="annule", roles=P, confirm=True),
}


# Ordered lifecycle used by "étape précédente / suivante".
ORDER = ["preparation", "repoussage", "roulage", "point_attente", "alignement", "decollage", "en_route", "approche",
         "atterrissage", "roulage_arrivee", "parking"]
# Going back is refused across these boundaries (an aircraft in the air cannot return to the ground and vice versa).
NO_BACK_FROM = {"en_route", "roulage_arrivee"}


def step_target(phase: str, direction: str) -> str | None:
    if phase not in ORDER:
        return None
    i = ORDER.index(phase)
    if direction == "next":
        return ORDER[i + 1] if i + 1 < len(ORDER) else None
    if phase in NO_BACK_FROM or i == 0:
        return None
    return ORDER[i - 1]


def step_for(phase: str, direction: str, role: str) -> str | None:
    """The step « Étape précédente / suivante » leads to for this role, or None when the button must not exist.
    A pilot only moves forward to the steps they can declare themselves (not décollage → croisière, which is automatic)."""
    to = step_target(phase, direction)
    if to and direction == "next" and role == "pilote":
        if not any(a["to"] == to and phase in a["frm"] and "pilote" in a["roles"] for a in ACTIONS.values()):
            return None
    return to


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def aware(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


# ---------- geometry of the tracks ----------

def _air(f: dict) -> tuple[list[tuple[float, float]], list[float], list[float]]:
    route = f["route"]
    pts = [(w["lat"], w["lon"]) for w in route]
    # take off from the end of the departure taxi, land where the arrival taxi starts. When the route carries the
    # real runway (lib/runways), that point is projected ON the runway centreline: line-up and touchdown/exit stay
    # on the runway axis (intersection departures included), never in the middle of the airport.
    out, inn = (f.get("taxi_out") or {}).get("path"), (f.get("taxi_in") or {}).get("path")
    lu = (f.get("lineup") or {}).get("path")
    if lu:  # take-off roll starts where the aircraft lined up
        out = lu
    if out:
        rw = route[0].get("rwy")
        pts[0] = project_on_runway(rw, out[-1][0], out[-1][1]) if rw else (out[-1][0], out[-1][1])
    if inn:
        rw = route[-1].get("rwy")
        pts[-1] = project_on_runway(rw, inn[0][0], inn[0][1]) if rw else (inn[0][0], inn[0][1])
    return pts, [w["cum_nm"] for w in route], [w["cum_s"] for w in route]


def dep_point(f: dict) -> tuple[float, float]:
    g, t = f.get("dep_gate"), (f.get("taxi_out") or {}).get("path")
    if g:
        return g["lat"], g["lon"]
    if t:
        return t[0][0], t[0][1]
    return f["route"][0]["lat"], f["route"][0]["lon"]


def arr_point(f: dict) -> tuple[float, float]:
    g, t = f.get("arr_gate"), (f.get("taxi_in") or {}).get("path")
    if g:
        return g["lat"], g["lon"]
    if t:
        return t[-1][0], t[-1][1]
    return f["route"][-1]["lat"], f["route"][-1]["lon"]


def _taxi(f: dict, kind: str) -> tuple[list[tuple[float, float]], list[float]]:
    t = f.get(kind)
    if not t or len(t.get("path", [])) < 2:
        return [], []
    pts = [(p[0], p[1]) for p in t["path"]]
    return pts, cumulative(pts)


def track_length(f: dict, track: str | None) -> float:
    if track == "air":
        return f["route"][-1]["cum_nm"]
    if track in TAXI_TRACKS:
        _, cum = _taxi(f, track)
        return cum[-1] if cum else 0.0
    return 0.0


def is_moving(f: dict) -> bool:
    p = f["progress"]
    return (TRACK_OF.get(f["phase"]) == p.get("track") and not p.get("hold")
            and f.get("manual_position") is None)


def current_distance(f: dict, now: datetime) -> float:
    p = f["progress"]
    track = p.get("track")
    if not track:
        return 0.0
    length = track_length(f, track)
    d = float(p.get("anchor_dist", 0.0))
    anchor_at = aware(p.get("anchor_at"))
    if is_moving(f) and anchor_at:
        elapsed = max(0.0, (now - anchor_at).total_seconds())
        if track == "air":
            # Phase décollage : roulis lent jusqu'à TAKEOFF_ROLL_NM, puis profil route
            if f.get("phase") == "decollage":
                base = float(p.get("anchor_dist", 0.0))
                if base < TAKEOFF_ROLL_NM:
                    d = base + elapsed * TAKEOFF_ROLL_KT / 3600.0
                    if d > TAKEOFF_ROLL_NM:
                        # transition douce vers le profil air (temps restant à vitesse croisière approx)
                        extra_s = (d - TAKEOFF_ROLL_NM) / max(TAKEOFF_ROLL_KT, 1) * 3600.0
                        _, dists, times = _air(f)
                        d = interp(times, dists, interp(dists, times, TAKEOFF_ROLL_NM) + extra_s * 0.5)
                else:
                    _, dists, times = _air(f)
                    d = interp(times, dists, interp(dists, times, d) + elapsed)
            else:
                _, dists, times = _air(f)
                d = interp(times, dists, interp(dists, times, d) + elapsed)
            if f.get("holding"):
                d = min(d, f["holding"]["fix_nm"])
        else:
            d += elapsed * (LINEUP_KT if track == "lineup" else TAXI_SPEED_KT) / 3600.0
    return max(0.0, min(d, length))


def rebase(f: dict, now: datetime) -> None:
    """Freeze the computed distance into the anchor. Call before ANY mutation."""
    p = f["progress"]
    p["anchor_dist"] = current_distance(f, now)
    p["anchor_at"] = now


def set_track(f: dict, track: str | None, dist: float, now: datetime) -> None:
    f["progress"].update(track=track, anchor_dist=dist, anchor_at=now)


def _rolling_view(f: dict, now: datetime) -> dict:
    """Autorisé au décollage et aligné : l'avion roule déjà, sans attendre le prochain passage du moteur (3 s)."""
    if f.get("phase") != "alignement" or not f.get("takeoff_cleared"):
        return f
    since = lined_up_since(f, now)
    if since is None:
        return f
    at = datetime.fromtimestamp(now.timestamp() - since, timezone.utc)
    return {**f, "phase": "decollage", "progress": {**f["progress"], "track": "air", "anchor_dist": 0.0, "anchor_at": at, "hold": False}}


def compute_position(f: dict, now: datetime) -> dict:
    f = _rolling_view(f, now)
    p = f["progress"]
    track = p.get("track")
    route = f["route"]
    d = current_distance(f, now)
    total = track_length(f, track)
    lat, lon, hdg, idx = route[0]["lat"], route[0]["lon"], 0.0, 0
    prev_wp = next_wp = None
    alt = None
    if track == "air":
        pts, dists, _ = _air(f)
        lat, lon, hdg, idx = locate(pts, dists, d)
        prev_wp = route[idx]["ident"]
        next_wp = route[idx + 1]["ident"] if idx + 1 < len(route) else None
        alts = [float(w.get("alt_ft") or 0) for w in route]
        alt = int(interp(dists, alts, d))
        h = f.get("holding")
        entered = hold_entered_at(f, now) if h else None
        if entered:
            lat, lon, hdg = racetrack_point(h, (now - entered).total_seconds())
            alt = int(h.get("alt_ft") or alt)
    elif track in TAXI_TRACKS:
        pts, cum = _taxi(f, track)
        if pts:
            lat, lon, hdg, idx = locate(pts, cum, d)
            if track == "lineup" and cum and d >= cum[-1] - 0.001:
                hdg = float(f["lineup"].get("hdg", hdg))  # lined up: nose along the runway
            rw = route[0].get("rwy")
            if track == "taxi_out" and f["phase"] == "point_attente" and rw:
                # au point d'attente, le nez regarde vers la suite : la piste
                from lib.runways import bearing
                on = project_on_runway(rw, lat, lon)
                if haversine_nm(lat, lon, on[0], on[1]) > 0.005:
                    hdg = bearing(lat, lon, on[0], on[1])
            seg = f[track].get("seg_names", [])
            prev_wp = (seg[idx] if idx < len(seg) else None) or None
            next_wp = next((n for n in seg[idx + 1:] if n and n != prev_wp), None)
        elif track == "taxi_out":
            lat, lon = dep_point(f)
        else:
            lat, lon = arr_point(f) if f["phase"] in ("parking", "termine") else _air(f)[0][-1]
    else:
        lat, lon = dep_point(f)
        hdg = float((f.get("dep_gate") or {}).get("hdg") or 0.0)  # parked nose-in, along the stand line
        pb = pushback_point(f, now)
        if pb:
            lat, lon, hdg = pb
    kind = "estimee"
    if f.get("manual_position"):
        lat, lon = f["manual_position"]["lat"], f["manual_position"]["lon"]
        kind = "manuelle"
    phase = f.get("prev_phase") if f["phase"] == "suspendu" else f["phase"]
    # time along the track (shown next to the percentage): flight plan timings in the air, taxi speed on the ground
    if track == "air":
        _, dists, times = _air(f)
        elapsed_s, total_s = interp(dists, times, d), times[-1]
    elif track in TAXI_TRACKS:
        elapsed_s, total_s = d / TAXI_SPEED_KT * 3600, total / TAXI_SPEED_KT * 3600
    else:
        elapsed_s = total_s = 0.0
    return dict(
        elapsed_s=round(elapsed_s), total_s=round(total_s),
        lat=lat, lon=lon, heading=round(hdg, 1), on_ground=phase in GROUND, track=track,
        distance_nm=round(d, 2), total_nm=round(total, 2),
        progress_pct=round(100 * d / total, 1) if total > 0 else 0.0,
        prev_wp=prev_wp, next_wp=next_wp, wp_index=idx, alt_ft=alt, kind=kind,
        paused=not is_moving(f),
    )


# ---------- procedures (SID / STAR from the plan de vol SimBrief) ----------

def procedures(route: list[dict]) -> tuple[str | None, str | None, int | None]:
    """(SID name, STAR name, index of the STAR entry fix). Only what the navlog flags as SID/STAR:
    nothing is invented when SimBrief does not identify a procedure."""
    n = len(route)
    sid = star = None
    star_idx = None
    half = max(1, n // 2)
    for i, w in enumerate(route[1:-1], start=1):
        if not w.get("sid_star"):
            continue
        via = w.get("via")
        if i < half:
            sid = sid or via
        elif star_idx is None:
            star_idx, star = i, via
    if star_idx is not None and star:
        # Remonter au premier fix de CETTE STAR (même via), sans traverser un autre nom
        while star_idx - 1 > 0:
            prev = route[star_idx - 1]
            if not prev.get("sid_star") or (prev.get("via") or "") != star:
                break
            star_idx -= 1
        # Ne jamais remonter dans la 1re moitié (SID)
        star_idx = max(star_idx, half)
    return sid, star, star_idx


# The chosen direction is where the NOSE ends up pointing: the aircraft is pushed backwards,
# i.e. it moves towards the opposite side (choosing "Nord" pushes it towards the south).
NOT_FIX = ("TOC", "TOD")


def _star_entry(route: list[dict], star: str | None, half: int) -> int | None:
    """Index du point d'entrée de CETTE STAR sur la route, ou None si la route ne la contient pas.
    1) le fix qui porte le nom de la STAR (TINI9W commence à TINIL) ;
    2) sinon le fix d'où part la première branche de la STAR : dans le navlog SimBrief, « via » décrit la branche qui
       ARRIVE sur un fix, le premier fix marqué du nom de la STAR est donc déjà son 2e point."""
    n = len(route)
    if not star:
        return None
    usable = lambda i: route[i].get("ident") not in NOT_FIX and route[i].get("kind") not in ("apt", "rwy")
    prefix = (re.match(r"[A-Z]+", star) or [""])[0]
    if len(prefix) >= 3:
        for i in range(half, n - 1):
            if usable(i) and route[i].get("ident", "").startswith(prefix):
                return i
    for i in range(half, n - 1):
        if (route[i].get("via") or "") == star:
            j = i - 1
            while j >= half and not usable(j):
                j -= 1
            return j if j >= half else i
    return None


def approach_target(f: dict) -> tuple[float, str]:
    """Distance le long de la route pour « Entrée en approche ». La STAR est celle AFFICHÉE : celle saisie sur le strip
    par le contrôle si elle existe, sinon celle du plan. Jamais l'entrée d'une autre STAR."""
    route = f["route"]
    n = len(route)
    meta = f.get("plan_meta") or {}
    _sid, star_from_route, star_idx = procedures(route)
    plan_star = meta.get("star") or star_from_route
    chosen = (f.get("strip") or {}).get("star")
    star = chosen or plan_star
    half = max(1, n // 2)
    idx = _star_entry(route, star, half)
    if idx is None and star == plan_star:  # STAR du plan sans nom exploitable : repli sur les marques du navlog
        if star_idx is not None and half <= star_idx < n - 1 and route[star_idx].get("ident") not in NOT_FIX:
            idx = star_idx
        else:
            idx = next((i for i in range(half, n - 1) if route[i].get("sid_star") and route[i].get("ident") not in NOT_FIX), None)
    if idx is not None:
        label_star = star or (route[idx].get("via") or "STAR")
        return route[idx]["cum_nm"], f"Positionné à l'entrée de la STAR {label_star} ({route[idx]['ident']})"

    tod = next((i for i in range(1, n - 1) if route[i].get("ident") == "TOD"), None)
    if tod is not None:
        why = f"STAR {star} absente de la route" if star else "Pas de STAR dans le plan"
        return route[tod]["cum_nm"], f"{why} : positionné au TOD (début de descente)"
    total = route[-1]["cum_nm"]
    to_lose = max(0.0, float(route[0].get("alt_ft") or 0) - float(route[-1].get("alt_ft") or 0))
    # 3 NM / 1000 ft
    d = max(0.0, total - (to_lose / 1000.0) * 3.0)
    return d, f"Pas de STAR dans le plan : positionné au TOD estimé ({to_lose / 1000 * 3:.0f} NM avant l'arrivée)"




PUSH_HDG = {"N": 0.0, "NE": 45.0, "E": 90.0, "SE": 135.0, "S": 180.0, "SW": 225.0, "W": 270.0, "NW": 315.0}
PUSH_VEC = {d: (math.cos(math.radians(h + 180)), math.sin(math.radians(h + 180))) for d, h in PUSH_HDG.items()}
PUSH_M, PUSH_S = 60.0, 90.0  # without a chosen end point (older flights): 60 m in 90 s
PUSH_SPEED = 1.2  # m/s, about 2.3 kt: a tug pushing back
PUSH_MIN_M, PUSH_MAX_M = 10.0, 400.0


def push_distance_m(f: dict, lat: float, lon: float) -> float:
    lat0, lon0 = dep_point(f)
    return math.hypot((lat - lat0) * 110_540, (lon - lon0) * 111_320 * math.cos(math.radians(lat0)))


def pushback_point(f: dict, now: datetime) -> tuple[float, float, float] | None:
    """Repoussage : déplacement vers le point cliqué. Pendant le mouvement le nez garde le cap
    initial (porte) ; à l'arrivée au point de push, le nez passe au cap choisi."""
    d = f.get("pushback_dir")
    if f["phase"] != "repoussage" or d not in PUSH_VEC:
        return None
    lat, lon = dep_point(f)
    # pushback_at et non anchor_at : choisir un point d'attente pendant le repoussage ne doit pas le faire recommencer
    started = aware(f.get("pushback_at")) or aware(f["progress"].get("anchor_at")) or now
    elapsed = (now - started).total_seconds()
    final_hdg = PUSH_HDG[d]
    to = f.get("pushback_to")
    gate_hdg = (f.get("dep_gate") or {}).get("hdg")
    if gate_hdg is not None:
        initial_hdg = float(gate_hdg)
    elif to:  # poste sans orientation connue : poussé en marche arrière, le nez regarde le poste
        from lib.runways import bearing
        initial_hdg = bearing(to["lat"], to["lon"], lat, lon)
    else:
        initial_hdg = final_hdg
    if to:
        dist = push_distance_m(f, to["lat"], to["lon"])
        k = 1.0 if dist < 1 else min(1.0, max(0.0, elapsed * PUSH_SPEED / dist))
        hdg = final_hdg if k >= 1.0 else initial_hdg  # le nez tourne seulement une fois le point atteint
        return lat + (to["lat"] - lat) * k, lon + (to["lon"] - lon) * k, hdg
    k = min(1.0, max(0.0, elapsed / PUSH_S))
    dy, dx = PUSH_VEC[d]
    dlat = dy * PUSH_M * k / 111_320
    dlon = dx * PUSH_M * k / (111_320 * max(0.2, math.cos(math.radians(lat))))
    hdg = final_hdg if k >= 1.0 else initial_hdg
    return lat + dlat, lon + dlon, hdg


LIVE_TAXI = {"taxi_out": ("roulage", "point_attente"), "taxi_in": ("roulage_arrivee",)}


def taxi_origin(f: dict, kind: str, now: datetime) -> tuple[float, float] | None:
    """Modification pendant le roulage : le nouveau tracé part de l'avion. Avant le roulage, None : le départ part du
    poste, et l'arrivée de la sortie de piste cliquée (même derrière l'avion, qui y est ramené)."""
    if f["phase"] in LIVE_TAXI[kind] and f["progress"].get("track") == kind:
        pos = compute_position(f, now)
        return pos["lat"], pos["lon"]
    return None


# ---------- transitions ----------

def enter_phase(f: dict, to: str, now: datetime) -> None:
    rebase(f, now)
    if to == "suspendu":
        f["prev_phase"] = f["phase"]
    elif f["phase"] != "suspendu":
        f["manual_position"] = None
    if to != "suspendu" and f["phase"] != "suspendu":
        f["progress"]["hold"] = False  # a « Stop » belongs to one phase: the next one starts moving again
    f["phase"] = to
    if to != "alignement":
        f["takeoff_cleared"] = False
    # block times for the leaderboard (server clock only, never user input)
    if to in ("repoussage", "roulage") and not f.get("block_off_at"):
        f["block_off_at"] = now
    if to in ("parking", "termine") and f.get("block_off_at") and not f.get("block_on_at"):
        f["block_on_at"] = now
    track = f["progress"].get("track")
    if to == "preparation":
        f["pushback_to"] = None  # back on the stand: a new pushback will be chosen
    if to == "repoussage":
        f["pushback_at"] = now
    if to in ("preparation", "repoussage"):
        # back on the stand (also when going back with « étape précédente »): no taxi / air track any more,
        # otherwise the old taxi position would hide the stand and the pushback would never move
        set_track(f, None, 0.0, now)
    elif to == "roulage":
        set_track(f, "taxi_out", 0.0, now)
    elif to == "point_attente":
        # S'arrêter exactement sur le dernier point du tracé (point d'attente)
        end = track_length(f, "taxi_out")
        set_track(f, "taxi_out", end, now)
        f["progress"]["hold"] = True  # figé pile sur le point
    elif to == "alignement":
        build_lineup(f)
        set_track(f, "lineup", 0.0, now)
    elif to == "decollage":
        # Roulement continu : pas de hold, piste dès le seuil (ou fin d'alignement projetée)
        f["progress"]["hold"] = False
        f["manual_position"] = None
        set_track(f, "air", 0.0, now)
        f["takeoff_at"] = now
        f["takeoff_cleared"] = True
    elif to == "retour_parking":
        # back to the stand along the departure taxi route, travelled the other way
        out = f.get("taxi_out") or {}
        if len(out.get("path") or []) >= 2:
            f["taxi_back"] = {"path": list(reversed(out["path"])), "seg_names": list(reversed(out.get("seg_names") or [])),
                              "names": list(reversed(out.get("names") or []))}
            set_track(f, "taxi_back", 0.0, now)
        else:  # no taxi route known: straight back on the stand
            f["phase"] = "preparation"
            set_track(f, None, 0.0, now)
    elif to in ("en_route", "approche") and track != "air":
        set_track(f, "air", 0.0, now)
    if to == "approche":
        # move the aircraft to the first fix of the arrival STAR, or to the top of descent when the plan has no
        # STAR (never backwards: an aircraft already past that point keeps its position)
        target, note = approach_target(f)
        here = f["progress"]["anchor_dist"]
        if target > here:
            set_track(f, "air", target, now)
            f["approach_note"] = note
        elif here - target <= 3.0:  # reached it by itself (automatic entry)
            f["approach_note"] = note.replace("Positionné à", "Arrivé à").replace("positionné au", "arrivé au")
        else:
            f["approach_note"] = f"{note} — déjà dépassé, position conservée."
    elif to == "atterrissage":
        if track_length(f, "taxi_in") > 0:
            set_track(f, "taxi_in", 0.0, now)  # on the runway exit, waits for "début du roulage"
        else:
            set_track(f, "air", track_length(f, "air"), now)
    elif to == "roulage_arrivee":
        set_track(f, "taxi_in", 0.0, now)
    elif to in ("parking", "termine") and track in ("taxi_in", "air"):
        set_track(f, "taxi_in", track_length(f, "taxi_in"), now)


# Taxiing cannot start before its route exists: entered by the controller when the flight is controlled,
# by the pilot otherwise (holding point at departure, route drawn to the stand at arrival).
TAXI_REQUIRED = {"roulage": "taxi_out", "roulage_arrivee": "taxi_in"}


def taxi_block(f: dict, to: str, controlled: bool) -> str | None:
    kind = TAXI_REQUIRED.get(to)
    if not kind or track_length(f, kind) > 0:
        return None
    if controlled:
        return "Roulage pas encore saisi : le contrôleur doit d'abord définir votre itinéraire de roulage."
    if kind == "taxi_out":
        return "Roulage pas encore saisi : choisissez d'abord votre point d'attente pour tracer le roulage."
    return "Roulage pas encore saisi : tracez d'abord votre roulage jusqu'au poste (partie « Roulage »)."


def allowed_actions(f: dict, role: str, is_owner: bool, controlled: bool = False) -> list[dict]:
    out = []
    for code, a in ACTIONS.items():
        if f["phase"] not in a["frm"] or role not in a["roles"]:
            continue
        if role == "pilote" and not is_owner:
            continue
        if code in REJECT_ACTIONS and not reject_window_open(f, utcnow()):
            continue  # the take-off can only be interrupted during its first minute
        out.append(dict(code=code, label=a["label"], confirm=bool(a.get("confirm")),
                        blocked=taxi_block(f, a["to"], controlled) if a["to"] else None))
    return out


def build_profile(points: list[dict], speeds_kt: list[float] | None = None, default_kt: float = DEFAULT_CRUISE_KT) -> None:
    """Fill cum_nm (great-circle) and cum_s (from per-segment speeds) on route points in-place."""
    cum_nm, cum_s = 0.0, 0.0
    points[0]["cum_nm"], points[0]["cum_s"] = 0.0, 0.0
    for i in range(1, len(points)):
        a, b = points[i - 1], points[i]
        leg = haversine_nm(a["lat"], a["lon"], b["lat"], b["lon"])
        spd = speeds_kt[i - 1] if speeds_kt and i - 1 < len(speeds_kt) and speeds_kt[i - 1] > 0 else default_kt
        cum_nm += leg
        cum_s += leg / spd * 3600
        b["cum_nm"], b["cum_s"] = round(cum_nm, 3), round(cum_s, 1)


def direct_to(f: dict, target: int, now: datetime) -> str:
    """Route change: fly direct from present (estimated) position to route[target]."""
    rebase(f, now)
    pos = compute_position(f, now)
    passed = pos["wp_index"]
    route = f["route"]
    if not (passed < target < len(route)):
        raise ValueError("Le point choisi doit être situé après la position actuelle.")
    seg_s = route[target]["cum_s"] - route[target - 1]["cum_s"]
    seg_nm = route[target]["cum_nm"] - route[target - 1]["cum_nm"]
    speed = seg_nm / seg_s * 3600 if seg_s > 0 and seg_nm > 0 else DEFAULT_CRUISE_KT
    if f.get("holding"):
        add_hold_time(f, now)
    f.pop("holding", None)  # a direct ends any holding pattern
    ppos = dict(ident="PPOS", name="Position estimée au moment du direct", lat=pos["lat"], lon=pos["lon"],
                alt_ft=pos["alt_ft"], ias_kt=None, kind="ppos")
    new = [dict(w) for w in route[: passed + 1]] + [ppos] + [dict(w) for w in route[target:]]
    # keep original timings for untouched legs; derive the new legs from the leg speed
    durations = []
    for i in range(1, len(new)):
        a, b = new[i - 1], new[i]
        leg = haversine_nm(a["lat"], a["lon"], b["lat"], b["lon"])
        if i <= passed:
            durations.append(route[i]["cum_s"] - route[i - 1]["cum_s"])
        elif i > passed + 2:
            j = target + (i - passed - 2)
            durations.append(route[j]["cum_s"] - route[j - 1]["cum_s"])
        else:
            durations.append(leg / speed * 3600)
    cum_nm, cum_s = 0.0, 0.0
    new[0]["cum_nm"], new[0]["cum_s"] = 0.0, 0.0
    for i in range(1, len(new)):
        cum_nm += haversine_nm(new[i - 1]["lat"], new[i - 1]["lon"], new[i]["lat"], new[i]["lon"])
        cum_s += max(1.0, durations[i - 1])
        new[i]["cum_nm"], new[i]["cum_s"] = round(cum_nm, 3), round(cum_s, 1)
    f["route"] = new
    f["manual_position"] = None
    set_track(f, "air", new[passed + 1]["cum_nm"], now)
    f["last_wp_index"] = passed + 1
    return route[target]["ident"]


def snap_distance(f: dict, lat: float, lon: float) -> float:
    track = f["progress"].get("track")
    if track == "air":
        pts, dists, _ = _air(f)
        return project(pts, dists, lat, lon)
    pts, cum = _taxi(f, track or "")
    return project(pts, cum, lat, lon) if pts else 0.0


# ---------- TOC / TOD moved by the pilot (late climb, early / late descent) ----------

PROFILE_MARKERS = ("TOC", "TOD")


def marker_nm(f: dict, ident: str) -> float | None:
    return next((w["cum_nm"] for w in f["route"] if w.get("ident") == ident), None)


def move_marker(f: dict, ident: str, new_nm: float) -> None:
    """Moves the TOC / TOD point along the route to `new_nm` (from the departure). The other points keep their
    distances and timings, so the aircraft does not jump; only the altitude profile follows: steady climb from the
    runway to the TOC, cruise level until the TOD, steady descent from the TOD to the arrival runway.
    Raises ValueError (French message) when the place is not possible."""
    route = f["route"]
    i = next((k for k, w in enumerate(route) if w.get("ident") == ident), None)
    if i is None:
        raise ValueError(f"Ce plan de vol n'a pas de point {ident}.")
    total = route[-1]["cum_nm"]
    other = marker_nm(f, "TOD" if ident == "TOC" else "TOC")
    new_nm = round(float(new_nm), 3)
    if not 2.0 <= new_nm <= total - 2.0:
        raise ValueError(f"Le {ident} doit rester sur la route, entre le départ et l'arrivée (0 à {total:.0f} NM).")
    if other is not None and ((ident == "TOC" and new_nm >= other - 1) or (ident == "TOD" and new_nm <= other + 1)):
        raise ValueError("Le TOC (fin de montée) doit rester avant le TOD (début de descente).")
    level = float(route[i].get("alt_ft") or f.get("cruise_alt_ft") or 30000)
    pt = route.pop(i)
    j = max(k for k, w in enumerate(route) if w["cum_nm"] <= new_nm)
    a, b = route[j], route[min(j + 1, len(route) - 1)]
    k = 0.0 if b["cum_nm"] == a["cum_nm"] else (new_nm - a["cum_nm"]) / (b["cum_nm"] - a["cum_nm"])
    route.insert(j + 1, {**pt, "lat": a["lat"] + (b["lat"] - a["lat"]) * k, "lon": a["lon"] + (b["lon"] - a["lon"]) * k,
                         "cum_nm": new_nm, "cum_s": round(a["cum_s"] + (b["cum_s"] - a["cum_s"]) * k, 1),
                         "alt_ft": level, "moved": True})
    _reprofile(route)


def _reprofile(route: list[dict]) -> None:
    toc = next((k for k, w in enumerate(route) if w.get("ident") == "TOC"), None)
    tod = next((k for k, w in enumerate(route) if w.get("ident") == "TOD"), None)
    ground = [k for k, w in enumerate(route) if w.get("kind") in ("apt", "rwy")]
    if toc is not None:
        lo = max([k for k in ground if k < toc], default=0)  # last departure runway point
        a0, n0, lvl, n1 = float(route[lo].get("alt_ft") or 0), route[lo]["cum_nm"], float(route[toc]["alt_ft"]), route[toc]["cum_nm"]
        for k in range(lo + 1, toc):
            route[k]["alt_ft"] = round(a0 + (lvl - a0) * (route[k]["cum_nm"] - n0) / max(0.1, n1 - n0))
        end = tod if tod is not None else len(route)
        for k in range(toc + 1, end):
            if route[k].get("kind") not in ("apt", "rwy"):
                route[k]["alt_ft"] = max(float(route[k].get("alt_ft") or 0), lvl)
    if tod is not None:
        hi = min([k for k in ground if k > tod], default=len(route) - 1)  # first arrival runway point
        lvl, n0, a1, n1 = float(route[tod]["alt_ft"]), route[tod]["cum_nm"], float(route[hi].get("alt_ft") or 0), route[hi]["cum_nm"]
        for k in range(tod + 1, hi):
            route[k]["alt_ft"] = round(lvl + (a1 - lvl) * (route[k]["cum_nm"] - n0) / max(0.1, n1 - n0))
        start = toc + 1 if toc is not None else 1
        for k in range(start, tod):
            if route[k].get("kind") not in ("apt", "rwy"):
                route[k]["alt_ft"] = max(float(route[k].get("alt_ft") or 0), lvl)


def build_lineup(f: dict) -> None:
    """Holding point -> onto the runway centreline -> a few metres along it, nose in the take-off direction."""
    out = (f.get("taxi_out") or {}).get("path") or []
    hp = (f.get("holding_point") or {})
    start = (out[-1][0], out[-1][1]) if out else ((hp["lat"], hp["lon"]) if hp.get("lat") is not None else None)
    rw = f["route"][0].get("rwy")
    if not start:
        start = (f["route"][0]["lat"], f["route"][0]["lon"])
    if not rw:
        f["lineup"] = {"path": [list(start), list(start)], "hdg": 0.0, "seg_names": [], "names": ["Alignement"]}
        return
    from lib.runways import offset
    on = project_on_runway(rw, start[0], start[1])
    end = offset(on[0], on[1], rw["hdg"], 0.02)  # ~37 m along the axis: the turn onto the centreline is visible
    f["lineup"] = {"path": [list(start), list(on), list(end)], "hdg": float(rw["hdg"]),
                   "seg_names": [f"Piste {rw['ident']}", f"Piste {rw['ident']}"], "names": [f"Piste {rw['ident']}"]}


def lined_up_since(f: dict, now: datetime) -> float | None:
    """Seconds since the aircraft finished lining up (None while it is still entering the runway)."""
    p = f["progress"]
    if f["phase"] != "alignement" or p.get("track") != "lineup" or not is_moving(f):
        return None
    left = track_length(f, "lineup") - float(p.get("anchor_dist", 0.0))
    done_at = (aware(p.get("anchor_at")) or now).timestamp() + max(0.0, left) / LINEUP_KT * 3600
    return now.timestamp() - done_at if now.timestamp() >= done_at else None


# ---------- holding pattern (attente) on a fix of the route ----------
# Standard racetrack: right turns, inbound leg on the route course towards the fix, 1 min legs up to FL140
# (1 min 30 above), 180° turns in 1 min, ICAO holding speeds. Asked by the controller (or the pilot when the flight
# is not controlled) with a number of turns; after them the aircraft keeps holding until told to leave.

TURN_S = 60.0


def hold_params(alt_ft: float | None) -> tuple[float, float]:
    """(leg seconds, speed kt) for this altitude."""
    a = alt_ft or 0
    return (60.0, 230.0) if a <= 14000 else (90.0, 265.0)


def hold_lap_s(h: dict) -> float:
    return 2 * TURN_S + 2 * h["leg_s"]


def hold_entered_at(f: dict, now: datetime) -> datetime | None:
    """When the aircraft reached the holding fix (None while it is still flying towards it)."""
    h = f.get("holding")
    if not h:
        return None
    if h.get("entered_at"):
        return aware(h["entered_at"])
    p = f["progress"]
    if p.get("track") != "air":
        return None
    d0, at = float(p.get("anchor_dist", 0.0)), aware(p.get("anchor_at")) or now
    if d0 >= h["fix_nm"] - 1e-6:
        return at
    if not is_moving(f):
        return None
    _, dists, times = _air(f)
    t = at.timestamp() + interp(dists, times, h["fix_nm"]) - interp(dists, times, d0)
    return datetime.fromtimestamp(t, timezone.utc) if t <= now.timestamp() else None


def racetrack_point(h: dict, t: float) -> tuple[float, float, float]:
    """(lat, lon, heading) t seconds after crossing the fix, on the racetrack (right turns)."""
    from lib.runways import offset
    hdg, leg_s, v = h["inbound"], h["leg_s"], h["speed_kt"]
    r = v * TURN_S / 3600.0 / math.pi  # radius of a 180° turn flown in 1 min
    L = v * leg_s / 3600.0
    t %= hold_lap_s(h)
    fix = (h["lat"], h["lon"])
    if t < TURN_S:  # outbound turn, centre on the right of the inbound course
        a = 180.0 * t / TURN_S
        c = offset(*fix, hdg + 90, r)
        lat, lon = offset(*c, hdg - 90 + a, r)
        return lat, lon, (hdg + a) % 360
    t -= TURN_S
    a_pt = offset(*fix, hdg + 90, 2 * r)
    if t < leg_s:  # outbound leg
        lat, lon = offset(*a_pt, hdg + 180, L * t / leg_s)
        return lat, lon, (hdg + 180) % 360
    t -= leg_s
    b_pt = offset(*a_pt, hdg + 180, L)
    if t < TURN_S:  # inbound turn
        a = 180.0 * t / TURN_S
        c = offset(*b_pt, hdg - 90, r)
        lat, lon = offset(*c, hdg + 90 + a, r)
        return lat, lon, (hdg + 180 + a) % 360
    t -= TURN_S
    d_pt = offset(*b_pt, hdg - 90, 2 * r)
    lat, lon = offset(*d_pt, hdg, L * min(1.0, t / leg_s))
    return lat, lon, hdg % 360


def racetrack_path(h: dict, n: int = 48) -> list[list[float]]:
    lap = hold_lap_s(h)
    return [[round(a, 6), round(b, 6)] for a, b, _ in (racetrack_point(h, lap * i / n) for i in range(n + 1))]


def start_holding(f: dict, idx: int, turns: int | None, now: datetime, by: str) -> dict:
    """Holding pattern on route[idx] (a fix still ahead of the aircraft). Raises ValueError (French message)."""
    if f["phase"] not in ("en_route", "approche") or f["progress"].get("track") != "air":
        raise ValueError("Un hold se demande en vol (en route ou en approche).")
    route = f["route"]
    if not 0 < idx < len(route) - 1 or route[idx].get("kind") in ("apt", "rwy") or route[idx].get("ident") in ("TOC", "TOD"):
        raise ValueError("Choisissez un point de la route (pas un point de piste, ni le TOC / TOD).")
    rebase(f, now)
    if route[idx]["cum_nm"] <= f["progress"]["anchor_dist"] + 0.5:
        raise ValueError(f"{route[idx]['ident']} est déjà dépassé : choisissez un point devant l'avion.")
    from lib.runways import bearing
    prev = route[idx - 1]
    alt = float(route[idx].get("alt_ft") or 0)
    leg_s, speed = hold_params(alt)
    f["holding"] = {"ident": route[idx]["ident"], "fix_nm": route[idx]["cum_nm"], "lat": route[idx]["lat"],
                    "lon": route[idx]["lon"], "inbound": round(bearing(prev["lat"], prev["lon"], route[idx]["lat"], route[idx]["lon"]), 1),
                    "turns": turns, "leg_s": leg_s, "speed_kt": speed, "alt_ft": alt, "exit": False,
                    "entered_at": None, "turns_done_logged": False, "set_by": by, "set_at": now}
    return f["holding"]


def holding_info(f: dict, now: datetime) -> dict | None:
    h = f.get("holding")
    if not h:
        return None
    entered = hold_entered_at(f, now)
    laps = int((now - entered).total_seconds() // hold_lap_s(h)) if entered else 0
    return {"ident": h["ident"], "turns": h.get("turns"), "laps_done": laps, "entered": bool(entered),
            "exit": bool(h.get("exit")), "inbound": h["inbound"], "leg_s": h["leg_s"], "speed_kt": h["speed_kt"],
            "lap_s": hold_lap_s(h), "path": racetrack_path(h),
            "turns_done": bool(entered and h.get("turns") and laps >= h["turns"])}


def leave_holding_at(f: dict, now: datetime) -> datetime | None:
    """Exit asked: the aircraft finishes its lap and leaves when it is back over the fix."""
    h = f.get("holding")
    entered = hold_entered_at(f, now)
    if not h or not h.get("exit") or not entered:
        return None
    lap = hold_lap_s(h)
    el = (now - entered).total_seconds()
    k = math.ceil(el / lap - 1e-9) if el > 0 else 0
    return datetime.fromtimestamp(entered.timestamp() + k * lap, timezone.utc)


def add_hold_time(f: dict, now: datetime) -> None:
    """Time flown in a hold is added to the flight's allowance (lib/hours): an ATC hold never costs hours."""
    entered = hold_entered_at(f, now)
    if entered and now > entered:
        f["hold_s"] = round(float(f.get("hold_s") or 0) + (now - entered).total_seconds())


def end_holding(f: dict, at: datetime) -> None:
    """Back on the route from the fix at `at` (the time spent holding is added to the flight)."""
    if f.get("holding"):
        add_hold_time(f, at)
    h = f.pop("holding", None)
    if h:
        f["progress"].update(track="air", anchor_dist=h["fix_nm"], anchor_at=at)


def reconcile_holding(f: dict, new_dist: float, now: datetime) -> str | None:
    """L'avion est déplacé à la main le long de la route (±NM, point précédent / suivant, recalage). Le hold reste
    TOUJOURS sur son point : au-delà du point le hold est terminé, en deçà l'avion revient vers le point et y refera
    son hold. À appeler AVANT de changer anchor_dist."""
    h = f.get("holding")
    if not h or f["progress"].get("track") != "air":
        return None
    entered = hold_entered_at(f, now)
    if new_dist > h["fix_nm"] + 1e-6:
        if entered:
            add_hold_time(f, now)
        f.pop("holding", None)
        return f"fin du hold sur {h['ident']}"
    if new_dist < h["fix_nm"] - 1e-6 and entered:
        add_hold_time(f, now)
        h.update(entered_at=None, exit=False, turns_done_logged=False)
        return f"retour vers le hold sur {h['ident']}"
    return None


def nudge_in_hold(f: dict, delta_nm: float | None, laps: int, now: datetime) -> str | None:
    """Avancer / reculer un avion EN hold le déplace SUR l'hippodrome, jamais sur la route initiale. Il ne quitte le
    hold que si une sortie a été demandée et que l'avance atteint le moment de cette sortie."""
    h = f["holding"]
    entered = hold_entered_at(f, now)
    secs = laps * hold_lap_s(h) if laps else float(delta_nm or 0) / h["speed_kt"] * 3600.0
    at = leave_holding_at(f, now)
    if secs > 0 and at is not None and secs >= (at - now).total_seconds():
        extra_nm = (secs - (at - now).total_seconds()) * h["speed_kt"] / 3600.0
        ident, fix = h["ident"], h["fix_nm"]
        end_holding(f, now)
        f["progress"]["anchor_dist"] = min(fix + extra_nm, track_length(f, "air"))
        return f"sortie du hold sur {ident}"
    elapsed = max(0.0, (now - entered).total_seconds() + secs)
    h["entered_at"] = now - timedelta(seconds=elapsed)
    if h.get("turns") and elapsed < h["turns"] * hold_lap_s(h):
        h["turns_done_logged"] = False
    return None


def go_around(f: dict, now: datetime) -> None:
    """Remise de gaz : l'avion repart à l'entrée de l'approche pour une nouvelle tentative (depuis l'approche comme
    depuis l'atterrissage). Le hold éventuel est terminé."""
    if f.get("holding"):
        add_hold_time(f, now)
        f.pop("holding", None)
    target, note = approach_target(f)
    f["manual_position"] = None
    f["progress"]["hold"] = False
    set_track(f, "air", target, now)
    f["last_wp_index"] = compute_position(f, now)["wp_index"]
    f["approach_note"] = f"Remise de gaz — {note}"


REJECT_ACTIONS = ("interrompre_decollage", "retour_parking")
REJECT_WINDOW_S = 180.0  # interrompre possible pendant 3 minutes après Décoller


def reject_window_open(f: dict, now: datetime) -> bool:
    at = aware(f.get("takeoff_at")) or aware(f["progress"].get("anchor_at"))
    return f["phase"] == "decollage" and bool(at) and (now - at).total_seconds() <= REJECT_WINDOW_S
