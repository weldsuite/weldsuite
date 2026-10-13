import { describe, expect, it } from 'vitest';
import {
  WARMUP_MIN_DAYS,
  WARMUP_MIN_SAMPLE,
  WARMUP_RAMP_MAX,
  WARMUP_RAMP_START,
  domainOf,
  inboxRate,
  warmupGate,
  warmupRampTarget,
} from './warmup';

describe('warmupRampTarget', () => {
  it('plans nothing before the first day', () => {
    expect(warmupRampTarget(0)).toBe(0);
    expect(warmupRampTarget(-3)).toBe(0);
  });

  it('starts low and reaches the cap on the last warmup day', () => {
    expect(warmupRampTarget(1)).toBe(WARMUP_RAMP_START);
    expect(warmupRampTarget(WARMUP_MIN_DAYS)).toBe(WARMUP_RAMP_MAX);
    expect(warmupRampTarget(WARMUP_MIN_DAYS + 10)).toBe(WARMUP_RAMP_MAX);
  });

  it('never goes down from one day to the next', () => {
    for (let day = 1; day < WARMUP_MIN_DAYS; day++) {
      expect(warmupRampTarget(day + 1)).toBeGreaterThanOrEqual(warmupRampTarget(day));
    }
  });
});

describe('inboxRate', () => {
  it('is null below the minimum sample', () => {
    expect(inboxRate({ inbox: WARMUP_MIN_SAMPLE - 1, spam: 0, missing: 0 })).toBeNull();
  });

  it('counts spam and missing against the rate', () => {
    expect(inboxRate({ inbox: 17, spam: 2, missing: 1 })).toBeCloseTo(0.85);
  });
});

describe('warmupGate', () => {
  const ready = { rampDay: WARMUP_MIN_DAYS, inboxRate3d: 0.9, hasLoginError: false };

  it('lets a mailbox through after 14 days at 85% or more', () => {
    expect(warmupGate(ready)).toEqual({ ready: true });
    expect(warmupGate({ ...ready, inboxRate3d: 0.85 })).toEqual({ ready: true });
  });

  it('explains why a mailbox is not ready yet', () => {
    expect(warmupGate({ ...ready, rampDay: WARMUP_MIN_DAYS - 1 })).toEqual({ ready: false, reason: 'too_early' });
    expect(warmupGate({ ...ready, inboxRate3d: null })).toEqual({ ready: false, reason: 'not_enough_data' });
    expect(warmupGate({ ...ready, inboxRate3d: 0.84 })).toEqual({ ready: false, reason: 'low_inbox_rate' });
  });

  it('puts a login problem before everything else', () => {
    expect(warmupGate({ rampDay: 1, inboxRate3d: null, hasLoginError: true })).toEqual({ ready: false, reason: 'login_error' });
  });
});

describe('domainOf', () => {
  it('lower-cases the domain and handles missing @', () => {
    expect(domainOf('Jane@GetAcme.com ')).toBe('getacme.com');
    expect(domainOf('not-an-address')).toBe('');
  });
});
