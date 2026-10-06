const DB_NAME = "sapphire_extensions";
const DB_VERSION = 2;

export const EXT_STORE = "extensions";
export const EXT_FILES_STORE = "extension_files";
export const EXT_STORAGE_STORE = "extension_storage";
export const EXT_STATE_STORE = "extension_state";

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(EXT_STORE)) {
        db.createObjectStore(EXT_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(EXT_FILES_STORE)) {
        db.createObjectStore(EXT_FILES_STORE);
      }
      if (!db.objectStoreNames.contains(EXT_STATE_STORE)) {
        db.createObjectStore(EXT_STATE_STORE);
      }
      if (!db.objectStoreNames.contains(EXT_STORAGE_STORE)) {
        db.createObjectStore(EXT_STORAGE_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

export async function dbGet<T = unknown>(store: string, key: IDBValidKey): Promise<T | undefined> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

export async function dbPut(store: string, key: IDBValidKey | null, value: unknown): Promise<IDBValidKey> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    const objStore = tx.objectStore(store);
    const req = key === null ? objStore.put(value) : objStore.put(value, key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function dbDelete(store: string, key: IDBValidKey): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    const req = tx.objectStore(store).delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function dbGetAll<T = unknown>(store: string): Promise<T[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result as T[]);
    req.onerror = () => reject(req.error);
  });
}

export async function dbGetAllKeys(store: string): Promise<IDBValidKey[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const req = tx.objectStore(store).getAllKeys();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Several puts/deletes in one transaction; `undefined` values are deletes. */
export async function dbWriteMany(store: string, entries: [IDBValidKey, unknown][]): Promise<void> {
  if (!entries.length) return;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    const objStore = tx.objectStore(store);
    for (const [key, value] of entries) {
      if (value === undefined) objStore.delete(key);
      else objStore.put(value, key);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** Every [key, value] whose string key starts with `prefix`. */
export async function dbGetPrefix<T = unknown>(store: string, prefix: string): Promise<[string, T][]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const range = IDBKeyRange.bound(prefix, `${prefix}￿`);
    const out: [string, T][] = [];
    const req = tx.objectStore(store).openCursor(range);
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) {
        resolve(out);
        return;
      }
      out.push([cursor.key as string, cursor.value as T]);
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

export async function dbDeletePrefix(store: string, prefix: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).delete(IDBKeyRange.bound(prefix, `${prefix}￿`));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function dbGetAllKeysPrefix(store: string, prefix: string): Promise<string[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const req = tx.objectStore(store).getAllKeys(IDBKeyRange.bound(prefix, `${prefix}￿`));
    req.onsuccess = () => resolve(req.result as string[]);
    req.onerror = () => reject(req.error);
  });
}
