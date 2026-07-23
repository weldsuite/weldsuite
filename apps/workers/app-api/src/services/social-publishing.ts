/**
 * Social publishing service — PostPeer integration backing /api/social-* .
 *
 * Pure functions (no Hono context). They take the tenant `Database`, the
 * worker `Env` (for the PostPeer key + KV), and ids. All queries are tenant
 * scoped — the caller resolves the tenant DB from the authenticated workspace.
 *
 * Responsibilities:
 *  - ensureWorkspaceProfile / getConnectUrl — connect channels via PostPeer
 *  - syncAccounts — pull connected channels into `socialAccounts`
 *  - publishPost — create/schedule a post on PostPeer, persist mapping + status
 *  - reconcileFromWebhook — apply PostPeer delivery webhooks to `socialPosts`
 *  - syncAnalytics — pull metrics into `socialAnalytics`
 *
 * PostPeer holds the platform OAuth tokens; we only keep the integration +
 * profile ids it returns (see `social-accounts.ts` / `social-posts.ts` schema).
 */

import { and, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import {
  consumeCredits,
  refundCredits,
  resolveInternalWorkspaceId,
  SERVICE_CREDIT_RATES,
} from '@weldsuite/credits';
import { schema, getMasterDb, type Database } from '../db';
import type { Env } from '../types';
import { generateId } from '../lib/id';
import {
  getPostPeerClient,
  type PostPeerCreatePostResult,
  type PostPeerPlatformResult,
  type PostPeerIntegration,
} from '../lib/postpeer';
import type { SocialPlatformContent } from '@weldsuite/db/schema/social-posts';

const { workspaceSettings, socialAccounts, socialPosts, socialMedia, socialAnalytics } = schema;

/** Thrown when the PostPeer key is not configured on the worker. */
export class PostPeerNotConfiguredError extends Error {
  constructor() {
    super('PostPeer is not configured (POSTPEER_API_KEY missing)');
    this.name = 'PostPeerNotConfiguredError';
  }
}

/**
 * Thrown when an operation would double-publish — e.g. publishing a post that
 * is already published or mid-publish. Routes map this to 409 Conflict.
 */
export class SocialPublishConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SocialPublishConflictError';
  }
}

/**
 * Thrown when the workspace's prepaid wallet can't cover the publish.
 * Routes map this to 402 with code INSUFFICIENT_CREDITS.
 */
export class SocialInsufficientCreditsError extends Error {
  constructor(
    public readonly currentBalance: number,
    public readonly required: number,
  ) {
    super(`Insufficient credits: publishing requires ${required}, balance is ${currentBalance}`);
    this.name = 'SocialInsufficientCreditsError';
  }
}

const KV_POST_MAP_TTL_SECONDS = 60 * 60 * 24 * 60; // 60 days

function postMapKey(postpeerPostId: string): string {
  return `pp:post:${postpeerPostId}`;
}

interface PostMapEntry {
  /** Clerk org id — used to resolve the tenant DB from a webhook. */
  orgId: string;
  /** Internal social post id. */
  postId: string;
}

/** Normalise a PostPeer platform string to our `social_platform` enum. */
function normalisePlatform(
  platform: string,
): 'facebook' | 'instagram' | 'twitter' | 'linkedin' | 'tiktok' | null {
  const p = platform.toLowerCase();
  if (p === 'x' || p === 'twitter') return 'twitter';
  if (p === 'facebook' || p === 'instagram' || p === 'linkedin' || p === 'tiktok') return p;
  return null;
}

interface MeteringContext {
  masterDb: ReturnType<typeof getMasterDb>;
  internalWsId: string;
}

/**
 * Resolve the master DB + internal workspace id for credit metering. Returns
 * null (with a warning) when the master DB isn't configured or the workspace
 * can't be resolved — the operation proceeds unmetered (degraded mode).
 */
