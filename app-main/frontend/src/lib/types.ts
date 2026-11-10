// Hand-written mirrors of backend/models/schemas.py — keep in sync.
export type Role = "pilote" | "atc" | "admin" | "aucun"; // "aucun" = mode not chosen yet

export interface User {
  id: string;
  email: string | null;
  display_name: string;
  discord_id: string | null;
  avatar_url: string | null;
  role: Role;
  access: Access;
  atc_allowed: boolean;
  simbrief_id: string | null;
  disabled: boolean;
  banned_until: string | null;
  ban_reason: string | null;
  roles_synced_at: string | null;
  created_at: string;
  inactivity?: Record<"pilote" | "atc", InactivityStatus> | null;
}

/** Inactivity rule (backend lib/activity) for one access. */
export interface InactivityStatus {
  kind: "pilote" | "atc";
  state: "non_concerne" | "actif" | "bientot" | "dispense" | "suspendu";
  last_activity: string | null;
  days_inactive: number | null;
  deadline: string | null;
  exempt_until: string | null;
  manual: boolean;
  reason: string | null;
  request_at: string | null;
}

export interface MemberActivity {
  id: string;
  display_name: string;
  avatar_url: string | null;
  badges: string[];
  status: InactivityStatus;
  flights_total: number;
  flights_30d: number;
  atc_hours: number;
  request_message: string | null;
  exempt_reason: string | null;
}

export interface ActivityRule {
  enabled: boolean;
  days: number;
  warn_days: number;
  by?: string;
  at?: string;
}

export interface ActivitySettings {
  since: string;
  pilote: ActivityRule;
  atc: ActivityRule;
  can_manage: { pilote: boolean; atc: boolean };
}

export interface Absence {
  id: string;
  user_id: string;
  display_name: string;
  avatar_url: string | null;
  kinds: ("pilote" | "atc")[];
  start: string;
  end: string;
  days: number;
  reason: string;
  status: "en_attente" | "acceptee" | "refusee" | "annulee" | "ecourtee";
  auto: boolean;
  frequent: boolean;
  created_at: string;
  decided_by: string | null;
  decided_at: string | null;
  comment: string | null;
  ongoing: boolean;
  can_decide: boolean;
  can_end: boolean;
}

export interface Preopening {
  id: string;
  user_id: string;
  controller: string;
  callsign: string;
  type: string;
  icao: string;
  name: string | null;
  frequency: string;
  start_at: string;
  created_at: string;
  status: "prevue" | "ouverte" | "annulee" | "expiree";
  cancel_request_at: string | null;
  cancel_reason: string | null;
  can_cancel: boolean;
  can_request_cancel: boolean;
  can_decide: boolean;
}

/** Rights computed server-side from the Discord roles — mirrors backend models/schemas.py Access. */
export interface Access {
  pilote: boolean;
  atc: boolean;
  atc_lead: boolean;
  pilot_lead: boolean;
  admin: boolean;
  creator: boolean;
}

export interface Gate {
  ref: string;
  lat: number;
  lon: number;
  kind: "stand" | "gate";
}

export interface Holding {
  ref: string;
  lat: number;
  lon: number;
  auto?: boolean; // name built by the site (taxiway - runway): none in OpenStreetMap
}

export interface GroundLine {
  name: string;
  kind: string;
  path: number[][];
}

export interface GroundArea {
  kind: string;
  path: number[][];
}

export interface Ground {
  icao: string;
  name: string;
  lat: number;
  lon: number;
  fetched_at: string;
  source: string;
  gates: Gate[];
  holdings: Holding[];
  lines: GroundLine[];
  areas?: GroundArea[];
}

export interface GroundSummary {
  icao: string;
  name: string;
  lat: number;
  lon: number;
  gates: number;
  fetched_at: string;
}

export interface TaxiPreview {
  airport: string;
  path: number[][];
  names: string[];
  length_nm: number;
}

export interface GateRef {
  ref: string;
  lat: number;
  lon: number;
}

export interface AirportRef {
  icao: string;
  name: string;
  lat: number;
  lon: number;
  configured: boolean;
}

