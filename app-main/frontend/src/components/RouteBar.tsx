import { Headset, MapPin, Navigation, Plane, Route } from "lucide-react";
import { tr } from "@/lib/i18n";
import { MOVING_PHASES, PHASE_COLORS, TAXIING_PHASES } from "@/lib/phases";
import type { FlightSummary } from "@/lib/types";
import { cn } from "@/lib/utils";

/** 4 h 05 / 42 min */
export const fmtDur = (s: number) => {
  const m = Math.max(0, Math.round(s / 60));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`;
};

/** Labels shown as chips start with a capital letter (« Au poste N08 »). */
const cap = (s: string) => (s ? s.charAt(0).toLocaleUpperCase() + s.slice(1) : s);

/** Where the aircraft is right now, in a few words (same text in the list and on the flight page). */
export function whereNow(f: FlightSummary): string {
  return cap(whereNowRaw(f));
}

function whereNowRaw(f: FlightSummary): string {
  const p = f.position;
  const phase = f.phase === "suspendu" ? f.prev_phase ?? f.phase : f.phase;
  if (p.track === "air") {
    return [p.alt_ft != null ? (p.alt_ft >= 10000 ? `FL${String(Math.round(p.alt_ft / 100)).padStart(3, "0")}` : `${p.alt_ft} ft`) : null,
            p.next_wp ? tr("vers {0}", [p.next_wp]) : null].filter(Boolean).join(" · ");
  }
  if (TAXIING_PHASES.has(phase)) return p.next_wp ? tr("roule vers {0}", [p.next_wp]) : tr("au roulage");
  const stand = phase === "parking" && f.returned_to_stand ? f.dep_gate : f.arr_gate;
  if (phase === "parking") return stand ? tr("au poste {0}", [stand.ref]) : tr("au parking");
  if (phase === "point_attente") return tr("au point d'attente");
  if (phase === "atterrissage") return tr("sur la piste");
  return f.dep_gate ? tr("au poste {0}", [f.dep_gate.ref]) : "";
}

export function flagsOf(f: FlightSummary): string[] {
  const p = f.position;
  const phase = f.phase === "suspendu" ? f.prev_phase ?? f.phase : f.phase;
  return [
    f.hold && TAXIING_PHASES.has(phase) && tr("arrêté"),
    f.hold && !TAXIING_PHASES.has(phase) && tr("pause ATC"),
    p.paused && MOVING_PHASES.has(f.phase) && !f.hold && tr("progression figée"),
    p.kind === "manuelle" && tr("position manuelle"),
  ].filter(Boolean).map((x) => cap(x as string));
}

const CHIP = "inline-flex h-5 max-w-full items-center gap-1 rounded-full border px-2 text-[10px] font-semibold leading-none";

/** Departure ── flight time ── arrival, the aircraft on the line, then where it is now and the time left.
 * The same block on the flight list and on the flight page. */
export default function RouteBar({ f, large = false }: { f: FlightSummary; large?: boolean }) {
  const p = f.position;
  const air = p.track === "air";
  const color = PHASE_COLORS[f.phase] ?? "#4AA8F0";
  const pct = Math.max(0, Math.min(100, p.progress_pct || 0));
  // already done: the flight progress, full once landed, empty before take-off
  const done = air ? pct : ["atterrissage", "roulage_arrivee", "parking", "termine"].includes(f.phase) ? 100 : 0;
  const planeAt = Math.min(97, Math.max(3, done));
  const where = whereNow(f);
  // small icon telling where the aircraft is: in flight, taxiing, or parked / waiting
  const WhereIcon = air ? Navigation : TAXIING_PHASES.has(f.phase) ? Route : MapPin;
  const flags = flagsOf(f);
  const code = large ? "text-lg" : "text-[11px]";
  const rwy = large ? "text-[10px]" : "text-[9px]";
  return (
    <div className={large ? "space-y-2" : "space-y-1.5"} data-testid={`route-bar-${f.callsign}`}>
      <div className="flex items-center gap-2 font-mono">
        <div className="text-center leading-tight">
          <div className={cn("font-bold text-foreground", code)} data-testid={large ? "detail-departure" : undefined}>{f.departure}</div>
          {f.dep_rwy && <div className={cn("text-muted-foreground", rwy)}>{tr("Piste {0}", [f.dep_rwy])}</div>}
        </div>
        <span className={cn("relative flex-1", large ? "h-8" : "h-7")}>
          {f.flight_time_s ? (
            <span className={cn("absolute left-1/2 top-0 -translate-x-1/2 whitespace-nowrap leading-none text-muted-foreground", large ? "text-[11px]" : "text-[10px]")} data-testid={`route-time-${f.callsign}`}>
              {fmtDur(f.flight_time_s)}
            </span>
          ) : null}
          {/* the line stops on each side of the aircraft: the aircraft sits ON the line, never crossed by it */}
          <span className="absolute inset-x-0 bottom-0 flex h-4 items-center">
            <span className="h-[2px] rounded-full" style={{ width: `calc(${planeAt}% - 10px)`, background: done > 0 ? color : "var(--color-secondary)" }} />
            <Plane className={cn("mx-1 shrink-0 rotate-45", large ? "h-4 w-4" : "h-3.5 w-3.5")} style={{ color }} data-testid={`route-plane-${f.callsign}`} />
            <span className="h-[2px] flex-1 rounded-full bg-secondary" />
          </span>
        </span>
        <div className="text-center leading-tight">
          <div className={cn("font-bold text-foreground", code)} data-testid={large ? "detail-arrival" : undefined}>{f.arrival}</div>
          {f.arr_rwy && <div className={cn("text-muted-foreground", rwy)}>{tr("Piste {0}", [f.arr_rwy])}</div>}
        </div>
      </div>
      {/* pilot on the left; on the right, two chips of the SAME shape: where the aircraft is, who controls it */}
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5" data-testid={large ? "detail-progress" : undefined}>
        <span className="min-w-0 truncate text-[11px] font-semibold text-foreground/90">{f.pilot_name}</span>
        <span className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
          {(where || (air && p.total_s)) ? (
            <span className={cn(CHIP, "border-[#4AA8F0]/30 bg-[#2B63C9]/12 text-[#9CCBF5]")} data-testid={`flight-row-where-${f.callsign}`}>
              <WhereIcon className="h-3 w-3 shrink-0" />
              <span className="truncate">
                {where}
                {air && p.total_s ? <span className="opacity-70">{where ? " · " : ""}{tr("reste {0}", [fmtDur((p.total_s ?? 0) - (p.elapsed_s ?? 0))])}</span> : null}
              </span>
            </span>
          ) : null}
          {/* same badge as in the flight panel: who controls the flight */}
          <span
            className={cn(CHIP, f.controller_callsign ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300" : "border-border bg-secondary/40 text-muted-foreground")}
            data-testid={`flight-row-sync-${f.callsign}`}
          >
            <Headset className="h-3 w-3 shrink-0" />
            <span className="truncate">{f.controller_callsign ?? tr("Non contrôlé")}</span>
          </span>
        </span>
      </div>
      {flags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {flags.map((x) => <span key={x} className="rounded bg-amber-500/15 px-1.5 font-sans text-[10px] font-semibold text-amber-300">{x}</span>)}
        </div>
      )}
    </div>
  );
}
