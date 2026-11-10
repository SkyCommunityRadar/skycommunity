import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";

/** Seasonal look of the site, chosen by the Créateur only (Administration) and shown to everyone. */
export type SiteTheme = "standard" | "noel" | "halloween" | "paques";

export const THEMES: { id: SiteTheme; label: string; emoji: string; hint: string }[] = [
  { id: "standard", label: "Standard", emoji: "✈️", hint: "L'apparence habituelle, sans décoration." },
  { id: "noel", label: "Noël", emoji: "🎄", hint: "Neige qui tombe, liseré rouge et vert." },
  { id: "halloween", label: "Halloween", emoji: "🎃", hint: "Chauves-souris, liseré orange et violet." },
  { id: "paques", label: "Pâques", emoji: "🐣", hint: "Œufs et fleurs, liseré pastel." },
];

export function useSiteTheme() {
  return useQuery<{ theme: SiteTheme; by: string | null; at: string | null }>({
    queryKey: ["site-theme"],
    queryFn: () => apiGet("/site/theme"),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    retry: false,
  });
}
