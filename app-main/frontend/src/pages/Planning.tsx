import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import { Building2, CalendarDays, Check, ChevronLeft, ChevronRight, Clock, Globe2, Pencil, Radio, Trash2, X } from "lucide-react";
import AppShell from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { apiDelete, apiGet, apiPatch, apiPost } from "@/lib/api";
import { errMsg } from "@/lib/hooks";
import { fmtDateTime } from "@/lib/phases";
import type { FrequencyInfo, PlanningIn, PlanningRequest, PlanningSlot, User } from "@/lib/types";
import { cn } from "@/lib/utils";

import { labels, locale, tr } from "@/lib/i18n";
const FREQ_RE = /^1(1[89]|2\d|3[0-6])\.\d{2,3}$/;
const DAY_FR = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"];
const POS_COLOR: Record<string, string> = { APP: "#4AA8F0", TWR: "#EF4444", GND: "#22C55E", CTR: "#F59E0B" };

// all planning dates are UTC calendar days
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (s: string, n: number) => {
  const d = new Date(`${s}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
};
const mondayOf = (s: string) => {
  const d = new Date(`${s}T00:00:00Z`);
  return addDays(s, -((d.getUTCDay() + 6) % 7));
};
const label = (s: string) => new Date(`${s}T00:00:00Z`).toLocaleDateString(locale(), { day: "numeric", month: "short", timeZone: "UTC" });
const todayUtc = () => iso(new Date());

function useDebounced<T>(v: T, ms = 350) {
  const [x, setX] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setX(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return x;
}

/** Availability form — used to publish a new one, or to request a change of a published one. */
function SlotForm({ initial, submitLabel, busy, onSubmit, onCancel, withReason }: {
  initial?: Partial<PlanningIn>;
  submitLabel: string;
  busy: boolean;
  onSubmit: (b: PlanningIn & { reason?: string }) => void;
  onCancel?: () => void;
  withReason?: boolean;
}) {
  const [date, setDate] = useState(initial?.date ?? todayUtc());
  const [kind, setKind] = useState<"airport" | "center">(initial?.kind ?? "airport");
  const [icao, setIcao] = useState(initial?.icao ?? "");
  const [position, setPosition] = useState<"APP" | "TWR" | "GND">((initial?.position as "APP") ?? "APP");
  const [start, setStart] = useState(initial?.start ?? "18:00");
  const [end, setEnd] = useState(initial?.end ?? "20:00");
  const [freq, setFreq] = useState(initial?.frequency ?? "");
  const [edited, setEdited] = useState(!!initial?.frequency);
  const [reason, setReason] = useState("");
  const pos = kind === "center" ? "CTR" : position;
  const code = useDebounced(icao.trim().toUpperCase());
  const ready = kind === "center" ? code.length >= 3 : code.length === 4;
  const info = useQuery<FrequencyInfo>({
    queryKey: ["atc-frequency", code, pos],
    queryFn: () => apiGet<FrequencyInfo>(`/atc/frequency?icao=${code}&position=${pos}`),
    enabled: ready,
    retry: false,
  });
  useEffect(() => {
    if (!edited && info.data) setFreq(info.data.frequency ?? "");
  }, [info.data, edited]);
  const valid = ready && !!info.data && FREQ_RE.test(freq) && end > start;

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) onSubmit({ date, kind, icao: code, position: pos, frequency: freq, start, end, ...(withReason ? { reason } : {}) });
      }}
      data-testid="planning-form"
    >
      <div className="grid grid-cols-2 gap-1 rounded-lg bg-background/60 p-1 text-xs">
        {([
          ["airport", "Aéroport", Building2],
          ["center", "Centre (CTR)", Globe2],
        ] as const).map(([k, l, Icon]) => (
          <button
            key={k}
            type="button"
            onClick={() => setKind(k)}
            className={cn("flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 font-semibold transition-colors", kind === k ? "bg-[#2B63C9] text-white" : "text-muted-foreground hover:text-foreground")}
          >
            <Icon className="h-3.5 w-3.5" /> {tr(l)}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <label className="space-y-1">
          <span className="text-[11px] text-muted-foreground">{tr("Jour (UTC)")}</span>
          <input type="date" value={date} min={todayUtc()} onChange={(e) => setDate(e.target.value)} required className="w-full rounded-md border border-border bg-card px-2 py-1.5 text-sm outline-none focus:border-[#4AA8F0]" data-testid="planning-date" />
        </label>
        <label className="space-y-1">
          <span className="text-[11px] text-muted-foreground">{kind === "airport" ? tr("Aéroport (OACI)") : tr("Centre (OACI)")}</span>
          <input value={icao} onChange={(e) => setIcao(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))} maxLength={4} placeholder={kind === "airport" ? "LFPG" : "LFFF"} required className="w-full rounded-md border border-border bg-card px-2 py-1.5 font-mono text-sm outline-none focus:border-[#4AA8F0]" data-testid="planning-icao" />
        </label>
      </div>
      {kind === "airport" ? (
        <div className="grid grid-cols-3 gap-1">
          {(["APP", "TWR", "GND"] as const).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setPosition(p)}
              className={cn("rounded-md border px-2 py-1.5 text-xs font-semibold transition-colors", position === p ? "border-[#4AA8F0] bg-[#2B63C9]/25 text-white" : "border-border text-muted-foreground hover:text-foreground")}
              data-testid={`planning-position-${p}`}
            >
              {p}
            </button>
          ))}
        </div>
      ) : (
        <p className="text-[11px] text-muted-foreground">{tr("Position")}{" "}<b className="font-mono text-foreground">{tr("CTR")}</b>{" "}{tr("sélectionnée automatiquement.")}</p>
      )}
      <div className="grid grid-cols-3 gap-2">
        <label className="space-y-1">
          <span className="text-[11px] text-muted-foreground">{tr("Début (UTC)")}</span>
          <input type="time" value={start} onChange={(e) => setStart(e.target.value)} required className="w-full rounded-md border border-border bg-card px-2 py-1.5 font-mono text-sm outline-none focus:border-[#4AA8F0]" data-testid="planning-start" />
        </label>
        <label className="space-y-1">
          <span className="text-[11px] text-muted-foreground">{tr("Fin (UTC)")}</span>
          <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} required className={cn("w-full rounded-md border bg-card px-2 py-1.5 font-mono text-sm outline-none focus:border-[#4AA8F0]", end <= start ? "border-red-500" : "border-border")} data-testid="planning-end" />
        </label>
        <label className="space-y-1">
          <span className="text-[11px] text-muted-foreground">{tr("Fréquence")}</span>
          <input
            value={freq}
            onChange={(e) => {
              setEdited(true);
              setFreq(e.target.value.replace(/[^0-9.]/g, ""));
            }}
            maxLength={7}
            placeholder="118.650"
            className={cn("w-full rounded-md border bg-card px-2 py-1.5 font-mono text-sm text-amber-200 outline-none focus:border-[#4AA8F0]", freq && !FREQ_RE.test(freq) ? "border-red-500" : "border-border")}
            data-testid="planning-frequency"
          />
        </label>
      </div>
      {ready && info.isError && <p className="text-xs text-red-400">{errMsg(info.error)}</p>}
      {info.data && (
        <p className="text-[11px] text-muted-foreground">
          <span className="font-mono text-[#7CC0F5]">{info.data.icao}_{pos}</span> · {info.data.name}
          {!info.data.frequency && tr(" · aucune fréquence connue : saisissez-la")}
        </p>
      )}
      {end <= start && <p className="text-xs text-red-400">{tr("L'heure de fin doit être après l'heure de début.")}</p>}
      {withReason && (
        <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} placeholder={tr("Motif de la modification (facultatif)")} className="w-full rounded-md border border-border bg-card px-2 py-1.5 text-sm outline-none focus:border-[#4AA8F0]" data-testid="planning-reason" />
      )}
      <div className="flex gap-2">
        {onCancel && (
          <Button type="button" variant="outline" size="lg" onClick={onCancel}>{tr("Annuler")}</Button>
        )}
        <Button type="submit" size="lg" className="flex-1" disabled={!valid || busy} data-testid="planning-submit">
          {busy ? tr("Envoi…") : submitLabel}
        </Button>
      </div>
    </form>
  );
}

const CHANGE_LABEL: Record<string, string> = labels({ date: "jour", callsign: "position", frequency: "fréquence", start: "début", end: "fin" });

function Diff({ r }: { r: PlanningRequest }) {
  const keys = ["date", "callsign", "start", "end", "frequency"].filter((k) => r.before[k] !== r.changes[k]);
  return (
    <ul className="space-y-0.5 text-xs">
      {keys.map((k) => (
        <li key={k}>
          <span className="text-muted-foreground">{CHANGE_LABEL[k]} :</span> <s className="text-muted-foreground">{r.before[k]}</s> →{" "}
          <b className="font-mono text-foreground">{r.changes[k]}</b>
        </li>
      ))}
    </ul>
  );
}

function RequestsPanel({ lead }: { lead: boolean }) {
  const qc = useQueryClient();
  const pending = useQuery<PlanningRequest[]>({ queryKey: ["planning-requests", "pending"], queryFn: () => apiGet("/planning/requests?status=pending"), refetchInterval: 15_000 });
  const decided = useQuery<PlanningRequest[]>({ queryKey: ["planning-requests", "decided"], queryFn: () => apiGet("/planning/requests?status=decided") });
  const [comment, setComment] = useState<Record<string, string>>({});
  const decide = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: "accept" | "refuse" }) =>
      apiPatch<PlanningRequest>(`/planning/requests/${id}`, { decision, comment: comment[id] || null }),
    onSuccess: (r) => toast.success(r.status === "accepted" ? tr("Modification acceptée et appliquée") : tr("Modification refusée")),
    onError: (e) => toast.error(errMsg(e)),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["planning-requests"] });
      qc.invalidateQueries({ queryKey: ["planning"] });
    },
  });
  const list = pending.data ?? [];
  return (
    <section className="space-y-3 rounded-2xl border border-border bg-card p-4" data-testid="planning-requests">
      <h2 className="flex items-center justify-between text-sm font-semibold">
        {lead ? tr("Demandes de modification à valider") : tr("Mes demandes de modification")}
        <span className={cn("rounded-full px-2 py-0.5 font-mono text-xs", list.length ? "bg-amber-500/20 text-amber-300" : "bg-secondary text-muted-foreground")}>{list.length}</span>
      </h2>
      {list.length === 0 && <p className="text-xs text-muted-foreground">{tr("Aucune demande en attente.")}</p>}
      <AnimatePresence initial={false}>
        {list.map((r) => (
          <motion.div key={r.id} layout initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, x: 20 }} className="space-y-2 rounded-xl border border-amber-500/40 bg-amber-500/5 p-3" data-testid={`planning-request-${r.id}`}>
            <div className="flex items-center justify-between gap-2 text-sm">
              <b className="font-mono text-[#7CC0F5]">{r.callsign}</b>
              <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] font-semibold text-amber-300">{tr("En attente")}</span>
            </div>
            <div className="text-[11px] text-muted-foreground">{tr("Demandée par")}{" "}<b className="text-foreground">{r.requested_by}</b>{" "}{tr("le")}{" "}{fmtDateTime(r.requested_at)}
            </div>
            <Diff r={r} />
            {r.reason && <p className="text-xs italic text-muted-foreground">« {r.reason} »</p>}
            {lead && (
              <div className="space-y-2">
                <input value={comment[r.id] ?? ""} onChange={(e) => setComment({ ...comment, [r.id]: e.target.value })} maxLength={200} placeholder={tr("Commentaire (facultatif)")} className="w-full rounded-md border border-border bg-card px-2 py-1 text-xs outline-none focus:border-[#4AA8F0]" />
                <div className="grid grid-cols-2 gap-2">
                  <Button size="lg" variant="destructive" disabled={decide.isPending} onClick={() => decide.mutate({ id: r.id, decision: "refuse" })} data-testid={`planning-refuse-${r.id}`}>
                    <X className="h-4 w-4" />{" "}{tr("Refuser")}</Button>
                  <Button size="lg" disabled={decide.isPending} onClick={() => decide.mutate({ id: r.id, decision: "accept" })} data-testid={`planning-accept-${r.id}`}>
                    <Check className="h-4 w-4" />{" "}{tr("Accepter")}</Button>
                </div>
              </div>
            )}
          </motion.div>
        ))}
      </AnimatePresence>
      {(decided.data ?? []).length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">{tr("Demandes traitées ({0})", [decided.data!.length])}</summary>
          <ul className="mt-2 space-y-1.5">
            {decided.data!.slice(0, 20).map((r) => (
              <li key={r.id} className="rounded-md bg-background/50 px-2 py-1.5" data-testid={`planning-decided-${r.id}`}>
                <b className="font-mono">{r.callsign}</b> · {r.requested_by} —{" "}
                <span className={r.status === "accepted" ? "text-emerald-300" : "text-red-300"}>{r.status === "accepted" ? tr("acceptée") : tr("refusée")}</span>{" "}{tr("par")}{" "}
                <b>{r.decided_by}</b>
                {r.decided_at && <>{" "}{tr("le {0}", [fmtDateTime(r.decided_at)])}</>}
                {r.comment && <span className="text-muted-foreground"> · « {r.comment} »</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function SlotCard({ s, me, onChanged }: { s: PlanningSlot; me: User; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const color = POS_COLOR[s.position] ?? "#94A3B8";
  const req = useMutation({
    mutationFn: (b: PlanningIn & { reason?: string }) => apiPost<PlanningRequest>(`/planning/${s.id}/requests`, b),
    onSuccess: (r) => {
      toast.success(r.status === "pending" ? tr("Demande envoyée aux administrateurs et au Responsable ATC") : tr("Modification enregistrée"));
      setEditing(false);
    },
    onError: (e) => toast.error(errMsg(e)),
    onSettled: onChanged,
  });
  const del = useMutation({
    mutationFn: () => apiDelete(`/planning/${s.id}`),
    onSuccess: () => toast.success(tr("Disponibilité supprimée")),
    onError: (e) => toast.error(errMsg(e)),
    onSettled: onChanged,
  });
  const mine = s.user_id === me.id;
  return (
    <motion.div layout initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} className={cn("min-w-0 space-y-2 rounded-xl border bg-background/60 p-3", mine ? "border-[#2B63C9]/50" : "border-border")} style={{ borderLeft: `3px solid ${color}` }} data-testid={`planning-slot-${s.callsign}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <span className="font-mono text-base font-bold" style={{ color }}>{s.callsign}</span>
        <span className="font-mono text-sm text-amber-200">{s.frequency}</span>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 text-xs">
        <span className="flex items-center gap-1 whitespace-nowrap font-mono">
          <Clock className="h-3.5 w-3.5 text-muted-foreground" /> {s.start} – {s.end}{" "}{tr("UTC")}</span>
        <span className="truncate text-muted-foreground">{s.controller}{mine && tr(" (vous)")}</span>
      </div>
      {s.pending_request && (
        <div className="rounded-md bg-amber-500/15 px-1.5 py-1 text-[10px] font-semibold text-amber-300" data-testid={`planning-pending-${s.callsign}`}>{tr("Modification en attente de validation")}</div>
      )}
      {s.last_change_by && !s.pending_request && <div className="text-[10px] text-emerald-300/80">{tr("Modifiée · validée par {0}", [s.last_change_by])}</div>}
      {editing ? (
        <div className="rounded-lg border border-[#2B63C9]/40 bg-card p-2">
          <SlotForm initial={{ ...s, position: s.position as PlanningIn["position"] }} withReason submitLabel={tr("Envoyer la demande")} busy={req.isPending} onSubmit={(b) => req.mutate(b)} onCancel={() => setEditing(false)} />
        </div>
      ) : confirmDel ? (
        <div className="space-y-1.5">
          <p className="text-[11px] text-red-300">{tr("Supprimer définitivement cette disponibilité ?")}</p>
          <div className="grid grid-cols-2 gap-1">
            <Button size="sm" variant="outline" onClick={() => setConfirmDel(false)}>{tr("Non")}</Button>
            <Button size="sm" variant="destructive" disabled={del.isPending} onClick={() => del.mutate()} data-testid={`planning-delete-confirm-${s.callsign}`}>{tr("Supprimer")}</Button>
          </div>
        </div>
      ) : (
        (s.can_request_change || s.can_delete) && (
          <div className="flex gap-1">
            {s.can_request_change && (
              <Button size="sm" variant="outline" className="flex-1" onClick={() => setEditing(true)} data-testid={`planning-edit-${s.callsign}`}>
                <Pencil className="h-3 w-3" />{" "}{tr("Modifier")}</Button>
            )}
            {s.can_delete && (
              <Button size="sm" variant="destructive" onClick={() => setConfirmDel(true)} title={tr("Supprimer")} data-testid={`planning-delete-${s.callsign}`}>
                <Trash2 className="h-3 w-3" />
              </Button>
            )}
          </div>
        )
      )}
    </motion.div>
  );
}

