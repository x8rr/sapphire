import { EventHub } from "./eventHub";
import type { ChromeManifest, ContentScriptRegistration, DNRRule } from "./types";

export interface PortRecord {
  id: string;
  name: string;
  extId: string;
  remote: { onMessage: EventHub; onDisconnect: EventHub };
}

export interface ContextMenuItem {
  id: string;
  title: string;
  contexts: string[];
  onclick?: (info: unknown, tab: unknown) => void;
}

export interface AlarmRecord {
  name: string;
  scheduledTime: number;
  periodInMinutes?: number;
  timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>;
}

export interface BackgroundContext {
  kind: "worker" | "frame";
  worker?: Worker;
  frame?: HTMLIFrameElement;
  events: RealmEvents;
}

export interface RealmEvents {
  runtimeOnMessage: EventHub;
  runtimeOnInstalled: EventHub;
  runtimeOnStartup: EventHub;
  runtimeOnConnect: EventHub;
  tabsOnCreated: EventHub;
  tabsOnUpdated: EventHub;
  tabsOnRemoved: EventHub;
  tabsOnActivated: EventHub;
  actionOnClicked: EventHub;
  browserActionOnClicked: EventHub;
  alarmsOnAlarm: EventHub;
  contextMenusOnClicked: EventHub;
  commandsOnCommand: EventHub;
  notificationsOnClicked: EventHub;
  notificationsOnClosed: EventHub;
  notificationsOnButtonClicked: EventHub;
  cookiesOnChanged: EventHub;
  webNavigationOnCompleted: EventHub;
}

export function createRealmEvents(): RealmEvents {
  return {
    runtimeOnMessage: new EventHub(),
    runtimeOnInstalled: new EventHub(),
    runtimeOnStartup: new EventHub(),
    runtimeOnConnect: new EventHub(),
    tabsOnCreated: new EventHub(),
    tabsOnUpdated: new EventHub(),
    tabsOnRemoved: new EventHub(),
    tabsOnActivated: new EventHub(),
    actionOnClicked: new EventHub(),
    browserActionOnClicked: new EventHub(),
    alarmsOnAlarm: new EventHub(),
    contextMenusOnClicked: new EventHub(),
    commandsOnCommand: new EventHub(),
    notificationsOnClicked: new EventHub(),
    notificationsOnClosed: new EventHub(),
    notificationsOnButtonClicked: new EventHub(),
    cookiesOnChanged: new EventHub(),
    webNavigationOnCompleted: new EventHub(),
  };
}

export interface ExtensionState {
  id: string;
  manifest: ChromeManifest;
  enabled: boolean;
  installedAt: number;
  filename: string;
  messages: Record<string, { message: string }>;
  dynamicRules: DNRRule[];
  staticRules: DNRRule[];
  rulesetRules: Map<string, DNRRule[]>;
  enabledRulesetIds: Set<string>;
  badgeText: string;
  badgeColor: string | null;
  iconUrl: string | null;
  title: string | null;
  popupPage: string | null;
  background: BackgroundContext | null;
  contextMenuItems: ContextMenuItem[];
  alarms: Map<string, AlarmRecord>;
  ports: Map<string, PortRecord>;
  tabEvents: Map<number, RealmEvents>;
  popupEvents: RealmEvents | null;
}

export class SapphireRegistry {
  readonly extensions = new Map<string, ExtensionState>();
  readonly contentScripts: ContentScriptRegistration[] = [];

  createExtensionState(id: string, manifest: ChromeManifest, enabled: boolean, installedAt: number, filename: string): ExtensionState {
    const state: ExtensionState = {
      id,
      manifest,
      enabled,
      installedAt,
      filename,
      messages: {},
      dynamicRules: [],
      staticRules: [],
      rulesetRules: new Map(),
      enabledRulesetIds: new Set(),
      badgeText: "",
      badgeColor: null,
      iconUrl: null,
      title: null,
      popupPage: null,
      background: null,
      contextMenuItems: [],
      alarms: new Map(),
      ports: new Map(),
      tabEvents: new Map(),
      popupEvents: null,
    };
    this.extensions.set(id, state);
    return state;
  }

  get(id: string): ExtensionState | undefined {
    return this.extensions.get(id);
  }

  remove(id: string): void {
    const ext = this.extensions.get(id);
    if (!ext) return;
    for (const alarm of ext.alarms.values()) clearTimeout(alarm.timer);
    if (ext.background?.kind === "worker") ext.background.worker?.terminate();
    if (ext.background?.kind === "frame") ext.background.frame?.remove();
    this.extensions.delete(id);
  }

  list(): ExtensionState[] {
    return [...this.extensions.values()];
  }

  private changeListeners = new Set<() => void>();

  onChange(cb: () => void): () => void {
    this.changeListeners.add(cb);
    return () => this.changeListeners.delete(cb);
  }

  notifyChange(): void {
    for (const cb of this.changeListeners) cb();
  }

  broadcast(extId: string, pick: (events: RealmEvents) => EventHub, args: unknown[]): void {
    const ext = this.extensions.get(extId);
    if (!ext) return;
    if (ext.background) pick(ext.background.events).fire(...args);
    for (const events of ext.tabEvents.values()) pick(events).fire(...args);
  }

  broadcastTabLifecycle(pick: (events: RealmEvents) => EventHub, args: unknown[]): void {
    for (const ext of this.extensions.values()) {
      if (!ext.enabled || !ext.background) continue;
      pick(ext.background.events).fire(...args);
    }
  }
}

