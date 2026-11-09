import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { apiPost } from "@/lib/api";
import { errMsg, useMe } from "@/lib/hooks";
import type { FlightDetail } from "@/lib/types";
import { tr } from "@/lib/i18n";

const CATS = [
  { id: "hrp", label: "HRP" },
  { id: "phraseologie", label: "Phraséologie" },
  { id: "vitesse_roulage", label: "Vitesse de roulage" },
  { id: "non_respect_clairance", label: "Non-respect clairance" },
  { id: "autre", label: "Autre" },
] as const;

function ReportPilotForm({ flight: f }: { flight: FlightDetail }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [cat, setCat] = useState<string>("hrp");
  const [comment, setComment] = useState("");
  const m = useMutation({
    mutationFn: () =>
      apiPost("/reports", {
        flight_id: f.id,
        target_id: f.pilot_id,
        category: cat,
        comment: comment.trim(),
      }),
    onSuccess: () => {
      toast.success(tr("Signalement envoyé"));
      setOpen(false);
      setCat("hrp");
      setComment("");
      // the « Signalements » page would otherwise keep showing its cached list
      qc.invalidateQueries({ queryKey: ["reports"] });
    },
    onError: (e) => toast.error(errMsg(e)),
  });

  if (!open) {
    return (
      <Button
        size="sm"
        variant="outline"
        className="w-full border-amber-500/40 text-amber-200"
        onClick={() => setOpen(true)}
        data-testid="report-pilot-open"
      >
        {tr("Signaler le pilote")}
      </Button>
    );
  }

  return (
    <div className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-xs" data-testid="report-pilot-form">
      <p className="font-semibold text-amber-200">{tr("Signaler {0}", [f.pilot_name || f.callsign])}</p>
      <select
        className="w-full rounded border border-border bg-background px-2 py-1"
        aria-label={tr("Catégorie")}
        value={cat}
        onChange={(e) => setCat(e.target.value)}
        disabled={m.isPending}
      >
        {CATS.map((c) => (
          <option key={c.id} value={c.id}>
            {tr(c.label)}
          </option>
        ))}
      </select>
      <textarea
        className="w-full rounded border border-border bg-background px-2 py-1"
        rows={2}
        maxLength={1000}
        aria-label={tr("Commentaire (optionnel)")}
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder={tr("Commentaire (optionnel)")}
        disabled={m.isPending}
      />
      <div className="flex gap-2">
        <Button size="sm" disabled={m.isPending} onClick={() => m.mutate()} data-testid="report-pilot-send">
          {tr("Envoyer")}
        </Button>
        <Button size="sm" variant="ghost" disabled={m.isPending} onClick={() => setOpen(false)}>
          {tr("Annuler")}
        </Button>
      </div>
    </div>
  );
}

export default function ReportPilot({ flight: f }: { flight: FlightDetail }) {
  const me = useMe();
  if (!f.can_control) return null;
  // an admin who owns the flight must not be able to report themselves
  if (me.data && me.data.id === f.pilot_id) return null;
  // key: switching to another flight must not keep an open form / draft comment from the previous one
  return <ReportPilotForm key={f.id} flight={f} />;
}