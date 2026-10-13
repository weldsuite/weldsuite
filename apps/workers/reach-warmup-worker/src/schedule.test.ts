import { describe, expect, it } from 'vitest';
import { WARMUP_MAINTAIN_MAX, WARMUP_MAINTAIN_MIN, warmupRampTarget } from '@weldsuite/reach-domain/warmup';
import { businessWindowOn } from './lib/time';
import { MIN_GAP_MS, SENDS_PER_THREAD, dailyTargetFor, newThreadsFor, planDay, spreadTimes } from './schedule';
import { constant, seeded } from './test-support/fixtures';

const AMS = 'Europe/Amsterdam';
const TUESDAY = businessWindowOn('2026-10-13', AMS); // 07:00-15:30 UTC
const SATURDAY = businessWindowOn('2026-10-17', AMS);

describe('dailyTargetFor', () => {
  it('follows the ramp while warming, leaving room for the replies', () => {
    expect(dailyTargetFor('warming', 1, constant(0.5))).toBe(newThreadsFor(warmupRampTarget(1)));
    expect(dailyTargetFor('warming', 7, constant(0.5))).toBe(newThreadsFor(warmupRampTarget(7)));
    expect(dailyTargetFor('warming', 20, constant(0.5))).toBe(25);
  });

  it('keeps total sends near the target and never plans zero for a positive one', () => {
    expect(newThreadsFor(0)).toBe(0);
    expect(newThreadsFor(1)).toBe(1);
    for (const total of [2, 10, 15, 40]) {
      expect(Math.abs(newThreadsFor(total) * SENDS_PER_THREAD - total)).toBeLessThanOrEqual(SENDS_PER_THREAD);
    }
  });

  it('draws from the maintenance range while maintaining', () => {
    const rng = seeded(7);
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const target = dailyTargetFor('maintaining', 30, rng);
      expect(target).toBeGreaterThanOrEqual(newThreadsFor(WARMUP_MAINTAIN_MIN));
      expect(target).toBeLessThanOrEqual(newThreadsFor(WARMUP_MAINTAIN_MAX));
      seen.add(target);
    }
    expect(seen.size).toBeGreaterThan(2);
  });
});

describe('planDay', () => {
  it('plans the whole target when the day has not started', () => {
    const plan = planDay(20, TUESDAY, new Date('2026-10-12T22:05:00Z'));
    expect(plan.count).toBe(20);
    expect(plan.from.toISOString()).toBe('2026-10-13T07:00:00.000Z');
    expect(plan.until.toISOString()).toBe('2026-10-13T15:30:00.000Z');
  });

  it('plans proportionally fewer when the day is half over', () => {
    // 11:15 UTC is 13:15 Amsterdam: 4h15 of 8h30 left, half the target.
    const plan = planDay(20, TUESDAY, new Date('2026-10-13T11:13:00Z'));
    expect(plan.count).toBe(10);
    expect(plan.from.getTime()).toBeGreaterThan(new Date('2026-10-13T11:13:00Z').getTime());
  });

  it('plans nothing once business hours are over', () => {
    expect(planDay(20, TUESDAY, new Date('2026-10-13T15:29:30Z')).count).toBe(0);
    expect(planDay(20, TUESDAY, new Date('2026-10-13T18:00:00Z')).count).toBe(0);
  });

  it('plans nothing on a weekend', () => {
    expect(planDay(40, SATURDAY, new Date('2026-10-16T22:30:00Z')).count).toBe(0);
  });

  it('plans nothing for a zero target', () => {
    expect(planDay(0, TUESDAY, new Date('2026-10-12T22:05:00Z')).count).toBe(0);
  });
});

describe('spreadTimes', () => {
  const from = new Date('2026-10-13T07:00:00Z');
  const until = new Date('2026-10-13T15:30:00Z');

  it('returns sorted times inside the window, spread over the whole day', () => {
    const times = spreadTimes(from, until, 40, seeded(3));
    expect(times).toHaveLength(40);
    for (let i = 0; i < times.length; i++) {
      const at = times[i]!.getTime();
      expect(at).toBeGreaterThanOrEqual(from.getTime());
      expect(at).toBeLessThanOrEqual(until.getTime());
      if (i > 0) expect(at - times[i - 1]!.getTime()).toBeGreaterThanOrEqual(MIN_GAP_MS - 1);
    }
    // First and last quarter of the day both carry sends.
    const quarter = (until.getTime() - from.getTime()) / 4;
    expect(times.filter((t) => t.getTime() < from.getTime() + quarter).length).toBeGreaterThan(5);
    expect(times.filter((t) => t.getTime() > until.getTime() - quarter).length).toBeGreaterThan(5);
  });

  it('gives irregular gaps, not a fixed beat', () => {
    const times = spreadTimes(from, until, 12, seeded(11));
    const gaps = times.slice(1).map((t, i) => t.getTime() - times[i]!.getTime());
    expect(new Set(gaps.map((gap) => Math.round(gap / 1000))).size).toBe(gaps.length);
  });

  it('returns nothing for a zero count', () => {
    expect(spreadTimes(from, until, 0, constant(0.5))).toEqual([]);
  });
});
