import { useEffect, useState, type ReactNode } from "react";
import LangSwitch from "@/components/LangSwitch";
import { Link, NavLink, Navigate, useLocation, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { motion } from "motion/react";
import HandoverNotice from "@/components/HandoverNotice";
import { Bell, Megaphone, LogOut, Radar, PlusCircle, History, UserRound, ShieldCheck, Trophy, PanelLeftClose, PanelLeftOpen, Lock, CalendarDays, Activity, AlertTriangle, Heart } from "lucide-react";
import { ApiError, apiGet, apiPost } from "@/lib/api";
import { errMsg, useMe } from "@/lib/hooks";
import { endSession } from "@/lib/session";
import type { User } from "@/lib/types";
import { cn } from "@/lib/utils";

import { labels, locale, tr } from "@/lib/i18n";
import { DONATE_URL } from "@/lib/siteConfig";
import { ThemeBadge } from "@/components/ThemeDecor";
export const DISCORD_INVITE = "https://discord.gg/xjhTqW3N7d";
const SIDEBAR_KEY = "sc.sidebar.collapsed";
const ADMIN_MODE_KEY = "sc.admin.uimode";

export function DiscordIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cn("fill-current", className)} aria-hidden="true">
      <path d="M20.317 4.37a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.74 19.74 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.1 13.1 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.094.252-.192.372-.291a.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.3 12.3 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.84 19.84 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
    </svg>
  );
}

/** UTC clock HH:MM:SS anchored on the server clock (offset measured from /health), ticking every second. */
function UtcClock() {
  const q = useQuery<{ ok: boolean; server_time: string }>({ queryKey: ["health"], queryFn: () => apiGet("/health"), refetchInterval: 30_000, retry: false });
  const [offset, setOffset] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (q.data) setOffset(new Date(q.data.server_time).getTime() - Date.now());
  }, [q.data]);
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  const online = q.isSuccess;
  return (
    <div className="flex items-center gap-1.5 rounded-md border border-border bg-background/60 px-2 py-1 font-mono text-xs sm:gap-2 sm:px-2.5 sm:text-sm" data-testid="utc-clock">
      <span className={cn("h-2 w-2 rounded-full sync-dot", online ? "bg-emerald-400" : "bg-red-400")} data-testid="sync-status" data-online={online} title={online ? tr("Synchronisé") : tr("Hors ligne — reconnexion…")} />
      <span className="tabular-nums tracking-wider" data-testid="server-time">
        {new Date(now + offset).toISOString().slice(11, 19)}
      </span>
      <span className="text-[10px] text-muted-foreground sm:text-[11px]">{tr("UTC")}</span>
    </div>
  );
}

export type UiMode = "pilote" | "atc";
/** UI mode: the session mode for members; a local display preference for the admin (who keeps all rights). */
export function useUiMode(user: User | undefined): UiMode {
  const [adminMode, setAdminMode] = useState<UiMode>(() => (localStorage.getItem(ADMIN_MODE_KEY) as UiMode) || "atc");
  useEffect(() => {
    const h = () => setAdminMode((localStorage.getItem(ADMIN_MODE_KEY) as UiMode) || "atc");
    window.addEventListener("sc-mode", h);
    return () => window.removeEventListener("sc-mode", h);
  }, []);
  if (!user) return "pilote";
  return user.role === "admin" ? adminMode : user.role === "atc" ? "atc" : "pilote";
}

