"""Real airport ground data from OpenStreetMap (Overpass API): stands/gates, taxiways, runways,
holding points. Built into a routable graph so taxi routes follow the actual taxiway centrelines.

Data © OpenStreetMap contributors (ODbL). Cached in Mongo collection `ground` per ICAO.
"""

import asyncio
import heapq
import math
import os
import re
import time

import httpx
from fastapi import HTTPException

from lib.db import db
from lib.engine import utcnow
from lib.geo import cumulative, haversine_nm

MIRRORS = [u for u in [
    os.environ.get("OVERPASS_URL"),
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
] if u]
UA = "SkyCommunityRadar/1.0 (+https://discord.gg/xjhTqW3N7d)"
TAXI_KINDS = {"taxiway", "taxilane", "runway"}
RUNWAY_PENALTY = 4.0  # prefer taxiways over runways when routing
_locks: dict[str, asyncio.Lock] = {}
_graphs: dict[str, "Graph"] = {}


GROUND_VERSION = 3  # bump when build_ground changes: older cached airports are rebuilt on next use
MARGIN_DEG = 0.004  # ~400 m around the aerodrome boundary


def _box(lat: float, lon: float) -> tuple[float, float, float, float]:
    dlat, dlon = 0.045, 0.045 / max(0.2, math.cos(math.radians(lat)))  # ~5 km half-size box (fallback)
    return lat - dlat, lon - dlon, lat + dlat, lon + dlon


def _query(bbox: tuple[float, float, float, float]) -> str:
    b = ",".join(f"{v:.5f}" for v in bbox)
    return (f'[out:json][timeout:80][bbox:{b}];(way["aeroway"~"^(taxiway|taxilane|runway|parking_position|apron|terminal)$"];'
            f'node["aeroway"~"^(gate|parking_position|holding_position)$"];);out body;>;out skel qt;')


async def _post(client: httpx.AsyncClient, q: str) -> dict:
    last = None
    for attempt in range(2):
        for url in MIRRORS:
            try:
                r = await client.post(url, data={"data": q})
                if r.status_code == 200:
                    return r.json()
                last = f"HTTP {r.status_code}"
            except (httpx.HTTPError, ValueError) as e:
                last = type(e).__name__
        await asyncio.sleep(4 * (attempt + 1))
    raise HTTPException(503, f"OpenStreetMap (Overpass) est momentanément saturé ({last}). Réessayez dans une minute.")


async def _aerodrome_bbox(client: httpx.AsyncClient, icao: str, lat: float, lon: float) -> tuple[float, float, float, float] | None:
    """Real extent of the airport (OSM aeroway=aerodrome boundary tagged with this ICAO), so that big airports are
    complete and neighbouring airfields' stands are not mixed in."""
    q = (f'[out:json][timeout:25];(way["aeroway"="aerodrome"]["icao"="{icao}"];'
         f'relation["aeroway"="aerodrome"]["icao"="{icao}"];);out bb;')
    try:
        data = await _post(client, q)
    except HTTPException:
        return None
    for e in data.get("elements", []):
        b = e.get("bounds")
        if not b:
            continue
        s_, w_, n_, e_ = b["minlat"], b["minlon"], b["maxlat"], b["maxlon"]
        # sanity: the boundary must contain (or be very close to) the reference point and stay < 25 km wide
        if s_ - 0.02 <= lat <= n_ + 0.02 and w_ - 0.03 <= lon <= e_ + 0.03 and (n_ - s_) < 0.25:
            return s_ - MARGIN_DEG, w_ - MARGIN_DEG, n_ + MARGIN_DEG, e_ + MARGIN_DEG
    return None


async def _fetch_raw(icao: str, lat: float, lon: float) -> tuple[dict, tuple[float, float, float, float]]:
    async with httpx.AsyncClient(timeout=70, headers={"User-Agent": UA}) as client:
        bbox = await _aerodrome_bbox(client, icao, lat, lon) or _box(lat, lon)
        return await _post(client, _query(bbox)), bbox


def _name(tags: dict) -> str:
    raw = (tags.get("ref") or tags.get("name") or "").strip()[:20]
    # Strip legacy numeric suffixes like « A (2) »
    return re.sub(r"\s*\(\d+\)\s*$", "", raw).strip()


def _bearing(a: tuple[float, float], b: tuple[float, float]) -> float:
    p1, p2, dl = math.radians(a[0]), math.radians(b[0]), math.radians(b[1] - a[1])
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return round((math.degrees(math.atan2(y, x)) + 360) % 360, 1)


