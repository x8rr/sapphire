<h1 align="center">
  <img src="sapphire.png" width=500>
</h1>

A Scramjet plugin that emulates the `chrome.*` extension APIs inside proxied frames, so
Chrome extensions (Vencord-style userscripts, ad blockers, etc.) can run against sites
loaded through Scramjet. Originally forked from
[carbonicality/amethyst](https://github.com/carbonicality/amethyst); this version is a
full TypeScript rewrite built directly around Scramjet's plugin API instead of a
standalone postMessage-bridged iframe runtime, and ships no UI of its own — it's a
library, the host app builds whatever extension-manager UI it wants on top.

## Architecture

- `Sapphire` (`src/sapphire.ts`) — orchestrator owning installed-extension state
  (IndexedDB-backed), background contexts, and content-script registrations. Create one
  per app.
- `SapphireContentScriptPlugin` (`src/SapphirePlugin.ts`) — a Scramjet `ManagedPlugin`.
  Create one per `Frame` (matching Scramjet's own convention, see
  `@mercuryworkshop/scramjet-controller`'s `createFrame({ plugins: [...] })`), passing it
  the shared `Sapphire` instance and that frame's tab id.
- `chromeApi.ts` — builds a *live* `chrome.*`/`browser.*` object directly on the target
  realm's real `Window` (obtained from Scramjet's `frame.hooks.init.pre` context). No
  postMessage bridge: `addListener` captures real function references from that realm, so
  dispatch is a direct call, not a serialized round-trip. This fixes real bugs the old
  amethyst design had (e.g. `chrome.runtime.getManifest()` returning `undefined` because
  it was silently async under the hood) and removes a class of injection-timing races.
- Background pages/scripts/service-workers all run in one persistent, invisible iframe
  per extension (not tied to any tab's lifecycle) — a deliberate simplification over
  spec-faithful Worker-based MV3 semantics; see the doc comment in `background.ts`.
- `dnr.ts` exports a pure `checkDeclarativeNetRequest()` matcher; it is *not* wired into
  Scramjet's fetch path (that hook is undocumented/unstable — see project notes), so wire
  it into your own request routing if you want extension-driven blocking.

## How it works (v0.2)

- Extension pages, popups, backgrounds and `chrome.runtime.getURL()` resources live on a
  per-extension https alias origin (`https://<id>.sapphire-extension.invalid/`) and load
  *through Scramjet*; the plugin's fetch hook serves them from IndexedDB. Pass the
  controller via `new Sapphire({ host, controller })` or `attachController()`.
- Content scripts run in the page's JS world (rewritten by Scramjet like page script) with a
  per-extension `chrome` resolved from the caller's `sourceURL`, so page scripts never see it.
- MV3 service workers run in hidden frames with `importScripts`/`clients`/`registration` shims.
- `declarativeNetRequest` and `webRequest` (incl. blocking) are wired into Scramjet's fetch hooks.
- Dev UI: `npm run dev`, then open http://localhost:5199/ — a small browser (tabs, URL bar, extension toolbar + popups, install from file / Web Store ID / URL, extension manager, log).
- Tests: `npm test` (real Chrome + Scramjet + local wisp) and `npm run test:realworld`.

### Migrating a host (e.g. cherri-v3)

1. Pass the Scramjet controller: `new Sapphire({ host, controller })`, or `sapphire.attachController(controller)` once it boots.
2. Add `plugins: [sapphire.createPlugin(tabId)]` to every `controller.createFrame(...)` (the old `SapphireContentScriptPlugin` still works).
3. Drop `sapphire-sw-router.js` from the service worker — extension files are now served by Sapphire's Scramjet fetch hook.
4. Load extension pages by URL: `frame.go(sapphire.resolveUrl("chrome-extension://<id>/page.html"))` (show `sapphire.displayUrl(url)` in the address bar).
5. If your host boots the proxy lazily, implement `ensureController` (start the proxy, then `attachController`); Sapphire calls it when an extension is installed or a popup/page needs it.
6. Optional host bindings: `createTab`, `closeTab`, `openPopup`, `showContextMenu`, `createNotification`, `openSidePanel`, `requestPermissions`.

## Usage

```ts
import { Sapphire, SapphireContentScriptPlugin } from "@x8r/sapphire";

const sapphire = new Sapphire({
  host: {
    getTabId: (win) => /* map a proxied window back to your tab id */,
    getTab: (id) => /* { id, windowId, url, title, active } */,
    getAllTabs: () => /* TabInfo[] */,
    getTabWindow: (id) => /* live Window for tabs.executeScript/cookies.* */,
    navigateTab: (id, url) => /* your router */,
  },
});
await sapphire.init(); // loads previously-installed extensions

// per tab, when creating its Scramjet frame:
controller.createFrame(iframeEl, {
  plugins: [new SapphireContentScriptPlugin(sapphire, tabId)],
});

// installing an extension (host owns the file picker / drag-drop UI):
const extId = await sapphire.installExtension(await file.arrayBuffer(), file.name);
```
