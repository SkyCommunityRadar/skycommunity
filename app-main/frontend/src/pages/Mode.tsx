import { useState } from "react";
import LangSwitch from "@/components/LangSwitch";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plane, RadioTower, Lock, Moon } from "lucide-react";
import { apiPost } from "@/lib/api";
import { errMsg, useMe } from "@/lib/hooks";
import { endSession } from "@/lib/session";
import type { InactivityStatus, User } from "@/lib/types";
import { cn } from "@/lib/utils";

import { locale, tr, trServer } from "@/lib/i18n";
const ADMIN_MODE_KEY = "sc.admin.uimode";
type M = "pilote" | "atc";

const fmtDay = (iso: string) => new Date(iso).toLocaleDateString(locale(), { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" });

/** Suspended for inactivity: explanation + « Demander la réactivation » (sent to the responsables). */
function Suspended({ mode, st, onSent }: { mode: M; st: InactivityStatus; onSent: (u: User) => void }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const lead = mode === "atc" ? "Responsable ATC" : "Responsable Pilotes";
  const send = async () => {
    setBusy(true);
    try {
      await apiPost(`/activity/me/${mode}/request`, msg.trim() ? { message: msg.trim() } : {});
      toast.success(tr("Demande envoyée au {0}", [lead]));
      await qc.invalidateQueries({ queryKey: ["me"] });
      const u = qc.getQueryData<User>(["me"]);
      if (u) onSent(u);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-3 space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs" data-testid={`mode-${mode}-suspended`}>
      <p className="font-semibold text-amber-200">{tr("Accès suspendu pour inactivité")}</p>
      <p className="text-amber-100/90">{trServer(st.reason ?? "")}</p>
      {st.request_at ? (
        <p className="text-emerald-300" data-testid={`mode-${mode}-request-sent`}>{tr("Demande de réactivation envoyée le {0} : le {1} va la traiter.", [fmtDay(st.request_at), lead])}</p>
      ) : (
        <>
          <input
            value={msg}
            onChange={(e) => setMsg(e.target.value)}
            maxLength={300}
            placeholder={tr("Un petit mot pour le responsable (facultatif)")}
            className="w-full rounded border border-border bg-background/70 px-2 py-1.5 text-xs outline-none focus:border-[#4AA8F0]"
            data-testid={`mode-${mode}-request-message`}
          />
          <button
            onClick={send}
            disabled={busy}
            className="rounded-md bg-amber-500 px-3 py-1.5 font-semibold text-black transition-colors hover:bg-amber-400 disabled:opacity-60"
            data-testid={`mode-${mode}-request`}
          >
            {busy ? tr("Envoi…") : tr("Demander la réactivation")}
          </button>
        </>
      )}
    </div>
  );
}

/** After login: choose Pilote or ATC. A mode the member has no Discord role for stays visible but locked,
 * and a mode suspended for inactivity explains why and lets the member ask for its reactivation. */
export default function Mode() {
  const me = useMe();
  const qc = useQueryClient();
  const nav = useNavigate();
  const loc = useLocation();
  const [busy, setBusy] = useState<string | null>(null);
  const from = (loc.state as { from?: string } | null)?.from;
  const target = from && from !== "/mode" ? from : "/";

  if (me.isError) return <Navigate to="/login" replace />;
  if (!me.data) return <div className="p-8 font-mono text-sm text-muted-foreground">{tr("Chargement…")}</div>;
  const u = me.data;
  const isAdmin = u.role === "admin";

  async function choose(mode: M) {
    if (isAdmin) {
      // administrators keep every right: the mode is only how the site is laid out for them
      localStorage.setItem(ADMIN_MODE_KEY, mode);
      window.dispatchEvent(new Event("sc-mode"));
      nav(target, { replace: true });
      return;
    }
    setBusy(mode);
    try {
      const user = await apiPost<User>("/auth/mode", { mode });
      qc.clear();
      qc.setQueryData(["me"], user);
      toast.success(mode === "atc" ? tr("Mode ATC activé") : tr("Mode Pilote activé"));
      nav(target, { replace: true });
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(null);
    }
  }

  const cards = [
    {
      mode: "pilote" as const,
      title: tr("Pilote"),
      icon: Plane,
      text: tr("Volez sur le réseau SkyCommunity : déposez votre plan de vol SimBrief, suivez votre avion sur le radar et soyez guidé par les contrôleurs."),
    },
    {
      mode: "atc" as const,
      title: "ATC",
      icon: RadioTower,
      text: tr("Contrôlez le trafic : ouvrez votre position (sol, tour, approche ou centre) et gérez les vols de votre zone en direct sur le radar."),
    },
  ];

  return (
    <div className="relative flex min-h-dvh items-center justify-center bg-[radial-gradient(circle_at_30%_20%,#10244a_0%,#070D1A_55%)] p-6">
      <LangSwitch className="absolute right-4 top-4" />
      <div className="w-full max-w-3xl space-y-8">
        <div className="flex items-center gap-3">
          <img src="/logo.png" alt={tr("SkyCommunity")} className="h-12 w-12 shrink-0 rounded-full bg-white ring-2 ring-[#4AA8F0]/40" />
          <div>
            <h1 className="text-2xl font-semibold tracking-tight" data-testid="mode-title">{tr("Bonjour {0}, quel poste aujourd'hui ?", [u.display_name])}</h1>
            <p className="text-sm text-muted-foreground">{tr("Vous pourrez changer de mode à tout moment depuis l'en-tête.")}</p>
          </div>
        </div>
        <div className="grid gap-5 md:grid-cols-2">
          {cards.map(({ mode, title, icon: Icon, text }) => {
            const noRole = !isAdmin && !u.access[mode];
            const st = u.inactivity?.[mode];
            const suspended = !isAdmin && !noRole && st?.state === "suspendu";
            const locked = noRole || suspended;
            return (
              <div
                key={mode}
                role={locked ? undefined : "button"}
                tabIndex={locked ? -1 : 0}
                onClick={() => !locked && !busy && choose(mode)}
                onKeyDown={(e) => !locked && !busy && (e.key === "Enter" || e.key === " ") && choose(mode)}
                aria-disabled={locked}
                data-testid={`mode-${mode}-button`}
                className={cn(
                  "group relative overflow-hidden rounded-xl border p-6 text-left transition-[transform,border-color,box-shadow] duration-200",
                  locked
                    ? "cursor-not-allowed border-border bg-card/60"
                    : "cursor-pointer border-[#2B63C9]/50 bg-card hover:-translate-y-1 hover:border-[#4AA8F0] hover:shadow-[0_12px_40px_-12px_#2B63C9]",
                )}
              >
                <div className="pointer-events-none absolute -right-8 -top-8 h-32 w-32 rounded-full bg-[#2B63C9]/15 blur-2xl" />
                <div className={cn(locked && "opacity-55")}>
                  <Icon className="h-9 w-9 text-[#4AA8F0]" />
                  <div className="mt-4 flex items-center gap-2 text-xl font-semibold">
                    {title} {noRole && <Lock className="h-4 w-4 text-muted-foreground" />}
                    {suspended && <Moon className="h-4 w-4 text-amber-300" />}
                  </div>
                  <p className="mt-1.5 text-sm text-muted-foreground">{text}</p>
                </div>
                {noRole && (
                  <div className="mt-3 rounded-lg border border-border bg-background/50 p-3 text-xs" data-testid={`mode-${mode}-locked`}>
                    <p className="font-semibold text-foreground">{tr("Vous n'avez pas accès au mode {0}.", [title])}</p>
                    <p className="mt-0.5 text-muted-foreground">{tr("Il faut le rôle {0} sur le serveur Discord SkyCommunity.", [title])}</p>
                  </div>
                )}
                {suspended && st && <Suspended mode={mode} st={st} onSent={(nu) => qc.setQueryData(["me"], nu)} />}
                {busy === mode && <p className="mt-3 text-xs text-[#4AA8F0]">{tr("Activation…")}</p>}
              </div>
            );
          })}
        </div>
        <button onClick={() => endSession()} className="text-xs text-muted-foreground hover:text-foreground" data-testid="mode-logout">{tr("Se déconnecter")}</button>
      </div>
    </div>
  );
}