export interface Waypoint {
  ident: string;
  name: string | null;
  lat: number;
  lon: number;
  alt_ft: number | null;
  ias_kt: number | null;
  kind: string | null;
  via?: string | null;
  sid_star?: boolean;
  cum_nm: number;
  cum_s: number;
}

export interface TaxiRoute {
  airport: string;
  names: string[];
  path: number[][];
  length_nm: number;
  points: number[][];
  set_by_name: string;
  set_at: string;
}

export interface Position {
  lat: number;
  lon: number;
  heading: number;
  on_ground: boolean;
  track: string | null;
  distance_nm: number;
  total_nm: number;
  progress_pct: number;
  elapsed_s?: number;
  total_s?: number;
  prev_wp: string | null;
  next_wp: string | null;
  wp_index: number;
  alt_ft: number | null;
  kind: "estimee" | "manuelle";
  paused: boolean;
}

export interface ActionInfo {
  code: string;
  label: string;
  confirm: boolean;
  to?: string | null;
  blocked?: string | null; // why it cannot be used yet (taxi route not entered…)
}

export interface FlightSummary {
  returned_to_stand?: boolean;
  id: string;
  callsign: string;
  pilot_id: string;
  pilot_name: string;
  aircraft_type: string;
  departure: string;
  arrival: string;
  phase: string;
  prev_phase: string | null;
  source: "simbrief";
  version: number;
  hold: boolean;
  dep_gate: GateRef | null;
  arr_gate: GateRef | null;
  arr_gate_by: "pilote" | "atc" | null; // "pilote" = souhaitée, "atc" = assignée
  position: Position;
  created_at: string;
  updated_at: string;
  controller_callsign: string | null; // position responsible right now (null = non contrôlé)
  flight_time_s?: number; // planned flight time (SimBrief)
  dep_rwy?: string | null;
  arr_rwy?: string | null;
}

export interface FlightDetail extends FlightSummary {
  route: Waypoint[];
  route_string: string | null;
  full_route?: string | null; // « LSGG/04 SIRO1N … TINI9W LFPG/27R »
  can_delete?: boolean; // administrator / creator: delete the flight for good
  can_edit_dep_rwy?: boolean; // controller: correct the runway (the route is re-planned)
  can_stop_taxi?: boolean; // « Stop / Reprendre » while taxiing (ATC if controlled, pilot otherwise)
  can_edit_arr_rwy?: boolean;
  dep_runways?: string[];
  arr_runways?: string[];
  cruise_alt_ft: number | null;
  plan_meta: Record<string, string | number | null>;
  taxi_out: TaxiRoute | null;
  taxi_in: TaxiRoute | null;
  taxi_back?: TaxiRoute | null;
  allowed_actions: ActionInfo[];
  /** phase the « previous / next step » buttons lead to (null: no button) */
  step_prev?: string | null;
  step_next?: string | null;
  controller_name: string | null;
  is_controller: boolean;
  sid: string | null;
  star: string | null;
  approach_note: string | null;
  pushback_dir: string | null;
  pushback_to?: { lat: number; lon: number } | null;
  can_control: boolean;
  can_edit_taxi: boolean;
  can_edit_gates: boolean;
  is_owner: boolean;
  // server-computed responsibility (backend lib/control.py)
  controlled: boolean;
  can_edit_taxi_out: boolean;
  can_edit_taxi_in: boolean;
  can_edit_dep_gate: boolean;
  can_edit_arr_gate: boolean;
  can_pick_holding: boolean;
  can_edit_profile?: boolean;
  can_nav?: boolean;
  holding?: Holding_ | null;
  takeoff_cleared?: boolean;
  reject_until?: string | null;
  lineup?: number[][] | null;
  toc_nm?: number | null;
  tod_nm?: number | null;
  can_edit_strip: boolean;
  holding_point: { ref: string | null; lat: number; lon: number } | null;
  dep_name: string | null;
  arr_name: string | null;
  dep_rwy: string | null;
  arr_rwy: string | null;
  has_pdf: boolean;
}

