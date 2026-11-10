import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { motion } from "motion/react";
import { ChevronDown, Crosshair, Flag, Gauge, Headset, MapPin, Navigation, TrendingUp, X } from "lucide-react";
import AtcControls from "@/components/AtcControls";
import DeleteButton from "@/components/DeleteButton";
import EventTimeline from "@/components/EventTimeline";
import FlightActions from "@/components/FlightActions";
import FlightStrip from "@/components/FlightStrip";
import PositionNudge from "@/components/PositionNudge";
import ProfileMarkers from "@/components/ProfileMarkers";
import NavPanel from "@/components/NavPanel";
import RouteTab from "@/components/RouteTab";
import TaxiTab from "@/components/TaxiTab";
import ReportPilot from "@/components/ReportPilot";
import EndFlightReviews from "@/components/EndFlightReviews";
import { Button } from "@/components/ui/button";
import type { FlightDetail } from "@/lib/types";
import type { FlightEditing } from "@/lib/useFlightEditing";
import { cn } from "@/lib/utils";

import { tr, trServer } from "@/lib/i18n";
type Tab = "details" | "taxi" | "route" | "history";

// codes of the « fin ou interruption du vol » actions (same list as FlightActions' DANGER)
const END_CODES = new Set(["annuler", "suspendre"]);

