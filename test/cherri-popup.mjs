// Open an extension's popup over cherri's internal home tab (needs cherri dev server on :5301).
import { chromium } from "playwright-core";
import { startServers } from "./harness/server.mjs";
const name = process.argv[2] ?? "tampermonkey";
const servers = await startServers();
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome-stable", headless: true });
const page = await (await browser.newContext()).newPage();
await page.addInitScript((wisp) => { if (location.protocol.startsWith("http") && !localStorage.getItem("cherri_settings")) localStorage.setItem("cherri_settings", JSON.stringify({ theme: "cherri", wisp })); }, "ws://localhost:5199/wisp/");
await page.goto(process.env.CHERRI ?? "http://127.0.0.1:5301/");
await page.waitForFunction(() => window.__cherriSapphire, null, { timeout: 60000 });
console.log("controller before install:", await page.evaluate(() => !!window.__cherriSapphire.controller));
const id = await page.evaluate(async (u) => window.__cherriSapphire.installExtension(await (await fetch(u)).arrayBuffer(), "x.crx"), `${servers.siteUrl}crx/${name}.crx`);
await page.waitForFunction(() => window.__cherriSapphire.controller, null, { timeout: 90000 });
console.log("controller after install (lazy boot triggered):", true);
await page.waitForTimeout(5000);
console.log("active tab visible to extensions:", await page.evaluate(() => JSON.stringify(window.__cherriSapphire.host.getAllTabs())));
const text = await page.evaluate(async (id) => {
  const s = window.__cherriSapphire;
  const frame = document.createElement("iframe");
  frame.style.cssText = "position:fixed;right:10px;top:50px;width:380px;height:520px;z-index:99999;background:#fff";
  document.body.appendChild(frame);
  await s.mountExtensionPopup(frame, id, s.host.getActiveTabId());
  await new Promise((r) => setTimeout(r, 9000));
  try { return JSON.stringify(frame.contentDocument.body.innerText.slice(0, 160)); } catch (e) { return String(e); }
}, id);
console.log("popup text:", text);
await browser.close(); await servers.close();
