import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit';
import type { ReachOverview } from '@weldsuite/app-api-client/schemas/reach';
import { reachMessages } from '@weldsuite/db/schema';
import { generateId } from '@weldsuite/worker-kit/id';
import overviewRoutes from './index';
import { readJson, reachApp } from '../../test-support/routes';
import { buildOverview } from '@weldsuite/reach-domain/overview';
import { resetReach, seedCampaign, seedEnrollment, seedMailbox, seedOutbound, seedProspect, seedSettings } from '../../test-support/reach';

let db: Database;
const NOW = new Date('2026-10-12T10:00:00Z'); // Monday 12:00 in Amsterdam (CEST)
const DAY = 86_400_000;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

beforeEach(async () => {
  await resetReach(db);
  await seedSettings(db, { defaultTimezone: 'Europe/Amsterdam' });
});

let n = 0;
async function inbound(mailboxId: string, patch: Partial<typeof reachMessages.$inferInsert>) {
  n += 1;
  await db.insert(reachMessages).values({
    id: generateId('rmsg'),
    direction: 'in',
    mailboxId,
    messageIdHeader: `in${n}@bigco.io`,
    fromEmail: 'jane@bigco.io',
    toEmail: 'sam@getacme.com',
    kind: 'reply',
    receivedAt: NOW,
    ...patch,
  });
}

describe('buildOverview', () => {
  it('is all zeros, with a 14-day series, for an empty workspace', async () => {
    const o = await buildOverview(db, NOW);
    expect(o).toMatchObject({
      sentToday: 0,
      sent7d: 0,
      replies7d: 0,
      interested7d: 0,
      bounceRate7d: 0,
      replyRate7d: 0,
      activeCampaigns: 0,
      unreadReplies: 0,
      mailboxes: { active: 0, warming: 0, paused: 0, error: 0 },
    });
    expect(o.daily).toHaveLength(14);
    expect(o.daily[13]).toEqual({ date: '2026-10-12', sent: 0, replies: 0 });
    expect(o.daily[0]?.date).toBe('2026-09-29');
  });

  it('counts sends, replies, interest, bounces and mailbox health', async () => {
    const mailbox = await seedMailbox(db);
    const { campaign } = await seedCampaign(db, { campaign: { status: 'active' } });
    await seedCampaign(db, { campaign: { status: 'paused' } });
    await seedCampaign(db, { campaign: { status: 'active', deletedAt: new Date() } });

    const sent = (at: string) => seedOutbound(db, mailbox.id, { sentAt: new Date(at), campaignId: campaign.id });
    // today in Amsterdam: 10:00 CEST x3, and 00:30 CEST (22:30Z the evening before)
    await sent('2026-10-12T08:00:00Z');
    await sent('2026-10-12T08:05:00Z');
    await sent('2026-10-12T08:10:00Z');
    await sent('2026-10-11T22:30:00Z');
    // yesterday
    await sent('2026-10-11T09:00:00Z');
    await sent('2026-10-11T12:00:00Z');
    // 7 days ago: in the 14-day series, outside the 7-day window
    await sent('2026-10-05T09:00:00Z');
    await sent('2026-10-05T10:00:00Z');
    // never left, or still leaving: not sent
    await seedOutbound(db, mailbox.id, { status: 'failed', sentAt: null });
    await seedOutbound(db, mailbox.id, { status: 'sending', sentAt: null });

    await inbound(mailbox.id, { label: 'interested', readAt: null });
    await inbound(mailbox.id, { label: 'not_interested', readAt: new Date(NOW.getTime() - 1000) });
    await inbound(mailbox.id, { label: 'meeting_request', readAt: null, receivedAt: new Date('2026-10-08T09:00:00Z') });
    await inbound(mailbox.id, { kind: 'auto_reply', label: null, readAt: null });
    await inbound(mailbox.id, { kind: 'bounce', label: null, readAt: null });
    await inbound(mailbox.id, { label: 'interested', receivedAt: new Date('2026-09-20T09:00:00Z'), readAt: new Date() });

    const bounced = await seedProspect(db);
    await seedEnrollment(db, campaign.id, bounced.id, { status: 'bounced', updatedAt: new Date('2026-10-10T09:00:00Z'), nextSendAt: null });

    for (const status of ['active', 'active', 'warming', 'paused', 'suspended', 'error', 'provisioning'] as const) await seedMailbox(db, { status });
    await seedMailbox(db, { status: 'deleted', deletedAt: new Date() });

    const o = await buildOverview(db, NOW);

    expect(o.sentToday).toBe(4);
    expect(o.sent7d).toBe(6);
    expect(o.replies7d).toBe(3);
    expect(o.interested7d).toBe(2); // interested + meeting_request, last 7 days
    expect(o.bounceRate7d).toBeCloseTo(1 / 6, 3);
    expect(o.replyRate7d).toBeCloseTo(0.5, 3);
    expect(o.activeCampaigns).toBe(1);
    expect(o.unreadReplies).toBe(2 + 0); // two unread replies; auto replies and bounces are not replies
    expect(o.mailboxes).toEqual({ active: 3, warming: 1, paused: 2, error: 1 });

    expect(o.daily).toHaveLength(14);
    const byDate = Object.fromEntries(o.daily.map((d) => [d.date, d]));
    expect(byDate['2026-10-12']).toEqual({ date: '2026-10-12', sent: 4, replies: 2 });
    expect(byDate['2026-10-11']).toEqual({ date: '2026-10-11', sent: 2, replies: 0 });
    expect(byDate['2026-10-08']).toEqual({ date: '2026-10-08', sent: 0, replies: 1 });
    expect(byDate['2026-10-05']).toEqual({ date: '2026-10-05', sent: 2, replies: 0 });
  });

  it('falls back to the default timezone without settings, and keeps rates within 0..1', async () => {
    await resetReach(db);
    const mailbox = await seedMailbox(db);
    await seedOutbound(db, mailbox.id, { sentAt: new Date(NOW.getTime() - DAY) });
    for (let i = 0; i < 3; i++) await inbound(mailbox.id, {});
    const o = await buildOverview(db, NOW);
    expect(o.sent7d).toBe(1);
    expect(o.replyRate7d).toBe(1); // 3 replies against 1 send, capped
  });
});

describe('GET /', () => {
  it('serves the overview for a user who can read campaigns, and refuses everyone else', async () => {
    const mailbox = await seedMailbox(db);
    await seedOutbound(db, mailbox.id, { sentAt: new Date(Date.now() - 1000) });
    const ok = await reachApp('/api/reach/overview', overviewRoutes, { permissions: ['reach_campaigns:read'], db }).request('/api/reach/overview');
    expect(ok.status).toBe(200);
    const { data } = await readJson<{ data: ReachOverview }>(ok);
    expect(data.sent7d).toBe(1);
    expect(data.daily).toHaveLength(14);

    const no = await reachApp('/api/reach/overview', overviewRoutes, { permissions: ['reach_prospects:read'], db }).request('/api/reach/overview');
    expect(no.status).toBe(403);
  });
});
