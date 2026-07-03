import { buildExtensionUrl, extensionPathDir, resolveExtensionResourcePath, sapphireExtensionBase, sapphireBootstrapUrl } from "./urlScheme";

const RESOURCE_ATTR_RE = /(<(?:script|link|img)\b[^>]*\s(?:src|href)=["'])([^"']+)(["'][^>]*>)/gi;

export async function rewriteExtHtml(extId: string, html: string, pagePath: string): Promise<string> {
  const pageDir = extensionPathDir(pagePath);
  let result = html.replace(RESOURCE_ATTR_RE, (full, prefix: string, url: string, suffix: string) => {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|data:|blob:)/i.test(url)) return full; 
    return `${prefix}${buildExtensionUrl(extId, resolveExtensionResourcePath(pageDir, url))}${suffix}`;
  });

  const baseTag = `<base href="${sapphireExtensionBase(extId)}${pageDir ? `${pageDir}/` : ""}">`;
  if (/<head[^>]*>/i.test(result)) {
    result = result.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`);
  } else {
    result = result.replace(/<html([^>]*)>/i, `<html$1><head>${baseTag}</head>`);
  }
  return result;
}

export function bootstrapExtensionFrame(frame: HTMLIFrameElement, extId: string): Promise<Window> {
  return new Promise((resolve, reject) => {
    frame.addEventListener(
      "load",
      () => {
        const win = frame.contentWindow;
        if (win) resolve(win);
        else reject(new Error("sapphire: bootstrap frame has no window after load"));
      },
      { once: true },
    );
    frame.src = sapphireBootstrapUrl(extId);
  });
}

export function writeDocument(win: Window, html: string): void {
  win.document.open();
  win.document.write(html);
  win.document.close();

  setTimeout(() => win.dispatchEvent(new Event("load")), 0);
}

export function injectScript(win: Window, code: string): void {
  try {
    const doc = win.document;
    const script = doc.createElement("script");
    script.textContent = code;
    (doc.head || doc.documentElement).appendChild(script);
  } catch (e) {
    console.warn("[sapphire] injectScript failed", e);
  }
}

export function injectScriptFromUrl(win: Window, url: string, isModule: boolean): Promise<void> {
  return new Promise((resolve) => {
    try {
      const doc = win.document;
      const script = doc.createElement("script");
      if (isModule) script.type = "module";
      script.src = url;
      script.addEventListener("load", () => resolve(), { once: true });
      script.addEventListener("error", (e) => {
        console.warn("[sapphire] injectScriptFromUrl failed to load", url, e);
        resolve();
      }, { once: true });
      (doc.head || doc.documentElement).appendChild(script);
    } catch (e) {
      console.warn("[sapphire] injectScriptFromUrl failed", e);
      resolve();
    }
  });
}

export function injectStyle(win: Window, css: string): void {
  try {
    const doc = win.document;
    const style = doc.createElement("style");
    style.textContent = css;
    (doc.head || doc.documentElement).appendChild(style);
  } catch (e) {
    console.warn("[sapphire] injectStyle failed", e);
  }
}
