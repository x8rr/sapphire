import { ApiError, asyncApi } from "../realm";
import type { ExtensionState } from "../registry";
import type { Sapphire } from "../sapphire";
import type { NotificationOptions } from "../types";
import { parseExtensionUrl, resolvePackagePath } from "../urls";
import type { Env, Namespace } from "./env";

let counter = 0;

async function resolveImage(ext: ExtensionState, url: string | undefined, fromPath: string): Promise<string | undefined> {
  if (!url) return undefined;
  if (/^(data|blob|https?):/i.test(url) && !parseExtensionUrl(url)) return url;
  const parsed = parseExtensionUrl(url);
  const path = parsed && parsed.extId === ext.id ? parsed.path : resolvePackagePath(url, fromPath);
  return (await ext.files.dataUrl(path)) ?? undefined;
}

function show(s: Sapphire, ext: ExtensionState, id: string, options: NotificationOptions): void {
  const callbacks = {
    click: () => s.registry.dispatch(ext.id, "notifications.onClicked", [id]),
    close: (byUser: boolean) => {
      ext.notifications.delete(id);
      s.registry.dispatch(ext.id, "notifications.onClosed", [id, byUser]);
    },
    buttonClick: (index: number) => s.registry.dispatch(ext.id, "notifications.onButtonClicked", [id, index]),
  };
  if (s.host.createNotification) {
    s.host.createNotification(ext.id, id, options, callbacks);
    return;
  }
  if (typeof Notification !== "undefined" && Notification.permission === "granted") {
    try {
      const n = new Notification(options.title ?? ext.manifest.name, {
        body: [options.message, options.contextMessage].filter(Boolean).join("\n"),
        icon: options.iconUrl,
        tag: `${ext.id}:${id}`,
        requireInteraction: options.requireInteraction,
        silent: options.silent,
      });
      n.onclick = () => callbacks.click();
      n.onclose = () => callbacks.close(true);
      return;
    } catch {
      // fall through
    }
  }
  s.host.showNotification?.(options.title ?? ext.manifest.name, options.message ?? "");
}

export function createNotifications(env: Env): Namespace {
  const { s, ctx, ext } = env;
  const fromPath = ctx.kind === "background" ? "" : (parseExtensionUrl(ctx.url)?.path ?? "");
  return {
    create: asyncApi(ctx, async (idOrOptions?: unknown, maybeOptions?: unknown) => {
      let id = typeof idOrOptions === "string" ? idOrOptions : "";
      const raw = ((typeof idOrOptions === "string" || idOrOptions === undefined ? maybeOptions : idOrOptions) ?? {}) as NotificationOptions;
      if (!raw.type || !raw.iconUrl || raw.title === undefined || raw.message === undefined) {
        throw new ApiError("Some of the required properties are missing: type, iconUrl, title and message.");
      }
      if (!id) id = `${Date.now()}-${++counter}`;
      const options: NotificationOptions = {
        ...raw,
        iconUrl: await resolveImage(ext, raw.iconUrl, fromPath),
        imageUrl: await resolveImage(ext, raw.imageUrl, fromPath),
        buttons: raw.buttons ? await Promise.all(raw.buttons.map(async (b) => ({ ...b, iconUrl: await resolveImage(ext, b.iconUrl, fromPath) }))) : undefined,
      };
      if (ext.notifications.has(id)) s.host.clearNotification?.(ext.id, id);
      ext.notifications.set(id, { id, options: options as Record<string, unknown> });
      show(s, ext, id, options);
      return id;
    }),
    update: asyncApi(ctx, async (id: string, options: NotificationOptions) => {
      const existing = ext.notifications.get(id);
      if (!existing) return false;
      const merged = { ...(existing.options as NotificationOptions), ...options };
      if (options.iconUrl) merged.iconUrl = await resolveImage(ext, options.iconUrl, fromPath);
      existing.options = merged as Record<string, unknown>;
      show(s, ext, id, merged);
      return true;
    }),
    clear: asyncApi(ctx, (id: string) => {
      if (!ext.notifications.delete(id)) return false;
      s.host.clearNotification?.(ext.id, id);
      s.registry.dispatch(ext.id, "notifications.onClosed", [id, false]);
      return true;
    }),
    getAll: asyncApi(ctx, () => Object.fromEntries([...ext.notifications.keys()].map((k) => [k, true]))),
    getPermissionLevel: asyncApi(ctx, () => "granted"),
    onClicked: ctx.events.api("notifications.onClicked"),
    onClosed: ctx.events.api("notifications.onClosed"),
    onButtonClicked: ctx.events.api("notifications.onButtonClicked"),
    onPermissionLevelChanged: ctx.events.api("notifications.onPermissionLevelChanged"),
    onShowSettings: ctx.events.api("notifications.onShowSettings"),
    TemplateType: { BASIC: "basic", IMAGE: "image", LIST: "list", PROGRESS: "progress" },
    PermissionLevel: { GRANTED: "granted", DENIED: "denied" },
  };
}
