import httpx
from fastapi import APIRouter, Depends, HTTPException, Query

from lib.auth import authorize, require
from lib.db import db
from lib.engine import go_around, go_around_possible, nudge_in_hold, reconcile_holding, reject_window_open, compute_position, hold_entered_at, start_holding, lined_up_since, marker_nm, move_marker, PUSH_MAX_M, PUSH_MIN_M, push_distance_m, TAXI_PHASES, ACTIONS, ACTIVE, AIR_PHASES, PHASES, taxi_origin, direct_to, taxi_block, enter_phase, rebase, snap_distance, \
    step_for, step_target, track_length, utcnow, aware
from lib.events import log_event
from lib.geo import haversine_nm
from lib.osm import on_airport, build_taxi_path, gate_ref, get_graph, get_ground
from models.schemas import (NavIn, ProfileMarkerIn, TaxiStopIn, RunwaysIn, ActionIn, HoldingIn, ControlIn, FlightDetail, FlightEvent, FlightsResponse, ForcePhaseIn, GatesIn,
                            NoteIn, NudgeIn, StepIn, TaxiIn)
from routers.atc import heartbeat as atc_heartbeat
from lib.control import ctx_for
from routers.common import apply_runway_change, ensure_control, check_version, detail, detail_for, load_flight, save, summary

router = APIRouter(prefix="/flights", tags=["flights"])
ATC_GAP_S = 120  # polling gaps longer than this end a controlling session


async def record_atc_presence(user: dict, now) -> None:
    """ATC hours = time actually spent on the radar in ATC mode (server-side heartbeat from polling)."""
    last = user.get("atc_last_seen")
    inc = 0.0
    if last:
        last = aware(last)
        gap = (now - last).total_seconds()
        if 0 < gap <= ATC_GAP_S:
            inc = gap
    await db.users.update_one({"id": user["id"]}, {"$set": {"atc_last_seen": now}, "$inc": {"atc_seconds": inc}})
DEP_GATE_PHASES = {"preparation"}
TAKEOFF_NUDGE_MAX_NM = 1.0
DIR_FR = {"N": "le nord", "NE": "le nord-est", "E": "l'est", "SE": "le sud-est", "S": "le sud",
          "SW": "le sud-ouest", "W": "l'ouest", "NW": "le nord-ouest"}


async def rejected_takeoff(f: dict, body, user: dict, now) -> None:
    """Interrupted take-off: the route is clicked point by point, from the exit taxiway to the new holding point or the
    stand. The aircraft appears on the exit taxiway and carries on from there."""
    if not reject_window_open(f, now):
        raise HTTPException(409, "Trop tard pour interrompre : le décollage a commencé il y a plus de 3 minutes.")
    if not body.taxi_points:
        raise HTTPException(422, "Cliquez d'abord le taxiway par lequel l'avion dégage la piste.")
    icao = f["departure"]
    ground = await get_ground(icao)
    if not all(on_airport(ground, p[0], p[1]) for p in body.taxi_points):
        raise HTTPException(422, f"Point hors de l'aéroport : cliquez sur une voie de {icao}.")
    if body.action == "interrompre_decollage":
        hp = next((h for h in ground.get("holdings", []) if h.get("ref") and h["ref"] == body.holding_ref
                   and abs(h["lat"] - (body.holding_lat or 0)) < 1e-4 and abs(h["lon"] - (body.holding_lon or 0)) < 1e-4), None)
        if not hp:
            raise HTTPException(422, "Choisissez le nouveau point d'attente.")
        try:
            t = await build_taxi_path(icao, body.taxi_points, None, None, end_point=(hp["lat"], hp["lon"]),
                                      exit_runway=f["route"][0].get("rwy") or {})
        except HTTPException as e:
            raise HTTPException(422, f"Roulage impossible ({e.detail}) : modifiez vos points.")
        rebase(f, now)
        enter_phase(f, "roulage", now)
        f["taxi_out"] = {**t, "points": [*body.taxi_points, [hp["lat"], hp["lon"]]], "rejected": True, "set_by_name": user["display_name"], "set_at": now}
        f["holding_point"] = {"ref": hp["ref"], "lat": hp["lat"], "lon": hp["lon"]}
        f["progress"].update(track="taxi_out", anchor_dist=0.0, anchor_at=now, hold=True)  # attend « Commencer le roulage »
    else:
        gate = gate_ref(await get_graph(icao), body.gate_ref) if body.gate_ref else None
        if not gate:
            raise HTTPException(422, "Cliquez le poste de stationnement où retourner.")
        try:
            t = await build_taxi_path(icao, body.taxi_points, None, gate["ref"], exit_runway=f["route"][0].get("rwy") or {})
        except HTTPException as e:
            raise HTTPException(422, f"Roulage impossible ({e.detail}) : modifiez vos points.")
        rebase(f, now)
        enter_phase(f, "retour_parking", now)
        f["phase"] = "retour_parking"
        f["dep_gate"] = gate
        f["taxi_back"] = {**t, "points": body.taxi_points, "rejected": True, "set_by_name": user["display_name"], "set_at": now}
        f["taxi_out"], f["holding_point"], f["pushback_to"] = None, None, None
        f["progress"].update(track="taxi_back", anchor_dist=0.0, anchor_at=now, hold=True)  # attend « Commencer le roulage »
    f["lineup"] = None
    f["_exit_name"] = (t["names"] or ["le taxiway choisi"])[0]


