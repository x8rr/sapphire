import type { DNRDecision, DNRHeaderInfo, DNRRule, DNRUrlTransform } from "./types";
import type { ExtensionState, SapphireRegistry } from "./registry";
import { extensionUrl } from "./urls";

export type ResourceType =
  | "main_frame"
  | "sub_frame"
  | "stylesheet"
  | "script"
  | "image"
  | "font"
  | "object"
  | "xmlhttprequest"
  | "ping"
  | "csp_report"
  | "media"
  | "websocket"
  | "webtransport"
  | "webbundle"
  | "other";

export const ALL_RESOURCE_TYPES: ResourceType[] = [
  "main_frame",
  "sub_frame",
  "stylesheet",
  "script",
  "image",
  "font",
  "object",
  "xmlhttprequest",
  "ping",
  "csp_report",
  "media",
  "websocket",
  "webtransport",
  "webbundle",
  "other",
];

export interface DnrRequest {
  url: URL;
  method: string;
  type: ResourceType;
  initiator: URL | null;
  tabId: number;
  /** Priority of an allowAllRequests rule that matched the requesting document, per extension. */
  allowAllPriority?: Map<string, number>;
}

export interface DnrMatch {
  extId: string;
  rulesetId: string;
  rule: DNRRule;
}

export interface DnrOutcome {
  action: "block" | "redirect" | "allow" | "allowAllRequests" | null;
  redirectUrl?: string;
  requestHeaders: DNRHeaderInfo[];
  responseHeaders: DNRHeaderInfo[];
  matched: DnrMatch[];
}

const ACTION_RANK: Record<string, number> = {
  allow: 5,
  allowAllRequests: 4,
  block: 3,
  upgradeScheme: 2,
  redirect: 1,
  modifyHeaders: 0,
};

interface CompiledRule {
  rule: DNRRule;
  rulesetId: string;
  priority: number;
  rank: number;
  regex: RegExp | null | undefined; // undefined = not compiled yet
  types: Set<string>;
  methods: Set<string> | null;
  excludedMethods: Set<string> | null;
}

interface CompiledIndex {
  version: number;
  byToken: Map<string, CompiledRule[]>;
  byDomain: Map<string, CompiledRule[]>;
  generic: CompiledRule[];
  hasModifyHeaders: boolean;
}

const indexCache = new WeakMap<ExtensionState, CompiledIndex>();

// A small table of multi-label public suffixes so domainType ("firstParty" /
// "thirdParty") gets the common cases right without shipping the full PSL.
const MULTI_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "ltd.uk", "plc.uk", "net.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au",
  "co.jp", "ne.jp", "or.jp", "ac.jp", "go.jp",
  "co.nz", "org.nz", "co.za", "co.in", "co.kr", "or.kr",
  "com.br", "com.cn", "com.mx", "com.ar", "com.tr", "com.tw", "com.hk", "com.sg", "com.my",
  "github.io", "gitlab.io", "blogspot.com", "herokuapp.com", "vercel.app", "netlify.app", "pages.dev", "workers.dev",
  "appspot.com", "cloudfront.net", "azurewebsites.net", "firebaseapp.com", "web.app",
]);

export function registrableDomain(hostname: string): string {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")) return host;
  const labels = host.split(".");
  if (labels.length <= 2) return host;
  const lastTwo = labels.slice(-2).join(".");
  if (MULTI_SUFFIXES.has(lastTwo)) return labels.slice(-3).join(".");
  return lastTwo;
}

function domainMatches(host: string, domains: string[]): boolean {
  for (const d of domains) {
    const dl = d.toLowerCase();
    if (host === dl || host.endsWith(`.${dl}`)) return true;
  }
  return false;
}

function urlFilterToRegExp(filter: string, caseSensitive: boolean): RegExp {
  let src = "";
  let i = 0;
  let pattern = filter;
  if (pattern.startsWith("||")) {
    src += "^[a-z][a-z0-9+.-]*:\\/\\/(?:[^\\/?#@]*@)?(?:[^\\/?#.]*\\.)*?";
    pattern = pattern.slice(2);
  } else if (pattern.startsWith("|")) {
    src += "^";
    pattern = pattern.slice(1);
  }
  let endAnchor = false;
  if (pattern.endsWith("|") && !pattern.endsWith("\\|")) {
    endAnchor = true;
    pattern = pattern.slice(0, -1);
  }
  for (i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") src += ".*";
    else if (ch === "^") src += "(?:[^a-zA-Z0-9_\\-.%]|$)";
    else src += ch.replace(/[.+?${}()|[\]\\/]/g, "\\$&");
  }
  if (endAnchor) src += "$";
  return new RegExp(src, caseSensitive ? "" : "i");
}

