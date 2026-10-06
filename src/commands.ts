import type { SapphireRegistry } from "./registry";

export interface MatchedCommand {
  extId: string;
  name: string;
}

type KeyLike = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey"> & { code?: string };

const NAMED_KEYS: Record<string, string[]> = {
  comma: [","],
  period: ["."],
  home: ["home"],
  end: ["end"],
  pageup: ["pageup"],
  pagedown: ["pagedown"],
  space: [" ", "spacebar"],
  insert: ["insert"],
  delete: ["delete", "del"],
  up: ["arrowup", "up"],
  down: ["arrowdown", "down"],
  left: ["arrowleft", "left"],
  right: ["arrowright", "right"],
  medianexttrack: ["mediatracknext", "medianexttrack"],
  mediaprevioustrack: ["mediatrackprevious", "mediaprevioustrack"],
  mediaplaypause: ["mediaplaypause"],
  mediastop: ["mediastop"],
};

function isMac(): boolean {
  return /mac/i.test(navigator.platform);
}

export function shortcutFor(suggested: Record<string, string | undefined> | undefined): string {
  if (!suggested) return "";
  const platform = isMac() ? "mac" : /cros/i.test(navigator.userAgent) ? "chromeos" : /linux/i.test(navigator.platform) ? "linux" : "windows";
  return suggested[platform] ?? suggested.default ?? "";
}

export function shortcutMatches(shortcut: string, e: KeyLike): boolean {
  if (!shortcut) return false;
  const parts = shortcut.split("+").map((p) => p.trim().toLowerCase());
  const mac = isMac();
  // On macOS Chrome maps "Ctrl" to Command; "MacCtrl" is the real Control key.
  const needMeta = mac && (parts.includes("command") || parts.includes("ctrl"));
  const needCtrl = mac ? parts.includes("macctrl") : parts.includes("ctrl") || parts.includes("command") || parts.includes("macctrl");
  const key = parts.find((p) => !["ctrl", "shift", "alt", "command", "macctrl"].includes(p));
  if (!key) return false;
  if (e.ctrlKey !== needCtrl) return false;
  if (mac && e.metaKey !== needMeta) return false;
  if (e.shiftKey !== parts.includes("shift") || e.altKey !== parts.includes("alt")) return false;
  const pressed = e.key.toLowerCase();
  const candidates = NAMED_KEYS[key] ?? [key];
  if (candidates.includes(pressed)) return true;
  // With Shift/Alt held, `key` is the shifted glyph; fall back to the physical key.
  if (e.code) {
    const code = e.code.toLowerCase();
    if (code === `key${key}` || code === `digit${key}`) return true;
  }
  return false;
}

export function findMatchingCommand(registry: SapphireRegistry, e: KeyLike): MatchedCommand | null {
  for (const ext of registry.list()) {
    if (!ext.enabled) continue;
    for (const [name, cmd] of Object.entries(ext.manifest.commands ?? {})) {
      const shortcut = shortcutFor(cmd.suggested_key as Record<string, string | undefined> | undefined);
      if (shortcutMatches(shortcut, e)) return { extId: ext.id, name };
    }
  }
  return null;
}

export function triggerCommand(registry: SapphireRegistry, extId: string, name: string, tab?: unknown): void {
  registry.dispatch(extId, "commands.onCommand", tab === undefined ? [name] : [name, tab]);
}
