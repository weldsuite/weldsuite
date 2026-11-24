/**
 * The dashboard chart has one point per day from `days` ago up to today,
 * however the clock moves while it is built.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit/db';
import { getDashboardChart } from './domains';

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

afterEach(() => vi.unstubAllGlobals());

/** A clock that moves one millisecond on every `new Date()` without arguments. */
function stubTickingClock(start: number) {
  const RealDate = Date;
  let now = start;
  class TickingDate extends RealDate {
    constructor(...args: ConstructorParameters<typeof Date> | []) {
      if (args.length === 0) super(now++);
      else super(...(args as ConstructorParameters<typeof Date>));
    }
  }
  vi.stubGlobal('Date', TickingDate);
}

describe('getDashboardChart', () => {
  it('keeps today when the clock ticks between reading the start and the end', async () => {
    stubTickingClock(Date.UTC(2026, 10, 24, 12, 0, 0));
    const one = await getDashboardChart(db, 1);
    expect(one.map((p) => p.date)).toEqual(['2026-11-23', '2026-11-24']);
    const month = await getDashboardChart(db, 30);
    expect(month).toHaveLength(31);
    expect(month.at(-1)?.date).toBe('2026-11-24');
  });
});
