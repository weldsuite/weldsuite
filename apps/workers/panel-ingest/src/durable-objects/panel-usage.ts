/**
 * PanelUsage: events and recordings counted per UTC day for one workspace,
 * across all its projects. One instance per workspace
 * (`PANEL_USAGE.idFromName(workspaceId)`).
 *
 * Recordings count under their own `recordings:` keys: one per session, when
 * its first chunk (seq 0) is stored.
 *
 * Settlement (ADR PANEL-007): the collector has no database, so while the
 * object holds counts panel-api has not seen, an alarm (about every five
 * minutes) sends the month's totals to panel-api over the `PANEL_API` service
 * binding. panel-api stores them, charges overage blocks to the credit wallet
 * and writes the quota state to KV (`panel:quota:<workspace>`), which the
 * collector reads. While the state is not `ok` the alarm keeps running even
 * without new counts: a blocked workspace sends nothing, so a top-up or a new
 * month would otherwise never lift the block.
 */

import { DurableObject } from 'cloudflare:workers';
import { parseQuotaState } from '@weldsuite/panel-domain/registry';
import type { Env } from '../env';

const EVENTS_PREFIX = 'events:';
const RECORDINGS_PREFIX = 'recordings:';
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-\d{2}$/;
const WORKSPACE_KEY = 'workspace';
const DIRTY_PREFIX = 'dirty:';
const QUOTA_KEY = 'quota';

/** How long counts wait before they are sent to panel-api, and between retries. */
export const SETTLE_INTERVAL_MS = 5 * 60 * 1000;
/** The route on panel-api's internal entrypoint; a service binding ignores the host. */
export const SETTLE_URL = 'https://panel-api.internal/internal/panel/usage/settle';

let warnedNoBinding = false;

export interface MonthUsage {
  month: string;
  /** Events counted in the month. */
  events: number;
  /** Events per UTC day (`YYYY-MM-DD`), days with no events left out. */
  days: Record<string, number>;
  /** Recordings started in the month. */
  recordings: number;
  /** Recordings per UTC day, days with none left out. */
  recordingDays: Record<string, number>;
}

export class PanelUsage extends DurableObject<Env> {
  /**
   * Count `events` accepted on the UTC `day`. Called over RPC by the collector,
   * which passes the workspace id so the object can name itself to panel-api.
   */
  async add(day: string, events: number, workspaceId?: string): Promise<void> {
    if (!DAY.test(day) || !Number.isSafeInteger(events) || events <= 0) {
      throw new RangeError('PanelUsage.add needs a YYYY-MM-DD day and a positive whole number of events');
    }
    const key = EVENTS_PREFIX + day;
    // Read-modify-write is safe here: the input gate holds other calls back while a storage operation is in flight.
    const current = (await this.ctx.storage.get<number>(key)) ?? 0;
    await this.ctx.storage.put(key, current + events);
    await this.markDirty(day, workspaceId);
  }

  /** Count `recordings` started on the UTC `day`. Called over RPC by the collector. */
  async addRecordings(day: string, recordings: number, workspaceId?: string): Promise<void> {
    if (!DAY.test(day) || !Number.isSafeInteger(recordings) || recordings <= 0) {
      throw new RangeError('PanelUsage.addRecordings needs a YYYY-MM-DD day and a positive whole number of recordings');
    }
    const key = RECORDINGS_PREFIX + day;
    const current = (await this.ctx.storage.get<number>(key)) ?? 0;
    await this.ctx.storage.put(key, current + recordings);
    await this.markDirty(day, workspaceId);
  }

  /** One UTC month (`YYYY-MM`): the totals and the count per day. */
  async month(month: string): Promise<MonthUsage> {
    if (!MONTH.test(month)) throw new RangeError('PanelUsage.month needs a YYYY-MM month');
    const [stored, storedRecordings] = await Promise.all([
      this.ctx.storage.list<number>({ prefix: EVENTS_PREFIX + month + '-' }),
      this.ctx.storage.list<number>({ prefix: RECORDINGS_PREFIX + month + '-' }),
    ]);

    const days: Record<string, number> = {};
    let events = 0;
    for (const [key, count] of stored) {
      days[key.slice(EVENTS_PREFIX.length)] = count;
      events += count;
    }
    const recordingDays: Record<string, number> = {};
    let recordings = 0;
    for (const [key, count] of storedRecordings) {
      recordingDays[key.slice(RECORDINGS_PREFIX.length)] = count;
      recordings += count;
    }
    return { month, events, days, recordings, recordingDays };
  }