const COMMON_TOKENS = new Set(["http", "https", "www", "com", "net", "org", "html", "js", "css", "php"]);

function bestToken(filter: string): string | null {
  const lower = filter.toLowerCase();
  const anchoredStart = lower.startsWith("|");
  const anchoredEnd = lower.endsWith("|");
  const re = /[a-z0-9]+/g;
  let best: string | null = null;
  let bestScore = -1;
  for (let m = re.exec(lower); m; m = re.exec(lower)) {
    const s = m.index;
    const e = s + m[0].length;
    const before = s === 0 ? (anchoredStart ? "|" : "*") : lower[s - 1];
    const after = e === lower.length ? (anchoredEnd ? "|" : "*") : lower[e];
    if (before === "*" || after === "*") continue;
    const token = m[0];
    if (token.length < 2) continue;
    const score = token.length + (COMMON_TOKENS.has(token) ? -100 : 0);
    if (score > bestScore) {
      best = token;
      bestScore = score;
    }
  }
  return best;
}

function compileRule(rule: DNRRule, rulesetId: string): CompiledRule {
  const cond = rule.condition ?? {};
  let types: Set<string>;
  if (cond.resourceTypes?.length) types = new Set(cond.resourceTypes);
  else {
    const excluded = new Set(cond.excludedResourceTypes ?? ["main_frame"]);
    types = new Set(ALL_RESOURCE_TYPES.filter((t) => !excluded.has(t)));
  }
  return {
    rule,
    rulesetId,
    priority: rule.priority ?? 1,
    rank: ACTION_RANK[rule.action?.type] ?? 0,
    regex: undefined,
    types,
    methods: cond.requestMethods?.length ? new Set(cond.requestMethods.map((m) => m.toLowerCase())) : null,
    excludedMethods: cond.excludedRequestMethods?.length ? new Set(cond.excludedRequestMethods.map((m) => m.toLowerCase())) : null,
  };
}

function push(map: Map<string, CompiledRule[]>, key: string, rule: CompiledRule) {
  const list = map.get(key);
  if (list) list.push(rule);
  else map.set(key, [rule]);
}

export function allRules(ext: ExtensionState): { rule: DNRRule; rulesetId: string }[] {
  const out: { rule: DNRRule; rulesetId: string }[] = [];
  for (const rule of ext.dnr.dynamicRules) out.push({ rule, rulesetId: "_dynamic" });
  for (const rule of ext.dnr.sessionRules) out.push({ rule, rulesetId: "_session" });
  for (const id of ext.dnr.enabledRulesets) {
    const disabled = ext.dnr.disabledStaticRules.get(id);
    for (const rule of ext.dnr.rulesets.get(id) ?? []) {
      if (disabled?.has(rule.id)) continue;
      out.push({ rule, rulesetId: id });
    }
  }
  return out;
}

function buildIndex(ext: ExtensionState): CompiledIndex {
  const cached = indexCache.get(ext);
  if (cached && cached.version === ext.dnr.version) return cached;
  const index: CompiledIndex = { version: ext.dnr.version, byToken: new Map(), byDomain: new Map(), generic: [], hasModifyHeaders: false };
  for (const { rule, rulesetId } of allRules(ext)) {
    if (!rule?.action?.type || !rule.condition) continue;
    const compiled = compileRule(rule, rulesetId);
    if (rule.action.type === "modifyHeaders") index.hasModifyHeaders = true;
    const cond = rule.condition;
    const token = cond.urlFilter && !cond.regexFilter ? bestToken(cond.urlFilter) : null;
    if (token) push(index.byToken, token, compiled);
    else if (!cond.urlFilter && !cond.regexFilter && cond.requestDomains?.length) {
      for (const d of cond.requestDomains) push(index.byDomain, d.toLowerCase(), compiled);
    } else index.generic.push(compiled);
  }
  indexCache.set(ext, index);
  return index;
}

