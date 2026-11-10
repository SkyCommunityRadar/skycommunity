"""Who controls what — computed by the server only, never chosen in the browser ("Prendre en charge" no longer exists).

Positions: APP, TWR, GND on an airport (opened in this order: APP, then TWR, then GND) and CTR on a centre.
Service needed by a flight depends on its phase (sol = GND, tour = TWR, approche = APP, en route = CTR).
Delegation on an airport:
  - APP alone handles APP + TWR + GND;  APP + TWR: TWR also handles GND;  APP + TWR + GND: each its own service.
  - No airport position open: the CTR whose sector contains the airport handles the three services.
En route: an APP covers the aircraft within its radius around its airport, otherwise the CTR whose sector contains it.
"""

from datetime import datetime, timedelta
from functools import lru_cache

from lib import airspace
from lib.db import db
from lib.engine import compute_position
from lib.geo import haversine_nm

ONLINE_S = 60  # a position without heartbeat (radar polling every 2 s) for 1 min has lost its connection
AIRPORT_ORDER = ("APP", "TWR", "GND")  # mandatory opening order
APP_RADIUS_NM = 30.0
# Positions able to provide each airport service, best first.
CHAIN = {"GND": ("GND", "TWR", "APP"), "TWR": ("TWR", "APP"), "APP": ("APP",)}

# phase -> (which airport, which service); en route has no airport.
PHASE_SERVICE = {
    "preparation": ("dep", "GND"), "repoussage": ("dep", "GND"),
    "roulage": ("dep", "GND"), "point_attente": ("dep", "TWR"), "alignement": ("dep", "TWR"), "decollage": ("dep", "TWR"),
    "en_route": (None, "CTR"), "approche": ("arr", "APP"), "atterrissage": ("arr", "TWR"),
    "roulage_arrivee": ("arr", "GND"), "parking": ("arr", "GND"), "retour_parking": ("dep", "GND"),
}


async def online_positions(now: datetime) -> list[dict]:
    since = now - timedelta(seconds=ONLINE_S)
    return await db.atc_positions.find({"last_seen": {"$gte": since}}, {"_id": 0}).to_list(500)


# ---------- geometry ----------

def _in_ring(lat: float, lon: float, ring: list) -> bool:
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > lat) != (yj > lat) and lon < (xj - xi) * (lat - yi) / ((yj - yi) or 1e-12) + xi:
            inside = not inside
        j = i
    return inside


def _in_polygon(lat: float, lon: float, poly: list) -> bool:
    return bool(poly) and _in_ring(lat, lon, poly[0]) and not any(_in_ring(lat, lon, h) for h in poly[1:])


@lru_cache(maxsize=1)
def _fir_by_id() -> dict[str, dict]:
    return {f["properties"]["id"]: f for f in airspace.features("fir")}


def fir_contains(fir_id: str | None, lat: float, lon: float) -> bool:
    f = _fir_by_id().get(fir_id or "")
    if not f:
        return False
    s, w, n, e = f["bbox"]
    if not (s <= lat <= n and w <= lon <= e):
        return False
    g = f["geometry"]
    polys = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]
    return any(_in_polygon(lat, lon, p) for p in polys)


def airport_coords(icao: str) -> tuple[float, float] | None:
    from routers.airports import ref_lookup  # local import: routers depend on lib, not the other way round
    ref = ref_lookup(icao)
    return (ref[1], ref[2]) if ref else None


# ---------- responsibility ----------

def airport_controller(positions: list[dict], icao: str, service: str) -> dict | None:
    """Position providing `service` (GND/TWR/APP) at `icao`, following the delegation rules."""
    at = {p["type"]: p for p in positions if p.get("airport") == icao}
    for t in CHAIN[service]:
        if t in at:
            return at[t]
    c = airport_coords(icao)
    if c:
        for p in positions:
            if p["type"] == "CTR" and fir_contains(p.get("fir_id"), c[0], c[1]):
                return p
    return None


def service_of(f: dict) -> tuple[str | None, str]:
    phase = f["phase"] if f["phase"] != "suspendu" else (f.get("prev_phase") or "preparation")
    side, service = PHASE_SERVICE.get(phase, ("dep", "GND"))
    if phase == "parking" and f.get("returned_to_stand"):
        side = "dep"  # back at its departure stand after an interrupted take-off
    icao = f["departure"] if side == "dep" else f["arrival"] if side == "arr" else None
    return icao, service


