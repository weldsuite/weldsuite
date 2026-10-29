/**
 * PanelUsage: events counted per UTC day for one workspace, across all its
 * projects. One instance per workspace (`PANEL_USAGE.idFromName(workspaceId)`).
 *
 * Phase 1 only counts. Plan allowances, overage settlement against the wallet,
 * the `panel:quota:<workspace>` KV state and the flush to the master
 * `panel_usage_monthly` table come in phase 7 (docs/plans/weldpanel.md).
 * Recordings will count under their own `recordings:` keys.
 */

import { DurableObject } from 'cloudflare:workers';

const EVENTS_PREFIX = 'events:';
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-\d{2}$/;

export interface MonthUsage {
  month: string;
  /** Events counted in the month. */
  events: number;
  /** Events per UTC day (`YYYY-MM-DD`), days with no events left out. */
  days: Record<string, number>;
}

export class PanelUsage extends DurableObject {
  /** Count `events` accepted on the UTC `day`. Called over RPC by the collector. */
  async add(day: string, events: number): Promise<void> {
    if (!DAY.test(day) || !Number.isSafeInteger(events) || events <= 0) {
      throw new RangeError('PanelUsage.add needs a YYYY-MM-DD day and a positive whole number of events');
    }
    const key = EVENTS_PREFIX + day;
    // Read-modify-write is safe here: the input gate holds other calls back while a storage operation is in flight.
    const current = (await this.ctx.storage.get<number>(key)) ?? 0;
    await this.ctx.storage.put(key, current + events);
  }

  /** One UTC month (`YYYY-MM`): the total and the count per day. */
  async month(month: string): Promise<MonthUsage> {
    if (!MONTH.test(month)) throw new RangeError('PanelUsage.month needs a YYYY-MM month');
    const stored = await this.ctx.storage.list<number>({ prefix: EVENTS_PREFIX + month + '-' });

    const days: Record<string, number> = {};
    let events = 0;
    for (const [key, count] of stored) {
      days[key.slice(EVENTS_PREFIX.length)] = count;
      events += count;
    }
    return { month, events, days };
  }
}
