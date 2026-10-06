import { ApiError, asyncApi, toRealm } from "../realm";
import type { Sapphire } from "../sapphire";
import type { Env, Namespace } from "./env";

interface JarCookie {
  name: string;
  value: string;
  path?: string;
  expires?: number;
  domain?: string;
  hostOnly?: boolean;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: string;
}

export interface ChromeCookie {
  name: string;
  value: string;
  domain: string;
  hostOnly: boolean;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: "no_restriction" | "lax" | "strict" | "unspecified";
  session: boolean;
  expirationDate?: number;
  storeId: string;
}

function jarCookies(s: Sapphire): JarCookie[] {
  const jar = s.controller?.cookieJar as { dump(): string } | undefined;
  if (!jar) return [];
  try {
    return Object.values(JSON.parse(jar.dump()) as Record<string, JarCookie>).filter((c) => c.expires === undefined || c.expires > Date.now());
  } catch {
    return [];
  }
}

function toChrome(c: JarCookie): ChromeCookie {
  const hostOnly = !!c.hostOnly;
  const domain = hostOnly ? String(c.domain ?? "").replace(/^\./, "") : String(c.domain ?? "");
  const ss = String(c.sameSite ?? "").toLowerCase();
  return {
    name: c.name,
    value: c.value,
    domain,
    hostOnly,
    path: c.path ?? "/",
    secure: !!c.secure,
    httpOnly: !!c.httpOnly,
    sameSite: ss === "none" ? "no_restriction" : ss === "strict" ? "strict" : ss === "lax" ? "lax" : "unspecified",
    session: c.expires === undefined,
    ...(c.expires !== undefined ? { expirationDate: c.expires / 1000 } : {}),
    storeId: "0",
  };
}

function domainMatch(cookieDomain: string, host: string, hostOnly: boolean): boolean {
  const d = cookieDomain.replace(/^\./, "");
  return hostOnly ? host === d : host === d || host.endsWith(`.${d}`);
}

function pathMatch(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith("/") || requestPath[cookiePath.length] === "/";
}

function select(s: Sapphire, details: { url?: string; name?: string; domain?: string; path?: string; secure?: boolean; session?: boolean }): ChromeCookie[] {
  let url: URL | null = null;
  if (details.url) {
    try {
      url = new URL(details.url);
    } catch {
      throw new ApiError(`Invalid url: "${details.url}".`);
    }
  }
  return jarCookies(s)
    .map(toChrome)
    .filter((c) => {
      if (details.name !== undefined && c.name !== details.name) return false;
      if (details.domain !== undefined) {
        const d = details.domain.replace(/^\./, "").toLowerCase();
        const cd = c.domain.replace(/^\./, "");
        if (cd !== d && !cd.endsWith(`.${d}`)) return false;
      }
      if (details.path !== undefined && c.path !== details.path) return false;
      if (details.secure !== undefined && c.secure !== details.secure) return false;
      if (details.session !== undefined && c.session !== details.session) return false;
      if (url) {
        if (!domainMatch(c.domain, url.hostname, c.hostOnly)) return false;
        if (!pathMatch(url.pathname || "/", c.path)) return false;
      }
      return true;
    })
    .sort((a, b) => b.path.length - a.path.length);
}

async function writeCookie(s: Sapphire, url: URL, header: string): Promise<void> {
  const controller = s.controller as
    | { cookieJar: { setCookies(str: string, url: URL): void }; persistCookies(): Promise<void>; propagateCookieSync(c: { url: string; cookie: string }[]): Promise<void> }
    | null;
  if (!controller) throw new ApiError("No cookie store is available.");
  controller.cookieJar.setCookies(header, url);
  await controller.persistCookies();
  await controller.propagateCookieSync([{ url: url.href, cookie: header }]).catch(() => {});
}

export function notifyCookieChange(s: Sapphire, cookie: ChromeCookie, removed: boolean, cause: string): void {
  for (const ext of s.registry.list()) {
    if (!ext.enabled || !ext.grantedPermissions.has("cookies")) continue;
    s.registry.dispatch(ext.id, "cookies.onChanged", (ctx) => [toRealm(ctx, { removed, cookie, cause })]);
  }
}

export function createCookies(env: Env): Namespace {
  const { s, ctx } = env;
  return {
    get: asyncApi(ctx, (details: { url: string; name: string }) => select(s, { url: details?.url, name: details?.name })[0] ?? null),
    getAll: asyncApi(ctx, (details: Record<string, unknown> = {}) => select(s, details)),
    set: asyncApi(
      ctx,
      async (details: { url: string; name?: string; value?: string; domain?: string; path?: string; secure?: boolean; httpOnly?: boolean; sameSite?: string; expirationDate?: number }) => {
        let url: URL;
        try {
          url = new URL(details.url);
        } catch {
          throw new ApiError(`Invalid url: "${details?.url}".`);
        }
        let header = `${details.name ?? ""}=${details.value ?? ""}`;
        header += `; Path=${details.path ?? "/"}`;
        if (details.domain) header += `; Domain=${details.domain}`;
        if (details.secure) header += "; Secure";
        if (details.httpOnly) header += "; HttpOnly";
        if (details.sameSite && details.sameSite !== "unspecified") header += `; SameSite=${details.sameSite === "no_restriction" ? "None" : details.sameSite}`;
        if (details.expirationDate !== undefined) header += `; Expires=${new Date(details.expirationDate * 1000).toUTCString()}`;
        await writeCookie(s, url, header);
        const cookie = select(s, { url: url.href, name: details.name ?? "" })[0] ?? null;
        if (cookie) notifyCookieChange(s, cookie, false, "explicit");
        return cookie;
      },
    ),
    remove: asyncApi(ctx, async (details: { url: string; name: string }) => {
      const url = new URL(details.url);
      const existing = select(s, { url: url.href, name: details.name })[0];
      if (!existing) return null;
      let header = `${details.name}=; Path=${existing.path}; Max-Age=0`;
      if (!existing.hostOnly) header += `; Domain=${existing.domain}`;
      await writeCookie(s, url, header);
      notifyCookieChange(s, existing, true, "explicit");
      return { url: details.url, name: details.name, storeId: "0" };
    }),
    getAllCookieStores: asyncApi(ctx, () => [{ id: "0", tabIds: s.host.getAllTabs().map((t) => t.id) }]),
    getPartitionKey: asyncApi(ctx, () => ({ partitionKey: {} })),
    onChanged: ctx.events.api("cookies.onChanged"),
    OnChangedCause: { EVICTED: "evicted", EXPIRED: "expired", EXPLICIT: "explicit", EXPIRED_OVERWRITE: "expired_overwrite", OVERWRITE: "overwrite" },
    SameSiteStatus: { NO_RESTRICTION: "no_restriction", LAX: "lax", STRICT: "strict", UNSPECIFIED: "unspecified" },
  };
}
