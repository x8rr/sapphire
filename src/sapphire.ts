import type { Controller } from "@mercuryworkshop/scramjet-controller";
import { refreshChromeApi } from "./api";
import { clickAction, colorToCss, effectiveAction } from "./api/action";
import { clearAlarms } from "./api/alarms";
import { clickContextMenuItem, contextMenuEntries, type ContextInfo } from "./api/contextMenus";
import { extensionInfo } from "./api/misc";
import { completeMessage, normalizeSendMessageArgs } from "./api/runtime";
import { BrowserData } from "./browserData";
import { findMatchingCommand, triggerCommand } from "./commands";
import { contentContext, contentWorldOf, executeInWorld, injectStyle, removeStyle, type ContentWorld, type ScriptInjection } from "./content";
import { checkDeclarativeNetRequest } from "./dnr";
import {
  deletePackage,
  loadExtension,
  loadRuleset,
  persistRegisteredScripts,
  registrationFiles,
  saveMeta,
  storedMeta,
  storedMetas,
  storePackage,
  unpackExtension,
  unregisterContentScripts,
  type InstalledExtensionSummary,
} from "./extensions";
import { dispatchServiceWorkerLifecycle } from "./frames";
import { deliverMessage, NO_RECEIVER, openPort, originOf } from "./messaging";
import { matchPattern } from "./matchPatterns";
import { ApiError, toRealm } from "./realm";
import { SapphireRegistry, type ExtensionContext, type ExtensionState, type FrameHandle } from "./registry";
import { SapphirePlugin, type SapphirePluginOptions } from "./SapphirePlugin";
import { buildTab, touchTab } from "./tabsModel";
import type { ContentScriptRegistration, DNRDecision, SapphireHostBindings } from "./types";
import { displayExtensionUrl, extensionUrl, normalizeExtensionUrl, parseExtensionUrl, setExtensionHostSuffix } from "./urls";
import { GENERATED_BACKGROUND, serveExtensionResource } from "./network";

export interface SapphireOptions {
  host: SapphireHostBindings;
  /** The Scramjet controller. Can also be supplied later with attachController(). */
  controller?: Controller;
  /** Where hidden background/offscreen frames are attached. Defaults to document.body. */
  backgroundRoot?: HTMLElement;
  /** Host suffix of the per-extension https origin. Default "sapphire-extension.invalid". */
  extensionHostSuffix?: string;
}

export interface NewTabOverride {
  extId: string;
  page: string;
  url: string;
}

export interface DownloadItem {
  id: number;
  url: string;
  finalUrl: string;
  filename: string;
  mime: string;
  state: "in_progress" | "interrupted" | "complete";
  danger: string;
  paused: boolean;
  canResume: boolean;
  bytesReceived: number;
  totalBytes: number;
  fileSize: number;
  startTime: string;
  endTime?: string;
  exists: boolean;
  incognito: boolean;
  byExtensionId: string;
  byExtensionName: string;
  error?: string;
}

interface AuthFlow {
  extId: string;
  resolve: (url: string) => void;
  reject: (e: Error) => void;
  close: () => void;
}

export class Sapphire {
  readonly registry = new SapphireRegistry();
  readonly host: SapphireHostBindings;
  readonly browserData = new BrowserData();
  readonly settings = new Map<string, { extId: string; value: unknown }>();
  downloads: DownloadItem[] = [];
  controller: Controller | null = null;

  private readonly backgroundRoot: HTMLElement | null;
  private ready: Promise<number> | null = null;
  private readonly popupFrames = new WeakMap<HTMLIFrameElement, FrameHandle>();
  private readonly openPopups = new Map<string, HTMLIFrameElement>();
  private readonly authFlows = new Map<string, AuthFlow>();
  private lastActivity = Date.now();
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private lastIdleState = "active";
  private changeTimer: ReturnType<typeof setTimeout> | null = null;
  private downloadCounter = 0;
  private startupPhase = true;
  private readonly externalContexts = new WeakMap<Window, Map<string, ExtensionContext>>();

  constructor(options: SapphireOptions) {
    this.host = options.host;
    this.backgroundRoot = options.backgroundRoot ?? null;
    if (options.extensionHostSuffix) setExtensionHostSuffix(options.extensionHostSuffix);
    if (options.controller) this.controller = options.controller;
    if (typeof document !== "undefined") {
      for (const type of ["pointerdown", "keydown", "wheel", "touchstart"]) {
        document.addEventListener(type, () => this.noteActivity(), { capture: true, passive: true });
      }
    }
  }

  // ---- setup --------------------------------------------------------------

  /** A plugin for a browser tab's Scramjet frame. */
  createPlugin(tabId: number | null, options: Omit<SapphirePluginOptions, "tabId"> = {}): SapphirePlugin {
    return new SapphirePlugin(this, { ...options, tabId });
  }

  private controllerWaiters: ((c: Controller) => void)[] = [];

  /** Resolves once a controller is attached, asking the host to boot one if needed. */
  waitForController(): Promise<Controller> {
    if (this.controller) return Promise.resolve(this.controller);
    const p = new Promise<Controller>((resolve) => this.controllerWaiters.push(resolve));
    this.host.ensureController?.();
    return p;
  }

  attachController(controller: Controller): void {
    if (this.controller === controller) return;
    this.controller = controller;
    for (const resolve of this.controllerWaiters.splice(0)) resolve(controller);
    for (const ext of this.registry.list()) if (ext.enabled) void this.startBackground(ext);
  }