async def lineup_on_taxiways(f: dict) -> None:
    """Line-up along the REAL taxiway left between the holding point and the runway (OpenStreetMap network), then
    onto the centreline, nose in the take-off direction. Falls back to the straight entry when the map has no link."""
    import heapq
    import math
    from lib.runways import offset, project_on_runway
    lu, rw = f.get("lineup") or {}, f["route"][0].get("rwy")
    path = lu.get("path") or []
    if not rw or len(path) < 2:
        return
    try:
        g = await get_graph(f["departure"])
    except HTTPException:
        return
    hp = path[0]
    start = g.nearest(hp[0], hp[1])
    if haversine_nm(hp[0], hp[1], *g.coords[start]) > 0.05:
        return
    # nodes of THIS runway's centreline as drawn on the map (OpenStreetMap runway way), displaced part included
    on_rwy = [n for n, (la, lo) in g.coords.items()
              if any(g.kind.get((n, v)) == "runway" for v, _, _ in g.adj[n])
              and haversine_nm(la, lo, *project_on_runway(rw, la, lo)) < 0.05]
    if not on_rwy:
        return
    dist, prev, pq = {start: 0.0}, {}, [(0.0, start)]
    while pq:  # distances from the holding point over the taxiway network (runways penalised, as for taxiing)
        d, u = heapq.heappop(pq)
        if d > dist.get(u, math.inf) or d > 2.0:
            continue
        for v, w, _ in g.adj[u]:
            if d + w < dist.get(v, math.inf):
                dist[v], prev[v] = d + w, u
                heapq.heappush(pq, (d + w, v))
    reach = [n for n in on_rwy if n in dist]
    if not reach:
        return
    entry = min(reach, key=lambda n: dist[n])
    seq = [entry]
    while seq[-1] != start:
        seq.append(prev[seq[-1]])
    pts = [list(hp)] + [list(g.coords[n]) for n in reversed(seq)]
    if len(pts) > 2 and haversine_nm(*pts[0], *pts[1]) < 0.003:
        pts.pop(1)
    end = offset(pts[-1][0], pts[-1][1], rw["hdg"], 0.02)  # turn onto the centreline, nose along the runway
    pts.append(list(end))
    f["lineup"] = {**lu, "path": pts, "seg_names": [g.edge_name(a, b) for a, b in zip(reversed(seq), list(reversed(seq))[1:])] or lu.get("seg_names", []),
                   "via_taxiway": True}


async def align_taxi_out(f: dict) -> None:
    """The departure taxi starts where the aircraft really is: the end of the pushback when there was one (the point
    clicked on the map), otherwise the stand. Rebuilt on the same clicked points / holding point when that changes."""
    t = f.get("taxi_out")
    # only before the aircraft starts taxiing: afterwards the route must not change under it (it stopped short of the
    # holding point when this rebuilt the route on arrival), and a route changed during the taxi starts at the aircraft
    if not t or not t.get("points") or t.get("rejected") or t.get("live") or f["phase"] not in ("preparation", "repoussage", "roulage"):
        return
    push = f.get("pushback_to") if f["phase"] in ("repoussage", "roulage") else None
    want = [push["lat"], push["lon"]] if push else None
    if (t.get("origin") or None) == want:
        return
    gate = (f.get("dep_gate") or {}).get("ref")
    try:
        hp = f.get("holding_point") or {}
        new = await build_taxi_path(f["departure"], t["points"], None if want else gate, None,
                                    origin=(want[0], want[1]) if want else None,
                                    end_point=(hp["lat"], hp["lon"]) if hp.get("lat") is not None else None)
    except HTTPException:
        return  # no route from there: keep the previous one rather than nothing
    if want:
        new["names"] = ["Fin du repoussage", *[n for n in new["names"] if n]]
    f["taxi_out"] = {**t, **new, "origin": want}


@router.get("", response_model=FlightsResponse)
async def list_flights(scope: str = Query("active", pattern="^(active|all|mine)$"),
                       user: dict = Depends(require("flight:read"))):
    q: dict = {}
    if scope == "active":
        q["phase"] = {"$in": ACTIVE}
    elif scope == "mine":
        q["pilot_id"] = user["id"]
    docs = await db.flights.find(q, {"_id": 0}).sort("updated_at", -1).to_list(500)
    now = utcnow()
    if user["role"] == "atc":
        await record_atc_presence(user, now)
    if user["role"] in ("atc", "admin"):
        await atc_heartbeat(user, now)
    ctx = await ctx_for(user, now)
    return FlightsResponse(server_time=now, flights=[summary(f, now, ctx) for f in docs])


@router.get("/{flight_id}", response_model=FlightDetail)
async def get_flight(flight_id: str, user: dict = Depends(require("flight:read"))):
    return await detail_for(await load_flight(flight_id), user)


@router.get("/{flight_id}/simbrief-pdf")
async def simbrief_pdf(flight_id: str, user: dict = Depends(require("flight:read"))):
    """Link to the SimBrief OFP PDF of this flight, checked before being given to the browser."""
    f = await load_flight(flight_id)
    url = (f.get("plan_meta") or {}).get("pdf_url")
    if not url:
        raise HTTPException(404, "Aucun PDF SimBrief n'est associé à ce vol (plan importé avant cette fonction, ou "
                                 "SimBrief n'a pas fourni de PDF).")
    try:
        async with httpx.AsyncClient(timeout=10, follow_redirects=True) as c:
            r = await c.head(url)
        if r.status_code != 200 or "pdf" not in r.headers.get("content-type", "").lower():
            raise HTTPException(404, "Le PDF SimBrief de ce vol n'est plus disponible sur simbrief.com (plan remplacé "
                                     "ou expiré).")
    except httpx.HTTPError:
        raise HTTPException(503, "SimBrief est injoignable pour le moment : réessayez dans quelques instants.")
    return {"url": url}


