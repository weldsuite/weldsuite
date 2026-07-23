/**
 * Social analytics routes — /api/social-analytics/* read-only aggregates.
 * Ported from apps/api-worker/src/routes/social/analytics.ts.
 *
 * Endpoints are read-only aggregates over `socialAnalytics`, `socialAccounts`,
 * `socialPosts`, and `socialCampaigns`. No mutations; not in the entity-event
 * catalog. Registered as EXEMPT in _event-coverage.test.ts.
 *
 * Permissions: analytics:read (all endpoints).
 */

import { Hono } from 'hono';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import type { Env, Variables } from '../../types';
import { error, success } from '../../lib/response';
import { schema } from '../../db';
import { syncAnalytics, PostPeerNotConfiguredError } from '../../services/social-publishing';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const { socialAnalytics, socialAccounts, socialPosts, socialCampaigns } = schema;

/**
 * POST /:postId/sync — pull fresh metrics for a published post from PostPeer
 * into socialAnalytics. This WRITES snapshot rows, so it is gated on a
 * write-level permission (`posts:update`) rather than the read-only
 * `analytics:read` used by the GET aggregates. (The `analytics` permission
 * object is read-only by design.)
 */
app.post('/:postId/sync', requirePermission('posts:update'), async (c) => {
  const db = c.get('tenantDb');
  const postId = c.req.param('postId');
  try {
    const result = await syncAnalytics(db, c.env, postId);
    return success(c, result);
  } catch (err) {
    if (err instanceof PostPeerNotConfiguredError) {
      return error.badRequest(c, 'Social publishing is not configured');
    }
    console.error('[app-api/social-analytics] sync failed:', err);
    return error.internal(c, 'Failed to sync analytics');
  }
});

/**
 * GET /overview — Lifetime totals + platform breakdown.
 */
app.get('/overview', requirePermission('analytics:read'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const analytics = await db
      .select()
      .from(socialAnalytics)
      .where(eq(socialAnalytics.snapshotPeriod, 'lifetime'));

    let totalImpressions = 0;
    let totalReach = 0;
    let totalEngagement = 0;
    let totalClicks = 0;

    for (const item of analytics) {
      totalImpressions += Number(item.impressions) || 0;
      totalReach += Number(item.reach) || 0;
      totalEngagement += item.totalEngagement || 0;
      totalClicks += item.clicks || 0;
    }

    const engagementRate =
      totalImpressions > 0 ? (totalEngagement / totalImpressions) * 100 : 0;

    const accounts = await db
      .select()
      .from(socialAccounts)
      .where(and(eq(socialAccounts.status, 'active'), isNull(socialAccounts.deletedAt)));

    const posts = await db
      .select({ id: socialPosts.id, targetAccountIds: socialPosts.targetAccountIds })
      .from(socialPosts)
      .where(and(eq(socialPosts.status, 'published'), isNull(socialPosts.deletedAt)));

    const platformStats = accounts.map((account) => ({
      platform: account.platform,
      followers: account.followerCount || 0,
      posts: posts.filter((p) => p.targetAccountIds?.includes(account.id)).length,
      engagement: 0,
    }));

    return success(c, {
      totalImpressions,
      totalReach,
      totalEngagement,
      totalClicks,
      engagementRate,
      topPosts: [],
      platformStats,
    });
  } catch (err) {
    console.error('[app-api/social-analytics] overview failed:', err);
    return error.internal(c, 'Failed to fetch analytics overview');
  }
});

/**
 * GET /stats — Dashboard-level stats (post counts by status, connected accounts).
 */
app.get('/stats', requirePermission('analytics:read'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const posts = await db
      .select({
        id: socialPosts.id,
        status: socialPosts.status,
        publishedAt: socialPosts.publishedAt,
      })
      .from(socialPosts)
      .where(isNull(socialPosts.deletedAt));

    const accountsResult = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(socialAccounts)
      .where(and(eq(socialAccounts.status, 'active'), isNull(socialAccounts.deletedAt)));

    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const scheduledPosts = posts.filter((p) => p.status === 'scheduled').length;
    const pendingApproval = posts.filter((p) => p.status === 'pending_approval').length;
    const publishedThisWeek = posts.filter(
      (p) =>
        p.status === 'published' &&
        p.publishedAt &&
        new Date(p.publishedAt) >= weekAgo,
    ).length;

    return success(c, {
      totalPosts: posts.length,
      scheduledPosts,
      publishedThisWeek,
      pendingApproval,
      totalEngagement: 0,
      connectedAccounts: accountsResult[0]?.count || 0,
    });
  } catch (err) {
    console.error('[app-api/social-analytics] stats failed:', err);
    return error.internal(c, 'Failed to fetch stats');
  }
});

/**
 * GET /search?q= — Cross-entity search over posts, campaigns, and accounts.
 */
app.get('/search', requirePermission('analytics:read'), async (c) => {
  const query = c.req.query('q') || '';

  if (!query || query.length < 2) {
    return success(c, []);
  }

  const db = c.get('tenantDb');
  const searchTerm = `%${query}%`;

  interface SearchResult {
    type: 'post' | 'account' | 'campaign';
    id: string;
    title: string;
    description?: string;
    url: string;
  }

  try {
    const results: SearchResult[] = [];

    const postResults = await db
      .select({ id: socialPosts.id, title: socialPosts.title, content: socialPosts.content })
      .from(socialPosts)
      .where(
        and(
          isNull(socialPosts.deletedAt),
          sql`(${socialPosts.title} ILIKE ${searchTerm} OR ${socialPosts.content} ILIKE ${searchTerm})`,
        ),
      )
      .limit(5);

    for (const post of postResults) {
      results.push({
        type: 'post',
        id: post.id,
        title: post.title || 'Untitled Post',
        description: post.content?.substring(0, 100),
        url: `/social/posts/${post.id}`,
      });
    }

    const campaignResults = await db
      .select({
        id: socialCampaigns.id,
        name: socialCampaigns.name,
        description: socialCampaigns.description,
      })
      .from(socialCampaigns)
      .where(
        and(
          isNull(socialCampaigns.deletedAt),
          sql`(${socialCampaigns.name} ILIKE ${searchTerm} OR ${socialCampaigns.description} ILIKE ${searchTerm})`,
        ),
      )
      .limit(5);

    for (const campaign of campaignResults) {
      results.push({
        type: 'campaign',
        id: campaign.id,
        title: campaign.name,
        description: campaign.description || undefined,
        url: `/social/campaigns/${campaign.id}`,
      });
    }

    const accountResults = await db
      .select({
        id: socialAccounts.id,
        name: socialAccounts.name,
        username: socialAccounts.username,
        platform: socialAccounts.platform,
      })
      .from(socialAccounts)
      .where(
        and(
          isNull(socialAccounts.deletedAt),
          sql`(${socialAccounts.name} ILIKE ${searchTerm} OR ${socialAccounts.username} ILIKE ${searchTerm})`,
        ),
      )
      .limit(5);

    for (const account of accountResults) {
      results.push({
        type: 'account',
        id: account.id,
        title: account.name,
        description: `@${account.username} on ${account.platform}`,
        url: `/social/accounts`,
      });
    }

    return success(c, results);
  } catch (err) {
    console.error('[app-api/social-analytics] search failed:', err);
    return error.internal(c, 'Failed to search social entities');
  }
});

export const socialAnalyticsRoutes = app;
