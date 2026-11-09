"""SkyCommunity ATC positions: APP / TWR / GND on an airport (mandatory order APP -> TWR -> GND, one controller may
hold several on the same airport) or CTR on a centre. Pre-recorded frequencies, handover (relève) + airspace layers."""

import uuid
from datetime import timedelta, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query

from pydantic import BaseModel, Field

from lib import airspace
from lib.auth import is_atc_lead, require
from lib.discord_roles import access_of
from lib.bot import handled, notify
from lib.control import AIRPORT_ORDER, ONLINE_S
from lib.db import db
from lib.engine import aware, utcnow
from lib.events import log_event
from lib.handover import accept_handover, close_positions, handover_out, preset_frequency, remember_frequency
from lib import discord_bot_client
from models.schemas import AirspaceResponse, AtcPosition, AtcPositionIn, FrequencyInfo, Handover, Preopening, PreopeningIn
from routers.airports import ref_lookup

router = APIRouter(tags=["atc"])
RADIUS_NM = {"GND": 3.0, "TWR": 8.0, "APP": 30.0, "CTR": 0.0}
POS_FR = {"APP": "Approche", "TWR": "Tour", "GND": "Sol", "CTR": "Centre"}


def _out(d: dict) -> AtcPosition:
    return AtcPosition(**{k: d.get(k) for k in AtcPosition.model_fields if k not in ("opened_at", "last_seen")},
                       opened_at=aware(d["opened_at"]), last_seen=aware(d["last_seen"]))


async def heartbeat(user: dict, now) -> None:
    """Radar polling keeps every position of this controller alive."""
    await db.atc_positions.update_many({"user_id": user["id"]}, {"$set": {"last_seen": now}})


async def _online(now) -> list[dict]:
    since = now - timedelta(seconds=ONLINE_S)
    return await db.atc_positions.find({"last_seen": {"$gte": since}}, {"_id": 0}).to_list(500)


def _center(icao: str) -> dict | None:
    return airspace.match("fir", icao)


@router.get("/atc/positions", response_model=list[AtcPosition])
async def list_positions(user: dict = Depends(require("flight:read"))):
    docs = sorted(await _online(utcnow()), key=lambda d: d["callsign"])
    return [_out(d) for d in docs]


@router.get("/atc/frequency", response_model=FrequencyInfo)
async def frequency(icao: str = Query(pattern=r"^[A-Za-z0-9]{3,4}$"),
                    position: str = Query(pattern="^(APP|TWR|GND|CTR)$"),
                    user: dict = Depends(require("atc:position"))):
    """Shown in the opening form before validation: pre-recorded frequency + what must be opened first."""
    icao = icao.upper()
    name = None
    if position == "CTR":
        c = _center(icao)
        if not c:
            raise HTTPException(404, f"Aucun centre connu pour {icao}.")
        name = c["properties"]["name"]
    else:
        ref = ref_lookup(icao) if len(icao) == 4 else None
        if not ref:
            raise HTTPException(404, f"Aéroport {icao} inconnu : utilisez son code OACI sur 4 lettres.")
        name = ref[0]
    freq, source = await preset_frequency(icao, position)
    online = await _online(utcnow())
    open_here = sorted({d["type"] for d in online if d.get("airport") == icao}, key=lambda t: AIRPORT_ORDER.index(t))
    missing = [] if position == "CTR" else [t for t in AIRPORT_ORDER[:AIRPORT_ORDER.index(position)] if t not in open_here]
    return FrequencyInfo(icao=icao, position=position, frequency=freq, source=source, name=name,
                         open_positions=open_here, missing_before=missing)


