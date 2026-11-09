import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiDelete } from "@/lib/api";
import { errMsg } from "@/lib/hooks";

import { tr } from "@/lib/i18n";
/** Permanent deletion (administrators and the creator only — the server checks it again).
 * Two steps: the first click only asks for confirmation. */
export default function DeleteButton({
  path, what, warning, onDone, testId,
}: {
  path: string;
  what: string; // « le vol AFR123 », « le profil de Jean »
  warning: string;
  onDone: () => void;
  testId: string;
}) {
  const qc = useQueryClient();
  const [ask, setAsk] = useState(false);
  const m = useMutation({
    mutationFn: () => apiDelete(path),
    onSuccess: () => {
      toast.success(tr("Suppression effectuée : {0}", [what]));
      qc.invalidateQueries();
      onDone();
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  if (!ask)
    return (
      <Button variant="outline" size="sm" className="border-red-500/40 text-red-300 hover:bg-red-500/10" onClick={() => setAsk(true)} data-testid={testId}>
        <Trash2 className="h-4 w-4" />{" "}{tr("Supprimer")}</Button>
    );
  return (
    <div className="space-y-2 rounded-lg border border-red-500/50 bg-red-500/10 p-3 text-sm" data-testid={`${testId}-confirm`}>
      <p>{tr("Supprimer définitivement")}{" "}<b>{what}</b> ? {warning}
      </p>
      <div className="flex gap-2">
        <Button size="sm" variant="destructive" disabled={m.isPending} onClick={() => m.mutate()} data-testid={`${testId}-yes`}>{tr("Oui, supprimer")}</Button>
        <Button size="sm" variant="ghost" onClick={() => setAsk(false)} data-testid={`${testId}-no`}>{tr("Annuler")}</Button>
      </div>
    </div>
  );
}
