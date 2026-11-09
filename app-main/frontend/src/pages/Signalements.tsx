import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import AppShell, { type UiMode } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { apiGet, apiPatch, apiPost } from "@/lib/api";
import { errMsg } from "@/lib/hooks";
import type { User } from "@/lib/types";
import { tr } from "@/lib/i18n";

type Report = {
  id: string;
  flight_id: string;
  callsign?: string;
  author_name: string;
  target_name: string;
  category: string;
  comment: string;
  status: string;
  created_at: string;
};

const CATS: { id: string; label: string }[] = [
  { id: "hrp", label: "HRP" },
  { id: "phraseologie", label: "Phraséologie" },
  { id: "vitesse_roulage", label: "Vitesse de roulage" },
  { id: "non_respect_clairance", label: "Non-respect clairance" },
  { id: "autre", label: "Autre" },
];

function SignalementsView({ user }: { user: User; mode: UiMode }) {
  const qc = useQueryClient();
  const q = useQuery<Report[]>({
    queryKey: ["reports"],
    queryFn: () => apiGet<Report[]>("/reports"),
  });
  const close = useMutation({
    mutationFn: (id: string) => apiPatch(`/reports/${id}`, { status: "closed" }),
    onSuccess: () => {
      toast.success(tr("Signalement clôturé"));
      qc.invalidateQueries({ queryKey: ["reports"] });
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  const isAdmin = user.role === "admin" || user.access?.admin;

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4" data-testid="signalements-page">
      <h1 className="text-xl font-semibold">{tr("Signalements")}</h1>
      <p className="text-sm text-muted-foreground">
        {tr("Signalements déposés par les ATC (HRP, phraséologie, vitesse de roulage…). Visibles par les responsables, les concernés et les admins.")}
      </p>
      {q.isError && <p className="text-sm text-red-300">{errMsg(q.error)}</p>}
      {q.data?.length === 0 && <p className="text-sm text-muted-foreground">{tr("Aucun signalement.")}</p>}
      {q.data?.map((r) => (
        <div key={r.id} className="space-y-1 rounded-xl border border-border bg-card p-4 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>
              <b>{r.author_name}</b> → <b>{r.target_name}</b>
              {r.callsign && <span className="text-muted-foreground"> · {r.callsign}</span>}
            </span>
            <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-xs text-amber-200">
              {CATS.find((c) => c.id === r.category)?.label || r.category}
            </span>
          </div>
          <p>{r.comment || <i className="text-muted-foreground">{tr("Sans commentaire")}</i>}</p>
          <p className="text-xs text-muted-foreground">
            {r.status} · {r.created_at}
          </p>
          {isAdmin && r.status === "open" && (
            <Button size="sm" variant="outline" disabled={close.isPending} onClick={() => close.mutate(r.id)}>
              {tr("Clôturer")}
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}

export default function Signalements() {
  return <AppShell>{(user, mode) => <SignalementsView user={user} mode={mode} />}</AppShell>;
}
