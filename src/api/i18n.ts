import { asyncApi } from "../realm";
import type { ExtensionState } from "../registry";
import type { ChromeManifest } from "../types";
import type { Env, Namespace } from "./env";

type Messages = Record<string, { message: string; placeholders?: Record<string, { content: string }> }>;

export function uiLocaleFor(available: string[], defaultLocale: string | undefined): string {
  const langs = [...(navigator.languages ?? []), navigator.language].filter(Boolean).map((l) => l.replace("-", "_"));
  for (const lang of langs) {
    if (available.includes(lang)) return lang;
    const base = lang.split("_")[0];
    if (available.includes(base)) return base;
  }
  return defaultLocale ?? available[0] ?? "en";
}

function lowerKeys(m: Messages): Messages {
  const out: Messages = {};
  for (const [k, v] of Object.entries(m)) {
    if (!v || typeof v !== "object") continue;
    const placeholders: Record<string, { content: string }> = {};
    for (const [pk, pv] of Object.entries(v.placeholders ?? {})) placeholders[pk.toLowerCase()] = pv;
    out[k.toLowerCase()] = { message: String(v.message ?? ""), placeholders };
  }
  return out;
}

/** Load every _locales/<l>/messages.json and build the lookup chain Chrome uses. */
export async function loadLocales(ext: ExtensionState): Promise<void> {
  const files = await ext.files.listFiles();
  const locales = [...new Set(files.map((f) => f.match(/^_locales\/([^/]+)\/messages\.json$/)?.[1]).filter((l): l is string => !!l))];
  ext.locales.clear();
  for (const locale of locales) {
    const text = await ext.files.readText(`_locales/${locale}/messages.json`);
    if (!text) continue;
    try {
      ext.locales.set(locale, lowerKeys(JSON.parse(text.replace(/^﻿/, ""))));
    } catch (e) {
      console.warn(`[sapphire] ${ext.manifest.name}: bad messages.json for ${locale}`, e);
    }
  }
  ext.uiLocale = uiLocaleFor(locales, ext.manifest.default_locale);
  const chain = [ext.manifest.default_locale, ext.uiLocale.split("_")[0], ext.uiLocale].filter((l): l is string => !!l);
  const merged: Messages = {};
  for (const l of chain) Object.assign(merged, ext.locales.get(l) ?? {});
  ext.messages = merged;
}

const RTL = new Set(["ar", "he", "fa", "ur", "yi", "ps", "sd", "ug", "dv"]);

export function getMessage(ext: ExtensionState, name: string, substitutions?: unknown, options?: { escapeLt?: boolean }): string {
  const key = String(name ?? "").toLowerCase();
  const locale = ext.uiLocale;
  const rtl = RTL.has(locale.split("_")[0]);
  const predefined: Record<string, string> = {
    "@@extension_id": ext.id,
    "@@ui_locale": locale,
    "@@bidi_dir": rtl ? "rtl" : "ltr",
    "@@bidi_reversed_dir": rtl ? "ltr" : "rtl",
    "@@bidi_start_edge": rtl ? "right" : "left",
    "@@bidi_end_edge": rtl ? "left" : "right",
  };
  if (key in predefined) return predefined[key];
  const entry = ext.messages[key];
  if (!entry) return "";
  const subs = substitutions === undefined || substitutions === null ? [] : Array.isArray(substitutions) ? substitutions.map(String) : [String(substitutions)];
  if (subs.length > 9) return "";
  const fillNumbers = (text: string) => text.replace(/\$(\d)/g, (m, d) => (Number(d) >= 1 ? (subs[Number(d) - 1] ?? "") : m));
  let text = entry.message.replace(/\$([A-Za-z0-9_@]+)\$/g, (m, ph: string) => {
    const p = entry.placeholders?.[ph.toLowerCase()];
    return p ? fillNumbers(String(p.content ?? "")) : m;
  });
  text = fillNumbers(text).replace(/\$\$/g, "$");
  if (options?.escapeLt) text = text.replace(/</g, "&lt;");
  return text;
}

export function localizeManifest(manifest: ChromeManifest, lookup: (name: string) => string): ChromeManifest {
  const visit = (value: unknown): unknown => {
    if (typeof value === "string") {
      return value.replace(/__MSG_([A-Za-z0-9_@]+)__/g, (m, name: string) => lookup(name) || m);
    }
    if (Array.isArray(value)) return value.map(visit);
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = visit(v);
      return out;
    }
    return value;
  };
  return visit(manifest) as ChromeManifest;
}

export function createI18n(env: Env): Namespace {
  const { ctx, ext } = env;
  return {
    getMessage: (name: string, substitutions?: unknown, options?: { escapeLt?: boolean }) => getMessage(ext, name, substitutions, options),
    getUILanguage: () => ext.uiLocale.replace("_", "-"),
    getAcceptLanguages: asyncApi(ctx, () => [...(navigator.languages ?? [navigator.language])]),
    detectLanguage: asyncApi(ctx, (text: string) => {
      const sample = String(text ?? "");
      let language = "und";
      if (/[぀-ヿ]/.test(sample)) language = "ja";
      else if (/[一-鿿]/.test(sample)) language = "zh";
      else if (/[가-힯]/.test(sample)) language = "ko";
      else if (/[Ѐ-ӿ]/.test(sample)) language = "ru";
      else if (/[؀-ۿ]/.test(sample)) language = "ar";
      else if (/[֐-׿]/.test(sample)) language = "he";
      else if (/[a-z]/i.test(sample)) language = navigator.language.split("-")[0] || "en";
      return { isReliable: false, languages: language === "und" ? [] : [{ language, percentage: 100 }] };
    }),
  };
}
