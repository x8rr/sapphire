import { invokeCallback, invokeCallbackWithError, toRealm } from "../realm";
import type { ContextMenuItem, ExtensionState } from "../registry";
import { matchPattern } from "../matchPatterns";
import type { Sapphire } from "../sapphire";
import { buildTab } from "../tabsModel";
import type { ContextMenuEntry } from "../types";
import type { Env, Namespace } from "./env";

export interface ContextInfo {
  contexts: string[];
  pageUrl?: string;
  frameUrl?: string;
  frameId?: number;
  linkUrl?: string;
  linkText?: string;
  srcUrl?: string;
  mediaType?: string;
  selectionText?: string;
  editable?: boolean;
}

let generatedId = 0;

export function createContextMenus(env: Env): Namespace {
  const { s, ctx, ext } = env;
  const mv = Number(ext.manifest.manifest_version) || 2;

  const withCallback = (cb: unknown, fn: () => void) => {
    try {
      fn();
      if (typeof cb === "function") queueMicrotask(() => invokeCallback(ctx, cb as () => void, []));
      return true;
    } catch (e) {
      const message = (e as Error).message;
      if (typeof cb === "function") queueMicrotask(() => invokeCallbackWithError(ctx, cb as () => void, message));
      else queueMicrotask(() => console.error(`[sapphire] ${ext.manifest.name}: Unchecked runtime.lastError: ${message}`));
      return false;
    }
  };

  const normalize = (props: Record<string, unknown>, base?: ContextMenuItem): ContextMenuItem => {
    const type = (props.type as ContextMenuItem["type"]) ?? base?.type ?? "normal";
    return {
      id: base?.id ?? String(props.id),
      parentId: props.parentId !== undefined ? String(props.parentId) : base?.parentId,
      title: props.title !== undefined ? String(props.title) : (base?.title ?? ""),
      type,
      checked: props.checked !== undefined ? !!props.checked : (base?.checked ?? false),
      contexts: (props.contexts as string[]) ?? base?.contexts ?? ["page"],
      visible: props.visible !== undefined ? !!props.visible : (base?.visible ?? true),
      enabled: props.enabled !== undefined ? !!props.enabled : (base?.enabled ?? true),
      documentUrlPatterns: (props.documentUrlPatterns as string[]) ?? base?.documentUrlPatterns,
      targetUrlPatterns: (props.targetUrlPatterns as string[]) ?? base?.targetUrlPatterns,
      onclick: typeof props.onclick === "function" ? (props.onclick as ContextMenuItem["onclick"]) : base?.onclick,
      onclickContext: typeof props.onclick === "function" ? ctx : base?.onclickContext,
    };
  };

  return {
    create: (props: Record<string, unknown> = {}, cb?: () => void) => {
      let id = props.id !== undefined ? String(props.id) : "";
      withCallback(cb, () => {
        if (!id) {
          if (mv >= 3 && ctx.kind === "background" && ext.manifest.background?.service_worker) {
            throw new Error("Extensions using event pages or Service Workers must pass an id parameter to chrome.contextMenus.create");
          }
          id = String(++generatedId);
        }
        if (ext.contextMenuItems.has(id)) throw new Error(`Cannot create item with duplicate id ${id}`);
        if (props.parentId !== undefined && !ext.contextMenuItems.has(String(props.parentId))) {
          throw new Error(`Cannot find menu item with id ${props.parentId}`);
        }
        const type = (props.type as string) ?? "normal";
        if (type !== "separator" && props.title === undefined) throw new Error("Title is required for non-separator menu items.");
        ext.contextMenuItems.set(id, normalize({ ...props, id }));
        s.registry.notifyChange();
      });
      return id;
    },
    update: (id: string | number, props: Record<string, unknown> = {}, cb?: () => void) => {
      withCallback(cb, () => {
        const item = ext.contextMenuItems.get(String(id));
        if (!item) throw new Error(`Cannot find menu item with id ${id}`);
        ext.contextMenuItems.set(item.id, normalize(props, item));
        s.registry.notifyChange();
      });
      return toRealm(ctx, undefined);
    },
    remove: (id: string | number, cb?: () => void) => {
      withCallback(cb, () => {
        const key = String(id);
        if (!ext.contextMenuItems.has(key)) throw new Error(`Cannot find menu item with id ${id}`);
        const drop = (target: string) => {
          ext.contextMenuItems.delete(target);
          for (const item of [...ext.contextMenuItems.values()]) if (item.parentId === target) drop(item.id);
        };
        drop(key);
        s.registry.notifyChange();
      });
    },
    removeAll: (cb?: () => void) => {
      withCallback(cb, () => {
        ext.contextMenuItems.clear();
        s.registry.notifyChange();
      });
    },
    onClicked: ctx.events.api("contextMenus.onClicked"),
    ACTION_MENU_TOP_LEVEL_LIMIT: 6,
    ContextType: {
      ALL: "all",
      PAGE: "page",
      FRAME: "frame",
      SELECTION: "selection",
      LINK: "link",
      EDITABLE: "editable",
      IMAGE: "image",
      VIDEO: "video",
      AUDIO: "audio",
      LAUNCHER: "launcher",
      BROWSER_ACTION: "browser_action",
      PAGE_ACTION: "page_action",
      ACTION: "action",
    },
    ItemType: { NORMAL: "normal", CHECKBOX: "checkbox", RADIO: "radio", SEPARATOR: "separator" },
  };
}

