/**
 * Prepaid seats — /api/prepaid-seats.
 *
 * Ported from apps/api-worker GET /settings/prepaid-seats (W3 legacy-worker
 * phase-out). Returns prepaid seat info for the workspace: total prepaid
 * (plan includedUsers + purchasedSeats), used (accurate member count from
 * Clerk), available, and whether more members can be added without buying
 * seats.
 *
 * Permissions: baseline general:read — shown in the invite-member dialog to
 * any member who can open it (same stance as member-limits).
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
 * GET / — prepaid seat totals for the workspace.
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

    let includedUsers = 1;

    if (workspace.planId) {
      const [plan] = await masterDb
        .select({
          pricePerUser: plans.pricePerUser,
          includedUsers: plans.includedUsers,
        })
        .from(plans)
        .where(eq(plans.id, workspace.planId));

      if (plan) {
        includedUsers = plan.includedUsers ?? 1;
      }
    }

    const purchasedSeats = workspace.purchasedSeats ?? 0;
    const prepaidSeats = includedUsers + purchasedSeats;

    const usedSeats = await getAccurateMemberCount(c.env, orgId, workspace.id, masterDb);
    const availableSeats = Math.max(0, prepaidSeats - usedSeats);

    return success(c, {
      prepaidSeats,
      usedSeats,
      availableSeats,
      canAddMore: availableSeats > 0,
    });
  } catch (err) {
    console.error('[app-api/prepaid-seats] Failed to get prepaid seats:', err);
    return error.internal(c, 'Failed to get prepaid seats');
  }
});

export const prepaidSeatsRoutes = app;
