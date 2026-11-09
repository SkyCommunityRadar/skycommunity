import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import AppShell from "@/components/AppShell";
import RadarMap from "@/components/RadarMap";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiPost } from "@/lib/api";
import { errMsg, useGround, useLoadedAirports } from "@/lib/hooks";
import { fmtDateTime } from "@/lib/phases";
import type { Ground, User } from "@/lib/types";

import { tr } from "@/lib/i18n";
function AirportsView({ user }: { user: User }) {
  const qc = useQueryClient();
  const loaded = useLoadedAirports();
  const [input, setInput] = useState("");
  const [icao, setIcao] = useState<string | null>(null);
  const [gateFilter, setGateFilter] = useState("");
  const [focus, setFocus] = useState<{ c: [number, number]; k: string } | null>(null);
  const g = useGround(icao);
  const refresh = useMutation<Ground, unknown, void>({
    mutationFn: () => apiPost<Ground>(`/airports/${icao}/ground/refresh`),
    onSuccess: (d) => {
      qc.setQueryData(["ground", icao], d);
      qc.invalidateQueries({ queryKey: ["airports"] });
      toast.success(tr("Plan au sol de {0} rechargé ({1} postes)", [d.icao, d.gates.length]));
    },
    onError: (e) => toast.error(errMsg(e)),
  });

  const open = (code: string) => {
    const c = code.trim().toUpperCase();
    if (/^[A-Z0-9]{4}$/.test(c)) {
      setIcao(c);
      setFocus(null);
    }
  };
  const gates = (g.data?.gates ?? []).filter((x) => !gateFilter || x.ref.includes(gateFilter.toUpperCase()));

  return (
    <div className="flex h-full">
      <aside className="w-80 shrink-0 border-r border-border bg-card overflow-y-auto p-3 space-y-4">
        <div className="space-y-2">
          <h1 className="text-sm font-semibold">{tr("Aéroports")}</h1>
          <form
            className="flex gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              open(input);
            }}
          >
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value.toUpperCase())}
              placeholder={tr("Code OACI (ex. LFMN)")}
              maxLength={4}
              className="h-8 font-mono text-xs uppercase"
              data-testid="airport-search-input"
            />
            <Button size="sm" type="submit" data-testid="airport-search-button">{tr("Ouvrir")}</Button>
          </form>
          <p className="text-[10px] text-muted-foreground">{tr("Postes, taxiways et pistes réels issus d'OpenStreetMap (© contributeurs OSM). Premier chargement : jusqu'à 1 min.")}</p>
        </div>
        <div className="space-y-1">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{tr("Déjà chargés")}</div>
          <ul className="space-y-0.5" data-testid="airport-list">
            {(loaded.data ?? []).map((a) => (
              <li key={a.icao}>
                <button
                  onClick={() => open(a.icao)}
                  className={`w-full rounded px-2 py-1.5 text-left text-xs transition-colors duration-150 ${icao === a.icao ? "bg-accent" : "hover:bg-accent/50"}`}
                  data-testid={`airport-item-${a.icao}`}
                >
                  <span className="font-mono font-semibold text-[#4AA8F0]">{a.icao}</span> {a.name}
                  <div className="text-[10px] text-muted-foreground">{tr("{0} postes · {1}", [a.gates, fmtDateTime(a.fetched_at)])}</div>
                </button>
              </li>
            ))}
          </ul>
        </div>
        {icao && (
          <div className="space-y-2" data-testid="airport-detail">
            {g.isLoading && <p className="text-xs text-[#4AA8F0]">{tr("Chargement du plan au sol de {0}…", [icao])}</p>}
            {g.isError && (
              <p className="text-xs text-red-400" data-testid="airport-error">
                {errMsg(g.error)}
              </p>
            )}
            {g.data && (
              <>
                <div className="text-xs">
                  <span className="font-mono font-semibold">{g.data.icao}</span> {g.data.name}
                </div>
                <Input
                  value={gateFilter}
                  onChange={(e) => setGateFilter(e.target.value)}
                  placeholder={tr("Filtrer les postes")}
                  className="h-8 text-xs font-mono"
                  data-testid="gate-filter-input"
                />
                <div className="flex max-h-64 flex-wrap gap-1 overflow-y-auto" data-testid="gate-list">
                  {gates.map((x) => (
                    <button
                      key={x.ref}
                      onClick={() => setFocus({ c: [x.lat, x.lon], k: `${x.ref}-${Date.now()}` })}
                      className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] hover:border-[#4AA8F0] transition-colors duration-150"
                      data-testid={`gate-chip-${x.ref}`}
                    >
                      {x.ref}
                    </button>
                  ))}
                </div>
                {user.role === "admin" && (
                  <Button size="sm" variant="secondary" disabled={refresh.isPending} onClick={() => refresh.mutate()} data-testid="ground-refresh-button">
                    {refresh.isPending ? tr("Rechargement…") : tr("Recharger depuis OpenStreetMap")}
                  </Button>
                )}
              </>
            )}
          </div>
        )}
      </aside>
      <section className="relative flex-1">
        <RadarMap
          testId="airport-map"
          grounds={g.data ? [g.data] : []}
          center={focus?.c ?? (g.data ? [g.data.lat, g.data.lon] : undefined)}
          zoom={focus ? 18 : 15}
          focusKey={focus?.k ?? g.data?.icao}
        />
      </section>
    </div>
  );
}

export default function Airports() {
  return <AppShell>{(u) => <AirportsView user={u} />}</AppShell>;
}
