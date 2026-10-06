import { ApiError, asyncApi, invokeCallback, toRealm } from "../realm";
import type { BookmarkNode, HistoryItem } from "../browserData";
import type { ExtensionState } from "../registry";
import type { Sapphire } from "../sapphire";
import { extensionUrl, parseExtensionUrl } from "../urls";
import { buildTab } from "../tabsModel";
import { closedShadowRoot } from "../frames";
import { resolveCreateUrl } from "./tabs";
import { declaredPermissions } from "./permissions";
import type { Env, Namespace } from "./env";

// ---- management ---------------------------------------------------------------

export function extensionInfo(s: Sapphire, ext: ExtensionState) {
  const { permissions, origins } = declaredPermissions(ext);
  const icons = Object.entries(ext.manifest.icons ?? {}).map(([size, path]) => ({ size: Number(size), url: extensionUrl(ext.id, path) }));
  const options = ext.manifest.options_ui?.page ?? ext.manifest.options_page;
  void s;
  return {
    id: ext.id,
    name: ext.manifest.name,
    shortName: ext.manifest.short_name ?? ext.manifest.name,
    description: ext.manifest.description ?? "",
    version: ext.manifest.version ?? "",
    ...(ext.manifest.version_name ? { versionName: ext.manifest.version_name } : {}),
    mayDisable: true,
    mayEnable: true,
    enabled: ext.enabled,
    ...(ext.enabled ? {} : { disabledReason: "unknown" }),
    isApp: false,
    type: "extension",
    homepageUrl: typeof ext.manifest.homepage_url === "string" ? ext.manifest.homepage_url : "",
    updateUrl: "",
    offlineEnabled: false,
    optionsUrl: options ? extensionUrl(ext.id, options) : "",
    icons,
    permissions: permissions.filter((p) => ext.grantedPermissions.has(p)),
    hostPermissions: origins,
    installType: "normal",
  };
}

export function createManagement(env: Env): Namespace {
  const { s, ctx, ext } = env;
  const require = (id: string) => {
    const target = s.registry.get(id);
    if (!target) throw new ApiError(`Failed to find extension with id ${id}.`);
    return target;
  };
  return {
    getSelf: asyncApi(ctx, () => extensionInfo(s, ext)),
    get: asyncApi(ctx, (id: string) => extensionInfo(s, require(id))),
    getAll: asyncApi(ctx, () => s.registry.list().map((e) => extensionInfo(s, e))),
    setEnabled: asyncApi(ctx, async (id: string, enabled: boolean) => {
      require(id);
      if (id === ext.id) throw new ApiError("Cannot change the enabled state of the calling extension.");
      await s.setExtensionEnabled(id, !!enabled);
    }),
    uninstall: asyncApi(ctx, async (id: string) => {
      require(id);
      await s.uninstallExtension(id);
    }),
    uninstallSelf: asyncApi(ctx, async () => {
      await s.uninstallExtension(ext.id);
    }),
    getPermissionWarningsById: asyncApi(ctx, () => []),
    getPermissionWarningsByManifest: asyncApi(ctx, () => []),
    launchApp: asyncApi(ctx, () => {
      throw new ApiError("Apps are not supported.");
    }),
    createAppShortcut: asyncApi(ctx, () => {
      throw new ApiError("Apps are not supported.");
    }),
    setLaunchType: asyncApi(ctx, () => undefined),
    generateAppForLink: asyncApi(ctx, () => {
      throw new ApiError("Apps are not supported.");
    }),
    onInstalled: ctx.events.api("management.onInstalled"),
    onUninstalled: ctx.events.api("management.onUninstalled"),
    onEnabled: ctx.events.api("management.onEnabled"),
    onDisabled: ctx.events.api("management.onDisabled"),
    ExtensionType: { EXTENSION: "extension", HOSTED_APP: "hosted_app", PACKAGED_APP: "packaged_app", LEGACY_PACKAGED_APP: "legacy_packaged_app", THEME: "theme", LOGIN_SCREEN_EXTENSION: "login_screen_extension" },
    ExtensionInstallType: { ADMIN: "admin", DEVELOPMENT: "development", NORMAL: "normal", SIDELOAD: "sideload", OTHER: "other" },
    ExtensionDisabledReason: { UNKNOWN: "unknown", PERMISSIONS_INCREASE: "permissions_increase" },
    LaunchType: { OPEN_AS_REGULAR_TAB: "OPEN_AS_REGULAR_TAB", OPEN_AS_PINNED_TAB: "OPEN_AS_PINNED_TAB", OPEN_AS_WINDOW: "OPEN_AS_WINDOW", OPEN_FULL_SCREEN: "OPEN_FULL_SCREEN" },
  };
}

/** Content-free subset every extension context has even without "management". */
export function createManagementSelf(env: Env): Namespace {
  const full = createManagement(env);
  return {
    getSelf: full.getSelf,
    uninstallSelf: full.uninstallSelf,
    getPermissionWarningsByManifest: full.getPermissionWarningsByManifest,
    ExtensionType: full.ExtensionType,
    ExtensionInstallType: full.ExtensionInstallType,
    ExtensionDisabledReason: full.ExtensionDisabledReason,
    LaunchType: full.LaunchType,
  };
}

// ---- commands / omnibox -----------------------------------------------------

export function commandShortcut(ext: ExtensionState, name: string): string {
  const key = ext.manifest.commands?.[name]?.suggested_key;
  if (!key) return "";
  const mac = /mac/i.test(navigator.platform);
  const raw = (mac ? key.mac : /cros/i.test(navigator.userAgent) ? key.chromeos : /linux/i.test(navigator.platform) ? key.linux : key.windows) ?? key.default ?? "";
  return raw.replace(/\bCommand\b/g, "⌘").replace(/\bMacCtrl\b/g, "Ctrl");
}

export function createCommands(env: Env): Namespace {
  const { ctx, ext } = env;
  return {
    getAll: asyncApi(ctx, () =>
      Object.entries(ext.manifest.commands ?? {}).map(([name, cmd]) => ({
        name,
        description: cmd.description ?? (name === "_execute_action" || name === "_execute_browser_action" || name === "_execute_page_action" ? "" : ""),
        shortcut: commandShortcut(ext, name),
      })),
    ),
    onCommand: ctx.events.api("commands.onCommand"),
  };
}

