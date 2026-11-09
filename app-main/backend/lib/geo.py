"""Great-circle helpers used by the progression engine (pure functions, no I/O)."""

import math
from bisect import bisect_right

R_NM = 3440.065


def haversine_nm(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R_NM * math.asin(min(1.0, math.sqrt(a)))


def bearing_deg(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def gc_interpolate(lat1: float, lon1: float, lat2: float, lon2: float, f: float) -> tuple[float, float]:
    d = haversine_nm(lat1, lon1, lat2, lon2) / R_NM
    if d < 1e-9:
        return lat1, lon1
    p1, l1, p2, l2 = map(math.radians, (lat1, lon1, lat2, lon2))
    a = math.sin((1 - f) * d) / math.sin(d)
    b = math.sin(f * d) / math.sin(d)
    x = a * math.cos(p1) * math.cos(l1) + b * math.cos(p2) * math.cos(l2)
    y = a * math.cos(p1) * math.sin(l1) + b * math.cos(p2) * math.sin(l2)
    z = a * math.sin(p1) + b * math.sin(p2)
    return math.degrees(math.atan2(z, math.hypot(x, y))), math.degrees(math.atan2(y, x))


def cumulative(points: list[tuple[float, float]]) -> list[float]:
    out = [0.0]
    for a, b in zip(points, points[1:]):
        out.append(out[-1] + haversine_nm(a[0], a[1], b[0], b[1]))
    return out


def locate(points: list[tuple[float, float]], cum: list[float], d: float) -> tuple[float, float, float, int]:
    """Position at along-track distance d. Returns (lat, lon, heading, index of last point passed)."""
    n = len(points)
    if n == 1:
        return points[0][0], points[0][1], 0.0, 0
    d = max(0.0, min(d, cum[-1]))
    i = min(bisect_right(cum, d) - 1, n - 2)
    seg = cum[i + 1] - cum[i]
    f = (d - cum[i]) / seg if seg > 0 else 0.0
    lat, lon = gc_interpolate(points[i][0], points[i][1], points[i + 1][0], points[i + 1][1], f)
    hdg = bearing_deg(points[i][0], points[i][1], points[i + 1][0], points[i + 1][1])
    passed = n - 1 if d >= cum[-1] else i
    return lat, lon, hdg, passed


def project(points: list[tuple[float, float]], cum: list[float], lat: float, lon: float) -> float:
    """Along-track distance of the point on the polyline closest to (lat, lon)."""
    if len(points) < 2:
        return 0.0
    kx = math.cos(math.radians(lat))
    best, best_d = float("inf"), 0.0
    for i in range(len(points) - 1):
        ax, ay = (points[i][1] - lon) * kx, points[i][0] - lat
        bx, by = (points[i + 1][1] - lon) * kx, points[i + 1][0] - lat
        vx, vy = bx - ax, by - ay
        vv = vx * vx + vy * vy
        t = 0.0 if vv == 0 else max(0.0, min(1.0, -(ax * vx + ay * vy) / vv))
        px, py = ax + t * vx, ay + t * vy
        dist = px * px + py * py
        if dist < best:
            best, best_d = dist, cum[i] + t * (cum[i + 1] - cum[i])
    return best_d


def interp(xs: list[float], ys: list[float], x: float) -> float:
    """Piecewise-linear interpolation, clamped at both ends."""
    if x <= xs[0]:
        return ys[0]
    if x >= xs[-1]:
        return ys[-1]
    i = bisect_right(xs, x) - 1
    span = xs[i + 1] - xs[i]
    return ys[i] if span <= 0 else ys[i] + (ys[i + 1] - ys[i]) * (x - xs[i]) / span
