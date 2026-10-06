// Extension resources live on a per-extension https origin instead of
// chrome-extension://. Scramjet only proxies http(s) URLs — anything else is
// passed through untouched and the real browser refuses to load it — so an
// https alias is what lets extension pages, content-script `getURL()` images,
// injected extension iframes, and `fetch(getURL(...))` all flow through the
// proxy, where Sapphire's fetch hook answers them from IndexedDB. `.invalid` is
// reserved (RFC 2606): if a request ever escaped the hook it cannot resolve.
import { SAPPHIRE_PREFIX } from "./urlScheme";

let hostSuffix = "sapphire-extension.invalid";

export function setExtensionHostSuffix(suffix: string): void {
  hostSuffix = suffix.replace(/^\.+/, "");
}

export function extensionHostSuffix(): string {
  return hostSuffix;
}

export function extensionOrigin(extId: string): string {
  return `https://${extId}.${hostSuffix}`;
}

export function extensionUrl(extId: string, path = ""): string {
  const clean = String(path).replace(/^\/+/, "");
  return `${extensionOrigin(extId)}/${clean}`;
}

export function isExtensionHost(hostname: string): string | null {
  const suffix = `.${hostSuffix}`;
  if (!hostname.endsWith(suffix)) return null;
  const id = hostname.slice(0, -suffix.length);
  return /^[a-p]{32}$|^[a-z0-9]{1,64}$/.test(id) ? id : null;
}

export interface ParsedExtensionUrl {
  extId: string;
  /** Decoded path without the leading slash. */
  path: string;
  search: string;
  hash: string;
}

/**
 * Recognises every spelling an extension URL can arrive in: the alias origin,
 * a literal chrome-extension:// URL (hard-coded strings, `tabs.create`), and the
 * legacy `/~/sx/<id>/` host path from older Sapphire versions.
 */
export function parseExtensionUrl(input: string | URL, base?: string): ParsedExtensionUrl | null {
  let url: URL;
  try {
    url = new URL(String(input), base ?? globalThis.location?.href);
  } catch {
    return null;
  }
  const decode = (p: string) => {
    try {
      return decodeURIComponent(p);
    } catch {
      return p;
    }
  };
  if (url.protocol === "chrome-extension:" || url.protocol === "moz-extension:") {
    if (!url.hostname) return null;
    return { extId: url.hostname, path: decode(url.pathname.replace(/^\/+/, "")), search: url.search, hash: url.hash };
  }
  if (url.protocol === "https:" || url.protocol === "http:") {
    const extId = isExtensionHost(url.hostname);
    if (extId) return { extId, path: decode(url.pathname.replace(/^\/+/, "")), search: url.search, hash: url.hash };
    if (globalThis.location && url.origin === globalThis.location.origin && url.pathname.startsWith(SAPPHIRE_PREFIX)) {
      const rest = url.pathname.slice(SAPPHIRE_PREFIX.length);
      const slash = rest.indexOf("/");
      if (slash > 0) return { extId: rest.slice(0, slash), path: decode(rest.slice(slash + 1)), search: url.search, hash: url.hash };
    }
  }
  return null;
}

/** chrome-extension:// (or legacy) URL → alias URL. Anything else is returned unchanged. */
export function normalizeExtensionUrl(input: string, base?: string): string {
  const parsed = parseExtensionUrl(input, base);
  if (!parsed) return input;
  return extensionUrl(parsed.extId, parsed.path) + parsed.search + parsed.hash;
}

/** Alias URL → chrome-extension:// for display in host UI. */
export function displayExtensionUrl(input: string): string {
  const parsed = parseExtensionUrl(input);
  if (!parsed) return input;
  return `chrome-extension://${parsed.extId}/${parsed.path}${parsed.search}${parsed.hash}`;
}

/** Resolve a manifest-relative or page-relative reference to a package path. */
export function resolvePackagePath(ref: string, fromPath = ""): string {
  const dir = fromPath.includes("/") ? fromPath.slice(0, fromPath.lastIndexOf("/") + 1) : "";
  const resolved = new URL(ref, `https://x.invalid/${ref.startsWith("/") ? "" : dir}`);
  try {
    return decodeURIComponent(resolved.pathname.replace(/^\/+/, ""));
  } catch {
    return resolved.pathname.replace(/^\/+/, "");
  }
}