@router.get("/{flight_id}/events", response_model=list[FlightEvent])
async def flight_events(flight_id: str, user: dict = Depends(require("flight:read"))):
    await load_flight(flight_id)
    docs = await db.events.find({"flight_id": flight_id}, {"_id": 0}).sort("at", -1).to_list(500)
    return [FlightEvent(**{**d, "at": aware(d["at"])}) for d in docs]


@router.post("/{flight_id}/actions", response_model=FlightDetail)
async def do_action(flight_id: str, body: ActionIn, user: dict = Depends(require("flight:act"))):
    f = await load_flight(flight_id)
    authorize(user, "flight:act", f)
    a = ACTIONS.get(body.action)
    if not a:
        raise HTTPException(400, "Action inconnue.")
    if user["role"] not in a["roles"]:
        raise HTTPException(403, "Cette action est réservée au contrôle (ATC/Admin).")
    check_version(f, body.version)
    ensure_control(f, user, ctx := await ctx_for(user, utcnow()))
    if body.action == "repoussage" and not body.pushback_dir:
        raise HTTPException(422, "Indiquez l'orientation de l'avion après le repoussage (Nord, Nord-Est, Est…).")
    if body.action == "repoussage":
        if not body.pushback_to:
            raise HTTPException(422, "Cliquez sur la carte l'endroit où l'avion doit être repoussé.")
        dist = push_distance_m(f, body.pushback_to.lat, body.pushback_to.lon)
        if not PUSH_MIN_M <= dist <= PUSH_MAX_M:
            raise HTTPException(422, f"Le point de fin de repoussage doit être entre {PUSH_MIN_M:.0f} et {PUSH_MAX_M:.0f} m "
                                     f"du poste (ici {dist:.0f} m) : cliquez plus près de l'avion.")
        if not on_airport(await get_ground(f["departure"]), body.pushback_to.lat, body.pushback_to.lon, None):
            raise HTTPException(422, "Point hors de l'aéroport : cliquez sur l'aéroport de départ.")
    if f["phase"] not in a["frm"]:
        raise HTTPException(409, f"Transition refusée : « {a['label']} » impossible depuis l'état "
                                 f"« {PHASES[f['phase']]} ».")
    if body.action == "repartir" and not f.get("returned_to_stand"):
        raise HTTPException(409, "« Repartir en vol » n'existe qu'après un retour au poste suite à un décollage interrompu.")
    if body.action == "go_around" and not go_around_possible(f, utcnow()):
        raise HTTPException(409, "La remise de gaz se fait en courte finale (moins de 12 NM de la piste) ou après le toucher.")
    now = utcnow()
    before = f["phase"]
    to = f.get("prev_phase") if body.action == "reprendre" else a["to"]
    if (why := taxi_block(f, to, bool(ctx.responsible(f)))):
        raise HTTPException(409, why)
    if body.action == "repoussage":
        f["pushback_dir"] = body.pushback_dir
        f["pushback_to"] = {"lat": round(body.pushback_to.lat, 7), "lon": round(body.pushback_to.lon, 7)}
    if body.action in ("interrompre_decollage", "retour_parking"):
        await rejected_takeoff(f, body, user, now)
        await save(f, body.version)
        target = f"point d'attente {body.holding_ref}" if body.action == "interrompre_decollage" else f"poste {body.gate_ref}"
        await log_event("phase", a["label"], user, f,
                        f"Décollage interrompu : piste dégagée par {f['_exit_name']}, roulage vers {target}"
                        f" — {' → '.join((f.get('taxi_back') or f.get('taxi_out') or {}).get('names') or [])}")
        f.pop("_exit_name", None)
        await save(f, f["version"])
        return detail(f, user, now, ctx)
    cleared_lineup = False
    already_lined = before == "alignement" and lined_up_since(f, now) is not None
    if body.action == "decollage" and (before == "point_attente" or (before == "alignement" and not already_lined)):
        # Autorisé au décollage : l'avion s'aligne d'abord (visible), puis décolle tout seul (pas d'arrêt)
        cleared_lineup = True
        if before == "point_attente":
            to = "alignement"
    if body.action == "decollage" and already_lined:
        # Déjà aligné : passage immédiat en décollage, roulement continu, aucun hold
        enter_phase(f, "decollage", now)
        f["takeoff_cleared"] = True
        f["progress"]["hold"] = False
    elif cleared_lineup and before == "alignement":
        rebase(f, now)
        f["takeoff_cleared"] = True
        f["progress"]["hold"] = False  # continue le mouvement d'alignement → décollage auto
    else:
        if body.action == "go_around":
            go_around(f, now)  # from the aircraft's real position (enter_phase would move it to the STAR entry)
            f["phase"], f["takeoff_cleared"] = "approche", False
        else:
            enter_phase(f, to, now)
        if to == "alignement" and body.action != "reprendre":
            await lineup_on_taxiways(f)
        if cleared_lineup:
            f["takeoff_cleared"] = True
            f["progress"]["hold"] = False
    await align_taxi_out(f)
    await save(f, body.version)
    if cleared_lineup:
        await log_event("phase", "Autorisé au décollage", user, f,
                        f"{PHASES[before]} → alignement sur la piste, puis décollage automatique")
        return detail(f, user, now, ctx)
    extra = (f" — repoussage de {push_distance_m(f, f['pushback_to']['lat'], f['pushback_to']['lon']):.0f} m, "
             f"nez vers {DIR_FR[body.pushback_dir]}") if body.action == "repoussage" else ""
    if to == "approche" and f.get("approach_note"):
        extra = f" — {f['approach_note']}"
    await log_event("phase", a["label"], user, f, f"{PHASES[before]} → {PHASES[to]}{extra}")
    return detail(f, user, now, ctx)


