import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AnimatePresence, motion } from "motion/react";
import { ArrowUpCircle, Radio } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiGet, apiPost } from "@/lib/api";
import { errMsg } from "@/lib/hooks";
import type { AtcPosition, Handover } from "@/lib/types";

import { tr } from "@/lib/i18n";
/** Mandatory handover (relève): blocking notice for the controller who must take over a position that was closed
 * or lost its connection. « Reprendre maintenant », otherwise the server does it automatically at the deadline. */
export default function HandoverNotice() {
  const qc = useQueryClient();
  const q = useQuery<Handover[]>({ queryKey: ["handovers"], queryFn: () => apiGet<Handover[]>("/atc/handovers/me"), refetchInterval: 3000 });
  const [now, setNow] = useState(() => Date.now());
  const list = q.data ?? [];
  useEffect(() => {
    if (!list.length) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [list.length]);
  const take = useMutation({
    mutationFn: () => apiPost<AtcPosition[]>("/atc/handovers/accept"),
    onSuccess: (ps) => toast.success(ps.length ? tr("Vous contrôlez maintenant {0}", [ps.map((p) => p.callsign).join(", ")]) : tr("Relève déjà effectuée")),
    onError: (e) => toast.error(errMsg(e)),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["handovers"] });
      qc.invalidateQueries({ queryKey: ["atc-positions"] });
      qc.invalidateQueries({ queryKey: ["flights"] });
    },
  });
  const deadline = list.length ? Math.min(...list.map((h) => new Date(h.deadline).getTime())) : 0;
  const left = Math.max(0, Math.ceil((deadline - now) / 1000));

  return (
    <AnimatePresence>
      {list.length > 0 && (
        <motion.div
          className="fixed inset-0 z-[2000] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="handover-title"
          data-testid="handover-notice"
        >
          <motion.div
            className="w-full max-w-md space-y-4 rounded-xl border border-amber-400/50 bg-card p-6 shadow-2xl"
            initial={{ scale: 0.94, y: 12 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.96, opacity: 0 }}
            transition={{ type: "spring", stiffness: 380, damping: 30 }}
          >
            <div className="flex items-center gap-3">
              <ArrowUpCircle className="h-8 w-8 shrink-0 text-amber-300" />
              <div>
                <h2 id="handover-title" className="text-lg font-semibold">{tr("Relève obligatoire")}</h2>
                <p className="text-sm text-muted-foreground">{tr("Vous devez reprendre")}{" "}{list.length > 1 ? tr("ces positions") : tr("cette position")}.</p>
              </div>
            </div>
            <ul className="space-y-1.5">
              {list.map((h) => (
                <li key={h.id} className="flex items-center justify-between rounded-md bg-background/70 px-3 py-2 text-sm">
                  <span>
                    <Radio className="mr-1.5 inline h-3.5 w-3.5 text-[#4AA8F0]" />
                    <b className="font-mono">{h.callsign}</b>
                    <span className="ml-2 text-xs text-muted-foreground">
                      {h.from_controller} — {h.reason === "fermeture" ? tr("position fermée") : tr("connexion perdue")}
                    </span>
                  </span>
                  <span className="font-mono text-amber-200">{h.frequency}</span>
                </li>
              ))}
            </ul>
            <Button size="lg" className="w-full text-base" onClick={() => take.mutate()} disabled={take.isPending} data-testid="handover-take-now">{tr("Reprendre maintenant")}</Button>
            <p className="text-center text-xs text-muted-foreground" data-testid="handover-countdown">{tr("Bascule automatique dans {0}:{1}", [Math.floor(left / 60), String(left % 60).padStart(2, "0")])}
            </p>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