def _stand_point(ids: list[int], coords: dict, graph_nodes: set, near_graph) -> tuple[tuple[float, float], float | None, int | None]:
    """Where the aircraft actually parks on an OSM parking_position way, and its heading.
    - lead-in line touching the taxilane: the far end of the line (nose position), heading taxilane -> stand;
    - line not touching the network: the end farthest from the taxiways;
    - closed way (stand drawn as an area): its centroid."""
    pts = [coords[n] for n in ids]
    if ids[0] == ids[-1] and len(ids) >= 4:  # area
        ring = pts[:-1]
        return (sum(p[0] for p in ring) / len(ring), sum(p[1] for p in ring) / len(ring)), None, None
    shared = [n for n in ids if n in graph_nodes]
    if shared:
        link = shared[0]
        far = max(ids, key=lambda n: haversine_nm(*coords[n], *coords[link]))
        return coords[far], _bearing(coords[link], coords[far]), link
    a, b = coords[ids[0]], coords[ids[-1]]
    da, db = near_graph(a), near_graph(b)
    end, start = (a, b) if da >= db else (b, a)
    return end, _bearing(start, end), None


def build_ground(raw: dict, bbox: tuple[float, float, float, float] | None = None) -> dict:
    """Overpass JSON -> compact ground doc (graph + stands + holding points + display lines)."""
    coords: dict[int, tuple[float, float]] = {}
    ways, pnodes = [], []
    for e in raw.get("elements", []):
        if e["type"] == "node":
            coords[e["id"]] = (round(e["lat"], 7), round(e["lon"], 7))
            if e.get("tags", {}).get("aeroway"):
                pnodes.append(e)
        elif e["type"] == "way":
            ways.append(e)
    edges, lines, graph_nodes = [], [], set()
    stand_ways, areas = [], []
    for w in ways:
        tags = w.get("tags", {})
        kind = tags.get("aeroway")
        ids = [n for n in w.get("nodes", []) if n in coords]
        if len(ids) < 2:
            continue
        if kind in TAXI_KINDS:
            name = _name(tags)
            for a, b in zip(ids, ids[1:]):
                edges.append([a, b, name, kind])
            graph_nodes.update(ids)
            lines.append({"name": name, "kind": kind, "path": [list(coords[n]) for n in ids]})
        elif kind == "parking_position":
            stand_ways.append((tags, ids))
        elif kind in ("apron", "terminal"):
            areas.append({"kind": kind, "path": [list(coords[n]) for n in ids]})
    neighbours: dict[int, list[int]] = {}
    for a, b, _, _ in edges:
        neighbours.setdefault(a, []).append(b)
        neighbours.setdefault(b, []).append(a)
    gn = list(graph_nodes)
    step = max(1, len(gn) // 4000)  # subsample big airports: distances only need ~50 m accuracy
    sample = [coords[n] for n in gn[::step]]

    def near_graph(p: tuple[float, float]) -> float:
        k = math.cos(math.radians(p[0]))
        return min(((q[0] - p[0]) ** 2 + ((q[1] - p[1]) * k) ** 2) for q in sample) ** 0.5 * 60 if sample else 0.0

    def inside(p: tuple[float, float]) -> bool:
        return not bbox or (bbox[0] <= p[0] <= bbox[2] and bbox[1] <= p[1] <= bbox[3])

    stands: dict[str, dict] = {}
    for tags, ids in stand_ways:
        ref = _name(tags)
        if not ref:
            continue
        (lat, lon), hdg, link = _stand_point(ids, coords, graph_nodes, near_graph)
        if not inside((lat, lon)) or near_graph((lat, lon)) > 0.25:  # > ~460 m from any taxiway: not this airport
            continue
        stands[ref] = {"ref": ref, "lat": round(lat, 7), "lon": round(lon, 7), "link": link, "kind": "stand", "hdg": hdg}
    holdings = []
    for n in pnodes:
        tags = n["tags"]
        kind, ref = tags.get("aeroway"), _name(tags)
        lat, lon = coords[n["id"]]
        if kind == "holding_position":
            if inside((lat, lon)):
                holdings.append({"ref": ref, "lat": lat, "lon": lon})
        elif ref and (kind == "parking_position" or ref not in stands):
            if not inside((lat, lon)) or near_graph((lat, lon)) > 0.25:
                continue
            hdg = None
            nb = neighbours.get(n["id"], [])
            if len(nb) == 1:  # stand point at the end of its lead-in line: nose along that line
                hdg = _bearing(coords[nb[0]], coords[n["id"]])
            stands[ref] = {"ref": ref, "lat": lat, "lon": lon, "link": n["id"] if n["id"] in graph_nodes else None,
                           "kind": "stand" if kind == "parking_position" else "gate", "hdg": hdg}
    return {
        "nodes": [[n, *coords[n]] for n in graph_nodes],
        "edges": edges,
        "gates": sorted(stands.values(), key=lambda g: (len(g["ref"]), g["ref"])),
        "holdings": holdings,
        "lines": lines,
        "areas": areas,
    }


class Graph:
    def __init__(self, doc: dict):
        self.coords = {int(n[0]): (n[1], n[2]) for n in doc["nodes"]}
        self.adj: dict[int, list[tuple[int, float, str]]] = {n: [] for n in self.coords}
        self.kind: dict[tuple[int, int], str] = {}
        for a, b, name, kind in doc["edges"]:
            a, b = int(a), int(b)
            if a not in self.coords or b not in self.coords:
                continue
            self.kind[(a, b)] = self.kind[(b, a)] = kind
            w = haversine_nm(*self.coords[a], *self.coords[b]) * (RUNWAY_PENALTY if kind == "runway" else 1.0)
            self.adj[a].append((b, w, name))
            self.adj[b].append((a, w, name))
        self.gates = {g["ref"]: g for g in doc["gates"]}

    def nearest(self, lat: float, lon: float) -> int:
        k = math.cos(math.radians(lat))
        return min(self.coords, key=lambda n: (self.coords[n][0] - lat) ** 2 + ((self.coords[n][1] - lon) * k) ** 2)

    def shortest(self, a: int, b: int) -> list[int]:
        if a == b:
            return [a]
        dist, prev, pq = {a: 0.0}, {}, [(0.0, a)]
        while pq:
            d, u = heapq.heappop(pq)
            if u == b:
                break
            if d > dist.get(u, math.inf):
                continue
            for v, w, _ in self.adj[u]:
                nd = d + w
                if nd < dist.get(v, math.inf):
                    dist[v], prev[v] = nd, u
                    heapq.heappush(pq, (nd, v))
        if b not in dist:
            raise HTTPException(400, "Aucun chemin continu sur les voies de circulation entre ces points "
                                     "(réseau OpenStreetMap discontinu). Ajoutez un point intermédiaire.")
        out = [b]
        while out[-1] != a:
            out.append(prev[out[-1]])
        return out[::-1]

    def edge_name(self, a: int, b: int) -> str:
        raw = next((n for v, _, n in self.adj[a] if v == b), "")
        # Jamais de « (2) » dans les noms affichés / stockés
        return re.sub(r"\s*\(\d+\)\s*$", "", raw or "").strip()

    def gate_node(self, ref: str) -> int:
        g = self.gates[ref]
        return int(g["link"]) if g.get("link") is not None else self.nearest(g["lat"], g["lon"])


async def _airport_ref(icao: str) -> tuple[str, float, float]:
    from routers.airports import ref_lookup  # local import: avoid cycle
    hit = ref_lookup(icao)
    if not hit:
        raise HTTPException(404, f"Code OACI {icao} inconnu.")
    return hit


_fetch_slots = asyncio.Semaphore(2)  # at most 2 concurrent Overpass downloads for the whole server
_user_fetches: dict[str, list[float]] = {}
USER_FETCH_LIMIT = 30  # new (uncached) airports per user per hour (auto-loading on zoom); admin exempt


def _quota(user: dict | None) -> None:
    if not user or user.get("role") == "admin":
        return
    now = time.time()
    hist = [t for t in _user_fetches.get(user["id"], []) if now - t < 3600]
    if len(hist) >= USER_FETCH_LIMIT:
        raise HTTPException(429, "Trop de nouveaux aéroports chargés en une heure. Réessayez plus tard.")
    hist.append(now)
    _user_fetches[user["id"]] = hist


def _xy(lat0: float, p: tuple[float, float]) -> tuple[float, float]:
    """Local flat coordinates in metres (fine at airport scale)."""
    return p[1] * 111_320 * math.cos(math.radians(lat0)), p[0] * 110_540


def _seg_dist(p, a, b) -> float:
    (px, py), (ax, ay), (bx, by) = p, a, b
    dx, dy = bx - ax, by - ay
    t = 0.0 if dx == dy == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - ax - t * dx, py - ay - t * dy)


