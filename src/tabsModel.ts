import type { Sapphire } from "./sapphire";
import type { TabInfo } from "./types";

export interface ChromeTab {
  id: number;
  index: number;
  windowId: number;
  openerTabId?: number;
  highlighted: boolean;
  active: boolean;
  selected: boolean;
  pinned: boolean;
  audible: boolean;
  discarded: boolean;
  autoDiscardable: boolean;
  frozen: boolean;
  mutedInfo: { muted: boolean };
  url: string;
  pendingUrl?: string;
  title: string;
  favIconUrl: string;
  status: "loading" | "complete" | "unloaded";
  incognito: boolean;
  width: number;
  height: number;
  groupId: number;
  lastAccessed: number;
}

/** Host TabInfo overlaid with what Sapphire observed in the tab's frames. */
export function tabInfo(s: Sapphire, tabId: number): TabInfo | null {
  const host = s.host.getTab(tabId);
  const tracked = s.registry.tabs.get(tabId);
  if (!host && !tracked) return null;
  return {
    id: tabId,
    windowId: host?.windowId ?? 1,
    url: tracked?.url || host?.url || "",
    title: tracked?.title || host?.title || "",
    active: host ? host.active || (s.host.getActiveTabId?.() ?? null) === tabId : false,
    index: host?.index,
    pinned: host?.pinned,
    favIconUrl: tracked?.favIconUrl || host?.favIconUrl,
    status: tracked?.status ?? host?.status ?? "complete",
    audible: host?.audible,
    muted: host?.muted,
    incognito: host?.incognito,
    openerTabId: host?.openerTabId,
  };
}

export function allTabInfos(s: Sapphire): TabInfo[] {
  const seen = new Set<number>();
  const out: TabInfo[] = [];
  for (const t of s.host.getAllTabs()) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    const info = tabInfo(s, t.id);
    if (info) out.push(info);
  }
  return out;
}

const lastAccessed = new Map<number, number>();

export function touchTab(tabId: number): void {
  lastAccessed.set(tabId, Date.now());
}

export function buildTab(s: Sapphire, tabId: number | null): ChromeTab | null {
  if (tabId === null || tabId < 0) return null;
  const info = tabInfo(s, tabId);
  if (!info) return null;
  const all = s.host.getAllTabs().filter((t) => (t.windowId ?? 1) === info.windowId);
  const index = info.index ?? Math.max(0, all.findIndex((t) => t.id === tabId));
  let width = 800;
  let height = 600;
  try {
    const win = s.host.getTabWindow?.(tabId);
    if (win) {
      width = win.innerWidth || width;
      height = win.innerHeight || height;
    }
  } catch {
    // cross-origin
  }
  const url = info.url;
  return {
    id: tabId,
    index,
    windowId: info.windowId,
    ...(info.openerTabId !== undefined ? { openerTabId: info.openerTabId } : {}),
    highlighted: info.active,
    active: info.active,
    selected: info.active,
    pinned: info.pinned ?? false,
    audible: info.audible ?? false,
    discarded: false,
    autoDiscardable: true,
    frozen: false,
    mutedInfo: { muted: info.muted ?? false },
    url,
    title: info.title || url,
    favIconUrl: info.favIconUrl ?? "",
    status: info.status ?? "complete",
    incognito: info.incognito ?? false,
    width,
    height,
    groupId: -1,
    lastAccessed: lastAccessed.get(tabId) ?? Date.now(),
  };
}

export function buildWindow(s: Sapphire, windowId: number, populate: boolean) {
  const tabs = allTabInfos(s).filter((t) => t.windowId === windowId);
  const win: Record<string, unknown> = {
    id: windowId,
    focused: true,
    top: 0,
    left: 0,
    width: globalThis.innerWidth || 1280,
    height: globalThis.innerHeight || 800,
    incognito: false,
    type: "normal",
    state: document.fullscreenElement ? "fullscreen" : "normal",
    alwaysOnTop: false,
    sessionId: undefined,
  };
  if (populate) win.tabs = tabs.map((t) => buildTab(s, t.id)).filter(Boolean);
  return win;
}

export function windowIds(s: Sapphire): number[] {
  const ids = new Set<number>();
  for (const t of s.host.getAllTabs()) ids.add(t.windowId ?? 1);
  if (!ids.size) ids.add(1);
  return [...ids].sort((a, b) => a - b);
}

export function currentWindowId(s: Sapphire, tabId: number | null): number {
  if (tabId !== null) {
    const t = s.host.getTab(tabId);
    if (t) return t.windowId ?? 1;
  }
  const active = s.host.getActiveTabId?.();
  if (active != null) return s.host.getTab(active)?.windowId ?? 1;
  return windowIds(s)[0];
}
