import { Fragment, type ReactNode } from "react";
import { ChevronRight, MapPin, Pencil, PlaneLanding, PlaneTakeoff } from "lucide-react";
import { Button } from "@/components/ui/button";
import TaxiEditor from "@/components/TaxiEditor";
import { useGround } from "@/lib/hooks";
import { tr } from "@/lib/i18n";
import type { FlightDetail } from "@/lib/types";
import type { FlightEditing } from "@/lib/useFlightEditing";
import { cn } from "@/lib/utils";

/** « Roulage » tab: one card for the departure (stand → holding point → taxi route), one for the arrival
 * (taxi route → stand). Same rules as before, laid out as a journey. */

function Card({ icon: Icon, title, icao, children, testId }: { icon: typeof PlaneTakeoff; title: string; icao: string; children: ReactNode; testId: string }) {
  return (
    <section className="overflow-hidden rounded-xl border border-border bg-background/40" data-testid={testId}>
      <header className="flex items-center gap-2 border-b border-border bg-card/60 px-3 py-2">
        <Icon className="h-4 w-4 text-[#4AA8F0]" />
        <span className="text-sm font-semibold">{title}</span>
        <span className="ml-auto rounded bg-secondary px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">{icao}</span>
      </header>
      <div className="divide-y divide-border/60">{children}</div>
    </section>
  );
}

