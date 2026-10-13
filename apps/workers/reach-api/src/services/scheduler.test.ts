import { describe, expect, it } from 'vitest';
import type { SendSchedule } from '@weldsuite/reach-domain/send-window';
import {
  assessMailboxes,
  evaluateCampaignGate,
  gapEndsAt,
  isGapOver,
  jitterFraction,
  mailboxCapacity,
  nextStepDueAt,
  planSends,
  type PlanCampaign,
  type PlanContext,
  type PlanMailbox,
} from './scheduler';

const NOW = new Date('2026-10-12T10:00:00Z'); // Monday 12:00 in Amsterdam (CEST)
const MINUTE = 60_000;

const SCHEDULE: SendSchedule = { timezone: 'Europe/Amsterdam', sendDays: [1, 2, 3, 4, 5], windowStart: '09:00', windowEnd: '17:00' };

const ctx = (overrides: Partial<PlanContext> = {}): PlanContext => ({
  now: NOW,
  dayTimezone: 'Europe/Amsterdam',
  maxDailySends: 300,
  workspaceSentToday: 0,
  ...overrides,
});

const mailbox = (id: string, overrides: Partial<PlanMailbox> = {}): PlanMailbox => ({
  id,
  status: 'active',
  dailyCap: 30,
  rampCurrent: 30,
  lastSentAt: null,
  sentToday: 0,
  ...overrides,
});

const campaign = (overrides: Partial<PlanCampaign> = {}): PlanCampaign => ({
  id: 'c1',
  schedule: SCHEDULE,
  dailyLimit: 100,
  minGapMinutes: 8,
  sentToday: 0,
  mailboxIds: ['m1', 'm2'],
  ...overrides,
});

const mailboxMap = (...list: PlanMailbox[]) => new Map(list.map((m) => [m.id, m]));
const campaignMap = (...list: PlanCampaign[]) => new Map(list.map((c) => [c.id, c]));
const e = (id: string, mailboxId: string | null = null, campaignId = 'c1') => ({ id, campaignId, mailboxId });

describe('mailbox pacing', () => {
  it('caps a mailbox at the lower of its ramp and its daily cap', () => {
    expect(mailboxCapacity({ dailyCap: 30, rampCurrent: 10, sentToday: 4 })).toBe(6);
    expect(mailboxCapacity({ dailyCap: 5, rampCurrent: 10, sentToday: 4 })).toBe(1);
    expect(mailboxCapacity({ dailyCap: 30, rampCurrent: 10, sentToday: 12 })).toBe(0);
  });

  it('keeps the gap between 100% and 150% of the minimum and stable for the same previous send', () => {
    const lastSentAt = new Date(NOW.getTime() - 5 * MINUTE);
    const m = { id: 'm1', lastSentAt };
    const ends = gapEndsAt(m, 8) as Date;
    const gap = ends.getTime() - lastSentAt.getTime();
    expect(gap).toBeGreaterThanOrEqual(8 * MINUTE);
    expect(gap).toBeLessThanOrEqual(12 * MINUTE);
    expect(gapEndsAt(m, 8)).toEqual(ends);
    expect(gapEndsAt({ id: 'm1', lastSentAt: null }, 8)).toBeNull();
  });

  it('spreads jitter over 0 to 0.5', () => {
    const values = Array.from({ length: 200 }, (_, i) => jitterFraction(`mailbox:${i}`));
    expect(Math.min(...values)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...values)).toBeLessThanOrEqual(0.5);
    expect(new Set(values.map((v) => v.toFixed(2))).size).toBeGreaterThan(10);
  });

  it('says a gap is over once its end has passed', () => {
    const m = { id: 'm1', lastSentAt: new Date(NOW.getTime() - 13 * MINUTE) };
    expect(isGapOver(m, 8, NOW)).toBe(true);
    expect(isGapOver({ id: 'm1', lastSentAt: new Date(NOW.getTime() - 2 * MINUTE) }, 8, NOW)).toBe(false);
  });
});

describe('evaluateCampaignGate', () => {
  it('is open inside the window, under the limits', () => {
    expect(evaluateCampaignGate(campaign(), ctx())).toEqual({ open: true });
  });

  it('closes outside the window until it opens', () => {
    const early = ctx({ now: new Date('2026-10-12T05:00:00Z') }); // 07:00 CEST
    expect(evaluateCampaignGate(campaign(), early)).toEqual({
      open: false,
      reason: 'window',
      reopensAt: new Date('2026-10-12T07:00:00Z'),
    });
  });

  it('closes on a non-send day until the next send day', () => {
    const saturday = ctx({ now: new Date('2026-10-17T10:00:00Z') });
    expect(evaluateCampaignGate(campaign(), saturday)).toMatchObject({
      open: false,
      reason: 'window',
      reopensAt: new Date('2026-10-19T07:00:00Z'),
    });
  });

  it('closes at the campaign daily limit until tomorrow\'s window', () => {
    expect(evaluateCampaignGate(campaign({ sentToday: 100 }), ctx())).toEqual({
      open: false,
      reason: 'daily_limit',
      reopensAt: new Date('2026-10-13T07:00:00Z'),
    });
  });

  it('closes at the workspace maxDailySends for every campaign', () => {
    expect(evaluateCampaignGate(campaign(), ctx({ workspaceSentToday: 300 }))).toMatchObject({
      open: false,
      reason: 'workspace_limit',
      reopensAt: new Date('2026-10-13T07:00:00Z'),
    });
  });
});