function ModeSwitch({ user, mode }: { user: User; mode: UiMode }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  const suspended = (m: UiMode) => user.role !== "admin" && user.inactivity?.[m]?.state === "suspendu";
  const canAtc = user.role === "admin" || (user.access.atc && !suspended("atc"));
  const canPilot = user.role === "admin" || (user.access.pilote && !suspended("pilote"));
  const pick = async (m: UiMode) => {
    if (m === mode || busy) return;
    if (suspended(m)) {
      toast.info(tr("Votre accès {0} est suspendu pour inactivité : demandez sa réactivation.", [m === "atc" ? "ATC" : "Pilote"]));
      nav("/mode");
      return;
    }
    if ((m === "atc" && !canAtc) || (m === "pilote" && !canPilot)) {
      toast.info(tr("Vous n'avez pas accès au mode {0} : il faut le rôle {1} sur le serveur Discord SkyCommunity.", [m === "atc" ? "ATC" : "Pilote", m === "atc" ? "ATC" : "Pilote"]));
      return;
    }
    if (user.role === "admin") {
      localStorage.setItem(ADMIN_MODE_KEY, m);
      window.dispatchEvent(new Event("sc-mode"));
      nav("/");
      return;
    }
    setBusy(true);
    try {
      const u = await apiPost<User>("/auth/mode", { mode: m });
      qc.clear();
      qc.setQueryData(["me"], u);
      toast.success(m === "atc" ? tr("Mode ATC activé") : tr("Mode Pilote activé"));
      nav("/");
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="relative flex rounded-lg border border-border bg-background/60 p-0.5 text-sm" role="radiogroup" data-testid="mode-switch">
      {(["pilote", "atc"] as const).map((m) => (
        <button
          key={m}
          role="radio"
          aria-checked={mode === m}
          onClick={() => pick(m)}
          disabled={busy}
          className={cn(
            "relative z-10 flex items-center gap-1 rounded-md px-2.5 py-1 font-semibold transition-colors duration-200 sm:px-3",
            mode === m ? "text-white" : "text-muted-foreground hover:text-foreground",
          )}
          data-testid={`mode-switch-${m}`}
        >
          {mode === m && (
            <motion.span layoutId="mode-pill" className="absolute inset-0 -z-10 rounded-md bg-[#2B63C9]" transition={{ type: "spring", stiffness: 500, damping: 38 }} />
          )}
          {m === "pilote" ? tr("Pilote") : "ATC"}
          {((m === "atc" && !canAtc) || (m === "pilote" && !canPilot)) && <Lock className="h-3 w-3" />}
        </button>
      ))}
    </div>
  );
}

function LogoutButton() {
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    if (!confirm) return;
    const t = window.setTimeout(() => setConfirm(false), 4000);
    return () => window.clearTimeout(t);
  }, [confirm]);
  return confirm ? (
    <button
      onClick={() => endSession()}
      className="whitespace-nowrap rounded-md bg-red-500/90 px-2.5 py-1.5 text-xs font-semibold text-white transition-colors duration-150 hover:bg-red-500"
      data-testid="logout-confirm-button"
    >
      <span className="hidden sm:inline">{tr("Confirmer la déconnexion")}</span>
      <span className="sm:hidden">{tr("Quitter ?")}</span>
    </button>
  ) : (
    <button
      onClick={() => setConfirm(true)}
      className="rounded-md p-2 text-muted-foreground transition-colors duration-150 hover:bg-secondary hover:text-foreground"
      title={tr("Se déconnecter")}
      data-testid="logout-button"
    >
      <LogOut className="h-5 w-5" />
    </button>
  );
}


type Notif = { id: string; kind: string; title: string; body: string; unread?: boolean };

function NotifBell({ user }: { user: User }) {
  const qc = useQueryClient();
  const q = useQuery<{ items: Notif[]; count: number; unread?: number }>({
    queryKey: ["notifications"],
    queryFn: () => apiGet("/notifications"),
    refetchInterval: 30_000,
    enabled: !!user,
  });
  const [open, setOpen] = useState(false);
  const count = q.data?.count ?? 0;
  const unread = q.data?.unread ?? 0; // red badge, like on a phone: what arrived since the bell was last opened
  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && unread > 0) {
      apiPost("/notifications/seen", {}).then(() => qc.invalidateQueries({ queryKey: ["notifications"] })).catch(() => undefined);
    }
  };
  return (
    <div className="relative" data-testid="notif-bell">
      <button
        type="button"
        onClick={toggle}
        className="relative rounded-md p-2 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        title={unread > 0 ? tr("{0} nouvelle(s) notification(s)", [unread]) : tr("Notifications")}
      >
        <Bell className="h-5 w-5" />
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-bold text-white ring-2 ring-[#070D1A]" data-testid="notif-unread">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 z-50 mt-2 max-h-96 w-80 overflow-y-auto rounded-lg border border-border bg-[#0B1220] p-2 shadow-xl">
          {count === 0 ? (
            <p className="p-2 text-xs text-muted-foreground">{tr("Aucune notification")}</p>
          ) : (
            (q.data?.items ?? []).map((it) =>
              it.kind === "announcement" ? (
                <div key={it.id} className="my-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-2 text-xs" data-testid="notif-announcement">
                  <p className="flex items-center gap-1.5 font-semibold text-amber-200">
                    <Megaphone className="h-3.5 w-3.5 shrink-0" /> {it.title}
                    {it.unread && <span className="ml-auto h-2 w-2 shrink-0 rounded-full bg-red-500" />}
                  </p>
                  <p className="mt-0.5 whitespace-pre-line text-amber-50/90">{it.body}</p>
                </div>
              ) : (
                <div key={it.id} className="border-b border-border/50 px-2 py-1.5 text-xs last:border-0">
                  <p className="flex items-center gap-1.5 font-semibold text-[#9CCBF5]">
                    {it.title}
                    {it.unread && <span className="ml-auto h-2 w-2 shrink-0 rounded-full bg-red-500" />}
                  </p>
                  <p className="text-muted-foreground">{it.body}</p>
                </div>
              ),
            )
          )}
        </div>
      )}
    </div>
  );
}

