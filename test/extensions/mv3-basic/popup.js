(async () => {
  const r = {};
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  r.tab = tab && { id: tab.id, url: tab.url, title: tab.title };
  r.toContent = await chrome.tabs.sendMessage(tab.id, { type: "toContent" });
  r.bg = await chrome.runtime.sendMessage({ type: "ping" });
  r.views = chrome.extension.getViews().length;
  r.css = getComputedStyle(document.getElementById("t")).color;
  r.href = location.href;
  window.__popup = r;
})().catch((e) => (window.__popup = { error: String(e.stack || e) }));
