// Chrome match patterns: https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns
// Semantics that matter and are easy to get wrong:
//   - a pattern without a port matches any port (http://127.0.0.1/* matches :5200)
//   - "*.example.com" also matches example.com itself
//   - the path part is matched against path + query, never the fragment
//   - scheme "*" means http or https only (plus ws/wss for host permissions)

interface CompiledPattern {
  all: boolean;
  schemes: string[] | null;
  host: string | null; // null = any host
  subdomains: boolean;
  port: string | null; // null = any port
  path: RegExp;
}

const cache = new Map<string, CompiledPattern | null>();

function globToRegExp(glob: string, questionMark: boolean): RegExp {
  let re = "";
  for (const ch of glob) {
    if (ch === "*") re += ".*";
    else if (ch === "?" && questionMark) re += ".";
    else re += ch.replace(/[.+^${}()|[\]\\?]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "s");
}

function compile(pattern: string): CompiledPattern | null {
  if (cache.has(pattern)) return cache.get(pattern)!;
  let result: CompiledPattern | null = null;
  if (pattern === "<all_urls>") {
    result = { all: true, schemes: null, host: null, subdomains: false, port: null, path: /.*/ };
  } else {
    const m = pattern.match(/^(\*|[a-z][a-z0-9+.-]*):\/\/([^/]*)(\/.*)?$/i);
    if (m) {
      const scheme = m[1].toLowerCase();
      let hostPart = m[2].toLowerCase();
      const path = m[3] ?? "/*";
      let port: string | null = null;
      const portMatch = hostPart.match(/^(.*?)(?::(\d+|\*))?$/);
      if (portMatch) {
        hostPart = portMatch[1];
        port = portMatch[2] && portMatch[2] !== "*" ? portMatch[2] : null;
      }
      let host: string | null = hostPart;
      let subdomains = false;
      if (host === "*" || (host === "" && scheme === "file")) host = null;
      else if (host.startsWith("*.")) {
        host = host.slice(2);
        subdomains = true;
      }
      result = {
        all: false,
        schemes: scheme === "*" ? ["http", "https", "ws", "wss"] : [scheme],
        host,
        subdomains,
        port,
        path: globToRegExp(path, false),
      };
    }
  }
  cache.set(pattern, result);
  return result;
}

const ALL_URLS_SCHEMES = new Set(["http", "https", "ws", "wss", "ftp", "file", "urn", "data"]);

export function matchPattern(pattern: string, url: string | URL): boolean {
  const compiled = compile(pattern);
  if (!compiled) return false;
  let u: URL;
  try {
    u = typeof url === "string" ? new URL(url) : url;
  } catch {
    return false;
  }
  const scheme = u.protocol.slice(0, -1).toLowerCase();
  if (compiled.all) return ALL_URLS_SCHEMES.has(scheme);
  if (compiled.schemes && !compiled.schemes.includes(scheme)) return false;
  const hostname = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (compiled.host !== null) {
    const h = compiled.host.replace(/^\[|\]$/g, "");
    if (compiled.subdomains) {
      if (hostname !== h && !hostname.endsWith(`.${h}`)) return false;
    } else if (hostname !== h) {
      return false;
    }
  }
  if (compiled.port !== null) {
    const effective = u.port || (scheme === "https" || scheme === "wss" ? "443" : scheme === "http" || scheme === "ws" ? "80" : "");
    if (effective !== compiled.port) return false;
  }
  const pathAndQuery = (u.pathname || "/") + u.search;
  return compiled.path.test(pathAndQuery);
}

export function isValidMatchPattern(pattern: string): boolean {
  return compile(pattern) !== null;
}

const globCache = new Map<string, RegExp>();

export function matchGlob(glob: string, url: string): boolean {
  let re = globCache.get(glob);
  if (!re) {
    re = globToRegExp(glob, true);
    globCache.set(glob, re);
  }
  return re.test(url);
}

export function urlMatchesPatterns(url: string, matches: string[], excludeMatches: string[] = []): boolean {
  if (!matches.some((p) => matchPattern(p, url))) return false;
  return !excludeMatches.some((p) => matchPattern(p, url));
}

export function urlMatchesContentScript(
  url: string,
  cs: { matches: string[]; excludeMatches: string[]; includeGlobs: string[]; excludeGlobs: string[] },
): boolean {
  if (!urlMatchesPatterns(url, cs.matches, cs.excludeMatches)) return false;
  if (cs.includeGlobs.length && !cs.includeGlobs.some((g) => matchGlob(g, url))) return false;
  if (cs.excludeGlobs.some((g) => matchGlob(g, url))) return false;
  return true;
}
