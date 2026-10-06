export interface ChromeManifestIcons {
  [size: string]: string;
}

export interface ChromeManifestAction {
  default_icon?: string | ChromeManifestIcons;
  default_title?: string;
  default_popup?: string;
}

export interface ChromeManifestBackground {
  service_worker?: string;
  type?: "module" | "classic";
  page?: string;
  scripts?: string[];
  persistent?: boolean;
}

export type RunAt = "document_start" | "document_end" | "document_idle";
export type ExecutionWorld = "ISOLATED" | "MAIN" | "USER_SCRIPT";

export interface ChromeManifestContentScript {
  matches?: string[];
  exclude_matches?: string[];
  include_globs?: string[];
  exclude_globs?: string[];
  js?: string[];
  css?: string[];
  run_at?: RunAt;
  all_frames?: boolean;
  match_about_blank?: boolean;
  match_origin_as_fallback?: boolean;
  world?: ExecutionWorld;
}

export interface ChromeManifestRuleResource {
  id?: string;
  enabled?: boolean;
  path: string;
}

export interface ChromeManifestCommand {
  description?: string;
  suggested_key?: {
    default?: string;
    windows?: string;
    mac?: string;
    linux?: string;
    chromeos?: string;
  };
}

export type WebAccessibleResources =
  | string[]
  | { resources: string[]; matches?: string[]; extension_ids?: string[]; use_dynamic_url?: boolean }[];

export interface ChromeManifest {
  name: string;
  short_name?: string;
  description?: string;
  version?: string;
  version_name?: string;
  manifest_version?: number;
  default_locale?: string;
  key?: string;
  background?: ChromeManifestBackground;
  content_scripts?: ChromeManifestContentScript[];
  declarative_net_request?: {
    rule_resources?: ChromeManifestRuleResource[];
  };
  icons?: ChromeManifestIcons;
  action?: ChromeManifestAction;
  browser_action?: ChromeManifestAction;
  page_action?: ChromeManifestAction;
  options_page?: string;
  options_ui?: { page?: string; open_in_tab?: boolean };
  side_panel?: { default_path?: string };
  chrome_url_overrides?: { newtab?: string; bookmarks?: string; history?: string };
  devtools_page?: string;
  commands?: Record<string, ChromeManifestCommand>;
  omnibox?: { keyword?: string };
  permissions?: string[];
  optional_permissions?: string[];
  host_permissions?: string[];
  optional_host_permissions?: string[];
  web_accessible_resources?: WebAccessibleResources;
  externally_connectable?: { matches?: string[]; ids?: string[]; accepts_tls_channel_id?: boolean };
  [key: string]: unknown;
}

export interface ExtensionMeta {
  id: string;
  manifest: ChromeManifest;
  enabled: boolean;
  installedAt: number;
  filename: string;
  fileList: string[];
  /** Version the background last ran onInstalled for; drives install vs update. */
  lastRunVersion?: string;
  grantedPermissions?: string[];
  grantedOrigins?: string[];
}

export interface DNRRuleCondition {
  urlFilter?: string;
  regexFilter?: string;
  isUrlFilterCaseSensitive?: boolean;
  resourceTypes?: string[];
  excludedResourceTypes?: string[];
  requestMethods?: string[];
  excludedRequestMethods?: string[];
  domains?: string[];
  excludedDomains?: string[];
  requestDomains?: string[];
  excludedRequestDomains?: string[];
  initiatorDomains?: string[];
  excludedInitiatorDomains?: string[];
  domainType?: "firstParty" | "thirdParty";
  tabIds?: number[];
  excludedTabIds?: number[];
  responseHeaders?: unknown[];
  excludedResponseHeaders?: unknown[];
}

export interface DNRHeaderInfo {
  header: string;
  operation: "append" | "set" | "remove";
  value?: string;
}

export interface DNRUrlTransform {
  scheme?: string;
  host?: string;
  port?: string;
  path?: string;
  query?: string;
  queryTransform?: {
    removeParams?: string[];
    addOrReplaceParams?: { key: string; value: string; replaceOnly?: boolean }[];
  };
  fragment?: string;
  username?: string;
  password?: string;
}

export interface DNRRuleAction {
  type: "block" | "redirect" | "upgradeScheme" | "modifyHeaders" | "allow" | "allowAllRequests";
  redirect?: { url?: string; regexSubstitution?: string; extensionPath?: string; transform?: DNRUrlTransform };
  requestHeaders?: DNRHeaderInfo[];
  responseHeaders?: DNRHeaderInfo[];
}

export interface DNRRule {
  id: number;
  priority?: number;
  condition: DNRRuleCondition;
  action: DNRRuleAction;
}

