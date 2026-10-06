export { Sapphire, type SapphireOptions, type NewTabOverride, type DownloadItem } from "./sapphire";
export { SapphirePlugin, SapphireContentScriptPlugin, type SapphirePluginOptions } from "./SapphirePlugin";
export { findMatchingCommand, triggerCommand, shortcutMatches, type MatchedCommand } from "./commands";
export { matchPattern, urlMatchesPatterns } from "./matchPatterns";
export { extensionOrigin, extensionUrl, parseExtensionUrl, displayExtensionUrl, normalizeExtensionUrl } from "./urls";
export { BLOCKED_HEADER } from "./network";
export type { InstalledExtensionSummary } from "./extensions";
export type { ContextInfo } from "./api/contextMenus";
export type {
  ChromeManifest,
  ContextMenuEntry,
  ContextMenuShowRequest,
  DNRDecision,
  DNRRule,
  NotificationOptions,
  SapphireHostBindings,
  TabInfo,
} from "./types";
