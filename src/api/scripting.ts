import { ApiError, asyncApi } from "../realm";
import { isValidMatchPattern } from "../matchPatterns";
import type { ContentScriptRegistration, ExecutionWorld, RunAt } from "../types";
import type { Env, Namespace } from "./env";

interface TargetSpec {
  tabId: number;
  frameIds?: number[];
  documentIds?: string[];
  allFrames?: boolean;
}

interface RegisteredScriptInput {
  id: string;
  matches?: string[];
  excludeMatches?: string[];
  includeGlobs?: string[];
  excludeGlobs?: string[];
  js?: (string | { file?: string; code?: string })[];
  css?: string[];
  runAt?: RunAt;
  allFrames?: boolean;
  matchOriginAsFallback?: boolean;
  world?: ExecutionWorld;
  worldId?: string;
  persistAcrossSessions?: boolean;
}

function validateTarget(target: TargetSpec | undefined): TargetSpec {
  if (!target || typeof target.tabId !== "number") throw new TypeError("Error in invocation of scripting: target.tabId is required.");
  if (target.allFrames && (target.frameIds || target.documentIds)) throw new ApiError("Cannot specify both 'allFrames' and 'frameIds' or 'documentIds'.");
  return target;
}

export function toRegistration(
  extId: string,
  input: RegisteredScriptInput,
  source: ContentScriptRegistration["source"],
  existing?: ContentScriptRegistration,
): ContentScriptRegistration {
  const js = (input.js ?? existing?.js ?? []).map((entry) => {
    if (typeof entry === "string") return { file: entry.replace(/^\/+/, "") };
    if ("file" in entry && typeof entry.file === "string") return { file: entry.file.replace(/^\/+/, "") };
    if ("code" in entry && typeof entry.code === "string") return { code: entry.code };
    throw new ApiError("Each script source must specify exactly one of 'file' or 'code'.");
  });
  const matches = input.matches ?? existing?.matches ?? [];
  for (const m of matches) if (!isValidMatchPattern(m)) throw new ApiError(`Script with ID '${input.id}' has invalid value for matches: ${m}`);
  return {
    extId,
    id: input.id,
    source,
    matches,
    excludeMatches: input.excludeMatches ?? existing?.excludeMatches ?? [],
    includeGlobs: input.includeGlobs ?? existing?.includeGlobs ?? [],
    excludeGlobs: input.excludeGlobs ?? existing?.excludeGlobs ?? [],
    js,
    css: (input.css ?? existing?.css ?? []).map((c) => c.replace(/^\/+/, "")),
    runAt: input.runAt ?? existing?.runAt ?? "document_idle",
    allFrames: input.allFrames ?? existing?.allFrames ?? false,
    matchAboutBlank: input.matchOriginAsFallback ?? existing?.matchAboutBlank ?? false,
    world: input.world ?? existing?.world ?? (source === "userScripts" ? "USER_SCRIPT" : "ISOLATED"),
    worldId: input.worldId ?? existing?.worldId,
    persistAcrossSessions: input.persistAcrossSessions ?? existing?.persistAcrossSessions ?? true,
  };
}

function describe(cs: ContentScriptRegistration, source: ContentScriptRegistration["source"]) {
  if (source === "userScripts") {
    return {
      id: cs.id,
      matches: cs.matches,
      excludeMatches: cs.excludeMatches,
      includeGlobs: cs.includeGlobs,
      excludeGlobs: cs.excludeGlobs,
      js: cs.js,
      runAt: cs.runAt,
      allFrames: cs.allFrames,
      world: cs.world,
      ...(cs.worldId ? { worldId: cs.worldId } : {}),
    };
  }
  return {
    id: cs.id,
    matches: cs.matches,
    excludeMatches: cs.excludeMatches,
    js: cs.js.map((j) => ("file" in j ? j.file : "")),
    css: cs.css,
    runAt: cs.runAt,
    allFrames: cs.allFrames,
    matchOriginAsFallback: cs.matchAboutBlank,
    world: cs.world,
    persistAcrossSessions: cs.persistAcrossSessions ?? true,
  };
}

function registrationApi(env: Env, source: "scripting" | "userScripts") {
  const { s, ctx, ext } = env;
  const mine = () => s.registry.contentScripts.filter((cs) => cs.extId === ext.id && cs.source === source);
  const register = async (scripts: RegisteredScriptInput[]) => {
    const ids = new Set(mine().map((cs) => cs.id));
    const seen = new Set<string>();
    const regs = (scripts ?? []).map((input) => {
      if (!input?.id) throw new ApiError("Script ID must not be empty.");
      if (input.id.startsWith("_")) throw new ApiError(`Script's ID '${input.id}' must not start with '_'`);
      if (ids.has(input.id) || seen.has(input.id)) throw new ApiError(`Duplicate script ID '${input.id}'`);
      seen.add(input.id);
      if (!input.matches?.length) throw new ApiError(`Script with ID '${input.id}' must specify 'matches'.`);
      const reg = toRegistration(ext.id, input, source);
      if (!reg.js.length && !reg.css.length) throw new ApiError(`Script with ID '${input.id}' must specify at least one js or css file.`);
      return reg;
    });
    await s.addContentScripts(ext, regs);
  };
  const update = async (scripts: RegisteredScriptInput[]) => {
    const current = mine();
    const regs = (scripts ?? []).map((input) => {
      const existing = current.find((cs) => cs.id === input.id);
      if (!existing) throw new ApiError(`Script with ID '${input.id}' does not exist.`);
      return toRegistration(ext.id, input, source, existing);
    });
    await s.removeContentScripts(ext, source, regs.map((r) => r.id!));
    await s.addContentScripts(ext, regs);
  };
  const unregister = async (filter?: { ids?: string[] }) => {
    if (filter?.ids) {
      const known = new Set(mine().map((cs) => cs.id));
      for (const id of filter.ids) if (!known.has(id)) throw new ApiError(`Nonexistent script ID '${id}'`);
    }
    await s.removeContentScripts(ext, source, filter?.ids ?? null);
  };
  const get = (filter?: { ids?: string[] }) =>
    mine()
      .filter((cs) => !filter?.ids || filter.ids.includes(cs.id!))
      .map((cs) => describe(cs, source));
  return {
    register: asyncApi(ctx, register),
    update: asyncApi(ctx, update),
    unregister: asyncApi(ctx, unregister),
    get: asyncApi(ctx, get),
  };
}

