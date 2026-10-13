import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit';
import { reachCampaigns, reachMailboxes } from '@weldsuite/db/schema';
import { campaignBounceRate, CAMPAIGN_BOUNCE_MIN_SAMPLE, recordHardBounce } from './guardrails';
import { resetReach, seedCampaign, seedEnrollment, seedMailbox, seedOutbound, seedProspect } from '../test-support/reach';

let db: Database;
const NOW = new Date('2026-10-12T12:00:00Z');
const HOUR = 3_600_000;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

beforeEach(async () => {
  await resetReach(db);
});

async function bounceFor(mailboxId: string, campaignId: string, updatedAt: Date) {
  const prospect = await seedProspect(db);
  return seedEnrollment(db, campaignId, prospect.id, { status: 'bounced', mailboxId, updatedAt, nextSendAt: null });
}

let sequence = 0;

/** `total` sent messages in the campaign, the first `bounced` of them to prospects whose enrollment bounced. */
async function seedSends(mailboxId: string, campaignId: string, total: number, bounced: number) {
  for (let i = 0; i < total; i++) {
    const prospect = await seedProspect(db);
    const enrollment = await seedEnrollment(db, campaignId, prospect.id, {
      status: i < bounced ? 'bounced' : 'completed',
      mailboxId,
      nextSendAt: null,
    });
    await seedOutbound(db, mailboxId, {
      campaignId,
      enrollmentId: enrollment.id,
      prospectId: prospect.id,
      sentAt: new Date(NOW.getTime() - (total - i) * 60_000),
      // strictly increasing, so "the last 50 sends" does not depend on the clock's resolution
      createdAt: new Date(NOW.getTime() - 24 * HOUR + ++sequence * 1000),
    });
  }
}

describe('recordHardBounce: mailbox', () => {
  it('pauses a mailbox after 5 hard bounces in a day and says why', async () => {
    const mailbox = await seedMailbox(db);
    const { campaign } = await seedCampaign(db, { mailboxIds: [mailbox.id] });
    const onMailboxPaused = vi.fn();
    for (let i = 0; i < 4; i++) await bounceFor(mailbox.id, campaign.id, new Date(NOW.getTime() - i * HOUR));

    expect(await recordHardBounce(db, { mailboxId: mailbox.id, campaignId: campaign.id }, { onMailboxPaused }, NOW)).toEqual({
      mailboxPaused: false,
      campaignPaused: false,
    });

    await bounceFor(mailbox.id, campaign.id, new Date(NOW.getTime() - 5 * HOUR));
    const result = await recordHardBounce(db, { mailboxId: mailbox.id, campaignId: campaign.id }, { onMailboxPaused }, NOW);

    expect(result.mailboxPaused).toBe(true);
    const [row] = await db.select().from(reachMailboxes).where(eq(reachMailboxes.id, mailbox.id));
    expect(row).toMatchObject({ status: 'paused', pausedReason: 'bounces' });
    expect(onMailboxPaused).toHaveBeenCalledTimes(1);
    expect(onMailboxPaused).toHaveBeenCalledWith(expect.objectContaining({ id: mailbox.id, status: 'paused' }));

    // already paused: nothing more to do
    expect((await recordHardBounce(db, { mailboxId: mailbox.id, campaignId: null }, { onMailboxPaused }, NOW)).mailboxPaused).toBe(false);
    expect(onMailboxPaused).toHaveBeenCalledTimes(1);
  });

  it('only counts bounces of the last 24 hours and of this mailbox', async () => {
    const mailbox = await seedMailbox(db);
    const other = await seedMailbox(db);
    const { campaign } = await seedCampaign(db, { mailboxIds: [mailbox.id, other.id] });
    for (let i = 0; i < 3; i++) await bounceFor(mailbox.id, campaign.id, new Date(NOW.getTime() - 30 * HOUR));
    for (let i = 0; i < 3; i++) await bounceFor(other.id, campaign.id, NOW);
    await bounceFor(mailbox.id, campaign.id, new Date(NOW.getTime() - HOUR));

    expect((await recordHardBounce(db, { mailboxId: mailbox.id, campaignId: null }, {}, NOW)).mailboxPaused).toBe(false);
    const [row] = await db.select().from(reachMailboxes).where(eq(reachMailboxes.id, mailbox.id));
    expect(row?.status).toBe('active');
  });

  it('is a no-op without a mailbox or campaign', async () => {
    expect(await recordHardBounce(db, { mailboxId: null, campaignId: null })).toEqual({ mailboxPaused: false, campaignPaused: false });
  });
});

