import { useState } from "react";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import GatePicker from "@/components/GatePicker";
import { apiPut } from "@/lib/api";
import { useFlightMutation } from "@/lib/hooks";
import type { FlightDetail } from "@/lib/types";

import { tr } from "@/lib/i18n";
function GateState({ saved, draft, by }: { saved: string | null; draft: string; by?: string | null }) {
  if ((draft || null) !== saved) {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300" data-testid="gate-unsaved">{tr("Sélection non enregistrée")}</span>
    );
  }
  if (!saved) return <span className="text-[10px] text-muted-foreground">{tr("Aucun poste enregistré")}</span>;
  return (
    <span className="inline-flex items-center gap-1 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-300" data-testid="gate-saved">
      <Check className="h-3 w-3" /> {saved}{" "}{tr("enregistré")}{by === "atc" ? tr(" · assigné par l'ATC") : by === "pilote" ? tr(" · souhaité par le pilote") : ""}
    </span>
  );
}

export default function GatesEditor({ flight: f }: { flight: FlightDetail }) {
  const m = useFlightMutation(f.id);
  const [dep, setDep] = useState(f.dep_gate?.ref ?? "");
  const [arr, setArr] = useState(f.arr_gate?.ref ?? "");
  const [flash, setFlash] = useState(false);
  const depLocked = f.phase !== "preparation" || !f.can_edit_dep_gate;
  const arrLocked = !f.can_edit_arr_gate || (f.is_owner && !f.is_controller && f.arr_gate_by === "atc" && !f.can_control);
  const dirty = (!depLocked && (dep || null) !== (f.dep_gate?.ref ?? null)) || (!arrLocked && (arr || null) !== (f.arr_gate?.ref ?? null));
  return (
    <div className={`space-y-3 rounded-lg p-2 text-xs transition-colors duration-700 ${flash ? "bg-emerald-500/10 ring-1 ring-emerald-500/40" : ""}`} data-testid="gates-editor">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <div className="text-muted-foreground">{tr("Poste départ ({0})", [f.departure])}</div>
          {depLocked ? (
            <div className="font-mono text-sm" data-testid="gate-dep-locked">{f.dep_gate?.ref ?? "—"}</div>
          ) : (
            <GatePicker icao={f.departure} value={dep} onChange={setDep} testId="gate-dep-input" />
          )}
          <GateState saved={f.dep_gate?.ref ?? null} draft={depLocked ? f.dep_gate?.ref ?? "" : dep} />
        </div>
        <div className="space-y-1">
          <div className="text-muted-foreground">{tr("Poste arrivée ({0})", [f.arrival])}</div>
          {arrLocked ? (
            <div className="font-mono text-sm" data-testid="gate-arr-locked">{f.arr_gate?.ref ?? "—"}</div>
          ) : (
            <GatePicker icao={f.arrival} value={arr} onChange={setArr} testId="gate-arr-input" />
          )}
          <GateState saved={f.arr_gate?.ref ?? null} draft={arrLocked ? f.arr_gate?.ref ?? "" : arr} by={f.arr_gate_by} />
        </div>
      </div>
      {!(depLocked && arrLocked) && (
        <Button
          size="sm"
          variant={dirty ? "default" : "secondary"}
          disabled={m.isPending || !dirty}
          onClick={() =>
            m.mutate(
              {
                fn: () =>
                  apiPut<FlightDetail>(`/flights/${f.id}/gates`, {
                    dep_gate: depLocked ? f.dep_gate?.ref ?? null : dep || null,
                    arr_gate: arrLocked ? f.arr_gate?.ref ?? null : arr || null,
                    version: f.version,
                  }),
                success: tr("Poste{0} enregistré", [arr && !arrLocked ? ` d'arrivée ${arr}` : ""]),
              },
              {
                onSuccess: () => {
                  setFlash(true);
                  setTimeout(() => setFlash(false), 1600);
                },
              },
            )
          }
          data-testid="gates-save"
        >
          {m.isPending ? tr("Enregistrement…") : dirty ? tr("Enregistrer les postes") : tr("Postes enregistrés")}
        </Button>
      )}
    </div>
  );
}

