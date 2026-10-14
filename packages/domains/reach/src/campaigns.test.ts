/**
 * The campaign operations an API runs, against pglite: what they refuse (as a
 * `ReachDomainError`), what they write, and what they send through the two
 * ports (entity events, waking the send sweep).
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit/db';
import { reachCampaignSteps, reachEnrollments } from '@weldsuite/db/schema';
import {
  createCampaign,
  deleteCampaign,
  enrollCampaignProspects,
  getCampaignDetail,
  getCampaignStats,
  launchCampaign,
  listCampaigns,
  listEnrollments,
  pauseCampaign,
  previewCampaignStep,
  removeCampaignEnrollment,
  replaceCampaignSteps,
  resumeCampaign,
  setCampaignMailboxes,
  updateCampaign,
  type EnrollDeps,
} from './campaigns';
import { ReachDomainError } from './errors';
import type { ReachEvent } from './events';
import { resetReach, seedCampaign, seedEnrollment, seedMailbox, seedProspect, seedSettings } from './testing/reach';

let db: Database;
let events: ReachEvent[];
let due: Array<{ kind: string; at: Date }>;

const emit = (event: ReachEvent) => {
  events.push(event);
};
const onDue = (kind: 'reach_send', at: Date) => {
  due.push({ kind, at });
};
const d = () => ({ db, emit, onDue, userId: 'user_1' });
const enrollDeps = (allowConsumerRecipients = false): EnrollDeps => ({ ...d(), limits: { allowConsumerRecipients } });

const actions = (type = 'reach_campaign') => events.filter((e) => e.entityType === type).map((e) => e.action);

/** What the promise was refused with. */
async function refused(promise: Promise<unknown>): Promise<ReachDomainError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ReachDomainError);
  return err as ReachDomainError;
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

beforeEach(async () => {
  await resetReach(db);
  events = [];
  due = [];
});

/** A draft campaign that can launch: a step, an active mailbox, a sender identity and one queued prospect. */
async function launchable(status: 'draft' | 'paused' = 'draft') {
  await seedSettings(db);
  const mailbox = await seedMailbox(db);
  const { campaign } = await seedCampaign(db, { campaign: { status }, mailboxIds: [mailbox.id] });
  const prospect = await seedProspect(db);
  const enrollment = await seedEnrollment(db, campaign.id, prospect.id, { status: 'queued', nextSendAt: null });
  return { campaign, mailbox, prospect, enrollment };
}

describe('createCampaign', () => {
  it('creates a draft with the workspace defaults and emits reach_campaign:created', async () => {
    await seedSettings(db, { defaultTimezone: 'Europe/Berlin', defaultSendDays: [1, 2, 3], defaultWindowStart: '08:30', defaultWindowEnd: '16:00' });

    const campaign = await createCampaign(d(), { name: 'Q4 outreach' });

    expect(campaign).toMatchObject({
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
    expect(campaign.id).toMatch(/^rcmp_/);
    expect(events).toMatchObject([{ entityType: 'reach_campaign', action: 'created', entityId: campaign.id }]);
  });

  it('refuses a schedule that cannot work with a 400', async () => {
    expect(await refused(createCampaign(d(), { name: 'X', windowStart: '17:00', windowEnd: '09:00' }))).toMatchObject({
      code: 'BAD_REQUEST',
      status: 400,
      message: 'The sending window must end after it starts',
    });
    expect(await refused(createCampaign(d(), { name: 'X', timezone: 'Mars/Olympus' }))).toMatchObject({
      code: 'BAD_REQUEST',
      message: "Unknown timezone 'Mars/Olympus'",
    });
    expect(events).toEqual([]);
  });
});

describe('reading', () => {
  it('lists newest first with a cursor, filters by status and name, and refuses an unknown status', async () => {
    await seedCampaign(db, { campaign: { name: 'Alpha', status: 'draft' } });
    await seedCampaign(db, { campaign: { name: 'Beta', status: 'paused' } });
    await seedCampaign(db, { campaign: { name: 'Gone', deletedAt: new Date() } });

    const first = await listCampaigns(db, { limit: '1' });
    expect(first).toMatchObject({ totalCount: 2, hasMore: true });
    expect(first.data).toHaveLength(1);
    const next = await listCampaigns(db, { limit: 1, cursor: first.cursor ?? undefined });
    expect(next.data).toHaveLength(1);
    expect(next.data[0]?.id).not.toBe(first.data[0]?.id);

    expect((await listCampaigns(db, { status: 'paused' })).data.map((c) => c.name)).toEqual(['Beta']);
    expect((await listCampaigns(db, { search: 'alp' })).data.map((c) => c.name)).toEqual(['Alpha']);
    expect(await refused(listCampaigns(db, { status: 'sleeping' }))).toMatchObject({ code: 'BAD_REQUEST', message: 'Unknown status filter' });
  });

  it('answers a missing campaign with a 404 naming it', async () => {
    expect(await refused(getCampaignDetail(db, 'rcmp_nope'))).toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
      message: "Campaign with ID 'rcmp_nope' not found",
    });
    expect(await refused(getCampaignStats(db, 'rcmp_nope'))).toMatchObject({ status: 404 });
  });
});

