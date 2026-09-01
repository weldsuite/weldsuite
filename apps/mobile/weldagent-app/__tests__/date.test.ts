import { formatRelativeTime } from '@/lib/date';
import { interpolate } from '@/lib/i18n/interpolate';
import { en } from '@/lib/i18n/locales/en';

describe('formatRelativeTime', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-30T12:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns just now / minutes / hours / days', () => {
    expect(formatRelativeTime('2026-08-30T11:59:30.000Z', en.relativeTime, interpolate)).toBe(
      en.relativeTime.justNow,
    );
    expect(formatRelativeTime('2026-08-30T11:50:00.000Z', en.relativeTime, interpolate)).toBe(
      '10m ago',
    );
    expect(formatRelativeTime('2026-08-30T09:00:00.000Z', en.relativeTime, interpolate)).toBe(
      '3h ago',
    );
    expect(formatRelativeTime('2026-08-28T12:00:00.000Z', en.relativeTime, interpolate)).toBe(
      '2d ago',
    );
  });

  it('returns never for missing or invalid values', () => {
    expect(formatRelativeTime(null, en.relativeTime, interpolate)).toBe(en.relativeTime.never);
    expect(formatRelativeTime('nope', en.relativeTime, interpolate)).toBe(en.relativeTime.never);
  });
});
