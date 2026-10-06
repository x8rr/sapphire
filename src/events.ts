export type Listener = (...args: any[]) => any;

export interface ListenerEntry {
  fn: Listener;
  /** Extra addListener arguments: webRequest filters, webNavigation url filters, ... */
  extra: unknown[];
}

interface DeclarativeRule {
  id?: string;
  priority?: number;
  conditions?: unknown[];
  actions?: unknown[];
  tags?: string[];
}

let ruleCounter = 0;

export class ChromeEvent {
  entries: ListenerEntry[] = [];
  rules: DeclarativeRule[] = [];

  readonly name: string;
  private readonly label: string;
  private readonly validate?: (extra: unknown[]) => void;

  constructor(name: string, label = "", validate?: (extra: unknown[]) => void) {
    this.name = name;
    this.label = label;
    this.validate = validate;
  }

  addListener = (fn: Listener, ...extra: unknown[]): void => {
    if (typeof fn !== "function") {
      throw new TypeError(`Error in invocation of ${this.name}.addListener: No matching signature.`);
    }
    this.validate?.(extra);
    if (!this.entries.some((e) => e.fn === fn)) this.entries.push({ fn, extra });
  };

  removeListener = (fn: Listener): void => {
    const i = this.entries.findIndex((e) => e.fn === fn);
    if (i > -1) this.entries.splice(i, 1);
  };

  hasListener = (fn: Listener): boolean => this.entries.some((e) => e.fn === fn);

  hasListeners = (): boolean => this.entries.length > 0;

  addRules = (rules: DeclarativeRule[], cb?: (rules: DeclarativeRule[]) => void): void => {
    const added = (rules ?? []).map((r) => ({ ...r, id: r.id ?? `_${++ruleCounter}`, priority: r.priority ?? 100 }));
    for (const rule of added) {
      const existing = this.rules.findIndex((r) => r.id === rule.id);
      if (existing > -1) this.rules.splice(existing, 1);
      this.rules.push(rule);
    }
    cb?.(added);
  };

  getRules = (idsOrCb?: string[] | ((rules: DeclarativeRule[]) => void), maybeCb?: (rules: DeclarativeRule[]) => void): void => {
    const ids = Array.isArray(idsOrCb) ? idsOrCb : null;
    const cb = typeof idsOrCb === "function" ? idsOrCb : maybeCb;
    cb?.(ids ? this.rules.filter((r) => ids.includes(r.id!)) : [...this.rules]);
  };

  removeRules = (idsOrCb?: string[] | (() => void), maybeCb?: () => void): void => {
    const ids = Array.isArray(idsOrCb) ? idsOrCb : null;
    const cb = typeof idsOrCb === "function" ? idsOrCb : maybeCb;
    this.rules = ids ? this.rules.filter((r) => !ids.includes(r.id!)) : [];
    cb?.();
  };

  /** Deliver asynchronously, one task per listener, like the browser does. */
  dispatch(...args: unknown[]): void {
    this.dispatchFiltered(() => true, () => args);
  }

  dispatchFiltered(accept: (entry: ListenerEntry) => boolean, makeArgs: (entry: ListenerEntry) => unknown[]): void {
    for (const entry of [...this.entries]) {
      if (!accept(entry)) continue;
      queueMicrotask(() => {
        if (!this.entries.includes(entry)) return;
        this.invoke(entry, makeArgs(entry));
      });
    }
  }

  /** Synchronous dispatch that collects return values (blocking webRequest, onMessage). */
  dispatchSync(accept: (entry: ListenerEntry) => boolean, makeArgs: (entry: ListenerEntry) => unknown[]): unknown[] {
    const results: unknown[] = [];
    for (const entry of [...this.entries]) {
      if (!accept(entry)) continue;
      results.push(this.invoke(entry, makeArgs(entry)));
    }
    return results;
  }

  invoke(entry: ListenerEntry, args: unknown[]): unknown {
    try {
      return entry.fn(...args);
    } catch (e) {
      console.error(`[sapphire]${this.label ? ` ${this.label}:` : ""} Error in event handler for ${this.name}:`, e);
      return undefined;
    }
  }

  clear(): void {
    this.entries = [];
  }

  toApi() {
    return {
      addListener: this.addListener,
      removeListener: this.removeListener,
      hasListener: this.hasListener,
      hasListeners: this.hasListeners,
      addRules: this.addRules,
      getRules: this.getRules,
      removeRules: this.removeRules,
    };
  }
}

/** Lazily-created named events owned by one context. */
export class EventTable {
  private readonly events = new Map<string, ChromeEvent>();

  private readonly label: string;

  constructor(label = "") {
    this.label = label;
  }

  get(name: string, validate?: (extra: unknown[]) => void): ChromeEvent {
    let ev = this.events.get(name);
    if (!ev) {
      ev = new ChromeEvent(name, this.label, validate);
      this.events.set(name, ev);
    }
    return ev;
  }

  peek(name: string): ChromeEvent | undefined {
    return this.events.get(name);
  }

  api(name: string, validate?: (extra: unknown[]) => void) {
    return this.get(name, validate).toApi();
  }

  clear(): void {
    for (const ev of this.events.values()) ev.clear();
    this.events.clear();
  }
}
