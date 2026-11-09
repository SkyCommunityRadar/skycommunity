"""Pydantic v2 request/response models. Mirrored by hand in frontend/src/lib/types.ts."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, model_validator, Field

Role = Literal["pilote", "atc", "admin", "aucun"]  # "aucun" = logged in, mode not chosen yet


# ---------- auth / users ----------
class Access(BaseModel):
    """Rights computed server-side from the Discord roles (lib/discord_roles)."""
    pilote: bool = False
    atc: bool = False
    atc_lead: bool = False
    pilot_lead: bool = False
    admin: bool = False
    creator: bool = False


class InactivityStatus(BaseModel):
    """lib/activity.status_from — state: non_concerne · actif · bientot · dispense · suspendu."""
    kind: Literal["pilote", "atc"]
    state: Literal["non_concerne", "actif", "bientot", "dispense", "suspendu"]
    last_activity: datetime | None = None
    days_inactive: int | None = None
    deadline: datetime | None = None
    exempt_until: datetime | None = None
    manual: bool = False
    reason: str | None = None
    request_at: datetime | None = None


class UserOut(BaseModel):
    id: str
    email: str | None = None
    display_name: str
    discord_id: str | None = None
    avatar_url: str | None = None
    role: Role
    access: Access
    atc_allowed: bool = False
    simbrief_id: str | None = None
    disabled: bool = False
    banned_until: datetime | None = None
    ban_reason: str | None = None
    roles_synced_at: datetime | None = None
    created_at: datetime
    inactivity: dict[str, InactivityStatus] | None = None


class NudgeIn(BaseModel):
    version: int
    delta_nm: float | None = Field(default=None, ge=-200, le=200)
    waypoint: Literal["prev", "next"] | None = None


class ModeIn(BaseModel):
    mode: Literal["pilote", "atc"]


class NavIn(BaseModel):
    """Route changes asked by the controller in charge, or by the pilot when the flight is not controlled."""
    op: Literal["direct", "hold", "hold_exit", "hold_continue", "hold_cancel"]
    version: int
    waypoint_index: int | None = Field(default=None, ge=0)
    turns: int | None = Field(default=None, ge=1, le=20)  # None = jusqu'à nouvel ordre


class ProfileIn(BaseModel):
    display_name: str = Field(min_length=2, max_length=40, pattern=r"^[^<>]+$")
    simbrief_id: str | None = Field(default=None, max_length=12, pattern=r"^\d*$")


class AdminUserPatch(BaseModel):
    disabled: bool | None = None  # permanent block
    ban_hours: int | None = Field(default=None, ge=0, le=24 * 365)  # temporary block; 0 = lift
    ban_reason: str | None = Field(default=None, max_length=200)


# ---------- airports (OpenStreetMap ground data) ----------
class Gate(BaseModel):
    ref: str
    lat: float
    lon: float
    kind: Literal["stand", "gate"] = "stand"
    hdg: float | None = None  # aircraft heading when parked (from the OSM stand lead-in line)


class Holding(BaseModel):
    ref: str
    lat: float
    lon: float


class GroundLine(BaseModel):
    name: str
    kind: str
    path: list[list[float]]


class GroundArea(BaseModel):
    kind: str
    path: list[list[float]]


class Ground(BaseModel):
    icao: str
    name: str
    lat: float
    lon: float
    fetched_at: datetime
    source: str
    gates: list[Gate]
    holdings: list[Holding]
    lines: list[GroundLine]
    areas: list[GroundArea] = []


class GroundSummary(BaseModel):
    icao: str
    name: str
    lat: float
    lon: float
    gates: int
    fetched_at: datetime


class TaxiPreviewIn(BaseModel):
    kind: Literal["taxi_out", "taxi_in"]
    points: list[list[float]] = Field(min_length=1, max_length=30)


class TaxiPreview(BaseModel):
    airport: str
    path: list[list[float]]
    names: list[str]
    length_nm: float


# ---------- flights ----------
class Waypoint(BaseModel):
    ident: str
    name: str | None = None
    lat: float
    lon: float
    alt_ft: int | None = None
    ias_kt: int | None = None
    kind: str | None = None
    via: str | None = None
    sid_star: bool = False
    cum_nm: float
    cum_s: float


class TaxiRoute(BaseModel):
    airport: str
    names: list[str]
    path: list[list[float]]
    length_nm: float
    points: list[list[float]]
    set_by_name: str
    set_at: datetime


class GateRef(BaseModel):
    ref: str
    lat: float
    lon: float
    hdg: float | None = None


class Position(BaseModel):
    lat: float
    lon: float
    heading: float
    on_ground: bool
    track: str | None
    distance_nm: float
    total_nm: float
    progress_pct: float
    elapsed_s: int = 0  # time already flown / taxied on this track
    total_s: int = 0  # time of the whole track
    prev_wp: str | None
    next_wp: str | None
    wp_index: int
    alt_ft: int | None
    kind: Literal["estimee", "manuelle"]
    paused: bool


class ActionInfo(BaseModel):
    code: str
    label: str
    confirm: bool
    blocked: str | None = None  # why the action cannot be used yet (e.g. taxi route not entered)


class FlightSummary(BaseModel):
    id: str
    callsign: str
    pilot_id: str
    pilot_name: str
    aircraft_type: str
    departure: str
    arrival: str
    phase: str
    prev_phase: str | None = None
    source: Literal["simbrief"]
    version: int
    hold: bool
    dep_gate: GateRef | None = None
    arr_gate: GateRef | None = None
    arr_gate_by: Literal["pilote", "atc"] | None = None  # "pilote" = souhaitée, "atc" = assignée
    position: Position
    created_at: datetime
    updated_at: datetime
    controller_callsign: str | None = None  # position responsible right now (None = non contrôlé)
    flight_time_s: int = 0  # planned flight time (SimBrief, take-off to landing)
    dep_rwy: str | None = None
    arr_rwy: str | None = None


class FlightDetail(FlightSummary):
    route: list[Waypoint]
    route_string: str | None
    full_route: str | None = None  # « LSGG/04 SID ... STAR LFPG/27R »
    can_delete: bool = False  # administrator / creator
    can_stop_taxi: bool = False  # « Stop / Reprendre » while taxiing (ATC if controlled, pilot otherwise)
    can_edit_dep_rwy: bool = False  # the controller may correct the runway (route re-planned)
    can_edit_arr_rwy: bool = False
    dep_runways: list[str] = []
    arr_runways: list[str] = []
    cruise_alt_ft: int | None
    plan_meta: dict[str, str | int | float | None]
    taxi_out: TaxiRoute | None
    taxi_in: TaxiRoute | None
    allowed_actions: list[ActionInfo]
    step_prev: str | None = None  # phase « Étape précédente » leads to (None: no button)
    step_next: str | None = None
    controller_name: str | None = None
    controller_callsign: str | None = None
    is_controller: bool = False
    sid: str | None = None
    star: str | None = None
    approach_note: str | None = None
    pushback_dir: str | None = None
    pushback_to: dict | None = None
    can_control: bool
    can_edit_taxi: bool
    can_edit_gates: bool
    is_owner: bool
    # server-computed responsibility (lib/control.py)
    controlled: bool = False
    can_edit_taxi_out: bool = False
    can_edit_taxi_in: bool = False
    can_edit_dep_gate: bool = False
    can_edit_arr_gate: bool = False
    can_pick_holding: bool = False
    can_edit_profile: bool = False
    can_nav: bool = False  # direct / attente (controller in charge, or the pilot when uncontrolled)
    holding: dict | None = None  # attente en cours / demandée (engine.holding_info)
    reject_until: datetime | None = None  # take-off can be interrupted until then (1 min)
    takeoff_cleared: bool = False  # lining up, then take-off by itself
    lineup: list[list[float]] | None = None  # move TOC / TOD (the pilot of the flight, or whoever is in charge of it)
    toc_nm: float | None = None
    tod_nm: float | None = None
    can_edit_strip: bool = False
    holding_point: dict | None = None
    # plan de vol SimBrief: airports and runways used (lib/runways)
    dep_name: str | None = None
    arr_name: str | None = None
    dep_rwy: str | None = None
    arr_rwy: str | None = None
    has_pdf: bool = False


class FlightsResponse(BaseModel):
    server_time: datetime
    flights: list[FlightSummary]


class FlightEvent(BaseModel):
    id: str
    flight_id: str | None
    callsign: str | None
    at: datetime
    type: str
    label: str
    actor_name: str
    actor_role: str
    details: str | None = None


class LatLon(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)


class ProfileMarkerIn(BaseModel):
    """TOC / TOD moved along the route: to the aircraft's current position, or by a number of NM (+ later, - earlier)."""
    marker: Literal["TOC", "TOD"]
    version: int
    here: bool = False
    shift_nm: float | None = Field(default=None, ge=-500, le=500)


