import { Button } from "@/components/ui/button";
import { apiPost } from "@/lib/api";
import { useFlightMutation } from "@/lib/hooks";
import type { ControlIn, FlightDetail } from "@/lib/types";

import { tr } from "@/lib/i18n";
export type MapMode = "view" | "snap" | "free" | "taxi_out" | "taxi_in" | "holding" | "pushback" | "gate_dep" | "gate_arr" | "reject_hold" | "reject_gate";

/** Controller tools (ATC/Admin only — enforced server-side too). */
export default function AtcControls({
  flight: f,
  mode,
  setMode,
}: {
  flight: FlightDetail;
  mode: MapMode;
  setMode: (m: MapMode) => void;
}) {
  const m = useFlightMutation(f.id);

  const send = (body: Omit<ControlIn, "version">, success: string) =>
    m.mutate({ fn: () => apiPost<FlightDetail>(`/flights/${f.id}/control`, { ...body, version: f.version }), success });

  return (
    <div className="space-y-3 text-xs" data-testid="atc-controls">
      <div className="space-y-1.5">
        <div className="text-[11px] text-muted-foreground">{tr("Sur la carte (ATC)")}</div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant={mode === "snap" ? "default" : "outline"}
            onClick={() => setMode(mode === "snap" ? "view" : "snap")}
            data-testid="ctl-pick-snap"
          >{tr("Replacer sur la route (l'avion continue)")}</Button>
          <Button
            size="sm"
            variant={mode === "free" ? "default" : "outline"}
            onClick={() => setMode(mode === "free" ? "view" : "free")}
            data-testid="ctl-pick-free"
          >{tr("Placer librement (l'avion s'arrête)")}</Button>
          {f.position.kind === "manuelle" && (
            <Button size="sm" variant="outline" onClick={() => send({ op: "clear_position" }, tr("Position libre annulée : l'avion reprend sa route"))} data-testid="ctl-clear-position">{tr("Annuler la position libre")}</Button>
          )}
        </div>
        {(mode === "snap" || mode === "free") && (
          <p className="text-[#4AA8F0]" data-testid="ctl-pick-hint">{tr("Cliquez sur la carte pour placer l'avion.")}</p>
        )}
      </div>

      {!f.can_stop_taxi && (
        <div className="flex flex-wrap gap-2">
          {f.hold ? (
            <Button size="sm" variant="secondary" onClick={() => send({ op: "resume" }, tr("Progression reprise"))} data-testid="ctl-resume">{tr("Reprendre la progression")}</Button>
          ) : (
            <Button size="sm" variant="secondary" onClick={() => send({ op: "pause" }, tr("Progression en pause"))} data-testid="ctl-pause">{tr("Pause de la progression")}</Button>
          )}
        </div>
      )}
    </div>
  );
}
