// Browser-level state that extensions read through chrome.history /
// chrome.bookmarks / chrome.topSites / chrome.sessions. Sapphire sees every
// top-level navigation in every tab, so history is real, not a stub.
import { dbGet, dbPut, EXT_STATE_STORE } from "./db";

export interface HistoryItem {
  id: string;
  url: string;
  title: string;
  lastVisitTime: number;
  visitCount: number;
  typedCount: number;
  visits: { visitId: string; visitTime: number; referringVisitId: string; transition: string }[];
}

export interface BookmarkNode {
  id: string;
  parentId?: string;
  index?: number;
  url?: string;
  title: string;
  dateAdded: number;
  dateGroupModified?: number;
  dateLastUsed?: number;
  folderType?: string;
  syncing: boolean;
  unmodifiable?: "managed";
  children?: BookmarkNode[];
}

export interface ClosedTab {
  sessionId: string;
  lastModified: number;
  url: string;
  title: string;
}

const MAX_HISTORY = 5000;

export class BrowserData {
  history: HistoryItem[] = [];
  bookmarks: BookmarkNode;
  closedTabs: ClosedTab[] = [];
  private nextId = 1;
  private nextVisit = 1;
  private loaded: Promise<void> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.bookmarks = BrowserData.emptyTree();
  }

  static emptyTree(): BookmarkNode {
    const now = Date.now();
    return {
      id: "0",
      title: "",
      dateAdded: now,
      syncing: false,
      children: [
        { id: "1", parentId: "0", index: 0, title: "Bookmarks bar", dateAdded: now, folderType: "bookmarks-bar", syncing: false, children: [] },
        { id: "2", parentId: "0", index: 1, title: "Other bookmarks", dateAdded: now, folderType: "other", syncing: false, children: [] },
      ],
    };
  }

  load(): Promise<void> {
    if (!this.loaded) {
      this.loaded = (async () => {
        const stored = await dbGet<{ history: HistoryItem[]; bookmarks: BookmarkNode; nextId: number; nextVisit: number }>(EXT_STATE_STORE, "__browser/data").catch(() => undefined);
        if (stored) {
          this.history = stored.history ?? [];
          this.bookmarks = stored.bookmarks ?? BrowserData.emptyTree();
          this.nextId = stored.nextId ?? 100;
          this.nextVisit = stored.nextVisit ?? 1;
        } else {
          this.nextId = 100;
        }
      })();
    }
    return this.loaded;
  }

  save(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void dbPut(EXT_STATE_STORE, "__browser/data", { history: this.history, bookmarks: this.bookmarks, nextId: this.nextId, nextVisit: this.nextVisit }).catch(() => {});
    }, 500);
  }

  id(): string {
    return String(this.nextId++);
  }

  recordVisit(url: string, title: string, transition = "link"): { item: HistoryItem; isNew: boolean } {
    const now = Date.now();
    let item = this.history.find((h) => h.url === url);
    const isNew = !item;
    if (!item) {
      item = { id: this.id(), url, title, lastVisitTime: now, visitCount: 0, typedCount: 0, visits: [] };
      this.history.unshift(item);
      if (this.history.length > MAX_HISTORY) this.history.length = MAX_HISTORY;
    }
    item.visitCount++;
    item.lastVisitTime = now;
    if (title) item.title = title;
    if (transition === "typed") item.typedCount++;
    item.visits.push({ visitId: String(this.nextVisit++), visitTime: now, referringVisitId: "0", transition });
    if (item.visits.length > 50) item.visits.splice(0, item.visits.length - 50);
    this.history.sort((a, b) => b.lastVisitTime - a.lastVisitTime);
    this.save();
    return { item, isNew };
  }

  updateTitle(url: string, title: string): void {
    const item = this.history.find((h) => h.url === url);
    if (item && title && item.title !== title) {
      item.title = title;
      this.save();
    }
  }

  findBookmark(id: string, node: BookmarkNode = this.bookmarks): BookmarkNode | null {
    if (node.id === id) return node;
    for (const child of node.children ?? []) {
      const found = this.findBookmark(id, child);
      if (found) return found;
    }
    return null;
  }

  walkBookmarks(fn: (node: BookmarkNode) => void, node: BookmarkNode = this.bookmarks): void {
    fn(node);
    for (const child of node.children ?? []) this.walkBookmarks(fn, child);
  }

  reindex(parent: BookmarkNode): void {
    (parent.children ?? []).forEach((c, i) => (c.index = i));
  }
}
