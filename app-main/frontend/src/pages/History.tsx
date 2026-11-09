import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import AppShell from "@/components/AppShell";
import { PhaseBadge } from "@/components/Badges";
import { apiGet } from "@/lib/api";
import { errMsg } from "@/lib/hooks";
import { fmtDateTime } from "@/lib/phases";
import type { FlightSummary, HistoryEntry } from "@/lib/types";

import { tr } from "@/lib/i18n";
/** Kept for the profile page ("mes vols"). */
export function FlightTable({ flights, testId }: { flights: FlightSummary[]; testId: string }) {
  return (
    <table className="w-full text-sm" data-testid={testId}>
      <thead className="text-left text-xs uppercase tracking-wider text-muted-foreground">
        <tr className="border-b border-border">
          <th className="py-2 font-normal">{tr("Indicatif")}</th>
          <th className="font-normal">{tr("Trajet")}</th>
          <th className="font-normal">{tr("Statut")}</th>
          <th className="font-normal">{tr("Mis à jour")}</th>
        </tr>
      </thead>
      <tbody>
        {flights.map((f) => (
          <tr key={f.id} className="border-b border-border/50 hover:bg-accent/40" data-testid={`history-row-${f.callsign}`}>
            <td className="py-2 font-mono font-semibold">
              <Link to={`/flights/${f.id}`} className="text-[#4AA8F0] hover:underline">{f.callsign}</Link>
            </td>
            <td className="font-mono">{f.departure} → {f.arrival}</td>
            <td><PhaseBadge phase={f.phase} /></td>
            <td className="font-mono text-muted-foreground">{fmtDateTime(f.updated_at)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const fmtDur = (m: number | null) => (m == null ? "—" : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`);

/** Flight history: ATC + admin only (enforced by the API). Finished and cancelled flights. */
function View() {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<"all" | "termine" | "annule">("all");
  const [airport, setAirport] = useState("");
  const params = new URLSearchParams({ q, status, airport: airport.length === 4 ? airport : "" }).toString();
  const h = useQuery<HistoryEntry[]>({ queryKey: ["history", params], queryFn: () => apiGet<HistoryEntry[]>(`/history?${params}`), placeholderData: (p) => p });
  return (
    <div className="mx-auto max-w-6xl space-y-5 p-6">
      <h1 className="text-2xl font-bold">{tr("Historique des vols")}</h1>
      <div className="flex flex-wrap gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr("Rechercher indicatif, pilote, appareil…")} className="min-w-64 flex-1 rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:border-[#4AA8F0]" data-testid="history-search" />
        <input value={airport} onChange={(e) => setAirport(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))} maxLength={4} placeholder="OACI" className="w-28 rounded-lg border border-border bg-card px-3 py-2 font-mono text-sm outline-none focus:border-[#4AA8F0]" data-testid="history-airport" />
        <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} className="rounded-lg border border-border bg-card px-3 py-2 text-sm" data-testid="history-status">
          <option value="all">{tr("Terminés et annulés")}</option>
          <option value="termine">{tr("Terminés")}</option>
          <option value="annule">{tr("Annulés")}</option>
        </select>
      </div>
      {h.isError && <p className="text-red-300" data-testid="history-error">{errMsg(h.error)}</p>}
      {/* phones: one card per flight instead of an 8-column table */}
      <ul className="space-y-2 md:hidden" data-testid="history-cards">
        {h.data?.map((f) => (
          <li key={f.id} className="rounded-xl border border-border bg-card p-3 text-sm">
            <div className="flex items-center justify-between gap-2">
              <Link to={`/flights/${f.id}`} className="font-mono text-base font-semibold text-[#4AA8F0]">{f.callsign}</Link>
              <PhaseBadge phase={f.phase} />
            </div>
            <div className="mt-1 flex items-center justify-between gap-2 font-mono">
              <span>{f.departure} → {f.arrival}</span>
              <span className="text-muted-foreground">{fmtDur(f.duration_min)}</span>
            </div>
            <div className="mt-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <Link to={`/pilotes/${f.pilot_id}`} className="truncate hover:text-[#4AA8F0]">{f.pilot_name}</Link>
              <span className="shrink-0 font-mono">{f.departed_at ? fmtDateTime(f.departed_at) : "—"}</span>
            </div>
          </li>
        ))}
      </ul>
      <div className="hidden overflow-x-auto rounded-xl border border-border bg-card md:block">
        <table className="w-full text-sm" data-testid="history-table">
          <thead className="text-left text-xs uppercase tracking-wider text-muted-foreground">
            <tr className="border-b border-border">
              {["Pilote", "Indicatif", "Départ", "Arrivée", "Départ (UTC)", "Arrivée (UTC)", "Durée", "Statut final"].map((c) => (
                <th key={tr(c)} className="px-3 py-3 font-medium">{tr(c)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {h.data?.map((f) => (
              <tr key={f.id} className="border-b border-border/50 transition-colors duration-150 hover:bg-accent/40" data-testid={`history-row-${f.callsign}`}>
                <td className="px-3 py-2.5"><Link to={`/pilotes/${f.pilot_id}`} className="hover:text-[#4AA8F0]">{f.pilot_name}</Link></td>
                <td className="px-3 font-mono font-semibold"><Link to={`/flights/${f.id}`} className="text-[#4AA8F0] hover:underline">{f.callsign}</Link></td>
                <td className="px-3 font-mono">{f.departure}</td>
                <td className="px-3 font-mono">{f.arrival}</td>
                <td className="px-3 font-mono text-muted-foreground">{f.departed_at ? fmtDateTime(f.departed_at) : "—"}</td>
                <td className="px-3 font-mono text-muted-foreground">{f.arrived_at ? fmtDateTime(f.arrived_at) : "—"}</td>
                <td className="px-3 font-mono">{fmtDur(f.duration_min)}</td>
                <td className="px-3"><PhaseBadge phase={f.phase} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {h.data?.length === 0 && <p className="rounded-xl border border-border bg-card p-6 text-center text-sm text-muted-foreground" data-testid="history-empty">{tr("Aucun vol ne correspond.")}</p>}
    </div>
  );
}

export default function History() {
  return <AppShell>{() => <View />}</AppShell>;
}
