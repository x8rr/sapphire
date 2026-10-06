import type { ExtensionContext } from "./registry";

type RealmWindow = Window & typeof globalThis;

/** An error meant for the extension: becomes runtime.lastError or a rejection. */
export class ApiError extends Error {}

export function realmOf(ctx: ExtensionContext): RealmWindow {
  return ctx.window as RealmWindow;
}

/**
 * Values handed to extension code are created in the extension's own realm so
 * `instanceof Array`, `x.constructor === Object` and friends behave. Things
 * that can't be cloned (windows, functions, ports) pass through as-is.
 */
export function toRealm<T>(ctx: ExtensionContext, value: T): T {
  if (value === null || value === undefined || typeof value !== "object") return value;
  try {
    return realmOf(ctx).structuredClone(value);
  } catch {
    return value;
  }
}

/** Message passing serialises with JSON in Chrome; mirror it into the target realm. */
export function jsonToRealm(ctx: ExtensionContext, value: unknown): unknown {
  if (value === undefined) return undefined;
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    return undefined;
  }
  if (text === undefined) return null;
  try {
    return realmOf(ctx).JSON.parse(text);
  } catch {
    return JSON.parse(text);
  }
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error || (e && typeof e === "object" && "message" in e)) return String((e as Error).message);
  return String(e);
}

export function realmError(ctx: ExtensionContext, message: string): Error {
  try {
    return new (realmOf(ctx).Error)(message);
  } catch {
    return new Error(message);
  }
}

export function realmTypeError(ctx: ExtensionContext, message: string): TypeError {
  try {
    return new (realmOf(ctx).TypeError)(message);
  } catch {
    return new TypeError(message);
  }
}

export function realmPromise<T>(ctx: ExtensionContext, p: Promise<T>, raw = false): Promise<T> {
  let PromiseCtor: PromiseConstructor = Promise;
  try {
    PromiseCtor = realmOf(ctx).Promise;
  } catch {
    // realm gone
  }
  return new PromiseCtor<T>((resolve, reject) => {
    p.then(
      (v) => resolve(raw ? v : toRealm(ctx, v)),
      (e) => reject(realmError(ctx, errorMessage(e))),
    );
  });
}

export function invokeCallback(ctx: ExtensionContext, cb: (...args: unknown[]) => unknown, args: unknown[]): void {
  if (!ctx.alive) return;
  try {
    cb(...args);
  } catch (e) {
    reportListenerError(ctx, e);
  }
}

export function invokeCallbackWithError(ctx: ExtensionContext, cb: (...args: unknown[]) => unknown, message: string, args: unknown[] = []): void {
  if (!ctx.alive) return;
  const previous = ctx.lastError;
  const previousChecked = ctx.lastErrorChecked;
  ctx.lastError = { message };
  ctx.lastErrorChecked = false;
  try {
    cb(...args);
  } catch (e) {
    reportListenerError(ctx, e);
  } finally {
    if (!ctx.lastErrorChecked) realmConsole(ctx).error(`Unchecked runtime.lastError: ${message}`);
    ctx.lastError = previous;
    ctx.lastErrorChecked = previousChecked;
  }
}

export function reportListenerError(ctx: ExtensionContext, e: unknown): void {
  try {
    realmConsole(ctx).error(e);
  } catch {
    console.error(e);
  }
}

export function realmConsole(ctx: ExtensionContext): Console {
  try {
    return realmOf(ctx).console;
  } catch {
    return console;
  }
}

export interface AsyncApiOptions {
  /** Don't clone the result into the realm (windows, live objects). */
  raw?: boolean;
  /** Arguments to pass the callback, given the resolved value. Default: [value]. */
  callbackArgs?: (value: unknown) => unknown[];
  /** Callback position when it isn't the trailing argument. */
  requireCallback?: boolean;
}

/**
 * Chrome's dual calling convention: a trailing callback gets the result (with
 * runtime.lastError set on failure), otherwise a Promise is returned.
 */
export function asyncApi<A extends unknown[]>(
  ctx: ExtensionContext,
  impl: (...args: A) => unknown,
  options: AsyncApiOptions = {},
): (...args: unknown[]) => unknown {
  return function sapphireApi(...args: unknown[]) {
    let cb: ((...a: unknown[]) => unknown) | undefined;
    if (args.length && typeof args[args.length - 1] === "function") cb = args.pop() as typeof cb;
    else while (args.length && args[args.length - 1] === undefined) args.pop();
    let p: Promise<unknown>;
    try {
      p = Promise.resolve(impl(...(args as A)));
    } catch (e) {
      if (e instanceof TypeError) throw realmTypeError(ctx, e.message);
      p = Promise.reject(e);
    }
    if (cb) {
      const callback = cb;
      p.then(
        (value) => {
          const out = options.raw ? value : toRealm(ctx, value);
          invokeCallback(ctx, callback, options.callbackArgs ? options.callbackArgs(out) : value === undefined ? [] : [out]);
        },
        (e) => invokeCallbackWithError(ctx, callback, errorMessage(e)),
      );
      return undefined;
    }
    return realmPromise(ctx, p, options.raw);
  };
}

/** Synchronous API that also accepts (and invokes) an optional trailing callback. */
export function syncApi<A extends unknown[]>(ctx: ExtensionContext, impl: (...args: A) => unknown): (...args: unknown[]) => unknown {
  return function sapphireSyncApi(...args: unknown[]) {
    let cb: ((...a: unknown[]) => unknown) | undefined;
    if (args.length && typeof args[args.length - 1] === "function") cb = args.pop() as typeof cb;
    const result = impl(...(args as A));
    if (cb) {
      const callback = cb;
      queueMicrotask(() => invokeCallback(ctx, callback, []));
    }
    return toRealm(ctx, result);
  };
}

export function lastErrorGetter(ctx: ExtensionContext) {
  return {
    get() {
      ctx.lastErrorChecked = true;
      return ctx.lastError ? toRealm(ctx, ctx.lastError) : undefined;
    },
    enumerable: true,
    configurable: true,
  } satisfies PropertyDescriptor;
}

export function randomId(len = 32): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len / 2));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}
