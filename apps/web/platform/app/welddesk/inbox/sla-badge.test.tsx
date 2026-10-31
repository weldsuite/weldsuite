import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/i18n', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  return { getTranslations: (ns: keyof typeof english) => english[ns] };
});

import { deskSlaDisplay, formatSlaDuration } from './sla-badge';

const now = new Date('2026-11-02T10:00:00Z').getTime();
const inMinutes = (minutes: number) => new Date(now + minutes * 60_000).toISOString();

describe('deskSlaDisplay', () => {
  it('counts down to the soonest running clock', () => {
    const display = deskSlaDisplay(
      { state: 'open', slaStatus: 'active', slaDueAt: inMinutes(42), slaMetric: 'first_response' },
      now,
    );
    expect(display).toMatchObject({ label: 'First response in 42m', tone: 'ok' });
  });

  it('turns amber on a warning and red once overdue, without waiting for the server', () => {
    expect(
      deskSlaDisplay({ state: 'open', slaStatus: 'warning', slaDueAt: inMinutes(10), slaMetric: 'resolution' }, now),
    ).toMatchObject({ label: 'Resolution in 10m', tone: 'warning' });
    expect(
      deskSlaDisplay({ state: 'open', slaStatus: 'active', slaDueAt: inMinutes(-90), slaMetric: 'next_response' }, now),
    ).toMatchObject({ label: 'Next response overdue 1h 30m', tone: 'breached' });
  });

  it('shows paused and finished clocks only where asked', () => {
    const paused = { state: 'open' as const, slaStatus: 'paused' as const, slaDueAt: null, slaMetric: null };
    expect(deskSlaDisplay(paused, now)).toBeNull();
    expect(deskSlaDisplay(paused, now, { showPaused: true })).toMatchObject({ label: 'SLA paused', tone: 'muted' });
    expect(deskSlaDisplay({ ...paused, slaStatus: 'breached' }, now)).toMatchObject({ label: 'SLA breached' });
    expect(deskSlaDisplay({ ...paused, slaStatus: null }, now)).toBeNull();
  });
});

describe('formatSlaDuration', () => {
  it('rounds to minutes, hours and days', () => {
    expect(formatSlaDuration(30_000)).toBe('1m');
    expect(formatSlaDuration(3 * 3_600_000 + 5 * 60_000)).toBe('3h 5m');
    expect(formatSlaDuration(50 * 3_600_000)).toBe('2d 2h');
  });
});
