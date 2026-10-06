import { dbPut, EXT_STATE_STORE } from "../db";
import { evaluateRequest, isRegexSupported, recomputeStaticRules, validateRule, type ResourceType } from "../dnr";
import { ApiError, asyncApi } from "../realm";
import type { ExtensionState } from "../registry";
import type { DNRRule } from "../types";
import type { Env, Namespace } from "./env";

const MAX_DYNAMIC = 30000;
const MAX_UNSAFE_DYNAMIC = 5000;
const MAX_SESSION = 5000;

export function persistDnr(ext: ExtensionState): void {
  void dbPut(EXT_STATE_STORE, `${ext.id}/dnr`, {
    dynamicRules: ext.dnr.dynamicRules,
    enabledRulesets: [...ext.dnr.enabledRulesets],
    disabledStaticRules: Object.fromEntries([...ext.dnr.disabledStaticRules].map(([k, v]) => [k, [...v]])),
  }).catch(() => {});
}

function applyUpdate(list: DNRRule[], options: { addRules?: DNRRule[]; removeRuleIds?: number[] }, max: number, label: string): DNRRule[] {
  const remove = new Set(options?.removeRuleIds ?? []);
  const next = list.filter((r) => !remove.has(r.id));
  const ids = new Set(next.map((r) => r.id));
  for (const rule of options?.addRules ?? []) {
    const err = validateRule(rule);
    if (err) throw new ApiError(err);
    if (ids.has(rule.id)) throw new ApiError(`Rule with id ${rule.id} does not have a unique ID.`);
    ids.add(rule.id);
    next.push(rule);
  }
  if (next.length > max) throw new ApiError(`${label} rule count exceeded.`);
  return next;
}

