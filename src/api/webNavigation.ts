import { ApiError, asyncApi, toRealm } from "../realm";
import type { Sapphire } from "../sapphire";
import type { Env, Namespace } from "./env";

export interface UrlFilter {
  hostContains?: string;
  hostEquals?: string;
  hostPrefix?: string;
  hostSuffix?: string;
  pathContains?: string;
  pathEquals?: string;
  pathPrefix?: string;
  pathSuffix?: string;
  queryContains?: string;
  queryEquals?: string;
  queryPrefix?: string;
  querySuffix?: string;
  urlContains?: string;
  urlEquals?: string;
  urlMatches?: string;
  originAndPathMatches?: string;
  urlPrefix?: string;
  urlSuffix?: string;
  schemes?: string[];
  ports?: (number | number[])[];
  cidrBlocks?: string[];
}

export function matchUrlFilter(f: UrlFilter, input: string): boolean {
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return false;
  }
  const host = u.hostname;
  const path = u.pathname;
  const query = u.search.replace(/^\?/, "");
  const full = u.href.split("#")[0];
  if (f.hostContains !== undefined && !`.${host}`.includes(f.hostContains)) return false;
  if (f.hostEquals !== undefined && host !== f.hostEquals) return false;
  if (f.hostPrefix !== undefined && !host.startsWith(f.hostPrefix)) return false;
  if (f.hostSuffix !== undefined && !host.endsWith(f.hostSuffix)) return false;
  if (f.pathContains !== undefined && !path.includes(f.pathContains)) return false;
  if (f.pathEquals !== undefined && path !== f.pathEquals) return false;
  if (f.pathPrefix !== undefined && !path.startsWith(f.pathPrefix)) return false;
  if (f.pathSuffix !== undefined && !path.endsWith(f.pathSuffix)) return false;
  if (f.queryContains !== undefined && !query.includes(f.queryContains)) return false;
  if (f.queryEquals !== undefined && query !== f.queryEquals) return false;
  if (f.queryPrefix !== undefined && !query.startsWith(f.queryPrefix)) return false;
  if (f.querySuffix !== undefined && !query.endsWith(f.querySuffix)) return false;
  if (f.urlContains !== undefined && !full.includes(f.urlContains)) return false;
  if (f.urlEquals !== undefined && full !== f.urlEquals) return false;
  if (f.urlPrefix !== undefined && !full.startsWith(f.urlPrefix)) return false;
  if (f.urlSuffix !== undefined && !full.endsWith(f.urlSuffix)) return false;
  try {
    if (f.urlMatches !== undefined && !new RegExp(f.urlMatches).test(full)) return false;
    if (f.originAndPathMatches !== undefined && !new RegExp(f.originAndPathMatches).test(u.origin + path)) return false;
  } catch {
    return false;
  }
  if (f.schemes && !f.schemes.includes(u.protocol.slice(0, -1))) return false;
  if (f.ports) {
    const port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
    if (!f.ports.some((p) => (Array.isArray(p) ? port >= p[0] && port <= p[1] : port === p))) return false;
  }
  return true;
}

/** Deliver a webNavigation event, honouring each listener's `{url: [UrlFilter]}`. */
export function dispatchNavigation(s: Sapphire, event: string, details: Record<string, unknown>): void {
  for (const ext of s.registry.list()) {
    if (!ext.enabled || !ext.grantedPermissions.has("webNavigation")) continue;
    for (const ctx of s.registry.extensionContexts(ext.id)) {
      const ev = ctx.events.peek(`webNavigation.${event}`);
      if (!ev?.hasListeners()) continue;
      ev.dispatchFiltered(
        (entry) => {
          const filters = (entry.extra[0] as { url?: UrlFilter[] } | undefined)?.url;
          return !filters?.length || filters.some((f) => matchUrlFilter(f, String(details.url ?? "")));
        },
        () => [toRealm(ctx, details)],
      );
    }
  }
}

export function createWebNavigation(env: Env): Namespace {
  const { s, ctx } = env;
  const describe = (tabId: number, frameId: number) => {
    const frame = s.registry.liveFrames(tabId).find((f) => f.frameId === frameId);
    if (!frame) return null;
    const parent = s.registry.liveFrames(tabId).find((f) => f.frameId === frame.parentFrameId);
    return {
      errorOccurred: frame.errorOccurred,
      url: frame.url,
      parentFrameId: frame.parentFrameId,
      documentId: frame.documentId,
      documentLifecycle: frame.documentLifecycle,
      frameType: frame.frameId === 0 ? "outermost_frame" : "sub_frame",
      ...(parent ? { parentDocumentId: parent.documentId } : {}),
    };
  };
  const ns: Namespace = {
    getFrame: asyncApi(ctx, (details: { tabId?: number; frameId?: number; documentId?: string }) => {
      let tabId = details?.tabId;
      let frameId = details?.frameId;
      if (details?.documentId) {
        for (const [id] of s.registry.tabs) {
          const f = s.registry.liveFrames(id).find((fr) => fr.documentId === details.documentId);
          if (f) {
            tabId = id;
            frameId = f.frameId;
          }
        }
      }
      if (tabId === undefined || frameId === undefined) throw new ApiError("Either documentId or both tabId and frameId must be specified.");
      return describe(tabId, frameId);
    }),
    getAllFrames: asyncApi(ctx, (details: { tabId: number }) => {
      if (!s.host.getTab(details?.tabId)) return null;
      return s.registry.liveFrames(details.tabId).map((f) => ({ ...describe(details.tabId, f.frameId), frameId: f.frameId, processId: 1 }));
    }),
    TransitionType: Object.fromEntries(
      ["link", "typed", "auto_bookmark", "auto_subframe", "manual_subframe", "generated", "start_page", "form_submit", "reload", "keyword", "keyword_generated"].map((t) => [t.toUpperCase(), t]),
    ),
    TransitionQualifier: { CLIENT_REDIRECT: "client_redirect", SERVER_REDIRECT: "server_redirect", FORWARD_BACK: "forward_back", FROM_ADDRESS_BAR: "from_address_bar" },
  };
  for (const ev of ["onBeforeNavigate", "onCommitted", "onDOMContentLoaded", "onCompleted", "onErrorOccurred", "onCreatedNavigationTarget", "onReferenceFragmentUpdated", "onTabReplaced", "onHistoryStateUpdated"]) {
    ns[ev] = ctx.events.api(`webNavigation.${ev}`);
  }
  return ns;
}
