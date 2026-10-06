// Content scripts run in the page's own JS world (Scramjet rewrites them like
// any inline script, so `location`, `document.cookie`, `fetch('/api')` all
// behave as on the real site). What Chrome gives them on top — a per-extension
// `chrome` object while page scripts keep seeing the page's own `window.chrome`
// — is done with a getter on `window.chrome` that looks at who is asking: each
// injected script carries a `//# sourceURL=` on its extension's alias origin,
// and V8 stack frames report that URL, so the calling extension is right there
// in `new Error().stack`. This also covers `globalThis.chrome` /
// `window.chrome` lookups (webextension-polyfill checks those) and callbacks
// that run long after injection.
import { buildChromeApi } from "./api";
import { matchPattern, urlMatchesContentScript } from "./matchPatterns";
import { randomId } from "./realm";
import type { ExtensionContext, ExtensionState } from "./registry";
import type { Sapphire } from "./sapphire";
import { jsonClone } from "./storage";
import type { ContentScriptRegistration, ExecutionWorld, RunAt } from "./types";
import { extensionHostSuffix, extensionUrl, isExtensionHost } from "./urls";

export interface ContentWorld {
  win: Window;
  doc: Document;
  tabId: number | null;
  frameId: number;
  parentFrameId: number;
  documentId: string;
  url: string;
  isTop: boolean;
  /** `${extId}` for ISOLATED, `${extId}:user` for USER_SCRIPT. */
  contexts: Map<string, ExtensionContext>;
  injecting: ExtensionContext | null;
  originalChrome: unknown;
  styles: { extId: string; key: string; el: Element }[];
  injectedPhases: Set<RunAt>;
  pageChrome: unknown;
}

const worlds = new WeakMap<Window, ContentWorld>();

/** Everything a content script's `chrome` can hold, across worlds. */
const CONTENT_NAMESPACES = ["runtime", "storage", "i18n", "extension", "dom"];

export function contentWorldOf(win: Window): ContentWorld | undefined {
  return worlds.get(win);
}

const V8Error = Error as ErrorConstructor & { stackTraceLimit: number; captureStackTrace(target: object): void };

function stackExtension(): { extId: string; user: boolean } | null {
  const holder: { stack?: string } = {};
  const limit = V8Error.stackTraceLimit;
  if (limit < 50) V8Error.stackTraceLimit = 50;
  V8Error.captureStackTrace(holder);
  V8Error.stackTraceLimit = limit;
  const stack = holder.stack ?? "";
  const suffix = extensionHostSuffix();
  let at = stack.indexOf(`.${suffix}/`);
  while (at !== -1) {
    const start = stack.lastIndexOf("https://", at);
    if (start !== -1 && at - start - 8 <= 64) {
      const host = stack.slice(start + 8, at + suffix.length + 1);
      const extId = isExtensionHost(host);
      if (extId) {
        const pathStart = at + suffix.length + 2;
        return { extId, user: stack.startsWith("__sapphire_user_script__/", pathStart) };
      }
    }
    at = stack.indexOf(`.${suffix}/`, at + 1);
  }
  // USER_SCRIPT-world bridge files (e.g. an installed userscript manager's own sandboxed
  // injector) are labeled with a real chrome-extension:// sourceURL, matching what real
  // Chrome would show for any extension-injected code — some extensions parse their own
  // call stack expecting exactly that scheme, so it can't use the fake https:// alias
  // like other isolated-world files do.
  const marker = "__sapphire_user_script__/";
  let m = stack.indexOf(`/${marker}`);
  while (m !== -1) {
    const start = stack.lastIndexOf("chrome-extension://", m);
    if (start !== -1 && m - start - "chrome-extension://".length <= 64) {
      const id = stack.slice(start + "chrome-extension://".length, m);
      if (/^[a-p]{32}$/.test(id)) return { extId: id, user: true };
    }
    m = stack.indexOf(`/${marker}`, m + 1);
  }
  return null;
}

