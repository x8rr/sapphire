import { asyncApi, toRealm } from "../realm";
import { matchPattern } from "../matchPatterns";
import type { ExtensionContext } from "../registry";
import type { Sapphire } from "../sapphire";
import { hostAllowed } from "./permissions";
import type { Env, Namespace } from "./env";

export type WebRequestStage =
  | "onBeforeRequest"
  | "onBeforeSendHeaders"
  | "onSendHeaders"
  | "onHeadersReceived"
  | "onAuthRequired"
  | "onResponseStarted"
  | "onBeforeRedirect"
  | "onCompleted"
  | "onErrorOccurred";

const STAGES: WebRequestStage[] = [
  "onBeforeRequest",
  "onBeforeSendHeaders",
  "onSendHeaders",
  "onHeadersReceived",
  "onAuthRequired",
  "onResponseStarted",
  "onBeforeRedirect",
  "onCompleted",
  "onErrorOccurred",
];

export interface WebRequestDetails {
  requestId: string;
  url: string;
  method: string;
  frameId: number;
  parentFrameId: number;
  tabId: number;
  type: string;
  timeStamp: number;
  initiator?: string;
  documentId?: string;
  parentDocumentId?: string;
  documentLifecycle?: string;
  frameType?: string;
  requestHeaders?: { name: string; value: string }[];
  responseHeaders?: { name: string; value: string }[];
  statusCode?: number;
  statusLine?: string;
  fromCache?: boolean;
  ip?: string;
  redirectUrl?: string;
  error?: string;
  requestBody?: unknown;
}

export interface BlockingOutcome {
  cancel: boolean;
  redirectUrl?: string;
  requestHeaders?: { name: string; value?: string }[];
  responseHeaders?: { name: string; value?: string }[];
}

interface RequestFilter {
  urls?: string[];
  types?: string[];
  tabId?: number;
  windowId?: number;
}

function validateFilter(extra: unknown[]): void {
  const filter = extra[0] as RequestFilter | undefined;
  if (!filter || !Array.isArray(filter.urls)) {
    throw new TypeError("Error in invocation of webRequest.addListener: filter must contain 'urls'.");
  }
}

function filterMatches(filter: RequestFilter | undefined, details: WebRequestDetails): boolean {
  if (!filter) return false;
  if (filter.urls && !filter.urls.some((p) => matchPattern(p, details.url))) return false;
  if (filter.types && !filter.types.includes(details.type)) return false;
  if (filter.tabId !== undefined && filter.tabId !== details.tabId) return false;
  return true;
}

export function hasWebRequestListeners(s: Sapphire): boolean {
  for (const ctx of s.registry.contexts) {
    for (const stage of STAGES) if (ctx.events.peek(`webRequest.${stage}`)?.hasListeners()) return true;
  }
  return false;
}

/**
 * Run one webRequest stage across every extension. Listeners registered with
 * "blocking" are called synchronously and may cancel/redirect/rewrite headers;
 * everything else is informational.
 */
export function dispatchWebRequest(s: Sapphire, stage: WebRequestStage, details: WebRequestDetails): BlockingOutcome {
  const outcome: BlockingOutcome = { cancel: false };
  const contexts: ExtensionContext[] = [];
  for (const ext of [...s.registry.list()].sort((a, b) => a.installedAt - b.installedAt)) {
    if (!ext.enabled || !ext.grantedPermissions.has("webRequest")) continue;
    if (!hostAllowed(ext, details.url)) continue;
    // Requests for another extension's resources are invisible to webRequest.
    for (const ctx of s.registry.extensionContexts(ext.id)) contexts.push(ctx);
  }
  for (const ctx of contexts) {
    const ev = ctx.events.peek(`webRequest.${stage}`);
    if (!ev?.hasListeners()) continue;
    for (const entry of [...ev.entries]) {
      const filter = entry.extra[0] as RequestFilter | undefined;
      if (!filterMatches(filter, details)) continue;
      const spec = (entry.extra[1] as string[] | undefined) ?? [];
      const shaped: Record<string, unknown> = { ...details };
      if (!spec.includes("requestHeaders")) delete shaped.requestHeaders;
      if (!spec.includes("responseHeaders")) delete shaped.responseHeaders;
      if (!spec.includes("requestBody")) delete shaped.requestBody;
      if (spec.includes("blocking")) {
        const result = ev.invoke(entry, [toRealm(ctx, shaped)]) as BlockingOutcome | undefined;
        if (result && typeof result === "object") {
          if (result.cancel) outcome.cancel = true;
          if (result.redirectUrl && !outcome.redirectUrl) outcome.redirectUrl = String(result.redirectUrl);
          if (Array.isArray(result.requestHeaders)) outcome.requestHeaders = result.requestHeaders.map((h) => ({ name: String(h.name), value: h.value === undefined ? undefined : String(h.value) }));
          if (Array.isArray(result.responseHeaders)) outcome.responseHeaders = result.responseHeaders.map((h) => ({ name: String(h.name), value: h.value === undefined ? undefined : String(h.value) }));
        }
      } else {
        const snapshot = toRealm(ctx, shaped);
        queueMicrotask(() => ev.invoke(entry, [snapshot]));
      }
    }
  }
  return outcome;
}

export function createWebRequest(env: Env): Namespace {
  const { ctx } = env;
  const ns: Namespace = {
    handlerBehaviorChanged: asyncApi(ctx, () => undefined),
    MAX_HANDLER_BEHAVIOR_CHANGED_CALLS_PER_10_MINUTES: 20,
    ResourceType: Object.fromEntries(
      ["main_frame", "sub_frame", "stylesheet", "script", "image", "font", "object", "xmlhttprequest", "ping", "csp_report", "media", "websocket", "webbundle", "other"].map((t) => [t.toUpperCase(), t]),
    ),
    OnBeforeRequestOptions: { BLOCKING: "blocking", REQUEST_BODY: "requestBody", EXTRA_HEADERS: "extraHeaders" },
    OnBeforeSendHeadersOptions: { REQUEST_HEADERS: "requestHeaders", BLOCKING: "blocking", EXTRA_HEADERS: "extraHeaders" },
    OnSendHeadersOptions: { REQUEST_HEADERS: "requestHeaders", EXTRA_HEADERS: "extraHeaders" },
    OnHeadersReceivedOptions: { BLOCKING: "blocking", RESPONSE_HEADERS: "responseHeaders", EXTRA_HEADERS: "extraHeaders" },
    OnResponseStartedOptions: { RESPONSE_HEADERS: "responseHeaders", EXTRA_HEADERS: "extraHeaders" },
    OnCompletedOptions: { RESPONSE_HEADERS: "responseHeaders", EXTRA_HEADERS: "extraHeaders" },
    OnErrorOccurredOptions: { EXTRA_HEADERS: "extraHeaders" },
  };
  for (const stage of STAGES) ns[stage] = ctx.events.api(`webRequest.${stage}`, validateFilter);
  return ns;
}
