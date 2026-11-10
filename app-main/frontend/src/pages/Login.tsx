import { Link, Navigate, useLocation } from "react-router-dom";
import LangSwitch from "@/components/LangSwitch";
import InstallApp from "@/components/InstallApp";
import { useQuery } from "@tanstack/react-query";
import { motion } from "motion/react";
import { FileText, Heart, Plane, RadioTower } from "lucide-react";
import { DiscordIcon } from "@/components/AppShell";
import { apiGet } from "@/lib/api";
import { useMe } from "@/lib/hooks";
import { ThemeGarland, ThemeGreeting, ThemeHat } from "@/components/ThemeDecor";
import { DONATE_URL } from "@/lib/siteConfig";

import { labels, tr } from "@/lib/i18n";
const D_ERR: Record<string, string> = labels({
  refus: "Connexion Discord annulée.",
  bloque: "Ce compte est suspendu. Contactez un administrateur.",
  etat: "La demande de connexion a expiré, réessayez.",
  expire: "La demande de connexion a expiré, réessayez.",
  hors_serveur: "Votre compte Discord n'est pas membre du serveur SkyCommunity. Rejoignez-le puis reconnectez-vous.",
  sans_role: "Accès refusé : il faut le rôle Pilote ou ATC sur le serveur Discord SkyCommunity.",
  anti_raid: "Les inscriptions sont temporairement fermées (protection anti-raid). Réessayez un peu plus tard.",
});

const FEATURES = [
  { icon: Plane, title: "Pilotes", text: "Plan de vol SimBrief, porte, roulage et progression en direct." },
  { icon: RadioTower, title: "Contrôleurs", text: "Positions APP, TWR, GND et CTR, strips partagés, relève." },
  { icon: FileText, title: "Un seul état", text: "Ce que voit le pilote, l'ATC le voit aussi, en temps réel." },
];

/** Radar-scope backdrop: concentric range rings + a slow sweep (pure CSS/SVG, no image to load). */
function RadarBackdrop() {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,var(--sc-glow)_0%,var(--sc-topbar)_55%,var(--sc-deep)_100%)]" />
      <svg className="absolute left-1/2 top-1/2 h-[160vmax] w-[160vmax] -translate-x-1/2 -translate-y-1/2 opacity-[0.22]" viewBox="-100 -100 200 200">
        {[18, 36, 54, 72, 90].map((r) => (
          <circle key={r} r={r} fill="none" stroke="#4AA8F0" strokeWidth="0.15" />
        ))}
        <line x1="-100" y1="0" x2="100" y2="0" stroke="#4AA8F0" strokeWidth="0.1" />
        <line x1="0" y1="-100" x2="0" y2="100" stroke="#4AA8F0" strokeWidth="0.1" />
      </svg>
      <div className="radar-sweep absolute left-1/2 top-1/2 h-[160vmax] w-[160vmax] -translate-x-1/2 -translate-y-1/2" />
    </div>
  );
}