export interface FlightsResponse {
  server_time: string;
  flights: FlightSummary[];
}

export interface FlightEvent {
  id: string;
  flight_id: string | null;
  callsign: string | null;
  at: string;
  type: string;
  label: string;
  actor_name: string;
  actor_role: string;
  details: string | null;
}

export type ControlOp =
  | "pause"
  | "resume"
  | "set_waypoint"
  | "set_progress"
  | "set_position"
  | "clear_position"
  | "direct_to";

export interface ControlIn {
  op: ControlOp;
  version: number;
  waypoint_index?: number;
  progress_nm?: number;
  lat?: number;
  lon?: number;
  mode?: "snap" | "free";
}

export interface SimbriefPreview {
  draft_id: string;
  callsign: string;
  aircraft_type: string;
  departure: string;
  departure_name: string | null;
  arrival: string;
  arrival_name: string | null;
  route_string: string | null;
  cruise_alt_ft: number | null;
  total_nm: number;
  est_time_s: number;
  times_from_plan: boolean;
  waypoints: Waypoint[];
  warnings: string[];
  plan_meta: Record<string, string | number | null>;
  dep_rwy: string | null;
  arr_rwy: string | null;
}

export type AltUnit = "FT" | "FL";

export interface StripIn {
  squawk: string | null;
  initial_alt: number | null;
  initial_alt_unit: AltUnit;
  cruise_fl: number | null;
  approach_alt: number | null;
  approach_alt_unit: AltUnit;
  remarks: string | null;
  // pre-filled from SimBrief, the ATC can change them (empty = back to the plan)
  sid: string | null;
  star: string | null;
  dep_rwy: string | null;
  arr_rwy: string | null;
}

export interface Strip extends StripIn {
  /** Lettre ATIS (A–Z) calculée comme le bot Discord pour l'aéroport de départ */
  atis_letter?: string | null;
  prefilled: string[];
  flight_id: string;
  callsign: string;
  aircraft_type: string;
  pilot_name: string;
  departure: string;
  arrival: string;
  phase: string;
  dep_gate: string | null;
  arr_gate: string | null;
  updated_by: string | null;
  updated_at: string | null;
  can_edit: boolean; // server-side: the flight concerns one of my positions
  controller_callsign: string | null;
}

/** Option 1: airport position (APP → TWR → GND order). Option 2: centre (CTR implied). */
export interface AtcPositionIn {
  kind: "airport" | "center";
  icao: string;
  position?: "APP" | "TWR" | "GND";
  frequency?: string;
  /** Same labels as Discord: "🇫🇷 FR" | "🇬🇧 EN" | "🇫🇷🇬🇧 FR / EN" */
  languages?: string;
}

export interface FrequencyInfo {
  icao: string;
  position: string;
  frequency: string | null;
  source: "ourairports" | "communaute" | null;
  name: string | null;
  open_positions: string[];
  missing_before: string[];
}

export interface Handover {
  id: string;
  airport: string;
  position: string;
  callsign: string;
  frequency: string;
  from_controller: string;
  reason: string;
  created_at: string;
  deadline: string;
}

export interface AtcPosition {
  id: string;
  callsign: string;
  type: string;
  languages?: string | null; // « 🇫🇷 FR », « 🇬🇧 EN », « 🇫🇷🇬🇧 FR / EN »
  frequency: string;
  controller: string;
  airport: string | null;
  lat: number | null;
  lon: number | null;
  radius_nm: number;
  fir_id: string | null;
  tracon_id: string | null;
  opened_at: string;
  last_seen: string;
}

export interface AirspaceFeature {
  type: "Feature";
  geometry: { type: string; coordinates: unknown };
  properties: { id: string; name: string; kind: "fir" | "tracon"; prefixes: string[] };
}

export interface AirspaceResponse {
  attribution: string;
  features: AirspaceFeature[];
}

export interface ReviewIn {
  flight_id: string;
  target_id: string;
  rating: number;
  comment: string;
}

