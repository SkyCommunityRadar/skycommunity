import { useEffect, useState } from "react";
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

export const reviewKey = (it: { flight_id: string; target_id: string }) => `${it.flight_id}:${it.target_id}`;

/** One opinion to give. Pilot: give it now, or decline. Controller: also « Plus tard » (the bell keeps the reminder). */
function ReviewForm({ it, onDone }: { it: Interaction; onDone?: () => void }) {
  const qc = useQueryClient();
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState("");
  const [declining, setDeclining] = useState(false);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["interactions"] });
    qc.invalidateQueries({ queryKey: ["notifications"] });
  };
  const m = useMutation({
    mutationFn: (b: ReviewIn) => apiPost<Review>("/reviews", b),
    onSuccess: () => {
      toast.success(tr("Avis envoyé : il sera publié après validation par un administrateur."));
      onDone?.();
    },
    onError: (e) => toast.error(errMsg(e)),
    onSettled: refresh,
  });
  const choice = useMutation({
    mutationFn: (what: "snooze" | "dismiss") => apiPost(`/reviews/${what}`, { flight_id: it.flight_id, target_id: it.target_id }),
    onSuccess: (_d, what) => {
      toast.info(what === "snooze"
        ? tr("Avis reporté : retrouvez-le dans la cloche des notifications jusqu'au {0}.", [it.deadline ? fmtDateTime(it.deadline) : "—"])
        : tr("Aucun avis laissé pour ce vol."));
      onDone?.();
    },
    onError: (e) => toast.error(errMsg(e)),
    onSettled: refresh,
  });
  const iAmController = it.target_role === "pilote"; // the opinion is about the pilot: I controlled the flight
  const id = `${it.callsign}-${it.target_id.slice(0, 6)}`;
  return (
    <div className="space-y-2 rounded-lg border border-border bg-background/50 p-3" data-testid={`review-form-${id}`}>
      <div className="text-sm">
        <b>{it.target_name}</b> <span className="text-muted-foreground">({it.target_role === "atc" ? tr("contrôleur") : tr("pilote")}{tr(") · vol")}{" "}{it.callsign} {it.departure} → {it.arrival}</span>
      </div>
      {it.deadline && <p className="text-[11px] text-muted-foreground">{tr("Avis possible jusqu'au {0}", [fmtDateTime(it.deadline)])}</p>}
      <StarPicker value={rating} onChange={setRating} testId={`review-stars-${id}`} />
      <textarea value={comment} onChange={(e) => setComment(e.target.value)} maxLength={500} rows={2} placeholder={tr("Commentaire (respectueux, 500 caractères max.)")} className="w-full rounded-md border border-border bg-card px-2.5 py-2 text-sm outline-none focus:border-[color:var(--sc-accent)]" data-testid={`review-comment-${id}`} />
      {declining ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-amber-200">{tr("Ne laisser aucun avis pour ce vol ? Ce n'est plus possible ensuite.")}</span>
          <Button size="sm" variant="destructive" disabled={choice.isPending} onClick={() => choice.mutate("dismiss")} data-testid={`review-dismiss-confirm-${id}`}>{tr("Confirmer")}</Button>
          <Button size="sm" variant="ghost" onClick={() => setDeclining(false)}>{tr("Retour")}</Button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={!rating || m.isPending} onClick={() => m.mutate({ flight_id: it.flight_id, target_id: it.target_id, rating, comment })} data-testid={`review-submit-${id}`}>{tr("Envoyer l'avis")}</Button>
          {iAmController && !it.snoozed && (
            <Button size="sm" variant="outline" disabled={choice.isPending} onClick={() => choice.mutate("snooze")} data-testid={`review-later-${id}`}>{tr("Plus tard")}</Button>
          )}
          <Button size="sm" variant="ghost" disabled={choice.isPending} onClick={() => setDeclining(true)} data-testid={`review-dismiss-${id}`}>{tr("Ne pas laisser d'avis")}</Button>
        </div>
      )}
    </div>
  );
}

/** Reviews you can leave: one per real interaction (pilot ↔ controller on a finished flight, within 24 h). */
export function ReviewPanel() {
  const q = useQuery<Interaction[]>({ queryKey: ["interactions"], queryFn: () => apiGet<Interaction[]>("/reviews/interactions") });
  return (
    <div className="space-y-3 rounded-xl border border-border bg-card p-5" data-testid="review-panel">
      <h2 className="text-lg font-semibold">{tr("Laisser un avis")}</h2>
      <p className="text-sm text-muted-foreground">{tr("À la fin d'un vol où pilote et contrôleur ont échangé, pendant 24 h. Un seul avis par interaction, publié après modération.")}</p>
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

/** End-of-flight window, on every page: opens by itself when a flight ends (pilot and controllers at the same time),
 * and when a « Avis à laisser » notification is clicked (`sc-open-review` event). */
export function ReviewPrompt() {
  const q = useQuery<Interaction[]>({ queryKey: ["interactions"], queryFn: () => apiGet<Interaction[]>("/reviews/interactions"), refetchInterval: 30_000 });
  const [forced, setForced] = useState<string | null>(null);
  useEffect(() => {
    const h = (e: Event) => setForced((e as CustomEvent<string>).detail);
    window.addEventListener("sc-open-review", h);
    return () => window.removeEventListener("sc-open-review", h);
  }, []);
  const items = (q.data ?? []).filter((it) => !it.snoozed || reviewKey(it) === forced);
  if (items.length === 0) return null;
  return (
    <div className="fixed inset-0 z-[800] flex items-center justify-center bg-black/60 p-4" data-testid="end-flight-reviews">
      <div className="max-h-[85vh] w-full max-w-lg space-y-3 overflow-y-auto rounded-xl border border-border bg-[color:var(--sc-panel)] p-4 shadow-2xl">
        <h2 className="text-lg font-semibold">{tr("Avis de fin de vol")}</h2>
        <p className="text-sm text-muted-foreground">{tr("Le vol est terminé : donnez votre avis sur l'échange, ou choisissez de ne pas en laisser.")}</p>
        {items.map((it) => <ReviewForm key={reviewKey(it)} it={it} onDone={() => setForced(null)} />)}
      </div>
    </div>
  );
}