@router.post("/{flight_id}/control", response_model=FlightDetail)
async def control(flight_id: str, body: ControlIn, user: dict = Depends(require("flight:control"))):
    f = await load_flight(flight_id)
    check_version(f, body.version)
    if f["phase"] not in ACTIVE:
        raise HTTPException(409, "Le vol est clôturé.")
    now = utcnow()
    ctx = await ctx_for(user, now)
    ensure_control(f, user, ctx)
    rebase(f, now)
    p = f["progress"]
    label, details = "", None
    if body.op == "pause":
        p["hold"], label = True, "Pause de la progression"
    elif body.op == "resume":
        p["hold"], label = False, "Reprise de la progression"
    elif body.op == "set_waypoint":
        if f["phase"] not in AIR_PHASES:
            raise HTTPException(409, "Le choix du point courant n'est possible qu'en vol.")
        i = body.waypoint_index
        if i is None or not (0 <= i < len(f["route"])):
            raise HTTPException(400, "Index de point invalide.")
        reconcile_holding(f, f["route"][i]["cum_nm"], now)
        p["anchor_dist"], f["manual_position"] = f["route"][i]["cum_nm"], None
        f["last_wp_index"] = i
        label, details = "Correction : point courant", f"Placé sur {f['route'][i]['ident']}"
    elif body.op == "set_progress":
        if body.progress_nm is None or not p.get("track"):
            raise HTTPException(400, "Aucune trajectoire active à ajuster.")
        reconcile_holding(f, min(body.progress_nm, track_length(f, p["track"])), now)
        p["anchor_dist"] = min(body.progress_nm, track_length(f, p["track"]))
        f["manual_position"] = None
        label, details = "Correction : progression sur la trajectoire", f"{p['anchor_dist']:.1f} NM"
    elif body.op == "set_position":
        if body.lat is None or body.lon is None:
            raise HTTPException(400, "Coordonnées manquantes.")
        if body.mode == "snap" and p.get("track"):
            snapped = snap_distance(f, body.lat, body.lon)
            reconcile_holding(f, snapped, now)
            p["anchor_dist"], f["manual_position"] = snapped, None
            label = "Correction : position recalée sur la trajectoire"
        else:
            f["manual_position"] = {"lat": body.lat, "lon": body.lon}
            label = "Correction : position manuelle (progression figée)"
        details = f"{body.lat:.4f}, {body.lon:.4f}"
    elif body.op == "clear_position":
        f["manual_position"], label = None, "Retour à la position calculée"
    elif body.op == "direct_to":
        if f["phase"] not in AIR_PHASES or body.waypoint_index is None:
            raise HTTPException(409, "Le changement de route n'est possible qu'en vol.")
        try:
            ident = direct_to(f, body.waypoint_index, now)
        except ValueError as e:
            raise HTTPException(400, str(e))
        label, details = "Modification de route", f"Direct {ident}"
    await save(f, body.version)
    await log_event("controle", label, user, f, details)
    return detail(f, user, now, ctx)


@router.post("/{flight_id}/step", response_model=FlightDetail)
async def step(flight_id: str, body: StepIn, user: dict = Depends(require("flight:act"))):
    """Previous / next lifecycle step. A pilot can only move forward through steps they are allowed to declare."""
    f = await load_flight(flight_id)
    authorize(user, "flight:act", f)
    check_version(f, body.version)
    ensure_control(f, user, ctx := await ctx_for(user, utcnow()))
    to = None if f.get("returned_to_stand") else step_target(f["phase"], body.direction)
    if not to:
        raise HTTPException(409, f"Aucune étape {'suivante' if body.direction == 'next' else 'précédente'} possible "
                                 f"depuis « {PHASES.get(f['phase'], f['phase'])} ».")
    if not step_for(f["phase"], body.direction, user["role"]):
        raise HTTPException(403, "Cette étape doit être déclenchée par le contrôle.")
    if body.direction == "next":
        # same rules as the buttons, for everybody: no taxi without a taxi route, no pushback without a direction
        # (an administrator who really needs to bypass them uses « Forcer un statut » in Administration)
        if (why := taxi_block(f, to, bool(ctx.responsible(f)))):
            raise HTTPException(409, why)
        if to == "repoussage" and not f.get("pushback_dir"):
            raise HTTPException(409, "Utilisez le bouton « Début du repoussage » pour choisir l'orientation de l'avion.")
    now, before = utcnow(), f["phase"]
    enter_phase(f, to, now)
    if to == "alignement":
        await lineup_on_taxiways(f)
    await align_taxi_out(f)
    await save(f, body.version)
    await log_event("phase", "Étape suivante" if body.direction == "next" else "Retour à l'étape précédente", user, f,
                    f"{PHASES[before]} → {PHASES[to]}")
    return detail(f, user, now, ctx)