export function installContentWorld(
  s: Sapphire,
  win: Window,
  info: { tabId: number | null; frameId: number; parentFrameId: number; documentId: string; url: string; isTop: boolean },
): ContentWorld {
  const existing = worlds.get(win);
  if (existing && existing.doc === win.document) return existing;
  let originalChrome: unknown;
  try {
    originalChrome = (win as unknown as { chrome?: unknown }).chrome;
  } catch {
    originalChrome = undefined;
  }
  const world: ContentWorld = {
    win,
    doc: win.document,
    ...info,
    contexts: new Map(),
    injecting: null,
    originalChrome,
    styles: [],
    injectedPhases: new Set(),
    pageChrome: undefined,
  };
  worlds.set(win, world);

  // window.chrome is a writable but non-configurable data property, so it
  // can't become an accessor. Its value (the native object holding loadTimes
  // / csi / app) is an ordinary object though, so each content-script
  // namespace becomes a per-caller getter on it instead. Page scripts get
  // back whatever the page itself would have seen.
  const nativeChrome = originalChrome && typeof originalChrome === "object" ? (originalChrome as Record<string, unknown>) : null;
  if (nativeChrome) {
    const pageValues = new Map<string, unknown>();
    for (const name of CONTENT_NAMESPACES) {
      const own = Object.getOwnPropertyDescriptor(nativeChrome, name);
      if (own && !own.configurable) continue;
      if (own) pageValues.set(name, own.get ? own.get.call(nativeChrome) : own.value);
      try {
        Object.defineProperty(nativeChrome, name, {
          configurable: true,
          enumerable: false,
          get() {
            let ctx: ExtensionContext | null | undefined = world.injecting;
            if (!ctx) {
              const found = stackExtension();
              if (found) ctx = world.contexts.get(found.user ? `${found.extId}:user` : found.extId) ?? null;
            }
            if (ctx && ctx.alive && ctx.chrome) return (ctx.chrome as Record<string, unknown>)[name];
            if (pageValues.has(name)) return pageValues.get(name);
            return name === "runtime" ? (world.pageChrome as Record<string, unknown> | undefined)?.runtime : undefined;
          },
          set(value) {
            pageValues.set(name, value);
          },
        });
      } catch (e) {
        console.warn("[sapphire] could not install chrome." + name + " accessor", e);
      }
    }
  }
  if (s.registry.contentScripts.some((cs) => cs.world === "MAIN")) hookDefineProperty(world);
  world.pageChrome = buildExternallyConnectableChrome(s, world);
  return world;
}

/** The ISOLATED (or USER_SCRIPT) world context for `ext` in this frame. */
export function contentContext(s: Sapphire, world: ContentWorld, ext: ExtensionState, kind: ExecutionWorld = "ISOLATED"): ExtensionContext {
  const key = kind === "USER_SCRIPT" ? `${ext.id}:user` : ext.id;
  const existing = world.contexts.get(key);
  if (existing && existing.alive) return existing;
  const ctx = s.registry.createContext({
    ext,
    kind: "content",
    window: world.win,
    document: world.doc,
    tabId: world.tabId,
    frameId: world.frameId,
    documentId: world.documentId,
    url: world.url,
    world: kind,
  });
  ctx.chrome = buildChromeApi(s, ctx);
  world.contexts.set(key, ctx);
  return ctx;
}

// ---- script / style injection ------------------------------------------------

function appendTarget(doc: Document): Element | null {
  return doc.head ?? doc.documentElement ?? null;
}

/**
 * Run `code` synchronously in the frame through Scramjet's DOM hooks, so it
 * is rewritten exactly like page script. The element is removed right away:
 * content scripts leave no trace in the DOM.
 */
type DescriptorMap = Map<object, Map<string | symbol, PropertyDescriptor>>;

function patchTargets(win: Window): object[] {
  const w = win as Window & typeof globalThis & Record<string, { prototype?: object } | undefined>;
  const names = ["Document", "ShadowRoot", "Node", "Element", "HTMLElement", "EventTarget", "CSSStyleSheet", "CustomElementRegistry", "History", "HTMLStyleElement"];
  const out: object[] = [];
  for (const n of names) {
    const proto = w[n]?.prototype;
    if (proto) out.push(proto);
  }
  out.push(win);
  return out;
}

function snapshotDescriptors(win: Window): DescriptorMap {
  const map: DescriptorMap = new Map();
  for (const target of patchTargets(win)) {
    const keys = new Map<string | symbol, PropertyDescriptor>();
    for (const key of Reflect.ownKeys(target)) {
      const d = Object.getOwnPropertyDescriptor(target, key);
      if (d && d.configurable) keys.set(key, d);
    }
    map.set(target, keys);
  }
  return map;
}

function sameDescriptor(a: PropertyDescriptor, b: PropertyDescriptor): boolean {
  return a.value === b.value && a.get === b.get && a.set === b.set;
}

/**
 * A MAIN-world script may monkey-patch DOM prototypes — Dark Reader's proxy
 * hides its own stylesheets from `document.styleSheets`, for instance. Real
 * Chrome keeps that from the extension's isolated world. We share one JS
 * world, so afterwards swap each patched member for a dispatcher: calls that
 * originate in an extension content script reach the original implementation,
 * everything else the patch.
 */
