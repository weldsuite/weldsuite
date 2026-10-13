import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit';
import { resolveWeldReachLimits, type WeldReachLimits } from '@weldsuite/app-api-client/schemas/reach';
import {
  reachCampaigns,
  reachEnrollments,
  reachMailboxes,
  reachMessages,
  reachProspects,
  reachSuppressions,
} from '@weldsuite/db/schema';

const smtp = vi.hoisted(() => ({
  sendMail: vi.fn(),
  built: [] as Array<{ subject: string; text: string; inReplyTo?: string; references?: string[]; messageId: string; from: { email: string }; to: Array<{ email: string }> }>,
  counter: 0,
}));

vi.mock('@weldsuite/smtp', () => ({
  buildMimeMessage: (message: (typeof smtp.built)[number]) => {
    smtp.built.push(message);
    return JSON.stringify(message);
  },
  generateMessageId: (domain: string) => `msg${++smtp.counter}@${domain}`,
  sendMail: (...args: unknown[]) => smtp.sendMail(...args),
}));

import { MAX_SEND_ATTEMPTS, runSendTick } from './send-tick';
import {
  resetReach,
  seedCampaign,
  seedEnrollment,
  seedMailbox,
  seedOutbound,
  seedProspect,
  seedSettings,
  testEnv,
} from '../test-support/reach';

let db: Database;
let env = testEnv();

const T0 = new Date('2026-10-12T10:00:00Z'); // Monday
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const tick = (now: Date = T0, limits: Partial<WeldReachLimits> = {}) =>
  runSendTick({ env, db, clerkOrgId: 'org_test', limits: resolveWeldReachLimits(limits), now: () => now });

const enrollmentOf = async (id: string) => {
  const [row] = await db.select().from(reachEnrollments).where(eq(reachEnrollments.id, id));
  return row!;
};
const campaignOf = async (id: string) => {
  const [row] = await db.select().from(reachCampaigns).where(eq(reachCampaigns.id, id));
  return row!;
};
const messagesOut = () => db.select().from(reachMessages).where(eq(reachMessages.direction, 'out'));

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

beforeEach(async () => {
  await resetReach(db);
  env = testEnv();
  smtp.sendMail.mockReset();
  smtp.sendMail.mockResolvedValue({ ok: true, response: '250 2.0.0 OK', accepted: ['x'] });
  smtp.built.length = 0;
  await seedSettings(db);
});

describe('first email', () => {
  it('renders the step, sends from the campaign mailbox, advances and makes the mailbox sticky', async () => {
    const mailbox = await seedMailbox(db);
    const { campaign, steps } = await seedCampaign(db, {
      mailboxIds: [mailbox.id],
      steps: [
        { subject: 'Hello {{firstName}}', body: 'Hi {{firstName}}, a question for {{companyName}}.\n\n{{senderFirstName}}' },
        { subject: 'Following up', body: 'Any thoughts?', delayDays: 3 },
      ],
    });
    const prospect = await seedProspect(db, { email: 'jane@bigco.io' });
    const enrollment = await seedEnrollment(db, campaign.id, prospect.id);

    const result = await tick();

    expect(result).toMatchObject({ claimed: 1, sent: 1, failed: 0, bounced: 0 });
    expect(smtp.sendMail).toHaveBeenCalledTimes(1);
    expect(smtp.built[0]?.subject).toBe('Hello Jane');
    expect(smtp.built[0]?.text.startsWith('Hi Jane, a question for BigCo.\n\nSam')).toBe(true);
    expect(smtp.built[0]?.text).toContain('Acme BV'); // footer

    const after = await enrollmentOf(enrollment.id);
    expect(after).toMatchObject({ status: 'active', currentStep: 1, mailboxId: mailbox.id, claimedAt: null });
    expect(after.nextSendAt).toEqual(new Date(T0.getTime() + 3 * 24 * HOUR));
    const [message] = await messagesOut();
    expect(message).toMatchObject({ status: 'sent', stepId: steps[0]!.id, enrollmentId: enrollment.id, campaignId: campaign.id, prospectId: prospect.id });
    expect(after.lastMessageId).toBe(message!.id);
    expect(after.threadRootMessageId).toBe(message!.messageIdHeader);
    expect((await campaignOf(campaign.id)).stats.sent).toBe(1);
    // the workspace is due again when the follow-up is
    expect(result.nextDueAt).toEqual(new Date(T0.getTime() + 3 * 24 * HOUR));
  });

  it('completes the enrollment after the last step and the campaign when nothing is left', async () => {
    const mailbox = await seedMailbox(db);
    const { campaign } = await seedCampaign(db, { mailboxIds: [mailbox.id] });
    const prospect = await seedProspect(db);
    const enrollment = await seedEnrollment(db, campaign.id, prospect.id);

    const result = await tick();

    expect((await enrollmentOf(enrollment.id)).status).toBe('completed');
    const done = await campaignOf(campaign.id);
    expect(done.status).toBe('completed');
    expect(done.completedAt).not.toBeNull();
    expect(result.nextDueAt).toBeNull();
    expect(env.events.sent).toContainEqual(expect.objectContaining({ eventType: 'reach_campaign:completed', entityId: campaign.id }));
  });

  it('does nothing for campaigns that are not active', async () => {
    const mailbox = await seedMailbox(db);
    for (const status of ['draft', 'paused', 'completed'] as const) {
      const { campaign } = await seedCampaign(db, { campaign: { status }, mailboxIds: [mailbox.id] });
      await seedEnrollment(db, campaign.id, (await seedProspect(db)).id);
    }
    const result = await tick();
    expect(result).toMatchObject({ claimed: 0, sent: 0, nextDueAt: null });
    expect(smtp.sendMail).not.toHaveBeenCalled();
  });
});