class ActionIn(BaseModel):
    action: str
    version: int
    pushback_dir: Literal["N", "NE", "E", "SE", "S", "SW", "W", "NW"] | None = None
    pushback_to: LatLon | None = None  # where the tug leaves the aircraft (clicked on the map)
    # take-off interrupted: taxiway used to vacate the runway, then the new holding point or the stand
    exit_node: int | None = None
    holding_ref: str | None = Field(default=None, max_length=40)
    gate_ref: str | None = Field(default=None, max_length=40)


class ControlIn(BaseModel):
    op: Literal["pause", "resume", "set_waypoint", "set_progress", "set_position", "clear_position", "direct_to"]
    version: int
    waypoint_index: int | None = None
    progress_nm: float | None = Field(default=None, ge=0)
    lat: float | None = Field(default=None, ge=-90, le=90)
    lon: float | None = Field(default=None, ge=-180, le=180)
    mode: Literal["snap", "free"] = "snap"


class TaxiIn(BaseModel):
    kind: Literal["taxi_out", "taxi_in"]
    points: list[list[float]] = Field(min_length=1, max_length=30)
    version: int


class HoldingIn(BaseModel):
    holding_ref: str = Field(min_length=1, max_length=30)
    holding_lat: float = Field(ge=-90, le=90)
    holding_lon: float = Field(ge=-180, le=180)
    version: int