function TopBar({ user, mode }: { user: User | undefined; mode: UiMode }) {
  return (
    <header className="z-40 flex h-14 shrink-0 items-center gap-2 border-b border-border bg-[#070D1A]/95 pl-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.5rem,env(safe-area-inset-right))] pt-[env(safe-area-inset-top)] backdrop-blur-md sm:gap-3" data-testid="top-bar">
      <Link to="/" className="flex shrink-0 items-center gap-2.5" data-testid="brand-link">
        <img src="/logo.png" alt={tr("SkyCommunity")} className="h-8 w-8 rounded-full bg-white ring-2 ring-[#4AA8F0]/40 sm:h-9 sm:w-9" data-testid="logo-slot" />
        <span className="hidden whitespace-nowrap text-base font-bold tracking-tight sm:inline">{tr("SkyCommunity")}{" "}<span className="text-[#4AA8F0]">{tr("Radar")}</span>
          <ThemeBadge />
        </span>
      </Link>
      <div className="ml-auto flex min-w-0 items-center gap-1.5 sm:gap-3">
        <UtcClock />
        <LangSwitch className="hidden sm:flex" />
        {user && <ModeSwitch user={user} mode={mode} />}
        <a
          href={DONATE_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded-md bg-gradient-to-r from-pink-600 to-rose-500 px-2.5 py-1.5 text-xs font-semibold text-white shadow-sm transition-[transform,filter] duration-150 hover:-translate-y-0.5 hover:brightness-110 sm:px-3 sm:text-sm"
          title={tr("Soutenir le projet")}
          data-testid="header-donate-link"
        >
          <Heart className="h-4 w-4 fill-white/90" />
          <span className="sm:hidden">{tr("Soutenir")}</span>
          <span className="hidden sm:inline">{tr("Soutenir le projet")}</span>
        </a>
        <a
          href={DISCORD_INVITE}
          target="_blank"
          rel="noopener noreferrer"
          className="hidden rounded-md bg-[#5865F2] p-2 text-white transition-[background-color,transform] duration-150 hover:-translate-y-0.5 hover:bg-[#4752C4] sm:block"
          title={tr("Serveur Discord SkyCommunity")}
          data-testid="header-discord-link"
        >
          <DiscordIcon className="h-5 w-5" />
        </a>
        {user && (
          <Link to="/profile" className="hidden items-center gap-2 md:flex" title={tr("Mon profil")} data-testid="current-user">
            {user.avatar_url ? (
              <img src={user.avatar_url} alt="" className="h-8 w-8 rounded-full ring-1 ring-border" />
            ) : (
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-secondary text-sm font-bold">{user.display_name.slice(0, 1).toUpperCase()}</span>
            )}
          </Link>
        )}
        {user && <NotifBell user={user} />}
        <LogoutButton />
      </div>
    </header>
  );
}

function navItems(user: User, mode: UiMode) {
  const items =
    mode === "atc"
      ? [
          { to: "/", label: tr("Radar"), icon: Radar, id: "radar" },
          { to: "/history", label: tr("Historique des vols"), icon: History, id: "history" },
          { to: "/signalements", label: tr("Signalements"), icon: AlertTriangle, id: "signalements" },
          { to: "/planning", label: tr("Planning ATC"), icon: CalendarDays, id: "planning" },
          { to: "/classement", label: tr("Classement"), icon: Trophy, id: "ranking" },
          { to: "/profile", label: tr("Profil"), icon: UserRound, id: "profile" },
        ]
      : [
          { to: "/", label: tr("Radar"), icon: Radar, id: "radar" },
          { to: "/flights/new", label: tr("Nouveau vol"), icon: PlusCircle, id: "new-flight" },
          { to: "/signalements", label: tr("Signalements"), icon: AlertTriangle, id: "signalements" },
          { to: "/planning", label: tr("Planning ATC"), icon: CalendarDays, id: "planning" },
          { to: "/classement", label: tr("Classement"), icon: Trophy, id: "ranking" },
          { to: "/profile", label: tr("Profil"), icon: UserRound, id: "profile" },
        ];
  if (isLead(user)) items.push({ to: "/suivi", label: tr("Suivi des membres"), icon: Activity, id: "suivi" });
  return user.role === "admin" ? [...items, { to: "/admin", label: tr("Administration"), icon: ShieldCheck, id: "admin" }] : items;
}

const isLead = (u: User) => u.access.admin || u.access.pilot_lead || u.access.atc_lead;

/** Reactivation requests waiting for this responsable (menu badge). */
function useActivityPending(user: User) {
  const q = useQuery<Record<string, { requests: number }>>({
    queryKey: ["activity-summary"],
    queryFn: () => apiGet("/activity/summary"),
    enabled: isLead(user) && user.role !== "aucun",
    refetchInterval: 60_000,
  });
  return Object.values(q.data ?? {}).reduce((n, k) => n + k.requests, 0);
}

/** Warning banner: this access will be suspended soon for inactivity. */
function InactivityBanner({ user, mode }: { user: User; mode: UiMode }) {
  const st = user.role === "admin" ? null : user.inactivity?.[mode];
  if (!st || st.state !== "bientot" || !st.deadline) return null;
  const day = new Date(st.deadline).toLocaleDateString(locale(), { day: "2-digit", month: "long", timeZone: "UTC" });
  return (
    <div className="flex items-start gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-100" data-testid="inactivity-banner">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
      <span>
        {mode === "atc"
          ? tr("Pas d'activité ATC depuis un moment : sans ouverture de position d'ici le {0}, votre accès ATC sera suspendu (règle d'inactivité de la communauté).", [day])
          : tr("Pas d'activité de vol depuis un moment : sans vol d'ici le {0}, votre accès Pilote sera suspendu (règle d'inactivité de la communauté).", [day])}
      </span>
    </div>
  );
}

/** Pending planning change requests, for administrators and the Responsable ATC (menu badge). */
function usePlanningPending(user: User) {
  const lead = user.access.atc_lead || user.access.admin;
  const q = useQuery<unknown[]>({
    queryKey: ["planning-requests", "pending"],
    queryFn: () => apiGet<unknown[]>("/planning/requests?status=pending"),
    enabled: lead && (user.role === "atc" || user.role === "admin"),
    refetchInterval: 30_000,
  });
  return lead ? q.data?.length ?? 0 : 0;
}

function Sidebar({ user, mode }: { user: User; mode: UiMode }) {
  const pending = usePlanningPending(user);
  const suivi = useActivityPending(user);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(SIDEBAR_KEY) === "1");
  const toggle = () =>
    setCollapsed((c) => {
      localStorage.setItem(SIDEBAR_KEY, c ? "0" : "1");
      return !c;
    });
  return (
    <motion.nav
      initial={false}
      animate={{ width: collapsed ? 64 : 224 }}
      transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
      className="relative z-30 hidden shrink-0 flex-col border-r border-border bg-[#0A1222] md:flex"
      data-testid="sidebar"
      data-collapsed={collapsed}
    >
      <div className="flex-1 space-y-1 p-2.5">
        {navItems(user, mode).map(({ to, label, icon: Icon, id }) => (
          <NavLink
            key={to}
            to={to}
            end={to === "/"}
            title={collapsed ? label : undefined}
            data-testid={`nav-${id}`}
            className={({ isActive }) =>
              cn(
                "group relative flex h-11 items-center gap-3 overflow-hidden rounded-lg px-3 text-[15px] font-medium transition-[background-color,color] duration-150",
                isActive ? "bg-[#2B63C9]/20 text-[#4AA8F0]" : "text-muted-foreground hover:bg-secondary hover:text-foreground",
              )
            }
          >
            <Icon className="h-5 w-5 shrink-0" />
            <span className={cn("whitespace-nowrap transition-opacity duration-150", collapsed ? "opacity-0" : "opacity-100")}>{label}</span>
            {id === "planning" && pending > 0 && (
              <span
                className={cn("rounded-full bg-amber-500 px-1.5 font-mono text-[11px] font-bold text-black", collapsed ? "absolute right-1.5 top-1.5" : "ml-auto")}
                title={tr("{0} demande(s) de modification à valider", [pending])}
                data-testid="nav-planning-badge"
              >
                {pending}
              </span>
            )}
            {id === "suivi" && suivi > 0 && (
              <span
                className={cn("rounded-full bg-amber-500 px-1.5 font-mono text-[11px] font-bold text-black", collapsed ? "absolute right-1.5 top-1.5" : "ml-auto")}
                title={tr("{0} demande(s) de réactivation", [suivi])}
                data-testid="nav-suivi-badge"
              >
                {suivi}
              </span>
            )}
            {collapsed && (
              <span className="pointer-events-none absolute left-14 z-50 hidden whitespace-nowrap rounded-md border border-border bg-popover px-2 py-1 text-xs text-foreground shadow-lg group-hover:block">
                {label}
              </span>
            )}
          </NavLink>
        ))}
      </div>
      <button
        onClick={toggle}
        className="m-2.5 flex h-10 items-center justify-center gap-2 rounded-lg border border-border text-sm text-muted-foreground transition-colors duration-150 hover:bg-secondary hover:text-foreground"
        title={collapsed ? tr("Développer le menu") : tr("Réduire le menu")}
        data-testid="sidebar-toggle"
      >
        {collapsed ? <PanelLeftOpen className="h-5 w-5" /> : <><PanelLeftClose className="h-5 w-5" />{" "}{tr("Réduire")}</>}
      </button>
    </motion.nav>
  );
}

