/**
 * GET /api/reach/access: access status, staff-set limits, live usage and the
 * global kill-switch state, for the module header and the limit hints.
 *
 * Any WeldReach permission opens it: the header is shown to every role that
 * can see the module. Read-only, so nothing to publish.
 */

import { Hono } from 'hono';
import { requirePermission } from '@weldsuite/permissions/server';
import { success } from '@weldsuite/worker-kit/response';
import type { Env, Variables } from '../../types';
import { buildAccessSummary } from '@weldsuite/reach-domain/access';
import { reachErrorHandler } from '../../services/reach-errors';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.onError(reachErrorHandler);

app.get(
  '/',
  requirePermission(
    'reach_campaigns:read',
    'reach_prospects:read',
    'reach_inbox:read',
    'reach_mailboxes:read',
    'reach_settings:read',
  ),
  async (c) => {
    // Flagship `weldreach-sending` (default on): off = no SMTP sends anywhere.
    const sendingEnabled = (await c.get('flags')?.isOn('weldreach-sending')) ?? true;
    const summary = await buildAccessSummary({
      db: c.get('tenantDb'),
      access: c.get('appAccess'),
      sendingEnabled,
    });
    return success(c, summary);
  },
);

export default app;
