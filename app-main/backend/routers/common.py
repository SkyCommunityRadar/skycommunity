"""Shared helpers for routers: serialization, versioned saves."""

import uuid
from datetime import datetime, timedelta

from fastapi import HTTPException

from lib.auth import PERMS
from lib.db import db
from lib.security import security_settings
from lib.discord_roles import access_fields, access_of, has_any_access
from lib.events import log_event
from lib.control import Ctx, ctx_for
from lib.engine import REJECT_WINDOW_S, ACTIONS, ACTIVE, step_for, TAXI_PHASES, aware, holding_info, allowed_actions, compute_position, procedures, rebase, snap_distance, utcnow
from lib.runways import change_runways, find as find_runway, runway_idents
from models.schemas import Access, FlightDetail, FlightSummary, Position, TaxiRoute, UserOut


def avatar_url(u: dict) -> str | None:
    """Rebuilt from stored ids only (never a user-supplied URL)."""
    did, av = u.get("discord_id"), u.get("avatar")
    if not did or not av or not str(av).replace("_", "").isalnum():
        return None
    return f"https://cdn.discordapp.com/avatars/{did}/{av}.png?size=128"


def user_out(u: dict) -> UserOut:
    a = access_of(u)
    return UserOut(id=u["id"], email=u.get("email"), display_name=u["display_name"],
                   discord_id=u.get("discord_id"), avatar_url=avatar_url(u), role=u.get("role", "aucun"),
                   access=Access(**a), atc_allowed=a["atc"] or a["admin"], simbrief_id=u.get("simbrief_id"),
                   disabled=bool(u.get("disabled")), banned_until=aware(u.get("banned_until")),
                   ban_reason=u.get("ban_reason"), roles_synced_at=aware(u.get("roles_synced_at")),
                   created_at=aware(u["created_at"]), inactivity=u.get("inactivity"))


async def upsert_discord_user(discord_id: str, profile: dict, roles: list[str]) -> dict:
    """Creates or updates the account keyed by the Discord id and stores the access computed from its roles."""
    now = utcnow()
    upd = {**profile, **access_fields(discord_id, roles), "last_login_at": now}
    user = await db.users.find_one_and_update({"discord_id": discord_id}, {"$set": upd},
                                             projection={"_id": 0}, return_document=True)
    if user:
        return user
    if not has_any_access(upd["access"]):  # no site role on Discord: no account is created
        return {"display_name": profile.get("display_name", ""), "access": upd["access"], "disabled": False}
    if (await security_settings())["lockdown"]:  # mode anti-raid: no new account until it is switched off
        return {"display_name": profile.get("display_name", ""), "access": upd["access"], "disabled": False,
                "lockdown_refused": True}
    user = dict(id=str(uuid.uuid4()), discord_id=discord_id, email=None, simbrief_id=None, disabled=False,
                token_version=0, password_hash=None, created_at=now, **upd)
    try:
        await db.users.insert_one(dict(user))
        await log_event("compte_cree", "Création de compte (Discord)", {**user, "role": "aucun"})
    except Exception:  # concurrent first login: the unique index kept one account, reuse it
        user = await db.users.find_one({"discord_id": discord_id}, {"_id": 0})
    return user


def summary(f: dict, now: datetime, ctx: Ctx | None = None) -> FlightSummary:
    r = ctx.responsible(f) if ctx else None
    return FlightSummary(
        controller_callsign=r["callsign"] if r else None,
        id=f["id"], callsign=f["callsign"], pilot_id=f["pilot_id"], pilot_name=f["pilot_name"],
        returned_to_stand=bool(f.get("returned_to_stand")),
        aircraft_type=f["aircraft_type"], departure=f["departure"], arrival=f["arrival"], phase=f["phase"],
        prev_phase=f.get("prev_phase"), source="simbrief", version=f["version"],
        hold=bool(f["progress"].get("hold")), position=Position(**compute_position(f, now)),
        dep_gate=f.get("dep_gate"), arr_gate=f.get("arr_gate"),
        arr_gate_by=f.get("arr_gate_by") or ("pilote" if f.get("arr_gate") else None),
        created_at=aware(f["created_at"]), updated_at=aware(f["updated_at"]),
        flight_time_s=int((f.get("route") or [{}])[-1].get("cum_s") or 0),
        **{k: v for k, v in plan_info(f).items() if k in ("dep_rwy", "arr_rwy")},
    )