@router.post("/atc/positions", response_model=AtcPosition)
async def open_position(body: AtcPositionIn, user: dict = Depends(require("atc:position"))):
    icao = body.icao.strip().upper()
    kind = "CTR" if body.kind == "center" else body.position
    if not kind:
        raise HTTPException(422, "Choisissez la position à ouvrir : APP, TWR ou GND.")
    now = utcnow()
    online = await _online(now)
    mine = [d for d in online if d["user_id"] == user["id"]]
    # Une seule fréquence / position ouverte à la fois (aligné sur le bot Discord)
    if mine:
        raise HTTPException(
            409,
            "Vous avez déjà une fréquence ouverte ("
            + ", ".join(d["callsign"] for d in mine)
            + "). Fermez-la avant d'en ouvrir une autre.",
        )
    cs = f"{icao}_{kind}"
    taken = next((d for d in online if d["callsign"] == cs), None)
    if taken:
        if taken["user_id"] == user["id"]:
            raise HTTPException(409, f"Vous avez déjà ouvert {cs}.")
        raise HTTPException(409, f"La position {cs} est déjà ouverte par {taken['controller']}.")
    # a position pre-opened by someone else is reserved for him from 15 min before to 30 min after the announced time
    booked = await db.preopenings.find_one({"callsign": cs, "status": "prevue", "user_id": {"$ne": user["id"]},
                                            "start_at": {"$lte": now + timedelta(minutes=15), "$gte": now - timedelta(minutes=30)}},
                                           {"_id": 0})
    if booked:
        raise HTTPException(409, f"{cs} est réservée : pré-ouverture annoncée par {booked['controller']} à "
                                 f"{aware(booked['start_at']).strftime('%H:%M')} UTC.")
    doc = {"id": str(uuid.uuid4()), "user_id": user["id"], "controller": user["display_name"], "callsign": cs,
           "type": kind, "frequency": None, "airport": None, "lat": None, "lon": None,
           "radius_nm": RADIUS_NM[kind], "fir_id": None, "tracon_id": None, "opened_at": now, "last_seen": now}
    if kind == "CTR":
        if mine:
            raise HTTPException(409, "Un centre (CTR) ne se cumule pas avec une autre position : fermez d'abord "
                                     + ", ".join(d["callsign"] for d in mine) + ".")
        c = _center(icao)
        if not c:
            raise HTTPException(422, f"Aucun centre connu pour {icao} (ex. LFFF, LFMM, EGTT).")
        doc["fir_id"] = c["properties"]["id"]
        s, w, n, e = c["bbox"]
        doc["lat"], doc["lon"] = (s + n) / 2, (w + e) / 2
    else:
        ref = ref_lookup(icao) if len(icao) == 4 else None
        if not ref:
            raise HTTPException(422, f"Aéroport {icao} inconnu : utilisez son code OACI sur 4 lettres (ex. LFPG).")
        other = [d for d in mine if d.get("airport") != icao]
        if other:
            raise HTTPException(409, "Vous ne pouvez cumuler des positions que sur un même aéroport : fermez d'abord "
                                     + ", ".join(d["callsign"] for d in other) + ".")
        here = {d["type"] for d in online if d.get("airport") == icao}
        missing = [t for t in AIRPORT_ORDER[:AIRPORT_ORDER.index(kind)] if t not in here]
        if missing:
            raise HTTPException(409, "Ordre d'ouverture obligatoire APP → TWR → GND : ouvrez d'abord "
                                     + " puis ".join(f"{icao}_{t}" for t in missing) + ".")
        doc["airport"], doc["lat"], doc["lon"] = icao, ref[1], ref[2]
        if kind == "APP":
            t = airspace.match("tracon", icao) or airspace.match("tracon", icao[1:])
            doc["tracon_id"] = t["properties"]["id"] if t else None
    preset, _ = await preset_frequency(icao, kind)
    freq = body.frequency or preset
    if not freq:
        raise HTTPException(422, f"Aucune fréquence enregistrée pour {cs} : saisissez-la.")
    doc["frequency"] = freq
    if body.frequency and body.frequency != preset:
        await remember_frequency(icao, kind, body.frequency, user)

    # Synchronise avec le bot Discord (création des salons vocaux/textuels)
    languages = (body.languages or "🇫🇷 FR").strip() or "🇫🇷 FR"
    doc["languages"] = languages
    discord_id = user.get("discord_id")
    if discord_id:
        bot_freq = await discord_bot_client.open_frequency(
            atc_discord_id=discord_id,
            icao=icao,
            position=kind,
            frequency_mhz=str(freq),
            languages=languages,
        )
        if bot_freq and bot_freq.get("id") is not None:
            doc["discord_freq_id"] = bot_freq["id"]

    await db.atc_positions.insert_one(dict(doc))
    await db.users.update_one({"id": user["id"]}, {"$set": {"atc_last_active": now}})
    await db.atc_handovers.delete_many({"callsign": cs})  # reopened: nothing to take over any more
    await log_event("atc", "Ouverture de position ATC", user, None, f"{cs} {freq}")
    # the controller's own pre-opening of this position is now done
    async for p in db.preopenings.find({"user_id": user["id"], "callsign": cs, "status": "prevue",
                                        "start_at": {"$lte": now + timedelta(minutes=30)}}, {"_id": 0}):
        await db.preopenings.update_one({"id": p["id"]}, {"$set": {"status": "ouverte", "opened_at": now}})
        await log_event("atc", "Pré-ouverture réalisée", user, None,
                        f"{cs} prévue à {aware(p['start_at']).strftime('%H:%M')} UTC, ouverte à {now.strftime('%H:%M')} UTC", scope="atc")
    return _out(doc)


