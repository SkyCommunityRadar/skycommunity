import { aircraftName } from "@/lib/aircraft";
import { Plane } from "lucide-react";
import { PhaseBadge } from "@/components/Badges";
import { MOVING_PHASES, PHASE_COLORS, PHASE_LABELS, fmtAlt, fmtMeters } from "@/lib/phases";
import type { FlightDetail } from "@/lib/types";

import { labels, tr } from "@/lib/i18n";
const TRACK_LABEL: Record<string, string> = labels({ air: "En vol", taxi_out: "Roulage départ", taxi_in: "Roulage arrivée", taxi_back: "Retour au parking", lineup: "Alignement" });

function Cell({ label, value, testId, accent }: { label: string; value: React.ReactNode; testId: string; accent?: boolean }) {
  return (
    <div className="min-w-0 rounded-lg bg-background/50 px-2.5 py-2">
      <div className="truncate text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`truncate font-mono text-sm ${accent ? "text-amber-200" : "text-foreground"}`} data-testid={testId}>
        {value}
      </div>
    </div>
  );
}

/** Flight summary: callsign + status, route with progress, key facts. */
/** 4 h 05 / 42 min — flight time along the planned profile. */
function fmtDuration(s: number): string {
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`;
}

export default function FlightStrip({ flight: f }: { flight: FlightDetail }) {
  const p = f.position;
  const color = PHASE_COLORS[f.phase] ?? "#4AA8F0";
  const pct = Math.max(0, Math.min(100, p.track === "air" ? p.progress_pct : p.track === "taxi_in" || ["parking", "termine"].includes(f.phase) ? 100 : 0));
  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-mono text-2xl font-bold leading-none tracking-tight text-[color:var(--sc-accent)]" data-testid="detail-callsign">
            {f.callsign}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">{tr("Appareil")}{" "}<span className="font-mono">{aircraftName(f.aircraft_type)}</span>
          </div>
        </div>
        <PhaseBadge phase={f.phase} testId="detail-phase" />
      </div>
      {f.phase === "suspendu" && f.prev_phase && (
        <p className="text-xs text-yellow-300" data-testid="suspended-note">{tr("Vol suspendu (phase précédente : {0})", [PHASE_LABELS[f.prev_phase]])}</p>
      )}

      <div className="rounded-xl border border-border bg-background/40 p-3">
        <div className="flex items-center gap-3">
          <div className="text-center">
            <div className="font-mono text-lg font-bold" data-testid="detail-departure">{f.departure}</div>
            {f.dep_rwy && <div className="text-[10px] text-muted-foreground">{tr("Piste {0}", [f.dep_rwy])}</div>}
          </div>
          {/* the line stops on each side of the aircraft: the aircraft sits on the line, never crossed by it */}
          <div className="flex h-6 flex-1 items-center">
            <div className="h-1 rounded-full transition-[width] duration-700" style={{ width: `calc(${Math.min(97, Math.max(3, pct))}% - 12px)`, background: pct > 0 ? color : "var(--color-secondary)" }} />
            <Plane className="mx-1 h-4 w-4 shrink-0 rotate-45" style={{ color }} />
            <div className="h-1 flex-1 rounded-full bg-secondary" />
          </div>
          <div className="text-center">
            <div className="font-mono text-lg font-bold" data-testid="detail-arrival">{f.arrival}</div>
            {f.arr_rwy && <div className="text-[10px] text-muted-foreground">{tr("Piste {0}", [f.arr_rwy])}</div>}
          </div>
        </div>
        <div className="mt-2 flex justify-between text-[10px] uppercase tracking-wider text-muted-foreground">
          <span>{p.track && !["parking", "preparation", "repoussage"].includes(f.phase) ? TRACK_LABEL[p.track] : tr("Au poste de stationnement")}</span>
          <span className="font-mono" data-testid="detail-progress">
            {p.track === "air"
              ? `${fmtDuration(p.elapsed_s ?? 0)} / ${fmtDuration(p.total_s ?? 0)} · `
              : p.track
                ? `${fmtMeters(p.distance_nm)} / ${fmtMeters(p.total_nm)} · `
                : ""}
            {Math.round(p.progress_pct)}%
          </span>
        </div>
        {(p.kind === "manuelle" || f.hold || (p.paused && MOVING_PHASES.has(f.phase))) && (
          <div className="mt-1.5 flex flex-wrap gap-2 font-mono text-[10px]">
            {p.kind === "manuelle" && <span className="text-amber-300">{tr("POSITION MANUELLE (ATC)")}</span>}
            {p.paused && MOVING_PHASES.has(f.phase) && !f.hold && <span className="text-muted-foreground" data-testid="detail-motion">{tr("PROGRESSION FIGÉE")}</span>}
            {f.hold && (
              <span className="text-yellow-300">
                {["roulage", "roulage_arrivee", "retour_parking"].includes(f.phase) ? tr("ARRÊTÉ SUR LE TAXIWAY") : tr("PAUSE ATC")}
              </span>
            )}
          </div>
        )}
      </div>

      <div className="grid grid-cols-3 gap-1.5">
        <Cell label={tr("Altitude")} value={p.on_ground ? tr("SOL") : fmtAlt(p.alt_ft)} testId="detail-alt" />
        <Cell label={tr("Dernier point")} value={p.prev_wp ?? "—"} testId="detail-prev-wp" />
        <Cell label={tr("Prochain point")} value={p.next_wp ?? "—"} testId="detail-next-wp" />
        <Cell label={tr("Poste départ")} value={f.dep_gate?.ref ?? "—"} testId="detail-dep-gate" accent />
        <Cell
          label={f.arr_gate_by === "atc" ? tr("Poste arr. (ATC)") : tr("Poste arr. souhaité")}
          value={f.arr_gate?.ref ?? "—"}
          testId="detail-arr-gate"
          accent
        />
        <Cell label={tr("Point d'attente")} value={f.holding_point?.ref ?? "—"} testId="detail-holding" />
      </div>
    </div>
  );
}
