import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

import { tr } from "@/lib/i18n";
/** Two-step button for dangerous actions, shown inside the page (browser confirm() pop-ups can be blocked
 * silently, which made the button look broken). The confirmation disappears by itself after 10 s, and a too-quick
 * second click (accidental double-click) is ignored. */
export default function ConfirmButton({
  label, confirmLabel = "Confirmer", onConfirm, disabled, size = "sm", testId, className,
}: {
  label: React.ReactNode;
  confirmLabel?: React.ReactNode;
  onConfirm: () => void;
  disabled?: boolean;
  size?: "xs" | "sm" | "default";
  testId: string;
  className?: string;
}) {
  const [ask, setAsk] = useState(false);
  const armedAt = useRef(0);
  useEffect(() => {
    if (!ask) return;
    armedAt.current = Date.now();
    const t = window.setTimeout(() => setAsk(false), 10000);
    return () => window.clearTimeout(t);
  }, [ask]);
  if (!ask)
    return (
      <Button size={size} variant="destructive" disabled={disabled} onClick={() => setAsk(true)} className={className} data-testid={testId}>
        {label}
      </Button>
    );
  return (
    <span className="inline-flex flex-wrap items-center gap-1" data-testid={`${testId}-confirm`}>
      <Button
        size={size}
        variant="destructive"
        disabled={disabled}
        onClick={() => {
          if (Date.now() - armedAt.current < 400) return; // double-click on the first button: not a confirmation
          setAsk(false);
          onConfirm();
        }}
        className="ring-2 ring-red-400/60"
        data-testid={`${testId}-yes`}
      >
        {confirmLabel}
      </Button>
      <Button size={size} variant="ghost" onClick={() => setAsk(false)} data-testid={`${testId}-no`}>{tr("Annuler")}</Button>
    </span>
  );
}
