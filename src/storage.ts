import { dbGetPrefix, dbWriteMany, dbDeletePrefix, EXT_STORAGE_STORE } from "./db";

export type StorageAreaName = "local" | "sync" | "session" | "managed";
export type StorageChanges = Record<string, { oldValue?: unknown; newValue?: unknown }>;

export const QUOTAS: Record<StorageAreaName, Record<string, number>> = {
  local: { QUOTA_BYTES: 10485760 },
  sync: {
    QUOTA_BYTES: 102400,
    QUOTA_BYTES_PER_ITEM: 8192,
    MAX_ITEMS: 512,
    MAX_WRITE_OPERATIONS_PER_HOUR: 1800,
    MAX_WRITE_OPERATIONS_PER_MINUTE: 120,
    MAX_SUSTAINED_WRITE_OPERATIONS_PER_MINUTE: 1000000,
  },
  session: { QUOTA_BYTES: 10485760 },
  managed: {},
};

/**
 * chrome.storage values round-trip through JSON in the browser, so a Date
 * comes back as a string, `undefined` members disappear and Maps turn into
 * `{}`. Reproducing that keeps extensions from depending on behaviour they
 * would never see in Chrome.
 */
export function jsonClone<T>(value: T): T {
  if (value === undefined) return value;
  const s = JSON.stringify(value);
  return s === undefined ? (undefined as T) : JSON.parse(s);
}

/**
 * All contexts of an extension live in this one page, so a single in-memory
 * copy per area is coherent across background, popups and content scripts.
 * IndexedDB is only the persistence layer, written in order behind it.
 */
export class StorageArea {
  private data: Map<string, unknown> | null = null;
  private loading: Promise<void> | null = null;
  private writeChain: Promise<void> = Promise.resolve();

  readonly extId: string;
  readonly area: StorageAreaName;
  private readonly persistent: boolean;

  constructor(extId: string, area: StorageAreaName, persistent: boolean) {
    this.extId = extId;
    this.area = area;
    this.persistent = persistent;
  }

  private prefix(): string {
    return `${this.extId}/${this.area}/`;
  }

  private async ensure(): Promise<Map<string, unknown>> {
    if (this.data) return this.data;
    if (!this.loading) {
      this.loading = (async () => {
        const map = new Map<string, unknown>();
        if (this.persistent) {
          for (const [key, value] of await dbGetPrefix(EXT_STORAGE_STORE, this.prefix())) {
            map.set(key.slice(this.prefix().length), value);
          }
        }
        this.data = map;
      })();
    }
    await this.loading;
    return this.data!;
  }

  private persist(entries: [string, unknown][]): void {
    if (!this.persistent || !entries.length) return;
    const prefixed = entries.map(([k, v]) => [`${this.prefix()}${k}`, v] as [string, unknown]);
    this.writeChain = this.writeChain
      .then(() => dbWriteMany(EXT_STORAGE_STORE, prefixed))
      .catch((e) => console.error(`[sapphire] storage.${this.area} write failed`, e));
  }

  async get(keys: unknown): Promise<Record<string, unknown>> {
    const data = await this.ensure();
    const out: Record<string, unknown> = {};
    if (keys === null || keys === undefined) {
      for (const [k, v] of data) out[k] = jsonClone(v);
    } else if (typeof keys === "string") {
      if (data.has(keys)) out[keys] = jsonClone(data.get(keys));
    } else if (Array.isArray(keys)) {
      for (const k of keys) if (data.has(String(k))) out[String(k)] = jsonClone(data.get(String(k)));
    } else if (typeof keys === "object") {
      for (const [k, def] of Object.entries(keys as Record<string, unknown>)) {
        out[k] = data.has(k) ? jsonClone(data.get(k)) : def;
      }
    } else {
      throw new Error("Invalid value for argument 1. Expected null, string, array or object.");
    }
    return out;
  }

  async getKeys(): Promise<string[]> {
    return [...(await this.ensure()).keys()];
  }

  async set(items: Record<string, unknown>): Promise<StorageChanges> {
    if (!items || typeof items !== "object" || Array.isArray(items)) {
      throw new Error("Error in invocation of storage.set(object items, optional function callback): No matching signature.");
    }
    const data = await this.ensure();
    const changes: StorageChanges = {};
    const writes: [string, unknown][] = [];
    for (const [key, raw] of Object.entries(items)) {
      if (raw === undefined) continue;
      const value = jsonClone(raw);
      const had = data.has(key);
      const old = data.get(key);
      data.set(key, value);
      writes.push([key, value]);
      if (!had || JSON.stringify(old) !== JSON.stringify(value)) {
        changes[key] = had ? { oldValue: jsonClone(old), newValue: jsonClone(value) } : { newValue: jsonClone(value) };
      }
    }
    this.persist(writes);
    return changes;
  }

  async remove(keys: string | string[]): Promise<StorageChanges> {
    const data = await this.ensure();
    const changes: StorageChanges = {};
    const writes: [string, unknown][] = [];
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      if (!data.has(key)) continue;
      changes[key] = { oldValue: jsonClone(data.get(key)) };
      data.delete(key);
      writes.push([key, undefined]);
    }
    this.persist(writes);
    return changes;
  }

  async clear(): Promise<StorageChanges> {
    const data = await this.ensure();
    const changes: StorageChanges = {};
    for (const [k, v] of data) changes[k] = { oldValue: jsonClone(v) };
    data.clear();
    if (this.persistent) {
      this.writeChain = this.writeChain.then(() => dbDeletePrefix(EXT_STORAGE_STORE, this.prefix())).catch(() => {});
    }
    return changes;
  }

  async bytesInUse(keys: unknown): Promise<number> {
    const data = await this.ensure();
    const selected = keys === null || keys === undefined ? [...data.keys()] : Array.isArray(keys) ? keys.map(String) : [String(keys)];
    let total = 0;
    for (const k of selected) {
      if (!data.has(k)) continue;
      total += k.length + (JSON.stringify(data.get(k))?.length ?? 0);
    }
    return total;
  }

  /** Wipe persisted data (uninstall). */
  async destroy(): Promise<void> {
    this.data = new Map();
    if (this.persistent) await dbDeletePrefix(EXT_STORAGE_STORE, this.prefix());
  }
}
