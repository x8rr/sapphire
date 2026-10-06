import { ApiError, asyncApi, toRealm } from "../realm";
import type { ExtensionState, SapphireRegistry } from "../registry";
import { QUOTAS, type StorageAreaName, type StorageChanges } from "../storage";
import type { Env, Namespace } from "./env";

export function broadcastStorageChange(registry: SapphireRegistry, ext: ExtensionState, area: StorageAreaName, changes: StorageChanges): void {
  if (!Object.keys(changes).length) return;
  for (const ctx of registry.contextsOf(ext.id)) {
    // storage.session is hidden from content scripts unless the access level was raised.
    if (area === "session" && ctx.kind === "content" && ext.settings.get("session.accessLevel") !== "TRUSTED_AND_UNTRUSTED_CONTEXTS") continue;
    ctx.events.peek("storage.onChanged")?.dispatchFiltered(() => true, () => [toRealm(ctx, changes), area]);
    ctx.events.peek(`storage.${area}.onChanged`)?.dispatchFiltered(() => true, () => [toRealm(ctx, changes)]);
  }
}

export function createStorage(env: Env, content: boolean): Namespace {
  const { s, ctx, ext } = env;

  const area = (name: StorageAreaName): Namespace => {
    const backend = ext.storage[name];
    const readonly = name === "managed";
    const guardSession = () => {
      if (name === "session" && content && ext.settings.get("session.accessLevel") !== "TRUSTED_AND_UNTRUSTED_CONTEXTS") {
        throw new ApiError("Access to storage is not allowed from this context.");
      }
    };
    const write = async (op: () => Promise<StorageChanges>) => {
      if (readonly) throw new ApiError("This is a read-only store.");
      guardSession();
      const changes = await op();
      broadcastStorageChange(s.registry, ext, name, changes);
    };
    const ns: Namespace = {
      get: asyncApi(ctx, (keys?: unknown) => {
        guardSession();
        return backend.get(keys);
      }),
      getKeys: asyncApi(ctx, () => {
        guardSession();
        return backend.getKeys();
      }),
      set: asyncApi(ctx, (items: Record<string, unknown>) => write(() => backend.set(items))),
      remove: asyncApi(ctx, (keys: string | string[]) => write(() => backend.remove(keys))),
      clear: asyncApi(ctx, () => write(() => backend.clear())),
      getBytesInUse: asyncApi(ctx, (keys?: unknown) => backend.bytesInUse(keys)),
      onChanged: ctx.events.api(`storage.${name}.onChanged`),
      ...QUOTAS[name],
    };
    if (name === "session") {
      ns.setAccessLevel = asyncApi(ctx, (opts: { accessLevel?: string }) => {
        if (content) throw new ApiError("Access to storage is not allowed from this context.");
        ext.settings.set("session.accessLevel", opts?.accessLevel ?? "TRUSTED_CONTEXTS");
      });
    } else if (!readonly) {
      ns.setAccessLevel = asyncApi(ctx, () => {
        throw new ApiError("This StorageArea does not support setAccessLevel.");
      });
    }
    return ns;
  };

  return {
    local: area("local"),
    sync: area("sync"),
    session: area("session"),
    managed: area("managed"),
    onChanged: ctx.events.api("storage.onChanged"),
    AccessLevel: { TRUSTED_AND_UNTRUSTED_CONTEXTS: "TRUSTED_AND_UNTRUSTED_CONTEXTS", TRUSTED_CONTEXTS: "TRUSTED_CONTEXTS" },
  };
}