function ruleMatches(c: CompiledRule, req: DnrRequest, urlString: string, host: string): boolean {
  const cond = c.rule.condition;
  if (!c.types.has(req.type)) return false;
  const method = req.method.toLowerCase();
  if (c.methods && !c.methods.has(method)) return false;
  if (c.excludedMethods?.has(method)) return false;
  if (cond.tabIds && !cond.tabIds.includes(req.tabId)) return false;
  if (cond.excludedTabIds?.includes(req.tabId)) return false;
  if (cond.requestDomains?.length && !domainMatches(host, cond.requestDomains)) return false;
  if (cond.excludedRequestDomains?.length && domainMatches(host, cond.excludedRequestDomains)) return false;
  const initiatorDomains = cond.initiatorDomains ?? cond.domains;
  const excludedInitiatorDomains = cond.excludedInitiatorDomains ?? cond.excludedDomains;
  const initHost = req.initiator?.hostname.toLowerCase() ?? null;
  if (initiatorDomains?.length && (!initHost || !domainMatches(initHost, initiatorDomains))) return false;
  if (excludedInitiatorDomains?.length && initHost && domainMatches(initHost, excludedInitiatorDomains)) return false;
  if (cond.domainType) {
    const firstParty = initHost !== null && registrableDomain(initHost) === registrableDomain(host);
    if (cond.domainType === "firstParty" && !firstParty) return false;
    if (cond.domainType === "thirdParty" && (firstParty || initHost === null)) return false;
  }
  if (cond.urlFilter || cond.regexFilter) {
    if (c.regex === undefined) {
      try {
        c.regex = cond.regexFilter
          ? new RegExp(cond.regexFilter, cond.isUrlFilterCaseSensitive ? "" : "i")
          : urlFilterToRegExp(cond.urlFilter!, cond.isUrlFilterCaseSensitive === true);
      } catch {
        c.regex = null;
      }
    }
    if (!c.regex || !c.regex.test(urlString)) return false;
  }
  return true;
}

function candidates(index: CompiledIndex, urlString: string, host: string): Set<CompiledRule> | CompiledRule[] {
  const out = new Set<CompiledRule>(index.generic);
  if (index.byToken.size) {
    const seen = new Set<string>();
    for (const token of urlString.toLowerCase().split(/[^a-z0-9]+/)) {
      if (token.length < 2 || seen.has(token)) continue;
      seen.add(token);
      const list = index.byToken.get(token);
      if (list) for (const r of list) out.add(r);
    }
  }
  if (index.byDomain.size) {
    let h = host;
    for (;;) {
      const list = index.byDomain.get(h);
      if (list) for (const r of list) out.add(r);
      const dot = h.indexOf(".");
      if (dot === -1) break;
      h = h.slice(dot + 1);
    }
  }
  return out;
}

function applyTransform(url: URL, t: DNRUrlTransform): string {
  const u = new URL(url.href);
  if (t.scheme) u.protocol = `${t.scheme}:`;
  if (t.host !== undefined) u.hostname = t.host;
  if (t.port !== undefined) u.port = t.port;
  if (t.path !== undefined) u.pathname = t.path;
  if (t.query !== undefined) u.search = t.query;
  if (t.queryTransform) {
    const params = u.searchParams;
    for (const p of t.queryTransform.removeParams ?? []) params.delete(p);
    for (const { key, value, replaceOnly } of t.queryTransform.addOrReplaceParams ?? []) {
      if (replaceOnly && !params.has(key)) continue;
      params.set(key, value);
    }
  }
  if (t.fragment !== undefined) u.hash = t.fragment;
  if (t.username !== undefined) u.username = t.username;
  if (t.password !== undefined) u.password = t.password;
  return u.href;
}

function redirectTarget(ext: ExtensionState, c: CompiledRule, req: DnrRequest, urlString: string): string | null {
  const action = c.rule.action;
  if (action.type === "upgradeScheme") {
    const u = new URL(req.url.href);
    if (u.protocol === "http:") u.protocol = "https:";
    else if (u.protocol === "ws:") u.protocol = "wss:";
    else return null;
    return u.href;
  }
  const r = action.redirect;
  if (!r) return null;
  if (r.url) return r.url;
  if (r.extensionPath) return extensionUrl(ext.id, r.extensionPath);
  if (r.transform) return applyTransform(req.url, r.transform);
  if (r.regexSubstitution && c.rule.condition.regexFilter && c.regex) {
    const m = urlString.match(c.regex);
    if (!m) return null;
    return r.regexSubstitution.replace(/\\(\d)/g, (_, d) => m[Number(d)] ?? "");
  }
  return null;
}

