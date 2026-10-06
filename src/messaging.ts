import { ChromeEvent } from "./events";
import { ApiError, jsonToRealm, realmError, realmOf, toRealm } from "./realm";
import type { ExtensionContext, PortEnd, SapphireRegistry } from "./registry";
import { jsonClone } from "./storage";

export const NO_RECEIVER = "Could not establish connection. Receiving end does not exist.";
export const PORT_CLOSED = "The message port closed before a response was received.";

/** Resolved value of a one-time message whose receivers never answered. */
export const NO_RESPONSE: unique symbol = Symbol("sapphire.noResponse");

export interface MessageSender {
  id?: string;
  url?: string;
  origin?: string;
  tab?: unknown;
  frameId?: number;
  documentId?: string;
  documentLifecycle?: string;
}

export function originOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return u.origin === "null" ? undefined : u.origin;
  } catch {
    return undefined;
  }
}

/**
 * Deliver a one-time message to every listener of `eventName` in `targets`.
 * First sendResponse (or first resolved non-undefined promise) wins; if no
 * listener keeps the channel open the result is NO_RESPONSE.
 */
export function deliverMessage(
  targets: ExtensionContext[],
  eventName: string,
  message: unknown,
  sender: MessageSender,
): Promise<unknown | typeof NO_RESPONSE> {
  const receivers = targets.filter((t) => t.events.peek(eventName)?.hasListeners());
  if (!receivers.length) return Promise.reject(new ApiError(NO_RECEIVER));
  const payload = jsonClone(message === undefined ? null : message);
  return new Promise((resolve, reject) => {
    let settled = false;
    let pending = 0;
    const respond = (value: unknown) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const release = () => {
      pending--;
      if (!settled && pending <= 0) respond(NO_RESPONSE);
    };
    setTimeout(() => {
      for (const target of receivers) {
        if (!target.alive) continue;
        const ev = target.events.peek(eventName);
        if (!ev) continue;
        for (const entry of [...ev.entries]) {
          if (settled) break;
          let answered = false;
          const sendResponse = (response?: unknown) => {
            if (answered || settled) return;
            answered = true;
            respond(response === undefined ? undefined : jsonClone(response));
          };
          const result = ev.invoke(entry, [jsonToRealm(target, payload), toRealm(target, sender), sendResponse]);
          if (result === true) {
            pending++;
            target.cleanup.push(() => {
              if (!answered) release();
            });
          } else if (result && typeof (result as PromiseLike<unknown>).then === "function") {
            pending++;
            (result as PromiseLike<unknown>).then(
              (value) => {
                if (value !== undefined) sendResponse(value);
                if (!answered) release();
              },
              (err) => {
                if (!settled) {
                  settled = true;
                  reject(new ApiError(err && typeof err === "object" && "message" in err ? String((err as Error).message) : String(err)));
                }
              },
            );
          }
        }
      }
      if (!settled && pending === 0) respond(NO_RESPONSE);
    }, 0);
  });
}

// ---- long-lived ports -------------------------------------------------------

export class PortSide implements PortEnd {
  readonly onMessage: ChromeEvent;
  readonly onDisconnect: ChromeEvent;
  readonly peers = new Set<PortSide>();
  connected = true;
  api: Record<string, unknown>;

  readonly owner: ExtensionContext;
  readonly name: string;

  constructor(owner: ExtensionContext, name: string, sender: MessageSender | undefined) {
    this.owner = owner;
    this.name = name;
    this.onMessage = new ChromeEvent("Port.onMessage", owner.ext.manifest.name);
    this.onDisconnect = new ChromeEvent("Port.onDisconnect", owner.ext.manifest.name);
    const realm = realmOf(owner);
    const api = new realm.Object() as Record<string, unknown>;
    api.name = name;
    if (sender) api.sender = toRealm(owner, sender);
    api.onMessage = this.onMessage.toApi();
    api.onDisconnect = this.onDisconnect.toApi();
    api.postMessage = (message: unknown) => this.post(message);
    api.disconnect = () => this.disconnect();
    this.api = api;
    owner.ports.add(this);
  }

  post(message: unknown): void {
    if (!this.connected) throw realmError(this.owner, "Attempting to use a disconnected port object");
    const payload = jsonClone(message === undefined ? null : message);
    for (const peer of this.peers) peer.receive(payload);
  }

  receive(payload: unknown): void {
    setTimeout(() => {
      if (!this.connected || !this.owner.alive) return;
      this.onMessage.dispatchSync(() => true, () => [jsonToRealm(this.owner, payload), this.api]);
    }, 0);
  }

  /** This side hangs up. The other side(s) see onDisconnect; this side doesn't. */
  disconnect(): void {
    if (!this.connected) return;
    this.connected = false;
    this.owner.ports.delete(this);
    for (const peer of this.peers) peer.peerGone(this);
    this.peers.clear();
  }

  disconnectFromRemote(): void {
    this.disconnect();
  }

  peerGone(peer: PortSide, error?: string): void {
    this.peers.delete(peer);
    if (this.peers.size || !this.connected) return;
    this.connected = false;
    this.owner.ports.delete(this);
    this.fireDisconnect(error);
  }

  fireDisconnect(error?: string): void {
    setTimeout(() => {
      if (!this.owner.alive) return;
      const ctx = this.owner;
      const previous = ctx.lastError;
      if (error) {
        ctx.lastError = { message: error };
        ctx.lastErrorChecked = false;
      }
      try {
        this.onDisconnect.dispatchSync(() => true, () => [this.api]);
      } finally {
        ctx.lastError = previous;
      }
    }, 0);
  }
}

export function openPort(
  registry: SapphireRegistry,
  sender: ExtensionContext,
  targets: ExtensionContext[],
  eventName: string,
  name: string,
  senderInfo: MessageSender,
): Record<string, unknown> {
  const callerSide = new PortSide(sender, name, undefined);
  const receivers = targets.filter((t) => t !== sender && registry.isAlive(t) && t.events.peek(eventName)?.hasListeners());
  if (!receivers.length) {
    callerSide.connected = false;
    sender.ports.delete(callerSide);
    callerSide.fireDisconnect(NO_RECEIVER);
    return callerSide.api;
  }
  for (const target of receivers) {
    const remote = new PortSide(target, name, senderInfo);
    remote.peers.add(callerSide);
    callerSide.peers.add(remote);
    // Queued as a task like the browser does; messages posted right after
    // connect() are queued behind it, so onConnect still runs first.
    setTimeout(() => {
      if (!target.alive) return;
      target.events.peek(eventName)?.dispatchSync(() => true, () => [remote.api]);
    }, 0);
  }
  return callerSide.api;
}
