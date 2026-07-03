import { withMissingMemberFallback } from "./autoStub";
import { dbDelete, dbGet, dbGetAllKeys, dbPut, EXT_STORAGE_STORE } from "./db";
import { readExtFileText, readExtFileURL } from "./fileStore";
import { createRealmEvents, type PortRecord, type RealmEvents, type SapphireRegistry } from "./registry";
import { recomputeStaticRules } from "./dnr";
import type { SapphireHostBindings, TabInfo } from "./types";
import { EventHub } from "./eventHub";
import { injectScript } from "./htmlInject";
import { chromeExtensionUrl, decodeSapphireUrl } from "./urlScheme";

let sapphireTraceCallCounter = 0;

function sapphireTraceLog(...args: unknown[]): void {
  if ((globalThis as { SAPPHIRE_TRACE?: boolean }).SAPPHIRE_TRACE) console.debug("[sapphire-trace]", ...args);
}

function traceCalls<T extends object>(obj: T, path = ""): T {
  return new Proxy(obj, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop !== "string") return value;
      const fullPath = path ? `${path}.${prop}` : prop;
      if (typeof value === "function") {
        return new Proxy(value, {
          apply(fnTarget, thisArg, args) {
            const callId = ++sapphireTraceCallCounter;
            sapphireTraceLog(`#${callId} call ${fullPath}(`, args, `)`);
            const result = Reflect.apply(fnTarget as (...a: unknown[]) => unknown, thisArg, args);
            if (result && typeof (result as Promise<unknown>).then === "function") {
              (result as Promise<unknown>).then(
                (r) => sapphireTraceLog(`#${callId} resolved ${fullPath} =>`, r),
                (e) => sapphireTraceLog(`#${callId} REJECTED ${fullPath} =>`, e),
              );
            }
            return result;
          },
          get(fnTarget, fnProp, fnReceiver) {
            const fnValue = Reflect.get(fnTarget, fnProp, fnReceiver);
            if (typeof fnProp !== "string") return fnValue;
            if (typeof fnValue === "object" && fnValue !== null) return traceCalls(fnValue, `${fullPath}.${fnProp}`);
            return fnValue;
          },
        });
      }
      if (value && typeof value === "object") return traceCalls(value as object, fullPath);
      return value;
    },
  }) as T;
}

export interface InstallChromeApiOptions {
  extId: string;
  tabId: number | null;
  isBackground: boolean;
  registry: SapphireRegistry;
  host: SapphireHostBindings;
  skipTabRegistration?: boolean;
  senderUrl?: string;
  senderFrameId?: number;
  senderDocumentId?: string;
}

function cloneForRealm<T>(realm: Window | undefined, value: T): T {
  if (!realm) return value;
  try {
    return (realm as unknown as { structuredClone: (v: T) => T }).structuredClone(value);
  } catch {
    return value;
  }
}

export function buildTabObject(host: SapphireHostBindings, tabId: number | null, realm?: Window): unknown {
  if (tabId === null) return null;
  const tab: TabInfo | null = host.getTab(tabId);
  if (!tab) return null;
  const activeId = host.getActiveTabId?.() ?? null;
  const obj = {
    id: tab.id,
    index: Math.max(0, tab.id - 1),
    windowId: tab.windowId,
    highlighted: tab.active,
    active: tab.active || tab.id === activeId,
    pinned: false,
    audible: false,
    discarded: false,
    autoDiscardable: false,
    mutedInfo: { muted: false },
    url: tab.url,
    title: tab.title,
    favIconUrl: "",
    status: "complete",
    incognito: false,
    width: 800,
    height: 600,
  };
  return cloneForRealm(realm, obj);
}

function openUrlInTab(host: SapphireHostBindings, tabId: number | null, url: string): void {
  const decoded = decodeSapphireUrl(url);
  if (decoded) {
    host.openExtensionTab?.(decoded.extId, decoded.path, tabId);
  } else {
    host.navigateTab?.(tabId, url);
  }
}

async function captureVisibleTabViaDisplayMedia(targetWin: Window | null): Promise<string | null> {
  if (!navigator.mediaDevices?.getDisplayMedia) return null;
  let stream: MediaStream | null = null;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: "browser" },
      preferCurrentTab: true,
    } as DisplayMediaStreamOptions);
    const track = stream.getVideoTracks()[0];
    if (!track) return null;
    const video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    await video.play();
    await new Promise<void>((resolve) => {
      if (video.readyState >= 2) resolve();
      else video.addEventListener("loadeddata", () => resolve(), { once: true });
    });

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0);

    const frameElement = (targetWin as unknown as { frameElement?: Element })?.frameElement;
    if (frameElement) {
      const rect = frameElement.getBoundingClientRect();
      const scaleX = video.videoWidth / window.innerWidth;
      const scaleY = video.videoHeight / window.innerHeight;
      const cropCanvas = document.createElement("canvas");
      cropCanvas.width = Math.max(1, Math.round(rect.width * scaleX));
      cropCanvas.height = Math.max(1, Math.round(rect.height * scaleY));
      const cropCtx = cropCanvas.getContext("2d");
      if (cropCtx) {
        cropCtx.drawImage(
          canvas,
          rect.left * scaleX,
          rect.top * scaleY,
          rect.width * scaleX,
          rect.height * scaleY,
          0,
          0,
          cropCanvas.width,
          cropCanvas.height,
        );
        return cropCanvas.toDataURL("image/png");
      }
    }
    return canvas.toDataURL("image/png");
  } catch (e) {
    console.warn("[sapphire] captureVisibleTab: getDisplayMedia failed or was cancelled", e);
    return null;
  } finally {
    stream?.getTracks().forEach((t) => t.stop());
  }
}

function generateDocumentId(): string {
  return typeof crypto?.randomUUID === "function" ? crypto.randomUUID().replace(/-/g, "") : Math.random().toString(36).slice(2).padEnd(32, "0");
}

function originOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "chrome-extension:" ? `chrome-extension://${parsed.hostname}` : parsed.origin;
  } catch {
    return undefined;
  }
}

function dispatchMessage(hubs: EventHub[], message: unknown, sender: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    queueMicrotask(() => dispatchMessageNow(hubs, message, sender, resolve));
  });
}

