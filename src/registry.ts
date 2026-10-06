import { EventTable } from "./events";
import { PackageFiles } from "./files";
import { StorageArea, type StorageAreaName } from "./storage";
import type { ChromeManifest, ContentScriptRegistration, DNRRule, ExecutionWorld, ExtensionMeta } from "./types";

export type ContextKind = "background" | "popup" | "tab" | "offscreen" | "sidepanel" | "iframe" | "content" | "devtools";

export interface PortEnd {
  /** Called when the other side goes away. */
  disconnectFromRemote(error?: string): void;
  owner: ExtensionContext;
}

export interface ExtensionContext {
  id: number;
  ext: ExtensionState;
  kind: ContextKind;
  window: Window;
  document: Document | null;
  tabId: number | null;
  frameId: number;
  documentId: string;
  url: string;
  world: ExecutionWorld;
  events: EventTable;
  alive: boolean;
  lastError: { message: string } | null;
  lastErrorChecked: boolean;
  chrome: Record<string, unknown> | null;
  ports: Set<PortEnd>;
  cleanup: (() => void)[];
}

export interface ActionState {
  title: string;
  badgeText: string;
  badgeColor: [number, number, number, number] | null;
  badgeTextColor: [number, number, number, number] | null;
  iconUrl: string | null;
  popup: string;
  enabled: boolean;
}

export interface ContextMenuItem {
  id: string;
  parentId?: string;
  title: string;
  type: "normal" | "checkbox" | "radio" | "separator";
  checked: boolean;
  contexts: string[];
  visible: boolean;
  enabled: boolean;
  documentUrlPatterns?: string[];
  targetUrlPatterns?: string[];
  onclick?: (info: unknown, tab: unknown) => void;
  onclickContext?: ExtensionContext;
}

export interface AlarmRecord {
  name: string;
  scheduledTime: number;
  periodInMinutes?: number;
  timer: ReturnType<typeof setTimeout>;
}

export interface NotificationRecord {
  id: string;
  options: Record<string, unknown>;
}

export interface FrameHandle {
  element: HTMLIFrameElement;
  go(url: string): void;
  destroy(): void;
}

export interface DnrState {
  dynamicRules: DNRRule[];
  sessionRules: DNRRule[];
  rulesets: Map<string, DNRRule[]>;
  enabledRulesets: Set<string>;
  disabledStaticRules: Map<string, Set<number>>;
  displayActionCountAsBadgeText: boolean;
  tabActionCounts: Map<number, number>;
  matchedRules: { rule: { ruleId: number; rulesetId: string }; tabId: number; timeStamp: number }[];
  version: number;
}

export interface ExtensionState {
  id: string;
  meta: ExtensionMeta;
  manifest: ChromeManifest;
  enabled: boolean;
  installedAt: number;
  filename: string;
  files: PackageFiles;
  /** locale → messages */
  locales: Map<string, Record<string, { message: string; placeholders?: Record<string, { content: string }> }>>;
  uiLocale: string;
  messages: Record<string, { message: string; placeholders?: Record<string, { content: string }> }>;
  storage: Record<StorageAreaName, StorageArea>;
  dnr: DnrState;
  defaultAction: ActionState;
  tabAction: Map<number, Partial<ActionState>>;
  iconUrl: string | null;
  contextMenuItems: Map<string, ContextMenuItem>;
  alarms: Map<string, AlarmRecord>;
  notifications: Map<string, NotificationRecord>;
  background: FrameHandle | null;
  backgroundReady: Promise<void> | null;
  offscreen: { handle: FrameHandle; url: string; reasons: string[] } | null;
  sidePanel: { path: string | null; enabled: boolean; openOnActionClick: boolean; tabOptions: Map<number, { path?: string; enabled?: boolean }> };
  grantedPermissions: Set<string>;
  grantedOrigins: Set<string>;
  omniboxDefaultSuggestion: { description: string } | null;
  userScriptWorlds: Map<string, { csp?: string; messaging?: boolean }>;
  settings: Map<string, unknown>;
}