/** Mobile: bottom tab bar with the same entries (short labels; leaves room for the iPhone home bar). */
const SHORT: Record<string, string> = labels({ radar: "Radar", "new-flight": "Nouveau", history: "Historique", planning: "Planning", ranking: "Classement", profile: "Profil", admin: "Admin", suivi: "Suivi" });
function MobileNav({ user, mode }: { user: User; mode: UiMode }) {
  const pending = usePlanningPending(user);
  const suivi = useActivityPending(user);
  return (
    <nav className="flex shrink-0 justify-around border-t border-border bg-[#0A1222] pb-[env(safe-area-inset-bottom)] md:hidden" data-testid="mobile-nav">
      {navItems(user, mode).map(({ to, label, icon: Icon, id }) => (
        <NavLink
          key={to}
          to={to}
          end={to === "/"}
          data-testid={`mobile-nav-${id}`}
          className={({ isActive }) =>
            cn("relative flex min-w-0 flex-1 flex-col items-center gap-0.5 py-2 text-[10px] leading-tight", isActive ? "text-[#4AA8F0]" : "text-muted-foreground")
          }
        >
          <Icon className="h-5 w-5" />
          <span className="max-w-full truncate px-0.5">{SHORT[id] ?? label.split(" ")[0]}</span>
          {id === "planning" && pending > 0 && (
            <span className="absolute right-[18%] top-1 rounded-full bg-amber-500 px-1 font-mono text-[9px] font-bold text-black">{pending}</span>
          )}
          {id === "suivi" && suivi > 0 && (
            <span className="absolute right-[18%] top-1 rounded-full bg-amber-500 px-1 font-mono text-[9px] font-bold text-black">{suivi}</span>
          )}
        </NavLink>
      ))}
    </nav>
  );
}