def name_holdings(icao: str, doc: dict) -> dict:
    """Many airports (LFML, LFBO, KEWR…) have holding points without any name in OpenStreetMap: they could not be picked.
    Each one gets the name of its taxiway, e.g. « D9 », « D9-2 » (auto=True). Never « (2) »."""
    from lib.runways import runway_ends
    holds = doc.get("holdings") or []
    if not holds or all(h.get("ref") for h in holds):
        return doc
    lat0 = doc.get("lat") or holds[0]["lat"]
    ends = runway_ends(icao)
    pairs = []  # (segment, ident of each end)
    for e in ends:
        pairs.append((_xy(lat0, (e["lat"], e["lon"])), _xy(lat0, (e["end_lat"], e["end_lon"])), e["ident"]))
    twys = [(re.sub(r"^(Taxiway|Taxilane|TWY)\s+", "", l["name"], flags=re.I), [_xy(lat0, tuple(pt)) for pt in l["path"]])
            for l in doc.get("lines", [])
            if l.get("kind") == "taxiway" and l.get("name")]
    used = {h["ref"] for h in holds if h.get("ref")}
    out = []
    for h in holds:
        if h.get("ref"):
            out.append(h)
            continue
        p = _xy(lat0, (h["lat"], h["lon"]))
        rwy = None
        if pairs:
            dists = [(_seg_dist(p, a, b), math.dist(p, a), ident) for a, b, ident in pairs]
            best_d = min(d for d, _, _ in dists)
            if best_d < 600:
                # both ends of the nearest runway (a parallel runway is much further away), then the end whose
                # threshold is nearest: the direction the runway is used from this holding point
                rwy = min((x for x in dists if x[0] <= best_d + 40), key=lambda x: x[1])[2]
        twy = None
        best = 120.0  # metres
        for name, path in twys:
            d = min((_seg_dist(p, path[i], path[i + 1]) for i in range(len(path) - 1)), default=1e9)
            if d < best:
                best, twy = d, name
        if not twy:
            out.append(h)  # no taxiway next to it: left unnamed (the runway guessed from the map was unreliable)
            continue
        # Pas de « (2) » : base seule, puis base-2, base-3… (lisible et unique)
        base = re.sub(r"\s*\(\d+\)\s*$", "", twy[:16]).strip() or twy[:16]
        ref, n = base, 2
        while ref in used:
            ref, n = f"{base}-{n}", n + 1
        used.add(ref)
        out.append({**h, "ref": ref, "auto": True})
    return {**doc, "holdings": out}


