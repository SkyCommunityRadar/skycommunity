"""Idempotent setup: database indexes + cleanup of legacy demonstration data.

There is no local administrator account any more: every account (administrators and the Créateur included)
signs in with Discord, and the Discord roles decide the access (lib/discord_roles.py).

Usage:
  python seed.py
"""

import asyncio
import os
import sys

from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

from lib.db import db, ensure_indexes  # noqa: E402


async def main(args: list[str]) -> None:
    await ensure_indexes()
    # legacy demonstration data
    demo_ids = [u["id"] async for u in db.users.find({"is_demo": True}, {"id": 1})]
    r1 = await db.flights.delete_many({"$or": [{"source": "demo"}, {"pilot_id": {"$in": demo_ids}}]})
    r2 = await db.users.delete_many({"is_demo": True})
    await db.users.update_many({}, {"$unset": {"is_demo": "", "role": ""}})
    await db.airports.drop()
    print(f"removed {r1.deleted_count} demo flights, {r2.deleted_count} demo users, fictitious airports")


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1:]))
