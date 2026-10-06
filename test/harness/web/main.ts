import { Controller, type Frame } from "@mercuryworkshop/scramjet-controller";
import LibcurlTransport from "@mercuryworkshop/libcurl-transport";
import { Sapphire } from "../../../src";
import type { ContextMenuEntry, ContextMenuShowRequest, TabInfo } from "../../../src";

// A tiny browser around Sapphire: tabs, URL bar, extension toolbar + popups,
// an extension manager and a log. Also exposes `window.harness` for the test runner.

interface HarnessTab {
  id: number;
  iframe: HTMLIFrameElement;
  frame: Frame;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = $("status");
const tabsEl = $("tabs");
const popupEl = $<HTMLIFrameElement>("popup");
const logs: string[] = [];
const notifications: { extId: string; id: string; options: unknown; click: () => void; buttonClick: (i: number) => void }[] = [];
const contextMenus: ContextMenuShowRequest[] = [];
const popups: string[] = [];
const sidePanels: { extId: string; path: string }[] = [];

let controller: Controller;
let nextTabId = 1;
let activeTabId: number | null = null;
let popupExt: string | null = null;
const tabs = new Map<number, HarnessTab>();

// ---- helpers -----------------------------------------------------------------

function safeString(v: unknown): string {
  try {
    return typeof v === "string" ? v : v instanceof Error ? `${v.name}: ${v.message}` : JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function tabUrl(tab: HarnessTab): string {
  try {
    const loc = tab.iframe.contentWindow?.location;
    if (!loc) return "";
    const path = loc.pathname;
    if (!path.startsWith(tab.frame.prefix)) return loc.href;
    return decodeURIComponent(path.slice(tab.frame.prefix.length)) + loc.hash;
  } catch {
    return "";
  }
}

function tabTitle(tab: HarnessTab): string {
  try {
    return tab.iframe.contentDocument?.title ?? "";
  } catch {
    return "";
  }
}

function tabInfo(tab: HarnessTab): TabInfo {
  return { id: tab.id, windowId: 1, url: tabUrl(tab), title: tabTitle(tab), active: tab.id === activeTabId, index: [...tabs.keys()].indexOf(tab.id) };
}

function toast(text: string, onClick?: () => void): void {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = text;
  el.onclick = () => {
    onClick?.();
    el.remove();
  };
  $("toasts").append(el);
  setTimeout(() => el.remove(), 6000);
}

function addLog(level: string, text: string): void {
  logs.push(`[${level}] ${text}`);
  const log = $("log");
  const line = document.createElement("div");
  line.className = level;
  line.textContent = `[${level}] ${text}`;
  log.append(line);
  while (log.childElementCount > 400) log.firstElementChild!.remove();
  log.scrollTop = log.scrollHeight;
}

// ---- Sapphire host -------------------------------------------------------------

const sapphire = new Sapphire({
  host: {
    getTabId: (win) => {
      for (const tab of tabs.values()) if (tab.iframe.contentWindow === win) return tab.id;
      return null;
    },
    getTab: (id) => {
      const tab = tabs.get(id);
      return tab ? tabInfo(tab) : null;
    },
    getAllTabs: () => [...tabs.values()].map(tabInfo),
    getActiveTabId: () => activeTabId,
    getTabWindow: (id) => tabs.get(id)?.iframe.contentWindow ?? null,
    createTab: (url, { active }) => openTab(url || "about:blank", active),
    navigateTab: (id, url) => (id === null ? void openTab(url, true) : navigate(id, url)),
    closeTab: (id) => closeTab(id),
    reloadTab: (id) => tabs.get(id)?.frame.reload(),
    activateTab: (id) => activate(id),
    goBack: (id) => tabs.get(id)?.frame.back(),
    goForward: (id) => tabs.get(id)?.frame.forward(),
    openPopup: (extId, tabId) => {
      popups.push(extId);
      popupExt = extId;
      $("popupwrap").classList.add("open");
      void sapphire.mountExtensionPopup(popupEl, extId, tabId);
      return true;
    },
    closePopup: (extId) => {
      popups.push(`closed:${extId}`);
      hidePopup();
    },
    openSidePanel: (extId, path) => {
      sidePanels.push({ extId, path });
      toast(`side panel requested: ${path}`);
    },
    createNotification: (extId, id, options, callbacks) => {
      notifications.push({ extId, id, options, click: callbacks.click, buttonClick: callbacks.buttonClick });
      const o = options as { title?: string; message?: string };
      toast(`${o.title ?? ""}\n${o.message ?? ""}`.trim(), () => callbacks.click());
    },
    showContextMenu: (request) => {
      contextMenus.push(request);
      renderContextMenu(request);
    },
    requestPermissions: (extId, perms, origins) => confirm(`Extension ${extId} requests:\n${[...perms, ...origins].join("\n")}`),
  },
});

function hidePopup(): void {
  if (popupExt) sapphire.unmountExtensionPopup(popupEl);
  popupExt = null;
  $("popupwrap").classList.remove("open");
}

// ---- tabs ------------------------------------------------------------------------

function openTab(url: string, active = true): number {
  const id = nextTabId++;
  const iframe = document.createElement("iframe");
  iframe.dataset.tabId = String(id);
  tabsEl.appendChild(iframe);
  const frame = controller.createFrame(iframe, { plugins: [sapphire.createPlugin(id)] });
  tabs.set(id, { id, iframe, frame });
  if (active || activeTabId === null) activeTabId = id;
  sapphire.notifyTabCreated(id);
  if (active) sapphire.notifyTabActivated(id);
  frame.go(sapphire.resolveUrl(url));
  renderTabs();
  return id;
}

function navigate(id: number, url: string): void {
  tabs.get(id)?.frame.go(sapphire.resolveUrl(url));
}

function closeTab(id: number): void {
  const tab = tabs.get(id);
  if (!tab) return;
  tab.iframe.remove();
  tabs.delete(id);
  if (activeTabId === id) activeTabId = [...tabs.keys()].pop() ?? null;
  sapphire.notifyTabRemoved(id);
  renderTabs();
}

function activate(id: number): void {
  activeTabId = id;
  sapphire.notifyTabActivated(id);
  renderTabs();
}

function renderTabs(): void {
  const strip = $("tabstrip");
  strip.textContent = "";
  for (const tab of tabs.values()) {
    tab.iframe.classList.toggle("active", tab.id === activeTabId);
    const el = document.createElement("div");
    el.className = `tab${tab.id === activeTabId ? " active" : ""}`;
    const label = document.createElement("span");
    label.textContent = tabTitle(tab) || sapphire.displayUrl(tabUrl(tab)) || "New tab";
    const x = document.createElement("button");
    x.textContent = "×";
    x.onclick = (e) => {
      e.stopPropagation();
      closeTab(tab.id);
    };
    el.append(label, x);
    el.onclick = () => activate(tab.id);
    strip.append(el);
  }
  const plus = document.createElement("button");
  plus.id = "newtab";
  plus.textContent = "+";
  plus.onclick = () => openTab(`${location.origin}/home.html`);
  strip.append(plus);
  const input = $<HTMLInputElement>("url");
  if (document.activeElement !== input) {
    const active = activeTabId !== null ? tabs.get(activeTabId) : undefined;
    input.value = active ? sapphire.displayUrl(tabUrl(active)) : "";
  }
  renderToolbar();
}

// ---- extension toolbar & manager --------------------------------------------------

function renderToolbar(): void {
  const wrap = $("exticons");
  wrap.textContent = "";
  for (const ext of sapphire.getInstalledExtensions(activeTabId)) {
    if (!ext.enabled) continue;
    const b = document.createElement("button");
    b.className = `iconbtn exticon${ext.actionEnabled ? "" : " disabled"}`;
    b.title = ext.title ?? ext.name;
    if (ext.iconUrl) {
      const img = document.createElement("img");
      img.src = ext.iconUrl;
      b.append(img);
    } else b.textContent = ext.name[0] ?? "?";
    if (ext.badgeText) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = ext.badgeText;
      if (ext.badgeColor) badge.style.background = ext.badgeColor;
      b.append(badge);
    }
    b.onclick = (e) => {
      e.stopPropagation();
      if (popupExt === ext.id) return hidePopup();
      hidePopup();
      sapphire.clickAction(ext.id, activeTabId);
    };
    wrap.append(b);
  }
}

function renderList(): void {
  const list = $("list");
  list.textContent = "";
  const exts = sapphire.getInstalledExtensions(activeTabId);
  if (!exts.length) list.textContent = "Nothing installed yet.";
  for (const ext of exts) {
    const row = document.createElement("div");
    row.className = "ext";
    const img = document.createElement("img");
    img.src = ext.iconUrl ?? "";
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.innerHTML = `<div class="name"></div><div class="sub"></div><div class="sub"></div><div class="acts"></div>`;
    (meta.querySelector(".name") as HTMLElement).textContent = `${ext.name} ${ext.version ?? ""}`;
    const subs = meta.querySelectorAll(".sub");
    subs[0].textContent = `MV${ext.manifest.manifest_version} · ${ext.id}`;
    subs[1].textContent = ext.description;
    const acts = meta.querySelector(".acts") as HTMLElement;
    const btn = (label: string, cls: string, fn: () => void | Promise<void>) => {
      const b = document.createElement("button");
      b.className = `xbtn ${cls}`;
      b.textContent = label;
      b.onclick = async () => {
        try {
          await fn();
        } catch (e) {
          setMsg(e instanceof Error ? e.message : String(e), true);
        }
        renderList();
        renderToolbar();
      };
      acts.append(b);
    };
    btn(ext.enabled ? "Disable" : "Enable", "sec", () => sapphire.setExtensionEnabled(ext.id, !ext.enabled));
    btn("Reload", "sec", () => sapphire.reloadExtension(ext.id));
    if (ext.optionsUrl) btn("Options", "sec", () => void openTab(ext.optionsUrl!));
    btn("Background", "sec", () => {
      const w = harness.backgroundWindow(ext.id);
      if (!w) return setMsg("no live background context", true);
      (window as unknown as { $bg: unknown }).$bg = w;
      setMsg(`background window is now window.$bg in the devtools console`);
    });
    btn("Remove", "bad", () => sapphire.uninstallExtension(ext.id));
    row.append(img, meta);
    list.append(row);
  }
}

function setMsg(text: string, err = false): void {
  const el = $("msg");
  el.textContent = text;
  el.className = err ? "err" : "";
}

async function installFrom(input: string | File): Promise<void> {
  try {
    let buf: ArrayBuffer;
    let name: string;
    if (typeof input !== "string") {
      buf = await input.arrayBuffer();
      name = input.name;
    } else if (/^[a-p]{32}$/.test(input.trim())) {
      setMsg("downloading from the Chrome Web Store…");
      const res = await fetch(`/api/crx/${input.trim()}`);
      if (!res.ok) throw new Error(`download failed (${res.status})`);
      buf = await res.arrayBuffer();
      name = `${input.trim()}.crx`;
    } else {
      const m = input.match(/\/detail\/(?:[^/]+\/)?([a-p]{32})/);
      if (m) return installFrom(m[1]);
      setMsg("downloading…");
      const res = await fetch(`/api/fetch?url=${encodeURIComponent(input)}`);
      if (!res.ok) throw new Error(`download failed (${res.status})`);
      buf = await res.arrayBuffer();
      name = input.split("/").pop() || "extension.zip";
    }
    setMsg("installing…");
    const id = await sapphire.installExtension(buf, name);
    setMsg(`installed ${id}`);
  } catch (e) {
    setMsg(e instanceof Error ? e.message : String(e), true);
  }
  renderList();
  renderToolbar();
}

// ---- context menu -------------------------------------------------------------------

function renderContextMenu(request: ContextMenuShowRequest): void {
  const menu = $("ctxmenu");
  menu.textContent = "";
  const content = $("content").getBoundingClientRect();
  const add = (entry: ContextMenuEntry, depth: number) => {
    const el = document.createElement("div");
    if (entry.children.length) {
      el.className = "head";
      el.textContent = `${"  ".repeat(depth)}${entry.title} ▸`;
      menu.append(el);
      for (const c of entry.children) add(c, depth + 1);
      return;
    }
    if (entry.type === "separator") return;
    el.textContent = `${"  ".repeat(depth)}${entry.type === "checkbox" || entry.type === "radio" ? (entry.checked ? "☑ " : "☐ ") : ""}${entry.title}`;
    el.onclick = () => {
      menu.style.display = "none";
      request.select(entry);
    };
    menu.append(el);
  };
  for (const e of request.items) {
    const head = document.createElement("div");
    head.className = "head";
    head.textContent = e.extName;
    menu.append(head);
    if (e.id.startsWith("__sapphire_root_")) for (const c of e.children) add(c, 0);
    else add(e, 0);
  }
  menu.style.left = `${content.left + request.x}px`;
  menu.style.top = `${content.top + request.y}px`;
  menu.style.display = "block";
}

// ---- boot ------------------------------------------------------------------------------

async function boot() {
  for (const level of ["log", "warn", "error", "info"] as const) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      addLog(level, args.map(safeString).join(" ").slice(0, 600));
      orig(...args);
    };
  }
  window.addEventListener("error", (e) => addLog("error", `${e.message}`));
  await navigator.serviceWorker.register("/sw.js");
  const registration = await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) {
    await new Promise<void>((resolve) => navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true }));
  }
  const transport = new LibcurlTransport({ wisp: `ws://${location.host}/wisp/` });
  await transport.init();
  controller = new Controller({ serviceworker: navigator.serviceWorker.controller ?? registration.active!, transport });
  await controller.wait();
  sapphire.attachController(controller);
  await sapphire.init();
  sapphire.onChange(() => {
    renderToolbar();
    if ($("side").classList.contains("open")) renderList();
  });
  status.textContent = "ready";
  setTimeout(() => (status.textContent = ""), 1500);
  renderList();
  renderTabs();
  if (!new URLSearchParams(location.search).has("blank")) openTab(`${location.origin}/home.html`);
}

