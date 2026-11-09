import { useState } from "react";
import { toast } from "sonner";
import { FileText, PlaneLanding, PlaneTakeoff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiGet, apiPut } from "@/lib/api";
import { errMsg, useFlightMutation } from "@/lib/hooks";
import type { FlightDetail } from "@/lib/types";

import { tr } from "@/lib/i18n";
function End({ kind, icao, name, rwy, flight }: { kind: "dep" | "arr"; icao: string; name: string | null; rwy: string | null; flight: FlightDetail }) {
  const Icon = kind === "dep" ? PlaneTakeoff : PlaneLanding;
  const m = useFlightMutation(flight.id);
  const editable = kind === "dep" ? flight.can_edit_dep_rwy : flight.can_edit_arr_rwy;
  const options = (kind === "dep" ? flight.dep_runways : flight.arr_runways) ?? [];
  const change = (v: string) =>
    v &&
    v !== rwy &&
    m.mutate({
      fn: () => apiPut<FlightDetail>(`/flights/${flight.id}/runways`, { version: flight.version, [kind === "dep" ? "dep_rwy" : "arr_rwy"]: v }),
      success: tr("Piste {0} : {1} — trajet recalculé", [kind === "dep" ? "de départ" : "d'arrivée", v]),
    });
  return (
    <div className="min-w-0 rounded-lg border border-border bg-background/50 p-3" data-testid={`route-${kind}`}>
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        <Icon className="h-3.5 w-3.5" /> {kind === "dep" ? tr("Départ") : tr("Arrivée")}
      </div>
      <div className="mt-1 font-mono text-lg font-bold text-[#4AA8F0]">{icao}</div>
      <div className="truncate text-[11px] text-muted-foreground" title={name ?? undefined}>{name ?? "—"}</div>
      {editable && options.length > 0 ? (
        <label className="mt-2 flex items-center gap-1.5 text-xs">{tr("Piste")}<select
            value={rwy ?? ""}
            disabled={m.isPending}
            onChange={(e) => change(e.target.value)}
            className="min-w-0 flex-1 rounded-md border border-[#4AA8F0]/50 bg-card px-1.5 py-1 font-mono font-bold text-amber-200 outline-none focus:border-[#4AA8F0]"
            title={tr("Changer de piste : le trajet est recalculé sur la nouvelle piste")}
            data-testid={`route-${kind}-rwy-select`}
          >
            {!rwy && <option value="">—</option>}
            {options.map((o) => (
              <option key={o} value={o}>{o}</option>
            ))}
          </select>
        </label>
      ) : (
        <div className="mt-2 text-xs">{tr("Piste")}{" "}<b className="font-mono text-amber-200" data-testid={`route-${kind}-rwy`}>{rwy ?? tr("non précisée")}</b>
        </div>
      )}
    </div>
  );
}

/** Route tab header: departure / arrival airports and runways from the plan de vol SimBrief + the OFP PDF. */
export default function SimbriefRoute({ flight: f }: { flight: FlightDetail }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const openPdf = async () => {
    setError(null);
    setBusy(true);
    // the tab is opened right away (inside the click) so that the browser does not block it
    const w = window.open("about:blank", "_blank");
    try {
      const { url } = await apiGet<{ url: string }>(`/flights/${f.id}/simbrief-pdf`);
      if (w) {
        w.opener = null;
        w.location.href = url;
      } else window.location.assign(url);
    } catch (e) {
      w?.close();
      setError(errMsg(e));
      toast.error(tr("PDF SimBrief indisponible"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3" data-testid="simbrief-route">
      <div className="grid grid-cols-2 gap-2">
        <End kind="dep" icao={f.departure} name={f.dep_name} rwy={f.dep_rwy} flight={f} />
        <End kind="arr" icao={f.arrival} name={f.arr_name} rwy={f.arr_rwy} flight={f} />
      </div>
      {f.has_pdf ? (
        <Button variant="secondary" className="w-full" onClick={openPdf} disabled={busy} data-testid="simbrief-pdf-button">
          <FileText className="h-4 w-4" /> {busy ? tr("Ouverture…") : tr("Consulter le plan de vol SimBrief (PDF)")}
        </Button>
      ) : (
        <p className="rounded-md border border-dashed border-border p-2 text-xs text-muted-foreground" data-testid="simbrief-pdf-none">{tr("Aucun PDF SimBrief n'est associé à ce vol.")}</p>
      )}
      {error && <p className="text-xs text-red-300" data-testid="simbrief-pdf-error">{error}</p>}
    </div>
  );
}