export function createDeclarativeNetRequest(env: Env): Namespace {
  const { s, ctx, ext } = env;
  const bump = () => {
    recomputeStaticRules(ext);
    persistDnr(ext);
    s.registry.notifyChange();
  };
  const filterRules = (rules: DNRRule[], filter?: { ruleIds?: number[] }) =>
    filter?.ruleIds ? rules.filter((r) => filter.ruleIds!.includes(r.id)) : rules;
  return {
    updateDynamicRules: asyncApi(ctx, (options: { addRules?: DNRRule[]; removeRuleIds?: number[] }) => {
      ext.dnr.dynamicRules = applyUpdate(ext.dnr.dynamicRules, options, MAX_DYNAMIC, "Dynamic");
      bump();
    }),
    getDynamicRules: asyncApi(ctx, (filter?: { ruleIds?: number[] }) => filterRules(ext.dnr.dynamicRules, filter)),
    updateSessionRules: asyncApi(ctx, (options: { addRules?: DNRRule[]; removeRuleIds?: number[] }) => {
      ext.dnr.sessionRules = applyUpdate(ext.dnr.sessionRules, options, MAX_SESSION, "Session");
      recomputeStaticRules(ext);
      s.registry.notifyChange();
    }),
    getSessionRules: asyncApi(ctx, (filter?: { ruleIds?: number[] }) => filterRules(ext.dnr.sessionRules, filter)),
    getEnabledRulesets: asyncApi(ctx, () => [...ext.dnr.enabledRulesets]),
    getAvailableStaticRuleCount: asyncApi(ctx, () => {
      let used = 0;
      for (const id of ext.dnr.enabledRulesets) used += ext.dnr.rulesets.get(id)?.length ?? 0;
      return Math.max(0, 300000 - used);
    }),
    updateEnabledRulesets: asyncApi(ctx, async (options: { enableRulesetIds?: string[]; disableRulesetIds?: string[] }) => {
      await s.ensureRulesetsLoaded(ext, options?.enableRulesetIds ?? []);
      for (const id of [...(options?.enableRulesetIds ?? []), ...(options?.disableRulesetIds ?? [])]) {
        if (!ext.dnr.rulesets.has(id)) throw new ApiError(`Invalid ruleset id: ${id}.`);
      }
      for (const id of options?.disableRulesetIds ?? []) ext.dnr.enabledRulesets.delete(id);
      for (const id of options?.enableRulesetIds ?? []) ext.dnr.enabledRulesets.add(id);
      bump();
    }),
    updateStaticRules: asyncApi(ctx, (options: { rulesetId: string; disableRuleIds?: number[]; enableRuleIds?: number[] }) => {
      if (!ext.dnr.rulesets.has(options?.rulesetId)) throw new ApiError(`Invalid ruleset id: ${options?.rulesetId}.`);
      const set = ext.dnr.disabledStaticRules.get(options.rulesetId) ?? new Set<number>();
      for (const id of options.disableRuleIds ?? []) set.add(id);
      for (const id of options.enableRuleIds ?? []) set.delete(id);
      ext.dnr.disabledStaticRules.set(options.rulesetId, set);
      bump();
    }),
    getDisabledRuleIds: asyncApi(ctx, (options: { rulesetId: string }) => [...(ext.dnr.disabledStaticRules.get(options?.rulesetId) ?? [])]),
    isRegexSupported: asyncApi(ctx, (options: { regex: string }) => isRegexSupported(String(options?.regex ?? ""))),
    testMatchOutcome: asyncApi(ctx, (request: { url: string; initiator?: string; method?: string; type: ResourceType; tabId?: number }) => {
      const outcome = evaluateRequest(s.registry, {
        url: new URL(request.url),
        initiator: request.initiator ? new URL(request.initiator) : null,
        method: request.method ?? "get",
        type: request.type,
        tabId: request.tabId ?? -1,
      });
      return {
        matchedRules: outcome.matched.filter((m) => m.extId === ext.id && m.rule.id > 0).map((m) => ({ ruleId: m.rule.id, rulesetId: m.rulesetId })),
      };
    }),
    getMatchedRules: asyncApi(ctx, (filter?: { tabId?: number; minTimeStamp?: number }) => ({
      rulesMatchedInfo: ext.dnr.matchedRules.filter(
        (m) => (filter?.tabId === undefined || m.tabId === filter.tabId) && (filter?.minTimeStamp === undefined || m.timeStamp >= filter.minTimeStamp),
      ),
    })),
    setExtensionActionOptions: asyncApi(ctx, (options: { displayActionCountAsBadgeText?: boolean; tabUpdate?: { tabId: number; increment: number } }) => {
      if (options?.displayActionCountAsBadgeText !== undefined) ext.dnr.displayActionCountAsBadgeText = options.displayActionCountAsBadgeText;
      if (options?.tabUpdate) {
        const { tabId, increment } = options.tabUpdate;
        ext.dnr.tabActionCounts.set(tabId, Math.max(0, (ext.dnr.tabActionCounts.get(tabId) ?? 0) + increment));
      }
      s.registry.notifyChange();
    }),
    onRuleMatchedDebug: ctx.events.api("declarativeNetRequest.onRuleMatchedDebug"),
    MAX_NUMBER_OF_RULES: 30000,
    GUARANTEED_MINIMUM_STATIC_RULES: 30000,
    MAX_NUMBER_OF_DYNAMIC_RULES: MAX_DYNAMIC,
    MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES: 5000,
    MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES: MAX_UNSAFE_DYNAMIC,
    MAX_NUMBER_OF_SESSION_RULES: MAX_SESSION,
    MAX_NUMBER_OF_UNSAFE_SESSION_RULES: 5000,
    MAX_NUMBER_OF_REGEX_RULES: 1000,
    MAX_NUMBER_OF_STATIC_RULESETS: 100,
    MAX_NUMBER_OF_ENABLED_STATIC_RULESETS: 50,
    MAX_GETMATCHEDRULES_CALLS_PER_INTERVAL: 20,
    GETMATCHEDRULES_QUOTA_INTERVAL: 10,
    DYNAMIC_RULESET_ID: "_dynamic",
    SESSION_RULESET_ID: "_session",
    ResourceType: Object.fromEntries(
      ["main_frame", "sub_frame", "stylesheet", "script", "image", "font", "object", "xmlhttprequest", "ping", "csp_report", "media", "websocket", "webtransport", "webbundle", "other"].map((t) => [t.toUpperCase(), t]),
    ),
    RuleActionType: { BLOCK: "block", REDIRECT: "redirect", ALLOW: "allow", UPGRADE_SCHEME: "upgradeScheme", MODIFY_HEADERS: "modifyHeaders", ALLOW_ALL_REQUESTS: "allowAllRequests" },
    HeaderOperation: { APPEND: "append", SET: "set", REMOVE: "remove" },
    DomainType: { FIRST_PARTY: "firstParty", THIRD_PARTY: "thirdParty" },
    RequestMethod: Object.fromEntries(["connect", "delete", "get", "head", "options", "patch", "post", "put", "other"].map((m) => [m.toUpperCase(), m])),
    UnsupportedRegexReason: { SYNTAX_ERROR: "syntaxError", MEMORY_LIMIT_EXCEEDED: "memoryLimitExceeded" },
  };
}
