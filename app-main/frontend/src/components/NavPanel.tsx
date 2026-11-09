import { useState } from "react";
import { CornerUpRight, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiPost } from "@/lib/api";
import { useFlightMutation } from "@/lib/hooks";
import type { FlightDetail } from "@/lib/types";

import { tr } from "@/lib/i18n";
const TURN_CHOICES = [1, 2, 3, 4, 5, 0] as const; // 0 = jusqu'à nouvel ordre

/** Direct to a fix of the route and holding patterns — the controller in charge, or the pilot when uncontrolled. */
export default function NavPanel({ flight: f }: { flight: FlightDetail }) {
  const m = useFlightMutation(f.id);
  const [wp, setWp] = useState("");
  const [turns, setTurns] = useState<number>(2);
  if (!f.can_nav) return null;
  const here = f.position.distance_nm;
  const ahead = f.route
    .map((w, i) => ({ w, i }))
    .filter(({ w, i }) => i > 0 && i < f.route.length - 1 && w.cum_nm > here + 0.5 && w.kind !== "apt" && w.kind !== "rwy" && w.ident !== "TOC" && w.ident !== "TOD");
  const send = (body: Record<string, unknown>, success: string) =>
    m.mutate({ fn: () => apiPost<FlightDetail>(`/flights/${f.id}/nav`, { version: f.version, ...body }), success });
  const h = f.holding;
  const tLabel = (n: number | null) => (n ? (n > 1 ? tr("{0} tours", [n]) : tr("1 tour")) : tr("jusqu'à nouvel ordre"));

  return (
    <div className="space-y-3" data-testid="nav-panel">
      {h && (
        <div className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs" data-testid="holding-status">
          <p className="flex items-center gap-1.5 font-semibold text-amber-100">
            <RotateCw className="h-3.5 w-3.5" />{" "}{tr("Hold sur")}{" "}{h.ident} · {tLabel(h.turns)}
          </p>
          <p className="text-amber-100/80">
            {!h.entered
              ? tr("En route vers le point du hold.")
              : h.exit
                ? tr("Sortie demandée : l'avion finit son tour et reprend la route en passant sur le point.")
                : h.turns_done
                  ? tr("Tours prévus effectués ({0}) : sans instruction, l'avion continue le hold.", [h.laps_done])
                  : tr("Tour {0}{1} — hippodrome à droite, axe {2}°, branches de {3} min.", [Math.min(h.laps_done + 1, h.turns ?? h.laps_done + 1), h.turns ? ` / ${h.turns}` : "", Math.round(h.inbound), h.leg_s / 60])}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {h.entered && !h.exit && (
              <Button size="xs" onClick={() => send({ op: "hold_exit" }, tr("Sortie du hold demandée"))} disabled={m.isPending} data-testid="hold-exit">{tr("Sortir du hold")}</Button>
            )}
            {h.entered && (
              <>
                <Button size="xs" variant="outline" disabled={m.isPending}
                  onClick={() => send({ op: "hold_continue", turns: (h.turns ?? h.laps_done) + 1 }, tr("Hold prolongé d'un tour"))} data-testid="hold-more">{tr("+1 tour")}</Button>
                <Button size="xs" variant="outline" disabled={m.isPending}
                  onClick={() => send({ op: "hold_continue" }, "Hold jusqu'à nouvel ordre")} data-testid="hold-forever">{tr("Jusqu'à nouvel ordre")}</Button>
              </>
            )}
            {!h.entered && (
              <Button size="xs" variant="outline" onClick={() => send({ op: "hold_cancel" }, tr("Hold annulé"))} disabled={m.isPending} data-testid="hold-cancel">{tr("Annuler le hold")}</Button>
            )}
          </div>
        </div>
      )}
      <div className="space-y-2">
        <select
          value={wp}
          onChange={(e) => setWp(e.target.value)}
          className="h-9 w-full rounded-md border border-border bg-background px-2 font-mono text-xs"
          data-testid="nav-waypoint"
        >
          <option value="">{tr("Choisir un point de la route…")}</option>
          {ahead.map(({ w, i }) => (
            <option key={i} value={i}>
              {tr("{0} — dans {1} NM", [w.ident, (w.cum_nm - here).toFixed(0)])}</option>
          ))}
        </select>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button size="sm" variant="outline" disabled={wp === "" || m.isPending}
            onClick={() => send({ op: "direct", waypoint_index: Number(wp) }, tr("Direct {0}", [f.route[Number(wp)]?.ident]))} data-testid="nav-direct">
            <CornerUpRight className="h-3.5 w-3.5" />{" "}{tr("Direct")}</Button>
          {!h && (
            <>
              <select value={turns} onChange={(e) => setTurns(Number(e.target.value))}
                className="h-8 rounded-md border border-border bg-background px-2 text-xs" data-testid="nav-turns">
                {TURN_CHOICES.map((n) => <option key={n} value={n}>{tLabel(n || null)}</option>)}
              </select>
              <Button size="sm" variant="outline" disabled={wp === "" || m.isPending}
                onClick={() => send({ op: "hold", waypoint_index: Number(wp), ...(turns ? { turns } : {}) }, tr("Hold sur {0}", [f.route[Number(wp)]?.ident]))}
                data-testid="nav-hold">
                <RotateCw className="h-3.5 w-3.5" />{" "}{tr("Hold")}</Button>
            </>
          )}
        </div>
        <p className="text-[11px] text-muted-foreground">{tr("Hold : hippodrome standard (virages à droite, branches d'1 min sous le FL140). Après les tours prévus, l'avion continue le hold tant qu'on ne le fait pas sortir.")}</p>
      </div>
    </div>
  );
}
