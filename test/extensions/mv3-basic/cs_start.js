window.__csStart = {
  shared: typeof sharedHelper === "function" ? sharedHelper() : null,
  readyState: document.readyState,
  href: location.href,
  runtimeId: chrome.runtime.id,
  hasTabs: typeof chrome.tabs,
  getURL: chrome.runtime.getURL("war.txt"),
  pageScriptRanBefore: !!window.pageScriptRan,
  globalChrome: !!(globalThis.chrome && globalThis.chrome.runtime && globalThis.chrome.runtime.id),
};
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "toContent") sendResponse({ fromContent: location.pathname, senderId: sender.id });
});
(() => {
  const mk = (cls) => { const st = document.createElement("style"); st.classList.add("darkreader", cls); st.media = "screen"; st.textContent = ""; return st; };
  const a = mk("a"); document.head.insertBefore(a, document.head.firstChild);
  const b = mk("b"); document.head.insertBefore(b, a.nextSibling);
  b.textContent = "html{}";
  const out = (window.__csStart.late = []);
  const snap = (l) => out.push([l, document.readyState, document.querySelectorAll("style.darkreader").length, document.styleSheets.length, [...document.styleSheets].includes(a.sheet)]);
  snap("sync"); queueMicrotask(() => snap("micro")); setTimeout(() => snap("t0"), 0);
  new MutationObserver((m, o) => { if (document.body) { snap("body"); o.disconnect(); } }).observe(document.documentElement, { childList: true });
  document.addEventListener("DOMContentLoaded", () => snap("dcl"));
})();
