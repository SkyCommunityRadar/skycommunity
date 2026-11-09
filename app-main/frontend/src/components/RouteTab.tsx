import SimbriefRoute from "@/components/SimbriefRoute";
import { fmtAlt, fmtDateTime, fmtDuration } from "@/lib/phases";
import type { FlightDetail } from "@/lib/types";

import { labels, tr } from "@/lib/i18n";
/** Route tab: departure / arrival + runways + PDF, route string, waypoint table, plan details. */
export default function RouteTab({ flight: f }: { flight: FlightDetail }) {
  const META_LABELS: Record<string, string> = labels({
    ofp_id: "OFP SimBrief", airac: "Cycle AIRAC", cruise_tas_kt: "Vitesse de croisière (kt)", air_distance_nm: "Distance air (NM)",
    sched_out: "Départ prévu (cales)", sched_off: "Décollage prévu", sched_on: "Atterrissage prévu", sched_in: "Arrivée prévue (cales)",
    est_time_enroute_s: "Durée estimée", alternate: "Dégagement",
  });
  const meta = Object.entries(f.plan_meta)
    .filter(([k, v]) => v != null && v !== "" && k in META_LABELS)
    .map(([k, v]): [string, string] => [
      META_LABELS[k],
      k === "est_time_enroute_s" ? fmtDuration(Number(v)) : k.startsWith("sched_") ? fmtDateTime(String(v)) : String(v),
    ]);

  return (
    <div className="space-y-3">
            <SimbriefRoute flight={f} />
            {(f.full_route || f.route_string) && (
              <p className="rounded-md border border-border bg-background/50 p-2 font-mono text-[11px] leading-relaxed text-sky-200 break-words" data-testid="route-string">
                {f.full_route || f.route_string}
              </p>
            )}
            <div className="text-xs text-muted-foreground">{tr("Croisière {0} · {1} NM · durée estimée {2}", [fmtAlt(f.cruise_alt_ft), f.route[f.route.length - 1].cum_nm.toFixed(0), fmtDuration(f.route[f.route.length - 1].cum_s)])}
            </div>
            <table className="w-full font-mono text-[11px]" data-testid="route-table">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="text-left font-normal">#</th>
                  <th className="text-left font-normal">{tr("Point")}</th>
                  <th className="text-right font-normal">{tr("Alt.")}</th>
                  <th className="text-right font-normal">{tr("Cumul")}</th>
                  <th className="text-right font-normal">{tr("Temps")}</th>
                </tr>
              </thead>
              <tbody>
                {f.route.map((w, i) => (
                  <tr
                    key={`${w.ident}-${i}`}
                    className={i === f.position.wp_index && f.position.track === "air" ? "text-[#4AA8F0]" : ""}
                  >
                    <td>{i}</td>
                    <td>{w.ident}</td>
                    <td className="text-right">{fmtAlt(w.alt_ft)}</td>
                    <td className="text-right">{tr("{0} NM", [w.cum_nm.toFixed(0)])}</td>
                    <td className="text-right">{fmtDuration(w.cum_s)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {meta.length > 0 && (
              <dl className="grid grid-cols-2 gap-1 text-[11px]" data-testid="plan-meta">
                {meta.map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-muted-foreground">{k}</dt>
                    <dd className="font-mono">{String(v)}</dd>
                  </div>
                ))}
              </dl>
            )}
            <p className="text-[10px] text-muted-foreground">{tr("Créé le {0}", [fmtDateTime(f.created_at)])}</p>
    </div>
  );
}