@router.post("/{flight_id}/nudge", response_model=FlightDetail)
async def nudge(flight_id: str, body: NudgeIn, user: dict = Depends(require("flight:act"))):
    """Pilot (own flight) or ATC moves the aircraft back/forward along its current taxi or air track."""
    f = await load_flight(flight_id)
    authorize(user, "flight:act", f)
    check_version(f, body.version)
    ensure_control(f, user, ctx := await ctx_for(user, utcnow()))
    p = f["progress"]
    track = p.get("track")
    if f["phase"] not in ACTIVE or not track or track_length(f, track) <= 0:
        raise HTTPException(409, "Aucune trajectoire (roulage ou route) à ajuster dans cette phase.")
    now = utcnow()
    rebase(f, now)
    total, d = track_length(f, track), p["anchor_dist"]
    before = d
    h = f.get("holding") if track == "air" else None
    if h and hold_entered_at(f, now):  # en hold : l'avion avance ou recule SUR le hold, pas sur la route
        if not body.waypoint and body.delta_nm is None:
            raise HTTPException(400, "Indiquez un décalage ou un point.")
        ident = h["ident"]
        note = nudge_in_hold(f, body.delta_nm, (1 if body.waypoint == "next" else -1) if body.waypoint else 0, now)
        f["manual_position"] = None
        await save(f, body.version)
        await log_event("position", "Position ajustée dans le hold", user, f, note or f"hold sur {ident}")
        return detail(f, user, now, ctx)
    if f["phase"] == "decollage":
        # take-off: small steps only, a click must never skip the climb (« en route » comes 5 NM after lift-off)
        if body.waypoint:
            raise HTTPException(409, "Pendant le décollage, avancez l'avion par petits pas (pas de saut de point).")
        if body.delta_nm is not None:
            body.delta_nm = max(-TAKEOFF_NUDGE_MAX_NM, min(TAKEOFF_NUDGE_MAX_NM, body.delta_nm))
    if body.waypoint and track == "air":
        cums = [w["cum_nm"] for w in f["route"]]
        if body.waypoint == "next":
            d = next((c for c in cums if c > d + 0.05), total)
        else:
            d = next((c for c in reversed(cums) if c < d - 0.05), 0.0)
    elif body.delta_nm is not None:
        d += body.delta_nm
    else:
        raise HTTPException(400, "Indiquez un décalage ou un point.")
    d = max(0.0, min(total, d))
    if h:  # en route vers le hold : l'avion s'arrête à son point et y entre, il ne le dépasse pas
        d = min(d, h["fix_nm"])
    p["anchor_dist"] = d
    f["manual_position"] = None
    if track == "air":
        f["last_wp_index"] = compute_position(f, now)["wp_index"]
    await save(f, body.version)
    label = "Position ajustée " + ("en avant" if p["anchor_dist"] >= before else "en arrière")
    await log_event("position", label, user, f, f"{'roulage' if track != 'air' else 'route'} : {p['anchor_dist']:.2f} / {total:.2f} NM")
    return detail(f, user, now, ctx)


@router.put("/{flight_id}/gates", response_model=FlightDetail)
async def set_gates(flight_id: str, body: GatesIn, user: dict = Depends(require("flight:gates"))):
    f = await load_flight(flight_id)
    authorize(user, "flight:gates", f)
    check_version(f, body.version)
    if f["phase"] not in ACTIVE:
        raise HTTPException(409, "Le vol est clôturé.")
    ctx = await ctx_for(user, utcnow())
    if user["role"] == "pilote" and ctx.responsible(f):
        r = ctx.responsible(f)
        raise HTTPException(403, f"Vol contrôlé par {r['callsign']} : c'est le contrôleur qui choisit les postes.")
    changes = []
    if body.dep_gate != (f.get("dep_gate") or {}).get("ref"):
        if f["phase"] not in DEP_GATE_PHASES:
            raise HTTPException(409, "Le poste de départ ne peut plus être modifié après le début du repoussage.")
        if user["role"] == "atc" and not ctx.can_gate(f, "dep"):
            raise HTTPException(403, f"{f['departure']} ne relève d'aucune de vos positions : poste en lecture seule.")
        f["dep_gate"] = gate_ref(await get_graph(f["departure"]), body.dep_gate)
        f["taxi_out"], f["holding_point"] = None, None  # both belonged to the old stand: to be chosen again
        changes.append(f"départ {body.dep_gate or '—'}")
    if body.arr_gate != (f.get("arr_gate") or {}).get("ref"):
        if user["role"] == "pilote" and f.get("arr_gate_by") == "atc":
            raise HTTPException(409, "La porte d'arrivée a été assignée par le contrôle.")
        if user["role"] == "atc" and not ctx.can_gate(f, "arr"):
            raise HTTPException(403, f"{f['arrival']} ne relève d'aucune de vos positions : poste en lecture seule.")
        f["arr_gate"] = gate_ref(await get_graph(f["arrival"]), body.arr_gate)
        f["arr_gate_by"] = "pilote" if user["role"] == "pilote" else "atc"
        if f.get("taxi_in"):  # the drawn route ended at the old stand
            now = utcnow()
            rebase(f, now)
            origin = taxi_origin(f, "taxi_in", now)
            try:
                t = await build_taxi_path(f["arrival"], [] if origin else f["taxi_in"].get("points") or [], None, body.arr_gate, origin=origin,
                                          exit_runway=None if origin else (f["route"][-1].get("rwy") or {})) if body.arr_gate else None
            except HTTPException:
                t = None
            on_it = f["progress"].get("track") == "taxi_in"
            f["taxi_in"] = {**f["taxi_in"], **t, "points": [] if origin else f["taxi_in"].get("points") or []} if t else None
            if on_it:
                if t:
                    f["progress"].update(anchor_dist=0.0, anchor_at=now)
                else:
                    f["progress"].update(track="air", anchor_dist=track_length(f, "air"), anchor_at=now)
                    if f["phase"] == "roulage_arrivee":
                        f["progress"]["hold"] = True
        changes.append(f"arrivée {'assignée' if f['arr_gate_by'] == 'atc' else 'souhaitée'} {body.arr_gate or '—'}")
    if not changes:
        return detail(f, user, utcnow(), ctx)
    await save(f, body.version)
    await log_event("poste", "Postes de stationnement modifiés", user, f, ", ".join(changes))
    return detail(f, user, utcnow(), ctx)