def _taxi(t: dict | None) -> TaxiRoute | None:
    if not t or "names" not in t:  # ignore legacy (pre-OSM) taxi routes
        return None
    return TaxiRoute(**{**t, "set_at": aware(t["set_at"])})


def ensure_control(f: dict, user: dict, ctx: Ctx) -> None:
    """Server-side rule for every change to a flight (status, progression, taxi, holding point…):
    - admin: always;
    - ATC: only the controller responsible for the flight right now (lib/control.py);
    - pilot: only while no ATC is responsible for the flight (uncontrolled)."""
    if user["role"] == "admin":
        return
    r = ctx.responsible(f)
    if user["role"] == "atc":
        if not r or r["user_id"] != user["id"]:
            raise HTTPException(403, (f"Ce vol relève de {r['callsign']} ({r['controller']}) : consultation seulement."
                                      if r else "Ce vol ne relève d'aucune de vos positions : consultation seulement."))
        return
    if r:
        raise HTTPException(403, f"Vol contrôlé par {r['callsign']} ({r['controller']}) : seules ses instructions "
                                 "font évoluer ce vol.")



PLAN_FIELDS = ("sid", "star", "dep_rwy", "arr_rwy")


DEP_RWY_PHASES = ("preparation", "repoussage", "roulage", "point_attente")
ARR_RWY_LOCKED = ("atterrissage", "roulage_arrivee", "parking", "termine", "annule")


def apply_runway_change(f: dict, dep_rwy: str | None, arr_rwy: str | None, now: datetime) -> list[str]:
    """Controller correction of the departure / arrival runway: the route is re-planned on the new runway
    (take-off along its axis, 8 NM final on the new centreline). Returns French notes for the journal.
    dep_rwy / arr_rwy: None = unchanged."""
    meta = f.setdefault("plan_meta", {})
    cur = plan_info(f, with_strip=False)
    dep_rwy = (dep_rwy or "").strip().upper() or None
    arr_rwy = (arr_rwy or "").strip().upper() or None
    if dep_rwy == cur["dep_rwy"]:
        dep_rwy = None
    if arr_rwy == cur["arr_rwy"]:
        arr_rwy = None
    if not dep_rwy and not arr_rwy:
        return []
    phase = f.get("prev_phase") if f["phase"] == "suspendu" else f["phase"]
    if dep_rwy and phase not in DEP_RWY_PHASES:
        raise HTTPException(409, "La piste de départ ne peut plus être changée : l'avion a déjà décollé.")
    if arr_rwy and phase in ARR_RWY_LOCKED:
        raise HTTPException(409, "La piste d'arrivée ne peut plus être changée : l'avion a déjà atterri.")
    for icao, ident in ((f["departure"], dep_rwy), (f["arrival"], arr_rwy)):
        if ident and not find_runway(icao, ident):
            raise HTTPException(422, f"La piste {ident} n'existe pas à {icao}.")
    rebase(f, now)
    air = f["progress"].get("track") == "air"
    pos = compute_position(f, now) if air else None
    change_runways(f["route"], f["departure"], f["arrival"], dep_rwy or cur["dep_rwy"], arr_rwy or cur["arr_rwy"])
    if pos:  # airborne: keep the aircraft where it is on the re-planned route
        f["progress"]["anchor_dist"] = snap_distance(f, pos["lat"], pos["lon"])
    notes, strip = [], f.get("strip") or {}
    if dep_rwy:
        notes.append(f"piste de départ {cur['dep_rwy'] or '—'} → {dep_rwy}")
        meta["dep_rwy"] = dep_rwy
        meta["atc_changed"] = ",".join(sorted(set(filter(None, str(meta.get("atc_changed") or "").split(","))) | {"dep_rwy"}))
        strip.pop("dep_rwy", None)
        if f.get("taxi_out") and phase in ("preparation", "repoussage"):
            f["taxi_out"], f["holding_point"] = None, None
            notes.append("roulage de départ effacé : à refaire vers la nouvelle piste")
        elif f.get("taxi_out"):
            notes.append("pensez à modifier le roulage en cours vers la nouvelle piste")
    if arr_rwy:
        notes.append(f"piste d'arrivée {cur['arr_rwy'] or '—'} → {arr_rwy}")
        meta["arr_rwy"] = arr_rwy
        meta["atc_changed"] = ",".join(sorted(set(filter(None, str(meta.get("atc_changed") or "").split(","))) | {"arr_rwy"}))
        strip.pop("arr_rwy", None)
        if f.get("taxi_in"):
            f["taxi_in"] = None
            notes.append("roulage d'arrivée effacé : à refaire depuis la nouvelle piste")
    if f.get("strip") is not None:
        f["strip"] = strip
    return notes