class GatesIn(BaseModel):
    dep_gate: str | None = Field(default=None, max_length=20)
    arr_gate: str | None = Field(default=None, max_length=20)
    version: int


class TaxiStopIn(BaseModel):
    version: int
    stop: bool  # True = stop where it is, False = resume the taxi route


class RunwaysIn(BaseModel):
    version: int
    dep_rwy: str | None = Field(default=None, max_length=5, pattern=r"^[0-9]{2}[LRC]?$")
    arr_rwy: str | None = Field(default=None, max_length=5, pattern=r"^[0-9]{2}[LRC]?$")


class StepIn(BaseModel):
    direction: Literal["prev", "next"]
    version: int


class SimbriefConfirmIn(BaseModel):
    dep_gate: str = Field(min_length=1, max_length=20)  # mandatory: the aircraft starts at its stand
    arr_gate: str | None = Field(default=None, max_length=20)


class NoteIn(BaseModel):
    text: str = Field(min_length=1, max_length=500)


class ForcePhaseIn(BaseModel):
    phase: str
    reason: str = Field(min_length=3, max_length=300)
    version: int


# ---------- SimBrief ----------
class SimbriefFetchIn(BaseModel):
    # SimBrief "Pilot ID" (numeric, shown in SimBrief > Account Settings).
    pilot_id: str = Field(pattern=r"^\s*\d{1,10}\s*$")


class AirportRef(BaseModel):
    """Reference position from the OurAirports public dataset (no ground data)."""
    icao: str
    name: str
    lat: float
    lon: float
    configured: bool  # ground data already loaded from OpenStreetMap


class SimbriefPreview(BaseModel):
    draft_id: str
    callsign: str
    aircraft_type: str
    departure: str
    departure_name: str | None
    arrival: str
    arrival_name: str | None
    route_string: str | None
    cruise_alt_ft: int | None
    total_nm: float
    est_time_s: float
    times_from_plan: bool
    waypoints: list[Waypoint]
    warnings: list[str]
    plan_meta: dict[str, str | int | float | None]
    dep_rwy: str | None = None
    arr_rwy: str | None = None


# ---------- leaderboard ----------
class LeaderEntry(BaseModel):
    rank: int
    user_id: str | None = None
    name: str
    avatar_url: str | None = None
    hours: float
    flights: int = 0
    active_days_30: int = 0
    rating: float | None = None
    reviews: int = 0
    score: float = 0
    stars: int
    level: str | None = None


