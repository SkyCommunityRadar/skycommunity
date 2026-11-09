import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { beginSession } from "@/lib/session";

import { tr } from "@/lib/i18n";
/** Landing after the Discord callback (the session is an httpOnly cookie set by the server), then goes on. */
export default function DiscordDone() {
  const nav = useNavigate();
  useEffect(() => {
    window.history.replaceState(null, "", "/auth/discord");
    beginSession();
    nav("/mode", { replace: true });
  }, [nav]);
  return <div className="p-8 font-mono text-sm text-muted-foreground" data-testid="discord-done">{tr("Connexion Discord…")}</div>;
}
