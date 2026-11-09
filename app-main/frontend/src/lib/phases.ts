import { labels, locale } from "@/lib/i18n";

export const PHASE_LABELS: Record<string, string> = labels({
  preparation: "Préparation",
  repoussage: "Repoussage",
  roulage: "Roulage",
  point_attente: "Point d'attente",
  alignement: "Alignement",
  decollage: "Décollage",
  en_route: "En route",
  approche: "En approche",
  atterrissage: "Atterrissage",
  roulage_arrivee: "Roulage arrivée",
  retour_parking: "Retour au parking",
  parking: "Au parking",
  termine: "Terminé",
  suspendu: "Suspendu",
  annule: "Annulé",
});

export const PHASE_COLORS: Record<string, string> = {
  preparation: "#94A3B8",
  repoussage: "#A855F7",
  roulage: "#38BDF8",
  point_attente: "#F59E0B",
  alignement: "#FBBF24",
  decollage: "#10B981",
  en_route: "#4AA8F0",
  approche: "#EC4899",
  atterrissage: "#10B981",
  roulage_arrivee: "#38BDF8",
  retour_parking: "#F97316",
  parking: "#64748B",
  termine: "#22C55E",
  suspendu: "#EAB308",
  annule: "#EF4444",
};

/** Phases where the aircraft moves by itself (a frozen progress only means something there). */
export const MOVING_PHASES = new Set(["roulage", "alignement", "decollage", "en_route", "approche", "roulage_arrivee", "retour_parking"]);
/** Phases on a taxiway. */
export const TAXIING_PHASES = new Set(["roulage", "alignement", "roulage_arrivee", "retour_parking"]);

export const ACTIVE_PHASES = Object.keys(PHASE_LABELS).filter((p) => p !== "termine" && p !== "annule");

export const ROLE_LABELS: Record<string, string> = labels({
  pilote: "Pilote",
  atc: "ATC",
  admin: "Administrateur",
  responsable_pilotes: "Responsable Pilotes",
  responsable_atc: "Responsable ATC",
  aucun: "Mode à choisir",
  systeme: "Système",
});

/** All times are shown in UTC, e.g. "15:15 UTC". */
export function fmtTime(iso: string): string {
  return `${new Date(iso).toISOString().slice(11, 16)} UTC`;
}

export function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString(locale(), { timeZone: "UTC" })} ${d.toISOString().slice(11, 16)} UTC`;
}

export function fmtDuration(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return `${h}h${String(m).padStart(2, "0")}`;
}

export function fmtAlt(ft: number | null): string {
  if (ft == null) return "—";
  return ft >= 5000 ? `FL${String(Math.round(ft / 100)).padStart(3, "0")}` : `${ft} ft`;
}

/** Ground distances in metres, rounded so they read naturally: 10 m steps (37 m -> 40 m, 1 846 m -> 1 850 m). */
export function fmtMeters(nm: number): string {
  const m = Math.round((nm * 1852) / 10) * 10;
  return `${m.toLocaleString(locale())} m`;
}
