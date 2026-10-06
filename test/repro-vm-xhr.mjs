// Interactive repro for Violentmonkey's GM_xmlhttpRequest not completing.
// Run with DevTools open so you can set a breakpoint inside Violentmonkey's
// own sandbox bridge (injected.js / injected-web.js) and step through what
// happens when GM_xmlhttpRequest() is called — that's the one lead this
// investigation couldn't chase further from the outside.
//
//   HOST_PORT=5299 SITE_PORT=5300 HEADFUL=1 node test/repro-vm-xhr.mjs
//
// Ports must be set via the shell (as above), not left to default — this
// repo's dev server commonly runs on 5199/5200 already, and this script must
// never bind those out from under it. Chrome opens headful; devtools won't
// auto-open, so open it yourself (right-click the harness tab, or F12)
// before the script proceeds past the first pause. The page stays open
// indefinitely at the end so you can poke around (ctrl-c to exit).
import { chromium } from "playwright-core";
import { startServers, HOST_PORT, SITE_PORT } from "./harness/server.mjs";

if (!process.env.HOST_PORT || !process.env.SITE_PORT) {
  console.error("Set HOST_PORT and SITE_PORT explicitly (e.g. HOST_PORT=5299 SITE_PORT=5300) before running this — see the file header.");
  process.exit(1);
}
console.log(`Using HOST_PORT=${HOST_PORT} SITE_PORT=${SITE_PORT}`);

const servers = await startServers();
const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? "/usr/bin/google-chrome-stable",
  headless: process.env.HEADFUL ? false : true,
  devtools: !!process.env.HEADFUL,
});
const context = await browser.newContext();
const page = await context.newPage();
page.on("console", (m) => console.log(`[${m.type()}]`, m.text()));
page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));

await page.goto(servers.hostUrl);
await page.evaluate(() => window.harness.ready);

const id = await page.evaluate((u) => window.harness.installFromUrl(u), `${servers.siteUrl}crx/violentmonkey.crx`);
console.log("Installed Violentmonkey:", id);
await page.waitForTimeout(3000);

const opts = await page.evaluate((id) => window.harness.openTab(`chrome-extension://${id}/options/index.html`), id);
await page.waitForTimeout(3000);

// Note: @match uses the real site origin, not a hardcoded port.
const code =
  `// ==UserScript==\n// @name Sapphire Test\n// @namespace t\n// @match ${servers.siteUrl}*\n// @grant GM_xmlhttpRequest\n// @grant unsafeWindow\n// ==/UserScript==\n` +
  "console.log('userscript running');" +
  "GM_xmlhttpRequest({ method: 'GET', url: unsafeWindow.location.origin + '/second.html', " +
  "onload: (r) => { console.log('GM_xhr onload', r.status); unsafeWindow.__vmXhr = { status: r.status }; }, " +
  "onerror: (e) => { console.log('GM_xhr onerror', JSON.stringify(e)); unsafeWindow.__vmXhr = { error: true }; } });";

await page.evaluate(
  async ([tab, code]) => {
    const w = window.harness.tabWindow(tab);
    const r = await w.chrome.runtime.sendMessage({ cmd: "ParseScript", data: { code, custom: {}, config: {} } });
    console.log("install result:", JSON.stringify(r?.update?.message));
  },
  [opts, code],
);

console.log("\n>>> Set your breakpoint now (e.g. inside the extension's injected.js / injected-web.js — search for 'HttpRequest'), then watch this terminal. <<<\n");
await page.waitForTimeout(5000);

const tab = await page.evaluate((u) => window.harness.openTab(u), `${servers.siteUrl}index.html`);
console.log("Opened target tab:", tab, "— GM_xmlhttpRequest should fire shortly.");

// Keep the harness alive indefinitely so you can keep inspecting.
await new Promise(() => {});