describe('recordHardBounce: campaign', () => {
  it('pauses a campaign whose bounce rate over the last 50 sends is above 3%', async () => {
    const mailbox = await seedMailbox(db);
    const { campaign } = await seedCampaign(db, { mailboxIds: [mailbox.id] });
    await seedSends(mailbox.id, campaign.id, 50, 2); // 4%
    const onCampaignPaused = vi.fn();

    const result = await recordHardBounce(db, { mailboxId: mailbox.id, campaignId: campaign.id }, { onCampaignPaused }, NOW);

    expect(result.campaignPaused).toBe(true);
    const [row] = await db.select().from(reachCampaigns).where(eq(reachCampaigns.id, campaign.id));
    expect(row).toMatchObject({ status: 'paused', pausedReason: 'bounce_rate' });
    expect(onCampaignPaused).toHaveBeenCalledWith(expect.objectContaining({ id: campaign.id, pausedReason: 'bounce_rate' }));
  });

  it('leaves a campaign at or under the threshold running', async () => {
    const mailbox = await seedMailbox(db);
    const { campaign } = await seedCampaign(db, { mailboxIds: [mailbox.id] });
    await seedSends(mailbox.id, campaign.id, 50, 1); // 2%
    expect((await recordHardBounce(db, { mailboxId: mailbox.id, campaignId: campaign.id }, {}, NOW)).campaignPaused).toBe(false);
    const rate = await campaignBounceRate(db, campaign.id);
    expect(rate).toMatchObject({ sample: 50, bounced: 1 });
    expect(rate.rate).toBeCloseTo(0.02);
  });

  it('judges only the last 50 sends', async () => {
    const mailbox = await seedMailbox(db);
    const { campaign } = await seedCampaign(db, { mailboxIds: [mailbox.id] });
    await seedSends(mailbox.id, campaign.id, 10, 10); // old and all bounced
    await seedSends(mailbox.id, campaign.id, 50, 0);
    const rate = await campaignBounceRate(db, campaign.id);
    expect(rate).toMatchObject({ sample: 50, bounced: 0 });
  });

  it('does not judge a handful of sends', async () => {
    const mailbox = await seedMailbox(db);
    const { campaign } = await seedCampaign(db, { mailboxIds: [mailbox.id] });
    await seedSends(mailbox.id, campaign.id, CAMPAIGN_BOUNCE_MIN_SAMPLE - 1, CAMPAIGN_BOUNCE_MIN_SAMPLE - 1);
    expect((await recordHardBounce(db, { mailboxId: mailbox.id, campaignId: campaign.id }, {}, NOW)).campaignPaused).toBe(false);
  });

  it('counts a recipient rejected at send time, and ignores temporary failures', async () => {
    const mailbox = await seedMailbox(db);
    const { campaign } = await seedCampaign(db, { mailboxIds: [mailbox.id] });
    await seedSends(mailbox.id, campaign.id, 24, 0);
    const prospect = await seedProspect(db);
    const bounced = await seedEnrollment(db, campaign.id, prospect.id, { status: 'bounced', mailboxId: mailbox.id, nextSendAt: null });
    await seedOutbound(db, mailbox.id, { campaignId: campaign.id, enrollmentId: bounced.id, status: 'failed', sentAt: null });
    // a temporary failure of another enrollment is neither a send nor a bounce
    const retrying = await seedEnrollment(db, campaign.id, (await seedProspect(db)).id, { mailboxId: mailbox.id });
    await seedOutbound(db, mailbox.id, { campaignId: campaign.id, enrollmentId: retrying.id, status: 'failed', sentAt: null });

    expect(await campaignBounceRate(db, campaign.id)).toMatchObject({ sample: 25, bounced: 1 });
    expect((await recordHardBounce(db, { mailboxId: mailbox.id, campaignId: campaign.id }, {}, NOW)).campaignPaused).toBe(true);
  });

  it('only pauses a running campaign', async () => {
    const mailbox = await seedMailbox(db);
    const { campaign } = await seedCampaign(db, { mailboxIds: [mailbox.id], campaign: { status: 'paused' } });
    await seedSends(mailbox.id, campaign.id, 30, 5);
    const onCampaignPaused = vi.fn();
    expect((await recordHardBounce(db, { mailboxId: null, campaignId: campaign.id }, { onCampaignPaused }, NOW)).campaignPaused).toBe(false);
    expect(onCampaignPaused).not.toHaveBeenCalled();
  });
});