function PlanningView({ user }: { user: User }) {
  const qc = useQueryClient();
  const [week, setWeek] = useState(() => mondayOf(todayUtc()));
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(week, i)), [week]);
  const q = useQuery<PlanningSlot[]>({ queryKey: ["planning", week], queryFn: () => apiGet(`/planning?start=${week}&days=7`), refetchInterval: 30_000 });
  const canPublish = user.role === "atc" || user.role === "admin";
  const lead = user.access.atc_lead || user.access.admin;
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["planning"] });
    qc.invalidateQueries({ queryKey: ["planning-requests"] });
  };
  const create = useMutation({
    mutationFn: (b: PlanningIn) => apiPost<PlanningSlot>("/planning", b),
    onSuccess: (s) => {
      toast.success(tr("Disponibilité {0} publiée", [s.callsign]));
      if (s.date < week || s.date > addDays(week, 6)) setWeek(mondayOf(s.date));
    },
    onError: (e) => toast.error(errMsg(e)),
    onSettled: refresh,
  });
  const today = todayUtc();
  const byDay = (d: string) => (q.data ?? []).filter((s) => s.date === d);

  return (
    <div className="mx-auto max-w-7xl space-y-5 p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight"><CalendarDays className="h-5 w-5 text-[#4AA8F0]" />{" "}{tr("Planning ATC")}</h1>
          <p className="text-xs text-muted-foreground">{tr("Les ouvertures annoncées par les contrôleurs. Toutes les heures sont en UTC.")}</p>
        </div>
        <div className="flex w-full flex-wrap items-center gap-1.5 sm:w-auto">
          <Button variant="outline" size="icon-lg" onClick={() => setWeek(addDays(week, -7))} title={tr("Semaine précédente")} data-testid="planning-prev-week"><ChevronLeft className="h-4 w-4" /></Button>
          <div className="min-w-0 flex-1 text-center text-sm font-medium sm:min-w-44 sm:flex-none" data-testid="planning-week-label">{tr("Semaine du {0} au {1}", [label(week), label(addDays(week, 6))])}</div>
          <Button variant="outline" size="icon-lg" onClick={() => setWeek(addDays(week, 7))} title={tr("Semaine suivante")} data-testid="planning-next-week"><ChevronRight className="h-4 w-4" /></Button>
          <Button variant="secondary" size="lg" className="w-full sm:w-auto" onClick={() => setWeek(mondayOf(today))}>{tr("Cette semaine")}</Button>
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-[20rem_1fr]">
        <div className="space-y-5">
          {canPublish && (
            <section className="space-y-3 rounded-2xl border border-[#2B63C9]/40 bg-gradient-to-b from-[#12264A] to-card p-4" data-testid="planning-create">
              <h2 className="flex items-center gap-2 text-sm font-semibold"><Radio className="h-4 w-4 text-[#4AA8F0]" />{" "}{tr("Annoncer une disponibilité")}</h2>
              <SlotForm submitLabel={tr("Publier")} busy={create.isPending} onSubmit={(b) => create.mutate(b)} />
              <p className="text-[10px] text-muted-foreground">{tr("Une fois publiée, toute modification passe par une demande validée par un administrateur ou le Responsable ATC.")}</p>
            </section>
          )}
          {canPublish && <RequestsPanel lead={lead} />}
        </div>

        {/* agenda: one row per day (a 7-column grid was far too narrow next to the form) */}
        <div className="min-w-0 space-y-2" data-testid="planning-week">
          {days.map((d, i) => {
            const slots = byDay(d);
            return (
              <div
                key={d}
                className={cn(
                  "flex flex-col gap-2 rounded-2xl border p-3 sm:flex-row sm:gap-4",
                  d === today ? "border-[#4AA8F0]/60 bg-[#2B63C9]/10" : "border-border bg-card/60",
                  d < today && "opacity-60",
                )}
                data-testid={`planning-day-${d}`}
              >
                <div className="flex shrink-0 items-baseline gap-2 sm:w-28 sm:flex-col sm:gap-0.5 sm:pt-1">
                  <span className="text-sm font-semibold">{tr(DAY_FR[i])}</span>
                  <span className="text-xs text-muted-foreground">{label(d)}</span>
                  {d === today && <span className="rounded-full bg-[#2B63C9] px-2 py-0.5 text-[10px] font-semibold text-white sm:mt-1">{tr("Aujourd'hui")}</span>}
                </div>
                {slots.length === 0 ? (
                  <p className="text-xs text-muted-foreground/70 sm:self-center">{tr("Aucune ouverture prévue")}</p>
                ) : (
                  <div className="grid min-w-0 flex-1 gap-2 md:grid-cols-2 2xl:grid-cols-3">
                    {slots.map((s) => <SlotCard key={s.id} s={s} me={user} onChanged={refresh} />)}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      {q.isError && <p className="text-sm text-red-300">{errMsg(q.error)}</p>}
    </div>
  );
}

export default function Planning() {
  return <AppShell>{(user) => <PlanningView user={user} />}</AppShell>;
}
