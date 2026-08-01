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
import {
  publishPost,
  syncAccounts,
  cancelPost,
  SocialPublishConflictError,
  type SocialPublishingContext,
} from '@weldsuite/social-publishing';

let db: Database;
let available = false;

beforeAll(async () => {
  available = await isPgliteAvailable();
  if (available) db = (await createPgliteDb()).db;
}, 60_000);

afterEach(() => vi.restoreAllMocks());

/**
 * Master DB stub. The service touches master for credit metering and to index
 * the PostPeer post id for the delivery webhook; neither is under test here, so
 * both are allowed to fail softly the way they do in a degraded environment.
 */
const masterDb = {
  select: () => {
    throw new Error('master DB not available in this test');
  },
  insert: () => ({
    values: () => ({ onConflictDoNothing: async () => undefined }),
  }),
};
const ctx = {
  POSTPEER_API_KEY: 'k',
  masterDb: () => masterDb,
} as unknown as SocialPublishingContext;

/** Stub fetch; record (method, path, body) and return canned PostPeer responses. */
function stubPostPeer(): Array<{ method: string; path: string; body?: unknown }> {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { method: string; body?: string }) => {
      const path = new URL(String(url)).pathname;
      calls.push({
        method: init.method,
        path,
        ...(init.body ? { body: JSON.parse(init.body) } : {}),
      });
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

    const res = await publishPost(db, ctx, 'org_1', 'spo_resched', {
      now: false,
      scheduledAt: '2030-01-01T00:00:00.000Z',
    });

    // Old scheduled post cancelled, then a new one created.
    expect(calls).toContainEqual({ method: 'DELETE', path: '/v1/posts/old_pp' });
    const created = calls.find((c) => c.method === 'POST' && c.path.endsWith('/posts'));
    expect(created).toBeDefined();
    expect(res.postpeerPostId).toBe('new_pp');

    // PostPeer's body schema is closed — the schedule must go out as
    // `scheduledFor` (naive UTC) + `timezone`, with no `scheduledAt` and no
    // `publishNow`, or the whole request 400s.
    expect(created!.body).toMatchObject({
      scheduledFor: '2030-01-01T00:00:00',
      timezone: 'UTC',
    });
    expect(created!.body).not.toHaveProperty('scheduledAt');
    expect(created!.body).not.toHaveProperty('publishNow');

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
      publishPost(db, ctx, 'org_1', 'spo_published', { now: true }),
    ).rejects.toBeInstanceOf(SocialPublishConflictError);
  });

  it('publishPost rejects a post that is mid-publish', async () => {
    if (!available) return;
    await seedAccount();
    await seedPost('spo_publishing', 'publishing', null);
    stubPostPeer();

    await expect(
      publishPost(db, ctx, 'org_1', 'spo_publishing', { now: true }),
    ).rejects.toBeInstanceOf(SocialPublishConflictError);
  });

  it('two concurrent publishes claim the slot atomically — only one submits', async () => {
    if (!available) return;
    await seedAccount();
    await seedPost('spo_race', 'draft', null);
    const calls = stubPostPeer();

    const [a, b] = await Promise.allSettled([
      publishPost(db, ctx, 'org_1', 'spo_race', { now: true }),
      publishPost(db, ctx, 'org_1', 'spo_race', { now: true }),
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

    const ok = await cancelPost(db, ctx, 'org_1', 'spo_cancel');
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

    await expect(cancelPost(db, ctx, 'org_1', 'spo_pub_cancel')).rejects.toBeInstanceOf(
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

describe('social publishing · account sync', () => {
  /**
   * Stub the three PostPeer calls syncAccounts makes, returning one integration
   * for an account that is already in the tenant DB under a DIFFERENT
   * integration id — what reconnecting a channel under a BYOK OAuth app does.
   */
  function stubSyncPostPeer(integrationId: string, platformUserId: string) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = new URL(String(url));
        const body = u.pathname.endsWith('/profiles')
          ? { profiles: [{ id: 'prof_1', name: 'org_1' }] }
          : u.pathname.endsWith('/connect/integrations')
            ? {
                integrations: [
                  {
                    id: integrationId,
                    platform: 'twitter',
                    platformUserId,
                    username: '@WeldSuite',
                    profileId: 'prof_1',
                  },
                ],
              }
            : {};
        return { ok: true, status: 200, text: async () => JSON.stringify(body) };
      }),
    );
  }

  /** Point the workspace at a known PostPeer profile so no profile is created. */
  async function seedProfileSetting(orgId: string) {
    await db
      .insert(schema.workspaceSettings)
      .values({
        id: orgId,
        customSettings: { social: { postpeerProfileId: 'prof_1' } },
        createdAt: new Date(),
        updatedAt: new Date(),
      } as unknown as typeof schema.workspaceSettings.$inferInsert)
      .onConflictDoNothing();
  }

  it('re-binds a reconnected channel instead of colliding on the unique index', async () => {
    if (!available) return;
    await seedProfileSetting('org_1');

    // Existing row from an earlier sync, under the OLD integration id.
    await db.insert(schema.socialAccounts).values({
      id: 'sac_rebind',
      platform: 'twitter',
      platformAccountId: '2069473473458528256',
      name: 'WeldSuite',
      postpeerIntegrationId: 'intg_old',
      postpeerProfileId: 'prof_1',
      status: 'active',
      connectedByUserId: 'u1',
      createdAt: new Date(),
      updatedAt: new Date(),
    } as typeof schema.socialAccounts.$inferInsert);

    // PostPeer now reports the SAME channel under a NEW integration id.
    stubSyncPostPeer('intg_new', '2069473473458528256');

    const res = await syncAccounts(db, ctx, 'org_1', 'u1');

    // Updated in place — not inserted, which is what used to blow up on
    // (platform, platform_account_id) and fail the whole sync with a 500.
    expect(res.accountIds).toEqual(['sac_rebind']);

    const rows = await db
      .select()
      .from(schema.socialAccounts)
      .where(eq(schema.socialAccounts.platformAccountId, '2069473473458528256'));
    expect(rows).toHaveLength(1);
    // Re-bound to the new integration, or publishing would target a dead one.
    expect(rows[0].postpeerIntegrationId).toBe('intg_new');
  });
});