@router.put("/{flight_id}/taxi", response_model=FlightDetail)
async def set_taxi(flight_id: str, body: TaxiIn, user: dict = Depends(require("flight:taxi"))):
    """Définit ou MODIFIE le roulage, point par point, jusqu'à la destination (point d'attente ou porte), y compris
    pendant le roulage. Arrivée : la porte d'abord, puis la sortie de piste (même derrière l'avion, qui y est ramené)."""
    f = await load_flight(flight_id)
    check_version(f, body.version)
    if f["phase"] not in ACTIVE:
        raise HTTPException(409, "Le vol est clôturé.")
    ctx = await ctx_for(user, utcnow())
    if not ctx.can_taxi(f, body.kind):
        raise HTTPException(403, "Seul le contrôleur responsable du sol de cet aéroport peut définir ce roulage.")
    out = body.kind == "taxi_out"
    icao = f["departure"] if out else f["arrival"]
    gate = (f.get("dep_gate") if out else f.get("arr_gate")) or {}
    now = utcnow()
    ground = await get_ground(icao)
    new_gate = None
    if not out and body.gate_ref and body.gate_ref != gate.get("ref"):
        if user["role"] == "pilote" and f.get("arr_gate_by") == "atc":
            raise HTTPException(409, "La porte d'arrivée a été assignée par le contrôle.")
        gate = new_gate = gate_ref(await get_graph(icao), body.gate_ref)
    if not out and not gate.get("ref") and ground.get("gates"):
        raise HTTPException(422, "Cliquez la porte d'arrivée comme dernier point du roulage.")
    if not all(on_airport(ground, p[0], p[1]) for p in body.points):
        raise HTTPException(422, f"Point hors de l'aéroport : cliquez sur une voie de {icao}.")
    hp = f.get("holding_point") if out else None
    if out and body.holding_ref:
        hp = next((h for h in ground.get("holdings", []) if (h.get("ref") or "") == body.holding_ref
                   and abs(h["lat"] - (body.holding_lat or 0)) < 1e-4 and abs(h["lon"] - (body.holding_lon or 0)) < 1e-4), None)
        if not hp:
            raise HTTPException(404, "Point d'attente inconnu dans les données de l'aéroport.")
        hp = {"ref": hp.get("ref"), "lat": hp["lat"], "lon": hp["lon"]}
    end = (hp["lat"], hp["lon"]) if hp else None
    origin = taxi_origin(f, body.kind, now)  # pendant le roulage : à partir de l'avion
    was_on_track = f["progress"].get("track") == body.kind
    try:
        t = await build_taxi_path(icao, body.points, gate.get("ref") if out and not origin else None,
                                  None if out else gate.get("ref"), origin=origin, end_point=end,
                                  exit_runway=None if out or origin else (f["route"][-1].get("rwy") or {}))
    except HTTPException as e:
        raise HTTPException(422, e.detail)
    rebase(f, now)
    points = [*body.points, [hp["lat"], hp["lon"]]] if hp else body.points
    f[body.kind] = {**t, "points": points, "set_by_name": user["display_name"], "set_at": now, "live": bool(origin)}
    if out and hp:
        f["holding_point"] = hp
    if new_gate:
        f["arr_gate"] = new_gate
        f["arr_gate_by"] = "pilote" if user["role"] == "pilote" else "atc"
    if origin:
        f["progress"].update(track=body.kind, anchor_dist=0.0, anchor_at=now)
        if f["phase"] == "point_attente":  # nouveau point d'attente au dernier moment : l'avion s'y rend
            f["phase"] = "roulage"
            f["progress"]["hold"] = False
    elif out:
        await align_taxi_out(f)
        t = f["taxi_out"]
    elif f["phase"] == "atterrissage":
        # l'avion est ramené sur la sortie choisie (même déjà dépassée) et figé jusqu'au début du roulage
        f["progress"].update(track="taxi_in", anchor_dist=0.0, anchor_at=now, hold=False)  # immobile tant que la phase n'est pas « roulage »
        f["manual_position"] = None
    await save(f, body.version)
    what = "départ" if out else "arrivée"
    await log_event("roulage", f"Itinéraire de roulage ({what}) {'modifié' if was_on_track else 'défini'}", user, f,
                    " → ".join(t["names"]) + f" ({t['length_nm']:.2f} NM)")
    return detail(f, user, now, ctx)


