import { mountExtensionPage } from "./pageMount";
import type { SapphireRegistry } from "./registry";
import type { SapphireHostBindings } from "./types";

function resolvePopupPage(registry: SapphireRegistry, extId: string): string | null {
  const ext = registry.get(extId);
  if (!ext) return null;
  const manifest = ext.manifest;
  return (
    ext.popupPage ??
    manifest.action?.default_popup ??
    manifest.browser_action?.default_popup ??
    manifest.page_action?.default_popup ??
    null
  );
}

export function getExtensionPopupPage(registry: SapphireRegistry, extId: string): string | null {
  return resolvePopupPage(registry, extId);
}

export async function mountExtensionPopup(
  frame: HTMLIFrameElement,
  extId: string,
  tabId: number | null,
  registry: SapphireRegistry,
  host: SapphireHostBindings,
): Promise<boolean> {
  const popupPage = resolvePopupPage(registry, extId);
  if (!popupPage) return false;
  return mountExtensionPage(frame, extId, popupPage, tabId, registry, host, true);
}