/** Evaluate one extension's rules. */
function evaluateExtension(ext: ExtensionState, req: DnrRequest): {
  best: CompiledRule | null;
  headerRules: CompiledRule[];
  matched: CompiledRule[];
  redirectUrl?: string;
} {
  const index = buildIndex(ext);
  const urlString = req.url.href.split("#")[0];
  const host = req.url.hostname.toLowerCase();
  let best: CompiledRule | null = null;
  const headerRules: CompiledRule[] = [];
  const matched: CompiledRule[] = [];
  let redirectUrl: string | undefined;
  for (const c of candidates(index, urlString, host)) {
    if (!ruleMatches(c, req, urlString, host)) continue;
    if (c.rule.action.type === "modifyHeaders") {
      headerRules.push(c);
      continue;
    }
    if (c.rule.action.type === "allowAllRequests" && req.type !== "main_frame" && req.type !== "sub_frame") continue;
    if (c.rule.action.type === "redirect" || c.rule.action.type === "upgradeScheme") {
      const target = redirectTarget(ext, c, req, urlString);
      if (!target || target === req.url.href) continue;
      if (!best || c.priority > best.priority || (c.priority === best.priority && c.rank > best.rank)) {
        best = c;
        redirectUrl = target;
      }
      continue;
    }
    if (!best || c.priority > best.priority || (c.priority === best.priority && c.rank > best.rank)) {
      best = c;
      redirectUrl = undefined;
    }
  }
  // An allowAllRequests match on the requesting document acts like an allow
  // rule of that priority for everything the document loads.
  const inherited = req.allowAllPriority?.get(ext.id);
  if (inherited !== undefined && (!best || inherited >= best.priority)) {
    best = { rule: { id: -1, condition: {}, action: { type: "allow" } }, rulesetId: "_inherited", priority: inherited, rank: ACTION_RANK.allow, regex: null, types: new Set(), methods: null, excludedMethods: null };
    redirectUrl = undefined;
  }
  if (best) matched.push(best);
  const allowFloor = best && (best.rule.action.type === "allow" || best.rule.action.type === "allowAllRequests") ? best.priority : -Infinity;
  const effectiveHeaders = headerRules.filter((h) => h.priority > allowFloor).sort((a, b) => b.priority - a.priority);
  matched.push(...effectiveHeaders);
  return { best, headerRules: effectiveHeaders, matched, redirectUrl };
}

function mergeHeaderOps(target: DNRHeaderInfo[], ops: DNRHeaderInfo[] | undefined) {
  for (const op of ops ?? []) {
    const name = op.header.toLowerCase();
    const prior = target.filter((t) => t.header.toLowerCase() === name);
    // A higher-priority set/remove owns the header; later rules may only keep appending.
    if (prior.some((p) => p.operation !== "append") && op.operation !== "append") continue;
    if (prior.some((p) => p.operation === "remove")) continue;
    target.push(op);
  }
}

export function evaluateRequest(registry: SapphireRegistry, req: DnrRequest): DnrOutcome {
  const outcome: DnrOutcome = { action: null, requestHeaders: [], responseHeaders: [], matched: [] };
  // Most recently installed extension wins ties, as in Chrome.
  const exts = registry
    .list()
    .filter((e) => e.enabled)
    .sort((a, b) => b.installedAt - a.installedAt);
  let redirect: string | undefined;
  let blocked = false;
  let allowAll = false;
  for (const ext of exts) {
    const hasRules =
      ext.dnr.dynamicRules.length || ext.dnr.sessionRules.length || ext.dnr.enabledRulesets.size || req.allowAllPriority?.has(ext.id);
    if (!hasRules) continue;
    const r = evaluateExtension(ext, req);
    for (const c of r.matched) outcome.matched.push({ extId: ext.id, rulesetId: c.rulesetId, rule: c.rule });
    const type = r.best?.rule.action.type;
    if (type === "block") blocked = true;
    else if ((type === "redirect" || type === "upgradeScheme") && r.redirectUrl && redirect === undefined) redirect = r.redirectUrl;
    else if (type === "allowAllRequests") allowAll = true;
    for (const h of r.headerRules) {
      mergeHeaderOps(outcome.requestHeaders, h.rule.action.requestHeaders);
      mergeHeaderOps(outcome.responseHeaders, h.rule.action.responseHeaders);
    }
  }
  if (blocked) outcome.action = "block";
  else if (redirect) {
    outcome.action = "redirect";
    outcome.redirectUrl = redirect;
  } else if (allowAll) outcome.action = "allowAllRequests";
  else if (outcome.matched.length) outcome.action = "allow";
  return outcome;
}

