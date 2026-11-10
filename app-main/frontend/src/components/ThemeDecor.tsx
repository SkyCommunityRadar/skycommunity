import { useEffect, useMemo } from "react";
import { useSiteTheme, type SiteTheme } from "@/lib/theme";

const PARTICLES: Record<Exclude<SiteTheme, "standard">, { glyphs: string[]; count: number; slow: number }> = {
  noel: { glyphs: ["❄", "❅", "❆"], count: 28, slow: 1 },
  halloween: { glyphs: ["🦇", "🍂", "🕸️"], count: 10, slow: 1.4 },
  paques: { glyphs: ["🥚", "🌸", "🐣"], count: 12, slow: 1.3 },
};

/** Applies the site theme (html[data-theme]) and draws its decorations: light, never in the way of a click. */
export default function ThemeDecor() {
  const q = useSiteTheme();
  const theme: SiteTheme = q.data?.theme ?? "standard";
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  const items = useMemo(() => {
    if (theme === "standard") return [];
    const p = PARTICLES[theme];
    // deterministic spread: the same layout on every render, no flicker when the radar refreshes
    return Array.from({ length: p.count }, (_, i) => ({
      glyph: p.glyphs[i % p.glyphs.length],
      left: (i * 37.3) % 100,
      size: 10 + ((i * 7) % 9),
      duration: (9 + ((i * 13) % 11)) * p.slow,
      delay: -((i * 5.7) % 18),
      drift: ((i % 5) - 2) * 18,
    }));
  }, [theme]);
  if (theme === "standard") return null;
  return (
    <div className="theme-decor" aria-hidden data-testid={`theme-decor-${theme}`}>
      {items.map((it, i) => (
        <span
          key={i}
          className="theme-particle"
          style={{ left: `${it.left}%`, fontSize: it.size, animationDuration: `${it.duration}s`, animationDelay: `${it.delay}s`, ["--drift" as string]: `${it.drift}px` }}
        >
          {it.glyph}
        </span>
      ))}
    </div>
  );
}

/** Small seasonal mark next to the site name. */
export function ThemeBadge() {
  const q = useSiteTheme();
  const t = q.data?.theme ?? "standard";
  const emoji = t === "noel" ? "🎄" : t === "halloween" ? "🎃" : t === "paques" ? "🐣" : null;
  return emoji ? <span className="ml-1 select-none" aria-hidden data-testid="theme-badge">{emoji}</span> : null;
}
