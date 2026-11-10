import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Building2, CalendarClock, Globe2, Lock, Radio, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiDelete, apiGet, apiPost } from "@/lib/api";
import { errMsg } from "@/lib/hooks";
import type { AtcPosition, AtcPositionIn, FrequencyInfo, Preopening, User } from "@/lib/types";
import { cn } from "@/lib/utils";

import { labels, locale, tr } from "@/lib/i18n";
export const useAtcPositions = () =>
  useQuery<AtcPosition[]>({ queryKey: ["atc-positions"], queryFn: () => apiGet<AtcPosition[]>("/atc/positions"), refetchInterval: 10_000 });

export const usePreopenings = () =>
  useQuery<Preopening[]>({ queryKey: ["atc-preopenings"], queryFn: () => apiGet<Preopening[]>("/atc/preopenings"), refetchInterval: 30_000 });

/** Default pre-opening time: in 1 h 15, rounded to the next quarter (UTC). */
function defaultStart(): { date: string; time: string } {
  const d = new Date(Date.now() + 75 * 60_000);
  d.setUTCMinutes(Math.ceil(d.getUTCMinutes() / 15) * 15, 0, 0);
  const iso = d.toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
}
const fmtWhen = (iso: string) => {
  const d = new Date(iso);
  return tr("{0} à {1} UTC", [d.toLocaleDateString(locale(), { weekday: "short", day: "2-digit", month: "2-digit", timeZone: "UTC" }), d.toISOString().slice(11, 16)]);
};

const TYPE_LABEL: Record<string, string> = labels({ GND: "Sol", TWR: "Tour", APP: "Approche", CTR: "Centre" });
const AIRPORT_POSITIONS = ["APP", "TWR", "GND"] as const;
const FREQ_RE = /^1(1[89]|2\d|3[0-6])\.\d{2,3}$/;

