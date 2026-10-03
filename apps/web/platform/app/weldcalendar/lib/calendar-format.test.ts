import { describe, expect, it, vi } from 'vitest';

vi.mock('@/hooks/queries/use-settings-queries', () => ({ useUserPreferences: () => ({ data: undefined }) }));

import { formatClock, formatClockCompact, formatClockRange, toTimeFormat } from './calendar-format';

describe('calendar-format', () => {
  const evening = new Date(2026, 9, 1, 18, 0);
  const halfPast = new Date(2026, 9, 1, 23, 30);

  it('defaults unknown preferences to 12h', () => {
    expect(toTimeFormat(undefined)).toBe('12h');
    expect(toTimeFormat('24h')).toBe('24h');
  });

  it('keeps AM/PM in 12h', () => {
    expect(formatClock(evening, '12h')).toBe('6:00 PM');
    expect(formatClockCompact(evening, '12h')).toBe('6 PM');
    expect(formatClockCompact(halfPast, '12h')).toBe('11:30 PM');
  });

  it('uses 24h clock when preferred', () => {
    expect(formatClock(evening, '24h')).toBe('18:00');
    expect(formatClockCompact(halfPast, '24h')).toBe('23:30');
    expect(formatClockRange(evening, halfPast, '24h')).toBe('18:00 – 23:30');
  });
});