export interface Review {
  id: string;
  flight_id: string;
  callsign: string;
  author_id: string;
  author_name: string;
  target_id: string;
  target_name: string;
  target_role: "pilote" | "atc";
  rating: number;
  comment: string;
  status: "pending" | "accepted" | "rejected";
  created_at: string;
  decided_at: string | null;
  decided_by: string | null;
}

export interface PublicReview {
  id: string;
  author_name: string;
  callsign: string;
  target_role: "pilote" | "atc";
  rating: number;
  comment: string;
  created_at: string;
}

export interface Interaction {
  flight_id: string;
  callsign: string;
  departure: string;
  arrival: string;
  target_id: string;
  target_name: string;
  target_role: "pilote" | "atc";
  at: string;
  snoozed?: boolean;
  deadline?: string | null;
}

export interface PublicProfile {
  id: string;
  display_name: string;
  avatar_url: string | null;
  discord_username: string | null;
  atc_allowed: boolean;
  level: string | null;
  stars: number;
  pilot_hours: number;
  atc_hours: number;
  atc_flights: number; // « vols contrôlés »
  flights: number;
  flights_cancelled: number;
  rating: number | null;
  reviews_count: number;
  reviews: PublicReview[];
  member_since: string;
  is_creator?: boolean;
  is_admin?: boolean;
  is_atc_lead?: boolean;
  is_pilot?: boolean;
  can_delete?: boolean;
}

export interface HistoryEntry {
  id: string;
  callsign: string;
  pilot_id: string;
  pilot_name: string;
  aircraft_type: string;
  departure: string;
  arrival: string;
  phase: string;
  departed_at: string | null;
  arrived_at: string | null;
  duration_min: number | null;
  created_at: string;
}

export interface LeaderEntry {
  rank: number;
  user_id: string | null;
  name: string;
  avatar_url: string | null;
  hours: number;
  flights: number;
  active_days_30: number;
  rating: number | null;
  reviews: number;
  score: number;
  stars: number;
  level: string | null;
}

// ---------- ATC planning (backend routers/planning.py) ----------
export interface PlanningIn {
  date: string; // YYYY-MM-DD (UTC)
  kind: "airport" | "center";
  icao: string;
  position: "APP" | "TWR" | "GND" | "CTR";
  frequency?: string | null;
  start: string; // HH:MM UTC
  end: string;
}

export interface PlanningRequest {
  id: string;
  slot_id: string;
  callsign: string;
  requested_by: string;
  requested_by_id: string;
  requested_at: string;
  reason: string | null;
  before: Record<string, string>;
  changes: Record<string, string>;
  status: "pending" | "accepted" | "refused";
  decided_by: string | null;
  decided_at: string | null;
  comment: string | null;
}

export interface PlanningSlot {
  id: string;
  user_id: string;
  controller: string;
  date: string;
  kind: "airport" | "center";
  icao: string;
  position: string;
  callsign: string;
  frequency: string;
  start: string;
  end: string;
  name: string | null;
  created_at: string;
  updated_at: string;
  last_change_by: string | null;
  pending_request: PlanningRequest | null;
  can_request_change: boolean;
  can_delete: boolean;
}

/** Holding pattern (attente) on a fix of the route — backend engine.holding_info. */
export interface Holding_ {
  ident: string;
  turns: number | null;
  laps_done: number;
  entered: boolean;
  exit: boolean;
  inbound: number;
  leg_s: number;
  speed_kt: number;
  lap_s: number;
  path: number[][];
  turns_done: boolean;
}


export interface AtisInfo {
  icao: string;
  letter?: string | null;
  name?: string | null;
  wind_deg?: number;
  wind_speed_kt?: number;
  qnh?: number;
  visibility_m?: number;
  temp_c?: number | null;
  text?: string;
  raw?: string | null;
  runways_dep?: string[];
  runways_arr?: string[];
  frequencies?: Record<string, string>;
  airport_db?: boolean;
  metar_ok?: boolean;
  metar_source?: string | null;
  elevation_ft?: number | null;
  iata?: string | null;
}
