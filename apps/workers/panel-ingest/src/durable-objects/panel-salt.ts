/**
 * PanelSalt: the daily salt of the cookieless visitor hash (ADR PANEL-006).
 *
 * One global instance (`PANEL_SALT.idFromName('global')`). It hands out a
 * random salt per UTC date, creating it on first use, and an alarm deletes
 * salts older than yesterday. Once a salt is gone, nobody (including us) can
 * recompute that day's visitor hashes from an IP and user agent, which is what
 * makes them anonymous rather than merely pseudonymous. Yesterday's salt stays
 * for isolates whose clock is a little behind.
 *
 * Isolates cache the salt for the date (lib/visitor.ts), so this object sees
 * one call per isolate per day, not one per event.
 */

import { DurableObject } from 'cloudflare:workers';
import { utcDate } from '../lib/time';

const DAY_MS = 24 * 60 * 60 * 1000;
const KEY_PREFIX = 'salt:';

function newSalt(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export class PanelSalt extends DurableObject {
  /** Today's salt (UTC), created on first use. Called over RPC by `todaysSalt`. */
  async today(): Promise<{ date: string; salt: string }> {
    const now = Date.now();
    const date = utcDate(now);
    const key = KEY_PREFIX + date;

    const existing = await this.ctx.storage.get<string>(key);
    if (existing) return { date, salt: existing };

    // The input gate holds other calls back during the read and the write, so two callers cannot both create a salt.
    const salt = newSalt();
    await this.ctx.storage.put(key, salt);
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(nextCleanup(now));
    }
    return { date, salt };
  }

  /** Drops salts older than yesterday; goes on daily while any salt is left. */
  async alarm(): Promise<void> {
    const now = Date.now();
    const oldestKept = KEY_PREFIX + utcDate(now - DAY_MS);

    const salts = await this.ctx.storage.list<string>({ prefix: KEY_PREFIX });
    const expired = [...salts.keys()].filter((key) => key < oldestKept);
    if (expired.length > 0) await this.ctx.storage.delete(expired);

    if (salts.size > expired.length) await this.ctx.storage.setAlarm(nextCleanup(now));
  }
}

/** A minute past the next UTC midnight, when yesterday's yesterday becomes deletable. */
function nextCleanup(now: number): number {
  return Math.floor(now / DAY_MS) * DAY_MS + DAY_MS + 60_000;
}
