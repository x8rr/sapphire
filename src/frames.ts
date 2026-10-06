import { buildChromeApi } from "./api";
import { dispatchNavigation } from "./api/webNavigation";
import { contentWorldOf, installContentWorld, startContentScripts, type ContentWorld } from "./content";
import { randomId, realmError } from "./realm";
import type { ContextKind, ExtensionContext, FrameRecord } from "./registry";
import type { Sapphire } from "./sapphire";
import { extensionUrl, parseExtensionUrl, resolvePackagePath } from "./urls";

export type FrameKind = "tab" | "popup" | "background" | "offscreen" | "sidepanel" | "auth";

export interface FramePluginInfo {
  kind: FrameKind;
  tabId: number | null;
}

interface InitContext {
  window: Window;
  client: { url: URL | string };
  isTopLevel: boolean;
}

const closedRoots = new WeakMap<Element, ShadowRoot>();
const hookedRealms = new WeakSet<object>();
/** The frame's own Navigation API object, grabbed before Scramjet deletes `navigation`. */
const frameNavigation = new WeakMap<object, { canGoBack: boolean; entries(): unknown[]; currentEntry: { index: number } | null }>();

/**
 * An iframe's history traversal is joint with its embedder's, so `history.back()`
 * in a tab with no earlier entry of its own would navigate the *host*. Bound
 * traversal by the frame's own entries.
 */
function shieldHistory(win: Window): void {
  const nav = frameNavigation.get(win);
  if (!nav) return;
  const within = (delta: number) => {
    try {
      const index = nav.currentEntry?.index ?? 0;
      const target = index + delta;
      return target >= 0 && target < nav.entries().length;
    } catch {
      return false;
    }
  };
  const history = win.history;
  const go = history.go.bind(history);
  const wrap = (name: "back" | "forward" | "go", fn: (delta?: number) => void) => {
    try {
      Object.defineProperty(history, name, { value: fn, writable: true, configurable: true });
    } catch {
      // ignore
    }
  };
  wrap("back", () => {
    if (within(-1)) go(-1);
  });
  wrap("forward", () => {
    if (within(1)) go(1);
  });
  wrap("go", (delta = 0) => {
    if (delta === 0) win.location.reload();
    else if (within(delta)) go(delta);
  });
}
/** Page contexts' stand-in navigator.serviceWorker, so SW→client messages can be delivered to it. */
const pageContainers = new WeakMap<object, { target: EventTarget; container: Record<string, unknown> }>();

export function closedShadowRoot(el: Element): ShadowRoot | null {
  return closedRoots.get(el) ?? null;
}

function hookAttachShadow(win: Window): void {
  const realm = win as Window & typeof globalThis;
  const proto = realm.Element?.prototype;
  if (!proto || hookedRealms.has(proto)) return;
  hookedRealms.add(proto);
  const original = proto.attachShadow;
  if (typeof original !== "function") return;
  const patched = {
    attachShadow(this: Element, init: ShadowRootInit) {
      const root = original.call(this, init);
      if (init?.mode === "closed") closedRoots.set(this, root);
      return root;
    },
  }.attachShadow;
  Object.defineProperty(proto, "attachShadow", { value: patched, writable: true, configurable: true, enumerable: true });
}

function contextKindFor(kind: FrameKind, isTop: boolean): ContextKind {
  if (!isTop) return "iframe";
  if (kind === "background") return "background";
  if (kind === "popup") return "popup";
  if (kind === "offscreen") return "offscreen";
  if (kind === "sidepanel") return "sidepanel";
  return "tab";
}

function frameIds(s: Sapphire, tabId: number | null, win: Window, isTop: boolean): { frameId: number; parentFrameId: number } {
  if (tabId === null) return { frameId: isTop ? 0 : -1, parentFrameId: -1 };
  const frameId = s.registry.frameIdFor(tabId, win, isTop);
  if (isTop) return { frameId, parentFrameId: -1 };
  let parentFrameId = 0;
  try {
    const parent = win.parent;
    const tab = s.registry.tab(tabId);
    const known = tab.frameIds.get(parent);
    if (known !== undefined) parentFrameId = known;
    else if (parent.frameElement && !(parent.frameElement as HTMLElement).ownerDocument.defaultView?.frameElement) parentFrameId = 0;
  } catch {
    parentFrameId = 0;
  }
  return { frameId, parentFrameId };
}

