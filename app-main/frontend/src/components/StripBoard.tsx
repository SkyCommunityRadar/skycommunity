import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Lock, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PhaseBadge } from "@/components/Badges";
import { apiGet, apiPut } from "@/lib/api";
import { errMsg } from "@/lib/hooks";
import { fmtTime } from "@/lib/phases";
import type { AltUnit, Strip, StripIn } from "@/lib/types";

import { tr } from "@/lib/i18n";
type Form = {
  squawk: string; initial_alt: string; initial_alt_unit: AltUnit; cruise_fl: string;
  approach_alt: string; approach_alt_unit: AltUnit; remarks: string;
  dep_rwy: string; sid: string; star: string; arr_rwy: string;
};

const toForm = (s: Strip): Form => ({
  squawk: s.squawk ?? "",
  initial_alt: s.initial_alt?.toString() ?? "",
  initial_alt_unit: s.initial_alt_unit,
  cruise_fl: s.cruise_fl?.toString() ?? "",
  approach_alt: s.approach_alt?.toString() ?? "",
  approach_alt_unit: s.approach_alt_unit,
  remarks: s.remarks ?? "",
  dep_rwy: s.dep_rwy ?? "", sid: s.sid ?? "", star: s.star ?? "", arr_rwy: s.arr_rwy ?? "",
});
type ProcField = "dep_rwy" | "sid" | "star" | "arr_rwy";
const PROC: { k: ProcField; label: string; ph: string; max: number }[] = [
  { k: "dep_rwy", label: "Piste départ", ph: "27R", max: 5 },
  { k: "sid", label: "SID", ph: "OPALE5A", max: 12 },
  { k: "star", label: "STAR", ph: "MOPA7W", max: 12 },
  { k: "arr_rwy", label: "Piste arrivée", ph: "04", max: 5 },
];
const num = (v: string) => (v.trim() === "" ? null : Number(v));
/** FT values are shown "5000 FT", FL values "FL060": the unit is never implicit. */
export const fmtAltUnit = (v: number | null, u: AltUnit) => (v == null ? "—" : u === "FL" ? `FL${String(v).padStart(3, "0")}` : `${v} FT`);

type NumField = "squawk" | "initial_alt" | "cruise_fl" | "approach_alt";
const FIELDS: { k: NumField; label: string; ph: string; max: number; unit?: "initial_alt_unit" | "approach_alt_unit" }[] = [
  { k: "squawk", label: "Transpondeur", ph: "7000", max: 4 },
  { k: "cruise_fl", label: "Croisière (FL)", ph: "350", max: 3 },
  { k: "initial_alt", label: "Montée initiale", ph: "5000", max: 5, unit: "initial_alt_unit" },
  { k: "approach_alt", label: "Approche", ph: "3000", max: 5, unit: "approach_alt_unit" },
];