  init(): Promise<number> {
    if (!this.ready) {
      this.ready = (async () => {
        const metas = await storedMetas();
        for (const meta of metas) {
          try {
            const ext = await loadExtension(this, meta);
            if (ext.enabled) void this.startBackground(ext);
          } catch (e) {
            console.error(`[sapphire] failed to load stored extension ${meta.id}`, e);
          }
        }
        this.registry.notifyChange();
        setTimeout(() => (this.startupPhase = false), 0);
        if (metas.some((m) => m.enabled !== false) && !this.controller) this.host.ensureController?.();
        return metas.length;
      })();
    }
    return this.ready;
  }

  onChange(cb: () => void): () => void {
    return this.registry.onChange(cb);
  }

  scheduleChange(): void {
    if (this.changeTimer) return;
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null;
      this.registry.notifyChange();
    }, 50);
  }

  // ---- install / uninstall ----------------------------------------------

  async installExtension(buffer: ArrayBuffer, filename = "extension.crx"): Promise<string> {
    const pkg = await unpackExtension(buffer, filename);
    const existing = this.registry.get(pkg.id);
    const previousMeta = existing?.meta ?? (await storedMeta(pkg.id));
    if (existing) this.unloadExtension(existing);
    const meta = await storePackage(pkg, filename, previousMeta);
    const ext = await loadExtension(this, meta);
    if (!this.controller) this.host.ensureController?.();
    if (ext.enabled) await this.startBackground(ext);
    this.registry.dispatchAll("management.onInstalled", (ctx) => [toRealm(ctx, extensionInfo(this, ext))]);
    this.registry.notifyChange();
    return ext.id;
  }

  private unloadExtension(ext: ExtensionState): void {
    this.stopBackground(ext);
    this.closeOffscreen(ext);
    clearAlarms(ext);
    unregisterContentScripts(this, ext.id);
    const popup = this.openPopups.get(ext.id);
    if (popup) this.unmountFrame(popup);
    for (const world of this.allContentWorlds()) {
      for (const style of [...world.styles]) if (style.extId === ext.id) removeStyle(world, ext.id, style.key);
    }
    this.registry.remove(ext.id);
  }

  async uninstallExtension(extId: string): Promise<void> {
    const ext = this.registry.get(extId);
    if (!ext) return;
    const uninstallUrl = ext.settings.get("uninstallUrl") as string | undefined;
    this.unloadExtension(ext);
    await deletePackage(ext);
    this.registry.dispatchAll("management.onUninstalled", [extId]);
    if (uninstallUrl) void this.openTab(uninstallUrl, { active: true });
    this.registry.notifyChange();
  }

  async setExtensionEnabled(extId: string, enabled: boolean): Promise<void> {
    const ext = this.registry.get(extId);
    if (!ext || ext.enabled === enabled) return;
    ext.enabled = enabled;
    ext.meta.enabled = enabled;
    await saveMeta(ext.meta);
    if (enabled) {
      await this.startBackground(ext);
      this.registry.dispatchAll("management.onEnabled", (ctx) => [toRealm(ctx, extensionInfo(this, ext))]);
    } else {
      this.stopBackground(ext);
      this.closeOffscreen(ext);
      for (const ctx of this.registry.contextsOf(ext.id)) this.registry.destroyContext(ctx);
      this.registry.dispatchAll("management.onDisabled", (ctx) => [toRealm(ctx, extensionInfo(this, ext))]);
    }
    this.registry.notifyChange();
  }

  async reloadExtension(extId: string): Promise<void> {
    const ext = this.registry.get(extId);
    if (!ext) return;
    const meta = ext.meta;
    this.unloadExtension(ext);
    const reloaded = await loadExtension(this, meta);
    if (reloaded.enabled) await this.startBackground(reloaded);
    this.registry.notifyChange();
  }

  getInstalledExtensions(tabId: number | null = this.host.getActiveTabId?.() ?? null): InstalledExtensionSummary[] {
    return this.registry.list().map((ext) => {
      const action = effectiveAction(ext, tabId);
      const options = ext.manifest.options_ui?.page ?? ext.manifest.options_page;
      return {
        id: ext.id,
        name: ext.manifest.name,
        version: ext.manifest.version,
        description: ext.manifest.description ?? "",
        enabled: ext.enabled,
        manifest: ext.manifest,
        iconUrl: action.iconUrl,
        title: action.title,
        badgeText: action.badgeText,
        badgeColor: colorToCss(action.badgeColor),
        badgeTextColor: colorToCss(action.badgeTextColor),
        hasPopup: !!action.popup,
        popupUrl: action.popup ? extensionUrl(ext.id, action.popup) : null,
        actionEnabled: action.enabled,
        optionsUrl: options ? extensionUrl(ext.id, options) : null,
      };
    });
  }

  // ---- frames ------------------------------------------------------------

  extensionUrl(extId: string, path = ""): string {
    return extensionUrl(extId, path);
  }

  /** Alias origin URL → chrome-extension:// for an address bar. */
  displayUrl(url: string): string {
    return displayExtensionUrl(url);
  }

  /** chrome-extension:// URL typed or linked by the user → the URL to load in a Scramjet frame. */
  resolveUrl(url: string): string {
    return normalizeExtensionUrl(url);
  }

  private requireController(): Controller {
    if (!this.controller) throw new Error("sapphire: no Scramjet controller attached (pass `controller` or call attachController())");
    return this.controller;
  }

  createFrame(element: HTMLIFrameElement, options: SapphirePluginOptions): FrameHandle {
    const controller = this.requireController();
    const frame = controller.createFrame(element, { plugins: [new SapphirePlugin(this, options)] });
    return {
      element,
      go: (url: string) => frame.go(url),
      destroy: () => {
        const i = controller.frames.indexOf(frame);
        if (i > -1) controller.frames.splice(i, 1);
      },
    };
  }

  private hiddenFrame(): HTMLIFrameElement {
    const frame = document.createElement("iframe");
    frame.style.cssText = "position:fixed;width:0;height:0;border:0;opacity:0;pointer-events:none;left:-10px;top:-10px;";
    frame.setAttribute("aria-hidden", "true");
    frame.tabIndex = -1;
    (this.backgroundRoot ?? document.body).appendChild(frame);
    return frame;
  }

  private mountFrame(element: HTMLIFrameElement, extId: string, path: string, options: SapphirePluginOptions): boolean {
    const ext = this.registry.get(extId);
    if (!ext || !ext.enabled || !this.controller) return false;
    this.popupFrames.get(element)?.destroy();
    const handle = this.createFrame(element, options);
    this.popupFrames.set(element, handle);
    handle.go(extensionUrl(extId, path));
    return true;
  }

  private unmountFrame(element: HTMLIFrameElement): void {
    const handle = this.popupFrames.get(element);
    if (!handle) return;
    handle.destroy();
    this.popupFrames.delete(element);
    try {
      element.src = "about:blank";
    } catch {
      // ignore
    }
  }

  getExtensionPopupPage(extId: string, tabId: number | null = null): string | null {
    const ext = this.registry.get(extId);
    if (!ext) return null;
    return effectiveAction(ext, tabId).popup || null;
  }

  async mountExtensionPopup(frame: HTMLIFrameElement, extId: string, tabId: number | null): Promise<boolean> {
    const popup = this.getExtensionPopupPage(extId, tabId);
    if (!popup) return false;
    await this.waitForController();
    const ok = this.mountFrame(frame, extId, popup, { kind: "popup", tabId });
    if (ok) this.openPopups.set(extId, frame);
    return ok;
  }

  /** Tear down a popup the host is hiding, so its ports disconnect like Chrome's. */
  unmountExtensionPopup(frame: HTMLIFrameElement): void {
    for (const [extId, el] of this.openPopups) if (el === frame) this.openPopups.delete(extId);
    this.unmountFrame(frame);
  }

  async mountExtensionPage(frame: HTMLIFrameElement, extId: string, page: string, tabId: number | null, kind: "tab" | "sidepanel" = "tab"): Promise<boolean> {
    await this.waitForController();
    return this.mountFrame(frame, extId, page.replace(/^\/+/, ""), { kind, tabId });
  }

  async mountSidePanel(frame: HTMLIFrameElement, extId: string, tabId: number | null): Promise<boolean> {
    const ext = this.registry.get(extId);
    if (!ext) return false;
    const path = (tabId !== null ? ext.sidePanel.tabOptions.get(tabId)?.path : undefined) ?? ext.sidePanel.path;
    if (!path) return false;
    await this.waitForController();
    return this.mountFrame(frame, extId, path, { kind: "sidepanel", tabId });
  }

  getNewTabOverride(): NewTabOverride | null {
    const winner = this.registry
      .list()
      .filter((ext) => ext.enabled && typeof ext.manifest.chrome_url_overrides?.newtab === "string")
      .sort((a, b) => b.installedAt - a.installedAt)[0];
    if (!winner) return null;
    const page = winner.manifest.chrome_url_overrides!.newtab!.replace(/^\/+/, "");
    return { extId: winner.id, page, url: extensionUrl(winner.id, page) };
  }

  async mountNewTabPage(frame: HTMLIFrameElement, extId: string, page: string, tabId: number | null): Promise<boolean> {
    return this.mountExtensionPage(frame, extId, page, tabId, "tab");
  }

  // ---- background / offscreen ----------------------------------------------

  private backgroundPath(ext: ExtensionState): string | null {
    const bg = ext.manifest.background;
    if (!bg) return null;
    if (bg.service_worker) return GENERATED_BACKGROUND;
    if (bg.page) return bg.page.replace(/^\/+/, "");
    if (bg.scripts?.length) return GENERATED_BACKGROUND;
    return null;
  }

  async startBackground(ext: ExtensionState): Promise<void> {
    if (ext.background || !this.controller || !ext.enabled) return ext.backgroundReady ?? undefined;
    const path = this.backgroundPath(ext);
    if (!path) {
      this.fireLifecycle(ext);
      return;
    }
    let resolveReady!: () => void;
    ext.backgroundReady = new Promise<void>((r) => (resolveReady = r));
    (ext as ExtensionState & { resolveBackground?: () => void }).resolveBackground = resolveReady;
    const element = this.hiddenFrame();
    element.name = `sapphire-background-${ext.id}`;
    const handle = this.createFrame(element, { kind: "background", tabId: null });
    ext.background = {
      element,
      go: handle.go,
      destroy: () => {
        handle.destroy();
        element.remove();
      },
    };
    handle.go(extensionUrl(ext.id, path));
    // Don't let a background that never loads hang callers forever.
    setTimeout(resolveReady, 15000);
    return ext.backgroundReady;
  }

  stopBackground(ext: ExtensionState): void {
    if (!ext.background) return;
    for (const ctx of this.registry.contextsOf(ext.id, (c) => c.kind === "background")) {
      ctx.events.peek("runtime.onSuspend")?.dispatchSync(() => true, () => []);
      this.registry.destroyContext(ctx);
    }
    ext.background.destroy();
    ext.background = null;
    ext.backgroundReady = null;
  }

  /** Called from the frame init hook when a background document starts. */
  onBackgroundContext(ext: ExtensionState, ctx: ExtensionContext): void {
    const win = ctx.window;
    const done = () => {
      setTimeout(() => {
        if (!ctx.alive) return;
        if (ext.manifest.background?.service_worker) dispatchServiceWorkerLifecycle(ctx);
        this.fireLifecycle(ext);
        (ext as ExtensionState & { resolveBackground?: () => void }).resolveBackground?.();
      }, 0);
    };
    if (win.document.readyState === "complete") done();
    else win.addEventListener("load", done, { once: true });
  }

  private fireLifecycle(ext: ExtensionState): void {
    const version = ext.manifest.version ?? "";
    const last = ext.meta.lastRunVersion;
    if (last === undefined) {
      this.registry.dispatch(ext.id, "runtime.onInstalled", [{ reason: "install" }]);
    } else if (last !== version) {
      this.registry.dispatch(ext.id, "runtime.onInstalled", [{ reason: "update", previousVersion: last }]);
    } else if (this.startupPhase) {
      this.registry.dispatch(ext.id, "runtime.onStartup", []);
    }
    if (last !== version) {
      ext.meta.lastRunVersion = version;
      void saveMeta(ext.meta);
    }
  }

  async createOffscreen(ext: ExtensionState, path: string, reasons: string[]): Promise<void> {
    const element = this.hiddenFrame();
    const handle = this.createFrame(element, { kind: "offscreen", tabId: null });
    const loaded = new Promise<void>((resolve) => {
      element.addEventListener("load", () => resolve(), { once: true });
      setTimeout(resolve, 10000);
    });
    ext.offscreen = {
      handle: {
        element,
        go: handle.go,
        destroy: () => {
          handle.destroy();
          element.remove();
        },
      },
      url: extensionUrl(ext.id, path),
      reasons,
    };
    handle.go(extensionUrl(ext.id, path));
    await loaded;
  }

  closeOffscreen(ext: ExtensionState): void {
    if (!ext.offscreen) return;
    for (const ctx of this.registry.contextsOf(ext.id, (c) => c.kind === "offscreen")) this.registry.destroyContext(ctx);
    ext.offscreen.handle.destroy();
    ext.offscreen = null;
  }

  // ---- tabs (called by APIs) ----------------------------------------------

  async openTab(url: string, options: { active?: boolean; openerTabId?: number; popup?: boolean } = {}): Promise<number | null> {
    const active = options.active ?? true;
    const before = new Set(this.host.getAllTabs().map((t) => t.id));
    const parsed = parseExtensionUrl(url);
    if (this.host.createTab) {
      const id = await this.host.createTab(url, { active, openerTabId: options.openerTabId });
      if (id !== null && id !== undefined) return id;
    } else if (parsed && this.host.openExtensionTab) {
      this.host.openExtensionTab(parsed.extId, parsed.path + parsed.search + parsed.hash, null);
    } else if (this.host.navigateTab) {
      this.host.navigateTab(null, url);
    } else {
      return null;
    }
    for (let i = 0; i < 20; i++) {
      const created = this.host.getAllTabs().find((t) => !before.has(t.id));
      if (created) return created.id;
      await new Promise((r) => setTimeout(r, i < 5 ? 0 : 16));
    }
    return this.host.getActiveTabId?.() ?? null;
  }

  navigate(tabId: number, url: string): void {
    const parsed = parseExtensionUrl(url);
    if (parsed && this.host.openExtensionTab && !this.host.createTab) {
      this.host.openExtensionTab(parsed.extId, parsed.path + parsed.search + parsed.hash, tabId);
      return;
    }
    if (this.host.navigateTab) {
      this.host.navigateTab(tabId, url);
      return;
    }
    const win = this.host.getTabWindow?.(tabId);
    if (win) win.location.href = url;
  }

  openExtensionPage(extId: string, page: string, tabId: number | null): void {
    const url = extensionUrl(extId, page);
    if (this.host.openExtensionTab) this.host.openExtensionTab(extId, page.replace(/^\/+/, ""), tabId);
    else if (tabId !== null) this.navigate(tabId, url);
    else void this.openTab(url, { active: true });
  }

  closeTab(tabId: number): void {
    this.host.closeTab?.(tabId);
  }

  reloadTab(tabId: number): void {
    if (this.host.reloadTab) this.host.reloadTab(tabId);
    else this.host.getTabWindow?.(tabId)?.location.reload();
  }

  activateTab(tabId: number): void {
    this.host.activateTab?.(tabId);
  }

  historyGo(tabId: number, delta: number): void {
    if (delta < 0 && this.host.goBack) return this.host.goBack(tabId);
    if (delta > 0 && this.host.goForward) return this.host.goForward(tabId);
    this.host.getTabWindow?.(tabId)?.history.go(delta);
  }

  tabUpdated(tabId: number, changes: Record<string, unknown>): void {
    const tab = buildTab(this, tabId);
    if (!tab) return;
    this.registry.dispatchAll("tabs.onUpdated", (ctx) => [tabId, toRealm(ctx, changes), toRealm(ctx, tab)]);
    if ("url" in changes) {
      for (const ext of this.registry.list()) {
        // Per-tab action state and DNR counters reset on navigation, as in Chrome.
        if (changes.status === "loading") {
          ext.tabAction.delete(tabId);
          ext.dnr.tabActionCounts.delete(tabId);
        }
      }
      this.scheduleChange();
    }
  }

  recordHistory(tabId: number, url: string, title: string): void {
    if (!/^https?:/i.test(url) || parseExtensionUrl(url)) return;
    void this.browserData.load().then(() => {
      const { item } = this.browserData.recordVisit(url, title);
      const result = { id: item.id, url: item.url, title: item.title, lastVisitTime: item.lastVisitTime, visitCount: item.visitCount, typedCount: item.typedCount };
      for (const ext of this.registry.list()) {
        if (ext.grantedPermissions.has("history")) this.registry.dispatch(ext.id, "history.onVisited", (ctx) => [toRealm(ctx, result)]);
      }
    });
    void tabId;
  }

  // ---- script injection (scripting / tabs.executeScript) ---------------------

  private targetFrames(target: { tabId: number; frameIds?: number[]; documentIds?: string[]; allFrames?: boolean }) {
    const frames = this.registry.liveFrames(target.tabId);
    if (!frames.length) {
      if (!this.host.getTab(target.tabId)) throw new ApiError(`No tab with id: ${target.tabId}`);
      throw new ApiError("Cannot access contents of the page. Extension manifest must request permission to access the respective host.");
    }
    let selected = frames;
    if (target.frameIds) {
      selected = frames.filter((f) => target.frameIds!.includes(f.frameId));
      const missing = target.frameIds.find((id) => !frames.some((f) => f.frameId === id));
      if (missing !== undefined) throw new ApiError(`No frame with id ${missing} in tab with id ${target.tabId}`);
    } else if (target.documentIds) {
      selected = frames.filter((f) => target.documentIds!.includes(f.documentId));
    } else if (!target.allFrames) {
      selected = frames.filter((f) => f.frameId === 0);
    }
    return selected;
  }

  async executeScript(
    ext: ExtensionState,
    target: { tabId: number; frameIds?: number[]; documentIds?: string[]; allFrames?: boolean },
    injection: ScriptInjection,
  ): Promise<{ frameId: number; documentId: string; result?: unknown }[]> {
    if (injection.files) await ext.files.preload(injection.files);
    const frames = this.targetFrames(target);
    const results: { frameId: number; documentId: string; result?: unknown }[] = [];
    let injected = 0;
    for (const frame of frames) {
      const world = contentWorldOf(frame.window);
      if (!world) {
        if (frame.frameId === 0 && !target.allFrames) {
          throw new ApiError(`Cannot access contents of url "${displayExtensionUrl(frame.url)}". Extension manifest must request permission to access this host.`);
        }
        continue;
      }
      injected++;
      const result = await executeInWorld(this, world, ext, injection);
      results.push({ frameId: frame.frameId, documentId: frame.documentId, ...(result !== undefined ? { result } : { result: null }) });
    }
    if (!injected) throw new ApiError("Cannot access contents of the page.");
    return results;
  }

  async insertCss(ext: ExtensionState, target: { tabId: number; frameIds?: number[]; documentIds?: string[]; allFrames?: boolean }, css: string, key: string): Promise<void> {
    for (const frame of this.targetFrames(target)) {
      const world = contentWorldOf(frame.window);
      if (world) injectStyle(world, ext, css, key);
    }
  }

  async removeCss(ext: ExtensionState, target: { tabId: number; frameIds?: number[]; documentIds?: string[]; allFrames?: boolean }, key: string): Promise<void> {
    for (const frame of this.targetFrames(target)) {
      const world = contentWorldOf(frame.window);
      if (world) removeStyle(world, ext.id, key);
    }
  }

  private allContentWorlds(): ContentWorld[] {
    const out: ContentWorld[] = [];
    for (const tabId of this.registry.tabs.keys()) {
      for (const frame of this.registry.liveFrames(tabId)) {
        const world = contentWorldOf(frame.window);
        if (world) out.push(world);
      }
    }
    return out;
  }

  async addContentScripts(ext: ExtensionState, regs: ContentScriptRegistration[]): Promise<void> {
    await ext.files.preload(registrationFiles(regs));
    this.registry.contentScripts.push(...regs);
    await persistRegisteredScripts(this, ext.id);
  }

  async removeContentScripts(ext: ExtensionState, source: ContentScriptRegistration["source"], ids: string[] | null): Promise<void> {
    const list = this.registry.contentScripts;
    for (let i = list.length - 1; i >= 0; i--) {
      const cs = list[i];
      if (cs.extId !== ext.id || cs.source !== source) continue;
      if (ids && !ids.includes(cs.id!)) continue;
      list.splice(i, 1);
    }
    await persistRegisteredScripts(this, ext.id);
  }

  // ---- DNR ------------------------------------------------------------------

  async ensureRulesetsLoaded(ext: ExtensionState, ids: string[]): Promise<void> {
    for (const id of ids) {
      if (ext.dnr.rulesets.get(id)?.length) continue;
      ext.dnr.rulesets.delete(id);
      if (!(await loadRuleset(ext, id))) ext.dnr.rulesets.delete(id);
    }
  }

  hasDnrRules(): boolean {
    for (const ext of this.registry.extensions.values()) {
      if (!ext.enabled) continue;
      if (ext.dnr.dynamicRules.length || ext.dnr.sessionRules.length || ext.dnr.enabledRulesets.size) return true;
    }
    return false;
  }

  checkDeclarativeNetRequest(requestUrl: string, initiatorUrl?: string, resourceType?: string): DNRDecision | null {
    return checkDeclarativeNetRequest(this.registry, requestUrl, initiatorUrl, resourceType);
  }

  refreshApis(ext: ExtensionState): void {
    for (const ctx of this.registry.contextsOf(ext.id)) refreshChromeApi(this, ctx);
  }

  // ---- host UI → extensions ------------------------------------------------

  /** Toolbar button click: opens the popup if there is one, otherwise fires action.onClicked. */
  clickAction(extId: string, tabId: number | null = this.host.getActiveTabId?.() ?? null): "popup" | "clicked" | "disabled" | null {
    const ext = this.registry.get(extId);
    if (!ext || !ext.enabled) return null;
    return clickAction(this, ext, tabId);
  }

  /** Legacy: always fire onClicked (hosts that render the popup themselves). */
  triggerActionClicked(extId: string, tabId: number | null): void {
    const ext = this.registry.get(extId);
    if (ext) this.dispatchActionClicked(ext, tabId);
  }

  dispatchActionClicked(ext: ExtensionState, tabId: number | null): void {
    const tab = buildTab(this, tabId);
    const mv = Number(ext.manifest.manifest_version) || 2;
    const event = mv >= 3 ? "action.onClicked" : ext.manifest.page_action ? "pageAction.onClicked" : "browserAction.onClicked";
    this.registry.dispatch(ext.id, event, (ctx) => [toRealm(ctx, tab)]);
  }

  getActionState(extId: string, tabId: number | null) {
    const ext = this.registry.get(extId);
    if (!ext) return null;
    const a = effectiveAction(ext, tabId);
    return { ...a, badgeColor: colorToCss(a.badgeColor), badgeTextColor: colorToCss(a.badgeTextColor) };
  }

  openPopup(extId: string, tabId: number | null): boolean {
    if (!this.getExtensionPopupPage(extId, tabId)) return false;
    const result = this.host.openPopup?.(extId, tabId);
    return result !== false && !!this.host.openPopup;
  }

  closePopup(extId: string): void {
    const frame = this.openPopups.get(extId);
    this.host.closePopup?.(extId);
    if (frame) this.unmountExtensionPopup(frame);
  }

  triggerCommand(extId: string, name: string, tabId: number | null = this.host.getActiveTabId?.() ?? null): void {
    const ext = this.registry.get(extId);
    if (!ext || !ext.enabled) return;
    if (name === "_execute_action" || name === "_execute_browser_action" || name === "_execute_page_action") {
      clickAction(this, ext, tabId);
      return;
    }
    if (name === "_execute_side_panel" && ext.sidePanel.path) {
      this.host.openSidePanel?.(ext.id, ext.sidePanel.path, tabId);
      return;
    }
    const tab = buildTab(this, tabId);
    triggerCommand(this.registry, extId, name, tab ?? undefined);
  }

  /** Returns true when the key event matched an extension shortcut and was consumed. */
  handleKeyboardEvent(e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey"> & { code?: string }, tabId: number | null = this.host.getActiveTabId?.() ?? null): boolean {
    if (!e.ctrlKey && !e.altKey && !e.metaKey && !/^(Media|F\d)/.test(e.key)) return false;
    const match = findMatchingCommand(this.registry, e);
    if (!match) return false;
    this.triggerCommand(match.extId, match.name, tabId);
    return true;
  }

  getContextMenuItems(info: ContextInfo) {
    return contextMenuEntries(this, info);
  }

  clickContextMenuItem(extId: string, itemId: string, info: ContextInfo, tabId: number | null): void {
    const ext = this.registry.get(extId);
    if (ext) clickContextMenuItem(this, ext, itemId, info, tabId);
  }

  showContextMenu(tabId: number, frameId: number, info: ContextInfo, e: MouseEvent): boolean {
    if (!this.host.showContextMenu) return false;
    const items = contextMenuEntries(this, info);
    if (!items.length) return false;
    let x = e.clientX;
    let y = e.clientY;
    try {
      let win: Window | null = (e.target as Node | null)?.ownerDocument?.defaultView ?? null;
      while (win && win.frameElement) {
        const rect = win.frameElement.getBoundingClientRect();
        x += rect.left;
        y += rect.top;
        win = win.parent === win ? null : win.parent;
      }
    } catch {
      // cross-origin
    }
    this.host.showContextMenu({
      tabId,
      frameId,
      x,
      y,
      items,
      select: (entry) => this.clickContextMenuItem(entry.extId, entry.id, info, tabId),
    });
    return true;
  }

  // Omnibox: the host calls these while the user types "<keyword> text".
  getOmniboxKeywords(): { extId: string; keyword: string; name: string }[] {
    return this.registry
      .list()
      .filter((e) => e.enabled && e.manifest.omnibox?.keyword)
      .map((e) => ({ extId: e.id, keyword: e.manifest.omnibox!.keyword!, name: e.manifest.name }));
  }

  omniboxInputStarted(extId: string): void {
    this.registry.dispatch(extId, "omnibox.onInputStarted", []);
  }

  omniboxInputChanged(extId: string, text: string): Promise<{ content: string; description: string; deletable?: boolean }[]> {
    return new Promise((resolve) => {
      let settled = false;
      const suggest = (suggestions: { content: string; description: string }[]) => {
        if (settled) return;
        settled = true;
        resolve(JSON.parse(JSON.stringify(suggestions ?? [])));
      };
      this.registry.dispatch(extId, "omnibox.onInputChanged", [text, suggest]);
      setTimeout(() => suggest([]), 3000);
    });
  }

  omniboxInputEntered(extId: string, text: string, disposition: "currentTab" | "newForegroundTab" | "newBackgroundTab" = "currentTab"): void {
    this.registry.dispatch(extId, "omnibox.onInputEntered", [text, disposition]);
  }

  omniboxInputCancelled(extId: string): void {
    this.registry.dispatch(extId, "omnibox.onInputCancelled", []);
  }

  omniboxDefaultSuggestion(extId: string): string | null {
    return this.registry.get(extId)?.omniboxDefaultSuggestion?.description ?? null;
  }

  // Tab lifecycle notifications from the host.
  notifyTabCreated(tabId: number): void {
    const tab = buildTab(this, tabId);
    if (tab) this.registry.dispatchAll("tabs.onCreated", (ctx) => [toRealm(ctx, tab)]);
  }

  notifyTabUpdated(tabId: number, changeInfo: { status?: string; url?: string; title?: string }): void {
    const tracked = this.registry.tab(tabId);
    const changes: Record<string, unknown> = {};
    if (changeInfo.url && changeInfo.url !== tracked.url) {
      tracked.url = changeInfo.url;
      changes.url = changeInfo.url;
    }
    if (changeInfo.title && changeInfo.title !== tracked.title) {
      tracked.title = changeInfo.title;
      changes.title = changeInfo.title;
    }
    if (changeInfo.status && changeInfo.status !== tracked.status) {
      tracked.status = changeInfo.status as "loading" | "complete";
      changes.status = changeInfo.status;
    }
    if (Object.keys(changes).length) this.tabUpdated(tabId, changes);
  }

  notifyTabRemoved(tabId: number, windowId = 1): void {
    const tracked = this.registry.tabs.get(tabId);
    if (tracked?.url && /^https?:/.test(tracked.url) && !parseExtensionUrl(tracked.url)) {
      this.browserData.closedTabs.unshift({ sessionId: `${tabId}-${Date.now()}`, lastModified: Date.now(), url: tracked.url, title: tracked.title });
      if (this.browserData.closedTabs.length > 25) this.browserData.closedTabs.length = 25;
    }
    for (const ctx of [...this.registry.contexts]) if (ctx.tabId === tabId) this.registry.destroyContext(ctx);
    this.registry.tabs.delete(tabId);
    for (const ext of this.registry.list()) {
      ext.tabAction.delete(tabId);
      ext.dnr.tabActionCounts.delete(tabId);
    }
    this.registry.dispatchAll("tabs.onRemoved", [tabId, { windowId, isWindowClosing: false }]);
  }

  notifyTabActivated(tabId: number, windowId = 1): void {
    touchTab(tabId);
    this.registry.dispatchAll("tabs.onActivated", [{ tabId, windowId }]);
    this.registry.dispatchAll("tabs.onHighlighted", [{ tabIds: [tabId], windowId }]);
    this.scheduleChange();
  }

  // ---- misc services used by APIs -------------------------------------------

  noteActivity(): void {
    this.lastActivity = Date.now();
    if (this.lastIdleState !== "active") this.checkIdle();
  }

  idleState(intervalSeconds: number): "active" | "idle" {
    this.ensureIdleWatch();
    return Date.now() - this.lastActivity >= intervalSeconds * 1000 ? "idle" : "active";
  }

  private ensureIdleWatch(): void {
    if (this.idleTimer) return;
    this.idleTimer = setInterval(() => this.checkIdle(), 15000);
  }

  private checkIdle(): void {
    for (const ext of this.registry.list()) {
      if (!ext.grantedPermissions.has("idle")) continue;
      const interval = (ext.settings.get("idle.interval") as number | undefined) ?? 60;
      const state = Date.now() - this.lastActivity >= interval * 1000 ? "idle" : "active";
      const key = "idle.lastState";
      if (ext.settings.get(key) !== state) {
        ext.settings.set(key, state);
        this.registry.dispatch(ext.id, "idle.onStateChanged", [state]);
      }
    }
    this.lastIdleState = Date.now() - this.lastActivity >= 60000 ? "idle" : "active";
  }

  launchWebAuthFlow(ext: ExtensionState, url: string, interactive: boolean): Promise<string> {
    if (!url) return Promise.reject(new ApiError("Authorization page could not be loaded."));
    if (!this.controller) return Promise.reject(new ApiError("Authorization page could not be loaded."));
    this.authFlows.get(ext.id)?.reject(new ApiError("Authorization page could not be loaded."));
    return new Promise((resolve, reject) => {
      const overlay = document.createElement("div");
      overlay.style.cssText = interactive
        ? "position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center"
        : "position:fixed;width:0;height:0;overflow:hidden;opacity:0;pointer-events:none";
      const panel = document.createElement("div");
      panel.style.cssText = "position:relative;width:min(520px,95vw);height:min(680px,90vh);background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 10px 40px rgba(0,0,0,.4)";
      const close = document.createElement("button");
      close.textContent = "×";
      close.setAttribute("aria-label", "Cancel sign-in");
      close.style.cssText = "position:absolute;top:6px;right:8px;z-index:1;border:0;background:#eee;border-radius:50%;width:28px;height:28px;font-size:18px;cursor:pointer";
      const iframe = document.createElement("iframe");
      iframe.style.cssText = "width:100%;height:100%;border:0";
      panel.append(close, iframe);
      overlay.append(panel);
      document.body.append(overlay);
      const handle = this.createFrame(iframe, { kind: "auth", tabId: null });
      const cleanup = () => {
        this.authFlows.delete(ext.id);
        handle.destroy();
        overlay.remove();
      };
      const timeout = interactive ? null : setTimeout(() => flow.reject(new ApiError("User interaction required.")), 30000);
      const flow: AuthFlow = {
        extId: ext.id,
        resolve: (u) => {
          if (timeout) clearTimeout(timeout);
          cleanup();
          resolve(u);
        },
        reject: (err) => {
          if (timeout) clearTimeout(timeout);
          cleanup();
          reject(err);
        },
        close: cleanup,
      };
      close.onclick = () => flow.reject(new ApiError("The user did not approve access."));
      this.authFlows.set(ext.id, flow);
      handle.go(url);
    });
  }

  /** From the request hook: a navigation reached https://<id>.chromiumapp.org/. */
  completeAuthFlow(url: URL): boolean {
    const extId = url.hostname.replace(/\.chromiumapp\.org$/, "");
    const flow = this.authFlows.get(extId);
    if (!flow) return false;
    setTimeout(() => flow.resolve(url.href), 0);
    return true;
  }

  async download(ext: ExtensionState, options: { url: string; filename?: string; saveAs?: boolean; method?: string; headers?: { name: string; value: string }[]; body?: string }): Promise<number> {
    if (!options?.url) throw new ApiError("Invalid URL.");
    const id = ++this.downloadCounter;
    const item: DownloadItem = {
      id,
      url: options.url,
      finalUrl: options.url,
      filename: options.filename ?? "",
      mime: "",
      state: "in_progress",
      danger: "safe",
      paused: false,
      canResume: false,
      bytesReceived: 0,
      totalBytes: -1,
      fileSize: -1,
      startTime: new Date().toISOString(),
      exists: true,
      incognito: false,
      byExtensionId: ext.id,
      byExtensionName: ext.manifest.name,
    };
    this.downloads.push(item);
    this.registry.dispatchAll("downloads.onCreated", (ctx) => [toRealm(ctx, item)]);
    void (async () => {
      try {
        let response: Response;
        const parsed = parseExtensionUrl(options.url);
        if (parsed) response = await serveExtensionResource(this, parsed.extId, new URL(extensionUrl(parsed.extId, parsed.path)), "GET");
        else if (/^(blob|data):/i.test(options.url)) response = await fetch(options.url);
        else {
          const transport = this.controller?.transport as
            | { request(url: URL, method: string, body: BodyInit | null, headers: [string, string][], signal?: AbortSignal): Promise<{ body: BodyInit | null; headers: [string, string][]; status: number; statusText: string }> }
            | undefined;
          if (!transport) throw new Error("NETWORK_FAILED");
          const r = await transport.request(new URL(options.url), options.method ?? "GET", options.body ?? null, (options.headers ?? []).map((h) => [h.name, h.value]), undefined);
          response = new Response(r.body, { status: r.status, statusText: r.statusText, headers: r.headers });
        }
        if (!response.ok) throw new Error("SERVER_FAILED");
        const blob = await response.blob();
        const disposition = response.headers.get("content-disposition") ?? "";
        const fromHeader = disposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i)?.[1];
        const name = (options.filename || (fromHeader ? decodeURIComponent(fromHeader) : "") || new URL(options.url, location.href).pathname.split("/").pop() || "download").split("/").pop()!;
        const objectUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = objectUrl;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
        Object.assign(item, { state: "complete", filename: name, mime: blob.type, bytesReceived: blob.size, totalBytes: blob.size, fileSize: blob.size, endTime: new Date().toISOString() });
        this.registry.dispatchAll("downloads.onChanged", (ctx) => [toRealm(ctx, { id, state: { previous: "in_progress", current: "complete" }, filename: { current: name } })]);
      } catch (e) {
        const error = (e as Error).message?.match(/^[A-Z_]+$/) ? (e as Error).message : "NETWORK_FAILED";
        Object.assign(item, { state: "interrupted", error, endTime: new Date().toISOString() });
        this.registry.dispatchAll("downloads.onChanged", (ctx) => [toRealm(ctx, { id, state: { previous: "in_progress", current: "interrupted" }, error: { current: error } })]);
      }
    })();
    return id;
  }

  /** chrome.runtime for web pages matched by some extension's externally_connectable. */
  externalRuntimeFor(world: ContentWorld): Record<string, unknown> {
    const s = this;
    const contextFor = (extId: string): ExtensionContext | null => {
      const ext = s.registry.get(extId);
      if (!ext || !ext.enabled) return null;
      if (!ext.manifest.externally_connectable?.matches?.some((p) => matchPattern(p, world.url))) return null;
      let map = s.externalContexts.get(world.win);
      if (!map) {
        map = new Map();
        s.externalContexts.set(world.win, map);
      }
      let ctx = map.get(extId);
      if (!ctx || !ctx.alive) {
        ctx = s.registry.createContext({ ext, kind: "content", window: world.win, document: world.doc, tabId: world.tabId, frameId: world.frameId, documentId: world.documentId, url: world.url, world: "MAIN" });
        map.set(extId, ctx);
      }
      return ctx;
    };
    const sender = () => ({ url: world.url, origin: originOf(world.url), tab: buildTab(s, world.tabId) ?? undefined, frameId: world.frameId, documentId: world.documentId, documentLifecycle: "active" });
    const realm = world.win as Window & typeof globalThis;
    const runtime = new realm.Object() as Record<string, unknown>;
    runtime.sendMessage = (...args: unknown[]) => {
      const { target, message, cb } = normalizeSendMessageArgs(args);
      if (!target) throw new realm.TypeError("chrome.runtime.sendMessage() called from a webpage must specify an Extension ID (string) for its first argument.");
      const ctx = contextFor(target);
      if (!ctx) {
        const err = new realm.Error(`Invalid extension id: '${target}'`);
        if (cb) queueMicrotask(() => cb());
        else return realm.Promise.reject(err);
        return undefined;
      }
      const targets = s.registry.extensionContexts(target);
      const p = targets.length ? deliverMessage(targets, "runtime.onMessageExternal", message, sender()) : Promise.reject(new ApiError(NO_RECEIVER));
      return completeMessage(ctx, p, cb);
    };
    runtime.connect = (extId: string, info?: { name?: string }) => {
      const ctx = contextFor(String(extId));
      if (!ctx) throw new realm.TypeError(`Invalid extension id: '${extId}'`);
      return openPort(s.registry, ctx, s.registry.extensionContexts(ctx.ext.id), "runtime.onConnectExternal", String(info?.name ?? ""), sender());
    };
    Object.defineProperty(runtime, "lastError", {
      get: () => {
        for (const ctx of s.externalContexts.get(world.win)?.values() ?? []) {
          if (ctx.lastError) {
            ctx.lastErrorChecked = true;
            return ctx.lastError;
          }
        }
        return undefined;
      },
    });
    return runtime;
  }

  /** Ensure a content-script context exists for `ext` in `win` (debug/host tooling). */
  contentContextFor(win: Window, extId: string): ExtensionContext | null {
    const world = contentWorldOf(win);
    const ext = this.registry.get(extId);
    if (!world || !ext) return null;
    return contentContext(this, world, ext);
  }
}
