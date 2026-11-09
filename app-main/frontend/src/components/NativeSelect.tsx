import type { SelectHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

/** Small styled native select — predictable for dense admin/ATC forms. */
export default function NativeSelect({ className, ...p }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...p}
      className={cn(
        "h-8 rounded-md border border-input bg-background px-2 text-xs font-mono outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        className,
      )}
    />
  );
}
