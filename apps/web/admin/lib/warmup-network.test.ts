import { describe, expect, it } from 'vitest';
import {
  STAFF_PAUSE_REASON,
  WARMUP_MIN_DAYS,
  canPause,
  canResume,
  fillPlacementDays,
  formatRate,
  isPoolStatus,
  lastUtcDays,
  likePattern,
  placementShare,
  poolDomainsFlag,
  rateTone,
  shortenError,
  stalledReason,
  startOfUtcDay,
  sumPlacement,
  unpausedStatus,
  type PlacementDay,
} from './warmup-network';

describe('unpausedStatus', () => {
  it('returns a mailbox that never started to waiting', () => {
    expect(unpausedStatus({ startedAt: null, rampDay: 0 })).toBe('waiting');
  });

  it('keeps warming until the ramp is done, then maintains', () => {
    const startedAt = new Date('2026-10-01T00:00:00.000Z');
    expect(unpausedStatus({ startedAt, rampDay: 1 })).toBe('warming');
    expect(unpausedStatus({ startedAt, rampDay: WARMUP_MIN_DAYS - 1 })).toBe('warming');
    expect(unpausedStatus({ startedAt, rampDay: WARMUP_MIN_DAYS })).toBe('maintaining');
    expect(unpausedStatus({ startedAt: startedAt.toISOString(), rampDay: 30 })).toBe('maintaining');
  });
});

describe('canPause / canResume', () => {
  it('pauses what is running or stuck in error, and resumes only what is paused', () => {
    for (const status of ['waiting', 'warming', 'maintaining', 'error'] as const) {
      expect(canPause(status)).toBe(true);
      expect(canResume(status)).toBe(false);
    }
    expect(canPause('paused')).toBe(false);
    expect(canResume('paused')).toBe(true);
    expect(canPause('removed')).toBe(false);
    expect(canResume('removed')).toBe(false);
  });
});

describe('isPoolStatus', () => {
  it('accepts the pool states and nothing else', () => {
    expect(isPoolStatus('maintaining')).toBe(true);
    expect(isPoolStatus('removed')).toBe(true);
    expect(isPoolStatus('active')).toBe(false);
    expect(isPoolStatus(null)).toBe(false);
  });
});

describe('formatRate / rateTone', () => {
  it('formats a rate with at most one decimal, and a dash without one', () => {
    expect(formatRate(0.92)).toBe('92%');
    expect(formatRate(0.8467)).toBe('84.7%');
    expect(formatRate(1)).toBe('100%');
    expect(formatRate(null)).toBe('—');
    expect(formatRate(undefined)).toBe('—');
  });

  it('is low below the 85% gate and ok from it', () => {
    expect(rateTone(0.849)).toBe('low');
    expect(rateTone(0.85)).toBe('ok');
    expect(rateTone(null)).toBe('none');
  });
});

describe('poolDomainsFlag', () => {
  it('flags a pool of fewer than 3 domains and says how many are missing', () => {
    expect(poolDomainsFlag(0)).toEqual({ belowMinimum: true, missing: 3 });
    expect(poolDomainsFlag(2)).toEqual({ belowMinimum: true, missing: 1 });
  });

  it('is fine from 3 domains', () => {
    expect(poolDomainsFlag(3)).toEqual({ belowMinimum: false, missing: 0 });
    expect(poolDomainsFlag(12)).toEqual({ belowMinimum: false, missing: 0 });
  });
});

describe('UTC days', () => {
  const now = new Date('2026-10-13T15:42:10.000Z');

  it('starts the day at UTC midnight', () => {
    expect(startOfUtcDay(now).toISOString()).toBe('2026-10-13T00:00:00.000Z');
  });

  it('lists the last days oldest first, ending today', () => {
    expect(lastUtcDays(3, now)).toEqual(['2026-10-11', '2026-10-12', '2026-10-13']);
    expect(lastUtcDays(7, now)[0]).toBe('2026-10-07');
  });

  it('crosses a month boundary', () => {
    expect(lastUtcDays(3, new Date('2026-11-01T00:00:01.000Z'))).toEqual(['2026-10-30', '2026-10-31', '2026-11-01']);
  });
});

describe('placement', () => {
  const day = (overrides: Partial<PlacementDay> = {}): PlacementDay => ({
    day: '2026-10-12',
    inbox: 0,
    spam: 0,
    missing: 0,
    pending: 0,
    ...overrides,
  });

  it('shares the inbox over the emails that were checked, leaving pending ones out', () => {
    expect(placementShare(day({ inbox: 90, spam: 8, missing: 2, pending: 40 }))).toBeCloseTo(0.9);
    expect(placementShare(day({ pending: 12 }))).toBeNull();
  });

  it('fills days without mail with zeros, in the order asked', () => {
    const filled = fillPlacementDays([day({ day: '2026-10-12', inbox: 5 })], ['2026-10-11', '2026-10-12', '2026-10-13']);
    expect(filled.map((d) => d.day)).toEqual(['2026-10-11', '2026-10-12', '2026-10-13']);
    expect(filled[0]).toEqual(day({ day: '2026-10-11' }));
    expect(filled[1]?.inbox).toBe(5);
  });

  it('sums the days', () => {
    const total = sumPlacement([day({ inbox: 4, spam: 1 }), day({ inbox: 6, missing: 2, pending: 3 })]);
    expect(total).toEqual({ inbox: 10, spam: 1, missing: 2, pending: 3 });
  });
});

describe('likePattern', () => {
  it('wraps the term and escapes LIKE wildcards', () => {
    expect(likePattern('anna')).toBe('%anna%');
    expect(likePattern('50%_off\\')).toBe('%50\\%\\_off\\\\%');
  });
});

describe('shortenError / stalledReason', () => {
  it('collapses whitespace and cuts a long login error', () => {
    expect(shortenError('  AUTHENTICATIONFAILED\n  invalid credentials ')).toBe('AUTHENTICATIONFAILED invalid credentials');
    expect(shortenError('x'.repeat(200), 20)).toHaveLength(20);
    expect(shortenError('x'.repeat(200), 20)?.endsWith('…')).toBe(true);
    expect(shortenError('   ')).toBeNull();
    expect(shortenError(null)).toBeNull();
  });

  it('names the staff pause, a login error, or the stored reason', () => {
    expect(stalledReason({ status: 'paused', pausedReason: STAFF_PAUSE_REASON, lastLoginError: null })).toBe('Paused by staff');
    expect(stalledReason({ status: 'error', pausedReason: null, lastLoginError: 'bad password' })).toBe('Login error');
    expect(stalledReason({ status: 'paused', pausedReason: 'low_inbox_rate', lastLoginError: null })).toBe('low inbox rate');
    expect(stalledReason({ status: 'paused', pausedReason: null, lastLoginError: null })).toBe('—');
  });
});
