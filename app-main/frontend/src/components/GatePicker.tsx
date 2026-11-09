import { useId } from "react";
import { Input } from "@/components/ui/input";
import { useGround } from "@/lib/hooks";

import { tr } from "@/lib/i18n";
/** Stand/gate picker fed by the airport's real OpenStreetMap stands (searchable list). */
export default function GatePicker({
  icao,
  value,
  onChange,
  testId,
}: {
  icao: string;
  value: string;
  onChange: (v: string) => void;
  testId: string;
}) {
  const g = useGround(icao);
  const listId = useId();
  const known = new Set((g.data?.gates ?? []).map((x) => x.ref));
  const invalid = value !== "" && g.data && !known.has(value);
  return (
    <div className="space-y-1">
      <Input
        list={listId}
        value={value}
        onChange={(e) => onChange(e.target.value.toUpperCase().trim())}
        placeholder={g.isLoading ? tr("Chargement des postes…") : tr("ex. F22, K41…")}
        disabled={g.isLoading}
        className="h-8 font-mono text-xs uppercase"
        data-testid={testId}
      />
      <datalist id={listId}>
        {(g.data?.gates ?? []).map((x) => (
          <option key={x.ref} value={x.ref} />
        ))}
      </datalist>
      <p className="text-[10px] text-muted-foreground" data-testid={`${testId}-status`}>
        {g.isLoading && tr("Chargement du plan au sol de {0} (OpenStreetMap, jusqu'à 1 min la première fois)…", [icao])}
        {g.isError && <span className="text-red-400">{tr("Plan au sol de {0} indisponible pour le moment — réessayez plus tard.", [icao])}</span>}
        {g.data && !invalid && tr("{0} postes disponibles à {1}", [g.data.gates.length, icao])}
        {invalid && <span className="text-red-400">{tr("Poste inconnu à {0}.", [icao])}</span>}
      </p>
    </div>
  );
}