async def get_ground(icao: str, refresh: bool = False, user: dict | None = None) -> dict:
    return name_holdings(icao.upper(), await _get_ground(icao, refresh, user))


async def _get_ground(icao: str, refresh: bool = False, user: dict | None = None) -> dict:
    icao = icao.upper()
    lock = _locks.setdefault(icao, asyncio.Lock())
    async with lock:
        old = None if refresh else await db.ground.find_one({"icao": icao}, {"_id": 0})
        if old and old.get("version", 1) >= GROUND_VERSION:
            return old
        name, lat, lon = await _airport_ref(icao)
        if not old:
            _quota(user)
        try:
            async with _fetch_slots:
                raw, bbox = await _fetch_raw(icao, lat, lon)
        except HTTPException:
            if old:  # Overpass busy: keep serving the previous version rather than failing
                return old
            raise
        built = build_ground(raw, bbox)
        if not built["nodes"]:
            if old:
                return old
            raise HTTPException(404, f"Aucune voie de circulation n'est cartographiée dans OpenStreetMap pour {icao}.")
        doc = {"icao": icao, "name": name, "lat": lat, "lon": lon, "fetched_at": utcnow(), "version": GROUND_VERSION,
               "bbox": list(bbox), "source": "OpenStreetMap", **built}
        await db.ground.replace_one({"icao": icao}, doc, upsert=True)
        _graphs.pop(icao, None)
        return doc


async def get_graph(icao: str) -> Graph:
    icao = icao.upper()
    if icao not in _graphs:
        _graphs[icao] = Graph(await get_ground(icao))
    return _graphs[icao]


def gate_ref(g: Graph, ref: str | None) -> dict | None:
    if not ref:
        return None
    if ref not in g.gates:
        raise HTTPException(400, f"Poste de stationnement {ref} inconnu sur cet aéroport.")
    s = g.gates[ref]
    return {"ref": ref, "lat": s["lat"], "lon": s["lon"], "hdg": s.get("hdg")}


