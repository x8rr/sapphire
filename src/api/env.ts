import type { ExtensionContext, ExtensionState } from "../registry";
import type { Sapphire } from "../sapphire";

export interface Env {
  s: Sapphire;
  ctx: ExtensionContext;
  ext: ExtensionState;
}

export type Namespace = Record<string, unknown>;

/** Attach a getter-backed property (lastError, dynamic state) to an API object. */
export function defineGetter(target: object, name: string, get: () => unknown): void {
  Object.defineProperty(target, name, { get, enumerable: true, configurable: true });
}
