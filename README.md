<h1 align="center">
  <img src="sapphire.png" width=500>
</h1>

A Scramjet plugin that emulates the `chrome.*` extension APIs inside proxied frames, so
Chrome extensions (Vencord-style userscripts, ad blockers, etc.) can run against sites
loaded through Scramjet. Originally forked from
[carbonicality/amethyst](https://github.com/carbonicality/amethyst).

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
