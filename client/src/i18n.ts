import { EN } from "./lang/en.ts";

/**
 * Translations. Mesa is written in Portuguese (pt-PT); the source text is the key, so `t("Guardar")`
 * shows "Guardar" in pt-PT and "Save" in English. Missing translations fall back to the Portuguese.
 * Placeholders: `t("Olá, {nome}", { nome })`. The language is a per-browser setting (core.language);
 * changing it reloads the page. `tools/i18n-check.py` lists strings not yet wrapped or translated.
 */
export type Lang = "pt-PT" | "en";

const TABLES: Record<Lang, Record<string, string> | null> = { "pt-PT": null, en: EN };

function readLang(): Lang {
  try {
    const v = JSON.parse(localStorage.getItem("mesa.settings") ?? "{}")["core.language"];
    return v === "en" ? "en" : "pt-PT";
  } catch {
    return "pt-PT";
  }
}

export const lang: Lang = readLang();
document.documentElement.lang = lang;
const table = TABLES[lang];
const missing = new Set<string>();

export function t(source: string, params?: Record<string, string | number>): string {
  let out = table?.[source];
  if (out === undefined) {
    out = source;
    if (table && import.meta.env.DEV && !missing.has(source)) {
      missing.add(source);
      console.debug(`i18n | sem tradução (${lang}): ${source}`);
    }
  }
  return params ? out.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m)) : out;
}

/** Strings seen without a translation this session (dev helper). */
export const untranslated = () => [...missing];

/** Locale for dates, numbers and sorting. */
export const locale = lang === "en" ? "en-GB" : "pt-PT";
