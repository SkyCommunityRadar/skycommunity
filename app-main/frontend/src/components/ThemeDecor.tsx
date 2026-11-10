import { useEffect, type ReactNode } from "react";
import { THEMES, setThemePreview, useSiteTheme, useThemePreview, type SiteTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { tr } from "@/lib/i18n";

export function useThemeId(): SiteTheme {
  const site = useSiteTheme().data?.theme ?? "standard";
  return useThemePreview() ?? site;
}

/** Applies the site theme (html[data-theme]): the colours of the whole interface follow it (index.css).
 * While a preview is on (Espace Créateur, this tab only), a small banner says so and lets you leave it. */
export default function ThemeDecor() {
  const theme = useThemeId();
  const preview = useThemePreview();
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  if (!preview) return null;
  const label = THEMES.find((t) => t.id === preview)?.label ?? preview;
  return (
    <div className="fixed bottom-20 left-1/2 z-[1000] flex -translate-x-1/2 items-center gap-3 rounded-full border border-amber-400/60 bg-black/85 px-4 py-2 text-xs text-amber-100 shadow-xl md:bottom-6" data-testid="theme-preview-banner">
      <span>{tr("Aperçu du thème {0} : visible seulement dans cet onglet", [tr(label)])}</span>
      <button type="button" onClick={() => setThemePreview(null)} className="rounded-full bg-amber-400 px-3 py-1 font-semibold text-black hover:bg-amber-300" data-testid="theme-preview-exit">
        {tr("Quitter l'aperçu")}
      </button>
    </div>
  );
}

// ---------- garlands hanging under the top bar / on top of the login card ----------

const LIGHTS = ["#E53935", "#FBC02D", "#43A047", "#F5F5F5"];
const EGGS = ["#F9A8D4", "#FDE68A", "#A7F3D0", "#C4B5FD", "#BAE6FD"];
const rnd = (n: number) => {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
};

function LightString() {
  const W = 56, N = 80;
  return (
    <svg width={W * N} height={24} className="block">
      {Array.from({ length: N }, (_, i) => {
        const x = i * W, c = LIGHTS[i % LIGHTS.length];
        return (
          <g key={i}>
            <path d={`M${x} 2 Q${x + W / 2} 13 ${x + W} 2`} fill="none" stroke="#14532D" strokeWidth={1.6} />
            <rect x={x + W / 2 - 2} y={6.5} width={4} height={3.2} rx={1} fill="#9CA3AF" />
            <ellipse cx={x + W / 2} cy={14.5} rx={3.7} ry={5.4} fill={c} style={{ color: c }} className={`theme-bulb theme-bulb-${i % 3}`} />
          </g>
        );
      })}
    </svg>
  );
}

function BloodDrips() {
  const W = 120, N = 40;
  const drips: ReactNode[] = [];
  for (let i = 0; i < N; i++) {
    for (let k = 0; k < 3; k++) {
      const r = rnd(i * 3 + k + 1);
      const x = i * W + 8 + k * 38 + Math.round(r * 16);
      const w = 3 + Math.round(r * 2.5);
      const y = 7 + Math.round(rnd(i * 7 + k) * 20);
      drips.push(
        <g key={`${i}-${k}`}>
          <path d={`M${x - 3} 3 C${x} 3 ${x} 5 ${x} 8 L${x} ${y} A${w / 2} ${w / 2} 0 0 0 ${x + w} ${y} L${x + w} 8 C${x + w} 5 ${x + w} 3 ${x + w + 3} 3 Z`} fill="url(#sc-blood)" />
          <path d={`M${x + w * 0.3} 9 V${y - 1}`} stroke="rgba(255,255,255,0.22)" strokeWidth={0.8} />
          {r > 0.6 && <circle cx={x + w / 2} cy={y + w + 3} r={w * 0.55} fill="#A10F1A" />}
        </g>,
      );
    }
  }
  return (
    <svg width={W * N} height={36} className="block">
      <defs>
        <linearGradient id="sc-blood" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#5E0000" />
          <stop offset="1" stopColor="#C1121F" />
        </linearGradient>
      </defs>
      <rect x={0} y={0} width={W * N} height={3.5} fill="#5E0000" />
      {drips}
    </svg>
  );
}

function EggBunting() {
  const W = 60, N = 70;
  return (
    <svg width={W * N} height={28} className="block">
      {Array.from({ length: N }, (_, i) => {
        const x = i * W, cx = x + W / 2, c = EGGS[i % EGGS.length];
        return (
          <g key={i}>
            <path d={`M${x} 2 Q${cx} 12 ${x + W} 2`} fill="none" stroke="#E9D5FF" strokeWidth={1.3} />
            <line x1={cx} y1={7} x2={cx} y2={9.5} stroke="#E9D5FF" strokeWidth={1} />
            <ellipse cx={cx} cy={16.5} rx={5.4} ry={7} fill={c} stroke="rgba(0,0,0,0.18)" strokeWidth={0.5} />
            {i % 3 === 0 && <polyline points={`${cx - 4.3},16.5 ${cx - 2.6},14.8 ${cx - 0.9},16.5 ${cx + 0.8},14.8 ${cx + 2.5},16.5 ${cx + 4.2},14.8`} fill="none" stroke="#FFFFFF" strokeWidth={1.1} />}
            {i % 3 === 1 && <><circle cx={cx - 1.8} cy={14} r={1} fill="#FFFFFF" /><circle cx={cx + 2} cy={16.5} r={1} fill="#FFFFFF" /><circle cx={cx - 0.8} cy={19.5} r={1} fill="#FFFFFF" /></>}
            {i % 3 === 2 && <rect x={cx - 5.2} y={16.2} width={10.4} height={2.2} fill="#FFFFFF" opacity={0.85} />}
          </g>
        );
      })}
    </svg>
  );
}

export function ThemeGarland({ className }: { className?: string }) {
  const t = useThemeId();
  if (t === "standard") return null;
  return (
    <div aria-hidden className={cn("pointer-events-none overflow-hidden", className)} data-testid={`theme-garland-${t}`}>
      {t === "noel" ? <LightString /> : t === "halloween" ? <BloodDrips /> : <EggBunting />}
    </div>
  );
}

// ---------- on the logo: Santa hat, witch hat, bunny ears ----------

export function ThemeHat({ size = "sm" }: { size?: "sm" | "lg" }) {
  const t = useThemeId();
  if (t === "standard") return null;
  const k = size === "lg" ? 2.7 : 1;
  // the small logo sits 10 px under the top of the screen: the hats must stay inside it
  const top = (lg: number, sm: number) => (size === "lg" ? lg * k : sm);
  if (t === "paques") {
    return (
      <svg aria-hidden viewBox="0 0 40 34" className="pointer-events-none absolute" style={{ left: "50%", top: top(-17, -10), width: 30 * k, transform: "translateX(-50%)", zIndex: 0 }} data-testid="theme-hat">
        <ellipse cx={13} cy={16} rx={5.6} ry={14} transform="rotate(-14 13 16)" fill="#F8FAFC" stroke="#CBD5E1" strokeWidth={0.6} />
        <ellipse cx={13} cy={17} rx={2.8} ry={10} transform="rotate(-14 13 17)" fill="#F9A8D4" />
        <ellipse cx={27} cy={16} rx={5.6} ry={14} transform="rotate(12 27 16)" fill="#F8FAFC" stroke="#CBD5E1" strokeWidth={0.6} />
        <ellipse cx={27} cy={17} rx={2.8} ry={10} transform="rotate(12 27 17)" fill="#F9A8D4" />
      </svg>
    );
  }
  if (t === "noel") {
    return (
      <svg aria-hidden viewBox="0 0 44 34" className="pointer-events-none absolute" style={{ left: -10 * k, top: top(-15, -10), width: 33 * k, transform: "rotate(-20deg)", zIndex: 2 }} data-testid="theme-hat">
        <path d="M6 25 C9 12 17 4 27 5 C34 6 38 11 39 18 C36 14 32 12.5 29 13.5 C26 15 27.5 21 30 25 Z" fill="#D32F2F" stroke="#8E1B1B" strokeWidth={0.8} />
        <rect x={3} y={23} width={30} height={8} rx={4} fill="#F8FAFC" stroke="#CBD5E1" strokeWidth={0.6} />
        <circle cx={39} cy={19.5} r={4.2} fill="#F8FAFC" stroke="#CBD5E1" strokeWidth={0.6} />
      </svg>
    );
  }
  return (
    <svg aria-hidden viewBox="0 0 42 36" className="pointer-events-none absolute" style={{ left: -8 * k, top: top(-19, -6), width: 30 * k, transform: "rotate(-14deg)", zIndex: 2 }} data-testid="theme-hat">
      <ellipse cx={21} cy={30} rx={20} ry={4.5} fill="#1F1030" stroke="#7C3AED" strokeWidth={0.8} />
      <path d="M10 29 C14 21 17 12 21 4 C22.5 1.5 26 2 28.5 5.5 C26 6 24.5 8.5 25.5 13 C27 19 29.5 24 32 29 Z" fill="#2E1747" stroke="#7C3AED" strokeWidth={0.8} />
      <path d="M11.5 24.5 H30.5 L31.6 27.6 H10.4 Z" fill="#F97316" />
      <rect x={18.5} y={24} width={5} height={4.2} rx={0.6} fill="none" stroke="#FDE68A" strokeWidth={1} />
    </svg>
  );
}

// ---------- little scene at the bottom of the side menu ----------

function Tree({ x, y, s, star = false }: { x: number; y: number; s: number; star?: boolean }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${s})`}>
      <rect x={-2} y={-4} width={4} height={5} fill="#6B4423" />
      <path d="M0 -22 L15 -3 H-15 Z" fill="#1E7B45" />
      <path d="M0 -30 L12 -13 H-12 Z" fill="#23904F" />
      <path d="M0 -37 L9 -22 H-9 Z" fill="#2BA85E" />
      <circle cx={-6} cy={-7} r={1.6} fill="#E53935" /><circle cx={5} cy={-10} r={1.6} fill="#FBC02D" /><circle cx={-2} cy={-18} r={1.4} fill="#E53935" />
      {star && <path d="M0 -42 l1.4 3 3.2.3-2.4 2.1.7 3.2L0 -35.7l-2.9 1.6.7-3.2-2.4-2.1 3.2-.3z" fill="#FBC02D" />}
    </g>
  );
}

function Pumpkin({ x, y, r }: { x: number; y: number; r: number }) {
  return (
    <g>
      <rect x={x - 1} y={y - r - 3} width={2} height={4} rx={1} fill="#3F6212" />
      <ellipse cx={x} cy={y} rx={r * 1.3} ry={r} fill="#EA580C" />
      <ellipse cx={x} cy={y} rx={r * 0.55} ry={r} fill="none" stroke="#C2410C" strokeWidth={0.8} />
      <path d={`M${x - r * 0.65} ${y - r * 0.25} l${r * 0.25} ${-r * 0.3} l${r * 0.25} ${r * 0.3}Z M${x + r * 0.15} ${y - r * 0.25} l${r * 0.25} ${-r * 0.3} l${r * 0.25} ${r * 0.3}Z`} fill="#FDE047" />
      <path d={`M${x - r * 0.6} ${y + r * 0.25} l${r * 0.3} ${r * 0.2} l${r * 0.3} ${-r * 0.2} l${r * 0.3} ${r * 0.2} l${r * 0.3} ${-r * 0.2}`} fill="none" stroke="#FDE047" strokeWidth={1} />
    </g>
  );
}

function Flower({ x, y, c }: { x: number; y: number; c: string }) {
  return (
    <g>
      <line x1={x} y1={y} x2={x} y2={y + 10} stroke="#2F855A" strokeWidth={1.2} />
      {[0, 72, 144, 216, 288].map((a) => (
        <circle key={a} cx={x + 2.6 * Math.cos((a * Math.PI) / 180)} cy={y + 2.6 * Math.sin((a * Math.PI) / 180)} r={2} fill={c} />
      ))}
      <circle cx={x} cy={y} r={1.5} fill="#FDE047" />
    </g>
  );
}

export function ThemeScene() {
  const t = useThemeId();
  if (t === "standard") return null;
  return (
    <div aria-hidden className="pointer-events-none h-[72px] w-full shrink-0 overflow-hidden" data-testid={`theme-scene-${t}`}>
      <svg viewBox="0 0 224 72" preserveAspectRatio="xMidYMax slice" className="h-full w-full">
        {t === "noel" && (
          <>
            {[[20, 12], [70, 20], [130, 8], [160, 24], [205, 14], [100, 30]].map(([x, y]) => <circle key={`${x}`} cx={x} cy={y} r={0.9} fill="#FFFFFF" opacity={0.55} />)}
            <path d="M0 54 Q30 46 62 52 T130 50 T190 53 T224 49 V72 H0 Z" fill="#E6EEF5" />
            <path d="M0 61 Q50 56 110 61 T224 59 V72 H0 Z" fill="#CFDCE8" />
            <Tree x={30} y={55} s={1} star />
            <Tree x={58} y={54} s={0.72} />
            <Tree x={192} y={54} s={0.9} star />
            <Tree x={168} y={55} s={0.6} />
            <rect x={102} y={44} width={18} height={13} rx={1} fill="#C62828" />
            <rect x={109.5} y={44} width={3} height={13} fill="#FBC02D" /><rect x={102} y={49} width={18} height={3} fill="#FBC02D" />
            <ellipse cx={108} cy={43} rx={3.2} ry={2} fill="#FBC02D" /><ellipse cx={114} cy={43} rx={3.2} ry={2} fill="#FBC02D" />
            <rect x={123} y={49} width={12} height={9} rx={1} fill="#2E7D32" /><rect x={128} y={49} width={2.2} height={9} fill="#F8FAFC" />
          </>
        )}
        {t === "halloween" && (
          <>
            <circle cx={196} cy={17} r={10} fill="#FDE68A" opacity={0.8} />
            <path d="M186 20 q3 -4 6 0 q2 -3 4 0 q3 -4 6 0 q-3 1 -4 4 q-2 -2 -4 0 q-2 -2 -4 0 q-1 -3 -4 -4z" fill="#0B0610" />
            <path d="M140 12 q2 -3 4 0 q1.5 -2 3 0 q2 -3 4 0 q-2 1 -3 3 q-1.5 -1.5 -3 0 q-1.5 -1.5 -3 0 q-1 -2 -2 -3z" fill="#0B0610" />
            <path d="M0 56 Q40 46 90 54 T170 52 T224 55 V72 H0 Z" fill="#1E0F2B" />
            <path d="M22 56 C22 44 20 36 24 24 M23 42 C17 37 14 33 12 28 M24 34 C29 30 33 29 36 25 M22 47 C27 45 30 43 33 40" stroke="#05030A" strokeWidth={2.4} strokeLinecap="round" fill="none" />
            <path d="M58 57 V45 a7 7 0 0 1 14 0 V57 Z" fill="#4B4458" />
            <text x={65} y={50} fontSize={4.5} textAnchor="middle" fill="#2A2433" fontWeight={700}>RIP</text>
            <path d="M80 58 V50 a5 5 0 0 1 10 0 V58 Z" fill="#3D3748" />
            <Pumpkin x={140} y={55} r={7} />
            <Pumpkin x={162} y={58} r={5} />
            <path d="M100 58 q4 -3 9 0 q5 2 9 0" fill="none" stroke="#7F1D1D" strokeWidth={2.5} strokeLinecap="round" />
          </>
        )}
        {t === "paques" && (
          <>
            <path d="M0 58 Q56 50 112 56 T224 54 V72 H0 Z" fill="#3F9E5A" />
            {Array.from({ length: 45 }, (_, i) => {
              const x = i * 5, h = 5 + ((i * 7) % 6);
              return <path key={i} d={`M${x} 58 l2 ${-h} l2 ${h}`} fill={i % 2 ? "#55B96F" : "#4CAF64"} />;
            })}
            <Flower x={18} y={44} c="#F9A8D4" />
            <Flower x={74} y={46} c="#FFFFFF" />
            <Flower x={150} y={44} c="#C4B5FD" />
            <Flower x={210} y={45} c="#F9A8D4" />
            <ellipse cx={45} cy={57} rx={5} ry={6.5} fill="#FDE68A" />
            <polyline points="41,57 43,55 45,57 47,55 49,57" fill="none" stroke="#FFFFFF" strokeWidth={1} />
            <ellipse cx={120} cy={58} rx={5} ry={6.5} fill="#F9A8D4" />
            <circle cx={118.5} cy={56} r={0.9} fill="#FFFFFF" /><circle cx={121.5} cy={58.5} r={0.9} fill="#FFFFFF" />
            <ellipse cx={178} cy={57} rx={5} ry={6.5} fill="#BAE6FD" />
            <rect x={173.2} y={56.5} width={9.6} height={2} fill="#FFFFFF" opacity={0.85} />
            <circle cx={96} cy={54} r={6} fill="#FDE047" />
            <ellipse cx={93} cy={55} rx={2.5} ry={1.8} fill="#FACC15" />
            <circle cx={98} cy={52} r={0.9} fill="#1F2937" />
            <path d="M101.5 53.5 l3 0.8 l-3 0.8 Z" fill="#F97316" />
          </>
        )}
      </svg>
    </div>
  );
}

/** One-line seasonal greeting (login page). */
export function ThemeGreeting({ className }: { className?: string }) {
  const t = useThemeId();
  const text = t === "noel" ? tr("Joyeuses fêtes de fin d'année !") : t === "halloween" ? tr("Joyeux Halloween !") : t === "paques" ? tr("Joyeuses Pâques !") : null;
  return text ? <p className={className} data-testid="theme-greeting">{text}</p> : null;
}
