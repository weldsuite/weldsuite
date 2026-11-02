import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { createSqliteD1 } from '@weldsuite/worker-kit/testing/d1';
import type { Database } from '@weldsuite/worker-kit';
import {
  reachCampaignMailboxes,
  reachCampaigns,
  reachCampaignSteps,
  reachEnrollments,
  reachMailboxes,
  reachProspectListMembers,
  reachProspectLists,
  reachSettings,
  reachSuppressions,
} from '@weldsuite/db/schema';
import type {
  ReachAddProspectsReport,
  ReachCampaign,
  ReachCampaignDetail,
  ReachCampaignStepStats,
  ReachEnrollment,
  ReachRenderedPreview,
} from '@weldsuite/app-api-client/schemas/reach';

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>('@weldsuite/entity-events');
  return { ...actual, publishEntityEvent: vi.fn(actual.publishEntityEvent) };
});

import { publishEntityEvent } from '@weldsuite/entity-events';
import campaignRoutes from './index';
import { asJson, readJson, reachApp } from '../../test-support/routes';
import {
  resetReach,
  seedCampaign,
  seedEnrollment,
  seedMailbox,
  seedOutbound,
  seedProspect,
  seedSettings,
  testEnv,
} from '../../test-support/reach';

const publish = publishEntityEvent as ReturnType<typeof vi.fn>;
const MIGRATION = readFileSync(resolve(__dirname, '../../../../workflow-worker/migrations/d1/0004_workspace_due_index.sql'), 'utf8');

let db: Database;
let d1: D1Database;

const ALL = ['reach_campaigns:read', 'reach_campaigns:create', 'reach_campaigns:update', 'reach_campaigns:delete'];
const app = (permissions: string[] = ALL, limits = {}) =>
  reachApp('/api/reach/campaigns', campaignRoutes, { permissions, db, limits, env: testEnv({ SCHEDULE_INDEX: d1 }) });

const events = (action?: string) =>
  publish.mock.calls.map(([arg]) => arg as { entityType: string; action: string; entityId: string }).filter((e) => e.entityType === 'reach_campaign' && (!action || e.action === action));

const dueRow = () =>
  d1.prepare("SELECT next_due_at FROM workspace_due_index WHERE kind = 'reach_send' AND workspace_id = 'org_test_default'").first<number>('next_due_at');

