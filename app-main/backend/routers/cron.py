"""Platform cron endpoints (.emergent/crons.yml). Authenticated by WEBHOOK_CRON_SECRET only."""

import asyncio
import hmac
import logging
import os
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, HTTPException, Request

from lib.db import db
from lib.engine import utcnow

router = APIRouter(prefix="/cron", tags=["cron"])
log = logging.getLogger("cron")
SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "backup.sh"


def _check(request: Request) -> None:
    secret = os.environ.get("WEBHOOK_CRON_SECRET", "")
    auth = request.headers.get("authorization", "")
    token = auth[7:] if auth.lower().startswith("bearer ") else ""
    if not secret or not token or not hmac.compare_digest(token.encode(), secret.encode()):
        raise HTTPException(401, "Unauthorized")


async def _run_backup(run_id: str) -> None:
    proc = await asyncio.create_subprocess_exec("bash", str(SCRIPT), stdout=asyncio.subprocess.PIPE,
                                                stderr=asyncio.subprocess.PIPE)
    out, err = await proc.communicate()
    ok = proc.returncode == 0
    await db.cron_runs.update_one({"run_id": run_id}, {"$set": {
        "status": "ok" if ok else "error", "finished_at": utcnow(),
        "file": out.decode().strip()[-200:] if ok else None, "error": None if ok else err.decode()[-300:]}})
    (log.info if ok else log.error)("backup %s: %s", run_id, "ok" if ok else err.decode()[-300:])


@router.post("/backup", status_code=202)
async def backup(request: Request, tasks: BackgroundTasks):
    # Cron endpoints must ack 2xx immediately; enqueue/background the actual work.
    _check(request)
    try:
        body = await request.json()
    except ValueError:
        body = {}
    if not isinstance(body, dict):
        raise HTTPException(400, "Invalid body")
    run_id = request.headers.get("x-webhook-id") or body.get("run_id") or f"manual-{utcnow().isoformat()}"
    res = await db.cron_runs.update_one({"run_id": run_id}, {"$setOnInsert": {
        "run_id": run_id, "job": "backup", "status": "queued", "queued_at": utcnow()}}, upsert=True)
    if res.upserted_id is not None:  # idempotent: a duplicate delivery does not start a second backup
        tasks.add_task(_run_backup, run_id)
    return {"accepted": True, "run_id": run_id}
