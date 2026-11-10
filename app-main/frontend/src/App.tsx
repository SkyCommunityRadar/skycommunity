import { Component, lazy, Suspense, useEffect, useRef, type ReactNode } from "react";
import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { tr } from "@/lib/i18n";
import ThemeDecor from "@/components/ThemeDecor";

// Each page is its own download: a phone opening the login page does not load the map engine (~1 MB) first.
// The loaders are shared by lazy() and by the idle prefetch below (a dynamic import() is only fetched once).
const pages = {
  Radar: () => import("@/pages/Radar"),
  Login: () => import("@/pages/Login"),
  FlightDetail: () => import("@/pages/FlightDetail"),
  NewFlight: () => import("@/pages/NewFlight"),
  History: () => import("@/pages/History"),
  Profile: () => import("@/pages/Profile"),
  Admin: () => import("@/pages/Admin"),
  Airports: () => import("@/pages/Airports"),
  Mode: () => import("@/pages/Mode"),
  Ranking: () => import("@/pages/Ranking"),
  Planning: () => import("@/pages/Planning"),
  PilotProfile: () => import("@/pages/PilotProfile"),
  DiscordDone: () => import("@/pages/DiscordDone"),
  Confidentialite: () => import("@/pages/Confidentialite"),
  Suivi: () => import("@/pages/Suivi"),
  Signalements: () => import("@/pages/Signalements"),
};

const Radar = lazy(pages.Radar);
const Login = lazy(pages.Login);
const FlightDetail = lazy(pages.FlightDetail);
const NewFlight = lazy(pages.NewFlight);
const History = lazy(pages.History);
const Profile = lazy(pages.Profile);
const Admin = lazy(pages.Admin);
const Airports = lazy(pages.Airports);
const Mode = lazy(pages.Mode);
const Ranking = lazy(pages.Ranking);
const Planning = lazy(pages.Planning);
const PilotProfile = lazy(pages.PilotProfile);
const DiscordDone = lazy(pages.DiscordDone);
const Confidentialite = lazy(pages.Confidentialite);
const Suivi = lazy(pages.Suivi);
const Signalements = lazy(pages.Signalements);

function PageLoading() {
  return (
    <div className="flex h-dvh items-center justify-center bg-background" data-testid="page-loading">
      <span className="h-6 w-6 animate-spin rounded-full border-2 border-[#4AA8F0] border-t-transparent" />
    </div>
  );
}

/** True when a page chunk could not be downloaded (offline, or an old chunk deleted by a new deploy). */
const isChunkError = (e: unknown) => /dynamically imported module|importing a module script|loading chunk|ChunkLoadError|failed to fetch/i.test(`${(e as Error)?.name ?? ""} ${(e as Error)?.message ?? e}`);

/**
 * A page that fails (download or render error) used to leave a blank screen.
 * Show a message with a reload button instead; it resets itself when the user navigates elsewhere.
 */
class PageErrorBoundary extends Component<{ resetKey: string; children: ReactNode }, { failed: boolean; chunk: boolean }> {
  state = { failed: false, chunk: false };

  static getDerivedStateFromError(error: unknown) {
    return { failed: true, chunk: isChunkError(error) };
  }

  componentDidCatch(error: unknown) {
    console.error("Page error:", error);
  }

  componentDidUpdate(prev: { resetKey: string }) {
    if (this.state.failed && prev.resetKey !== this.props.resetKey) this.setState({ failed: false, chunk: false });
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-3 bg-background p-6 text-center" data-testid="page-error">
        <p className="max-w-sm text-sm text-muted-foreground">
          {this.state.chunk
            ? tr("Impossible de charger la page. Vérifiez votre connexion, puis rechargez (une nouvelle version a peut-être été publiée).")
            : tr("Une erreur est survenue sur cette page. Rechargez, ou revenez à l'accueil.")}
        </p>
        <div className="flex gap-2">
          <Button onClick={() => window.location.reload()}>{tr("Recharger")}</Button>
          <Button variant="outline" onClick={() => window.location.assign("/")}>
            {tr("Accueil")}
          </Button>
        </div>
      </div>
    );
  }
}

// One <Route> per page in src/pages; BrowserRouter already wraps this in main.tsx.
export default function App() {
  const loc = useLocation();
  const prefetched = useRef(false);

  // Without this, the first visit to each page replaced the whole screen (top bar + menu included) with the
  // spinner while its chunk downloaded. Fetch them quietly once the user is past the login page.
  useEffect(() => {
    if (prefetched.current || loc.pathname === "/login") return;
    const t = window.setTimeout(() => {
      prefetched.current = true;
      Object.values(pages).forEach((load) => void load().catch(() => undefined));
    }, 1500);
    return () => window.clearTimeout(t);
  }, [loc.pathname]);

  return (
    <>
    <ThemeDecor />
    <PageErrorBoundary resetKey={loc.pathname}>
      <Suspense fallback={<PageLoading />}>
        <Routes>
          <Route path="/" element={<Radar />} />
          <Route path="/login" element={<Login />} />
          <Route path="/confidentialite" element={<Confidentialite />} />
          <Route path="/mode" element={<Mode />} />
          <Route path="/flights/new" element={<NewFlight />} />
          <Route path="/flights/:id" element={<FlightDetail />} />
          <Route path="/history" element={<History />} />
          <Route path="/airports" element={<Airports />} />
          <Route path="/profile" element={<Profile />} />
          <Route path="/classement" element={<Ranking />} />
          <Route path="/planning" element={<Planning />} />
          <Route path="/pilotes/:id" element={<PilotProfile />} />
          <Route path="/auth/discord" element={<DiscordDone />} />
          <Route path="/admin" element={<Admin />} />
          <Route path="/suivi" element={<Suivi />} />
          <Route path="/signalements" element={<Signalements />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </PageErrorBoundary>
    </>
  );
}