// ---- wiring ------------------------------------------------------------------------------

$("extbtn").onclick = () => {
  $("side").classList.toggle("open");
  renderList();
};
$("clearlog").onclick = () => ($("log").textContent = "");
$("installbtn").onclick = () => {
  const v = $<HTMLInputElement>("storeid").value.trim();
  if (v) void installFrom(v);
};
$<HTMLInputElement>("storeid").onkeydown = (e) => e.key === "Enter" && $("installbtn").click();
$<HTMLInputElement>("file").onchange = (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) void installFrom(f);
};
$("back").onclick = () => activeTabId !== null && tabs.get(activeTabId)?.frame.back();
$("fwd").onclick = () => activeTabId !== null && tabs.get(activeTabId)?.frame.forward();
$("reload").onclick = () => activeTabId !== null && tabs.get(activeTabId)?.frame.reload();
$<HTMLInputElement>("url").onkeydown = (e) => {
  if (e.key !== "Enter") return;
  let v = (e.target as HTMLInputElement).value.trim();
  if (!v) return;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(v)) v = /\s/.test(v) || !v.includes(".") ? `https://duckduckgo.com/?q=${encodeURIComponent(v)}` : `https://${v}`;
  if (activeTabId === null || !tabs.has(activeTabId)) openTab(v);
  else navigate(activeTabId, v);
  (e.target as HTMLInputElement).blur();
};
document.addEventListener("click", () => {
  $("ctxmenu").style.display = "none";
});
document.addEventListener("click", (e) => {
  if (!(e.target as HTMLElement).closest("#popupwrap, .exticon")) hidePopup();
});
document.addEventListener("keydown", (e) => {
  if (sapphire.handleKeyboardEvent(e)) e.preventDefault();
});
setInterval(() => {
  if (tabs.size) renderTabs();
}, 1500);

const harness = {
  ready: boot(),
  get controller() {
    return controller;
  },
  sapphire,
  logs,
  notifications,
  contextMenus,
  popups,
  sidePanels,
  tabs,
  openTab,
  navigate,
  closeTab,
  activate,
  tabWindow: (id: number) => tabs.get(id)?.iframe.contentWindow ?? null,
  async installFromUrl(url: string, name?: string) {
    const buf = await (await fetch(url)).arrayBuffer();
    return sapphire.installExtension(buf, name ?? url.split("/").pop());
  },
  popupWindow: () => popupEl.contentWindow,
  backgroundWindow(extId: string) {
    const ctx = [...sapphire.registry.contexts].find((c) => c.ext.id === extId && c.kind === "background" && c.alive);
    return ctx?.window ?? null;
  },
  async clearAll() {
    for (const ext of sapphire.registry.list()) await sapphire.uninstallExtension(ext.id);
  },
};

(window as unknown as { harness: typeof harness }).harness = harness;
