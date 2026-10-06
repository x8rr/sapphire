import { dbGet, dbGetAllKeysPrefix, EXT_FILES_STORE } from "./db";
import { guessMime } from "./crx";

const decoder = new TextDecoder();

/**
 * One extension's package files. Reads go to IndexedDB and are cached; text
 * that must be available synchronously (content scripts injected at
 * document_start, importScripts in a service worker) is preloaded.
 */
export class PackageFiles {
  private readonly bytes = new Map<string, ArrayBuffer | null>();
  private readonly text = new Map<string, string | null>();
  private list: Set<string> | null = null;

  readonly extId: string;

  constructor(extId: string, fileList?: string[]) {
    this.extId = extId;
    if (fileList?.length) this.list = new Set(fileList);
  }

  static normalize(path: string): string {
    return path.replace(/^(?:\.?\/)+/, "").replace(/\/{2,}/g, "/").replace(/\/\.\//g, "/");
  }

  async listFiles(): Promise<string[]> {
    if (!this.list) {
      const prefix = `${this.extId}/`;
      const keys = await dbGetAllKeysPrefix(EXT_FILES_STORE, prefix);
      this.list = new Set(keys.map((k) => k.slice(prefix.length)));
    }
    return [...this.list];
  }

  has(path: string): boolean | null {
    return this.list ? this.list.has(PackageFiles.normalize(path)) : null;
  }

  async read(path: string): Promise<ArrayBuffer | null> {
    const p = PackageFiles.normalize(path);
    if (this.bytes.has(p)) return this.bytes.get(p)!;
    if (this.list && !this.list.has(p)) return null;
    const ab = (await dbGet<ArrayBuffer>(EXT_FILES_STORE, `${this.extId}/${p}`)) ?? null;
    this.bytes.set(p, ab);
    return ab;
  }

  async readText(path: string): Promise<string | null> {
    const p = PackageFiles.normalize(path);
    if (this.text.has(p)) return this.text.get(p)!;
    const ab = await this.read(p);
    const text = ab ? decoder.decode(ab) : null;
    this.text.set(p, text);
    // Text is what callers keep asking for; don't hold both copies.
    if (text !== null) this.bytes.delete(p);
    return text;
  }

  readTextSync(path: string): string | null {
    return this.text.get(PackageFiles.normalize(path)) ?? null;
  }

  async preload(paths: string[]): Promise<void> {
    await Promise.all(paths.map((p) => this.readText(p)));
  }

  async preloadMatching(test: (path: string) => boolean): Promise<void> {
    const files = await this.listFiles();
    await this.preload(files.filter(test));
  }

  async blobUrl(path: string): Promise<string | null> {
    const ab = await this.read(path);
    if (!ab) return null;
    return URL.createObjectURL(new Blob([ab], { type: guessMime(path) }));
  }

  async dataUrl(path: string): Promise<string | null> {
    const ab = await this.read(path);
    if (!ab) return null;
    const bytes = new Uint8Array(ab);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return `data:${guessMime(path)};base64,${btoa(binary)}`;
  }
}