describe('no double sends', () => {
  it('two ticks racing for the same enrollment send once', async () => {
    const mailbox = await seedMailbox(db);
    const { campaign } = await seedCampaign(db, { mailboxIds: [mailbox.id] });
    await seedEnrollment(db, campaign.id, (await seedProspect(db)).id);

    const [a, b] = await Promise.all([tick(), tick()]);

    expect(a.sent + b.sent).toBe(1);
    expect(smtp.sendMail).toHaveBeenCalledTimes(1);
    expect(await messagesOut()).toHaveLength(1);
  });

  it('leaves an enrollment that another tick claimed minutes ago alone, and takes over a stale claim', async () => {
    const mailbox = await seedMailbox(db);
    const { campaign } = await seedCampaign(db, { mailboxIds: [mailbox.id] });
    const fresh = await seedEnrollment(db, campaign.id, (await seedProspect(db)).id, { claimedAt: new Date(T0.getTime() - 5 * MINUTE) });
    expect((await tick()).claimed).toBe(0);
    expect((await enrollmentOf(fresh.id)).status).toBe('active');

    await db.update(reachEnrollments).set({ claimedAt: new Date(T0.getTime() - 20 * MINUTE) }).where(eq(reachEnrollments.id, fresh.id));
    expect((await tick()).sent).toBe(1);
  });

  it('advances instead of resending when the step already has a sent message (crash after SMTP)', async () => {
    const mailbox = await seedMailbox(db);
    const { campaign, steps } = await seedCampaign(db, {
      mailboxIds: [mailbox.id],
      steps: [{ subject: 'One', body: 'Body' }, { subject: 'Two', body: 'Body two' }],
    });
    const prospect = await seedProspect(db);
    const enrollment = await seedEnrollment(db, campaign.id, prospect.id, { claimedAt: new Date(T0.getTime() - HOUR) });
    const earlier = await seedOutbound(db, mailbox.id, { enrollmentId: enrollment.id, stepId: steps[0]!.id, campaignId: campaign.id, status: 'sent' });

    const result = await tick();

    expect(smtp.sendMail).not.toHaveBeenCalled();
    expect(result.sent).toBe(0);
    expect(await enrollmentOf(enrollment.id)).toMatchObject({ currentStep: 1, status: 'active', mailboxId: mailbox.id, lastMessageId: earlier.id });
  });

  it('turns a long-stuck sending row into unknown and never resends that step', async () => {
    const mailbox = await seedMailbox(db);
    const { campaign, steps } = await seedCampaign(db, {
      mailboxIds: [mailbox.id],
      steps: [{ subject: 'One', body: 'Body' }, { subject: 'Two', body: 'Body two' }],
    });
    const enrollment = await seedEnrollment(db, campaign.id, (await seedProspect(db)).id, { claimedAt: new Date(T0.getTime() - HOUR) });
    const stuck = await seedOutbound(db, mailbox.id, {
      enrollmentId: enrollment.id,
      stepId: steps[0]!.id,
      campaignId: campaign.id,
      status: 'sending',
      sentAt: null,
    });
    await db.update(reachMessages).set({ createdAt: new Date(T0.getTime() - 20 * MINUTE) }).where(eq(reachMessages.id, stuck.id));

    await tick();

    expect(smtp.sendMail).not.toHaveBeenCalled();
    const [row] = await db.select().from(reachMessages).where(eq(reachMessages.id, stuck.id));
    expect(row?.status).toBe('unknown');
    expect((await enrollmentOf(enrollment.id)).currentStep).toBe(1);
  });

  it('waits for a send that is still in flight', async () => {
    const mailbox = await seedMailbox(db);
    const { campaign, steps } = await seedCampaign(db, { mailboxIds: [mailbox.id] });
    const enrollment = await seedEnrollment(db, campaign.id, (await seedProspect(db)).id, { claimedAt: new Date(T0.getTime() - 11 * MINUTE) });
    const inFlight = await seedOutbound(db, mailbox.id, { enrollmentId: enrollment.id, stepId: steps[0]!.id, status: 'sending', sentAt: null });
    await db.update(reachMessages).set({ createdAt: new Date(T0.getTime() - 11 * MINUTE) }).where(eq(reachMessages.id, inFlight.id));

    await tick();

    expect(smtp.sendMail).not.toHaveBeenCalled();
    expect((await enrollmentOf(enrollment.id)).nextSendAt).toEqual(new Date(T0.getTime() + 5 * MINUTE));
  });

  it('stops an enrollment whose step keeps failing', async () => {
    const mailbox = await seedMailbox(db);
    const { campaign, steps } = await seedCampaign(db, { mailboxIds: [mailbox.id] });
    const enrollment = await seedEnrollment(db, campaign.id, (await seedProspect(db)).id);
    for (let i = 0; i < MAX_SEND_ATTEMPTS; i++) {
      await seedOutbound(db, mailbox.id, { enrollmentId: enrollment.id, stepId: steps[0]!.id, status: 'failed', sentAt: null });
    }
    await tick();
    expect(smtp.sendMail).not.toHaveBeenCalled();
    expect(await enrollmentOf(enrollment.id)).toMatchObject({ status: 'failed', stoppedReason: 'send_failed' });
  });
});

