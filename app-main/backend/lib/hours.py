"""Flight hours counted for the ranking and the profiles.

Real block time (off the stand -> on the stand), but never more than the flight planned by SimBrief plus a margin:
moving one's aircraft back on its route again and again (or leaving a flight running) cannot inflate the hours.
Margin: +20 % of the planned flight time, +20 min (taxi, waiting at the holding point), + the time spent in holds.
"""

from lib.engine import aware

MARGIN = 1.20
GROUND_ALLOWANCE_S = 20 * 60
MAX_S = 24 * 3600
# projection to read only what is needed (the last waypoint carries the planned flight time)
PROJECTION = {"route": {"$slice": -1}, "hold_s": 1}


def allowed_seconds(f: dict) -> float:
    route = f.get("route") or []
    planned = float((route[-1] if route else {}).get("cum_s") or 0)
    if planned <= 0:
        return MAX_S
    return min(MAX_S, planned * MARGIN + GROUND_ALLOWANCE_S + float(f.get("hold_s") or 0))


def counted_hours(f: dict) -> float:
    off, on = aware(f.get("block_off_at")), aware(f.get("block_on_at"))
    if not off or not on:
        return 0.0
    real = max(0.0, (on - off).total_seconds())
    return min(real, allowed_seconds(f)) / 3600