function useDebounced<T>(value: T, ms = 350): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Opening form: option 1 = a position on an airport (APP → TWR → GND), option 2 = a centre (CTR). */
function OpenForm({ onDone }: { onDone: () => void }) {
  const [kind, setKind] = useState<"airport" | "center">("airport");
  const [icao, setIcao] = useState("");
  const [position, setPosition] = useState<"APP" | "TWR" | "GND">("APP");
  const [freq, setFreq] = useState("");
  const [edited, setEdited] = useState(false);
  const [languages, setLanguages] = useState("🇫🇷 FR");
  const [when, setWhen] = useState<"now" | "later">("now");
  const [start, setStart] = useState(defaultStart);
  const pos = kind === "center" ? "CTR" : position;
  const code = useDebounced(icao.trim().toUpperCase());
  const ready = kind === "center" ? code.length >= 3 : code.length === 4;
  const info = useQuery<FrequencyInfo>({
    queryKey: ["atc-frequency", code, pos],
    queryFn: () => apiGet<FrequencyInfo>(`/atc/frequency?icao=${code}&position=${pos}`),
    enabled: ready,
    retry: false,
  });
  // the pre-recorded frequency fills the field, unless the controller typed one
  useEffect(() => {
    if (!edited) setFreq(info.data?.frequency ?? "");
  }, [info.data, edited]);
  useEffect(() => setEdited(false), [code, pos]);

  const open = useMutation({
    mutationFn: (b: AtcPositionIn) => apiPost<AtcPosition>("/atc/positions", b),
    onSuccess: (p) => {
      toast.success(tr("Position {0} ouverte sur {1}", [p.callsign, p.frequency]));
      setIcao("");
      onDone();
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  const pre = useMutation({
    mutationFn: (b: AtcPositionIn & { start_at: string }) => apiPost<Preopening>("/atc/preopenings", b),
    onSuccess: (p) => {
      toast.success(tr("Pré-ouverture de {0} annoncée pour le {1}", [p.callsign, fmtWhen(p.start_at)]));
      setIcao("");
      setWhen("now");
      onDone();
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  const later = when === "later";
  const missing = info.data?.missing_before ?? [];
  const blocked = !later && kind === "airport" && missing.length > 0; // the opening order is checked at the real opening
  const freqOk = FREQ_RE.test(freq);
  const startIso = `${start.date}T${start.time}:00Z`;
  const tooSoon = later && (Number.isNaN(Date.parse(startIso)) || Date.parse(startIso) < Date.now() + 60 * 60_000);
  const body = { kind, icao: code, ...(kind === "airport" ? { position } : {}), ...(freq ? { frequency: freq } : {}), languages };
  const submit = () => (later ? pre.mutate({ ...body, start_at: startIso }) : open.mutate(body));

  return (
    <div className="space-y-3 rounded-lg border border-border bg-background/40 p-3" data-testid="atc-open-form">
      <div className="grid grid-cols-2 gap-1 rounded-md bg-background/60 p-1 text-xs" role="tablist">
        {([
          ["airport", "Aéroport", Building2],
          ["center", "Centre (CTR)", Globe2],
        ] as const).map(([k, label, Icon]) => (
          <button
            key={k}
            role="tab"
            aria-selected={kind === k}
            onClick={() => setKind(k)}
            className={cn(
              "flex items-center justify-center gap-1.5 rounded px-2 py-1.5 font-semibold transition-colors",
              kind === k ? "bg-[color:var(--sc-primary)] text-white" : "text-muted-foreground hover:text-foreground",
            )}
            data-testid={`atc-kind-${k}`}
          >
            <Icon className="h-3.5 w-3.5" /> {tr(label)}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-1 rounded-md bg-background/60 p-1 text-xs" role="tablist">
        {([
          ["now", "Ouvrir maintenant", Radio],
          ["later", "Pré-ouverture", CalendarClock],
        ] as const).map(([k, label, Icon]) => (
          <button
            key={k}
            role="tab"
            aria-selected={when === k}
            onClick={() => setWhen(k)}
            className={cn(
              "flex items-center justify-center gap-1.5 rounded px-2 py-1.5 font-semibold transition-colors",
              when === k ? "bg-[color:var(--sc-primary)] text-white" : "text-muted-foreground hover:text-foreground",
            )}
            data-testid={`atc-when-${k}`}
          >
            <Icon className="h-3.5 w-3.5" /> {tr(label)}
          </button>
        ))}
      </div>
      {later && (
        <div className="space-y-1.5 rounded border border-border/70 bg-card/60 p-2 text-xs" data-testid="atc-preopen-time">
          <p className="text-muted-foreground">{tr("Annoncez à l'avance l'ouverture d'une position (au moins")}{" "}<b className="text-foreground">{tr("1 heure avant")}</b>{tr(", une seule à la fois). L'annonce est publiée sur le radar et sur le Discord.")}</p>
          <div className="flex flex-wrap items-center gap-2">
            <input type="date" value={start.date} onChange={(e) => setStart({ ...start, date: e.target.value })}
              className="rounded border border-border bg-background px-1.5 py-1 font-mono" data-testid="atc-preopen-date" />
            <input type="time" value={start.time} onChange={(e) => setStart({ ...start, time: e.target.value })}
              className="rounded border border-border bg-background px-1.5 py-1 font-mono" data-testid="atc-preopen-hour" />
            <span className="text-muted-foreground">{tr("UTC")}</span>
          </div>
          {tooSoon && <p className="text-amber-300" data-testid="atc-preopen-too-soon">{tr("L'heure doit être au moins 1 heure plus tard que maintenant.")}</p>}
        </div>
      )}

      <label className="block space-y-1">
        <span className="text-[11px] text-muted-foreground">{kind === "airport" ? tr("Code OACI de l'aéroport") : tr("Code OACI du centre")}</span>
        <input
          value={icao}
          onChange={(e) => setIcao(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
          placeholder={kind === "airport" ? "LFPG" : "LFFF"}
          maxLength={4}
          className="w-full rounded border border-border bg-card px-2 py-1.5 font-mono text-sm outline-none focus:border-[color:var(--sc-accent)]"
          data-testid="atc-icao-input"
        />
      </label>

      {kind === "airport" ? (
        <div className="space-y-1">
          <span className="text-[11px] text-muted-foreground">{tr("Position (ordre obligatoire : APP → TWR → GND)")}</span>
          <div className="grid grid-cols-3 gap-1">
            {AIRPORT_POSITIONS.map((p) => {
              const isOpen = info.data?.open_positions.includes(p);
              return (
                <button
                  key={p}
                  onClick={() => setPosition(p)}
                  className={cn(
                    "rounded border px-2 py-1.5 text-xs font-semibold transition-colors",
                    position === p ? "border-[color:var(--sc-accent)] bg-[color:var(--sc-primary)]/25 text-white" : "border-border text-muted-foreground hover:text-foreground",
                  )}
                  data-testid={`atc-position-${p}`}
                >
                  {p}
                  <span className="block text-[10px] font-normal">{isOpen ? tr("déjà ouverte") : TYPE_LABEL[p]}</span>
                </button>
              );
            })}
          </div>
        </div>
      ) : (
        <p className="text-[11px] text-muted-foreground">{tr("Position")}{" "}<b className="font-mono text-foreground">{tr("CTR")}</b>{" "}{tr("sélectionnée automatiquement.")}</p>
      )}

      {ready && info.isError && <p className="text-xs text-red-400">{errMsg(info.error)}</p>}
      {info.data && (
        <div className="space-y-2 rounded border border-border/70 bg-card/60 p-2 text-xs" data-testid="atc-frequency-preview">
          <div className="flex items-baseline justify-between gap-2">
            <span className="font-mono font-semibold text-[color:var(--sc-accent)]">{info.data.icao}_{pos}</span>
            <span className="truncate text-muted-foreground">{info.data.name}</span>
          </div>
          {blocked && (
            <p className="flex items-center gap-1 text-amber-300" data-testid="atc-order-warning">
              <Lock className="h-3 w-3" />{" "}{tr("Ouvrez d'abord")}{" "}{missing.map((m) => `${info.data!.icao}_${m}`).join(" puis ")}.
            </p>
          )}
          <label className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-2">
            <span className="text-muted-foreground">{tr("Langue(s)")}</span>
            <select
              value={languages}
              onChange={(e) => setLanguages(e.target.value)}
              className="rounded border border-border bg-background px-1.5 py-1 text-sm"
              data-testid="atc-languages"
            >
              <option value="🇫🇷 FR">🇫🇷 Français</option>
              <option value="🇬🇧 EN">🇬🇧 English</option>
              <option value="🇫🇷🇬🇧 FR / EN">🌐 FR + EN</option>
            </select>
          </label>
          <label className="flex items-center gap-2">
            <span className="text-muted-foreground">{tr("Fréquence")}</span>
            <input
              value={freq}
              onChange={(e) => {
                setEdited(true);
                setFreq(e.target.value.replace(/[^0-9.]/g, ""));
              }}
              placeholder="118.650"
              maxLength={7}
              className={cn(
                "w-24 rounded border bg-background px-1.5 py-1 font-mono text-sm text-amber-200 outline-none focus:border-[color:var(--sc-accent)]",
                freq && !freqOk ? "border-red-500" : "border-border",
              )}
              data-testid="atc-frequency-input"
            />
          </label>
          <p className="text-[10px] text-muted-foreground">
            {info.data.source === "ourairports"
              ? tr("Fréquence préenregistrée (OurAirports).")
              : info.data.source === "communaute"
                ? tr("Fréquence déjà saisie par un contrôleur SkyCommunity.")
                : tr("Aucune fréquence connue : saisissez-la, elle sera mémorisée pour les prochaines ouvertures.")}
          </p>
        </div>
      )}

      <Button
        className="w-full"
        onClick={submit}
        disabled={open.isPending || pre.isPending || !info.data || blocked || !freqOk || tooSoon}
        data-testid="atc-open-position"
      >
        {later ? <CalendarClock className="h-4 w-4" /> : <Radio className="h-4 w-4" />}
        {later ? tr("Annoncer la pré-ouverture de ") : tr("Ouvrir ")}
        {info.data ? `${info.data.icao}_${pos}` : tr("la position")}
      </Button>
    </div>
  );
}

/** One announced pre-opening. The controller asks for its cancellation with a mandatory reason; the Responsable
 * ATC (and the administrators) accept / refuse the request, or cancel directly — always with a reason, logged. */
export function PreopeningItem({ p, user, showReason = false }: { p: Preopening; user: User; showReason?: boolean }) {
  const qc = useQueryClient();
  const [form, setForm] = useState<null | "request" | "cancel" | "refuse">(null);
  const [text, setText] = useState("");
  const m = useMutation({
    mutationFn: ({ url, body }: { url: string; body: Record<string, string> }) => apiPost<Preopening>(url, body),
    onSuccess: (_d, v) => {
      const msg: Record<string, string> = {
        "cancel-request": "Demande d'annulation envoyée au Responsable ATC",
        cancel: "Pré-ouverture annulée",
        accept: "Annulation acceptée",
        refuse: "Demande d'annulation refusée",
      };
      toast.success(tr(msg[v.body.decision ?? v.url.split("/").pop()!] ?? "Fait"));
      setForm(null);
      setText("");
    },
    onError: (e) => toast.error(errMsg(e)),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["atc-preopenings"] });
      qc.invalidateQueries({ queryKey: ["activity-summary"] });
      qc.invalidateQueries({ queryKey: ["activity-journal"] });
    },
  });
  const base = `/atc/preopenings/${p.id}`;
  const own = p.user_id === user.id;
  const valid = text.trim().length >= 3;
  const submit = () => {
    if (form === "request") m.mutate({ url: `${base}/cancel-request`, body: { reason: text.trim() } });
    if (form === "cancel") m.mutate({ url: `${base}/cancel`, body: { reason: text.trim() } });
    if (form === "refuse") m.mutate({ url: `${base}/cancel-request/decision`, body: { decision: "refuse", ...(text.trim() ? { comment: text.trim() } : {}) } });
  };
  return (
    <li className="space-y-1 rounded bg-background/60 px-2 py-1 text-xs" data-testid={`atc-preopening-${p.callsign}`}>
      <div className="flex items-center justify-between gap-2 font-mono">
        <span className="min-w-0 truncate">
          <b className="text-[color:var(--sc-accent)]">{p.callsign}</b> <span className="text-amber-200">{p.frequency}</span>
          <span className="ml-1 font-sans text-[10px] text-muted-foreground">{p.controller}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5 font-sans text-[11px]">
          {fmtWhen(p.start_at)}
          {p.can_cancel && !p.cancel_request_at && (
            <button onClick={() => setForm(form === "cancel" ? null : "cancel")} title={tr("Annuler la pré-ouverture")}
              className="rounded p-0.5 text-muted-foreground hover:bg-red-500/20 hover:text-red-300" data-testid={`atc-preopening-cancel-${p.callsign}`}>
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </span>
      </div>
      {p.cancel_request_at && (own || p.can_decide || showReason) && (
        <p className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-amber-100" data-testid={`atc-preopening-request-${p.callsign}`}>
          {own ? tr("Annulation demandée, en attente du Responsable ATC") : tr("Annulation demandée par {0}", [p.controller])}{" "}{tr("— motif : «")}{" "}{p.cancel_reason} »
        </p>
      )}
      {(p.can_request_cancel || p.can_decide) && !form && (
        <div className="flex flex-wrap gap-1">
          {p.can_request_cancel && (
            <Button size="xs" variant="outline" onClick={() => setForm("request")} data-testid={`atc-preopening-ask-${p.callsign}`}>{tr("Demander l'annulation")}</Button>
          )}
          {p.can_decide && (
            <>
              <Button size="xs" onClick={() => m.mutate({ url: `${base}/cancel-request/decision`, body: { decision: "accept" } })}
                disabled={m.isPending} data-testid={`atc-preopening-accept-${p.callsign}`}>{tr("Accepter l'annulation")}</Button>
              <Button size="xs" variant="outline" onClick={() => setForm("refuse")} data-testid={`atc-preopening-refuse-${p.callsign}`}>{tr("Refuser")}</Button>
            </>
          )}
        </div>
      )}
      {form && (
        <div className="space-y-1.5 rounded border border-border bg-card/60 p-2">
          <input
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={300}
            placeholder={form === "refuse" ? tr("Réponse au contrôleur (facultatif)") : tr("Motif de l'annulation (obligatoire)")}
            className="w-full rounded border border-border bg-background px-2 py-1 outline-none focus:border-[color:var(--sc-accent)]"
            data-testid={`atc-preopening-reason-${p.callsign}`}
          />
          <div className="flex gap-1">
            <Button size="xs" variant={form === "refuse" ? "default" : "destructive"} onClick={submit}
              disabled={m.isPending || (form !== "refuse" && !valid)} data-testid={`atc-preopening-submit-${p.callsign}`}>
              {form === "request" ? tr("Envoyer la demande") : form === "cancel" ? tr("Annuler la pré-ouverture") : tr("Refuser la demande")}
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setForm(null)}>{tr("Fermer")}</Button>
          </div>
        </div>
      )}
    </li>
  );
}

/** Open SkyCommunity ATC positions + (for controllers) open / close your own positions. */
export default function AtcPositionPanel({ user, canOpen: allowed = true }: { user: User; canOpen?: boolean }) {
  const qc = useQueryClient();
  const q = useAtcPositions();
  const mine = (q.data ?? []).filter((p) => p.controller === user.display_name);
  const canOpen = allowed && (user.role === "atc" || user.role === "admin");
  const done = () => {
    qc.invalidateQueries({ queryKey: ["atc-positions"] });
    qc.invalidateQueries({ queryKey: ["atc-atis-me"] });
    qc.invalidateQueries({ queryKey: ["atc-frequency"] });
    qc.invalidateQueries({ queryKey: ["atc-preopenings"] });
    qc.invalidateQueries({ queryKey: ["flights"] });
    qc.invalidateQueries({ queryKey: ["flight"] });
  };
  const preq = usePreopenings();
  const close = useMutation({
    mutationFn: (callsign?: string) => apiDelete<{ ok: boolean }>(callsign ? `/atc/positions/${callsign}` : "/atc/positions/me"),
    onSuccess: (_r, cs) => toast.success(cs ? tr("Position {0} fermée", [cs]) : tr("Positions fermées")),
    onError: (e) => toast.error(errMsg(e)),
    onSettled: done,
  });
  return (
    <div className="space-y-3 text-sm" data-testid="atc-position-panel">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
        <Radio className="h-3 w-3" />{" "}{tr("Positions ATC ouvertes (")}{q.data?.length ?? 0})
      </div>
      {q.data?.length === 0 && <p className="text-muted-foreground" data-testid="atc-positions-empty">{tr("Aucun contrôleur en ligne : vols non contrôlés.")}</p>}
      <ul className="space-y-1">
        {q.data?.map((p) => {
          const own = p.controller === user.display_name;
          return (
            <li
              key={p.id}
              className={cn("flex items-center justify-between gap-2 rounded px-2 py-1 font-mono", own ? "bg-[color:var(--sc-primary)]/15 ring-1 ring-[color:var(--sc-primary)]/40" : "bg-background/60")}
              data-testid={`atc-online-${p.callsign}`}
            >
              <span className="min-w-0 truncate">
                <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-emerald-400 sync-dot" />
                <b className="text-[color:var(--sc-accent)]">{p.callsign}</b> <span className="text-muted-foreground">{TYPE_LABEL[p.type] ?? p.type}</span>
                <span className="ml-1 font-sans text-[10px] text-muted-foreground">{p.controller}</span>
              </span>
              <span className="flex items-center gap-1.5">
                <span className="text-amber-200">{p.frequency}</span>
                {own && canOpen && (
                  <button
                    onClick={() => close.mutate(p.callsign)}
                    disabled={close.isPending}
                    className="rounded p-0.5 text-muted-foreground hover:bg-red-500/20 hover:text-red-300"
                    title={tr("Fermer {0}", [p.callsign])}
                    data-testid={`atc-close-${p.callsign}`}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      {(preq.data?.length ?? 0) > 0 && (
        <div className="space-y-1" data-testid="atc-preopenings">
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
            <CalendarClock className="h-3 w-3" />{" "}{tr("Pré-ouvertures annoncées")}</div>
          <ul className="space-y-1">
            {preq.data!.map((p) => (
              <PreopeningItem key={p.id} p={p} user={user} />
            ))}
          </ul>
        </div>
      )}
      {canOpen && mine.length > 1 && (
        <Button size="xs" variant="outline" onClick={() => close.mutate(undefined)} disabled={close.isPending} data-testid="atc-close-position">{tr("Fermer toutes mes positions")}</Button>
      )}
      {canOpen && <OpenForm onDone={done} />}
    </div>
  );
}
