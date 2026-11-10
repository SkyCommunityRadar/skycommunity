import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { ArrowLeft, LocateFixed, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import AppShell from "@/components/AppShell";
import FlightPanel from "@/components/FlightPanel";
import RadarMap from "@/components/RadarMap";
import { useFlight, useGround } from "@/lib/hooks";
import type { User } from "@/lib/types";
import { useFlightEditing } from "@/lib/useFlightEditing";

import { tr } from "@/lib/i18n";
function DetailView({ id }: { id: string; user: User }) {
  const q = useFlight(id);
  const [params, setParams] = useSearchParams();
  const [follow, setFollow] = useState(true);
  const dep = useGround(q.data?.departure);
  const arr = useGround(q.data?.arrival);
  const f = q.data;
  const ed = useFlightEditing(f, dep.data, params.get("pick") === "holding" ? "holding" : "view", () => {
    if (params.has("pick")) setParams({}, { replace: true });
  }, arr.data);

  if (!f) {
    return (
      <div className="p-6 text-sm text-muted-foreground" data-testid="flight-detail-loading">
        {q.isError ? tr("Vol introuvable ou serveur injoignable.") : tr("Chargement du vol…")}
      </div>
    );
  }
  const grounds = [dep.data, arr.data].filter((g) => !!g).map((g) => g!);

  return (
    <div className="flex h-full flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
      <aside className="order-2 w-full shrink-0 border-r border-border bg-card lg:order-none lg:w-[28rem] lg:overflow-y-auto" data-testid="flight-detail-panel">
        <div className="theme-stripe" aria-hidden />
        <div className="flex items-center justify-between gap-2 px-4 pt-3">
          <Link to={`/?f=${f.id}`} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" data-testid="back-to-radar">
            <ArrowLeft className="h-3.5 w-3.5" />{" "}{tr("Radar")}</Link>
          {/* back to the radar with this flight open in the side panel */}
          <Button size="sm" variant="outline" render={<Link to={`/?f=${f.id}`} />} data-testid="close-full-page">
            <X className="h-4 w-4" />{" "}{tr("Fermer")}</Button>
        </div>
        <FlightPanel flight={f} ed={ed} fullPage />
      </aside>
      <section className="relative order-1 h-[50vh] shrink-0 lg:order-none lg:h-auto lg:flex-1 lg:shrink">
        <RadarMap
          testId="detail-map"
          flights={[f]}
          selectedId={f.id}
          route={f.route}
          flownIndex={f.position.track === "air" ? f.position.wp_index : undefined}
          aircraftPos={f.position.track === "air" ? (f.holding?.entered ? (f.holding.path[0] as [number, number]) : [f.position.lat, f.position.lon]) : undefined}
          holdPath={f.holding?.path}
          lineupPath={f.lineup ?? undefined}
          taxis={ed.taxis}
          grounds={grounds}
          highlightGates={ed.gateHighlight ?? [f.dep_gate?.ref, f.arr_gate?.ref].filter((r): r is string => !!r)}
          draftPoints={ed.draftPoints}
          onMapClick={ed.onMapClick}
          onHoldingClick={ed.onHoldingClick}
          onTaxiwayClick={ed.onTaxiwayClick}
          onGateClick={ed.onGateClick}
          selectedHolding={ed.editingKind === "taxi_out" || ed.mode === "reject_hold" ? ed.destination : f.holding_point}
          crosshair={ed.crosshair}
          pushHint={ed.pushHint}
          center={ed.focusAt ?? [f.position.lat, f.position.lon]}
          zoom={ed.focusAt || f.position.on_ground ? 16 : 9}
          focusKey={`${ed.focusKey}-${f.position.on_ground ? "sol" : "air"}`}
          followPos={follow && ed.mode === "view" ? [f.position.lat, f.position.lon] : undefined}
          onUserPan={() => setFollow(false)}
        />
        {/* moving the map by hand stops the following; « Centrer sur l'avion » brings it back */}
        <button
          onClick={() => setFollow(!follow)}
          className={`absolute bottom-6 right-3 z-[500] inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium backdrop-blur transition-colors duration-150 ${follow ? "border-[color:var(--sc-accent)]/60 bg-[color:var(--sc-primary)]/30 text-[color:var(--sc-accent-soft)]" : "border-border bg-background/90 text-foreground hover:border-[color:var(--sc-accent)]/60 hover:text-[color:var(--sc-accent-soft)]"}`}
          title={follow ? tr("Cliquer pour arrêter de suivre l'avion") : undefined}
          data-testid="follow-toggle"
        >
          <LocateFixed className="h-3.5 w-3.5" />
          {follow ? tr("Suivi de l'avion") : tr("Centrer sur l'avion")}
        </button>
        {ed.banner && (
          <div className="absolute right-3 top-3 z-[500] rounded-lg border border-[color:var(--sc-accent)]/50 bg-background/90 px-3 py-1.5 text-xs text-[color:var(--sc-accent-soft)]" data-testid="map-mode-banner">
            {ed.banner}
          </div>
        )}
      </section>
    </div>
  );
}

function DetailRoute() {
  const { id } = useParams();
  return <AppShell>{(user) => <DetailView id={id ?? ""} user={user} />}</AppShell>;
}

export default DetailRoute;
