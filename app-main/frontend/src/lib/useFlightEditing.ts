import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { MapMode } from "@/components/AtcControls";
import type { MapTaxi } from "@/components/RadarMap";
import { apiPost, apiPut } from "@/lib/api";
import { useFlightMutation } from "@/lib/hooks";
import type { FlightDetail, Ground, Holding } from "@/lib/types";

import { tr } from "@/lib/i18n";
export interface FlightEditing {
  mode: MapMode;
  setMode: (m: MapMode) => void;
  points: number[][];
  setPoints: (p: number[][]) => void;
  setDraftPath: (p: number[][]) => void;
  editingKind: "taxi_out" | "taxi_in" | null;
  startEdit: (kind: "taxi_out" | "taxi_in") => void;
  togglePickHolding: () => void;
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
export function useFlightEditing(f: FlightDetail | null | undefined, dep?: Ground, initialMode: MapMode = "view", onHoldingSaved?: () => void): FlightEditing {
  const m = useFlightMutation(f?.id);
  const [mode, setMode] = useState<MapMode>(initialMode);
  const [points, setPoints] = useState<number[][]>([]);
  const [draftPath, setDraftPath] = useState<number[][]>([]);
  const [focusKey, setFocusKey] = useState("init");
  const [push, setPush] = useState<{ dir: string; label: string } | null>(null);
  const [pick, setPick] = useState<FlightEditing["pick"]>(null);
  const id = f?.id;
  useEffect(() => {
    // another flight selected: leave any edition in progress
    setMode((cur) => (cur === initialMode ? cur : "view"));
    setPoints([]);
    setDraftPath([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const editingKind = mode === "taxi_out" || mode === "taxi_in" ? mode : null;
  const taxis: MapTaxi[] = [];
  if (f?.taxi_out && editingKind !== "taxi_out") taxis.push({ path: f.taxi_out.path, status: "valide" });
  if (f?.taxi_in && editingKind !== "taxi_in") taxis.push({ path: f.taxi_in.path, status: "valide" });
  if (editingKind && draftPath.length > 1) taxis.push({ path: draftPath, status: "brouillon" });

  const gateOf = editingKind === "taxi_out" ? f?.dep_gate : editingKind === "taxi_in" ? f?.arr_gate : null;
  const focusAt: [number, number] | null =
    mode === "pick" && pick?.points[0]
      ? [pick.points[0].lat, pick.points[0].lon]
      : (mode === "holding" || mode === "pushback") && f
      ? f.dep_gate
        ? [f.dep_gate.lat, f.dep_gate.lon]
        : dep
          ? [dep.lat, dep.lon]
          : null
      : editingKind && gateOf
        ? [gateOf.lat, gateOf.lon]
        : null;

  const startEdit = (kind: "taxi_out" | "taxi_in") => {
    if (!f) return;
    setPoints(f[kind]?.points ?? []);
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
    setMode((m) => (m === "pick" ? "view" : m));
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
    // Roulage : privilégier le clic sur les taxiways affichés ; hors aéroport = refusé
    if (editingKind && dep) {
      const dLat = Math.abs(lat - dep.lat);
      const dLon = Math.abs(lon - dep.lon);
      // ~0.15° ≈ 9 NM — hors zone aéroport
      if (dLat > 0.15 || dLon > 0.15) {
        toast.info(tr("Cliquez sur un taxiway ou une porte de l'aéroport."));
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
  const pushHint =
    mode === "pushback" && push && f?.dep_gate
      ? { lat: f.dep_gate.lat, lon: f.dep_gate.lon, hdg: PUSH_HDG[push.dir] ?? 0, label: push.label }
      : f?.phase === "repoussage" && f.dep_gate && (f as { pushback_dir?: string }).pushback_dir
        ? {
            lat: f.position?.lat ?? f.dep_gate.lat,
            lon: f.position?.lon ?? f.dep_gate.lon,
            hdg: PUSH_HDG[(f as { pushback_dir?: string }).pushback_dir || "N"] ?? 0,
            label: tr("Repoussage"),
          }
        : null;

  return {
    mode, setMode, points, setPoints, setDraftPath, editingKind, startEdit, togglePickHolding, startPushback,
    pushLabel: mode === "pushback" ? push?.label ?? null : null, taxis, pick, startPick, setPicked, stopPick,
    draftPoints: editingKind ? points : undefined,
    onMapClick,
    onHoldingClick: mode === "holding" && f?.can_pick_holding ? (_icao, h) => pickHolding(h) : undefined,
    onTaxiwayClick: editingKind
      ? (_icao, lat, lon, _name) => {
          setPoints((prev) => [...prev, [Number(lat.toFixed(6)), Number(lon.toFixed(6))]]);
        }
      : undefined,
    onGateClick: editingKind
      ? (_icao, ref) => {
          // Porte cliquée sur la carte pendant l'édition : point supplémentaire via coord porte si connue
          toast.info(tr("Porte {0} — utilisez le sélecteur de porte pour l'associer au vol.", [ref]));
        }
      : undefined,
    // Crosshair pendant tout mode d'édition (y compris après clic taxiway)
    crosshair: mode !== "view" && mode !== "holding" && mode !== "pick",
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
          : editingKind === "taxi_in"
            ? tr("Roulage arrivée : cliquez la sortie de piste (porte déjà choisie → tracé auto)")
            : editingKind
            ? tr("Saisie du roulage : cliquez les voies dans l'ordre")
            : tr("Cliquez sur la carte pour positionner l'avion"),
  };
}
