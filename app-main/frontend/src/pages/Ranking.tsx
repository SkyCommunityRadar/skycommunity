import { useQuery } from "@tanstack/react-query";
import { Star } from "lucide-react";
import AppShell from "@/components/AppShell";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Link } from "react-router-dom";
import { apiGet } from "@/lib/api";
import type { LeaderEntry } from "@/lib/types";

import { tr } from "@/lib/i18n";
interface Leaderboard {
  pilots: LeaderEntry[];
  atc: LeaderEntry[];
}

function Board({ rows, kind }: { rows: LeaderEntry[]; kind: string }) {
  if (rows.length === 0)
    return <p className="p-4 text-sm text-muted-foreground" data-testid={`leader-${kind}-empty`}>{tr("Aucune heure enregistrée pour le moment.")}</p>;
  return (
    <ol className="space-y-1.5" data-testid={`leader-${kind}`}>
      {rows.map((r) => (
        <li
          key={`${r.rank}-${r.name}`}
          className="flex items-center gap-2.5 rounded-lg border border-border bg-card px-3 py-2.5 transition-[border-color,transform] duration-150 hover:-translate-y-0.5 hover:border-[color:var(--sc-accent)]/50 sm:gap-3 sm:px-4 sm:py-3"
          data-testid={`leader-${kind}-row-${r.rank}`}
        >
          <span className={`w-7 shrink-0 font-mono text-base font-bold sm:w-8 sm:text-lg ${r.rank <= 3 ? "text-[color:var(--sc-accent)]" : "text-muted-foreground"}`}>#{r.rank}</span>
          <div className="min-w-0 flex-1">
            <Link to={r.user_id ? `/pilotes/${r.user_id}` : "#"} className="flex min-w-0 items-center gap-2 text-[15px] font-semibold hover:text-[color:var(--sc-accent)] sm:text-base" data-testid={`leader-${kind}-name-${r.rank}`}>
              {r.avatar_url && <img src={r.avatar_url} alt="" className="h-6 w-6 shrink-0 rounded-full" />}
              <span className="truncate">{r.name}</span>
            </Link>
            <div className="flex flex-wrap items-center gap-0.5">
              {Array.from({ length: 5 }).map((_, i) => (
                <Star key={i} className={`h-3.5 w-3.5 ${i < r.stars ? "fill-[color:var(--sc-accent)] text-[color:var(--sc-accent)]" : "text-border"}`} />
              ))}
              {r.level && <span className="ml-1.5 whitespace-nowrap text-[10px] text-muted-foreground">{r.level}</span>}
            </div>
          </div>
          <div className="shrink-0 text-right font-mono text-xs sm:text-sm">
            <div className="whitespace-nowrap">{r.hours.toFixed(1)}{" "}{tr("h")}{kind === "pilots" ? tr(" · {0} vols", [r.flights]) : ""}</div>
            <div className="whitespace-nowrap text-[11px] text-muted-foreground sm:text-xs">
              {r.rating != null ? `★ ${r.rating.toFixed(1)} (${r.reviews})` : tr("pas d'avis")} · <span className="text-[color:var(--sc-accent)]" data-testid={`leader-${kind}-score-${r.rank}`}>{tr("{0} pts", [r.score])}</span>
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}

function View() {
  const q = useQuery<Leaderboard>({ queryKey: ["leaderboard"], queryFn: () => apiGet<Leaderboard>("/leaderboard"), refetchInterval: 60000 });
  return (
    <div className="mx-auto h-full max-w-3xl overflow-y-auto p-4 sm:p-6 space-y-4">
      <h1 className="text-2xl font-bold tracking-tight">{tr("Classement")}</h1>
      <p className="text-sm text-muted-foreground">{tr("Score calculé par le serveur : heures (×10, plafonnées au temps prévu du vol + marge), vols réalisés (×4), jours actifs sur 30 jours (×3) et note moyenne des avis validés (pondérée par le nombre d'avis, plafonnée à 10 avis pour éviter les manipulations). Une étoile toutes les 10 h.")}</p>
      <Tabs defaultValue="pilots">
        <TabsList>
          <TabsTrigger value="pilots" data-testid="leader-tab-pilots">{tr("Pilotes")}</TabsTrigger>
          <TabsTrigger value="atc" data-testid="leader-tab-atc">{tr("ATC")}</TabsTrigger>
        </TabsList>
        <TabsContent value="pilots" className="pt-3"><Board rows={q.data?.pilots ?? []} kind="pilots" /></TabsContent>
        <TabsContent value="atc" className="pt-3"><Board rows={q.data?.atc ?? []} kind="atc" /></TabsContent>
      </Tabs>
    </div>
  );
}

export default function Ranking() {
  return <AppShell>{() => <View />}</AppShell>;
}