describe('pacing', () => {
  it('sends one email per mailbox per tick and waits out the gap for the rest', async () => {
    const mailbox = await seedMailbox(db);
    const { campaign } = await seedCampaign(db, { mailboxIds: [mailbox.id], campaign: { minGapMinutes: 8 } });
    const enrollments = [];
    for (let i = 0; i < 3; i++) enrollments.push(await seedEnrollment(db, campaign.id, (await seedProspect(db)).id, { nextSendAt: new Date(T0.getTime() - (3 - i) * MINUTE) }));

    const first = await tick();
    expect(first.sent).toBe(1);
    // oldest due goes first
    expect((await enrollmentOf(enrollments[0]!.id)).status).toBe('completed');
    expect((await enrollmentOf(enrollments[1]!.id)).status).toBe('active');

    // right away: the mailbox is inside its gap, nothing is claimed
    const second = await tick(new Date(T0.getTime() + MINUTE));
    expect(second).toMatchObject({ claimed: 0, sent: 0 });
    // and the workspace is due again when the gap is over (8 to 12 minutes after the first send)
    expect(second.nextDueAt!.getTime()).toBeGreaterThanOrEqual(T0.getTime() + 8 * MINUTE);
    expect(second.nextDueAt!.getTime()).toBeLessThanOrEqual(T0.getTime() + 12 * MINUTE);

    const third = await tick(new Date(T0.getTime() + 13 * MINUTE));
    expect(third.sent).toBe(1);
    expect(smtp.sendMail).toHaveBeenCalledTimes(2);
  });

  it('rotates first emails over the campaign mailboxes, the one with most capacity first', async () => {
    const busy = await seedMailbox(db);
    const fresh = await seedMailbox(db);
    for (let i = 0; i < 10; i++) await seedOutbound(db, busy.id, { sentAt: new Date(T0.getTime() - 2 * HOUR) });
    const { campaign } = await seedCampaign(db, { mailboxIds: [busy.id, fresh.id] });
    const first = await seedEnrollment(db, campaign.id, (await seedProspect(db)).id, { nextSendAt: new Date(T0.getTime() - 2 * MINUTE) });
    const second = await seedEnrollment(db, campaign.id, (await seedProspect(db)).id, { nextSendAt: new Date(T0.getTime() - MINUTE) });

    const result = await tick();

    expect(result.sent).toBe(2);
    expect((await enrollmentOf(first.id)).mailboxId).toBe(fresh.id); // most capacity left
    expect((await enrollmentOf(second.id)).mailboxId).toBe(busy.id);
  });

  it('keeps follow-ups on the same mailbox', async () => {
    const a = await seedMailbox(db);
    const b = await seedMailbox(db);
    const { campaign } = await seedCampaign(db, {
      mailboxIds: [a.id, b.id],
      steps: [{ subject: 'One', body: 'Body' }, { subject: 'Two', body: 'Body two' }],
    });
    const enrollment = await seedEnrollment(db, campaign.id, (await seedProspect(db)).id, { mailboxId: b.id, currentStep: 1 });
    // `a` has far more capacity left, but the sequence stays with `b`
    for (let i = 0; i < 5; i++) await seedOutbound(db, b.id, { sentAt: new Date(T0.getTime() - 3 * HOUR) });

    await tick();

    expect(smtp.built[0]?.from.email).toBe(b.email);
    expect((await enrollmentOf(enrollment.id)).mailboxId).toBe(b.id);
  });

  it('never sends from a warming, paused or errored mailbox', async () => {
    const warming = await seedMailbox(db, { status: 'warming' });
    const paused = await seedMailbox(db, { status: 'paused' });
    const { campaign } = await seedCampaign(db, { mailboxIds: [warming.id, paused.id] });
    const enrollment = await seedEnrollment(db, campaign.id, (await seedProspect(db)).id);
    const result = await tick();
    expect(result.sent).toBe(0);
    expect(smtp.sendMail).not.toHaveBeenCalled();
    // put back for an hour, not hammered every minute
    expect((await enrollmentOf(enrollment.id)).nextSendAt).toEqual(new Date(T0.getTime() + HOUR));
    expect(result.nextDueAt).toEqual(new Date(T0.getTime() + HOUR));
  });

  it('holds follow-ups pinned to a mailbox that is paused', async () => {
    const down = await seedMailbox(db, { status: 'paused' });
    const other = await seedMailbox(db);
    const { campaign } = await seedCampaign(db, {
      mailboxIds: [down.id, other.id],
      steps: [{ subject: 'One', body: 'Body' }, { subject: 'Two', body: 'Body two' }],
    });
    const enrollment = await seedEnrollment(db, campaign.id, (await seedProspect(db)).id, { mailboxId: down.id, currentStep: 1 });
    const result = await tick();
    expect(result.sent).toBe(0);
    expect((await enrollmentOf(enrollment.id)).nextSendAt).toEqual(new Date(T0.getTime() + HOUR));
  });

  it('stops a mailbox at min(ramp, daily cap) and moves its prospects to tomorrow\'s window', async () => {
    const ramping = await seedMailbox(db, { rampCurrent: 2, dailyCap: 30 });
    for (let i = 0; i < 2; i++) await seedOutbound(db, ramping.id, { sentAt: new Date(T0.getTime() - 3 * HOUR) });
    const { campaign } = await seedCampaign(db, {
      mailboxIds: [ramping.id],
      campaign: { timezone: 'Europe/Amsterdam', windowStart: '09:00', windowEnd: '17:00', sendDays: [1, 2, 3, 4, 5] },
    });
    const pinned = await seedEnrollment(db, campaign.id, (await seedProspect(db)).id, { mailboxId: ramping.id });
    const fresh = await seedEnrollment(db, campaign.id, (await seedProspect(db)).id);

    const result = await tick();

    expect(result.sent).toBe(0);
    expect(smtp.sendMail).not.toHaveBeenCalled();
    // Tuesday 09:00 Amsterdam (CEST) = 07:00Z
    const tomorrow = new Date('2026-10-13T07:00:00Z');
    expect((await enrollmentOf(pinned.id)).nextSendAt).toEqual(tomorrow);
    expect((await enrollmentOf(fresh.id)).nextSendAt).toEqual(tomorrow);
    expect(result.nextDueAt).toEqual(tomorrow);
  });

  it('the daily cap wins over a bigger ramp value', async () => {
    const mailbox = await seedMailbox(db, { rampCurrent: 50, dailyCap: 1 });
    const { campaign } = await seedCampaign(db, { mailboxIds: [mailbox.id], steps: [{ subject: 'One', body: 'B' }, { subject: 'Two', body: 'B2' }] });
    await seedEnrollment(db, campaign.id, (await seedProspect(db)).id);
    await seedEnrollment(db, campaign.id, (await seedProspect(db)).id);
    expect((await tick()).sent).toBe(1);
    expect((await tick(new Date(T0.getTime() + HOUR))).sent).toBe(0);
  });

  it('stops everything at the workspace maxDailySends', async () => {
    const a = await seedMailbox(db);
    const b = await seedMailbox(db);
    const { campaign } = await seedCampaign(db, { mailboxIds: [a.id, b.id], campaign: { timezone: 'Europe/Amsterdam', windowStart: '09:00', windowEnd: '17:00' } });
    // five sends earlier today, from outside any campaign (a typed reply counts too)
    for (let i = 0; i < 4; i++) await seedOutbound(db, a.id, { sentAt: new Date(T0.getTime() - 3 * HOUR) });
    await seedOutbound(db, b.id, { sentAt: new Date(T0.getTime() - 3 * HOUR), sentBy: 'user_1' });
    const enrollments = [];
    for (let i = 0; i < 3; i++) enrollments.push(await seedEnrollment(db, campaign.id, (await seedProspect(db)).id));

    const result = await tick(T0, { maxDailySends: 6 });

    expect(result.sent).toBe(1);
    // the others wait for tomorrow's window
    const waiting = await Promise.all(enrollments.map((e) => enrollmentOf(e.id)));
    expect(waiting.filter((e) => e.status === 'completed')).toHaveLength(1);
    for (const e of waiting.filter((x) => x.status === 'active')) expect(e.nextSendAt).toEqual(new Date('2026-10-13T07:00:00Z'));
  });

  it('stops at the campaign daily limit', async () => {
    const a = await seedMailbox(db);
    const b = await seedMailbox(db);
    const { campaign } = await seedCampaign(db, { mailboxIds: [a.id, b.id], campaign: { dailyLimit: 1 } });
    await seedEnrollment(db, campaign.id, (await seedProspect(db)).id);
    await seedEnrollment(db, campaign.id, (await seedProspect(db)).id);
    expect((await tick()).sent).toBe(1);
    expect(smtp.sendMail).toHaveBeenCalledTimes(1);
  });
});