async function resolveMetering(env: Env, orgId: string): Promise<MeteringContext | null> {
  try {
    const masterDb = getMasterDb(env);
    const internalWsId = await resolveInternalWorkspaceId(masterDb, orgId);
    if (!internalWsId) {
      console.warn(`[social-publishing] no master workspace for org ${orgId} — unmetered`);
      return null;
    }
    return { masterDb, internalWsId };
  } catch (err) {
    console.warn(
      '[social-publishing] credit metering unavailable — unmetered:',
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

// --- Profile management ----------------------------------------------------

/**
 * Ensure the workspace has a PostPeer profile, creating one on first use.
 * The id is persisted under `workspaceSettings.customSettings.social`.
 */
export async function ensureWorkspaceProfile(
  db: Database,
  env: Env,
  workspaceId: string,
): Promise<string> {
  const client = getPostPeerClient(env);
  if (!client) throw new PostPeerNotConfiguredError();

  const [settings] = await db
    .select()
    .from(workspaceSettings)
    .where(eq(workspaceSettings.id, workspaceId))
    .limit(1);

  const custom = (settings?.customSettings ?? {}) as Record<string, unknown>;
  const social = (custom.social ?? {}) as Record<string, unknown>;
  const existingProfileId = social.postpeerProfileId as string | undefined;
  if (existingProfileId) return existingProfileId;

  // Not recorded for this workspace yet. Reconcile against PostPeer's
  // authoritative profile list before creating a new one: a profile named after
  // this workspace may already exist (a concurrent connect, a prior attempt
  // whose local persist was lost, or another worker instance). Adopting it keeps
  // exactly ONE profile per workspace, so connect and sync always resolve the
  // same profileId — a stray sibling profile would hide its accounts from sync's
  // isolation guard. Profile names are the workspace id, unique per tenant, so a
  // name match can only ever be THIS workspace's own profile.
  const existingRemote = (await client.listProfiles()).find((p) => p.name === workspaceId);
  const profileId = existingRemote?.id ?? (await client.createProfile(workspaceId)).id;

  const newCustom = {
    ...custom,
    social: { ...social, postpeerProfileId: profileId },
  };
  const now = new Date();
  if (settings) {
    await db
      .update(workspaceSettings)
      .set({ customSettings: newCustom, updatedAt: now })
      .where(eq(workspaceSettings.id, workspaceId));
  } else {
    await db.insert(workspaceSettings).values({
      id: workspaceId,
      customSettings: newCustom,
      createdAt: now,
      updatedAt: now,
    } as unknown as typeof workspaceSettings.$inferInsert);
  }

  return profileId;
}

/** Return a hosted OAuth URL the user follows to connect a platform account. */
export async function getConnectUrl(
  db: Database,
  env: Env,
  workspaceId: string,
  platform: string,
  redirectUri?: string,
): Promise<{ url: string; profileId: string }> {
  const client = getPostPeerClient(env);
  if (!client) throw new PostPeerNotConfiguredError();
  const profileId = await ensureWorkspaceProfile(db, env, workspaceId);
  const { url } = await client.getConnectUrl(platform, profileId, redirectUri);
  return { url, profileId };
}

// --- Account sync ----------------------------------------------------------

export interface SyncAccountsResult {
  synced: number;
  accountIds: string[];
}

/**
 * Pull the workspace's connected channels from PostPeer and upsert them into
 * `socialAccounts`, keyed by `postpeerIntegrationId`.
 */
export async function syncAccounts(
  db: Database,
  env: Env,
  workspaceId: string,
  connectedByUserId: string,
): Promise<SyncAccountsResult> {
  const client = getPostPeerClient(env);
  if (!client) throw new PostPeerNotConfiguredError();

  const primaryProfileId = await ensureWorkspaceProfile(db, env, workspaceId);

  // A workspace owns EVERY PostPeer profile named after its workspace id. Under
  // normal operation that's exactly one, but a concurrent-connect race can leave
  // several — and an account may be bound to any of them. Resolve the full set so
  // sync sees channels connected under any of this workspace's profiles, then use
  // it as the isolation boundary below. Profile name == workspaceId, which is
  // unique per tenant, so this set can never include another workspace's profile.
  const ownProfileIds = new Set<string>([primaryProfileId]);
  try {
    for (const p of await client.listProfiles()) {
      if (p.name === workspaceId) ownProfileIds.add(p.id);
    }
  } catch {
    // If the profile list is unavailable, fall back to the primary profile only.
  }

  const integrations: PostPeerIntegration[] = [];
  for (const pid of ownProfileIds) {
    integrations.push(...(await client.listIntegrations(pid)));
  }

  const accountIds: string[] = [];
  const now = new Date();

  for (const integration of integrations) {
    // Multi-tenant isolation guard. Every WeldSuite workspace shares ONE PostPeer
    // project (a single account-level API key), so an integration belongs to this
    // workspace ONLY if it is bound to one of THIS workspace's profiles. We list
    // per-profile above, but do NOT trust the provider's server-side filter as the
    // sole boundary: an integration whose profileId isn't in our own set — a
    // different tenant's, or null (project-level, connected outside our flow) —
    // must never be imported, or one workspace could pull in another's account.
    // This client-side check is the authoritative boundary.
    if (!integration.profileId || !ownProfileIds.has(integration.profileId)) continue;

    const platform = normalisePlatform(String(integration.platform));
    if (!platform) continue; // skip platforms we don't model yet

    const [existing] = await db
      .select()
      .from(socialAccounts)
      .where(eq(socialAccounts.postpeerIntegrationId, integration.id))
      .limit(1);

    if (existing) {
      await db
        .update(socialAccounts)
        .set({
          name: integration.name ?? integration.username ?? existing.name,
          username: integration.username ?? existing.username,
          avatarUrl: integration.avatarUrl ?? existing.avatarUrl,
          postpeerProfileId: integration.profileId,
          status: 'active',
          lastSyncAt: now,
          deletedAt: null,
          updatedAt: now,
        })
        .where(eq(socialAccounts.id, existing.id));
      accountIds.push(existing.id);
    } else {
      const id = generateId('sac');
      await db.insert(socialAccounts).values({
        id,
        platform,
        platformAccountId: integration.platformUserId ?? integration.id,
        name: integration.name ?? integration.username ?? `${platform} account`,
        username: integration.username,
        avatarUrl: integration.avatarUrl,
        postpeerIntegrationId: integration.id,
        postpeerProfileId: integration.profileId,
        status: 'active',
        lastSyncAt: now,
        connectedByUserId,
        createdAt: now,
        updatedAt: now,
      } as unknown as typeof socialAccounts.$inferInsert);
      accountIds.push(id);
    }
  }

  return { synced: accountIds.length, accountIds };
}

// --- Publishing ------------------------------------------------------------

export interface PublishPostOptions {
  /** Publish immediately. When false, `scheduledAt` is required. */
  now: boolean;
  scheduledAt?: string;
  timezone?: string;
}

export interface PublishPostResult {
  postId: string;
  postpeerPostId: string;
  status: 'published' | 'scheduled' | 'failed';
  platformContent: SocialPlatformContent[];
}

function mapPlatformResults(
  results: PostPeerPlatformResult[],
  byAccount: Map<string, { id: string; platform: SocialPlatformContent['platform'] }>,
): SocialPlatformContent[] {
  return results.map((r) => {
    const acc = r.accountId ? byAccount.get(r.accountId) : undefined;
    return {
      platform: (acc?.platform ?? (normalisePlatform(r.platform) || 'facebook')) as SocialPlatformContent['platform'],
      accountId: acc?.id ?? r.accountId ?? '',
      platformPostId: undefined,
      publishedUrl: r.platformPostUrl,
      status: r.success ? 'published' : 'failed',
      error: r.error,
      publishedAt: r.success ? new Date().toISOString() : undefined,
    } satisfies SocialPlatformContent;
  });
}

/**
 * Publish or schedule a `socialPosts` row through PostPeer. Loads the post and
 * its target accounts, builds the PostPeer payload, calls the API, persists the
 * `postpeerPostId`, status, and per-platform results, and records a KV mapping
 * so the delivery webhook can resolve the workspace later.
 */
export async function publishPost(
  db: Database,
  env: Env,
  orgId: string,
  postId: string,
  options: PublishPostOptions,
): Promise<PublishPostResult> {
  const client = getPostPeerClient(env);
  if (!client) throw new PostPeerNotConfiguredError();

  const [post] = await db
    .select()
    .from(socialPosts)
    .where(and(eq(socialPosts.id, postId), isNull(socialPosts.deletedAt)))
    .limit(1);
  if (!post) throw new Error(`Social post not found: ${postId}`);

  const targetIds = (post.targetAccountIds ?? []) as string[];
  if (targetIds.length === 0) throw new Error('Post has no target accounts');

  const accounts = await db
    .select()
    .from(socialAccounts)
    .where(and(inArray(socialAccounts.id, targetIds), isNull(socialAccounts.deletedAt)));

  const platforms: Array<{ platform: string; accountId: string }> = [];
  const byPostpeerAccount = new Map<string, { id: string; platform: SocialPlatformContent['platform'] }>();
  for (const acc of accounts) {
    if (!acc.postpeerIntegrationId) continue; // not connected via PostPeer
    platforms.push({ platform: acc.platform, accountId: acc.postpeerIntegrationId });
    byPostpeerAccount.set(acc.postpeerIntegrationId, {
      id: acc.id,
      platform: acc.platform as SocialPlatformContent['platform'],
    });
  }
  if (platforms.length === 0) {
    throw new Error('No PostPeer-connected accounts among the post targets');
  }

  // Resolve media urls.
  const mediaIds = (post.mediaIds ?? []) as string[];
  let mediaItems: Array<{ type: 'image' | 'video' | 'gif'; url: string }> | undefined;
  if (mediaIds.length > 0) {
    const media = await db
      .select()
      .from(socialMedia)
      .where(inArray(socialMedia.id, mediaIds));
    mediaItems = media
      .filter((m) => !!m.url)
      .map((m) => ({
        type: (m.mediaType ?? 'image') as 'image' | 'video' | 'gif',
        url: m.url as string,
      }));
  }

  // Idempotency — atomically claim the publishing slot. A single conditional
  // UPDATE flips the row to `publishing` only if it isn't already
  // `publishing`/`published`, so two concurrent publish calls can't both pass a
  // read-then-write guard and double-submit to PostPeer (TOCTOU). The loser
  // updates zero rows and is rejected. Done after read-only validation so a
  // validation error can't leave the row stuck in `publishing`.
  const claimSet: Record<string, unknown> = {
    status: 'publishing',
    lastPublishAttemptAt: new Date(),
    publishAttempts: sql`${socialPosts.publishAttempts} + 1`,
    updatedAt: new Date(),
  };
  // When scheduling, persist scheduledAt/timezone as part of the SAME atomic
  // claim so the stored time can't diverge from what is submitted to PostPeer
  // under concurrent (re)schedule requests.
  if (!options.now && options.scheduledAt) {
    claimSet.scheduledAt = new Date(options.scheduledAt);
    if (options.timezone) claimSet.timezone = options.timezone;
  }
  const claimed = await db
    .update(socialPosts)
    .set(claimSet)
    .where(
      and(
        eq(socialPosts.id, postId),
        isNull(socialPosts.deletedAt),
        notInArray(socialPosts.status, ['publishing', 'published']),
      ),
    )
    .returning({ id: socialPosts.id, publishAttempts: socialPosts.publishAttempts });
  if (claimed.length === 0) {
    throw new SocialPublishConflictError('Post is already being published or has been published');
  }

  // Credit metering — charge the prepaid wallet per target platform BEFORE
  // submitting to PostPeer. The (postId, attempt) idempotency key means a
  // retried request can't double-charge; failures are refunded below.
  // Insufficient balance fails CLOSED (402); an unavailable master DB fails
  // open with a loud warning (degraded mode), matching the other workers.
  const creditCost = platforms.length * SERVICE_CREDIT_RATES.socialPostPerPlatform;
  let creditTransactionId: string | null = null;
  const metering = await resolveMetering(env, orgId);
  if (metering) {
    const attempt = claimed[0].publishAttempts ?? 0;
    let charge: Awaited<ReturnType<typeof consumeCredits>> | null = null;
    try {
      charge = await consumeCredits(metering.masterDb, {
        workspaceId: metering.internalWsId,
        amount: creditCost,
        serviceType: 'social_post',
        idempotencyKey: `social:${postId}:${attempt}`,
        referenceId: postId,
        referenceType: 'social_post',
        description: `Social post to ${platforms.length} platform(s)${options.now ? '' : ' (scheduled)'}`,
        metadata: {
          postId,
          platforms: platforms.map((p) => p.platform),
          scheduled: !options.now,
        },
      });
    } catch (err) {
      console.error('[social-publishing] credit charge FAILED (publishing unmetered!):', err);
    }
    if (charge) {
      if (!charge.ok) {
        // Release the claim so the user can retry after topping up.
        await db
          .update(socialPosts)
          .set({ status: post.status, lastPublishError: 'insufficient_credits', updatedAt: new Date() })
          .where(eq(socialPosts.id, postId));
        throw new SocialInsufficientCreditsError(charge.currentBalance, creditCost);
      }
      creditTransactionId = charge.transactionId;
    }
  }

  // If a PostPeer scheduled post already exists for this row (e.g. reschedule,
  // or publish-now of a scheduled post), cancel it FIRST so the old scheduled
  // time can't still fire alongside the new submission (double-post). Cancel is
  // best-effort: a 404 (already gone) must not block the new submission.
  if (post.postpeerPostId && post.status === 'scheduled') {
    try {
      await client.deletePost(post.postpeerPostId);
    } catch (err) {
      console.warn(
        `[social-publishing] failed to cancel previous PostPeer post ${post.postpeerPostId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  let result: PostPeerCreatePostResult;
  try {
    result = await client.createPost({
      content: post.content,
      platforms,
      mediaItems,
      publishNow: options.now ? true : undefined,
      scheduledAt: options.now ? undefined : options.scheduledAt,
      timezone: options.timezone ?? post.timezone ?? undefined,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'PostPeer publish failed';
    await db
      .update(socialPosts)
      .set({ status: 'failed', lastPublishError: message, updatedAt: new Date() })
      .where(eq(socialPosts.id, postId));
    // Nothing was submitted — refund the full charge.
    if (metering && creditTransactionId) {
      try {
        await refundCredits(metering.masterDb, {
          workspaceId: metering.internalWsId,
          amount: creditCost,
          idempotencyKey: `social_refund:${creditTransactionId}`,
          referenceId: postId,
          referenceType: 'social_post',
          description: 'Social publish failed before submission — refund',
        });
      } catch (refundErr) {
        console.error('[social-publishing] refund after failed submit FAILED:', refundErr);
      }
    }
    throw err;
  }

  const platformContent = mapPlatformResults(result.platforms ?? [], byPostpeerAccount);
  const anyFailed = platformContent.some((p) => p.status === 'failed');
  const allFailed = platformContent.length > 0 && platformContent.every((p) => p.status === 'failed');

  const status: PublishPostResult['status'] = options.now
    ? allFailed
      ? 'failed'
      : 'published'
    : 'scheduled';

  // Refund platforms that failed immediately (publish-now only — scheduled
  // posts report failures later via webhook, handled in reconcileFromWebhook).
  let refundedCredits = 0;
  if (metering && creditTransactionId && options.now) {
    const failedCount = platformContent.filter((p) => p.status === 'failed').length;
    if (failedCount > 0) {
      const refundAmount = failedCount * SERVICE_CREDIT_RATES.socialPostPerPlatform;
      try {
        await refundCredits(metering.masterDb, {
          workspaceId: metering.internalWsId,
          amount: refundAmount,
          idempotencyKey: `social_refund:${creditTransactionId}:immediate`,
          referenceId: postId,
          referenceType: 'social_post',
          description: `Social publish failed on ${failedCount} platform(s) — partial refund`,
        });
        refundedCredits = refundAmount;
      } catch (refundErr) {
        console.error('[social-publishing] partial refund FAILED:', refundErr);
      }
    }
  }

  await db
    .update(socialPosts)
    .set({
      status,
      postpeerPostId: result.postId,
      platformContent,
      publishedAt: status === 'published' ? new Date() : null,
      lastPublishError: anyFailed
        ? platformContent.find((p) => p.error)?.error ?? null
        : null,
      creditsConsumed: creditTransactionId ? creditCost - refundedCredits : 0,
      creditTransactionId,
      updatedAt: new Date(),
    })
    .where(eq(socialPosts.id, postId));

  // Map PostPeer post id → workspace for the delivery webhook.
  if (env.WORKSPACE_CACHE && result.postId) {
    const entry: PostMapEntry = { orgId, postId };
    await env.WORKSPACE_CACHE.put(postMapKey(result.postId), JSON.stringify(entry), {
      expirationTtl: KV_POST_MAP_TTL_SECONDS,
    });
  }

  return { postId, postpeerPostId: result.postId, status, platformContent };
}

/**
 * Cancel a post. A post that is already `published` or mid-`publishing` CANNOT
 * be cancelled — its content is (being) live on the channels — so we reject
 * with SocialPublishConflictError rather than silently flipping it to
 * cancelled. If the post has a live PostPeer scheduled post, that is cancelled
 * on PostPeer first (best-effort) so it can't still fire. Returns false if the
 * post doesn't exist.
 */
export async function cancelPost(
  db: Database,
  env: Env,
  orgId: string,
  postId: string,
): Promise<boolean> {
  const [post] = await db
    .select()
    .from(socialPosts)
    .where(and(eq(socialPosts.id, postId), isNull(socialPosts.deletedAt)))
    .limit(1);
  if (!post) return false;

  if (post.status === 'published' || post.status === 'publishing') {
    throw new SocialPublishConflictError('Cannot cancel a post that is already published or publishing');
  }

  if (post.postpeerPostId && post.status === 'scheduled') {
    const client = getPostPeerClient(env);
    if (client) {
      try {
        await client.deletePost(post.postpeerPostId);
      } catch (err) {
        console.warn(
          `[social-publishing] failed to cancel PostPeer post ${post.postpeerPostId}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  // Atomic guard: only flip to cancelled if it hasn't become published/publishing
  // in the meantime (mirrors the publishPost claim).
  const cancelled = await db
    .update(socialPosts)
    .set({ status: 'cancelled', creditsConsumed: 0, creditTransactionId: null, updatedAt: new Date() })
    .where(
      and(
        eq(socialPosts.id, postId),
        isNull(socialPosts.deletedAt),
        notInArray(socialPosts.status, ['published', 'publishing']),
      ),
    )
    .returning({ id: socialPosts.id });
  if (cancelled.length === 0) {
    throw new SocialPublishConflictError('Cannot cancel a post that is already published or publishing');
  }

  // Refund the credits charged when the post was scheduled. Idempotent on the
  // original ledger transaction, so a repeated cancel can't double-refund.
  if (post.creditTransactionId && (post.creditsConsumed ?? 0) > 0) {
    const metering = await resolveMetering(env, orgId);
    if (metering) {
      try {
        await refundCredits(metering.masterDb, {
          workspaceId: metering.internalWsId,
          amount: post.creditsConsumed as number,
          idempotencyKey: `social_refund_cancel:${post.creditTransactionId}`,
          referenceId: postId,
          referenceType: 'social_post',
          description: 'Scheduled social post cancelled — refund',
        });
      } catch (refundErr) {
        console.error('[social-publishing] cancel refund FAILED:', refundErr);
      }
    }
  }

  return true;
}

// --- Webhook reconciliation ------------------------------------------------

export interface PostPeerWebhookPayload {
  event?: string;
  data?: {
    postId?: string;
    status?: string;
    platforms?: PostPeerPlatformResult[];
  };
  postId?: string;
  status?: string;
  platforms?: PostPeerPlatformResult[];
}

/** Look up the workspace + internal post id for a PostPeer post id. */
export async function resolvePostpeerPost(
  env: Env,
  postpeerPostId: string,
): Promise<PostMapEntry | null> {
  if (!env.WORKSPACE_CACHE) return null;
  return (await env.WORKSPACE_CACHE.get(postMapKey(postpeerPostId), 'json')) as PostMapEntry | null;
}

/**
 * Apply a PostPeer delivery webhook to the matching `socialPosts` row. Updates
 * status, per-platform permalinks, and publishedAt. Tenant-scoped — the caller
 * resolves `db` from the workspace via `resolvePostpeerPost`.
 */
export async function reconcileFromWebhook(
  db: Database,
  env: Env,
  orgId: string,
  internalPostId: string,
  payload: PostPeerWebhookPayload,
): Promise<boolean> {
  const data = payload.data ?? payload;
  const event = payload.event ?? '';
  const incomingPlatforms = data.platforms ?? [];

  const [post] = await db
    .select()
    .from(socialPosts)
    .where(and(eq(socialPosts.id, internalPostId), isNull(socialPosts.deletedAt)))
    .limit(1);
  if (!post) return false;

  // Merge per-platform results by accountId, preserving our internal mapping.
  const existing = (post.platformContent ?? []) as SocialPlatformContent[];
  const newlyFailedAccountIds: string[] = [];
  const merged: SocialPlatformContent[] = existing.map((pc) => {
    const match = incomingPlatforms.find(
      (p) => p.accountId === pc.accountId || normalisePlatform(p.platform) === pc.platform,
    );
    if (!match) return pc;
    if (!match.success && pc.status !== 'failed') newlyFailedAccountIds.push(pc.accountId);
    return {
      ...pc,
      publishedUrl: match.platformPostUrl ?? pc.publishedUrl,
      status: match.success ? 'published' : 'failed',
      error: match.error ?? pc.error,
      publishedAt: match.success ? pc.publishedAt ?? new Date().toISOString() : pc.publishedAt,
    } satisfies SocialPlatformContent;
  });

  const failed = event.includes('failed') || merged.some((p) => p.status === 'failed');
  const published =
    event.includes('published') || (merged.length > 0 && merged.every((p) => p.status === 'published'));

  const nextStatus: typeof post.status =
    published && !failed ? 'published' : failed && !published ? 'failed' : post.status;

  // Refund credits for platforms that just flipped to failed. Idempotent per
  // (transaction, account) — webhook replays can't double-refund.
  let creditsConsumed = post.creditsConsumed ?? 0;
  if (post.creditTransactionId && creditsConsumed > 0 && newlyFailedAccountIds.length > 0) {
    const metering = await resolveMetering(env, orgId);
    if (metering) {
      for (const accountId of newlyFailedAccountIds) {
        const refundAmount = Math.min(SERVICE_CREDIT_RATES.socialPostPerPlatform, creditsConsumed);
        if (refundAmount <= 0) break;
        try {
          await refundCredits(metering.masterDb, {
            workspaceId: metering.internalWsId,
            amount: refundAmount,
            idempotencyKey: `social_refund:${post.creditTransactionId}:${accountId}`,
            referenceId: internalPostId,
            referenceType: 'social_post',
            description: 'Social platform delivery failed — refund',
            metadata: { accountId },
          });
          creditsConsumed -= refundAmount;
        } catch (refundErr) {
          console.error('[social-publishing] webhook failure refund FAILED:', refundErr);
        }
      }
    }
  }

  await db
    .update(socialPosts)
    .set({
      status: nextStatus,
      platformContent: merged,
      publishedAt: nextStatus === 'published' ? post.publishedAt ?? new Date() : post.publishedAt,
      lastPublishError: failed ? merged.find((p) => p.error)?.error ?? post.lastPublishError : post.lastPublishError,
      creditsConsumed,
      updatedAt: new Date(),
    })
    .where(eq(socialPosts.id, internalPostId));

  return true;
}

// --- Analytics sync --------------------------------------------------------

/** Pull metrics for a published post from PostPeer into `socialAnalytics`. */
export async function syncAnalytics(
  db: Database,
  env: Env,
  postId: string,
): Promise<{ snapshots: number }> {
  const client = getPostPeerClient(env);
  if (!client) throw new PostPeerNotConfiguredError();

  const [post] = await db
    .select()
    .from(socialPosts)
    .where(and(eq(socialPosts.id, postId), isNull(socialPosts.deletedAt)))
    .limit(1);
  if (!post || !post.postpeerPostId) return { snapshots: 0 };

  // Map PostPeer integration id → our account id so per-account metrics can be
  // attributed. Both postId and accountId are NOT NULL on socialAnalytics.
  const targetIds = (post.targetAccountIds ?? []) as string[];
  const targets = targetIds.length
    ? await db
        .select()
        .from(socialAccounts)
        .where(inArray(socialAccounts.id, targetIds))
    : [];
  const byIntegration = new Map<string, string>();
  for (const acc of targets) {
    if (acc.postpeerIntegrationId) byIntegration.set(acc.postpeerIntegrationId, acc.id);
  }
  const fallbackAccountId = targets.length === 1 ? targets[0].id : undefined;

  const metrics = await client.getAnalytics({ postId: post.postpeerPostId });
  const now = new Date();
  let snapshots = 0;

  for (const m of metrics) {
    const accountId = (m.accountId && byIntegration.get(m.accountId)) || fallbackAccountId;
    if (!accountId) continue; // can't attribute this metric to one of our accounts
    const engagement =
      m.engagement ?? (m.likes ?? 0) + (m.comments ?? 0) + (m.shares ?? 0) + (m.saves ?? 0);
    const impressions = m.impressions ?? 0;
    await db.insert(socialAnalytics).values({
      id: generateId('san'),
      postId: post.id,
      accountId,
      platformPostId: m.postId ?? post.postpeerPostId,
      snapshotPeriod: 'lifetime',
      snapshotAt: now,
      impressions,
      reach: m.reach ?? 0,
      likes: m.likes ?? 0,
      comments: m.comments ?? 0,
      shares: m.shares ?? 0,
      saves: m.saves ?? 0,
      clicks: m.clicks ?? 0,
      videoViews: m.views ?? 0,
      totalEngagement: engagement,
      engagementRate: impressions > 0 ? (engagement / impressions) * 100 : 0,
      rawData: m as unknown as Record<string, unknown>,
      createdAt: now,
      updatedAt: now,
    } as unknown as typeof socialAnalytics.$inferInsert);
    snapshots += 1;
  }

  return { snapshots };
}