function dispatchMessageNow(hubs: EventHub[], message: unknown, sender: unknown, resolve: (v: unknown) => void): void {
    let responded = false;
    const sendResponse = (resp: unknown) => {
      sapphireTraceLog("sendResponse called with", resp, "already responded:", responded, "for", message);
      if (responded) return;
      responded = true;
      resolve(resp);
    };
    const listeners = hubs.flatMap((hub) => hub.snapshot());
    if (listeners.length === 0) {
      console.warn("[sapphire] runtime.sendMessage: no onMessage listeners registered yet for this extension", message);
    }
    let anyAsync = false;
    for (const [i, fn] of listeners.entries()) {
      sapphireTraceLog(`dispatchMessage listener #${i} invoked for`, message);
      const result = fn(message, sender, sendResponse);
      sapphireTraceLog(`dispatchMessage listener #${i} returned`, result, "responded so far:", responded);
      if (result === true) {
        anyAsync = true;
      } else if (result && typeof (result as Promise<unknown>).then === "function") {
        anyAsync = true;
        (result as Promise<unknown>).then(
          (r) => {
            sapphireTraceLog(`dispatchMessage listener #${i} thenable resolved`, r);
            sendResponse(r);
          },
          (e) => {
            sapphireTraceLog(`dispatchMessage listener #${i} thenable REJECTED`, e);
            sendResponse(undefined);
          },
        );
      } else if (!responded) {
        console.debug("[sapphire] runtime.sendMessage: a listener ran but didn't signal it would respond (returned", result, ") — treating as not handled", message);
      }
    }
    if (!anyAsync && !responded) sendResponse(undefined);
}

async function storageGet(extId: string, area: string, keys: unknown): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  const allKeys = await dbGetAllKeys(EXT_STORAGE_STORE);
  const prefix = `${extId}/${area}/`;
  const relevant = allKeys.filter((k) => typeof k === "string" && k.startsWith(prefix)) as string[];
  for (const k of relevant) {
    const shortKey = k.slice(prefix.length);
    let include = false;
    if (keys === null || keys === undefined) include = true;
    else if (typeof keys === "string") include = shortKey === keys;
    else if (Array.isArray(keys)) include = keys.includes(shortKey);
    else if (typeof keys === "object") include = shortKey in (keys as object);
    if (include) result[shortKey] = await dbGet(EXT_STORAGE_STORE, k);
  }
  if (typeof keys === "object" && keys !== null && !Array.isArray(keys)) {
    for (const [k, v] of Object.entries(keys as Record<string, unknown>)) {
      if (!(k in result)) result[k] = v;
    }
  }
  return result;
}

async function storageSet(extId: string, area: string, items: Record<string, unknown>): Promise<void> {
  for (const [key, value] of Object.entries(items)) {
    await dbPut(EXT_STORAGE_STORE, `${extId}/${area}/${key}`, value);
  }
}

async function storageRemove(extId: string, area: string, keys: string | string[]): Promise<void> {
  const arr = Array.isArray(keys) ? keys : [keys];
  for (const key of arr) {
    await dbDelete(EXT_STORAGE_STORE, `${extId}/${area}/${key}`);
  }
}

async function storageClear(extId: string, area: string): Promise<void> {
  const allKeys = await dbGetAllKeys(EXT_STORAGE_STORE);
  const prefix = `${extId}/${area}/`;
  for (const k of allKeys.filter((key) => typeof key === "string" && key.startsWith(prefix))) {
    await dbDelete(EXT_STORAGE_STORE, k);
  }
}

async function storageGetKeys(extId: string, area: string): Promise<string[]> {
  const allKeys = await dbGetAllKeys(EXT_STORAGE_STORE);
  const prefix = `${extId}/${area}/`;
  return (allKeys.filter((k) => typeof k === "string" && k.startsWith(prefix)) as string[]).map((k) => k.slice(prefix.length));
}

function makeStorageArea(extId: string, area: string, realm: Window) {
  return {
    get: (keys: unknown, cb?: (items: Record<string, unknown>) => void) => {
      const p = storageGet(extId, area, keys).then((result) => cloneForRealm(realm, result));
      if (cb) p.then(cb);
      return p;
    },
    set: (items: Record<string, unknown>, cb?: () => void) => {
      const p = storageSet(extId, area, items);
      if (cb) p.then(cb);
      return p;
    },
    remove: (keys: string | string[], cb?: () => void) => {
      const p = storageRemove(extId, area, keys);
      if (cb) p.then(cb);
      return p;
    },
    clear: (cb?: () => void) => {
      const p = storageClear(extId, area);
      if (cb) p.then(cb);
      return p;
    },
    getBytesInUse: (_keys: unknown, cb?: (n: number) => void) => {
      const result = (0);
      cb?.(result);
      return Promise.resolve(result);
    },
    getKeys: (cb?: (keys: string[]) => void) => {
      const p = storageGetKeys(extId, area);
      if (cb) p.then(cb);
      return p;
    },
  };
}

