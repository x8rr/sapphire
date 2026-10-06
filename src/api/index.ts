import { withMissingMemberFallback } from "../autoStub";
import type { ExtensionContext } from "../registry";
import type { Sapphire } from "../sapphire";
import { createAction } from "./action";
import { createAlarms } from "./alarms";
import { createContextMenus } from "./contextMenus";
import { createCookies } from "./cookies";
import { createDeclarativeNetRequest } from "./dnr";
import type { Env, Namespace } from "./env";
import { createI18n } from "./i18n";
import {
  createBookmarks,
  createBrowsingData,
  createCommands,
  createContentSettings,
  createDeclarativeContent,
  createDom,
  createDownloads,
  createFontSettings,
  createHistory,
  createIdentity,
  createIdle,
  createInstanceId,
  createManagement,
  createManagementSelf,
  createOffscreen,
  createOmnibox,
  createPower,
  createPrivacy,
  createProxy,
  createReadingList,
  createSearch,
  createSessions,
  createSidePanel,
  createSystem,
  createTabGroups,
  createTopSites,
  createTts,
  createUnsupported,
} from "./misc";
import { createNotifications } from "./notifications";
import { createPermissions } from "./permissions";
import { createExtensionNamespace, createRuntime, createUserScriptRuntime } from "./runtime";
import { createScripting, createUserScripts } from "./scripting";
import { createStorage } from "./storage";
import { createTabs, createWindows } from "./tabs";
import { createWebNavigation } from "./webNavigation";
import { createWebRequest } from "./webRequest";

type Builder = (env: Env) => Namespace;

/** Namespaces gated by a single permission. */
const PERMISSION_NAMESPACES: [string, string | string[], Builder][] = [
  ["storage", "storage", (env) => createStorage(env, false)],
  ["alarms", "alarms", createAlarms],
  ["contextMenus", "contextMenus", createContextMenus],
  ["notifications", "notifications", createNotifications],
  ["cookies", "cookies", createCookies],
  ["webRequest", "webRequest", createWebRequest],
  ["webNavigation", "webNavigation", createWebNavigation],
  ["declarativeNetRequest", ["declarativeNetRequest", "declarativeNetRequestWithHostAccess", "declarativeNetRequestFeedback"], createDeclarativeNetRequest],
  ["declarativeContent", "declarativeContent", createDeclarativeContent],
  ["userScripts", "userScripts", createUserScripts],
  ["history", "history", createHistory],
  ["bookmarks", "bookmarks", createBookmarks],
  ["topSites", "topSites", createTopSites],
  ["sessions", "sessions", createSessions],
  ["downloads", "downloads", createDownloads],
  ["identity", "identity", createIdentity],
  ["idle", "idle", createIdle],
  ["tts", "tts", createTts],
  ["fontSettings", "fontSettings", createFontSettings],
  ["privacy", "privacy", createPrivacy],
  ["proxy", "proxy", createProxy],
  ["contentSettings", "contentSettings", createContentSettings],
  ["search", "search", createSearch],
  ["sidePanel", "sidePanel", createSidePanel],
  ["offscreen", "offscreen", createOffscreen],
  ["tabGroups", "tabGroups", createTabGroups],
  ["browsingData", "browsingData", createBrowsingData],
  ["readingList", "readingList", createReadingList],
  ["power", "power", () => createPower()],
  ["management", "management", createManagement],
  ["instanceID", ["gcm", "instanceID"], createInstanceId],
  ["gcm", "gcm", (env) => createUnsupported(env, "gcm", ["register", "unregister", "send"], ["onMessage", "onMessagesDeleted", "onSendError"])],
  ["debugger", "debugger", (env) => createUnsupported(env, "debugger", ["attach", "detach", "sendCommand", "getTargets"], ["onEvent", "onDetach"])],
  ["pageCapture", "pageCapture", (env) => createUnsupported(env, "pageCapture", ["saveAsMHTML"])],
  ["desktopCapture", "desktopCapture", (env) => ({ ...createUnsupported(env, "desktopCapture", ["chooseDesktopMedia"]), cancelChooseDesktopMedia: () => {} })],
  ["tabCapture", "tabCapture", (env) => createUnsupported(env, "tabCapture", ["capture", "getCapturedTabs", "getMediaStreamId"], ["onStatusChanged"])],
  ["ttsEngine", "ttsEngine", (env) => createUnsupported(env, "ttsEngine", ["updateVoices", "updateLanguage", "sendTtsEvent", "sendTtsAudio"], ["onSpeak", "onStop", "onPause", "onResume"])],
];

