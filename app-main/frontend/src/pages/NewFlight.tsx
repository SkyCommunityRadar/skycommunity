import { aircraftName } from "@/lib/aircraft";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import AppShell from "@/components/AppShell";
import RadarMap from "@/components/RadarMap";
import GatePicker from "@/components/GatePicker";
import { useGround } from "@/lib/hooks";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { apiPost } from "@/lib/api";
import { errMsg } from "@/lib/hooks";
import { fmtAlt, fmtDuration } from "@/lib/phases";
import type { FlightDetail, SimbriefPreview, User } from "@/lib/types";

import { tr } from "@/lib/i18n";
function SimbriefTab({ user }: { user: User }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [identifier, setIdentifier] = useState(user.simbrief_id ?? "");
  const [error, setError] = useState<string | null>(null);
  const fetchM = useMutation<SimbriefPreview, unknown, void>({
    mutationFn: () => apiPost<SimbriefPreview>("/simbrief/fetch", { pilot_id: identifier.trim() }),
    onMutate: () => setError(null),
    onError: (e) => setError(errMsg(e)),
  });
  const [depGate, setDepGate] = useState("");
  const [arrGate, setArrGate] = useState("");
  const confirmM = useMutation<FlightDetail, unknown, string>({
    mutationFn: (draftId) =>
      apiPost<FlightDetail>(`/simbrief/confirm/${draftId}`, { dep_gate: depGate || null, arr_gate: arrGate || null }),
    onSuccess: (f) => {
      qc.invalidateQueries({ queryKey: ["flights"] });
      toast.success(tr("Vol {0} créé depuis SimBrief", [f.callsign]));
      nav(`/?f=${f.id}`);
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  const p = fetchM.data;
  // as soon as the plan is fetched, the map zooms on the departure airport's stands (loaded from OpenStreetMap,
  // which can take up to a minute the very first time an airport is used)
  const depGround = useGround(p?.departure);
  const gates = depGround.data?.gates ?? [];
  const chosen = gates.find((g) => g.ref === depGate);
  const gatesCentre: [number, number] | undefined = chosen
    ? [chosen.lat, chosen.lon]
    : gates.length
      ? [gates.reduce((s, g) => s + g.lat, 0) / gates.length, gates.reduce((s, g) => s + g.lon, 0) / gates.length]
      : depGround.data
        ? [depGround.data.lat, depGround.data.lon]
        : undefined;

  return (
    <div className="grid h-full min-h-0 grid-cols-1 gap-4 md:grid-cols-[22rem_1fr]">
      <div className="space-y-4 overflow-y-auto">
        <form
          className="space-y-3 rounded-2xl border border-[color:var(--sc-primary)]/40 bg-gradient-to-b from-[color:var(--sc-glow)] to-card p-4 shadow-lg"
          onSubmit={(e) => {
            e.preventDefault();
            fetchM.mutate();
          }}
          data-testid="simbrief-import-card"
        >
          <a href="https://www.simbrief.com/" target="_blank" rel="noopener noreferrer" className="block" title={tr("Ouvrir simbrief.com")}>
            <img src="/simbrief-logo.png" alt={tr("SimBrief by Navigraph")} className="h-8 w-auto" data-testid="simbrief-logo" />
          </a>
          <p className="text-xs text-muted-foreground">{tr("Récupère votre")}{" "}<b>{tr("dernier plan de vol généré")}</b>{" "}{tr("sur SimBrief via l'API publique. Aucun mot de passe n'est demandé.")}</p>
          <div className="space-y-1.5">
            <Label htmlFor="sb-id">{tr("Pilot ID SimBrief")}</Label>
            <Input
              id="sb-id"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value.replace(/\D/g, ""))}
              inputMode="numeric"
              placeholder={tr("ex. 123456")}
              required
              className="font-mono"
              data-testid="simbrief-identifier-input"
            />
            <p className="text-[11px] text-muted-foreground">{tr("Numéro visible sur simbrief.com → Account Settings → « Pilot ID ». Générez d'abord votre plan sur SimBrief.")}</p>
          </div>
          <Button type="submit" size="lg" className="h-11 w-full text-base" disabled={fetchM.isPending || !identifier.trim()} data-testid="simbrief-fetch-button">
            <Download className="h-4 w-4" /> {fetchM.isPending ? tr("Récupération…") : tr("Importer mon plan SimBrief")}
          </Button>
          <a href="https://www.simbrief.com/system/dispatch.php" target="_blank" rel="noopener noreferrer" className="block text-center text-[11px] text-[color:var(--sc-accent-soft)] hover:underline">{tr("Pas encore de plan ? Le générer sur simbrief.com")}</a>
          {error && (
            <p className="rounded border border-red-500/40 bg-red-500/10 p-2 text-xs text-red-300" data-testid="simbrief-error">
              {error}
            </p>
          )}
        </form>
        {p && (
          <div className="space-y-3 rounded border border-border bg-card p-3" data-testid="simbrief-preview">
            <div className="flex items-baseline justify-between">
              <span className="font-mono text-lg font-bold" data-testid="preview-callsign">{p.callsign}</span>
              <span className="font-mono text-xs text-muted-foreground">{aircraftName(p.aircraft_type)}</span>
            </div>
            <div className="font-mono text-sm" data-testid="preview-route-airports">
              {p.departure}
              {p.dep_rwy && <span className="text-amber-200">{" "}{tr("(piste {0})", [p.dep_rwy])}</span>} → {p.arrival}
              {p.arr_rwy && <span className="text-amber-200">{" "}{tr("(piste {0})", [p.arr_rwy])}</span>}
            </div>
            <div className="text-[11px] text-muted-foreground">
              {p.departure_name} → {p.arrival_name}
            </div>
            <div className="grid grid-cols-3 gap-2 font-mono text-[11px]">
              <div>
                <div className="text-muted-foreground">{tr("Croisière")}</div>
                {fmtAlt(p.cruise_alt_ft)}
              </div>
              <div>
                <div className="text-muted-foreground">{tr("Distance")}</div>
                {p.total_nm.toFixed(0)}{" "}{tr("NM")}</div>
              <div>
                <div className="text-muted-foreground">{tr("Durée")}{" "}{p.times_from_plan ? tr("(plan)") : tr("(estimée)")}</div>
                {fmtDuration(p.est_time_s)}
              </div>
            </div>
            {p.route_string && <p className="font-mono text-[11px] text-sky-200 break-words">{p.route_string}</p>}
            {p.warnings.length > 0 && (
              <ul className="space-y-1 text-[11px] text-amber-300" data-testid="preview-warnings">
                {p.warnings.map((w) => (
                  <li key={w}>⚠ {w}</li>
                ))}
              </ul>
            )}
            <div className="text-[11px] text-muted-foreground">{tr("{0} points de navigation", [p.waypoints.length])}</div>
            <div className="space-y-2 rounded border border-[color:var(--sc-primary)]/40 bg-[color:var(--sc-primary)]/5 p-2.5">
              <div className="text-[11px] font-medium">{tr("Votre porte / poste de stationnement")}</div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <div className="mb-1 text-[10px] text-muted-foreground">{tr("Porte de départ {0} (obligatoire)", [p.departure])}</div>
                  <GatePicker icao={p.departure} value={depGate} onChange={setDepGate} testId="new-dep-gate-input" />
                </div>
                <div>
                  <div className="mb-1 text-[10px] text-muted-foreground">{tr("Porte d'arrivée souhaitée {0}", [p.arrival])}</div>
                  <GatePicker icao={p.arrival} value={arrGate} onChange={setArrGate} testId="new-arr-gate-input" />
                </div>
              </div>
            </div>
            <div className="flex gap-2">
              <Button onClick={() => confirmM.mutate(p.draft_id)} disabled={confirmM.isPending || !depGate} data-testid="simbrief-confirm-button">{tr("Confirmer et créer le vol")}</Button>
              <Button variant="ghost" onClick={() => fetchM.reset()} data-testid="simbrief-cancel-button">{tr("Annuler")}</Button>
            </div>
          </div>
        )}
      </div>
      <div className={`relative min-h-[320px] overflow-hidden rounded border border-border md:min-h-[400px] ${p ? "" : "hidden md:block"}`}>
        <RadarMap
          testId="simbrief-preview-map"
          route={p?.waypoints}
          grounds={depGround.data ? [depGround.data] : undefined}
          highlightGates={chosen ? [chosen.ref] : undefined}
          center={p ? (gatesCentre ?? [p.waypoints[0].lat, p.waypoints[0].lon]) : undefined}
          zoom={p ? (chosen ? 17.5 : gatesCentre ? 15.5 : 12) : undefined}
          focusKey={p ? `${p.draft_id}-${depGround.data ? "sol" : "attente"}-${chosen?.ref ?? ""}` : undefined}
        />
        {p && depGround.isLoading && (
          <div className="absolute left-1/2 top-4 z-[650] flex -translate-x-1/2 items-center gap-2 rounded-lg border border-[color:var(--sc-accent)]/40 bg-background/95 px-3 py-2 text-xs shadow-lg" data-testid="dep-ground-loading">
            <span className="h-3 w-3 animate-spin rounded-full border-2 border-[color:var(--sc-accent)] border-t-transparent" />{tr("Chargement des portes de")}{" "}{p.departure}{tr("… (jusqu'à 1 min la première fois)")}</div>
        )}
      </div>
    </div>
  );
}

export default function NewFlight() {
  return (
    <AppShell>
      {(user) =>
        user.role === "pilote" || user.role === "admin" ? (
          <div className="flex min-h-full flex-col gap-4 p-4 md:h-full md:p-5">
            <h1 className="text-xl font-semibold tracking-tight">{tr("Nouveau vol")}</h1>
            <Tabs defaultValue="simbrief" className="flex-1 min-h-0 flex flex-col">
              <TabsList>
                <TabsTrigger value="simbrief" data-testid="tab-simbrief">{tr("Import SimBrief")}</TabsTrigger>
  
              </TabsList>
              <TabsContent value="simbrief" className="flex-1 min-h-0 pt-3">
                <SimbriefTab user={user} />
              </TabsContent>

            </Tabs>
          </div>
        ) : (
          <p className="p-6 text-sm text-muted-foreground" data-testid="new-flight-forbidden">{tr("Seuls les pilotes et administrateurs peuvent créer un vol.")}</p>
        )
      }
    </AppShell>
  );
}
