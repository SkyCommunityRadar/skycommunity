"""Builds data/vatsim/france_fir.geojson: the 5 French centres (LFFF Paris, LFEE Reims, LFRR Brest, LFBB Bordeaux,
LFMM Marseille) as touching, NON-overlapping areas (lower airspace), like the official map of the French FIRs.

The VATSpy boundaries mix lower and upper sectors (e.g. the « LFFF » shape also covers all of Reims, Brest's upper
sector covers half of Paris). Run once after refreshing the VATSIM data (needs `shapely`, only for this script):
    python scripts/build_france_fir.py
"""

import json
import sys
from pathlib import Path

from shapely.geometry import mapping, shape
from shapely.ops import unary_union

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from lib import airspace  # noqa: E402

raw = json.loads((airspace.DATA / "Boundaries.geojson").read_text(encoding="utf-8"))
F = {str(f["properties"]["id"]): shape(f["geometry"]) for f in raw["features"] if str(f["properties"].get("id", "")).startswith("LF")}

paris = F["LFFF-LOW"]                       # Paris lower airspace (north + centre, Lille to Bourges)
reims = F["LFEE-4EH"] - paris               # Reims: north-east (Champagne, Lorraine, Alsace)
brest = F["LFRR"] - paris - reims           # Brest: west, without its upper sector over Paris
bordeaux = F["LFBB"] - paris - reims - brest
marseille = F["LFMM"] - paris - reims - brest - bordeaux
# the small hole left between the Paris and Reims shapes (Langres / Vosges plateau) goes to Reims
whole = unary_union([F[i] for i in ("LFFF", "LFEE", "LFRR", "LFBB", "LFMM")])
reims = unary_union([reims, whole - unary_union([paris, reims, brest, bordeaux, marseille])])

out = {"type": "FeatureCollection", "features": []}
for fid, geom in (("LFFF", paris), ("LFEE", reims), ("LFRR", brest), ("LFBB", bordeaux), ("LFMM", marseille)):
    geom = geom.buffer(0)
    parts = [g for g in getattr(geom, "geoms", [geom]) if g.area > 0.005]  # drop slivers
    geom = unary_union(parts)
    out["features"].append({"type": "Feature", "properties": {"id": fid}, "geometry": mapping(geom)})
    print(fid, round(geom.area, 2), [round(c, 2) for c in geom.bounds])
(airspace.DATA / "france_fir.geojson").write_text(json.dumps(out), encoding="utf-8")