describe('windows', () => {
  const amsterdam = { timezone: 'Europe/Amsterdam', windowStart: '09:00', windowEnd: '17:00', sendDays: [1, 2, 3, 4, 5] };

  it('does not send before the window opens and wakes the workspace when it does', async () => {
    const mailbox = await seedMailbox(db);
    const { campaign } = await seedCampaign(db, { mailboxIds: [mailbox.id], campaign: amsterdam });
    const enrollment = await seedEnrollment(db, campaign.id, (await seedProspect(db)).id, { nextSendAt: new Date('2026-10-12T04:00:00Z') });
    const early = new Date('2026-10-12T05:00:00Z'); // 07:00 in Amsterdam

    const result = await tick(early);

    expect(result.sent).toBe(0);
    expect((await enrollmentOf(enrollment.id)).nextSendAt).toEqual(new Date('2026-10-12T07:00:00Z'));
    expect(result.nextDueAt).toEqual(new Date('2026-10-12T07:00:00Z'));
    expect((await tick(new Date('2026-10-12T07:00:00Z'))).sent).toBe(1);
  });

  it('does not send after the window or on a non-send day', async () => {
    const mailbox = await seedMailbox(db);
    const { campaign } = await seedCampaign(db, { mailboxIds: [mailbox.id], campaign: amsterdam });
    const enrollment = await seedEnrollment(db, campaign.id, (await seedProspect(db)).id, { nextSendAt: new Date('2026-10-16T10:00:00Z') });

    // Friday 18:00 in Amsterdam
    const evening = await tick(new Date('2026-10-16T16:00:00Z'));
    expect(evening.sent).toBe(0);
    // next Monday 09:00 CEST
    expect((await enrollmentOf(enrollment.id)).nextSendAt).toEqual(new Date('2026-10-19T07:00:00Z'));
    // Saturday noon: still closed
    expect((await tick(new Date('2026-10-17T10:00:00Z'))).claimed).toBe(0);
  });

  it('reads the window in the campaign timezone across a DST change', async () => {
    const mailbox = await seedMailbox(db);
    const { campaign } = await seedCampaign(db, { mailboxIds: [mailbox.id], campaign: amsterdam });
    const enrollment = await seedEnrollment(db, campaign.id, (await seedProspect(db)).id, { nextSendAt: new Date('2026-10-25T20:00:00Z') });
    // Sunday after the clocks went back: Monday 09:00 is 08:00Z (CET), not 07:00Z
    await tick(new Date('2026-10-25T20:00:00Z'));
    expect((await enrollmentOf(enrollment.id)).nextSendAt).toEqual(new Date('2026-10-26T08:00:00Z'));
  });

  it('moves a follow-up that comes due outside the window into the next one', async () => {
    const mailbox = await seedMailbox(db);
    const { campaign } = await seedCampaign(db, {
      mailboxIds: [mailbox.id],
      campaign: amsterdam,
      steps: [{ subject: 'One', body: 'B' }, { subject: 'Two', body: 'B2', delayDays: 1, delayHours: 6 }],
    });
    const enrollment = await seedEnrollment(db, campaign.id, (await seedProspect(db)).id);
    // Monday 14:00 Amsterdam + 1 d 6 h = Tuesday 20:00 -> Wednesday 09:00 (07:00Z)
    await tick(new Date('2026-10-12T12:00:00Z'));
    expect((await enrollmentOf(enrollment.id)).nextSendAt).toEqual(new Date('2026-10-14T07:00:00Z'));
  });
});

