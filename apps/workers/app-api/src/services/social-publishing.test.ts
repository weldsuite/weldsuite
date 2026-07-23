/**
 * pglite integration tests for the social publishing double-post guards:
 *  - reschedule/publish cancels a pre-existing PostPeer scheduled post first
 *  - publishPost is idempotent (rejects already-published / mid-publish)
 *  - cancelPost cancels the live PostPeer post so it can't still fire
 *
 * The PostPeer API is exercised through a stubbed global `fetch`.
 */

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb, isPgliteAvailable } from '../test/pglite';
import { schema, type Database } from '../db';
import type { Env } from '../types';
import { publishPost, cancelPost, SocialPublishConflictError } from './social-publishing';

let db: Database;
let available = false;

beforeAll(async () => {
  available = await isPgliteAvailable();
  if (available) db = (await createPgliteDb()).db;
}, 60_000);

afterEach(() => vi.restoreAllMocks());

const kv = { put: vi.fn(async () => {}), get: vi.fn(async () => null) };
const env = { POSTPEER_API_KEY: 'k', WORKSPACE_CACHE: kv } as unknown as Env;

/** Stub fetch; record (method, path) and return canned PostPeer responses. */
function stubPostPeer(): Array<{ method: string; path: string }> {
  const calls: Array<{ method: string; path: string }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { method: string }) => {
      const path = new URL(String(url)).pathname;
      calls.push({ method: init.method, path });
      const body =
        init.method === 'POST' && path.endsWith('/posts')
          ? {
              postId: 'new_pp',
              status: 'scheduled',
              platforms: [
                { platform: 'twitter', accountId: 'intg_1', success: true, platformPostUrl: 'https://x/1' },
              ],
            }
          : {};
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    }),
  );
  return calls;
}

async function seedAccount() {
  await db
    .insert(schema.socialAccounts)
    .values({
      id: 'sac_1',
      platform: 'twitter',
      platformAccountId: 'pa1',
      name: 'X acct',
      postpeerIntegrationId: 'intg_1',
      status: 'active',
      connectedByUserId: 'u1',
      createdAt: new Date(),
      updatedAt: new Date(),
    } as typeof schema.socialAccounts.$inferInsert)
    .onConflictDoNothing();
}

async function seedPost(id: string, status: string, postpeerPostId: string | null) {
  await db.insert(schema.socialPosts).values({
    id,
    content: 'hello world',
    postType: 'post',
    status: status as never,
    targetAccountIds: ['sac_1'],
    postpeerPostId,
    timezone: 'UTC',
    createdByUserId: 'u1',
    createdAt: new Date(),
    updatedAt: new Date(),
  } as typeof schema.socialPosts.$inferInsert);
}

describe('social publishing · double-post guards', () => {
  it('reschedule cancels the previous PostPeer post before creating a new one', async () => {
    if (!available) return;
    await seedAccount();
    await seedPost('spo_resched', 'scheduled', 'old_pp');
    const calls = stubPostPeer();

    const res = await publishPost(db, env, 'org_1', 'spo_resched', {
      now: false,
      scheduledAt: '2030-01-01T00:00:00.000Z',
    });

    // Old scheduled post cancelled, then a new one created.
    expect(calls).toContainEqual({ method: 'DELETE', path: '/v1/posts/old_pp' });
    expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/posts'))).toBe(true);
    expect(res.postpeerPostId).toBe('new_pp');

    const [row] = await db
      .select()
      .from(schema.socialPosts)
      .where(eq(schema.socialPosts.id, 'spo_resched'));
    expect(row.postpeerPostId).toBe('new_pp');
    // scheduledAt is persisted atomically with the claim — it matches the
    // requested time, not whatever a concurrent request might have written.
    expect(row.scheduledAt?.toISOString()).toBe('2030-01-01T00:00:00.000Z');
  });

  it('publishPost is idempotent — rejects an already-published post', async () => {
    if (!available) return;
    await seedAccount();
    await seedPost('spo_published', 'published', 'pp_live');
    stubPostPeer();

    await expect(
      publishPost(db, env, 'org_1', 'spo_published', { now: true }),
    ).rejects.toBeInstanceOf(SocialPublishConflictError);
  });

  it('publishPost rejects a post that is mid-publish', async () => {
    if (!available) return;
    await seedAccount();
    await seedPost('spo_publishing', 'publishing', null);
    stubPostPeer();

    await expect(
      publishPost(db, env, 'org_1', 'spo_publishing', { now: true }),
    ).rejects.toBeInstanceOf(SocialPublishConflictError);
  });

  it('two concurrent publishes claim the slot atomically — only one submits', async () => {
    if (!available) return;
    await seedAccount();
    await seedPost('spo_race', 'draft', null);
    const calls = stubPostPeer();

    const [a, b] = await Promise.allSettled([
      publishPost(db, env, 'org_1', 'spo_race', { now: true }),
      publishPost(db, env, 'org_1', 'spo_race', { now: true }),
    ]);

    const fulfilled = [a, b].filter((r) => r.status === 'fulfilled');
    const rejected = [a, b].filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(SocialPublishConflictError);

    // Exactly one PostPeer create — no duplicate submission.
    const creates = calls.filter((c) => c.method === 'POST' && c.path.endsWith('/posts'));
    expect(creates).toHaveLength(1);
  });

  it('cancelPost cancels the live PostPeer post and marks the row cancelled', async () => {
    if (!available) return;
    await seedAccount();
    await seedPost('spo_cancel', 'scheduled', 'pp_cancel');
    const calls = stubPostPeer();

    const ok = await cancelPost(db, env, 'org_1', 'spo_cancel');
    expect(ok).toBe(true);
    expect(calls).toContainEqual({ method: 'DELETE', path: '/v1/posts/pp_cancel' });

    const [row] = await db
      .select()
      .from(schema.socialPosts)
      .where(eq(schema.socialPosts.id, 'spo_cancel'));
    expect(row.status).toBe('cancelled');
  });

  it('cancelPost refuses to cancel an already-published post', async () => {
    if (!available) return;
    await seedAccount();
    await seedPost('spo_pub_cancel', 'published', 'pp_pub');
    const calls = stubPostPeer();

    await expect(cancelPost(db, env, 'org_1', 'spo_pub_cancel')).rejects.toBeInstanceOf(
      SocialPublishConflictError,
    );
    // PostPeer is not touched, and the row stays published.
    expect(calls).toHaveLength(0);
    const [row] = await db
      .select()
      .from(schema.socialPosts)
      .where(eq(schema.socialPosts.id, 'spo_pub_cancel'));
    expect(row.status).toBe('published');
  });
});
