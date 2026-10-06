import { allowAllPriorities, applyHeaderOps, evaluateRequest, type DnrOutcome, type ResourceType } from "./dnr";
import { dispatchWebRequest, hasWebRequestListeners, type WebRequestDetails } from "./api/webRequest";
import { localizeCss } from "./content";
import { guessMime, isTextMime } from "./crx";
import type { FramePluginInfo } from "./frames";
import type { ExtensionState } from "./registry";
import type { Sapphire } from "./sapphire";
import { toRealm } from "./realm";
import { isExtensionHost } from "./urls";

type RawHeaders = [string, string][];

interface FetchRequestLike {
  method: string;
  rawUrl: URL;
  destination?: string;
}

interface ParsedLike {
  url: URL;
  clientUrl?: URL;
  destination: string;
  isIframe?: boolean;
}

interface RequestState {
  details: WebRequestDetails;
  dnr: DnrOutcome | null;
  watched: boolean;
}

export const BLOCKED_HEADER = "x-sapphire-blocked";
export const GENERATED_BACKGROUND = "_generated_background_page.html";

const states = new WeakMap<object, RequestState>();
let requestCounter = 0;

/** document/iframe allowAllRequests matches, keyed by `${tabId} ${documentUrl}`. */
const allowAllDocs = new Map<string, Map<string, number>>();

function resourceType(parsed: ParsedLike, request: FetchRequestLike): ResourceType {
  const dest = parsed.destination || request.destination || "";
  switch (dest) {
    case "document":
    case "iframe":
    case "frame":
      return parsed.isIframe ? "sub_frame" : "main_frame";
    case "script":
    case "worker":
    case "sharedworker":
    case "serviceworker":
    case "audioworklet":
    case "paintworklet":
    case "xslt":
      return "script";
    case "style":
      return "stylesheet";
    case "image":
      return "image";
    case "font":
      return "font";
    case "object":
    case "embed":
      return "object";
    case "audio":
    case "video":
    case "track":
      return "media";
    case "report":
      return "csp_report";
    case "manifest":
    case "webidentity":
      return "other";
    case "":
      return "xmlhttprequest";
    default:
      return "other";
  }
}

function safeUrl(u: URL | string | undefined | null): URL | null {
  if (!u) return null;
  try {
    return new URL(String(u));
  } catch {
    return null;
  }
}

function headersToChrome(raw: RawHeaders): { name: string; value: string }[] {
  return raw.map(([name, value]) => ({ name, value }));
}

function chromeToHeaders(list: { name: string; value?: string }[]): RawHeaders {
  return list.filter((h) => h.value !== undefined).map((h) => [h.name, String(h.value)]);
}

function blockedResponse(type: ResourceType, url: string): Response {
  if (type === "main_frame" || type === "sub_frame") {
    const host = safeUrl(url)?.hostname ?? url;
    const escaped = host.replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`);
    return new Response(
      `<!doctype html><html><head><meta charset="utf-8"><title>${escaped}</title><style>body{font:14px system-ui,sans-serif;color:#5f6368;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}main{max-width:520px;padding:24px}h1{font-size:22px;color:#202124;font-weight:500}</style></head><body><main><h1>This page has been blocked by an extension</h1><p>${escaped} was blocked. Try disabling your extensions.</p><p style="font-size:12px">ERR_BLOCKED_BY_CLIENT</p></main></body></html>`,
      { status: 200, headers: { "content-type": "text/html; charset=utf-8", [BLOCKED_HEADER]: "document" } },
    );
  }
  return new Response("", { status: 403, statusText: "Blocked by client", headers: { [BLOCKED_HEADER]: "1" } });
}

function redirectResponse(location: string): Response {
  return new Response(null, { status: 307, statusText: "Internal Redirect", headers: { location, "non-authoritative-reason": "WebRequest API" } });
}