describe('checks right before the send', () => {
  it('skips a prospect that was suppressed after enrolling (address, and whole domain)', async () => {
    const mailbox = await seedMailbox(db);
    const { campaign } = await seedCampaign(db, { mailboxIds: [mailbox.id] });
    const byEmail = await seedEnrollment(db, campaign.id, (await seedProspect(db, { email: 'jane@bigco.io' })).id);
    const byDomain = await seedEnrollment(db, campaign.id, (await seedProspect(db, { email: 'bob@mail.corp.example' })).id);
    await db.insert(reachSuppressions).values([
      { id: 'rsup_1', value: 'jane@bigco.io', type: 'email', reason: 'unsubscribed' },
      { id: 'rsup_2', value: 'corp.example', type: 'domain', reason: 'manual' },
    ]);

    const result = await tick();

    expect(smtp.sendMail).not.toHaveBeenCalled();
    expect(result.sent).toBe(0);
    expect(await enrollmentOf(byEmail.id)).toMatchObject({ status: 'unsubscribed', stoppedReason: 'suppressed:unsubscribed' });
    expect(await enrollmentOf(byDomain.id)).toMatchObject({ status: 'unsubscribed', stoppedReason: 'suppressed:manual' });
  });

  it('refuses consumer addresses unless the workspace is allowed them', async () => {
    const mailbox = await seedMailbox(db);
    const { campaign } = await seedCampaign(db, { mailboxIds: [mailbox.id] });
    const enrollment = await seedEnrollment(db, campaign.id, (await seedProspect(db, { email: 'jane@gmail.com' })).id);

    await tick();
    expect(smtp.sendMail).not.toHaveBeenCalled();
    expect(await enrollmentOf(enrollment.id)).toMatchObject({ status: 'failed', stoppedReason: 'consumer_domain' });
  });

  it('sends to consumer addresses once staff allowed them for the workspace', async () => {
    const mailbox = await seedMailbox(db);
    const { campaign } = await seedCampaign(db, { mailboxIds: [mailbox.id] });
    const enrollment = await seedEnrollment(db, campaign.id, (await seedProspect(db, { email: 'joe@gmail.com' })).id);

    const result = await tick(T0, { allowConsumerRecipients: true });

    expect(result.sent).toBe(1);
    expect((await enrollmentOf(enrollment.id)).status).toBe('completed');
  });

  it('fails a prospect with an unresolved variable instead of sending braces, and honours fallbacks', async () => {
    const mailbox = await seedMailbox(db);
    const other = await seedMailbox(db);
    const { campaign } = await seedCampaign(db, {
      mailboxIds: [mailbox.id, other.id],
      steps: [{ subject: 'Hello {{firstName|there}}', body: 'About {{companyName}} and {{city}}' }],
    });
    const missing = await seedEnrollment(db, campaign.id, (await seedProspect(db, { customFields: {} })).id, { nextSendAt: new Date(T0.getTime() - MINUTE) });
    const fine = await seedEnrollment(db, campaign.id, (await seedProspect(db, { customFields: { city: 'Utrecht' }, firstName: null })).id);

    await tick();

    expect(await enrollmentOf(missing.id)).toMatchObject({ status: 'failed', stoppedReason: 'missing_variables' });
    expect(smtp.sendMail).toHaveBeenCalledTimes(1);
    expect(smtp.built[0]?.subject).toBe('Hello there');
    expect(smtp.built[0]?.text).toContain('About BigCo and Utrecht');
    expect((await enrollmentOf(fine.id)).status).toBe('completed');
  });

  it('stops an enrollment whose prospect was deleted', async () => {
    const mailbox = await seedMailbox(db);
    const { campaign } = await seedCampaign(db, { mailboxIds: [mailbox.id] });
    const prospect = await seedProspect(db);
    const enrollment = await seedEnrollment(db, campaign.id, prospect.id);
    await db.update(reachProspects).set({ deletedAt: new Date() }).where(eq(reachProspects.id, prospect.id));
    await tick();
    expect(smtp.sendMail).not.toHaveBeenCalled();
    expect(await enrollmentOf(enrollment.id)).toMatchObject({ status: 'failed', stoppedReason: 'prospect_deleted' });
  });
});

