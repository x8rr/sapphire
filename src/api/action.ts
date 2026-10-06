import { ApiError, asyncApi } from "../realm";
import type { ActionState, ExtensionState } from "../registry";
import type { Sapphire } from "../sapphire";
import { extensionUrl, resolvePackagePath } from "../urls";
import type { Env, Namespace } from "./env";

type Color = [number, number, number, number];

const NAMED: Record<string, Color> = {
  red: [255, 0, 0, 255],
  green: [0, 128, 0, 255],
  blue: [0, 0, 255, 255],
  black: [0, 0, 0, 255],
  white: [255, 255, 255, 255],
  transparent: [0, 0, 0, 0],
};

export function parseColor(input: unknown): Color {
  if (Array.isArray(input)) {
    const [r = 0, g = 0, b = 0, a = 255] = input.map(Number);
    return [r, g, b, a];
  }
  const s = String(input ?? "").trim().toLowerCase();
  if (NAMED[s]) return NAMED[s];
  let m = s.match(/^#([0-9a-f]{3,8})$/);
  if (m) {
    let hex = m[1];
    if (hex.length === 3 || hex.length === 4) hex = hex.split("").map((c) => c + c).join("");
    const n = (i: number) => parseInt(hex.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), hex.length === 8 ? n(6) : 255];
  }
  m = s.match(/^rgba?\(([^)]+)\)$/);
  if (m) {
    const parts = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] === undefined ? 255 : parts[3] <= 1 ? Math.round(parts[3] * 255) : parts[3]];
  }
  throw new ApiError("The color specification could not be parsed.");
}

export function colorToCss(c: Color | null): string | null {
  return c ? `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${c[3] / 255})` : null;
}

function imageDataToUrl(data: ImageData): string {
  const canvas = document.createElement("canvas");
  canvas.width = data.width;
  canvas.height = data.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  // ImageData from another realm can't be passed straight to putImageData.
  const copy = new ImageData(new Uint8ClampedArray(data.data), data.width, data.height);
  ctx.putImageData(copy, 0, 0);
  return canvas.toDataURL("image/png");
}

function pickSize<T>(dict: Record<string, T>): T | undefined {
  const sizes = Object.keys(dict).sort((a, b) => Number(b) - Number(a));
  return dict[sizes.find((k) => Number(k) <= 32) ?? sizes[sizes.length - 1]] ?? dict[sizes[0]];
}

export function effectiveAction(ext: ExtensionState, tabId: number | null): ActionState {
  const tab = tabId !== null ? ext.tabAction.get(tabId) : undefined;
  const merged: ActionState = { ...ext.defaultAction, ...(tab ?? {}) };
  if (merged.iconUrl === null) merged.iconUrl = ext.iconUrl;
  if (!merged.badgeText && ext.dnr.displayActionCountAsBadgeText && tabId !== null) {
    const count = ext.dnr.tabActionCounts.get(tabId);
    if (count) merged.badgeText = String(count);
  }
  return merged;
}

