importScripts("sw_helper.js");
self.results = { swHelper: typeof swHelper, installEvent: false, onInstalledReason: null };
self.addEventListener("install", () => { self.results.installEvent = true; });
chrome.runtime.onInstalled.addListener((d) => {
  self.results.onInstalledReason = d.reason;
  chrome.contextMenus.create({ id: "m1", title: "Test menu %s", contexts: ["selection", "page"] });
});
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "ping") { sendResponse({ pong: true, senderTab: sender.tab && sender.tab.id, senderUrl: sender.url, frameId: sender.frameId, origin: sender.origin }); return; }
  if (msg.type === "async") { setTimeout(() => sendResponse({ later: msg.value * 2 }), 50); return true; }
  if (msg.type === "promise") { return Promise.resolve({ viaPromise: true }); }
  if (msg.type === "fetch") { fetch(msg.url).then((r) => r.text()).then((t) => sendResponse({ text: t.slice(0, 100) }), (e) => sendResponse({ error: String(e) })); return true; }
  if (msg.type === "execScript") {
    chrome.scripting.executeScript({ target: { tabId: sender.tab.id }, func: (a) => document.title + a, args: ["!"] })
      .then((r) => sendResponse(r), (e) => sendResponse({ error: e.message }));
    return true;
  }
  if (msg.type === "noreply") { return; }
});
chrome.runtime.onConnect.addListener((port) => {
  port.onMessage.addListener((m) => { port.postMessage({ echo: m, name: port.name, sender: !!port.sender }); });
});
chrome.tabs.onUpdated.addListener((tabId, info, tab) => { (self.tabUpdates ||= []).push({ tabId, info, url: tab.url }); });
chrome.webNavigation.onCompleted.addListener((d) => { (self.navCompleted ||= []).push({ url: d.url, frameId: d.frameId }); });
chrome.contextMenus.onClicked.addListener((info, tab) => { self.results.menuClick = { id: info.menuItemId, sel: info.selectionText, tab: tab && tab.id }; });
chrome.commands.onCommand.addListener((name, tab) => { self.results.command = { name, tab: tab && tab.id }; });
chrome.alarms.onAlarm.addListener((a) => { self.results.alarm = a.name; });
chrome.alarms.create("a1", { delayInMinutes: 0.001 });
chrome.storage.onChanged.addListener((changes, area) => { (self.storageChanges ||= []).push({ area, keys: Object.keys(changes) }); });
self.results.clientsType = typeof clients.matchAll;
self.results.i18n = chrome.i18n.getMessage("greet", ["World"]);
self.results.extId = chrome.i18n.getMessage("@@extension_id") === chrome.runtime.id;
self.results.getURL = chrome.runtime.getURL("x.html");
self.results.manifestName = chrome.runtime.getManifest().name;
self.results.manifestDesc = chrome.runtime.getManifest().description;
self.results.instanceofSW = self instanceof ServiceWorkerGlobalScope;
self.results.hasBrowserAction = typeof chrome.browserAction;
self.results.hasHistory = typeof chrome.history;
self.results.promiseRealm = chrome.storage.local.get("x") instanceof Promise;