export interface FrameRecord {
  frameId: number;
  parentFrameId: number;
  window: Window;
  url: string;
  documentId: string;
  documentLifecycle: "prerender" | "active" | "cached" | "pending_deletion";
  errorOccurred: boolean;
}

export interface TabState {
  id: number;
  url: string;
  title: string;
  status: "loading" | "complete";
  favIconUrl: string;
  nextFrameId: number;
  frames: Map<number, FrameRecord>;
  frameIds: WeakMap<Window, number>;
}

export function defaultActionFor(manifest: ChromeManifest): ActionState {
  const action = manifest.action ?? manifest.browser_action ?? manifest.page_action;
  return {
    title: action?.default_title ?? manifest.name,
    badgeText: "",
    badgeColor: null,
    badgeTextColor: null,
    iconUrl: null,
    popup: action?.default_popup ?? "",
    enabled: manifest.page_action ? false : true,
  };
}

let contextCounter = 0;

export class SapphireRegistry {
  readonly extensions = new Map<string, ExtensionState>();
  readonly contentScripts: ContentScriptRegistration[] = [];
  readonly contexts = new Set<ExtensionContext>();
  readonly tabs = new Map<number, TabState>();
  private changeListeners = new Set<() => void>();

  createExtensionState(meta: ExtensionMeta): ExtensionState {
    const manifest = meta.manifest;
    const state: ExtensionState = {
      id: meta.id,
      meta,
      manifest,
      enabled: meta.enabled !== false,
      installedAt: meta.installedAt,
      filename: meta.filename,
      files: new PackageFiles(meta.id, meta.fileList),
      locales: new Map(),
      uiLocale: "en",
      messages: {},
      storage: {
        local: new StorageArea(meta.id, "local", true),
        sync: new StorageArea(meta.id, "sync", true),
        session: new StorageArea(meta.id, "session", false),
        managed: new StorageArea(meta.id, "managed", false),
      },
      dnr: {
        dynamicRules: [],
        sessionRules: [],
        rulesets: new Map(),
        enabledRulesets: new Set(),
        disabledStaticRules: new Map(),
        displayActionCountAsBadgeText: false,
        tabActionCounts: new Map(),
        matchedRules: [],
        version: 0,
      },
      defaultAction: defaultActionFor(manifest),
      tabAction: new Map(),
      iconUrl: null,
      contextMenuItems: new Map(),
      alarms: new Map(),
      notifications: new Map(),
      background: null,
      backgroundReady: null,
      offscreen: null,
      sidePanel: {
        path: manifest.side_panel?.default_path ?? null,
        enabled: true,
        openOnActionClick: false,
        tabOptions: new Map(),
      },
      grantedPermissions: new Set(meta.grantedPermissions ?? manifest.permissions ?? []),
      grantedOrigins: new Set(meta.grantedOrigins ?? manifest.host_permissions ?? []),
      omniboxDefaultSuggestion: null,
      userScriptWorlds: new Map(),
      settings: new Map(),
    };
    this.extensions.set(meta.id, state);
    return state;
  }

  get(id: string): ExtensionState | undefined {
    return this.extensions.get(id);
  }

  remove(id: string): void {
    const ext = this.extensions.get(id);
    if (!ext) return;
    for (const alarm of ext.alarms.values()) clearTimeout(alarm.timer);
    ext.alarms.clear();
    for (const ctx of [...this.contexts]) if (ctx.ext === ext) this.destroyContext(ctx);
    this.extensions.delete(id);
  }

  list(): ExtensionState[] {
    return [...this.extensions.values()];
  }

  onChange(cb: () => void): () => void {
    this.changeListeners.add(cb);
    return () => this.changeListeners.delete(cb);
  }

  notifyChange(): void {
    for (const cb of this.changeListeners) {
      try {
        cb();
      } catch (e) {
        console.error("[sapphire] change listener threw", e);
      }
    }
  }

