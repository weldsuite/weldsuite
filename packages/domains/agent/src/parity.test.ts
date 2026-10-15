/**
 * WeldAgent Grok-parity unit tests (no DB).
 */

import { describe, expect, it } from 'vitest';
import { computeNextHourlyRun, routineScheduleError, toolRiskLevel } from './parity';

describe('weldagent parity helpers', () => {
  it('marks consequential tools as high risk', () => {
    expect(toolRiskLevel('computer_exec')).toBe('high');
    expect(toolRiskLevel('list_people')).toBe('low');
  });

  it('schedules the next UTC hour', () => {
    const from = new Date('2026-09-14T17:41:00.000Z');
    const next = computeNextHourlyRun(from);
    expect(next.toISOString()).toBe('2026-09-14T18:00:00.000Z');
  });

  it('rejects a cron or timezone that would fall back to hourly', () => {
    expect(routineScheduleError('0 7 * * 1-5', 'Europe/Amsterdam')).toBeNull();
    expect(routineScheduleError(undefined, 'Europe/Amsterdam')).toBeNull();
    expect(routineScheduleError('0 7 * * 1-5', 'Mars/Olympus')).toMatch(/Unknown timezone/);
    expect(routineScheduleError('every morning', 'UTC')).toMatch(/five fields/);
    expect(routineScheduleError('0 7 31 2 *', 'UTC')).toMatch(/never fires/);
  });
});
