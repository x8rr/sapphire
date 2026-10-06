import { ApiError, asyncApi } from "../realm";
import { deliverMessage, NO_RECEIVER, openPort } from "../messaging";
import { matchGlob, matchPattern } from "../matchPatterns";
import { allTabInfos, buildTab, buildWindow, currentWindowId, windowIds } from "../tabsModel";
import { normalizeExtensionUrl, extensionUrl } from "../urls";
import { completeMessage, normalizeSendMessageArgs, senderFor } from "./runtime";
import { captureVisibleTab } from "../capture";
import type { Env, Namespace } from "./env";

export function resolveCreateUrl(env: Env, url: string | undefined): string {
  if (!url) return "";
  // Relative URLs in tabs.create / windows.create resolve against the extension root.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) return extensionUrl(env.ext.id, url.replace(/^\.?\//, ""));
  return normalizeExtensionUrl(url);
}

export function createTabs(env: Env): Namespace {
  const { s, ctx, ext } = env;
  const callerTab = () => (ctx.tabId !== null ? ctx.tabId : null);
  const requireTab = (id: unknown) => {
    const tabId = id === undefined || id === null ? (callerTab() ?? s.host.getActiveTabId?.() ?? null) : Number(id);
    if (tabId === null || !buildTab(s, tabId)) throw new ApiError(`No tab with id: ${id}.`);
    return tabId;
  };

  const query = (q: Record<string, unknown> = {}) => {
    const current = currentWindowId(s, callerTab());
    const urlPatterns = q.url === undefined ? null : Array.isArray(q.url) ? (q.url as string[]) : [q.url as string];
    return allTabInfos(s)
      .map((t) => buildTab(s, t.id)!)
      .filter((t) => {
        if (!t) return false;
        if (q.active !== undefined && t.active !== q.active) return false;
        if (q.highlighted !== undefined && t.highlighted !== q.highlighted) return false;
        if (q.pinned !== undefined && t.pinned !== q.pinned) return false;
        if (q.audible !== undefined && t.audible !== q.audible) return false;
        if (q.muted !== undefined && t.mutedInfo.muted !== q.muted) return false;
        if (q.discarded !== undefined && t.discarded !== q.discarded) return false;
        if (q.autoDiscardable !== undefined && t.autoDiscardable !== q.autoDiscardable) return false;
        if (q.frozen !== undefined && t.frozen !== q.frozen) return false;
        if (q.status !== undefined && t.status !== q.status) return false;
        if (q.index !== undefined && t.index !== q.index) return false;
        if (q.groupId !== undefined && t.groupId !== q.groupId) return false;
        if ((q.currentWindow === true || q.lastFocusedWindow === true) && t.windowId !== current) return false;
        if ((q.currentWindow === false || q.lastFocusedWindow === false) && t.windowId === current) return false;
        if (q.windowId !== undefined) {
          const wanted = q.windowId === -2 ? current : q.windowId;
          if (t.windowId !== wanted) return false;
        }
        if (q.windowType !== undefined && q.windowType !== "normal") return false;
        if (typeof q.title === "string" && !matchGlob(q.title, t.title)) return false;
        if (urlPatterns && !urlPatterns.some((p) => matchPattern(p, t.url))) return false;
        return true;
      })
      .sort((a, b) => a.windowId - b.windowId || a.index - b.index);
  };

  const create = async (props: { url?: string; active?: boolean; selected?: boolean; openerTabId?: number; index?: number; windowId?: number; pinned?: boolean } = {}) => {
    const url = resolveCreateUrl(env, props.url);
    const active = props.active ?? props.selected ?? true;
    const id = await s.openTab(url, { active, openerTabId: props.openerTabId ?? callerTab() ?? undefined });
    if (id === null) throw new ApiError("Unable to create tab.");
    return buildTab(s, id) ?? { id, index: 0, windowId: 1, active, url, pendingUrl: url, title: "", status: "loading" };
  };

  const update = async (tabIdOrProps?: unknown, maybeProps?: unknown) => {
    const tabId = requireTab(typeof tabIdOrProps === "number" ? tabIdOrProps : undefined);
    const props = ((typeof tabIdOrProps === "number" ? maybeProps : tabIdOrProps) ?? {}) as {
      url?: string;
      active?: boolean;
      highlighted?: boolean;
      selected?: boolean;
      muted?: boolean;
    };
    if (props.url !== undefined) s.navigate(tabId, resolveCreateUrl(env, props.url));
    if (props.active || props.highlighted || props.selected) s.activateTab(tabId);
    return buildTab(s, tabId);
  };

  const sendMessage = (tabIdArg: unknown, ...rest: unknown[]) => {
    const tabId = Number(tabIdArg);
    const list = [...rest];
    let cb: ((...a: unknown[]) => unknown) | undefined;
    if (list.length && typeof list[list.length - 1] === "function") cb = list.pop() as typeof cb;
    const { message } = normalizeSendMessageArgs([null, list[0]]);
    const options = (list[1] ?? {}) as { frameId?: number; documentId?: string };
    const targets = s.registry.contextsOf(
      ext.id,
      (c) =>
        c.kind === "content" &&
        c.tabId === tabId &&
        (options.frameId === undefined || c.frameId === options.frameId) &&
        (options.documentId === undefined || c.documentId === options.documentId),
    );
    const p = targets.length ? deliverMessage(targets, "runtime.onMessage", message, senderFor(env)) : Promise.reject(new ApiError(NO_RECEIVER));
    return completeMessage(ctx, p, cb);
  };

  const connect = (tabIdArg: unknown, info: { name?: string; frameId?: number; documentId?: string } = {}) => {
    const tabId = Number(tabIdArg);
    const targets = s.registry.contextsOf(
      ext.id,
      (c) =>
        c.kind === "content" &&
        c.tabId === tabId &&
        (info.frameId === undefined || c.frameId === info.frameId) &&
        (info.documentId === undefined || c.documentId === info.documentId),
    );
    return openPort(s.registry, ctx, targets, "runtime.onConnect", String(info.name ?? ""), senderFor(env));
  };

  const mv2Inject = (kind: "js" | "css" | "removeCss") =>
    asyncApi(ctx, async (tabIdOrDetails?: unknown, maybeDetails?: unknown) => {
      const tabId = requireTab(typeof tabIdOrDetails === "number" ? tabIdOrDetails : undefined);
      const details = ((typeof tabIdOrDetails === "number" ? maybeDetails : tabIdOrDetails) ?? {}) as {
        code?: string;
        file?: string;
        allFrames?: boolean;
        frameId?: number;
        runAt?: string;
        matchAboutBlank?: boolean;
      };
      if (!details.code && !details.file) throw new ApiError("Either 'code' or 'file' must be specified.");
      const target = { tabId, allFrames: details.allFrames, frameIds: details.frameId !== undefined ? [details.frameId] : undefined };
      if (kind === "js") {
        const results = await s.executeScript(ext, target, {
          world: "ISOLATED",
          code: details.code,
          files: details.file ? [details.file] : undefined,
          injectImmediately: details.runAt === "document_start",
        });
        return results.map((r) => r.result);
      }
      const css = details.code ?? (details.file ? await ext.files.readText(details.file) : null);
      if (css === null) throw new ApiError(`Failed to load file: "${details.file}".`);
      if (kind === "css") await s.insertCss(ext, target, css, details.file ? `file:${details.file}` : `code:${css}`);
      else await s.removeCss(ext, target, details.file ? `file:${details.file}` : `code:${css}`);
      return undefined;
    });

  return {
    query: asyncApi(ctx, query),
    get: asyncApi(ctx, (tabId: number) => {
      const tab = buildTab(s, Number(tabId));
      if (!tab) throw new ApiError(`No tab with id: ${tabId}.`);
      return tab;
    }),
    getCurrent: asyncApi(ctx, () => (ctx.kind === "tab" || ctx.kind === "iframe" ? (buildTab(s, ctx.tabId) ?? undefined) : undefined)),
    getSelected: asyncApi(ctx, () => query({ active: true, currentWindow: true })[0]),
    getAllInWindow: asyncApi(ctx, (windowId?: number) => query({ windowId: windowId ?? -2 })),
    create: asyncApi(ctx, create),
    duplicate: asyncApi(ctx, async (tabId: number) => {
      const tab = buildTab(s, requireTab(tabId));
      return create({ url: tab!.url, active: true, openerTabId: tabId });
    }),
    update: asyncApi(ctx, update),
    remove: asyncApi(ctx, (ids: number | number[]) => {
      for (const id of Array.isArray(ids) ? ids : [ids]) {
        if (!buildTab(s, id)) throw new ApiError(`No tab with id: ${id}.`);
        s.closeTab(id);
      }
    }),
    reload: asyncApi(ctx, (tabIdOrProps?: unknown) => {
      s.reloadTab(requireTab(typeof tabIdOrProps === "number" ? tabIdOrProps : undefined));
    }),
    goBack: asyncApi(ctx, (tabId?: number) => s.historyGo(requireTab(tabId), -1)),
    goForward: asyncApi(ctx, (tabId?: number) => s.historyGo(requireTab(tabId), 1)),
    discard: asyncApi(ctx, (tabId?: number) => buildTab(s, requireTab(tabId))),
    highlight: asyncApi(ctx, (info: { tabs: number | number[]; windowId?: number }) => {
      const list = Array.isArray(info.tabs) ? info.tabs : [info.tabs];
      const all = query({ windowId: info.windowId ?? -2 });
      const first = all.find((t) => t.index === list[0]);
      if (first) s.activateTab(first.id);
      return buildWindow(s, info.windowId ?? currentWindowId(s, callerTab()), true);
    }),
    move: asyncApi(ctx, (ids: number | number[]) => {
      const tabs = (Array.isArray(ids) ? ids : [ids]).map((id) => buildTab(s, id)).filter(Boolean);
      return Array.isArray(ids) ? tabs : tabs[0];
    }),
    group: asyncApi(ctx, () => {
      throw new ApiError("Tab groups are not supported in this browser.");
    }),
    ungroup: asyncApi(ctx, () => undefined),
    detectLanguage: asyncApi(ctx, (tabId?: number) => {
      const win = s.host.getTabWindow?.(requireTab(tabId));
      let lang = "";
      try {
        lang = win?.document.documentElement.lang ?? "";
      } catch {
        lang = "";
      }
      return lang ? lang.split("-")[0] : "und";
    }),
    captureVisibleTab: asyncApi(ctx, (windowIdOrOpts?: unknown, maybeOpts?: unknown) => {
      const opts = (typeof windowIdOrOpts === "object" && windowIdOrOpts ? windowIdOrOpts : maybeOpts) as { format?: string; quality?: number } | undefined;
      const tabId = callerTab() ?? s.host.getActiveTabId?.() ?? null;
      return captureVisibleTab(s, tabId, opts?.format === "jpeg" ? "image/jpeg" : "image/png", opts?.quality);
    }),
    getZoom: asyncApi(ctx, () => 1),
    setZoom: asyncApi(ctx, () => undefined),
    getZoomSettings: asyncApi(ctx, () => ({ mode: "automatic", scope: "per-origin", defaultZoomFactor: 1 })),
    setZoomSettings: asyncApi(ctx, () => undefined),
    sendMessage,
    sendRequest: sendMessage,
    connect,
    executeScript: mv2Inject("js"),
    insertCSS: mv2Inject("css"),
    removeCSS: mv2Inject("removeCss"),
    onCreated: ctx.events.api("tabs.onCreated"),
    onUpdated: ctx.events.api("tabs.onUpdated"),
    onRemoved: ctx.events.api("tabs.onRemoved"),
    onActivated: ctx.events.api("tabs.onActivated"),
    onHighlighted: ctx.events.api("tabs.onHighlighted"),
    onMoved: ctx.events.api("tabs.onMoved"),
    onDetached: ctx.events.api("tabs.onDetached"),
    onAttached: ctx.events.api("tabs.onAttached"),
    onReplaced: ctx.events.api("tabs.onReplaced"),
    onZoomChange: ctx.events.api("tabs.onZoomChange"),
    onSelectionChanged: ctx.events.api("tabs.onSelectionChanged"),
    onActiveChanged: ctx.events.api("tabs.onActiveChanged"),
    onHighlightChanged: ctx.events.api("tabs.onHighlightChanged"),
    TAB_ID_NONE: -1,
    TAB_INDEX_NONE: -1,
    MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND: 2,
    TabStatus: { UNLOADED: "unloaded", LOADING: "loading", COMPLETE: "complete" },
    MutedInfoReason: { USER: "user", CAPTURE: "capture", EXTENSION: "extension" },
    WindowType: { NORMAL: "normal", POPUP: "popup", PANEL: "panel", APP: "app", DEVTOOLS: "devtools" },
    ZoomSettingsMode: { AUTOMATIC: "automatic", MANUAL: "manual", DISABLED: "disabled" },
    ZoomSettingsScope: { PER_ORIGIN: "per-origin", PER_TAB: "per-tab" },
  };
}

