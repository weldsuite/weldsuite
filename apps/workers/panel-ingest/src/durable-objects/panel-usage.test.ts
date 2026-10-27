import { describe, expect, it } from 'vitest';
import { fakeDurableObjectContext } from '../testing/fakes';
import { PanelUsage } from './panel-usage';

function create() {
  const state = fakeDurableObjectContext();
  return { usage: new PanelUsage(state.ctx, {}), ...state };
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
    });
  });

  it('keeps months apart', async () => {
    const { usage } = create();
    await usage.add('2026-09-30', 7);
    await usage.add('2026-10-01', 1);

    expect((await usage.month('2026-09')).events).toBe(7);
    expect((await usage.month('2026-10')).events).toBe(1);
    expect(await usage.month('2026-11')).toEqual({ month: '2026-11', events: 0, days: {} });
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
