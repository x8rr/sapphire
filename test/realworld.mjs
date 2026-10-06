// Exploratory: install real Web Store extensions and report what breaks.
//   node test/realworld.mjs [name ...]   (CRX files live in test/site/crx/)
import { readdirSync } from "node:fs";
import { chromium } from "playwright-core";
import { startServers } from "./harness/server.mjs";

const names = process.argv.slice(2).length
  ? process.argv.slice(2)
  : readdirSync(new URL("./site/crx/", import.meta.url)).filter((f) => f.endsWith(".crx")).map((f) => f.slice(0, -4));
const pageUrl = process.env.PAGE ?? null;
const servers = await startServers();
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome-stable", headless: true });

for (const name of names) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const lines = [];
  page.on("console", (m) => lines.push(`[${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => lines.push(`[pageerror] ${e.message} :: ${String(e.stack).split("\n").slice(1, 4).join(" | ").slice(0, 400)}`));
  await page.goto(servers.hostUrl);
  await page.evaluate(() => window.harness.ready);
  const t0 = Date.now();
  let extId;
  try {
    extId = await page.evaluate((u) => window.harness.installFromUrl(u), `${servers.siteUrl}crx/${name}.crx`);
  } catch (e) {
    console.log(`\n### ${name}: INSTALL FAILED ${e.message}`);
    await context.close();
    continue;
  }
  const info = await page.evaluate((id) => {
    const ext = window.harness.sapphire.registry.get(id);
    return { name: ext.manifest.name, version: ext.manifest.version, mv: ext.manifest.manifest_version, perms: ext.manifest.permissions, bg: ext.manifest.background, popup: ext.defaultAction.popup, cs: (ext.manifest.content_scripts || []).length };
  }, extId);
  await page.waitForTimeout(4000);
  const tabId = await page.evaluate((u) => window.harness.openTab(u), pageUrl ?? `${servers.siteUrl}index.html`);
  await page.waitForTimeout(6000);
  const pageState = await page.evaluate((id) => {
    const w = window.harness.tabWindow(id);
    try {
      return { title: w.document.title, styles: w.document.querySelectorAll("style").length, extStyles: w.document.querySelectorAll("[data-sapphire-extension], .darkreader").length, bodyLen: w.document.body?.innerHTML.length, htmlAttrs: [...w.document.documentElement.attributes].map((a) => a.name + "=" + a.value.slice(0, 40)) };
    } catch (e) {
      return { error: String(e) };
    }
  }, tabId);
  let popup = null;
  if (info.popup) {
    await page.evaluate(([id, tab]) => window.harness.sapphire.clickAction(id, tab), [extId, tabId]);
    await page.waitForTimeout(4000);
    popup = await page.evaluate(() => {
      const w = window.harness.popupWindow();
      try {
        return { title: w.document.title, bodyText: (w.document.body?.innerText ?? "").replace(/\s+/g, " ").slice(0, 160), elements: w.document.querySelectorAll("*").length };
      } catch (e) {
        return { error: String(e) };
      }
    });
  }
  const contexts = await page.evaluate((id) => [...window.harness.sapphire.registry.contexts].filter((c) => c.ext.id === id && c.alive).map((c) => c.kind), extId);
  const logs = await page.evaluate(() => window.harness.logs);
  const relevant = [...lines, ...logs].filter((l) => (/error|Error|warn|sapphire|Unchecked|not supported|undefined/.test(l)) && !/vite|libcurl|Failed to load resource: the server responded with a status of 404|connecting/.test(l));
  console.log(`\n### ${name} — ${info.name} ${info.version} (MV${info.mv}) id=${extId} ${Date.now() - t0}ms`);
  console.log(`   perms: ${JSON.stringify(info.perms)}  bg: ${JSON.stringify(info.bg)}  cs: ${info.cs}`);
  console.log(`   contexts: ${JSON.stringify(contexts)}`);
  console.log(`   page: ${JSON.stringify(pageState)}`);
  if (popup) console.log(`   popup: ${JSON.stringify(popup)}`);
  const seen = new Set();
  for (const l of relevant) {
    const key = l.slice(0, 200);
    if (seen.has(key)) continue;
    seen.add(key);
    console.log(`   ${l.slice(0, 500).replace(/\n/g, "\n      ")}`);
    if (seen.size > 40) break;
  }
  await context.close();
}
await browser.close();
await servers.close();
