import { ManagedPlugin } from "@mercuryworkshop/scramjet-controller";
import type { Frame } from "@mercuryworkshop/scramjet-controller";
import { injectContentScripts } from "./contentScripts";
import type { Sapphire } from "./sapphire";

export class SapphireContentScriptPlugin extends ManagedPlugin {
  private readonly sapphire: Sapphire;
  private readonly tabId: number;

  constructor(sapphire: Sapphire, tabId: number) {
    super("sapphire-content-scripts", []);
    this.sapphire = sapphire;
    this.tabId = tabId;
  }

  install(frame: Frame): void {
    this.tap(frame.hooks.init.pre, (ctx) => {
      if (!ctx?.window) return;
      const url = ctx.window.location.href;
      void injectContentScripts(ctx.window, this.tabId, url, ctx.isTopLevel, this.sapphire.registry, this.sapphire.host);
    });
  }
}