class Leaderboard(BaseModel):
    pilots: list[LeaderEntry]
    atc: list[LeaderEntry]


class StripIn(BaseModel):
    """ATC strip fields (shared between all controllers). Empty = not set."""
    squawk: str | None = Field(default=None, pattern=r"^[0-7]{4}$")
    initial_alt: int | None = Field(default=None, ge=0, le=60000)
    initial_alt_unit: Literal["FT", "FL"] = "FT"
    cruise_fl: int | None = Field(default=None, ge=0, le=600)
    approach_alt: int | None = Field(default=None, ge=0, le=60000)
    approach_alt_unit: Literal["FT", "FL"] = "FT"
    remarks: str | None = Field(default=None, max_length=120)
    sid: str | None = Field(default=None, max_length=12)
    star: str | None = Field(default=None, max_length=12)
    dep_rwy: str | None = Field(default=None, max_length=5)
    arr_rwy: str | None = Field(default=None, max_length=5)

    @model_validator(mode="after")
    def _fl_range(self):
        for v, u, label in ((self.initial_alt, self.initial_alt_unit, "Montée initiale"),
                            (self.approach_alt, self.approach_alt_unit, "Approche")):
            if v is not None and u == "FL" and v > 600:
                raise ValueError(f"{label} : un niveau de vol va de FL000 à FL600 (ex. FL060), pas {v}.")
        return self


class Strip(BaseModel):
    flight_id: str
    callsign: str
    aircraft_type: str
    pilot_name: str
    departure: str
    arrival: str
    phase: str
    dep_gate: str | None
    arr_gate: str | None
    squawk: str | None
    initial_alt: int | None
    initial_alt_unit: Literal["FT", "FL"]
    cruise_fl: int | None
    approach_alt: int | None
    approach_alt_unit: Literal["FT", "FL"]
    prefilled: list[str]
    remarks: str | None
    sid: str | None = None
    star: str | None = None
    dep_rwy: str | None = None
    arr_rwy: str | None = None
    updated_by: str | None
    updated_at: datetime | None
    can_edit: bool = False
    controller_callsign: str | None = None


FREQ_PATTERN = r"^1(1[89]|2\d|3[0-6])\.\d{2,3}$"


class AtcPositionIn(BaseModel):
    """Option 1: an airport position (kind=airport, icao, position APP/TWR/GND). Option 2: a centre (kind=center, CTR
    implied). The frequency is optional when a pre-recorded one exists."""
    kind: Literal["airport", "center"]
    icao: str = Field(min_length=3, max_length=4, pattern=r"^[A-Za-z0-9]{3,4}$")
    position: Literal["APP", "TWR", "GND"] | None = None
    frequency: str | None = Field(default=None, pattern=FREQ_PATTERN)


class PreopeningIn(AtcPositionIn):
    """Announced opening of a position later (at least 1 h ahead, one at a time per controller). start_at in UTC."""
    start_at: datetime


class Preopening(BaseModel):
    id: str
    user_id: str
    controller: str
    callsign: str
    type: str
    icao: str
    name: str | None = None
    frequency: str
    start_at: datetime
    created_at: datetime
    status: Literal["prevue", "ouverte", "annulee", "expiree"]
    cancel_request_at: datetime | None = None  # the controller asked the Responsable ATC to cancel it
    cancel_reason: str | None = None
    can_cancel: bool = False  # direct cancellation (Responsable ATC, administrators)
    can_request_cancel: bool = False  # the controller himself: request with a mandatory reason
    can_decide: bool = False  # accept / refuse a pending request


class FrequencyInfo(BaseModel):
    icao: str
    position: str
    frequency: str | None
    source: Literal["ourairports", "communaute"] | None
    name: str | None = None
    open_positions: list[str] = []
    missing_before: list[str] = []  # positions that must be open first (APP -> TWR -> GND)


class Handover(BaseModel):
    id: str
    airport: str
    position: str
    callsign: str
    frequency: str
    from_controller: str
    reason: str
    created_at: datetime
    deadline: datetime