export function createAction(env: Env, kind: "action" | "browserAction" | "pageAction"): Namespace {
  const { s, ctx, ext } = env;
  const mv = Number(ext.manifest.manifest_version) || 2;
  const set = (details: { tabId?: number } | undefined, patch: Partial<ActionState>) => {
    const tabId = details?.tabId;
    if (tabId !== undefined && tabId !== null) {
      if (!s.host.getTab(tabId)) throw new ApiError(`No tab with id: ${tabId}.`);
      ext.tabAction.set(tabId, { ...(ext.tabAction.get(tabId) ?? {}), ...patch });
    } else if (kind === "pageAction") {
      throw new ApiError("pageAction requires a tabId.");
    } else {
      Object.assign(ext.defaultAction, patch);
    }
    s.registry.notifyChange();
  };
  const get = (details: { tabId?: number } | undefined) => effectiveAction(ext, details?.tabId ?? null);

  const setIcon = async (details: { imageData?: unknown; path?: unknown; tabId?: number }) => {
    let url: string | null = null;
    if (details?.imageData) {
      const data = details.imageData as ImageData | Record<string, ImageData>;
      const one = "data" in data && "width" in data ? (data as ImageData) : pickSize(data as Record<string, ImageData>);
      if (one) url = imageDataToUrl(one);
    } else if (details?.path) {
      const p = typeof details.path === "string" ? details.path : pickSize(details.path as Record<string, string>);
      if (p) {
        const resolved = resolvePackagePath(p, ctx.kind === "background" ? "" : new URL(ctx.url).pathname.replace(/^\//, ""));
        url = await ext.files.dataUrl(resolved);
        if (!url) throw new ApiError(`Failed to set icon '${p}': Not found`);
      }
    } else {
      throw new ApiError("Either the path or imageData property must be specified.");
    }
    set(details, { iconUrl: url });
  };

  const ns: Namespace = {
    setTitle: asyncApi(ctx, (d: { title: string; tabId?: number }) => set(d, { title: String(d?.title ?? "") })),
    getTitle: asyncApi(ctx, (d?: { tabId?: number }) => get(d).title),
    setIcon: asyncApi(ctx, setIcon),
    setPopup: asyncApi(ctx, (d: { popup: string; tabId?: number }) => set(d, { popup: String(d?.popup ?? "").replace(/^\/+/, "") })),
    getPopup: asyncApi(ctx, (d?: { tabId?: number }) => {
      const popup = get(d).popup;
      return popup ? extensionUrl(ext.id, popup) : "";
    }),
    onClicked: ctx.events.api(`${kind}.onClicked`),
  };
  if (kind !== "pageAction") {
    Object.assign(ns, {
      setBadgeText: asyncApi(ctx, (d: { text?: string | null; tabId?: number }) => set(d, { badgeText: d?.text == null ? "" : String(d.text) })),
      getBadgeText: asyncApi(ctx, (d?: { tabId?: number }) => get(d).badgeText),
      setBadgeBackgroundColor: asyncApi(ctx, (d: { color: unknown; tabId?: number }) => set(d, { badgeColor: parseColor(d?.color) })),
      getBadgeBackgroundColor: asyncApi(ctx, (d?: { tabId?: number }) => get(d).badgeColor ?? [66, 133, 244, 255]),
      enable: asyncApi(ctx, (tabId?: number) => set(tabId === undefined ? undefined : { tabId }, { enabled: true })),
      disable: asyncApi(ctx, (tabId?: number) => set(tabId === undefined ? undefined : { tabId }, { enabled: false })),
      openPopup: asyncApi(ctx, async (options?: { windowId?: number }) => {
        void options;
        const ok = s.openPopup(ext.id, ctx.tabId ?? s.host.getActiveTabId?.() ?? null);
        if (!ok) throw new ApiError("Could not find an active browser window.");
      }),
    });
    if (mv >= 3 && kind === "action") {
      Object.assign(ns, {
        setBadgeTextColor: asyncApi(ctx, (d: { color: unknown; tabId?: number }) => set(d, { badgeTextColor: parseColor(d?.color) })),
        getBadgeTextColor: asyncApi(ctx, (d?: { tabId?: number }) => get(d).badgeTextColor ?? [255, 255, 255, 255]),
        isEnabled: asyncApi(ctx, (tabId?: number) => get(tabId === undefined ? undefined : { tabId }).enabled),
        getUserSettings: asyncApi(ctx, () => ({ isOnToolbar: true })),
        onUserSettingsChanged: ctx.events.api("action.onUserSettingsChanged"),
      });
    }
  } else {
    Object.assign(ns, {
      show: asyncApi(ctx, (tabId: number) => set({ tabId }, { enabled: true })),
      hide: asyncApi(ctx, (tabId: number) => set({ tabId }, { enabled: false })),
    });
  }
  return ns;
}

/** Host-facing: click the toolbar button. Opens the popup if there is one, else fires onClicked. */
export function clickAction(s: Sapphire, ext: ExtensionState, tabId: number | null): "popup" | "clicked" | "disabled" {
  const state = effectiveAction(ext, tabId);
  if (!state.enabled) return "disabled";
  if (state.popup) {
    if (s.openPopup(ext.id, tabId)) return "popup";
  }
  if (ext.sidePanel.openOnActionClick && ext.sidePanel.path) {
    s.host.openSidePanel?.(ext.id, ext.sidePanel.path, tabId);
    return "clicked";
  }
  s.dispatchActionClicked(ext, tabId);
  return "clicked";
}
