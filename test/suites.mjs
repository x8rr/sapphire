const install = (t, name) => t.eval((u) => window.harness.installFromUrl(u), `${t.site}ext/${name}.zip`);
const openTab = (t, path) => t.eval((u) => window.harness.openTab(u), `${t.site}${path}`);

import { existsSync } from "node:fs";
const hasCrx = (n) => existsSync(new URL(`./site/crx/${n}.crx`, import.meta.url));
const installCrx = (t, name) => t.eval((u) => window.harness.installFromUrl(u), `${t.site}crx/${name}.crx`);

export const suites = [
  {
    name: "mv3-basic",
    async run(t) {
      const extId = await install(t, "mv3-basic");
      t.check("extension id is a 32-char a-p id", /^[a-p]{32}$/.test(extId), extId);

      const bg = await t.waitFor((id) => {
        const r = window.harness.backgroundWindow(id)?.results;
        return r && r.onInstalledReason ? JSON.parse(JSON.stringify(r)) : null;
      }, extId);
      t.eq("sw: importScripts shares globals", bg.swHelper, "function");
      t.eq("sw: install event fired", bg.installEvent, true);
      t.eq("sw: onInstalled reason", bg.onInstalledReason, "install");
      t.eq("sw: clients.matchAll exists", bg.clientsType, "function");
      t.eq("sw: i18n placeholders", bg.i18n, "Hello World!");
      t.eq("sw: @@extension_id", bg.extId, true);
      t.check("sw: getURL is on the extension origin", String(bg.getURL).startsWith(`https://${extId}.`) && bg.getURL.endsWith("/x.html"), bg.getURL);
      t.eq("sw: manifest name", bg.manifestName, "Sapphire MV3 Test");
      t.eq("sw: manifest localized", bg.manifestDesc, "Test extension");
      t.eq("sw: self instanceof ServiceWorkerGlobalScope", bg.instanceofSW, true);
      t.eq("sw: MV3 has no browserAction", bg.hasBrowserAction, "undefined");
      t.eq("sw: undeclared permission namespace absent", bg.hasHistory, "undefined");
      t.eq("sw: API promises are realm promises", bg.promiseRealm, true);

      const tabId = await openTab(t, "index.html");
      const cs = await t.waitFor((id) => {
        const w = window.harness.tabWindow(id);
        return w && w.__csIdle ? JSON.parse(JSON.stringify({ start: w.__csStart, idle: w.__csIdle, main: w.__mainWorld, pageSaw: w.pageSawChromeRuntimeId, pageRan: w.pageScriptRan })) : null;
      }, tabId, 30000);
      if (cs.__timeout) {
        t.check("content scripts ran", false, cs);
        return;
      }
      const { start, idle, main } = cs;
      t.eq("cs start: cross-file globals shared", start?.shared, "shared");
      t.eq("cs start: runs at document_start (readyState loading)", start?.readyState, "loading");
      t.eq("cs start: runs before page scripts", start?.pageScriptRanBefore, false);
      t.eq("cs start: location is the real URL", start?.href, `${t.site}index.html`);
      t.eq("cs start: chrome.runtime.id", start?.runtimeId, extId);
      t.eq("cs start: no chrome.tabs in content scripts", start?.hasTabs, "undefined");
      t.eq("cs start: globalThis.chrome resolves to extension API", start?.globalChrome, true);
      t.eq("page scripts don't see extension chrome.runtime", cs.pageSaw, false);
      t.eq("MAIN world script has no extension API", main?.chromeRuntimeId, false);
      t.check("cs idle: no error", !idle.error, idle.error);
      t.eq("cs idle: readyState complete", idle.readyState, "complete");
      t.eq("cs idle: content CSS applied", idle.cssApplied, "rgb(1, 2, 3)");
      t.eq("messaging: sync sendResponse", idle.ping?.pong, true);
      t.eq("messaging: sender.tab.id", idle.ping?.senderTab, tabId);
      t.eq("messaging: sender.frameId", idle.ping?.frameId, 0);
      t.eq("messaging: sender.url", idle.ping?.senderUrl, `${t.site}index.html`);
      t.eq("messaging: sender.origin", idle.ping?.origin, t.site.replace(/\/$/, ""));
      t.eq("messaging: async (return true)", idle.async, { later: 42 });
      t.eq("messaging: promise-returning listener", idle.promise, { viaPromise: true });
      t.eq("messaging: no reply sets lastError", idle.noreplyErr, "The message port closed before a response was received.");
      t.eq("storage: JSON semantics (Date → {})", idle.storage, { k1: { a: 1, d: "1970-01-01T00:00:00.000Z" } });
      t.eq("storage: callback form + missing keys", idle.storageCb, { k1: { a: 1, d: "1970-01-01T00:00:00.000Z" } });
      t.eq("web_accessible_resources fetch from page", idle.war, "web accessible text");
      t.eq("scripting.executeScript func+args result", idle.exec?.[0]?.result, "Sapphire Test Page!");
      t.eq("scripting.executeScript frameId", idle.exec?.[0]?.frameId, 0);
      t.eq("ports: round trip", idle.port, { echo: { hi: 1 }, name: "p1", sender: true });
      t.eq("getURL image loads in page", idle.img, 7);
      t.check("DNR block rule blocks fetch", /status:403|error:/.test(idle.blockedFetch), idle.blockedFetch);
      t.eq("non-matching fetch is not blocked", idle.okFetch, "status:200");
      t.eq("extension iframe in page gets extension API", idle.frameMsg?.hasTabs, "object");
      t.eq("extension iframe id", idle.frameMsg?.id, extId);

      const bgState = await t.eval((id) => {
        const w = window.harness.backgroundWindow(id);
        return JSON.parse(JSON.stringify({ tabUpdates: w.tabUpdates, nav: w.navCompleted, storage: w.storageChanges, alarm: w.results.alarm }));
      }, extId);
      t.check(
        "tabs.onUpdated: complete with url",
        bgState.tabUpdates?.some((u) => u.tabId === tabId && u.info.status === "complete" && u.url === `${t.site}index.html`),
        bgState.tabUpdates,
      );
      t.check("webNavigation.onCompleted", bgState.nav?.some((n) => n.url === `${t.site}index.html` && n.frameId === 0), bgState.nav);
      t.check("storage.onChanged reaches background", bgState.storage?.some((c) => c.area === "local" && c.keys.includes("k1")), bgState.storage);
      t.eq("alarms fire", bgState.alarm, "a1");

      // Popup
      const clicked = await t.eval(([id, tab]) => window.harness.sapphire.clickAction(id, tab), [extId, tabId]);
      t.eq("action click opens popup", clicked, "popup");
      const popup = await t.waitFor(() => {
        const w = window.harness.popupWindow();
        return w && w.__popup ? JSON.parse(JSON.stringify(w.__popup)) : null;
      });
      t.check("popup: no error", !popup.error && !popup.__timeout, popup);
      t.eq("popup: tabs.query active tab", popup.tab?.id, tabId);
      t.eq("popup: tab url", popup.tab?.url, `${t.site}index.html`);
      t.eq("popup: tabs.sendMessage → content script", popup.toContent, { fromContent: "/index.html", senderId: extId });
      t.eq("popup: runtime.sendMessage → background", popup.bg?.pong, true);
      t.eq("popup: stylesheet applied", popup.css, "rgb(9, 8, 7)");

      // Context menu + command
      await t.eval(([id, tab, url]) => window.harness.sapphire.clickContextMenuItem(id, "m1", { contexts: ["selection"], selectionText: "abc", pageUrl: url }, tab), [extId, tabId, `${t.site}index.html`]);
      const menu = await t.waitFor((id) => window.harness.backgroundWindow(id).results.menuClick ?? null, extId);
      t.eq("contextMenus.onClicked", menu, { id: "m1", sel: "abc", tab: tabId });
      await t.eval((tab) => {
        const w = window.harness.tabWindow(tab);
        w.document.body.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Y", code: "KeyY", ctrlKey: true, shiftKey: true, bubbles: true }));
      }, tabId);
      const cmd = await t.waitFor((id) => window.harness.backgroundWindow(id).results.command ?? null, extId);
      t.eq("keyboard shortcut in page → commands.onCommand", cmd, { name: "do-thing", tab: tabId });

      // all_frames content script in a child frame
      await t.eval(([tab, url]) => window.harness.navigate(tab, url), [tabId, `${t.site}second.html`]);
      const child = await t.waitFor((tab) => {
        const w = window.harness.tabWindow(tab);
        const f = w?.document?.getElementById("child");
        return f?.contentWindow?.__csChild ? JSON.parse(JSON.stringify(f.contentWindow.__csChild)) : null;
      }, tabId);
      t.eq("all_frames content script in child frame", child?.href, `${t.site}child.html`);
    },
  },
  ...(hasCrx("darkreader")
    ? [
        {
          name: "real:darkreader",
          async run(t) {
            await installCrx(t, "darkreader");
            await t.page.waitForTimeout(3000);
            const tab = await t.eval((u) => window.harness.openTab(u), `${t.site}index.html`);
            const state = await t.waitFor((id) => {
              const w = window.harness.tabWindow(id);
              try {
                const d = w.document;
                return d.documentElement.getAttribute("data-darkreader-mode") && w.getComputedStyle(d.documentElement).backgroundColor === "rgb(24, 26, 27)"
                  ? { bg: w.getComputedStyle(d.documentElement).backgroundColor, color: w.getComputedStyle(d.body).color, pageSeesProxy: !!d.documentElement.getAttribute("data-darkreader-proxy-injected") }
                  : null;
              } catch {
                return null;
              }
            }, tab, 20000);
            t.check("dark theme applied to page", !state.__timeout && state.bg === "rgb(24, 26, 27)", state);
            t.eq("text recolored", state.color, "rgb(232, 230, 227)");
          },
        },
      ]
    : []),
  ...(hasCrx("violentmonkey")
    ? [
        {
          name: "real:violentmonkey",
          async run(t) {
            const id = await installCrx(t, "violentmonkey");
            await t.page.waitForTimeout(3000);
            const opts = await t.eval((id) => window.harness.openTab(`chrome-extension://${id}/options/index.html`), id);
            await t.page.waitForTimeout(3000);
            const parsed = await t.eval(async (tab) => {
              const w = window.harness.tabWindow(tab);
              const code = "// ==UserScript==\n// @name Sapphire Test\n// @namespace t\n// @match http://127.0.0.1:5200/*\n// @grant GM_setValue\n// @grant GM_getValue\n// @grant unsafeWindow\n// ==/UserScript==\nunsafeWindow.__vmRan = { title: document.title, gm: typeof GM_setValue, v: (GM_setValue('a', 5), GM_getValue('a')) };";
              const r = await w.chrome.runtime.sendMessage({ cmd: "ParseScript", data: { code, custom: {}, config: {} } });
              return r?.update?.message ?? null;
            }, opts);
            t.eq("userscript installed through the options page API", parsed, "Script installed.");
            const tab = await t.eval((u) => window.harness.openTab(u), `${t.site}index.html`);
            const ran = await t.waitFor((id) => {
              const r = window.harness.tabWindow(id)?.__vmRan;
              return r ? JSON.parse(JSON.stringify(r)) : null;
            }, tab, 20000);
            t.eq("userscript ran with GM_* APIs", ran, { title: "Sapphire Test Page", gm: "function", v: 5 });
          },
        },
      ]
    : []),
  ...(hasCrx("vimium")
    ? [
        {
          name: "real:vimium",
          async run(t) {
            await installCrx(t, "vimium");
            await t.page.waitForTimeout(3000);
            const tab = await t.eval((u) => window.harness.openTab(u), `${t.site}second.html`);
            await t.page.waitForTimeout(4000);
            await t.page.locator(`iframe[data-tab-id='${tab}']`).click({ position: { x: 300, y: 300 } });
            await t.page.keyboard.press("f");
            const hints = await t.waitFor((id) => {
              const n = window.harness.tabWindow(id).document.querySelectorAll(".vimium-reset").length;
              return n > 0 ? n : null;
            }, tab, 8000);
            t.check("pressing f shows Vimium link-hint UI", typeof hints === "number", hints);
          },
        },
      ]
    : []),
  ...(hasCrx("tampermonkey")
    ? [
        {
          name: "real:tampermonkey",
          async run(t) {
            await installCrx(t, "tampermonkey");
            await t.page.waitForTimeout(4000);
            // A .user.js URL is intercepted into Tampermonkey's install page (ask.html).
            await t.eval((u) => window.harness.openTab(u), `${t.site}test.user.js`);
            const ask = await t.waitFor(() => {
              for (const tab of window.harness.tabs.values()) {
                try {
                  const b = tab.iframe.contentDocument.querySelector("input.install");
                  if (b) return tab.id;
                } catch {}
              }
              return null;
            }, undefined, 20000);
            t.check("install dialog renders", typeof ask === "number", ask);
            if (typeof ask !== "number") return;
            await t.eval((id) => window.harness.tabWindow(id).document.querySelector("input.install").click(), ask);
            await t.page.waitForTimeout(3000);
            t.eval(() => typeof window.harness).then((x) => t.eq("host page survives the install flow", x, "object"));
            const tab = await t.eval((u) => window.harness.openTab(u), `${t.site}index.html`);
            const ran = await t.waitFor((id) => {
              const r = window.harness.tabWindow(id)?.__tmRan;
              return r ? JSON.parse(JSON.stringify(r)) : null;
            }, tab, 20000);
            t.eq("userscript ran with GM_* APIs", ran, { gm: "function", v: 7, title: "Sapphire Test Page" });
          },
        },
      ]
    : []),
  ...(hasCrx("stylus")
    ? [
        {
          name: "real:stylus",
          async run(t) {
            const id = await installCrx(t, "stylus");
            await t.page.waitForTimeout(4000);
            const manage = await t.eval((id) => window.harness.openTab(`chrome-extension://${id}/manage.html`), id);
            await t.page.waitForTimeout(3000);
            const style = await t.eval(async (tab) => {
              const w = window.harness.tabWindow(tab);
              const r = await Promise.race([new Promise((r) => setTimeout(() => r(null), 10000)), w.API.styles.install({ name: "sapphire test", enabled: true, sections: [{ code: "h1 { color: rgb(1, 2, 3) !important; }", urls: [], urlPrefixes: ["http://127.0.0.1:5200/"], domains: [], regexps: [] }] })]);
              return r ? r.name : null;
            }, manage);
            t.eq("style installed through the page API (page → service worker)", style, "sapphire test");
            const tab = await t.eval((u) => window.harness.openTab(u), `${t.site}index.html`);
            const color = await t.waitFor((id) => {
              const w = window.harness.tabWindow(id);
              try {
                const c = w.getComputedStyle(w.document.querySelector("h1")).color;
                return c === "rgb(1, 2, 3)" ? c : null;
              } catch { return null; }
            }, tab, 15000);
            t.eq("user style applied to the page", color, "rgb(1, 2, 3)");
          },
        },
      ]
    : []),
  {
    // The core mechanism a "Vencord web" style loader relies on: a background
    // service worker fetches remote JS and evals it directly into a live
    // page's MAIN world (not the isolated content-script world).
    name: "vencord-style-loader",
    async run(t) {
      await install(t, "vencord-style");
      await t.page.waitForTimeout(1500);
      const tab = await openTab(t, "vencord-target.html");
      const state = await t.waitFor((tabId) => {
        const w = window.harness.tabWindow(tabId);
        return w && w.__vencordLoaded ? { loaded: w.__vencordLoaded, banner: w.document.getElementById("vencord-banner")?.textContent ?? null } : null;
      }, tab, 10000);
      t.check("remote bundle fetched + eval'd into page MAIN world", !state.__timeout && state.loaded === true, state);
      t.eq("injected code can mutate the live DOM", state?.banner, "patched");
    },
  },
  ...(hasCrx("ublite")
    ? [
        {
          name: "real:ublite",
          async run(t) {
            const id = await installCrx(t, "ublite");
            await t.page.waitForTimeout(4000);
            const tab = await t.eval((u) => window.harness.openTab(u), `${t.site}ads.html`);
            await t.page.waitForTimeout(1500);
            const probe = await t.eval(async (tabId) => {
              const w = window.harness.tabWindow(tabId);
              return w && (await w.__adProbe);
            }, tab);
            t.check("doubleclick.net request blocked/neutered by default filter lists", /neutered|^error:/.test(probe?.doubleclick ?? ""), probe);
            t.check("google-analytics.com request blocked/neutered by default filter lists", /neutered|^error:/.test(probe?.googleAnalytics ?? ""), probe);
            t.eq("same-origin page fetch is unaffected", probe?.ownPage, "status:200");

            await t.eval(([extId, tabId]) => window.harness.sapphire.clickAction(extId, tabId), [id, tab]);
            await t.page.waitForTimeout(2500);
            const popup = await t.eval(() => {
              const w = window.harness.popupWindow();
              try {
                return { title: w.document.title, bodyLen: w.document.body?.innerText.length };
              } catch (e) {
                return { error: String(e) };
              }
            });
            t.check("uBlock Origin Lite popup renders", !popup.error && popup.bodyLen > 0, popup);
          },
        },
      ]
    : []),
  // Needs real internet (YouTube through the proxy): NETWORK=1 node test/run.mjs youtube
  ...(process.env.NETWORK && hasCrx("sponsorblock") && hasCrx("ryd")
    ? [
        {
          name: "net:youtube",
          async run(t) {
            await installCrx(t, "sponsorblock");
            await installCrx(t, "ryd");
            await t.page.waitForTimeout(4000);
            const tab = await t.eval((u) => window.harness.openTab(u), "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
            const ui = await t.waitFor((id) => {
              const d = window.harness.tabWindow(id)?.document;
              if (!d) return null;
              const sb = !!d.querySelector("#startSegmentButton, #infoButton");
              const dislike = [...d.querySelectorAll("dislike-button-view-model button, ytd-segmented-like-dislike-button-renderer button")].some((b) => /^\d+(\.\d+)?[KM]?$/.test(b.innerText.trim()));
              return sb && dislike ? { sb, dislike } : null;
            }, tab, 60000);
            t.check("SponsorBlock injects its player buttons", !ui.__timeout, ui);
            t.check("Return YouTube Dislike shows a dislike count", !ui.__timeout, ui);
          },
        },
      ]
    : []),
];
