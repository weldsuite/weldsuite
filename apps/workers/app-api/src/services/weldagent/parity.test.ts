/**
 * WeldAgent Grok-parity unit tests (no DB).
 */

import { describe, expect, it } from 'vitest';
import { computeNextHourlyRun, toolRiskLevel } from '../../services/weldagent/parity';

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
});
