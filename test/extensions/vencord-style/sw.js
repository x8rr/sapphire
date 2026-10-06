// Simulates a "Vencord web" style loader: on a matching page, fetch a
// remote bundle (here: same test site, but still cross-origin relative to
// the extension's own chrome-extension:// origin, which is what matters for
// permission/CORS purposes) from the background, then eval it directly into
// the page's MAIN world — exactly the mechanism such loaders use to patch a
// live site's client-side code.
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== "complete" || !tab.url || !tab.url.includes("vencord-target.html")) return;
  const origin = new URL(tab.url).origin;
  const code = await fetch(`${origin}/vencord-bundle.js`).then((r) => r.text());
  await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: (src) => {
      (0, eval)(src);
    },
    args: [code],
  });
});
