import { Link } from "react-router-dom";
import LangSwitch from "@/components/LangSwitch";
import InstallApp from "@/components/InstallApp";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import AppShell from "@/components/AppShell";
import { FlightTable } from "@/pages/History";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiPatch } from "@/lib/api";
import { errMsg, useFlights } from "@/lib/hooks";
import { ROLE_LABELS } from "@/lib/phases";
import type { User } from "@/lib/types";
import { ProfileCard, usePublicProfile } from "@/pages/PilotProfile";
import { ReviewPanel } from "@/components/Reviews";
import { MyAbsences } from "@/components/Absences";

import { tr } from "@/lib/i18n";
function ProfileView({ user }: { user: User }) {
  const qc = useQueryClient();
  const mine = useFlights("mine");
  const pub = usePublicProfile(user.id);
  const [name, setName] = useState(user.display_name);
  const [sb, setSb] = useState(user.simbrief_id ?? "");
  const save = useMutation<User, unknown, void>({
    mutationFn: () => apiPatch<User>("/auth/me", { display_name: name, simbrief_id: sb.trim() || null }),
    onSuccess: (u) => {
      qc.setQueryData(["me"], u);
      toast.success(tr("Profil enregistré"));
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      {pub.data && <ProfileCard p={pub.data} />}
      <div className="grid gap-6 lg:grid-cols-2">
        <form
          className="space-y-3 rounded border border-border bg-card p-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <div className="text-xs text-muted-foreground" data-testid="profile-email">{tr("Compte Discord · rôle")}{" "}<b data-testid="profile-role">{ROLE_LABELS[user.role]}</b>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="p-name">{tr("Nom affiché")}</Label>
            <Input id="p-name" value={name} onChange={(e) => setName(e.target.value)} data-testid="profile-name-input" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="p-sb">{tr("Pilot ID SimBrief")}</Label>
            <Input id="p-sb" value={sb} onChange={(e) => setSb(e.target.value.replace(/\D/g, "").slice(0, 12))} className="font-mono" data-testid="profile-simbrief-input" />
          </div>
          <Button type="submit" disabled={save.isPending} data-testid="profile-save-button">{tr("Enregistrer")}</Button>
        </form>
      </div>
      <MyAbsences user={user} />
      <ReviewPanel />
      <div className="space-y-2">
        <h2 className="text-sm font-semibold">{tr("Mes vols")}</h2>
        <FlightTable flights={mine.data?.flights ?? []} testId="my-flights-table" />
      </div>
      <div className="mx-auto flex max-w-sm items-center justify-between rounded border border-border bg-card px-4 py-3 text-sm" data-testid="profile-language">
        <span>{tr("Langue de l'interface")}</span>
        <LangSwitch />
      </div>
      <div className="mx-auto max-w-sm">
        <InstallApp />
      </div>
      <p className="text-center text-xs text-muted-foreground">
        <Link to="/confidentialite" className="underline hover:text-foreground" data-testid="profile-privacy-link">{tr("Confidentialité et données personnelles")}</Link>
      </p>
    </div>
  );
}

export default function Profile() {
  return <AppShell>{(u) => <ProfileView user={u} />}</AppShell>;
}