def responsible(f: dict, positions: list[dict], now: datetime) -> dict | None:
    """The one position responsible for this flight right now, or None (uncontrolled)."""
    if f["phase"] in ("termine", "annule") or not positions:
        return None
    icao, service = service_of(f)
    if icao:
        return airport_controller(positions, icao, service)
    pos = compute_position(f, now)
    lat, lon = pos["lat"], pos["lon"]
    for p in positions:  # an approach covers the aircraft near its airport
        if p["type"] == "APP" and p.get("lat") is not None and haversine_nm(lat, lon, p["lat"], p["lon"]) <= APP_RADIUS_NM:
            return p
    for p in positions:
        if p["type"] == "CTR" and fir_contains(p.get("fir_id"), lat, lon):
            return p
    return None


def covers_airport(user_positions: list[dict], icao: str) -> bool:
    """Does one of these positions control `icao` (airport position there, or the CTR of its sector)?"""
    c = None
    for p in user_positions:
        if p.get("airport") == icao:
            return True
        if p["type"] == "CTR":
            c = c or airport_coords(icao)
            if c and fir_contains(p.get("fir_id"), c[0], c[1]):
                return True
    return False


class Ctx:
    """Control context of one request: online positions + the requesting user."""

    def __init__(self, positions: list[dict], user: dict, now: datetime):
        self.positions, self.user, self.now = positions, user, now
        self.mine = [p for p in positions if p["user_id"] == user["id"]]

    @property
    def is_admin(self) -> bool:
        return self.user.get("role") == "admin"

    def responsible(self, f: dict) -> dict | None:
        return responsible(f, self.positions, self.now)

    def is_responsible(self, f: dict) -> bool:
        r = self.responsible(f)
        return bool(r and r["user_id"] == self.user["id"])

    def can_manage(self, f: dict) -> bool:
        """Status, progression, corrections: admin, or the ATC responsible for the flight right now."""
        return self.is_admin or (self.user.get("role") == "atc" and self.is_responsible(f))

    def concerns_me(self, f: dict) -> bool:
        """Departs from / arrives at one of my airports (or my sector), or crosses my zone under my responsibility."""
        return self.is_responsible(f) or covers_airport(self.mine, f["departure"]) or covers_airport(self.mine, f["arrival"])

    def can_edit_strip(self, f: dict) -> bool:
        return self.is_admin or (self.user.get("role") == "atc" and self.concerns_me(f))

    def can_taxi(self, f: dict, kind: str) -> bool:
        """Taxi routes: the controller providing the ground service of that airport (or admin)."""
        if self.is_admin:
            return True
        if self.user.get("role") == "pilote":  # uncontrolled flight: the pilot enters their own taxi route
            return f.get("pilot_id") == self.user["id"] and not self.responsible(f)
        if self.user.get("role") != "atc":
            return False
        icao = f["departure"] if kind == "taxi_out" else f["arrival"]
        g = airport_controller(self.positions, icao, "GND")
        return bool(g and g["user_id"] == self.user["id"]) or self.is_responsible(f)

    def can_gate(self, f: dict, which: str) -> bool:
        if self.is_admin:
            return True
        if self.user.get("role") != "atc":
            return False
        return self.is_responsible(f) or covers_airport(self.mine, f["departure" if which == "dep" else "arrival"])


async def ctx_for(user: dict, now: datetime) -> Ctx:
    return Ctx(await online_positions(now), user, now)


async def record_controllers(now: datetime) -> None:
    """Engine tick: remembers every controller who was responsible for a flight (profile « vols contrôlés »)."""
    from lib.engine import ACTIVE
    positions = await online_positions(now)
    if not positions:
        return
    async for f in db.flights.find({"phase": {"$in": ACTIVE}}, {"_id": 0}):
        r = responsible(f, positions, now)
        if r and r["user_id"] not in (f.get("controllers") or []):
            await db.flights.update_one({"id": f["id"]}, {"$addToSet": {"controllers": r["user_id"]}})
