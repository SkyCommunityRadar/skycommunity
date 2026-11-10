import { Link } from "react-router-dom";
import { MapPin } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useGround } from "@/lib/hooks";
import type { FlightDetail } from "@/lib/types";

import { tr } from "@/lib/i18n";
/** Uncontrolled flight: the pilot (or the responsible controller) picks the holding point by clicking it on the map. */
export default function HoldingPicker({ flight, onPickHolding, pickingHolding }: { flight: FlightDetail; onPickHolding?: () => void; pickingHolding?: boolean }) {
  const ground = useGround(flight.can_pick_holding ? flight.departure : undefined);
  const holdings = (ground.data?.holdings ?? []).filter((h) => h.ref);
  if (!flight.can_pick_holding) {
    return flight.holding_point ? (
      <p className="text-xs text-muted-foreground" data-testid="holding-current">{tr("Point d'attente :")}{" "}<b className="font-mono text-emerald-300">{flight.holding_point.ref}</b>
      </p>
    ) : null;
  }
  if (ground.isLoading) return <p className="text-xs text-muted-foreground">{tr("Chargement des points d'attente…")}</p>;
  if (holdings.length === 0) return <p className="text-xs text-muted-foreground">{tr("Aucun point d'attente n'est cartographié à {0} dans OpenStreetMap.", [flight.departure])}</p>;
  return (
              <div className="flex items-center justify-between gap-2 rounded-xl border border-border bg-background/40 p-3" data-testid="holding-picker">
                <div className="min-w-0 text-xs">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{tr("Point d'attente")}</div>
                  {flight.holding_point ? (
                    <div data-testid="holding-current">
                      <b className="font-mono text-sm text-emerald-300">{flight.holding_point.ref}</b> <span className="text-muted-foreground">{tr("· roulage généré")}</span>
                    </div>
                  ) : (
                    <div className="text-muted-foreground">{tr("Aucun point choisi")}</div>
                  )}
                </div>
                {onPickHolding ? (
                  <Button type="button" size="lg" variant={pickingHolding ? "default" : "secondary"} onClick={onPickHolding} disabled={false} data-testid="holding-pick-on-map">
                    <MapPin className="h-4 w-4" /> {pickingHolding ? tr("Cliquez sur la carte…") : flight.holding_point ? tr("Changer") : tr("Choisir sur la carte")}
                  </Button>
                ) : (
                  <Link to={`/flights/${flight.id}?pick=holding`} className="inline-flex items-center gap-1 text-xs text-[color:var(--sc-accent)] hover:underline" data-testid="holding-open-detail">
                    <MapPin className="h-3.5 w-3.5" />{" "}{tr("Choisir sur la carte")}</Link>
                )}
              </div>
  );
}
