import { installChromeApi } from "./chromeApi";
import { readExtFileText } from "./fileStore";
import { bootstrapExtensionFrame, injectScriptFromUrl, rewriteExtHtml, writeDocument } from "./htmlInject";
import { getBackgroundInfo } from "./manifest";
import type { ExtensionState, SapphireRegistry } from "./registry";
import type { SapphireHostBindings } from "./types";
import { buildExtensionUrl, chromeExtensionUrl } from "./urlScheme";

export function stopBackground(ext: ExtensionState): void {
  if (ext.background?.kind === "frame") ext.background.frame?.remove();
  if (ext.background?.kind === "worker") ext.background.worker?.terminate();
  ext.background = null;
}

export async function startBackground(
  ext: ExtensionState,
  registry: SapphireRegistry,
  host: SapphireHostBindings,
  rootEl: HTMLElement,
): Promise<void> {
  const bgInfo = getBackgroundInfo(ext.manifest);
  if (!bgInfo) return;
  stopBackground(ext);

  const frame = document.createElement("iframe");
  frame.style.cssText = "position:fixed;width:0;height:0;border:none;opacity:0;pointer-events:none;z-index:-1;";
  frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
  frame.setAttribute("aria-hidden", "true");
  rootEl.appendChild(frame);

  let win: Window;
  try {
    win = await bootstrapExtensionFrame(frame, ext.id);
  } catch (e) {
    console.error(`[sapphire] failed to bootstrap background frame for ${ext.manifest.name}`, e);
    frame.remove();
    return;
  }

  const backgroundPath = bgInfo.type === "page" ? bgInfo.page : bgInfo.type === "worker" ? bgInfo.script : bgInfo.scripts[0];

  const events = installChromeApi(win, {
    extId: ext.id,
    tabId: null,
    isBackground: true,
    registry,
    host,
    senderUrl: backgroundPath ? chromeExtensionUrl(ext.id, backgroundPath) : undefined,
  });
  ext.background = { kind: "frame", frame, events };

  if (bgInfo.type === "page") {
    const raw = await readExtFileText(ext.id, bgInfo.page);
    const html = raw !== null ? await rewriteExtHtml(ext.id, raw, bgInfo.page) : "<!DOCTYPE html><html><head></head><body></body></html>";
    writeDocument(win, html);
  } else {
    writeDocument(win, "<!DOCTYPE html><html><head></head><body></body></html>");
    const scriptPaths = bgInfo.type === "worker" ? [bgInfo.script] : bgInfo.scripts;
    const isModule = bgInfo.type === "worker" && bgInfo.isModule;
    for (const path of scriptPaths) {
      await injectScriptFromUrl(win, buildExtensionUrl(ext.id, path), isModule);
    }
  }

  events.runtimeOnInstalled.fire({ reason: "install" });
  events.runtimeOnStartup.fire();
}
