import { useState, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import {
  MoveRight,
  ChevronLeft, ChevronRight, CircleX, Flag, Hand, Headset, Info, MoveDown, Navigation, Pause, PlaneLanding,
  PlaneTakeoff, Play, Route, ShieldCheck, SquareParking, Undo2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiPost } from "@/lib/api";
import { useFlightMutation } from "@/lib/hooks";
import type { FlightEditing } from "@/lib/useFlightEditing";
import RejectedTakeoff from "@/components/RejectedTakeoff";
import type { ActionInfo, FlightDetail } from "@/lib/types";
import { cn } from "@/lib/utils";

import { tr, trServer } from "@/lib/i18n";
import { PHASE_COLORS, PHASE_LABELS } from "@/lib/phases";
const ACTIVE = new Set([
  "preparation", "repoussage", "roulage", "point_attente", "alignement", "decollage", "en_route", "approche",
  "atterrissage", "roulage_arrivee", "retour_parking", "parking", "suspendu",
]);
// laid out as a compass rose (3 x 3, centre left empty); the choice is where the nose ends up pointing
const DIRS = [
  ["NW", "Nord-Ouest"], ["N", "Nord"], ["NE", "Nord-Est"],
  ["W", "Ouest"], null, ["E", "Est"],
  ["SW", "Sud-Ouest"], ["S", "Sud"], ["SE", "Sud-Est"],
] as const;
const ICONS: Record<string, LucideIcon> = {
  repoussage: MoveDown, roulage: Route, point_attente: Hand, alignement: MoveRight, decollage: PlaneTakeoff, approche: Navigation,
  go_around: Undo2, atterrissage: PlaneLanding, roulage_arrivee: Route, parking: SquareParking, reprendre: Play,
  suspendre: Pause, terminer: Flag, annuler: CircleX, interrompre_decollage: Undo2, retour_parking: SquareParking,
};
// actions that end or interrupt the flight: kept apart, in red, never next to the normal progression
const DANGER = new Set(["annuler", "suspendre"]);

type Pending = { label: string; danger: boolean; run: () => void };

function Notice({ tone, icon: Icon, children, testId }: { tone: "info" | "ok" | "muted"; icon: LucideIcon; children: ReactNode; testId: string }) {
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-lg border px-3 py-2 text-xs leading-relaxed",
        tone === "info" && "border-sky-500/40 bg-sky-500/8 text-sky-100",
        tone === "ok" && "border-emerald-500/40 bg-emerald-500/8 text-emerald-100",
        tone === "muted" && "border-border bg-background/50 text-muted-foreground",
      )}
      data-testid={testId}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

/** Phase buttons (only what the SERVER allows), grouped by function: move the flight forward (big, blue),
 * adjust (outline), end / interrupt (red, separate). Confirmations are INLINE (no modal that could freeze the page). */
/** part="main": phase buttons, Stop, previous / next step. part="end": end or interruption of the flight (kept apart,
 * at the bottom of the tab). Without `part`, both. */
/** « Étape précédente / suivante » with a preview of the step it leads to (decided by the server: step_prev / step_next). */
function StepButton({ dir, to, onClick, disabled }: { dir: "prev" | "next"; to: string; onClick: () => void; disabled: boolean }) {
  const prev = dir === "prev";
  const color = PHASE_COLORS[to] ?? "#4AA8F0";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "group flex min-w-0 items-center gap-2 rounded-lg border border-border/70 bg-background/30 px-2.5 py-1.5 transition-colors hover:border-[#4AA8F0]/50 hover:bg-[#2B63C9]/10 disabled:opacity-50",
        prev ? "text-left" : "flex-row-reverse text-right",
      )}
      data-testid={`step-${dir}`}
    >
      {prev ? <ChevronLeft className="h-4 w-4 shrink-0 text-muted-foreground group-hover:text-foreground" /> : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground group-hover:text-foreground" />}
      <span className="min-w-0 leading-tight">
        <span className="block text-[10px] uppercase tracking-wider text-muted-foreground">{prev ? tr("Étape précédente") : tr("Étape suivante")}</span>
        <span className={cn("flex items-center gap-1.5 text-xs font-semibold text-foreground", !prev && "justify-end")} data-testid={`step-${dir}-to`}>
          <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: color }} />
          <span className="truncate">{PHASE_LABELS[to] ?? to}</span>
        </span>
      </span>
    </button>
  );
}

