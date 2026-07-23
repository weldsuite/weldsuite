/**
 * Helpdesk statistics routes — /api/helpdesk-stats/* surface.
 * Read-only aggregates over helpdesk tickets. No mutations.
 *
 * Permissions: tickets:read.
 */

import { Hono } from 'hono';
import { isNull, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import type { Env, Variables } from '../../types';
import { error, success } from '../../lib/response';
import { schema } from '../../db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// ============================================================================
// GET / — aggregate ticket counts by status
// ============================================================================

app.get('/', requirePermission('tickets:read'), async (c) => {
  const db = c.get('tenantDb');
  const { helpdeskTickets } = schema;
  try {
    const [result] = await db
      .select({
        totalTickets: sql<number>`count(*)::int`,
        openTickets: sql<number>`count(*) filter (where status = 'open')::int`,
        pendingTickets: sql<number>`count(*) filter (where status = 'pending')::int`,
        resolvedTickets: sql<number>`count(*) filter (where status = 'resolved')::int`,
        closedTickets: sql<number>`count(*) filter (where status = 'closed')::int`,
        newTickets: sql<number>`count(*) filter (where status = 'new')::int`,
        urgentTickets: sql<number>`count(*) filter (where priority = 'urgent')::int`,
        highPriorityTickets: sql<number>`count(*) filter (where priority = 'high')::int`,
      })
      .from(helpdeskTickets)
      .where(isNull(helpdeskTickets.deletedAt));

    return success(c, result ?? {
      totalTickets: 0,
      openTickets: 0,
      pendingTickets: 0,
      resolvedTickets: 0,
      closedTickets: 0,
      newTickets: 0,
      urgentTickets: 0,
      highPriorityTickets: 0,
    });
  } catch (err) {
    console.error('[app-api/helpdesk-stats] get failed:', err);
    return error.internal(c, 'Failed to fetch helpdesk stats');
  }
});

export const helpdeskStatsRoutes = app;