function Row({ label, children, action }: { label: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start gap-x-3 gap-y-1.5 px-3 py-2.5">
      <div className="w-28 shrink-0 pt-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="min-w-0 flex-1 text-xs">{children}</div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

const Pill = ({ children, tone = "route" }: { children: ReactNode; tone?: "route" | "stand" | "hold" }) => (
  <span
    className={cn(
      "inline-flex items-center rounded-md px-1.5 py-0.5 font-mono text-[11px] font-semibold",
      tone === "route" && "bg-[#2B63C9]/15 text-[#7CC0F5]",
      tone === "stand" && "bg-secondary text-foreground",
      tone === "hold" && "bg-emerald-500/15 text-emerald-300",
    )}
  >
    {children}
  </span>
);

/** Stand of one side: shown as a chip, and chosen by clicking it directly on the map (like the holding point). */
function GateRow({ f, side, ed }: { f: FlightDetail; side: "dep" | "arr"; ed: FlightEditing }) {
  const dep = side === "dep";
  const saved = (dep ? f.dep_gate?.ref : f.arr_gate?.ref) ?? null;
  const locked = dep
    ? f.phase !== "preparation" || !f.can_edit_dep_gate
    : !f.can_edit_arr_gate || (f.is_owner && !f.is_controller && f.arr_gate_by === "atc" && !f.can_control);
  const picking = ed.mode === (dep ? "gate_dep" : "gate_arr");
  const note = !dep && saved ? (f.arr_gate_by === "atc" ? tr("assigné par l'ATC") : f.arr_gate_by === "pilote" ? tr("souhaité par le pilote") : null) : null;
  const action = !locked && (
    <Button size="sm" variant={picking ? "default" : "outline"} onClick={() => (picking ? ed.setMode("view") : ed.startGatePick(side))} data-testid={`gate-${side}-pick-on-map`}>
      <MapPin className="h-3.5 w-3.5" /> {picking ? tr("Cliquez sur la carte…") : saved ? tr("Changer") : tr("Choisir sur la carte")}
    </Button>
  );
  return (
    <Row label={dep ? tr("Poste de départ") : tr("Poste d'arrivée")} action={action}>
      {saved ? (
        <span className="flex flex-wrap items-center gap-2" data-testid={`gate-${side}-current`}>
          <Pill tone="stand">{saved}</Pill>
          {note && <span className="text-[11px] text-muted-foreground">{note}</span>}
        </span>
      ) : (
        <span className="text-muted-foreground" data-testid={`gate-${side}-current`}>{locked ? tr("Non défini") : tr("À choisir sur la carte.")}</span>
      )}
    </Row>
  );
}

function HoldingRow({ f, ed }: { f: FlightDetail; ed: FlightEditing }) {
  const ground = useGround(f.can_pick_holding ? f.departure : undefined);
  const named = (ground.data?.holdings ?? []).filter((h) => h.ref);
  const picking = ed.mode === "holding";
  const action = f.can_pick_holding && named.length > 0 && (
    <Button size="sm" variant={picking ? "default" : "outline"} onClick={ed.togglePickHolding} data-testid="holding-pick-on-map">
      <MapPin className="h-3.5 w-3.5" /> {picking ? tr("Cliquez sur la carte…") : f.holding_point ? tr("Changer") : tr("Choisir sur la carte")}
    </Button>
  );
  return (
    <Row label={tr("Point d'attente")} action={action}>
      {f.holding_point ? (
        <span data-testid="holding-current"><Pill tone="hold">{f.holding_point.ref}</Pill></span>
      ) : f.can_pick_holding && ground.isLoading ? (
        <span className="text-muted-foreground">{tr("Chargement des points d'attente…")}</span>
      ) : f.can_pick_holding && named.length === 0 ? (
        <span className="text-muted-foreground">{tr("Aucun point d'attente n'est cartographié à {0} dans OpenStreetMap.", [f.departure])}</span>
      ) : (
        <span className="text-muted-foreground">{f.can_pick_holding ? tr("À choisir sur la carte : le roulage sera tracé automatiquement.") : tr("Non défini")}</span>
      )}
    </Row>
  );
}

/** The taxi route as a journey: stand → taxiways → holding point (departure), or taxiways → stand (arrival). */
function RouteRow({ f, kind, ed }: { f: FlightDetail; kind: "taxi_out" | "taxi_in"; ed: FlightEditing }) {
  const out = kind === "taxi_out";
  const t = f[kind];
  const editing = ed.mode === kind;
  const canEdit = out ? f.can_edit_taxi_out : f.can_edit_taxi_in;
  const gate = out ? f.dep_gate?.ref : f.arr_gate?.ref;
  const names = (t?.names ?? []).filter((n) => n && n !== "Stand");
  const action = canEdit && !editing && (
    <Button size="sm" variant="outline" onClick={() => ed.startEdit(kind)} data-testid={`taxi-${kind}-edit`}>
      <Pencil className="h-3.5 w-3.5" /> {t ? tr("Modifier") : tr("Tracer")}
    </Button>
  );
  return (
    <Row label={tr("Roulage")} action={action}>
      {editing ? (
        <TaxiEditor flight={f} kind={kind} editing points={ed.points} setPoints={ed.setPoints} onPreview={ed.setDraftPath} onEdit={() => ed.startEdit(kind)} onDone={() => ed.setMode("view")} destination={out ? ed.destination : null} destGate={out ? null : ed.destGate} />
      ) : t ? (
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-1" data-testid={`taxi-${kind}-path`}>
            {out && gate && <Pill tone="stand">{gate}</Pill>}
            {names.map((n, i) => (
              <Fragment key={`${n}-${i}`}>
                {(i > 0 || (out && gate)) && <ChevronRight className="h-3 w-3 text-muted-foreground" />}
                <Pill>{tr(n)}</Pill>
              </Fragment>
            ))}
            {out && f.holding_point && <><ChevronRight className="h-3 w-3 text-muted-foreground" /><Pill tone="hold">{f.holding_point.ref}</Pill></>}
            {!out && gate && <><ChevronRight className="h-3 w-3 text-muted-foreground" /><Pill tone="stand">{gate}</Pill></>}
          </div>
          <p className="text-[11px] text-muted-foreground">{tr("{0} NM · tracé par {1}", [t.length_nm.toFixed(2), t.set_by_name])}</p>
        </div>
      ) : (
        <span className="text-muted-foreground" data-testid={`taxi-${kind}-empty`}>
          {out
            ? f.can_pick_holding ? tr("Pas encore de roulage : choisissez votre point d'attente.") : tr("Pas encore de roulage.")
            : tr("Pas encore de roulage jusqu'au poste.")}
        </span>
      )}
    </Row>
  );
}

export default function TaxiTab({ flight: f, ed }: { flight: FlightDetail; ed: FlightEditing }) {
  return (
    <div className="space-y-4" data-testid="taxi-tab">
      <Card icon={PlaneTakeoff} title={tr("Départ")} icao={f.departure} testId="taxi-card-dep">
        <GateRow f={f} side="dep" ed={ed} />
        {(f.can_pick_holding || f.holding_point) && <HoldingRow f={f} ed={ed} />}
        <RouteRow f={f} kind="taxi_out" ed={ed} />
      </Card>
      <Card icon={PlaneLanding} title={tr("Arrivée")} icao={f.arrival} testId="taxi-card-arr">
        <GateRow f={f} side="arr" ed={ed} />
        <RouteRow f={f} kind="taxi_in" ed={ed} />
      </Card>
      {!f.can_pick_holding && !f.holding_point && f.phase === "preparation" && !f.is_controller && f.controlled && (
        <p className="text-[11px] text-muted-foreground">
          {tr("Vol contrôlé : le contrôleur choisit votre point d'attente et trace le roulage.")}
        </p>
      )}
    </div>
  );
}
