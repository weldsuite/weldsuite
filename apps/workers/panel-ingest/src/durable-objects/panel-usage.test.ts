import { describe, expect, it } from 'vitest';
import { fakeDurableObjectContext } from '../testing/fakes';
import { PanelUsage } from './panel-usage';
import type { Env } from '../env';

function create() {
  const state = fakeDurableObjectContext();
  return { usage: new PanelUsage(state.ctx, {} as Env), ...state };
}

describe('PanelUsage', () => {
  it('counts events per UTC day', async () => {
    const { usage } = create();
    await usage.add('2026-10-27', 3);
    await usage.add('2026-10-27', 2);
    await usage.add('2026-10-28', 10);

    expect(await usage.month('2026-10')).toEqual({
      month: '2026-10',
      events: 15,
      days: { '2026-10-27': 5, '2026-10-28': 10 },
      recordings: 0,
      recordingDays: {},
    });
  });

  it('keeps months apart', async () => {
    const { usage } = create();
    await usage.add('2026-09-30', 7);
    await usage.add('2026-10-01', 1);

    expect((await usage.month('2026-09')).events).toBe(7);
    expect((await usage.month('2026-10')).events).toBe(1);
    expect(await usage.month('2026-11')).toEqual({ month: '2026-11', events: 0, days: {}, recordings: 0, recordingDays: {} });
  });

  it('counts recordings apart from events, per UTC day and month', async () => {
    const { usage } = create();
    await usage.addRecordings('2026-10-27', 1);
    await usage.addRecordings('2026-10-27', 2);
    await usage.addRecordings('2026-10-28', 1);
    await usage.addRecordings('2026-11-01', 5);
    await usage.add('2026-10-27', 4);

    expect(await usage.month('2026-10')).toEqual({
      month: '2026-10',
      events: 4,
      days: { '2026-10-27': 4 },
      recordings: 4,
      recordingDays: { '2026-10-27': 3, '2026-10-28': 1 },
    });
    expect((await usage.month('2026-11')).recordings).toBe(5);
  });

  it('refuses a malformed recording day or count', async () => {
    const { usage } = create();
    await expect(usage.addRecordings('2026-10', 1)).rejects.toThrow(RangeError);
    await expect(usage.addRecordings('2026-10-27', 0)).rejects.toThrow(RangeError);
    await expect(usage.addRecordings('2026-10-27', 1.5)).rejects.toThrow(RangeError);
  });

  it('refuses a malformed day, month or count', async () => {
    const { usage } = create();
    await expect(usage.add('2026-10', 1)).rejects.toThrow(RangeError);
    await expect(usage.add('27-10-2026', 1)).rejects.toThrow(RangeError);
    await expect(usage.add('2026-10-27', 0)).rejects.toThrow(RangeError);
    await expect(usage.add('2026-10-27', -1)).rejects.toThrow(RangeError);
    await expect(usage.add('2026-10-27', 1.5)).rejects.toThrow(RangeError);
    await expect(usage.month('2026')).rejects.toThrow(RangeError);
  });
});
