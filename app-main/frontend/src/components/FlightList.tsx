import { aircraftName } from "@/lib/aircraft";
import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import RouteBar from "@/components/RouteBar";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PhaseBadge } from "@/components/Badges";
import { ACTIVE_PHASES, PHASE_LABELS } from "@/lib/phases";
import type { FlightSummary } from "@/lib/types";
import { cn } from "@/lib/utils";


import { tr } from "@/lib/i18n";
export default function FlightList({
  flights,
  selectedId,
  onSelect,
  loading,
  error,
}: {
  flights: FlightSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  loading: boolean;
  error: boolean;
}) {
  const [q, setQ] = useState("");
  const [phase, setPhase] = useState("all");
  const [airport, setAirport] = useState("");

  const shown = useMemo(() => {
    const s = q.trim().toUpperCase();
    const ap = airport.trim().toUpperCase();
    return flights.filter(
      (f) =>
        (!s || f.callsign.includes(s) || f.pilot_name.toUpperCase().includes(s)) &&
        (phase === "all" || f.phase === phase) &&
        (!ap || f.departure.includes(ap) || f.arrival.includes(ap)),
    );
  }, [flights, q, phase, airport]);

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-2 border-b border-border p-3">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{tr("Vols actifs")}</h2>
          <span className="rounded-full bg-[color:var(--sc-primary)]/15 px-2 py-0.5 font-mono text-[11px] text-[color:var(--sc-accent-soft)]" data-testid="active-flights-count">
            {shown.length}/{flights.length}
          </span>
        </div>
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={tr("Indicatif ou pilote")}
            className="h-9 pl-8 text-xs"
            data-testid="flight-search-input"
          />
        </div>
        <div className="flex gap-2">
          <Select value={phase} onValueChange={(v: string) => setPhase(v)}>
            <SelectTrigger size="sm" className="min-w-0 flex-1 text-xs" data-testid="flight-filter-phase">
              <SelectValue>{(v) => (v === "all" ? tr("Toutes phases") : PHASE_LABELS[v as string])}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{tr("Toutes phases")}</SelectItem>
              {ACTIVE_PHASES.map((p) => (
                <SelectItem key={p} value={p}>
                  {PHASE_LABELS[p]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            value={airport}
            onChange={(e) => setAirport(e.target.value.toUpperCase())}
            placeholder={tr("OACI")}
            className="h-8 w-20 shrink-0 text-center font-mono text-xs uppercase"
            maxLength={4}
            title={tr("Aéroport (ICAO)")}
            data-testid="flight-filter-airport"
          />
        </div>
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto p-2" data-testid="flight-list">
        {loading && <p className="p-2 text-xs text-muted-foreground">{tr("Chargement…")}</p>}
        {error && !loading && (
          <p className="p-2 text-xs text-red-400" data-testid="flight-list-error">{tr("Données non synchronisées — reconnexion en cours. Dernier état affiché.")}</p>
        )}
        {!loading && shown.length === 0 && (
          <p className="p-2 text-xs text-muted-foreground" data-testid="flight-list-empty">{tr("Aucun vol ne correspond.")}</p>
        )}
        {shown.map((f) => <FlightRow key={f.id} f={f} selected={selectedId === f.id} onSelect={onSelect} />)}
      </div>
    </div>
  );
}

/** One flight: callsign + phase, then the same route block as on the flight page. */
function FlightRow({ f, selected, onSelect }: { f: FlightSummary; selected: boolean; onSelect: (id: string) => void }) {
  return (
    <button
      onClick={() => onSelect(f.id)}
      data-testid={`flight-row-${f.callsign}`}
      className={cn(
        "w-full space-y-2 rounded-xl border px-3 py-2.5 text-left transition-[background-color,border-color] duration-150",
        selected ? "border-[color:var(--sc-accent)]/70 bg-[color:var(--sc-primary)]/12" : "border-border bg-background/40 hover:border-[color:var(--sc-accent)]/40 hover:bg-secondary/40",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="font-mono text-sm font-bold text-foreground">{f.callsign}</span>
          <span className="truncate font-mono text-[11px] text-muted-foreground">{aircraftName(f.aircraft_type)}</span>
        </span>
        <PhaseBadge phase={f.phase} />
      </div>
      <RouteBar f={f} />
    </button>
  );
}
