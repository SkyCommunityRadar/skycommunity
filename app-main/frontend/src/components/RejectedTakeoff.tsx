import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { apiGet, apiPost } from "@/lib/api";
import { errMsg, useFlightMutation } from "@/lib/hooks";
import type { FlightDetail } from "@/lib/types";
import type { FlightEditing } from "@/lib/useFlightEditing";

import { tr } from "@/lib/i18n";
interface Options {
  exits: { node: number; name: string; lat: number; lon: number; dist_m: number }[];
  holdings: { ref: string; lat: number; lon: number }[];
  gates: string[];
}

/** Take-off interrupted: choose the taxiway to vacate the runway, then the new holding point or the stand;
 * the site builds the taxi route (runway -> exit -> taxiways -> target). */
export default function RejectedTakeoff({ flight: f, code, onClose, ed }: { flight: FlightDetail; code: "interrompre_decollage" | "retour_parking"; onClose: () => void; ed?: FlightEditing }) {
  const m = useFlightMutation(f.id);
  const q = useQuery<Options>({ queryKey: ["rejected-options", f.id], queryFn: () => apiGet<Options>(`/flights/${f.id}/rejected-options`), retry: false });
  const [target, setTarget] = useState("");
  // the exit taxiway is chosen ON THE MAP: the possible exits are shown as orange circles
  useEffect(() => {
    if (!q.data || !ed) return;
    ed.startPick(q.data.exits.map((e) => ({ id: String(e.node), lat: e.lat, lon: e.lon, label: e.name })),
      tr("Cliquez sur la carte le taxiway par lequel l'avion dégage la piste (cercles orange)"));
    return () => ed.stopPick();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.data]);
  const exit = ed?.pick?.selected ?? "";
  const chosen = q.data?.exits.find((e) => String(e.node) === exit);
  const close = () => { ed?.stopPick(); onClose(); };
  const toHold = code === "interrompre_decollage";
  const left = f.reject_until ? Math.max(0, Math.round((Date.parse(f.reject_until) - Date.now()) / 1000)) : null;
  const submit = () =>
    m.mutate(
      {
        fn: () => apiPost<FlightDetail>(`/flights/${f.id}/actions`, {
          action: code, version: f.version, exit_node: Number(exit), ...(toHold ? { holding_ref: target } : { gate_ref: target }),
        }),
        success: toHold ? tr("Décollage interrompu : roulage vers {0}", [target]) : tr("Décollage interrompu : retour au poste {0}", [target]),
      },
      { onSuccess: close },
    );
  return (
    <div className="space-y-3 rounded-xl border border-red-500/50 bg-red-500/8 p-4" data-testid="rejected-takeoff">
      <p className="text-sm font-semibold">{toHold ? tr("Interrompre : retour au point d'attente") : tr("Interrompre : retour au parking")}</p>
      {left != null && <p className="text-[11px] text-muted-foreground">{tr("Encore {0} s pour interrompre le décollage.", [left])}</p>}
      {q.isError && <p className="text-xs text-red-300">{errMsg(q.error)}</p>}
      {q.data && (
        <>
          <div className="space-y-1 text-xs">
            <span className="text-muted-foreground">{tr("1. Taxiway pour dégager la piste : cliquez-le sur la carte")}</span>
            <p className={chosen ? "font-mono font-semibold text-emerald-300" : "text-amber-200"} data-testid="rejected-exit">
              {chosen ? tr("Sortie {0}{1}", [chosen.name, chosen.dist_m >= 30 ? ` (dans ${chosen.dist_m} m)` : ""]) : tr("Aucune sortie choisie : cliquez un cercle orange sur la carte.")}
            </p>
          </div>
          <label className="block space-y-1 text-xs">
            <span className="text-muted-foreground">2. {toHold ? tr("Nouveau point d'attente") : tr("Poste de stationnement")}</span>
            <select value={target} onChange={(e) => setTarget(e.target.value)} className="h-9 w-full rounded-md border border-border bg-background px-2 font-mono text-xs" data-testid="rejected-target">
              <option value="">{toHold ? tr("Choisir le point d'attente…") : tr("Choisir le poste…")}</option>
              {(toHold ? q.data.holdings.map((h) => h.ref) : q.data.gates).map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </label>
          <p className="text-[11px] text-muted-foreground">{tr("Le site trace le roulage : piste → sortie choisie → taxiways →")}{" "}{toHold ? tr("point d'attente") : tr("poste")}.</p>
        </>
      )}
      <div className="grid grid-cols-2 gap-2">
        <Button variant="outline" onClick={close}>{tr("Retour")}</Button>
        <Button variant="destructive" disabled={!exit || !target || m.isPending} onClick={submit} data-testid="rejected-submit">{tr("Confirmer")}</Button>
      </div>
    </div>
  );
}
