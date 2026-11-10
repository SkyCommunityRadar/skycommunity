import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import type { MapMode } from "@/components/AtcControls";
import type { MapTaxi } from "@/components/RadarMap";
import { apiGet, apiPost, apiPut } from "@/lib/api";
import { useFlightMutation } from "@/lib/hooks";
import type { FlightDetail, Ground, Holding } from "@/lib/types";

import { tr } from "@/lib/i18n";
type HoldingDest = { ref: string | null; lat: number; lon: number };

/** The aircraft is already taxiing on this route: a change starts from where it is. */
export const isLiveTaxi = (f: FlightDetail, kind: "taxi_out" | "taxi_in") =>
  kind === "taxi_out" ? f.phase === "roulage" || f.phase === "point_attente" : f.phase === "roulage_arrivee";

/** Is this click on the airport, at most `maxM` metres from one of its taxiways / runways? */
function nearGround(g: Ground, lat: number, lon: number, maxM = 150): boolean {
  const kx = 111_320 * Math.cos((lat * Math.PI) / 180), ky = 110_540;
  for (const line of g.lines) {
    for (let i = 0; i + 1 < line.path.length; i++) {
      const ax = (line.path[i][1] - lon) * kx, ay = (line.path[i][0] - lat) * ky;
      const bx = (line.path[i + 1][1] - lon) * kx, by = (line.path[i + 1][0] - lat) * ky;
      const vx = bx - ax, vy = by - ay, vv = vx * vx + vy * vy;
      const t = vv === 0 ? 0 : Math.max(0, Math.min(1, -(ax * vx + ay * vy) / vv));
      if (Math.hypot(ax + t * vx, ay + t * vy) <= maxM) return true;
    }
  }
  return false;
}

export interface FlightEditing {
  mode: MapMode;
  setMode: (m: MapMode) => void;
  points: number[][];
  setPoints: (p: number[][]) => void;
  setDraftPath: (p: number[][]) => void;
  editingKind: "taxi_out" | "taxi_in" | null;
  startEdit: (kind: "taxi_out" | "taxi_in") => void;
  togglePickHolding: () => void;
  /** stand chosen by clicking it on the map; with `onPick` the stand is handed back instead of being saved */
  startGatePick: (side: "dep" | "arr", onPick?: (ref: string) => void) => void;
  /** departure taxi: holding point the route goes to */
  destination: HoldingDest | null;
  pickPoints?: { id: string; lat: number; lon: number; label: string; selected?: boolean }[];
  onPickPoint: (id: string) => void;
  /** pushback: the nose direction is chosen, now the end point is clicked on the map */
  startPushback: (dir: string, label: string) => void;
  pushLabel: string | null;
  /** generic pick on the map (runway exit after an interrupted take-off) */
  pick: { points: { id: string; lat: number; lon: number; label: string }[]; selected: string | null; title: string } | null;
  startPick: (points: { id: string; lat: number; lon: number; label: string }[], title: string) => void;
  setPicked: (id: string | null) => void;
  stopPick: () => void;
  /** map props */
  taxis: MapTaxi[];
  draftPoints?: number[][];
  onMapClick: (lat: number, lon: number) => void;
  onHoldingClick?: (icao: string, h: Holding) => void;
  onTaxiwayClick?: (icao: string, lat: number, lon: number, name?: string | null) => void;
  onGateClick?: (icao: string, ref: string) => void;
  crosshair: boolean;
  pushHint?: { lat: number; lon: number; hdg: number; label?: string } | null;
  focusAt: [number, number] | null;
  focusKey: string;
  banner: string | null;
}

/** Map interactions on one flight (taxi entry, holding point, position correction) — shared by the radar side
 * panel and the full flight page so both behave exactly the same. The server decides what is allowed. */
