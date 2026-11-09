import { PHASE_COLORS, PHASE_LABELS } from "@/lib/phases";

export function PhaseBadge({ phase, testId }: { phase: string; testId?: string }) {
  const c = PHASE_COLORS[phase] ?? "#94A3B8";
  return (
    <span
      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide border"
      style={{ color: c, borderColor: `${c}66`, background: `${c}14` }}
      data-testid={testId ?? "phase-badge"}
      data-phase={phase}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: c }} />
      {PHASE_LABELS[phase] ?? phase}
    </span>
  );
}