export type DNRDecision =
  | { action: "block" }
  | { action: "redirect"; url: string }
  | { action: "modifyHeaders"; headers: DNRHeaderInfo[]; responseHeaders: DNRHeaderInfo[] };

export interface ContentScriptRegistration {
  extId: string;
  /** Set for scripting.registerContentScripts / userScripts registrations. */
  id?: string;
  source: "manifest" | "scripting" | "userScripts";
  matches: string[];
  excludeMatches: string[];
  includeGlobs: string[];
  excludeGlobs: string[];
  js: ({ file: string } | { code: string })[];
  css: string[];
  runAt: RunAt;
  allFrames: boolean;
  matchAboutBlank: boolean;
  world: ExecutionWorld;
  worldId?: string;
  persistAcrossSessions?: boolean;
}

export interface TabInfo {
  id: number;
  windowId: number;
  url: string;
  title: string;
  active: boolean;
  index?: number;
  pinned?: boolean;
  favIconUrl?: string;
  status?: "loading" | "complete" | "unloaded";
  audible?: boolean;
  muted?: boolean;
  incognito?: boolean;
  openerTabId?: number;
}

export interface NotificationOptions {
  type?: string;
  title?: string;
  message?: string;
  contextMessage?: string;
  iconUrl?: string;
  imageUrl?: string;
  buttons?: { title: string; iconUrl?: string }[];
  items?: { title: string; message: string }[];
  progress?: number;
  priority?: number;
  eventTime?: number;
  requireInteraction?: boolean;
  silent?: boolean;
}

export interface ContextMenuShowRequest {
  tabId: number | null;
  frameId: number;
  x: number;
  y: number;
  items: ContextMenuEntry[];
  /** Call with the chosen entry; Sapphire dispatches contextMenus.onClicked. */
  select: (entry: ContextMenuEntry) => void;
}

export interface ContextMenuEntry {
  extId: string;
  extName: string;
  id: string;
  title: string;
  type: "normal" | "checkbox" | "radio" | "separator";
  checked: boolean;
  enabled: boolean;
  children: ContextMenuEntry[];
}

export interface SapphireHostBindings {
  /**
   * Called when Sapphire needs the Scramjet controller and doesn't have one yet
   * (an extension is installed, or a popup/page must be mounted). Hosts that boot
   * the proxy lazily should start it here and then call attachController().
   */
  ensureController?: () => void;
  getTabId: (win: Window) => number | null;
  getTab: (tabId: number) => TabInfo | null;
  getAllTabs: () => TabInfo[];
  getActiveTabId?: () => number | null;
  getTabWindow?: (tabId: number) => Window | null;
  /** tabId null means "open a new tab". */
  navigateTab?: (tabId: number | null, url: string) => void;
  /**
   * Open a new tab and return its id. Preferred over navigateTab(null, ...) since
   * tabs.create has to hand the new tab back to the extension.
   */
  createTab?: (url: string, options: { active: boolean; openerTabId?: number }) => number | Promise<number> | null;
  closeTab?: (tabId: number) => void;
  reloadTab?: (tabId: number) => void;
  activateTab?: (tabId: number) => void;
  goBack?: (tabId: number) => void;
  goForward?: (tabId: number) => void;
  /**
   * Legacy: show an extension page (options, tabs.create with an extension URL)
   * in a tab. Extension pages now load through Scramjet like any other URL, so a
   * host that only implements navigateTab/createTab gets this for free.
   */
  openExtensionTab?: (extId: string, page: string, tabId: number | null) => void;
  /** action.openPopup / _execute_action. Return false if the popup couldn't be shown. */
  openPopup?: (extId: string, tabId: number | null) => boolean | void;
  /** window.close() inside a popup. */
  closePopup?: (extId: string) => void;
  openSidePanel?: (extId: string, path: string, tabId: number | null) => void;
  /** Legacy two-field notification sink. */
  showNotification?: (title: string, message: string) => void;
  createNotification?: (
    extId: string,
    notificationId: string,
    options: NotificationOptions,
    callbacks: { click: () => void; close: (byUser: boolean) => void; buttonClick: (index: number) => void },
  ) => void;
  clearNotification?: (extId: string, notificationId: string) => void;
  showContextMenu?: (request: ContextMenuShowRequest) => void;
  /** permissions.request prompt. Defaults to granting. */
  requestPermissions?: (extId: string, permissions: string[], origins: string[]) => boolean | Promise<boolean>;
  /** tabs.captureVisibleTab. Resolve to a data: URL. Falls back to getDisplayMedia. */
  captureTab?: (tabId: number | null, format: string, quality?: number) => Promise<string | null>;
  /** Extensions calling chrome.search.query, or the omnibox fallback. */
  search?: (text: string, tabId: number | null, disposition: string) => void;
}
