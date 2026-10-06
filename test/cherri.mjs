// Runtime check of the migrated cherri-v3 host (needs its dev server on :5301).
//   (cd ../cherri-v3 && node_modules/.bin/vite --port 5301 --strictPort --host 127.0.0.1) & node test/cherri.mjs
import { chromium } from "playwright-core";
import { startServers } from "./harness/server.mjs";

const CHERRI = process.env.CHERRI ?? "http://127.0.0.1:5301/";
const servers = await startServers();
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome-stable", headless: true });
const context = await browser.newContext();
const page = await context.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", e.message.slice(0, 200)));
page.on("console", (m) => { const t = m.text(); if (!/vite|Failed to load|font/i.test(t)) console.log("[c]", t.slice(0, 220)); });
await page.addInitScript((wisp) => {
  const key = "cherri_settings";
  if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ theme: "cherri", wisp }));
}, `ws://localhost:5199/wisp/`);
await page.goto(CHERRI);
await page.waitForFunction(() => window.__cherriSapphire, null, { timeout: 60000 });
console.log("cherri up, sapphire present");
const id = await page.evaluate(async (u) => {
  const buf = await (await fetch(u)).arrayBuffer();
  return window.__cherriSapphire.installExtension(buf, "darkreader.crx");
}, `${servers.siteUrl}crx/darkreader.crx`);
console.log("installed", id);
await page.waitForTimeout(3000);
console.log("extensions:", await page.evaluate(() => JSON.stringify(window.__cherriSapphire.getInstalledExtensions().map((e) => [e.name, e.enabled]))));
// New host bindings: extension-initiated tabs go through cherri's own tab model.
await page.goto("about:blank");
await page.goto(`${CHERRI}?u=${encodeURIComponent(servers.siteUrl + "index.html")}`);
await page.waitForFunction(() => window.__cherriSapphire?.controller, null, { timeout: 60000 });
await page.waitForTimeout(12000);
const out = await page.evaluate(async (site) => {
  const s = window.__cherriSapphire;
  const r = {};
  r.tabsBefore = [...s.registry.tabs.keys()];
  const id = await s.openTab(site + "second.html", { active: true });
  r.newId = id;
  await new Promise((res) => setTimeout(res, 8000));
  r.url = s.registry.tabs.get(id)?.url;
  const dr = [...s.registry.contexts].filter((c) => c.tabId === id && c.alive).map((c) => c.ext.manifest.name + ":" + c.kind + ":" + c.frameId);
  r.ctxs = dr;
  s.closeTab(id);
  await new Promise((res) => setTimeout(res, 1500));
  r.afterClose = [...s.registry.tabs.keys()];
  return JSON.stringify(r);
}, servers.siteUrl);
console.log("bindings:", out);
await browser.close();
await servers.close();