/** Priority of allowAllRequests rules that matched this frame navigation, per extension. */
export function allowAllPriorities(outcome: DnrOutcome): Map<string, number> {
  const map = new Map<string, number>();
  for (const m of outcome.matched) {
    if (m.rule.action.type !== "allowAllRequests") continue;
    const p = m.rule.priority ?? 1;
    map.set(m.extId, Math.max(map.get(m.extId) ?? -Infinity, p));
  }
  return map;
}

export function applyHeaderOps(headers: [string, string][], ops: DNRHeaderInfo[]): [string, string][] {
  let out = headers;
  for (const op of ops) {
    const name = op.header.toLowerCase();
    if (op.operation === "remove") out = out.filter(([k]) => k.toLowerCase() !== name);
    else if (op.operation === "set") out = [...out.filter(([k]) => k.toLowerCase() !== name), [op.header, op.value ?? ""]];
    else if (op.operation === "append") {
      const existing = out.find(([k]) => k.toLowerCase() === name);
      if (existing && name !== "set-cookie") existing[1] = `${existing[1]}; ${op.value ?? ""}`;
      else out = [...out, [op.header, op.value ?? ""]];
    }
  }
  return out;
}

export function recomputeStaticRules(ext: ExtensionState): void {
  ext.dnr.version++;
}

export function isRegexSupported(regex: string): { isSupported: boolean; reason?: string } {
  // Chrome evaluates regexFilter with RE2: no lookaround, no backreferences.
  if (/\(\?[=!<]|\\[1-9]/.test(regex)) return { isSupported: false, reason: "syntaxError" };
  try {
    new RegExp(regex);
  } catch {
    return { isSupported: false, reason: "syntaxError" };
  }
  if (regex.length > 2048) return { isSupported: false, reason: "memoryLimitExceeded" };
  return { isSupported: true };
}

export function validateRule(rule: DNRRule): string | null {
  if (!rule || typeof rule.id !== "number" || !Number.isInteger(rule.id) || rule.id < 1) return `Rule with id ${rule?.id} must have a positive integer id.`;
  if (!rule.action?.type) return `Rule with id ${rule.id} does not specify an action type.`;
  if (!ACTION_RANK.hasOwnProperty(rule.action.type)) return `Rule with id ${rule.id} has an invalid action type.`;
  if (rule.condition?.urlFilter !== undefined && rule.condition?.regexFilter !== undefined)
    return `Rule with id ${rule.id} specifies both "urlFilter" and "regexFilter".`;
  if (rule.condition?.regexFilter && !isRegexSupported(rule.condition.regexFilter).isSupported)
    return `Rule with id ${rule.id} specified a non-supported regex.`;
  if (rule.action.type === "redirect" && !rule.action.redirect) return `Rule with id ${rule.id} does not provide the "redirect" key.`;
  if (rule.action.type === "modifyHeaders" && !rule.action.requestHeaders?.length && !rule.action.responseHeaders?.length)
    return `Rule with id ${rule.id} does not specify the "requestHeaders" or "responseHeaders" key.`;
  return null;
}

/** Legacy synchronous entry point kept from the previous public API. */
export function checkDeclarativeNetRequest(
  registry: SapphireRegistry,
  requestUrl: string,
  initiatorUrl?: string,
  resourceType?: string,
): DNRDecision | null {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }
  let initiator: URL | null = null;
  try {
    initiator = initiatorUrl ? new URL(initiatorUrl) : null;
  } catch {
    initiator = null;
  }
  const outcome = evaluateRequest(registry, {
    url,
    method: "GET",
    type: (resourceType as ResourceType) ?? "other",
    initiator,
    tabId: -1,
  });
  if (outcome.action === "block") return { action: "block" };
  if (outcome.action === "redirect" && outcome.redirectUrl) return { action: "redirect", url: outcome.redirectUrl };
  if (outcome.requestHeaders.length || outcome.responseHeaders.length)
    return { action: "modifyHeaders", headers: outcome.requestHeaders, responseHeaders: outcome.responseHeaders };
  return null;
}
