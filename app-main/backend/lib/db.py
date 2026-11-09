"""Shared Mongo handle — import `client`/`db` from here (server.py, routers, seed.py)."""

import logging
import os
from pathlib import Path

from dotenv import load_dotenv
from motor.motor_asyncio import AsyncIOMotorClient
from pymongo import ASCENDING, DESCENDING, IndexModel

load_dotenv(Path(__file__).parent.parent / ".env")

mongo_url = os.environ["MONGO_URL"]
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ["DB_NAME"]]

logger = logging.getLogger(__name__)

# One entry per collection: every field a route filters, sorts, or dedupes on. Applied by ensure_indexes() at startup.
INDEXES: dict[str, list[IndexModel]] = {
    "users": [
        IndexModel([("id", ASCENDING)], name="id", unique=True),
        IndexModel([("email", ASCENDING)], name="email_unique", unique=True,
                   partialFilterExpression={"email": {"$type": "string"}}),
        IndexModel([("discord_id", ASCENDING)], name="discord_id", unique=True,
                   partialFilterExpression={"discord_id": {"$type": "string"}}),
    ],
    "flights": [
        IndexModel([("id", ASCENDING)], name="id", unique=True),
        IndexModel([("phase", ASCENDING), ("updated_at", DESCENDING)], name="phase_updated"),
        IndexModel([("pilot_id", ASCENDING), ("updated_at", DESCENDING)], name="pilot_updated"),
        IndexModel([("callsign", ASCENDING), ("phase", ASCENDING)], name="callsign_phase"),
    ],
    "events": [
        IndexModel([("flight_id", ASCENDING), ("at", DESCENDING)], name="flight_at"),
        IndexModel([("at", DESCENDING)], name="at_desc"),
    ],
    "password_resets": [
        IndexModel([("hash", ASCENDING)], name="hash", unique=True),
        IndexModel([("expires_at", ASCENDING)], name="ttl", expireAfterSeconds=0),
    ],
    "oauth_states": [
        IndexModel([("state", ASCENDING)], name="state", unique=True),
        IndexModel([("expires_at", ASCENDING)], name="ttl", expireAfterSeconds=0),
    ],
    "reviews": [
        IndexModel([("id", ASCENDING)], name="id", unique=True),
        IndexModel([("author_id", ASCENDING), ("flight_id", ASCENDING), ("target_id", ASCENDING)], name="one_per_interaction", unique=True),
        IndexModel([("target_id", ASCENDING), ("status", ASCENDING)], name="target_status"),
    ],
    "revoked_tokens": [
        IndexModel([("jti", ASCENDING)], name="jti", unique=True),
        IndexModel([("exp", ASCENDING)], name="ttl", expireAfterSeconds=0),
    ],
    "atc_positions": [  # several positions per controller (APP + TWR + GND on one airport)
        IndexModel([("user_id", ASCENDING)], name="user_multi"),
        IndexModel([("callsign", ASCENDING)], name="callsign"),
        IndexModel([("airport", ASCENDING), ("type", ASCENDING)], name="airport_type"),
        IndexModel([("last_seen", ASCENDING)], name="last_seen"),
    ],
    "atc_handovers": [
        IndexModel([("id", ASCENDING)], name="id", unique=True),
        IndexModel([("airport", ASCENDING), ("position", ASCENDING)], name="airport_position", unique=True),
        IndexModel([("to_user_id", ASCENDING)], name="to_user"),
    ],
    "frequencies": [IndexModel([("key", ASCENDING)], name="key", unique=True)],
    "planning": [
        IndexModel([("id", ASCENDING)], name="id", unique=True),
        IndexModel([("date", ASCENDING), ("start", ASCENDING)], name="date_start"),
        IndexModel([("callsign", ASCENDING), ("date", ASCENDING)], name="callsign_date"),
        IndexModel([("user_id", ASCENDING), ("date", ASCENDING)], name="user_date"),
    ],
    "planning_requests": [
        IndexModel([("id", ASCENDING)], name="id", unique=True),
        IndexModel([("slot_id", ASCENDING), ("status", ASCENDING)], name="slot_status"),
        IndexModel([("status", ASCENDING), ("requested_at", DESCENDING)], name="status_at"),
    ],
    "bot_outbox": [
        IndexModel([("id", ASCENDING)], name="id", unique=True),
        IndexModel([("sent_at", ASCENDING), ("created_at", ASCENDING)], name="pending"),
        IndexModel([("created_at", ASCENDING)], name="ttl", expireAfterSeconds=30 * 86400),
    ],
    "absences": [
        IndexModel([("id", ASCENDING)], name="id", unique=True),
        IndexModel([("user_id", ASCENDING), ("created_at", DESCENDING)], name="user_created"),
        IndexModel([("kinds", ASCENDING), ("status", ASCENDING), ("start", ASCENDING)], name="kind_status_start"),
    ],
    "preopenings": [
        IndexModel([("id", ASCENDING)], name="id", unique=True),
        IndexModel([("status", ASCENDING), ("start_at", ASCENDING)], name="status_start"),
        IndexModel([("user_id", ASCENDING), ("status", ASCENDING)], name="user_status"),
    ],
    "ground": [IndexModel([("icao", ASCENDING)], name="icao", unique=True)],
    "simbrief_drafts": [
        IndexModel([("id", ASCENDING)], name="id", unique=True),
        IndexModel([("created_at", ASCENDING)], name="ttl", expireAfterSeconds=3600),
    ],
}


async def ensure_indexes() -> None:
    # migration: the « Prêt au départ » phase no longer exists -> back to « Préparation »
    try:
        await db.flights.update_many({"phase": "pret_depart"}, {"$set": {"phase": "preparation"}})
        await db.flights.update_many({"prev_phase": "pret_depart"}, {"$set": {"prev_phase": "preparation"}})
    except Exception as exc:
        logger.error("migration pret_depart: %s", exc)
    # migration: one controller used to hold a single position (unique index "user") — now several are allowed
    try:
        if "user" in await db.atc_positions.index_information():
            await db.atc_positions.drop_index("user")
    except Exception as exc:
        logger.error("drop atc_positions.user: %s", exc)
    for collection, models in INDEXES.items():
        for model in models:  # one at a time so a bad spec skips only itself
            try:
                await db[collection].create_indexes([model])
            except Exception as exc:  # never block boot on an index; the log line names what to fix
                logger.error("ensure_indexes(%s.%s): %s", collection, model.document["name"], exc)