export default function FlightActions({ flight, ed, part }: { flight: FlightDetail; ed?: FlightEditing; part?: "main" | "end" }) {
  const m = useFlightMutation(flight.id);
  const [pending, setPending] = useState<Pending | null>(null);
  const [askPush, setAskPush] = useState(false);
  const [reject, setReject] = useState<null | "interrompre_decollage" | "retour_parking">(null);
  // the server decides who may act: allowed_actions is empty for anybody who is not in charge of this flight
  const locked = flight.allowed_actions.length === 0 && !flight.can_control;
  const canStep = ACTIVE.has(flight.phase) && flight.phase !== "suspendu" && !locked;
  const progress = flight.allowed_actions.filter((a) => !DANGER.has(a.code));
  const uniqProgress = progress.filter((a, i, arr) => arr.findIndex((x) => x.code === a.code) === i);
  const danger = flight.allowed_actions.filter((a) => DANGER.has(a.code));
  const notStarted = flight.position.distance_nm === 0; // waiting at the start of its route (exit after an interrupted take-off)

  const action = (code: string, label: string, extra: Record<string, string> = {}) => () =>
    m.mutate({ fn: () => apiPost<FlightDetail>(`/flights/${flight.id}/actions`, { action: code, version: flight.version, ...extra }), success: label });
  const step = (direction: "prev" | "next") => () =>
    m.mutate({
      fn: () => apiPost<FlightDetail>(`/flights/${flight.id}/step`, { direction, version: flight.version }),
      success: direction === "next" ? tr("Étape suivante") : tr("Retour à l'étape précédente"),
    });
  const click = (a: ActionInfo) =>
    a.code === "interrompre_decollage" || a.code === "retour_parking"
      ? setReject(a.code)
      : a.code === "repoussage"
      ? setAskPush(true)
      : a.confirm || DANGER.has(a.code)
        ? setPending({ label: tr(a.label), danger: DANGER.has(a.code), run: action(a.code, tr(a.label)) })
        : action(a.code, tr(a.label))();

  const confirmBox = pending && (
          <motion.div
            key="confirm"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.16 }}
            className={cn("space-y-3 rounded-xl border p-4", pending.danger ? "border-red-500/50 bg-red-500/8" : "border-[#4AA8F0]/50 bg-[#4AA8F0]/8")}
            data-testid="confirm-dialog"
          >
            <p className="text-sm font-semibold">{tr("Confirmer : {0}", [pending.label])}</p>
            <p className="text-xs text-muted-foreground">{tr("Cette action est enregistrée dans l'historique du vol et visible par tous.")}</p>
            <div className="grid grid-cols-2 gap-2">
              <Button variant="outline" size="lg" type="button" onClick={() => setPending(null)} data-testid="confirm-cancel">{tr("Retour")}</Button>
              <Button
                type="button"
                size="lg"
                variant={pending.danger ? "destructive" : "default"}
                onClick={() => {
                  const p = pending;
                  setPending(null);
                  p.run();
                }}
                data-testid="confirm-ok"
              >{tr("Confirmer")}</Button>
            </div>
          </motion.div>
  );

  if (part === "end") {
    if (danger.length === 0) return null;
    return pending ? (
      confirmBox
    ) : (
      <div className="flex flex-wrap gap-2" data-testid="flight-end-actions">
        {danger.map((a) => {
          const Icon = ICONS[a.code] ?? CircleX;
          return (
            <Button key={a.code} type="button" variant="outline" size="sm" disabled={m.isPending} onClick={() => click(a)}
              className="border-red-500/40 text-red-300 hover:bg-red-500/10" data-testid={`action-${a.code}`}>
              <Icon className="h-4 w-4" /> {tr(a.label)}
            </Button>
          );
        })}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {flight.controlled && !flight.is_controller && (
        <Notice tone="info" icon={Headset} testId="controlled-notice">
          {flight.is_owner
            ? tr("Vol contrôlé par {0} ({1}) : suivez ses instructions, il fait évoluer le vol.", [flight.controller_name, flight.controller_callsign])
            : tr("Ce vol relève de {0} ({1}) : consultation seulement.", [flight.controller_callsign, flight.controller_name])}
        </Notice>
      )}
      {!flight.controlled && locked && !flight.is_owner && (
        <Notice tone="muted" icon={Info} testId="readonly-notice">{tr("Ce vol ne relève d'aucune de vos positions : consultation seulement.")}</Notice>
      )}
      {flight.phase === "alignement" && (
        <Notice tone="info" icon={MoveRight} testId="lineup-notice">
          {flight.takeoff_cleared
            ? tr("Autorisé au décollage : l'avion s'aligne sur la piste puis décolle tout seul.")
            : tr("Aligné et en attente sur la piste : décollage sur autorisation.")}
        </Notice>
      )}
            {flight.controlled && flight.is_controller && (
        <Notice tone="ok" icon={ShieldCheck} testId="responsible-notice">{tr("Vous êtes responsable de ce vol ({0}).", [flight.controller_callsign])}</Notice>
      )}

      <AnimatePresence mode="wait" initial={false}>
        {pending ? (
          confirmBox
        ) : ed?.mode === "pushback" ? (
          <motion.div
            key="push-map"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            className="space-y-2 rounded-xl border border-[#4AA8F0]/50 bg-[#4AA8F0]/8 p-4"
            data-testid="pushback-click"
          >
            <p className="text-sm font-semibold">{tr("Repoussage, nez vers le {0}", [ed.pushLabel?.toLowerCase()])}</p>
            <p className="text-xs text-muted-foreground">{tr("2. Cliquez sur la carte l'endroit où l'avion doit s'arrêter (entre 10 et 400 m du poste). Le repoussage démarre aussitôt.")}</p>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => { ed.setMode("view"); setAskPush(true); }}>{tr("Changer de direction")}</Button>
              <Button size="sm" variant="ghost" onClick={() => ed.setMode("view")} data-testid="pushback-click-cancel">{tr("Annuler")}</Button>
            </div>
          </motion.div>
        ) : reject ? (
          <motion.div key="reject" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}>
            <RejectedTakeoff flight={flight} code={reject} ed={ed} onClose={() => setReject(null)} />
          </motion.div>
        ) : askPush ? (
          <motion.div
            key="push"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.16 }}
            className="space-y-3 rounded-xl border border-[#4AA8F0]/50 bg-[#4AA8F0]/8 p-4"
            data-testid="pushback-picker"
          >
            <p className="text-sm font-semibold">{tr("Repoussage : 1. le nez de l'avion finit vers…")}</p>
            <p className="text-xs text-muted-foreground">{tr("2. Ensuite, cliquez sur la carte l'endroit où le pushback laisse l'avion.")}</p>
            <div className="mx-auto grid max-w-xs grid-cols-3 gap-2">
              {DIRS.map((entry, i) => entry === null ? (
                <div key={`c${i}`} className="grid place-items-center text-xs text-muted-foreground">✈</div>
              ) : (([d, label]) => (
                <Button
                  key={d}
                  type="button"
                  variant="outline"
                  className="h-11 px-1 text-xs"
                  onClick={() => {
                    setAskPush(false);
                    ed?.startPushback(d, tr(label)); // then the end point is clicked on the map
                  }}
                  data-testid={`pushback-${d}`}
                >
                  {tr(label)}
                </Button>
              ))(entry))}
            </div>
            <Button size="sm" variant="ghost" onClick={() => setAskPush(false)} data-testid="pushback-cancel">{tr("Retour")}</Button>
          </motion.div>
        ) : (
          <motion.div key="buttons" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.12 }} className="space-y-3">
            {flight.can_stop_taxi && (
              <motion.button
                type="button"
                whileTap={{ scale: 0.97 }}
                disabled={m.isPending}
                onClick={() =>
                  m.mutate({
                    fn: () => apiPost<FlightDetail>(`/flights/${flight.id}/taxi-stop`, { stop: !flight.hold, version: flight.version }),
                    success: flight.hold ? tr("Roulage repris") : tr("Avion arrêté"),
                  })
                }
                className={cn(
                  "flex min-h-14 w-full items-center justify-center gap-2 rounded-xl text-base font-bold shadow-sm transition-colors disabled:opacity-50",
                  flight.hold ? "bg-emerald-600 text-white hover:bg-emerald-500" : "bg-red-600 text-white hover:bg-red-500",
                )}
                data-testid={flight.hold ? "taxi-resume" : "taxi-stop"}
              >
                {flight.hold ? <Play className="h-5 w-5" /> : <Hand className="h-5 w-5" />}
                {flight.hold ? (notStarted ? tr("Commencer le roulage") : tr("Reprendre le roulage")) : tr("Stop — arrêter l'avion")}
              </motion.button>
            )}
            {flight.can_stop_taxi && flight.hold && (
              <p className="text-center text-xs text-amber-200" data-testid="taxi-stopped-note">
                {notStarted ? tr("Avion arrêté sur le taxiway de sortie : il part quand vous commencez le roulage.") : tr("Avion arrêté sur le taxiway — il repart là où il s'est arrêté.")}
              </p>
            )}
            {flight.phase === "decollage" && progress.some((a) => a.code === "interrompre_decollage") && (
              <p className="text-xs text-muted-foreground" data-testid="rejected-takeoff-note">{tr("Décollage interrompu ? Choisissez de revenir au point d'attente pour redécoller, ou de rentrer au parking.")}</p>
            )}
            {progress.length > 0 && (
              <div className={cn("grid gap-2", progress.length > 1 ? "grid-cols-2" : "grid-cols-1")} data-testid="flight-actions">
                {uniqProgress.map((a, i) => {
                  const Icon = ICONS[a.code] ?? ChevronRight;
                  return (
                    <motion.button
                      key={a.code}
                      type="button"
                      whileHover={{ y: -1 }}
                      whileTap={{ scale: 0.97 }}
                      disabled={m.isPending || !!a.blocked}
                      title={a.blocked ? trServer(a.blocked) : undefined}
                      onClick={() => click(a)}
                      className={cn(
                        "flex min-h-12 items-center justify-center gap-2 rounded-xl px-3 text-sm font-semibold shadow-sm transition-colors disabled:opacity-50",
                        i === 0
                          ? "bg-[#2B63C9] text-white shadow-[#2B63C9]/30 hover:bg-[#3572DB]"
                          : "border border-[#2B63C9]/50 bg-[#2B63C9]/10 text-[#9CCBF5] hover:bg-[#2B63C9]/20",
                        progress.length % 2 === 1 && i === 0 && progress.length > 1 && "col-span-2",
                      )}
                      data-testid={`action-${a.code}`}
                    >
                      <Icon className="h-5 w-5" /> {tr(a.label)}
                    </motion.button>
                  );
                })}
              </div>
            )}
            {progress.filter((a) => a.blocked).map((a) => (
              <Notice key={`b-${a.code}`} tone="info" icon={Hand} testId={`blocked-${a.code}`}>
                {trServer(a.blocked!)}
              </Notice>
            ))}
            {flight.allowed_actions.length === 0 && !locked && (
              <p className="text-sm text-muted-foreground" data-testid="no-actions">{tr("Aucune action disponible pour vous dans cet état.")}</p>
            )}

            {canStep && (flight.step_prev || flight.step_next) && (
              <div className="grid grid-cols-2 gap-2" data-testid="step-buttons">
                {flight.step_prev ? (
                  <StepButton dir="prev" to={flight.step_prev} disabled={m.isPending}
                    onClick={() => setPending({ label: tr("Revenir à « {0} »", [PHASE_LABELS[flight.step_prev!] ?? flight.step_prev!]), danger: false, run: step("prev") })} />
                ) : <span />}
                {flight.step_next && (
                  <StepButton dir="next" to={flight.step_next} disabled={m.isPending}
                    onClick={() => setPending({ label: tr("Passer à « {0} »", [PHASE_LABELS[flight.step_next!] ?? flight.step_next!]), danger: false, run: step("next") })} />
                )}
              </div>
            )}

            {part === undefined && danger.length > 0 && (
              <div className="pt-1"><FlightActions flight={flight} ed={ed} part="end" /></div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
