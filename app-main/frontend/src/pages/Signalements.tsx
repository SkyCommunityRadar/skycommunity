import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import AppShell, { type UiMode } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { apiGet, apiPatch } from "@/lib/api";
import { errMsg } from "@/lib/hooks";
import { fmtDateTime } from "@/lib/phases";
import type { User } from "@/lib/types";
import { cn } from "@/lib/utils";
import { tr } from "@/lib/i18n";

type Report = {
  id: string;
  kind: "pilote" | "atc";
  flight_id: string;
  callsign?: string;
  author_id: string;
  author_name: string;
  target_id: string;
  target_name: string;
  category: string;
  category_label: string;
  comment: string;
  status: "open" | "closed";
  created_at: string;
  closed_at?: string | null;
  closed_by?: string | null;
  close_comment?: string | null;
  can_close: boolean;
};
type Filter = "open" | "closed" | "all";

function CloseForm({ r, onDone }: { r: Report; onDone: () => void }) {
  const qc = useQueryClient();
  const [note, setNote] = useState("");
  const m = useMutation({
    mutationFn: () => apiPatch(`/reports/${r.id}`, { comment: note.trim() }),
    onSuccess: () => {
      toast.success(tr("Signalement clôturé"));
      qc.invalidateQueries({ queryKey: ["reports"] });
      qc.invalidateQueries({ queryKey: ["notifications"] });
      onDone();
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  return (
    <div className="space-y-2 rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-3" data-testid={`report-close-form-${r.id}`}>
      <p className="text-xs font-semibold text-emerald-200">{tr("Clôturer ce signalement ?")}</p>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        maxLength={500}
        rows={2}
        placeholder={tr("Mot de clôture (facultatif) : il sera transmis à {0} et à {1}", [r.target_name, r.author_name])}
        className="w-full rounded-md border border-border bg-background px-2.5 py-2 text-sm outline-none focus:border-[color:var(--sc-accent)]"
        data-testid="report-close-note"
      />
      <div className="flex gap-2">
        <Button size="sm" disabled={m.isPending} onClick={() => m.mutate()} data-testid="report-close-confirm">{tr("Confirmer la clôture")}</Button>
        <Button size="sm" variant="ghost" onClick={onDone}>{tr("Annuler")}</Button>
      </div>
    </div>
  );
}

function ReportCard({ r, me }: { r: Report; me: User }) {
  const [closing, setClosing] = useState(false);
  const open = r.status === "open";
  return (
    <div className="space-y-2 rounded-xl border border-border bg-card p-4 text-sm" data-testid={`report-${r.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold", open ? "bg-amber-500/20 text-amber-200" : "bg-emerald-500/15 text-emerald-300")} data-testid="report-status">
          {open ? tr("Ouvert") : tr("Clôturé")}
        </span>
        <span className="rounded-full bg-secondary px-2 py-0.5 text-[11px] text-muted-foreground">
          {r.kind === "atc" ? tr("Contrôleur signalé") : tr("Pilote signalé")}
        </span>
        <span className="rounded-full bg-[color:var(--sc-primary)]/20 px-2 py-0.5 text-[11px] text-[color:var(--sc-accent-soft)]">{tr(r.category_label)}</span>
        {r.callsign && (
          <Link to={`/flights/${r.flight_id}`} className="ml-auto font-mono text-xs text-[color:var(--sc-accent)] hover:underline">{r.callsign}</Link>
        )}
      </div>
      <p>
        <b>{r.author_name}</b>{" "}<span className="text-muted-foreground">{tr("a signalé")}</span>{" "}<b>{r.target_name}</b>
        {r.author_id === me.id && <span className="text-muted-foreground"> · {tr("vous")}</span>}
        {r.target_id === me.id && <span className="text-amber-200"> · {tr("vous êtes concerné")}</span>}
      </p>
      <p className="whitespace-pre-line">{r.comment || <i className="text-muted-foreground">{tr("Sans commentaire")}</i>}</p>
      <p className="text-xs text-muted-foreground">{tr("Déposé le {0}", [fmtDateTime(r.created_at)])}</p>
      {!open && (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs">
          <p className="text-emerald-200">{tr("Clôturé par {0} le {1}", [r.closed_by ?? "—", r.closed_at ? fmtDateTime(r.closed_at) : "—"])}</p>
          {r.close_comment && <p className="mt-1 whitespace-pre-line text-foreground/90">« {r.close_comment} »</p>}
        </div>
      )}
      {open && r.can_close && (closing ? (
        <CloseForm r={r} onDone={() => setClosing(false)} />
      ) : (
        <Button size="sm" variant="outline" onClick={() => setClosing(true)} data-testid="report-close">{tr("Clôturer")}</Button>
      ))}
    </div>
  );
}

function SignalementsView({ user }: { user: User; mode: UiMode }) {
  const [filter, setFilter] = useState<Filter>("open");
  const q = useQuery<Report[]>({ queryKey: ["reports", filter], queryFn: () => apiGet<Report[]>(`/reports?status=${filter}`) });
  const a = user.access;
  const scope = a.admin
    ? tr("Vous voyez et traitez tous les signalements (administrateur).")
    : a.pilot_lead && a.atc_lead
      ? tr("Vous voyez et traitez tous les signalements (Responsable Pilotes et Responsable ATC).")
      : a.pilot_lead
        ? tr("Vous voyez et traitez tous les signalements visant des pilotes (Responsable Pilotes), en plus des vôtres.")
        : a.atc_lead
          ? tr("Vous voyez et traitez tous les signalements visant des contrôleurs (Responsable ATC), en plus des vôtres.")
          : tr("Vous voyez les signalements que vous avez déposés et ceux qui vous concernent.");
  const FILTERS: [Filter, string][] = [["open", tr("Ouverts")], ["closed", tr("Clôturés")], ["all", tr("Tous")]];
  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4" data-testid="signalements-page">
      <h1 className="text-xl font-semibold">{tr("Signalements")}</h1>
      <p className="text-sm text-muted-foreground">
        {tr("Les contrôleurs peuvent signaler un pilote (HRP, phraséologie, vitesse de roulage…) et les pilotes un contrôleur (non-respect des procédures, phraséologie…), depuis le panneau du vol. Le Responsable Pilotes traite les signalements visant des pilotes, le Responsable ATC ceux visant des contrôleurs.")}
      </p>
      <p className="text-xs text-[color:var(--sc-accent-soft)]" data-testid="reports-scope">{scope}</p>
      <div className="flex gap-1">
        {FILTERS.map(([k, label]) => (
          <Button key={k} size="sm" variant={filter === k ? "default" : "outline"} onClick={() => setFilter(k)} data-testid={`reports-filter-${k}`}>{label}</Button>
        ))}
      </div>
      {q.isError && <p className="text-sm text-red-300">{errMsg(q.error)}</p>}
      {q.data?.length === 0 && <p className="text-sm text-muted-foreground">{tr("Aucun signalement.")}</p>}
      {q.data?.map((r) => <ReportCard key={r.id} r={r} me={user} />)}
    </div>
  );
}

export default function Signalements() {
  return <AppShell>{(user, mode) => <SignalementsView user={user} mode={mode} />}</AppShell>;
}
