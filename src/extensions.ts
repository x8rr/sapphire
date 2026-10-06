import JSZip from "jszip";
import { extensionIdFromPublicKey, extensionIdFromSeed, parseCrx } from "./crx";
import { dbDeletePrefix, dbGet, dbGetAll, dbPut, dbWriteMany, dbDelete, EXT_FILES_STORE, EXT_STATE_STORE, EXT_STORE } from "./db";
import { getMessage, loadLocales, localizeManifest } from "./api/i18n";
import { restoreAlarms } from "./api/alarms";
import { recomputeStaticRules } from "./dnr";
import { defaultActionFor, type ExtensionState } from "./registry";
import type { Sapphire } from "./sapphire";
import type { ChromeManifest, ChromeManifestAction, ChromeManifestIcons, ContentScriptRegistration, DNRRule, ExtensionMeta } from "./types";

export interface InstalledExtensionSummary {
  id: string;
  name: string;
  version: string | undefined;
  enabled: boolean;
  manifest: ChromeManifest;
  iconUrl: string | null;
  title: string | null;
  badgeText: string;
  badgeColor: string | null;
  badgeTextColor: string | null;
  hasPopup: boolean;
  popupUrl: string | null;
  actionEnabled: boolean;
  optionsUrl: string | null;
  description: string;
}

/** Chrome accepts comments and trailing commas in manifest.json. */
export function parseManifestText(text: string): ChromeManifest {
  const src = text.replace(/^﻿/, "");
  try {
    return JSON.parse(src);
  } catch {
    let out = "";
    let inString = false;
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (inString) {
        out += ch;
        if (ch === "\\") {
          out += src[++i] ?? "";
        } else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
        out += ch;
      } else if (ch === "/" && src[i + 1] === "/") {
        while (i < src.length && src[i] !== "\n") i++;
        out += "\n";
      } else if (ch === "/" && src[i + 1] === "*") {
        i += 2;
        while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
        i++;
      } else out += ch;
    }
    return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
  }
}

export function getDefaultIcon(manifest: ChromeManifest): string | null {
  const icons: string | ChromeManifestIcons | undefined =
    (manifest.action as ChromeManifestAction | undefined)?.default_icon ??
    (manifest.browser_action as ChromeManifestAction | undefined)?.default_icon ??
    (manifest.page_action as ChromeManifestAction | undefined)?.default_icon ??
    manifest.icons;
  if (!icons) return null;
  if (typeof icons === "string") return icons;
  const sizes = Object.keys(icons)
    .map(Number)
    .filter((n) => !Number.isNaN(n))
    .sort((a, b) => b - a);
  const preferred = sizes.find((n) => n <= 48) ?? sizes[sizes.length - 1];
  if (preferred !== undefined) return icons[String(preferred)] ?? null;
  const firstKey = Object.keys(icons)[0];
  return firstKey ? icons[firstKey] : null;
}

export function manifestContentScripts(ext: ExtensionState): ContentScriptRegistration[] {
  return (ext.manifest.content_scripts ?? []).map((cs) => ({
    extId: ext.id,
    source: "manifest" as const,
    matches: cs.matches ?? [],
    excludeMatches: cs.exclude_matches ?? [],
    includeGlobs: cs.include_globs ?? [],
    excludeGlobs: cs.exclude_globs ?? [],
    js: (cs.js ?? []).map((file) => ({ file: file.replace(/^\/+/, "") })),
    css: (cs.css ?? []).map((file) => file.replace(/^\/+/, "")),
    runAt: cs.run_at ?? "document_idle",
    allFrames: cs.all_frames ?? false,
    matchAboutBlank: cs.match_about_blank ?? cs.match_origin_as_fallback ?? false,
    world: cs.world ?? "ISOLATED",
  }));
}

export function registrationFiles(regs: ContentScriptRegistration[]): string[] {
  const files: string[] = [];
  for (const r of regs) {
    for (const j of r.js) if ("file" in j) files.push(j.file);
    files.push(...r.css);
  }
  return files;
}