def full_route(f: dict, pi: dict) -> str:
    """ICAO-style route: « LSGG/04 SIRO1N SIROD L615 LISMO DCT DJL DCT TINIL TINI9W LFPG/27R »."""
    toks = (f.get("route_string") or "").split()
    if pi["sid"] and (not toks or toks[0] != pi["sid"]):
        toks.insert(0, pi["sid"])
    if pi["star"] and (not toks or toks[-1] != pi["star"]):
        toks.append(pi["star"])
    dep = f["departure"] + (f"/{pi['dep_rwy']}" if pi["dep_rwy"] else "")
    arr = f["arrival"] + (f"/{pi['arr_rwy']}" if pi["arr_rwy"] else "")
    return " ".join([dep, *toks, arr])


def plan_info(f: dict, with_strip: bool = True) -> dict:
    """SID, STAR and departure / arrival runways. Taken automatically from the SimBrief plan; a value the
    controller entered on the ATC strip replaces it (an empty strip field falls back to the plan)."""
    meta, route = f.get("plan_meta") or {}, f["route"]
    sid, star, _ = procedures(route)
    if "sid" in meta or "star" in meta:  # imported since nov. 2026: names recorded from the plan (None = aucune)
        sid, star = meta.get("sid"), meta.get("star")
    out = dict(sid=sid, star=star,
               dep_rwy=meta.get("dep_rwy") or (route[0].get("rwy") or {}).get("ident"),
               arr_rwy=meta.get("arr_rwy") or (route[-1].get("rwy") or {}).get("ident"))
    strip = (f.get("strip") or {}) if with_strip else {}
    return {k: strip.get(k) or v for k, v in out.items()}