# ---------- pré-ouvertures: a controller announces in advance that he will open a position ----------

PREOPEN_MIN = timedelta(hours=1)
PREOPEN_MAX = timedelta(days=14)


def _pre_out(d: dict, user: dict) -> Preopening:
    req = d.get("cancel_request") or {}
    live = d["status"] == "prevue"
    lead = is_atc_lead(user)
    return Preopening(**{k: d.get(k) for k in Preopening.model_fields
                         if k not in ("start_at", "created_at", "can_cancel", "can_request_cancel", "can_decide",
                                      "cancel_request_at", "cancel_reason")},
                      start_at=aware(d["start_at"]), created_at=aware(d["created_at"]),
                      cancel_request_at=aware(req.get("at")), cancel_reason=req.get("reason"),
                      # Le créateur doit toujours passer par une demande (validation staff)
                      can_cancel=live and lead and d["user_id"] != user["id"],
                      can_request_cancel=live and d["user_id"] == user["id"] and not req,
                      can_decide=live and lead and bool(req))



@router.get("/atc/atis")
async def atis_for_controller(user: dict = Depends(require("flight:read"))):
    """ATIS des aéroports où l'utilisateur contrôle actuellement (bandeau SkyRadar)."""
    from lib.atis_letter import build_atis
    docs = await db.atc_positions.find({"user_id": user["id"]}, {"_id": 0}).to_list(20)
    icaos = []
    for d in docs:
        icao = (d.get("airport") or d.get("icao") or "").upper().strip()
        if not icao and d.get("callsign"):
            icao = str(d["callsign"]).split("_")[0].upper()
        if icao and len(icao) >= 4 and icao not in icaos:
            icaos.append(icao[:4])
    out = []
    for icao in icaos:
        info = await build_atis(icao)
        if info:
            out.append(info)
    return out


@router.get("/atc/atis/{icao}")
async def atis_one(icao: str, user: dict = Depends(require("flight:read"))):
    from lib.atis_letter import build_atis
    info = await build_atis(icao)
    if not info:
        raise HTTPException(404, "ATIS indisponible pour cet aéroport.")
    return info


@router.get("/atc/preopenings", response_model=list[Preopening])
async def list_preopenings(user: dict = Depends(require("flight:read"))):
    since = utcnow() - timedelta(minutes=30)
    docs = await db.preopenings.find({"status": "prevue", "start_at": {"$gte": since}}, {"_id": 0}).sort("start_at", 1).to_list(200)
    return [_pre_out(d, user) for d in docs]