export function createOmnibox(env: Env): Namespace {
  const { ctx, ext } = env;
  return {
    setDefaultSuggestion: asyncApi(ctx, (suggestion: { description: string }) => {
      ext.omniboxDefaultSuggestion = { description: String(suggestion?.description ?? "") };
    }),
    onInputStarted: ctx.events.api("omnibox.onInputStarted"),
    onInputChanged: ctx.events.api("omnibox.onInputChanged"),
    onInputEntered: ctx.events.api("omnibox.onInputEntered"),
    onInputCancelled: ctx.events.api("omnibox.onInputCancelled"),
    onDeleteSuggestion: ctx.events.api("omnibox.onDeleteSuggestion"),
    OnInputEnteredDisposition: { CURRENT_TAB: "currentTab", NEW_FOREGROUND_TAB: "newForegroundTab", NEW_BACKGROUND_TAB: "newBackgroundTab" },
    DescriptionStyleType: { URL: "url", MATCH: "match", DIM: "dim" },
  };
}

// ---- identity -----------------------------------------------------------------

export function createIdentity(env: Env): Namespace {
  const { s, ctx, ext } = env;
  return {
    getRedirectURL: (path?: string) => `https://${ext.id}.chromiumapp.org/${String(path ?? "").replace(/^\/+/, "")}`,
    launchWebAuthFlow: asyncApi(ctx, (details: { url: string; interactive?: boolean }) => s.launchWebAuthFlow(ext, details?.url, !!details?.interactive)),
    getAuthToken: asyncApi(ctx, () => {
      throw new ApiError("OAuth2 not granted or revoked.");
    }),
    removeCachedAuthToken: asyncApi(ctx, () => undefined),
    clearAllCachedAuthTokens: asyncApi(ctx, () => undefined),
    getProfileUserInfo: asyncApi(ctx, () => ({ email: "", id: "" })),
    getAccounts: asyncApi(ctx, () => []),
    onSignInChanged: ctx.events.api("identity.onSignInChanged"),
    AccountStatus: { SYNC: "SYNC", ANY: "ANY" },
  };
}

// ---- idle / power / system / tts ---------------------------------------------

export function createIdle(env: Env): Namespace {
  const { s, ctx, ext } = env;
  return {
    queryState: asyncApi(ctx, (interval: number) => s.idleState(Number(interval) || 60)),
    setDetectionInterval: (interval: number) => {
      ext.settings.set("idle.interval", Math.max(15, Number(interval) || 60));
    },
    getAutoLockDelay: asyncApi(ctx, () => 0),
    onStateChanged: ctx.events.api("idle.onStateChanged"),
    IdleState: { ACTIVE: "active", IDLE: "idle", LOCKED: "locked" },
  };
}

export function createPower(): Namespace {
  return {
    requestKeepAwake: () => {},
    releaseKeepAwake: () => {},
    reportActivity: () => Promise.resolve(),
    Level: { SYSTEM: "system", DISPLAY: "display" },
  };
}

