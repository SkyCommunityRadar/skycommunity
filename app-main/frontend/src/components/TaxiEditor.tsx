import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { apiPost, apiPut } from "@/lib/api";
import { errMsg, useFlightMutation } from "@/lib/hooks";
import type { FlightDetail, TaxiPreview } from "@/lib/types";

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
}

/** ATC enters a taxi route by clicking on the taxiways; the server routes it along the real OSM network. */
export default function TaxiEditor({ flight, kind, editing, points, setPoints, onPreview, onEdit, onDone }: Props) {
  const m = useFlightMutation(flight.id);
  const current = flight[kind];
  const out = kind === "taxi_out";
  const icao = out ? flight.departure : flight.arrival;
  const gate = out ? flight.dep_gate : flight.arr_gate;
  const [preview, setPreview] = useState<TaxiPreview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!editing || points.length === 0) {
      setPreview(null);
      onPreview([]);
      return;
    }
    let live = true;
    const params = new URLSearchParams({ flight_id: flight.id });
    if (gate) params.set(out ? "start_gate" : "end_gate", gate.ref);
    const qs = `?${params}`;
    apiPost<TaxiPreview>(`/airports/${icao}/taxi-preview${qs}`, { kind, points })
      .then((p) => {
        if (!live) return;
        setPreview(p);
        setError(null);
        onPreview(p.path);
      })
      .catch((e) => live && setError(errMsg(e)));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, points, icao, gate?.ref]);

  const save = () =>
    m.mutate(
      { fn: () => apiPut<FlightDetail>(`/flights/${flight.id}/taxi`, { kind, points, version: flight.version }), success: tr("Roulage enregistré") },
      { onSuccess: onDone },
    );

  return (
    <div className="space-y-2 text-xs" data-testid={`taxi-editor-${kind}`}>
      {editing ? (
        <div className="space-y-2">
          <p className="text-[#4AA8F0]">
            {out
              ? tr("Cliquez sur la carte les voies à emprunter dans l'ordre jusqu'au point d'attente. Le tracé suit automatiquement les taxiways.")
              : gate
                ? tr("Porte {0} enregistrée : cliquez la sortie de piste (même derrière l'avion). Le tracé jusqu'à la porte est calculé automatiquement. Vous pouvez ajouter d'autres points si besoin.", [gate.ref])
                : tr("Choisissez d'abord la porte d'arrivée, puis cliquez la sortie de piste. Le tracé se calcule automatiquement.")}
          </p>
          <p className="font-mono text-[11px]" data-testid={`taxi-${kind}-preview`}>
            {points.length === 0 ? tr("Aucun point.") : preview ? tr("{0} · {1} NM", [preview.names.join(" → ") || "—", preview.length_nm.toFixed(2)]) : tr("Calcul…")}
          </p>
          {error && <p className="text-red-400" data-testid={`taxi-${kind}-error`}>{error}</p>}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={save} disabled={!preview || !!error || m.isPending} data-testid={`taxi-${kind}-save`}>{tr("Enregistrer le roulage")}</Button>
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
