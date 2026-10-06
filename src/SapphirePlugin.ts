import { ManagedPlugin } from "@mercuryworkshop/scramjet-controller";
import type { Frame } from "@mercuryworkshop/scramjet-controller";
import { onInitPost, onInitPre, type FrameKind, type FramePluginInfo } from "./frames";
import { onFetchPreresponse, onFetchRequest, onFetchResponse } from "./network";
import type { Sapphire } from "./sapphire";

export interface SapphirePluginOptions {
  tabId?: number | null;
  kind?: FrameKind;
}

/**
 * One per Scramjet Frame. For browser tabs pass the host's tab id; Sapphire
 * creates its own instances for background pages, popups and offscreen
 * documents. Wires Scramjet's frame-init hooks (extension contexts, content
 * scripts, navigation tracking) and fetch hooks (extension resources,
 * declarativeNetRequest, webRequest).
 */
export class SapphirePlugin extends ManagedPlugin {
  readonly sapphire: Sapphire;
  readonly info: FramePluginInfo;

  constructor(sapphire: Sapphire, tabIdOrOptions: number | null | SapphirePluginOptions = null) {
    super("sapphire", []);
    this.sapphire = sapphire;
    this.info =
      tabIdOrOptions !== null && typeof tabIdOrOptions === "object"
        ? { kind: tabIdOrOptions.kind ?? "tab", tabId: tabIdOrOptions.tabId ?? null }
        : { kind: "tab", tabId: tabIdOrOptions };
  }

  install(frame: Frame): void {
    super.install(frame);
    const s = this.sapphire;
    this.tap(frame.hooks.init.pre, (ctx) => {
      if (!ctx?.window) return;
      try {
        onInitPre(s, this.info, ctx);
      } catch (e) {
        console.error("[sapphire] frame init (pre) failed", e);
      }
    });
    this.tap(frame.hooks.init.post, (ctx) => {
      if (!ctx?.window) return;
      try {
        onInitPost(s, this.info, ctx);
      } catch (e) {
        console.error("[sapphire] frame init (post) failed", e);
      }
    });
    this.tap(frame.hooks.fetch.request, async (ctx, props) => {
      try {
        await onFetchRequest(s, this.info, ctx as never, props as never);
      } catch (e) {
        console.error("[sapphire] request hook failed", e);
      }
    });
    this.tap(frame.hooks.fetch.preresponse, (ctx, props) => {
      try {
        onFetchPreresponse(s, ctx as never, props as never);
      } catch (e) {
        console.error("[sapphire] preresponse hook failed", e);
      }
    });
    this.tap(frame.hooks.fetch.response, (ctx, props) => {
      try {
        onFetchResponse(s, ctx as never, props as never);
      } catch (e) {
        console.error("[sapphire] response hook failed", e);
      }
    });
  }
}

/** Kept for existing hosts: `new SapphireContentScriptPlugin(sapphire, tabId)`. */
export class SapphireContentScriptPlugin extends SapphirePlugin {
  constructor(sapphire: Sapphire, tabId: number) {
    super(sapphire, { kind: "tab", tabId });
  }
}