  /**
   * Sends every month with counts panel-api has not seen (and, while the quota
   * state is not `ok`, the current month) to panel-api, and keeps the alarm
   * running until all of it was accepted and the state is `ok` again.
   */
  async alarm(): Promise<void> {
    const workspaceId = await this.ctx.storage.get<string>(WORKSPACE_KEY);
    if (!workspaceId) return;
    const api = this.env.PANEL_API;
    if (!api) {
      // Feature off: no settlement without the binding, and no point retrying.
      warnNoBindingOnce();
      return;
    }

    const { marks, months, current } = await this.pendingMonths();

    let again = false;
    for (const month of [...months].sort((a, b) => a.localeCompare(b))) {
      const usage = await this.month(month);
      let quota: string | null = null;
      try {
        quota = await settleMonth(api, workspaceId, month, usage);
      } catch (error) {
        console.error(`[panel-ingest] Usage settlement failed for workspace ${workspaceId}: ${error instanceof Error ? error.message : String(error)}`);
        again = true;
        continue;
      }

      // Counts that arrived while panel-api worked stay marked, and go out next time.
      const mark = marks.get(month);
      if (mark !== undefined && !(await this.clearIfUnchanged(month, mark))) again = true;
      if (month === current) await this.ctx.storage.put(QUOTA_KEY, parseQuotaState(quota));
    }

    const quotaNow = parseQuotaState((await this.ctx.storage.get<string>(QUOTA_KEY)) ?? null);
    if (again || quotaNow !== 'ok') await this.ctx.storage.setAlarm(Date.now() + SETTLE_INTERVAL_MS);
  }

  /** The months to send: those with unsent counts, and the current one while the quota state is not `ok`. */
  private async pendingMonths(): Promise<{ marks: Map<string, number>; months: Set<string>; current: string }> {
    const dirty = await this.ctx.storage.list<number>({ prefix: DIRTY_PREFIX });
    const marks = new Map<string, number>();
    for (const [key, mark] of dirty) marks.set(key.slice(DIRTY_PREFIX.length), mark);
    const current = new Date().toISOString().slice(0, 7);
    const lastQuota = parseQuotaState((await this.ctx.storage.get<string>(QUOTA_KEY)) ?? null);
    const months = new Set(marks.keys());
    if (lastQuota !== 'ok') months.add(current);
    return { marks, months, current };
  }

  /** Deletes the month's dirty mark when it is still `mark`; false when more counts arrived meanwhile. */
  private async clearIfUnchanged(month: string, mark: number): Promise<boolean> {
    if ((await this.ctx.storage.get<number>(DIRTY_PREFIX + month)) !== mark) return false;
    await this.ctx.storage.delete(DIRTY_PREFIX + month);
    return true;
  }

  /** Remembers that `day`'s month has counts panel-api has not seen, and makes sure an alarm is set. */
  private async markDirty(day: string, workspaceId?: string): Promise<void> {
    const storage = this.ctx.storage;
    if (workspaceId && (await storage.get<string>(WORKSPACE_KEY)) !== workspaceId) await storage.put(WORKSPACE_KEY, workspaceId);
    const key = DIRTY_PREFIX + day.slice(0, 7);
    await storage.put(key, ((await storage.get<number>(key)) ?? 0) + 1);
    if ((await storage.getAlarm()) === null) await storage.setAlarm(Date.now() + SETTLE_INTERVAL_MS);
  }
}

function warnNoBindingOnce(): void {
  if (warnedNoBinding) return;
  warnedNoBinding = true;
  console.warn('[panel-ingest] PANEL_API binding is missing: usage is counted but never settled');
}

/** Posts one month's counts to panel-api; resolves to the quota state it answered with. Throws when it did not accept them. */
async function settleMonth(api: Fetcher, workspaceId: string, month: string, usage: { events: number; recordings: number }): Promise<string | null> {
  const response = await api.fetch(SETTLE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspaceId, month, events: usage.events, recordings: usage.recordings }),
  });
  if (!response.ok) throw new Error(`panel-api answered ${response.status}`);
  return ((await response.json()) as { quota?: string }).quota ?? null;
}

/** Forgets that the missing binding was warned about. Tests only. */
export function resetUsageWarnings(): void {
  warnedNoBinding = false;
}