function isolatedCaller(world: ContentWorld): boolean {
  const injecting = world.injecting;
  if (injecting) return injecting.world !== "MAIN";
  return stackExtension() !== null;
}

/** Descriptor that sends isolated-world callers to `orig` and everyone else to `patched`. */
function dispatchingDescriptor(world: ContentWorld, orig: PropertyDescriptor, patched: PropertyDescriptor): PropertyDescriptor | null {
  const dispatch = (fn: unknown, original: unknown): unknown =>
    typeof fn === "function" && typeof original === "function"
      ? new Proxy(fn as (...a: unknown[]) => unknown, {
          apply(t, thisArg, args) {
            return Reflect.apply(isolatedCaller(world) ? (original as (...a: unknown[]) => unknown) : t, thisArg, args);
          },
        })
      : fn;
  if (patched.get || patched.set || orig.get || orig.set) {
    return {
      configurable: true,
      enumerable: patched.enumerable,
      get: (dispatch(patched.get, orig.get) ?? orig.get) as () => unknown,
      set: (dispatch(patched.set, orig.set) ?? orig.set) as (v: unknown) => void,
    };
  }
  if (typeof patched.value === "function" && typeof orig.value === "function") {
    return { ...patched, value: dispatch(patched.value, orig.value) };
  }
  return null;
}

function isolatePatches(world: ContentWorld, before: DescriptorMap): void {
  for (const [target, keys] of before) {
    for (const [key, orig] of keys) {
      const now = Object.getOwnPropertyDescriptor(target, key);
      if (!now || !now.configurable || sameDescriptor(orig, now)) continue;
      const wrapped = dispatchingDescriptor(world, orig, now);
      if (!wrapped) continue;
      try {
        Object.defineProperty(target, key, wrapped);
      } catch {
        // frozen or otherwise unpatchable
      }
    }
  }
}

/** Patches made later (event handlers, timers) go through Object.defineProperty / Reflect.defineProperty. */
function hookDefineProperty(world: ContentWorld): void {
  const win = world.win as Window & typeof globalThis;
  const targets = new WeakSet<object>(patchTargets(win));
  const rewrite = (target: unknown, key: PropertyKey, desc: PropertyDescriptor): PropertyDescriptor => {
    if (!target || typeof target !== "object" || !targets.has(target as object)) return desc;
    const orig = Object.getOwnPropertyDescriptor(target, key);
    if (!orig || !orig.configurable) return desc;
    // Only patches coming from an extension's MAIN-world script need protecting from its own isolated world.
    const holder: { stack?: string } = {};
    V8Error.captureStackTrace(holder);
    if (!(holder.stack ?? "").includes("chrome-extension://")) return desc;
    return dispatchingDescriptor(world, orig, desc) ?? desc;
  };
  const nativeDefine = win.Object.defineProperty;
  const nativeReflect = win.Reflect.defineProperty;
  try {
    win.Object.defineProperty = new Proxy(nativeDefine, {
      apply: (t, thisArg, args) => Reflect.apply(t, thisArg, [args[0], args[1], rewrite(args[0], args[1], args[2])]),
    });
    win.Reflect.defineProperty = new Proxy(nativeReflect, {
      apply: (t, thisArg, args) => Reflect.apply(t, thisArg, [args[0], args[1], rewrite(args[0], args[1], args[2])]),
    });
  } catch {
    // ignore
  }
}

export function runScript(world: ContentWorld, code: string, sourceUrl: string, ctx: ExtensionContext | null): void {
  const doc = world.win.document;
  const target = appendTarget(doc);
  if (!target) return;
  const previous = world.injecting;
  world.injecting = ctx;
  const before = ctx === null ? snapshotDescriptors(world.win) : null;
  try {
    const script = doc.createElement("script");
    script.textContent = `${code}\n//# sourceURL=${sourceUrl}`;
    target.appendChild(script);
    script.remove();
  } catch (e) {
    console.warn("[sapphire] content script injection failed", sourceUrl, e);
  } finally {
    world.injecting = previous;
    if (before) isolatePatches(world, before);
  }
}

function sourceUrlFor(ext: ExtensionState, file: string, world: ExecutionWorld): string {
  if (world === "MAIN") return `chrome-extension://${ext.id}/${file.replace(/^\/+/, "")}`;
  // Real chrome-extension:// scheme, matching MAIN world and real Chrome's uniform
  // treatment of extension-injected code's sourceURL regardless of world — some
  // extensions (e.g. userscript managers) verify their own call stack against that
  // exact scheme. stackExtension() recognizes this form via the marker path segment.
  if (world === "USER_SCRIPT") return `chrome-extension://${ext.id}/__sapphire_user_script__/${file.replace(/^\/+/, "")}`;
  return extensionUrl(ext.id, file);
}

