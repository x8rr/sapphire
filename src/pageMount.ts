import { installChromeApi } from "./chromeApi";
import { readExtFileText } from "./fileStore";
import { bootstrapExtensionFrame, rewriteExtHtml, writeDocument } from "./htmlInject";
import type { SapphireRegistry } from "./registry";
import type { SapphireHostBindings } from "./types";
import { chromeExtensionUrl } from "./urlScheme";

export async function mountExtensionPage(
  frame: HTMLIFrameElement,
  extId: string,
  pagePath: string,
  tabId: number | null,
  registry: SapphireRegistry,
  host: SapphireHostBindings,
  skipTabRegistration: boolean,
): Promise<boolean> {
  const win = await bootstrapExtensionFrame(frame, extId);

  const events = installChromeApi(win, {
    extId,
    tabId,
    isBackground: false,
    registry,
    host,
    skipTabRegistration,
    senderUrl: chromeExtensionUrl(extId, pagePath),
  });

  if (skipTabRegistration) {
    const ext = registry.get(extId);
    if (ext) ext.popupEvents = events;
  }

  const raw = await readExtFileText(extId, pagePath);
  if (raw === null) return false;
  const html = await rewriteExtHtml(extId, raw, pagePath);
  writeDocument(win, html);
  return true;
}
