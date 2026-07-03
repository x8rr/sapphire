import { installChromeApi } from "./chromeApi";
import { readExtFileText } from "./fileStore";
import { injectScript, injectStyle } from "./htmlInject";
import { urlMatchesPatterns } from "./manifest";
import type { ExtensionState, SapphireRegistry } from "./registry";
import type { ChromeManifestContentScript, ContentScriptRegistration, SapphireHostBindings } from "./types";

export function registerContentScripts(ext: ExtensionState, registry: SapphireRegistry): void {
  const scripts: ChromeManifestContentScript[] = ext.manifest.content_scripts ?? [];
  for (const cs of scripts) {
    registry.contentScripts.push({
      extId: ext.id,
      matches: cs.matches ?? [],
      excludeMatches: cs.exclude_matches ?? [],
      js: cs.js ?? [],
      css: cs.css ?? [],
      runAt: cs.run_at ?? "document_idle",
      allFrames: cs.all_frames ?? false,
    });
  }
}

export function unregisterContentScripts(extId: string, registry: SapphireRegistry): void {
  for (let i = registry.contentScripts.length - 1; i >= 0; i--) {
    if (registry.contentScripts[i].extId === extId) registry.contentScripts.splice(i, 1);
  }
}

function generateDocumentId(): string {
  return typeof crypto?.randomUUID === "function" ? crypto.randomUUID().replace(/-/g, "") : Math.random().toString(36).slice(2).padEnd(32, "0");
}

export async function injectContentScripts(
  win: Window,
  tabId: number,
  url: string,
  isTopLevel: boolean,
  registry: SapphireRegistry,
  host: SapphireHostBindings,
): Promise<void> {
  if (!url) return;
  const matching = registry.contentScripts.filter(
    (cs) => (isTopLevel || cs.allFrames) && urlMatchesPatterns(url, cs.matches, cs.excludeMatches),
  );
  if (!matching.length) return;

  const documentId = generateDocumentId();
  const frameId = isTopLevel ? 0 : 1;

  const installedExts = new Set<string>();
  const ensureChromeApi = (extId: string) => {
    if (installedExts.has(extId)) return;
    installedExts.add(extId);
    installChromeApi(win, {
      extId,
      tabId,
      isBackground: false,
      registry,
      host,
      senderUrl: url,
      senderFrameId: frameId,
      senderDocumentId: documentId,
    });
  };

  const byRunAt: Record<ContentScriptRegistration["runAt"], ContentScriptRegistration[]> = {
    document_start: [],
    document_end: [],
    document_idle: [],
  };
  for (const cs of matching) {
    const ext = registry.get(cs.extId);
    if (!ext?.enabled) continue;
    byRunAt[cs.runAt].push(cs);
  }

  const injectGroup = async (group: ContentScriptRegistration[]) => {
    for (const cs of group) {
      ensureChromeApi(cs.extId);
      for (const cssFile of cs.css) {
        const css = await readExtFileText(cs.extId, cssFile);
        if (css) injectStyle(win, css);
      }
      for (const jsFile of cs.js) {
        const code = await readExtFileText(cs.extId, jsFile);
        if (code) injectScript(win, code);
      }
    }
  };

  await injectGroup(byRunAt.document_start);
  if (byRunAt.document_end.length) {
    win.addEventListener("DOMContentLoaded", () => void injectGroup(byRunAt.document_end), { once: true });
  }
  if (byRunAt.document_idle.length) {
    win.addEventListener("load", () => void injectGroup(byRunAt.document_idle), { once: true });
  }

  const tab = host.getTab(tabId);
  for (const extId of new Set(matching.map((cs) => cs.extId))) {
    registry.broadcast(extId, (e) => e.tabsOnUpdated, [tabId, { status: "complete" }, tab]);
  }
}
