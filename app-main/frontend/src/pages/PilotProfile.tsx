import { useParams, Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Star } from "lucide-react";
import AppShell from "@/components/AppShell";
import DeleteButton from "@/components/DeleteButton";
import { apiGet } from "@/lib/api";
import { errMsg } from "@/lib/hooks";
import { fmtDateTime } from "@/lib/phases";
import type { PublicProfile } from "@/lib/types";

import { tr } from "@/lib/i18n";
export function Stars({ value, testId }: { value: number | null; testId?: string }) {
  return (
    <span className="inline-flex items-center gap-0.5" data-testid={testId} title={value != null ? `${value}/5` : tr("Aucune note")}>
      {[1, 2, 3, 4, 5].map((i) => (
        <Star key={i} className={`h-4 w-4 ${value != null && i <= Math.round(value) ? "fill-amber-400 text-amber-400" : "text-muted-foreground/40"}`} />
      ))}
    </span>
  );
}

export function ProfileCard({ p }: { p: PublicProfile }) {
  const stats = [
    ["Heures de vol", `${p.pilot_hours} h`, "pilot-hours"],
    ["Vols réalisés", String(p.flights), "flights"],
    ["Heures ATC", `${p.atc_hours} h`, "atc-hours"],
    ...(p.atc_allowed ? [["Vols contrôlés", String(p.atc_flights), "atc-flights"]] : []),
    ["Vols annulés", String(p.flights_cancelled), "cancelled"],
  ];
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-5 rounded-xl border border-border bg-card p-6">
        {p.avatar_url ? (
          <img src={p.avatar_url} alt="" className="h-20 w-20 rounded-full ring-2 ring-[color:var(--sc-accent)]/50" data-testid="profile-avatar" />
        ) : (
          <div className="flex h-20 w-20 items-center justify-center rounded-full bg-secondary text-3xl font-bold" data-testid="profile-avatar">
            {p.display_name.slice(0, 1).toUpperCase()}
          </div>
        )}
        <div className="space-y-1">
          <h1 className="text-2xl font-bold" data-testid="profile-name">{p.display_name}</h1>
          {p.discord_username && <p className="text-sm text-muted-foreground" data-testid="profile-discord">@{p.discord_username}</p>}
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {p.is_creator && <span className="rounded-md bg-amber-400/15 px-2 py-0.5 font-semibold text-amber-300" data-testid="profile-badge-creator">{tr("Créateur")}</span>}
            {p.is_admin && !p.is_creator && <span className="rounded-md bg-rose-500/15 px-2 py-0.5 font-semibold text-rose-300" data-testid="profile-badge-admin">{tr("Administrateur")}</span>}
            {p.is_atc_lead && <span className="rounded-md bg-violet-500/15 px-2 py-0.5 font-semibold text-violet-300" data-testid="profile-badge-atc-lead">{tr("Responsable ATC")}</span>}
            {p.level && <span className="rounded-md bg-[color:var(--sc-primary)]/20 px-2 py-0.5 font-semibold text-[color:var(--sc-accent)]" data-testid="profile-level">{p.level}</span>}
            {p.atc_allowed && <span className="rounded-md bg-emerald-500/15 px-2 py-0.5 text-emerald-300">{tr("ATC")}</span>}
          </div>
        </div>
        <div className="ml-auto text-right">
          <Stars value={p.rating} testId="profile-rating-stars" />
          <p className="text-sm text-muted-foreground" data-testid="profile-rating">
            {p.rating != null ? `${p.rating.toFixed(1)}/5` : tr("Pas encore noté")} · {p.reviews_count}{" "}{tr("avis")}</p>
        </div>
      </div>
      <div className={`grid grid-cols-2 gap-3 ${stats.length === 5 ? "md:grid-cols-5" : "md:grid-cols-4"}`}>
        {stats.map(([l, v, id]) => (
          <div key={id} className="rounded-xl border border-border bg-card p-4 transition-colors duration-150 hover:border-[color:var(--sc-accent)]/50">
            <div className="text-xs uppercase tracking-wider text-muted-foreground">{tr(l)}</div>
            <div className="mt-1 font-mono text-2xl font-bold" data-testid={`profile-stat-${id}`}>{v}</div>
          </div>
        ))}
      </div>
      <div className="space-y-3">
        <h2 className="text-lg font-semibold">{tr("Avis validés")}</h2>
        {p.reviews.length === 0 && <p className="text-sm text-muted-foreground" data-testid="profile-no-reviews">{tr("Aucun avis publié pour le moment.")}</p>}
        {p.reviews.map((r) => (
          <div key={r.id} className="rounded-lg border border-border bg-card p-4" data-testid={`profile-review-${r.id}`}>
            <div className="flex items-center justify-between text-sm">
              <span>
                <b>{r.author_name}</b> <span className="text-muted-foreground">{tr("· vol")}{" "}{r.callsign}{" "}{tr("· en tant que")}{" "}{r.target_role === "atc" ? tr("contrôleur") : tr("pilote")}</span>
              </span>
              <Stars value={r.rating} />
            </div>
            {r.comment && <p className="mt-2 text-sm">{r.comment}</p>}
            <p className="mt-1 text-xs text-muted-foreground">{fmtDateTime(r.created_at)}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

export function usePublicProfile(id: string | undefined) {
  return useQuery<PublicProfile>({ queryKey: ["profile", id], queryFn: () => apiGet<PublicProfile>(`/users/${id}/profile`), enabled: !!id });
}

function View() {
  const { id } = useParams();
  const q = usePublicProfile(id);
  const nav = useNavigate();
  return (
    <div className="mx-auto max-w-4xl space-y-4 p-6">
      <Link to="/classement" className="text-sm text-muted-foreground hover:text-foreground" data-testid="profile-back">{tr("← Classement")}</Link>
      {q.isLoading && <p className="text-muted-foreground">{tr("Chargement…")}</p>}
      {q.isError && <p className="text-red-300">{errMsg(q.error)}</p>}
      {q.data && <ProfileCard p={q.data} />}
      {q.data?.can_delete && (
        <div className="flex justify-end">
          <DeleteButton
            path={`/admin/users/${q.data.id}`}
            what={tr("le profil de {0}", [q.data.display_name])}
            warning={tr("Ses vols et les avis le concernant sont supprimés aussi. S'il est encore sur le Discord, il retrouvera un profil vide à sa prochaine connexion.")}
            onDone={() => nav("/classement")}
            testId="delete-profile"
          />
        </div>
      )}
    </div>
  );
}

export default function PilotProfile() {
  return <AppShell>{() => <View />}</AppShell>;
}
