import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { apiPost, apiPut } from "@/lib/api";
import { errMsg, useFlightMutation, useGround } from "@/lib/hooks";
import type { FlightDetail, TaxiPreview } from "@/lib/types";
import { isLiveTaxi } from "@/lib/useFlightEditing";

import { tr } from "@/lib/i18n";
interface Props {
  flight: FlightDetail;
  kind: "taxi_out" | "taxi_in";
  editing: boolean;
  points: number[][];
  setPoints: (p: number[][]) => void;
  onPreview: (path: number[][]) => void;
  onEdit: () => void;
  onDone: () => void;
  /** departure: the holding point the route ends on */
  destination?: { ref: string | null; lat: number; lon: number } | null;
  /** arrival: the stand clicked as the last point */
  destGate?: string | null;
}

/** The route is entered point by point on the taxiways, in the order it is followed. */
export default function TaxiEditor({ flight, kind, editing, points, setPoints, onPreview, onEdit, onDone, destination, destGate }: Props) {
  const m = useFlightMutation(flight.id);
  const current = flight[kind];
  const out = kind === "taxi_out";
  const icao = out ? flight.departure : flight.arrival;
  const startGate = out ? flight.dep_gate?.ref : undefined;
  const ground = useGround(out ? undefined : flight.arrival);
  const [preview, setPreview] = useState<TaxiPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const live = isLiveTaxi(flight, kind);
  const dest = out && destination ? { holding_lat: destination.lat, holding_lon: destination.lon } : {};
  const needGate = !out && (ground.data?.gates.length ?? 1) > 0;
  // arrival: at least the exit taxiway and the stand (from the aircraft when it is already taxiing)
  const ready = out ? points.length > 0 || !!destination : live ? points.length > 0 || !!destGate : points.length >= 2 || (points.length >= 1 && !!destGate);

  useEffect(() => {
    if (!editing || !ready) {
      setPreview(null);
      setError(null);
      onPreview([]);
      return;
    }
    let live_ = true;
    const params = new URLSearchParams({ flight_id: flight.id });
    if (startGate) params.set("start_gate", startGate);
    if (!out && destGate) params.set("end_gate", destGate);
    apiPost<TaxiPreview>(`/airports/${icao}/taxi-preview?${params}`, { kind, points, ...dest })
      .then((p) => {
        if (!live_) return;
        setPreview(p);
        setError(null);
        onPreview(p.path);
      })
      .catch((e) => live_ && setError(errMsg(e)));
    return () => {
      live_ = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, ready, points, icao, startGate, destGate, destination?.lat, destination?.lon]);

  const canSave = !!preview && !error && !m.isPending && (out || !needGate || !!destGate);
  const save = () =>
    m.mutate(
      {
        fn: () => apiPut<FlightDetail>(`/flights/${flight.id}/taxi`, {
          kind, points, version: flight.version,
          ...(destination && out ? { holding_ref: destination.ref, holding_lat: destination.lat, holding_lon: destination.lon } : {}),
          ...(destGate && !out ? { gate_ref: destGate } : {}),
        }),
        success: tr("Roulage enregistré"),
      },
      { onSuccess: onDone },
    );
  const names = (preview?.names ?? []).filter((n) => n !== "Stand");

  return (
    <div className="space-y-2 text-xs" data-testid={`taxi-editor-${kind}`}>
      {editing ? (
        <div className="space-y-2">
          <p className="text-[#4AA8F0]">
            {out
              ? live
                ? tr("L'avion roule : le nouveau tracé part de sa position. Cliquez les voies à emprunter, point par point, jusqu'à la destination.")
                : tr("Cliquez sur la carte les voies à emprunter, point par point. Cliquez un cercle orange pour changer de point d'attente. Le tracé suit automatiquement les taxiways.")
              : live
                ? tr("L'avion roule : le nouveau tracé part de sa position. Cliquez les voies à emprunter, puis la porte d'arrivée.")
                : tr("Cliquez d'abord le taxiway de sortie de piste, puis les voies suivantes dans l'ordre, et terminez en cliquant la porte d'arrivée.")}
          </p>
          {out && destination && <p className="text-[11px] text-muted-foreground" data-testid="taxi-destination">{tr("Destination : {0}", [destination.ref ?? "—"])}</p>}
          {!out && <p className="text-[11px] text-muted-foreground" data-testid="taxi-destination">{destGate ? tr("Destination : {0}", [destGate]) : needGate ? tr("Porte d'arrivée : pas encore cliquée") : ""}</p>}
          <p className="font-mono text-[11px]" data-testid={`taxi-${kind}-preview`}>
            {!ready ? (points.length ? tr("Sortie choisie.") : tr("Aucun point.")) : preview ? tr("{0} · {1} NM", [names.join(" → ") || "—", preview.length_nm.toFixed(2)]) : tr("Calcul…")}
          </p>
          {error && <p className="text-red-400" data-testid={`taxi-${kind}-error`}>{error}</p>}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={save} disabled={!canSave} data-testid={`taxi-${kind}-save`}>{tr("Enregistrer le roulage")}</Button>
            <Button size="sm" variant="outline" disabled={points.length === 0} onClick={() => setPoints(points.slice(0, -1))} data-testid={`taxi-${kind}-undo`}>{tr("Annuler le dernier point")}</Button>
            <Button size="sm" variant="ghost" onClick={onDone} data-testid={`taxi-${kind}-cancel`}>{tr("Fermer")}</Button>
          </div>
        </div>
      ) : (
        (out ? flight.can_edit_taxi_out : flight.can_edit_taxi_in) && (
          <Button size="sm" variant="secondary" onClick={onEdit} data-testid={`taxi-${kind}-edit`}>
            {current ? tr("Modifier le roulage") : tr("Saisir le roulage")}
          </Button>
        )
      )}
    </div>
  );
}
