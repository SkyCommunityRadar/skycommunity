import { ChevronsLeft, ChevronLeft, ChevronRight, ChevronsRight, SkipBack, SkipForward } from "lucide-react";
import { apiPost } from "@/lib/api";
import { useFlightMutation } from "@/lib/hooks";
import type { FlightDetail } from "@/lib/types";
import { fmtMeters } from "@/lib/phases";

import { tr } from "@/lib/i18n";
/** Move the aircraft back/forward along its current track (taxi or route). Owner pilot or ATC/admin. */
export default function PositionNudge({ flight: f }: { flight: FlightDetail }) {
  const m = useFlightMutation(f.id);
  const track = f.position.track;
  if (!track || f.position.total_nm <= 0) return null;
  const air = track === "air";
  const inHold = air && !!f.holding?.entered;
  // on the ground the steps are round distances in metres (40 m / 200 m), not 0.02 NM = 37 m
  const M = 1 / 1852;
  const small = air ? 5 : 40 * M;
  const big = air ? 25 : 200 * M;
  const send = (body: { delta_nm?: number; waypoint?: "prev" | "next" }) =>
    m.mutate({ fn: () => apiPost<FlightDetail>(`/flights/${f.id}/nudge`, { ...body, version: f.version }) });
  const fmt = (v: number) => (air ? `${v} NM` : fmtMeters(v));
  const seg = "flex h-8 flex-1 items-center justify-center gap-1 whitespace-nowrap px-2 text-[11px] font-semibold text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-50";
  return (
    <div className="space-y-1.5" data-testid="position-nudge">
      <div className="text-[11px] text-muted-foreground">{inHold ? tr("Dans le hold") : air ? tr("Sur la route") : tr("Sur le roulage")}</div>
      <div className="flex divide-x divide-border overflow-hidden rounded-lg border border-border bg-background/40">
        {air && (
          <button className={seg} disabled={m.isPending} onClick={() => send({ waypoint: "prev" })} data-testid="nudge-prev-wp" title={inHold ? tr("Tour précédent") : tr("Point préc.")}>
            <SkipBack className="h-3 w-3" />
          </button>
        )}
        <button className={seg} disabled={m.isPending} onClick={() => send({ delta_nm: -big })} data-testid="nudge-back-big" title={`-${fmt(big)}`}>
          <ChevronsLeft className="h-3 w-3" /> {fmt(big)}
        </button>
        <button className={seg} disabled={m.isPending} onClick={() => send({ delta_nm: -small })} data-testid="nudge-back" title={`-${fmt(small)}`}>
          <ChevronLeft className="h-3 w-3" /> {fmt(small)}
        </button>
        <button className={seg} disabled={m.isPending} onClick={() => send({ delta_nm: small })} data-testid="nudge-forward" title={`+${fmt(small)}`}>
          {fmt(small)} <ChevronRight className="h-3 w-3" />
        </button>
        <button className={seg} disabled={m.isPending} onClick={() => send({ delta_nm: big })} data-testid="nudge-forward-big" title={`+${fmt(big)}`}>
          {fmt(big)} <ChevronsRight className="h-3 w-3" />
        </button>
        {air && (
          <button className={seg} disabled={m.isPending} onClick={() => send({ waypoint: "next" })} data-testid="nudge-next-wp" title={inHold ? tr("Tour suivant") : tr("Point suiv.")}>
            <SkipForward className="h-3 w-3" />
          </button>
        )}
      </div>
      <p className="text-[10px] text-muted-foreground">{inHold ? tr("Reculer ou avancer l'avion dans le hold (⏮ ⏭ : tour précédent / suivant). Il ne sort du hold que si la sortie a été demandée.") : air ? tr("Reculer ou avancer l'avion sur sa route (⏮ ⏭ : point précédent / suivant).") : tr("Reculer ou avancer l'avion sur son roulage.")}</p>
    </div>
  );
}
