import { describe, expect, it } from 'vitest';
import { isSnoozeSweepCron, SNOOZE_SWEEP_CRONS } from './snooze-sweep';

describe('isSnoozeSweepCron', () => {
  it('accepts the production 5-minute cadence and the hourly test cadence', () => {
    expect(SNOOZE_SWEEP_CRONS).toEqual(['*/5 * * * *', '0 * * * *']);
    expect(isSnoozeSweepCron('*/5 * * * *')).toBe(true);
    expect(isSnoozeSweepCron('0 * * * *')).toBe(true);
  });

  it('ignores other schedules', () => {
    expect(isSnoozeSweepCron('* * * * *')).toBe(false);
    expect(isSnoozeSweepCron('*/15 * * * *')).toBe(false);
  });
});
