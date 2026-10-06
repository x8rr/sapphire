// End-to-end tests: real Chrome, real Scramjet, real extensions.
//   node test/run.mjs [suite-name-filter]
import { chromium } from "playwright-core";
import { startServers } from "./harness/server.mjs";
import { suites } from "./suites.mjs";

const filter = process.argv[2];
const servers = await startServers();
const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? "/usr/bin/google-chrome-stable",
  headless: process.env.HEADFUL ? false : true,
});

let failed = 0;
let passed = 0;
for (const suite of suites) {
  if (filter && !suite.name.includes(filter)) continue;
  const context = await browser.newContext();
  const page = await context.newPage();
  const consoleLines = [];
  page.on("console", (m) => consoleLines.push(`[${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => consoleLines.push(`[pageerror] ${e.message}`));
  const results = [];
  const t = {
    page,
    servers,
    site: servers.siteUrl,
    check(name, ok, detail) {
      results.push({ name, ok: !!ok, detail });
    },
    eq(name, actual, expected) {
      const ok = JSON.stringify(actual) === JSON.stringify(expected);
      results.push({ name, ok, detail: ok ? undefined : { actual, expected } });
    },
    async waitFor(fn, arg, timeout = 15000) {
      try {
        const handle = await page.waitForFunction(fn, arg, { timeout, polling: 100 });
        return await handle.jsonValue();
      } catch (e) {
        return { __timeout: true, error: String(e.message).split("\n")[0] };
      }
    },
    eval: (fn, arg) => page.evaluate(fn, arg),
  };
  const started = Date.now();
  try {
    await page.goto(servers.hostUrl);
    await page.evaluate(() => window.harness.ready);
    await suite.run(t);
  } catch (e) {
    results.push({ name: "suite crashed", ok: false, detail: String(e.stack ?? e) });
  }
  const bad = results.filter((r) => !r.ok);
  passed += results.length - bad.length;
  failed += bad.length;
  console.log(`\n=== ${suite.name} (${results.length - bad.length}/${results.length} passed, ${Date.now() - started}ms)`);
  for (const r of results) {
    if (r.ok) console.log(`  ok   ${r.name}`);
    else console.log(`  FAIL ${r.name}${r.detail !== undefined ? `\n       ${JSON.stringify(r.detail).slice(0, 1500)}` : ""}`);
  }
  if (bad.length && process.env.VERBOSE !== "0") {
    const logs = await page.evaluate(() => window.harness?.logs ?? []).catch(() => []);
    const interesting = [...consoleLines, ...logs].filter((l) => /sapphire|error|Error|FAIL|Uncaught|warn/.test(l) && !/vite|libcurl|connecting/.test(l));
    console.log("  --- console (filtered) ---");
    for (const l of interesting.slice(-60)) console.log("   ", l.slice(0, 400));
  }
  await context.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
await browser.close();
await servers.close();
process.exit(failed ? 1 : 0);