export async function loadRuleset(ext: ExtensionState, id: string): Promise<boolean> {
  if (ext.dnr.rulesets.has(id)) return true;
  const resource = ext.manifest.declarative_net_request?.rule_resources?.find((r) => r.id === id);
  if (!resource?.path) return false;
  const text = await ext.files.readText(resource.path);
  if (!text) {
    ext.dnr.rulesets.set(id, []);
    return true;
  }
  try {
    const rules = JSON.parse(text) as DNRRule[];
    ext.dnr.rulesets.set(id, Array.isArray(rules) ? rules : []);
  } catch (e) {
    console.warn(`[sapphire] ${ext.manifest.name}: failed to parse rule set ${resource.path}`, e);
    ext.dnr.rulesets.set(id, []);
  }
  return true;
}

async function loadDnr(ext: ExtensionState): Promise<void> {
  const resources = ext.manifest.declarative_net_request?.rule_resources ?? [];
  const persisted = await dbGet<{ dynamicRules?: DNRRule[]; enabledRulesets?: string[]; disabledStaticRules?: Record<string, number[]> }>(EXT_STATE_STORE, `${ext.id}/dnr`).catch(() => undefined);
  const enabled = persisted?.enabledRulesets ?? resources.filter((r) => r.enabled !== false && r.id).map((r) => r.id!);
  // Disabled rulesets only record their existence until someone enables them.
  for (const r of resources) if (r.id && !enabled.includes(r.id)) ext.dnr.rulesets.set(r.id, ext.dnr.rulesets.get(r.id) ?? []);
  for (const id of enabled) {
    ext.dnr.rulesets.delete(id);
    if (await loadRuleset(ext, id)) ext.dnr.enabledRulesets.add(id);
  }
  ext.dnr.dynamicRules = persisted?.dynamicRules ?? [];
  for (const [k, v] of Object.entries(persisted?.disabledStaticRules ?? {})) ext.dnr.disabledStaticRules.set(k, new Set(v));
  recomputeStaticRules(ext);
}

export async function loadExtension(s: Sapphire, meta: ExtensionMeta): Promise<ExtensionState> {
  const ext = s.registry.createExtensionState(meta);
  await loadLocales(ext);
  ext.manifest = localizeManifest(meta.manifest, (name) => getMessage(ext, name));
  ext.defaultAction = defaultActionFor(ext.manifest);
  ext.sidePanel.path = ext.manifest.side_panel?.default_path ?? null;

  const iconPath = getDefaultIcon(ext.manifest);
  if (iconPath) ext.iconUrl = await ext.files.dataUrl(iconPath.replace(/^\/+/, "")).catch(() => null);

  await loadDnr(ext);

  const manifestScripts = manifestContentScripts(ext);
  const stored = await dbGet<ContentScriptRegistration[]>(EXT_STATE_STORE, `${ext.id}/scripts`).catch(() => undefined);
  const dynamic = (stored ?? []).map((r) => ({ ...r, extId: ext.id }));
  s.registry.contentScripts.push(...manifestScripts, ...dynamic);
  await ext.files.preload(registrationFiles([...manifestScripts, ...dynamic]));
  // A service worker can importScripts() anything at any time, synchronously.
  if (ext.manifest.background?.service_worker) await ext.files.preloadMatching((p) => /\.m?js$/.test(p));

  await restoreAlarms(s, ext);
  return ext;
}

export function unregisterContentScripts(s: Sapphire, extId: string): void {
  const list = s.registry.contentScripts;
  for (let i = list.length - 1; i >= 0; i--) if (list[i].extId === extId) list.splice(i, 1);
}

export async function persistRegisteredScripts(s: Sapphire, extId: string): Promise<void> {
  const regs = s.registry.contentScripts.filter((cs) => cs.extId === extId && cs.source !== "manifest" && cs.persistAcrossSessions !== false);
  await dbPut(EXT_STATE_STORE, `${extId}/scripts`, regs).catch(() => {});
}

