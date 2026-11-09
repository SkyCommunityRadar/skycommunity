import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";
import type { Interaction } from "@/lib/types";
import { ReviewPanel } from "@/components/Reviews";
import { tr } from "@/lib/i18n";
import { Button } from "@/components/ui/button";

/** Modal d'avis après fin de vol (pilote et ATC). */
export default function EndFlightReviews({ phase }: { phase?: string }) {
  const [open, setOpen] = useState(false);
  const [seenTermine, setSeenTermine] = useState(false);
  const q = useQuery<Interaction[]>({
    queryKey: ["interactions"],
    queryFn: () => apiGet<Interaction[]>("/reviews/interactions"),
    enabled: open,
  });

  useEffect(() => {
    if (phase === "termine" && !seenTermine) {
      setSeenTermine(true);
      // petit délai pour laisser le serveur logger les events ATC
      const t = window.setTimeout(() => setOpen(true), 800);
      return () => window.clearTimeout(t);
    }
    if (phase && phase !== "termine") setSeenTermine(false);
  }, [phase, seenTermine]);

  if (!open) return null;
  const has = (q.data?.length ?? 0) > 0;

  return (
    <div className="fixed inset-0 z-[800] flex items-center justify-center bg-black/60 p-4" data-testid="end-flight-reviews">
      <div className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-xl border border-border bg-[#0B1220] p-4 shadow-2xl">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{tr("Avis sur ce vol")}</h2>
          <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>{tr("Fermer")}</Button>
        </div>
        <p className="mb-3 text-sm text-muted-foreground">
          {tr("Le vol est terminé. Laissez un avis si vous avez interagi avec un contrôleur ou un pilote.")}
        </p>
        {q.isLoading && <p className="text-sm text-muted-foreground">{tr("Chargement…")}</p>}
        {!q.isLoading && !has && (
          <p className="text-sm text-muted-foreground">{tr("Aucune interaction à évaluer pour le moment.")}</p>
        )}
        {has && <ReviewPanel />}
        <div className="mt-3 flex justify-end">
          <Button size="sm" variant="secondary" onClick={() => setOpen(false)}>{tr("Plus tard")}</Button>
        </div>
      </div>
    </div>
  );
}
