/**
 * pglite integration tests for the social publishing double-post guards:
 *  - reschedule/publish cancels a pre-existing PostPeer scheduled post first
 *  - publishPost is idempotent (rejects already-published / mid-publish)
 *  - cancelPost deletes the live PostPeer post so it can't still fire, fails
 *    loudly if that delete doesn't land, and keeps the content as a draft
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
  cancelDeliveryBeforeDelete,
  SocialPublishConflictError,
  SocialCancelUpstreamError,
  type SocialPublishingContext,
} from '@weldsuite/social-publishing';
import type { SocialPlatformContent } from '@weldsuite/db/schema/social-posts';

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

/**
 * Stub fetch; record (method, path, body) and return canned PostPeer responses.
 *
 * `deleteStatus` forces DELETE /posts/:id to fail with that HTTP status, which
 * is how the cancel-must-fail-loudly paths are exercised.
 *
 * `platformResults` overrides what the create-post call reports per channel.
 * The default mirrors a well-formed publish-now response; tests that care about
 * the schedule path pass their own, because PostPeer does NOT echo `accountId`
 * back there.
 */
function stubPostPeer(
  opts: {
    deleteStatus?: number;
    onDelete?: () => Promise<void>;
    platformResults?: Array<Record<string, unknown>>;
  } = {},
): Array<{ method: string; path: string; body?: unknown }> {
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
      // Lets a test land a concurrent DB change in the exact window between
      // cancelPost's upstream delete and its local update.
      if (init.method === 'DELETE' && opts.onDelete) await opts.onDelete();
      if (opts.deleteStatus && init.method === 'DELETE') {
        return {
          ok: false,
          status: opts.deleteStatus,
          text: async () => JSON.stringify({ message: 'nope' }),
        };
      }
      const body =
        init.method === 'POST' && path.endsWith('/posts')
          ? {
              postId: 'new_pp',
              status: 'scheduled',
              platforms: opts.platformResults ?? [
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

/** A second twitter account, for tests pinning the exact-accountId match order. */
async function seedSecondAccount() {
  await db
    .insert(schema.socialAccounts)
    .values({
      id: 'sac_2',
      platform: 'twitter',
      platformAccountId: 'pa2',
      name: 'X acct 2',
      postpeerIntegrationId: 'intg_2',
      status: 'active',
      connectedByUserId: 'u1',
      createdAt: new Date(),
      updatedAt: new Date(),
    } as typeof schema.socialAccounts.$inferInsert)
    .onConflictDoNothing();
}

async function seedPost(
  id: string,
  status: string,
  postpeerPostId: string | null,
  scheduledAt?: Date,
  targetAccountIds: string[] = ['sac_1'],
) {
  await db.insert(schema.socialPosts).values({
    id,
    content: 'hello world',
    postType: 'post',
    status: status as never,
    targetAccountIds,
    postpeerPostId,
    scheduledAt,
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

    // PostPeer's body schema is closed and `scheduledFor` is validated as
    // `format: "date-time"` — the schedule must go out as an RFC 3339 UTC
    // instant (offset included) + `timezone`, with no `scheduledAt` and no
    // `publishNow`, or the whole request 400s.
    expect(created!.body).toMatchObject({
      scheduledFor: '2030-01-01T00:00:00.000Z',
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

  it('cancelPost deletes the live PostPeer post and returns the row to draft', async () => {
    if (!available) return;
    await seedAccount();
    await seedPost('spo_cancel', 'scheduled', 'pp_cancel', new Date('2030-06-01T14:00:00Z'));
    const calls = stubPostPeer();

    const ok = await cancelPost(db, ctx, 'org_1', 'spo_cancel');
    expect(ok).toBe(true);
    expect(calls).toContainEqual({ method: 'DELETE', path: '/v1/posts/pp_cancel' });

    const [row] = await db
      .select()
      .from(schema.socialPosts)
      .where(eq(schema.socialPosts.id, 'spo_cancel'));
    // The content survives so it can be re-scheduled; the slot and the upstream
    // handle are both gone.
    expect(row.status).toBe('draft');
    expect(row.content).toBe('hello world');
    expect(row.scheduledAt).toBeNull();
    expect(row.postpeerPostId).toBeNull();
  });

  it('cancelPost refuses to blank a schedule replaced by a concurrent reschedule', async () => {
    if (!available) return;
    await seedAccount();
    await seedPost('spo_resched_race', 'scheduled', 'pp_old', new Date('2030-06-01T14:00:00Z'));

    // Simulate a reschedule completing in the window between our upstream
    // delete and our local update: it mints a NEW PostPeer post and puts the row
    // back to `scheduled`. Status alone would look unchanged at update time.
    const newScheduledAt = new Date('2030-07-01T09:00:00Z');
    stubPostPeer({
      onDelete: async () => {
        await db
          .update(schema.socialPosts)
          .set({ status: 'scheduled', postpeerPostId: 'pp_new', scheduledAt: newScheduledAt })
          .where(eq(schema.socialPosts.id, 'spo_resched_race'));
      },
    });

    await expect(cancelPost(db, ctx, 'org_1', 'spo_resched_race')).rejects.toBeInstanceOf(
      SocialPublishConflictError,
    );

    // pp_new is live upstream, so the row must still say scheduled. Blanking it
    // would leave us claiming `draft` while PostPeer goes on to publish.
    const [row] = await db
      .select()
      .from(schema.socialPosts)
      .where(eq(schema.socialPosts.id, 'spo_resched_race'));
    expect(row.status).toBe('scheduled');
    expect(row.postpeerPostId).toBe('pp_new');
    expect(row.scheduledAt).toEqual(newScheduledAt);
  });

  it('cancelPost fails loudly and leaves the post scheduled when PostPeer errors', async () => {
    if (!available) return;
    await seedAccount();
    const scheduledAt = new Date('2030-06-01T14:00:00Z');
    await seedPost('spo_cancel_5xx', 'scheduled', 'pp_5xx', scheduledAt);
    stubPostPeer({ deleteStatus: 500 });

    await expect(cancelPost(db, ctx, 'org_1', 'spo_cancel_5xx')).rejects.toBeInstanceOf(
      SocialCancelUpstreamError,
    );

    // The post is still armed upstream, so the row must still say so — anything
    // else would tell the user it was cancelled when it is about to publish.
    const [row] = await db
      .select()
      .from(schema.socialPosts)
      .where(eq(schema.socialPosts.id, 'spo_cancel_5xx'));
    expect(row.status).toBe('scheduled');
    expect(row.postpeerPostId).toBe('pp_5xx');
    expect(row.scheduledAt).toEqual(scheduledAt);
  });

  it('cancelPost treats a PostPeer 404 as already-unscheduled and proceeds', async () => {
    if (!available) return;
    await seedAccount();
    await seedPost('spo_cancel_404', 'scheduled', 'pp_404', new Date('2030-06-01T14:00:00Z'));
    stubPostPeer({ deleteStatus: 404 });

    const ok = await cancelPost(db, ctx, 'org_1', 'spo_cancel_404');
    expect(ok).toBe(true);

    const [row] = await db
      .select()
      .from(schema.socialPosts)
      .where(eq(schema.socialPosts.id, 'spo_cancel_404'));
    expect(row.status).toBe('draft');
    expect(row.postpeerPostId).toBeNull();
  });

  it('cancelPost refuses to unschedule when PostPeer is not configured', async () => {
    if (!available) return;
    await seedAccount();
    await seedPost('spo_cancel_nocfg', 'scheduled', 'pp_nocfg', new Date('2030-06-01T14:00:00Z'));
    const calls = stubPostPeer();
    const noKeyCtx = { masterDb: () => masterDb } as unknown as SocialPublishingContext;

    await expect(cancelPost(db, noKeyCtx, 'org_1', 'spo_cancel_nocfg')).rejects.toBeInstanceOf(
      SocialCancelUpstreamError,
    );
    expect(calls).toHaveLength(0);

    const [row] = await db
      .select()
      .from(schema.socialPosts)
      .where(eq(schema.socialPosts.id, 'spo_cancel_nocfg'));
    expect(row.status).toBe('scheduled');
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

describe('social publishing · platform content', () => {
  it('a scheduled post is pending per platform and carries our own account id', async () => {
    if (!available) return;
    await seedAccount();
    await seedPost('spo_sched_pc', 'draft', null);
    // PostPeer does not echo `accountId` back on the schedule path — deriving
    // platformContent from the response is what used to leave it empty.
    const calls = stubPostPeer({ platformResults: [{ platform: 'twitter', success: true }] });

    const res = await publishPost(db, ctx, 'org_1', 'spo_sched_pc', {
      now: false,
      scheduledAt: '2030-01-01T00:00:00.000Z',
    });

    expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/posts'))).toBe(true);
    expect(res.status).toBe('scheduled');
    expect(res.platformContent).toHaveLength(1);

    const [pc] = res.platformContent;
    // Resolved from our own target, not from the response.
    expect(pc.accountId).toBe('sac_1');
    expect(pc.platform).toBe('twitter');
    // Queued is not delivered: nothing may claim it published, and nothing may
    // stamp a publish time.
    expect(pc.status).toBe('pending');
    expect(pc.publishedAt).toBeUndefined();

    const [row] = await db
      .select()
      .from(schema.socialPosts)
      .where(eq(schema.socialPosts.id, 'spo_sched_pc'));
    // The row and its platform content agree — no post reads as published
    // while the row itself says scheduled.
    expect(row.status).toBe('scheduled');
    expect(row.publishedAt).toBeNull();
    const stored = row.platformContent as SocialPlatformContent[];
    expect(stored[0].status).toBe('pending');
    expect(stored[0].accountId).toBe('sac_1');
  });

  it('publish-now marks the platform published and still resolves our account id', async () => {
    if (!available) return;
    await seedAccount();
    await seedPost('spo_now_pc', 'draft', null);
    stubPostPeer({
      platformResults: [{ platform: 'twitter', success: true, platformPostUrl: 'https://x/9' }],
    });

    const res = await publishPost(db, ctx, 'org_1', 'spo_now_pc', { now: true });

    expect(res.status).toBe('published');
    const [pc] = res.platformContent;
    expect(pc.accountId).toBe('sac_1');
    expect(pc.status).toBe('published');
    expect(pc.publishedUrl).toBe('https://x/9');
    expect(pc.publishedAt).toBeDefined();
  });

  it('a channel PostPeer rejected is failed on the schedule path too', async () => {
    if (!available) return;
    await seedAccount();
    await seedPost('spo_sched_fail', 'draft', null);
    stubPostPeer({
      platformResults: [{ platform: 'twitter', success: false, error: 'channel revoked' }],
    });

    const res = await publishPost(db, ctx, 'org_1', 'spo_sched_fail', {
      now: false,
      scheduledAt: '2030-01-01T00:00:00.000Z',
    });

    const [pc] = res.platformContent;
    expect(pc.status).toBe('failed');
    expect(pc.error).toBe('channel revoked');
    // The account id has to survive a failure — the refund idempotency key is
    // built from it, and colliding keys silently drop refunds.
    expect(pc.accountId).toBe('sac_1');
  });

  it('an exact accountId match is claimed by its own target, not stolen by an earlier platform fallback', async () => {
    if (!available) return;
    await seedAccount();
    await seedSecondAccount();
    // Two twitter accounts on one post. Only ONE result comes back, naming
    // sac_2's integration explicitly. A single pass that resolves targets in
    // order would let sac_1 grab this result via the platform fallback before
    // sac_2 ever gets a chance at its own exact match — attributing sac_2's
    // failure to sac_1 instead.
    await seedPost('spo_multi_acct', 'draft', null, undefined, ['sac_1', 'sac_2']);
    stubPostPeer({
      platformResults: [
        { platform: 'twitter', accountId: 'intg_2', success: false, error: 'revoked' },
      ],
    });

    const res = await publishPost(db, ctx, 'org_1', 'spo_multi_acct', { now: true });

    expect(res.platformContent).toHaveLength(2);
    const bySac1 = res.platformContent.find((p) => p.accountId === 'sac_1');
    const bySac2 = res.platformContent.find((p) => p.accountId === 'sac_2');
    expect(bySac1).toBeDefined();
    expect(bySac2).toBeDefined();

    // The named account gets the failure...
    expect(bySac2!.status).toBe('failed');
    expect(bySac2!.error).toBe('revoked');
    // ...and the other stays unclaimed rather than wrongly inheriting it.
    expect(bySac1!.status).toBe('pending');
    expect(bySac1!.error).toBeUndefined();
  });
});

describe('social publishing · delete cancels the pending delivery', () => {
  it('cancels the upstream scheduled post so a deleted post cannot still fire', async () => {
    if (!available) return;
    await seedAccount();
    await seedPost('spo_del', 'scheduled', 'pp_del', new Date('2030-06-01T14:00:00Z'));
    const calls = stubPostPeer();

    await cancelDeliveryBeforeDelete(db, ctx, 'org_1', 'spo_del');

    expect(calls).toContainEqual({ method: 'DELETE', path: '/v1/posts/pp_del' });
    const [row] = await db
      .select()
      .from(schema.socialPosts)
      .where(eq(schema.socialPosts.id, 'spo_del'));
    // cancelPost unschedules back to `draft`; the caller stamps `deletedAt`
    // immediately after, so this status is never user-visible. What matters is
    // that the upstream handle and the slot are both gone before the delete.
    expect(row.status).toBe('draft');
    expect(row.scheduledAt).toBeNull();
    expect(row.postpeerPostId).toBeNull();
  });

  it('stays quiet for an already-published post so the record is still deletable', async () => {
    if (!available) return;
    await seedAccount();
    await seedPost('spo_del_pub', 'published', 'pp_del_pub');
    const calls = stubPostPeer();

    // A published post cannot be recalled, and that must not block the delete.
    await expect(cancelDeliveryBeforeDelete(db, ctx, 'org_1', 'spo_del_pub')).resolves.toBeUndefined();

    expect(calls).toHaveLength(0);
    const [row] = await db
      .select()
      .from(schema.socialPosts)
      .where(eq(schema.socialPosts.id, 'spo_del_pub'));
    expect(row.status).toBe('published');
  });

  it('propagates a non-conflict cancellation failure so the route cannot delete the row', async () => {
    if (!available) return;
    await seedAccount();
    await seedPost('spo_del_err', 'scheduled', 'pp_del_err');
    stubPostPeer();

    // Only SocialPublishConflictError ("already live, can't be recalled") may
    // be swallowed. Everything else — PostPeer unreachable, a DB error — must
    // surface, or a delete route that ignores it would remove the row while
    // the schedule might still be live upstream. Force a DB-level failure in
    // the cancel claim itself (distinct from the published/publishing check,
    // which runs before this and would throw SocialPublishConflictError) to
    // simulate that "unexpected error" case.
    const originalUpdate = db.update.bind(db);
    db.update = (() => {
      throw new Error('boom: simulated DB failure');
    }) as typeof db.update;

    try {
      await expect(cancelDeliveryBeforeDelete(db, ctx, 'org_1', 'spo_del_err')).rejects.toThrow('boom');
    } finally {
      db.update = originalUpdate;
    }

    // Nothing rewrote the row — it is exactly as it was before the failed cancel.
    const [row] = await db
      .select()
      .from(schema.socialPosts)
      .where(eq(schema.socialPosts.id, 'spo_del_err'));
    expect(row.status).toBe('scheduled');
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
