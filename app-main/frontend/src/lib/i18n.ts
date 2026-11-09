/* Interface language (français / English) — no library, no cost for French.

- The French text written in the code is the key: tr("Nouveau vol") returns it as-is in French, without any lookup.
- The English dictionary (lib/i18n-en.ts) is a separate file, downloaded only by someone who picks English.
- Changing the language re-renders the app once (App is keyed on the language in main.tsx).
- Server messages (errors…) are translated by trServer() with patterns: « Vol contrôlé par {} ({}) … ».
*/
import { useSyncExternalStore } from "react";

export type Lang = "fr" | "en";
const KEY = "sc.lang";

let lang: Lang = (() => {
  try {
    return localStorage.getItem(KEY) === "en" ? "en" : "fr";
  } catch {
    return "fr";
  }
})();
let EN: Record<string, string> | null = null;
let SERVER: [RegExp, string][] = [];
const listeners = new Set<() => void>();

export const getLang = (): Lang => lang;

function compile(rows: [string, string][]): [RegExp, string][] {
  return rows.map(([fr, en]) => {
    const parts = fr.split("{}").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    return [new RegExp(`^${parts.join("(.+?)")}$`, "s"), en];
  });
}

/** Loads the English dictionary when needed (once). Called before the first render and on every change. */
export async function loadLang(): Promise<void> {
  if (lang === "en" && !EN) {
    const m = await import("./i18n-en");
    EN = m.EN;
    SERVER = compile(m.SERVER);
  }
  if (typeof document !== "undefined") document.documentElement.lang = lang;
}

export async function setLang(l: Lang): Promise<void> {
  if (l === lang) return;
  lang = l;
  try {
    localStorage.setItem(KEY, l);
  } catch {
    /* private mode: the choice lasts for this visit only */
  }
  await loadLang();
  listeners.forEach((f) => f());
}

export function useLang(): Lang {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getLang,
    getLang,
  );
}

type Vars = (string | number | null | undefined)[] | Record<string, string | number | null | undefined>;

function fill(s: string, vars?: Vars): string {
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k: string) => {
    const v = (vars as Record<string, unknown>)[k];
    return v === undefined || v === null ? m : String(v);
  });
}

/** Text of the interface: the French text, or its English translation. {0}, {1}… are replaced by `vars`. */
export function tr(fr: string, vars?: Vars): string {
  return fill(lang === "en" && EN ? EN[fr] ?? fr : fr, vars);
}

/** Message written by the server (always French): translated with the patterns of lib/i18n-en.ts. */
export function trServer(msg: string): string {
  if (lang !== "en" || !EN || !msg) return msg;
  const exact = EN[msg];
  if (exact) return exact;
  for (const [re, en] of SERVER) {
    const m = re.exec(msg);
    if (m) {
      let i = 1;
      return en.replace(/\{\}/g, () => trServer(m[i++] ?? ""));
    }
  }
  return msg;
}

/** Locale for dates and numbers. */
export const locale = (): string => (lang === "en" ? "en-GB" : "fr-FR");

/** Map of labels written in French (phases, roles…): read through it, each value comes back translated. */
export function labels<T extends Record<string, string>>(m: T): T {
  return new Proxy(m, {
    get: (o, k) => (typeof k === "string" && typeof (o as Record<string, unknown>)[k] === "string" ? tr((o as Record<string, string>)[k]) : (o as Record<string | symbol, unknown>)[k]),
    getOwnPropertyDescriptor: (o, k) => {
      const d = Object.getOwnPropertyDescriptor(o, k);
      return d && typeof d.value === "string" ? { ...d, value: tr(d.value) } : d;
    },
  });
}
