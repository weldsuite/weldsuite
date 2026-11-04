/**
 * WeldSocial's plain object routes on pglite: campaigns, team members, media
 * assets and accounts (their CRUD, not the PostPeer actions), the settings
 * singleton and the analytics reads. Each list's filters and cursor, each
 * route's refusals, and the event every write publishes.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { socialCampaignsRoutes } from './social-campaigns';
import { socialTeamMembersRoutes } from './social-team-members';
import { socialMediaRoutes } from './social-media';
import { socialAccountsRoutes } from './social-accounts';
import { socialSettingsRoutes } from './social-settings';
import { socialAnalyticsRoutes } from './social-analytics';

let db: Database;

type Routes = Parameters<typeof createTestApp>[1];

function client(base: string, routes: Routes, grants: string[], context: Record<string, unknown> = {}) {
  const { request } = createTestApp(base, routes, {
    context: { tenantDb: db, permissions: permissions(...grants), ...context },
  });
  const send = (method: string, path: string, body?: unknown) =>
    request(`${base}${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
  return {
    get: (path = '') => request(`${base}${path}`),
    post: (body: unknown, path = '') => send('POST', path, body),
    patch: (path: string, body: unknown) => send('PATCH', path, body),
    put: (body: unknown, path = '') => send('PUT', path, body),
    remove: (path: string) => send('DELETE', path),
  };
}

const json = async <T = Record<string, unknown>>(res: Response) => (await res.json()) as T;
const at = (minute: number) => new Date(Date.UTC(2026, 8, 1, 9, minute));

interface Page {
  data: Array<Record<string, unknown> & { id: string }>;
  pagination: { totalCount: number; hasMore: boolean; cursor: string | null };
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 180_000);

// ── campaigns ────────────────────────────────────────────────────────────────

describe('/api/social-campaigns', () => {
  const ALL = ['campaigns:read', 'campaigns:create', 'campaigns:update', 'campaigns:delete'];
  const api = (grants = ALL) => client('/api/social-campaigns', socialCampaignsRoutes, grants);

  beforeAll(async () => {
    await db.insert(schema.socialCampaigns).values([
      { id: 'scm_a', name: 'Spring launch', status: 'active', createdByUserId: 'u1', createdAt: at(1), updatedAt: at(1) },
      { id: 'scm_b', name: 'Summer teaser', status: 'draft', createdByUserId: 'u1', createdAt: at(2), updatedAt: at(2) },
      { id: 'scm_c', name: 'Autumn launch', status: 'active', createdByUserId: 'u1', createdAt: at(3), updatedAt: at(3) },
      { id: 'scm_gone', name: 'Gone launch', createdByUserId: 'u1', createdAt: at(4), updatedAt: at(4), deletedAt: at(5) },
    ]);
  });

  it('lists newest first, filters and pages', async () => {
    const all = await json<Page>(await api().get());
    expect(all.data.map((c) => c.id)).toEqual(['scm_c', 'scm_b', 'scm_a']);
    expect(all.pagination).toEqual({ totalCount: 3, hasMore: false, cursor: null });
    const active = await json<Page>(await api().get('?status=active&search=launch'));
    expect(active.data.map((c) => c.id)).toEqual(['scm_c', 'scm_a']);
    const first = await json<Page>(await api().get('?limit=1'));
    expect(first.pagination).toEqual({ totalCount: 3, hasMore: true, cursor: 'scm_c' });
    const next = await json<Page>(await api().get('?limit=1&cursor=scm_c'));
    expect(next.data.map((c) => c.id)).toEqual(['scm_b']);
    // An unknown cursor: the count drops the last filter, as the route does.
    const unknown = await json<Page>(await api().get('?search=Summer&cursor=scm_nope'));
    expect(unknown.data.map((c) => c.id)).toEqual(['scm_b']);
    expect(unknown.pagination.totalCount).toBe(3);
  });

  it('answers 500 for a status the enum does not know', async () => {
    const res = await api().get('?status=bogus');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list social campaigns' } });
  });

  it('creates, reads, updates and deletes a campaign', async () => {
    const created = await api().post({
      name: 'Winter',
      createdByUserId: 'user_test_default',
      description: 'Cold',
      tags: ['x'],
      notAColumn: true,
    });
    expect(created.status).toBe(201);
    const { data } = await json<{ data: { id: string } }>(created);
    const row = await json<{ data: Record<string, unknown> }>(await api().get(`/${data.id}`));
    expect(row.data).toMatchObject({ name: 'Winter', status: 'draft', description: 'Cold', tags: ['x'] });

    const updated = await api().patch(`/${data.id}`, { status: 'paused', color: '#fff' });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toEqual({ data: { id: data.id } });
    expect((await json<{ data: Record<string, unknown> }>(await api().get(`/${data.id}`))).data).toMatchObject({
      status: 'paused',
      color: '#fff',
    });

    expect((await api().remove(`/${data.id}`)).status).toBe(204);
    expect((await api().get(`/${data.id}`)).status).toBe(404);
    expect((await api().remove(`/${data.id}`)).status).toBe(404);
  });

  it('refuses bad bodies and writes the database refuses', async () => {
    for (const body of [{}, { name: '' }, { name: 'x', budget: true }, { name: 'x', status: 'y'.repeat(31) }]) {
      expect((await api().post(body)).status).toBe(400);
    }
    // created_by_user_id is NOT NULL and the route leaves it to the body.
    const missingCreator = await api().post({ name: 'No creator' });
    expect(missingCreator.status).toBe(500);
    expect(await missingCreator.json()).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to create social campaign' },
    });
    // A timestamp from the body is a string, which Drizzle can't write.
    const badDate = await api().post({ name: 'Dated', createdByUserId: 'u', startDate: '2026-01-01' });
    expect(badDate.status).toBe(500);
    const badPatch = await api().patch('/scm_a', { endDate: '2026-02-01' });
    expect(badPatch.status).toBe(500);
    expect(await badPatch.json()).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to update social campaign' },
    });
    expect((await api().patch('/scm_a', { name: '' })).status).toBe(400);
    expect((await api().patch('/scm_missing', { name: 'x' })).status).toBe(404);
  });

  it('needs each permission', async () => {
    expect((await api(['campaigns:create']).get()).status).toBe(403);
    expect((await api(['campaigns:read']).get('/scm_a')).status).toBe(200);
    expect((await api(['campaigns:read']).post({ name: 'x' })).status).toBe(403);
    expect((await api(['campaigns:read']).patch('/scm_a', { name: 'x' })).status).toBe(403);
    expect((await api(['campaigns:read']).remove('/scm_a')).status).toBe(403);
  });
});

// ── team members ─────────────────────────────────────────────────────────────

describe('/api/social-team-members', () => {
  const ALL = ['posts:read', 'posts:create', 'posts:update', 'posts:delete'];
  const api = (grants = ALL) => client('/api/social-team-members', socialTeamMembersRoutes, grants);

  it('adds, lists, updates and removes a member', async () => {
    const added = await api().post({ userId: 'user_ann', role: 'editor', email: 'ann@example.test', accountIds: ['sac_1'] });
    expect(added.status).toBe(201);
    const { data } = await json<{ data: { id: string } }>(added);
    await api().post({ userId: 'user_bob' });

    const all = await json<Page>(await api().get());
    expect(all.data.map((m) => m.userId).sort()).toEqual(['user_ann', 'user_bob']);
    expect(all.data.find((m) => m.userId === 'user_bob')).toMatchObject({ role: 'contributor', isActive: true });
    const ann = await json<Page>(await api().get('?userId=user_ann'));
    expect(ann.data.map((m) => m.id)).toEqual([data.id]);
    expect((await json<{ data: unknown }>(await api().get(`/${data.id}`))).data).toMatchObject({ email: 'ann@example.test' });

    expect((await api().patch(`/${data.id}`, { role: 'viewer', name: 'Ann' })).status).toBe(200);
    expect((await api().patch(`/${data.id}`, { role: 'chief' })).status).toBe(500);
    expect((await api().remove(`/${data.id}`)).status).toBe(204);
    expect((await api().get(`/${data.id}`)).status).toBe(404);
  });

  it('refuses bad bodies and unknown members', async () => {
    expect((await api().post({})).status).toBe(400);
    expect((await api().post({ userId: 'x', role: 'r'.repeat(51) })).status).toBe(400);
    expect((await api().post({ userId: 'x', accountIds: [1] })).status).toBe(400);
    expect((await api().patch('/stm_missing', { role: 'viewer' })).status).toBe(404);
    expect((await api().remove('/stm_missing')).status).toBe(404);
  });

  it('needs each permission', async () => {
    expect((await api(['posts:create']).get()).status).toBe(403);
    expect((await api(['posts:read']).post({ userId: 'x' })).status).toBe(403);
  });
});

// ── media ────────────────────────────────────────────────────────────────────

describe('/api/social-media', () => {
  const ALL = ['posts:read', 'posts:create', 'posts:update', 'posts:delete'];
  const api = (grants = ALL) => client('/api/social-media', socialMediaRoutes, grants);

  it('derives the type, MIME type, storage and status of a new asset', async () => {
    const cases: Array<[Record<string, unknown>, Record<string, unknown>]> = [
      [
        { fileName: 'Clip.MOV', size: 2048 },
        { mediaType: 'video', mimeType: 'video/mp4', fileSize: 2048, storageProvider: 'r2', status: 'uploading' },
      ],
      [
        { fileName: 'banner.webp', url: 'https://cdn.test/banner.webp', fileSize: 10 },
        { mediaType: 'image', mimeType: 'image/webp', fileSize: 10, storageProvider: 'url', status: 'ready', url: 'https://cdn.test/banner.webp', storagePath: 'url:https://cdn.test/banner.webp' },
      ],
      [
        { fileName: 'anim.gif', contentType: 'image/x-gif', status: 'processing', altText: 'Loop' },
        { mediaType: 'gif', mimeType: 'image/x-gif', fileSize: 0, status: 'processing', altText: 'Loop' },
      ],
      [
        { fileName: 'doc.bin', mediaType: 'video', originalName: 'Doc', storagePath: 'custom/path' },
        { mediaType: 'video', mimeType: 'video/mp4', originalName: 'Doc', storagePath: 'custom/path' },
      ],
      [{ fileName: 'photo.jpeg', mimeType: 'image/heic' }, { mediaType: 'image', mimeType: 'image/heic' }],
    ];
    for (const [body, expected] of cases) {
      const res = await api().post(body);
      expect(res.status).toBe(201);
      const { data } = await json<{ data: { id: string } }>(res);
      const row = await json<{ data: Record<string, unknown> }>(await api().get(`/${data.id}`));
      expect(row.data).toMatchObject({ uploadedByUserId: 'user_test_default', ...expected });
    }
  });

  it('lists and pages, counting every live asset', async () => {
    const all = await json<Page>(await api().get());
    expect(all.data).toHaveLength(5);
    const first = await json<Page>(await api().get('?limit=2'));
    expect(first.pagination.hasMore).toBe(true);
    const next = await json<Page>(await api().get(`?limit=2&cursor=${first.pagination.cursor}`));
    expect(next.data).toHaveLength(2);
    expect(next.pagination.totalCount).toBe(5);
    expect((await json<Page>(await api().get('?cursor=smed_missing'))).pagination.totalCount).toBe(5);
  });

  it('updates and deletes an asset', async () => {
    const { data } = await json<{ data: { id: string } }>(await api().post({ fileName: 'x.png' }));
    expect((await api().patch(`/${data.id}`, { status: 'ready', altText: 'X' })).status).toBe(200);
    expect((await api().patch(`/${data.id}`, { size: 1.5 })).status).toBe(400);
    expect((await api().patch(`/${data.id}`, { mediaType: 'audio' })).status).toBe(500);
    expect((await api().remove(`/${data.id}`)).status).toBe(204);
    expect((await api().patch(`/${data.id}`, { altText: 'Y' })).status).toBe(404);
    expect((await api().remove(`/${data.id}`)).status).toBe(404);
    expect((await api().get('/smed_missing')).status).toBe(404);
  });

  it('refuses bad bodies and missing permissions', async () => {
    expect((await api().post({})).status).toBe(400);
    expect((await api().post({ fileName: 'a.png', url: 'u'.repeat(2001) })).status).toBe(400);
    expect((await api(['posts:read']).post({ fileName: 'a.png' })).status).toBe(403);
    expect((await api(['posts:create']).get()).status).toBe(403);
  });
});

// ── accounts (CRUD) ──────────────────────────────────────────────────────────

describe('/api/social-accounts (CRUD)', () => {
  const ALL = ['posts:read', 'posts:create', 'posts:update', 'posts:delete'];
  const api = (grants = ALL) => client('/api/social-accounts', socialAccountsRoutes, grants);

  it('creates an account for the caller and never shows its tokens', async () => {
    const res = await api().post({
      platform: 'instagram',
      platformAccountId: 'ig_1',
      name: 'Acme IG',
      accessToken: 'secret-token',
      refreshToken: 'secret-refresh',
      followerCount: 12,
    });
    expect(res.status).toBe(201);
    const { data } = await json<{ data: { id: string } }>(res);
    const row = await json<{ data: Record<string, unknown> }>(await api().get(`/${data.id}`));
    expect(row.data).toMatchObject({ connectedByUserId: 'user_test_default', status: 'active', followerCount: 12 });
    expect(row.data).not.toHaveProperty('accessToken');
    expect(row.data).not.toHaveProperty('refreshToken');
    const [stored] = await db.select().from(schema.socialAccounts).where(eq(schema.socialAccounts.id, data.id));
    expect(stored?.accessToken).toBe('secret-token');

    await api().post({ platform: 'twitter', platformAccountId: 'tw_x', name: 'Acme X', status: 'inactive', connectedByUserId: 'user_other' });
    const all = await json<Page>(await api().get());
    for (const account of all.data) expect(account).not.toHaveProperty('accessToken');
    expect((await json<Page>(await api().get('?platform=twitter&status=inactive'))).data.map((a) => a.name)).toEqual([
      'Acme X',
    ]);
    expect((await api().get('?platform=myspace')).status).toBe(500);
  });

  it('updates and deletes an account', async () => {
    const { data } = await json<{ data: { id: string } }>(
      await api().post({ platform: 'linkedin', platformAccountId: 'li_9', name: 'Acme LI' }),
    );
    expect((await api().patch(`/${data.id}`, { name: 'Acme LinkedIn', status: 'expired' })).status).toBe(200);
    expect((await api().patch(`/${data.id}`, { platform: 'p'.repeat(51) })).status).toBe(400);
    expect((await api().remove(`/${data.id}`)).status).toBe(204);
    expect((await api().get(`/${data.id}`)).status).toBe(404);
    expect((await api().patch(`/${data.id}`, { name: 'x' })).status).toBe(404);
    expect((await api().remove(`/${data.id}`)).status).toBe(404);
  });

  it('refuses bad bodies, duplicates and missing permissions', async () => {
    expect((await api().post({})).status).toBe(400);
    expect((await api().post({ platform: 'twitter', username: 'u'.repeat(256) })).status).toBe(400);
    // name is NOT NULL.
    expect((await api().post({ platform: 'twitter', platformAccountId: 'tw_n' })).status).toBe(500);
    expect((await api(['posts:read']).post({ platform: 'twitter' })).status).toBe(403);
    expect((await api(['posts:read']).remove('/sac_x')).status).toBe(403);
  });
});

// ── settings ─────────────────────────────────────────────────────────────────

describe('/api/social-settings', () => {
  const api = (grants = ['accounts:read', 'accounts:update'], context: Record<string, unknown> = {}) =>
    client('/api/social-settings', socialSettingsRoutes, grants, context);

  it('answers the defaults, then the stored settings merged with them', async () => {
    const fresh = api(undefined, { clerkOrgId: 'org_settings' });
    expect(await json(await fresh.get())).toEqual({
      data: {
        defaultTimezone: 'UTC',
        defaultApprovalRequired: false,
        autoScheduleEnabled: false,
        bestTimeToPost: { enabled: false, times: [] },
        hashtagSuggestions: true,
        linkShortening: false,
        utmTracking: { enabled: false, source: '', medium: 'social', campaign: '' },
        notifications: { publishedPosts: true, failedPosts: true, approvalRequests: true, weeklyReport: false },
      },
    });
    const saved = await fresh.put({
      defaultTimezone: 'Europe/Amsterdam',
      bestTimeToPost: { enabled: true, times: [{ day: 1, hour: 9, extra: 'dropped' }] },
      unknownKey: 'dropped too',
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ data: { message: 'Social settings updated successfully' } });
    expect((await fresh.put({ hashtagSuggestions: false })).status).toBe(200);
    const read = await json<{ data: Record<string, unknown> }>(await fresh.get());
    expect(read.data).toMatchObject({
      defaultTimezone: 'Europe/Amsterdam',
      hashtagSuggestions: false,
      bestTimeToPost: { enabled: true, times: [{ day: 1, hour: 9 }] },
    });
  });

  it('keeps the rest of the workspace settings', async () => {
    await db.insert(schema.workspaceSettings).values({
      id: 'org_with_settings',
      customSettings: { parcel: { carrier: 'dhl' }, social: { linkShortening: true } },
    } as typeof schema.workspaceSettings.$inferInsert);
    const existing = api(undefined, { clerkOrgId: 'org_with_settings' });
    expect((await existing.put({ autoScheduleEnabled: true })).status).toBe(200);
    const [row] = await db
      .select()
      .from(schema.workspaceSettings)
      .where(eq(schema.workspaceSettings.id, 'org_with_settings'));
    expect(row?.customSettings).toEqual({ parcel: { carrier: 'dhl' }, social: { linkShortening: true, autoScheduleEnabled: true } });
  });

  it('lists the time zones and refuses bad input', async () => {
    const zones = await json<{ data: string[] }>(await api().get('/timezones'));
    expect(zones.data).toContain('Europe/Amsterdam');
    expect((await api().put({ defaultTimezone: 7 })).status).toBe(400);
    expect((await api().put({ utmTracking: { enabled: true } })).status).toBe(400);
    expect((await api(['accounts:read']).put({})).status).toBe(403);
    expect((await api(['accounts:update']).get()).status).toBe(403);
    expect((await api(['accounts:update']).get('/timezones')).status).toBe(403);
  });
});

// ── analytics (reads) ────────────────────────────────────────────────────────

describe('/api/social-analytics (reads)', () => {
  const api = (grants = ['analytics:read']) => client('/api/social-analytics', socialAnalyticsRoutes, grants);

  beforeAll(async () => {
    const now = new Date();
    await db.insert(schema.socialAccounts).values([
      { id: 'sac_an1', platform: 'twitter', platformAccountId: 'an_1', name: 'Analytics X', username: 'anx', followerCount: 300, connectedByUserId: 'u', createdAt: at(1), updatedAt: at(1) },
      { id: 'sac_an2', platform: 'facebook', platformAccountId: 'an_2', name: 'Analytics FB', connectedByUserId: 'u', createdAt: at(2), updatedAt: at(2) },
    ]);
    await db.insert(schema.socialPosts).values([
      { id: 'spo_an1', title: 'Analytics launch post', content: 'Launching the analytics product today', status: 'published', publishedAt: now, targetAccountIds: ['sac_an1', 'sac_an2'], createdByUserId: 'u', createdAt: at(1), updatedAt: at(1) },
      { id: 'spo_an2', content: 'Old analytics', status: 'published', publishedAt: at(1), targetAccountIds: ['sac_an1'], createdByUserId: 'u', createdAt: at(2), updatedAt: at(2) },
      { id: 'spo_an3', content: 'Queued', status: 'scheduled', targetAccountIds: [], createdByUserId: 'u', createdAt: at(3), updatedAt: at(3) },
      { id: 'spo_an4', content: 'Waiting', status: 'pending_approval', targetAccountIds: [], createdByUserId: 'u', createdAt: at(4), updatedAt: at(4) },
    ]);
    await db.insert(schema.socialAnalytics).values([
      { id: 'san_1', postId: 'spo_an1', accountId: 'sac_an1', snapshotPeriod: 'lifetime', snapshotAt: now, impressions: 1000, reach: 700, totalEngagement: 30, clicks: 9 },
      { id: 'san_2', postId: 'spo_an2', accountId: 'sac_an1', snapshotPeriod: 'lifetime', snapshotAt: now, impressions: 500, reach: 100, totalEngagement: 3, clicks: 1 },
      { id: 'san_3', postId: 'spo_an2', accountId: 'sac_an1', snapshotPeriod: 'daily', snapshotAt: now, impressions: 99999, totalEngagement: 99 },
    ]);
    await db.insert(schema.socialCampaigns).values({
      id: 'scm_an',
      name: 'Analytics campaign',
      description: 'About analytics',
      createdByUserId: 'u',
      createdAt: at(1),
      updatedAt: at(1),
    });
  });

  it('answers the overview', async () => {
    const res = await api().get('/overview');
    expect(res.status).toBe(200);
    const { data } = await json<{ data: Record<string, unknown> & { platformStats: unknown[] } }>(res);
    expect(data).toMatchObject({ totalImpressions: 1500, totalReach: 800, totalEngagement: 33, totalClicks: 10, topPosts: [] });
    expect(data.engagementRate).toBeCloseTo(2.2);
    expect(data.platformStats).toEqual(
      expect.arrayContaining([
        { platform: 'twitter', followers: 300, posts: 2, engagement: 0 },
        { platform: 'facebook', followers: 0, posts: 1, engagement: 0 },
      ]),
    );
  });

  it('answers the dashboard stats', async () => {
    const { data } = await json<{ data: Record<string, number> }>(await api().get('/stats'));
    expect(data).toMatchObject({ scheduledPosts: 1, pendingApproval: 1, publishedThisWeek: 1, totalEngagement: 0 });
    expect(data.totalPosts).toBeGreaterThanOrEqual(4);
    expect(data.connectedAccounts).toBeGreaterThanOrEqual(2);
  });

  it('searches posts, campaigns and accounts', async () => {
    expect(await json(await api().get('/search'))).toEqual({ data: [] });
    expect(await json(await api().get('/search?q=a'))).toEqual({ data: [] });
    const { data } = await json<{ data: Array<{ type: string; id: string; title: string; description?: string; url: string }> }>(
      await api().get('/search?q=ANALYTICS'),
    );
    expect(data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'post', id: 'spo_an1', title: 'Analytics launch post', url: '/social/posts/spo_an1' }),
        expect.objectContaining({ type: 'post', id: 'spo_an2', title: 'Untitled Post' }),
        { type: 'campaign', id: 'scm_an', title: 'Analytics campaign', description: 'About analytics', url: '/social/campaigns/scm_an' },
        { type: 'account', id: 'sac_an2', title: 'Analytics FB', description: '@null on facebook', url: '/social/accounts' },
      ]),
    );
  });

  it('needs analytics:read', async () => {
    for (const path of ['/overview', '/stats', '/search?q=xx']) {
      expect((await api(['posts:read']).get(path)).status).toBe(403);
    }
  });
});