  // ---- contexts ----------------------------------------------------------

  createContext(init: Omit<ExtensionContext, "id" | "events" | "alive" | "lastError" | "lastErrorChecked" | "chrome" | "ports" | "cleanup">): ExtensionContext {
    const ctx: ExtensionContext = {
      ...init,
      id: ++contextCounter,
      events: new EventTable(init.ext.manifest.name),
      alive: true,
      lastError: null,
      lastErrorChecked: false,
      chrome: null,
      ports: new Set(),
      cleanup: [],
    };
    this.contexts.add(ctx);
    return ctx;
  }

  isAlive(ctx: ExtensionContext): boolean {
    if (!ctx.alive) return false;
    try {
      if (ctx.window.closed || (ctx.document && ctx.window.document !== ctx.document)) {
        this.destroyContext(ctx);
        return false;
      }
    } catch {
      this.destroyContext(ctx);
      return false;
    }
    return true;
  }

  destroyContext(ctx: ExtensionContext): void {
    if (!ctx.alive) return;
    ctx.alive = false;
    this.contexts.delete(ctx);
    for (const port of [...ctx.ports]) {
      try {
        port.disconnectFromRemote();
      } catch {
        // ignore
      }
    }
    ctx.ports.clear();
    for (const fn of ctx.cleanup) {
      try {
        fn();
      } catch {
        // ignore
      }
    }
    ctx.events.clear();
  }

  contextsOf(extId: string, pred: (ctx: ExtensionContext) => boolean = () => true): ExtensionContext[] {
    const out: ExtensionContext[] = [];
    for (const ctx of [...this.contexts]) {
      if (ctx.ext.id !== extId) continue;
      if (!this.isAlive(ctx)) continue;
      if (pred(ctx)) out.push(ctx);
    }
    return out;
  }

  /** Extension (non content-script) contexts: background, pages, popups, offscreen. */
  extensionContexts(extId: string): ExtensionContext[] {
    return this.contextsOf(extId, (c) => c.kind !== "content");
  }

  dispatch(extId: string, event: string, args: unknown[] | ((ctx: ExtensionContext) => unknown[]), includeContent = false): void {
    const ext = this.extensions.get(extId);
    if (!ext || !ext.enabled) return;
    for (const ctx of this.contextsOf(extId, (c) => includeContent || c.kind !== "content")) {
      const ev = ctx.events.peek(event);
      if (!ev?.hasListeners()) continue;
      ev.dispatch(...(typeof args === "function" ? args(ctx) : args));
    }
  }

  dispatchAll(event: string, args: unknown[] | ((ctx: ExtensionContext) => unknown[])): void {
    for (const ext of this.extensions.values()) this.dispatch(ext.id, event, args);
  }

  // ---- tabs --------------------------------------------------------------

  tab(tabId: number): TabState {
    let tab = this.tabs.get(tabId);
    if (!tab) {
      tab = {
        id: tabId,
        url: "",
        title: "",
        status: "complete",
        favIconUrl: "",
        nextFrameId: 1,
        frames: new Map(),
        frameIds: new WeakMap(),
      };
      this.tabs.set(tabId, tab);
    }
    return tab;
  }

  frameIdFor(tabId: number, win: Window, isTop: boolean): number {
    const tab = this.tab(tabId);
    if (isTop) return 0;
    let id = tab.frameIds.get(win);
    if (id === undefined) {
      id = tab.nextFrameId++;
      tab.frameIds.set(win, id);
    }
    return id;
  }

  liveFrames(tabId: number): FrameRecord[] {
    const tab = this.tabs.get(tabId);
    if (!tab) return [];
    const out: FrameRecord[] = [];
    for (const [id, frame] of tab.frames) {
      let alive = false;
      try {
        alive = !frame.window.closed && !!frame.window.document;
      } catch {
        alive = false;
      }
      if (alive) out.push(frame);
      else tab.frames.delete(id);
    }
    return out.sort((a, b) => a.frameId - b.frameId);
  }
}