export function useFlightEditing(f: FlightDetail | null | undefined, dep?: Ground, initialMode: MapMode = "view", onHoldingSaved?: () => void, arr?: Ground): FlightEditing {
  const m = useFlightMutation(f?.id);
  const [mode, setMode] = useState<MapMode>(initialMode);
  const [points, setPoints] = useState<number[][]>([]);
  const [draftPath, setDraftPath] = useState<number[][]>([]);
  const [focusKey, setFocusKey] = useState("init");
  const [push, setPush] = useState<{ dir: string; label: string } | null>(null);
  const [pick, setPick] = useState<FlightEditing["pick"]>(null);
  const [destination, setDestination] = useState<HoldingDest | null>(null);
  const gatePickCb = useRef<((ref: string) => void) | null>(null);
  const id = f?.id;
  useEffect(() => {
    // another flight selected: leave any edition in progress
    setMode((cur) => (cur === initialMode ? cur : "view"));
    setPoints([]);
    setDraftPath([]);
    setDestination(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const editingKind = mode === "taxi_out" || mode === "taxi_in" ? mode : null;
  const taxis: MapTaxi[] = [];
  if (f?.taxi_out && editingKind !== "taxi_out") taxis.push({ path: f.taxi_out.path, status: "valide" });
  if (f?.taxi_in && editingKind !== "taxi_in") taxis.push({ path: f.taxi_in.path, status: "valide" });
  if (editingKind && draftPath.length > 1) taxis.push({ path: draftPath, status: "brouillon" });

  const gateMode = mode === "gate_dep" || mode === "gate_arr";
  const gateOf = editingKind === "taxi_out" ? f?.dep_gate : editingKind === "taxi_in" ? f?.arr_gate : null;
  const pickExits = mode === "taxi_in" && !!f && !isLiveTaxi(f, "taxi_in");
  const exitsQ = useQuery<{ exits: { node: number; name: string; lat: number; lon: number }[] }>({
    queryKey: ["arrival-exits", id, f?.arr_rwy],
    queryFn: () => apiGet(`/flights/${id}/arrival-exits`),
    enabled: pickExits,
    staleTime: 60_000,
    retry: false,
  });
  const exits = pickExits && points.length === 0 ? exitsQ.data?.exits ?? [] : [];
  const focusAt: [number, number] | null =
    mode === "pick" && pick?.points[0]
      ? [pick.points[0].lat, pick.points[0].lon]
      : (mode === "holding" || mode === "pushback") && f
      ? f.dep_gate
        ? [f.dep_gate.lat, f.dep_gate.lon]
        : dep
          ? [dep.lat, dep.lon]
          : null
      : gateMode && f
        ? mode === "gate_dep"
          ? f.dep_gate ? [f.dep_gate.lat, f.dep_gate.lon] : dep ? [dep.lat, dep.lon] : null
          : f.arr_gate ? [f.arr_gate.lat, f.arr_gate.lon] : arr ? [arr.lat, arr.lon] : null
      : pickExits && f
        ? [f.route[f.route.length - 1].lat, f.route[f.route.length - 1].lon] // on the arrival runway, where the exits are
      : editingKind && gateOf
        ? [gateOf.lat, gateOf.lon]
        : null;

  const startEdit = (kind: "taxi_out" | "taxi_in") => {
    if (!f) return;
    // pendant le roulage on repart de l'avion ; le point d'attente est la destination, pas un point intermédiaire
    let pts = isLiveTaxi(f, kind) ? [] : f[kind]?.points ?? [];
    const hp = kind === "taxi_out" ? f.holding_point ?? null : null;
    if (hp && pts.length) {
      const last = pts[pts.length - 1];
      if (Math.abs(last[0] - hp.lat) < 1e-5 && Math.abs(last[1] - hp.lon) < 1e-5) pts = pts.slice(0, -1);
    }
    setPoints(pts);
    setDestination(hp);
    setMode(kind);
    setFocusKey(`${kind}-${Date.now()}`);
  };
  const togglePickHolding = () => {
    setMode((cur) => (cur === "holding" ? "view" : "holding"));
    setFocusKey(`holding-${Date.now()}`);
  };
  const startPick = (points: { id: string; lat: number; lon: number; label: string }[], title: string) => {
    setPick({ points, selected: null, title });
    setMode("pick");
    if (points[0]) setFocusKey(`pick-${Date.now()}`);
  };
  const setPicked = (id: string | null) => setPick((p) => (p ? { ...p, selected: id } : p));
  const stopPick = () => {
    setPick(null);
    gatePickCb.current = null;
    setMode((m) => (m === "pick" || m === "gate_dep" || m === "gate_arr" ? "view" : m));
  };
  const startGatePick = (side: "dep" | "arr", onPick?: (ref: string) => void) => {
    setPick(null);
    gatePickCb.current = onPick ?? null;
    setMode(side === "dep" ? "gate_dep" : "gate_arr");
    setFocusKey(`gate-${side}-${Date.now()}`);
  };
  const saveGate = (ref: string) => {
    if (!f) return;
    const cur = f, isDep = mode === "gate_dep";
    m.mutate(
      {
        fn: () => apiPut<FlightDetail>(`/flights/${cur.id}/gates`, {
          dep_gate: isDep ? ref : cur.dep_gate?.ref ?? null,
          arr_gate: isDep ? cur.arr_gate?.ref ?? null : ref,
          version: cur.version,
        }),
        success: tr("Poste {0} enregistré", [ref]),
      },
      { onSuccess: () => setMode("view") },
    );
  };
  const startPushback = (dir: string, label: string) => {
    setPush({ dir, label });
    setMode("pushback");
    setFocusKey(`pushback-${Date.now()}`);
  };
  const pickHolding = (h: Holding) => {
    if (!f) return;
    const cur = f;
    m.mutate(
      {
        fn: () => apiPut<FlightDetail>(`/flights/${cur.id}/holding`, { holding_ref: h.ref, holding_lat: h.lat, holding_lon: h.lon, version: cur.version }),
        success: tr("Point d'attente {0} enregistré — roulage généré", [h.ref]),
      },
      {
        onSuccess: () => {
          setMode("view");
          onHoldingSaved?.();
        },
      },
    );
  };
  const onMapClick = (lat: number, lon: number) => {
    if (!f) return;
    if (mode === "holding") {
      toast.info(tr("Cliquez directement sur un point d'attente (cercle orange)."));
      return;
    }
    if (mode === "pick") {
      toast.info(tr("Cliquez directement sur un des cercles orange."));
      return;
    }
    if (gateMode) {
      toast.info(tr("Cliquez directement sur un poste de l'aéroport."));
      return;
    }
    // Roulage : uniquement sur les voies de l'aéroport concerné
    if (editingKind) {
      const g = editingKind === "taxi_out" ? dep : arr;
      if (g && !nearGround(g, lat, lon)) {
        toast.info(tr("Point hors de l'aéroport : cliquez sur une voie de {0}.", [g.icao]));
        return;
      }
    }
    if (mode === "pushback" && push) {
      const cur = f;
      const p = push;
      m.mutate(
        {
          fn: () => apiPost<FlightDetail>(`/flights/${cur.id}/actions`, {
            action: "repoussage", version: cur.version, pushback_dir: p.dir,
            pushback_to: { lat: Number(lat.toFixed(7)), lon: Number(lon.toFixed(7)) },
          }),
          success: tr("Repoussage, nez vers le {0}", [p.label.toLowerCase()]),
        },
        { onSuccess: () => { setMode("view"); setPush(null); } },
      );
      return;
    }
    if (editingKind) {
      setPoints([...points, [Number(lat.toFixed(6)), Number(lon.toFixed(6))]]);
      return;
    }
    if (mode !== "snap" && mode !== "free") return;
    const cur = f;
    m.mutate({
      fn: () => apiPost<FlightDetail>(`/flights/${cur.id}/control`, { op: "set_position", lat, lon, mode, version: cur.version }),
      success: mode === "snap" ? tr("Position recalée sur la trajectoire") : tr("Position manuelle appliquée"),
    });
    setMode("view");
  };

  const PUSH_HDG: Record<string, number> = { N: 0, NE: 45, E: 90, SE: 135, S: 180, SW: 225, W: 270, NW: 315 };
  // temporary: the arrow disappears as soon as the aircraft has reached its pushback point and turned
  const pushDone = !!f?.pushback_to && Math.abs(f.position.lat - f.pushback_to.lat) < 2e-5 && Math.abs(f.position.lon - f.pushback_to.lon) < 2e-5;
  const pushHint =
    mode === "pushback" && push && f?.dep_gate
      ? { lat: f.dep_gate.lat, lon: f.dep_gate.lon, hdg: PUSH_HDG[push.dir] ?? 0, label: push.label }
      : f?.phase === "repoussage" && f.dep_gate && f.pushback_dir && !pushDone
        ? { lat: f.position.lat, lon: f.position.lon, hdg: PUSH_HDG[f.pushback_dir] ?? 0, label: tr("Repoussage") }
        : null;

  return {
    mode, setMode, points, setPoints, setDraftPath, editingKind, startEdit, togglePickHolding, startPushback, startGatePick, destination,
    pickPoints: pick
      ? pick.points.map((x) => ({ ...x, selected: x.id === pick.selected }))
      : exits.length > 0
        ? exits.map((e) => ({ id: String(e.node), lat: e.lat, lon: e.lon, label: e.name }))
        : undefined,
    onPickPoint: (pointId) => {
      const ex = exits.find((e) => String(e.node) === pointId);
      if (ex) setPoints([[Number(ex.lat.toFixed(6)), Number(ex.lon.toFixed(6))]]);
      else setPicked(pointId);
    },
    pushLabel: mode === "pushback" ? push?.label ?? null : null, taxis, pick, startPick, setPicked, stopPick,
    draftPoints: editingKind ? points : undefined,
    onMapClick,
    onHoldingClick:
      mode === "holding" && f?.can_pick_holding
        ? (_icao, h) => pickHolding(h)
        : editingKind === "taxi_out"
          ? (icao, h) => {
              if (icao === f?.departure) setDestination({ ref: h.ref, lat: h.lat, lon: h.lon });
            }
          : undefined,
    onTaxiwayClick: editingKind
      ? (icao, lat, lon, _name) => {
          if (icao !== (editingKind === "taxi_out" ? f?.departure : f?.arrival)) {
            toast.info(tr("Point hors de l'aéroport : cliquez sur une voie de {0}.", [editingKind === "taxi_out" ? f?.departure : f?.arrival]));
            return;
          }
          setPoints([...points, [Number(lat.toFixed(6)), Number(lon.toFixed(6))]]);
        }
      : undefined,
    onGateClick: gateMode
      ? (icao, ref) => {
          if (icao !== (mode === "gate_dep" ? f?.departure : f?.arrival)) {
            toast.info(tr("Ce poste n'est pas sur l'aéroport du vol."));
            return;
          }
          if (gatePickCb.current) gatePickCb.current(ref);
          else saveGate(ref);
        }
      : undefined,
    // Crosshair pendant tout mode d'édition (y compris après clic taxiway)
    crosshair: mode !== "view" && mode !== "holding" && mode !== "pick" && !gateMode,
    pushHint,
    focusAt, focusKey,
    banner:
      mode === "view"
        ? null
        : mode === "holding"
          ? tr("Choisissez le point d'attente : cliquez un cercle orange")
          : mode === "pick"
            ? pick?.title ?? tr("Cliquez sur la carte")
          : mode === "pushback"
            ? tr("Repoussage (nez vers le {0}) : cliquez où l'avion doit s'arrêter", [push?.label.toLowerCase() ?? "…"])
          : gateMode
            ? tr("Cliquez sur le poste de stationnement, directement sur la carte")
          : editingKind === "taxi_in" && pickExits && points.length === 0
            ? tr("Roulage arrivée : cliquez la sortie de piste (cercles orange)")
            : editingKind
            ? tr("Tracé du roulage : cliquez les voies dans l'ordre, point par point")
            : tr("Cliquez sur la carte pour positionner l'avion"),
  };
}