describe('follow-ups', () => {
  it('replies in the same thread with Re: <first subject>, In-Reply-To and References', async () => {
    const mailbox = await seedMailbox(db);
    const { campaign } = await seedCampaign(db, {
      mailboxIds: [mailbox.id],
      steps: [
        { subject: 'Hello {{firstName}}', body: 'First' },
        { subject: 'ignored in thread', body: 'Second', replyInThread: true },
      ],
    });
    const enrollment = await seedEnrollment(db, campaign.id, (await seedProspect(db)).id);

    await tick();
    const first = smtp.built[0]!;
    const afterFirst = await enrollmentOf(enrollment.id);
    expect(afterFirst.threadRootMessageId).toBe(first.messageId);

    await tick(new Date(afterFirst.nextSendAt!.getTime() + MINUTE));
    const second = smtp.built[1]!;
    expect(second.subject).toBe('Re: Hello Jane');
    expect(second.inReplyTo).toBe(first.messageId);
    expect(second.references).toEqual([first.messageId]);
    const rows = await messagesOut();
    expect(rows.map((r) => r.threadKey)).toEqual([first.messageId, first.messageId]);
    expect((await enrollmentOf(enrollment.id)).status).toBe('completed');
  });

  it('starts a new thread when the step does not reply in thread', async () => {
    const mailbox = await seedMailbox(db);
    const { campaign } = await seedCampaign(db, {
      mailboxIds: [mailbox.id],
      steps: [
        { subject: 'First subject', body: 'First' },
        { subject: 'A fresh subject', body: 'Second', replyInThread: false },
      ],
    });
    const enrollment = await seedEnrollment(db, campaign.id, (await seedProspect(db)).id);
    await tick();
    await tick(new Date((await enrollmentOf(enrollment.id)).nextSendAt!.getTime() + MINUTE));
    expect(smtp.built[1]?.subject).toBe('A fresh subject');
    expect(smtp.built[1]?.inReplyTo).toBeUndefined();
  });
});