describe('assessMailboxes', () => {
  it('sorts mailboxes into ready, gap-blocked, capped and unusable', () => {
    const justSent = mailbox('m3', { lastSentAt: new Date(NOW.getTime() - 2 * MINUTE) });
    const readiness = assessMailboxes(
      [
        mailbox('m1'),
        mailbox('m2', { sentToday: 30 }),
        justSent,
        mailbox('m4', { status: 'paused' }),
        mailbox('m5', { status: 'warming' }),
      ],
      [campaign()],
      NOW,
    );
    expect([...readiness.readyMailboxIds]).toEqual(['m1']);
    expect([...readiness.cappedMailboxIds]).toEqual(['m2']);
    expect([...readiness.unusableMailboxIds].sort()).toEqual(['m4', 'm5']);
    expect(readiness.gapBlockedUntil?.getTime()).toBe((gapEndsAt(justSent, 8) as Date).getTime());
  });
});

describe('planSends', () => {
  it('sends at most one email per mailbox per tick', () => {
    const plan = planSends(ctx(), campaignMap(campaign()), mailboxMap(mailbox('m1'), mailbox('m2')), [e('a'), e('b'), e('c')]);
    expect(plan.sends.map((s) => s.enrollmentId)).toEqual(['a', 'b']);
    expect(new Set(plan.sends.map((s) => s.mailboxId)).size).toBe(2);
    expect(plan.deferrals).toEqual([{ enrollmentId: 'c', until: null, reason: 'mailbox_busy' }]);
    expect(plan.retryAt?.getTime()).toBe(NOW.getTime() + MINUTE);
  });

  it('gives a first email to the mailbox with the most capacity left, and keeps it for follow-ups', () => {
    const mailboxes = mailboxMap(mailbox('m1', { sentToday: 25 }), mailbox('m2', { sentToday: 3 }));
    const first = planSends(ctx(), campaignMap(campaign()), mailboxes, [e('a')]);
    expect(first.sends).toEqual([{ enrollmentId: 'a', campaignId: 'c1', mailboxId: 'm2' }]);

    // The sticky mailbox is used even though another has more capacity.
    const followUp = planSends(ctx(), campaignMap(campaign()), mailboxes, [e('a', 'm1')]);
    expect(followUp.sends).toEqual([{ enrollmentId: 'a', campaignId: 'c1', mailboxId: 'm1' }]);
  });

  it('breaks capacity ties by who rested longest', () => {
    const mailboxes = mailboxMap(
      mailbox('m1', { lastSentAt: new Date(NOW.getTime() - 60 * MINUTE) }),
      mailbox('m2', { lastSentAt: new Date(NOW.getTime() - 120 * MINUTE) }),
    );
    expect(planSends(ctx(), campaignMap(campaign()), mailboxes, [e('a')]).sends[0]?.mailboxId).toBe('m2');
  });

  it('honours the ramp: a mailbox still ramping up stops at its current cap', () => {
    const mailboxes = mailboxMap(mailbox('m1', { rampCurrent: 10, sentToday: 10 }), mailbox('m2', { status: 'paused' }));
    const plan = planSends(ctx(), campaignMap(campaign()), mailboxes, [e('a')]);
    expect(plan.sends).toEqual([]);
    // m2 is not active, m1 is capped: tomorrow's window
    expect(plan.deferrals).toEqual([{ enrollmentId: 'a', until: new Date('2026-10-13T07:00:00Z'), reason: 'mailbox_capacity' }]);
  });

  it('waits for the gap and reports when to look again', () => {
    const lastSentAt = new Date(NOW.getTime() - 3 * MINUTE);
    const mailboxes = mailboxMap(mailbox('m1', { lastSentAt }), mailbox('m2', { lastSentAt }));
    const plan = planSends(ctx(), campaignMap(campaign()), mailboxes, [e('a'), e('b', 'm1')]);
    expect(plan.sends).toEqual([]);
    expect(plan.deferrals.map((d) => d.reason)).toEqual(['mailbox_gap', 'mailbox_gap']);
    expect(plan.deferrals.every((d) => d.until === null)).toBe(true);
    // 3 minutes ago + a gap of 8 to 12 minutes
    expect(plan.retryAt?.getTime()).toBeGreaterThanOrEqual(NOW.getTime() + 5 * MINUTE);
    expect(plan.retryAt?.getTime()).toBeLessThanOrEqual(NOW.getTime() + 9 * MINUTE);
  });

  it('uses the claimed campaign\'s own minimum gap', () => {
    const lastSentAt = new Date(NOW.getTime() - 20 * MINUTE);
    const mailboxes = mailboxMap(mailbox('m1', { lastSentAt }));
    const slow = campaign({ minGapMinutes: 60, mailboxIds: ['m1'] });
    expect(planSends(ctx(), campaignMap(slow), mailboxes, [e('a')]).sends).toEqual([]);
    const quick = campaign({ minGapMinutes: 8, mailboxIds: ['m1'] });
    expect(planSends(ctx(), campaignMap(quick), mailboxes, [e('a')]).sends).toHaveLength(1);
  });

  it('stops at the campaign daily limit within the tick and defers the rest to tomorrow', () => {
    const plan = planSends(
      ctx(),
      campaignMap(campaign({ dailyLimit: 10, sentToday: 9 })),
      mailboxMap(mailbox('m1'), mailbox('m2')),
      [e('a'), e('b')],
    );
    expect(plan.sends).toHaveLength(1);
    expect(plan.deferrals).toEqual([{ enrollmentId: 'b', until: new Date('2026-10-13T07:00:00Z'), reason: 'campaign_limit' }]);
  });

  it('stops at the workspace daily limit across campaigns', () => {
    const c1 = campaign();
    const c2 = campaign({ id: 'c2', mailboxIds: ['m2'] });
    const plan = planSends(
      ctx({ maxDailySends: 10, workspaceSentToday: 9 }),
      campaignMap(c1, c2),
      mailboxMap(mailbox('m1'), mailbox('m2')),
      [e('a', null, 'c1'), e('b', null, 'c2')],
    );
    expect(plan.sends.map((s) => s.enrollmentId)).toEqual(['a']);
    expect(plan.deferrals).toMatchObject([{ enrollmentId: 'b', reason: 'workspace_limit' }]);
  });

  it('puts an enrollment on hold for an hour when its mailbox is unusable', () => {
    const plan = planSends(ctx(), campaignMap(campaign()), mailboxMap(mailbox('m1', { status: 'paused' }), mailbox('m2')), [e('a', 'm1')]);
    expect(plan.sends).toEqual([]);
    expect(plan.deferrals).toEqual([
      { enrollmentId: 'a', until: new Date(NOW.getTime() + 60 * MINUTE), reason: 'mailbox_unavailable' },
    ]);
  });

  it('never rotates to a warming or paused mailbox', () => {
    const mailboxes = mailboxMap(mailbox('m1', { status: 'warming' }), mailbox('m2', { status: 'paused' }));
    const plan = planSends(ctx(), campaignMap(campaign()), mailboxes, [e('a')]);
    expect(plan.sends).toEqual([]);
    expect(plan.deferrals).toMatchObject([{ reason: 'no_mailbox' }]);
  });

  it('does not count a mailbox twice when two campaigns share it', () => {
    const c2 = campaign({ id: 'c2', mailboxIds: ['m1'] });
    const plan = planSends(
      ctx(),
      campaignMap(campaign({ mailboxIds: ['m1'] }), c2),
      mailboxMap(mailbox('m1')),
      [e('a', null, 'c1'), e('b', null, 'c2')],
    );
    expect(plan.sends).toHaveLength(1);
    expect(plan.deferrals[0]?.reason).toBe('mailbox_busy');
  });
});

describe('nextStepDueAt', () => {
  it('adds the step delay and moves the result into the window', () => {
    // sent Friday 15:00 CEST + 3 days = Monday 15:00 (inside the window)
    expect(nextStepDueAt(new Date('2026-10-16T13:00:00Z'), { delayDays: 3, delayHours: 0 }, SCHEDULE)).toEqual(
      new Date('2026-10-19T13:00:00Z'),
    );
    // sent Monday 15:00 CEST + 2 days + 4 h = Wednesday 19:00 CEST, outside: Thursday 09:00
    expect(nextStepDueAt(new Date('2026-10-12T13:00:00Z'), { delayDays: 2, delayHours: 4 }, SCHEDULE)).toEqual(
      new Date('2026-10-15T07:00:00Z'),
    );
    // a weekend landing goes to Monday morning
    expect(nextStepDueAt(new Date('2026-10-14T10:00:00Z'), { delayDays: 3, delayHours: 0 }, SCHEDULE)).toEqual(
      new Date('2026-10-19T07:00:00Z'),
    );
  });
});