export function createScripting(env: Env): Namespace {
  const { s, ctx, ext } = env;
  const reg = registrationApi(env, "scripting");
  return {
    executeScript: asyncApi(
      ctx,
      async (injection: {
        target: TargetSpec;
        func?: (...a: unknown[]) => unknown;
        function?: (...a: unknown[]) => unknown;
        args?: unknown[];
        files?: string[];
        world?: ExecutionWorld;
        injectImmediately?: boolean;
      }) => {
        const target = validateTarget(injection?.target);
        const func = injection.func ?? injection.function;
        if (!!func === !!injection.files?.length) throw new ApiError("Exactly one of 'func' and 'files' must be specified");
        if (injection.files) {
          for (const f of injection.files) {
            if ((await ext.files.readText(f)) === null) throw new ApiError(`Could not load file: '${f}'.`);
          }
        }
        return s.executeScript(ext, target, {
          func: func ? String(func) : undefined,
          args: injection.args,
          files: injection.files?.map((f) => f.replace(/^\/+/, "")),
          world: injection.world ?? "ISOLATED",
          injectImmediately: injection.injectImmediately,
        });
      },
    ),
    insertCSS: asyncApi(ctx, async (injection: { target: TargetSpec; css?: string; files?: string[]; origin?: string }) => {
      const target = validateTarget(injection?.target);
      if (!!injection.css === !!injection.files?.length) throw new ApiError("Exactly one of 'css' and 'files' must be specified.");
      if (injection.css !== undefined) return s.insertCss(ext, target, injection.css, `code:${injection.css}`);
      for (const f of injection.files!) {
        const css = await ext.files.readText(f);
        if (css === null) throw new ApiError(`Could not load file: '${f}'.`);
        await s.insertCss(ext, target, css, `file:${f.replace(/^\/+/, "")}`);
      }
    }),
    removeCSS: asyncApi(ctx, async (injection: { target: TargetSpec; css?: string; files?: string[] }) => {
      const target = validateTarget(injection?.target);
      if (injection.css !== undefined) return s.removeCss(ext, target, `code:${injection.css}`);
      for (const f of injection.files ?? []) await s.removeCss(ext, target, `file:${f.replace(/^\/+/, "")}`);
    }),
    registerContentScripts: reg.register,
    updateContentScripts: reg.update,
    unregisterContentScripts: reg.unregister,
    getRegisteredContentScripts: reg.get,
    ExecutionWorld: { ISOLATED: "ISOLATED", MAIN: "MAIN" },
    StyleOrigin: { AUTHOR: "AUTHOR", USER: "USER" },
  };
}

export function createUserScripts(env: Env): Namespace {
  const { s, ctx, ext } = env;
  const reg = registrationApi(env, "userScripts");
  return {
    register: reg.register,
    update: reg.update,
    unregister: reg.unregister,
    getScripts: reg.get,
    configureWorld: asyncApi(ctx, (config: { csp?: string; messaging?: boolean; worldId?: string }) => {
      ext.userScriptWorlds.set(config?.worldId ?? "", { csp: config?.csp, messaging: config?.messaging });
    }),
    getWorldConfigurations: asyncApi(ctx, () => [...ext.userScriptWorlds].map(([worldId, c]) => ({ ...c, ...(worldId ? { worldId } : {}) }))),
    resetWorldConfiguration: asyncApi(ctx, (worldId?: string) => {
      ext.userScriptWorlds.delete(worldId ?? "");
    }),
    execute: asyncApi(
      ctx,
      async (injection: { target: TargetSpec; js: { code?: string; file?: string }[]; world?: ExecutionWorld; injectImmediately?: boolean }) => {
        const target = validateTarget(injection?.target);
        const results: { frameId: number; documentId: string; result?: unknown }[][] = [];
        for (const source of injection.js ?? []) {
          results.push(
            await s.executeScript(ext, target, {
              code: source.code,
              files: source.file ? [source.file] : undefined,
              world: injection.world ?? "USER_SCRIPT",
              injectImmediately: injection.injectImmediately,
            }),
          );
        }
        return results[results.length - 1] ?? [];
      },
    ),
    ExecutionWorld: { MAIN: "MAIN", USER_SCRIPT: "USER_SCRIPT" },
  };
}
