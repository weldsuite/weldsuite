/**
 * WeldSocial's posts through the public API on pglite (tenant and master):
 * the NOT NULL fields a create fills in, the server-owned keys it drops, the
 * list filters, and the publishing routes up to PostPeer: an unknown post, a
 * workspace without an organization, a deployment without PostPeer, a
 * schedule that fails validation, and cancelling and deleting a draft (which
 * has no upstream delivery to stop). The PostPeer calls themselves are in
 * social-publish.test.ts with the service mocked.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createMasterPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { conformanceMasterDb } from '@weldsuite/worker-kit/testing/conformance';
import * as masterSchema from '@weldsuite/db/schema/master';
import { createExternalTestApp } from './harness';
import { createPgliteDb } from './pglite';
import type { ApiKeySession } from '../types';
import type { Database } from '../db';

const master = vi.hoisted(() => ({ db: undefined as unknown }));

// `resolveClerkOrgId` and the publishing service read the master database.
vi.mock('../lib/master-db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/master-db')>()),
  createMasterDb: () => conformanceMasterDb(master.db),
}));

const JSON_HEADERS = { 'Content-Type': 'application/json' };

let tenantDb: Database;
let masterDb: Database;

const session = (workspaceId: string): ApiKeySession =>
  ({
    keyId: 'key_social_posts',
    keyType: 'personal',
    workspaceId,
    userId: 'user_social_posts',
    scopes: ['social_posts:read', 'social_posts:write'],
    tier: 'enterprise',
    databaseUrl: null,
    licensedApps: null,
  }) as ApiKeySession;

const api = (workspaceId = 'ws_social_posts') =>
  createExternalTestApp({ session: session(workspaceId), tenantDb, masterDb }).request;
const body = (method: string, value: unknown): RequestInit => ({ method, headers: JSON_HEADERS, body: JSON.stringify(value) });

async function data<T = Record<string, unknown>>(res: Response): Promise<T> {
  return ((await res.json()) as { data: T }).data;
}

beforeAll(async () => {
  tenantDb = (await createPgliteDb()).db;
  masterDb = (await createMasterPgliteDb()).db as Database;
  master.db = masterDb;
  const m = masterDb as unknown as import('drizzle-orm/pglite').PgliteDatabase<typeof masterSchema>;
  await m
    .insert(masterSchema.workspaces)
    .values([
      { id: 'ws_social_posts', name: 'Social posts', slug: 'social-posts-ext', clerkOrgId: 'org_social_posts' },
      { id: 'ws_social_no_org', name: 'No org', slug: 'social-no-org-ext' },
    ] as (typeof masterSchema.workspaces.$inferInsert)[])
    .onConflictDoNothing();
}, 120_000);

describe('/v1/social-posts', () => {
  it('creates with the NOT NULL fields filled in, filters, updates and deletes a draft', async () => {
    const request = api();
    const res = await request(
      '/v1/social-posts',
      body('POST', { accountIds: ['sacc_1'], campaignId: 'scmp_ext', createdByUserId: 'someone_else' }),
    );
    expect(res.status, await res.clone().text()).toBe(201);
    const post = await data<{ id: string; content: string; targetAccountIds: string[]; createdByUserId: string; status: string }>(res);
    expect(post).toMatchObject({ content: '', targetAccountIds: ['sacc_1'], createdByUserId: 'user_social_posts' });

    const listed = await data<{ id: string }[]>(await request(`/v1/social-posts?campaignId=scmp_ext&status=${post.status}`));
    expect(listed.map((p) => p.id)).toEqual([post.id]);
    expect((await request(`/v1/social-posts/${post.id}`)).status).toBe(200);
    const patched = await request(`/v1/social-posts/${post.id}`, body('PATCH', { content: 'Hello', id: 'socp_hijack' }));
    expect(patched.status, await patched.clone().text()).toBe(200);
    expect(await data(patched)).toMatchObject({ id: post.id, content: 'Hello' });
    expect((await request('/v1/social-posts/socp_missing', body('PATCH', { content: 'x' }))).status).toBe(404);

    // A draft has no PostPeer delivery to stop.
    expect((await request(`/v1/social-posts/${post.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await request(`/v1/social-posts/${post.id}`)).status).toBe(404);
    expect((await request(`/v1/social-posts/${post.id}`, { method: 'DELETE' })).status).toBe(404);
  });

  it('answers the publishing routes up to PostPeer', async () => {
    const request = api();
    const post = await data<{ id: string }>(await request('/v1/social-posts', body('POST', { content: 'Launch' })));

    expect((await request('/v1/social-posts/socp_missing/publish', { method: 'POST' })).status).toBe(404);
    expect((await request('/v1/social-posts/socp_missing/cancel', { method: 'POST' })).status).toBe(404);

    // Without POSTPEER_API_KEY there is no publishing.
    const publish = await request(`/v1/social-posts/${post.id}/publish`, { method: 'POST' });
    expect(publish.status).toBe(503);
    expect(await publish.json()).toEqual({
      error: { code: 'SOCIAL_PUBLISHING_NOT_CONFIGURED', message: 'Social publishing is not configured' },
    });
    expect((await request(`/v1/social-posts/${post.id}/schedule`, body('POST', { scheduledAt: 'tomorrow' }))).status).toBe(400);
    expect(
      (await request(`/v1/social-posts/${post.id}/schedule`, body('POST', { scheduledAt: '2030-01-01T09:30:00+02:00' }))).status,
    ).toBe(503);

    // A draft cancels to a draft.
    const cancelled = await request(`/v1/social-posts/${post.id}/cancel`, { method: 'POST' });
    expect(cancelled.status, await cancelled.clone().text()).toBe(200);
    expect(await data(cancelled)).toEqual({ id: post.id, status: 'cancelled' });

    // A workspace without an organization cannot reach PostPeer at all.
    const orphan = api('ws_social_no_org');
    const refused = await orphan(`/v1/social-posts/${post.id}/publish`, { method: 'POST' });
    expect(refused.status).toBe(500);
    expect(await refused.json()).toMatchObject({ error: { message: 'Workspace is not linked to an organization' } });
    expect((await orphan(`/v1/social-posts/${post.id}`, { method: 'DELETE' })).status).toBe(500);
    expect((await orphan(`/v1/social-posts/${post.id}/cancel`, { method: 'POST' })).status).toBe(500);
  });
});