/** Auth gate + shell (fixed top bar, collapsible sidebar). */
export default function AppShell({ children }: { children: (user: User, mode: UiMode) => ReactNode }) {
  const me = useMe();
  const loc = useLocation();
  const mode = useUiMode(me.data);
  if (me.error instanceof ApiError && me.error.status === 401) {
    return <Navigate to="/login" replace state={{ from: loc.pathname + loc.search }} />;
  }
  if (me.data?.role === "aucun") return <Navigate to="/mode" replace state={{ from: loc.pathname + loc.search }} />;
  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <TopBar user={me.data} mode={mode} />
      <div className="flex min-h-0 flex-1">
        {me.data && <Sidebar user={me.data} mode={mode} />}
        <motion.main key={loc.pathname} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18 }} className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          {me.data && <InactivityBanner user={me.data} mode={mode} />}
          {me.data ? (
            children(me.data, mode)
          ) : (
            <div className="p-8 font-mono text-sm text-muted-foreground" data-testid="shell-loading">
              {me.isError ? tr("Serveur injoignable — nouvelle tentative automatique…") : tr("Chargement de la session…")}
            </div>
          )}
        </motion.main>
      </div>
      {me.data && <MobileNav user={me.data} mode={mode} />}
      {(me.data?.role === "atc" || me.data?.role === "admin") && <HandoverNotice />}
    </div>
  );
}