async def build_taxi_path(icao: str, points: list[list[float]], start_gate: str | None, end_gate: str | None,
                          origin: tuple[float, float] | None = None, orient_from: tuple[float, float] | None = None) -> dict:
    """Route along real taxiways: [start gate | aircraft] -> clicked points (snapped) -> [end gate].
    `origin` (arrival taxi): the aircraft's position. The route always runs from the aircraft towards the stand,
    whatever order the points were clicked in, and starts at the aircraft when it is already on the ground.
    `orient_from` (aircraft still airborne): only used to put the clicked points in the aircraft -> stand order."""
    g = await get_graph(icao)
    stops: list[int] = []
    head: list[tuple[float, float]] = []
    tail: list[tuple[float, float]] = []
    ref = origin or orient_from
    if ref and len(points) >= 2 and haversine_nm(ref[0], ref[1], *points[-1][:2]) < haversine_nm(ref[0], ref[1], *points[0][:2]):
        points = list(reversed(points))
    if origin:
        head = [(origin[0], origin[1])]
        stops.append(g.nearest(origin[0], origin[1]))
    if start_gate:
        s = g.gates.get(start_gate)
        if s:
            head = [(s["lat"], s["lon"])]
            stops.append(g.gate_node(start_gate))
    for lat, lon in points:
        n = g.nearest(lat, lon)
        if not stops or stops[-1] != n:
            stops.append(n)
    if end_gate:
        s = g.gates.get(end_gate)
        if s:
            stops.append(g.gate_node(end_gate))
            tail = [(s["lat"], s["lon"])]
    if len(stops) < 2:
        raise HTTPException(400, "Cliquez au moins un point de destination sur les voies de circulation.")
    seq = [stops[0]]
    for a, b in zip(stops, stops[1:]):
        seq += g.shortest(a, b)[1:]
    pts = head + [g.coords[n] for n in seq] + tail
    seg = (["Stand" if not origin else ""] if head else []) + [g.edge_name(a, b) for a, b in zip(seq, seq[1:])] + (["Stand"] if tail else [])
    names: list[str] = []
    for n in seg:
        if n and (not names or names[-1] != n):
            names.append(n)
    return {"airport": icao, "path": [list(p) for p in pts], "seg_names": seg, "names": names,
            "length_nm": round(cumulative(pts)[-1], 3)}


# ---------- rejected take-off: vacate the runway by a chosen taxiway ----------

def runway_exits(g: "Graph", rwy: dict, lat: float, lon: float, allow_behind: bool = True) -> list[dict]:
    """Taxiways leaving this runway, nearest first.
    `allow_behind=True` (défaut) : sorties derrière l'avion acceptées (arrivée / remise en position).
    """
    from lib.runways import project_on_runway
    k = math.cos(math.radians(lat))
    hx, hy = math.sin(math.radians(rwy["hdg"])), math.cos(math.radians(rwy["hdg"]))
    out: dict[int, dict] = {}
    for n, (la, lo) in g.coords.items():
        if not any(g.kind.get((n, v)) == "runway" for v, _, _ in g.adj[n]) or \
                haversine_nm(la, lo, *project_on_runway(rwy, la, lo)) > 0.05:
            continue  # not on this runway's centreline (as drawn on the map)
        names = [nm for v, _, nm in g.adj[n] if g.kind.get((n, v)) != "runway"]
        if not names:
            continue
        along = ((lo - lon) * k * hx + (la - lat) * hy) * 60.0  # NM along the take-off direction
        if not allow_behind and along < -0.03:
            continue  # behind the aircraft (rejected take-off: only forward exits)
        name = next((x for x in names if x), "") or "Sortie"
        # strip legacy « (2) » suffixes from OSM-derived names
        name = re.sub(r"\s*\(\d+\)\s*$", "", name).strip() or name
        out[n] = {
            "node": n, "name": name, "lat": la, "lon": lo,
            "dist_m": round(along * 1852),  # négatif = derrière
            "behind": along < -0.03,
        }
    return sorted(out.values(), key=lambda e: abs(e["dist_m"]))


def vacate_path(g: "Graph", icao: str, origin: tuple[float, float], exit_node: int, target_node: int,
                tail: tuple[float, float] | None = None) -> dict:
    """Aircraft on the runway -> along the runway to the chosen exit -> taxiways -> target node (+ stand point)."""
    o = g.nearest(*origin)
    seq = g.shortest(o, exit_node)
    seq += g.shortest(exit_node, target_node)[1:]
    pts = [origin] + [g.coords[n] for n in seq] + ([tail] if tail else [])
    seg = [""] + [g.edge_name(a, b) for a, b in zip(seq, seq[1:])] + (["Stand"] if tail else [])
    names: list[str] = []
    for n in seg:
        if n and (not names or names[-1] != n):
            names.append(n)
    return {"airport": icao, "path": [list(p) for p in pts], "seg_names": seg, "names": names,
            "length_nm": round(cumulative(pts)[-1], 3), "points": [], "rejected": True}