function generatedBackgroundPage(ext: ExtensionState): string {
  const bg = ext.manifest.background ?? {};
  const scripts = bg.service_worker ? [bg.service_worker] : (bg.scripts ?? []);
  const type = bg.service_worker && bg.type === "module" ? ' type="module"' : "";
  const tags = scripts.map((src) => `<script${type} src="/${String(src).replace(/^\/+/, "").replace(/"/g, "&quot;")}"></script>`).join("");
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${bg.service_worker ? "Service Worker" : "Background Page"}</title></head><body>${tags}</body></html>`;
}

export async function serveExtensionResource(s: Sapphire, extId: string, url: URL, method: string): Promise<Response> {
  const ext = s.registry.get(extId);
  const base = { "access-control-allow-origin": "*", "cache-control": "no-cache", "cross-origin-resource-policy": "cross-origin" };
  if (!ext || !ext.enabled) {
    return new Response("", { status: 404, headers: { ...base, [BLOCKED_HEADER]: "1" } });
  }
  let path = url.pathname.replace(/^\/+/, "");
  try {
    path = decodeURIComponent(path);
  } catch {
    // keep raw
  }
  if (path === GENERATED_BACKGROUND && !(await ext.files.read(path))) {
    return new Response(method === "HEAD" ? null : generatedBackgroundPage(ext), { status: 200, headers: { ...base, "content-type": "text/html; charset=utf-8" } });
  }
  const mime = guessMime(path);
  if (!path || path.endsWith("/")) {
    return new Response("", { status: 404, headers: base });
  }
  if (mime === "text/css") {
    const css = await ext.files.readText(path);
    if (css === null) return new Response("", { status: 404, headers: base });
    return new Response(method === "HEAD" ? null : localizeCss(ext, css), { status: 200, headers: { ...base, "content-type": "text/css; charset=utf-8" } });
  }
  const bytes = await ext.files.read(path);
  if (!bytes) return new Response("", { status: 404, headers: base });
  return new Response(method === "HEAD" ? null : bytes, {
    status: 200,
    headers: { ...base, "content-type": isTextMime(mime) ? `${mime}; charset=utf-8` : mime },
  });
}

function recordMatches(s: Sapphire, outcome: DnrOutcome, tabId: number, details: WebRequestDetails): void {
  const now = Date.now();
  const counted = new Set<string>();
  for (const m of outcome.matched) {
    if (m.rule.id < 0) continue;
    const ext = s.registry.get(m.extId);
    if (!ext) continue;
    const type = m.rule.action.type;
    if (ext.grantedPermissions.has("declarativeNetRequestFeedback")) {
      ext.dnr.matchedRules.push({ rule: { ruleId: m.rule.id, rulesetId: m.rulesetId }, tabId, timeStamp: now });
      if (ext.dnr.matchedRules.length > 5000) ext.dnr.matchedRules.splice(0, 1000);
      s.registry.dispatch(ext.id, "declarativeNetRequest.onRuleMatchedDebug", (ctx) => [
        toRealm(ctx, {
          request: { requestId: details.requestId, url: details.url, method: details.method, frameId: details.frameId, partentFrameId: details.parentFrameId, parentFrameId: details.parentFrameId, tabId, type: details.type, initiator: details.initiator, documentId: details.documentId },
          rule: { ruleId: m.rule.id, rulesetId: m.rulesetId },
        }),
      ]);
    }
    if ((type === "block" || type === "redirect" || type === "upgradeScheme") && tabId >= 0 && !counted.has(ext.id)) {
      counted.add(ext.id);
      ext.dnr.tabActionCounts.set(tabId, (ext.dnr.tabActionCounts.get(tabId) ?? 0) + 1);
      if (ext.dnr.displayActionCountAsBadgeText) s.scheduleChange();
    }
  }
}

function frameIdFor(s: Sapphire, tabId: number, parsed: ParsedLike, type: ResourceType): { frameId: number; parentFrameId: number; documentId?: string } {
  if (tabId < 0) return { frameId: -1, parentFrameId: -1 };
  if (type === "main_frame") return { frameId: 0, parentFrameId: -1 };
  const client = parsed.clientUrl?.href;
  const frames = s.registry.liveFrames(tabId);
  const owner = client ? frames.filter((f) => f.url === client).sort((a, b) => b.frameId - a.frameId)[0] : undefined;
  if (type === "sub_frame") return { frameId: -1, parentFrameId: owner?.frameId ?? 0 };
  return { frameId: owner?.frameId ?? 0, parentFrameId: owner?.parentFrameId ?? -1, documentId: owner?.documentId };
}

export async function onFetchRequest(
  s: Sapphire,
  info: FramePluginInfo,
  ctx: { request: FetchRequestLike; parsed: ParsedLike },
  props: { init: { headers?: RawHeaders; method?: string }; url: URL; earlyResponse?: unknown },
): Promise<void> {
  const url = props.url;
  const extId = isExtensionHost(url.hostname);
  if (extId) {
    props.earlyResponse = await serveExtensionResource(s, extId, url, ctx.request.method);
    return;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return;
  if (url.hostname.endsWith(".chromiumapp.org") && s.completeAuthFlow(url)) {
    props.earlyResponse = new Response("<!doctype html><title>Signed in</title>", { status: 200, headers: { "content-type": "text/html" } });
    return;
  }
  const initiator = safeUrl(ctx.parsed.clientUrl);
  // Requests made by extensions are invisible to other extensions' DNR/webRequest.
  if (initiator && isExtensionHost(initiator.hostname)) return;

  const dnrActive = s.hasDnrRules();
  const wrActive = hasWebRequestListeners(s);
  if (!dnrActive && !wrActive) return;

  const tabId = info.kind === "tab" ? (info.tabId ?? -1) : -1;
  const type = resourceType(ctx.parsed, ctx.request);
  const frame = frameIdFor(s, tabId, ctx.parsed, type);
  const details: WebRequestDetails = {
    requestId: String(++requestCounter),
    url: url.href,
    method: (ctx.request.method || "GET").toUpperCase(),
    frameId: frame.frameId === -1 && type === "sub_frame" ? 0 : frame.frameId,
    parentFrameId: frame.parentFrameId,
    tabId,
    type,
    timeStamp: Date.now(),
    ...(initiator && type !== "main_frame" ? { initiator: initiator.origin } : {}),
    ...(frame.documentId ? { documentId: frame.documentId } : {}),
    documentLifecycle: "active",
    frameType: frame.frameId === 0 ? "outermost_frame" : "sub_frame",
  };
  const state: RequestState = { details, dnr: null, watched: wrActive };
  states.set(ctx.request, state);

  if (dnrActive) {
    const docKey = initiator ? `${tabId} ${initiator.href}` : "";
    const outcome = evaluateRequest(s.registry, {
      url,
      method: details.method.toLowerCase(),
      type,
      initiator: type === "main_frame" ? null : initiator,
      tabId,
      allowAllPriority: type === "main_frame" ? undefined : allowAllDocs.get(docKey),
    });
    state.dnr = outcome;
    if (type === "main_frame" || type === "sub_frame") {
      const priorities = allowAllPriorities(outcome);
      const key = `${tabId} ${url.href}`;
      if (priorities.size) allowAllDocs.set(key, priorities);
      else allowAllDocs.delete(key);
      if (allowAllDocs.size > 500) allowAllDocs.delete(allowAllDocs.keys().next().value!);
    }
    if (outcome.matched.length) recordMatches(s, outcome, tabId, details);
    if (outcome.action === "block") {
      props.earlyResponse = blockedResponse(type, url.href);
      if (wrActive) dispatchWebRequest(s, "onErrorOccurred", { ...details, error: "net::ERR_BLOCKED_BY_CLIENT" });
      return;
    }
    if (outcome.action === "redirect" && outcome.redirectUrl) {
      props.earlyResponse = redirectResponse(outcome.redirectUrl);
      if (wrActive) dispatchWebRequest(s, "onBeforeRedirect", { ...details, redirectUrl: outcome.redirectUrl, statusCode: 307 });
      return;
    }
    if (outcome.requestHeaders.length) props.init.headers = applyHeaderOps(props.init.headers ?? [], outcome.requestHeaders);
  }

  if (wrActive) {
    const before = dispatchWebRequest(s, "onBeforeRequest", details);
    if (before.cancel) {
      props.earlyResponse = blockedResponse(type, url.href);
      dispatchWebRequest(s, "onErrorOccurred", { ...details, error: "net::ERR_BLOCKED_BY_CLIENT" });
      return;
    }
    if (before.redirectUrl) {
      props.earlyResponse = redirectResponse(before.redirectUrl);
      dispatchWebRequest(s, "onBeforeRedirect", { ...details, redirectUrl: before.redirectUrl, statusCode: 307 });
      return;
    }
    const sendHeaders = dispatchWebRequest(s, "onBeforeSendHeaders", { ...details, requestHeaders: headersToChrome(props.init.headers ?? []) });
    if (sendHeaders.cancel) {
      props.earlyResponse = blockedResponse(type, url.href);
      dispatchWebRequest(s, "onErrorOccurred", { ...details, error: "net::ERR_BLOCKED_BY_CLIENT" });
      return;
    }
    if (sendHeaders.requestHeaders) props.init.headers = chromeToHeaders(sendHeaders.requestHeaders);
    dispatchWebRequest(s, "onSendHeaders", { ...details, requestHeaders: headersToChrome(props.init.headers ?? []) });
  }
}

export function onFetchPreresponse(s: Sapphire, ctx: { request: object }, props: { response: { status: number; statusText?: string; rawHeaders: RawHeaders } }): void {
  const state = states.get(ctx.request);
  if (!state) return;
  const response = props.response;
  if (state.dnr?.responseHeaders.length) response.rawHeaders = applyHeaderOps(response.rawHeaders, state.dnr.responseHeaders);
  if (!state.watched) return;
  const received = dispatchWebRequest(s, "onHeadersReceived", {
    ...state.details,
    statusCode: response.status,
    statusLine: `HTTP/1.1 ${response.status} ${response.statusText ?? ""}`.trim(),
    responseHeaders: headersToChrome(response.rawHeaders),
  });
  if (received.cancel) {
    const blocked = blockedResponse(state.details.type as ResourceType, state.details.url);
    Object.assign(props, { response: Object.assign(blocked, { rawHeaders: [...blocked.headers] as RawHeaders }) });
    dispatchWebRequest(s, "onErrorOccurred", { ...state.details, error: "net::ERR_BLOCKED_BY_CLIENT" });
    state.watched = false;
    return;
  }
  if (received.redirectUrl) {
    const redirect = redirectResponse(received.redirectUrl);
    Object.assign(props, { response: Object.assign(redirect, { rawHeaders: [...redirect.headers] as RawHeaders }) });
    dispatchWebRequest(s, "onBeforeRedirect", { ...state.details, redirectUrl: received.redirectUrl, statusCode: 307 });
    state.watched = false;
    return;
  }
  if (received.responseHeaders) response.rawHeaders = chromeToHeaders(received.responseHeaders);
  if (response.status >= 300 && response.status < 400) {
    const location = response.rawHeaders.find(([k]) => k.toLowerCase() === "location")?.[1];
    if (location) {
      dispatchWebRequest(s, "onBeforeRedirect", { ...state.details, redirectUrl: new URL(location, state.details.url).href, statusCode: response.status });
      state.watched = false;
    }
  }
}

export function onFetchResponse(s: Sapphire, ctx: { request: object }, props: { response: { status: number; statusText?: string; headers: { toRawHeaders?: () => RawHeaders } } }): void {
  const state = states.get(ctx.request);
  if (!state?.watched) return;
  const raw = props.response.headers?.toRawHeaders?.() ?? [];
  const extra = { statusCode: props.response.status, statusLine: `HTTP/1.1 ${props.response.status} ${props.response.statusText ?? ""}`.trim(), responseHeaders: headersToChrome(raw), fromCache: false, ip: "" };
  dispatchWebRequest(s, "onResponseStarted", { ...state.details, ...extra });
  dispatchWebRequest(s, "onCompleted", { ...state.details, ...extra });
}