@router.post("/{flight_id}/nav", response_model=FlightDetail)
async def navigation(flight_id: str, body: NavIn, user: dict = Depends(require("flight:read"))):
    """Direct to a fix of the route, holding pattern (number of turns, leave or carry on at any time). The controller
    in charge of the flight, or its pilot when no controller is (ensure_control); administrators always."""
    f = await load_flight(flight_id)
    check_version(f, body.version)
    now = utcnow()
    ctx = await ctx_for(user, now)
    if user["role"] == "pilote" and f["pilot_id"] != user["id"]:
        raise HTTPException(403, "Ce vol appartient à un autre pilote.")
    ensure_control(f, user, ctx)
    if f["phase"] not in ("en_route", "approche"):
        raise HTTPException(409, "Direct et hold se demandent en vol (en route ou en approche).")
    h = f.get("holding")
    if body.op in ("direct", "hold"):
        if body.waypoint_index is None or body.waypoint_index >= len(f["route"]):
            raise HTTPException(422, "Choisissez un point de la route.")
    if body.op == "direct":
        try:
            ident = direct_to(f, body.waypoint_index, now)
        except ValueError as e:
            raise HTTPException(400, str(e))
        label, details = "Direct", f"Direct {ident}" + (f" (fin du hold sur {h['ident']})" if h else "")
    elif body.op == "hold":
        if h:
            raise HTTPException(409, f"Le vol est déjà en hold sur {h['ident']} : faites-le d'abord sortir.")
        try:
            hp = start_holding(f, body.waypoint_index, body.turns, now, user["display_name"])
        except ValueError as e:
            raise HTTPException(422, str(e))
        label = f"Hold demandé sur {hp['ident']}"
        details = (f"{body.turns} tour(s)" if body.turns else "jusqu'à nouvel ordre") + \
            f" — hippodrome, virages à droite, axe {hp['inbound']:.0f}°, branches de {hp['leg_s'] / 60:g} min"
    else:
        if not h:
            raise HTTPException(409, "Aucun hold en cours.")
        rebase(f, now)
        if body.op == "hold_cancel" or not hold_entered_at(f, now):  # not there yet: simply cancelled
            f.pop("holding", None)
            label, details = f"Hold annulé sur {h['ident']}", "l'avion poursuit sa route"
        elif body.op == "hold_exit":
            h["exit"] = True
            label, details = f"Sortie du hold demandée sur {h['ident']}", "à la fin du tour, en passant sur le point"
        else:  # hold_continue: more turns
            h["exit"], h["turns_done_logged"] = False, False
            h["turns"] = body.turns
            label, details = f"Hold prolongé sur {h['ident']}", f"{body.turns} tour(s) au total" if body.turns else "jusqu'à nouvel ordre"
    await save(f, body.version)
    await log_event("hold" if body.op != "direct" else "controle", label, user, f, details)
    return detail(f, user, now, ctx)


@router.post("/{flight_id}/profile", response_model=FlightDetail)
async def move_profile_marker(flight_id: str, body: ProfileMarkerIn, user: dict = Depends(require("flight:read"))):
    """The pilot replaces his TOC / TOD on the route when he is late on the plan (climb or descent started later /
    earlier). Allowed to the pilot of the flight, and to whoever is in charge of it (responsible controller, admin)."""
    f = await load_flight(flight_id)
    check_version(f, body.version)
    now = utcnow()
    ctx = await ctx_for(user, now)
    if f["pilot_id"] != user["id"] and user["role"] not in ("atc", "admin"):
        raise HTTPException(403, "Ce vol appartient à un autre pilote.")
    ensure_control(f, user, ctx)  # a controlled flight: only its controller changes it, not the pilot
    if f["phase"] not in ACTIVE:
        raise HTTPException(409, "Le vol est clôturé.")
    old = marker_nm(f, body.marker)
    if old is None:
        raise HTTPException(404, f"Ce plan de vol n'a pas de point {body.marker}.")
    rebase(f, now)
    if body.here:
        if f["progress"].get("track") != "air":
            raise HTTPException(409, "« Ici » n'est possible qu'en vol : utilisez les boutons ±NM.")
        new = f["progress"]["anchor_dist"]
    elif body.shift_nm:
        new = old + body.shift_nm
    else:
        raise HTTPException(422, "Indiquez où placer le point.")
    try:
        move_marker(f, body.marker, new)
    except ValueError as e:
        raise HTTPException(422, str(e))
    # waypoint indices moved: passages already logged stay logged
    d = f["progress"].get("anchor_dist", 0.0) if f["progress"].get("track") == "air" else 0.0
    f["last_wp_index"] = max([k for k, w in enumerate(f["route"]) if w["cum_nm"] <= d], default=0)
    await save(f, body.version)
    what = "fin de montée" if body.marker == "TOC" else "début de descente"
    await log_event("profil", f"{body.marker} déplacé ({what})", user, f, f"{old:.0f} NM → {new:.0f} NM du départ")
    return detail(f, user, now, ctx)


@router.post("/{flight_id}/taxi-stop", response_model=FlightDetail)
async def taxi_stop(flight_id: str, body: TaxiStopIn, user: dict = Depends(require("flight:act"))):
    """« Stop » / « Reprendre » while taxiing (give way, hold short of a runway…): the controller responsible when
    the flight is controlled, the pilot when it is not (ensure_control)."""
    f = await load_flight(flight_id)
    authorize(user, "flight:act", f)
    check_version(f, body.version)
    now = utcnow()
    ensure_control(f, user, ctx := await ctx_for(user, now))
    if f["phase"] not in TAXI_PHASES:
        raise HTTPException(409, "L'arrêt / la reprise n'existent que pendant le roulage.")
    if bool(f["progress"].get("hold")) == body.stop:
        return detail(f, user, now, ctx)
    rebase(f, now)
    f["progress"]["hold"] = body.stop
    await save(f, body.version)
    await log_event("roulage", "Roulage arrêté" if body.stop else "Roulage repris", user, f,
                    f"{PHASES[f['phase']]} — {'arrêt sur place' if body.stop else 'reprise du trajet'}")
    return detail(f, user, now, ctx)


