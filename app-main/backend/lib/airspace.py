"""Airspace boundaries from the VATSIM community datasets (CC BY-SA 4.0, simulation use only):
- VATSpy Data Project: FIR / centre sector boundaries + names + callsign prefixes
- SimAware TRACON Project: approach (TRACON) boundaries + callsign prefixes
Files are bundled in backend/data/vatsim (refresh by re-downloading them; see docs/DEPLOIEMENT.md)."""

import json
from functools import lru_cache
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "data" / "vatsim"
ATTRIBUTION = "Secteurs © VATSpy Data Project & SimAware TRACON Project (VATSIM, CC BY-SA 4.0) — simulation uniquement"


def _bbox(geom: dict) -> tuple[float, float, float, float]:
    xs, ys = [], []

    def walk(c):
        if isinstance(c[0], (int, float)):
            xs.append(c[0])
            ys.append(c[1])
        else:
            for x in c:
                walk(x)
    walk(geom["coordinates"])
    return min(ys), min(xs), max(ys), max(xs)


def _round(c):
    return [round(c[0], 3), round(c[1], 3)] if isinstance(c[0], (int, float)) else [_round(x) for x in c]


@lru_cache(maxsize=1)
def fir_names() -> dict[str, dict]:
    """boundary id -> {name, prefixes} from VATSpy.dat [FIRs]."""
    out: dict[str, dict] = {}
    section = None
    for line in (DATA / "VATSpy.dat").read_text(encoding="utf-8", errors="ignore").splitlines():
        if line.startswith("["):
            section = line.strip()
            continue
        if section != "[FIRs]" or not line or line.startswith(";"):
            continue
        parts = line.split("|")
        if len(parts) < 4:
            continue
        icao, name, prefix, boundary = parts[0], parts[1], parts[2], parts[3] or parts[0]
        e = out.setdefault(boundary, {"name": name, "prefixes": set()})
        e["prefixes"].update(p for p in (icao, prefix) if p)
    return out


@lru_cache(maxsize=1)
def _overrides() -> dict[str, dict]:
    """Corrected shapes (france_fir.geojson, built by scripts/build_france_fir.py): the 5 French centres side by side,
    without the overlaps of the raw VATSpy data."""
    try:
        raw = json.loads((DATA / "france_fir.geojson").read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    return {str(f["properties"]["id"]): f["geometry"] for f in raw.get("features", [])}


@lru_cache(maxsize=2)
def features(kind: str) -> list[dict]:
    fname = "Boundaries.geojson" if kind == "fir" else "TRACONBoundaries.geojson"
    raw = json.loads((DATA / fname).read_text(encoding="utf-8"))
    names = fir_names() if kind == "fir" else {}
    fixed = _overrides() if kind == "fir" else {}
    ids = {str((f.get("properties") or {}).get("id", "")) for f in raw.get("features", [])}
    out = []
    for f in raw.get("features", []):
        p, g = f.get("properties") or {}, f.get("geometry")
        if not g or not g.get("coordinates"):
            continue
        fid = str(p.get("id", ""))
        g = fixed.get(fid, g)
        if kind == "fir":
            meta = names.get(fid, {})
            name, prefixes = meta.get("name") or fid, sorted(meta.get("prefixes") or {fid})
            if p.get("oceanic") == "1":
                name += " (océanique)"
        else:
            name, prefixes = p.get("name") or fid, list(p.get("prefix") or [])
        # « LFFF-AENB », « LFRR-EST »…: sub-sectors of a centre that also exists as a whole -> not drawn (they overlap it)
        sub = kind == "fir" and "-" in fid and fid.split("-", 1)[0] in ids
        out.append({
            "type": "Feature", "bbox": _bbox(g), "sub": sub,
            "geometry": {"type": g["type"], "coordinates": _round(g["coordinates"])},
            "properties": {"id": fid, "name": name, "kind": kind, "prefixes": prefixes},
        })
    return out


def in_bbox(kind: str, s: float, w: float, n: float, e: float, limit: int = 400) -> list[dict]:
    res = []
    for f in features(kind):
        bs, bw, bn, be = f["bbox"]
        if f["sub"] or bn < s or bs > n or be < w or bw > e:
            continue
        res.append({k: v for k, v in f.items() if k not in ("bbox", "sub")})
        if len(res) >= limit:
            break
    return res


def match(kind: str, prefix: str) -> dict | None:
    """Boundary whose callsign prefixes contain `prefix` (e.g. LFFF / PAR for CTR, LFPG for APP)."""
    prefix = prefix.upper()
    exact = next((f for f in features(kind) if f["properties"]["id"].upper() == prefix), None)
    if exact:
        return exact  # « LFFF » is the whole Paris centre, never one of its sub-sectors
    for f in sorted(features(kind), key=lambda f: f["sub"]):
        if prefix in f["properties"]["prefixes"] or f["properties"]["id"].upper() == prefix:
            return f
    return None
