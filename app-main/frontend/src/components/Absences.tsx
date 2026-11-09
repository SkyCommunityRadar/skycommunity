import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, Palmtree } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiGet, apiPost } from "@/lib/api";
import { errMsg } from "@/lib/hooks";
import type { Absence, User } from "@/lib/types";
import { cn } from "@/lib/utils";

import { locale, tr } from "@/lib/i18n";
const STATUS: Record<Absence["status"], [string, string]> = {
  en_attente: ["En attente de validation", "bg-amber-500/15 text-amber-300 ring-amber-500/30"],
  acceptee: ["Acceptée", "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30"],
  refusee: ["Refusée", "bg-red-500/15 text-red-300 ring-red-500/30"],
  annulee: ["Annulée", "bg-secondary text-muted-foreground ring-border"],
  ecourtee: ["Terminée plus tôt", "bg-secondary text-muted-foreground ring-border"],
};
const fr = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString(locale(), { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" });
const today = () => new Date().toISOString().slice(0, 10);
const plus = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const span = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000) + 1;

function useRefresh() {
  const qc = useQueryClient();
  return () => {
    ["absences", "me", "activity-members", "activity-summary", "activity-journal"].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
  };
}

function StatusChip({ a }: { a: Absence }) {
  const [label, cls] = STATUS[a.status];
  return <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1", cls)}>{a.ongoing ? tr("En cours") : tr(label)}</span>;
}

/** Profile: the member declares his absences (pilots and controllers; the staff uses the Discord bot). */
export function MyAbsences({ user }: { user: User }) {
  const refresh = useRefresh();
  const q = useQuery<Absence[]>({ queryKey: ["absences", "me"], queryFn: () => apiGet<Absence[]>("/absences/me") });
  const [start, setStart] = useState(today);
  const [end, setEnd] = useState(() => plus(today(), 6));
  const [reason, setReason] = useState("");
  const create = useMutation({
    mutationFn: () => apiPost<Absence>("/absences/me", { start, end, reason: reason.trim() }),
    onSuccess: (a) => {
      toast.success(a.status === "acceptee" ? tr("Absence enregistrée") : tr("Demande d'absence envoyée au responsable"));
      setReason("");
      refresh();
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  const stop = useMutation({
    mutationFn: (id: string) => apiPost<Absence>(`/absences/me/${id}/end`),
    onSuccess: (a) => {
      toast.success(a.status === "ecourtee" ? tr("Bon retour ! Absence terminée") : tr("Absence annulée"));
      refresh();
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  const a = user.access;
  const concerned = !a.admin && ((a.pilote && !a.pilot_lead) || (a.atc && !a.atc_lead));
  if (!concerned) return null;
  const days = span(start, end);
  const valid = days >= 1 && reason.trim().length >= 3;
  return (
    <div className="space-y-3 rounded border border-border bg-card p-4" data-testid="my-absences">
      <div>
        <h2 className="flex items-center gap-2 text-sm font-semibold"><Palmtree className="h-4 w-4 text-[#4AA8F0]" />{" "}{tr("Mes absences")}</h2>
        <p className="text-xs text-muted-foreground">
          {a.atc && !a.pilote
            ? tr("Prévenez quand vous ne pourrez pas contrôler : pendant une absence, la règle d'inactivité est en pause.")
            : tr("Prévenez quand vous ne pourrez pas voler : pendant une absence, la règle d'inactivité est en pause.")}{" "}
          {tr("Jusqu'à 7 jours, c'est accepté tout de suite ; au-delà, la demande part au responsable.")}
        </p>
      </div>
      <div className="flex flex-wrap items-end gap-2 text-xs">
        <label className="space-y-1">
          <span className="block text-muted-foreground">{tr("Du")}</span>
          <input type="date" value={start} min={today()} onChange={(e) => setStart(e.target.value)}
            className="rounded border border-border bg-background px-2 py-1 font-mono" data-testid="absence-start" />
        </label>
        <label className="space-y-1">
          <span className="block text-muted-foreground">{tr("Au (inclus)")}</span>
          <input type="date" value={end} min={start} onChange={(e) => setEnd(e.target.value)}
            className="rounded border border-border bg-background px-2 py-1 font-mono" data-testid="absence-end" />
        </label>
        <label className="min-w-48 flex-1 space-y-1">
          <span className="block text-muted-foreground">{tr("Motif (obligatoire)")}</span>
          <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder={tr("Vacances, examens, PC en panne…")}
            className="w-full rounded border border-border bg-background px-2 py-1" data-testid="absence-reason" />
        </label>
        <Button size="sm" onClick={() => create.mutate()} disabled={!valid || create.isPending} data-testid="absence-submit">
          {days > 7 ? tr("Envoyer la demande") : tr("Déclarer l'absence")}
        </Button>
      </div>
      {days >= 1 && (
        <p className={cn("text-[11px]", days > 7 ? "text-amber-300" : "text-muted-foreground")}>
          {days > 1 ? tr("{0} jours", [days]) : tr("1 jour")} — {days > 7 ? tr("plus de 7 jours : un responsable doit valider.") : tr("acceptée automatiquement.")}
        </p>
      )}
      {(q.data?.length ?? 0) > 0 && (
        <ul className="space-y-1.5 text-xs">
          {q.data!.map((x) => (
            <li key={x.id} className="flex flex-wrap items-center gap-2 rounded bg-background/50 px-2.5 py-1.5" data-testid={`my-absence-${x.id}`}>
              <span className="font-mono">{fr(x.start)} → {fr(x.end)}</span>
              <StatusChip a={x} />
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{x.reason}{x.comment ? tr(" — réponse : {0}", [x.comment]) : ""}</span>
              {x.can_end && (
                <Button size="xs" variant="outline" onClick={() => stop.mutate(x.id)} disabled={stop.isPending} data-testid={`my-absence-end-${x.id}`}>
                  {x.ongoing ? tr("Je suis de retour") : tr("Annuler")}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function LeadRow({ a }: { a: Absence }) {
  const refresh = useRefresh();
  const [form, setForm] = useState<null | "refuse" | "shorten">(null);
  const [comment, setComment] = useState("");
  const [newEnd, setNewEnd] = useState(a.start);
  const m = useMutation({
    mutationFn: (b: { decision: string; comment?: string; end?: string }) => apiPost<Absence>(`/absences/${a.id}/decision`, b),
    onSuccess: (_r, b) => {
      toast.success(tr({ accept: "Absence acceptée", refuse: "Absence refusée", shorten: "Absence raccourcie" }[b.decision] ?? "Fait"));
      setForm(null);
      setComment("");
      refresh();
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  return (
    <li className={cn("space-y-1.5 rounded-lg border bg-card p-3 text-sm", a.status === "en_attente" ? "border-amber-500/50" : "border-border")} data-testid={`absence-${a.id}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Link to={`/pilotes/${a.user_id}`} className="flex items-center gap-2 font-semibold hover:text-[#4AA8F0]">
          {a.avatar_url && <img src={a.avatar_url} alt="" className="h-6 w-6 rounded-full" />}
          {a.display_name}
        </Link>
        <StatusChip a={a} />
        {a.frequent && (
          <span className="flex items-center gap-1 rounded-full bg-red-500/15 px-2 py-0.5 text-[11px] font-semibold text-red-300 ring-1 ring-red-500/30" data-testid={`absence-${a.id}-frequent`}>
            <AlertTriangle className="h-3 w-3" />{" "}{tr("Absences fréquentes")}</span>
        )}
        <span className="ml-auto font-mono text-xs">{tr("{0} → {1} · {2} j", [fr(a.start), fr(a.end), a.days])}</span>
      </div>
      <p className="text-xs text-muted-foreground">{tr("Motif :")}{" "}<span className="text-foreground">{a.reason}</span>
        {a.decided_by && a.status !== "en_attente" && (a.auto ? tr(" · acceptée automatiquement (7 jours ou moins)") : tr(" · traitée par {0}", [a.decided_by]))}
        {a.comment && tr(" · réponse : {0}", [a.comment])}
      </p>
      {a.can_decide && !form && (
        <div className="flex flex-wrap gap-1.5">
          {a.status === "en_attente" ? (
            <>
              <Button size="xs" onClick={() => m.mutate({ decision: "accept" })} disabled={m.isPending} data-testid={`absence-${a.id}-accept`}>{tr("Accepter")}</Button>
              <Button size="xs" variant="outline" onClick={() => setForm("refuse")} data-testid={`absence-${a.id}-refuse`}>{tr("Refuser…")}</Button>
            </>
          ) : (
            a.days > 1 && <Button size="xs" variant="outline" onClick={() => setForm("shorten")} data-testid={`absence-${a.id}-shorten`}>{tr("Raccourcir…")}</Button>
          )}
        </div>
      )}
      {form && (
        <div className="flex flex-wrap items-end gap-2 rounded border border-border bg-background/40 p-2 text-xs">
          {form === "shorten" && (
            <label className="space-y-1">
              <span className="block text-muted-foreground">{tr("Nouveau dernier jour")}</span>
              <input type="date" value={newEnd} min={a.start} max={plus(a.end, -1)} onChange={(e) => setNewEnd(e.target.value)}
                className="rounded border border-border bg-background px-2 py-1 font-mono" />
            </label>
          )}
          <label className="min-w-48 flex-1 space-y-1">
            <span className="block text-muted-foreground">{tr("Explication pour le membre (obligatoire)")}</span>
            <input autoFocus value={comment} onChange={(e) => setComment(e.target.value)} maxLength={300}
              className="w-full rounded border border-border bg-background px-2 py-1" data-testid={`absence-${a.id}-comment`} />
          </label>
          <Button size="xs" variant="destructive" disabled={m.isPending || comment.trim().length < 3}
            onClick={() => m.mutate({ decision: form, comment: comment.trim(), ...(form === "shorten" ? { end: newEnd } : {}) })}
            data-testid={`absence-${a.id}-confirm`}>
            {form === "refuse" ? tr("Refuser l'absence") : tr("Raccourcir")}
          </Button>
          <Button size="xs" variant="ghost" onClick={() => setForm(null)}>{tr("Fermer")}</Button>
        </div>
      )}
    </li>
  );
}

/** Suivi des membres: absences to validate, current / upcoming ones, and the history. */
export function LeadAbsences({ kind }: { kind: "pilote" | "atc" }) {
  const [scope, setScope] = useState<"a_traiter" | "en_cours" | "historique">("a_traiter");
  const q = useQuery<Absence[]>({
    queryKey: ["absences", kind, scope],
    queryFn: () => apiGet<Absence[]>(`/absences?kind=${kind}&scope=${scope}`),
    refetchInterval: 60_000,
  });
  const pending = useQuery<Absence[]>({
    queryKey: ["absences", kind, "a_traiter"],
    queryFn: () => apiGet<Absence[]>(`/absences?kind=${kind}&scope=a_traiter`),
    refetchInterval: 60_000,
  });
  const tabs = [
    ["a_traiter", tr("À valider ({0})", [pending.data?.length ?? 0])],
    ["en_cours", tr("En cours et à venir")],
    ["historique", "Historique"],
  ] as const;
  return (
    <div className="space-y-3 rounded-xl border border-border bg-card/60 p-4" data-testid={`lead-absences-${kind}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-sm font-semibold"><Palmtree className="h-4 w-4 text-[#4AA8F0]" />{" "}{tr("Absences")}</p>
        <div className="flex flex-wrap gap-1">
          {tabs.map(([k, label]) => (
            <button key={k} onClick={() => setScope(k)} data-testid={`absences-${kind}-${k}`}
              className={cn("rounded-full border px-3 py-1 text-xs font-semibold",
                scope === k ? "border-[#4AA8F0] bg-[#2B63C9]/25 text-white" : "border-border text-muted-foreground hover:text-foreground")}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground">{tr("7 jours ou moins : acceptée automatiquement. Plus de 7 jours : à valider ici. Alerte si un membre s'absente souvent (3 absences ou 30 jours sur 90 jours).")}</p>
      {q.data?.length === 0 && <p className="text-xs text-muted-foreground">{tr("Rien ici.")}</p>}
      <ul className="space-y-2">
        {q.data?.map((a) => <LeadRow key={a.id} a={a} />)}
      </ul>
    </div>
  );
}
