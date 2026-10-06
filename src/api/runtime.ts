import {
  ApiError,
  asyncApi,
  errorMessage,
  invokeCallback,
  invokeCallbackWithError,
  jsonToRealm,
  lastErrorGetter,
  realmOf,
  realmPromise,
  toRealm,
} from "../realm";
import { deliverMessage, NO_RECEIVER, NO_RESPONSE, openPort, PORT_CLOSED, PortSide, type MessageSender, originOf } from "../messaging";
import type { ExtensionContext } from "../registry";
import { compatFor } from "../compat";
import { displayExtensionUrl, extensionUrl } from "../urls";
import { buildTab } from "../tabsModel";
import type { Env, Namespace } from "./env";

export function platformInfo(): { os: string; arch: string; nacl_arch: string } {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = (nav.userAgentData?.platform || navigator.platform || navigator.userAgent).toLowerCase();
  let os = "linux";
  if (platform.includes("win")) os = "win";
  else if (platform.includes("mac") || platform.includes("iphone") || platform.includes("ipad")) os = "mac";
  else if (platform.includes("cros") || navigator.userAgent.includes("CrOS")) os = "cros";
  else if (platform.includes("android")) os = "android";
  const arm = /arm|aarch64/i.test(navigator.userAgent) || /arm/i.test(navigator.platform);
  return { os, arch: arm ? "arm64" : "x86-64", nacl_arch: arm ? "arm" : "x86-64" };
}

export function senderFor(env: Env, ctx: ExtensionContext = env.ctx): MessageSender {
  const sender: MessageSender = {
    id: ctx.ext.id,
    url: compatFor(ctx.ext.id).senderUrlAsChromeExtension ? displayExtensionUrl(ctx.url) : ctx.url,
    origin: originOf(ctx.url),
  };
  if (ctx.tabId !== null && (ctx.kind === "content" || ctx.kind === "tab" || ctx.kind === "iframe")) {
    sender.tab = buildTab(env.s, ctx.tabId) ?? undefined;
    sender.frameId = ctx.frameId;
  }
  if (ctx.kind !== "background") {
    sender.documentId = ctx.documentId;
    sender.documentLifecycle = "active";
  }
  return sender;
}

/** runtime.sendMessage's overloaded argument list, as Chromium normalises it. */
export function normalizeSendMessageArgs(args: unknown[]): { target: string | null; message: unknown; cb?: (...a: unknown[]) => unknown } {
  const list = [...args];
  let cb: ((...a: unknown[]) => unknown) | undefined;
  if (list.length && typeof list[list.length - 1] === "function") cb = list.pop() as typeof cb;
  if (list.length >= 3) return { target: (list[0] as string | null) ?? null, message: list[1], cb };
  if (list.length === 2) {
    if (list[0] === null || list[0] === undefined || typeof list[0] === "string") return { target: (list[0] as string | null) ?? null, message: list[1], cb };
    return { target: null, message: list[0], cb };
  }
  return { target: null, message: list[0], cb };
}

/** Shared by runtime.sendMessage and tabs.sendMessage: callback / promise plumbing. */
export function completeMessage(ctx: ExtensionContext, p: Promise<unknown>, cb?: (...a: unknown[]) => unknown): unknown {
  if (cb) {
    p.then(
      (value) => {
        if (value === NO_RESPONSE) invokeCallbackWithError(ctx, cb, PORT_CLOSED);
        else invokeCallback(ctx, cb, [jsonToRealm(ctx, value)]);
      },
      (e) => invokeCallbackWithError(ctx, cb, errorMessage(e)),
    );
    return undefined;
  }
  return realmPromise(
    ctx,
    p.then((value) => (value === NO_RESPONSE ? undefined : jsonToRealm(ctx, value))),
    true,
  );
}