function sameWindow(a: Window, b: Window): boolean {
  try {
    return a === b;
  } catch {
    return false;
  }
}

/**
 * Scramjet rewrites URL arguments (importScripts included) into its
 * /<prefix>/<encoded real URL> form; recover the real URL.
 */
export function unproxyUrl(ref: string): string {
  const m = ref.match(/\/(https?%3A%2F%2F[^?#/]*)/i);
  if (!m) return ref;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return ref;
  }
}

/** Service worker globals for an MV3 background running in a (hidden) page. */
function installServiceWorkerShim(s: Sapphire, ctx: ExtensionContext): void {
  const win = ctx.window as Window & typeof globalThis & Record<string, unknown>;
  const ext = ctx.ext;
  const swPath = ext.manifest.background?.service_worker ?? "background.js";
  const scriptUrl = extensionUrl(ext.id, swPath);
  const importScripts = (...urls: unknown[]) => {
    for (const raw of urls) {
      const ref = unproxyUrl(String(raw));
      const parsed = parseExtensionUrl(ref, scriptUrl);
      const path = parsed && parsed.extId === ext.id ? parsed.path : /^[a-z]+:/i.test(ref) ? null : resolvePackagePath(ref, swPath);
      const code = path !== null ? ext.files.readTextSync(path) : null;
      if (code === null) {
        throw realmError(ctx, `Failed to execute 'importScripts' on 'WorkerGlobalScope': The script at '${ref}' failed to load.`);
      }
      const doc = win.document;
      const script = doc.createElement("script");
      script.textContent = `${code}\n//# sourceURL=${extensionUrl(ext.id, path!)}`;
      (doc.head ?? doc.documentElement).appendChild(script);
      script.remove();
    }
  };
  const makeClient = (c: ExtensionContext) => ({
    id: String(c.id),
    url: c.url,
    type: "window",
    frameType: c.kind === "iframe" ? "nested" : "top-level",
    focused: c.kind === "tab" && c.tabId === s.host.getActiveTabId?.(),
    visibilityState: "visible",
    postMessage: (message: unknown, transfer?: Transferable[] | { transfer?: Transferable[] }) => {
      try {
        const ports = (Array.isArray(transfer) ? transfer : (transfer?.transfer ?? [])).filter((t): t is MessagePort => !!t && typeof (t as MessagePort).postMessage === "function" && "onmessage" in (t as object));
        const realm = c.window as Window & typeof globalThis;
        const event = new realm.MessageEvent("message", { data: message, ports, origin: extensionUrl(ext.id, "").slice(0, -1) });
        const page = pageContainers.get(c);
        if (page) {
          // In a page, messages from "its" service worker arrive on navigator.serviceWorker.
          page.target.dispatchEvent(event);
          const handler = page.container.onmessage;
          if (typeof handler === "function") (handler as (e: Event) => void).call(page.container, event);
        } else {
          c.window.dispatchEvent(event);
        }
      } catch {
        // ignore
      }
    },
    focus: () => Promise.resolve(makeClient(c)),
    navigate: (url: string) => {
      c.window.location.href = url;
      return Promise.resolve(makeClient(c));
    },
  });
  const clients = {
    matchAll: (opts: { type?: string } = {}) =>
      Promise.resolve(opts.type && opts.type !== "window" && opts.type !== "all" ? [] : s.registry.extensionContexts(ext.id).filter((c) => c !== ctx).map(makeClient)),
    get: (id: string) => Promise.resolve(s.registry.extensionContexts(ext.id).filter((c) => String(c.id) === id).map(makeClient)[0]),
    openWindow: async (url: string) => {
      const id = await s.openTab(parseExtensionUrl(url) ? url : new URL(url, scriptUrl).href, { active: true });
      return id === null ? null : { id: String(id), url, type: "window" };
    },
    claim: () => Promise.resolve(),
  };
  const worker = { scriptURL: scriptUrl, state: "activated", postMessage: () => {}, onstatechange: null, addEventListener: () => {}, removeEventListener: () => {} };
  const registration = {
    scope: extensionUrl(ext.id, ""),
    active: worker,
    installing: null,
    waiting: null,
    updateViaCache: "imports",
    navigationPreload: { enable: () => Promise.resolve(), disable: () => Promise.resolve(), setHeaderValue: () => Promise.resolve(), getState: () => Promise.resolve({ enabled: false, headerValue: "" }) },
    showNotification: async (title: string, options: { body?: string; icon?: string; tag?: string } = {}) => {
      s.host.showNotification?.(String(title), String(options.body ?? ""));
    },
    getNotifications: () => Promise.resolve([]),
    update: () => Promise.resolve(),
    unregister: () => Promise.resolve(false),
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  const define = (name: string, value: unknown) => {
    try {
      Object.defineProperty(win, name, { value, writable: true, configurable: true, enumerable: false });
    } catch {
      // ignore
    }
  };
  define("importScripts", importScripts);
  define("clients", clients);
  define("registration", registration);
  define("serviceWorker", worker);
  define("skipWaiting", () => Promise.resolve());
  const scopeCtor = function ServiceWorkerGlobalScope() {
    throw new TypeError("Illegal constructor");
  };
  Object.defineProperty(scopeCtor, Symbol.hasInstance, { value: (obj: unknown) => obj === win });
  const workerCtor = function WorkerGlobalScope() {
    throw new TypeError("Illegal constructor");
  };
  Object.defineProperty(workerCtor, Symbol.hasInstance, { value: (obj: unknown) => obj === win });
  define("ServiceWorkerGlobalScope", scopeCtor);
  define("WorkerGlobalScope", workerCtor);
  if (!("ExtendableEvent" in win)) {
    define(
      "ExtendableEvent",
      class extends (win.Event as typeof Event) {
        waitUntil(_p: unknown): void {}
        addRoutes(): Promise<void> {
          return Promise.resolve();
        }
      },
    );
  }
}

/**
 * Scramjet deletes Navigator.prototype.serviceWorker (the proxy owns the real
 * worker), but extension pages legitimately talk to "their" service worker:
 * `navigator.serviceWorker.controller`, `.ready`, `onmessage`, `postMessage`.
 * Give them an inert, spec-shaped stand-in.
 */
function installPageServiceWorkerShim(s: Sapphire, ctx: ExtensionContext): void {
  const win = ctx.window as Window & typeof globalThis;
  const ext = ctx.ext;
  if (!ext.manifest.background?.service_worker) return;
  const scriptURL = extensionUrl(ext.id, ext.manifest.background.service_worker);
  const target = new win.EventTarget();
  const worker = Object.assign(new win.EventTarget(), {
    scriptURL,
    state: "activated",
    onstatechange: null,
    // page → its service worker: arrives as a `message` event (with any transferred ports) in the background realm.
    postMessage: (message: unknown, transfer?: Transferable[] | { transfer?: Transferable[] }) => {
      const bg = s.registry.contextsOf(ext.id, (c) => c.kind === "background")[0];
      if (!bg) return;
      const ports = (Array.isArray(transfer) ? transfer : (transfer?.transfer ?? [])).filter(
        (t): t is MessagePort => !!t && typeof (t as MessagePort).postMessage === "function" && "onmessage" in (t as object),
      );
      const bgWin = bg.window as Window & typeof globalThis;
      const event = new bgWin.MessageEvent("message", { data: message, ports, origin: extensionUrl(ext.id, "").slice(0, -1) });
      setTimeout(() => bgWin.dispatchEvent(event), 0);
    },
  });
  const registration = Object.assign(new win.EventTarget(), {
    scope: extensionUrl(ext.id, ""),
    active: worker,
    installing: null,
    waiting: null,
    updateViaCache: "imports",
    update: () => Promise.resolve(registration),
    unregister: () => Promise.resolve(false),
    pushManager: { getSubscription: () => Promise.resolve(null) },
  });
  const container: Record<string, unknown> = {
    // Extension pages are always controlled by their own extension's (single) service worker.
    // Extension pages are always controlled by their own extension's (single) service worker.
    controller: worker,
    ready: Promise.resolve(registration),
    onmessage: null,
    oncontrollerchange: null,
    onmessageerror: null,
    register: () => Promise.resolve(registration),
    getRegistration: () => Promise.resolve(registration),
    getRegistrations: () => Promise.resolve([registration]),
    startMessages: () => {},
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
  };
  pageContainers.set(ctx, { target, container });
  try {
    Object.defineProperty(win.navigator, "serviceWorker", { value: container, configurable: true, enumerable: true });
  } catch {
    // ignore
  }
  void s;
}

/** Fire SW lifecycle events once the background document has run its scripts. */
export function dispatchServiceWorkerLifecycle(ctx: ExtensionContext): void {
  const win = ctx.window as Window & typeof globalThis & Record<string, unknown>;
  for (const type of ["install", "activate"]) {
    try {
      const ev = new win.Event(type) as Event & { waitUntil?: (p: unknown) => void };
      ev.waitUntil = () => {};
      (ev as Event & { addRoutes?: () => Promise<void> }).addRoutes = () => Promise.resolve();
      win.dispatchEvent(ev);
      const handler = win[`on${type}`];
      if (typeof handler === "function") (handler as (e: Event) => void).call(win, ev);
    } catch (e) {
      console.warn("[sapphire] service worker lifecycle dispatch failed", e);
    }
  }
}

function recordFrame(s: Sapphire, tabId: number, win: Window, frameId: number, parentFrameId: number, documentId: string, url: string): FrameRecord {
  const tab = s.registry.tab(tabId);
  const record: FrameRecord = { frameId, parentFrameId, window: win, url, documentId, documentLifecycle: "active", errorOccurred: false };
  tab.frames.set(frameId, record);
  return record;
}

function frameType(frameId: number): string {
  return frameId === 0 ? "outermost_frame" : "sub_frame";
}

/** Only real tabs own frames; a popup's tabId is just "the tab it was opened over". */
function frameTabId(info: FramePluginInfo): number | null {
  return info.kind === "tab" ? info.tabId : null;
}

export function onInitPre(s: Sapphire, info: FramePluginInfo, init: InitContext): void {
  const win = init.window;
  const isTop = init.isTopLevel;
  const url = String(init.client.url);
  const tabId = frameTabId(info);
  const { frameId, parentFrameId } = frameIds(s, tabId, win, isTop);
  const documentId = randomId(32);
  const parsed = parseExtensionUrl(url);
  try {
    const nav = (win as unknown as { navigation?: never }).navigation;
    if (nav) frameNavigation.set(win, nav);
  } catch {
    // ignore
  }
  if (s.registry.contentScripts.length) hookAttachShadow(win);

  if (tabId !== null) {
    const parentRecord = parentFrameId >= 0 ? s.registry.tab(tabId).frames.get(parentFrameId) : undefined;
    recordFrame(s, tabId, win, frameId, parentFrameId, documentId, url);
    const base = { tabId, frameId, parentFrameId, url, timeStamp: Date.now(), documentLifecycle: "active", frameType: frameType(frameId), ...(parentRecord ? { parentDocumentId: parentRecord.documentId } : {}) };
    if (isTop) {
      const tab = s.registry.tab(tabId);
      const changed = tab.url !== url;
      tab.url = url;
      tab.status = "loading";
      tab.title = "";
      tab.favIconUrl = "";
      s.tabUpdated(tabId, changed ? { status: "loading", url } : { status: "loading" });
    }
    dispatchNavigation(s, "onBeforeNavigate", { ...base, processId: -1 });
    dispatchNavigation(s, "onCommitted", { ...base, documentId, processId: 1, transitionType: isTop ? "link" : "auto_subframe", transitionQualifiers: [] });
  }

  if (parsed) {
    const ext = s.registry.get(parsed.extId);
    if (!ext || !ext.enabled) return;
    const kind = contextKindFor(info.kind, isTop);
    const ctx = s.registry.createContext({
      ext,
      kind,
      window: win,
      document: win.document,
      tabId,
      frameId,
      documentId,
      url,
      world: "ISOLATED",
    });
    ctx.chrome = buildChromeApi(s, ctx);
    // Non-configurable but writable in Chrome: assignment is the only way in.
    try {
      (win as unknown as { chrome: unknown }).chrome = ctx.chrome;
    } catch (e) {
      console.error("[sapphire] could not install chrome on extension page", e);
    }
    if (kind === "background" && ext.manifest.background?.service_worker) installServiceWorkerShim(s, ctx);
    else installPageServiceWorkerShim(s, ctx);
    win.addEventListener("pagehide", () => s.registry.destroyContext(ctx));
    if (kind === "background") s.onBackgroundContext(ext, ctx);
    return;
  }

  installContentWorld(s, win, { tabId, frameId, parentFrameId, documentId, url, isTop });
}

export function onInitPost(s: Sapphire, info: FramePluginInfo, init: InitContext): void {
  const win = init.window;
  const isTop = init.isTopLevel;
  const tabId = frameTabId(info);
  const world = contentWorldOf(win);
  const url = String(init.client.url);
  const parsed = parseExtensionUrl(url);

  if (world && world.doc === win.document) startContentScripts(s, world);

  if (parsed && isTop && (info.kind === "popup" || info.kind === "tab" || info.kind === "sidepanel")) {
    // window.close() from an extension page closes *its* tab/popup, never the host window.
    const extId = parsed.extId;
    const close = () => {
      if (info.kind === "popup") s.closePopup(extId);
      else if (tabId !== null) s.closeTab(tabId);
    };
    try {
      Object.defineProperty(win, "close", { value: close, writable: true, configurable: true });
    } catch {
      // ignore
    }
  }

  if (tabId !== null || parsed) shieldHistory(win);
  installKeyboardShortcuts(s, win, tabId);
  if (tabId !== null) {
    installContextMenuCapture(s, win, tabId, world);
    watchLifecycle(s, win, tabId, isTop, url, init.client);
  }
}

function watchLifecycle(s: Sapphire, win: Window, tabId: number, isTop: boolean, url: string, client: InitContext["client"]): void {
  const doc = win.document;
  const tab = s.registry.tab(tabId);
  const frameRecord = () => [...tab.frames.values()].find((f) => sameWindow(f.window, win));
  const base = () => {
    const f = frameRecord();
    return { tabId, frameId: f?.frameId ?? 0, parentFrameId: f?.parentFrameId ?? -1, url: f?.url ?? url, timeStamp: Date.now(), documentId: f?.documentId, documentLifecycle: "active", frameType: frameType(f?.frameId ?? 0), processId: 1 };
  };
  const stillCurrent = () => {
    try {
      return win.document === doc;
    } catch {
      return false;
    }
  };
  doc.addEventListener("DOMContentLoaded", () => {
    if (stillCurrent()) dispatchNavigation(s, "onDOMContentLoaded", base());
  });
  win.addEventListener("load", () => {
    if (!stillCurrent()) return;
    dispatchNavigation(s, "onCompleted", base());
    if (!isTop) return;
    tab.status = "complete";
    const changes: Record<string, unknown> = { status: "complete" };
    const title = doc.title;
    if (title && title !== tab.title) {
      tab.title = title;
      changes.title = title;
    }
    s.tabUpdated(tabId, changes);
    const icon = doc.querySelector<HTMLLinkElement>('link[rel~="icon"]')?.href;
    let favIconUrl = "";
    try {
      favIconUrl = icon ?? new URL("/favicon.ico", tab.url).href;
    } catch {
      favIconUrl = "";
    }
    if (favIconUrl && favIconUrl !== tab.favIconUrl && !parseExtensionUrl(tab.url)) {
      tab.favIconUrl = favIconUrl;
      s.tabUpdated(tabId, { favIconUrl });
    }
    s.recordHistory(tabId, tab.url, tab.title);
  });
  if (isTop) {
    const observeTitle = () => {
      const title = doc.title;
      if (title && title !== tab.title && stillCurrent()) {
        tab.title = title;
        s.tabUpdated(tabId, { title });
        s.browserData.updateTitle(tab.url, title);
      }
    };
    try {
      const Observer = (win as Window & typeof globalThis).MutationObserver;
      const mo = new Observer(observeTitle);
      mo.observe(doc, { subtree: true, childList: true, characterData: true });
      win.addEventListener("load", () => setTimeout(() => mo.disconnect(), 5000), { once: true });
    } catch {
      // ignore
    }
    const onUrlChange = (event: "onHistoryStateUpdated" | "onReferenceFragmentUpdated") => {
      if (!stillCurrent()) return;
      let current: string;
      try {
        current = String(client.url);
      } catch {
        return;
      }
      if (current === tab.url) return;
      tab.url = current;
      const f = frameRecord();
      if (f) f.url = current;
      s.tabUpdated(tabId, { url: current });
      dispatchNavigation(s, event, { ...base(), url: current, transitionType: "link", transitionQualifiers: [] });
    };
    try {
      const history = win.history;
      for (const method of ["pushState", "replaceState"] as const) {
        const original = history[method];
        history[method] = function (this: History, ...args: Parameters<History["pushState"]>) {
          const result = original.apply(this, args);
          queueMicrotask(() => onUrlChange("onHistoryStateUpdated"));
          return result;
        };
      }
      win.addEventListener("popstate", () => onUrlChange("onHistoryStateUpdated"));
      win.addEventListener("hashchange", () => onUrlChange("onReferenceFragmentUpdated"));
    } catch {
      // ignore
    }
  }
}

function installKeyboardShortcuts(s: Sapphire, win: Window, tabId: number | null): void {
  try {
    win.addEventListener(
      "keydown",
      (e: KeyboardEvent) => {
        if (s.handleKeyboardEvent(e, tabId)) {
          e.preventDefault();
          e.stopImmediatePropagation();
        }
      },
      true,
    );
  } catch {
    // ignore
  }
}

function installContextMenuCapture(s: Sapphire, win: Window, tabId: number, world: ContentWorld | undefined): void {
  if (!s.host.showContextMenu) return;
  win.addEventListener(
    "contextmenu",
    (e: MouseEvent) => {
      const target = e.target as Element | null;
      const contexts: string[] = [];
      let linkUrl: string | undefined;
      let linkText: string | undefined;
      let srcUrl: string | undefined;
      let mediaType: string | undefined;
      const link = target?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (link) {
        contexts.push("link");
        linkUrl = link.href;
        linkText = link.textContent ?? "";
      }
      const tag = target?.tagName?.toLowerCase();
      if (tag === "img" || tag === "video" || tag === "audio") {
        mediaType = tag === "img" ? "image" : tag;
        contexts.push(mediaType);
        srcUrl = (target as HTMLImageElement).currentSrc || (target as HTMLImageElement).src;
      }
      const selection = win.getSelection()?.toString() ?? "";
      if (selection) contexts.push("selection");
      const editable = !!target && ((target as HTMLElement).isContentEditable || tag === "input" || tag === "textarea");
      if (editable) contexts.push("editable");
      const isTop = world?.isTop ?? true;
      contexts.push(isTop ? "page" : "frame");
      const tab = s.registry.tab(tabId);
      const info = {
        contexts,
        pageUrl: tab.url,
        frameUrl: world?.url,
        frameId: world?.frameId,
        linkUrl,
        linkText,
        srcUrl,
        mediaType,
        selectionText: selection || undefined,
        editable,
      };
      if (s.showContextMenu(tabId, world?.frameId ?? 0, info, e)) e.preventDefault();
    },
    true,
  );
}