function StripCard({ s, selected, onSelect }: { s: Strip; selected: boolean; onSelect?: (id: string) => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState<Form | null>(null);
  const m = useMutation({
    mutationFn: (body: StripIn) => apiPut<Strip>(`/strips/${s.flight_id}`, body),
    onSuccess: () => {
      toast.success(tr("Strip {0} mis à jour", [s.callsign]));
      setForm(null);
    },
    onError: (e) => toast.error(errMsg(e)),
    onSettled: () => qc.invalidateQueries({ queryKey: ["strips"] }),
  });
  const id = s.callsign.toLowerCase();
  const save = () => {
    if (!form) return;
    if (form.squawk && !/^[0-7]{4}$/.test(form.squawk)) return toast.error(tr("Transpondeur : 4 chiffres de 0 à 7."));
    for (const [v, u, l] of [[form.initial_alt, form.initial_alt_unit, tr("Montée initiale")], [form.approach_alt, form.approach_alt_unit, tr("Approche")]] as const) {
      if (v && u === "FL" && Number(v) > 600) return toast.error(tr("{0} : en FL, saisissez 000 à 600 (ex. 060), pas {1}.", [l, v]));
    }
    m.mutate({
      squawk: form.squawk || null,
      initial_alt: num(form.initial_alt),
      initial_alt_unit: form.initial_alt_unit,
      cruise_fl: num(form.cruise_fl),
      approach_alt: num(form.approach_alt),
      approach_alt_unit: form.approach_alt_unit,
      remarks: form.remarks.trim() || null,
      dep_rwy: form.dep_rwy.trim() || null, sid: form.sid.trim() || null,
      star: form.star.trim() || null, arr_rwy: form.arr_rwy.trim() || null,
    });
  };
  return (
    <div
      className={`rounded border-l-4 border bg-background/70 p-2 text-xs transition-[border-color,background-color] duration-150 ${selected ? "border-[#4AA8F0] bg-[#4AA8F0]/5" : "border-border border-l-[#1E6FD9]"}`}
      data-testid={`strip-${id}`}
    >
      <div className="flex items-center justify-between gap-2">
        <button className="text-left" onClick={() => onSelect?.(s.flight_id)} data-testid={`strip-select-${id}`}>
          <span className="font-mono text-sm font-bold text-[#4AA8F0]">{s.callsign}</span>{" "}
          {s.atis_letter ? (
            <span className="ml-1 rounded bg-[#2B63C9]/30 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-amber-200" title={tr("Lettre ATIS")} data-testid={`strip-atis-${s.flight_id}`}>
              ATIS {s.atis_letter}
            </span>
          ) : null}{" "}
          <span className="font-mono text-muted-foreground">{s.aircraft_type}</span>
          <div className="font-mono text-[11px]">
            {s.departure}
            {s.dep_gate ? `/${s.dep_gate}` : ""} → {s.arrival}
            {s.arr_gate ? `/${s.arr_gate}` : ""}
          </div>
        </button>
        <div className="flex items-center gap-1.5">
          <PhaseBadge phase={s.phase} testId={`strip-phase-${id}`} />
          {!form && s.can_edit && (
            <Button size="icon-xs" variant="ghost" onClick={() => setForm(toForm(s))} title={tr("Modifier le strip")} data-testid={`strip-edit-${id}`}>
              <Pencil className="h-3 w-3" />
            </Button>
          )}
          {!s.can_edit && (
            <span title={tr("Ce vol ne relève d'aucune de vos positions : strip en lecture seule")} className="text-muted-foreground" data-testid={`strip-readonly-${id}`}>
              <Lock className="h-3 w-3" />
            </span>
          )}
        </div>
      </div>
      {form ? (
        <div className="mt-2 space-y-1.5">
          <div className="grid grid-cols-2 gap-1.5">
            {FIELDS.map((f) => (
              <label key={f.k} className="space-y-0.5">
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{tr(f.label)}</span>
                <div className="flex gap-1">
                  <input
                    value={form[f.k]}
                    inputMode="numeric"
                    maxLength={f.unit && form[f.unit] === "FL" ? 3 : f.max}
                    placeholder={f.unit && form[f.unit] === "FL" ? "060" : f.ph}
                    onChange={(e) => setForm({ ...form, [f.k]: e.target.value.replace(/\D/g, "") })}
                    className="w-full min-w-0 rounded border border-border bg-card px-1.5 py-1 font-mono outline-none focus:border-[#4AA8F0]"
                    data-testid={`strip-input-${f.k.replace(/_/g, "-")}-${id}`}
                  />
                  {f.unit && (
                    <button
                      type="button"
                      onClick={() => setForm({ ...form, [f.unit!]: form[f.unit!] === "FT" ? "FL" : "FT" })}
                      className="shrink-0 rounded border border-[#4AA8F0]/50 px-1.5 font-mono text-[10px] font-bold text-[#4AA8F0] transition-colors duration-150 hover:bg-[#4AA8F0]/10"
                      title={tr("Basculer pieds (FT) / niveau de vol (FL)")}
                      data-testid={`strip-unit-${f.k.replace(/_/g, "-")}-${id}`}
                    >
                      {form[f.unit]}
                    </button>
                  )}
                </div>
              </label>
            ))}
          </div>
          <div className="grid grid-cols-4 gap-1.5">
            {PROC.map((f) => (
              <label key={f.k} className="space-y-0.5">
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{tr(f.label)}</span>
                <input
                  value={form[f.k]}
                  maxLength={f.max}
                  placeholder={f.ph}
                  onChange={(e) => setForm({ ...form, [f.k]: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "") })}
                  className="w-full min-w-0 rounded border border-border bg-card px-1.5 py-1 font-mono outline-none focus:border-[#4AA8F0]"
                  data-testid={`strip-input-${f.k.replace(/_/g, "-")}-${id}`}
                />
              </label>
            ))}
          </div>
          <p className="text-[10px] text-muted-foreground">{tr("Pistes, SID et STAR viennent du plan SimBrief ; videz un champ pour revenir au plan.")}</p>
          <input
            value={form.remarks}
            maxLength={120}
            placeholder={tr("Remarques")}
            onChange={(e) => setForm({ ...form, remarks: e.target.value })}
            className="w-full rounded border border-border bg-card px-1.5 py-1 outline-none focus:border-[#4AA8F0]"
            data-testid={`strip-input-remarks-${id}`}
          />
          <div className="flex justify-end gap-1.5">
            <Button size="xs" variant="ghost" onClick={() => setForm(null)} data-testid={`strip-cancel-${id}`}>{tr("Annuler")}</Button>
            <Button size="xs" onClick={save} disabled={m.isPending} data-testid={`strip-save-${id}`}>{tr("Enregistrer")}</Button>
          </div>
        </div>
      ) : (
        <>
          <div className="mt-1.5 grid grid-cols-4 gap-1 font-mono">
            {[
              ["XPDR", s.squawk ?? "—", "squawk"],
              ["MONT.", fmtAltUnit(s.initial_alt, s.initial_alt_unit), "initial"],
              ["CRZ", fmtAltUnit(s.cruise_fl, "FL"), "cruise"],
              ["APP", fmtAltUnit(s.approach_alt, s.approach_alt_unit), "approach"],
            ].map(([l, v, k]) => (
              <div key={k} className="rounded bg-card px-1 py-0.5">
                <div className="text-[9px] text-muted-foreground">{l}</div>
                <div className="text-[12px] text-amber-200" data-testid={`strip-${k}-${id}`}>
                  {v}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-1 grid grid-cols-4 gap-1 font-mono">
            {PROC.map(({ k, label }) => (
              <div key={k} className="rounded bg-card px-1 py-0.5">
                <div className="text-[9px] text-muted-foreground">
                  {tr(label).replace("Piste départ", "PISTE DEP").replace("Piste arrivée", "PISTE ARR")}
                </div>
                <div className="truncate text-[12px] text-amber-200" data-testid={`strip-${k.replace(/_/g, "-")}-${id}`}>
                  {s[k] ?? "—"}
                </div>
              </div>
            ))}
          </div>
          {s.remarks && <p className="mt-1 text-[11px] text-sky-200" data-testid={`strip-remarks-${id}`}>{s.remarks}</p>}
          <p className="mt-1 text-[10px] text-muted-foreground" data-testid={`strip-controller-${id}`}>
            {s.controller_callsign ? tr("Sous contrôle {0}", [s.controller_callsign]) : tr("Non contrôlé")}
          </p>
          {s.updated_by && s.updated_at && (
            <p className="mt-1 text-[10px] text-muted-foreground">{tr("Modifié par {0} · {1}", [s.updated_by, fmtTime(s.updated_at)])}
            </p>
          )}
        </>
      )}
    </div>
  );
}

/** Shared strip board: every ATC sees the same strips; only those concerning one of my positions are editable (server rule). */
export default function StripBoard({ selectedId, onSelect, myAirport }: { selectedId?: string | null; onSelect?: (id: string) => void; myAirport?: string | null }) {
  const q = useQuery<Strip[]>({ queryKey: ["strips"], queryFn: () => apiGet<Strip[]>("/strips"), refetchInterval: 3000 });
  const [icao, setIcao] = useState(myAirport ?? "");
  const ap = icao.trim().toUpperCase();
  const all = q.data ?? [];
  const section = (title: string, rows: Strip[], id: string) => (
    <div className="space-y-2" data-testid={`strip-section-${id}`}>
      <div className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title} <span className="rounded bg-secondary px-1.5 font-mono">{rows.length}</span>
      </div>
      {rows.length === 0 ? (
        <p className="rounded border border-dashed border-border p-2 text-xs text-muted-foreground" data-testid={`strip-section-${id}-empty`}>{tr("Aucun vol actuellement présent.")}</p>
      ) : (
        rows.map((s) => <StripCard key={s.flight_id} s={s} selected={s.flight_id === selectedId} onSelect={onSelect} />)
      )}
    </div>
  );
  return (
    <div className="space-y-3 p-3" data-testid="strip-board">
      <div className="flex gap-1.5">
        <input
          value={icao}
          onChange={(e) => setIcao(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
          maxLength={4}
          placeholder={tr("Filtrer par OACI (ex. LFPG)")}
          className="flex-1 rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-sm outline-none focus:border-[#4AA8F0]"
          data-testid="strip-icao-filter"
        />
        {ap && (
          <Button size="sm" variant="outline" onClick={() => setIcao("")} data-testid="strip-global-view">{tr("Vue globale")}</Button>
        )}
      </div>
      {q.isLoading && <p className="text-xs text-muted-foreground">{tr("Chargement des strips…")}</p>}
      {q.isError && <p className="text-xs text-red-300">{errMsg(q.error)}</p>}
      {ap.length === 4 ? (
        <>
          {section(tr("Départs {0}", [ap]), all.filter((s) => s.departure === ap), "departures")}
          {section(tr("Arrivées {0}", [ap]), all.filter((s) => s.arrival === ap), "arrivals")}
        </>
      ) : (
        section(tr("Tous les vols actifs"), all, "all")
      )}
    </div>
  );
}
