/**
 * The workspace's own view of its outbound sending limits (WeldMail settings
 * "Sending limits" card and the restriction banner).
 *
 *   GET /api/mail-sending/usage   → { data: OutboundUsage | null }
 *
 * null when the outbound guard isn't reachable in this environment. See
 * docs/plans/weldmail-outbound-abuse.md.
 */

import { Hono } from 'hono';
import { requirePermission } from '@weldsuite/permissions/server';
import { getOutboundUsage } from '@weldsuite/mail-domain/outbound';
import { error, success } from '@weldsuite/worker-kit/response';
import type { Env, Variables } from '../../types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.get('/usage', requirePermission('accounts:read'), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);
  try {
    return success(c, await getOutboundUsage(c.env, { kind: 'workspace', clerkOrgId: orgId }));
  } catch (err) {
    console.error('[mail-sending] usage failed:', err);
    return error.internal(c, 'Failed to load sending limits');
  }
});

export const mailSendingRoutes = app;
