/**
 * Feature requests — /api/feature-requests. Product feedback board (submit /
 * vote on feature requests, bug reports, improvements), backed by the MASTER
 * DB `feature_requests` table — the board is global across all workspaces.
 *
 * NOTE (W3 legacy-worker phase-out): the platform's feedback UI calls
 * /settings/feature-requests on api-worker, but api-worker never implemented
 * these routes — they 404 today. This is a fresh implementation against the
 * existing packages/core/db/src/schema/feature-requests.ts master table, shaped to
 * what the platform components already expect
 * (app/settings/feedback/*, components/feedback/*):
 *
 *   - GET  /            ?type=feature|bug|improvement&sortBy=votes|newest|oldest
 *                       → FeatureRequest[] each + `hasVoted` for the caller
 *   - GET  /stats       → totals by status and type
 *   - POST /            { title, description, type } → created request
 *   - POST /:id/vote    toggle the caller's vote → { voteCount, voters, hasVoted }
 *
 * Permissions: baseline general:read for everything — any authenticated
 * workspace member may browse, submit, and vote (feedback is user-level, not
 * an object-permission surface).
 *
 * Entity events: none — `feature_request` is not in the
 * packages/core/entity-events catalog (and the table is master-global, outside
 * tenant event streams).
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import type { Env, Variables } from '../../types';
import { error, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema, getMasterDb, masterSchema } from '../../db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const { featureRequests } = masterSchema;

const createFeatureRequestSchema = z.object({
  title: z.string().min(1, 'Title is required').max(500),
  description: z.string().min(1, 'Description is required'),
  type: z.enum(['feature', 'bug', 'improvement']).default('feature'),
});

const listQuerySchema = z.object({
  type: z.enum(['feature', 'bug', 'improvement']).optional(),
  sortBy: z.enum(['votes', 'newest', 'oldest']).default('votes'),
});

/**
 * GET / — list feature requests with the caller's vote status.
 */
app.get('/', requirePermission('general:read'), zValidator('query', listQuerySchema), async (c) => {
  const userId = c.get('userId');
  const { type, sortBy } = c.req.valid('query');

  try {
    const masterDb = getMasterDb(c.env);

    const orderBy =
      sortBy === 'newest'
        ? desc(featureRequests.createdAt)
        : sortBy === 'oldest'
          ? asc(featureRequests.createdAt)
          : desc(featureRequests.voteCount);

    // `feature_requests` lives in the MASTER db and is GLOBAL across every
    // workspace, and this route is gated on the baseline `general:read` that
    // every role (incl. VIEWER) holds. So columns are projected explicitly —
    // a bare .select() would hand any authenticated user of any tenant the
    // submitterEmail, submitterId (Clerk user id), internal adminNotes and
    // voters (Clerk user ids) of every request ever filed. `voters` is read
    // only to derive `hasVoted` and is NOT returned.
    const rows = await masterDb
      .select({
        id: featureRequests.id,
        title: featureRequests.title,
        description: featureRequests.description,
        type: featureRequests.type,
        status: featureRequests.status,
        voteCount: featureRequests.voteCount,
        submitterName: featureRequests.submitterName,
        voters: featureRequests.voters,
        createdAt: featureRequests.createdAt,
        updatedAt: featureRequests.updatedAt,
        completedAt: featureRequests.completedAt,
      })
      .from(featureRequests)
      .where(type ? eq(featureRequests.type, type) : undefined)
      .orderBy(orderBy, desc(featureRequests.id));

    return success(
      c,
      rows.map(({ voters, ...r }) => ({
        ...r,
        hasVoted: (voters || []).includes(userId),
      })),
    );
  } catch (err) {
    console.error('[app-api/feature-requests] Failed to list feature requests:', err);
    return error.internal(c, 'Failed to fetch feature requests');
  }
});

/**
 * GET /stats — board totals by status and type.
 */
