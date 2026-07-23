/**
 * Member limits — /api/member-limits.
 *
 * Ported from apps/api-worker GET /settings/member-limits (W3 legacy-worker
 * phase-out). Returns the workspace's member limit derived from its plan
 * (maxUsers hard cap, or includedUsers + purchasedSeats for per-seat plans),
 * the accurate current member count (Clerk source of truth), and whether the
 * workspace is at its limit.
 *
 * Permissions: read-only, self-workspace billing context every member may
 * see (the invite dialog shows it to anyone who can open it) — gated on the
 * baseline general:read like other personal/workspace-context reads.
 *
 * Entity events: none — read-only surface.
 */

import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import type { Env, Variables } from '../../types';
import { error, success } from '../../lib/response';
import { getMasterDb, masterSchema } from '../../db';
import { getAccurateMemberCount } from '../../services/member-count';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * GET / — current member limit, count, and at-limit flag.
 */
app.get('/', requirePermission('general:read'), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);

  try {
    const masterDb = getMasterDb(c.env);
    const { workspaces, plans } = masterSchema;

    const [workspace] = await masterDb
      .select({
        id: workspaces.id,
        planId: workspaces.planId,
        purchasedSeats: workspaces.purchasedSeats,
      })
      .from(workspaces)
      .where(eq(workspaces.clerkOrgId, orgId));

    if (!workspace) return error.notFound(c, 'Workspace');

    let limit: number | null = null;
    let planName = 'Free';

    if (workspace.planId) {
      const [plan] = await masterDb
        .select({
          name: plans.name,
          maxUsers: plans.maxUsers,
          pricePerUser: plans.pricePerUser,
          includedUsers: plans.includedUsers,
        })
        .from(plans)
        .where(eq(plans.id, workspace.planId));

      if (plan) {
        planName = plan.name;

        if (plan.maxUsers != null && plan.maxUsers > 0) {
          limit = plan.maxUsers;
        } else {
          const pricePerUser = plan.pricePerUser ? parseFloat(plan.pricePerUser) : 0;
          if (pricePerUser > 0) {
            limit = (plan.includedUsers ?? 1) + (workspace.purchasedSeats ?? 0);
          }
        }
      }
    }

    const current = await getAccurateMemberCount(c.env, orgId, workspace.id, masterDb);

    return success(c, {
      limit,
      current,
      atLimit: limit !== null && current >= limit,
      planName,
    });
  } catch (err) {
    console.error('[app-api/member-limits] Failed to get member limits:', err);
    return error.internal(c, 'Failed to get member limits');
  }
});

export const memberLimitsRoutes = app;