export function installChromeApi(realm: Window, opts: InstallChromeApiOptions): RealmEvents {
  const { extId, tabId, isBackground, registry, host, skipTabRegistration, senderUrl, senderFrameId, senderDocumentId } = opts;
  const ext = registry.get(extId);
  if (!ext) throw new Error(`sapphire: installChromeApi called for unknown extension ${extId}`);

  const events = createRealmEvents();
  if (isBackground) {
  } else if (tabId !== null && !skipTabRegistration) {
    ext.tabEvents.set(tabId, events);
  }

  let portIdCounter = 0;

  const runtime = {
    id: extId,
    getManifest: () => ext.manifest,
    getURL: (path?: string) => chromeExtensionUrl(extId, path == null ? "" : String(path)),
    sendMessage: (
      extIdOrMsg: unknown,
      msgOrOpts?: unknown,
      optsOrCb?: unknown,
      maybeCb?: unknown,
    ) => {
      let targetExt: string;
      let message: unknown;
      let callback: ((resp: unknown) => void) | undefined;
      if (typeof extIdOrMsg === "object") {
        message = extIdOrMsg;
        callback = msgOrOpts as typeof callback;
        targetExt = extId;
      } else if (typeof extIdOrMsg === "string" && typeof msgOrOpts === "object") {
        targetExt = extIdOrMsg;
        message = msgOrOpts;
        callback = (typeof optsOrCb === "function" ? optsOrCb : maybeCb) as typeof callback;
      } else {
        message = extIdOrMsg;
        callback = msgOrOpts as typeof callback;
        targetExt = extId;
      }
      const target = registry.get(targetExt);
      const hubs = [target?.background?.events.runtimeOnMessage, target?.popupEvents?.runtimeOnMessage].filter(
        (h): h is EventHub => h !== undefined,
      );
      if (hubs.length === 0) {
        if (callback) {
          callback(undefined);
          return undefined;
        }
        return Promise.resolve(undefined);
      }
      const sender = {
        id: extId,
        url: senderUrl,
        origin: originOf(senderUrl),
        frameId: senderFrameId,
        documentId: senderDocumentId,
        tab: tabId !== null ? buildTabObject(host, tabId, realm) : undefined,
      };
      const responsePromise = dispatchMessage(hubs, message, sender).then((resp) => cloneForRealm(realm, resp));
      if (callback) {
        void responsePromise.then(callback);
        return undefined;
      }
      return responsePromise;
    },
    onMessage: events.runtimeOnMessage.toApi(),
    onInstalled: events.runtimeOnInstalled.toApi(),
    onStartup: events.runtimeOnStartup.toApi(),
    onConnect: events.runtimeOnConnect.toApi(),
    connect: (extIdOrInfo?: unknown, maybeInfo?: unknown) => {
      const targetExt = typeof extIdOrInfo === "string" ? extIdOrInfo : extId;
      const connectInfo = (typeof extIdOrInfo === "string" ? maybeInfo : extIdOrInfo) as { name?: string } | undefined;
      const name = connectInfo?.name ?? "";
      const portId = `port_${++portIdCounter}`;

      const callerSide = { onMessage: new EventHub(), onDisconnect: new EventHub() };
      const remoteSide = { onMessage: new EventHub(), onDisconnect: new EventHub() };

      const disconnectBoth = () => {
        callerSide.onDisconnect.fire();
        remoteSide.onDisconnect.fire();
        ext.ports.delete(portId);
      };

      const sender = {
        id: extId,
        url: senderUrl,
        origin: originOf(senderUrl),
        frameId: senderFrameId,
        documentId: senderDocumentId,
        tab: tabId !== null ? buildTabObject(host, tabId, realm) : undefined,
      };

      let callerPort: typeof remotePort;
      let remotePort: {
        name: string;
        sender: typeof sender;
        postMessage: (msg: unknown) => void;
        disconnect: () => void;
        onMessage: ReturnType<EventHub["toApi"]>;
        onDisconnect: ReturnType<EventHub["toApi"]>;
      };

      callerPort = {
        name,
        sender,
        postMessage: (msg: unknown) => remoteSide.onMessage.fire(msg, remotePort),
        disconnect: disconnectBoth,
        onMessage: callerSide.onMessage.toApi(),
        onDisconnect: callerSide.onDisconnect.toApi(),
      };
      remotePort = {
        name,
        sender,
        postMessage: (msg: unknown) => callerSide.onMessage.fire(msg, callerPort),
        disconnect: disconnectBoth,
        onMessage: remoteSide.onMessage.toApi(),
        onDisconnect: remoteSide.onDisconnect.toApi(),
      };

      const record: PortRecord = { id: portId, name, extId: targetExt, remote: remoteSide };
      ext.ports.set(portId, record);

      const target = registry.get(targetExt);
      target?.background?.events.runtimeOnConnect.fire(remotePort);

      return callerPort;
    },
    lastError: null as { message: string } | null,
    getPlatformInfo: (cb?: (info: unknown) => void) => {
      const result = ({ os: "linux", arch: "x86-64", nacl_arch: "x86_64" });
      cb?.(result);
      return Promise.resolve(result);
    },
    openOptionsPage: (cb?: () => void) => {
      const page = ext.manifest.options_page ?? ext.manifest.options_ui?.page;
      if (page) host.openExtensionTab?.(extId, page, tabId);
      cb?.();
    },
    setUninstallURL: (_url?: string, cb?: () => void) => {
      cb?.();
      return Promise.resolve(undefined);
    },
    requestUpdateCheck: (cb?: (status: string, details: unknown) => void) => {
      cb?.("no_update", {});
      return Promise.resolve({ status: "no_update", details: {} });
    },
  };

  const storage = {
    local: makeStorageArea(extId, "local", realm),
    sync: makeStorageArea(extId, "sync", realm),
    session: makeStorageArea(extId, "session", realm),
    managed: makeStorageArea(extId, "managed", realm),
    onChanged: new EventHub().toApi(),
  };

  const tabs = {
    query: (queryInfo: { active?: boolean; url?: string } = {}, cb?: (tabs: unknown[]) => void) => {
      const active = host.getActiveTabId?.();
      const result = host
        .getAllTabs()
        .filter((t) => {
          if (queryInfo.active !== undefined && queryInfo.active !== (t.id === active)) return false;
          if (queryInfo.url && !t.url.includes(queryInfo.url)) return false;
          return true;
        })
        .map((t) => buildTabObject(host, t.id, realm));
      cb?.(result);
      return Promise.resolve(result);
    },
    get: (id: number, cb?: (tab: unknown) => void) => {
      const tab = buildTabObject(host, id, realm);
      cb?.(tab);
      return Promise.resolve(tab);
    },
    getCurrent: (cb?: (tab: unknown) => void) => {
      const tab = buildTabObject(host, tabId, realm);
      cb?.(tab);
      return Promise.resolve(tab);
    },
    create: (createProps: { url?: string } = {}, cb?: (tab: unknown) => void) => {
      if (createProps.url) openUrlInTab(host, null, createProps.url);
      const tab = buildTabObject(host, tabId, realm);
      cb?.(tab);
      return Promise.resolve(tab);
    },
    update: (tabIdOrProps: unknown, updatePropsOrCb?: unknown, maybeCb?: unknown) => {
      const targetTabId = typeof tabIdOrProps === "number" ? tabIdOrProps : tabId;
      const updateProps = (typeof tabIdOrProps === "number" ? updatePropsOrCb : tabIdOrProps) as { url?: string } | undefined;
      const cb = (typeof updatePropsOrCb === "function" ? updatePropsOrCb : maybeCb) as ((tab: unknown) => void) | undefined;
      if (updateProps?.url) openUrlInTab(host, targetTabId, updateProps.url);
      const tab = buildTabObject(host, targetTabId, realm);
      cb?.(tab);
      return Promise.resolve(tab);
    },
    remove: (_tabIds: number | number[], cb?: () => void) => {
      cb?.();
      return Promise.resolve(undefined);
    },
    sendMessage: (targetTabId: number, message: unknown, optsOrCb?: unknown, maybeCb?: unknown) => {
      const callback = (typeof optsOrCb === "function" ? optsOrCb : typeof maybeCb === "function" ? maybeCb : undefined) as
        | ((resp: unknown) => void)
        | undefined;
      const targetEvents = ext.tabEvents.get(targetTabId);
      if (!targetEvents) {
        if (callback) {
          callback(undefined);
          return undefined;
        }
        return Promise.resolve(undefined);
      }
      const sender = {
        id: extId,
        url: senderUrl,
        frameId: senderFrameId,
        documentId: senderDocumentId,
        tab: buildTabObject(host, tabId, realm),
      };
      const responsePromise = dispatchMessage([targetEvents.runtimeOnMessage], message, sender).then((resp) => cloneForRealm(realm, resp));
      if (callback) {
        void responsePromise.then(callback);
        return undefined;
      }
      return responsePromise;
    },
    onCreated: events.tabsOnCreated.toApi(),
    onUpdated: events.tabsOnUpdated.toApi(),
    onRemoved: events.tabsOnRemoved.toApi(),
    onActivated: events.tabsOnActivated.toApi(),
    executeScript: (tabIdOrDetails: unknown, detailsOrCb?: unknown, maybeCb?: unknown) => {
      const actualTabId = typeof tabIdOrDetails === "number" ? tabIdOrDetails : tabId;
      const details = (typeof tabIdOrDetails === "object" ? tabIdOrDetails : detailsOrCb) as { code?: string; file?: string } | undefined;
      const cb = (typeof detailsOrCb === "function" ? detailsOrCb : maybeCb) as ((r: unknown[]) => void) | undefined;
      const win = actualTabId !== null ? host.getTabWindow?.(actualTabId) : null;
      let result: unknown[] = [];
      if (win && details?.code) {
        try {
          result = [(win as unknown as { eval: (s: string) => unknown }).eval(details.code)];
        } catch {
          result = [];
        }
      }
      cb?.(result);
      return Promise.resolve(result);
    },
    insertCSS: (tabIdOrDetails: unknown, detailsOrCb?: unknown, maybeCb?: unknown) => {
      const actualTabId = typeof tabIdOrDetails === "number" ? tabIdOrDetails : tabId;
      const details = (typeof tabIdOrDetails === "object" ? tabIdOrDetails : detailsOrCb) as { code?: string } | undefined;
      const cb = (typeof detailsOrCb === "function" ? detailsOrCb : maybeCb) as (() => void) | undefined;
      const win = actualTabId !== null ? host.getTabWindow?.(actualTabId) : null;
      if (win && details?.code) injectCss(win, details.code);
      cb?.();
      return Promise.resolve(undefined);
    },
    captureVisibleTab: (windowIdOrOpts?: unknown, optsOrCb?: unknown, maybeCb?: unknown) => {
      const cb = (typeof windowIdOrOpts === "function" ? windowIdOrOpts : typeof optsOrCb === "function" ? optsOrCb : maybeCb) as
        | ((dataUrl: string | null) => void)
        | undefined;
      const targetWin = tabId !== null ? host.getTabWindow?.(tabId) ?? null : null;
      const p = captureVisibleTabViaDisplayMedia(targetWin);
      p.then(cb);
      return p;
    },
    TAB_ID_NONE: -1,
  };

  const windows = {
    getCurrent: (cb?: (w: unknown) => void) => {
      const w = { id: 1, focused: true, type: "normal", state: "normal" };
      cb?.(w);
      return Promise.resolve(w);
    },
    getAll: (cb?: (w: unknown[]) => void) => {
      const all = [{ id: 1, focused: true, type: "normal", state: "normal" }];
      cb?.(all);
      return Promise.resolve(all);
    },
    create: (createData: { url?: string } = {}, cb?: (w: unknown) => void) => {
      if (createData.url) host.navigateTab?.(null, createData.url);
      const w = { id: 1, focused: true, type: "normal", state: "normal" };
      cb?.(w);
      return Promise.resolve(w);
    },
    onFocusChanged: new EventHub().toApi(),
    WINDOW_ID_NONE: -1,
    WINDOW_ID_CURRENT: -2,
  };

  const i18n = {
    getMessage: (messageName: string, substitutions?: string | string[]) => {
      const msg = ext.messages[messageName];
      if (!msg) return "";
      let text = msg.message ?? "";
      if (substitutions) {
        const subs = Array.isArray(substitutions) ? substitutions : [substitutions];
        subs.forEach((s, i) => {
          text = text.replace(new RegExp(`\\$${i + 1}`, "g"), s);
        });
      }
      return text;
    },
    getUILanguage: () => realm.navigator.language || "en",
    detectLanguage: (_text: string, cb?: (r: unknown) => void) => {
      const result = ({ isReliable: false, languages: [] });
      cb?.(result);
      return Promise.resolve(result);
    },
    getAcceptLanguage: (cb?: (langs: string[]) => void) => {
      const result = ([realm.navigator.language || "en"]);
      cb?.(result);
      return Promise.resolve(result);
    },
  };

  const contextMenus = {
    create: (props: { id?: string; title: string; contexts?: string[] }, cb?: () => void) => {
      const id = props.id ?? Math.random().toString(36).slice(2);
      ext.contextMenuItems.push({ id, title: props.title, contexts: props.contexts ?? ["all"] });
      cb?.();
      return id;
    },
    update: (id: string, props: Partial<{ title: string; contexts: string[] }>, cb?: () => void) => {
      const item = ext.contextMenuItems.find((i) => i.id === id);
      if (item) Object.assign(item, props);
      cb?.();
    },
    remove: (id: string, cb?: () => void) => {
      const idx = ext.contextMenuItems.findIndex((i) => i.id === id);
      if (idx > -1) ext.contextMenuItems.splice(idx, 1);
      cb?.();
    },
    removeAll: (cb?: () => void) => {
      ext.contextMenuItems.length = 0;
      cb?.();
    },
    onClicked: events.contextMenusOnClicked.toApi(),
  };

  const notifications = {
    create: (idOrOptions: unknown, optionsOrCb?: unknown, maybeCb?: unknown) => {
      const notifId = typeof idOrOptions === "string" ? idOrOptions : `notif_${Date.now()}`;
      const options = (typeof idOrOptions === "string" ? optionsOrCb : idOrOptions) as { title?: string; message?: string } | undefined;
      const cb = (typeof optionsOrCb === "function" ? optionsOrCb : maybeCb) as ((id: string) => void) | undefined;
      host.showNotification?.(options?.title ?? ext.manifest.name, options?.message ?? "");
      cb?.(notifId);
      return notifId;
    },
    update: (_id: string, _options: unknown, cb?: (wasUpdated: boolean) => void) => {
      const result = (true);
      cb?.(result);
      return Promise.resolve(result);
    },
    clear: (_id: string, cb?: (wasCleared: boolean) => void) => {
      const result = (true);
      cb?.(result);
      return Promise.resolve(result);
    },
    getAll: (cb?: (all: Record<string, unknown>) => void) => {
      const result = ({});
      cb?.(result);
      return Promise.resolve(result);
    },
    onClicked: events.notificationsOnClicked.toApi(),
    onClosed: events.notificationsOnClosed.toApi(),
    onButtonClicked: events.notificationsOnButtonClicked.toApi(),
  };

  const cookies = {
    get: (details: { name: string; domain?: string }, cb?: (cookie: unknown) => void) => {
      const win = tabId !== null ? host.getTabWindow?.(tabId) : realm;
      let val: unknown = null;
      try {
        const all = win?.document?.cookie?.split(";") ?? [];
        const found = all.find((c) => c.trim().startsWith(`${details.name}=`));
        if (found) {
          const value = found.split("=").slice(1).join("=").trim();
          val = { name: details.name, value, domain: details.domain ?? "", path: "/" };
        }
      } catch {
      }
      cb?.(val);
      return val;
    },
    set: (details: { name: string; value: string; path?: string; domain?: string }, cb?: () => void) => {
      const win = tabId !== null ? host.getTabWindow?.(tabId) : realm;
      try {
        let c = `${details.name}=${details.value}`;
        if (details.path) c += `;path=${details.path}`;
        if (details.domain) c += `;domain=${details.domain}`;
        if (win) win.document.cookie = c;
      } catch {
      }
      cb?.();
    },
    getAll: (_details: unknown, cb?: (cookies: unknown[]) => void) => {
      const result: unknown[] = [];
      cb?.(result);
      return Promise.resolve(result);
    },
    remove: (_details: unknown, cb?: () => void) => {
      cb?.();
      return Promise.resolve(undefined);
    },
    onChanged: events.cookiesOnChanged.toApi(),
  };

  function mkWebRequestEvent() {
    const hub = new EventHub();
    return {
      addListener: (fn: (...a: unknown[]) => unknown, _filter?: unknown, _extraInfoSpec?: unknown) => hub.addListener(fn),
      removeListener: hub.removeListener,
      hasListener: hub.hasListener,
    };
  }
  const webRequest = {
    onBeforeRequest: mkWebRequestEvent(),
    onBeforeSendHeaders: mkWebRequestEvent(),
    onSendHeaders: mkWebRequestEvent(),
    onHeadersReceived: mkWebRequestEvent(),
    onCompleted: mkWebRequestEvent(),
    onErrorOccurred: mkWebRequestEvent(),
    onBeforeRedirect: mkWebRequestEvent(),
    handlerBehaviorChanged: (cb?: () => void) => {
      cb?.();
      return Promise.resolve(undefined);
    },
  };

  const declarativeNetRequest = {
    updateDynamicRules: (options: { addRules?: unknown[]; removeRuleIds?: number[] }, cb?: () => void) => {
      if (options.removeRuleIds) {
        ext.dynamicRules = ext.dynamicRules.filter((r) => !options.removeRuleIds!.includes(r.id));
      }
      if (options.addRules) ext.dynamicRules.push(...(options.addRules as typeof ext.dynamicRules));
      cb?.();
      return Promise.resolve(undefined);
    },
    getDynamicRules: (filterOrCb?: unknown, maybeCb?: (rules: unknown[]) => void) => {
      const filter = typeof filterOrCb === "function" ? undefined : (filterOrCb as { ruleIds?: number[] } | undefined);
      const cb = typeof filterOrCb === "function" ? (filterOrCb as (rules: unknown[]) => void) : maybeCb;
      const rules = filter?.ruleIds ? ext.dynamicRules.filter((r) => filter.ruleIds!.includes(r.id)) : ext.dynamicRules;
      cb?.(rules);
      return Promise.resolve(rules);
    },
    updateSessionRules: (_options: unknown, cb?: () => void) => {
      cb?.();
      return Promise.resolve(undefined);
    },
    getSessionRules: (filterOrCb?: unknown, maybeCb?: (rules: unknown[]) => void) => {
      const cb = typeof filterOrCb === "function" ? (filterOrCb as (rules: unknown[]) => void) : maybeCb;
      cb?.([]);
      return Promise.resolve([]);
    },
    isRegexSupported: (_opts: unknown, cb?: (r: { isSupported: boolean }) => void) => {
      const result = { isSupported: true };
      cb?.(result);
      return Promise.resolve(result);
    },
    testMatchOutcome: (_req: unknown, cb?: (r: unknown) => void) => {
      const result = { matchedRules: [] };
      cb?.(result);
      return Promise.resolve(result);
    },
    getAvailableRulesets: (cb?: (ids: string[]) => void) => {
      const ids = [...ext.rulesetRules.keys()];
      cb?.(ids);
      return Promise.resolve(ids);
    },
    getEnabledRulesets: (cb?: (ids: string[]) => void) => {
      const ids = [...ext.enabledRulesetIds];
      cb?.(ids);
      return Promise.resolve(ids);
    },
    updateEnabledRulesets: (options: { enableRulesetIds?: string[]; disableRulesetIds?: string[] }, cb?: () => void) => {
      for (const id of options.disableRulesetIds ?? []) ext.enabledRulesetIds.delete(id);
      for (const id of options.enableRulesetIds ?? []) {
        if (ext.rulesetRules.has(id)) ext.enabledRulesetIds.add(id);
      }
      recomputeStaticRules(ext);
      cb?.();
      return Promise.resolve(undefined);
    },
    MAX_NUMBER_OF_RULES: 30000,
    MAX_NUMBER_OF_DYNAMIC_RULES: 5000,
    GUARANTEED_MINIMUM_STATIC_RULES: 30000,
  };

  function injectCss(win: Window, css: string) {
    try {
      const doc = win.document;
      const style = doc.createElement("style");
      style.textContent = css;
      (doc.head || doc.documentElement).appendChild(style);
    } catch {
    }
  }

  const scripting = {
    executeScript: async (
      injection: { target?: { tabId?: number }; func?: (...a: unknown[]) => unknown; args?: unknown[]; files?: string[] },
      cb?: (results: unknown[]) => void,
    ) => {
      const targetTabId = injection.target?.tabId ?? tabId;
      const win = targetTabId !== null ? host.getTabWindow?.(targetTabId) : null;
      if (win && targetTabId !== null && !(win as unknown as { chrome?: unknown }).chrome) {
        installChromeApi(win, {
          extId,
          tabId: targetTabId,
          isBackground: false,
          registry,
          host,
          senderUrl: host.getTab(targetTabId)?.url,
          senderFrameId: 0,
          senderDocumentId: generateDocumentId(),
        });
      }
      let results: unknown[] = [];
      if (win && injection.func) {
        try {
          results = [{ result: injection.func(...(injection.args ?? [])) }];
        } catch {
          results = [];
        }
      } else if (win && injection.files?.length) {
        for (const file of injection.files) {
          const code = await readExtFileText(extId, file);
          if (code !== null) injectScript(win, code);
        }
        results = injection.files.map(() => ({ result: undefined }));
      }
      cb?.(results);
      return Promise.resolve(results);
    },
    insertCSS: (injection: { target?: { tabId?: number }; css?: string }, cb?: () => void) => {
      const targetTabId = injection.target?.tabId ?? tabId;
      const win = targetTabId !== null ? host.getTabWindow?.(targetTabId) : null;
      if (win && injection.css) injectCss(win, injection.css);
      cb?.();
      return Promise.resolve(undefined);
    },
    removeCSS: (_injection: unknown, cb?: () => void) => {
      cb?.();
      return Promise.resolve(undefined);
    },
    registerContentScripts: (
      scripts: { id: string; matches?: string[]; excludeMatches?: string[]; js?: string[]; css?: string[]; runAt?: string; allFrames?: boolean }[],
      cb?: () => void,
    ) => {
      for (const s of scripts) {
        const idx = registry.contentScripts.findIndex((cs) => cs.extId === extId && cs.id === s.id);
        const entry = {
          extId,
          id: s.id,
          matches: s.matches ?? [],
          excludeMatches: s.excludeMatches ?? [],
          js: s.js ?? [],
          css: s.css ?? [],
          runAt: (s.runAt as "document_start" | "document_end" | "document_idle" | undefined) ?? "document_idle",
          allFrames: s.allFrames ?? false,
        };
        if (idx === -1) registry.contentScripts.push(entry);
        else registry.contentScripts[idx] = entry;
      }
      cb?.();
      return Promise.resolve(undefined);
    },
    unregisterContentScripts: (filter: { ids?: string[] } | undefined, cb?: () => void) => {
      for (let i = registry.contentScripts.length - 1; i >= 0; i--) {
        const cs = registry.contentScripts[i];
        if (cs.extId !== extId || cs.id === undefined) continue;
        if (filter?.ids && !filter.ids.includes(cs.id)) continue;
        registry.contentScripts.splice(i, 1);
      }
      cb?.();
      return Promise.resolve(undefined);
    },
    getRegisteredContentScripts: (filter: { ids?: string[] } | undefined, cb?: (scripts: unknown[]) => void) => {
      const result = registry.contentScripts
        .filter((cs) => cs.extId === extId && cs.id !== undefined && (!filter?.ids || filter.ids.includes(cs.id)))
        .map((cs) => ({
          id: cs.id,
          matches: cs.matches,
          excludeMatches: cs.excludeMatches,
          js: cs.js,
          css: cs.css,
          runAt: cs.runAt,
          allFrames: cs.allFrames,
        }));
      cb?.(result);
      return Promise.resolve(result);
    },
  };

  function makeAction(clickHub: EventHub) {
    const extRef = ext!;
    return {
      setIcon: (details: { imageData?: unknown; path?: unknown }, cb?: () => void) => {
        if (details.imageData) {
          extRef.iconUrl = typeof details.imageData === "object" ? (Object.values(details.imageData as object)[0] as string) : (details.imageData as string);
          registry.notifyChange();
          cb?.();
        } else if (details.path) {
          const p = typeof details.path === "object" ? (Object.values(details.path as object)[0] as string) : (details.path as string);
          readExtFileURL(extRef.id, p).then((url) => {
            if (url) extRef.iconUrl = url;
            registry.notifyChange();
            cb?.();
          });
        } else {
          cb?.();
        }
      },
      setTitle: (details: { title: string }, cb?: () => void) => {
        extRef.title = details.title;
        registry.notifyChange();
        cb?.();
      },
      setBadgeText: (details: { text: string }, cb?: () => void) => {
        extRef.badgeText = details.text ?? "";
        registry.notifyChange();
        cb?.();
      },
      setBadgeBackgroundColor: (details: { color: string }, cb?: () => void) => {
        extRef.badgeColor = details.color;
        registry.notifyChange();
        cb?.();
      },
      getBadgeText: (_details: unknown, cb?: (text: string) => void) => {
        const result = (extRef.badgeText);
        cb?.(result);
        return Promise.resolve(result);
      },
      enable: (_tabId?: number, cb?: () => void) => {
        cb?.();
        return Promise.resolve(undefined);
      },
      disable: (_tabId?: number, cb?: () => void) => {
        cb?.();
        return Promise.resolve(undefined);
      },
      onClicked: clickHub.toApi(),
      openPopup: (_options: unknown, cb?: () => void) => {
        cb?.();
        return Promise.resolve(undefined);
      },
      setPopup: (details: { popup: string }, cb?: () => void) => {
        extRef.popupPage = details.popup;
        registry.notifyChange();
        cb?.();
      },
      getPopup: (_details: unknown, cb?: (popup: string) => void) => {
        const result = (extRef.popupPage ?? "");
        cb?.(result);
        return Promise.resolve(result);
      },
    };
  }
  const action = makeAction(events.actionOnClicked);
  const browserAction = makeAction(events.browserActionOnClicked);
  const pageAction = makeAction(events.actionOnClicked);

  const alarms = {
    create: (nameOrInfo: unknown, maybeInfo?: unknown) => {
      const name = typeof nameOrInfo === "string" ? nameOrInfo : "";
      const alarmInfo = (typeof nameOrInfo === "string" ? maybeInfo : nameOrInfo) as
        | { when?: number; delayInMinutes?: number; periodInMinutes?: number }
        | undefined;
      const existing = ext.alarms.get(name);
      if (existing) clearTimeout(existing.timer);
      const delayMs = alarmInfo?.when !== undefined ? Math.max(0, alarmInfo.when - Date.now()) : (alarmInfo?.delayInMinutes ?? 0) * 60000;
      const periodMs = alarmInfo?.periodInMinutes ? alarmInfo.periodInMinutes * 60000 : null;
      const scheduledTime = Date.now() + delayMs;
      const fire = () => registry.broadcast(extId, (e) => e.alarmsOnAlarm, [{ name, scheduledTime, periodInMinutes: alarmInfo?.periodInMinutes }]);
      const timer = periodMs
        ? setTimeout(() => {
            fire();
            ext.alarms.set(name, { name, scheduledTime, periodInMinutes: alarmInfo?.periodInMinutes, timer: setInterval(fire, periodMs) });
          }, delayMs)
        : setTimeout(fire, delayMs);
      ext.alarms.set(name, { name, scheduledTime, periodInMinutes: alarmInfo?.periodInMinutes, timer });
    },
    get: (name: string, cb?: (alarm: unknown) => void) => {
      const alarm = ext.alarms.get(name);
      cb?.(alarm ? { name, scheduledTime: alarm.scheduledTime, periodInMinutes: alarm.periodInMinutes } : null);
    },
    getAll: (cb?: (alarms: unknown[]) => void) => {
      const result = ([...ext.alarms.values()].map((a) => ({ name: a.name, scheduledTime: a.scheduledTime, periodInMinutes: a.periodInMinutes })));
      cb?.(result);
      return Promise.resolve(result);
    },
    clear: (name: string, cb?: (wasCleared: boolean) => void) => {
      const alarm = ext.alarms.get(name);
      if (alarm) clearTimeout(alarm.timer);
      const existed = ext.alarms.delete(name);
      cb?.(existed);
    },
    clearAll: (cb?: (wasCleared: boolean) => void) => {
      for (const alarm of ext.alarms.values()) clearTimeout(alarm.timer);
      ext.alarms.clear();
      cb?.(true);
    },
    onAlarm: events.alarmsOnAlarm.toApi(),
  };

  const permissions = {
    request: (_perms: unknown, cb?: (granted: boolean) => void) => {
      cb?.(true);
      return Promise.resolve(true);
    },
    contains: (_perms: unknown, cb?: (has: boolean) => void) => {
      cb?.(true);
      return Promise.resolve(true);
    },
    getAll: (cb?: (perms: unknown) => void) => {
      const result = { permissions: ext.manifest.permissions ?? [], origins: ext.manifest.host_permissions ?? [] };
      cb?.(result);
      return Promise.resolve(result);
    },
    remove: (_perms: unknown, cb?: (removed: boolean) => void) => {
      cb?.(true);
      return Promise.resolve(true);
    },
    onAdded: new EventHub().toApi(),
    onRemoved: new EventHub().toApi(),
  };

  const history = {
    search: (_query: { text?: string; maxResults?: number }, cb?: (results: unknown[]) => void) => {
      const result: unknown[] = [];
      cb?.(result);
      return Promise.resolve(result);
    },
    getVisits: (_details: unknown, cb?: (visits: unknown[]) => void) => {
      const result: unknown[] = [];
      cb?.(result);
      return Promise.resolve(result);
    },
    addUrl: (_details: unknown, cb?: () => void) => {
      cb?.();
      return Promise.resolve(undefined);
    },
    deleteUrl: (_details: unknown, cb?: () => void) => {
      cb?.();
      return Promise.resolve(undefined);
    },
    deleteAll: (cb?: () => void) => {
      cb?.();
      return Promise.resolve(undefined);
    },
    onVisited: new EventHub().toApi(),
    onVisitRemoved: new EventHub().toApi(),
  };

  const bookmarks = {
    get: (_idOrList: unknown, cb?: (nodes: unknown[]) => void) => {
      const result: unknown[] = [];
      cb?.(result);
      return Promise.resolve(result);
    },
    getTree: (cb?: (tree: unknown[]) => void) => {
      const result = ([{ id: "0", title: "Bookmarks", children: [] }]);
      cb?.(result);
      return Promise.resolve(result);
    },
    search: (_query: unknown, cb?: (nodes: unknown[]) => void) => {
      const result: unknown[] = [];
      cb?.(result);
      return Promise.resolve(result);
    },
    create: (bookmark: { url?: string; title?: string }, cb?: (node: unknown) => void) => {
      const result = ({ id: "0", ...bookmark });
      cb?.(result);
      return Promise.resolve(result);
    },
    remove: (_id: string, cb?: () => void) => {
      cb?.();
      return Promise.resolve(undefined);
    },
    onCreated: new EventHub().toApi(),
    onRemoved: new EventHub().toApi(),
    onChanged: new EventHub().toApi(),
  };

  const downloads = {
    download: (options: { url: string; filename?: string }, cb?: (id: number) => void) => {
      try {
        const doc = realm.document;
        const a = doc.createElement("a");
        a.href = options.url;
        a.download = options.filename ?? "";
        doc.body.appendChild(a);
        a.click();
        a.remove();
      } catch {
      }
      cb?.(1);
    },
    search: (_query: unknown, cb?: (items: unknown[]) => void) => {
      const result: unknown[] = [];
      cb?.(result);
      return Promise.resolve(result);
    },
    pause: (_id: number, cb?: () => void) => {
      cb?.();
      return Promise.resolve(undefined);
    },
    resume: (_id: number, cb?: () => void) => {
      cb?.();
      return Promise.resolve(undefined);
    },
    cancel: (_id: number, cb?: () => void) => {
      cb?.();
      return Promise.resolve(undefined);
    },
    onCreated: new EventHub().toApi(),
    onChanged: new EventHub().toApi(),
  };

  const identity = {
    getAuthToken: (_details: unknown, cb?: (token: string | undefined) => void) => {
      const result = (undefined);
      cb?.(result);
      return Promise.resolve(result);
    },
    launchWebAuthFlow: (_details: unknown, cb?: (url: string | undefined) => void) => {
      const result = (undefined);
      cb?.(result);
      return Promise.resolve(result);
    },
    getRedirectURL: (path?: string) => `https://sapphire.invalid/${extId}/${path ?? ""}`,
    removeCachedAuthToken: (_details: unknown, cb?: () => void) => {
      cb?.();
      return Promise.resolve(undefined);
    },
  };

  const commands = {
    getAll: (cb?: (commands: unknown[]) => void) => {
      const cmds = ext.manifest.commands ?? {};
      const list = Object.entries(cmds).map(([name, cmd]) => ({ name, description: cmd.description ?? "", shortcut: cmd.suggested_key?.default ?? "" }));
      cb?.(list);
      return Promise.resolve(list);
    },
    onCommand: events.commandsOnCommand.toApi(),
  };

  const omnibox = {
    setDefaultSuggestion: (_suggestion: unknown) => {},
    onInputStarted: new EventHub().toApi(),
    onInputChanged: new EventHub().toApi(),
    onInputEntered: new EventHub().toApi(),
    onInputCancelled: new EventHub().toApi(),
  };

  const proxy = {
    settings: {
      get: (_details: unknown, cb?: (r: unknown) => void) => {
        const result = ({ value: { mode: "direct" }, levelOfControl: "controlled_by_this_extension" });
        cb?.(result);
        return Promise.resolve(result);
      },
      set: (_details: unknown, cb?: () => void) => {
        cb?.();
        return Promise.resolve(undefined);
      },
      clear: (_details: unknown, cb?: () => void) => {
        cb?.();
        return Promise.resolve(undefined);
      },
    },
    onProxyError: new EventHub().toApi(),
  };

  const system = {
    cpu: {
      getInfo: (cb?: (i: unknown) => void) => {
        const result = { numOfProcessors: 4, "arch-name": "x86-64", modelName: "Sapphire vCPU", features: [] };
        cb?.(result);
        return Promise.resolve(result);
      },
    },
    memory: {
      getInfo: (cb?: (i: unknown) => void) => {
        const result = { capacity: 8 * 1024 * 1024 * 1024, availableCapacity: 4 * 1024 * 1024 * 1024 };
        cb?.(result);
        return Promise.resolve(result);
      },
    },
    storage: {
      getInfo: (cb?: (i: unknown[]) => void) => {
        cb?.([]);
        return Promise.resolve([]);
      },
    },
    display: {
      getInfo: (cb?: (i: unknown[]) => void) =>
        cb?.([{ id: "0", isPrimary: true, isInternal: false, isEnabled: true, bounds: { left: 0, top: 0, width: realm.screen.width, height: realm.screen.height } }]),
    },
  };

  const power = {
    requestKeepAwake: (_level?: string) => {},
    releaseKeepAwake: () => {},
  };

  const management = {
    getSelf: (cb?: (info: unknown) => void) => {
      const result = ({ id: extId, name: ext.manifest.name, version: ext.manifest.version ?? "", enabled: ext.enabled, type: "extension" });
      cb?.(result);
      return Promise.resolve(result);
    },
    getAll: (cb?: (all: unknown[]) => void) =>
      cb?.(registry.list().map((e) => ({ id: e.id, name: e.manifest.name, version: e.manifest.version ?? "", enabled: e.enabled, type: "extension" }))),
    setEnabled: (_id: string, _enabled: boolean, cb?: () => void) => {
      cb?.();
      return Promise.resolve(undefined);
    },
    uninstallSelf: (_options: unknown, cb?: () => void) => {
      cb?.();
      return Promise.resolve(undefined);
    },
    onEnabled: new EventHub().toApi(),
    onDisabled: new EventHub().toApi(),
  };

  const webNavigation = {
    getFrame: (_details: unknown, cb?: (frame: unknown) => void) => {
      const result = (null);
      cb?.(result);
      return Promise.resolve(result);
    },
    getAllFrames: (_details: unknown, cb?: (frames: unknown[]) => void) => {
      const result: unknown[] = [];
      cb?.(result);
      return Promise.resolve(result);
    },
    onBeforeNavigate: new EventHub().toApi(),
    onCommitted: new EventHub().toApi(),
    onCompleted: events.webNavigationOnCompleted.toApi(),
    onDOMContentLoaded: new EventHub().toApi(),
    onErrorOccurred: new EventHub().toApi(),
    onHistoryStateUpdated: new EventHub().toApi(),
    onReferenceFragmentUpdated: new EventHub().toApi(),
  };

  const tts = {
    speak: (utterance: string, options?: { lang?: string; rate?: number; pitch?: number; volume?: number }, cb?: () => void) => {
      try {
        const SpeechSynthesisUtteranceCtor = (realm as unknown as { SpeechSynthesisUtterance: typeof SpeechSynthesisUtterance }).SpeechSynthesisUtterance;
        const u = new SpeechSynthesisUtteranceCtor(utterance);
        if (options?.lang) u.lang = options.lang;
        if (options?.rate) u.rate = options.rate;
        if (options?.pitch) u.pitch = options.pitch;
        if (options?.volume) u.volume = options.volume;
        realm.speechSynthesis.speak(u);
      } catch {
      }
      cb?.();
    },
    stop: () => realm.speechSynthesis?.cancel(),
    isSpeaking: (cb?: (speaking: boolean) => void) => {
      const result = (realm.speechSynthesis?.speaking ?? false);
      cb?.(result);
      return Promise.resolve(result);
    },
    getVoices: (cb?: (voices: unknown[]) => void) =>
      cb?.((realm.speechSynthesis?.getVoices() ?? []).map((v) => ({ voiceName: v.name, lang: v.lang, remote: false, extensionId: "" }))),
    onEvent: new EventHub().toApi(),
  };

  const clipboard = {
    setImageData: (_imageData: unknown, _type: string, cb?: () => void) => {
      cb?.();
      return Promise.resolve(undefined);
    },
  };

  const fontSettings = {
    getFont: (_details: unknown, cb?: (font: unknown) => void) => {
      const result = ({ fontId: "Arial", levelOfControl: "controllable_by_this_extension" });
      cb?.(result);
      return Promise.resolve(result);
    },
    setFont: (_details: unknown, cb?: () => void) => {
      cb?.();
      return Promise.resolve(undefined);
    },
    clearFont: (_details: unknown, cb?: () => void) => {
      cb?.();
      return Promise.resolve(undefined);
    },
    getFontList: (cb?: (fonts: { fontId: string; displayName: string }[]) => void) => {
      const fonts = [
        "Arial",
        "Arial Black",
        "Comic Sans MS",
        "Courier New",
        "Georgia",
        "Impact",
        "Segoe UI",
        "Tahoma",
        "Times New Roman",
        "Trebuchet MS",
        "Verdana",
      ].map((fontId) => ({ fontId, displayName: fontId }));
      cb?.(fonts);
      return Promise.resolve(fonts);
    },
    onFontChanged: new EventHub().toApi(),
  };

  const extensionNs = {
    getURL: runtime.getURL,
    getBackgroundPage: () => null,
    isAllowedIncognitoAccess: (cb?: (allowed: boolean) => void) => {
      cb?.(false);
      return Promise.resolve(false);
    },
    isAllowedFileSchemeAccess: (cb?: (allowed: boolean) => void) => {
      cb?.(false);
      return Promise.resolve(false);
    },
    onMessage: runtime.onMessage,
    onMessageExternal: new EventHub().toApi(),
    sendMessage: runtime.sendMessage,
  };

  const chromeApi = {
    runtime,
    storage,
    tabs,
    windows,
    extension: extensionNs,
    i18n,
    contextMenus,
    notifications,
    cookies,
    webRequest,
    declarativeNetRequest,
    scripting,
    action,
    browserAction,
    pageAction,
    alarms,
    permissions,
    history,
    bookmarks,
    downloads,
    identity,
    commands,
    omnibox,
    contentSettings: {},
    proxy,
    system,
    power,
    management,
    webNavigation,
    tts,
    clipboard,
    fontSettings,
    app: {
      getDetails: () => null,
      isInstalled: false,
      InstallState: { DISABLED: "disabled", INSTALLED: "installed", NOT_INSTALLED: "not_installed" },
      RunningState: { CANNOT_RUN: "cannot_run", READY_TO_RUN: "ready_to_run", RUNNING: "running" },
    },
    csi: () => ({}),
    loadTimes: () => ({}),
  };

  const chromeApiWithFallback = (globalThis as { SAPPHIRE_TRACE?: boolean }).SAPPHIRE_TRACE
    ? traceCalls(withMissingMemberFallback(chromeApi))
    : withMissingMemberFallback(chromeApi);

  (realm as unknown as { chrome: unknown }).chrome = chromeApiWithFallback;
  if (!(realm as unknown as { browser?: unknown }).browser) {
    (realm as unknown as { browser: unknown }).browser = chromeApiWithFallback;
  }

  return events;
}
