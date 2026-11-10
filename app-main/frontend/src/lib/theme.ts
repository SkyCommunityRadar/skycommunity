import { useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";

/** Seasonal look of the site, chosen by the Créateur only (Administration) and shown to everyone. */
export type SiteTheme = "standard" | "noel" | "halloween" | "paques";

export const THEMES: { id: SiteTheme; label: string; emoji: string; hint: string }[] = [
  { id: "standard", label: "Standard", emoji: "✈️", hint: "L'apparence habituelle, sans décoration." },
  { id: "noel", label: "Noël", emoji: "🎄", hint: "Rouge, vert et or, guirlande lumineuse, bonnet de Noël sur le logo." },
  { id: "halloween", label: "Halloween", emoji: "🎃", hint: "Orange et violet, sang qui coule sous les menus, chapeau de sorcière." },
  { id: "paques", label: "Pâques", emoji: "🐣", hint: "Couleurs pastel, guirlande d'œufs, oreilles de lapin sur le logo." },
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

// ---------- preview: a theme shown only in this browser tab, the site's theme is unchanged ----------
const PREVIEW_KEY = "sc.theme.preview";
const PREVIEW_EVENT = "sc-theme-preview";

function readPreview(): SiteTheme | null {
  try {
    const v = sessionStorage.getItem(PREVIEW_KEY);
    return THEMES.some((t) => t.id === v) ? (v as SiteTheme) : null;
  } catch {
    return null;
  }
}

export function setThemePreview(t: SiteTheme | null) {
  try {
    if (t) sessionStorage.setItem(PREVIEW_KEY, t);
    else sessionStorage.removeItem(PREVIEW_KEY);
  } catch {
    /* storage blocked: no preview */
  }
  window.dispatchEvent(new Event(PREVIEW_EVENT));
}

export function useThemePreview(): SiteTheme | null {
  return useSyncExternalStore(
    (cb) => {
      window.addEventListener(PREVIEW_EVENT, cb);
      return () => window.removeEventListener(PREVIEW_EVENT, cb);
    },
    readPreview,
    () => null,
  );
}