describe('updateCampaign and deleteCampaign', () => {
  it('updates, emits and answers with the detail; refuses a bad window and an unknown id', async () => {
    const { campaign } = await seedCampaign(db, { campaign: { status: 'draft', timezone: 'UTC', windowStart: '09:00', windowEnd: '17:00' } });

    const updated = await updateCampaign(d(), campaign.id, { name: 'Renamed', dailyLimit: 40 });
    expect(updated).toMatchObject({ name: 'Renamed', dailyLimit: 40, steps: expect.any(Array) });
    expect(actions()).toEqual(['updated']);

    expect(await refused(updateCampaign(d(), campaign.id, { windowStart: '18:00' }))).toMatchObject({ status: 400 });
    expect(await refused(updateCampaign(d(), 'rcmp_nope', { name: 'x' }))).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses to delete a running campaign, and frees the prospects of a deleted one', async () => {
    const running = (await seedCampaign(db, { campaign: { status: 'active' } })).campaign;
    expect(await refused(deleteCampaign(d(), running.id))).toMatchObject({
      code: 'CAMPAIGN_ACTIVE',
      status: 409,
      message: 'Pause the campaign before deleting it',
    });

    const { campaign, enrollment } = await launchable('paused');
    await deleteCampaign(d(), campaign.id);

    const [row] = await db.select().from(reachEnrollments).where(eq(reachEnrollments.id, enrollment.id));
    expect(row).toMatchObject({ status: 'paused', stoppedReason: 'campaign_deleted', nextSendAt: null });
    expect(events.at(-1)).toMatchObject({ action: 'deleted', entityId: campaign.id, data: { id: campaign.id } });
    expect(await refused(getCampaignDetail(db, campaign.id))).toMatchObject({ status: 404 });
  });
});

describe('steps and mailboxes', () => {
  it('replaces the steps by position: edited ones keep their id, extra ones go', async () => {
    const { campaign, steps } = await seedCampaign(db, {
      campaign: { status: 'draft' },
      steps: [
        { subject: 'One', body: 'a' },
        { subject: 'Two', body: 'b' },
        { subject: 'Three', body: 'c' },
      ],
    });

    const detail = await replaceCampaignSteps(d(), campaign.id, [
      { subject: 'One v2', body: 'a2', delayDays: 0, delayHours: 0, replyInThread: true },
      { subject: 'Two v2', body: 'b2', delayDays: 2, delayHours: 0, replyInThread: true },
    ]);

    expect(detail.steps.map((s) => [s.id, s.subject])).toEqual([
      [steps[0]?.id, 'One v2'],
      [steps[1]?.id, 'Two v2'],
    ]);
    expect(await db.select().from(reachCampaignSteps).where(eq(reachCampaignSteps.campaignId, campaign.id))).toHaveLength(2);
    expect(actions()).toEqual(['updated']);
  });

  it('refuses to change the steps of a running campaign', async () => {
    const { campaign } = await seedCampaign(db, { campaign: { status: 'active' } });
    expect(
      await refused(replaceCampaignSteps(d(), campaign.id, [{ subject: 'S', body: 'b', delayDays: 0, delayHours: 0, replyInThread: true }])),
    ).toMatchObject({ code: 'CAMPAIGN_ACTIVE', status: 409 });
  });

  it('sets the mailboxes (deduplicated) and refuses ones that do not exist', async () => {
    const { campaign } = await seedCampaign(db, { campaign: { status: 'draft' } });
    const mailbox = await seedMailbox(db);

    const detail = await setCampaignMailboxes(d(), campaign.id, [mailbox.id, mailbox.id]);
    expect(detail.mailboxIds).toEqual([mailbox.id]);

    expect(await refused(setCampaignMailboxes(d(), campaign.id, [mailbox.id, 'rmbx_ghost']))).toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Some mailboxes do not exist',
      details: { unknown: ['rmbx_ghost'] },
    });
    expect((await setCampaignMailboxes(d(), campaign.id, [])).mailboxIds).toEqual([]);
  });
});