@router.put("/{flight_id}/runways", response_model=FlightDetail)
async def set_runways(flight_id: str, body: RunwaysIn, user: dict = Depends(require("strip:write"))):
    """Controller (a position concerned by the flight) or administrator corrects the departure / arrival runway;
    the route is re-planned on the new runway."""
    f = await load_flight(flight_id)
    check_version(f, body.version)
    if f["phase"] not in ACTIVE:
        raise HTTPException(409, "Le vol est clôturé.")
    now = utcnow()
    ctx = await ctx_for(user, now)
    if not ctx.can_edit_strip(f):
        raise HTTPException(403, "Seul un contrôleur concerné par ce vol (ou un administrateur) peut changer de piste.")
    notes = apply_runway_change(f, body.dep_rwy, body.arr_rwy, now)
    if not notes:
        return detail(f, user, now, ctx)
    await save(f, body.version)
    await log_event("controle", "Piste modifiée par le contrôle", user, f, " · ".join(notes))
    return detail(f, user, now, ctx)


@router.put("/{flight_id}/holding", response_model=FlightDetail)
async def set_holding(flight_id: str, body: HoldingIn, user: dict = Depends(require("flight:act"))):
    """Pilot (uncontrolled flight) or responsible controller picks the holding point; the taxi route from the
    departure stand is generated on the real OSM taxiway network. No route is invented when it fails."""
    f = await load_flight(flight_id)
    authorize(user, "flight:act", f)
    check_version(f, body.version)
    now = utcnow()
    ctx = await ctx_for(user, now)
    ensure_control(f, user, ctx)
    if f["phase"] not in ("preparation", "repoussage"):
        raise HTTPException(409, "Le point d'attente se choisit avant le début du roulage.")
    ground = await get_ground(f["departure"])
    hp = next((h for h in ground.get("holdings", []) if (h.get("ref") or "") == body.holding_ref
               and abs(h["lat"] - body.holding_lat) < 1e-4 and abs(h["lon"] - body.holding_lon) < 1e-4), None)
    if not hp:
        raise HTTPException(404, "Point d'attente inconnu dans les données de l'aéroport.")
    gate = (f.get("dep_gate") or {}).get("ref")
    try:
        t = await build_taxi_path(f["departure"], [], gate, None, end_point=(hp["lat"], hp["lon"]))
    except HTTPException as e:
        raise HTTPException(422, f"Chemin de roulage automatique indisponible ({e.detail}). Choisissez un autre "
                                 "point d'attente ou demandez un tracé manuel à l'ATC.")
    rebase(f, now)
    f["taxi_out"] = {**t, "points": [[hp["lat"], hp["lon"]]], "set_by_name": user["display_name"], "set_at": now}
    f["holding_point"] = {"ref": hp.get("ref"), "lat": hp["lat"], "lon": hp["lon"]}
    await align_taxi_out(f)  # holding point chosen during the pushback: from where the tug leaves the aircraft
    t = f["taxi_out"]
    await save(f, body.version)
    await log_event("roulage", f"Point d'attente {hp.get('ref')} choisi, roulage généré automatiquement", user, f,
                    " → ".join(t["names"]) + f" ({t['length_nm']:.2f} NM)")
    return detail(f, user, now, ctx)


@router.post("/{flight_id}/notes")
async def add_note(flight_id: str, body: NoteIn, user: dict = Depends(require("flight:note"))):
    f = await load_flight(flight_id)
    authorize(user, "flight:note", f)
    await log_event("note", "Note", user, f, body.text.strip())
    return {"ok": True}


@router.post("/{flight_id}/force", response_model=FlightDetail)
async def force_phase(flight_id: str, body: ForcePhaseIn, user: dict = Depends(require("admin:flights"))):
    f = await load_flight(flight_id)
    if body.phase not in PHASES:
        raise HTTPException(400, "Phase inconnue.")
    check_version(f, body.version)
    before, now = f["phase"], utcnow()
    f["progress"]["hold"] = False
    enter_phase(f, body.phase, now)
    await save(f, body.version)
    await log_event("admin", "Correction administrative de l'état", user, f,
                    f"{PHASES[before]} → {PHASES[body.phase]} — {body.reason}")
    return await detail_for(f, user, now)


@router.delete("/{flight_id}")
async def delete_flight(flight_id: str, user: dict = Depends(require("admin:flights"))):
    """Administrators and the creator: removes the flight for good (unlike « Annuler », which keeps it in the
    history), with its reviews and pending handovers. Its journal entries stay in the global log."""
    f = await load_flight(flight_id)
    await db.flights.delete_one({"id": flight_id})
    await db.reviews.delete_many({"flight_id": flight_id})
    await db.atc_handovers.delete_many({"flight_id": flight_id})
    await log_event("admin", "Suppression du vol", user, None, f"{f['callsign']} ({f['departure']} → {f['arrival']}, pilote {f['pilot_name']})")
    return {"ok": True}
