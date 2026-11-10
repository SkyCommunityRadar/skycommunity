import json
import math
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query

from lib.auth import current_user, require
from lib.db import db
from lib import runways as runways_mod
from lib.events import log_event
from lib.geo import haversine_nm

from lib.engine import taxi_origin, utcnow
from lib.osm import build_taxi_path, get_ground, on_airport
from models.schemas import AirportRef, Ground, GroundSummary, TaxiPreview, TaxiPreviewIn

router = APIRouter(prefix="/airports", tags=["airports"])

_REF: dict[str, list] | None = None


def _ref() -> dict[str, list]:
    """OurAirports public-domain dataset (positions only), loaded lazily once."""
    global _REF
    if _REF is None:
        with open(Path(__file__).resolve().parent.parent / "data" / "airports_ref.json", encoding="utf-8") as fh:
            _REF = json.load(fh)
    return _REF


def ref_lookup(icao: str) -> tuple[str, float, float] | None:
    hit = _ref().get(icao.strip().upper())
    return (hit[0], hit[1], hit[2]) if hit else None


def _icao(icao: str) -> str:
    code = icao.strip().upper()
    if len(code) != 4 or not code.isalnum():
        raise HTTPException(400, "Code OACI sur 4 caractères attendu.")
    return code


@router.get("", response_model=list[GroundSummary])
async def list_loaded(user: dict = Depends(require("flight:read"))):
    docs = await db.ground.find({}, {"_id": 0, "icao": 1, "name": 1, "lat": 1, "lon": 1, "gates": 1, "fetched_at": 1}
                                ).sort("icao", 1).to_list(500)
    return [GroundSummary(**{**d, "gates": len(d.get("gates", []))}) for d in docs]


@router.get("/nearby", response_model=list[AirportRef])
async def nearby(lat: float = Query(ge=-90, le=90), lon: float = Query(ge=-180, le=180),
                 radius_nm: float = Query(8.0, gt=0, le=30), limit: int = Query(2, ge=1, le=5),
                 user: dict = Depends(require("flight:read"))):
    """Airports (with a real runway of 900 m or more) around the map centre: the radar loads their ground
    plan automatically when the user zooms in, for every airport — not only those of the selected flight."""
    rw = runways_mod._all()
    k = math.cos(math.radians(lat))
    dlat, dlon = radius_nm / 60.0, radius_nm / 60.0 / max(0.05, k)
    hits = []
    for code, (name, alat, alon) in ((c, v[:3]) for c, v in _ref().items()):
        if abs(alat - lat) > dlat or abs(alon - lon) > dlon or len(code) != 4:
            continue
        if not any((r[8] or 0) >= 3000 for r in rw.get(code, [])):
            continue
        d = haversine_nm(lat, lon, alat, alon)
        if d <= radius_nm:
            hits.append((d, code, name, alat, alon))
    hits.sort()
    loaded = {d["icao"] async for d in db.ground.find({"icao": {"$in": [h[1] for h in hits[:limit]]}}, {"icao": 1})}
    return [AirportRef(icao=c, name=n, lat=a, lon=o, configured=c in loaded) for _, c, n, a, o in hits[:limit]]


@router.get("/lookup/{icao}", response_model=AirportRef)
async def lookup_airport(icao: str, user: dict = Depends(current_user)):
    code = _icao(icao)
    hit = ref_lookup(code)
    if not hit:
        raise HTTPException(404, f"Code OACI {code} inconnu.")
    loaded = await db.ground.find_one({"icao": code}, {"_id": 1})
    return AirportRef(icao=code, name=hit[0], lat=hit[1], lon=hit[2], configured=bool(loaded))


@router.get("/{icao}/ground", response_model=Ground)
async def ground(icao: str, user: dict = Depends(require("flight:read"))):
    return await get_ground(_icao(icao), user=user)


@router.post("/{icao}/ground/refresh", response_model=Ground)
async def refresh_ground(icao: str, user: dict = Depends(require("admin:airports"))):
    doc = await get_ground(_icao(icao), refresh=True)
    await log_event("admin", "Données au sol rechargées depuis OpenStreetMap", user, None,
                    f"{doc['icao']} : {len(doc['gates'])} postes")
    return doc


@router.post("/{icao}/taxi-preview", response_model=TaxiPreview)
async def taxi_preview(icao: str, body: TaxiPreviewIn, start_gate: str | None = None, end_gate: str | None = None,
                       flight_id: str | None = None, user: dict = Depends(require("flight:taxi"))):
    code = _icao(icao)
    doc = await get_ground(code, user=user)
    if not all(on_airport(doc, p[0], p[1]) for p in body.points):
        raise HTTPException(422, f"Point hors de l'aéroport : cliquez sur une voie de {code}.")
    origin, exit_runway = None, None
    if flight_id:  # same anchoring as the saved route
        f = await db.flights.find_one({"id": flight_id}, {"_id": 0})
        if f:
            origin = taxi_origin(f, body.kind, utcnow())
            if body.kind == "taxi_in" and not origin:
                exit_runway = f["route"][-1].get("rwy") or {}  # arrival: from the runway, through the exit
            elif body.kind == "taxi_out" and f["phase"] == "decollage":
                exit_runway = f["route"][0].get("rwy") or {}  # interrupted take-off
            push = f.get("pushback_to") if f["phase"] == "repoussage" else None
            if body.kind == "taxi_out" and not origin and push:
                origin = (push["lat"], push["lon"])
    end = (body.holding_lat, body.holding_lon) if body.kind == "taxi_out" and body.holding_lat is not None and body.holding_lon is not None else None
    t = await build_taxi_path(code, body.points, None if origin else start_gate, end_gate, origin=origin, end_point=end,
                              exit_runway=exit_runway)
    return TaxiPreview(airport=t["airport"], path=t["path"], names=t["names"], length_nm=t["length_nm"])