function has(ctx: ExtensionContext, permission: string | string[]): boolean {
  const list = Array.isArray(permission) ? permission : [permission];
  return list.some((p) => ctx.ext.grantedPermissions.has(p));
}

function nativeChromeExtras(win: Window): Namespace {
  const out: Namespace = {};
  try {
    const native = (win as unknown as { chrome?: Record<string, unknown> }).chrome;
    if (native && typeof native === "object") {
      for (const key of ["app", "csi", "loadTimes"]) if (key in native) out[key] = native[key];
    }
  } catch {
    // ignore
  }
  return out;
}

function buildNamespaces(s: Sapphire, ctx: ExtensionContext): Namespace {
  const env: Env = { s, ctx, ext: ctx.ext };
  const manifest = ctx.ext.manifest;
  const mv = Number(manifest.manifest_version) || 2;

  if (ctx.kind === "content") {
    if (ctx.world === "USER_SCRIPT") return { runtime: createUserScriptRuntime(env) };
    const runtime = createRuntime(env, true);
    const api: Namespace = {
      runtime,
      i18n: createI18n(env),
      extension: createExtensionNamespace(env, runtime, true),
      dom: createDom(env),
    };
    if (has(ctx, "storage")) api.storage = createStorage(env, true);
    return api;
  }

  const runtime = createRuntime(env, false);
  const api: Namespace = {
    ...nativeChromeExtras(ctx.window),
    runtime,
    extension: createExtensionNamespace(env, runtime, false),
    i18n: createI18n(env),
    tabs: createTabs(env),
    windows: createWindows(env),
    permissions: createPermissions(env),
    management: createManagementSelf(env),
    commands: createCommands(env),
    dom: createDom(env),
  };
  if (mv >= 3 && manifest.action) api.action = createAction(env, "action");
  if (mv < 3 && manifest.browser_action) api.browserAction = createAction(env, "browserAction");
  if (mv < 3 && manifest.page_action) api.pageAction = createAction(env, "pageAction");
  if (manifest.omnibox) api.omnibox = createOmnibox(env);
  if (mv >= 3 ? has(ctx, "scripting") : has(ctx, "scripting")) api.scripting = createScripting(env);
  for (const [name, permission, build] of PERMISSION_NAMESPACES) {
    if (!has(ctx, permission)) continue;
    try {
      api[name] = build(env);
    } catch (e) {
      console.error(`[sapphire] failed to build chrome.${name}`, e);
    }
  }
  const system: Namespace = {};
  for (const part of ["cpu", "memory", "storage", "display"] as const) {
    if (has(ctx, `system.${part}`)) system[part] = createSystem(env, part);
  }
  if (Object.keys(system).length) api.system = system;
  // Anything the manifest asks for that isn't implemented still exists, so
  // feature checks pass and calls fail softly instead of throwing TypeError.
  for (const permission of ctx.ext.grantedPermissions) {
    const name = permission.split(".")[0];
    if (!/^[a-zA-Z]+$/.test(name) || name in api || NON_NAMESPACE_PERMISSIONS.has(name)) continue;
    api[name] = withMissingMemberFallback({});
  }
  return api;
}

const NON_NAMESPACE_PERMISSIONS = new Set([
  "activeTab",
  "background",
  "clipboardRead",
  "clipboardWrite",
  "geolocation",
  "tabs",
  "unlimitedStorage",
  "webRequestBlocking",
  "webRequestAuthProvider",
  "declarativeNetRequestFeedback",
  "declarativeNetRequestWithHostAccess",
  "nativeMessaging",
  "system",
  "favicon",
  "sidePanel",
  "offscreen",
]);

export function buildChromeApi(s: Sapphire, ctx: ExtensionContext): Record<string, unknown> {
  const realm = ctx.window as Window & typeof globalThis;
  const api = buildNamespaces(s, ctx);
  let target: Record<string, unknown>;
  try {
    target = new realm.Object() as Record<string, unknown>;
  } catch {
    target = {};
  }
  for (const [key, value] of Object.entries(api)) {
    Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
  }
  return target;
}

/** After permissions.request, namespaces for newly granted permissions appear in live contexts. */
export function refreshChromeApi(s: Sapphire, ctx: ExtensionContext): void {
  if (!ctx.chrome) return;
  const fresh = buildNamespaces(s, ctx);
  for (const [key, value] of Object.entries(fresh)) {
    if (!(key in ctx.chrome)) Object.defineProperty(ctx.chrome, key, { value, writable: true, enumerable: true, configurable: true });
  }
}
