import { buildTabObject } from "./chromeApi";
import { checkDeclarativeNetRequest } from "./dnr";
import {
  getInstalledExtensions,
  installExtension as installExtensionImpl,
  loadStoredExtensions,
  setExtensionEnabled,
  uninstallExtension as uninstallExtensionImpl,
  type InstalledExtensionSummary,
} from "./extensions";
import { getNewTabOverride, mountNewTabPage, type NewTabOverride } from "./newtab";
import { getExtensionPopupPage, mountExtensionPopup } from "./popup";
import { SapphireRegistry } from "./registry";
import type { DNRDecision, SapphireHostBindings } from "./types";

export interface SapphireOptions {
  host: SapphireHostBindings;
  backgroundRoot?: HTMLElement;
}

export class Sapphire {
  readonly registry = new SapphireRegistry();
  readonly host: SapphireHostBindings;
  private readonly backgroundRoot: HTMLElement;
  private ready: Promise<number> | null = null;

  constructor(options: SapphireOptions) {
    this.host = options.host;
    this.backgroundRoot = options.backgroundRoot ?? document.body;
  }

  init(): Promise<number> {
    if (!this.ready) {
      this.ready = loadStoredExtensions(this.registry, this.host, this.backgroundRoot);
    }
    return this.ready;
  }

  async installExtension(buffer: ArrayBuffer, filename = "extension.crx"): Promise<string> {
    return installExtensionImpl(buffer, filename, this.registry, this.host, this.backgroundRoot);
  }

  async uninstallExtension(extId: string): Promise<void> {
    return uninstallExtensionImpl(extId, this.registry);
  }

  async setExtensionEnabled(extId: string, enabled: boolean): Promise<void> {
    return setExtensionEnabled(extId, enabled, this.registry, this.host, this.backgroundRoot);
  }

  getInstalledExtensions(): InstalledExtensionSummary[] {
    return getInstalledExtensions(this.registry);
  }

  getExtensionPopupPage(extId: string): string | null {
    return getExtensionPopupPage(this.registry, extId);
  }

  async mountExtensionPopup(frame: HTMLIFrameElement, extId: string, tabId: number | null): Promise<boolean> {
    return mountExtensionPopup(frame, extId, tabId, this.registry, this.host);
  }

  getNewTabOverride(): NewTabOverride | null {
    return getNewTabOverride(this.registry);
  }

  async mountNewTabPage(frame: HTMLIFrameElement, extId: string, page: string, tabId: number | null): Promise<boolean> {
    return mountNewTabPage(frame, extId, page, tabId, this.registry, this.host);
  }

  checkDeclarativeNetRequest(requestUrl: string, initiatorUrl?: string, resourceType?: string): DNRDecision | null {
    return checkDeclarativeNetRequest(this.registry, requestUrl, initiatorUrl, resourceType);
  }

  onChange(cb: () => void): () => void {
    return this.registry.onChange(cb);
  }

  triggerActionClicked(extId: string, tabId: number | null): void {
    const tab = buildTabObject(this.host, tabId);
    this.registry.broadcast(extId, (e) => e.actionOnClicked, [tab]);
    this.registry.broadcast(extId, (e) => e.browserActionOnClicked, [tab]);
  }

  notifyTabCreated(tabId: number): void {
    this.registry.broadcastTabLifecycle((e) => e.tabsOnCreated, [buildTabObject(this.host, tabId)]);
  }

  notifyTabUpdated(tabId: number, changeInfo: { status?: string; url?: string }): void {
    const tab = buildTabObject(this.host, tabId);
    this.registry.broadcastTabLifecycle((e) => e.tabsOnUpdated, [tabId, changeInfo, tab]);
  }

  notifyTabRemoved(tabId: number, windowId = 1): void {
    this.registry.broadcastTabLifecycle((e) => e.tabsOnRemoved, [tabId, { windowId, isWindowClosing: false }]);
  }

  notifyTabActivated(tabId: number, windowId = 1): void {
    this.registry.broadcastTabLifecycle((e) => e.tabsOnActivated, [{ tabId, windowId }]);
  }
}
