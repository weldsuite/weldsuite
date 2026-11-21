/**
 * Live WeldDesk reports under /api/helpdesk-analytics (mounted from ./index):
 *
 * - GET /wallboard?teamId=  the queue right now, for a screen the whole team
 *   looks at (conversations:read, not settings:read);
 * - GET /phone?range=       call KPIs for a period (settings:read, like the
 *   other reports).
 *
 * Read-only, so no entity events. Services: services/desk-wallboard.ts and
 * services/desk-phone-report.ts.
 */

import { Hono } from 'hono';
import { requirePermission } from '@weldsuite/permissions/server';
import type { Env, Variables } from '../../types';
import { error, success } from '@weldsuite/worker-kit/response';
import { deskTeamExists, deskWallboard } from '../../services/desk-wallboard';
import { deskPhoneReport } from '../../services/desk-phone-report';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.get('/wallboard', requirePermission('conversations:read'), async (c) => {
  const db = c.get('tenantDb');
  const teamId = c.req.query('teamId')?.trim() || null;
  try {
    if (teamId && !(await deskTeamExists(db, teamId))) return error.badRequest(c, 'Unknown team');
    return success(c, await deskWallboard(db, new Date(), teamId));
  } catch (err) {
    console.error('[desk-api/helpdesk-analytics] wallboard failed:', err);
    return error.internal(c, 'Failed to fetch the wallboard');
  }
});

app.get('/phone', requirePermission('settings:read'), async (c) => {
  try {
    return success(c, await deskPhoneReport(c.get('tenantDb'), c.req.query('range'), new Date()));
  } catch (err) {
    console.error('[desk-api/helpdesk-analytics] phone report failed:', err);
    return error.internal(c, 'Failed to fetch the phone report');
  }
});

export const helpdeskLiveReportRoutes = app;