export function createSystem(env: Env, which: "cpu" | "memory" | "storage" | "display"): Namespace {
  const { ctx } = env;
  if (which === "cpu") {
    return {
      getInfo: asyncApi(ctx, () => ({
        numOfProcessors: navigator.hardwareConcurrency || 4,
        archName: /arm/i.test(navigator.userAgent) ? "arm64" : "x86_64",
        modelName: "",
        features: [],
        processors: Array.from({ length: navigator.hardwareConcurrency || 4 }, () => ({ usage: { user: 0, kernel: 0, idle: 0, total: 0 } })),
        temperatures: [],
      })),
    };
  }
  if (which === "memory") {
    const gb = ((navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8) * 1024 ** 3;
    return { getInfo: asyncApi(ctx, () => ({ capacity: gb, availableCapacity: Math.round(gb / 2) })) };
  }
  if (which === "storage") {
    return {
      getInfo: asyncApi(ctx, () => []),
      ejectDevice: asyncApi(ctx, () => "no_such_device"),
      getAvailableCapacity: asyncApi(ctx, () => ({ id: "", availableCapacity: 0 })),
      onAttached: ctx.events.api("system.storage.onAttached"),
      onDetached: ctx.events.api("system.storage.onDetached"),
    };
  }
  return {
    getInfo: asyncApi(ctx, () => [
      {
        id: "0",
        name: "Display",
        isPrimary: true,
        isInternal: false,
        isEnabled: true,
        isUnified: false,
        dpiX: 96 * devicePixelRatio,
        dpiY: 96 * devicePixelRatio,
        rotation: 0,
        bounds: { left: 0, top: 0, width: screen.width, height: screen.height },
        workArea: { left: 0, top: 0, width: screen.availWidth, height: screen.availHeight },
        overscan: { left: 0, top: 0, right: 0, bottom: 0 },
        modes: [],
        hasTouchSupport: navigator.maxTouchPoints > 0,
        availableDisplayZoomFactors: [1],
        displayZoomFactor: 1,
      },
    ]),
    getDisplayLayout: asyncApi(ctx, () => []),
    onDisplayChanged: ctx.events.api("system.display.onDisplayChanged"),
  };
}

export function createTts(env: Env): Namespace {
  const { ctx } = env;
  const synth = typeof speechSynthesis !== "undefined" ? speechSynthesis : null;
  return {
    speak: asyncApi(ctx, (utterance: string, options: Record<string, unknown> = {}) => {
      if (!synth) throw new ApiError("Text-to-speech is not available.");
      if (!options.enqueue) synth.cancel();
      const u = new SpeechSynthesisUtterance(String(utterance ?? ""));
      if (options.lang) u.lang = String(options.lang);
      if (options.rate !== undefined) u.rate = Number(options.rate);
      if (options.pitch !== undefined) u.pitch = Number(options.pitch);
      if (options.volume !== undefined) u.volume = Number(options.volume);
      if (options.voiceName) {
        const voice = synth.getVoices().find((v) => v.name === options.voiceName);
        if (voice) u.voice = voice;
      }
      const onEvent = typeof options.onEvent === "function" ? (options.onEvent as (e: unknown) => void) : null;
      const emit = (type: string, extra: Record<string, unknown> = {}) => {
        const event = { type, charIndex: 0, ...extra };
        if (onEvent) invokeCallback(ctx, onEvent, [toRealm(ctx, event)]);
        ctx.events.peek("tts.onEvent")?.dispatch(toRealm(ctx, event));
      };
      u.onstart = () => emit("start");
      u.onend = () => emit("end", { charIndex: String(utterance ?? "").length });
      u.onerror = (e) => emit(e.error === "interrupted" || e.error === "canceled" ? "interrupted" : "error", { errorMessage: e.error });
      u.onboundary = (e) => emit(e.name === "sentence" ? "sentence" : "word", { charIndex: e.charIndex, length: e.charLength });
      synth.speak(u);
    }),
    stop: () => synth?.cancel(),
    pause: () => synth?.pause(),
    resume: () => synth?.resume(),
    isSpeaking: asyncApi(ctx, () => !!synth?.speaking),
    getVoices: asyncApi(ctx, () =>
      (synth?.getVoices() ?? []).map((v) => ({ voiceName: v.name, lang: v.lang, remote: !v.localService, extensionId: "", eventTypes: ["start", "end", "word", "sentence", "error", "interrupted"] })),
    ),
    onEvent: ctx.events.api("tts.onEvent"),
    onVoicesChanged: ctx.events.api("tts.onVoicesChanged"),
    EventType: Object.fromEntries(["start", "end", "word", "sentence", "marker", "interrupted", "cancelled", "error", "pause", "resume"].map((t) => [t.toUpperCase(), t])),
    VoiceGender: { MALE: "male", FEMALE: "female" },
  };
}

// ---- settings-style namespaces ------------------------------------------------

function chromeSetting(env: Env, key: string, defaultValue: unknown): Namespace {
  const { s, ctx, ext } = env;
  const eventName = `setting.${key}.onChange`;
  return {
    get: asyncApi(ctx, () => {
      const override = s.settings.get(key);
      const controlled = override && override.extId === ext.id;
      return {
        value: override ? override.value : defaultValue,
        levelOfControl: override ? (controlled ? "controlled_by_this_extension" : "controlled_by_other_extensions") : "controllable_by_this_extension",
      };
    }),
    set: asyncApi(ctx, (details: { value: unknown; scope?: string }) => {
      s.settings.set(key, { extId: ext.id, value: details?.value });
      s.registry.dispatchAll(eventName, [{ value: details?.value, levelOfControl: "controlled_by_this_extension" }]);
    }),
    clear: asyncApi(ctx, () => {
      if (s.settings.get(key)?.extId === ext.id) s.settings.delete(key);
      s.registry.dispatchAll(eventName, [{ value: defaultValue, levelOfControl: "controllable_by_this_extension" }]);
    }),
    onChange: ctx.events.api(eventName),
  };
}

export function createPrivacy(env: Env): Namespace {
  const setting = (k: string, v: unknown) => chromeSetting(env, `privacy.${k}`, v);
  return {
    network: {
      networkPredictionEnabled: setting("network.networkPredictionEnabled", true),
      webRTCIPHandlingPolicy: setting("network.webRTCIPHandlingPolicy", "default"),
    },
    services: {
      alternateErrorPagesEnabled: setting("services.alternateErrorPagesEnabled", true),
      autofillAddressEnabled: setting("services.autofillAddressEnabled", true),
      autofillCreditCardEnabled: setting("services.autofillCreditCardEnabled", true),
      passwordSavingEnabled: setting("services.passwordSavingEnabled", true),
      safeBrowsingEnabled: setting("services.safeBrowsingEnabled", true),
      safeBrowsingExtendedReportingEnabled: setting("services.safeBrowsingExtendedReportingEnabled", false),
      searchSuggestEnabled: setting("services.searchSuggestEnabled", true),
      spellingServiceEnabled: setting("services.spellingServiceEnabled", false),
      translationServiceEnabled: setting("services.translationServiceEnabled", true),
    },
    websites: {
      doNotTrackEnabled: setting("websites.doNotTrackEnabled", false),
      hyperlinkAuditingEnabled: setting("websites.hyperlinkAuditingEnabled", true),
      protectedContentEnabled: setting("websites.protectedContentEnabled", true),
      referrersEnabled: setting("websites.referrersEnabled", true),
      thirdPartyCookiesAllowed: setting("websites.thirdPartyCookiesAllowed", true),
      topicsEnabled: setting("websites.topicsEnabled", false),
      fledgeEnabled: setting("websites.fledgeEnabled", false),
      adMeasurementEnabled: setting("websites.adMeasurementEnabled", false),
      relatedWebsiteSetsEnabled: setting("websites.relatedWebsiteSetsEnabled", false),
    },
    IPHandlingPolicy: { DEFAULT: "default", DEFAULT_PUBLIC_AND_PRIVATE_INTERFACES: "default_public_and_private_interfaces", DEFAULT_PUBLIC_INTERFACE_ONLY: "default_public_interface_only", DISABLE_NON_PROXIED_UDP: "disable_non_proxied_udp" },
  };
}

export function createProxy(env: Env): Namespace {
  return {
    settings: chromeSetting(env, "proxy.settings", { mode: "system" }),
    onProxyError: env.ctx.events.api("proxy.onProxyError"),
    Mode: { DIRECT: "direct", AUTO_DETECT: "auto_detect", PAC_SCRIPT: "pac_script", FIXED_SERVERS: "fixed_servers", SYSTEM: "system" },
    Scheme: { HTTP: "http", HTTPS: "https", QUIC: "quic", SOCKS4: "socks4", SOCKS5: "socks5" },
  };
}

export function createContentSettings(env: Env): Namespace {
  const { s, ctx } = env;
  const types: Record<string, string> = {
    cookies: "allow",
    images: "allow",
    javascript: "allow",
    location: "ask",
    popups: "block",
    notifications: "ask",
    microphone: "ask",
    camera: "ask",
    automaticDownloads: "ask",
    clipboard: "ask",
    sound: "allow",
    autoVerify: "allow",
    unsandboxedPlugins: "block",
    plugins: "block",
  };
  const ns: Namespace = {
    ContentSetting: {},
    CookiesContentSetting: { ALLOW: "allow", BLOCK: "block", SESSION_ONLY: "session_only" },
    Scope: { REGULAR: "regular", INCOGNITO_SESSION_ONLY: "incognito_session_only" },
  };
  for (const [type, def] of Object.entries(types)) {
    const key = `contentSettings.${type}`;
    ns[type] = {
      get: asyncApi(ctx, (details: { primaryUrl: string }) => {
        const rules = (s.settings.get(key)?.value as { pattern: string; setting: string }[] | undefined) ?? [];
        const match = rules.find((r) => {
          try {
            return new RegExp(`^${r.pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`).test(details?.primaryUrl ?? "") || r.pattern === "<all_urls>";
          } catch {
            return false;
          }
        });
        return { setting: match?.setting ?? def };
      }),
      set: asyncApi(ctx, (details: { primaryPattern: string; setting: string }) => {
        const rules = ((s.settings.get(key)?.value as { pattern: string; setting: string }[] | undefined) ?? []).filter((r) => r.pattern !== details.primaryPattern);
        rules.unshift({ pattern: details.primaryPattern, setting: details.setting });
        s.settings.set(key, { extId: env.ext.id, value: rules });
      }),
      clear: asyncApi(ctx, () => {
        s.settings.delete(key);
      }),
      getResourceIdentifiers: asyncApi(ctx, () => undefined),
    };
  }
  return ns;
}

export function createFontSettings(env: Env): Namespace {
  const { ctx } = env;
  const fonts = ["Arial", "Arial Black", "Comic Sans MS", "Courier New", "Georgia", "Impact", "Segoe UI", "Tahoma", "Times New Roman", "Trebuchet MS", "Verdana", "Roboto", "Noto Sans"];
  const sizeSetting = (name: string, def: number) => ({
    [`get${name}`]: asyncApi(ctx, () => ({ pixelSize: env.s.settings.get(`font.${name}`)?.value ?? def, levelOfControl: "controllable_by_this_extension" })),
    [`set${name}`]: asyncApi(ctx, (d: { pixelSize: number }) => {
      env.s.settings.set(`font.${name}`, { extId: env.ext.id, value: d?.pixelSize });
    }),
    [`clear${name}`]: asyncApi(ctx, () => {
      env.s.settings.delete(`font.${name}`);
    }),
  });
  return {
    getFont: asyncApi(ctx, (d: { genericFamily: string }) => ({
      fontId: (env.s.settings.get(`font.${d?.genericFamily}`)?.value as string) ?? (d?.genericFamily === "fixed" ? "Courier New" : d?.genericFamily === "sansserif" ? "Arial" : "Times New Roman"),
      levelOfControl: "controllable_by_this_extension",
    })),
    setFont: asyncApi(ctx, (d: { genericFamily: string; fontId: string }) => {
      env.s.settings.set(`font.${d?.genericFamily}`, { extId: env.ext.id, value: d?.fontId });
    }),
    clearFont: asyncApi(ctx, (d: { genericFamily: string }) => {
      env.s.settings.delete(`font.${d?.genericFamily}`);
    }),
    getFontList: asyncApi(ctx, () => fonts.map((fontId) => ({ fontId, displayName: fontId }))),
    ...sizeSetting("DefaultFontSize", 16),
    ...sizeSetting("DefaultFixedFontSize", 13),
    ...sizeSetting("MinimumFontSize", 0),
    onFontChanged: ctx.events.api("fontSettings.onFontChanged"),
    onDefaultFontSizeChanged: ctx.events.api("fontSettings.onDefaultFontSizeChanged"),
    onDefaultFixedFontSizeChanged: ctx.events.api("fontSettings.onDefaultFixedFontSizeChanged"),
    onMinimumFontSizeChanged: ctx.events.api("fontSettings.onMinimumFontSizeChanged"),
    GenericFamily: { STANDARD: "standard", SANSSERIF: "sansserif", SERIF: "serif", FIXED: "fixed", CURSIVE: "cursive", FANTASY: "fantasy", MATH: "math" },
    ScriptCode: {},
  };
}

// ---- history / bookmarks / topSites / sessions / search ------------------------

function historyResult(h: HistoryItem) {
  return { id: h.id, url: h.url, title: h.title, lastVisitTime: h.lastVisitTime, visitCount: h.visitCount, typedCount: h.typedCount };
}

export function createHistory(env: Env): Namespace {
  const { s, ctx } = env;
  const data = s.browserData;
  return {
    search: asyncApi(ctx, async (query: { text?: string; startTime?: number; endTime?: number; maxResults?: number }) => {
      await data.load();
      const text = String(query?.text ?? "").toLowerCase();
      const start = query?.startTime ?? Date.now() - 24 * 3600 * 1000;
      const end = query?.endTime ?? Infinity;
      const words = text.split(/\s+/).filter(Boolean);
      return data.history
        .filter((h) => h.lastVisitTime >= start && h.lastVisitTime <= end)
        .filter((h) => words.every((w) => h.url.toLowerCase().includes(w) || h.title.toLowerCase().includes(w)))
        .slice(0, query?.maxResults === 0 ? undefined : (query?.maxResults ?? 100))
        .map(historyResult);
    }),
    getVisits: asyncApi(ctx, async (details: { url: string }) => {
      await data.load();
      const h = data.history.find((x) => x.url === details?.url);
      return (h?.visits ?? []).map((v) => ({ id: h!.id, ...v, isLocal: true }));
    }),
    addUrl: asyncApi(ctx, async (details: { url: string; title?: string; transition?: string; visitTime?: number }) => {
      await data.load();
      const { item } = data.recordVisit(details.url, details.title ?? "", details.transition ?? "link");
      s.registry.dispatchAll("history.onVisited", [historyResult(item)]);
    }),
    deleteUrl: asyncApi(ctx, async (details: { url: string }) => {
      await data.load();
      data.history = data.history.filter((h) => h.url !== details?.url);
      data.save();
      s.registry.dispatchAll("history.onVisitRemoved", [{ allHistory: false, urls: [details?.url] }]);
    }),
    deleteRange: asyncApi(ctx, async (range: { startTime: number; endTime: number }) => {
      await data.load();
      const removed = data.history.filter((h) => h.lastVisitTime >= range.startTime && h.lastVisitTime <= range.endTime).map((h) => h.url);
      data.history = data.history.filter((h) => !removed.includes(h.url));
      data.save();
      s.registry.dispatchAll("history.onVisitRemoved", [{ allHistory: false, urls: removed }]);
    }),
    deleteAll: asyncApi(ctx, async () => {
      await data.load();
      data.history = [];
      data.save();
      s.registry.dispatchAll("history.onVisitRemoved", [{ allHistory: true, urls: [] }]);
    }),
    onVisited: ctx.events.api("history.onVisited"),
    onVisitRemoved: ctx.events.api("history.onVisitRemoved"),
    TransitionType: Object.fromEntries(
      ["link", "typed", "auto_bookmark", "auto_subframe", "manual_subframe", "generated", "auto_toplevel", "form_submit", "reload", "keyword", "keyword_generated"].map((t) => [t.toUpperCase(), t]),
    ),
  };
}

function strip(node: BookmarkNode, deep: boolean): BookmarkNode {
  const { children, ...rest } = node;
  if (node.url !== undefined) return rest;
  return { ...rest, ...(deep ? { children: (children ?? []).map((c) => strip(c, true)) } : {}) };
}

export function createBookmarks(env: Env): Namespace {
  const { s, ctx } = env;
  const data = s.browserData;
  const need = (id: string) => {
    const node = data.findBookmark(String(id));
    if (!node) throw new ApiError("Can't find bookmark for id.");
    return node;
  };
  const parentOf = (node: BookmarkNode) => (node.parentId ? data.findBookmark(node.parentId) : null);
  const emit = (event: string, args: unknown[]) => s.registry.dispatchAll(`bookmarks.${event}`, args);
  return {
    get: asyncApi(ctx, async (ids: string | string[]) => {
      await data.load();
      return (Array.isArray(ids) ? ids : [ids]).map((id) => strip(need(id), false));
    }),
    getChildren: asyncApi(ctx, async (id: string) => {
      await data.load();
      return (need(id).children ?? []).map((c) => strip(c, false));
    }),
    getRecent: asyncApi(ctx, async (n: number) => {
      await data.load();
      const all: BookmarkNode[] = [];
      data.walkBookmarks((node) => {
        if (node.url) all.push(node);
      });
      return all.sort((a, b) => b.dateAdded - a.dateAdded).slice(0, n).map((c) => strip(c, false));
    }),
    getTree: asyncApi(ctx, async () => {
      await data.load();
      return [strip(data.bookmarks, true)];
    }),
    getSubTree: asyncApi(ctx, async (id: string) => {
      await data.load();
      return [strip(need(id), true)];
    }),
    search: asyncApi(ctx, async (query: string | { query?: string; url?: string; title?: string }) => {
      await data.load();
      const q = typeof query === "string" ? { query } : (query ?? {});
      const words = String(q.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const out: BookmarkNode[] = [];
      data.walkBookmarks((node) => {
        if (node.id === "0") return;
        if (q.url !== undefined && node.url !== q.url) return;
        if (q.title !== undefined && node.title !== q.title) return;
        if (words.length && !words.every((w) => node.title.toLowerCase().includes(w) || (node.url ?? "").toLowerCase().includes(w))) return;
        out.push(strip(node, false));
      });
      return out;
    }),
    create: asyncApi(ctx, async (props: { parentId?: string; index?: number; title?: string; url?: string }) => {
      await data.load();
      const parent = need(props?.parentId ?? "2");
      if (parent.url !== undefined) throw new ApiError("Parameter 'parentId' does not specify a folder.");
      const node: BookmarkNode = { id: data.id(), parentId: parent.id, title: props?.title ?? "", dateAdded: Date.now(), syncing: false };
      if (props?.url !== undefined) node.url = props.url;
      else node.children = [];
      parent.children ??= [];
      parent.children.splice(props?.index ?? parent.children.length, 0, node);
      data.reindex(parent);
      data.save();
      emit("onCreated", [node.id, strip(node, false)]);
      return strip(node, false);
    }),
    move: asyncApi(ctx, async (id: string, dest: { parentId?: string; index?: number }) => {
      await data.load();
      const node = need(id);
      const oldParent = parentOf(node)!;
      const oldIndex = node.index ?? 0;
      const newParent = need(dest?.parentId ?? oldParent.id);
      oldParent.children = (oldParent.children ?? []).filter((c) => c !== node);
      newParent.children ??= [];
      newParent.children.splice(Math.min(dest?.index ?? newParent.children.length, newParent.children.length), 0, node);
      node.parentId = newParent.id;
      data.reindex(oldParent);
      data.reindex(newParent);
      data.save();
      emit("onMoved", [node.id, { parentId: newParent.id, index: node.index, oldParentId: oldParent.id, oldIndex }]);
      return strip(node, false);
    }),
    update: asyncApi(ctx, async (id: string, changes: { title?: string; url?: string }) => {
      await data.load();
      const node = need(id);
      if (changes?.title !== undefined) node.title = changes.title;
      if (changes?.url !== undefined && node.url !== undefined) node.url = changes.url;
      data.save();
      emit("onChanged", [node.id, { title: node.title, ...(node.url !== undefined ? { url: node.url } : {}) }]);
      return strip(node, false);
    }),
    remove: asyncApi(ctx, async (id: string) => {
      await data.load();
      const node = need(id);
      if (node.children?.length) throw new ApiError("Can't remove non-empty folder (use recursive to force).");
      const parent = parentOf(node);
      if (!parent || ["0", "1", "2"].includes(node.id)) throw new ApiError("Can't modify the root bookmark folders.");
      parent.children = (parent.children ?? []).filter((c) => c !== node);
      data.reindex(parent);
      data.save();
      emit("onRemoved", [node.id, { parentId: parent.id, index: node.index, node: strip(node, true) }]);
    }),
    removeTree: asyncApi(ctx, async (id: string) => {
      await data.load();
      const node = need(id);
      const parent = parentOf(node);
      if (!parent || ["0", "1", "2"].includes(node.id)) throw new ApiError("Can't modify the root bookmark folders.");
      parent.children = (parent.children ?? []).filter((c) => c !== node);
      data.reindex(parent);
      data.save();
      emit("onRemoved", [node.id, { parentId: parent.id, index: node.index, node: strip(node, true) }]);
    }),
    onCreated: ctx.events.api("bookmarks.onCreated"),
    onRemoved: ctx.events.api("bookmarks.onRemoved"),
    onChanged: ctx.events.api("bookmarks.onChanged"),
    onMoved: ctx.events.api("bookmarks.onMoved"),
    onChildrenReordered: ctx.events.api("bookmarks.onChildrenReordered"),
    onImportBegan: ctx.events.api("bookmarks.onImportBegan"),
    onImportEnded: ctx.events.api("bookmarks.onImportEnded"),
    MAX_WRITE_OPERATIONS_PER_HOUR: 1000000,
    MAX_SUSTAINED_WRITE_OPERATIONS_PER_MINUTE: 1000000,
    BookmarkTreeNodeUnmodifiable: { MANAGED: "managed" },
    FolderType: { BOOKMARKS_BAR: "bookmarks-bar", OTHER: "other", MOBILE: "mobile", MANAGED: "managed" },
  };
}

export function createTopSites(env: Env): Namespace {
  const { s, ctx } = env;
  return {
    get: asyncApi(ctx, async () => {
      await s.browserData.load();
      return [...s.browserData.history]
        .sort((a, b) => b.visitCount - a.visitCount)
        .slice(0, 10)
        .map((h) => ({ url: h.url, title: h.title }));
    }),
  };
}

export function createSessions(env: Env): Namespace {
  const { s, ctx } = env;
  return {
    getRecentlyClosed: asyncApi(ctx, (filter?: { maxResults?: number }) =>
      s.browserData.closedTabs.slice(0, filter?.maxResults ?? 25).map((t) => ({
        lastModified: Math.floor(t.lastModified / 1000),
        tab: { sessionId: t.sessionId, url: t.url, title: t.title, index: 0, windowId: 1, active: false, pinned: false, highlighted: false, incognito: false, selected: false, discarded: false, autoDiscardable: true, groupId: -1 },
      })),
    ),
    getDevices: asyncApi(ctx, () => []),
    restore: asyncApi(ctx, async (sessionId?: string) => {
      const list = s.browserData.closedTabs;
      const idx = sessionId ? list.findIndex((t) => t.sessionId === sessionId) : 0;
      if (idx < 0 || !list[idx]) throw new ApiError(`Invalid session id: "${sessionId}".`);
      const [entry] = list.splice(idx, 1);
      const id = await s.openTab(entry.url, { active: true });
      return { lastModified: Math.floor(Date.now() / 1000), tab: buildTab(s, id) ?? undefined };
    }),
    setTabValue: asyncApi(ctx, (tabId: number, key: string, value: string) => {
      env.ext.settings.set(`session.tab.${tabId}.${key}`, value);
    }),
    getTabValue: asyncApi(ctx, (tabId: number, key: string) => env.ext.settings.get(`session.tab.${tabId}.${key}`)),
    removeTabValue: asyncApi(ctx, (tabId: number, key: string) => {
      env.ext.settings.delete(`session.tab.${tabId}.${key}`);
    }),
    setWindowValue: asyncApi(ctx, () => undefined),
    getWindowValue: asyncApi(ctx, () => undefined),
    removeWindowValue: asyncApi(ctx, () => undefined),
    onChanged: ctx.events.api("sessions.onChanged"),
    MAX_SESSION_RESULTS: 25,
  };
}

export function createSearch(env: Env): Namespace {
  const { s, ctx } = env;
  return {
    query: asyncApi(ctx, (info: { text: string; disposition?: string; tabId?: number }) => {
      const disposition = info?.disposition ?? (info?.tabId !== undefined ? "CURRENT_TAB" : "NEW_TAB");
      const tabId = info?.tabId ?? (disposition === "CURRENT_TAB" ? (s.host.getActiveTabId?.() ?? null) : null);
      if (s.host.search) s.host.search(String(info?.text ?? ""), tabId, disposition);
      else {
        const url = `https://www.google.com/search?q=${encodeURIComponent(String(info?.text ?? ""))}`;
        if (tabId !== null && disposition === "CURRENT_TAB") s.navigate(tabId, url);
        else void s.openTab(url, { active: true });
      }
    }),
    Disposition: { CURRENT_TAB: "CURRENT_TAB", NEW_TAB: "NEW_TAB", NEW_WINDOW: "NEW_WINDOW" },
  };
}

// ---- sidePanel / offscreen / tabGroups ------------------------------------------

export function createSidePanel(env: Env): Namespace {
  const { s, ctx, ext } = env;
  const sp = ext.sidePanel;
  return {
    setOptions: asyncApi(ctx, (options: { tabId?: number; path?: string; enabled?: boolean }) => {
      if (options?.tabId !== undefined) {
        sp.tabOptions.set(options.tabId, { ...(sp.tabOptions.get(options.tabId) ?? {}), ...(options.path !== undefined ? { path: options.path } : {}), ...(options.enabled !== undefined ? { enabled: options.enabled } : {}) });
      } else {
        if (options?.path !== undefined) sp.path = options.path;
        if (options?.enabled !== undefined) sp.enabled = options.enabled;
      }
      s.registry.notifyChange();
    }),
    getOptions: asyncApi(ctx, (options?: { tabId?: number }) => {
      const tab = options?.tabId !== undefined ? sp.tabOptions.get(options.tabId) : undefined;
      return { enabled: tab?.enabled ?? sp.enabled, ...((tab?.path ?? sp.path) ? { path: tab?.path ?? sp.path } : {}) };
    }),
    setPanelBehavior: asyncApi(ctx, (behavior: { openPanelOnActionClick?: boolean }) => {
      if (behavior?.openPanelOnActionClick !== undefined) sp.openOnActionClick = behavior.openPanelOnActionClick;
    }),
    getPanelBehavior: asyncApi(ctx, () => ({ openPanelOnActionClick: sp.openOnActionClick })),
    open: asyncApi(ctx, (options: { tabId?: number; windowId?: number }) => {
      const tabId = options?.tabId ?? ctx.tabId ?? s.host.getActiveTabId?.() ?? null;
      const tabOpts = tabId !== null ? sp.tabOptions.get(tabId) : undefined;
      const path = tabOpts?.path ?? sp.path;
      if (!path || (tabOpts?.enabled ?? sp.enabled) === false) throw new ApiError("No active side panel for tabId.");
      if (!s.host.openSidePanel) throw new ApiError("Side panels are not supported by this browser.");
      s.host.openSidePanel(ext.id, path, tabId);
      s.registry.dispatch(ext.id, "sidePanel.onOpened", [{ path, windowId: 1, ...(tabId !== null ? { tabId } : {}) }]);
    }),
    close: asyncApi(ctx, () => undefined),
    getLayout: asyncApi(ctx, () => ({ side: "right" })),
    onOpened: ctx.events.api("sidePanel.onOpened"),
    onClosed: ctx.events.api("sidePanel.onClosed"),
    Side: { LEFT: "left", RIGHT: "right" },
  };
}

export function createOffscreen(env: Env): Namespace {
  const { s, ctx, ext } = env;
  return {
    createDocument: asyncApi(ctx, async (params: { url: string; reasons: string[]; justification: string }) => {
      if (ext.offscreen) throw new ApiError("Only a single offscreen document may be created.");
      if (!params?.url) throw new ApiError("Offscreen document URL is required.");
      const parsed = parseExtensionUrl(resolveCreateUrl(env, params.url));
      if (!parsed || parsed.extId !== ext.id) throw new ApiError("Offscreen documents must be extension URLs.");
      await s.createOffscreen(ext, parsed.path + parsed.search, params.reasons ?? []);
    }),
    closeDocument: asyncApi(ctx, () => {
      if (!ext.offscreen) throw new ApiError("No current offscreen document.");
      s.closeOffscreen(ext);
    }),
    hasDocument: asyncApi(ctx, () => !!ext.offscreen),
    Reason: Object.fromEntries(
      ["TESTING", "AUDIO_PLAYBACK", "IFRAME_SCRIPTING", "DOM_SCRAPING", "BLOBS", "DOM_PARSER", "USER_MEDIA", "DISPLAY_MEDIA", "WEB_RTC", "CLIPBOARD", "LOCAL_STORAGE", "WORKERS", "BATTERY_STATUS", "MATCH_MEDIA", "GEOLOCATION"].map((r) => [r, r]),
    ),
  };
}

export function createTabGroups(env: Env): Namespace {
  const { ctx } = env;
  return {
    get: asyncApi(ctx, (id: number) => {
      throw new ApiError(`No group with id: ${id}.`);
    }),
    query: asyncApi(ctx, () => []),
    update: asyncApi(ctx, (id: number) => {
      throw new ApiError(`No group with id: ${id}.`);
    }),
    move: asyncApi(ctx, (id: number) => {
      throw new ApiError(`No group with id: ${id}.`);
    }),
    onCreated: ctx.events.api("tabGroups.onCreated"),
    onUpdated: ctx.events.api("tabGroups.onUpdated"),
    onMoved: ctx.events.api("tabGroups.onMoved"),
    onRemoved: ctx.events.api("tabGroups.onRemoved"),
    TAB_GROUP_ID_NONE: -1,
    Color: Object.fromEntries(["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"].map((c) => [c.toUpperCase(), c])),
  };
}

// ---- declarativeContent -------------------------------------------------------

export function createDeclarativeContent(env: Env): Namespace {
  const { ctx } = env;
  const ctor = (instanceType: string) =>
    function (this: Record<string, unknown>, options?: Record<string, unknown>) {
      Object.assign(this, options ?? {});
      this.instanceType = `declarativeContent.${instanceType}`;
    };
  return {
    onPageChanged: ctx.events.api("declarativeContent.onPageChanged"),
    PageStateMatcher: ctor("PageStateMatcher"),
    ShowAction: ctor("ShowAction"),
    ShowPageAction: ctor("ShowPageAction"),
    SetIcon: ctor("SetIcon"),
    RequestContentScript: ctor("RequestContentScript"),
    PageStateMatcherInstanceType: { DECLARATIVE_CONTENT_PAGE_STATE_MATCHER: "declarativeContent.PageStateMatcher" },
    ShowActionInstanceType: { DECLARATIVE_CONTENT_SHOW_ACTION: "declarativeContent.ShowAction" },
    ShowPageActionInstanceType: { DECLARATIVE_CONTENT_SHOW_PAGE_ACTION: "declarativeContent.ShowPageAction" },
    SetIconInstanceType: { DECLARATIVE_CONTENT_SET_ICON: "declarativeContent.SetIcon" },
    RequestContentScriptInstanceType: { DECLARATIVE_CONTENT_REQUEST_CONTENT_SCRIPT: "declarativeContent.RequestContentScript" },
  };
}

// ---- dom / browsingData / misc stubs ------------------------------------------

export function createDom(env: Env): Namespace {
  void env;
  return {
    openOrClosedShadowRoot: (element: Element) => {
      if (!element || typeof element !== "object") return null;
      return (element as Element).shadowRoot ?? closedShadowRoot(element) ?? null;
    },
  };
}

export function createBrowsingData(env: Env): Namespace {
  const { s, ctx } = env;
  const clearCookies = async () => {
    const controller = s.controller as { cookieJar: { clear(): void }; persistCookies(): Promise<void>; propagateCookieSync(c: unknown[], o: unknown): Promise<void> } | null;
    if (!controller) return;
    controller.cookieJar.clear();
    await controller.persistCookies();
    await controller.propagateCookieSync([], { clear: true }).catch(() => {});
  };
  const clearHistory = async () => {
    await s.browserData.load();
    s.browserData.history = [];
    s.browserData.save();
  };
  const remove = async (_options: unknown, types: Record<string, boolean>) => {
    if (types?.cookies) await clearCookies();
    if (types?.history) await clearHistory();
  };
  const single = (fn: () => Promise<void>) => asyncApi(ctx, fn);
  return {
    remove: asyncApi(ctx, remove),
    removeCookies: single(clearCookies),
    removeHistory: single(clearHistory),
    removeAppcache: single(async () => {}),
    removeCache: single(async () => {}),
    removeCacheStorage: single(async () => {}),
    removeDownloads: single(async () => {}),
    removeFileSystems: single(async () => {}),
    removeFormData: single(async () => {}),
    removeIndexedDB: single(async () => {}),
    removeLocalStorage: single(async () => {}),
    removePasswords: single(async () => {}),
    removeServiceWorkers: single(async () => {}),
    removeWebSQL: single(async () => {}),
    settings: asyncApi(ctx, () => ({ options: { since: 0 }, dataToRemove: {}, dataRemovalPermitted: { cookies: true, history: true } })),
  };
}

export function createDownloads(env: Env): Namespace {
  const { s, ctx, ext } = env;
  return {
    download: asyncApi(ctx, (options: { url: string; filename?: string; saveAs?: boolean; method?: string; headers?: { name: string; value: string }[]; body?: string }) =>
      s.download(ext, options),
    ),
    search: asyncApi(ctx, (query: { id?: number } = {}) => s.downloads.filter((d) => query?.id === undefined || d.id === query.id)),
    pause: asyncApi(ctx, () => undefined),
    resume: asyncApi(ctx, () => undefined),
    cancel: asyncApi(ctx, () => undefined),
    erase: asyncApi(ctx, (query: { id?: number } = {}) => {
      const removed = s.downloads.filter((d) => query?.id === undefined || d.id === query.id).map((d) => d.id);
      s.downloads = s.downloads.filter((d) => !removed.includes(d.id));
      return removed;
    }),
    removeFile: asyncApi(ctx, () => undefined),
    open: asyncApi(ctx, () => undefined),
    show: () => true,
    showDefaultFolder: () => {},
    getFileIcon: asyncApi(ctx, () => ""),
    acceptDanger: asyncApi(ctx, () => undefined),
    setShelfEnabled: () => {},
    setUiOptions: asyncApi(ctx, () => undefined),
    onCreated: ctx.events.api("downloads.onCreated"),
    onChanged: ctx.events.api("downloads.onChanged"),
    onErased: ctx.events.api("downloads.onErased"),
    onDeterminingFilename: ctx.events.api("downloads.onDeterminingFilename"),
    State: { IN_PROGRESS: "in_progress", INTERRUPTED: "interrupted", COMPLETE: "complete" },
    FilenameConflictAction: { UNIQUIFY: "uniquify", OVERWRITE: "overwrite", PROMPT: "prompt" },
    DangerType: { FILE: "file", URL: "url", CONTENT: "content", UNCOMMON: "uncommon", HOST: "host", UNWANTED: "unwanted", SAFE: "safe", ACCEPTED: "accepted" },
  };
}

export function createReadingList(env: Env): Namespace {
  const { s, ctx } = env;
  const list = (s.settings.get("readingList")?.value as { url: string; title: string; hasBeenRead: boolean; creationTime: number; lastUpdateTime: number }[] | undefined) ?? [];
  s.settings.set("readingList", { extId: "", value: list });
  return {
    addEntry: asyncApi(ctx, (entry: { url: string; title: string; hasBeenRead: boolean }) => {
      if (list.some((e) => e.url === entry.url)) throw new ApiError("Duplicate URL.");
      const now = Date.now();
      list.push({ ...entry, creationTime: now, lastUpdateTime: now });
    }),
    query: asyncApi(ctx, (info: { url?: string; title?: string; hasBeenRead?: boolean } = {}) =>
      list.filter((e) => (info.url === undefined || e.url === info.url) && (info.title === undefined || e.title === info.title) && (info.hasBeenRead === undefined || e.hasBeenRead === info.hasBeenRead)),
    ),
    removeEntry: asyncApi(ctx, (info: { url: string }) => {
      const i = list.findIndex((e) => e.url === info.url);
      if (i < 0) throw new ApiError("URL not found.");
      list.splice(i, 1);
    }),
    updateEntry: asyncApi(ctx, (info: { url: string; title?: string; hasBeenRead?: boolean }) => {
      const e = list.find((x) => x.url === info.url);
      if (!e) throw new ApiError("URL not found.");
      Object.assign(e, info, { lastUpdateTime: Date.now() });
    }),
    onEntryAdded: ctx.events.api("readingList.onEntryAdded"),
    onEntryRemoved: ctx.events.api("readingList.onEntryRemoved"),
    onEntryUpdated: ctx.events.api("readingList.onEntryUpdated"),
  };
}

export function createUnsupported(env: Env, name: string, methods: string[], events: string[] = []): Namespace {
  const { ctx } = env;
  const ns: Namespace = {};
  for (const m of methods) {
    ns[m] = asyncApi(ctx, () => {
      throw new ApiError(`chrome.${name}.${m} is not supported in this browser.`);
    });
  }
  for (const e of events) ns[e] = ctx.events.api(`${name}.${e}`);
  return ns;
}

export function createInstanceId(env: Env): Namespace {
  const { ctx, ext } = env;
  const id = () => {
    let v = ext.settings.get("instanceID") as string | undefined;
    if (!v) {
      v = Array.from(crypto.getRandomValues(new Uint8Array(11)), (b) => b.toString(36)).join("").slice(0, 11);
      ext.settings.set("instanceID", v);
    }
    return v;
  };
  return {
    getID: asyncApi(ctx, id),
    getCreationTime: asyncApi(ctx, () => ext.installedAt / 1000),
    getToken: asyncApi(ctx, () => {
      throw new ApiError("Asynchronous operation is pending.");
    }),
    deleteToken: asyncApi(ctx, () => undefined),
    deleteID: asyncApi(ctx, () => {
      ext.settings.delete("instanceID");
    }),
    onTokenRefresh: ctx.events.api("instanceID.onTokenRefresh"),
  };
}

