import { useEffect, useState } from "react";
import { Link, Navigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Settings2 } from "lucide-react";
import AppShell from "@/components/AppShell";
import { PreopeningItem, usePreopenings } from "@/components/AtcPositionPanel";
import { LeadAbsences } from "@/components/Absences";
import ConfirmButton from "@/components/ConfirmButton";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { apiGet, apiPost, apiPut } from "@/lib/api";
import { errMsg } from "@/lib/hooks";
import type { ActivitySettings, FlightEvent, InactivityStatus, MemberActivity, User } from "@/lib/types";
import { ROLE_LABELS, fmtDateTime } from "@/lib/phases";
import { cn } from "@/lib/utils";

import { labels, locale, tr, trServer } from "@/lib/i18n";
type Kind = "pilote" | "atc";
const KIND_FR: Record<Kind, string> = labels({ pilote: "Pilote", atc: "ATC" });
const STATE: Record<InactivityStatus["state"], [string, string]> = {
  actif: ["Actif", "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30"],
  bientot: ["Bientôt inactif", "bg-amber-500/15 text-amber-300 ring-amber-500/30"],
  suspendu: ["Suspendu", "bg-red-500/15 text-red-300 ring-red-500/30"],
  dispense: ["Dispensé", "bg-sky-500/15 text-sky-300 ring-sky-500/30"],
  non_concerne: ["Non concerné", "bg-secondary text-muted-foreground ring-border"],
};
const FILTERS = [
  ["tous", "Tous"],
  ["demandes", "Demandes"],
  ["suspendu", "Suspendus"],
  ["bientot", "Bientôt inactifs"],
  ["dispense", "Dispensés"],
  ["actif", "Actifs"],
] as const;
type Filter = (typeof FILTERS)[number][0];