function Card({ icon: Icon, title, children, testId }: { icon: typeof Gauge; title: string; children: React.ReactNode; testId: string }) {
  return (
    <section className="overflow-hidden rounded-xl border border-border bg-background/40" data-testid={testId}>
      <header className="flex items-center gap-2 border-b border-border bg-card/60 px-3 py-2">
        <Icon className="h-4 w-4 text-[#4AA8F0]" />
        <span className="text-sm font-semibold">{title}</span>
      </header>
      <div className="space-y-3 p-3">{children}</div>
    </section>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

/** Everything about one flight, the same on the radar (opens as soon as an aircraft is clicked) and on the
 * full page: « Détails » (summary + actions) and « Roulage » (stands, holding point, taxi routes) first. */
export default function FlightPanel({
  flight: f, ed, onClose, onCenter, fullPage = false,
}: {
  flight: FlightDetail;
  ed: FlightEditing;
  onClose?: () => void;
  onCenter?: () => void;
  fullPage?: boolean;
}) {
  const [tab, setTab] = useState<Tab>(ed.mode === "holding" ? "taxi" : "details");
  const nav = useNavigate();
  const tabs: { k: Tab; label: string }[] = [
    { k: "details", label: tr("Contrôle") },
    { k: "taxi", label: tr("Roulage") },
    { k: "route", label: tr("Route") },
    { k: "history", label: tr("Historique") },
  ];
  const active = tab;

  return (
    <div className="flex min-h-full flex-col" data-testid="selected-flight-panel">
      <div className="space-y-3 p-4 pb-0">
        <div className="flex items-center justify-between gap-2">
          <Link to={`/pilotes/${f.pilot_id}`} className="text-sm text-muted-foreground hover:text-[#4AA8F0]" data-testid="selected-pilot-link">{tr("Pilote :")}{" "}<span className="font-semibold text-foreground underline-offset-2 hover:underline">{f.pilot_name}</span>
          </Link>
          <div className="flex items-center gap-1.5">
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold",
                f.controller_callsign ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300" : "border-border text-muted-foreground",
              )}
              data-testid="selected-controller"
            >
              <Headset className="h-3 w-3" /> {f.controller_callsign ?? tr("Non contrôlé")}
            </span>
            {onClose && (
              <button onClick={onClose} className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground" title={tr("Fermer")} data-testid="close-flight-panel">
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
        <FlightStrip flight={f} />
      </div>

      <div className="sticky top-0 z-10 mt-3 border-b border-border bg-card/95 px-2 backdrop-blur" role="tablist">
        <div className="flex">
          {tabs.map(({ k, label }) => (
            <button
              key={k}
              role="tab"
              aria-selected={active === k}
              onClick={() => setTab(k)}
              className={cn(
                "relative flex-1 px-2 py-3 text-sm font-medium transition-colors",
                active === k ? "text-[#7CC0F5]" : "text-muted-foreground hover:text-foreground",
              )}
              data-testid={`tab-${k === "details" ? "details" : k === "taxi" ? "taxi" : k}`}
            >
              {label}
              {active === k && (
                <motion.span layoutId={`flight-tab-${fullPage ? "page" : "radar"}`} className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-[#4AA8F0]" transition={{ type: "spring", stiffness: 500, damping: 40 }} />
              )}
            </button>
          ))}
        </div>
      </div>

      <motion.div key={active} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.16 }} className="flex-1 space-y-5 p-4">
        {active === "details" && (
          <>
            {f.approach_note && f.phase === "approche" && <p className="text-xs text-amber-200" data-testid="approach-note">{trServer(f.approach_note)}</p>}
            {f.can_pick_holding && !f.holding_point && !f.taxi_out && (
              // proposed up front: on an unknown airport the pilot would otherwise not think of the « Roulage » tab
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-xs" data-testid="holding-reminder">
                <span className="min-w-0 flex-1 text-amber-100">
                  <b>{tr("Avant de rouler :")}</b>{" "}{tr("choisissez votre point d'attente à {0}. Le chemin de roulage depuis votre poste sera tracé automatiquement.", [f.departure])}</span>
                <Button size="sm" onClick={() => { setTab("taxi"); if (ed.mode !== "holding") ed.togglePickHolding(); }} data-testid="holding-reminder-pick">
                  <MapPin className="h-3.5 w-3.5" />{" "}{tr("Choisir sur la carte")}</Button>
              </div>
            )}
            {f.can_edit_taxi_in && !f.taxi_in && ["en_route", "approche", "atterrissage"].includes(f.phase) && ed.mode !== "taxi_in" && ed.mode !== "gate_arr" && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-xs" data-testid="arrival-taxi-reminder">
                <span className="min-w-0 flex-1 text-amber-100">
                  <b>{tr("Roulage à l'arrivée :")}</b>{" "}{f.arr_gate ? tr("choisissez la sortie de piste à {0}, le tracé jusqu'au poste {1} sera automatique.", [f.arrival, f.arr_gate.ref]) : tr("choisissez d'abord votre poste à {0}, puis la sortie de piste.", [f.arrival])}</span>
                <Button size="sm" onClick={() => { setTab("taxi"); if (f.arr_gate) ed.startEdit("taxi_in"); else ed.startGatePick("arr"); }} data-testid="arrival-taxi-open">
                  <MapPin className="h-3.5 w-3.5" />{" "}{tr("Ouvrir le roulage")}</Button>
              </div>
            )}
            <Card icon={Gauge} title={tr("Phase du vol")} testId="card-phase">
              <FlightActions flight={f} ed={ed} part="main" />
            </Card>
            <ReportPilot flight={f} />
            <EndFlightReviews phase={f.phase} />
            {((f.allowed_actions.length > 0 || f.can_control) && !!f.position.track && f.position.total_nm > 0 || f.can_control) && (
              <Card icon={Crosshair} title={tr("Position de l'avion")} testId="card-position">
                {(f.allowed_actions.length > 0 || f.can_control) && <PositionNudge flight={f} />}
                {f.can_control && <AtcControls flight={f} mode={ed.mode} setMode={ed.setMode} />}
              </Card>
            )}
            {f.can_nav && (
              <Card icon={Navigation} title={tr("Navigation (direct / hold)")} testId="card-nav">
                <NavPanel flight={f} />
              </Card>
            )}
            {f.can_edit_profile && (f.toc_nm != null || f.tod_nm != null) && (
              <Card icon={TrendingUp} title={tr("Profil de vol (TOC / TOD)")} testId="card-profile">
                <ProfileMarkers flight={f} />
              </Card>
            )}
            {(f.allowed_actions.some((a) => END_CODES.has(a.code)) || f.can_delete) && (
              <details className="group rounded-xl border border-red-500/25 bg-red-500/[0.04]" data-testid="card-end">
                <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-xs font-semibold text-red-300/90">
                  <Flag className="h-4 w-4" /> {tr("Fin ou interruption du vol")}
                  <ChevronDown className="ml-auto h-4 w-4 transition-transform group-open:rotate-180" />
                </summary>
                <div className="space-y-3 border-t border-red-500/20 px-3 py-3">
                  <FlightActions flight={f} ed={ed} part="end" />
                  {f.can_delete && (
                    <div className="space-y-1.5 border-t border-red-500/15 pt-3">
                      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{tr("Administration")}</div>
                      <DeleteButton
                        path={`/flights/${f.id}`}
                        what={tr("le vol {0}", [f.callsign])}
                        warning={tr("Il disparaît du radar et de l'historique (contrairement à « Annuler le vol »).")}
                        onDone={() => (onClose ? onClose() : nav("/"))}
                        testId="delete-flight"
                      />
                    </div>
                  )}
                </div>
              </details>
            )}
          </>
        )}
        {active === "taxi" && <TaxiTab flight={f} ed={ed} />}
        {active === "route" && <RouteTab flight={f} />}
        {active === "history" && <EventTimeline flightId={f.id} canNote={f.can_control || f.is_owner} />}
      </motion.div>

      {onCenter && (
        <div className="sticky bottom-0 border-t border-border bg-card/95 p-3 backdrop-blur">
          <Button variant="outline" size="lg" className="w-full" onClick={onCenter} data-testid="center-on-flight">
            <Crosshair className="h-4 w-4" />{" "}{tr("Centrer sur l'avion")}</Button>
        </div>
      )}
    </div>
  );
}
