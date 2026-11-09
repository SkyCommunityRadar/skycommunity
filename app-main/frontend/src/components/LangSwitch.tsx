import { setLang, useLang, type Lang } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** FR / EN: interface language, remembered on this device. */
export default function LangSwitch({ className }: { className?: string }) {
  const lang = useLang();
  return (
    <div className={cn("flex rounded-md border border-border bg-background/60 p-0.5 text-[11px] font-semibold", className)} role="radiogroup" aria-label="Langue / Language" data-testid="lang-switch">
      {(["fr", "en"] as Lang[]).map((l) => (
        <button
          key={l}
          role="radio"
          aria-checked={lang === l}
          onClick={() => void setLang(l)}
          className={cn("rounded px-1.5 py-0.5 uppercase transition-colors", lang === l ? "bg-[#2B63C9] text-white" : "text-muted-foreground hover:text-foreground")}
          title={l === "fr" ? "Français" : "English"}
          data-testid={`lang-${l}`}
        >
          {l}
        </button>
      ))}
    </div>
  );
}