def detail(f: dict, user: dict, now: datetime, ctx: Ctx) -> FlightDetail:
    perms = PERMS.get(user["role"], set())
    owner = f["pilot_id"] == user["id"]
    s = summary(f, now, ctx)
    active = f["phase"] in ACTIVE
    r = ctx.responsible(f)
    if user["role"] == "admin":
        may_act = True
    elif user["role"] == "atc":
        may_act = bool(r and r["user_id"] == user["id"])
    else:
        may_act = owner and not r
    meta = f.get("plan_meta") or {}
    pi = plan_info(f)
    sid, star = pi["sid"], pi["star"]
    taxi_out, taxi_in = active and ctx.can_taxi(f, "taxi_out"), active and ctx.can_taxi(f, "taxi_in")
    dep_gate = active and (ctx.can_gate(f, "dep") if user["role"] != "pilote" else owner and not r)
    arr_gate = active and (ctx.can_gate(f, "arr") if user["role"] != "pilote" else owner and not r)
    acts = allowed_actions(f, user["role"], owner, bool(r)) if may_act else []
    return FlightDetail(
        controller_name=r["controller"] if r else None, controller_callsign=r["callsign"] if r else None,
        is_controller=bool(r and r["user_id"] == user["id"]), sid=sid, star=star,
        approach_note=f.get("approach_note"), pushback_dir=f.get("pushback_dir"), pushback_to=f.get("pushback_to"),
        **s.model_dump(exclude={"controller_callsign", "dep_rwy", "arr_rwy"}), route=f["route"], route_string=f.get("route_string"),
        full_route=full_route(f, pi), can_delete=user["role"] == "admin",
        can_stop_taxi=active and may_act and f["phase"] in TAXI_PHASES,
        cruise_alt_ft=f.get("cruise_alt_ft"),
        plan_meta=f.get("plan_meta") or {}, taxi_out=_taxi(f.get("taxi_out")), taxi_in=_taxi(f.get("taxi_in")),
        taxi_back=_taxi({**f["taxi_back"], "set_by_name": f["taxi_back"].get("set_by_name") or "", "set_at": f["taxi_back"].get("set_at") or f["updated_at"]})
        if f["phase"] == "retour_parking" and f.get("taxi_back") else None,
        # « Étape préc./suiv. » masquée si une action de phase mène déjà au même état (évite doublons
        # du type « Retour en route » + « Étape précédente : En route »)
        step_prev=None if f.get("returned_to_stand") else (
            prv if (prv := step_for(f["phase"], "prev", user["role"]) if active and may_act else None)
            and not any(ACTIONS[a["code"]]["to"] == prv for a in acts) else None
        ),
        step_next=None if f.get("returned_to_stand") else (
            nxt if (nxt := step_for(f["phase"], "next", user["role"]) if active and may_act else None)
            and not any(ACTIONS[a["code"]]["to"] == nxt for a in acts) else None
        ),
        allowed_actions=acts,
        can_control="flight:control" in perms and active and may_act,
        can_edit_taxi=taxi_out or taxi_in,
        can_edit_gates=dep_gate or arr_gate,
        is_owner=owner, controlled=bool(r),
        can_edit_taxi_out=taxi_out, can_edit_taxi_in=taxi_in, can_edit_dep_gate=dep_gate, can_edit_arr_gate=arr_gate,
        can_pick_holding=active and may_act and f["phase"] in ("preparation", "repoussage"),
        holding=holding_info(f, now),
        can_nav=active and (may_act or user["role"] == "admin") and f["phase"] in ("en_route", "approche"),
        reject_until=(aware(f.get("takeoff_at")) + timedelta(seconds=REJECT_WINDOW_S)) if f["phase"] == "decollage" and f.get("takeoff_at") else None,
        takeoff_cleared=bool(f.get("takeoff_cleared")) and f["phase"] == "alignement",
        lineup=(f.get("lineup") or {}).get("path") if f["phase"] in ("alignement", "decollage") else None,
        can_edit_profile=active and may_act and f["phase"] not in ("parking", "roulage_arrivee", "atterrissage"),
        toc_nm=next((w["cum_nm"] for w in f["route"] if w.get("ident") == "TOC"), None),
        tod_nm=next((w["cum_nm"] for w in f["route"] if w.get("ident") == "TOD"), None),
        can_edit_strip=active and ctx.can_edit_strip(f),
        can_edit_dep_rwy=active and ctx.can_edit_strip(f) and (f.get("prev_phase") if f["phase"] == "suspendu" else f["phase"]) in DEP_RWY_PHASES,
        can_edit_arr_rwy=active and ctx.can_edit_strip(f) and (f.get("prev_phase") if f["phase"] == "suspendu" else f["phase"]) not in ARR_RWY_LOCKED,
        dep_runways=runway_idents(f["departure"]) if active and ctx.can_edit_strip(f) else [],
        arr_runways=runway_idents(f["arrival"]) if active and ctx.can_edit_strip(f) else [],
        holding_point=f.get("holding_point"),
        dep_name=meta.get("dep_name") or f["route"][0].get("name"), arr_name=meta.get("arr_name") or f["route"][-1].get("name"),
        dep_rwy=pi["dep_rwy"], arr_rwy=pi["arr_rwy"],
        has_pdf=bool(meta.get("pdf_url")),
    )