export default function Login() {
  const me = useMe();
  const loc = useLocation();
  const from = (loc.state as { from?: string } | null)?.from ?? "/";
  const discord = useQuery<{ enabled: boolean }>({ queryKey: ["discord-status"], queryFn: () => apiGet("/auth/discord/status"), retry: false });
  const dErr = new URLSearchParams(loc.search).get("discord_error");

  // Only a *currently valid* session redirects; stale cached data after a 401 must not (redirect loop).
  if (me.isSuccess) return <Navigate to={from === "/login" ? "/" : from} replace />;

  return (
    <div className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden bg-[color:var(--sc-deep)] px-4 py-10">
      <RadarBackdrop />
      <LangSwitch className="absolute right-4 top-4 z-20" />
      <motion.main
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
        className="relative z-10 flex w-full max-w-3xl flex-col items-center text-center"
      >
        <span className="relative inline-flex"><ThemeHat size="lg" /><img src="/logo.png" alt={tr("SkyCommunity")} className="relative z-[1] h-24 w-24 rounded-full bg-white shadow-[0_0_60px_-10px_var(--sc-accent)] ring-4 ring-[color:var(--sc-accent)]/30" data-testid="login-logo-slot" /></span>
        <h1 className="mt-6 text-4xl font-bold tracking-tight sm:text-5xl">{tr("SkyCommunity")}{" "}<span className="text-[color:var(--sc-accent)]">{tr("Radar")}</span>
        </h1>
        <p className="mt-3 max-w-xl text-balance text-sm text-muted-foreground sm:text-base">{tr("Le ciel de SkyCommunity, sous vos yeux.")}</p>
        <ThemeGreeting className="mt-2 text-sm font-semibold text-[color:var(--sc-accent-soft)]" />

        <div className="relative mt-8 w-full max-w-sm space-y-3 overflow-hidden rounded-2xl border border-white/10 bg-[color:var(--sc-sidebar)]/80 p-6 shadow-2xl backdrop-blur-md">
          <ThemeGarland className="absolute inset-x-0 top-0 h-[22px]" />
          <h2 className="text-lg font-semibold">{tr("Connexion")}</h2>
          <p className="text-xs text-muted-foreground">{tr("Vos accès (Pilote, ATC, administration) suivent automatiquement vos rôles sur le serveur Discord SkyCommunity.")}</p>
          <button
            onClick={() => window.location.assign("/api/auth/discord/login")}
            disabled={discord.data?.enabled === false}
            className="flex w-full items-center justify-center gap-2.5 rounded-xl bg-[#5865F2] px-4 py-3.5 text-base font-semibold text-white shadow-lg shadow-[#5865F2]/30 transition-[background-color,transform] duration-150 hover:-translate-y-0.5 hover:bg-[#4752C4] disabled:cursor-not-allowed disabled:opacity-50"
            data-testid="discord-login-button"
          >
            <DiscordIcon className="h-5 w-5" />{" "}{tr("Se connecter avec Discord")}</button>
          {discord.data?.enabled === false && (
            <p className="text-xs text-amber-300" data-testid="discord-disabled">{tr("La connexion Discord est en cours de configuration par l'équipe.")}</p>
          )}
          {dErr && (
            <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300" data-testid="discord-error">
              {D_ERR[dErr] ?? tr("Échec de la connexion Discord, réessayez.")}
            </p>
          )}
          <a
            href="https://discord.gg/xjhTqW3N7d"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block text-xs text-[color:var(--sc-accent-soft)] underline-offset-4 hover:underline"
            data-testid="discord-button"
          >{tr("Pas encore membre ? Rejoindre le Discord SkyCommunity")}</a>
        </div>

        <a
          href={DONATE_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-5 inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-pink-600 to-rose-500 px-6 py-3 text-sm font-semibold text-white shadow-lg shadow-pink-600/30 transition-[transform,filter] duration-150 hover:-translate-y-0.5 hover:brightness-110"
          data-testid="donate-home-button"
        >
          <Heart className="h-4 w-4 fill-white/90" />{" "}{tr("Soutenir le projet")}
        </a>

        <div className="mt-10 grid w-full gap-3 sm:grid-cols-3">
          {FEATURES.map(({ icon: Icon, title, text }, i) => (
            <motion.div
              key={tr(title)}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.15 + i * 0.08, duration: 0.35 }}
              className="rounded-xl border border-white/8 bg-white/[0.03] p-4 backdrop-blur-sm"
            >
              <Icon className="mx-auto h-6 w-6 text-[color:var(--sc-accent)]" />
              <div className="mt-2 text-sm font-semibold">{tr(title)}</div>
              <p className="mt-1 text-xs text-muted-foreground">{tr(text)}</p>
            </motion.div>
          ))}
        </div>
      </motion.main>
      <div className="relative z-10 mt-6 w-full max-w-sm">
        <InstallApp compact />
      </div>
      <p className="relative z-10 mt-10 font-mono text-[10px] text-muted-foreground">{tr("Communauté SkyCommunity · MSFS PC / Xbox / PS5 ·")}{" "}
        <Link to="/confidentialite" className="underline hover:text-foreground" data-testid="privacy-link">{tr("Confidentialité")}</Link>
      </p>
    </div>
  );
}