const day = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(locale(), { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" }) : "—";

function ago(st: InactivityStatus) {
  if (!st.last_activity) return "jamais";
  const d = st.days_inactive ?? 0;
  return d === 0 ? "aujourd'hui" : d === 1 ? "hier" : `il y a ${d} j`;
}

/** Inactivity rule of one side: on/off, delay, warning. Editable by the responsable of that side and the admins. */
function RuleCard({ kind, s }: { kind: Kind; s: ActivitySettings }) {
  const qc = useQueryClient();
  const rule = s[kind];
  const [edit, setEdit] = useState(false);
  const [v, setV] = useState({ enabled: rule.enabled, days: rule.days, warn_days: rule.warn_days });
  useEffect(() => setV({ enabled: rule.enabled, days: rule.days, warn_days: rule.warn_days }), [rule.enabled, rule.days, rule.warn_days]);
  const save = useMutation({
    mutationFn: () => apiPut<ActivitySettings>(`/activity/settings/${kind}`, v),
    onSuccess: (d) => {
      qc.setQueryData(["activity-settings"], d);
      qc.invalidateQueries({ queryKey: ["activity-members"] });
      toast.success(tr("Règle d'inactivité enregistrée"));
      setEdit(false);
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  return (
    <div className="rounded-xl border border-border bg-card p-4 text-sm" data-testid={`rule-${kind}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-semibold">{tr("Règle d'inactivité {0}", [KIND_FR[kind]])}</p>
          {rule.enabled ? (
            <p className="text-muted-foreground">
              {kind === "pilote"
                ? tr("Accès Pilote suspendu après {0} jours sans vol.", [rule.days])
                : tr("Accès ATC suspendu après {0} jours sans ouverture de position ATC.", [rule.days])}{" "}
              {tr("Le membre est prévenu {0} jours avant (bandeau sur le site + message Discord).", [rule.warn_days])}
            </p>
          ) : (
            <p className="text-amber-300">{tr("Règle désactivée : personne n'est suspendu automatiquement.")}</p>
          )}
          <p className="mt-1 text-[11px] text-muted-foreground">{tr("Comptée à partir du {0}", [day(s.since)])}{rule.by ? tr(" · modifiée par {0}", [rule.by]) : ""}
          </p>
        </div>
        {!edit && (
          <Button size="sm" variant="outline" onClick={() => setEdit(true)} data-testid={`rule-${kind}-edit`}>
            <Settings2 className="h-3.5 w-3.5" />{" "}{tr("Modifier")}</Button>
        )}
      </div>
      {edit && (
        <div className="mt-3 flex flex-wrap items-end gap-3 border-t border-border pt-3">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={v.enabled} onChange={(e) => setV({ ...v, enabled: e.target.checked })} data-testid={`rule-${kind}-enabled`} />{tr("Règle active")}</label>
          <label className="space-y-1">
            <span className="block text-[11px] text-muted-foreground">{tr("Suspension après (7 à 30 jours)")}</span>
            <input type="number" min={7} max={30} value={v.days} onChange={(e) => setV({ ...v, days: +e.target.value })}
              className="w-24 rounded border border-border bg-background px-2 py-1 font-mono" data-testid={`rule-${kind}-days`} />
          </label>
          <label className="space-y-1">
            <span className="block text-[11px] text-muted-foreground">{tr("Alerte (jours avant)")}</span>
            <input type="number" min={0} max={30} value={v.warn_days} onChange={(e) => setV({ ...v, warn_days: +e.target.value })}
              className="w-24 rounded border border-border bg-background px-2 py-1 font-mono" data-testid={`rule-${kind}-warn`} />
          </label>
          <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending} data-testid={`rule-${kind}-save`}>{tr("Enregistrer")}</Button>
          <Button size="sm" variant="ghost" onClick={() => setEdit(false)}>{tr("Annuler")}</Button>
        </div>
      )}
    </div>
  );
}

function MemberCard({ kind, m }: { kind: Kind; m: MemberActivity }) {
  const qc = useQueryClient();
  const [exempt, setExempt] = useState(false);
  const [days, setDays] = useState(30);
  const [reason, setReason] = useState("");
  const act = useMutation({
    mutationFn: (b: { action: string; days?: number; reason?: string }) => apiPost<MemberActivity>(`/activity/members/${m.id}/${kind}`, b),
    onSuccess: (_d, b) => {
      const done: Record<string, string> = {
        reactivate: "Accès réactivé", exempt: "Dispense enregistrée", end_exempt: "Dispense levée",
        suspend: "Accès suspendu", refuse_request: "Demande refusée",
      };
      toast.success(`${tr(done[b.action])} : ${m.display_name}`);
      setExempt(false);
      setReason("");
      qc.invalidateQueries({ queryKey: ["activity-members"] });
      qc.invalidateQueries({ queryKey: ["activity-summary"] });
      qc.invalidateQueries({ queryKey: ["activity-journal"] });
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  const st = m.status;
  const [label0, cls] = STATE[st.state];
  const label = tr(label0);
  const managed = st.state !== "non_concerne";
  return (
    <li className={cn("rounded-lg border bg-card p-3 text-sm", st.request_at ? "border-amber-500/50" : "border-border")} data-testid={`member-${m.id}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Link to={`/pilotes/${m.id}`} className="flex min-w-0 items-center gap-2 font-semibold hover:text-[color:var(--sc-accent)]">
          {m.avatar_url ? <img src={m.avatar_url} alt="" className="h-7 w-7 shrink-0 rounded-full" /> : (
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-secondary text-xs">{m.display_name.slice(0, 1).toUpperCase()}</span>
          )}
          <span className="truncate">{m.display_name}</span>
        </Link>
        {m.badges.map((b) => (
          <span key={b} className="rounded bg-[color:var(--sc-primary)]/20 px-1.5 py-0.5 text-[10px] text-[color:var(--sc-accent-soft)]">{b}</span>
        ))}
        <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1", cls)} data-testid={`member-${m.id}-state`}>{label}</span>
        <span className="ml-auto text-xs text-muted-foreground">{tr("Dernière activité :")}{" "}<b className="text-foreground">{ago(st)}</b>
          {" · "}
          {kind === "pilote" ? tr("{0} vol(s) sur 30 j · {1} au total", [m.flights_30d, m.flights_total]) : tr("{0} h de contrôle", [m.atc_hours])}
        </span>
      </div>
      {managed && (
        <p className="mt-1 text-xs text-muted-foreground">
          {st.state === "suspendu" && trServer(st.reason ?? "")}
          {st.state === "bientot" && st.deadline && tr("Sera suspendu le {0} sans activité.", [day(st.deadline)])}
          {st.state === "actif" && st.deadline && tr("Échéance : {0}.", [day(st.deadline)])}
          {st.state === "dispense" && tr("Dispensé jusqu'au {0}{1}.", [day(st.exempt_until), m.exempt_reason ? ` (${m.exempt_reason})` : ""])}
        </p>
      )}
      {st.request_at && (
        <div className="mt-2 rounded border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-100" data-testid={`member-${m.id}-request`}>{tr("Demande de réactivation le {0}{1}", [day(st.request_at), m.request_message ? ` : « ${m.request_message} »` : ""])}
        </div>
      )}
      {managed && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {(st.state === "suspendu" || st.state === "bientot") && (
            <Button size="xs" onClick={() => act.mutate({ action: "reactivate" })} disabled={act.isPending} data-testid={`member-${m.id}-reactivate`}>
              {st.state === "suspendu" ? tr("Réactiver") : tr("Remettre le compteur à zéro")}
            </Button>
          )}
          {st.request_at && (
            <Button size="xs" variant="outline" onClick={() => act.mutate({ action: "refuse_request" })} disabled={act.isPending} data-testid={`member-${m.id}-refuse`}>{tr("Refuser la demande")}</Button>
          )}
          {st.state === "dispense" ? (
            <Button size="xs" variant="outline" onClick={() => act.mutate({ action: "end_exempt" })} disabled={act.isPending}>{tr("Lever la dispense")}</Button>
          ) : (
            <Button size="xs" variant="outline" onClick={() => setExempt((x) => !x)} data-testid={`member-${m.id}-exempt`}>{tr("Dispenser…")}</Button>
          )}
          {st.state !== "suspendu" && (
            <ConfirmButton size="xs" label={tr("Suspendre")} confirmLabel={tr("Oui, suspendre")} testId={`member-${m.id}-suspend`}
              onConfirm={() => act.mutate({ action: "suspend", reason: reason.trim() || undefined })} />
          )}
        </div>
      )}
      {exempt && (
        <div className="mt-2 flex flex-wrap items-end gap-2 rounded border border-border bg-background/40 p-2 text-xs">
          <label className="space-y-1">
            <span className="block text-muted-foreground">{tr("Durée (jours)")}</span>
            <input type="number" min={1} max={365} value={days} onChange={(e) => setDays(+e.target.value)}
              className="w-20 rounded border border-border bg-background px-2 py-1 font-mono" data-testid={`member-${m.id}-exempt-days`} />
          </label>
          <label className="min-w-40 flex-1 space-y-1">
            <span className="block text-muted-foreground">{tr("Motif (obligatoire)")}</span>
            <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} placeholder={tr("Vacances, examens…")}
              className="w-full rounded border border-border bg-background px-2 py-1" />
          </label>
          <Button size="xs" onClick={() => act.mutate({ action: "exempt", days, reason: reason.trim() })} disabled={act.isPending || reason.trim().length < 3}
            data-testid={`member-${m.id}-exempt-save`}>{tr("Dispenser")}</Button>
        </div>
      )}
    </li>
  );
}

/** Who decided what and when on this side (also in the administrators' journal). */
function History({ kind }: { kind: Kind }) {
  const [open, setOpen] = useState(false);
  const q = useQuery<FlightEvent[]>({
    queryKey: ["activity-journal", kind],
    queryFn: () => apiGet<FlightEvent[]>(`/activity/journal?kind=${kind}&limit=300`),
    enabled: open,
    refetchInterval: open ? 30_000 : false,
  });
  return (
    <div className="rounded-xl border border-border bg-card p-4 text-sm" data-testid={`journal-${kind}`}>
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-between font-semibold" data-testid={`journal-${kind}-toggle`}>{tr("Historique des décisions")}<span className="text-xs font-normal text-muted-foreground">{open ? tr("Masquer") : tr("Afficher")}</span>
      </button>
      {open && (
        <ol className="mt-3 space-y-1 text-xs">
          {q.data?.length === 0 && <li className="text-muted-foreground">{tr("Rien pour le moment.")}</li>}
          {q.data?.map((e) => (
            <li key={e.id} className="flex flex-wrap gap-x-3 gap-y-0.5 border-b border-border/40 py-1.5">
              <span className="w-32 shrink-0 font-mono text-muted-foreground">{fmtDateTime(e.at)}</span>
              <span className="min-w-0 flex-1">
                <b>{e.label}</b>
                {e.details && <span className="text-muted-foreground"> — {e.details}</span>}
              </span>
              <span className="text-muted-foreground">{tr("par {0} ({1})", [e.actor_name, ROLE_LABELS[e.actor_role] ?? e.actor_role])}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** Pending requests to cancel a pre-opening (Responsable ATC / administrators). */
function CancelRequests({ user }: { user: User }) {
  const q = usePreopenings();
  const rows = (q.data ?? []).filter((p) => p.can_decide);
  if (rows.length === 0) return null;
  return (
    <div className="rounded-xl border border-amber-500/40 bg-card p-4 text-sm" data-testid="preopening-requests">
      <p className="mb-2 font-semibold">{tr("Demandes d'annulation de pré-ouverture ({0})", [rows.length])}</p>
      <ul className="space-y-1.5">
        {rows.map((p) => <PreopeningItem key={p.id} p={p} user={user} showReason />)}
      </ul>
    </div>
  );
}

function Side({ kind, s, user }: { kind: Kind; s: ActivitySettings; user: User }) {
  const [filter, setFilter] = useState<Filter>("tous");
  const q = useQuery<MemberActivity[]>({
    queryKey: ["activity-members", kind],
    queryFn: () => apiGet<MemberActivity[]>(`/activity/members?kind=${kind}`),
    refetchInterval: 60_000,
  });
  const rows = q.data ?? [];
  const count = (f: Filter) =>
    f === "tous" ? rows.length : f === "demandes" ? rows.filter((r) => r.status.request_at).length : rows.filter((r) => r.status.state === f).length;
  const shown = rows.filter((r) =>
    filter === "tous" ? true : filter === "demandes" ? !!r.status.request_at : r.status.state === filter,
  );
  return (
    <div className="space-y-4">
      {kind === "atc" && <CancelRequests user={user} />}
      <LeadAbsences kind={kind} />
      <RuleCard kind={kind} s={s} />
      <div className="flex flex-wrap gap-1.5">
        {FILTERS.map(([f, label]) => (
          <button key={f} onClick={() => setFilter(f)} data-testid={`filter-${kind}-${f}`}
            className={cn("rounded-full border px-3 py-1 text-xs font-semibold transition-colors",
              filter === f ? "border-[color:var(--sc-accent)] bg-[color:var(--sc-primary)]/25 text-white" : "border-border text-muted-foreground hover:text-foreground")}>
            {tr(label)} <span className="font-mono opacity-70">{count(f)}</span>
          </button>
        ))}
      </div>
      {q.isLoading && <p className="text-sm text-muted-foreground">{tr("Chargement…")}</p>}
      {q.data && shown.length === 0 && <p className="text-sm text-muted-foreground" data-testid={`members-${kind}-empty`}>{tr("Personne dans cette catégorie.")}</p>}
      <ul className="space-y-2">
        {shown.map((m) => <MemberCard key={m.id} kind={kind} m={m} />)}
      </ul>
      <History kind={kind} />
    </div>
  );
}

function View({ user }: { user: User }) {
  const s = useQuery<ActivitySettings>({ queryKey: ["activity-settings"], queryFn: () => apiGet<ActivitySettings>("/activity/settings") });
  const kinds = (["pilote", "atc"] as const).filter((k) => (k === "pilote" ? user.access.pilot_lead : user.access.atc_lead) || user.access.admin);
  const [params, setParams] = useSearchParams(); // ?tab=atc: direct links sent by the Discord bot
  if (kinds.length === 0) return <Navigate to="/" replace />;
  const wanted = params.get("tab");
  const tab = kinds.find((k) => k === wanted) ?? kinds[0];
  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4 sm:p-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{tr("Suivi des membres")}</h1>
        <p className="text-sm text-muted-foreground">{tr("Activité de chaque membre sur le réseau. Un pilote est actif quand il vole ; un contrôleur quand il ouvre une position. Sans activité pendant le délai choisi, l'accès est suspendu jusqu'à ce qu'un responsable le réactive.")}</p>
      </div>
      {s.isError && <p className="text-sm text-red-400">{errMsg(s.error)}</p>}
      {s.data && (
        <Tabs value={tab} onValueChange={(v) => setParams({ tab: v }, { replace: true })}>
          {kinds.length > 1 && (
            <TabsList>
              {kinds.map((k) => (
                <TabsTrigger key={k} value={k} data-testid={`suivi-tab-${k}`}>{k === "pilote" ? tr("Pilotes") : "ATC"}</TabsTrigger>
              ))}
            </TabsList>
          )}
          {kinds.map((k) => (
            <TabsContent key={k} value={k} className="pt-3">
              <Side kind={k} s={s.data} user={user} />
            </TabsContent>
          ))}
        </Tabs>
      )}
    </div>
  );
}

export default function Suivi() {
  return <AppShell>{(user) => <View user={user} />}</AppShell>;
}