async function post<T>(path: string, body: unknown = {}, a = app()) {
  const res = await a.request(`/api/reach/campaigns${path}`, asJson('POST', body));
  return { res, body: await readJson<{ data: T; error?: { code: string; message: string; details?: { problems?: string[] } } }>(res) };
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

beforeEach(async () => {
  await resetReach(db);
  d1 = createSqliteD1(MIGRATION);
  publish.mockClear();
});

describe('create, read, update, delete', () => {
  it('creates a draft with the workspace defaults and publishes the event', async () => {
    await seedSettings(db, { defaultTimezone: 'Europe/Berlin', defaultSendDays: [1, 2, 3], defaultWindowStart: '08:30', defaultWindowEnd: '16:00' });
    const { res, body } = await post<ReachCampaignDetail>('', { name: 'Q4 outreach' });

    expect(res.status).toBe(201);
    expect(body.data).toMatchObject({
      name: 'Q4 outreach',
      status: 'draft',
      timezone: 'Europe/Berlin',
      sendDays: [1, 2, 3],
      windowStart: '08:30',
      windowEnd: '16:00',
      steps: [],
      mailboxIds: [],
      stats: { prospects: 0, sent: 0, replied: 0, interested: 0, bounced: 0, unsubscribed: 0 },
    });
    expect(body.data.id).toMatch(/^rcmp_/);
    expect(events('created')).toHaveLength(1);
  });

  it('lets the request override the defaults and refuses schedules that cannot work', async () => {
    const ok = await post<ReachCampaignDetail>('', { name: 'X', timezone: 'America/New_York', dailyLimit: 40, minGapMinutes: 15, stopOnAutoReply: true });
    expect(ok.body.data).toMatchObject({ timezone: 'America/New_York', dailyLimit: 40, minGapMinutes: 15, stopOnAutoReply: true });

    expect((await post('', { name: 'X', windowStart: '17:00', windowEnd: '09:00' })).res.status).toBe(400);
    expect((await post('', { name: 'X', timezone: 'Mars/Olympus' })).res.status).toBe(400);
    expect((await post('', { name: '' })).res.status).toBe(400);
  });

  it('lists with filters and a cursor, and reads one with its steps and mailboxes', async () => {
    const mailbox = await seedMailbox(db);
    const { campaign } = await seedCampaign(db, { campaign: { name: 'Alpha', status: 'draft' }, mailboxIds: [mailbox.id] });
    await seedCampaign(db, { campaign: { name: 'Beta', status: 'paused' } });
    await seedCampaign(db, { campaign: { name: 'Gone', deletedAt: new Date() } });

    const all = await readJson<{ data: ReachCampaign[]; pagination: { totalCount: number; hasMore: boolean; cursor: string | null } }>(await app().request('/api/reach/campaigns?limit=1'));
    expect(all.data).toHaveLength(1);
    expect(all.pagination).toMatchObject({ totalCount: 2, hasMore: true });
    const next = await readJson<{ data: ReachCampaign[] }>(await app().request(`/api/reach/campaigns?limit=1&cursor=${all.pagination.cursor}`));
    expect(next.data).toHaveLength(1);
    expect(next.data[0]?.id).not.toBe(all.data[0]?.id);

    const paused = await readJson<{ data: ReachCampaign[] }>(await app().request('/api/reach/campaigns?status=paused'));
    expect(paused.data.map((c) => c.name)).toEqual(['Beta']);
    const search = await readJson<{ data: ReachCampaign[] }>(await app().request('/api/reach/campaigns?search=alp'));
    expect(search.data.map((c) => c.name)).toEqual(['Alpha']);
    expect((await app().request('/api/reach/campaigns?status=bogus')).status).toBe(400);

    const detail = await readJson<{ data: ReachCampaignDetail }>(await app().request(`/api/reach/campaigns/${campaign.id}`));
    expect(detail.data.mailboxIds).toEqual([mailbox.id]);
    expect(detail.data.steps).toHaveLength(1);
    expect((await app().request('/api/reach/campaigns/rcmp_nope')).status).toBe(404);
  });

  it('updates fields, validating the merged schedule', async () => {
    const { campaign } = await seedCampaign(db, { campaign: { status: 'draft', windowStart: '09:00', windowEnd: '17:00' } });
    const res = await app().request(`/api/reach/campaigns/${campaign.id}`, asJson('PATCH', { name: 'Renamed', dailyLimit: 25, sendDays: [1, 2] }));
    expect(res.status).toBe(200);
    expect((await readJson<{ data: ReachCampaignDetail }>(res)).data).toMatchObject({ name: 'Renamed', dailyLimit: 25, sendDays: [1, 2] });
    expect(events('updated')).toHaveLength(1);

    // only the window end changes, but it would end before the stored start
    expect((await app().request(`/api/reach/campaigns/${campaign.id}`, asJson('PATCH', { windowEnd: '08:00' }))).status).toBe(400);
    expect((await app().request('/api/reach/campaigns/rcmp_nope', asJson('PATCH', { name: 'x' }))).status).toBe(404);
  });

  it('deletes a campaign that is not running, and frees its prospects', async () => {
    const { campaign } = await seedCampaign(db, { campaign: { status: 'paused' } });
    const prospect = await seedProspect(db);
    const enrollment = await seedEnrollment(db, campaign.id, prospect.id);

    const res = await app().request(`/api/reach/campaigns/${campaign.id}`, { method: 'DELETE' });

    expect(res.status).toBe(204);
    expect((await app().request(`/api/reach/campaigns/${campaign.id}`)).status).toBe(404);
    const [row] = await db.select().from(reachEnrollments).where(eq(reachEnrollments.id, enrollment.id));
    expect(row).toMatchObject({ status: 'paused', stoppedReason: 'campaign_deleted' });
    expect(events('deleted')).toHaveLength(1);
  });

  it('refuses to delete a running campaign', async () => {
    const { campaign } = await seedCampaign(db, { campaign: { status: 'active' } });
    const res = await app().request(`/api/reach/campaigns/${campaign.id}`, { method: 'DELETE' });
    expect(res.status).toBe(409);
    expect((await readJson<{ error: { code: string } }>(res)).error.code).toBe('CAMPAIGN_ACTIVE');
  });

  it('is refused without the permission', async () => {
    expect((await app(['reach_campaigns:read']).request('/api/reach/campaigns', asJson('POST', { name: 'x' }))).status).toBe(403);
    expect((await app([]).request('/api/reach/campaigns')).status).toBe(403);
  });
});

describe('PUT /:id/steps', () => {
  const steps = [
    { delayDays: 0, delayHours: 0, subject: 'Hello {{firstName}}', body: 'First', replyInThread: true },
    { delayDays: 3, delayHours: 0, subject: 'Follow-up', body: 'Second', replyInThread: true },
    { delayDays: 5, delayHours: 2, subject: 'Last one', body: 'Third', replyInThread: false },
  ];

  it('replaces all steps, keeping the id of a step that stays at its position', async () => {
    const { campaign, steps: before } = await seedCampaign(db, { campaign: { status: 'draft' }, steps: [{ subject: 'Old 1', body: 'a' }, { subject: 'Old 2', body: 'b' }, { subject: 'Old 3', body: 'c' }, { subject: 'Old 4', body: 'd' }] });

    const res = await app().request(`/api/reach/campaigns/${campaign.id}/steps`, asJson('PUT', { steps }));

    expect(res.status).toBe(200);
    const { data } = await readJson<{ data: ReachCampaignDetail }>(res);
    expect(data.steps.map((s) => [s.order, s.subject, s.delayDays, s.delayHours, s.replyInThread])).toEqual([
      [0, 'Hello {{firstName}}', 0, 0, true],
      [1, 'Follow-up', 3, 0, true],
      [2, 'Last one', 5, 2, false],
    ]);
    expect(data.steps.map((s) => s.id)).toEqual(before.slice(0, 3).map((s) => s.id));
    expect(await db.select().from(reachCampaignSteps).where(eq(reachCampaignSteps.campaignId, campaign.id))).toHaveLength(3);
    expect(events('updated')).toHaveLength(1);
  });

  it('adds steps beyond the existing ones', async () => {
    const { campaign } = await seedCampaign(db, { campaign: { status: 'draft' }, steps: [{ subject: 'Only', body: 'a' }] });
    const { data } = await readJson<{ data: ReachCampaignDetail }>(await app().request(`/api/reach/campaigns/${campaign.id}/steps`, asJson('PUT', { steps })));
    expect(data.steps).toHaveLength(3);
    expect(data.steps[2]?.id).toMatch(/^rstp_/);
  });

  it('answers 409 CAMPAIGN_ACTIVE while the campaign runs, and allows it once paused', async () => {
    const { campaign } = await seedCampaign(db, { campaign: { status: 'active' } });
    const res = await app().request(`/api/reach/campaigns/${campaign.id}/steps`, asJson('PUT', { steps }));
    expect(res.status).toBe(409);
    expect((await readJson<{ error: { code: string } }>(res)).error.code).toBe('CAMPAIGN_ACTIVE');

    await db.update(reachCampaigns).set({ status: 'paused' }).where(eq(reachCampaigns.id, campaign.id));
    expect((await app().request(`/api/reach/campaigns/${campaign.id}/steps`, asJson('PUT', { steps }))).status).toBe(200);
  });

  it('validates the steps', async () => {
    const { campaign } = await seedCampaign(db, { campaign: { status: 'draft' } });
    expect((await app().request(`/api/reach/campaigns/${campaign.id}/steps`, asJson('PUT', { steps: [] }))).status).toBe(400);
    expect((await app().request(`/api/reach/campaigns/${campaign.id}/steps`, asJson('PUT', { steps: [{ ...steps[0], subject: '' }] }))).status).toBe(400);
    expect((await app().request('/api/reach/campaigns/rcmp_nope/steps', asJson('PUT', { steps }))).status).toBe(404);
  });
});

describe('PUT /:id/mailboxes', () => {
  it('assigns mailboxes, replacing the previous set, and refuses unknown ones', async () => {
    const a = await seedMailbox(db);
    const b = await seedMailbox(db, { status: 'warming' });
    const gone = await seedMailbox(db, { status: 'deleted', deletedAt: new Date() });
    const { campaign } = await seedCampaign(db, { campaign: { status: 'draft' }, mailboxIds: [a.id] });

    const res = await app().request(`/api/reach/campaigns/${campaign.id}/mailboxes`, asJson('PUT', { mailboxIds: [b.id] }));
    expect(res.status).toBe(200);
    expect((await readJson<{ data: ReachCampaignDetail }>(res)).data.mailboxIds).toEqual([b.id]);
    expect(await db.select().from(reachCampaignMailboxes)).toHaveLength(1);

    const bad = await app().request(`/api/reach/campaigns/${campaign.id}/mailboxes`, asJson('PUT', { mailboxIds: [a.id, gone.id, 'rmbx_nope'] }));
    expect(bad.status).toBe(400);
    expect((await app().request(`/api/reach/campaigns/${campaign.id}/mailboxes`, asJson('PUT', { mailboxIds: [] }))).status).toBe(200);
    expect(await db.select().from(reachCampaignMailboxes)).toHaveLength(0);
  });
});

describe('POST /:id/prospects', () => {
  it('enrolls the eligible prospects as queued and reports every skip by reason', async () => {
    const { campaign } = await seedCampaign(db, { campaign: { status: 'draft' } });
    const other = await seedCampaign(db, { campaign: { status: 'active' } });

    const fine1 = await seedProspect(db, { email: 'a@bigco.io' });
    const fine2 = await seedProspect(db, { email: 'b@bigco.io' });
    const already = await seedProspect(db, { email: 'already@bigco.io' });
    const suppressed = await seedProspect(db, { email: 'sup@bigco.io' });
    const suppressedDomain = await seedProspect(db, { email: 'someone@blocked.example' });
    const consumer = await seedProspect(db, { email: 'me@gmail.com' });
    const invalid = await seedProspect(db, { email: 'info@bigco.io', validation: 'role' });
    const noMx = await seedProspect(db, { email: 'x@nomx.test', validation: 'no_mx' });
    const elsewhere = await seedProspect(db, { email: 'busy@bigco.io' });
    const finished = await seedProspect(db, { email: 'finished@bigco.io' });
    await seedEnrollment(db, campaign.id, already.id, { status: 'queued', nextSendAt: null });
    await seedEnrollment(db, other.campaign.id, elsewhere.id, { status: 'active' });
    await seedEnrollment(db, other.campaign.id, finished.id, { status: 'completed', nextSendAt: null });
    await db.insert(reachSuppressions).values([
      { id: 'rsup_1', value: 'sup@bigco.io', type: 'email', reason: 'unsubscribed' },
      { id: 'rsup_2', value: 'blocked.example', type: 'domain', reason: 'manual' },
    ]);

    const ids = [fine1, fine2, already, suppressed, suppressedDomain, consumer, invalid, noMx, elsewhere, finished].map((p) => p.id);
    const { res, body } = await post<ReachAddProspectsReport>(`/${campaign.id}/prospects`, { prospectIds: [...ids, 'rpro_unknown'] });

    expect(res.status).toBe(200);
    expect(body.data.added).toBe(3); // fine1, fine2, finished (its other enrollment is over)
    expect(Object.fromEntries(body.data.skipped.map((s) => [s.reason, s.count]))).toEqual({
      already_enrolled: 1,
      suppressed: 2,
      consumer: 1,
      invalid: 2,
      enrolled_elsewhere: 1,
    });
    const rows = await db.select().from(reachEnrollments).where(eq(reachEnrollments.campaignId, campaign.id));
    expect(rows.filter((r) => r.status === 'queued')).toHaveLength(4); // 3 new + the one that was already there
    const [c] = await db.select().from(reachCampaigns).where(eq(reachCampaigns.id, campaign.id));
    expect(c?.stats.prospects).toBe(4);
    expect(events('updated')).toHaveLength(1);
  });

  it('takes a whole list, and skips the same prospect the second time', async () => {
    const { campaign } = await seedCampaign(db, { campaign: { status: 'draft' } });
    const p1 = await seedProspect(db);
    const p2 = await seedProspect(db);
    await db.insert(reachProspectLists).values({ id: 'rpl_a', name: 'A', prospectCount: 2 });
    await db.insert(reachProspectListMembers).values([
      { id: 'rplm_1', listId: 'rpl_a', prospectId: p1.id },
      { id: 'rplm_2', listId: 'rpl_a', prospectId: p2.id },
    ]);

    const first = await post<ReachAddProspectsReport>(`/${campaign.id}/prospects`, { listId: 'rpl_a' });
    expect(first.body.data).toMatchObject({ added: 2, skipped: [] });
    const second = await post<ReachAddProspectsReport>(`/${campaign.id}/prospects`, { listId: 'rpl_a' });
    expect(second.body.data).toMatchObject({ added: 0, skipped: [{ reason: 'already_enrolled', count: 2 }] });

    expect((await post(`/${campaign.id}/prospects`, { listId: 'rpl_nope' })).res.status).toBe(404);
    expect((await post(`/${campaign.id}/prospects`, {})).res.status).toBe(400);
    expect((await post('/rcmp_nope/prospects', { listId: 'rpl_a' })).res.status).toBe(404);
  });

  it('lets consumer addresses in when the workspace is allowed them', async () => {
    const { campaign } = await seedCampaign(db, { campaign: { status: 'draft' } });
    const consumer = await seedProspect(db, { email: 'me@gmail.com' });
    const { body } = await post<ReachAddProspectsReport>(`/${campaign.id}/prospects`, { prospectIds: [consumer.id] }, app(ALL, { allowConsumerRecipients: true }));
    expect(body.data).toMatchObject({ added: 1, skipped: [] });
  });

  it('puts prospects added to a running campaign straight into the send schedule', async () => {
    const { campaign } = await seedCampaign(db, { campaign: { status: 'active' } });
    const p = await seedProspect(db);
    const before = Date.now();
    await post(`/${campaign.id}/prospects`, { prospectIds: [p.id] });
    const [e] = await db.select().from(reachEnrollments).where(eq(reachEnrollments.campaignId, campaign.id));
    expect(e?.status).toBe('active');
    expect(e?.nextSendAt).not.toBeNull();
    expect(await dueRow()).toBeLessThanOrEqual(Math.max(before, e!.nextSendAt!.getTime()) + 1000);
  });

  it('refuses a campaign that has finished', async () => {
    const { campaign } = await seedCampaign(db, { campaign: { status: 'completed' } });
    const p = await seedProspect(db);
    const { res, body } = await post(`/${campaign.id}/prospects`, { prospectIds: [p.id] });
    expect(res.status).toBe(409);
    expect(body.error?.code).toBe('CAMPAIGN_CLOSED');
  });
});

describe('enrollments', () => {
  it('lists them with prospect and mailbox, filters by status and pages', async () => {
    const mailbox = await seedMailbox(db);
    const { campaign } = await seedCampaign(db, { campaign: { status: 'active' } });
    const p1 = await seedProspect(db, { email: 'one@bigco.io' });
    const p2 = await seedProspect(db, { email: 'two@bigco.io' });
    const p3 = await seedProspect(db, { email: 'three@bigco.io' });
    await seedEnrollment(db, campaign.id, p1.id, { status: 'active', mailboxId: mailbox.id, currentStep: 1 });
    await seedEnrollment(db, campaign.id, p2.id, { status: 'replied', nextSendAt: null, stoppedReason: 'replied' });
    await seedEnrollment(db, campaign.id, p3.id, { status: 'queued', nextSendAt: null });

    const all = await readJson<{ data: ReachEnrollment[]; pagination: { totalCount: number; hasMore: boolean; cursor: string | null } }>(
      await app().request(`/api/reach/campaigns/${campaign.id}/enrollments?limit=2`),
    );
    expect(all.data).toHaveLength(2);
    expect(all.pagination).toMatchObject({ totalCount: 3, hasMore: true });
    const rest = await readJson<{ data: ReachEnrollment[] }>(await app().request(`/api/reach/campaigns/${campaign.id}/enrollments?limit=2&cursor=${all.pagination.cursor}`));
    expect(rest.data).toHaveLength(1);

    const active = await readJson<{ data: ReachEnrollment[]; pagination: { totalCount: number } }>(await app().request(`/api/reach/campaigns/${campaign.id}/enrollments?status=active`));
    expect(active.pagination.totalCount).toBe(1);
    expect(active.data[0]).toMatchObject({
      status: 'active',
      currentStep: 1,
      mailboxId: mailbox.id,
      mailboxEmail: mailbox.email,
      prospect: { email: 'one@bigco.io', firstName: 'Jane' },
    });
    expect((await app().request(`/api/reach/campaigns/${campaign.id}/enrollments?status=bogus`)).status).toBe(400);
    expect((await app().request('/api/reach/campaigns/rcmp_nope/enrollments')).status).toBe(404);
  });

  it('removes an enrollment, recounts the campaign and completes it when nothing is left', async () => {
    const { campaign } = await seedCampaign(db, { campaign: { status: 'active' } });
    const p = await seedProspect(db);
    const enrollment = await seedEnrollment(db, campaign.id, p.id);

    const res = await app().request(`/api/reach/campaigns/${campaign.id}/enrollments/${enrollment.id}`, { method: 'DELETE' });

    expect(res.status).toBe(204);
    expect(await db.select().from(reachEnrollments)).toHaveLength(0);
    const [c] = await db.select().from(reachCampaigns).where(eq(reachCampaigns.id, campaign.id));
    expect(c).toMatchObject({ status: 'completed' });
    expect(c?.stats.prospects).toBe(0);
    expect(events('completed')).toHaveLength(1);
    expect((await app().request(`/api/reach/campaigns/${campaign.id}/enrollments/${enrollment.id}`, { method: 'DELETE' })).status).toBe(404);
  });
});

describe('POST /:id/launch', () => {
  async function ready() {
    await seedSettings(db);
    const mailbox = await seedMailbox(db);
    const { campaign } = await seedCampaign(db, { campaign: { status: 'draft', timezone: 'UTC', windowStart: '00:00', windowEnd: '23:59' }, mailboxIds: [mailbox.id] });
    const prospects = await Promise.all([seedProspect(db), seedProspect(db), seedProspect(db)]);
    for (const p of prospects) await seedEnrollment(db, campaign.id, p.id, { status: 'queued', nextSendAt: null });
    return { campaign, mailbox, prospects };
  }

  it('activates the queued enrollments over the window, marks the workspace due and publishes launched', async () => {
    const { campaign } = await ready();
    const before = Date.now();

    const { res, body } = await post<ReachCampaignDetail>(`/${campaign.id}/launch`);

    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({ status: 'active', pausedReason: null });
    expect(body.data.launchedAt).not.toBeNull();
    const rows = await db.select().from(reachEnrollments).where(eq(reachEnrollments.campaignId, campaign.id));
    expect(rows.every((r) => r.status === 'active' && r.nextSendAt !== null)).toBe(true);
    const times = rows.map((r) => r.nextSendAt!.getTime()).sort((a, b) => a - b);
    expect(times[0]).toBeGreaterThanOrEqual(before - 1000);
    expect(new Set(times).size).toBeGreaterThan(1); // spread, not a single instant
    expect(await dueRow()).toBeLessThanOrEqual(times[0]! + 1000);
    expect(events('launched')).toHaveLength(1);
  });

  it('lists everything that blocks a launch', async () => {
    const warming = await seedMailbox(db, { status: 'warming' });
    const { campaign } = await seedCampaign(db, { campaign: { status: 'draft' }, steps: [], mailboxIds: [warming.id] });
    const { res, body } = await post(`/${campaign.id}/launch`);
    expect(res.status).toBe(400);
    expect([...(body.error?.details?.problems ?? [])].sort()).toEqual(['no_active_mailbox', 'no_prospects', 'no_sender_identity', 'no_steps']);
    expect((await db.select().from(reachCampaigns).where(eq(reachCampaigns.id, campaign.id)))[0]?.status).toBe('draft');
    expect(events('launched')).toHaveLength(0);
  });

  it.each([
    ['no steps', async (id: string) => { await db.delete(reachCampaignSteps).where(eq(reachCampaignSteps.campaignId, id)); }, 'no_steps'],
    ['no mailbox', async (id: string) => { await db.delete(reachCampaignMailboxes).where(eq(reachCampaignMailboxes.campaignId, id)); }, 'no_active_mailbox'],
    ['no sender identity', async () => { await db.update(reachSettings).set({ senderAddress: null }); }, 'no_sender_identity'],
    ['no prospects', async (id: string) => { await db.delete(reachEnrollments).where(eq(reachEnrollments.campaignId, id)); }, 'no_prospects'],
  ])('blocks the launch with %s', async (_label, breakIt, problem) => {
    const { campaign } = await ready();
    await breakIt(campaign.id);
    const { res, body } = await post(`/${campaign.id}/launch`);
    expect(res.status).toBe(400);
    expect(body.error?.details?.problems).toEqual([problem]);
  });

  it('does not count a warming mailbox, only an active one', async () => {
    const { campaign, mailbox } = await ready();
    await db.update(reachMailboxes).set({ status: 'warming' }).where(eq(reachMailboxes.id, mailbox.id));
    const { res, body } = await post(`/${campaign.id}/launch`);
    expect(res.status).toBe(400);
    expect(body.error?.details?.problems).toEqual(['no_active_mailbox']);
  });

  it('answers 409 for a campaign that already runs, is paused or archived', async () => {
    for (const [status, code] of [['active', 'CAMPAIGN_ACTIVE'], ['paused', 'CAMPAIGN_PAUSED'], ['archived', 'CAMPAIGN_CLOSED']] as const) {
      const { campaign } = await seedCampaign(db, { campaign: { status } });
      const { res, body } = await post(`/${campaign.id}/launch`);
      expect(res.status).toBe(409);
      expect(body.error?.code).toBe(code);
    }
    expect((await post('/rcmp_nope/launch')).res.status).toBe(404);
  });
});

describe('pause and resume', () => {
  it('pauses a running campaign and resumes it, activating prospects added meanwhile and re-marking the workspace due', async () => {
    const mailbox = await seedMailbox(db);
    const { campaign } = await seedCampaign(db, { campaign: { status: 'active' }, mailboxIds: [mailbox.id] });
    const p1 = await seedProspect(db);
    await seedEnrollment(db, campaign.id, p1.id, { status: 'active', nextSendAt: new Date(Date.now() + 3_600_000) });

    const paused = await post<ReachCampaignDetail>(`/${campaign.id}/pause`);
    expect(paused.res.status).toBe(200);
    expect(paused.body.data).toMatchObject({ status: 'paused', pausedReason: 'manual' });
    expect(events('paused')).toHaveLength(1);
    expect((await post(`/${campaign.id}/pause`)).res.status).toBe(409);

    // a prospect added while paused waits as queued
    const p2 = await seedProspect(db);
    await post(`/${campaign.id}/prospects`, { prospectIds: [p2.id] });
    const queued = await db.select().from(reachEnrollments).where(eq(reachEnrollments.prospectId, p2.id));
    expect(queued[0]?.status).toBe('queued');

    const resumed = await post<ReachCampaignDetail>(`/${campaign.id}/resume`);
    expect(resumed.res.status).toBe(200);
    expect(resumed.body.data).toMatchObject({ status: 'active', pausedReason: null });
    const after = await db.select().from(reachEnrollments).where(eq(reachEnrollments.prospectId, p2.id));
    expect(after[0]?.status).toBe('active');
    expect(await dueRow()).not.toBeNull();
    expect((await post(`/${campaign.id}/resume`)).res.status).toBe(409);
  });

  it('clears the automatic pause reason on resume', async () => {
    const { campaign } = await seedCampaign(db, { campaign: { status: 'paused', pausedReason: 'bounce_rate' } });
    const { body } = await post<ReachCampaignDetail>(`/${campaign.id}/resume`);
    expect(body.data).toMatchObject({ status: 'active', pausedReason: null });
  });

  it('only pauses what runs and resumes what is paused', async () => {
    const { campaign } = await seedCampaign(db, { campaign: { status: 'draft' } });
    expect((await post(`/${campaign.id}/pause`)).res.status).toBe(409);
    expect((await post(`/${campaign.id}/resume`)).res.status).toBe(409);
    expect((await post('/rcmp_nope/pause')).res.status).toBe(404);
    expect((await post('/rcmp_nope/resume')).res.status).toBe(404);
  });
});

describe('POST /:id/preview', () => {
  it('renders a step for a prospect with the sender from the first assigned mailbox, signature and footer', async () => {
    await seedSettings(db, { optOutText: 'Reply stop to opt out.', senderCompanyName: 'Acme BV', senderAddress: 'Keizersgracht 1' });
    const mailbox = await seedMailbox(db, { firstName: 'Sam', lastName: 'Taylor', signature: 'Sam Taylor | Acme' });
    const { campaign, steps } = await seedCampaign(db, {
      campaign: { status: 'draft' },
      mailboxIds: [mailbox.id],
      steps: [{ subject: 'Hello {{firstName|there}}', body: 'Hi {{firstName}}, I am {{senderFirstName}} {{senderLastName}}. {{city|your city}}' }],
    });
    const prospect = await seedProspect(db, { firstName: 'Jane', companyName: 'BigCo' });

    const { body } = await post<ReachRenderedPreview>(`/${campaign.id}/preview`, { stepId: steps[0]!.id, prospectId: prospect.id });

    expect(body.data.subject).toBe('Hello Jane');
    expect(body.data.body).toBe('Hi Jane, I am Sam Taylor. your city\n\nSam Taylor | Acme\n\n-- \nReply stop to opt out.\nAcme BV\nKeizersgracht 1');
    expect(body.data.missingVariables).toEqual([]);
  });

  it('reports variables that would stop a prospect from being emailed', async () => {
    const { campaign } = await seedCampaign(db, { campaign: { status: 'draft' }, steps: [{ subject: 'About {{companyName}}', body: 'Saw your {{recentNews}}' }] });
    const prospect = await seedProspect(db, { companyName: null });
    const { body } = await post<ReachRenderedPreview>(`/${campaign.id}/preview`, { prospectId: prospect.id });
    expect([...body.data.missingVariables].sort()).toEqual(['companyName', 'recentNews']);
    expect(body.data.subject).toBe('About {{companyName}}');
  });

  it('previews unsaved text, with a sample prospect when none is enrolled', async () => {
    const { campaign } = await seedCampaign(db, { campaign: { status: 'draft' }, steps: [] });
    const { res, body } = await post<ReachRenderedPreview>(`/${campaign.id}/preview`, { subject: 'Hi {{firstName}}', body: 'From {{companyName}}' });
    expect(res.status).toBe(200);
    expect(body.data.subject).toBe('Hi Alex');
    expect(body.data.body).toContain('From Example Inc');
  });

  it('uses the first enrolled prospect by default and answers 400/404 for what it cannot preview', async () => {
    const { campaign } = await seedCampaign(db, { campaign: { status: 'draft' }, steps: [{ subject: 'Hello {{firstName}}', body: 'x' }] });
    await seedEnrollment(db, campaign.id, (await seedProspect(db, { firstName: 'Enrolled' })).id);
    expect((await post<ReachRenderedPreview>(`/${campaign.id}/preview`)).body.data.subject).toBe('Hello Enrolled');

    const empty = await seedCampaign(db, { campaign: { status: 'draft' }, steps: [] });
    expect((await post(`/${empty.campaign.id}/preview`)).res.status).toBe(400);
    expect((await post(`/${campaign.id}/preview`, { stepId: 'rstp_nope' })).res.status).toBe(404);
    expect((await post(`/${campaign.id}/preview`, { prospectId: 'rpro_nope' })).res.status).toBe(404);
    expect((await post('/rcmp_nope/preview')).res.status).toBe(404);
  });
});

describe('GET /:id/stats', () => {
  it('counts sent, replied and bounced per step', async () => {
    const mailbox = await seedMailbox(db);
    const { campaign, steps } = await seedCampaign(db, {
      mailboxIds: [mailbox.id],
      steps: [{ subject: 'One', body: 'a' }, { subject: 'Two', body: 'b' }],
    });
    // explicit, strictly increasing creation times: "the last email to a prospect" must not depend on the clock's resolution
    let tick = 0;
    const send = async (stepIdx: number, enrollmentId: string, status: 'sent' | 'failed' = 'sent') =>
      seedOutbound(db, mailbox.id, {
        campaignId: campaign.id,
        enrollmentId,
        stepId: steps[stepIdx]!.id,
        status,
        sentAt: status === 'sent' ? new Date() : null,
        createdAt: new Date(Date.UTC(2026, 9, 12, 8, 0, 0) + ++tick * 1000),
      });

    const e1 = await seedEnrollment(db, campaign.id, (await seedProspect(db)).id, { status: 'replied', nextSendAt: null });
    const e2 = await seedEnrollment(db, campaign.id, (await seedProspect(db)).id, { status: 'replied', nextSendAt: null });
    const e3 = await seedEnrollment(db, campaign.id, (await seedProspect(db)).id, { status: 'bounced', nextSendAt: null });
    const e4 = await seedEnrollment(db, campaign.id, (await seedProspect(db)).id, { status: 'active' });
    // e1 replied to step 1, e2 to step 2, e3 bounced on step 1, e4 got both
    await send(0, e1.id);
    await send(0, e2.id);
    await send(1, e2.id);
    await send(0, e3.id);
    await send(0, e4.id);
    await send(1, e4.id);

    const { data } = await readJson<{ data: ReachCampaignStepStats[] }>(await app().request(`/api/reach/campaigns/${campaign.id}/stats`));

    expect(data).toEqual([
      { stepId: steps[0]!.id, order: 0, sent: 4, replied: 1, bounced: 1 },
      { stepId: steps[1]!.id, order: 1, sent: 2, replied: 1, bounced: 0 },
    ]);
    expect((await app().request('/api/reach/campaigns/rcmp_nope/stats')).status).toBe(404);
  });
});
