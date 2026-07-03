
import { dbGet, dbGetAllKeys, EXT_FILES_STORE } from "../db";
import { guessMime } from "../crx";
import { decodeSapphirePath, SAPPHIRE_PREFIX } from "../urlScheme";

const clientToExtId = new Map<string, string>();

function isBootstrapUrl(pathname: string): string | null {
  const match = pathname.match(/^\/~\/sx\/([^/]+)\/__bootstrap__$/);
  return match ? match[1] : null;
}

export function shouldRoute(event: FetchEvent): boolean {
  try {
    const url = new URL(event.request.url);
    if (url.pathname.startsWith(SAPPHIRE_PREFIX)) return true;
    if (url.origin !== self.location.origin) return false;
    return Boolean(event.clientId && clientToExtId.has(event.clientId));
  } catch {
    return false;
  }
}

async function serveExtensionFile(extId: string, path: string): Promise<Response | null> {
  const bytes = await dbGet<ArrayBuffer>(EXT_FILES_STORE, `${extId}/${path}`);
  if (!bytes) return null;
  return new Response(bytes, { status: 200, headers: { "Content-Type": guessMime(path) } });
}

export async function route(event: FetchEvent): Promise<Response> {
  const url = new URL(event.request.url);

  const bootstrapExtId = isBootstrapUrl(url.pathname);
  if (bootstrapExtId) {
    const clientId = (event as unknown as { resultingClientId?: string }).resultingClientId;
    if (clientId) clientToExtId.set(clientId, bootstrapExtId);
    return new Response("<!DOCTYPE html><html><head></head><body></body></html>", {
      status: 200,
      headers: { "Content-Type": "text/html" },
    });
  }

  if (url.pathname.startsWith(SAPPHIRE_PREFIX)) {
    const decoded = decodeSapphirePath(url.pathname);
    if (!decoded) return new Response("sapphire: malformed extension resource URL", { status: 400 });

    const response = await serveExtensionFile(decoded.extId, decoded.path);
    if (response) return response;

    const allKeys = await dbGetAllKeys(EXT_FILES_STORE);
    const prefix = `${decoded.extId}/`;
    const storedForExt = allKeys.filter((k) => typeof k === "string" && k.startsWith(prefix)).map((k) => (k as string).slice(prefix.length));
    return new Response(
      `sapphire: no such extension file: "${decoded.path}"\n\nFiles actually stored for this extension:\n${storedForExt.join("\n") || "(none)"}`,
      { status: 404, headers: { "Content-Type": "text/plain" } },
    );
  }

  const extId = event.clientId ? clientToExtId.get(event.clientId) : undefined;
  if (extId) {
    const response = await serveExtensionFile(extId, url.pathname.replace(/^\
    if (response) return response;
  }
  return fetch(event.request);
}
