import { useEffect, useState } from "react";
import { Download, Share, SquarePlus, X } from "lucide-react";
import { Button } from "@/components/ui/button";

import { tr } from "@/lib/i18n";
type PromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };

const standalone = () =>
  window.matchMedia?.("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

/** « Installer l'appli »: Android / Chrome use the browser's own install prompt; on iPhone the user is shown the
 * two taps to do in Safari. Hidden once the radar is already running as an installed app. */
export default function InstallApp({ compact = false }: { compact?: boolean }) {
  const [evt, setEvt] = useState<PromptEvent | null>(null);
  const [help, setHelp] = useState(false);
  const [installed, setInstalled] = useState(standalone());
  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setEvt(e as PromptEvent);
    };
    const onInstalled = () => setInstalled(true);
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);
  if (installed) return null;
  const ios = isIos();
  const install = async () => {
    if (evt) {
      await evt.prompt();
      if ((await evt.userChoice).outcome === "accepted") setInstalled(true);
      setEvt(null);
    } else setHelp(true);
  };
  return (
    <div className="space-y-2" data-testid="install-app">
      <Button variant="outline" size={compact ? "sm" : "default"} onClick={install} className="w-full" data-testid="install-app-button">
        <Download className="h-4 w-4" />{" "}{tr("Installer l'appli SkyCommunity Radar")}</Button>
      {help && (
        <div className="relative space-y-2 rounded-lg border border-[color:var(--sc-accent)]/40 bg-[color:var(--sc-accent)]/5 p-3 text-left text-xs leading-relaxed" data-testid="install-app-help">
          <button onClick={() => setHelp(false)} className="absolute right-2 top-2 text-muted-foreground" aria-label={tr("Fermer")}>
            <X className="h-4 w-4" />
          </button>
          {(ios ? ["ios", "android", "pc"] : ["android", "ios", "pc"]).map((k) =>
            k === "ios" ? (
              <div key={k} className="space-y-1" data-testid="install-help-ios">
                <p className="font-semibold">{tr("Sur iPhone / iPad :")}</p>
                <p>{tr("1. Ouvrez le site dans")}{" "}<b>{tr("Safari")}</b>{" "}{tr("(ou Chrome / Edge sur iOS 16.4 et plus).")}</p>
                <p>{tr("2. Appuyez sur")}{" "}<Share className="inline h-3.5 w-3.5" /> <b>{tr("Partager")}</b>{" "}{tr("en bas de l'écran.")}</p>
                <p>{tr("3. Choisissez")}{" "}<SquarePlus className="inline h-3.5 w-3.5" /> <b>{tr("« Sur l'écran d'accueil »")}</b>{tr(", puis")}{" "}<b>{tr("Ajouter")}</b>.</p>
              </div>
            ) : k === "android" ? (
              <div key={k} className="space-y-1" data-testid="install-help-android">
                <p className="font-semibold">{tr("Sur Android (Chrome) :")}</p>
                <p>{tr("Menu")}{" "}<b>⋮</b>{" "}{tr("en haut à droite →")}{" "}<b>{tr("« Installer l'application »")}</b>{" "}{tr("(ou « Ajouter à l'écran d'accueil »).")}</p>
              </div>
            ) : (
              <div key={k} className="space-y-1" data-testid="install-help-pc">
                <p className="font-semibold">{tr("Sur ordinateur (Chrome / Edge) :")}</p>
                <p>{tr("Icône d'installation à droite de la barre d'adresse.")}</p>
              </div>
            ),
          )}
          <p className="text-muted-foreground">{tr("L'icône SkyCommunity reste ensuite sur l'écran d'accueil et le radar s'ouvre en plein écran. Gratuit, sans store.")}</p>
        </div>
      )}
    </div>
  );
}