app.get('/stats', requirePermission('general:read'), async (c) => {
  try {
    const masterDb = getMasterDb(c.env);

    const rows = await masterDb
      .select({ status: featureRequests.status, type: featureRequests.type })
      .from(featureRequests);

    const stats = {
      total: rows.length,
      open: 0,
      underReview: 0,
      planned: 0,
      inProgress: 0,
      completed: 0,
      declined: 0,
      features: 0,
      bugs: 0,
      improvements: 0,
    };

    for (const row of rows) {
      switch (row.status) {
        case 'open': stats.open++; break;
        case 'under_review': stats.underReview++; break;
        case 'planned': stats.planned++; break;
        case 'in_progress': stats.inProgress++; break;
        case 'completed': stats.completed++; break;
        case 'declined': stats.declined++; break;
      }
      switch (row.type) {
        case 'feature': stats.features++; break;
        case 'bug': stats.bugs++; break;
        case 'improvement': stats.improvements++; break;
      }
    }

    return success(c, stats);
  } catch (err) {
    console.error('[app-api/feature-requests] Failed to compute stats:', err);
    return error.internal(c, 'Failed to fetch feature request stats');
  }
});

/**
 * POST / — submit a new feature request. Submitter identity is resolved from
 * the caller's tenant workspace-member row (name/email best effort).
 */
app.post(
  '/',
  requirePermission('general:read'),
  zValidator('json', createFeatureRequestSchema),
  async (c) => {
    const userId = c.get('userId');
    const { title, description, type } = c.req.valid('json');

    try {
      const masterDb = getMasterDb(c.env);

      // Best-effort submitter identity from the tenant member row.
      let submitterName = 'Unknown';
      let submitterEmail = '';
      try {
        const db = c.get('tenantDb');
        const { workspaceMembers } = schema;
        const [member] = await db
          .select({ name: workspaceMembers.name, email: workspaceMembers.email })
          .from(workspaceMembers)
          .where(and(eq(workspaceMembers.userId, userId), isNull(workspaceMembers.deletedAt)))
          .limit(1);
        if (member) {
          submitterName = member.name || submitterName;
          submitterEmail = member.email || submitterEmail;
        }
      } catch {
        // Tenant lookup is best-effort — feedback must not fail on it.
      }

      const [created] = await masterDb
        .insert(featureRequests)
        .values({
          id: generateId('freq'),
          title,
          description,
          type,
          submitterId: userId,
          submitterName,
          submitterEmail,
        })
        .returning();

      return success(c, { ...created, hasVoted: false }, 201);
    } catch (err) {
      console.error('[app-api/feature-requests] Failed to create feature request:', err);
      return error.internal(c, 'Failed to submit feature request');
    }
  },
);

/**
 * POST /:id/vote — toggle the caller's vote on a request.
 */
app.post('/:id/vote', requirePermission('general:read'), async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');

  try {
    const masterDb = getMasterDb(c.env);

    const [request] = await masterDb
      .select()
      .from(featureRequests)
      .where(eq(featureRequests.id, id))
      .limit(1);

    if (!request) return error.notFound(c, 'Feature request', id);

    const voters = request.voters || [];
    const hasVoted = voters.includes(userId);
    const nextVoters = hasVoted ? voters.filter((v) => v !== userId) : [...voters, userId];

    const [updated] = await masterDb
      .update(featureRequests)
      .set({
        voters: nextVoters,
        voteCount: nextVoters.length,
        updatedAt: new Date(),
      })
      .where(eq(featureRequests.id, id))
      .returning({ voteCount: featureRequests.voteCount, voters: featureRequests.voters });

    return success(c, {
      voteCount: updated?.voteCount ?? nextVoters.length,
      voters: updated?.voters ?? nextVoters,
      hasVoted: !hasVoted,
    });
  } catch (err) {
    console.error('[app-api/feature-requests] Failed to toggle vote:', err);
    return error.internal(c, 'Failed to vote');
  }
});

export const featureRequestsRoutes = app;