class AtcPosition(BaseModel):
    id: str
    callsign: str
    type: str
    frequency: str
    controller: str
    airport: str | None
    lat: float | None
    lon: float | None
    radius_nm: float
    fir_id: str | None
    tracon_id: str | None
    opened_at: datetime
    last_seen: datetime


class AirspaceResponse(BaseModel):
    attribution: str
    features: list[dict]


class ReviewIn(BaseModel):
    flight_id: str = Field(min_length=1, max_length=64)
    target_id: str = Field(min_length=1, max_length=64)
    rating: int = Field(ge=1, le=5)
    comment: str = Field(default="", max_length=500)


class Review(BaseModel):
    id: str
    flight_id: str
    callsign: str
    author_id: str
    author_name: str
    target_id: str
    target_name: str
    target_role: Literal["pilote", "atc"]
    rating: int
    comment: str
    status: Literal["pending", "accepted", "rejected"]
    created_at: datetime
    decided_at: datetime | None = None
    decided_by: str | None = None


class PublicReview(BaseModel):
    id: str
    author_name: str
    callsign: str
    target_role: Literal["pilote", "atc"]
    rating: int
    comment: str
    created_at: datetime


class Interaction(BaseModel):
    flight_id: str
    callsign: str
    departure: str
    arrival: str
    target_id: str
    target_name: str
    target_role: Literal["pilote", "atc"]
    at: datetime


class ReviewDecisionIn(BaseModel):
    decision: Literal["accept", "reject"]


class PublicProfile(BaseModel):
    id: str
    display_name: str
    avatar_url: str | None
    discord_username: str | None
    atc_allowed: bool
    atc_flights: int = 0  # « vols contrôlés »
    level: str | None
    stars: int
    pilot_hours: float
    atc_hours: float
    flights: int
    flights_cancelled: int
    rating: float | None
    reviews_count: int
    reviews: list[PublicReview]
    member_since: datetime
    # roles held on the SkyCommunity Discord, shown as badges on the profile
    is_creator: bool = False
    is_admin: bool = False
    is_atc_lead: bool = False
    is_pilot: bool = True
    can_delete: bool = False  # the viewer (administrator / creator) may delete this profile


class HistoryEntry(BaseModel):
    id: str
    callsign: str
    pilot_id: str
    pilot_name: str
    aircraft_type: str
    departure: str
    arrival: str
    phase: str
    departed_at: datetime | None
    arrived_at: datetime | None
    duration_min: int | None
    created_at: datetime


# ---------- ATC planning ----------
HHMM = r"^([01]\d|2[0-3]):[0-5]\d$"
DATE = r"^\d{4}-\d{2}-\d{2}$"


class PlanningIn(BaseModel):
    """An availability announced by a controller (times in UTC)."""
    date: str = Field(pattern=DATE)
    kind: Literal["airport", "center"]
    icao: str = Field(min_length=3, max_length=4, pattern=r"^[A-Za-z0-9]{3,4}$")
    position: Literal["APP", "TWR", "GND", "CTR"]
    frequency: str | None = Field(default=None, pattern=FREQ_PATTERN)
    start: str = Field(pattern=HHMM)
    end: str = Field(pattern=HHMM)


class PlanningChangeIn(PlanningIn):
    reason: str | None = Field(default=None, max_length=200)


class PlanningDecisionIn(BaseModel):
    decision: Literal["accept", "refuse"]
    comment: str | None = Field(default=None, max_length=200)


class PlanningRequest(BaseModel):
    id: str
    slot_id: str
    callsign: str
    requested_by: str
    requested_by_id: str
    requested_at: datetime
    reason: str | None = None
    before: dict
    changes: dict
    status: Literal["pending", "accepted", "refused"]
    decided_by: str | None = None
    decided_at: datetime | None = None
    comment: str | None = None


class PlanningSlot(BaseModel):
    id: str
    user_id: str
    controller: str
    date: str
    kind: Literal["airport", "center"]
    icao: str
    position: str
    callsign: str
    frequency: str
    start: str
    end: str
    name: str | None = None
    created_at: datetime
    updated_at: datetime
    last_change_by: str | None = None  # who validated the last modification
    pending_request: PlanningRequest | None = None
    can_request_change: bool = False
    can_delete: bool = False