function messageTargets(env: Env, targetId: string): { contexts: ExtensionContext[]; event: string } {
  const { s, ctx } = env;
  if (targetId === ctx.ext.id) {
    return { contexts: s.registry.extensionContexts(targetId).filter((c) => c !== ctx), event: "runtime.onMessage" };
  }
  const target = s.registry.get(targetId);
  if (!target || !target.enabled) return { contexts: [], event: "runtime.onMessageExternal" };
  return { contexts: s.registry.extensionContexts(targetId), event: "runtime.onMessageExternal" };
}

export function createRuntime(env: Env, content: boolean): Namespace {
  const { s, ctx, ext } = env;
  const mv = Number(ext.manifest.manifest_version) || 2;

  const sendMessage = (...args: unknown[]) => {
    const { target, message, cb } = normalizeSendMessageArgs(args);
    const targetId = target ?? ext.id;
    const { contexts, event } = messageTargets(env, targetId);
    const p = contexts.length ? deliverMessage(contexts, event, message, senderFor(env)) : Promise.reject(new ApiError(NO_RECEIVER));
    return completeMessage(ctx, p, cb);
  };

  const connect = (idOrInfo?: unknown, maybeInfo?: unknown) => {
    const targetId = typeof idOrInfo === "string" ? idOrInfo : ext.id;
    const info = (typeof idOrInfo === "string" ? maybeInfo : idOrInfo) as { name?: string } | undefined;
    const { contexts } = messageTargets(env, targetId);
    const event = targetId === ext.id ? "runtime.onConnect" : "runtime.onConnectExternal";
    return openPort(s.registry, ctx, contexts, event, String(info?.name ?? ""), senderFor(env));
  };

  const runtime: Namespace = {
    id: ext.id,
    getManifest: () => toRealm(ctx, ext.manifest),
    getURL: (path?: unknown) => extensionUrl(ext.id, path == null ? "" : String(path)),
    sendMessage,
    connect,
    onMessage: ctx.events.api("runtime.onMessage"),
    onConnect: ctx.events.api("runtime.onConnect"),
    // Messages/ports from a chrome.userScripts-world script land here, not onMessage/onConnect
    // (real Chrome keeps the two separate since USER_SCRIPT is a more restricted sandbox).
    onUserScriptMessage: ctx.events.api("runtime.onUserScriptMessage"),
    onUserScriptConnect: ctx.events.api("runtime.onUserScriptConnect"),
    OnInstalledReason: { INSTALL: "install", UPDATE: "update", CHROME_UPDATE: "chrome_update", SHARED_MODULE_UPDATE: "shared_module_update" },
    OnRestartRequiredReason: { APP_UPDATE: "app_update", OS_UPDATE: "os_update", PERIODIC: "periodic" },
    PlatformArch: { ARM: "arm", ARM64: "arm64", X86_32: "x86-32", X86_64: "x86-64", MIPS: "mips", MIPS64: "mips64", RISCV64: "riscv64" },
    PlatformNaclArch: { ARM: "arm", X86_32: "x86-32", X86_64: "x86-64", MIPS: "mips", MIPS64: "mips64" },
    PlatformOs: { MAC: "mac", WIN: "win", ANDROID: "android", CROS: "cros", LINUX: "linux", OPENBSD: "openbsd", FUCHSIA: "fuchsia" },
    RequestUpdateCheckStatus: { THROTTLED: "throttled", NO_UPDATE: "no_update", UPDATE_AVAILABLE: "update_available" },
    ContextType: { TAB: "TAB", POPUP: "POPUP", BACKGROUND: "BACKGROUND", OFFSCREEN_DOCUMENT: "OFFSCREEN_DOCUMENT", SIDE_PANEL: "SIDE_PANEL", DEVELOPER_TOOLS: "DEVELOPER_TOOLS" },
  };
  Object.defineProperty(runtime, "lastError", lastErrorGetter(ctx));
  if (content) {
    return runtime;
  }

  Object.assign(runtime, {
    onMessageExternal: ctx.events.api("runtime.onMessageExternal"),
    onConnectExternal: ctx.events.api("runtime.onConnectExternal"),
    onInstalled: ctx.events.api("runtime.onInstalled"),
    onStartup: ctx.events.api("runtime.onStartup"),
    onSuspend: ctx.events.api("runtime.onSuspend"),
    onSuspendCanceled: ctx.events.api("runtime.onSuspendCanceled"),
    onUpdateAvailable: ctx.events.api("runtime.onUpdateAvailable"),
    onRestartRequired: ctx.events.api("runtime.onRestartRequired"),
    onUserScriptMessage: ctx.events.api("runtime.onUserScriptMessage"),
    onUserScriptConnect: ctx.events.api("runtime.onUserScriptConnect"),
    onBrowserUpdateAvailable: ctx.events.api("runtime.onBrowserUpdateAvailable"),
    getPlatformInfo: asyncApi(ctx, () => platformInfo()),
    getBackgroundPage: asyncApi(
      ctx,
      async () => {
        if (mv >= 3 || ext.manifest.background?.service_worker) throw new ApiError("You do not have a background page.");
        await ext.backgroundReady;
        const bg = s.registry.contextsOf(ext.id, (c) => c.kind === "background")[0];
        if (!bg) throw new ApiError("You do not have a background page.");
        return bg.window;
      },
      { raw: true },
    ),
    openOptionsPage: asyncApi(ctx, () => {
      const page = ext.manifest.options_ui?.page ?? ext.manifest.options_page;
      if (!page) throw new ApiError("Could not create an options page.");
      s.openExtensionPage(ext.id, page, null);
    }),
    setUninstallURL: asyncApi(ctx, (url?: string) => {
      if (url && !/^https?:\/\//i.test(url)) throw new ApiError("Invalid URL: " + url);
      ext.settings.set("uninstallUrl", url ?? "");
    }),
    reload: () => {
      setTimeout(() => void s.reloadExtension(ext.id), 0);
    },
    restart: () => {
      ctx.lastError = { message: "Function available only for ChromeOS kiosk mode." };
    },
    restartAfterDelay: asyncApi(ctx, () => {
      throw new ApiError("Function available only for ChromeOS kiosk mode.");
    }),
    requestUpdateCheck: asyncApi(ctx, () => ({ status: "no_update", version: "" }), {
      callbackArgs: (v) => (mv >= 3 ? [v] : [(v as { status: string }).status, {}]),
    }),
    getPackageDirectoryEntry: asyncApi(ctx, () => {
      throw new ApiError("getPackageDirectoryEntry is not supported.");
    }),
    connectNative: (application: string) => {
      const side = new PortSide(ctx, String(application ?? ""), undefined);
      side.connected = false;
      ctx.ports.delete(side);
      side.fireDisconnect("Specified native messaging host not found.");
      return side.api;
    },
    sendNativeMessage: asyncApi(ctx, () => {
      throw new ApiError("Specified native messaging host not found.");
    }),
    getContexts: asyncApi(ctx, (filter: Record<string, unknown[] | undefined> = {}) => {
      return s.registry
        .extensionContexts(ext.id)
        .filter((c) => c.kind !== "iframe")
        .map((c) => ({
          contextType:
            c.kind === "background" ? "BACKGROUND" : c.kind === "popup" ? "POPUP" : c.kind === "offscreen" ? "OFFSCREEN_DOCUMENT" : c.kind === "sidepanel" ? "SIDE_PANEL" : c.kind === "devtools" ? "DEVELOPER_TOOLS" : "TAB",
          contextId: `${c.id}`,
          tabId: c.tabId ?? -1,
          windowId: c.tabId !== null ? (s.host.getTab(c.tabId)?.windowId ?? 1) : -1,
          documentId: c.kind === "background" && ext.manifest.background?.service_worker ? undefined : c.documentId,
          frameId: c.kind === "background" ? -1 : c.frameId,
          documentUrl: c.kind === "background" && ext.manifest.background?.service_worker ? undefined : c.url,
          documentOrigin: c.kind === "background" && ext.manifest.background?.service_worker ? undefined : originOf(c.url),
          incognito: false,
        }))
        .filter((info) => {
          for (const [key, values] of Object.entries(filter)) {
            if (!Array.isArray(values)) continue;
            const map: Record<string, string> = {
              contextTypes: "contextType",
              contextIds: "contextId",
              tabIds: "tabId",
              windowIds: "windowId",
              documentIds: "documentId",
              frameIds: "frameId",
              documentUrls: "documentUrl",
              documentOrigins: "documentOrigin",
            };
            const field = map[key];
            if (field && !values.includes((info as Record<string, unknown>)[field])) return false;
            if (key === "incognito" && values.length) return false;
          }
          return true;
        });
    }),
  });
  return runtime;
}

export function createExtensionNamespace(env: Env, runtime: Namespace, content: boolean): Namespace {
  const { s, ctx, ext } = env;
  const mv = Number(ext.manifest.manifest_version) || 2;
  const ns: Namespace = {
    inIncognitoContext: false,
    ViewType: { TAB: "tab", POPUP: "popup" },
  };
  if (mv < 3) {
    Object.defineProperty(ns, "lastError", lastErrorGetter(ctx));
    ns.getURL = runtime.getURL;
    ns.sendRequest = (...args: unknown[]) => (runtime.sendMessage as (...a: unknown[]) => unknown)(...args);
    ns.onRequest = runtime.onMessage;
    if (!content) ns.onRequestExternal = runtime.onMessageExternal;
  }
  if (content) return ns;
  const views = (filter: { type?: string; tabId?: number; windowId?: number } = {}) => {
    const realm = realmOf(ctx);
    const out = new realm.Array() as Window[];
    for (const c of s.registry.extensionContexts(ext.id)) {
      if (c.kind === "iframe" || c.kind === "offscreen") continue;
      const type = c.kind === "popup" ? "popup" : c.kind === "tab" ? "tab" : c.kind === "background" ? "background" : "other";
      if (filter.type && filter.type !== type) continue;
      if (filter.tabId !== undefined && filter.tabId !== c.tabId) continue;
      if (type === "background" && filter.type === undefined && mv >= 3) continue;
      out.push(c.window);
    }
    return out;
  };
  Object.assign(ns, {
    getViews: (filter?: { type?: string; tabId?: number }) => views(filter),
    getExtensionTabs: (windowId?: number) => views({ type: "tab", windowId }),
    getBackgroundPage: () => {
      if (mv >= 3 || ext.manifest.background?.service_worker) return null;
      return s.registry.contextsOf(ext.id, (c) => c.kind === "background")[0]?.window ?? null;
    },
    isAllowedIncognitoAccess: asyncApi(ctx, () => false),
    isAllowedFileSchemeAccess: asyncApi(ctx, () => false),
    setUpdateUrlData: () => {},
  });
  return ns;
}


/** USER_SCRIPT world: only messaging, and only once configureWorld({messaging: true}). */
export function createUserScriptRuntime(env: Env): Namespace {
  const { s, ctx, ext } = env;
  const enabled = () => [...ext.userScriptWorlds.values()].some((w) => w.messaging);
  const runtime: Namespace = {
    id: ext.id,
    onMessage: ctx.events.api("runtime.onMessage"),
    onConnect: ctx.events.api("runtime.onConnect"),
    sendMessage: (...args: unknown[]) => {
      const { message, cb } = normalizeSendMessageArgs(args);
      if (!enabled()) return completeMessage(ctx, Promise.reject(new ApiError(NO_RECEIVER)), cb);
      const targets = s.registry.extensionContexts(ext.id);
      return completeMessage(ctx, deliverMessage(targets, "runtime.onUserScriptMessage", message, senderFor(env)), cb);
    },
    connect: (info?: { name?: string }) => {
      const targets = enabled() ? s.registry.extensionContexts(ext.id) : [];
      return openPort(s.registry, ctx, targets, "runtime.onUserScriptConnect", String(info?.name ?? ""), senderFor(env));
    },
  };
  Object.defineProperty(runtime, "lastError", lastErrorGetter(ctx));
  return runtime;
}
