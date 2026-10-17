/**
 * WeldReach on the public API: campaigns, prospects, lists, suppressions and
 * the overview, against pglite.
 *
 * Every write runs the domain function reach-api runs, so these tests check
 * what the public API adds: the routes and their scopes, the envelope of
 * successes and refusals, the entity events (with the workspace and actor of
 * the API key), the send sweep being woken for the Clerk org id, and the
 * limits and the kill switch reaching the domain from the access row.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { reachEnrollments, reachProspects } from '@weldsuite/db/schema';
import { resetReach, seedCampaign, seedEnrollment, seedMailbox, seedProspect, seedSettings } from '@weldsuite/reach-domain/testing/reach';
import { createPgliteDb } from './pglite';
import type { Database } from '../db';
import { approvedAccess, ORG_ID, reachTestApp, WORKSPACE_ID } from './reach-support';
import { stubDns } from './reach-dns-stub';

let db: Database;
let restoreDns: () => void;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  restoreDns = stubDns();
}, 60_000);

afterAll(() => restoreDns());

beforeEach(async () => {
  await resetReach(db);
});

interface Data<T> {
  data: T;
}
interface Paged<T> {
  data: T[];
  pagination: { totalCount: number; hasMore: boolean; cursor: string | null };
}
interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}
interface Campaign {
  id: string;
  name: string;
  status: string;
  ownerId: string | null;
  launchedAt: string | null;
  pausedReason: string | null;
  stats: Record<string, number>;
  steps: Array<{ id: string; order: number; subject: string }>;
  mailboxIds: string[];
}
interface Prospect {
  id: string;
  email: string;
  firstName: string | null;
  validation: string;
  source: string;
}

const STEPS = [
  { delayDays: 0, delayHours: 0, subject: 'Quick question, {{firstName|there}}', body: 'Hi {{firstName|there}}, do you still plan routes by hand?', replyInThread: false },
  { delayDays: 3, delayHours: 0, subject: 'Re: Quick question', body: 'Bumping this up.', replyInThread: true },
];

describe('campaigns', () => {
  it('creates a campaign, sets steps and mailboxes, enrols prospects and launches it', async () => {
    await seedSettings(db);
    const mailbox = await seedMailbox(db);
    const app = reachTestApp({ db });

    const created = await app.send<Data<Campaign>>('POST', '/v1/reach/campaigns', { name: 'Q4 logistics', timezone: 'Europe/Amsterdam', dailyLimit: 80 });
    expect(created.status).toBe(201);
    const campaign = created.body.data;
    expect(campaign).toMatchObject({ name: 'Q4 logistics', status: 'draft', steps: [], mailboxIds: [], ownerId: 'user_reach_test', launchedAt: null });
    expect(app.eventsOf('reach_campaign', 'created')).toHaveLength(1);

    const steps = await app.send<Data<Campaign>>('PUT', `/v1/reach/campaigns/${campaign.id}/steps`, { steps: STEPS });
    expect(steps.status).toBe(200);
    expect(steps.body.data.steps.map((s) => [s.order, s.subject])).toEqual([
      [0, 'Quick question, {{firstName|there}}'],
      [1, 'Re: Quick question'],
    ]);

    const mailboxes = await app.send<Data<Campaign>>('PUT', `/v1/reach/campaigns/${campaign.id}/mailboxes`, { mailboxIds: [mailbox.id] });
    expect(mailboxes.body.data.mailboxIds).toEqual([mailbox.id]);

    const jane = await app.send<Data<Prospect>>('POST', '/v1/reach/prospects', { email: 'jane@bigco.io', firstName: 'Jane' });
    const joe = await app.send<Data<Prospect>>('POST', '/v1/reach/prospects', { email: 'joe@bigco.io' });
    const enrolled = await app.send<Data<{ added: number; skipped: unknown[] }>>('POST', `/v1/reach/campaigns/${campaign.id}/prospects`, {
      prospectIds: [jane.body.data.id, joe.body.data.id],
    });
    expect(enrolled.status).toBe(200);
    expect(enrolled.body.data).toEqual({ added: 2, skipped: [] });
    // A draft campaign has nothing to send yet: the sweep is not woken.
    expect(await app.dueRow()).toBeNull();

    const launched = await app.send<Data<Campaign>>('POST', `/v1/reach/campaigns/${campaign.id}/launch`);
    expect(launched.status).toBe(200);
    expect(launched.body.data).toMatchObject({ status: 'active', stats: { prospects: 2 } });
    expect(launched.body.data.launchedAt).not.toBeNull();

    // The send sweep is woken for the workspace's Clerk org id (not the master workspace id).
    const due = await app.dueRow();
    expect(due?.workspaceId).toBe(ORG_ID);
    // The next send window: tomorrow morning at the latest, or Monday when the test runs over
    // a weekend, so the bound is a week rather than a day.
    expect(due?.nextDueAt).toBeLessThan(Date.now() + 7 * 24 * 3_600_000);

    // The events carry the workspace and the actor of the key.
    const launchEvents = app.eventsOf('reach_campaign', 'launched');
    expect(launchEvents).toHaveLength(1);
    expect(launchEvents[0]).toMatchObject({
      entityId: campaign.id,
      metadata: { workspaceId: WORKSPACE_ID, userId: 'user_reach_test', source: 'api' },
    });

    const enrollments = await app.get<Paged<{ status: string; prospect: { email: string } }>>(`/v1/reach/campaigns/${campaign.id}/enrollments`);
    expect(enrollments.body.data.map((e) => [e.prospect.email, e.status]).sort()).toEqual([
      ['jane@bigco.io', 'active'],
      ['joe@bigco.io', 'active'],
    ]);
    expect(enrollments.body.pagination).toEqual({ totalCount: 2, hasMore: false, cursor: null });

    const stats = await app.get<Data<Array<{ order: number; sent: number }>>>(`/v1/reach/campaigns/${campaign.id}/stats`);
    expect(stats.status).toBe(200);
    expect(stats.body.data.map((s) => s.order)).toEqual([0, 1]);
  });

  it('refuses to launch what is not ready, with the problems', async () => {
    const app = reachTestApp({ db });
    const created = await app.send<Data<Campaign>>('POST', '/v1/reach/campaigns', { name: 'Empty' });
    const res = await app.send<ErrorBody>('POST', `/v1/reach/campaigns/${created.body.data.id}/launch`);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: {
        code: 'BAD_REQUEST',
        message: 'This campaign cannot be launched yet',
        details: { problems: ['no_steps', 'no_active_mailbox', 'no_sender_identity', 'no_prospects'] },
      },
    });
    expect(await app.dueRow()).toBeNull();
    expect(app.eventsOf('reach_campaign', 'launched')).toHaveLength(0);
  });

  it('pauses, resumes (waking the sweep again) and refuses states that do not fit', async () => {
    const mailbox = await seedMailbox(db);
    await seedSettings(db);
    const { campaign } = await seedCampaign(db, { campaign: { status: 'draft' }, mailboxIds: [mailbox.id] });
    const prospect = await seedProspect(db);
    await seedEnrollment(db, campaign.id, prospect.id, { status: 'queued', nextSendAt: null });
    const app = reachTestApp({ db });
    const base = `/v1/reach/campaigns/${campaign.id}`;

    expect((await app.send('POST', `${base}/launch`)).status).toBe(200);
    expect((await app.send<ErrorBody>('POST', `${base}/launch`)).body.error.code).toBe('CAMPAIGN_ACTIVE');

    const paused = await app.send<Data<Campaign>>('POST', `${base}/pause`);
    expect(paused.body.data).toMatchObject({ status: 'paused', pausedReason: 'manual' });
    const again = await app.send<ErrorBody>('POST', `${base}/pause`);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('CAMPAIGN_NOT_ACTIVE');
    expect((await app.send<ErrorBody>('POST', `${base}/launch`)).body.error.code).toBe('CAMPAIGN_PAUSED');

    // A fresh index: resuming must mark the workspace due again.
    const resumeApp = reachTestApp({ db });
    expect(await resumeApp.dueRow()).toBeNull();
    const resumed = await resumeApp.send<Data<Campaign>>('POST', `${base}/resume`);
    expect(resumed.body.data).toMatchObject({ status: 'active', pausedReason: null });
    expect((await resumeApp.dueRow())?.workspaceId).toBe(ORG_ID);
    expect((await resumeApp.send<ErrorBody>('POST', `${base}/resume`)).body.error.code).toBe('CAMPAIGN_NOT_PAUSED');
    expect(app.eventsOf('reach_campaign', 'paused')).toHaveLength(1);
  });

  it('wakes the sweep when prospects are enrolled into a running campaign', async () => {
    const mailbox = await seedMailbox(db);
    const { campaign } = await seedCampaign(db, { campaign: { status: 'active' }, mailboxIds: [mailbox.id] });
    const prospect = await seedProspect(db);
    const app = reachTestApp({ db });

    const res = await app.send<Data<{ added: number }>>('POST', `/v1/reach/campaigns/${campaign.id}/prospects`, { prospectIds: [prospect.id] });
    expect(res.body.data.added).toBe(1);
    expect((await app.dueRow())?.workspaceId).toBe(ORG_ID);
  });

  it('lists, filters, pages, patches and deletes (a running campaign has to be paused first)', async () => {
    const app = reachTestApp({ db });
    const ids: string[] = [];
    for (const name of ['Alpha', 'Beta', 'Gamma']) {
      ids.push((await app.send<Data<Campaign>>('POST', '/v1/reach/campaigns', { name })).body.data.id);
    }

    const first = await app.get<Paged<Campaign>>('/v1/reach/campaigns?limit=2');
    expect(first.body.data).toHaveLength(2);
    expect(first.body.pagination).toMatchObject({ totalCount: 3, hasMore: true });
    const second = await app.get<Paged<Campaign>>(`/v1/reach/campaigns?limit=2&cursor=${first.body.pagination.cursor}`);
    expect(second.body.data).toHaveLength(1);
    expect(second.body.pagination).toMatchObject({ hasMore: false, cursor: null });
    expect([...first.body.data, ...second.body.data].map((c) => c.id).sort()).toEqual([...ids].sort());

    expect((await app.get<Paged<Campaign>>('/v1/reach/campaigns?search=bet')).body.data.map((c) => c.name)).toEqual(['Beta']);
    expect((await app.get<Paged<Campaign>>('/v1/reach/campaigns?status=active')).body.data).toEqual([]);
    const bad = await app.get<ErrorBody>('/v1/reach/campaigns?status=bogus');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('BAD_REQUEST');

    const patched = await app.send<Data<Campaign>>('PATCH', `/v1/reach/campaigns/${ids[0]}`, { name: 'Alpha 2', dailyLimit: 10 });
    expect(patched.body.data).toMatchObject({ name: 'Alpha 2' });
    expect(app.eventsOf('reach_campaign', 'updated').length).toBeGreaterThan(0);

    const deleted = await app.request(`/v1/reach/campaigns/${ids[1]}`, { method: 'DELETE' });
    expect(deleted.status).toBe(204);
    expect(await deleted.text()).toBe('');
    expect((await app.get<ErrorBody>(`/v1/reach/campaigns/${ids[1]}`)).status).toBe(404);
    expect(app.eventsOf('reach_campaign', 'deleted')).toHaveLength(1);

    const mailbox = await seedMailbox(db);
    await seedSettings(db);
    const { campaign: running } = await seedCampaign(db, { campaign: { status: 'active' }, mailboxIds: [mailbox.id] });
    const blocked = await app.send<ErrorBody>('DELETE', `/v1/reach/campaigns/${running.id}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('CAMPAIGN_ACTIVE');
  });

  it('removes an enrollment and answers 404 for unknown campaigns and enrollments', async () => {
    const { campaign } = await seedCampaign(db, { campaign: { status: 'paused' } });
    const prospect = await seedProspect(db);
    const enrollment = await seedEnrollment(db, campaign.id, prospect.id, { status: 'queued', nextSendAt: null });
    const app = reachTestApp({ db });

    const removed = await app.request(`/v1/reach/campaigns/${campaign.id}/enrollments/${enrollment.id}`, { method: 'DELETE' });
    expect(removed.status).toBe(204);
    const [row] = await db.select().from(reachEnrollments).where(eq(reachEnrollments.id, enrollment.id));
    expect(row).toBeUndefined();

    expect((await app.send<ErrorBody>('DELETE', `/v1/reach/campaigns/${campaign.id}/enrollments/renr_nope`)).body.error.code).toBe('NOT_FOUND');
    expect((await app.get<ErrorBody>('/v1/reach/campaigns/rcmp_nope')).body.error).toMatchObject({ code: 'NOT_FOUND' });
    expect((await app.get<ErrorBody>('/v1/reach/campaigns/rcmp_nope/stats')).status).toBe(404);
    expect((await app.send<ErrorBody>('POST', '/v1/reach/campaigns/rcmp_nope/prospects', { prospectIds: ['rpro_x'] })).status).toBe(404);
  });

  it('answers a request that fails validation with the documented envelope', async () => {
    const app = reachTestApp({ db });

    const missingName = await app.send<ErrorBody>('POST', '/v1/reach/campaigns', {});
    expect(missingName.status).toBe(400);
    expect(missingName.body.error).toMatchObject({ code: 'BAD_REQUEST', message: 'Validation failed' });
    expect(missingName.body.error.details).toEqual(expect.arrayContaining([expect.objectContaining({ path: ['name'] })]));

    const badWindow = await app.send<ErrorBody>('POST', '/v1/reach/campaigns', { name: 'X', windowStart: '17:00', windowEnd: '09:00' });
    expect(badWindow.status).toBe(400);
    expect(badWindow.body.error.code).toBe('BAD_REQUEST');

    const { campaign } = await seedCampaign(db, { campaign: { status: 'draft' }, steps: [] });
    const tooMany = await app.send<ErrorBody>('PUT', `/v1/reach/campaigns/${campaign.id}/steps`, { steps: Array.from({ length: 11 }, () => STEPS[0]) });
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.error.message).toBe('Validation failed');

    const malformed = await app.request('/v1/reach/campaigns', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{ nope' });
    expect(malformed.status).toBe(400);
    expect(((await malformed.json()) as ErrorBody).error.code).toBe('BAD_REQUEST');
  });
});

describe('prospects', () => {
  it('creates, reads, patches, lists and deletes a prospect, publishing the events', async () => {
    const app = reachTestApp({ db });

    const created = await app.send<Data<Prospect>>('POST', '/v1/reach/prospects', { email: 'Jane@BigCo.io', firstName: 'Jane', companyName: 'BigCo', customFields: { plan: 'pro' } });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ email: 'jane@bigco.io', firstName: 'Jane', validation: 'valid', source: 'manual' });
    const id = created.body.data.id;
    expect(app.eventsOf('reach_prospect', 'created')).toHaveLength(1);

    const duplicate = await app.send<ErrorBody>('POST', '/v1/reach/prospects', { email: 'jane@bigco.io' });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('CONFLICT');

    expect((await app.get<Data<Prospect>>(`/v1/reach/prospects/${id}`)).body.data.email).toBe('jane@bigco.io');

    const patched = await app.send<Data<Prospect>>('PATCH', `/v1/reach/prospects/${id}`, { firstName: 'Janet', title: 'CTO' });
    expect(patched.body.data).toMatchObject({ firstName: 'Janet', title: 'CTO' });
    expect(app.eventsOf('reach_prospect', 'updated')).toHaveLength(1);

    const found = await app.get<Paged<Prospect>>('/v1/reach/prospects?search=janet');
    expect(found.body.data.map((p) => p.id)).toEqual([id]);
    expect((await app.get<Paged<Prospect>>('/v1/reach/prospects?validation=no_mx')).body.data).toEqual([]);

    const deleted = await app.request(`/v1/reach/prospects/${id}`, { method: 'DELETE' });
    expect(deleted.status).toBe(204);
    expect(app.eventsOf('reach_prospect', 'deleted')).toHaveLength(1);
    expect((await app.get<ErrorBody>(`/v1/reach/prospects/${id}`)).status).toBe(404);
    expect((await app.get<Paged<Prospect>>('/v1/reach/prospects')).body.data).toEqual([]);
  });

  it('gives every prospect a verdict: no MX, role address and consumer address', async () => {
    const app = reachTestApp({ db });
    const verdict = async (email: string) => (await app.send<Data<Prospect>>('POST', '/v1/reach/prospects', { email })).body.data.validation;

    expect(await verdict('lead@nomx.example')).toBe('no_mx');
    expect(await verdict('info@bigco.io')).toBe('role');
    expect(await verdict('someone@gmail.com')).toBe('consumer');
  });

  it("applies the workspace's limits: a workspace staff allowed to email consumers can", async () => {
    const app = reachTestApp({ db, access: approvedAccess({ limits: { allowConsumerRecipients: true } }) });
    const res = await app.send<Data<Prospect>>('POST', '/v1/reach/prospects', { email: 'someone@gmail.com' });
    expect(res.body.data.validation).toBe('valid');
  });

  it('refuses an invalid address and an unknown list', async () => {
    const app = reachTestApp({ db });
    expect((await app.send<ErrorBody>('POST', '/v1/reach/prospects', { email: 'not-an-email' })).status).toBe(400);
    const unknownList = await app.send<ErrorBody>('POST', '/v1/reach/prospects', { email: 'a@bigco.io', listId: 'rpl_nope' });
    expect(unknownList.status).toBe(404);
    expect(unknownList.body.error.code).toBe('NOT_FOUND');
  });

  it('pages through prospects with the cursor', async () => {
    for (let i = 0; i < 3; i += 1) await seedProspect(db, { email: `lead${i}@bigco.io` });
    const app = reachTestApp({ db });

    const first = await app.get<Paged<Prospect>>('/v1/reach/prospects?limit=2');
    expect(first.body.pagination).toMatchObject({ totalCount: 3, hasMore: true });
    const second = await app.get<Paged<Prospect>>(`/v1/reach/prospects?limit=2&cursor=${first.body.pagination.cursor}`);
    expect(second.body.data).toHaveLength(1);
    expect(second.body.pagination.hasMore).toBe(false);
  });

  it('imports a JSON array onto a new list, reports what it skipped and updates existing addresses', async () => {
    const app = reachTestApp({ db });
    const rows = [
      { email: 'a@bigco.io', firstName: 'A' },
      { email: 'b@bigco.io' },
      { email: 'A@bigco.io' },
      { email: 'info@bigco.io' },
      { email: 'nobody@nomx.example' },
      { email: '' },
    ];

    const first = await app.send<Data<{ listId: string; created: number; updated: number; skipped: Array<{ reason: string; count: number }> }>>(
      'POST',
      '/v1/reach/prospects/import',
      { rows, listName: 'Q4 import', sourceRef: 'crm-export-2026-10' },
    );
    expect(first.status).toBe(200);
    const report = first.body.data;
    expect(report).toMatchObject({ created: 4, updated: 0 });
    expect(report.skipped).toEqual(expect.arrayContaining([
      { reason: 'duplicate', count: 1 },
      { reason: 'invalid_row', count: 1 },
      { reason: 'role', count: 1 },
      { reason: 'no_mx', count: 1 },
    ]));
    expect(app.eventsOf('reach_prospect', 'created')).toHaveLength(4);

    const list = await app.get<Data<{ prospectCount: number; name: string; source: string; sourceRef: string }>>(`/v1/reach/lists/${report.listId}`);
    expect(list.body.data).toMatchObject({ name: 'Q4 import', prospectCount: 4, source: 'csv', sourceRef: 'crm-export-2026-10' });

    const second = await app.send<Data<{ created: number; updated: number }>>('POST', '/v1/reach/prospects/import', { rows: [{ email: 'a@bigco.io', title: 'CEO' }, { email: 'c@bigco.io' }], listId: report.listId });
    expect(second.body.data).toMatchObject({ created: 1, updated: 1 });
    const [updated] = await db.select().from(reachProspects).where(eq(reachProspects.email, 'a@bigco.io'));
    expect(updated).toMatchObject({ firstName: 'A', title: 'CEO' });
  });

  it('refuses an import of more than 5,000 rows, an empty one and an unknown list', async () => {
    const app = reachTestApp({ db });

    const rows = Array.from({ length: 5001 }, (_, i) => ({ email: `lead${i}@bigco.io` }));
    const tooMany = await app.send<ErrorBody>('POST', '/v1/reach/prospects/import', { rows });
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.error).toMatchObject({ code: 'BAD_REQUEST', message: 'Validation failed' });
    expect(await db.select().from(reachProspects)).toHaveLength(0);

    expect((await app.send<ErrorBody>('POST', '/v1/reach/prospects/import', { rows: [] })).status).toBe(400);
    const unknownList = await app.send<ErrorBody>('POST', '/v1/reach/prospects/import', { rows: [{ email: 'a@bigco.io' }], listId: 'rpl_nope' });
    expect(unknownList.status).toBe(404);
  });

  it('does not expose the CRM and WeldData imports', async () => {
    const app = reachTestApp({ db });
    for (const path of ['/v1/reach/prospects/import-crm-list', '/v1/reach/prospects/import-welddata']) {
      const res = await app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ listId: 'x' }) });
      expect(res.status, path).toBe(404);
    }
  });
});

describe('lists', () => {
  it('creates a list, adds and removes members, renames it and deletes it', async () => {
    const jane = await seedProspect(db, { email: 'jane@bigco.io' });
    const joe = await seedProspect(db, { email: 'joe@bigco.io' });
    const app = reachTestApp({ db });

    const created = await app.send<Data<{ id: string; name: string; prospectCount: number; source: string }>>('POST', '/v1/reach/lists', { name: 'Logistics', description: 'Q4' });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ name: 'Logistics', prospectCount: 0, source: 'manual' });
    const id = created.body.data.id;

    const added = await app.send<Data<{ added: number }>>('POST', `/v1/reach/lists/${id}/members`, { prospectIds: [jane.id, joe.id] });
    expect(added.body.data).toEqual({ added: 2 });
    expect((await app.get<Data<{ prospectCount: number }>>(`/v1/reach/lists/${id}`)).body.data.prospectCount).toBe(2);
    expect((await app.get<Paged<Prospect>>(`/v1/reach/prospects?listId=${id}`)).body.data.map((p) => p.email).sort()).toEqual(['jane@bigco.io', 'joe@bigco.io']);

    const removed = await app.send<Data<{ removed: number }>>('POST', `/v1/reach/lists/${id}/members/remove`, { prospectIds: [jane.id] });
    expect(removed.body.data).toEqual({ removed: 1 });
    expect((await app.get<Data<{ prospectCount: number }>>(`/v1/reach/lists/${id}`)).body.data.prospectCount).toBe(1);

    const renamed = await app.send<Data<{ name: string }>>('PATCH', `/v1/reach/lists/${id}`, { name: 'Logistics NL' });
    expect(renamed.body.data.name).toBe('Logistics NL');
    expect((await app.get<Paged<{ id: string }>>('/v1/reach/lists')).body.data.map((l) => l.id)).toEqual([id]);

    const deleted = await app.request(`/v1/reach/lists/${id}`, { method: 'DELETE' });
    expect(deleted.status).toBe(204);
    expect((await app.get<ErrorBody>(`/v1/reach/lists/${id}`)).status).toBe(404);
    // Deleting a list leaves its prospects alone.
    expect((await app.get<Data<Prospect>>(`/v1/reach/prospects/${jane.id}`)).status).toBe(200);
  });

  it('answers 404 for an unknown list and 400 for an empty member array', async () => {
    const app = reachTestApp({ db });
    expect((await app.send<ErrorBody>('PATCH', '/v1/reach/lists/rpl_nope', { name: 'x' })).status).toBe(404);
    expect((await app.send<ErrorBody>('POST', '/v1/reach/lists/rpl_nope/members', { prospectIds: ['rpro_x'] })).status).toBe(404);
    expect((await app.send<ErrorBody>('POST', '/v1/reach/lists/rpl_nope/members', { prospectIds: [] })).status).toBe(400);
  });
});

describe('suppressions', () => {
  it('adds, lists and removes entries, and an entry keeps a prospect out of campaigns', async () => {
    const { campaign } = await seedCampaign(db, { campaign: { status: 'paused' } });
    const jane = await seedProspect(db, { email: 'jane@acme.nl' });
    const app = reachTestApp({ db });

    const added = await app.send<Data<{ added: number; skipped: number }>>('POST', '/v1/reach/suppressions', { values: ['Jane@Acme.nl', 'blocked.example', 'not valid', 'jane@acme.nl'] });
    expect(added.status).toBe(201);
    expect(added.body.data).toEqual({ added: 2, skipped: 2 });

    const listed = await app.get<Paged<{ id: string; value: string; type: string; reason: string; createdBy: string }>>('/v1/reach/suppressions');
    expect(listed.body.data.map((s) => [s.value, s.type, s.reason, s.createdBy]).sort()).toEqual([
      ['blocked.example', 'domain', 'manual', 'user_reach_test'],
      ['jane@acme.nl', 'email', 'manual', 'user_reach_test'],
    ]);

    const enrol = await app.send<Data<{ added: number; skipped: Array<{ reason: string; count: number }> }>>('POST', `/v1/reach/campaigns/${campaign.id}/prospects`, { prospectIds: [jane.id] });
    expect(enrol.body.data.added).toBe(0);
    expect(enrol.body.data.skipped).toEqual(expect.arrayContaining([{ reason: 'suppressed', count: 1 }]));

    const entry = listed.body.data.find((s) => s.value === 'jane@acme.nl')!;
    const removed = await app.request(`/v1/reach/suppressions/${entry.id}`, { method: 'DELETE' });
    expect(removed.status).toBe(204);
    expect((await app.send<ErrorBody>('DELETE', `/v1/reach/suppressions/${entry.id}`)).status).toBe(404);
    expect((await app.get<Paged<unknown>>('/v1/reach/suppressions')).body.pagination.totalCount).toBe(1);
  });

  it('stops the enrollments of a suppressed prospect and completes a campaign left with nothing to send', async () => {
    const mailbox = await seedMailbox(db);
    const { campaign } = await seedCampaign(db, { campaign: { status: 'active' }, mailboxIds: [mailbox.id] });
    const prospect = await seedProspect(db, { email: 'jane@acme.nl' });
    const enrollment = await seedEnrollment(db, campaign.id, prospect.id);
    const app = reachTestApp({ db });

    await app.send('POST', '/v1/reach/suppressions', { values: ['jane@acme.nl'] });

    const [row] = await db.select().from(reachEnrollments).where(eq(reachEnrollments.id, enrollment.id));
    expect(row?.status).not.toBe('active');
    const completed = app.eventsOf('reach_campaign', 'completed');
    expect(completed.map((e) => e.entityId)).toEqual([campaign.id]);
    expect(app.eventsOf('reach_suppression')).toHaveLength(0);
  });

  it('refuses an empty list of values', async () => {
    const app = reachTestApp({ db });
    expect((await app.send<ErrorBody>('POST', '/v1/reach/suppressions', { values: [] })).status).toBe(400);
  });
});

describe('overview and access', () => {
  it('answers the dashboard numbers', async () => {
    const mailbox = await seedMailbox(db);
    await seedCampaign(db, { campaign: { status: 'active' }, mailboxIds: [mailbox.id] });
    const app = reachTestApp({ db });

    const res = await app.get<Data<Record<string, unknown>>>('/v1/reach/overview');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      sentToday: 0,
      sent7d: 0,
      replies7d: 0,
      activeCampaigns: 1,
      unreadReplies: 0,
      mailboxes: { active: 1, warming: 0 },
    });
    expect(res.body.data.daily).toHaveLength(14);
  });

  it("answers the staff-set limits, today's usage and the state of the global switch", async () => {
    await seedMailbox(db);
    const on = reachTestApp({ db, access: approvedAccess({ limits: { maxDailySends: 123, allowConsumerRecipients: true } }) });
    const open = await on.get<Data<{ status: string; limits: Record<string, unknown>; usage: Record<string, number>; sendingEnabled: boolean }>>('/v1/reach/access');
    expect(open.status).toBe(200);
    expect(open.body.data).toMatchObject({
      status: 'approved',
      limits: { maxDailySends: 123, allowConsumerRecipients: true, maxDomains: 3, maxMailboxes: 10 },
      usage: { domains: 0, mailboxes: 1, sendsToday: 0 },
      sendingEnabled: true,
    });

    const off = reachTestApp({ db, sendingEnabled: false });
    expect((await off.get<Data<{ sendingEnabled: boolean }>>('/v1/reach/access')).body.data.sendingEnabled).toBe(false);
  });

  it('treats the kill switch as on when Flagship is not bound', async () => {
    const app = reachTestApp({ db, env: { FLAGSHIP: undefined } });
    expect((await app.get<Data<{ sendingEnabled: boolean }>>('/v1/reach/access')).body.data.sendingEnabled).toBe(true);
  });
});
