"""Ranking: weighted score from real server data only (block times, ATC time, activity, moderated reviews)."""

from datetime import timedelta

from fastapi import APIRouter, Depends

from lib.auth import current_user
from lib.db import db
from lib.engine import aware, utcnow
from lib.hours import PROJECTION as HOURS_PROJECTION, counted_hours
from models.schemas import Leaderboard, LeaderEntry
from routers.common import avatar_url

router = APIRouter(prefix="/leaderboard", tags=["leaderboard"])

# Levels (min_hours, name), kept server-side so they can change without rebuilding the ranking.
LEVELS: list[tuple[float, str]] = [(0, "Pilote"), (10, "Pilote confirmé"), (50, "Commandant"), (150, "Instructeur"), (400, "Légende")]
# Controllers have their own titles (they used to receive the pilot ones, e.g. « Pilote confirmé »).
LEVELS_ATC: list[tuple[float, str]] = [(0, "Contrôleur"), (10, "Contrôleur confirmé"), (50, "Contrôleur senior"),
                                        (150, "Instructeur ATC"), (400, "Légende")]


def level_for(hours: float, levels: list[tuple[float, str]] | None = None) -> str | None:
    name = None
    for th, n in sorted(levels or LEVELS):
        if hours >= th:
            name = n
    return name


def score(hours: float, flights: int, active_days: int, rating: float | None, reviews: int) -> float:
    """Hours dominate; activity rewards regularity; the rating only weighs once several reviews exist
    (capped at 10) so a single 5/5 cannot manipulate the ranking."""
    r = ((rating or 3.0) - 3.0) * min(reviews, 10) * 2.0
    return round(hours * 10 + flights * 4 + active_days * 3 + r, 1)


def _rank(rows: list[dict], levels: list[tuple[float, str]] | None = None) -> list[LeaderEntry]:
    rows = sorted([r for r in rows if r["hours"] > 0 or r["flights"] > 0], key=lambda r: -r["score"])[:100]
    return [LeaderEntry(rank=i + 1, stars=min(5, int(r["hours"] // 10)), level=level_for(r["hours"], levels), **r)
            for i, r in enumerate(rows)]


@router.get("", response_model=Leaderboard)
async def leaderboard(user: dict = Depends(current_user)):
    since = utcnow() - timedelta(days=30)
    agg: dict[str, dict] = {}
    async for f in db.flights.find({"block_off_at": {"$ne": None}},
                                   {"_id": 0, "pilot_id": 1, "block_off_at": 1, "block_on_at": 1, "phase": 1, **HOURS_PROJECTION}):
        a = agg.setdefault(f["pilot_id"], {"hours": 0.0, "flights": 0, "days": set()})
        off, on = aware(f["block_off_at"]), aware(f.get("block_on_at"))
        if on:
            a["hours"] += counted_hours(f)  # capped to the planned flight + margin (lib/hours)
            a["flights"] += 1
        if off >= since:
            a["days"].add(off.date())
    ratings: dict[str, list[int]] = {}
    async for r in db.reviews.find({"status": "accepted"}, {"_id": 0, "target_id": 1, "target_role": 1, "rating": 1}):
        ratings.setdefault(f"{r['target_role']}:{r['target_id']}", []).append(r["rating"])
    users = {u["id"]: u async for u in db.users.find({}, {"_id": 0, "id": 1, "display_name": 1, "discord_id": 1,
                                                          "avatar": 1, "atc_seconds": 1})}

    def row(uid: str, hours: float, flights: int, days: int, role: str) -> dict:
        rs = ratings.get(f"{role}:{uid}", [])
        rating = round(sum(rs) / len(rs), 2) if rs else None
        u = users.get(uid, {})
        return dict(user_id=uid, name=u.get("display_name", "?"), avatar_url=avatar_url(u), hours=round(hours, 1),
                    flights=flights, active_days_30=days, rating=rating, reviews=len(rs),
                    score=score(hours, flights, days, rating, len(rs)))

    pilots = [row(uid, a["hours"], a["flights"], len(a["days"]), "pilote") for uid, a in agg.items()]
    atc = [row(uid, u.get("atc_seconds", 0) / 3600, 0, 0, "atc") for uid, u in users.items() if u.get("atc_seconds", 0) > 0]
    return Leaderboard(pilots=_rank(pilots), atc=_rank(atc, LEVELS_ATC))
