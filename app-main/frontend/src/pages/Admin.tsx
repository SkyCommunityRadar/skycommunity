import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import AppShell from "@/components/AppShell";
import { ReviewModeration } from "@/components/Reviews";
import NativeSelect from "@/components/NativeSelect";
import ConfirmButton from "@/components/ConfirmButton";
import { PhaseBadge } from "@/components/Badges";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { apiDelete, apiGet, apiPatch, apiPost, apiPut } from "@/lib/api";
import { errMsg, useFlights } from "@/lib/hooks";
import { PHASE_LABELS, ROLE_LABELS, fmtDateTime } from "@/lib/phases";
import type { FlightDetail, FlightEvent, FlightSummary, User } from "@/lib/types";

import { tr } from "@/lib/i18n";
import { THEMES, useSiteTheme, type SiteTheme } from "@/lib/theme";
type UserPatch = { disabled?: boolean; ban_hours?: number; ban_reason?: string };

function blockedLabel(u: User): string | null {
  if (u.disabled) return tr("Bloqué définitivement");
  if (u.banned_until && new Date(u.banned_until) > new Date()) return tr("Suspendu jusqu'au {0}", [fmtDateTime(u.banned_until)]);
  return null;
}

function RoleBadges({ u }: { u: User }) {
  const a = u.access;
  const roles: [boolean, string, string][] = [
    [a.creator, "Créateur", "bg-amber-400/15 text-amber-300"],
    [a.admin && !a.creator, "Administrateur", "bg-[#2B63C9]/20 text-[#7CC0F5]"],
    [a.atc_lead, "Responsable ATC", "bg-violet-500/15 text-violet-300"],
    [a.atc && !a.atc_lead, "ATC", "bg-emerald-500/15 text-emerald-300"],
    [a.pilote, "Pilote", "bg-sky-500/15 text-sky-300"],
  ];
  const shown = roles.filter(([on]) => on);
  if (!shown.length) return <span className="text-muted-foreground">{tr("Aucun rôle (pas d'accès)")}</span>;
  return (
    <div className="flex flex-wrap gap-1" data-testid={`admin-roles-${u.id}`}>
      {shown.map(([, label, cls]) => (
        <span key={tr(label)} className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${cls}`}>{tr(label)}</span>
      ))}
    </div>
  );
}

type BulkResult = { deleted: number; skipped: string[] };

/** Selection of rows (checkboxes) + one button to delete them all, confirmed inside the page. */
function useSelection() {
  const [sel, setSel] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setSel((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const setAll = (ids: string[], on: boolean) => setSel(on ? new Set(ids) : new Set());
  const remove = (ids: string[]) => setSel((s) => new Set([...s].filter((id) => !ids.includes(id))));
  return { sel, toggle, setAll, remove, clear: () => setSel(new Set()) };
}

function BulkBar({ count, what, onDelete, pending, onClear, testId }: { count: number; what: string; onDelete: () => void; pending: boolean; onClear: () => void; testId: string }) {
  if (count === 0) return null;
  return (
    <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-lg border border-red-500/40 bg-[#1a0f16]/95 p-2 text-sm backdrop-blur" data-testid={testId}>
      <span className="font-semibold">{tr(count > 1 ? "{0} {1} sélectionnés" : "{0} {1} sélectionné", [count, what])}</span>
      <ConfirmButton
        label={tr("Supprimer la sélection ({0})", [count])}
        confirmLabel={tr("Oui, supprimer {0} {1}{2}", [count, what, count > 1 ? "s" : ""])}
        onConfirm={onDelete}
        disabled={pending}
        testId={`${testId}-delete`}
      />
      <Button size="sm" variant="ghost" onClick={onClear}>{tr("Tout désélectionner")}</Button>
    </div>
  );
}

const box = "h-4 w-4 cursor-pointer accent-[#4AA8F0]";

function Users({ me }: { me: User }) {
  const qc = useQueryClient();
  const q = useQuery<User[]>({ queryKey: ["admin-users"], queryFn: () => apiGet<User[]>("/admin/users"), refetchInterval: 10000 });
  const m = useMutation<User, unknown, { id: string; body: UserPatch; ok: string }>({
    mutationFn: ({ id, body }) => apiPatch<User>(`/admin/users/${id}`, body),
    onSuccess: (_u, v) => toast.success(v.ok),
    onError: (e) => toast.error(errMsg(e)),
    onSettled: () => qc.invalidateQueries({ queryKey: ["admin-users"] }),
  });
  const [reason, setReason] = useState<Record<string, string>>({});
  const list = q.data ?? [];
  const sync = useMutation<User, unknown, User>({
    mutationFn: (u) => apiPost<User>(`/admin/users/${u.id}/sync`),
    onSuccess: (u) => toast.success(tr("Rôles Discord de {0} synchronisés", [u.display_name])),
    onError: (e) => toast.error(errMsg(e)),
    onSettled: () => qc.invalidateQueries({ queryKey: ["admin-users"] }),
  });
  const act = (u: User, body: UserPatch, ok: string) => m.mutate({ id: u.id, body, ok });
  const s = useSelection();
  const del = useMutation<BulkResult, unknown, string[]>({
    mutationFn: (ids) => apiPost<BulkResult>("/admin/users/delete", { ids }),
    onSuccess: (r, ids) => {
      toast.success(tr("{0} profil(s) supprimé(s)", [r.deleted]));
      r.skipped.forEach((x) => toast.info(x));
      s.remove(ids);
    },
    onError: (e) => toast.error(errMsg(e)),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["admin-users"] });
      qc.invalidateQueries({ queryKey: ["flights"] });
    },
  });
  // The Créateur can never be sanctioned or deleted; only the Créateur can act on an administrator.
  const isProtected = (u: User) => u.id === me.id || u.access.creator || (u.access.admin && !me.access.creator);
  const deletable = list.filter((u) => !isProtected(u)).map((u) => u.id);

  return (
    <div className="space-y-6">
      <p className="text-xs text-muted-foreground" data-testid="admin-roles-note">{tr("Les accès suivent les rôles du serveur Discord (Pilote, ATC, Responsable ATC, Administrateur). Ils sont relus à chaque connexion et toutes les 5 minutes : pour donner ou retirer un accès, modifiez le rôle sur Discord.")}</p>
      <BulkBar count={s.sel.size} what={tr("profil")} pending={del.isPending} onDelete={() => del.mutate([...s.sel])} onClear={s.clear} testId="admin-users-bulk" />
      <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-xs" data-testid="admin-users-table">
        <thead className="text-left text-[10px] uppercase tracking-wider text-muted-foreground">
          <tr className="border-b border-border">
            <th className="w-7 py-2">
              <input
                type="checkbox"
                className={box}
                checked={deletable.length > 0 && deletable.every((id) => s.sel.has(id))}
                onChange={(e) => s.setAll(deletable, e.target.checked)}
                title={tr("Tout sélectionner")}
                data-testid="admin-users-select-all"
              />
            </th>
            <th className="py-2 font-normal">{tr("Membre")}</th>
            <th className="font-normal">{tr("Rôles Discord")}</th>
            <th className="font-normal">{tr("Statut sur le réseau")}</th>
            <th className="font-normal">{tr("Sanction")}</th>
          </tr>
        </thead>
        <tbody>
          {list.map((u) => {
            const blocked = blockedLabel(u);
            const protectedUser = isProtected(u);
            return (
              <tr key={u.id} className={`border-b border-border/50 align-top ${s.sel.has(u.id) ? "bg-red-500/5" : ""}`} data-testid={`admin-user-row-${u.id}`}>
                <td className="py-2.5">
                  {!protectedUser && (
                    <input type="checkbox" className={box} checked={s.sel.has(u.id)} onChange={() => s.toggle(u.id)} data-testid={`admin-user-select-${u.id}`} />
                  )}
                </td>
                <td className="py-2">
                  <div className="font-medium">{u.display_name}</div>
                  <div className="font-mono text-muted-foreground">{u.discord_id ? tr("Discord #{0}", [u.discord_id]) : (u.email ?? "")}</div>
                  <div className="text-[10px] text-muted-foreground">{tr("inscrit le {0}", [fmtDateTime(u.created_at)])}</div>
                </td>
                <td className="py-2">
                  <RoleBadges u={u} />
                  {u.roles_synced_at && <div className="mt-1 text-[10px] text-muted-foreground">{tr("relus le {0}", [fmtDateTime(u.roles_synced_at)])}</div>}
                  {u.discord_id && (
                    <Button size="xs" variant="outline" className="mt-1" disabled={sync.isPending} onClick={() => sync.mutate(u)} data-testid={`admin-sync-${u.id}`}>{tr("Resynchroniser")}</Button>
                  )}
                </td>
                <td className="py-2">
                  <span className={blocked ? "text-red-400" : "text-emerald-400"} data-testid={`admin-user-status-${u.id}`}>
                    {blocked ?? tr("Actif")}
                  </span>
                  {blocked && u.ban_reason && <div className="text-[10px] text-muted-foreground">{tr("Motif : {0}", [u.ban_reason])}</div>}
                </td>
                <td className="py-2">
                  {!protectedUser && (
                    <div className="space-y-1.5">
                      <Input
                        value={reason[u.id] ?? ""}
                        onChange={(e) => setReason({ ...reason, [u.id]: e.target.value })}
                        placeholder={tr("Motif (facultatif)")}
                        className="h-7 w-52 text-[11px]"
                        data-testid={`admin-ban-reason-${u.id}`}
                      />
                      <div className="flex flex-wrap gap-1">
                        {[
                          [24, "24 h"],
                          [168, "7 jours"],
                          [720, "30 jours"],
                        ].map(([h, l]) => (
                          <Button
                            key={h}
                            size="xs"
                            variant="outline"
                            onClick={() => act(u, { ban_hours: h as number, ban_reason: reason[u.id] ?? "" }, tr("Suspendu {0}", [l]))}
                            data-testid={`admin-ban-${h}-${u.id}`}
                          >
                            {l}
                          </Button>
                        ))}
                        <ConfirmButton
                          size="xs"
                          label={tr("Définitif")}
                          confirmLabel={tr("Bloquer {0}", [u.display_name])}
                          onConfirm={() => act(u, { disabled: true, ban_reason: reason[u.id] ?? "" }, tr("Bloqué définitivement"))}
                          testId={`admin-block-${u.id}`}
                        />
                        {blocked && (
                          <Button size="xs" onClick={() => act(u, { disabled: false, ban_hours: 0 }, tr("Membre débloqué"))} data-testid={`admin-unblock-${u.id}`}>{tr("Débloquer")}</Button>
                        )}
                      </div>
                      <ConfirmButton
                        size="xs"
                        label={tr("Supprimer le profil")}
                        confirmLabel={tr("Supprimer {0} et ses vols", [u.display_name])}
                        disabled={del.isPending}
                        onConfirm={() => del.mutate([u.id])}
                        testId={`admin-delete-user-${u.id}`}
                      />
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>
    </div>
  );
}

function FlightRow({ f, selected, onToggle, onDelete, deleting }: { f: FlightSummary; selected: boolean; onToggle: () => void; onDelete: () => void; deleting: boolean }) {
  const qc = useQueryClient();
  const [phase, setPhase] = useState(f.phase);
  const [reason, setReason] = useState("");
  const done = () => {
    qc.invalidateQueries({ queryKey: ["flights"] });
    qc.invalidateQueries({ queryKey: ["flight", f.id] });
  };
  const force = useMutation<FlightDetail, unknown, void>({
    mutationFn: () => apiPost<FlightDetail>(`/flights/${f.id}/force`, { phase, reason, version: f.version }),
    onSuccess: () => {
      setReason("");
      toast.success(tr("Statut forcé"));
    },
    onError: (e) => toast.error(errMsg(e)),
    onSettled: done,
  });
  return (
    <tr className={`border-b border-border/50 ${selected ? "bg-red-500/5" : ""}`} data-testid={`admin-flight-row-${f.callsign}`}>
      <td className="py-2">
        <input type="checkbox" className={box} checked={selected} onChange={onToggle} data-testid={`admin-flight-select-${f.callsign}`} />
      </td>
      <td className="py-2 font-mono font-semibold">
        {f.callsign}
        <div className="font-sans text-[10px] font-normal text-muted-foreground">{f.pilot_name} · {f.departure} → {f.arrival}</div>
      </td>
      <td>
        <PhaseBadge phase={f.phase} />
      </td>
      <td>
        <div className="flex gap-1.5">
          <NativeSelect value={phase} onChange={(e) => setPhase(e.target.value)} data-testid={`admin-force-phase-${f.callsign}`}>
            {Object.entries(PHASE_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </NativeSelect>
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={tr("Motif (obligatoire)")}
            className="h-8 w-48 text-xs"
            data-testid={`admin-force-reason-${f.callsign}`}
          />
          <Button size="sm" variant="secondary" disabled={reason.trim().length < 3 || force.isPending} onClick={() => force.mutate()} data-testid={`admin-force-button-${f.callsign}`}>{tr("Forcer")}</Button>
        </div>
      </td>
      <td>
        <ConfirmButton label={tr("Supprimer")} confirmLabel={tr("Supprimer {0}", [f.callsign])} onConfirm={onDelete} disabled={deleting} testId={`admin-delete-${f.callsign}`} />
      </td>
    </tr>
  );
}

function Flights() {
  const q = useFlights("all");
  const qc = useQueryClient();
  const s = useSelection();
  const flights = q.data?.flights ?? [];
  const del = useMutation<BulkResult, unknown, string[]>({
    mutationFn: (ids) => apiPost<BulkResult>("/admin/flights/delete", { ids }),
    onSuccess: (r, ids) => {
      toast.success(r.deleted > 1 ? tr("{0} vols supprimés", [r.deleted]) : tr("Vol supprimé"));
      s.remove(ids);
    },
    onError: (e) => toast.error(errMsg(e)),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["flights"] });
      qc.invalidateQueries({ queryKey: ["flight"] });
    },
  });
  return (
    <div className="space-y-2">
    <BulkBar count={s.sel.size} what={tr("vol")} pending={del.isPending} onDelete={() => del.mutate([...s.sel])} onClear={s.clear} testId="admin-flights-bulk" />
    <div className="overflow-x-auto">
    <table className="w-full min-w-[640px] text-xs" data-testid="admin-flights-table">
      <thead className="text-left text-[10px] uppercase tracking-wider text-muted-foreground">
        <tr className="border-b border-border">
          <th className="w-7 py-2">
            <input
              type="checkbox"
              className={box}
              checked={flights.length > 0 && flights.every((f) => s.sel.has(f.id))}
              onChange={(e) => s.setAll(flights.map((f) => f.id), e.target.checked)}
              title={tr("Tout sélectionner")}
              data-testid="admin-flights-select-all"
            />
          </th>
          <th className="py-2 font-normal">{tr("Indicatif")}</th>
          <th className="font-normal">{tr("Statut")}</th>
          <th className="font-normal">{tr("Forcer un statut (journalisé)")}</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {flights.map((f) => (
          <FlightRow
            key={`${f.id}-${f.version}`}
            f={f}
            selected={s.sel.has(f.id)}
            onToggle={() => s.toggle(f.id)}
            onDelete={() => del.mutate([f.id])}
            deleting={del.isPending}
          />
        ))}
      </tbody>
    </table>
    </div>
    {flights.length === 0 && !q.isLoading && <p className="p-4 text-center text-sm text-muted-foreground">{tr("Aucun vol.")}</p>}
    </div>
  );
}

const JOURNAL_TYPES = [
  ["", "Tout"],
  ["activite", "Activité / inactivité"],
  ["atc", "Positions ATC"],
  ["planning", "Planning"],
  ["admin", "Administration"],
  ["avis", "Avis"],
  ["mode", "Connexions"],
  ["compte_cree", "Comptes créés"],
] as const;

function Journal() {
  const [type, setType] = useState("");
  const q = useQuery<FlightEvent[]>({
    queryKey: ["admin-events", type],
    queryFn: () => apiGet<FlightEvent[]>(`/admin/events?limit=300${type ? `&type=${type}` : ""}`),
    refetchInterval: 5000,
  });
  return (
    <div className="space-y-2">
    <div className="flex flex-wrap gap-1.5" data-testid="admin-journal-filters">
      {JOURNAL_TYPES.map(([t, label]) => (
        <button key={t} onClick={() => setType(t)} data-testid={`admin-journal-filter-${t || "tout"}`}
          className={`rounded-full border px-3 py-1 text-xs font-semibold ${type === t ? "border-[#4AA8F0] bg-[#2B63C9]/25 text-white" : "border-border text-muted-foreground hover:text-foreground"}`}>
          {tr(label)}
        </button>
      ))}
    </div>
    <ol className="space-y-1 font-mono text-[11px]" data-testid="admin-journal">
      {(q.data ?? []).map((e) => (
        <li key={e.id} className="flex gap-3 border-b border-border/40 py-1">
          <span className="text-muted-foreground w-36 shrink-0">{fmtDateTime(e.at)}</span>
          <span className="w-20 shrink-0 text-[#4AA8F0]">{e.callsign ?? "—"}</span>
          <span className="flex-1">
            {e.label}
            {e.details && <span className="text-muted-foreground"> — {e.details}</span>}
          </span>
          <span className="text-muted-foreground">
            {e.actor_name} ({ROLE_LABELS[e.actor_role] ?? e.actor_role})
          </span>
        </li>
      ))}
    </ol>
    </div>
  );
}

type SecurityState = { lockdown: boolean; by: string | null; at: string | null; new_account_hours: number };

/** « Mode anti-raid »: one switch for the moment the Discord server is being raided. */
function AntiRaid() {
  const qc = useQueryClient();
  const q = useQuery<SecurityState>({ queryKey: ["admin-security"], queryFn: () => apiGet<SecurityState>("/admin/security") });
  const m = useMutation({
    mutationFn: (lockdown: boolean) => apiPut<SecurityState>("/admin/security", { lockdown }),
    onSuccess: (s) => {
      qc.setQueryData(["admin-security"], s);
      toast.success(s.lockdown ? tr("Mode anti-raid activé") : tr("Mode anti-raid désactivé"));
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  const on = !!q.data?.lockdown;
  return (
    <div
      className={`flex flex-col gap-3 rounded-xl border p-4 sm:flex-row sm:items-center ${on ? "border-red-500/60 bg-red-500/10" : "border-border bg-card"}`}
      data-testid="anti-raid"
    >
      <div className="flex-1 space-y-1 text-sm">
        <p className="font-semibold">{tr("Mode anti-raid")}{" "}{on ? <span className="text-red-300">{tr("· ACTIVÉ")}</span> : <span className="text-muted-foreground">{tr("· désactivé")}</span>}
        </p>
        <p className="text-xs text-muted-foreground">{tr("À activer si le Discord se fait raider : plus aucun nouveau compte ne peut être créé, et les comptes créés il y a moins de {0} h ne peuvent plus rien modifier (lecture seule). Les membres déjà là ne voient aucune différence.", [q.data?.new_account_hours ?? 24])}
          {on && q.data?.by && (q.data.at ? tr(" Activé par {0} le {1}.", [q.data.by, fmtDateTime(q.data.at)]) : tr(" Activé par {0}.", [q.data.by]))}
        </p>
      </div>
      <Button
        variant={on ? "outline" : "destructive"}
        disabled={m.isPending || q.isLoading}
        onClick={() => m.mutate(!on)}
        data-testid="anti-raid-toggle"
      >
        {on ? tr("Désactiver") : tr("Activer le mode anti-raid")}
      </Button>
    </div>
  );
}

type Announcement = { id: string; title: string; body: string; by: string | null; at: string };

/** Créateur only: the seasonal theme of the site and announcements sent to every member's notifications. */
function CreatorPanel() {
  const qc = useQueryClient();
  const theme = useSiteTheme();
  const setTheme = useMutation({
    mutationFn: (t: SiteTheme) => apiPut("/site/theme", { theme: t }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["site-theme"] });
      toast.success(tr("Thème du site changé"));
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  const list = useQuery<Announcement[]>({ queryKey: ["announcements"], queryFn: () => apiGet<Announcement[]>("/site/announcements") });
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [confirm, setConfirm] = useState(false);
  const send = useMutation({
    mutationFn: () => apiPost("/site/announcements", { title: title.trim(), body: body.trim() }),
    onSuccess: () => {
      setTitle("");
      setBody("");
      setConfirm(false);
      qc.invalidateQueries({ queryKey: ["announcements"] });
      qc.invalidateQueries({ queryKey: ["notifications"] });
      toast.success(tr("Annonce envoyée à tous les membres"));
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => apiDelete(`/site/announcements/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["announcements"] });
      qc.invalidateQueries({ queryKey: ["notifications"] });
      toast.success(tr("Annonce retirée"));
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  const current = theme.data?.theme ?? "standard";
  const ready = title.trim().length >= 2 && body.trim().length >= 2;
  return (
    <div className="space-y-4 rounded-xl border border-amber-400/40 bg-amber-400/[0.04] p-4" data-testid="creator-panel">
      <p className="text-sm font-semibold text-amber-200">{tr("Espace Créateur")}</p>
      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{tr("Thème du site")}</p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {THEMES.map((t) => (
            <button
              key={t.id}
              type="button"
              disabled={setTheme.isPending}
              onClick={() => t.id !== current && setTheme.mutate(t.id)}
              className={`rounded-lg border p-3 text-left text-xs transition-colors ${t.id === current ? "border-amber-400 bg-amber-400/15" : "border-border bg-background/40 hover:bg-secondary"}`}
              data-testid={`theme-${t.id}`}
            >
              <span className="block text-lg">{t.emoji}</span>
              <span className="block font-semibold">{tr(t.label)}{t.id === current ? ` · ${tr("actif")}` : ""}</span>
              <span className="block text-muted-foreground">{tr(t.hint)}</span>
            </button>
          ))}
        </div>
        <p className="text-[11px] text-muted-foreground">{tr("Visible par tous les membres, page de connexion comprise, dans les 5 minutes (tout de suite pour qui recharge la page).")}</p>
      </div>
      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{tr("Annonce à tous les membres")}</p>
        <Input value={title} maxLength={80} onChange={(e) => { setTitle(e.target.value); setConfirm(false); }} placeholder={tr("Titre (ex. Soirée ATC samedi 21 h)")} data-testid="announcement-title" />
        <textarea
          value={body}
          maxLength={600}
          onChange={(e) => { setBody(e.target.value); setConfirm(false); }}
          placeholder={tr("Message")}
          rows={3}
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-[#4AA8F0]"
          data-testid="announcement-body"
        />
        {confirm ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-amber-200">{tr("Envoyer cette annonce dans les notifications de tous les membres ?")}</span>
            <Button size="sm" onClick={() => send.mutate()} disabled={send.isPending} data-testid="announcement-confirm">{tr("Oui, envoyer")}</Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>{tr("Annuler")}</Button>
          </div>
        ) : (
          <Button size="sm" disabled={!ready} onClick={() => setConfirm(true)} data-testid="announcement-send">{tr("Envoyer l'annonce")}</Button>
        )}
        {(list.data ?? []).length > 0 && (
          <div className="space-y-1.5 pt-1">
            <p className="text-[11px] text-muted-foreground">{tr("Annonces envoyées (visibles 30 jours dans les notifications)")}</p>
            {(list.data ?? []).slice(0, 10).map((a) => (
              <div key={a.id} className="flex items-start gap-2 rounded-md border border-border bg-background/40 px-2.5 py-1.5 text-xs">
                <div className="min-w-0 flex-1">
                  <p className="font-semibold">{a.title}</p>
                  <p className="text-muted-foreground">{fmtDateTime(a.at)}</p>
                </div>
                <Button size="xs" variant="ghost" disabled={remove.isPending} onClick={() => remove.mutate(a.id)} data-testid="announcement-delete">{tr("Retirer")}</Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function Admin() {
  return (
    <AppShell>
      {(me) =>
        me.role !== "admin" ? (
          <p className="p-6 text-sm text-muted-foreground" data-testid="admin-forbidden">{tr("Accès réservé aux administrateurs.")}</p>
        ) : (
          <div className="p-5 space-y-4 h-full overflow-y-auto">
            <h1 className="text-xl font-semibold tracking-tight">{tr("Administration")}</h1>
            {me.access.creator && <CreatorPanel />}
            <AntiRaid />
            <Tabs defaultValue="users">
              <TabsList>
                <TabsTrigger value="users" data-testid="admin-tab-users">{tr("Utilisateurs")}</TabsTrigger>
                <TabsTrigger value="flights" data-testid="admin-tab-flights">{tr("Vols")}</TabsTrigger>
                <TabsTrigger value="journal" data-testid="admin-tab-journal">{tr("Logs")}</TabsTrigger>
                <TabsTrigger value="reviews" data-testid="admin-tab-reviews">{tr("Avis")}</TabsTrigger>
              </TabsList>
              <TabsContent value="reviews" className="pt-3">
                <ReviewModeration />
              </TabsContent>
              <TabsContent value="users" className="pt-3">
                <Users me={me} />
              </TabsContent>
              <TabsContent value="flights" className="pt-3">
                <Flights />
              </TabsContent>
              <TabsContent value="journal" className="pt-3">
                <Journal />
              </TabsContent>
            </Tabs>
          </div>
        )
      }
    </AppShell>
  );
}