@router.post("/atc/preopenings", response_model=Preopening)
async def create_preopening(body: PreopeningIn, user: dict = Depends(require("atc:position"))):
    now = utcnow()
    start = aware(body.start_at).astimezone(timezone.utc).replace(second=0, microsecond=0)
    if start < now + PREOPEN_MIN - timedelta(seconds=30):
        raise HTTPException(422, "Une pré-ouverture s'annonce au moins 1 heure à l'avance : choisissez une heure plus tardive.")
    if start > now + PREOPEN_MAX:
        raise HTTPException(422, "Une pré-ouverture s'annonce 14 jours à l'avance au maximum.")
    mine = await db.preopenings.find_one({"user_id": user["id"], "status": "prevue", "start_at": {"$gte": now - timedelta(minutes=30)}}, {"_id": 0})
    if mine:
        raise HTTPException(409, f"Vous avez déjà une pré-ouverture prévue ({mine['callsign']} le "
                                 f"{aware(mine['start_at']).strftime('%d/%m à %H:%M')} UTC) : une seule à la fois. "
                                 "Demandez d'abord son annulation au Responsable ATC pour en annoncer une autre.")
    icao = body.icao.strip().upper()
    kind = "CTR" if body.kind == "center" else body.position
    if not kind:
        raise HTTPException(422, "Choisissez la position à pré-ouvrir : APP, TWR ou GND.")
    if kind == "CTR":
        c = _center(icao)
        if not c:
            raise HTTPException(422, f"Aucun centre connu pour {icao} (ex. LFFF, LFMM, EGTT).")
        name = c["properties"]["name"]
    else:
        ref = ref_lookup(icao) if len(icao) == 4 else None
        if not ref:
            raise HTTPException(422, f"Aéroport {icao} inconnu : utilisez son code OACI sur 4 lettres (ex. LFPG).")
        name = ref[0]
    cs = f"{icao}_{kind}"
    clash = await db.preopenings.find_one({"callsign": cs, "status": "prevue", "start_at": {"$gt": start - timedelta(hours=2),
                                                                                         "$lt": start + timedelta(hours=2)}}, {"_id": 0})
    if clash:
        raise HTTPException(409, f"{cs} est déjà pré-ouverte par {clash['controller']} à "
                                 f"{aware(clash['start_at']).strftime('%H:%M')} UTC le {aware(clash['start_at']).strftime('%d/%m')}.")
    freq = body.frequency or (await preset_frequency(icao, kind))[0]
    if not freq:
        raise HTTPException(422, f"Aucune fréquence enregistrée pour {cs} : saisissez-la.")
    languages = (body.languages or "🇫🇷 FR").strip() or "🇫🇷 FR"
    doc = {"id": str(uuid.uuid4()), "user_id": user["id"], "controller": user["display_name"],
           "discord_id": user.get("discord_id"), "callsign": cs, "type": kind,
           "icao": icao, "name": name, "frequency": freq, "languages": languages,
           "start_at": start, "created_at": now, "status": "prevue"}
    await db.preopenings.insert_one(dict(doc))
    when = start.strftime("%d/%m à %H:%M")
    await log_event("atc", "Pré-ouverture de position ATC", user, None, f"{cs} {freq} — {when} UTC", scope="atc")
    # Payload structuré : le bot construit le même embed que Discord (_embed_preopen)
    await notify(
        "preouverture",
        "annonces",
        f"📡 Pré-ouverture ATC : {cs} ({POS_FR[kind]} — {name}) sur {freq}, le {when} UTC, par {user['display_name']}.",
        {
            "id": doc["id"],
            "callsign": cs,
            "icao": icao,
            "position": kind,
            "frequency": freq,
            "languages": languages,
            "start_at": start.isoformat(),
            "hour": when,
            "controller": user["display_name"],
            "discord_id": user.get("discord_id"),
            "name": name,
            "embed": True,
        },
    )
    return _pre_out(doc, user)


class CancelReasonIn(BaseModel):
    reason: str = Field(min_length=3, max_length=300)


class CancelDecisionIn(BaseModel):
    decision: Literal["accept", "refuse"]
    comment: str | None = Field(default=None, max_length=300)


def _lead_actor(user: dict) -> dict:
    return {**user, "role": "admin" if access_of(user)["admin"] else "responsable_atc"}


async def _pending(pre_id: str) -> dict:
    d = await db.preopenings.find_one({"id": pre_id, "status": "prevue"}, {"_id": 0})
    if not d:
        raise HTTPException(404, "Pré-ouverture introuvable (déjà ouverte, annulée ou passée).")
    return d


async def _cancel(d: dict, actor: dict, reason: str, label: str) -> None:
    now = utcnow()
    res = await db.preopenings.update_one({"id": d["id"], "status": "prevue"},
                                          {"$set": {"status": "annulee", "cancelled_by": actor["display_name"],
                                                    "cancelled_at": now, "cancel_reason": reason}})
    if not res.modified_count:
        raise HTTPException(409, "Cette pré-ouverture vient d'être modifiée : rechargez la page.")
    when = aware(d["start_at"]).strftime("%d/%m à %H:%M")
    await log_event("atc", label, actor, None, f"{d['callsign']} du {when} UTC (annoncée par {d['controller']}) — motif : {reason}",
                    scope="atc")
    await notify(
        "preouverture_annulee",
        "annonces",
        f"❌ Pré-ouverture annulée : {d['callsign']} du {when} UTC (annoncée par {d['controller']}).",
        {
            "id": d["id"],
            "callsign": d["callsign"],
            "icao": d.get("icao") or (d["callsign"] or "?").split("_")[0],
            "position": d.get("type") or (d["callsign"] or "?").split("_")[-1],
            "frequency": d.get("frequency"),
            "languages": d.get("languages"),
            "hour": when,
            "controller": d.get("controller") or "—",
            "discord_id": d.get("discord_id"),
            "cancelled_by": actor.get("display_name"),
            "cancel_reason": reason,
            "embed": True,
        },
    )