async def detail_for(f: dict, user: dict, now: datetime | None = None) -> FlightDetail:
    now = now or utcnow()
    return detail(f, user, now, await ctx_for(user, now))


async def delete_flights_data(ids: list[str]) -> None:
    """Removes flights for good, with everything that counted them: reviews, review reminders, pending handovers.
    Hours, flight counts, ranking and profiles are computed from the remaining flights only. The journal keeps its
    lines (history of what happened), but no counter reads a deleted flight from it."""
    if not ids:
        return
    q = {"flight_id": {"$in": ids}}
    await db.flights.delete_many({"id": {"$in": ids}})
    await db.reviews.delete_many(q)
    await db.review_snoozes.delete_many(q)
    await db.review_dismissals.delete_many(q)
    await db.atc_handovers.delete_many(q)


async def load_flight(flight_id: str) -> dict:
    f = await db.flights.find_one({"id": flight_id}, {"_id": 0})
    if not f:
        raise HTTPException(404, "Vol introuvable.")
    return f


def check_version(f: dict, version: int) -> None:
    if f["version"] != version:
        raise HTTPException(409, "Le vol a été modifié entre-temps par un autre utilisateur. Données rechargées, "
                                 "vérifiez l'état puis recommencez.")


async def save(f: dict, expected_version: int) -> None:
    """Optimistic concurrency: the write only lands if nobody else changed the flight meanwhile."""
    f["version"] = expected_version + 1
    f["updated_at"] = utcnow()
    res = await db.flights.replace_one({"id": f["id"], "version": expected_version}, f)
    if res.matched_count == 0:
        raise HTTPException(409, "Modification concurrente détectée : le vol a changé entre-temps. Réessayez.")


async def one_active_flight(user: dict) -> None:
    """Server-side rule: a pilot may only have one active flight at a time."""
    f = await db.flights.find_one({"pilot_id": user["id"], "phase": {"$in": ACTIVE}}, {"_id": 0, "callsign": 1})
    if f:
        raise HTTPException(409, f"Vous avez déjà un vol actif ({f['callsign']}). Terminez-le ou annulez-le avant "
                                 "d'en créer un nouveau.")


async def unique_callsign(callsign: str) -> None:
    if await db.flights.find_one({"callsign": callsign, "phase": {"$in": ACTIVE}}, {"_id": 1}):
        raise HTTPException(409, f"Un vol actif utilise déjà l'indicatif {callsign}.")


def new_flight_doc(user: dict, *, callsign: str, aircraft_type: str, route: list[dict], route_string: str | None,
                   cruise_alt_ft: int | None, plan_meta: dict | None, dep_gate: dict | None,
                   arr_gate: dict | None) -> dict:
    now = utcnow()
    return dict(
        id=str(uuid.uuid4()), callsign=callsign, pilot_id=user["id"], pilot_name=user["display_name"],
        aircraft_type=aircraft_type, departure=route[0]["ident"], arrival=route[-1]["ident"], phase="preparation",
        prev_phase=None, source="simbrief", version=1, route=route, route_string=route_string,
        cruise_alt_ft=cruise_alt_ft, plan_meta=plan_meta or {}, taxi_out=None, taxi_in=None, manual_position=None,
        dep_gate=dep_gate, arr_gate=arr_gate,
        progress=dict(track=None, anchor_dist=0.0, anchor_at=now, hold=False), last_wp_index=0,
        created_at=now, updated_at=now,
    )
