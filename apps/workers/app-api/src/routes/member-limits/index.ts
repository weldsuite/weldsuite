/**
 * Member limits — /api/member-limits.
 *
 * Ported from apps/api-worker GET /settings/member-limits (W3 legacy-worker
 * phase-out). Returns the workspace's member limit derived from its plan
 * (maxUsers hard cap, or includedUsers + purchasedSeats for per-seat plans),
 * the accurate current member count (Clerk source of truth), and whether the
 * workspace is at its limit.
 *
 * The computation itself lives in services/seat-limits.ts, shared with the
 * invite path so the number shown here is the number that gets enforced.
 *
 * Permissions: read-only, self-workspace billing context every member may
 * see (the invite dialog shows it to anyone who can open it) — gated on the
 * baseline general:read like other personal/workspace-context reads.
 *
 * Entity events: none — read-only surface.
 */

import { Hono } from 'hono';
import { requirePermission } from '@weldsuite/permissions/server';
import type { Env, Variables } from '../../types';
import { error, success } from '../../lib/response';
import { getWorkspaceSeatLimit } from '../../services/seat-limits';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * GET / — current member limit, count, and at-limit flag.
 */
app.get('/', requirePermission('general:read'), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);

  try {
    const seats = await getWorkspaceSeatLimit(c.env, orgId);
    if (!seats) return error.notFound(c, 'Workspace');

    return success(c, seats);
  } catch (err) {
    console.error('[app-api/member-limits] Failed to get member limits:', err);
    return error.internal(c, 'Failed to get member limits');
  }
});

export const memberLimitsRoutes = app;