@router.post("/atc/preopenings/{pre_id}/cancel-request", response_model=Preopening)
async def request_cancel(pre_id: str, body: CancelReasonIn, user: dict = Depends(require("flight:read"))):
    """The controller asks the Responsable ATC to cancel his own pre-opening (reason mandatory)."""
    d = await _pending(pre_id)
    if d["user_id"] != user["id"]:
        raise HTTPException(403, "Vous ne pouvez demander l'annulation que de vos propres pré-ouvertures.")
    if d.get("cancel_request"):
        raise HTTPException(409, "Votre demande d'annulation est déjà envoyée : le Responsable ATC va la traiter.")
    reason = body.reason.strip()
    if len(reason) < 3:
        raise HTTPException(422, "Indiquez le motif de l'annulation.")
    when = aware(d["start_at"]).strftime("%d/%m à %H:%M")
    mid = await notify(
        "preouverture_demande_annulation",
        "validation_atc",
        f"🔔 {user['display_name']} demande l'annulation de sa pré-ouverture {d['callsign']} du {when} UTC. "
        f"Motif : « {reason} ».",
        {
            "id": pre_id,
            "callsign": d["callsign"],
            "icao": d.get("icao") or (d["callsign"] or "?").split("_")[0],
            "position": d.get("type") or (d["callsign"] or "?").split("_")[-1],
            "frequency": d.get("frequency"),
            "hour": when,
            "controller": d.get("controller") or user["display_name"],
            "discord_id": d.get("discord_id") or user.get("discord_id"),
            "reason": reason,
            "embed": True,
        },
        path="/suivi?tab=atc",
    )
    req = {"at": utcnow(), "reason": reason, "alert_id": mid}
    await db.preopenings.update_one({"id": pre_id}, {"$set": {"cancel_request": req}})
    await log_event("atc", "Demande d'annulation de pré-ouverture", user, None, f"{d['callsign']} du {when} UTC — motif : {reason}",
                    scope="atc")
    return _pre_out({**d, "cancel_request": req}, user)


@router.post("/atc/preopenings/{pre_id}/cancel-request/decision", response_model=Preopening)
async def decide_cancel(pre_id: str, body: CancelDecisionIn, user: dict = Depends(require("flight:read"))):
    if not is_atc_lead(user):
        raise HTTPException(403, "Seuls le Responsable ATC et les administrateurs traitent les demandes d'annulation.")
    d = await _pending(pre_id)
    req = d.get("cancel_request")
    if not req:
        raise HTTPException(409, "Aucune demande d'annulation en attente pour cette pré-ouverture.")
    comment = (body.comment or "").strip() or None
    owner = await db.users.find_one({"id": d["user_id"]}, {"_id": 0, "discord_id": 1})
    when = aware(d["start_at"]).strftime("%d/%m à %H:%M")
    if body.decision == "accept":
        await _cancel({**d}, _lead_actor(user), req["reason"], "Annulation de pré-ouverture acceptée")
        dm = f"✅ Ta demande d'annulation de la pré-ouverture {d['callsign']} du {when} UTC a été acceptée par {user['display_name']}."
        d = {**d, "status": "annulee"}
    else:
        await db.preopenings.update_one({"id": pre_id}, {"$unset": {"cancel_request": ""}})
        await log_event("atc", "Annulation de pré-ouverture refusée", _lead_actor(user), None,
                        f"{d['callsign']} du {when} UTC (annoncée par {d['controller']}) — motif demandé : {req['reason']}"
                        + (f" — réponse : {comment}" if comment else ""), scope="atc")
        dm = (f"⛔ Ta demande d'annulation de la pré-ouverture {d['callsign']} du {when} UTC a été refusée par "
              f"{user['display_name']}" + (f" : {comment}" if comment else ".") + " La position reste prévue.")
        d = {k: v for k, v in d.items() if k != "cancel_request"}
    await notify(f"preouverture_annulation_{body.decision}", "membre", dm, {"id": pre_id}, (owner or {}).get("discord_id"))
    await handled(req.get("alert_id"), "validation_atc",
                  f"{'✅' if body.decision == 'accept' else '⛔'} Traitée par {user['display_name']} : annulation de "
                  f"{d['callsign']} du {when} UTC {'acceptée' if body.decision == 'accept' else 'refusée'}.")
    return _pre_out(d, user)


