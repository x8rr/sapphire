const wrapCache = new WeakMap<object, object>();

export function withMissingMemberFallback<T extends object>(real: T): T {
  const cached = wrapCache.get(real);
  if (cached) return cached as T;
  const proxy = new Proxy(real, {
    get(target, prop, receiver) {
      if (prop in target) {
        const value = Reflect.get(target, prop, receiver);
        if (value !== null && typeof value === "object" && !Array.isArray(value)) {
          return withMissingMemberFallback(value as object);
        }
        return value;
      }
      if (typeof prop !== "string") return undefined;
      return createAutoStub();
    },
  });
  wrapCache.set(real, proxy);
  return proxy as T;
}

function createAutoStub(): unknown {
  const cache = new Map<string, unknown>();
  const target = () => {};
  return new Proxy(target, {
    get(_t, prop) {
      if (prop === Symbol.toPrimitive) {
        return (hint: string) => (hint === "number" ? 0 : "");
      }
      if (typeof prop !== "string") return undefined;
      if (prop === "toJSON") return undefined;
      if (prop === "valueOf") return () => 0;
      if (prop === "toString") return () => "";
      if (prop === "then") {
        return (resolve?: (v: unknown) => void) => resolve?.(undefined);
      }
      const cached = cache.get(prop);
      if (cached !== undefined) return cached;
      let value: unknown;
      if (prop === "addListener" || prop === "removeListener") value = () => {};
      else if (prop === "hasListener") value = () => false;
      else value = createAutoStub();
      cache.set(prop, value);
      return value;
    },
    apply(_t, _thisArg, args) {
      const cb = args[args.length - 1];
      if (typeof cb === "function") {
        try {
          cb(undefined);
        } catch {
        }
      }
      return createAutoStub();
    },
  });
}