describe('failures', () => {
  it('a rejected recipient is a hard bounce: enrollment bounced, address suppressed, counted', async () => {
    const mailbox = await seedMailbox(db);
    const { campaign } = await seedCampaign(db, { mailboxIds: [mailbox.id] });
    const prospect = await seedProspect(db, { email: 'gone@bigco.io' });
    const enrollment = await seedEnrollment(db, campaign.id, prospect.id);
    smtp.sendMail.mockResolvedValue({
      ok: false, permanent: true, stage: 'rcpt', code: 550, enhancedCode: '5.1.1', response: '550 5.1.1 no such user', recipientRejected: true, authFailed: false,
    });

    const result = await tick();

    expect(result).toMatchObject({ sent: 0, bounced: 1 });
    expect(await enrollmentOf(enrollment.id)).toMatchObject({ status: 'bounced', stoppedReason: 'hard_bounce', mailboxId: mailbox.id });
    const [suppression] = await db.select().from(reachSuppressions);
    expect(suppression).toMatchObject({ value: 'gone@bigco.io', reason: 'bounced', type: 'email' });
    expect((await campaignOf(campaign.id)).stats).toMatchObject({ sent: 0, bounced: 1 });
  });

  it('bad credentials put the mailbox in error and keep the prospect for later', async () => {
    const mailbox = await seedMailbox(db);
    const { campaign } = await seedCampaign(db, { mailboxIds: [mailbox.id] });
    const enrollment = await seedEnrollment(db, campaign.id, (await seedProspect(db)).id);
    smtp.sendMail.mockResolvedValue({ ok: false, permanent: true, stage: 'auth', code: 535, response: '535 bad login', recipientRejected: false, authFailed: true });

    await tick();

    const [mb] = await db.select().from(reachMailboxes).where(eq(reachMailboxes.id, mailbox.id));
    expect(mb).toMatchObject({ status: 'error', pausedReason: 'smtp_auth_failed' });
    expect(mb?.lastError).toContain('535 bad login');
    const after = await enrollmentOf(enrollment.id);
    expect(after).toMatchObject({ status: 'active', currentStep: 0, claimedAt: null });
    expect(after.nextSendAt).toEqual(new Date(T0.getTime() + 15 * MINUTE));
    expect(env.events.sent).toContainEqual(expect.objectContaining({ eventType: 'reach_mailbox:updated', entityId: mailbox.id }));
  });

  it('retries a temporary failure in 15 minutes', async () => {
    const mailbox = await seedMailbox(db);
    const { campaign } = await seedCampaign(db, { mailboxIds: [mailbox.id] });
    const enrollment = await seedEnrollment(db, campaign.id, (await seedProspect(db)).id);
    smtp.sendMail.mockResolvedValue({ ok: false, permanent: false, stage: 'rcpt', code: 451, response: '451 try later', recipientRejected: false, authFailed: false });

    const result = await tick();

    expect(result.deferred).toBe(1);
    const after = await enrollmentOf(enrollment.id);
    expect(after).toMatchObject({ status: 'active', currentStep: 0 });
    expect(after.nextSendAt).toEqual(new Date(T0.getTime() + 15 * MINUTE));
    expect(result.nextDueAt).toEqual(new Date(T0.getTime() + 15 * MINUTE));
  });

  it('treats a send with unknown delivery as sent: never resent, sequence continues', async () => {
    const mailbox = await seedMailbox(db);
    const { campaign } = await seedCampaign(db, {
      mailboxIds: [mailbox.id],
      steps: [{ subject: 'One', body: 'B' }, { subject: 'Two', body: 'B2' }],
    });
    const enrollment = await seedEnrollment(db, campaign.id, (await seedProspect(db)).id);
    smtp.sendMail.mockResolvedValue({ ok: false, permanent: false, stage: 'timeout', response: 'timed out', recipientRejected: false, authFailed: false, deliveryUncertain: true });

    const result = await tick();

    expect(result.sent).toBe(0); // not counted as sent
    expect((await messagesOut())[0]?.status).toBe('unknown');
    expect((await enrollmentOf(enrollment.id)).currentStep).toBe(1);
    expect((await campaignOf(campaign.id)).stats.sent).toBe(0);
  });

  it('fails the enrollment for a permanent rejection that is not about the recipient', async () => {
    const mailbox = await seedMailbox(db);
    const { campaign } = await seedCampaign(db, { mailboxIds: [mailbox.id] });
    const enrollment = await seedEnrollment(db, campaign.id, (await seedProspect(db)).id);
    smtp.sendMail.mockResolvedValue({ ok: false, permanent: true, stage: 'data', code: 554, response: '554 5.7.1 rejected as spam', recipientRejected: false, authFailed: false });
    await tick();
    expect(await enrollmentOf(enrollment.id)).toMatchObject({ status: 'failed', stoppedReason: 'smtp_rejected' });
  });

  it('puts the mailbox in error when its credentials cannot be opened', async () => {
    const mailbox = await seedMailbox(db);
    await db.update(reachMailboxes).set({ smtpCredentials: 'garbage' }).where(eq(reachMailboxes.id, mailbox.id));
    const { campaign } = await seedCampaign(db, { mailboxIds: [mailbox.id] });
    const enrollment = await seedEnrollment(db, campaign.id, (await seedProspect(db)).id);
    await tick();
    const [mb] = await db.select().from(reachMailboxes).where(eq(reachMailboxes.id, mailbox.id));
    expect(mb).toMatchObject({ status: 'error', pausedReason: 'credentials_unavailable' });
    expect(smtp.sendMail).not.toHaveBeenCalled();
    expect((await enrollmentOf(enrollment.id)).nextSendAt).toEqual(new Date(T0.getTime() + HOUR));
  });

  it('auto-pauses a campaign whose bounce rate is over the line, after the send that tipped it', async () => {
    const mailbox = await seedMailbox(db);
    const { campaign } = await seedCampaign(db, { mailboxIds: [mailbox.id] });
    // 24 earlier sends, none bounced
    const earlier = await seedProspect(db);
    for (let i = 0; i < 24; i++) {
      await seedOutbound(db, mailbox.id, { campaignId: campaign.id, enrollmentId: 'renr_old', prospectId: earlier.id, sentAt: new Date(T0.getTime() - (2 + i) * MINUTE) });
    }
    const enrollment = await seedEnrollment(db, campaign.id, (await seedProspect(db)).id);
    smtp.sendMail.mockResolvedValue({ ok: false, permanent: true, stage: 'rcpt', code: 550, response: '550 no', recipientRejected: true, authFailed: false });

    await tick();

    expect((await enrollmentOf(enrollment.id)).status).toBe('bounced');
    expect(await campaignOf(campaign.id)).toMatchObject({ status: 'paused', pausedReason: 'bounce_rate' });
    expect(env.events.sent).toContainEqual(expect.objectContaining({ eventType: 'reach_campaign:paused', entityId: campaign.id }));
  });
});