@router.post("/atc/preopenings/{pre_id}/cancel", response_model=Preopening)
async def cancel_preopening(pre_id: str, body: CancelReasonIn, user: dict = Depends(require("flight:read"))):
    """Annulation directe: staff uniquement, et uniquement sur la pré-ouverture d'un AUTRE contrôleur."""
    if not is_atc_lead(user):
        raise HTTPException(403, "Demandez l'annulation au Responsable ATC, avec un motif.")
    d = await _pending(pre_id)
    if d["user_id"] == user["id"]:
        raise HTTPException(
            400,
            "Pour ta propre pré-ouverture, utilise « Demander l'annulation » : un Responsable ATC doit valider.",
        )
    reason = body.reason.strip()
    if len(reason) < 3:
        raise HTTPException(422, "Indiquez le motif de l'annulation.")
    await _cancel(d, _lead_actor(user), reason, "Pré-ouverture annulée par un responsable")
    if (d.get("cancel_request") or {}).get("alert_id"):
        await handled(d["cancel_request"]["alert_id"], "responsables_atc",
                      f"✅ Traitée par {user['display_name']} : pré-ouverture {d['callsign']} annulée.")
    if d["user_id"] != user["id"]:
        owner = await db.users.find_one({"id": d["user_id"]}, {"_id": 0, "discord_id": 1})
        await notify("preouverture_annulee_responsable", "membre",
                     f"❌ Ta pré-ouverture {d['callsign']} du {aware(d['start_at']).strftime('%d/%m à %H:%M')} UTC a été annulée "
                     f"par {user['display_name']}. Motif : {reason}", {"id": pre_id}, (owner or {}).get("discord_id"))
    return _pre_out({**d, "status": "annulee"}, user)


async def expire_preopenings() -> None:
    """A pre-opening not opened within 1 h of its time is recorded as missed."""
    async for p in db.preopenings.find({"status": "prevue", "start_at": {"$lt": utcnow() - timedelta(hours=1)}}, {"_id": 0}):
        res = await db.preopenings.update_one({"id": p["id"], "status": "prevue"}, {"$set": {"status": "expiree"}})
        if res.modified_count:
            await log_event("atc", "Pré-ouverture non réalisée (expirée)", None, None,
                            f"{p['callsign']} prévue le {aware(p['start_at']).strftime('%d/%m à %H:%M')} UTC par {p['controller']}",
                            scope="atc")


@router.delete("/atc/positions/me")
async def close_all_positions(user: dict = Depends(require("atc:position"))):
    docs = await db.atc_positions.find({"user_id": user["id"]}, {"_id": 0}).to_list(10)
    await close_positions(docs, "fermeture", user)
    return {"ok": True}


@router.delete("/atc/positions/{callsign}")
async def close_one_position(callsign: str, user: dict = Depends(require("atc:position"))):
    d = await db.atc_positions.find_one({"user_id": user["id"], "callsign": callsign.upper()}, {"_id": 0})
    if not d:
        raise HTTPException(404, "Vous n'avez pas ouvert cette position.")
    await close_positions([d], "fermeture", user)
    return {"ok": True}


@router.get("/atc/handovers/me", response_model=list[Handover])
async def my_handovers(user: dict = Depends(require("atc:position"))):
    docs = await db.atc_handovers.find({"to_user_id": user["id"]}, {"_id": 0}).sort("created_at", 1).to_list(10)
    return [Handover(**handover_out(h)) for h in docs]


@router.post("/atc/handovers/accept", response_model=list[AtcPosition])
async def accept_my_handovers(user: dict = Depends(require("atc:position"))):
    """« Reprendre maintenant »: takes over every position waiting for this controller."""
    out = []
    for h in await db.atc_handovers.find({"to_user_id": user["id"]}, {"_id": 0}).to_list(10):
        d = await accept_handover(h, automatic=False)
        if d:
            out.append(_out(d))
    return out


@router.get("/airspaces", response_model=AirspaceResponse)
async def airspaces(kind: str = Query(pattern="^(fir|tracon)$"),
                    bbox: str = Query(pattern=r"^-?\d+(\.\d+)?(,-?\d+(\.\d+)?){3}$"),
                    user: dict = Depends(require("flight:read"))):
    s, w, n, e = (float(x) for x in bbox.split(","))
    return AirspaceResponse(attribution=airspace.ATTRIBUTION, features=airspace.in_bbox(kind, s, w, n, e))