export interface UnpackedPackage {
  manifest: ChromeManifest;
  files: Map<string, ArrayBuffer>;
  id: string;
}

export async function unpackExtension(buffer: ArrayBuffer, filename: string): Promise<UnpackedPackage> {
  const crx = parseCrx(buffer);
  const zip = await JSZip.loadAsync(crx.zip);
  let root = "";
  if (!zip.file("manifest.json")) {
    const candidates = Object.keys(zip.files).filter((p) => p.endsWith("/manifest.json") && !p.startsWith("__MACOSX/"));
    candidates.sort((a, b) => a.split("/").length - b.split("/").length);
    if (!candidates.length) throw new Error("no manifest.json found in extension");
    root = candidates[0].slice(0, -"manifest.json".length);
  }
  const manifestText = await zip.file(`${root}manifest.json`)!.async("text");
  let manifest: ChromeManifest;
  try {
    manifest = parseManifestText(manifestText);
  } catch (e) {
    throw new Error(`invalid manifest: ${(e as Error).message}`);
  }
  if (!manifest || typeof manifest !== "object" || !manifest.name) throw new Error("invalid manifest: missing name");
  const files = new Map<string, ArrayBuffer>();
  const reads: Promise<void>[] = [];
  zip.forEach((path, file) => {
    if (file.dir || !path.startsWith(root) || path.startsWith("__MACOSX/") || path.startsWith("_metadata/")) return;
    const rel = path.slice(root.length);
    reads.push(file.async("arraybuffer").then((ab) => void files.set(rel, ab)));
  });
  await Promise.all(reads);
  let id: string;
  if (typeof manifest.key === "string" && manifest.key) id = await extensionIdFromPublicKey(manifest.key);
  else if (crx.crxId) id = crx.crxId;
  else if (crx.publicKey) id = await extensionIdFromPublicKey(crx.publicKey);
  else id = await extensionIdFromSeed(`${manifest.name}\n${filename.replace(/[-_ ]?v?\d+(\.\d+)*\.(zip|crx)$/i, "")}`);
  return { manifest, files, id };
}

export async function storePackage(pkg: UnpackedPackage, filename: string, previous?: ExtensionMeta): Promise<ExtensionMeta> {
  await dbDeletePrefix(EXT_FILES_STORE, `${pkg.id}/`);
  const entries = [...pkg.files].map(([path, ab]) => [`${pkg.id}/${path}`, ab] as [string, unknown]);
  for (let i = 0; i < entries.length; i += 200) await dbWriteMany(EXT_FILES_STORE, entries.slice(i, i + 200));
  const meta: ExtensionMeta = {
    id: pkg.id,
    manifest: pkg.manifest,
    enabled: previous?.enabled ?? true,
    installedAt: previous?.installedAt ?? Date.now(),
    filename,
    fileList: [...pkg.files.keys()],
    lastRunVersion: previous?.lastRunVersion,
  };
  await dbPut(EXT_STORE, null, meta);
  return meta;
}

export async function storedMetas(): Promise<ExtensionMeta[]> {
  return dbGetAll<ExtensionMeta>(EXT_STORE);
}

export async function storedMeta(id: string): Promise<ExtensionMeta | undefined> {
  return dbGet<ExtensionMeta>(EXT_STORE, id);
}

export async function saveMeta(meta: ExtensionMeta): Promise<void> {
  await dbPut(EXT_STORE, null, meta);
}

export async function deletePackage(ext: ExtensionState): Promise<void> {
  await dbDelete(EXT_STORE, ext.id);
  await dbDeletePrefix(EXT_FILES_STORE, `${ext.id}/`);
  await dbDeletePrefix(EXT_STATE_STORE, `${ext.id}/`);
  await ext.storage.local.destroy();
  await ext.storage.sync.destroy();
}
