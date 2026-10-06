import { dbGet, dbPut, EXT_STATE_STORE } from "../db";
import { ApiError, asyncApi } from "../realm";
import type { AlarmRecord, ExtensionState } from "../registry";
import type { Sapphire } from "../sapphire";
import type { Env, Namespace } from "./env";

interface StoredAlarm {
  name: string;
  scheduledTime: number;
  periodInMinutes?: number;
}

// setTimeout clamps anything above ~24.8 days to 1ms; re-arm in chunks instead.
const MAX_TIMEOUT = 2 ** 31 - 1;

function persist(ext: ExtensionState): void {
  const list: StoredAlarm[] = [...ext.alarms.values()].map(({ name, scheduledTime, periodInMinutes }) => ({ name, scheduledTime, periodInMinutes }));
  void dbPut(EXT_STATE_STORE, `${ext.id}/alarms`, list).catch(() => {});
}

export function scheduleAlarm(s: Sapphire, ext: ExtensionState, alarm: StoredAlarm): void {
  const existing = ext.alarms.get(alarm.name);
  if (existing) clearTimeout(existing.timer);
  const arm = (): ReturnType<typeof setTimeout> => {
    const delay = Math.max(0, alarm.scheduledTime - Date.now());
    return setTimeout(
      () => {
        if (alarm.scheduledTime - Date.now() > 50) {
          record.timer = arm();
          return;
        }
        const fired = { name: alarm.name, scheduledTime: alarm.scheduledTime, ...(alarm.periodInMinutes ? { periodInMinutes: alarm.periodInMinutes } : {}) };
        if (alarm.periodInMinutes) {
          alarm.scheduledTime = Date.now() + alarm.periodInMinutes * 60000;
          record.scheduledTime = alarm.scheduledTime;
          record.timer = arm();
        } else {
          ext.alarms.delete(alarm.name);
        }
        persist(ext);
        s.registry.dispatch(ext.id, "alarms.onAlarm", [fired]);
      },
      Math.min(delay, MAX_TIMEOUT),
    );
  };
  const record: AlarmRecord = { name: alarm.name, scheduledTime: alarm.scheduledTime, periodInMinutes: alarm.periodInMinutes, timer: 0 as unknown as ReturnType<typeof setTimeout> };
  ext.alarms.set(alarm.name, record);
  record.timer = arm();
  persist(ext);
}

export async function restoreAlarms(s: Sapphire, ext: ExtensionState): Promise<void> {
  const stored = await dbGet<StoredAlarm[]>(EXT_STATE_STORE, `${ext.id}/alarms`).catch(() => undefined);
  for (const alarm of stored ?? []) {
    // A missed periodic alarm fires once on startup, like Chrome after sleep.
    if (alarm.scheduledTime < Date.now() && !alarm.periodInMinutes) alarm.scheduledTime = Date.now() + 1000;
    scheduleAlarm(s, ext, alarm);
  }
}

export function clearAlarms(ext: ExtensionState): void {
  for (const a of ext.alarms.values()) clearTimeout(a.timer);
  ext.alarms.clear();
}

export function createAlarms(env: Env): Namespace {
  const { s, ctx, ext } = env;
  const describe = (a: AlarmRecord) => ({ name: a.name, scheduledTime: a.scheduledTime, ...(a.periodInMinutes ? { periodInMinutes: a.periodInMinutes } : {}) });
  return {
    create: asyncApi(ctx, (nameOrInfo?: unknown, maybeInfo?: unknown) => {
      const name = typeof nameOrInfo === "string" ? nameOrInfo : "";
      const info = ((typeof nameOrInfo === "string" ? maybeInfo : nameOrInfo) ?? {}) as { when?: number; delayInMinutes?: number; periodInMinutes?: number };
      if (info.when !== undefined && info.delayInMinutes !== undefined) throw new ApiError("Cannot set both when and delayInMinutes.");
      const periodInMinutes = info.periodInMinutes !== undefined ? Number(info.periodInMinutes) : undefined;
      let scheduledTime: number;
      if (info.when !== undefined) scheduledTime = Number(info.when);
      else if (info.delayInMinutes !== undefined) scheduledTime = Date.now() + Number(info.delayInMinutes) * 60000;
      else if (periodInMinutes !== undefined) scheduledTime = Date.now() + periodInMinutes * 60000;
      else throw new ApiError("One of when, delayInMinutes or periodInMinutes must be set.");
      scheduleAlarm(s, ext, { name, scheduledTime, periodInMinutes });
    }),
    get: asyncApi(ctx, (name?: string) => {
      const a = ext.alarms.get(typeof name === "string" ? name : "");
      return a ? describe(a) : undefined;
    }),
    getAll: asyncApi(ctx, () => [...ext.alarms.values()].map(describe)),
    clear: asyncApi(ctx, (name?: string) => {
      const key = typeof name === "string" ? name : "";
      const a = ext.alarms.get(key);
      if (!a) return false;
      clearTimeout(a.timer);
      ext.alarms.delete(key);
      persist(ext);
      return true;
    }),
    clearAll: asyncApi(ctx, () => {
      const had = ext.alarms.size > 0;
      clearAlarms(ext);
      persist(ext);
      return had;
    }),
    onAlarm: ctx.events.api("alarms.onAlarm"),
  };
}
