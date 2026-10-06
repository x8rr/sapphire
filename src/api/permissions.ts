import { dbPut, EXT_STORE } from "../db";
import { ApiError, asyncApi } from "../realm";
import { matchPattern } from "../matchPatterns";
import type { ExtensionState } from "../registry";
import type { Env, Namespace } from "./env";

/** Permissions that are really host patterns when they appear in MV2 `permissions`. */
export function isHostPattern(p: string): boolean {
  return p === "<all_urls>" || /^(\*|https?|wss?|ftp|file|urn):\/\//.test(p);
}

export function declaredPermissions(ext: ExtensionState): { permissions: string[]; origins: string[] } {
  const all = [...(ext.manifest.permissions ?? []), ...(ext.manifest.optional_permissions ?? [])];
  const origins = [...(ext.manifest.host_permissions ?? []), ...(ext.manifest.optional_host_permissions ?? []), ...all.filter(isHostPattern)];
  return { permissions: all.filter((p) => !isHostPattern(p)), origins };
}

export function hasPermission(ext: ExtensionState, permission: string): boolean {
  return ext.grantedPermissions.has(permission);
}

/** Whether a granted origin pattern covers `pattern` (or a URL). */
function originCovered(ext: ExtensionState, pattern: string): boolean {
  if (ext.grantedOrigins.has(pattern) || ext.grantedOrigins.has("<all_urls>")) return true;
  const sample = pattern.replace("*://", "https://").replace("://*.", "://x.").replace(/\*/g, "x");
  for (const granted of ext.grantedOrigins) {
    if (matchPattern(granted, sample)) return true;
  }
  return false;
}

export function hostAllowed(ext: ExtensionState, url: string): boolean {
  for (const granted of ext.grantedOrigins) if (matchPattern(granted, url)) return true;
  for (const p of ext.grantedPermissions) if (isHostPattern(p) && matchPattern(p, url)) return true;
  return false;
}

async function persistGrants(ext: ExtensionState): Promise<void> {
  ext.meta.grantedPermissions = [...ext.grantedPermissions];
  ext.meta.grantedOrigins = [...ext.grantedOrigins];
  await dbPut(EXT_STORE, null, ext.meta).catch(() => {});
}

export function createPermissions(env: Env): Namespace {
  const { s, ctx, ext } = env;
  const split = (input: { permissions?: string[]; origins?: string[] } = {}) => ({
    permissions: (input.permissions ?? []).filter((p) => !isHostPattern(p)),
    origins: [...(input.origins ?? []), ...(input.permissions ?? []).filter(isHostPattern)],
  });
  const declared = declaredPermissions(ext);
  return {
    getAll: asyncApi(ctx, () => ({ permissions: [...ext.grantedPermissions].filter((p) => !isHostPattern(p)), origins: [...ext.grantedOrigins] })),
    contains: asyncApi(ctx, (input: { permissions?: string[]; origins?: string[] }) => {
      const { permissions, origins } = split(input);
      return permissions.every((p) => ext.grantedPermissions.has(p)) && origins.every((o) => originCovered(ext, o));
    }),
    request: asyncApi(ctx, async (input: { permissions?: string[]; origins?: string[] }) => {
      const { permissions, origins } = split(input);
      for (const p of permissions) {
        if (!declared.permissions.includes(p)) throw new ApiError(`Only permissions specified in the manifest may be requested.`);
      }
      const missingP = permissions.filter((p) => !ext.grantedPermissions.has(p));
      const missingO = origins.filter((o) => !originCovered(ext, o));
      if (!missingP.length && !missingO.length) return true;
      const granted = s.host.requestPermissions ? await s.host.requestPermissions(ext.id, missingP, missingO) : true;
      if (!granted) return false;
      for (const p of missingP) ext.grantedPermissions.add(p);
      for (const o of missingO) ext.grantedOrigins.add(o);
      await persistGrants(ext);
      s.registry.dispatch(ext.id, "permissions.onAdded", [{ permissions: missingP, origins: missingO }]);
      s.refreshApis(ext);
      return true;
    }),
    remove: asyncApi(ctx, async (input: { permissions?: string[]; origins?: string[] }) => {
      const { permissions, origins } = split(input);
      const required = new Set([...(ext.manifest.permissions ?? []), ...(ext.manifest.host_permissions ?? [])]);
      if ([...permissions, ...origins].some((p) => required.has(p))) throw new ApiError("You cannot remove required permissions.");
      for (const p of permissions) ext.grantedPermissions.delete(p);
      for (const o of origins) ext.grantedOrigins.delete(o);
      await persistGrants(ext);
      s.registry.dispatch(ext.id, "permissions.onRemoved", [{ permissions, origins }]);
      return true;
    }),
    addHostAccessRequest: asyncApi(ctx, () => undefined),
    removeHostAccessRequest: asyncApi(ctx, () => undefined),
    onAdded: ctx.events.api("permissions.onAdded"),
    onRemoved: ctx.events.api("permissions.onRemoved"),
  };
}