function itemApplies(item: ContextMenuItem, info: ContextInfo): boolean {
  if (!item.visible) return false;
  const contexts = item.contexts.includes("all") ? ["page", "frame", "selection", "link", "editable", "image", "video", "audio"] : item.contexts;
  if (!contexts.some((c) => info.contexts.includes(c))) return false;
  if (item.documentUrlPatterns?.length && !item.documentUrlPatterns.some((p) => matchPattern(p, info.frameUrl ?? info.pageUrl ?? ""))) return false;
  const target = info.linkUrl ?? info.srcUrl;
  if (item.targetUrlPatterns?.length && target && !item.targetUrlPatterns.some((p) => matchPattern(p, target))) return false;
  return true;
}

export function contextMenuEntries(s: Sapphire, info: ContextInfo): ContextMenuEntry[] {
  const out: ContextMenuEntry[] = [];
  for (const ext of s.registry.list()) {
    if (!ext.enabled || !ext.contextMenuItems.size) continue;
    const build = (parentId: string | undefined): ContextMenuEntry[] =>
      [...ext.contextMenuItems.values()]
        .filter((item) => item.parentId === parentId && itemApplies(item, info))
        .map((item) => ({
          extId: ext.id,
          extName: ext.manifest.name,
          id: item.id,
          title: item.title.replace(/%s/g, info.selectionText ?? ""),
          type: item.type,
          checked: item.checked,
          enabled: item.enabled,
          children: build(item.id),
        }));
    const top = build(undefined);
    // Chrome folds more than one top-level item under the extension's name.
    if (top.length > 1) {
      out.push({ extId: ext.id, extName: ext.manifest.name, id: `__sapphire_root_${ext.id}`, title: ext.manifest.name, type: "normal", checked: false, enabled: true, children: top });
    } else out.push(...top);
  }
  return out;
}

export function clickContextMenuItem(s: Sapphire, ext: ExtensionState, itemId: string, info: ContextInfo, tabId: number | null): void {
  const item = ext.contextMenuItems.get(itemId);
  if (!item || !item.enabled) return;
  const wasChecked = item.checked;
  if (item.type === "checkbox") item.checked = !item.checked;
  if (item.type === "radio") {
    for (const other of ext.contextMenuItems.values()) if (other.type === "radio" && other.parentId === item.parentId) other.checked = false;
    item.checked = true;
  }
  const clickInfo: Record<string, unknown> = {
    menuItemId: /^\d+$/.test(item.id) && !ext.manifest.background?.service_worker ? Number(item.id) : item.id,
    editable: !!info.editable,
    pageUrl: info.pageUrl,
  };
  if (item.parentId !== undefined) clickInfo.parentMenuItemId = item.parentId;
  if (info.frameUrl && info.frameUrl !== info.pageUrl) clickInfo.frameUrl = info.frameUrl;
  if (info.frameId !== undefined) clickInfo.frameId = info.frameId;
  if (info.linkUrl) clickInfo.linkUrl = info.linkUrl;
  if (info.srcUrl) clickInfo.srcUrl = info.srcUrl;
  if (info.mediaType) clickInfo.mediaType = info.mediaType;
  if (info.selectionText) clickInfo.selectionText = info.selectionText;
  if (item.type === "checkbox" || item.type === "radio") {
    clickInfo.wasChecked = wasChecked;
    clickInfo.checked = item.checked;
  }
  const tab = buildTab(s, tabId) ?? undefined;
  s.registry.dispatch(ext.id, "contextMenus.onClicked", (c) => [toRealm(c, clickInfo), toRealm(c, tab)]);
  if (item.onclick && item.onclickContext && s.registry.isAlive(item.onclickContext)) {
    const c = item.onclickContext;
    queueMicrotask(() => invokeCallback(c, item.onclick as (...a: unknown[]) => unknown, [toRealm(c, clickInfo), toRealm(c, tab)]));
  }
  s.registry.notifyChange();
}
