import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiPost } from "@/lib/api";
import { useFlightMutation } from "@/lib/hooks";
import type { FlightDetail } from "@/lib/types";

import { tr } from "@/lib/i18n";
const SHIFTS = [-20, -5, 5, 20];

/** The pilot replaces his TOC (end of climb) / TOD (start of descent) on the route when he is late on the plan. */
export default function ProfileMarkers({ flight: f }: { flight: FlightDetail }) {
  const m = useFlightMutation(f.id);
  if (!f.can_edit_profile || (f.toc_nm == null && f.tod_nm == null)) return null;
  const inAir = f.position.track === "air";
  const here = f.position.distance_nm;
  const send = (marker: "TOC" | "TOD", body: Record<string, unknown>, label: string) =>
    m.mutate({ fn: () => apiPost<FlightDetail>(`/flights/${f.id}/profile`, { marker, version: f.version, ...body }), success: label });
  const rows = [
    { k: "TOC" as const, nm: f.toc_nm, title: tr("TOC — fin de montée"), Icon: ArrowUpRight },
    { k: "TOD" as const, nm: f.tod_nm, title: tr("TOD — début de descente"), Icon: ArrowDownRight },
  ].filter((r) => r.nm != null);
  return (
    <div className="space-y-2" data-testid="profile-markers">
      <p className="text-xs text-muted-foreground">{tr("En retard ou en avance sur le plan ? Replacez votre fin de montée et votre début de descente : l'altitude suit.")}</p>
      {rows.map(({ k, nm, title, Icon }) => (
        <div key={k} className="space-y-1.5 rounded-lg border border-border bg-background/40 p-2.5" data-testid={`profile-${k}`}>
          <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 text-xs">
            <span className="flex items-center gap-1.5 whitespace-nowrap font-semibold"><Icon className="h-3.5 w-3.5 text-[color:var(--sc-accent)]" /> {title}</span>
            <span className="font-mono text-muted-foreground">{tr("à {0} NM du départ", [nm!.toFixed(0)])}{inAir && (nm! >= here ? tr(" · dans {0} NM", [(nm! - here).toFixed(0)]) : tr(" · passé de {0} NM", [(here - nm!).toFixed(0)]))}
            </span>
          </div>
          <div className="flex flex-wrap gap-1">
            {SHIFTS.map((s) => (
              <Button key={s} size="xs" variant="outline" disabled={m.isPending} className="font-mono"
                onClick={() => send(k, { shift_nm: s }, tr("{0} déplacé de {1} NM", [k, `${s > 0 ? "+" : ""}${s}`]))}
                data-testid={`profile-${k}-${s}`}>
                {tr("{0} NM", [s > 0 ? `+${s}` : s])}</Button>
            ))}
            {inAir && (
              <Button size="xs" disabled={m.isPending} onClick={() => send(k, { here: true }, tr("{0} placé à votre position", [k]))} data-testid={`profile-${k}-here`}>{tr("Ici (ma position)")}</Button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
