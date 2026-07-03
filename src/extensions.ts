import JSZip from "jszip";
import { crxToZip, generateExtensionId } from "./crx";
import { dbDelete, dbGet, dbGetAll, dbGetAllKeys, dbPut, EXT_FILES_STORE, EXT_STORAGE_STORE, EXT_STORE } from "./db";
import { readExtFileText, readExtFileURL } from "./fileStore";
import { startBackground, stopBackground } from "./background";
import { registerContentScripts, unregisterContentScripts } from "./contentScripts";
import { getDefaultIcon, resolveManifestI18n } from "./manifest";
import { recomputeStaticRules } from "./dnr";
import type { SapphireRegistry } from "./registry";
import type { ChromeManifest, ExtensionMeta, SapphireHostBindings } from "./types";

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
  hasPopup: boolean;
}

async function loadMessages(extId: string, manifest: ChromeManifest): Promise<Record<string, { message: string }>> {
  const defaultLocale = manifest.default_locale ?? "en";
  const primary = await readExtFileText(extId, `_locales/${defaultLocale}/messages.json`);
  if (primary) {
    try {
      return JSON.parse(primary);
    } catch {
    }
  }
  if (defaultLocale !== "en") {
    const en = await readExtFileText(extId, "_locales/en/messages.json");
    if (en) {
      try {
        return JSON.parse(en);
      } catch {
      }
    }
  }
  return {};
}

export async function loadExtension(
  meta: ExtensionMeta,
  registry: SapphireRegistry,
  host: SapphireHostBindings,
  backgroundRoot: HTMLElement,
): Promise<void> {
  const ext = registry.createExtensionState(meta.id, meta.manifest, meta.enabled !== false, meta.installedAt, meta.filename);

  ext.messages = await loadMessages(ext.id, ext.manifest);
  resolveManifestI18n(ext.manifest, ext.messages);
  registerContentScripts(ext, registry);

  const defaultIconPath = getDefaultIcon(ext.manifest);
  if (defaultIconPath) {
    try {
      ext.iconUrl = await readExtFileURL(ext.id, defaultIconPath);
    } catch (e) {
      console.warn(`[sapphire] failed to resolve default icon for ${ext.manifest.name}`, e);
    }
  }

  const ruleResources = ext.manifest.declarative_net_request?.rule_resources ?? [];
  for (const ruleSet of ruleResources) {
    if (!ruleSet.path || !ruleSet.id) continue;
    const rulesText = await readExtFileText(ext.id, ruleSet.path);
    if (!rulesText) continue;
    try {
      ext.rulesetRules.set(ruleSet.id, JSON.parse(rulesText));
      if (ruleSet.enabled !== false) ext.enabledRulesetIds.add(ruleSet.id);
    } catch (e) {
      console.warn(`[sapphire] failed to parse rule set ${ruleSet.path}`, e);
    }
  }
  recomputeStaticRules(ext);

  if (ext.enabled) {
    try {
      await startBackground(ext, registry, host, backgroundRoot);
    } catch (e) {
      console.error(`[sapphire] failed to start background for ${ext.manifest.name}`, e);
    }
  }

  registry.notifyChange();
}

export async function loadStoredExtensions(registry: SapphireRegistry, host: SapphireHostBindings, backgroundRoot: HTMLElement): Promise<number> {
  const stored = await dbGetAll<ExtensionMeta>(EXT_STORE);
  for (const meta of stored) {
    try {
      await loadExtension(meta, registry, host, backgroundRoot);
    } catch (e) {
      console.error(`[sapphire] failed to load stored extension ${meta.id}`, e);
    }
  }
  return stored.length;
}

export async function installExtension(
  buffer: ArrayBuffer,
  filename: string,
  registry: SapphireRegistry,
  host: SapphireHostBindings,
  backgroundRoot: HTMLElement,
): Promise<string> {
  const zipBuffer = crxToZip(buffer);
  const zip = await JSZip.loadAsync(zipBuffer);

  const manifestFile = zip.file("manifest.json");
  if (!manifestFile) throw new Error("no manifest.json found in extension");
  const manifestText = await manifestFile.async("text");

  let manifest: ChromeManifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch (e) {
    throw new Error(`invalid manifest: ${(e as Error).message}`);
  }

  const extId = generateExtensionId(manifest.name + (manifest.version ?? ""));

  const fileOps: Promise<void>[] = [];
  zip.forEach((path, file) => {
    if (file.dir) return;
    fileOps.push(
      file
        .async("arraybuffer")
        .then((ab) => dbPut(EXT_FILES_STORE, `${extId}/${path}`, ab))
        .then(() => undefined)
        .catch((e) => {
          console.error(`[sapphire] failed to store file ${path} for ${manifest.name}`, e);
        }),
    );
  });
  await Promise.all(fileOps);

  const meta: ExtensionMeta = {
    id: extId,
    manifest,
    enabled: true,
    installedAt: Date.now(),
    filename,
    fileList: [],
  };
  await dbPut(EXT_STORE, null, meta);
  await loadExtension(meta, registry, host, backgroundRoot);
  return extId;
}

export async function uninstallExtension(extId: string, registry: SapphireRegistry): Promise<void> {
  const ext = registry.get(extId);
  if (!ext) return;

  stopBackground(ext);
  unregisterContentScripts(extId, registry);
  registry.remove(extId);

  await dbDelete(EXT_STORE, extId);
  const fileKeys = await dbGetAllKeys(EXT_FILES_STORE);
  for (const k of fileKeys.filter((key) => typeof key === "string" && key.startsWith(`${extId}/`))) {
    await dbDelete(EXT_FILES_STORE, k);
  }
  const storageKeys = await dbGetAllKeys(EXT_STORAGE_STORE);
  for (const k of storageKeys.filter((key) => typeof key === "string" && key.startsWith(`${extId}/`))) {
    await dbDelete(EXT_STORAGE_STORE, k);
  }
  registry.notifyChange();
}

export async function setExtensionEnabled(
  extId: string,
  enabled: boolean,
  registry: SapphireRegistry,
  host: SapphireHostBindings,
  backgroundRoot: HTMLElement,
): Promise<void> {
  const ext = registry.get(extId);
  if (!ext) return;
  ext.enabled = enabled;
  const stored = await dbGet<ExtensionMeta>(EXT_STORE, extId);
  if (stored) {
    stored.enabled = enabled;
    await dbPut(EXT_STORE, null, stored);
  }
  if (enabled) {
    await startBackground(ext, registry, host, backgroundRoot);
  } else {
    stopBackground(ext);
  }
  registry.notifyChange();
}

export function getInstalledExtensions(registry: SapphireRegistry): InstalledExtensionSummary[] {
  return registry.list().map((ext) => ({
    id: ext.id,
    name: ext.manifest.name,
    version: ext.manifest.version,
    enabled: ext.enabled,
    manifest: ext.manifest,
    iconUrl: ext.iconUrl,
    title: ext.title,
    badgeText: ext.badgeText,
    badgeColor: ext.badgeColor,
    hasPopup: Boolean(
      ext.popupPage ??
        ext.manifest.action?.default_popup ??
        ext.manifest.browser_action?.default_popup ??
        ext.manifest.page_action?.default_popup,
    ),
  }));
}