export function localizeCss(ext: ExtensionState, css: string): string {
  return css
    .replace(/__MSG_@@extension_id__/g, ext.id)
    .replace(/__MSG_([A-Za-z0-9_@]+)__/g, (m, name: string) => ext.messages[name]?.message ?? ext.messages[name.toLowerCase()]?.message ?? m)
    .replace(/chrome-extension:\/\/([a-z]{32})\//g, (_, id: string) => extensionUrl(id, ""));
}

export function injectStyle(world: ContentWorld, ext: ExtensionState, css: string, key: string): void {
  const doc = world.win.document;
  const target = appendTarget(doc);
  if (!target) return;
  try {
    const style = doc.createElement("style");
    style.textContent = localizeCss(ext, css);
    style.setAttribute("data-sapphire-extension", ext.id);
    target.appendChild(style);
    world.styles.push({ extId: ext.id, key, el: style });
  } catch (e) {
    console.warn("[sapphire] content style injection failed", e);
  }
}

export function removeStyle(world: ContentWorld, extId: string, key: string): void {
  for (let i = world.styles.length - 1; i >= 0; i--) {
    const s = world.styles[i];
    if (s.extId === extId && s.key === key) {
      s.el.remove();
      world.styles.splice(i, 1);
    }
  }
}

// ---- declared content scripts ---------------------------------------------

function effectiveUrl(world: ContentWorld, cs: ContentScriptRegistration): string | null {
  const url = world.url;
  if (/^(about:|data:|blob:|javascript:)/.test(url) || url === "") {
    if (!cs.matchAboutBlank) return null;
    try {
      const parent = world.win.parent !== world.win ? worlds.get(world.win.parent) : undefined;
      return parent?.url ?? null;
    } catch {
      return null;
    }
  }
  return url;
}

export function matchingRegistrations(s: Sapphire, world: ContentWorld): ContentScriptRegistration[] {
  const out: ContentScriptRegistration[] = [];
  for (const cs of s.registry.contentScripts) {
    const ext = s.registry.get(cs.extId);
    if (!ext?.enabled) continue;
    if (!world.isTop && !cs.allFrames) continue;
    const url = effectiveUrl(world, cs);
    if (!url || !urlMatchesContentScript(url, cs)) continue;
    out.push(cs);
  }
  // Chrome injects per extension in install order, manifest order within one.
  return out;
}

function injectRegistration(s: Sapphire, world: ContentWorld, cs: ContentScriptRegistration, phase: "css" | "js"): void {
  const ext = s.registry.get(cs.extId);
  if (!ext) return;
  if (phase === "css") {
    for (const file of cs.css) {
      const css = ext.files.readTextSync(file);
      if (css !== null) injectStyle(world, ext, css, `manifest:${file}`);
    }
    return;
  }
  const ctx = cs.world === "MAIN" ? null : contentContext(s, world, ext, cs.world);
  cs.js.forEach((entry, i) => {
    let code: string | null;
    let name: string;
    if ("file" in entry) {
      code = ext.files.readTextSync(entry.file);
      name = entry.file;
    } else {
      code = entry.code;
      name = `${cs.id ?? "script"}-${i}.js`;
    }
    if (code === null) {
      console.warn(`[sapphire] ${ext.manifest.name}: content script ${name} was not preloaded`);
      return;
    }
    runScript(world, code, sourceUrlFor(ext, name, cs.world), ctx);
  });
}

/**
 * Called from the frame's init hook (after Scramjet has hooked the realm,
 * before any page script runs). document_start happens right here;
 * document_end / document_idle are scheduled against the document lifecycle.
 */
export function startContentScripts(s: Sapphire, world: ContentWorld): void {
  const regs = matchingRegistrations(s, world);
  if (!regs.length) return;
  const byPhase: Record<RunAt, ContentScriptRegistration[]> = { document_start: [], document_end: [], document_idle: [] };
  for (const cs of regs) {
    injectRegistration(s, world, cs, "css");
    byPhase[cs.runAt].push(cs);
  }
  const run = (phase: RunAt) => {
    if (world.injectedPhases.has(phase)) return;
    if (worlds.get(world.win) !== world || world.win.document !== world.doc) return;
    world.injectedPhases.add(phase);
    for (const cs of byPhase[phase]) injectRegistration(s, world, cs, "js");
  };
  run("document_start");
  whenReady(world, "interactive", () => {
    run("document_end");
    // Chrome picks a moment between document_end and just after window.onload.
    let idleDone = false;
    const idle = () => {
      if (idleDone) return;
      idleDone = true;
      run("document_idle");
    };
    whenReady(world, "complete", idle);
    setTimeout(idle, 200);
  });
}

export function whenReady(world: ContentWorld, state: "interactive" | "complete", cb: () => void): void {
  const doc = world.doc;
  const reached = () => doc.readyState === "complete" || (state === "interactive" && doc.readyState === "interactive");
  if (reached()) {
    cb();
    return;
  }
  const onChange = () => {
    if (!reached()) return;
    doc.removeEventListener("readystatechange", onChange);
    cb();
  };
  doc.addEventListener("readystatechange", onChange);
}

// ---- scripting.executeScript / tabs.executeScript ---------------------------

export interface ScriptInjection {
  func?: string;
  args?: unknown[];
  files?: string[];
  code?: string;
  world: ExecutionWorld;
  injectImmediately?: boolean;
}

function compiles(expression: string): boolean {
  try {
    new Function(`return (${expression}\n);`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Function source from a Scramjet-rewritten realm. Scramjet maps
 * `toString()` back to the original text but its span can overrun by a few
 * characters (`(a) => a + 1)` for an arrow passed as an argument), so trim
 * trailing characters until the text parses as a function expression.
 */
export function repairFunctionSource(src: string): string {
  if (compiles(src)) return src;
  for (let cut = 1; cut <= Math.min(64, src.length - 1); cut++) {
    const candidate = src.slice(0, -cut).trimEnd();
    if (candidate && compiles(candidate)) return candidate;
  }
  // Method shorthand (`foo() {}`) isn't an expression on its own.
  if (compiles(`{${src}}`)) return `(${JSON.stringify("")}, {${src}})[Object.keys({${src}})[0]]`;
  return src;
}

export function executeInWorld(s: Sapphire, world: ContentWorld, ext: ExtensionState, injection: ScriptInjection): Promise<unknown> {
  return new Promise((resolve) => {
    const go = () => {
      const ctx = injection.world === "MAIN" ? null : contentContext(s, world, ext, injection.world);
      if (injection.files) {
        for (const file of injection.files) {
          const code = ext.files.readTextSync(file);
          if (code !== null) runScript(world, code, sourceUrlFor(ext, file, injection.world), ctx);
        }
        resolve(undefined);
        return;
      }
      const key = `__sapphire_result_${randomId(16)}`;
      let settled = false;
      const finish = (payload: { v?: unknown; e?: string }) => {
        if (settled) return;
        settled = true;
        try {
          delete (world.win as unknown as Record<string, unknown>)[key];
        } catch {
          // ignore
        }
        if (payload && "e" in payload && payload.e !== undefined) {
          try {
            (world.win as unknown as { console: Console }).console.error(payload.e);
          } catch {
            // ignore
          }
          resolve(undefined);
          return;
        }
        try {
          resolve(jsonClone(payload?.v));
        } catch {
          resolve(undefined);
        }
      };
      Object.defineProperty(world.win, key, { value: finish, configurable: true, enumerable: false });
      let expr: string;
      if (injection.func !== undefined) {
        expr = `(${repairFunctionSource(injection.func)})(...${JSON.stringify(injection.args ?? [])})`;
      } else {
        expr = `(0, eval)(${JSON.stringify(injection.code ?? "")})`;
      }
      const code = `(function(){var __f=window[${JSON.stringify(key)}];var __r;try{__r=${expr};}catch(e){__f({e:e&&e.stack||String(e)});return;}Promise.resolve(__r).then(function(v){__f({v:v});},function(e){__f({e:e&&e.stack||String(e)});});})();`;
      try {
        new Function(code);
      } catch (e) {
        finish({ e: `Error: ${(e as Error).message}` });
        return;
      }
      runScript(world, code, sourceUrlFor(ext, `__sapphire_execute_script__/${key}.js`, injection.world), ctx);
      if (!settled) setTimeout(() => finish({ v: undefined }), 30000);
    };
    if (injection.injectImmediately || world.doc.readyState !== "loading") go();
    else whenReady(world, "interactive", go);
  });
}

// ---- externally_connectable: chrome.runtime for matching web pages ----------

function buildExternallyConnectableChrome(s: Sapphire, world: ContentWorld): unknown {
  const exts = s.registry.list().filter((ext) => ext.enabled && ext.manifest.externally_connectable?.matches?.some((p) => matchPattern(p, world.url)));
  if (!exts.length) return undefined;
  return { runtime: s.externalRuntimeFor(world) };
}
