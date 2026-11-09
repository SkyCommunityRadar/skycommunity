import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiGet, apiPatch, apiPost } from "@/lib/api";
import { errMsg } from "@/lib/hooks";
import { fmtDateTime } from "@/lib/phases";
import type { Interaction, Review, ReviewIn } from "@/lib/types";
import { cn } from "@/lib/utils";

import { labels, tr } from "@/lib/i18n";
function StarPicker({ value, onChange, testId }: { value: number; onChange: (v: number) => void; testId: string }) {
  return (
    <div className="flex gap-0.5" data-testid={testId}>
      {[1, 2, 3, 4, 5].map((i) => (
        <button key={i} type="button" onClick={() => onChange(i)} className="transition-transform duration-100 hover:scale-110" data-testid={`${testId}-${i}`} aria-label={tr("{0} étoiles", [i])}>
          <Star className={cn("h-6 w-6", i <= value ? "fill-amber-400 text-amber-400" : "text-muted-foreground/40")} />
        </button>
      ))}
    </div>
  );
}

function ReviewForm({ it }: { it: Interaction }) {
  const qc = useQueryClient();
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState("");
  const m = useMutation({
    mutationFn: (b: ReviewIn) => apiPost<Review>("/reviews", b),
    onSuccess: () => toast.success(tr("Avis envoyé : il sera publié après validation par un administrateur.")),
    onError: (e) => toast.error(errMsg(e)),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["interactions"] });
      qc.invalidateQueries({ queryKey: ["notifications"] });
    },
  });
  const snooze = useMutation({
    mutationFn: () => apiPost("/reviews/snooze", { flight_id: it.flight_id, target_id: it.target_id }),
    onSuccess: () => toast.info(tr("Avis reporté : il réapparaîtra dans 24 h si non donné.")),
    onError: (e) => toast.error(errMsg(e)),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["interactions"] });
      qc.invalidateQueries({ queryKey: ["notifications"] });
    },
  });
  const id = `${it.callsign}-${it.target_id.slice(0, 6)}`;
  return (
    <div className="space-y-2 rounded-lg border border-border bg-background/50 p-3" data-testid={`review-form-${id}`}>
      <div className="text-sm">
        <b>{it.target_name}</b> <span className="text-muted-foreground">({it.target_role === "atc" ? tr("contrôleur") : tr("pilote")}{tr(") · vol")}{" "}{it.callsign} {it.departure} → {it.arrival}</span>
      </div>
      <StarPicker value={rating} onChange={setRating} testId={`review-stars-${id}`} />
      <textarea value={comment} onChange={(e) => setComment(e.target.value)} maxLength={500} rows={2} placeholder={tr("Commentaire (respectueux, 500 caractères max.)")} className="w-full rounded-md border border-border bg-card px-2.5 py-2 text-sm outline-none focus:border-[#4AA8F0]" data-testid={`review-comment-${id}`} />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={!rating || m.isPending} onClick={() => m.mutate({ flight_id: it.flight_id, target_id: it.target_id, rating, comment })} data-testid={`review-submit-${id}`}>{tr("Envoyer l'avis")}</Button>
        <Button
          size="sm"
          variant="outline"
          disabled={snooze.isPending}
          onClick={() => snooze.mutate()}
          data-testid={`review-later-${id}`}
        >
          {tr("Donner plus tard (24 h)")}
        </Button>
      </div>
    </div>
  );
}

/** Reviews you can leave: one per real interaction (pilot ↔ controller on a flight, last 30 days). */
export function ReviewPanel() {
  const q = useQuery<Interaction[]>({ queryKey: ["interactions"], queryFn: () => apiGet<Interaction[]>("/reviews/interactions") });
  return (
    <div className="space-y-3 rounded-xl border border-border bg-card p-5" data-testid="review-panel">
      <h2 className="text-lg font-semibold">{tr("Laisser un avis")}</h2>
      <p className="text-sm text-muted-foreground">{tr("Uniquement après une interaction réelle sur un vol (30 derniers jours). Un seul avis par interaction, publié après modération.")}</p>
      {q.isError && <p className="text-sm text-red-300">{errMsg(q.error)}</p>}
      {q.data?.length === 0 && <p className="text-sm text-muted-foreground" data-testid="review-none">{tr("Aucune interaction à évaluer pour le moment.")}</p>}
      {q.data?.map((it) => <ReviewForm key={`${it.flight_id}-${it.target_id}`} it={it} />)}
    </div>
  );
}

/** Admin moderation: pending / accepted / rejected. */
export function ReviewModeration() {
  const qc = useQueryClient();
  const [status, setStatus] = useState<Review["status"]>("pending");
  const q = useQuery<Review[]>({ queryKey: ["admin-reviews", status], queryFn: () => apiGet<Review[]>(`/admin/reviews?status=${status}`) });
  const m = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: "accept" | "reject" }) => apiPatch<Review>(`/admin/reviews/${id}`, { decision }),
    onSuccess: (r) => toast.success(r.status === "accepted" ? tr("Avis publié") : tr("Avis rejeté")),
    onError: (e) => toast.error(errMsg(e)),
    onSettled: () => qc.invalidateQueries({ queryKey: ["admin-reviews"] }),
  });
  const LABEL = labels({ pending: "En attente", accepted: "Acceptés", rejected: "Rejetés" });
  return (
    <section className="space-y-3 rounded-xl border border-border bg-card p-5" data-testid="review-moderation">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">{tr("Modération des avis")}</h2>
        <div className="flex gap-1">
          {(["pending", "accepted", "rejected"] as const).map((s) => (
            <Button key={s} size="sm" variant={status === s ? "default" : "outline"} onClick={() => setStatus(s)} data-testid={`reviews-tab-${s}`}>
              {LABEL[s]}
            </Button>
          ))}
        </div>
      </div>
      {q.data?.length === 0 && <p className="text-sm text-muted-foreground" data-testid="reviews-empty">{tr("Aucun avis {0}.", [LABEL[status].toLowerCase()])}</p>}
      {q.data?.map((r) => (
        <div key={r.id} className="space-y-1.5 rounded-lg border border-border bg-background/50 p-3 text-sm" data-testid={`review-row-${r.id}`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>
              <b>{r.author_name}</b> → <b>{r.target_name}</b> <span className="text-muted-foreground">({r.target_role === "atc" ? tr("contrôleur") : tr("pilote")}{tr(") · vol")}{" "}{r.callsign}</span>
            </span>
            <span className="font-mono text-amber-300">{"★".repeat(r.rating)}{"☆".repeat(5 - r.rating)}</span>
          </div>
          <p>{r.comment || <i className="text-muted-foreground">{tr("Sans commentaire")}</i>}</p>
          <p className="text-xs text-muted-foreground">{tr("Soumis le")}{" "}{fmtDateTime(r.created_at)}
            {r.decided_by && tr(" · traité par {0}", [r.decided_by])}
          </p>
          {status === "pending" && (
            <div className="flex gap-2 pt-1">
              <Button size="sm" onClick={() => m.mutate({ id: r.id, decision: "accept" })} disabled={m.isPending} data-testid={`review-accept-${r.id}`}>{tr("Accepter")}</Button>
              <Button size="sm" variant="destructive" onClick={() => m.mutate({ id: r.id, decision: "reject" })} disabled={m.isPending} data-testid={`review-reject-${r.id}`}>{tr("Rejeter")}</Button>
            </div>
          )}
        </div>
      ))}
    </section>
  );
}
