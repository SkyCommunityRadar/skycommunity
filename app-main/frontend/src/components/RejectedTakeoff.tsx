import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { apiPost } from "@/lib/api";
import { errMsg, useFlightMutation } from "@/lib/hooks";
import type { FlightDetail, TaxiPreview } from "@/lib/types";
import type { FlightEditing } from "@/lib/useFlightEditing";

import { tr } from "@/lib/i18n";

/** Take-off interrupted: the route is clicked on the taxiways, from the exit to the new holding point or the stand. */
export default function RejectedTakeoff({ flight: f, code, onClose, ed }: { flight: FlightDetail; code: "interrompre_decollage" | "retour_parking"; onClose: () => void; ed?: FlightEditing }) {
  const m = useFlightMutation(f.id);
  const toHold = code === "interrompre_decollage";
  const points = ed?.points ?? [];
  const hp = toHold ? ed?.destination ?? null : null;
  const gate = toHold ? null : ed?.destGate ?? null;
  const [preview, setPreview] = useState<TaxiPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    ed?.startReject(toHold ? "hold" : "gate");
    return () => ed?.stopReject();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const hasDest = !!hp || !!gate;
  const ready = points.length >= 2 || (points.length >= 1 && hasDest);
  useEffect(() => {
    if (!ready) {
      setPreview(null);
      setError(null);
      ed?.setDraftPath([]);
      return;
    }
    let live = true;
    const params = new URLSearchParams({ flight_id: f.id });
    if (gate) params.set("end_gate", gate);
    apiPost<TaxiPreview>(`/airports/${f.departure}/taxi-preview?${params}`, { kind: "taxi_out", points, ...(hp ? { holding_lat: hp.lat, holding_lon: hp.lon } : {}) })
      .then((p) => {
        if (!live) return;
        setPreview(p);
        setError(null);
        ed?.setDraftPath(p.path);
      })
      .catch((e) => live && setError(errMsg(e)));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, points, gate, hp?.lat, hp?.lon, f.departure, f.id]);
  const close = () => { ed?.stopReject(); onClose(); };
  const left = f.reject_until ? Math.max(0, Math.round((Date.parse(f.reject_until) - Date.now()) / 1000)) : null;
  const target = hp?.ref ?? gate ?? "";
  const names = (preview?.names ?? []).filter((n) => n !== "Stand");
  const submit = () =>
    m.mutate(
      {
        fn: () => apiPost<FlightDetail>(`/flights/${f.id}/actions`, {
          action: code, version: f.version, taxi_points: points,
          ...(toHold ? { holding_ref: hp?.ref, holding_lat: hp?.lat, holding_lon: hp?.lon } : { gate_ref: gate }),
        }),
        success: toHold ? tr("Décollage interrompu : roulage vers {0}", [target]) : tr("Décollage interrompu : retour au poste {0}", [target]),
      },
      { onSuccess: close },
    );
  return (
    <div className="space-y-3 rounded-xl border border-red-500/50 bg-red-500/8 p-4" data-testid="rejected-takeoff">
      <p className="text-sm font-semibold">{toHold ? tr("Interrompre : retour au point d'attente") : tr("Interrompre : retour au parking")}</p>
      {left != null && <p className="text-[11px] text-muted-foreground">{tr("Encore {0} s pour interrompre le décollage.", [left])}</p>}
      <p className="text-xs text-[color:var(--sc-accent-soft)]">
        {toHold
          ? tr("Cliquez le taxiway de sortie, les voies suivantes dans l'ordre, puis le nouveau point d'attente (cercle orange).")
          : tr("Cliquez le taxiway de sortie, les voies suivantes dans l'ordre, puis le poste de stationnement.")}
      </p>
      <p className="font-mono text-[11px]" data-testid="rejected-preview">
        {points.length === 0 ? tr("Aucun point.") : preview ? tr("{0} · {1} NM", [names.join(" → ") || "—", preview.length_nm.toFixed(2)]) : ready ? tr("Calcul…") : tr("Sortie choisie.")}
      </p>
      <p className={target ? "font-mono text-xs font-semibold text-emerald-300" : "text-xs text-amber-200"} data-testid="rejected-target">
        {target ? tr("Destination : {0}", [target]) : tr("Destination : pas encore cliquée")}
      </p>
      {error && <p className="text-xs text-red-300">{error}</p>}
      <Button size="sm" variant="outline" disabled={points.length === 0} onClick={() => ed?.setPoints(points.slice(0, -1))} data-testid="rejected-undo">{tr("Annuler le dernier point")}</Button>
      <div className="grid grid-cols-2 gap-2">
        <Button variant="outline" onClick={close}>{tr("Retour")}</Button>
        <Button variant="destructive" disabled={points.length === 0 || !hasDest || !preview || !!error || m.isPending} onClick={submit} data-testid="rejected-submit">{tr("Confirmer")}</Button>
      </div>
    </div>
  );
}