describe('what happens next', () => {
  it('reports the earliest future send and, with nothing left, null', async () => {
    const mailbox = await seedMailbox(db);
    const { campaign } = await seedCampaign(db, { mailboxIds: [mailbox.id] });
    const later = new Date(T0.getTime() + 5 * HOUR);
    const soon = new Date(T0.getTime() + 2 * HOUR);
    await seedEnrollment(db, campaign.id, (await seedProspect(db)).id, { nextSendAt: later });
    await seedEnrollment(db, campaign.id, (await seedProspect(db)).id, { nextSendAt: soon });
    const result = await tick();
    expect(result).toMatchObject({ claimed: 0, nextDueAt: soon });
  });

  it('leaves due rows behind the claim limit for the next minute', async () => {
    const mailboxes = [await seedMailbox(db)];
    const { campaign } = await seedCampaign(db, { mailboxIds: mailboxes.map((m) => m.id) });
    for (let i = 0; i < 6; i++) await seedEnrollment(db, campaign.id, (await seedProspect(db)).id, { nextSendAt: new Date(T0.getTime() - (10 - i) * MINUTE) });
    const result = await tick();
    expect(result.sent).toBe(1);
    // five still due: the workspace is looked at again, not left to the 10-minute safety net
    expect(result.nextDueAt!.getTime()).toBeLessThanOrEqual(T0.getTime() + 13 * MINUTE);
    expect(result.nextDueAt!.getTime()).toBeGreaterThan(T0.getTime());
    const due = await db.select().from(reachEnrollments).where(and(eq(reachEnrollments.status, 'active')));
    expect(due).toHaveLength(5);
  });
});