describe('enrollCampaignProspects', () => {
  it('queues eligible prospects and reports the rest by reason, without waking the sweep for a draft', async () => {
    const { campaign } = await seedCampaign(db, { campaign: { status: 'draft' } });
    const good = await seedProspect(db);
    const consumer = await seedProspect(db, { email: 'someone@gmail.com' });

    const report = await enrollCampaignProspects(enrollDeps(), campaign.id, { prospectIds: [good.id, consumer.id] });

    expect(report).toEqual({ added: 1, skipped: [{ reason: 'consumer', count: 1 }] });
    expect(due).toEqual([]);
    expect((await getCampaignDetail(db, campaign.id)).stats.prospects).toBe(1);
    expect(actions()).toEqual(['updated']);

    // The workspace limit decides about consumer addresses.
    const again = await enrollCampaignProspects(enrollDeps(true), campaign.id, { prospectIds: [consumer.id] });
    expect(again.added).toBe(1);
  });

  it('starts the prospects of a running campaign and wakes the sweep', async () => {
    const { campaign } = await seedCampaign(db, { campaign: { status: 'active' } });
    const prospect = await seedProspect(db);
    const before = Date.now();

    await enrollCampaignProspects(enrollDeps(), campaign.id, { prospectIds: [prospect.id] });

    const [row] = await db.select().from(reachEnrollments).where(eq(reachEnrollments.prospectId, prospect.id));
    expect(row?.status).toBe('active');
    expect(due).toHaveLength(1);
    expect(due[0]?.kind).toBe('reach_send');
    // The sweep is never woken for the past.
    expect(due[0]?.at.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('refuses a finished campaign and a list that does not exist', async () => {
    const { campaign } = await seedCampaign(db, { campaign: { status: 'completed' } });
    expect(await refused(enrollCampaignProspects(enrollDeps(), campaign.id, { prospectIds: ['rpro_1'] }))).toMatchObject({
      code: 'CAMPAIGN_CLOSED',
      status: 409,
    });
    const open = (await seedCampaign(db, { campaign: { status: 'draft' } })).campaign;
    expect(await refused(enrollCampaignProspects(enrollDeps(), open.id, { listId: 'rpl_ghost' }))).toMatchObject({
      code: 'NOT_FOUND',
      message: "List with ID 'rpl_ghost' not found",
    });
  });
});

describe('enrollments', () => {
  it('lists a campaign enrollments with prospect and mailbox, and filters by status', async () => {
    const { campaign } = await seedCampaign(db, { campaign: { status: 'draft' } });
    const a = await seedProspect(db, { email: 'a@bigco.io' });
    const b = await seedProspect(db, { email: 'b@bigco.io' });
    await seedEnrollment(db, campaign.id, a.id, { status: 'queued', nextSendAt: null });
    await seedEnrollment(db, campaign.id, b.id, { status: 'paused', nextSendAt: null });

    const all = await listEnrollments(db, campaign.id);
    expect(all.totalCount).toBe(2);
    expect(all.data.map((e) => e.prospect.email).sort()).toEqual(['a@bigco.io', 'b@bigco.io']);
    expect((await listEnrollments(db, campaign.id, { status: 'paused' })).data.map((e) => e.prospect.email)).toEqual(['b@bigco.io']);
    expect(await refused(listEnrollments(db, campaign.id, { status: 'nope' }))).toMatchObject({ code: 'BAD_REQUEST' });
    expect(await refused(listEnrollments(db, 'rcmp_nope'))).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('removes one, recounts, and completes a running campaign that had no one else', async () => {
    const { campaign } = await seedCampaign(db, { campaign: { status: 'active' } });
    const prospect = await seedProspect(db);
    const enrollment = await seedEnrollment(db, campaign.id, prospect.id);

    await removeCampaignEnrollment(d(), campaign.id, enrollment.id);

    expect(actions()).toEqual(['updated', 'completed']);
    expect((await getCampaignDetail(db, campaign.id)).status).toBe('completed');
    expect(await refused(removeCampaignEnrollment(d(), campaign.id, enrollment.id))).toMatchObject({
      code: 'NOT_FOUND',
      message: `Enrollment with ID '${enrollment.id}' not found`,
    });
  });
});

describe('launch, pause and resume', () => {
  it('names what stops a campaign from launching', async () => {
    const { campaign } = await seedCampaign(db, { campaign: { status: 'draft' }, steps: [] });

    const err = await refused(launchCampaign(d(), campaign.id));

    expect(err).toMatchObject({ code: 'BAD_REQUEST', status: 400, message: 'This campaign cannot be launched yet' });
    expect(err.details).toEqual({ problems: ['no_steps', 'no_active_mailbox', 'no_sender_identity', 'no_prospects'] });
    expect(due).toEqual([]);
  });

  it('launches: starts the queued prospects, wakes the sweep and emits reach_campaign:launched', async () => {
    const { campaign, enrollment } = await launchable();

    const detail = await launchCampaign(d(), campaign.id);

    expect(detail).toMatchObject({ status: 'active', pausedReason: null });
    expect(detail.launchedAt).not.toBeNull();
    const [row] = await db.select().from(reachEnrollments).where(eq(reachEnrollments.id, enrollment.id));
    expect(row?.status).toBe('active');
    expect(due).toHaveLength(1);
    expect(actions()).toEqual(['launched']);

    expect(await refused(launchCampaign(d(), campaign.id))).toMatchObject({ code: 'CAMPAIGN_ACTIVE', status: 409 });
  });

  it('answers each wrong state with its own 409 code', async () => {
    const draft = (await seedCampaign(db, { campaign: { status: 'draft' } })).campaign;
    const paused = (await seedCampaign(db, { campaign: { status: 'paused' } })).campaign;
    const archived = (await seedCampaign(db, { campaign: { status: 'archived' } })).campaign;

    expect(await refused(launchCampaign(d(), paused.id))).toMatchObject({ code: 'CAMPAIGN_PAUSED' });
    expect(await refused(launchCampaign(d(), archived.id))).toMatchObject({ code: 'CAMPAIGN_CLOSED' });
    expect(await refused(pauseCampaign(d(), draft.id))).toMatchObject({ code: 'CAMPAIGN_NOT_ACTIVE', status: 409 });
    expect(await refused(resumeCampaign(d(), draft.id))).toMatchObject({ code: 'CAMPAIGN_NOT_PAUSED', status: 409 });
  });

  it('pauses a running campaign and resumes it, waking the sweep', async () => {
    const { campaign } = await seedCampaign(db, { campaign: { status: 'active' } });

    expect(await pauseCampaign(d(), campaign.id)).toMatchObject({ status: 'paused', pausedReason: 'manual' });
    expect(actions()).toEqual(['paused']);

    expect(await resumeCampaign(d(), campaign.id)).toMatchObject({ status: 'active', pausedReason: null });
    expect(actions()).toEqual(['paused', 'updated']);
    expect(due).toHaveLength(1);
  });
});

describe('previewCampaignStep', () => {
  it('renders a stored step for a sample prospect when nobody is enrolled', async () => {
    await seedSettings(db);
    const { campaign } = await seedCampaign(db, { campaign: { status: 'draft' } });

    const preview = await previewCampaignStep(db, campaign.id, {});

    expect(preview.subject).toBe('Hello Alex');
    expect(preview.body).toContain('Hi Alex, quick question about Example Inc.');
    expect(preview.body).toContain('Acme BV');
    expect(preview.missingVariables).toEqual([]);
  });

  it('previews unsaved text and refuses a missing step, an empty campaign and an unknown prospect', async () => {
    const { campaign } = await seedCampaign(db, { campaign: { status: 'draft' } });
    const empty = (await seedCampaign(db, { campaign: { status: 'draft' }, steps: [] })).campaign;

    expect((await previewCampaignStep(db, campaign.id, { subject: 'Hi {{firstName}}', body: 'Body' })).subject).toBe('Hi Alex');
    expect(await refused(previewCampaignStep(db, campaign.id, { stepId: 'rstp_ghost' }))).toMatchObject({
      code: 'NOT_FOUND',
      message: "Step with ID 'rstp_ghost' not found",
    });
    expect(await refused(previewCampaignStep(db, empty.id, {}))).toMatchObject({
      code: 'BAD_REQUEST',
      message: 'The campaign has no step to preview',
    });
    expect(await refused(previewCampaignStep(db, campaign.id, { prospectId: 'rpro_ghost' }))).toMatchObject({ code: 'NOT_FOUND' });
  });
});