export function createWindows(env: Env): Namespace {
  const { s, ctx } = env;
  const callerWindow = () => currentWindowId(s, ctx.tabId);
  const getWindow = (id: number, populate: boolean) => {
    const wid = id === -2 ? callerWindow() : id;
    if (!windowIds(s).includes(wid)) throw new ApiError(`No window with id: ${id}.`);
    return buildWindow(s, wid, populate);
  };
  return {
    get: asyncApi(ctx, (id: number, opts?: { populate?: boolean }) => getWindow(id, !!opts?.populate)),
    getCurrent: asyncApi(ctx, (opts?: { populate?: boolean }) => getWindow(callerWindow(), !!opts?.populate)),
    getLastFocused: asyncApi(ctx, (opts?: { populate?: boolean }) => getWindow(currentWindowId(s, null), !!opts?.populate)),
    getAll: asyncApi(ctx, (opts?: { populate?: boolean }) => windowIds(s).map((id) => buildWindow(s, id, !!opts?.populate))),
    create: asyncApi(ctx, async (data: { url?: string | string[]; tabId?: number; focused?: boolean; type?: string } = {}) => {
      const urls = data.url === undefined ? [""] : Array.isArray(data.url) ? data.url : [data.url];
      let first: number | null = null;
      for (const url of urls) {
        const id = await s.openTab(resolveCreateUrl(env, url), { active: data.focused !== false, popup: data.type === "popup" });
        if (first === null) first = id;
      }
      const win = buildWindow(s, first !== null ? (s.host.getTab(first)?.windowId ?? 1) : callerWindow(), true);
      return win;
    }),
    update: asyncApi(ctx, (id: number) => getWindow(id, false)),
    remove: asyncApi(ctx, (id: number) => {
      getWindow(id, false);
    }),
    onCreated: ctx.events.api("windows.onCreated"),
    onRemoved: ctx.events.api("windows.onRemoved"),
    onFocusChanged: ctx.events.api("windows.onFocusChanged"),
    onBoundsChanged: ctx.events.api("windows.onBoundsChanged"),
    WINDOW_ID_NONE: -1,
    WINDOW_ID_CURRENT: -2,
    WindowType: { NORMAL: "normal", POPUP: "popup", PANEL: "panel", APP: "app", DEVTOOLS: "devtools" },
    WindowState: { NORMAL: "normal", MINIMIZED: "minimized", MAXIMIZED: "maximized", FULLSCREEN: "fullscreen", LOCKED_FULLSCREEN: "locked-fullscreen" },
    CreateType: { NORMAL: "normal", POPUP: "popup", PANEL: "panel" },
  };
}

