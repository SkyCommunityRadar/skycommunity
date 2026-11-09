import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiPost } from "@/lib/api";
import { errMsg, useFlightEvents } from "@/lib/hooks";
import { ROLE_LABELS, fmtDateTime } from "@/lib/phases";

import { tr } from "@/lib/i18n";
export default function EventTimeline({ flightId, canNote }: { flightId: string; canNote: boolean }) {
  const ev = useFlightEvents(flightId);
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  const addNote = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      await apiPost(`/flights/${flightId}/notes`, { text });
      setText("");
      qc.invalidateQueries({ queryKey: ["flight-events", flightId] });
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      {canNote && (
        <div className="flex gap-2">
          <Input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={tr("Ajouter une note à l'historique")}
            className="h-8 text-xs"
            data-testid="note-input"
          />
          <Button size="sm" variant="secondary" onClick={addNote} disabled={busy} data-testid="note-submit">{tr("Noter")}</Button>
        </div>
      )}
      <ol className="space-y-1.5" data-testid="event-timeline">
        {(ev.data ?? []).map((e) => (
          <li key={e.id} className="border-l-2 border-sky-700/60 pl-2.5 text-xs" data-testid="event-item">
            <div className="flex justify-between gap-2">
              <span className="text-foreground">{e.label}</span>
              <span className="font-mono text-[10px] text-muted-foreground shrink-0">{fmtDateTime(e.at)}</span>
            </div>
            <div className="text-[11px] text-muted-foreground">
              {e.actor_name} ({ROLE_LABELS[e.actor_role] ?? e.actor_role}){e.details ? ` — ${e.details}` : ""}
            </div>
          </li>
        ))}
        {ev.isSuccess && ev.data.length === 0 && <li className="text-xs text-muted-foreground">{tr("Aucun événement.")}</li>}
        {ev.isError && <li className="text-xs text-red-400">{tr("Historique indisponible (hors ligne).")}</li>}
      </ol>
    </div>
  );
}
