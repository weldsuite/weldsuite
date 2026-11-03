/**
 * WeldSocial's PostPeer routes on pglite: connecting and syncing accounts,
 * posts (CRUD, publish, schedule, reschedule, cancel, delete), approvals
 * (create, approve with auto-schedule, reject, patch, delete) and the
 * analytics sync. PostPeer is a fetch stub that answers by URL and body
 * (../test/postpeer-stub.ts); credits and the PostPeer post index live in a
 * master pglite, shared with the Rust server in conformance mode.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import * as masterSchema from '@weldsuite/db/schema/master';
import { conformanceMasterDb, createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { POSTPEER_ENV, createPostPeerFetchStub, postpeerCallsSince } from '../test/postpeer-stub';

const holder = vi.hoisted(() => ({ master: null as unknown }));
vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/worker-kit/db')>();
  return { ...actual, getMasterDb: () => conformanceMasterDb(holder.master) };
});

import { socialAccountsRoutes } from './social-accounts';
import { socialPostsRoutes } from './social-posts';
import { socialApprovalsRoutes } from './social-approvals';
import { socialAnalyticsRoutes } from './social-analytics';

const WORKSPACE_ID = 'ws_test_default';
const ORG_ID = 'org_test_default';
const WRITE = ['posts:read', 'posts:create', 'posts:update', 'posts:delete'];

let db: Database;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pglite drizzle stands in for neon-http
let master: any;
const postpeer = createPostPeerFetchStub();

type Routes = Parameters<typeof createTestApp>[1];

interface Options {
  grants?: string[];
  env?: Record<string, unknown>;
  context?: Record<string, unknown>;
}

function client(base: string, routes: Routes, { grants = WRITE, env = {}, context = {} }: Options = {}) {
  const { request } = createTestApp(base, routes, {
    context: { tenantDb: db, masterDb: master, permissions: permissions(...grants), ...context },
    env: { ...POSTPEER_ENV, ...env } as never,
  });
  const send = (method: string, path: string, body?: unknown) =>
    request(`${base}${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
  return {
    get: (path = '') => request(`${base}${path}`),
    post: (path: string, body?: unknown) => send('POST', path, body),
    patch: (path: string, body: unknown) => send('PATCH', path, body),
    remove: (path: string) => send('DELETE', path),
  };
}

const accountsApi = (options?: Options) => client('/api/social-accounts', socialAccountsRoutes, options);
const postsApi = (options?: Options) => client('/api/social-posts', socialPostsRoutes, options);
const approvalsApi = (options?: Options) => client('/api/social-approvals', socialApprovalsRoutes, options);
const analyticsApi = (options?: Options) => client('/api/social-analytics', socialAnalyticsRoutes, options);

const json = async <T = Record<string, unknown>>(res: Response) => (await res.json()) as T;

async function post(id: string) {
  const [row] = await db.select().from(schema.socialPosts).where(eq(schema.socialPosts.id, id));
  return row!;
}

async function balance(): Promise<number> {
  const [row] = await master
    .select()
    .from(masterSchema.workspaceCredits)
    .where(eq(masterSchema.workspaceCredits.workspaceId, WORKSPACE_ID));
  return (row as { currentBalance: number }).currentBalance;
}

async function setBalance(value: number) {
  await master
    .update(masterSchema.workspaceCredits)
    .set({ currentBalance: value })
    .where(eq(masterSchema.workspaceCredits.workspaceId, WORKSPACE_ID));
}

async function seedPost(id: string, values: Partial<typeof schema.socialPosts.$inferInsert> = {}) {
  const now = new Date();
  await db.insert(schema.socialPosts).values({
    id,
    content: id,
    targetAccountIds: ['sac_p_tw', 'sac_p_li'],
    createdByUserId: 'user_test_default',
    createdAt: now,
    updatedAt: now,
    ...values,
  });
}

beforeAll(async () => {
  vi.stubGlobal('fetch', postpeer);
  db = (await createPgliteDb()).db;
  master = (await createMasterPgliteDb()).db;
  holder.master = master;
  await master
    .insert(masterSchema.workspaces)
    .values({ id: WORKSPACE_ID, clerkOrgId: ORG_ID, name: 'Social', slug: 'social' } as typeof masterSchema.workspaces.$inferInsert);
  const now = new Date();
  await master.insert(masterSchema.workspaceCredits).values({
    id: 'wcr_social',
    workspaceId: WORKSPACE_ID,
    currentBalance: 100,
    periodStart: now,
    periodEnd: now,
  });
  await db.insert(schema.socialAccounts).values([
    { id: 'sac_p_tw', platform: 'twitter', platformAccountId: 'p_tw', name: 'Pub X', postpeerIntegrationId: 'int_tw', connectedByUserId: 'u', createdAt: now, updatedAt: now },
    { id: 'sac_p_li', platform: 'linkedin', platformAccountId: 'p_li', name: 'Pub LI', postpeerIntegrationId: 'int_li', connectedByUserId: 'u', createdAt: now, updatedAt: now },
    { id: 'sac_p_none', platform: 'facebook', platformAccountId: 'p_fb', name: 'Not via PostPeer', connectedByUserId: 'u', createdAt: now, updatedAt: now },
  ]);
  await db.insert(schema.socialMedia).values({
    id: 'smed_p1',
    fileName: 'a.mp4',
    mimeType: 'video/mp4',
    fileSize: 1,
    mediaType: 'video',
    storagePath: 'x',
    url: 'https://cdn.test/a.mp4',
    uploadedByUserId: 'u',
    createdAt: now,
    updatedAt: now,
  });
}, 180_000);

afterAll(() => {
  vi.unstubAllGlobals();
});

// ── accounts: connect and sync ───────────────────────────────────────────────

describe('/api/social-accounts connect and sync', () => {
  it('adopts the workspace’s PostPeer profile and answers the connect URL with the BYOK app', async () => {
    const from = postpeer.mock.calls.length;
    const res = await accountsApi().post('/connect', { platform: 'twitter', redirectUri: 'https://app.test/back' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: {
        url: 'https://connect.postpeer.test/twitter?profileId=pp_prof_default&redirectUri=https%3A%2F%2Fapp.test%2Fback&appId=app_tw',
        profileId: 'pp_prof_default',
        appId: 'app_tw',
      },
    });
    expect(postpeerCallsSince(postpeer, from)).toEqual([
      'GET /connect/twitter?profileId=pp_prof_default&redirectUri=https%3A%2F%2Fapp.test%2Fback&appId=app_tw',
      'GET /profiles',
    ]);
    const [settings] = await db.select().from(schema.workspaceSettings).where(eq(schema.workspaceSettings.id, ORG_ID));
    expect(settings?.customSettings).toEqual({ social: { postpeerProfileId: 'pp_prof_default' } });
  });

  it('reuses the stored profile; a malformed app id falls back to PostPeer’s app', async () => {
    const from = postpeer.mock.calls.length;
    const res = await accountsApi().post('/connect', { platform: 'linkedin' });
    expect(await res.json()).toEqual({
      data: { url: 'https://connect.postpeer.test/linkedin?profileId=pp_prof_default', profileId: 'pp_prof_default' },
    });
    expect(postpeerCallsSince(postpeer, from)).toEqual(['GET /connect/linkedin?profileId=pp_prof_default']);
  });

  it('creates a profile for a workspace PostPeer doesn’t know', async () => {
    const res = await accountsApi({ context: { clerkOrgId: 'org_fresh' } }).post('/connect', { platform: 'facebook' });
    expect(await json(res)).toEqual({
      data: { url: 'https://connect.postpeer.test/facebook?profileId=pp_prof_org_fresh', profileId: 'pp_prof_org_fresh' },
    });
  });

  it('answers the connect refusals', async () => {
    const failed = await accountsApi().post('/connect', { platform: 'tiktok' });
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Failed to start account connection' } });
    const unconfigured = await accountsApi({ env: { POSTPEER_API_KEY: undefined } }).post('/connect', { platform: 'twitter' });
    expect(unconfigured.status).toBe(400);
    expect(await unconfigured.json()).toEqual({ error: { code: 'BAD_REQUEST', message: 'Social publishing is not configured' } });
    expect((await accountsApi().post('/connect', { platform: 'myspace' })).status).toBe(400);
    expect((await accountsApi().post('/connect', { platform: 'twitter', redirectUri: 'not a url' })).status).toBe(400);
    expect((await accountsApi({ grants: ['posts:read'] }).post('/connect', { platform: 'twitter' })).status).toBe(403);
  });

  it('syncs the channels of every profile the workspace owns, and nobody else’s', async () => {
    const now = new Date();
    await db.insert(schema.socialAccounts).values({
      id: 'sac_old_tw',
      platform: 'twitter',
      platformAccountId: 'tw_1',
      name: 'Old name',
      postpeerIntegrationId: 'int_old',
      status: 'expired',
      connectedByUserId: 'u',
      createdAt: now,
      updatedAt: now,
      deletedAt: now,
    });
    const res = await accountsApi().post('/sync');
    expect(res.status).toBe(200);
    const { data } = await json<{ data: { synced: number; accountIds: string[] } }>(res);
    expect(data.synced).toBe(3);
    expect(data.accountIds.slice(0, 2)).toEqual(['sac_old_tw', 'sac_p_li']);
    const accounts = await db.select().from(schema.socialAccounts);
    expect(accounts.find((a) => a.id === 'sac_old_tw')).toMatchObject({
      name: 'Acme on X',
      username: 'acme',
      postpeerIntegrationId: 'int_tw_new',
      status: 'active',
      deletedAt: null,
    });
    expect(accounts.find((a) => a.id === 'sac_p_li')).toMatchObject({
      platform: 'linkedin',
      name: 'acme-li',
      avatarUrl: 'https://cdn.test/li.png',
      connectedByUserId: 'u',
    });
    expect(accounts.find((a) => a.postpeerIntegrationId === 'int_x2')).toMatchObject({
      platform: 'twitter',
      name: 'Second X',
      connectedByUserId: 'user_test_default',
    });
    expect(accounts.some((a) => ['int_foreign', 'int_orphan', 'int_yt'].includes(a.postpeerIntegrationId ?? ''))).toBe(false);
  });

  it('answers the sync refusals', async () => {
    const unconfigured = await accountsApi({ env: { POSTPEER_API_KEY: undefined } }).post('/sync');
    expect(unconfigured.status).toBe(400);
    expect((await accountsApi({ grants: ['posts:read'] }).post('/sync')).status).toBe(403);
  });
});

// ── posts ────────────────────────────────────────────────────────────────────

describe('/api/social-posts CRUD', () => {
  it('creates drafts with server-owned defaults', async () => {
    const res = await postsApi().post('', { title: 'Hello', accountIds: ['sac_p_tw'], campaignId: 'scm_1' });
    expect(res.status).toBe(201);
    const { data } = await json<{ data: { id: string } }>(res);
    expect(await post(data.id)).toMatchObject({
      content: '',
      targetAccountIds: ['sac_p_tw'],
      createdByUserId: 'user_test_default',
      status: 'draft',
      postType: 'post',
      campaignId: 'scm_1',
    });

    const queued = await postsApi().post('', {
      content: 'For approval',
      status: 'pending_approval',
      scheduledAt: '2030-01-02T03:04:05+01:00',
      createdByUserId: 'user_other',
      hashtagSettings: { hashtags: ['a'], position: 'end' },
    });
    const { data: queuedData } = await json<{ data: { id: string } }>(queued);
    const row = await post(queuedData.id);
    expect(row).toMatchObject({ createdByUserId: 'user_other', hashtagSettings: { hashtags: ['a'], position: 'end' } });
    expect(row.scheduledAt).toEqual(new Date('2030-01-02T02:04:05Z'));
    expect(row.approvalRequestedAt).toBeInstanceOf(Date);
  });

  it('lists, filters, reads and updates posts', async () => {
    await seedPost('spo_c1', { status: 'draft', campaignId: 'scm_list', createdAt: new Date('2026-01-01T00:00:00Z') });
    await seedPost('spo_c2', { status: 'failed', campaignId: 'scm_list', createdAt: new Date('2026-01-02T00:00:00Z') });
    const list = await json<{ data: Array<{ id: string }>; pagination: { totalCount: number } }>(
      await postsApi().get('?campaignId=scm_list'),
    );
    expect(list.data.map((p) => p.id)).toEqual(['spo_c2', 'spo_c1']);
    const failed = await json<{ data: Array<{ id: string }> }>(await postsApi().get('?status=failed&campaignId=scm_list'));
    expect(failed.data.map((p) => p.id)).toEqual(['spo_c2']);
    expect((await postsApi().get('?status=unknown')).status).toBe(500);
    const paged = await json<{ data: unknown[]; pagination: { cursor: string | null } }>(await postsApi().get('?limit=1&campaignId=scm_list'));
    expect(paged.pagination.cursor).toBe('spo_c2');
    expect((await postsApi().get('?cursor=spo_c2&campaignId=scm_list')).status).toBe(200);
    expect((await json<{ data: { id: string } }>(await postsApi().get('/spo_c1'))).data.id).toBe('spo_c1');
    expect((await postsApi().get('/spo_missing')).status).toBe(404);

    expect((await postsApi().patch('/spo_c1', { title: 'Renamed', status: 'approved', labels: ['l'] })).status).toBe(200);
    expect(await post('spo_c1')).toMatchObject({ title: 'Renamed', status: 'approved', labels: ['l'] });
    expect((await postsApi().patch('/spo_missing', { title: 'x' })).status).toBe(404);
  });

  it('refuses bad bodies, dates Drizzle can’t write, and missing permissions', async () => {
    expect((await postsApi().post('', { postType: 'video' })).status).toBe(400);
    expect((await postsApi().post('', { targetAccountIds: 'sac_p_tw' })).status).toBe(400);
    expect((await postsApi().post('', { scheduledAt: 'not a date' })).status).toBe(500);
    expect((await postsApi().post('', { publishedAt: '2030-01-01T00:00:00Z' })).status).toBe(500);
    const badPatch = await postsApi().patch('/spo_c1', { scheduledAt: '2030-01-01T00:00:00Z' });
    expect(badPatch.status).toBe(500);
    expect(await badPatch.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Failed to update social post' } });
    expect((await postsApi({ grants: ['posts:read'] }).post('', {})).status).toBe(403);
    expect((await postsApi({ grants: ['posts:create'] }).get()).status).toBe(403);
  });
});

describe('/api/social-posts publishing', () => {
  it('publishes now, charging per platform and refunding the platforms that failed', async () => {
    await seedPost('spo_now', { content: 'Hello world [fail-second]', mediaIds: ['smed_p1', 'smed_missing'] });
    const before = await balance();
    const from = postpeer.mock.calls.length;
    const res = await postsApi().post('/spo_now/publish');
    expect(res.status).toBe(200);
    const { data } = await json<{ data: Record<string, unknown> & { platformContent: Array<Record<string, unknown>> } }>(res);
    expect(data).toMatchObject({ postId: 'spo_now', postpeerPostId: 'pp_post_hello_world_fail_second_', status: 'published' });
    expect(data.platformContent).toEqual([
      expect.objectContaining({ platform: 'twitter', accountId: 'sac_p_tw', status: 'published', publishedUrl: 'https://social.test/int_tw/0' }),
      { platform: 'linkedin', accountId: 'sac_p_li', status: 'failed', error: 'Token expired' },
    ]);
    expect(postpeerCallsSince(postpeer, from)).toEqual(['POST /posts']);
    expect(await post('spo_now')).toMatchObject({ status: 'published', lastPublishError: 'Token expired', creditsConsumed: 2, publishAttempts: 1 });
    expect(await balance()).toBe(before - 2);
    const [indexed] = await master
      .select()
      .from(masterSchema.postpeerPostIndex)
      .where(eq(masterSchema.postpeerPostIndex.socialPostId, 'spo_now'));
    expect(indexed).toMatchObject({ clerkOrgId: ORG_ID, postpeerPostId: 'pp_post_hello_world_fail_second_' });

    const again = await postsApi().post('/spo_now/publish');
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({
      error: { code: 'CONFLICT', message: 'Post is already being published or has been published' },
    });
  });

  it('marks a post failed when every platform fails, and refunds it all', async () => {
    await seedPost('spo_allfail', { content: 'Nope [fail-all]' });
    const before = await balance();
    const res = await postsApi().post('/spo_allfail/publish');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { status: string } }).data.status).toBe('failed');
    expect(await balance()).toBe(before);
  });

  it('refunds and marks the post failed when PostPeer refuses it', async () => {
    await seedPost('spo_reject', { content: 'Bad media [reject]' });
    const before = await balance();
    const res = await postsApi().post('/spo_reject/publish');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Invalid media type' } });
    expect(await post('spo_reject')).toMatchObject({ status: 'failed', lastPublishError: 'Invalid media type' });
    expect(await balance()).toBe(before);
  });

  it('refuses a publish the wallet can’t cover, and releases the post', async () => {
    await seedPost('spo_poor', { status: 'approved' });
    await setBalance(3);
    const res = await postsApi().post('/spo_poor/publish');
    await setBalance(100);
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({
      error: {
        code: 'INSUFFICIENT_CREDITS',
        message: 'Insufficient credits. Top up your workspace balance to continue.',
        details: { currentBalance: 3, required: 4, shortfall: 1 },
      },
    });
    expect(await post('spo_poor')).toMatchObject({ status: 'approved', lastPublishError: 'insufficient_credits' });
  });

  it('answers the publish refusals', async () => {
    await seedPost('spo_notargets', { targetAccountIds: [] });
    await seedPost('spo_unconnected', { targetAccountIds: ['sac_p_none'] });
    const cases: Array<[string, number, string]> = [
      ['spo_missing', 500, 'Social post not found: spo_missing'],
      ['spo_notargets', 500, 'Post has no target accounts'],
      ['spo_unconnected', 500, 'No PostPeer-connected accounts among the post targets'],
    ];
    for (const [id, status, message] of cases) {
      const res = await postsApi().post(`/${id}/publish`);
      expect(res.status).toBe(status);
      expect(((await res.json()) as { error: { message: string } }).error.message).toBe(message);
    }
    const unconfigured = await postsApi({ env: { POSTPEER_API_KEY: undefined } }).post('/spo_notargets/publish');
    expect(unconfigured.status).toBe(400);
    expect((await postsApi({ grants: ['posts:read'] }).post('/spo_notargets/publish')).status).toBe(403);
  });

  it('schedules in UTC, then reschedules after cancelling the old schedule', async () => {
    await seedPost('spo_sched', { content: 'Later' });
    const scheduled = await postsApi().post('/spo_sched/schedule', {
      scheduledAt: '2030-06-01T16:00:00+02:00',
      timezone: 'Europe/Amsterdam',
    });
    expect(scheduled.status).toBe(200);
    const { data } = await json<{ data: { status: string; platformContent: Array<{ status: string }> } }>(scheduled);
    expect(data.status).toBe('scheduled');
    expect(data.platformContent.map((p) => p.status)).toEqual(['pending', 'pending']);
    const row = await post('spo_sched');
    expect(row).toMatchObject({ status: 'scheduled', timezone: 'Europe/Amsterdam', postpeerPostId: 'pp_post_later', creditsConsumed: 4 });
    expect(row.scheduledAt).toEqual(new Date('2030-06-01T14:00:00Z'));

    const from = postpeer.mock.calls.length;
    const moved = await postsApi().post('/spo_sched/reschedule', { scheduledAt: '2030-07-01T08:00:00Z' });
    expect(moved.status).toBe(200);
    expect(postpeerCallsSince(postpeer, from)).toEqual(['DELETE /posts/pp_post_later', 'POST /posts']);
    expect((await post('spo_sched')).scheduledAt).toEqual(new Date('2030-07-01T08:00:00Z'));
  });

  it('validates schedules', async () => {
    for (const body of [{}, { scheduledAt: '2030-06-01T16:00:00' }, { scheduledAt: '2030-06-01T16:00:00Z', timezone: 3 }]) {
      expect((await postsApi().post('/spo_sched/schedule', body)).status).toBe(400);
      expect((await postsApi().post('/spo_sched/reschedule', body)).status).toBe(400);
    }
    expect((await postsApi().post('/spo_missing/reschedule', { scheduledAt: '2030-06-01T16:00:00Z' })).status).toBe(500);
    expect(
      (await postsApi({ env: { POSTPEER_API_KEY: undefined } }).post('/spo_sched/schedule', { scheduledAt: '2030-06-01T16:00:00Z' }))
        .status,
    ).toBe(400);
  });

  it('cancels a schedule back to a draft and refunds it', async () => {
    const before = await balance();
    const res = await postsApi().post('/spo_sched/cancel');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { id: 'spo_sched', status: 'draft' } });
    expect(await post('spo_sched')).toMatchObject({ status: 'draft', scheduledAt: null, postpeerPostId: null, creditsConsumed: 0 });
    expect(await balance()).toBe(before + 4);
  });

  it('answers the cancel refusals', async () => {
    await seedPost('spo_stuck', { status: 'scheduled', postpeerPostId: 'pp_post_stuck' });
    await seedPost('spo_gone', { status: 'scheduled', postpeerPostId: 'pp_post_gone' });
    const stuck = await postsApi().post('/spo_stuck/cancel');
    expect(stuck.status).toBe(502);
    expect(await stuck.json()).toEqual({
      error: {
        code: 'UPSTREAM_ERROR',
        message: 'Failed to remove the scheduled post from PostPeer — it is still scheduled to publish. Please try again.',
      },
    });
    expect((await post('spo_stuck')).status).toBe('scheduled');
    expect((await postsApi().post('/spo_gone/cancel')).status).toBe(200);
    const live = await postsApi().post('/spo_now/cancel');
    expect(live.status).toBe(409);
    expect((await postsApi().post('/spo_missing/cancel')).status).toBe(404);
    const unconfigured = await postsApi({ env: { POSTPEER_API_KEY: undefined } }).post('/spo_stuck/cancel');
    expect(unconfigured.status).toBe(502);
    expect(((await unconfigured.json()) as { error: { message: string } }).error.message).toContain('PostPeer is not configured');
    expect((await postsApi({ grants: ['posts:read'] }).post('/spo_stuck/cancel')).status).toBe(403);
  });

  it('deletes a post after stopping its delivery', async () => {
    await seedPost('spo_del', { status: 'scheduled', postpeerPostId: 'pp_post_del' });
    expect((await postsApi().remove('/spo_del')).status).toBe(204);
    expect((await post('spo_del')).deletedAt).toBeInstanceOf(Date);
    // A published post can't be recalled; it is deleted all the same.
    expect((await postsApi().remove('/spo_now')).status).toBe(204);
    const stuck = await postsApi().remove('/spo_stuck');
    expect(stuck.status).toBe(502);
    expect((await post('spo_stuck')).deletedAt).toBeNull();
    expect((await postsApi().remove('/spo_now')).status).toBe(404);
    expect((await postsApi({ grants: ['posts:read'] }).remove('/spo_c1')).status).toBe(403);
  });
});

// ── approvals ────────────────────────────────────────────────────────────────

describe('/api/social-approvals', () => {
  it('submits a post for approval', async () => {
    await seedPost('spo_ap1', { content: 'Approve me', scheduledAt: new Date('2031-01-01T10:00:00Z') });
    const res = await approvalsApi().post('', { postId: 'spo_ap1', comment: 'Please', approverId: 'user_boss' });
    expect(res.status).toBe(201);
    const { data } = await json<{ data: { id: string; postId: string } }>(res);
    expect(data.postId).toBe('spo_ap1');
    const [approval] = await db.select().from(schema.socialApprovals).where(eq(schema.socialApprovals.id, data.id));
    expect(approval).toMatchObject({ status: 'pending', submissionNotes: 'Please', assignedToUserId: 'user_boss', version: 1 });
    expect(await post('spo_ap1')).toMatchObject({ status: 'pending_approval' });
  });

  it('refuses a submission without a live post', async () => {
    const missing = await approvalsApi().post('', { comment: 'x' });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: { code: 'BAD_REQUEST', message: 'postId is required' } });
    expect((await approvalsApi().post('', { postId: 'spo_missing' })).status).toBe(404);
    expect((await approvalsApi().post('', { postId: 'spo_ap1', status: 's'.repeat(31) })).status).toBe(400);
    expect((await approvalsApi({ grants: ['posts:read'] }).post('', { postId: 'spo_ap1' })).status).toBe(403);
  });

  it('approves and schedules a post that has a time', async () => {
    const [approval] = await db.select().from(schema.socialApprovals).where(eq(schema.socialApprovals.postId, 'spo_ap1'));
    const res = await approvalsApi().post(`/${approval!.id}/approve`, { decisionNotes: 'Ship it' });
    expect(res.status).toBe(200);
    const { data } = await json<{ data: Record<string, unknown> & { publishResult: { status: string } | null } }>(res);
    expect(data).toMatchObject({ approvalId: approval!.id, postId: 'spo_ap1', status: 'approved', scheduled: true, scheduleError: null });
    expect(data.publishResult?.status).toBe('scheduled');
    const [decided] = await db.select().from(schema.socialApprovals).where(eq(schema.socialApprovals.id, approval!.id));
    expect(decided).toMatchObject({ status: 'approved', decidedByUserId: 'user_test_default', decisionNotes: 'Ship it' });

    const again = await approvalsApi().post(`/${approval!.id}/approve`);
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: { code: 'CONFLICT', message: 'Approval is not pending' } });
  });

  it('approves without scheduling, or reports why scheduling failed', async () => {
    await seedPost('spo_ap2', { content: 'No time' });
    await seedPost('spo_ap3', { content: 'No targets', targetAccountIds: [], scheduledAt: new Date('2031-01-01T10:00:00Z') });
    const ids: string[] = [];
    for (const postId of ['spo_ap2', 'spo_ap3']) {
      const { data } = await json<{ data: { id: string } }>(await approvalsApi().post('', { postId }));
      ids.push(data.id);
    }
    // A body that is not JSON is read as no notes.
    const plain = await approvalsApi().post(`/${ids[0]}/approve`);
    expect((await json<{ data: unknown }>(plain)).data).toMatchObject({ scheduled: false, scheduleError: null, publishResult: null });
    const failed = await approvalsApi().post(`/${ids[1]}/approve`, { decisionNotes: 7 });
    expect((await json<{ data: unknown }>(failed)).data).toMatchObject({
      scheduled: false,
      scheduleError: 'Post has no target accounts',
      publishResult: null,
    });
    expect((await approvalsApi().post('/sap_missing/approve')).status).toBe(404);
  });

  it('rejects, or asks for a revision', async () => {
    await seedPost('spo_rj1', { content: 'Reject me' });
    await seedPost('spo_rj2', { content: 'Revise me' });
    const first = await json<{ data: { id: string } }>(await approvalsApi().post('', { postId: 'spo_rj1' }));
    const second = await json<{ data: { id: string } }>(await approvalsApi().post('', { postId: 'spo_rj2' }));

    const rejected = await approvalsApi().post(`/${first.data.id}/reject`, { rejectionReason: 'Off brand' });
    expect(await rejected.json()).toEqual({ data: { approvalId: first.data.id, postId: 'spo_rj1', status: 'rejected' } });
    expect(await post('spo_rj1')).toMatchObject({ status: 'draft', rejectionReason: 'Off brand', rejectedByUserId: 'user_test_default' });

    const revision = await approvalsApi().post(`/${second.data.id}/reject?revision=true`, { decisionNotes: 'Shorter' });
    expect(((await revision.json()) as { data: { status: string } }).data.status).toBe('revision_requested');
    expect(await post('spo_rj2')).toMatchObject({ status: 'draft', rejectionReason: 'Shorter', rejectedAt: null });

    expect((await approvalsApi().post(`/${first.data.id}/reject`, {})).status).toBe(409);
    expect((await approvalsApi().post('/sap_missing/reject', {})).status).toBe(404);
    expect((await approvalsApi().post(`/${first.data.id}/reject`, { decisionNotes: 1 })).status).toBe(400);
    expect((await approvalsApi({ grants: ['posts:read'] }).post(`/${first.data.id}/reject`, {})).status).toBe(403);
  });

  it('lists, reads, patches and deletes approvals', async () => {
    await seedPost('spo_ap4', { content: 'Patch me' });
    const { data } = await json<{ data: { id: string } }>(await approvalsApi().post('', { postId: 'spo_ap4' }));
    const list = await json<{ data: Array<{ id: string }>; pagination: { totalCount: number } }>(
      await approvalsApi().get('?postId=spo_ap4&status=pending'),
    );
    expect(list.data.map((a) => a.id)).toEqual([data.id]);
    expect((await approvalsApi().get('?limit=1')).status).toBe(200);
    expect((await approvalsApi().get(`?cursor=${data.id}`)).status).toBe(200);
    expect((await approvalsApi().get('?status=nope')).status).toBe(500);
    expect((await json<{ data: { id: string } }>(await approvalsApi().get(`/${data.id}`))).data.id).toBe(data.id);
    expect((await approvalsApi().get('/sap_missing')).status).toBe(404);

    const viaPatch = await approvalsApi().patch(`/${data.id}`, { status: 'approved' });
    expect(viaPatch.status).toBe(400);
    expect(((await viaPatch.json()) as { error: { message: string } }).error.message).toContain('/approve');
    expect((await approvalsApi().patch(`/${data.id}`, { status: 'revision_requested' })).status).toBe(400);
    expect((await approvalsApi().patch(`/${data.id}`, { priority: 'high', status: 'withdrawn' })).status).toBe(200);
    expect((await approvalsApi().patch('/sap_missing', { priority: 'low' })).status).toBe(404);

    expect((await approvalsApi().remove(`/${data.id}`)).status).toBe(204);
    expect((await approvalsApi().remove(`/${data.id}`)).status).toBe(404);
    expect((await approvalsApi({ grants: ['posts:read'] }).remove(`/${data.id}`)).status).toBe(403);
  });
});

// ── analytics sync ───────────────────────────────────────────────────────────

describe('POST /api/social-analytics/:postId/sync', () => {
  it('pulls the metrics PostPeer has for a post, per account it can attribute', async () => {
    await seedPost('spo_metrics', { postpeerPostId: 'pp_post_metrics', status: 'published' });
    const res = await analyticsApi().post('/spo_metrics/sync');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { snapshots: 2 } });
    const rows = await db
      .select()
      .from(schema.socialAnalytics)
      .where(and(eq(schema.socialAnalytics.postId, 'spo_metrics'), eq(schema.socialAnalytics.accountId, 'sac_p_tw')));
    expect(rows[0]).toMatchObject({ impressions: 1000, totalEngagement: 16, platformPostId: 'remote_1', videoViews: 5 });
    expect(rows[0]?.engagementRate).toBeCloseTo(1.6);
  });

  it('does nothing for a post that was never published', async () => {
    expect(await json(await analyticsApi().post('/spo_c1/sync'))).toEqual({ data: { snapshots: 0 } });
    expect(await json(await analyticsApi().post('/spo_missing/sync'))).toEqual({ data: { snapshots: 0 } });
  });

  it('answers the refusals', async () => {
    expect((await analyticsApi({ env: { POSTPEER_API_KEY: undefined } }).post('/spo_metrics/sync')).status).toBe(400);
    expect((await analyticsApi({ grants: ['posts:read', 'analytics:read'] }).post('/spo_metrics/sync')).status).toBe(403);
  });
});
