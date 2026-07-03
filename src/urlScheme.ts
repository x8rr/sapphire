export const SAPPHIRE_PREFIX = "/~/sx/";

export function sapphireBootstrapUrl(extId: string): string {
  return `${sapphireExtensionBase(extId)}__bootstrap__`;
}

export function sapphireExtensionBase(extId: string): string {
  return `${globalThis.location.origin}${SAPPHIRE_PREFIX}${extId}/`;
}

export function buildExtensionUrl(extId: string, path: string): string {
  return `${sapphireExtensionBase(extId)}${path.replace(/^\//, "")}`;
}

export function chromeExtensionUrl(extId: string, path: string): string {
  return `chrome-extension://${extId}/${path.replace(/^\//, "")}`;
}

export function resolveExtensionResourcePath(pageDir: string, ref: string): string {
  if (ref.startsWith("/")) return ref.replace(/^\
  const fakeBase = `sapphire://x/${pageDir ? `${pageDir}/` : ""}`;
  const resolved = new URL(ref, fakeBase);
  return decodeURIComponent(resolved.pathname.replace(/^\
}

export function extensionPathDir(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

export function decodeSapphirePath(pathname: string): { extId: string; path: string } | null {
  if (!pathname.startsWith(SAPPHIRE_PREFIX)) return null;
  const rest = pathname.slice(SAPPHIRE_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash === -1) return null;
  const extId = rest.slice(0, slash);
  const path = decodeURIComponent(rest.slice(slash + 1));
  if (!extId || !path) return null;
  return { extId, path };
}

export function decodeSapphireUrl(input: string): { extId: string; path: string } | null {
  try {
    const url = new URL(input, globalThis.location.href);
    if (url.protocol === "chrome-extension:") {
      const extId = url.hostname;
      const path = decodeURIComponent(url.pathname.replace(/^\
      if (!extId || !path) return null;
      return { extId, path };
    }
    if (url.origin !== globalThis.location.origin) return null;
    return decodeSapphirePath(url.pathname);
  } catch {
    return null;
  }
}
